-- Migration: Add n8n-compatible chronological Slack query functions
-- Purpose: Enable n8n AI agent to query "latest N messages" and date-range queries
-- Date: 2026-01-15
--
-- Background: The MCP server (mcp-readonly) implements slack_latest_messages as
-- JavaScript logic in the Edge Function. n8n uses Supabase RPC functions directly
-- and doesn't have access to MCP tools. These functions bridge that gap.
-- ============================================================================
-- ============================================================================
-- 0. Drop ALL existing overloads (handles multiple signatures dynamically)
-- ============================================================================
-- Using pg_proc catalog to find and drop all overloaded versions
-- Reference: https://www.postgresql.org/docs/current/catalog-pg-proc.html
DO $$
DECLARE
  func_record RECORD;
  drop_sql TEXT;
BEGIN
  -- Find and drop all overloads of our target functions
  FOR func_record IN
    SELECT
      n.nspname as schema_name,
      p.proname as func_name,
      pg_get_function_identity_arguments(p.oid) as func_args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname IN ('public', 'volterra_kb')
      AND p.proname IN (
        'get_latest_slack_messages',
        'get_slack_messages_by_date',
        'get_slack_thread_messages',
        'get_slack_channel_summary'
      )
  LOOP
    drop_sql := format(
      'DROP FUNCTION IF EXISTS %I.%I(%s)',
      func_record.schema_name,
      func_record.func_name,
      func_record.func_args
    );
    RAISE NOTICE 'Dropping: %', drop_sql;
    EXECUTE drop_sql;
  END LOOP;
END $$;

-- ============================================================================
-- 1. get_latest_slack_messages - Most recent N messages from a channel
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.get_latest_slack_messages (
  p_channel_id text DEFAULT 'C05FA8B5YPM',
  p_limit int DEFAULT 20
) RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  user_real_name text,
  text text,
  message_at timestamptz,
  has_files boolean,
  file_count int,
  bot_id text,
  subtype text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.id,
    sm.channel_id,
    sm.message_ts,
    sm.thread_ts,
    sm.user_id,
    sm.user_display_name,
    sm.user_real_name,
    sm.text,
    sm.message_at,
    sm.has_files,
    sm.file_count,
    sm.bot_id,
    sm.subtype
  FROM volterra_kb.slack_messages sm
  WHERE sm.channel_id = p_channel_id
  ORDER BY sm.message_at DESC
  LIMIT LEAST(p_limit, 200);  -- Cap at 200 for safety
END;
$$;

