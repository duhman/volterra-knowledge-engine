-- Migration: Setup cron job for Slack channel sync
-- Requires pg_cron and pg_net extensions (already enabled via migration 006)

-- ============================================================================
-- HELPER FUNCTION: Invoke Slack Channel Sync Edge Function
-- ============================================================================

CREATE OR REPLACE FUNCTION invoke_slack_channel_sync(
  p_channel_id TEXT DEFAULT 'C05FA8B5YPM',
  p_lookback_hours INTEGER DEFAULT 48,
  p_max_threads INTEGER DEFAULT 200,
  p_recheck_threads INTEGER DEFAULT 50
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  project_url TEXT;
  service_role_key TEXT;
  cron_secret TEXT;
  request_id BIGINT;
BEGIN
  -- Get secrets from Vault
  SELECT decrypted_secret INTO project_url 
  FROM vault.decrypted_secrets WHERE name = 'project_url';
  
  SELECT decrypted_secret INTO service_role_key 
  FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  
  SELECT decrypted_secret INTO cron_secret 
  FROM vault.decrypted_secrets WHERE name = 'cron_secret';
  
  IF project_url IS NULL OR service_role_key IS NULL THEN
    RAISE EXCEPTION 'Missing Vault secrets: project_url or service_role_key';
  END IF;
  
  -- Make async HTTP POST to Edge Function
  SELECT net.http_post(
    url := project_url || '/functions/v1/slack-channel-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key,
      'x-cron-secret', COALESCE(cron_secret, '')
    ),
    body := jsonb_build_object(
      'channel_id', p_channel_id,
      'lookback_hours', p_lookback_hours,
      'max_threads', p_max_threads,
      'recheck_threads', p_recheck_threads
    ),
    timeout_milliseconds := 300000  -- 5 minute timeout
  ) INTO request_id;
  
  RETURN request_id;
END;
$$;

-- ============================================================================
-- CRON JOB
-- ============================================================================

-- Daily Slack channel sync at 06:00 UTC (same time as HubSpot sync)
SELECT cron.schedule(
  'daily-slack-help-me-platform-sync',
  '0 6 * * *',  -- 06:00 UTC daily
  $$SELECT invoke_slack_channel_sync('C05FA8B5YPM', 48, 200, 50);$$
);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON FUNCTION invoke_slack_channel_sync IS 'Invokes slack-channel-sync Edge Function via pg_net with service role auth. Parameters: channel_id, lookback_hours, max_threads (new threads to fetch), recheck_threads (old threads to recheck for new replies)';
