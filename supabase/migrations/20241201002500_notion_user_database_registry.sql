-- Migration: Create Notion user and database registry tables
-- Purpose: Map Notion user IDs to display names, track known databases for type-based queries
-- Date: 2025-12-29
-- ============================================================================
-- NOTION USERS TABLE (for Platform Lead / Stakeholder resolution)
-- ============================================================================
CREATE TABLE IF NOT EXISTS volterra_kb.notion_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Notion identity
  notion_user_id TEXT NOT NULL UNIQUE,
  -- User information
  display_name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  -- Organization context
  department TEXT, -- from Permission groups in CSV
  role TEXT, -- Member, Workspace owner, Guest
  -- Platform Lead default
  is_default_platform_lead BOOLEAN DEFAULT FALSE,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- NOTION DATABASES TABLE (for database type queries)
-- ============================================================================
CREATE TABLE IF NOT EXISTS volterra_kb.notion_databases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Notion identity
  notion_database_id TEXT NOT NULL UNIQUE,
  -- Database metadata
  name TEXT NOT NULL,
  database_type TEXT NOT NULL, -- 'tasks', 'projects', 'roadmap', 'meetings', 'transcripts'
  description TEXT,
  -- Hierarchy
  parent_database_id TEXT, -- for relations (e.g., tasks belong to projects)
  parent_page_id TEXT, -- if database is child of a page
  -- Schema information (from Notion API)
  property_schema JSONB,
  -- Sync configuration
  sync_enabled BOOLEAN DEFAULT TRUE,
  webhook_enabled BOOLEAN DEFAULT FALSE, -- true for meeting databases
  sync_priority INTEGER DEFAULT 1, -- lower = higher priority
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================
-- Fast user lookup by Notion ID
CREATE INDEX IF NOT EXISTS idx_notion_users_notion_id ON volterra_kb.notion_users (notion_user_id);

-- Find users by email
CREATE INDEX IF NOT EXISTS idx_notion_users_email ON volterra_kb.notion_users (email)
WHERE
  email IS NOT NULL;

-- Find default platform lead
CREATE INDEX IF NOT EXISTS idx_notion_users_default_lead ON volterra_kb.notion_users (is_default_platform_lead)
WHERE
  is_default_platform_lead = TRUE;

-- Fast database lookup by Notion ID
CREATE INDEX IF NOT EXISTS idx_notion_databases_notion_id ON volterra_kb.notion_databases (notion_database_id);

-- Find databases by type
CREATE INDEX IF NOT EXISTS idx_notion_databases_type ON volterra_kb.notion_databases (database_type);

-- Find webhook-enabled databases
CREATE INDEX IF NOT EXISTS idx_notion_databases_webhook ON volterra_kb.notion_databases (webhook_enabled)
WHERE
  webhook_enabled = TRUE;

-- ============================================================================
-- TRIGGERS
-- ============================================================================
DROP TRIGGER IF EXISTS update_notion_users_updated_at ON volterra_kb.notion_users;

CREATE TRIGGER update_notion_users_updated_at BEFORE
UPDATE ON volterra_kb.notion_users FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column ();

DROP TRIGGER IF EXISTS update_notion_databases_updated_at ON volterra_kb.notion_databases;

CREATE TRIGGER update_notion_databases_updated_at BEFORE
UPDATE ON volterra_kb.notion_databases FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column ();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE volterra_kb.notion_users ENABLE ROW LEVEL SECURITY;

ALTER TABLE volterra_kb.notion_databases ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY "Service role full access on notion_users" ON volterra_kb.notion_users FOR ALL USING (true)
WITH
  CHECK (true);

CREATE POLICY "Service role full access on notion_databases" ON volterra_kb.notion_databases FOR ALL USING (true)
WITH
  CHECK (true);

-- Anon can read (for MCP tools)
CREATE POLICY "Anon can read notion_users" ON volterra_kb.notion_users FOR
SELECT
  USING (true);

CREATE POLICY "Anon can read notion_databases" ON volterra_kb.notion_databases FOR
SELECT
  USING (true);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================
-- Resolve user name to Notion user ID
CREATE OR REPLACE FUNCTION volterra_kb.resolve_notion_user (p_name TEXT) RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT notion_user_id
    FROM volterra_kb.notion_users
    WHERE display_name ILIKE '%' || p_name || '%'
       OR email ILIKE '%' || p_name || '%'
    ORDER BY
        CASE WHEN display_name ILIKE p_name THEN 0 ELSE 1 END,
        display_name
    LIMIT 1;
$$;

-- Get default platform lead user ID
CREATE OR REPLACE FUNCTION volterra_kb.get_default_platform_lead () RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT notion_user_id
    FROM volterra_kb.notion_users
    WHERE is_default_platform_lead = TRUE
    LIMIT 1;
$$;

-- Get database ID by type
CREATE OR REPLACE FUNCTION volterra_kb.get_database_by_type (p_type TEXT) RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT notion_database_id
    FROM volterra_kb.notion_databases
    WHERE database_type = p_type
      AND sync_enabled = TRUE
    LIMIT 1;
$$;

-- Check if database is webhook-enabled (for real-time sync)
CREATE OR REPLACE FUNCTION volterra_kb.is_webhook_database (p_database_id TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT COALESCE(
        (SELECT webhook_enabled FROM volterra_kb.notion_databases WHERE notion_database_id = p_database_id),
        FALSE
    );
$$;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE volterra_kb.notion_users IS 'Maps Notion user IDs to display names for property resolution';

COMMENT ON COLUMN volterra_kb.notion_users.notion_user_id IS 'UUID from Notion API (user ID)';

COMMENT ON COLUMN volterra_kb.notion_users.is_default_platform_lead IS 'True for Adrian (default when Platform Lead not specified)';

COMMENT ON TABLE volterra_kb.notion_databases IS 'Registry of known Notion databases for type-based queries';

COMMENT ON COLUMN volterra_kb.notion_databases.database_type IS 'Semantic type: tasks, projects, roadmap, meetings, transcripts';

COMMENT ON COLUMN volterra_kb.notion_databases.webhook_enabled IS 'True for databases that should trigger real-time sync';

COMMENT ON COLUMN volterra_kb.notion_databases.property_schema IS 'JSON schema of database properties from Notion API';

COMMENT ON FUNCTION volterra_kb.resolve_notion_user IS 'Fuzzy match user name/email to Notion user ID';

COMMENT ON FUNCTION volterra_kb.get_default_platform_lead IS 'Get Notion user ID of default Platform Lead (Adrian)';

COMMENT ON FUNCTION volterra_kb.get_database_by_type IS 'Get Notion database ID by semantic type';
