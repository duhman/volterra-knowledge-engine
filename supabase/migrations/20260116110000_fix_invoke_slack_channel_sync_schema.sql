-- Migration: Fix invoke_slack_channel_sync schema
-- Problem: Function exists in public schema but cron jobs call volterra_kb.invoke_slack_channel_sync
-- Solution: Create function in volterra_kb schema
SET
  search_path TO volterra_kb,
  public;

-- ============================================================================
-- CREATE FUNCTION IN VOLTERRA_KB SCHEMA
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.invoke_slack_channel_sync (
  p_channel_id TEXT DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_lookback_hours INTEGER DEFAULT 48,
  p_max_threads INTEGER DEFAULT 200,
  p_recheck_threads INTEGER DEFAULT 50
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
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
-- GRANTS
-- ============================================================================
GRANT
EXECUTE ON FUNCTION volterra_kb.invoke_slack_channel_sync TO service_role,
anon;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON FUNCTION volterra_kb.invoke_slack_channel_sync IS 'Invokes slack-channel-sync Edge Function via pg_net with service role auth.
   Parameters: channel_id, lookback_hours, max_threads (new threads to fetch),
   recheck_threads (old threads to recheck for new replies).
   Reads secrets from Vault: project_url, service_role_key, cron_secret.';
