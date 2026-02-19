-- Meeting Notes Daily Sync
-- Created: 2026-01-13
-- Purpose: Schedule daily sync of Meeting Notes Notion database to knowledge base
-- Schedule the Edge Function to run daily at 08:00 UTC (09:00 CET)
-- This syncs the Meeting Notes database (a7105d5b-0b32-431f-95fa-1ec25cf8a568)
-- containing 154+ pages of cross-functional meeting documentation
SELECT
  cron.schedule (
    'meeting-notes-sync-daily',
    '0 8 * * *', -- Every day at 08:00 UTC
    $$
  SELECT
    net.http_post(
      url := current_setting('app.settings.supabase_url') || '/functions/v1/meeting-notes-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 1800000  -- 30 minute timeout for safety
    ) AS request_id;
  $$
  );

-- Create RPC function to manually trigger the sync (async pattern with Vault)
CREATE OR REPLACE FUNCTION volterra_kb.invoke_meeting_notes_sync () RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
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
    url := 'https://your-project.supabase.co/functions/v1/meeting-notes-sync',
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
    'message', 'Meeting Notes sync started. Check Edge Function logs for results.'
  );
END;
$$;

-- Grant permissions
GRANT
EXECUTE ON FUNCTION volterra_kb.invoke_meeting_notes_sync () TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.invoke_meeting_notes_sync () TO anon;

-- Add comment
COMMENT ON FUNCTION volterra_kb.invoke_meeting_notes_sync () IS 'Manually trigger Meeting Notes sync from Notion to knowledge base';

-- Log the setup
DO $$
BEGIN
  RAISE NOTICE 'Meeting Notes daily sync configured:';
  RAISE NOTICE '  - Schedule: Every day at 08:00 UTC';
  RAISE NOTICE '  - Database: 83080877-05f0-4dbb-bf80-09bb7f15a2fb';
  RAISE NOTICE '  - Data Source: a7105d5b-0b32-431f-95fa-1ec25cf8a568';
  RAISE NOTICE '  - Pages: ~154';
  RAISE NOTICE '  - Manual trigger: SELECT volterra_kb.invoke_meeting_notes_sync();';
END $$;
