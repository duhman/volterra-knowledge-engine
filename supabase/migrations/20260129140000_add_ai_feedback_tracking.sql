-- Migration: add_ai_feedback_tracking
-- Created: 2026-01-29
-- Purpose: Track AI response quality and human corrections in #help-me-platform
--
-- Tables:
--   - ai_response_feedback: Captures AI responses and any subsequent human corrections
--
-- Columns added to slack_threads:
--   - resolution_status: open, resolved, escalated
--   - resolution_method: ai_correct, human_corrected, manual
--   - resolved_at: timestamp when resolved
--   - resolved_by: user_id who resolved
SET
  search_path TO volterra_kb,
  public,
  extensions;

-- ============================================================================
-- AI RESPONSE FEEDBACK TABLE
-- ============================================================================
-- Tracks AI responses and human corrections for learning/accuracy metrics
CREATE TABLE IF NOT EXISTS volterra_kb.ai_response_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Thread identification
  thread_ts TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT 'C05FA8B5YPM', -- #help-me-platform
  -- AI response details
  ai_response_ts TEXT NOT NULL,
  ai_response_text TEXT NOT NULL,
  ai_confidence DOUBLE PRECISION, -- If available from AI agent
  ai_sources JSONB, -- Which KB sources were cited
  -- Human correction (populated when someone corrects the AI)
  human_correction_ts TEXT,
  human_correction_text TEXT,
  human_corrector_id TEXT,
  human_corrector_name TEXT,
  -- Classification of the error (set during review/analysis)
  error_category TEXT, -- 'wrong_diagnosis', 'missing_context', 'outdated_info', 'auth_type_error', etc.
  error_notes TEXT,
  -- Resolution tracking
  resolution_status TEXT DEFAULT 'pending', -- 'pending', 'resolved', 'escalated', 'false_positive'
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- Constraints
  CONSTRAINT ai_response_feedback_channel_ts_unique UNIQUE (channel_id, ai_response_ts)
);

-- ============================================================================
-- ADD RESOLUTION TRACKING TO SLACK_THREADS
-- ============================================================================
ALTER TABLE volterra_kb.slack_threads
ADD COLUMN IF NOT EXISTS resolution_status TEXT,
ADD COLUMN IF NOT EXISTS resolution_method TEXT,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS resolved_by TEXT;

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_ai_response_feedback_thread ON volterra_kb.ai_response_feedback (channel_id, thread_ts);

CREATE INDEX IF NOT EXISTS idx_ai_response_feedback_status ON volterra_kb.ai_response_feedback (resolution_status);

CREATE INDEX IF NOT EXISTS idx_ai_response_feedback_error_category ON volterra_kb.ai_response_feedback (error_category)
WHERE
  error_category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_response_feedback_created ON volterra_kb.ai_response_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_slack_threads_resolution_status ON volterra_kb.slack_threads (resolution_status)
WHERE
  resolution_status IS NOT NULL;

