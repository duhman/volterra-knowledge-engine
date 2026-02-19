-- Migration: Add embeddings to slack_messages for semantic search
-- Enables vector search over individual Slack messages via n8n Supabase Vector Store node

-- ============================================================================
-- ADD EMBEDDING COLUMN
-- ============================================================================

ALTER TABLE slack_messages 
ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- ============================================================================
-- CREATE INDEX FOR VECTOR SEARCH
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_slack_messages_embedding 
ON slack_messages USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 50);

-- ============================================================================
-- MATCH FUNCTION FOR SEMANTIC SEARCH
-- ============================================================================

CREATE OR REPLACE FUNCTION match_slack_messages(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20,
  filter_channel_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  text text,
  message_at timestamptz,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT 
    sm.id,
    sm.channel_id,
    sm.message_ts,
    sm.thread_ts,
    sm.user_id,
    sm.user_display_name,
    sm.text,
    sm.message_at,
    1 - (sm.embedding <=> query_embedding) AS similarity
  FROM slack_messages sm
  WHERE 
    sm.embedding IS NOT NULL
    AND 1 - (sm.embedding <=> query_embedding) > match_threshold
    AND (filter_channel_id IS NULL OR sm.channel_id = filter_channel_id)
  ORDER BY sm.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ============================================================================
-- BACKFILL HELPER FUNCTION
-- ============================================================================

-- Get messages needing embeddings (for batch processing)
CREATE OR REPLACE FUNCTION get_slack_messages_without_embeddings(
  p_limit int DEFAULT 100,
  p_channel_id text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  text text,
  channel_id text,
  message_ts text
)
LANGUAGE sql STABLE
AS $$
  SELECT id, text, channel_id, message_ts
  FROM slack_messages
  WHERE embedding IS NULL
    AND text IS NOT NULL
    AND LENGTH(text) > 10
    AND (p_channel_id IS NULL OR channel_id = p_channel_id)
  ORDER BY message_at DESC
  LIMIT p_limit;
$$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN slack_messages.embedding IS 'OpenAI text-embedding-3-small vector for semantic search';
COMMENT ON FUNCTION match_slack_messages IS 'Semantic search over Slack messages. Returns messages similar to query embedding.';
COMMENT ON FUNCTION get_slack_messages_without_embeddings IS 'Helper to get messages needing embedding generation for backfill.';
