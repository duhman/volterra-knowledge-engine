-- Migration: Add Slack reaction columns and MCP analytics function
-- Purpose: Enable reaction analytics queries (e.g., "average reactions in #platform-all-deliveries")
-- Note: Reactions are already stored in raw JSONB - this extracts them for efficient querying
SET
  search_path TO volterra_kb,
  public;

-- ============================================================================
-- STEP 1: ADD REACTION COLUMNS TO SLACK_MESSAGES
-- ============================================================================
ALTER TABLE slack_messages
ADD COLUMN IF NOT EXISTS reaction_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '[]'::jsonb;

-- ============================================================================
-- STEP 2: CREATE INDEXES FOR REACTION ANALYTICS
-- ============================================================================
-- Partial index for messages with reactions (most queries filter on this)
CREATE INDEX IF NOT EXISTS idx_slack_messages_reaction_count ON slack_messages (reaction_count DESC)
WHERE
  reaction_count > 0;

-- GIN index for reaction name searches (e.g., "find all messages with :rocket:")
CREATE INDEX IF NOT EXISTS idx_slack_messages_reactions_gin ON slack_messages USING gin (reactions);

-- Composite index for channel + date + reactions (common analytics query pattern)
CREATE INDEX IF NOT EXISTS idx_slack_messages_channel_date_reactions ON slack_messages (channel_id, message_at DESC, reaction_count)
WHERE
  reaction_count > 0;

-- ============================================================================
-- STEP 3: BACKFILL FROM EXISTING RAW JSONB
-- ============================================================================
UPDATE slack_messages
SET
  reactions = COALESCE(raw -> 'reactions', '[]'::jsonb),
  reaction_count = COALESCE(
    (
      SELECT
        SUM((r ->> 'count')::int)
      FROM
        jsonb_array_elements(raw -> 'reactions') r
    ),
    0
  )
WHERE
  raw -> 'reactions' IS NOT NULL
  AND (
    reaction_count IS NULL
    OR reaction_count = 0
  );

-- ============================================================================
-- STEP 4: MCP ANALYTICS FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_get_reaction_analytics (
  p_channel_id TEXT DEFAULT 'C078S57MS5P', -- platform-all-deliveries
  p_date_from DATE DEFAULT NULL,
  p_date_to DATE DEFAULT NULL
) RETURNS TABLE (
  total_messages BIGINT,
  messages_with_reactions BIGINT,
  total_reactions BIGINT,
  avg_reactions_per_message NUMERIC,
  top_reactions JSONB
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  WITH msg_stats AS (
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE reaction_count > 0) as with_reactions,
      SUM(reaction_count) as total_reactions
    FROM slack_messages
    WHERE channel_id = p_channel_id
      AND (p_date_from IS NULL OR message_at >= p_date_from)
      AND (p_date_to IS NULL OR message_at < p_date_to)
      AND subtype IS NULL  -- Only regular messages (exclude joins, leaves, etc.)
  ),
  reaction_breakdown AS (
    SELECT jsonb_agg(
      jsonb_build_object('name', r.name, 'total_count', r.total)
      ORDER BY r.total DESC
    ) as top_reactions
    FROM (
      SELECT
        elem->>'name' as name,
        SUM((elem->>'count')::int) as total
      FROM slack_messages,
           jsonb_array_elements(reactions) as elem
      WHERE channel_id = p_channel_id
        AND (p_date_from IS NULL OR message_at >= p_date_from)
        AND (p_date_to IS NULL OR message_at < p_date_to)
        AND reactions != '[]'::jsonb
      GROUP BY elem->>'name'
      ORDER BY total DESC
      LIMIT 10
    ) r
  )
  SELECT
    ms.total,
    ms.with_reactions,
    COALESCE(ms.total_reactions, 0),
    ROUND(COALESCE(ms.total_reactions::numeric / NULLIF(ms.total, 0), 0), 2),
    COALESCE(rb.top_reactions, '[]'::jsonb)
  FROM msg_stats ms, reaction_breakdown rb;
END;
$$;

-- Grant permissions for MCP access
GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_reaction_analytics TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_reaction_analytics TO anon;

-- ============================================================================
-- STEP 5: COMMENTS
-- ============================================================================
COMMENT ON COLUMN slack_messages.reaction_count IS 'Total reaction count across all emoji types';

COMMENT ON COLUMN slack_messages.reactions IS 'Array of {name, count, users[]} reaction objects from Slack';

COMMENT ON FUNCTION volterra_kb.mcp_get_reaction_analytics IS 'Get reaction analytics for a Slack channel.
Returns: total_messages, messages_with_reactions, total_reactions, avg_reactions_per_message, top_reactions.
Channel IDs: C078S57MS5P (platform-all-deliveries), C05FA8B5YPM (help-me-platform).
Example: SELECT * FROM volterra_kb.mcp_get_reaction_analytics(''C078S57MS5P'', ''2025-01-01'', ''2025-12-31'');';
