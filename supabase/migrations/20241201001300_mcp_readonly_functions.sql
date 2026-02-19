-- Migration: MCP read-only helper functions
-- Safe wrappers for the internal MCP server with bounded outputs

-- ============================================================================
-- LATEST SLACK THREADS (time-ordered, not semantic)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_latest_slack_threads(
  p_channel_id text DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  thread_ts text,
  root_text text,
  root_user_id text,
  message_count int,
  reply_count int,
  participant_count int,
  root_message_at timestamptz,
  latest_reply_ts text
)
LANGUAGE sql STABLE
AS $$
  SELECT 
    st.thread_ts,
    LEFT(st.root_text, 500) as root_text,  -- truncate for safety
    st.root_user_id,
    st.message_count,
    st.reply_count,
    st.participant_count,
    st.root_message_at,
    st.latest_reply_ts
  FROM slack_threads st
  WHERE st.channel_id = p_channel_id
    AND st.root_text IS NOT NULL
  ORDER BY st.root_message_at DESC
  LIMIT LEAST(p_limit, 50);  -- hard cap at 50
$$;

-- ============================================================================
-- SAFE MATCH_TRAINING_CONVERSATIONS WRAPPER
-- Returns only minimal safe fields
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_match_training_conversations(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  subject text,
  category text,
  conversation_summary text,
  training_type text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT 
    tc.id,
    tc.subject,
    tc.category,
    LEFT(tc.conversation_summary, 1000) as conversation_summary,  -- truncate
    tc.training_type,
    1 - (tc.embedding <=> query_embedding) AS similarity
  FROM training_conversations tc
  WHERE 
    tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT LEAST(match_count, 50);  -- hard cap at 50
$$;

-- ============================================================================
-- SAFE MATCH_DOCUMENTS WRAPPER
-- Returns only minimal safe fields, excludes raw content by default
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_match_documents(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.78,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  title text,
  department text,
  document_type text,
  source_type text,
  source_path text,
  content_preview text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT 
    d.id,
    d.title,
    d.department,
    d.document_type,
    d.source_type,
    d.source_path,
    LEFT(d.content, 500) as content_preview,  -- only first 500 chars
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE 
    d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT LEAST(match_count, 50);  -- hard cap at 50
$$;

-- ============================================================================
-- SAFE MATCH_SLACK_MESSAGES WRAPPER
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_match_slack_messages(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
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
    sm.user_display_name,
    LEFT(sm.text, 500) as text,  -- truncate
    sm.message_at,
    1 - (sm.embedding <=> query_embedding) AS similarity
  FROM slack_messages sm
  WHERE 
    sm.embedding IS NOT NULL
    AND 1 - (sm.embedding <=> query_embedding) > match_threshold
  ORDER BY sm.embedding <=> query_embedding
  LIMIT LEAST(match_count, 100);  -- hard cap at 100
$$;

-- ============================================================================
-- SAFE MATCH_WOD_DEALS WRAPPER
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_match_wod_deals(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  deal_name text,
  geographic_area text,
  country text,
  total_parking_spaces int,
  total_boxes int,
  charger_type text,
  total_cost_excl_vat numeric,
  deal_date date,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT 
    d.id,
    d.deal_name,
    d.geographic_area,
    d.country,
    d.total_parking_spaces,
    d.total_boxes,
    d.charger_type,
    d.total_cost_excl_vat,
    d.deal_date,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM wod_deals d
  WHERE 
    d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT LEAST(match_count, 30);  -- hard cap at 30
$$;

-- ============================================================================
-- EXTENDED TABLE STATS FOR MCP
-- Includes Slack tables in the stats
-- ============================================================================

CREATE OR REPLACE FUNCTION get_table_stats_extended()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'documents', (SELECT count(*) FROM documents),
    'training_conversations', (SELECT count(*) FROM training_conversations),
    'training_messages', (SELECT count(*) FROM training_messages),
    'slack_threads', (SELECT count(*) FROM slack_threads),
    'slack_messages', (SELECT count(*) FROM slack_messages),
    'wod_deals', (SELECT count(*) FROM wod_deals),
    'wod_deal_circuits', (SELECT count(*) FROM wod_deal_circuits),
    'wod_deal_costs', (SELECT count(*) FROM wod_deal_costs),
    'wod_deal_offers', (SELECT count(*) FROM wod_deal_offers),
    'wod_cost_catalog', (SELECT count(*) FROM wod_cost_catalog)
  ) INTO result;
  
  RETURN result;
END;
$$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON FUNCTION get_latest_slack_threads IS 'Get most recent Slack threads ordered by time (for MCP)';
COMMENT ON FUNCTION mcp_match_training_conversations IS 'Safe semantic search over training conversations with truncated outputs';
COMMENT ON FUNCTION mcp_match_documents IS 'Safe semantic search over documents with truncated content preview';
COMMENT ON FUNCTION mcp_match_slack_messages IS 'Safe semantic search over Slack messages with truncated text';
COMMENT ON FUNCTION mcp_match_wod_deals IS 'Safe semantic search over WoD deals with minimal fields';
COMMENT ON FUNCTION get_table_stats_extended IS 'Extended table stats including Slack tables';
