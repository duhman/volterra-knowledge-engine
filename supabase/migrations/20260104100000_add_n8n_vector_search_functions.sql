-- Migration: Add n8n-compatible vector search functions
-- Purpose: Create RPC functions expected by n8n Supabase Vector Store nodes
-- Date: 2026-01-04
--
-- The n8n LangChain Supabase Vector Store node expects functions named:
--   match_documents, match_training_conversations, match_slack_messages, match_wod_deals
--
-- Previous migrations only created mcp_* prefixed versions.
-- These functions use HNSW indexes for fast vector similarity search.
-- ============================================================================
-- Drop any existing functions with these names (any signature) to avoid conflicts
-- ============================================================================
DROP FUNCTION IF EXISTS public.match_training_conversations (extensions.vector, float, int);

DROP FUNCTION IF EXISTS public.match_documents (extensions.vector, float, int);

DROP FUNCTION IF EXISTS public.match_slack_messages (extensions.vector, float, int);

DROP FUNCTION IF EXISTS public.match_wod_deals (extensions.vector, float, int);

DROP FUNCTION IF EXISTS volterra_kb.match_training_conversations (extensions.vector, float, int);

DROP FUNCTION IF EXISTS volterra_kb.match_documents (extensions.vector, float, int);

DROP FUNCTION IF EXISTS volterra_kb.match_slack_messages (extensions.vector, float, int);

DROP FUNCTION IF EXISTS volterra_kb.match_wod_deals (extensions.vector, float, int);

-- ============================================================================
-- match_training_conversations - HubSpot support tickets
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.match_training_conversations (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    tc.id,
    COALESCE(tc.subject, '') || E'\n\n' || COALESCE(tc.conversation_summary, '') as content,
    jsonb_build_object(
      'subject', tc.subject,
      'category', tc.category,
      'subcategory', tc.subcategory,
      'priority', tc.priority,
      'status', tc.status,
      'hubspot_ticket_id', tc.hubspot_ticket_id,
      'create_date', tc.create_date,
      'training_type', tc.training_type
    ) as metadata,
    1 - (tc.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.training_conversations tc
  WHERE
    tc.embedding IS NOT NULL
    AND 1 - (tc.embedding <=> query_embedding) > match_threshold
  ORDER BY tc.embedding <=> query_embedding
  LIMIT LEAST(match_count, 50);
END;
$$;

COMMENT ON FUNCTION volterra_kb.match_training_conversations IS 'Vector similarity search over HubSpot support tickets. Used by n8n Supabase Vector Store node.';

-- ============================================================================
-- match_documents - Knowledge base documents
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.match_documents (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.78,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    COALESCE(d.title, '') || E'\n\n' || LEFT(COALESCE(d.content, ''), 2000) as content,
    jsonb_build_object(
      'title', d.title,
      'department', d.department,
      'document_type', d.document_type,
      'source_type', d.source_type,
      'source_path', d.source_path,
      'created_at', d.created_at
    ) as metadata,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.documents d
  WHERE
    d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT LEAST(match_count, 50);
END;
$$;

COMMENT ON FUNCTION volterra_kb.match_documents IS 'Vector similarity search over knowledge base documents. Used by n8n Supabase Vector Store node.';

-- ============================================================================
-- match_slack_messages - Slack messages
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.match_slack_messages (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.id,
    COALESCE(sm.text, '') as content,
    jsonb_build_object(
      'channel_id', sm.channel_id,
      'message_ts', sm.message_ts,
      'thread_ts', sm.thread_ts,
      'user_display_name', sm.user_display_name,
      'user_real_name', sm.user_real_name,
      'message_at', sm.message_at
    ) as metadata,
    1 - (sm.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.slack_messages sm
  WHERE
    sm.embedding IS NOT NULL
    AND 1 - (sm.embedding <=> query_embedding) > match_threshold
  ORDER BY sm.embedding <=> query_embedding
  LIMIT LEAST(match_count, 100);
END;
$$;

COMMENT ON FUNCTION volterra_kb.match_slack_messages IS 'Vector similarity search over Slack messages. Used by n8n Supabase Vector Store node.';

-- ============================================================================
-- match_wod_deals - Wheel of Deal pricing data
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.match_wod_deals (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    COALESCE(d.deal_name, '') || ' - ' || COALESCE(d.geographic_area, '') as content,
    jsonb_build_object(
      'deal_name', d.deal_name,
      'geographic_area', d.geographic_area,
      'country', d.country,
      'total_parking_spaces', d.total_parking_spaces,
      'total_boxes', d.total_boxes,
      'charger_type', d.charger_type,
      'total_cost_excl_vat', d.total_cost_excl_vat,
      'deal_date', d.deal_date
    ) as metadata,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.wod_deals d
  WHERE
    d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT LEAST(match_count, 30);
END;
$$;

COMMENT ON FUNCTION volterra_kb.match_wod_deals IS 'Vector similarity search over Wheel of Deal data. Used by n8n Supabase Vector Store node.';

-- ============================================================================
-- Grant permissions on volterra_kb functions
-- ============================================================================
GRANT
EXECUTE ON FUNCTION volterra_kb.match_training_conversations TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.match_documents TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.match_slack_messages TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.match_wod_deals TO anon,
authenticated,
service_role;

-- ============================================================================
-- Public schema wrappers for PostgREST discovery
-- These thin wrappers delegate to volterra_kb schema functions
-- ============================================================================
CREATE OR REPLACE FUNCTION public.match_training_conversations (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.match_training_conversations(query_embedding, match_threshold, match_count);
$$;

CREATE OR REPLACE FUNCTION public.match_documents (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.78,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.match_documents(query_embedding, match_threshold, match_count);
$$;

CREATE OR REPLACE FUNCTION public.match_slack_messages (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.match_slack_messages(query_embedding, match_threshold, match_count);
$$;

CREATE OR REPLACE FUNCTION public.match_wod_deals (
  query_embedding extensions.vector (1536),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'extensions',
  'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.match_wod_deals(query_embedding, match_threshold, match_count);
$$;

-- Grant permissions on public wrappers (with full signatures for uniqueness)
GRANT
EXECUTE ON FUNCTION public.match_training_conversations (extensions.vector, float, int) TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION public.match_documents (extensions.vector, float, int) TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION public.match_slack_messages (extensions.vector, float, int) TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION public.match_wod_deals (extensions.vector, float, int) TO anon,
authenticated,
service_role;

-- ============================================================================
-- Verification
-- ============================================================================
DO $$
BEGIN
  RAISE NOTICE 'Vector search functions created successfully.';
  RAISE NOTICE 'Functions available:';
  RAISE NOTICE '  - match_training_conversations (public and volterra_kb)';
  RAISE NOTICE '  - match_documents (public and volterra_kb)';
  RAISE NOTICE '  - match_slack_messages (public and volterra_kb)';
  RAISE NOTICE '  - match_wod_deals (public and volterra_kb)';
END $$;