-- ============================================================================
-- UPSERT FUNCTION FOR N8N WORKFLOW
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.upsert_ai_response_feedback (
  p_thread_ts TEXT,
  p_channel_id TEXT,
  p_ai_response_ts TEXT,
  p_ai_response_text TEXT,
  p_ai_confidence DOUBLE PRECISION DEFAULT NULL,
  p_ai_sources JSONB DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO volterra_kb.ai_response_feedback (
    thread_ts,
    channel_id,
    ai_response_ts,
    ai_response_text,
    ai_confidence,
    ai_sources
  ) VALUES (
    p_thread_ts,
    COALESCE(p_channel_id, 'C05FA8B5YPM'),
    p_ai_response_ts,
    p_ai_response_text,
    p_ai_confidence,
    p_ai_sources
  )
  ON CONFLICT (channel_id, ai_response_ts)
  DO UPDATE SET
    ai_response_text = EXCLUDED.ai_response_text,
    ai_confidence = COALESCE(EXCLUDED.ai_confidence, volterra_kb.ai_response_feedback.ai_confidence),
    ai_sources = COALESCE(EXCLUDED.ai_sources, volterra_kb.ai_response_feedback.ai_sources),
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ============================================================================
-- RECORD HUMAN CORRECTION FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.record_human_correction (
  p_thread_ts TEXT,
  p_channel_id TEXT,
  p_correction_ts TEXT,
  p_correction_text TEXT,
  p_corrector_id TEXT,
  p_corrector_name TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_target_id UUID;
BEGIN
  -- Find the most recent AI response in this thread that hasn't been corrected yet
  SELECT id INTO v_target_id
  FROM volterra_kb.ai_response_feedback
  WHERE thread_ts = p_thread_ts
    AND channel_id = COALESCE(p_channel_id, 'C05FA8B5YPM')
    AND human_correction_ts IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  -- If no uncorrected response found, return false
  IF v_target_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Update the found record
  UPDATE volterra_kb.ai_response_feedback
  SET
    human_correction_ts = p_correction_ts,
    human_correction_text = p_correction_text,
    human_corrector_id = p_corrector_id,
    human_corrector_name = p_corrector_name,
    resolution_status = 'pending',
    updated_at = NOW()
  WHERE id = v_target_id;

  RETURN TRUE;
END;
$$;

-- ============================================================================
-- ANALYTICS: GET CORRECTION STATS
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.get_ai_feedback_stats (p_days INTEGER DEFAULT 30) RETURNS TABLE (
  total_responses BIGINT,
  corrected_responses BIGINT,
  correction_rate DOUBLE PRECISION,
  by_error_category JSONB,
  by_resolution_status JSONB
) LANGUAGE sql STABLE AS $$
  WITH
    base_data AS (
      SELECT *
      FROM volterra_kb.ai_response_feedback
      WHERE created_at >= NOW() - (p_days || ' days')::INTERVAL
    ),
    counts AS (
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE human_correction_ts IS NOT NULL) AS corrected
      FROM base_data
    ),
    category_agg AS (
      SELECT COALESCE(
        jsonb_object_agg(error_category, cnt),
        '{}'::JSONB
      ) AS by_category
      FROM (
        SELECT error_category, COUNT(*) AS cnt
        FROM base_data
        WHERE error_category IS NOT NULL
        GROUP BY error_category
      ) sub
    ),
    status_agg AS (
      SELECT COALESCE(
        jsonb_object_agg(COALESCE(resolution_status, 'pending'), cnt),
        '{}'::JSONB
      ) AS by_status
      FROM (
        SELECT resolution_status, COUNT(*) AS cnt
        FROM base_data
        GROUP BY resolution_status
      ) sub
    )
  SELECT
    c.total AS total_responses,
    c.corrected AS corrected_responses,
    CASE WHEN c.total > 0 THEN c.corrected::DOUBLE PRECISION / c.total ELSE 0 END AS correction_rate,
    cat.by_category AS by_error_category,
    stat.by_status AS by_resolution_status
  FROM counts c
  CROSS JOIN category_agg cat
  CROSS JOIN status_agg stat;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================
-- Auto-update updated_at
DROP TRIGGER IF EXISTS update_ai_response_feedback_updated_at ON volterra_kb.ai_response_feedback;

CREATE TRIGGER update_ai_response_feedback_updated_at BEFORE
UPDATE ON volterra_kb.ai_response_feedback FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column ();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE volterra_kb.ai_response_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on ai_response_feedback" ON volterra_kb.ai_response_feedback;

CREATE POLICY "Service role full access on ai_response_feedback" ON volterra_kb.ai_response_feedback FOR ALL USING (true)
WITH
  CHECK (true);

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT
SELECT
,
  INSERT,
UPDATE ON volterra_kb.ai_response_feedback TO service_role;

GRANT
SELECT
  ON volterra_kb.ai_response_feedback TO anon;

GRANT
EXECUTE ON FUNCTION volterra_kb.upsert_ai_response_feedback TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.record_human_correction TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.get_ai_feedback_stats TO service_role,
anon;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE volterra_kb.ai_response_feedback IS 'Tracks AI responses and human corrections in #help-me-platform for accuracy improvement';

COMMENT ON COLUMN volterra_kb.ai_response_feedback.error_category IS 'Classification: wrong_diagnosis, missing_context, outdated_info, auth_type_error, etc.';

COMMENT ON COLUMN volterra_kb.ai_response_feedback.resolution_status IS 'pending = needs review, resolved = addressed, escalated = needs training data, false_positive = AI was correct';

COMMENT ON COLUMN volterra_kb.slack_threads.resolution_status IS 'Thread resolution: open, resolved, escalated';

COMMENT ON COLUMN volterra_kb.slack_threads.resolution_method IS 'How resolved: ai_correct, human_corrected, manual';
