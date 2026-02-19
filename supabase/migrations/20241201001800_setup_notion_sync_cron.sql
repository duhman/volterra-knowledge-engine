-- Migration: Setup cron job for Notion pages sync
-- Requires pg_cron and pg_net extensions (already enabled)

-- ============================================================================
-- HELPER FUNCTION: Invoke Notion Pages Sync Edge Function
-- ============================================================================

CREATE OR REPLACE FUNCTION invoke_notion_pages_sync(
  p_max_pages INTEGER DEFAULT 1000,
  p_force_reembed BOOLEAN DEFAULT FALSE
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
    url := project_url || '/functions/v1/notion-pages-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_role_key,
      'x-cron-secret', COALESCE(cron_secret, '')
    ),
    body := jsonb_build_object(
      'max_pages', p_max_pages,
      'force_reembed', p_force_reembed
    ),
    timeout_milliseconds := 600000  -- 10 minute timeout (Notion sync can be slow)
  ) INTO request_id;
  
  RETURN request_id;
END;
$$;

-- ============================================================================
-- CRON JOB
-- ============================================================================

-- Daily Notion pages sync at 05:00 UTC (before Slack/HubSpot at 06:00)
SELECT cron.schedule(
  'daily-notion-pages-sync',
  '0 5 * * *',  -- 05:00 UTC daily
  $$SELECT invoke_notion_pages_sync(1000, FALSE);$$
);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON FUNCTION invoke_notion_pages_sync IS 
  'Invokes notion-pages-sync Edge Function via pg_net with service role auth. Parameters: max_pages (default 1000), force_reembed (default FALSE).';
