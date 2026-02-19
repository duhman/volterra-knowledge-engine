-- Migration: Create private_kb schema for personal/private content
-- Purpose: Isolated schema for meeting transcriptions and private Notion content
-- Date: 2025-12-30
-- ============================================================================
-- Create isolated schema
CREATE SCHEMA IF NOT EXISTS private_kb;

-- Grant permissions (service role only for writes, anon for reads)
GRANT USAGE ON SCHEMA private_kb TO anon,
authenticated,
service_role;

GRANT ALL ON SCHEMA private_kb TO postgres;

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA private_kb
GRANT
SELECT
  ON TABLES TO anon,
  authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA private_kb
GRANT ALL ON TABLES TO service_role;

-- ============================================================================
-- DOCUMENTS TABLE (mirrors volterra_kb.documents structure)
-- ============================================================================
CREATE TABLE IF NOT EXISTS private_kb.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Core content
  content TEXT NOT NULL,
  embedding extensions.vector (1536), -- text-embedding-3-small dimensions
  -- Metadata (simplified for private use)
  department TEXT NOT NULL DEFAULT 'Private',
  document_type TEXT NOT NULL DEFAULT 'Meeting Transcript',
  title TEXT NOT NULL,
  owner TEXT,
  access_level TEXT NOT NULL DEFAULT 'confidential' CHECK (
    access_level IN ('internal', 'restricted', 'confidential')
  ),
  -- Optional metadata
  tags TEXT[],
  sensitivity TEXT DEFAULT 'PII' CHECK (sensitivity IN ('GDPR', 'PII', 'None')),
  language TEXT,
  -- Source tracking
  source_type TEXT DEFAULT 'notion',
  source_path TEXT NOT NULL,
  notion_page_id TEXT,
  notion_database_id TEXT,
  original_filename TEXT,
  mime_type TEXT,
  file_size BIGINT,
  -- Content hash for deduplication
  content_hash TEXT,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Unique constraint for upserts
  UNIQUE (source_type, source_path)
);

-- ============================================================================
-- SYNC STATE TABLE (minimal tracking)
-- ============================================================================
CREATE TABLE IF NOT EXISTS private_kb.sync_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  last_sync_at TIMESTAMPTZ,
  pages_processed INTEGER DEFAULT 0,
  pages_created INTEGER DEFAULT 0,
  pages_updated INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default row
INSERT INTO
  private_kb.sync_state (id)
VALUES
  ('default')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- INDEXES
-- ============================================================================
-- HNSW vector index (better than IVFFlat for our scale)
-- Note: vector_cosine_ops is in extensions schema on Supabase Cloud
CREATE INDEX IF NOT EXISTS idx_private_documents_embedding ON private_kb.documents USING hnsw (embedding extensions.vector_cosine_ops)
WITH
  (m = 16, ef_construction = 64);

-- Standard indexes
CREATE INDEX IF NOT EXISTS idx_private_documents_source_path ON private_kb.documents (source_path);

CREATE INDEX IF NOT EXISTS idx_private_documents_notion_page_id ON private_kb.documents (notion_page_id)
WHERE
  notion_page_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_private_documents_notion_database_id ON private_kb.documents (notion_database_id)
WHERE
  notion_database_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_private_documents_created_at ON private_kb.documents (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_private_documents_tags ON private_kb.documents USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_private_documents_content_hash ON private_kb.documents (content_hash)
WHERE
  content_hash IS NOT NULL;

-- ============================================================================
-- TRIGGERS
-- ============================================================================
DROP TRIGGER IF EXISTS update_private_documents_updated_at ON private_kb.documents;

CREATE TRIGGER update_private_documents_updated_at BEFORE
UPDATE ON private_kb.documents FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column ();

DROP TRIGGER IF EXISTS update_private_sync_state_updated_at ON private_kb.sync_state;

CREATE TRIGGER update_private_sync_state_updated_at BEFORE
UPDATE ON private_kb.sync_state FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column ();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE private_kb.documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE private_kb.sync_state ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access on private_documents" ON private_kb.documents FOR ALL USING (true)
WITH
  CHECK (true);

CREATE POLICY "Service role full access on private_sync_state" ON private_kb.sync_state FOR ALL USING (true)
WITH
  CHECK (true);

-- Anon can read (for MCP tools - schema provides isolation)
CREATE POLICY "Anon can read private_documents" ON private_kb.documents FOR
SELECT
  USING (true);

CREATE POLICY "Anon can read private_sync_state" ON private_kb.sync_state FOR
SELECT
  USING (true);

-- ============================================================================
-- SEMANTIC SEARCH FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION private_kb.match_documents (
  query_embedding extensions.vector (1536),
  match_threshold FLOAT DEFAULT 0.78,
  match_count INT DEFAULT 10
) RETURNS TABLE (
  id UUID,
  content TEXT,
  title TEXT,
  document_type TEXT,
  source_path TEXT,
  notion_page_id TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ,
  similarity FLOAT
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = 'extensions',
  'private_kb',
  'public' AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.content,
        d.title,
        d.document_type,
        d.source_path,
        d.notion_page_id,
        d.tags,
        d.created_at,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM private_kb.documents d
    WHERE (1 - (d.embedding <=> query_embedding)) > match_threshold
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ============================================================================
-- UTILITY FUNCTIONS
-- ============================================================================
-- Get document count
CREATE OR REPLACE FUNCTION private_kb.get_document_count () RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'private_kb',
  'public' AS $$
    SELECT COUNT(*) FROM private_kb.documents;
$$;

-- Get sync status
CREATE OR REPLACE FUNCTION private_kb.get_sync_status () RETURNS TABLE (
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
    SELECT
        s.last_sync_at,
        s.pages_processed,
        s.pages_created,
        s.pages_updated,
        s.last_error,
        (SELECT COUNT(*) FROM private_kb.documents) AS document_count
    FROM private_kb.sync_state s
    WHERE s.id = 'default';
$$;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON SCHEMA private_kb IS 'Isolated schema for private/personal content (meeting transcripts, notes)';

COMMENT ON TABLE private_kb.documents IS 'Private documents with vector embeddings - isolated from volterra_kb';

COMMENT ON TABLE private_kb.sync_state IS 'Sync state tracking for private Notion pages';

COMMENT ON FUNCTION private_kb.match_documents IS 'Semantic search in private documents';

COMMENT ON FUNCTION private_kb.get_document_count IS 'Get total count of private documents';

COMMENT ON FUNCTION private_kb.get_sync_status IS 'Get sync status and document count';
