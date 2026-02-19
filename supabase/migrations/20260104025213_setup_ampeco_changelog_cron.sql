-- Schedule ampeco-changelog-monitor Edge Function to run daily at 12:00 UTC
SELECT cron.schedule(
  'ampeco-changelog-monitor',
  '0 12 * * *',
  $$
  SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/ampeco-changelog-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true)
    ),
    body := '{}'::jsonb
  );
  $$
);
