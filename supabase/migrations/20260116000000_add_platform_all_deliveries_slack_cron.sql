-- Migration: Add platform-all-deliveries channel to daily Slack sync
-- Channel ID: YOUR_SLACK_CHANNEL_ID
-- Schedule: 06:15 UTC daily (offset from help-me-platform at 06:00)
SET
  search_path TO volterra_kb,
  public;

-- ============================================================================
-- STEP 1: REGISTER CHANNEL IN SYNC STATE TABLE
-- ============================================================================
INSERT INTO
  slack_channel_sync_state (channel_id, channel_name, lookback_hours)
VALUES
  ('YOUR_SLACK_CHANNEL_ID', 'platform-all-deliveries', 48)
ON CONFLICT (channel_id) DO UPDATE
SET
  channel_name = EXCLUDED.channel_name,
  lookback_hours = EXCLUDED.lookback_hours;

-- ============================================================================
-- STEP 2: SCHEDULE DAILY CRON JOB (15 MIN OFFSET TO AVOID OVERLAP)
-- ============================================================================
SELECT
  cron.schedule (
    'daily-slack-platform-all-deliveries-sync',
    '15 6 * * *',
    -- 06:15 UTC daily
    $$SELECT volterra_kb.invoke_slack_channel_sync('YOUR_SLACK_CHANNEL_ID', 48, 200, 50);$$
  );

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE slack_channel_sync_state IS 'Tracks Slack channel sync state for incremental syncing. Each channel has one row.';
