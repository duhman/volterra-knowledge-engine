-- Migration: Fix MCP match functions schema
-- Problem: Functions exist in public schema but MCP server uses volterra_kb schema
-- Solution: Recreate functions in volterra_kb schema with proper grants
SET
  search_path TO volterra_kb,
  extensions,
  public;

-- ============================================================================
-- MCP_MATCH_DOCUMENTS - Semantic search on documents table
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_match_documents (
  query_embedding vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  title text,
  department text,
  document_type text,
  source_type text,
  source_path text,
  content_preview text,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT
    d.id,
    d.title,
    d.department,
    d.document_type,
    d.source_type,
    d.source_path,
    LEFT(d.content, 500) as content_preview,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.documents d
  WHERE
    d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_match_documents TO service_role,
anon;

-- ============================================================================
-- MCP_MATCH_TRAINING_CONVERSATIONS - Semantic search on training data
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_match_training_conversations (
  query_embedding vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  hubspot_ticket_id text,
  subject text,
  category text,
  subcategory text,
  training_type text,
  summary text,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT
    tc.id,
    tc.hubspot_ticket_id,
    tc.subject,
    tc.category,
    tc.subcategory,
    tc.training_type,
    LEFT(tc.conversation_summary, 500) as summary,
    1 - (tc.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.training_conversations tc
  WHERE
    tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_match_training_conversations TO service_role,
anon;

-- ============================================================================
-- MCP_MATCH_SLACK_MESSAGES - Semantic search on Slack messages
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_match_slack_messages (
  query_embedding vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
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
    LEFT(sm.text, 500) as text,
    sm.message_at,
    1 - (sm.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.slack_messages sm
  WHERE
    sm.embedding IS NOT NULL
    AND 1 - (sm.embedding <=> query_embedding) > match_threshold
  ORDER BY sm.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_match_slack_messages TO service_role,
anon;

-- ============================================================================
-- MCP_MATCH_WOD_DEALS - Semantic search on WoD deals
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_match_wod_deals (
  query_embedding vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  deal_name text,
  geographic_area text,
  country text,
  total_parking_spaces int,
  total_boxes int,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT
    wd.id,
    wd.deal_name,
    wd.geographic_area,
    wd.country,
    wd.total_parking_spaces,
    wd.total_boxes,
    1 - (wd.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.wod_deals wd
  WHERE
    wd.embedding IS NOT NULL
    AND 1 - (wd.embedding <=> query_embedding) > match_threshold
  ORDER BY wd.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_match_wod_deals TO service_role,
anon;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON FUNCTION volterra_kb.mcp_match_documents IS 'MCP semantic search for documents. Required for kb_search tool.';

COMMENT ON FUNCTION volterra_kb.mcp_match_training_conversations IS 'MCP semantic search for training conversations. Required for kb_search tool.';

COMMENT ON FUNCTION volterra_kb.mcp_match_slack_messages IS 'MCP semantic search for Slack messages. Required for kb_search tool.';

COMMENT ON FUNCTION volterra_kb.mcp_match_wod_deals IS 'MCP semantic search for WoD deals. Required for kb_search tool.';
