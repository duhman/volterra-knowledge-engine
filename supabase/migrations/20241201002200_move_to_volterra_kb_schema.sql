-- Migration: Move volterra-kb tables from public to volterra_kb schema
-- Purpose: Isolate knowledge base tables in dedicated schema for multi-project organization
-- Date: 2025-12-25
-- Tables affected: 14 tables (documents, training_*, slack_*, wod_*, notion_*, sync state)

-- Create new schema
CREATE SCHEMA IF NOT EXISTS volterra_kb;

-- Grant permissions
GRANT USAGE ON SCHEMA volterra_kb TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA volterra_kb TO postgres;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA volterra_kb
  GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA volterra_kb
  GRANT ALL ON TABLES TO service_role;

-- Move tables (order matters: parents before children)
-- This preserves all data, indexes, foreign keys, sequences, and RLS policies

-- Parent tables first (no FK dependencies)
ALTER TABLE public.documents SET SCHEMA volterra_kb;
ALTER TABLE public.training_conversations SET SCHEMA volterra_kb;
ALTER TABLE public.slack_threads SET SCHEMA volterra_kb;
ALTER TABLE public.wod_deals SET SCHEMA volterra_kb;
ALTER TABLE public.wod_cost_catalog SET SCHEMA volterra_kb;
ALTER TABLE public.notion_pages SET SCHEMA volterra_kb;

-- Sync state tables (no FK dependencies)
ALTER TABLE public.notion_sync_state SET SCHEMA volterra_kb;
ALTER TABLE public.slack_channel_sync_state SET SCHEMA volterra_kb;
ALTER TABLE public.hubspot_ticket_sync_state SET SCHEMA volterra_kb;

-- Child tables with foreign key dependencies
ALTER TABLE public.training_messages SET SCHEMA volterra_kb;
ALTER TABLE public.slack_messages SET SCHEMA volterra_kb;
ALTER TABLE public.wod_deal_circuits SET SCHEMA volterra_kb;
ALTER TABLE public.wod_deal_costs SET SCHEMA volterra_kb;
ALTER TABLE public.wod_deal_offers SET SCHEMA volterra_kb;

-- Update search_path for roles
-- This allows code to reference tables without schema prefix (e.g., .from('documents'))
-- Postgres will search volterra_kb first, then fall back to public
ALTER ROLE anon SET search_path TO volterra_kb, public;
ALTER ROLE authenticated SET search_path TO volterra_kb, public;
ALTER ROLE service_role SET search_path TO volterra_kb, public;

-- Verification queries (commented out - run manually after migration)
-- SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'volterra_kb' ORDER BY tablename;
-- Expected: 14 tables
--
-- SELECT COUNT(*) FROM volterra_kb.wod_deal_circuits WHERE deal_id IN (SELECT id FROM volterra_kb.wod_deals);
-- Should equal total circuits count
--
-- SELECT COUNT(*) FROM volterra_kb.documents WHERE embedding IS NOT NULL;
-- Should match previous count

-- Note: RLS policies, indexes, foreign keys, and sequences move automatically with tables
-- Note: This migration is instant (metadata-only change, no data movement)
