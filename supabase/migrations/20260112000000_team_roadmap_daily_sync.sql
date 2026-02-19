-- Team Platform Roadmap Daily Sync
-- Created: 2026-01-12
-- Purpose: Schedule daily sync of Team Platform Roadmap Notion database to knowledge base
-- Schedule the Edge Function to run daily at 07:00 UTC (08:00 CET)
-- This syncs the Team Platform Roadmap database (YOUR_NOTION_DB_ID)
-- containing 580+ pages of platform documentation
SELECT
  cron.schedule (
    'team-roadmap-sync-daily',
    '0 7 * * *', -- Every day at 07:00 UTC
    $$
  SELECT
    net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/team-roadmap-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 1800000  -- 30 minute timeout for 580+ pages
    ) AS request_id;
  $$
  );

-- Create RPC function to manually trigger the sync (async pattern with Vault)
CREATE OR REPLACE FUNCTION volterra_kb.invoke_team_roadmap_sync () RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
  request_id bigint;
  service_key text;
BEGIN
  -- Get service role key from Vault
  SELECT decrypted_secret INTO service_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF service_key IS NULL THEN
    RAISE EXCEPTION 'Service role key not found in vault. Add it with: SELECT vault.create_secret(''your-key'', ''service_role_key'');';
  END IF;

  SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/team-roadmap-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || service_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 1800000
  ) INTO request_id;

  RETURN jsonb_build_object(
    'status', 'triggered',
    'request_id', request_id,
    'message', 'Team Roadmap sync started. Check Edge Function logs for results.'
  );
END;
$$;

-- Grant permissions
GRANT
EXECUTE ON FUNCTION volterra_kb.invoke_team_roadmap_sync () TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.invoke_team_roadmap_sync () TO anon;

-- Add comment
COMMENT ON FUNCTION volterra_kb.invoke_team_roadmap_sync () IS 'Manually trigger Team Platform Roadmap sync from Notion to knowledge base';

-- Log the setup
DO $$
BEGIN
  RAISE NOTICE 'Team Platform Roadmap daily sync configured:';
  RAISE NOTICE '  - Schedule: Every day at 07:00 UTC';
  RAISE NOTICE '  - Database: c9ea0b87-7c7e-4996-8c99-4419ac08a270';
  RAISE NOTICE '  - Data Source: YOUR_NOTION_DB_ID';
  RAISE NOTICE '  - Pages: ~580';
  RAISE NOTICE '  - Manual trigger: SELECT volterra_kb.invoke_team_roadmap_sync();';
END $$;
