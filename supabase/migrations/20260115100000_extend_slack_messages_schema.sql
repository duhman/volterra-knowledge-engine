-- Migration: Extend slack_messages schema with additional fields from Slack exports
-- Captures: first_name, username, team_id, edit info, client_msg_id, parent_user_id
-- All fields are available in raw JSONB, now extracted for querying
SET
  search_path TO volterra_kb,
  public;

-- ============================================================================
-- ADD NEW COLUMNS
-- ============================================================================
ALTER TABLE slack_messages
ADD COLUMN IF NOT EXISTS user_first_name TEXT,
ADD COLUMN IF NOT EXISTS username TEXT,
ADD COLUMN IF NOT EXISTS team_id TEXT,
ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS edited_by TEXT,
ADD COLUMN IF NOT EXISTS client_msg_id TEXT,
ADD COLUMN IF NOT EXISTS parent_user_id TEXT;

-- ============================================================================
-- INDEXES FOR NEW COLUMNS
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_slack_messages_username ON slack_messages (username);

CREATE INDEX IF NOT EXISTS idx_slack_messages_team_id ON slack_messages (team_id);

CREATE INDEX IF NOT EXISTS idx_slack_messages_parent_user_id ON slack_messages (parent_user_id);

-- ============================================================================
-- BACKFILL EXISTING RECORDS FROM RAW JSONB
-- ============================================================================
UPDATE slack_messages
SET
  user_first_name = raw -> 'user_profile' ->> 'first_name',
  username = raw -> 'user_profile' ->> 'name',
  team_id = raw ->> 'team',
  edited_at = CASE
    WHEN raw -> 'edited' ->> 'ts' IS NOT NULL THEN to_timestamp((raw -> 'edited' ->> 'ts')::float)
    ELSE NULL
  END,
  edited_by = raw -> 'edited' ->> 'user',
  client_msg_id = raw ->> 'client_msg_id',
  parent_user_id = raw ->> 'parent_user_id'
WHERE
  raw IS NOT NULL;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON COLUMN slack_messages.user_first_name IS 'First name from user_profile (e.g., "Adrian")';

COMMENT ON COLUMN slack_messages.username IS 'Slack username from user_profile.name (e.g., "adrian.andrei")';

COMMENT ON COLUMN slack_messages.team_id IS 'Slack team/workspace ID';

COMMENT ON COLUMN slack_messages.edited_at IS 'Timestamp when message was last edited';

COMMENT ON COLUMN slack_messages.edited_by IS 'User ID who last edited the message';

COMMENT ON COLUMN slack_messages.client_msg_id IS 'Client-generated unique message ID';

COMMENT ON COLUMN slack_messages.parent_user_id IS 'User ID of thread root author (for thread replies)';
