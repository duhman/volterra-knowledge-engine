-- Migration: Create Notion pages sync tables for daily automated ingestion
-- Tracks all Notion pages accessible to the integration, enables change detection + delete propagation

-- ============================================================================
-- SYNC STATE TABLE (one row, global sync stats)
-- ============================================================================

CREATE TABLE IF NOT EXISTS notion_sync_state (
    id TEXT PRIMARY KEY DEFAULT 'default',
    
    -- Last run statistics
    last_run_at TIMESTAMPTZ,
    last_run_pages_seen INTEGER DEFAULT 0,
    last_run_pages_changed INTEGER DEFAULT 0,
    last_run_pages_deleted INTEGER DEFAULT 0,
    last_run_docs_upserted INTEGER DEFAULT 0,
    last_run_docs_deleted INTEGER DEFAULT 0,
    last_run_chunks_created INTEGER DEFAULT 0,
    last_run_failed_pages INTEGER DEFAULT 0,
    last_run_error TEXT,
    last_run_duration_ms INTEGER,
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert initial state row
INSERT INTO notion_sync_state (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- NOTION PAGES TABLE (one row per page)
-- ============================================================================

CREATE TABLE IF NOT EXISTS notion_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Notion identity
    notion_page_id TEXT NOT NULL UNIQUE,
    source_path TEXT NOT NULL UNIQUE,  -- notion://page/<id> or notion://db/<dbId>/page/<id>
    
    -- Page metadata from Notion API
    title TEXT NOT NULL,
    url TEXT,
    parent_type TEXT,  -- 'workspace', 'page_id', 'database_id'
    parent_id TEXT,    -- parent page/database ID if applicable
    database_id TEXT,  -- if page is from a database
    archived BOOLEAN DEFAULT FALSE,
    
    -- Change tracking
    notion_created_time TIMESTAMPTZ,
    notion_last_edited_time TIMESTAMPTZ,
    content_hash TEXT,  -- MD5 of rendered content, for detecting actual changes
    
    -- Document tracking
    doc_chunk_count INTEGER DEFAULT 0,
    last_ingested_at TIMESTAMPTZ,
    
    -- Sync tracking
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Fast lookup by Notion page ID
CREATE INDEX IF NOT EXISTS idx_notion_pages_notion_page_id 
    ON notion_pages(notion_page_id);

-- Find stale/removed pages (not seen in recent sync)
CREATE INDEX IF NOT EXISTS idx_notion_pages_last_seen_at 
    ON notion_pages(last_seen_at ASC);

-- Find pages needing re-ingestion (changed since last ingested)
CREATE INDEX IF NOT EXISTS idx_notion_pages_last_edited 
    ON notion_pages(notion_last_edited_time DESC);

-- Filter by database
CREATE INDEX IF NOT EXISTS idx_notion_pages_database_id 
    ON notion_pages(database_id) WHERE database_id IS NOT NULL;

-- Filter archived
CREATE INDEX IF NOT EXISTS idx_notion_pages_archived 
    ON notion_pages(archived) WHERE archived = TRUE;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at on notion_sync_state
DROP TRIGGER IF EXISTS update_notion_sync_state_updated_at ON notion_sync_state;
CREATE TRIGGER update_notion_sync_state_updated_at
    BEFORE UPDATE ON notion_sync_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at on notion_pages
DROP TRIGGER IF EXISTS update_notion_pages_updated_at ON notion_pages;
CREATE TRIGGER update_notion_pages_updated_at
    BEFORE UPDATE ON notion_pages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE notion_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE notion_pages ENABLE ROW LEVEL SECURITY;

-- Permissive policies for service role (matching existing pattern)
CREATE POLICY "Service role full access on notion_sync_state" 
    ON notion_sync_state FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on notion_pages" 
    ON notion_pages FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE notion_sync_state IS 'Global sync state for Notion pages ingestion';
COMMENT ON COLUMN notion_sync_state.last_run_pages_seen IS 'Total pages returned by Notion search in last run';
COMMENT ON COLUMN notion_sync_state.last_run_pages_changed IS 'Pages with content changes that were re-embedded';
COMMENT ON COLUMN notion_sync_state.last_run_pages_deleted IS 'Pages removed from Notion (no longer accessible)';

COMMENT ON TABLE notion_pages IS 'Tracks all Notion pages for change detection and delete propagation';
COMMENT ON COLUMN notion_pages.notion_page_id IS 'Notion page UUID (without dashes for source_path)';
COMMENT ON COLUMN notion_pages.source_path IS 'Stable identifier matching documents.source_path';
COMMENT ON COLUMN notion_pages.content_hash IS 'MD5 hash of rendered page content for change detection';
COMMENT ON COLUMN notion_pages.doc_chunk_count IS 'Number of document chunks created (for cleanup when count changes)';
COMMENT ON COLUMN notion_pages.last_seen_at IS 'Updated each sync run; pages not seen are considered deleted';
