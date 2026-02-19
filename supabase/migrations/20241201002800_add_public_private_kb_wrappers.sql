-- Migration: Add public wrapper functions for private_kb access
-- Purpose: Enable REST API access to volterra_kb and private_kb from scripts
-- Date: 2025-12-30
-- ============================================================================
-- Public wrapper to get private database list
-- This is needed because volterra_kb schema is not exposed via PostgREST
CREATE OR REPLACE FUNCTION public.get_private_databases () RETURNS TABLE (
  notion_database_id TEXT,
  name TEXT,
  database_type TEXT,
  target_schema TEXT
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT
        d.notion_database_id,
        d.name,
        d.database_type,
        d.target_schema
    FROM volterra_kb.notion_databases d
    WHERE d.is_private = TRUE
    ORDER BY d.name;
$$;

COMMENT ON FUNCTION public.get_private_databases IS 'Public wrapper: List databases configured for private_kb schema routing';

-- Grant execute to service role
GRANT
EXECUTE ON FUNCTION public.get_private_databases TO service_role;

-- ============================================================================
-- PRIVATE_KB WRAPPER FUNCTIONS
-- These are needed because private_kb schema is not exposed via PostgREST
-- ============================================================================
-- Check if document exists by content hash
CREATE OR REPLACE FUNCTION public.private_kb_document_exists (p_content_hash TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'private_kb',
  'public' AS $$
    SELECT EXISTS (
        SELECT 1 FROM private_kb.documents
        WHERE content_hash = p_content_hash
    );
$$;

COMMENT ON FUNCTION public.private_kb_document_exists IS 'Check if document exists in private_kb by content hash';

GRANT
EXECUTE ON FUNCTION public.private_kb_document_exists TO service_role;

-- Get document by source path (for update checks)
CREATE OR REPLACE FUNCTION public.private_kb_get_document_by_source (p_source_type TEXT, p_source_path TEXT) RETURNS TABLE (id UUID, content_hash TEXT) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'private_kb',
  'public' AS $$
    SELECT d.id, d.content_hash
    FROM private_kb.documents d
    WHERE d.source_type = p_source_type
      AND d.source_path = p_source_path;
$$;

COMMENT ON FUNCTION public.private_kb_get_document_by_source IS 'Get private_kb document by source type and path';

GRANT
EXECUTE ON FUNCTION public.private_kb_get_document_by_source TO service_role;

-- Upsert document into private_kb
CREATE OR REPLACE FUNCTION public.private_kb_upsert_document (
  p_content TEXT,
  p_embedding extensions.vector (1536),
  p_title TEXT,
  p_document_type TEXT,
  p_source_type TEXT,
  p_source_path TEXT,
  p_notion_page_id TEXT DEFAULT NULL,
  p_notion_database_id TEXT DEFAULT NULL,
  p_tags TEXT[] DEFAULT NULL,
  p_content_hash TEXT DEFAULT NULL
) RETURNS TABLE (id UUID, created BOOLEAN) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = 'extensions',
  'private_kb',
  'public' AS $$
DECLARE
    v_id UUID;
    v_created BOOLEAN;
BEGIN
    -- Try to insert, on conflict update
    INSERT INTO private_kb.documents (
        content,
        embedding,
        title,
        document_type,
        source_type,
        source_path,
        notion_page_id,
        notion_database_id,
        tags,
        content_hash
    ) VALUES (
        p_content,
        p_embedding,
        p_title,
        p_document_type,
        p_source_type,
        p_source_path,
        p_notion_page_id,
        p_notion_database_id,
        p_tags,
        p_content_hash
    )
    ON CONFLICT (source_type, source_path) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        title = EXCLUDED.title,
        document_type = EXCLUDED.document_type,
        notion_page_id = EXCLUDED.notion_page_id,
        notion_database_id = EXCLUDED.notion_database_id,
        tags = EXCLUDED.tags,
        content_hash = EXCLUDED.content_hash,
        updated_at = NOW()
    RETURNING documents.id, (xmax = 0) INTO v_id, v_created;

    RETURN QUERY SELECT v_id, v_created;
END;
$$;

COMMENT ON FUNCTION public.private_kb_upsert_document IS 'Upsert document into private_kb with embedding';

GRANT
EXECUTE ON FUNCTION public.private_kb_upsert_document TO service_role;

-- Update sync state
CREATE OR REPLACE FUNCTION public.private_kb_update_sync_state (
  p_pages_processed INTEGER,
  p_pages_created INTEGER,
  p_pages_updated INTEGER,
  p_last_error TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = 'private_kb',
  'public' AS $$
BEGIN
    UPDATE private_kb.sync_state SET
        last_sync_at = NOW(),
        pages_processed = p_pages_processed,
        pages_created = p_pages_created,
        pages_updated = p_pages_updated,
        last_error = p_last_error,
        updated_at = NOW()
    WHERE id = 'default';
END;
$$;

COMMENT ON FUNCTION public.private_kb_update_sync_state IS 'Update private_kb sync state after batch run';

GRANT
EXECUTE ON FUNCTION public.private_kb_update_sync_state TO service_role;

-- Get sync status (wrapper for external access)
CREATE OR REPLACE FUNCTION public.private_kb_get_sync_status () RETURNS TABLE (
  last_sync_at TIMESTAMPTZ,
  pages_processed INTEGER,
  pages_created INTEGER,
  pages_updated INTEGER,
  last_error TEXT,
  document_count BIGINT
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'private_kb',
  'public' AS $$
    SELECT * FROM private_kb.get_sync_status();
$$;

COMMENT ON FUNCTION public.private_kb_get_sync_status IS 'Public wrapper for private_kb sync status';

GRANT
EXECUTE ON FUNCTION public.private_kb_get_sync_status TO service_role;
