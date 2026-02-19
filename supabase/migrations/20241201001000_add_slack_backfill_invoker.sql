-- Migration: Add Slack historical backfill invoker
-- Purpose: chunked backfill from latest -> oldest without Edge Function timeouts.

-- Helper function: invoke slack-channel-sync Edge Function in backfill mode.
CREATE OR REPLACE FUNCTION invoke_slack_channel_backfill(
  p_channel_id TEXT DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_target_oldest_iso TEXT DEFAULT '2023-07-03T00:00:00Z',
  p_max_threads INTEGER DEFAULT 200,
  p_max_history_pages INTEGER DEFAULT 2,
  p_history_page_limit INTEGER DEFAULT 100,
  p_generate_docs BOOLEAN DEFAULT FALSE
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
  SELECT decrypted_secret INTO project_url
  FROM vault.decrypted_secrets WHERE name = 'project_url';

  SELECT decrypted_secret INTO service_role_key
  FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  SELECT decrypted_secret INTO cron_secret
  FROM vault.decrypted_secrets WHERE name = 'cron_secret';

  IF project_url IS NULL OR service_role_key IS NULL THEN
    RAISE EXCEPTION 'Missing Vault secrets: project_url or service_role_key';
  END IF;

  SELECT net.http_post(
    url := project_url || '/functions/v1/slack-channel-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key,
      'x-cron-secret', COALESCE(cron_secret, '')
    ),
    body := jsonb_build_object(
      'mode', 'backfill',
      'channel_id', p_channel_id,
      'target_oldest_iso', p_target_oldest_iso,
      'max_threads', p_max_threads,
      'max_history_pages', p_max_history_pages,
      'history_page_limit', p_history_page_limit,
      'generate_docs', p_generate_docs,
      'recheck_threads', 0
    ),
    timeout_milliseconds := 300000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION invoke_slack_channel_backfill IS
  'Invokes slack-channel-sync Edge Function in backfill mode. Uses slack_channel_sync_state.cursor_oldest_ts as moving "latest" cursor and walks back to target_oldest_iso. Defaults: no embeddings (generate_docs=false).';