COMMENT ON FUNCTION volterra_kb.get_latest_slack_messages IS 'Get the most recent N messages from a Slack channel, ordered by time (newest first).
Default channel: C05FA8B5YPM (#help-me-platform). Max limit: 200.
Used by n8n AI agent for chronological queries.';

-- ============================================================================
-- 2. get_slack_messages_by_date - Messages within a date range
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.get_slack_messages_by_date (
  p_channel_id text DEFAULT 'C05FA8B5YPM',
  p_date_from timestamptz DEFAULT NOW() - INTERVAL '7 days',
  p_date_to timestamptz DEFAULT NOW(),
  p_limit int DEFAULT 50
) RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  user_real_name text,
  text text,
  message_at timestamptz,
  has_files boolean,
  file_count int,
  bot_id text,
  subtype text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.id,
    sm.channel_id,
    sm.message_ts,
    sm.thread_ts,
    sm.user_id,
    sm.user_display_name,
    sm.user_real_name,
    sm.text,
    sm.message_at,
    sm.has_files,
    sm.file_count,
    sm.bot_id,
    sm.subtype
  FROM volterra_kb.slack_messages sm
  WHERE sm.channel_id = p_channel_id
    AND sm.message_at >= p_date_from
    AND sm.message_at <= p_date_to
  ORDER BY sm.message_at DESC
  LIMIT LEAST(p_limit, 500);  -- Cap at 500 for date ranges
END;
$$;

COMMENT ON FUNCTION volterra_kb.get_slack_messages_by_date IS 'Get Slack messages within a date range from a channel, ordered by time (newest first).
Default channel: C05FA8B5YPM (#help-me-platform). Default range: last 7 days. Max limit: 500.
Used by n8n AI agent for time-based queries like "messages from last 24 hours".';

-- ============================================================================
-- 3. get_slack_thread_messages - All messages in a thread (chronological)
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.get_slack_thread_messages (
  p_thread_ts text,
  p_channel_id text DEFAULT 'C05FA8B5YPM'
) RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  user_real_name text,
  text text,
  message_at timestamptz,
  has_files boolean,
  file_count int,
  bot_id text,
  subtype text,
  is_root boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.id,
    sm.channel_id,
    sm.message_ts,
    sm.thread_ts,
    sm.user_id,
    sm.user_display_name,
    sm.user_real_name,
    sm.text,
    sm.message_at,
    sm.has_files,
    sm.file_count,
    sm.bot_id,
    sm.subtype,
    (sm.message_ts = p_thread_ts) as is_root
  FROM volterra_kb.slack_messages sm
  WHERE sm.channel_id = p_channel_id
    AND (sm.thread_ts = p_thread_ts OR sm.message_ts = p_thread_ts)
  ORDER BY sm.message_at ASC;  -- Chronological for threads
END;
$$;

COMMENT ON FUNCTION volterra_kb.get_slack_thread_messages IS 'Get all messages in a Slack thread, ordered chronologically (oldest first).
Includes the root message (is_root=true) and all replies.
Used by n8n AI agent to fetch complete thread conversations.';

-- ============================================================================
-- 4. get_slack_channel_summary - Quick stats for a channel
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.get_slack_channel_summary (
  p_channel_id text DEFAULT 'C05FA8B5YPM',
  p_days int DEFAULT 7
) RETURNS TABLE (
  channel_id text,
  total_messages bigint,
  messages_in_period bigint,
  unique_users bigint,
  threads_in_period bigint,
  earliest_message timestamptz,
  latest_message timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    p_channel_id as channel_id,
    COUNT(*) as total_messages,
    COUNT(*) FILTER (WHERE sm.message_at >= NOW() - (p_days || ' days')::interval) as messages_in_period,
    COUNT(DISTINCT sm.user_id) FILTER (WHERE sm.message_at >= NOW() - (p_days || ' days')::interval) as unique_users,
    COUNT(DISTINCT sm.thread_ts) FILTER (WHERE sm.message_at >= NOW() - (p_days || ' days')::interval) as threads_in_period,
    MIN(sm.message_at) as earliest_message,
    MAX(sm.message_at) as latest_message
  FROM volterra_kb.slack_messages sm
  WHERE sm.channel_id = p_channel_id;
END;
$$;

COMMENT ON FUNCTION volterra_kb.get_slack_channel_summary IS 'Get summary statistics for a Slack channel.
Shows total messages, recent activity count, unique users, and thread count.
Useful for n8n agent to understand channel activity before detailed queries.';

-- ============================================================================
-- Public schema wrappers for PostgREST discovery
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_latest_slack_messages (
  p_channel_id text DEFAULT 'C05FA8B5YPM',
  p_limit int DEFAULT 20
) RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  user_real_name text,
  text text,
  message_at timestamptz,
  has_files boolean,
  file_count int,
  bot_id text,
  subtype text
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.get_latest_slack_messages(p_channel_id, p_limit);
$$;

CREATE OR REPLACE FUNCTION public.get_slack_messages_by_date (
  p_channel_id text DEFAULT 'C05FA8B5YPM',
  p_date_from timestamptz DEFAULT NOW() - INTERVAL '7 days',
  p_date_to timestamptz DEFAULT NOW(),
  p_limit int DEFAULT 50
) RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  user_real_name text,
  text text,
  message_at timestamptz,
  has_files boolean,
  file_count int,
  bot_id text,
  subtype text
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.get_slack_messages_by_date(p_channel_id, p_date_from, p_date_to, p_limit);
$$;

CREATE OR REPLACE FUNCTION public.get_slack_thread_messages (
  p_thread_ts text,
  p_channel_id text DEFAULT 'C05FA8B5YPM'
) RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  user_real_name text,
  text text,
  message_at timestamptz,
  has_files boolean,
  file_count int,
  bot_id text,
  subtype text,
  is_root boolean
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.get_slack_thread_messages(p_thread_ts, p_channel_id);
$$;

CREATE OR REPLACE FUNCTION public.get_slack_channel_summary (
  p_channel_id text DEFAULT 'C05FA8B5YPM',
  p_days int DEFAULT 7
) RETURNS TABLE (
  channel_id text,
  total_messages bigint,
  messages_in_period bigint,
  unique_users bigint,
  threads_in_period bigint,
  earliest_message timestamptz,
  latest_message timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.get_slack_channel_summary(p_channel_id, p_days);
$$;

-- ============================================================================
-- Grant permissions
-- ============================================================================
-- volterra_kb schema functions
GRANT
EXECUTE ON FUNCTION volterra_kb.get_latest_slack_messages TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.get_slack_messages_by_date TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.get_slack_thread_messages TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.get_slack_channel_summary TO anon,
authenticated,
service_role;

-- public schema wrappers
GRANT
EXECUTE ON FUNCTION public.get_latest_slack_messages TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION public.get_slack_messages_by_date TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION public.get_slack_thread_messages TO anon,
authenticated,
service_role;

GRANT
EXECUTE ON FUNCTION public.get_slack_channel_summary TO anon,
authenticated,
service_role;

-- ============================================================================
-- Verification
-- ============================================================================
DO $$
BEGIN
  RAISE NOTICE 'Slack chronological query functions created successfully.';
  RAISE NOTICE 'Functions available:';
  RAISE NOTICE '  - get_latest_slack_messages(channel_id, limit)';
  RAISE NOTICE '  - get_slack_messages_by_date(channel_id, date_from, date_to, limit)';
  RAISE NOTICE '  - get_slack_thread_messages(thread_ts, channel_id)';
  RAISE NOTICE '  - get_slack_channel_summary(channel_id, days)';
  RAISE NOTICE '';
  RAISE NOTICE 'Example usage:';
  RAISE NOTICE '  SELECT * FROM get_latest_slack_messages(''C05FA8B5YPM'', 10);';
  RAISE NOTICE '  SELECT * FROM get_slack_messages_by_date(''C05FA8B5YPM'', NOW() - INTERVAL ''24 hours'', NOW(), 50);';
END $$;
