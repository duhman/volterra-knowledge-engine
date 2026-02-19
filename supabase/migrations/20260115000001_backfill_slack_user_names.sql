-- Migration: Backfill user_display_name and user_real_name for existing Slack messages
-- Purpose: Update existing messages where we have user_id but null display/real names
-- Date: 2026-01-15
--
-- Background: The slack-channel-sync Edge Function was storing messages without
-- user profile info because conversations.history doesn't return user_profile.
-- Now that we've added a user cache, new messages will have names. This migration
-- creates an RPC function to backfill existing messages using the raw JSON.
-- ============================================================================
-- ============================================================================
-- 1. Create backfill function that extracts user info from raw JSON
-- ============================================================================
-- Note: We can't call Slack API from SQL, so we extract from the 'raw' column
-- which contains the original Slack message payload.
CREATE OR REPLACE FUNCTION volterra_kb.backfill_slack_user_names_from_raw () RETURNS TABLE (updated_count bigint, skipped_count bigint) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
  v_updated bigint := 0;
  v_skipped bigint := 0;
BEGIN
  -- Update messages where we have username in raw but display_name is null
  WITH to_update AS (
    SELECT
      id,
      raw->>'username' as raw_username,
      raw->'user_profile'->>'display_name' as raw_display_name,
      raw->'user_profile'->>'real_name' as raw_real_name
    FROM volterra_kb.slack_messages
    WHERE user_display_name IS NULL
      AND raw IS NOT NULL
      AND (raw->>'username' IS NOT NULL
           OR raw->'user_profile'->>'display_name' IS NOT NULL
           OR raw->'user_profile'->>'real_name' IS NOT NULL)
  )
  UPDATE volterra_kb.slack_messages m
  SET
    user_display_name = COALESCE(
      tu.raw_display_name,
      tu.raw_username,
      m.user_display_name
    ),
    user_real_name = COALESCE(
      tu.raw_real_name,
      tu.raw_username,
      m.user_real_name
    )
  FROM to_update tu
  WHERE m.id = tu.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Count remaining messages without names
  SELECT COUNT(*) INTO v_skipped
  FROM volterra_kb.slack_messages
  WHERE user_display_name IS NULL;

  RETURN QUERY SELECT v_updated, v_skipped;
END;
$$;

COMMENT ON FUNCTION volterra_kb.backfill_slack_user_names_from_raw IS 'Backfill user_display_name and user_real_name for existing Slack messages
by extracting from the raw JSON column. Returns count of updated and skipped messages.
Run after deploying the user cache fix to update historical data.';

-- ============================================================================
-- 2. Create public schema wrapper for PostgREST
-- ============================================================================
CREATE OR REPLACE FUNCTION public.backfill_slack_user_names_from_raw () RETURNS TABLE (updated_count bigint, skipped_count bigint) LANGUAGE sql SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
  SELECT * FROM volterra_kb.backfill_slack_user_names_from_raw();
$$;

-- ============================================================================
-- 3. Grant permissions
-- ============================================================================
GRANT
EXECUTE ON FUNCTION volterra_kb.backfill_slack_user_names_from_raw TO service_role;

GRANT
EXECUTE ON FUNCTION public.backfill_slack_user_names_from_raw TO service_role;

-- ============================================================================
-- 4. Run the backfill (optional - can be done manually)
-- ============================================================================
-- Uncomment to run automatically on migration:
-- SELECT * FROM volterra_kb.backfill_slack_user_names_from_raw();
-- ============================================================================
-- Verification
-- ============================================================================
DO $$
BEGIN
  RAISE NOTICE 'Slack user names backfill function created successfully.';
  RAISE NOTICE '';
  RAISE NOTICE 'To run the backfill manually:';
  RAISE NOTICE '  SELECT * FROM backfill_slack_user_names_from_raw();';
  RAISE NOTICE '';
  RAISE NOTICE 'Note: This only fills names available in the raw JSON column.';
  RAISE NOTICE 'For messages where user_profile was not captured, names will';
  RAISE NOTICE 'remain null until the next full sync with the user cache.';
END $$;
