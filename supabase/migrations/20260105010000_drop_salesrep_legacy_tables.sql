-- Migration: Drop legacy ElevenLabs architecture tables
-- Purpose: Remove unused tables from original ElevenLabs implementation
-- Date: 2026-01-05
-- Note: Active pipeline uses Telavox tables (calls, transcriptions, telavox_*)
-- Reference: lib/mcp-servers/supabase/README.md documents this as legacy
-- ============================================================================
-- Drop in reverse dependency order (children before parents)
-- 1. Drop sync_history (depends on conversations.conversation_id)
DROP TABLE IF EXISTS sales_rep.sync_history CASCADE;

-- 2. Drop sync_queue (depends on conversations.conversation_id)
DROP TABLE IF EXISTS sales_rep.sync_queue CASCADE;

-- 3. Drop insights (depends on conversations.conversation_id)
DROP TABLE IF EXISTS sales_rep.insights CASCADE;

-- 4. Drop conversations (depends on users.id)
DROP TABLE IF EXISTS sales_rep.conversations CASCADE;

-- 5. Drop users (no dependencies, root table)
DROP TABLE IF EXISTS sales_rep.users CASCADE;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After running, verify with:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'sales_rep' ORDER BY table_name;
--
-- Expected remaining tables:
-- - blocked_numbers
-- - calls
-- - settings
-- - telavox_api_keys
-- - telavox_call_sessions
-- - telavox_job_queue
-- - telavox_org_configs
-- - transcriptions
-- - webhook_logs
