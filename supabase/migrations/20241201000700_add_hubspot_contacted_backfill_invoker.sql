-- Migration: Add SQL helper to invoke hubspot-ticket-contacted-backfill Edge Function
-- This allows manual batch backfill via SQL: SELECT invoke_hubspot_ticket_contacted_backfill(100);

CREATE OR REPLACE FUNCTION invoke_hubspot_ticket_contacted_backfill(
  batch_size INT DEFAULT 100
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
  SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO service_role_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret';

  IF project_url IS NULL OR service_role_key IS NULL THEN
    RAISE EXCEPTION 'Missing Vault secrets: project_url or service_role_key';
  END IF;

  -- Invoke Edge Function via pg_net
  SELECT net.http_post(
    url := project_url || '/functions/v1/hubspot-ticket-contacted-backfill',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key,
      'x-cron-secret', COALESCE(cron_secret, '')
    ),
    body := jsonb_build_object(
      'batch_size', batch_size
    ),
    timeout_milliseconds := 300000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

-- Grant execute to postgres role
GRANT EXECUTE ON FUNCTION invoke_hubspot_ticket_contacted_backfill(INT) TO postgres;

COMMENT ON FUNCTION invoke_hubspot_ticket_contacted_backfill IS 'Manually invoke backfill of hs_num_times_contacted for existing tickets. Run repeatedly until all nulls are filled.';
