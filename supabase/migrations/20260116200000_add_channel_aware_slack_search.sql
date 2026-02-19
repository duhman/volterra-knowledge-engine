-- Migration: Add channel-aware semantic search for Slack messages
-- Problem: match_slack_messages has no channel filter, returns results from all channels
-- Solution: Create new function with optional p_channel_id parameter
SET
  search_path TO public,
  extensions,
  volterra_kb;

-- ============================================================================
-- CHANNEL-AWARE SEMANTIC SEARCH FUNCTION
-- ============================================================================
-- This function allows filtering semantic search by channel_id.
-- When p_channel_id is NULL, it searches all channels (backwards compatible).
-- When p_channel_id is specified, it only searches that channel.
CREATE OR REPLACE FUNCTION public.match_slack_messages_by_channel (
  query_embedding vector (1536),
  p_channel_id text DEFAULT NULL, -- NULL = all channels, or specific channel ID
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20
) RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_display_name text,
  text text,
  message_at timestamptz,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT
    sm.id,
    sm.channel_id,
    sm.message_ts,
    sm.thread_ts,
    sm.user_display_name,
    LEFT(sm.text, 1000) as text,
    sm.message_at,
    1 - (sm.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.slack_messages sm
  WHERE
    sm.embedding IS NOT NULL
    AND (p_channel_id IS NULL OR sm.channel_id = p_channel_id)
    AND 1 - (sm.embedding <=> query_embedding) > match_threshold
  ORDER BY sm.embedding <=> query_embedding
  LIMIT LEAST(match_count, 100);
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT
EXECUTE ON FUNCTION public.match_slack_messages_by_channel TO service_role,
anon;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON FUNCTION public.match_slack_messages_by_channel IS 'Semantic search on Slack messages with optional channel filtering.
Parameters:
  - query_embedding: 1536-dim vector from text-embedding-3-small
  - p_channel_id: Optional channel ID filter (NULL = all channels)
  - match_threshold: Minimum similarity score (default 0.5)
  - match_count: Maximum results (default 20, max 100)

Known channel IDs:
  - C05FA8B5YPM: #help-me-platform (support tickets)
  - C078S57MS5P: #platform-all-deliveries (delivery announcements)

Used by n8n AI Agent workflow c4tHYJcGwSaDAA6c for channel-specific queries.';
