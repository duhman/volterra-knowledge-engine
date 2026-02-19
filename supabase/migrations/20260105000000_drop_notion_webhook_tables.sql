-- Migration: Drop Notion webhook infrastructure (deprecated)
-- Purpose: Clean up webhook-only tables and functions after deprecating real-time sync
-- Date: 2026-01-05
-- Note: Batch sync (notion-pages-sync) continues to work - it never used these tables
-- ============================================================================
-- ============================================================================
-- DROP RPC FUNCTIONS (must drop before tables they reference)
-- ============================================================================
-- Webhook event functions (from 002400)
DROP FUNCTION IF EXISTS volterra_kb.webhook_event_exists (TEXT);

DROP FUNCTION IF EXISTS volterra_kb.log_webhook_event (TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB);

DROP FUNCTION IF EXISTS volterra_kb.mark_webhook_event_completed (TEXT);

DROP FUNCTION IF EXISTS volterra_kb.mark_webhook_event_failed (TEXT, TEXT);

-- User resolution functions (from 002500)
DROP FUNCTION IF EXISTS volterra_kb.resolve_notion_user (TEXT);

DROP FUNCTION IF EXISTS volterra_kb.get_default_platform_lead ();

-- Database registry functions (from 002500, 002700)
DROP FUNCTION IF EXISTS volterra_kb.get_database_by_type (TEXT);

DROP FUNCTION IF EXISTS volterra_kb.is_webhook_database (TEXT);

DROP FUNCTION IF EXISTS volterra_kb.is_private_database (TEXT);

DROP FUNCTION IF EXISTS volterra_kb.get_database_target_schema (TEXT);

DROP FUNCTION IF EXISTS volterra_kb.get_private_databases ();

-- ============================================================================
-- DROP TABLES (CASCADE handles policies, triggers, indexes)
-- ============================================================================
-- Webhook events table (from 002400)
DROP TABLE IF EXISTS volterra_kb.notion_webhook_events CASCADE;

-- Database registry table (from 002500, extended in 002700)
DROP TABLE IF EXISTS volterra_kb.notion_databases CASCADE;

-- User registry table (from 002500)
DROP TABLE IF EXISTS volterra_kb.notion_users CASCADE;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After running, verify with:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'volterra_kb' AND table_name LIKE 'notion%';
-- Expected: Only notion_pages and notion_sync_state remain
