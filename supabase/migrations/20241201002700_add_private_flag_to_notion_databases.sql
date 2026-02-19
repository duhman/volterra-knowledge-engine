-- Migration: Add private flag and target schema to notion_databases
-- Purpose: Enable routing webhook events to different schemas based on database type
-- Date: 2025-12-30
-- ============================================================================
-- Add is_private flag
ALTER TABLE volterra_kb.notion_databases
ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;

-- Add target_schema column for explicit schema routing
ALTER TABLE volterra_kb.notion_databases
ADD COLUMN IF NOT EXISTS target_schema TEXT DEFAULT 'volterra_kb';

-- ============================================================================
-- INDEXES
-- ============================================================================
-- Fast lookup for private databases
CREATE INDEX IF NOT EXISTS idx_notion_databases_private ON volterra_kb.notion_databases (is_private)
WHERE
  is_private = TRUE;

-- Index for schema routing
CREATE INDEX IF NOT EXISTS idx_notion_databases_target_schema ON volterra_kb.notion_databases (target_schema);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================
-- Check if a database is marked as private
CREATE OR REPLACE FUNCTION volterra_kb.is_private_database (p_database_id TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT COALESCE(
        (SELECT is_private FROM volterra_kb.notion_databases
         WHERE notion_database_id = p_database_id),
        FALSE
    );
$$;

-- Get target schema for a database (defaults to volterra_kb)
CREATE OR REPLACE FUNCTION volterra_kb.get_database_target_schema (p_database_id TEXT) RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
    SELECT COALESCE(
        (SELECT target_schema FROM volterra_kb.notion_databases
         WHERE notion_database_id = p_database_id),
        'volterra_kb'
    );
$$;

-- Get all private databases
CREATE OR REPLACE FUNCTION volterra_kb.get_private_databases () RETURNS TABLE (
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

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON COLUMN volterra_kb.notion_databases.is_private IS 'True for databases containing private/personal content (routes to private_kb schema)';

COMMENT ON COLUMN volterra_kb.notion_databases.target_schema IS 'Target schema for webhook events (volterra_kb or private_kb)';

COMMENT ON FUNCTION volterra_kb.is_private_database IS 'Check if a database is marked as private';

COMMENT ON FUNCTION volterra_kb.get_database_target_schema IS 'Get target schema for webhook routing (defaults to volterra_kb)';

COMMENT ON FUNCTION volterra_kb.get_private_databases IS 'List all databases configured for private schema routing';
