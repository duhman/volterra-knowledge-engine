-- Migration: Add invoker function for slack-messages-embed Edge Function
-- For backfilling embeddings on existing slack_messages

CREATE OR REPLACE FUNCTION invoke_slack_messages_embed(
  p_batch_size INTEGER DEFAULT 50,
  p_channel_id TEXT DEFAULT NULL
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
    url := project_url || '/functions/v1/slack-messages-embed',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key,
      'x-cron-secret', COALESCE(cron_secret, '')
    ),
    body := jsonb_build_object(
      'batch_size', p_batch_size,
      'channel_id', p_channel_id
    ),
    timeout_milliseconds := 300000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION invoke_slack_messages_embed IS 
  'Invokes slack-messages-embed Edge Function to generate embeddings for slack_messages. Call repeatedly until all messages have embeddings.';
