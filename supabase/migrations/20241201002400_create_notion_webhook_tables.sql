-- Migration: Create Notion webhook events table for real-time sync
-- Purpose: Track and deduplicate webhook events, enable meeting transcription capture
-- Date: 2025-12-29
-- ============================================================================
-- WEBHOOK EVENTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS volterra_kb.notion_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Event identity (from Notion webhook payload)
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL, -- page.created, page.content_updated, page.properties_updated, page.deleted
  -- Entity information
  entity_type TEXT NOT NULL DEFAULT 'page', -- page, database, block
  entity_id TEXT NOT NULL, -- Notion page/database/block ID
  -- Event metadata
  workspace_id TEXT,
  integration_id TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  -- Processing state
  attempt_number INTEGER DEFAULT 1,
  processing_status TEXT DEFAULT 'pending', -- pending, processing, completed, failed, skipped
  processing_error TEXT,
  processed_at TIMESTAMPTZ,
  -- Raw payload for debugging
  payload JSONB,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================
-- Fast event_id lookup for deduplication
CREATE INDEX IF NOT EXISTS idx_notion_webhook_events_event_id ON volterra_kb.notion_webhook_events (event_id);

-- Find pending events for processing
CREATE INDEX IF NOT EXISTS idx_notion_webhook_events_status ON volterra_kb.notion_webhook_events (processing_status, created_at)
WHERE
  processing_status IN ('pending', 'processing');

-- Find events by entity for history
CREATE INDEX IF NOT EXISTS idx_notion_webhook_events_entity ON volterra_kb.notion_webhook_events (entity_id, timestamp DESC);

-- Find failed events for retry
CREATE INDEX IF NOT EXISTS idx_notion_webhook_events_failed ON volterra_kb.notion_webhook_events (processing_status, attempt_number)
WHERE
  processing_status = 'failed'
  AND attempt_number < 3;

-- Filter by event type
CREATE INDEX IF NOT EXISTS idx_notion_webhook_events_type ON volterra_kb.notion_webhook_events (event_type);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
-- Auto-update updated_at
DROP TRIGGER IF EXISTS update_notion_webhook_events_updated_at ON volterra_kb.notion_webhook_events;

CREATE TRIGGER update_notion_webhook_events_updated_at BEFORE
UPDATE ON volterra_kb.notion_webhook_events FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column ();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE volterra_kb.notion_webhook_events ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access on notion_webhook_events" ON volterra_kb.notion_webhook_events FOR ALL USING (true)
WITH
  CHECK (true);

-- Anon can read (for MCP tools)
CREATE POLICY "Anon can read notion_webhook_events" ON volterra_kb.notion_webhook_events FOR
SELECT
  USING (true);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================
-- Check if event already exists (for deduplication)
CREATE OR REPLACE FUNCTION volterra_kb.webhook_event_exists (p_event_id TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT EXISTS(SELECT 1 FROM volterra_kb.notion_webhook_events WHERE event_id = p_event_id);
$$;

-- Log new webhook event
CREATE OR REPLACE FUNCTION volterra_kb.log_webhook_event (
  p_event_id TEXT,
  p_event_type TEXT,
  p_entity_id TEXT,
  p_timestamp TIMESTAMPTZ,
  p_payload JSONB DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO volterra_kb.notion_webhook_events (
        event_id, event_type, entity_id, timestamp, payload
    ) VALUES (
        p_event_id, p_event_type, p_entity_id, p_timestamp, p_payload
    )
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Mark event as completed
CREATE OR REPLACE FUNCTION volterra_kb.mark_webhook_event_completed (p_event_id TEXT) RETURNS VOID LANGUAGE sql SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    UPDATE volterra_kb.notion_webhook_events
    SET processing_status = 'completed',
        processed_at = NOW()
    WHERE event_id = p_event_id;
$$;

-- Mark event as failed
CREATE OR REPLACE FUNCTION volterra_kb.mark_webhook_event_failed (p_event_id TEXT, p_error TEXT) RETURNS VOID LANGUAGE sql SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    UPDATE volterra_kb.notion_webhook_events
    SET processing_status = 'failed',
        processing_error = p_error,
        attempt_number = attempt_number + 1
    WHERE event_id = p_event_id;
$$;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE volterra_kb.notion_webhook_events IS 'Tracks Notion webhook events for deduplication and processing';

COMMENT ON COLUMN volterra_kb.notion_webhook_events.event_id IS 'Unique event ID from Notion webhook payload';

COMMENT ON COLUMN volterra_kb.notion_webhook_events.event_type IS 'Event type: page.created, page.content_updated, page.properties_updated, page.deleted';

COMMENT ON COLUMN volterra_kb.notion_webhook_events.entity_id IS 'Notion entity ID (page, database, or block)';

COMMENT ON COLUMN volterra_kb.notion_webhook_events.processing_status IS 'pending, processing, completed, failed, skipped';

COMMENT ON COLUMN volterra_kb.notion_webhook_events.attempt_number IS 'Number of processing attempts (max 3 before giving up)';

COMMENT ON FUNCTION volterra_kb.webhook_event_exists IS 'Check if webhook event already exists (for deduplication)';

COMMENT ON FUNCTION volterra_kb.log_webhook_event IS 'Log new webhook event with conflict handling';
