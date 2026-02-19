-- Migration: Setup cron jobs for HubSpot ticket sync and embedding generation
-- Requires pg_cron and pg_net extensions to be enabled (see migration 006)

-- ============================================================================
-- VAULT SECRETS (run manually - values are project-specific)
-- ============================================================================
-- NOTE: Run these SQL commands manually in SQL Editor with actual values:
--
-- Project URL (your Supabase API URL):
-- SELECT vault.create_secret('https://your-server.example.com', 'project_url');
--
-- Service Role Key (for invoking Edge Functions with verify_jwt=true):
-- SELECT vault.create_secret('your-service-role-key', 'service_role_key');
--
-- Cron Secret (optional, for x-cron-secret header validation):
-- SELECT vault.create_secret('your-random-cron-secret', 'cron_secret');

-- ============================================================================
-- HELPER FUNCTION: Invoke Edge Function with proper auth
-- ============================================================================

CREATE OR REPLACE FUNCTION invoke_hubspot_tickets_sync(
  lookback_hours INTEGER DEFAULT 48,
  ticket_limit INTEGER DEFAULT 500
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
    url := project_url || '/functions/v1/hubspot-tickets-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key,
      'x-cron-secret', COALESCE(cron_secret, '')
    ),
    body := jsonb_build_object(
      'lookback_hours', lookback_hours,
      'limit', ticket_limit
    ),
    timeout_milliseconds := 300000  -- 5 minute timeout
  ) INTO request_id;
  
  RETURN request_id;
END;
$$;

CREATE OR REPLACE FUNCTION invoke_generate_embeddings(
  batch_size INTEGER DEFAULT 50
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  project_url TEXT;
  service_role_key TEXT;
  request_id BIGINT;
BEGIN
  -- Get secrets from Vault
  SELECT decrypted_secret INTO project_url 
  FROM vault.decrypted_secrets WHERE name = 'project_url';
  
  SELECT decrypted_secret INTO service_role_key 
  FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  
  IF project_url IS NULL OR service_role_key IS NULL THEN
    RAISE EXCEPTION 'Missing Vault secrets: project_url or service_role_key';
  END IF;
  
  -- Make async HTTP POST to Edge Function
  SELECT net.http_post(
    url := project_url || '/functions/v1/generate-embeddings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key
    ),
    body := jsonb_build_object(
      'batch_size', batch_size
    ),
    timeout_milliseconds := 300000  -- 5 minute timeout
  ) INTO request_id;
  
  RETURN request_id;
END;
$$;

-- ============================================================================
-- CRON JOBS
-- ============================================================================

-- Daily HubSpot ticket sync at 06:00 UTC
SELECT cron.schedule(
  'daily-hubspot-ticket-sync',
  '0 6 * * *',  -- 06:00 UTC daily
  $$SELECT invoke_hubspot_tickets_sync(48, 500);$$
);

-- Embedding backfill every 15 minutes
SELECT cron.schedule(
  'periodic-embedding-generation',
  '*/15 * * * *',  -- Every 15 minutes
  $$SELECT invoke_generate_embeddings(50);$$
);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON FUNCTION invoke_hubspot_tickets_sync IS 'Invokes hubspot-tickets-sync Edge Function via pg_net with service role auth';
COMMENT ON FUNCTION invoke_generate_embeddings IS 'Invokes generate-embeddings Edge Function via pg_net with service role auth';
