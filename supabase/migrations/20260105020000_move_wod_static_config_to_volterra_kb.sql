-- Migration: Move wod_static_config to volterra_kb schema
-- Purpose: Align with other WoD tables moved in migration 20241201002200
-- Date: 2026-01-05
-- ============================================================================
-- Move table to volterra_kb schema (if it exists in public)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'wod_static_config'
    ) THEN
        ALTER TABLE public.wod_static_config SET SCHEMA volterra_kb;
        RAISE NOTICE 'Moved wod_static_config from public to volterra_kb';
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'volterra_kb' AND table_name = 'wod_static_config'
    ) THEN
        RAISE NOTICE 'wod_static_config already in volterra_kb schema';
    ELSE
        RAISE NOTICE 'wod_static_config table does not exist';
    END IF;
END $$;
