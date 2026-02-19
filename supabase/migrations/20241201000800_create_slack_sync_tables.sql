-- Migration: Create Slack channel sync tables for daily automated ingestion
-- Stores full raw Slack message properties + sync state for incremental updates

-- ============================================================================
-- SYNC STATE TABLE (one row per channel)
-- ============================================================================

CREATE TABLE IF NOT EXISTS slack_channel_sync_state (
    channel_id TEXT PRIMARY KEY,
    channel_name TEXT NOT NULL,
    
    -- Incremental cursor: oldest timestamp we've fetched in recent window
    cursor_oldest_ts TEXT,
    
    -- Safety lookback window in hours (default 48h to catch edits/late replies)
    lookback_hours INTEGER DEFAULT 48,
    
    -- Last run statistics
    last_run_at TIMESTAMPTZ,
    last_run_threads_fetched INTEGER DEFAULT 0,
    last_run_threads_upserted INTEGER DEFAULT 0,
    last_run_messages_upserted INTEGER DEFAULT 0,
    last_run_docs_upserted INTEGER DEFAULT 0,
    last_run_failed_threads INTEGER DEFAULT 0,
    last_run_error TEXT,
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert initial state row for help-me-platform channel
INSERT INTO slack_channel_sync_state (channel_id, channel_name)
VALUES ('C05FA8B5YPM', 'help-me-platform')
ON CONFLICT (channel_id) DO NOTHING;

-- ============================================================================
-- SLACK THREADS TABLE (one row per thread root)
-- ============================================================================

CREATE TABLE IF NOT EXISTS slack_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Thread identity (unique per channel)
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    
    -- Thread metadata (extracted for querying)
    root_user_id TEXT,
    root_bot_id TEXT,
    root_subtype TEXT,
    root_text TEXT,
    root_message_at TIMESTAMPTZ,
    
    -- Thread statistics
    reply_count INTEGER DEFAULT 0,
    latest_reply_ts TEXT,
    message_count INTEGER DEFAULT 1,
    participant_user_ids TEXT[],
    participant_count INTEGER DEFAULT 1,
    
    -- Full raw JSON for root message
    root_raw JSONB,
    
    -- Document tracking (for cleanup when chunk count changes)
    doc_chunk_count INTEGER DEFAULT 0,
    
    -- Sync tracking
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Unique constraint
    CONSTRAINT slack_threads_channel_thread_unique UNIQUE (channel_id, thread_ts)
);

-- ============================================================================
-- SLACK MESSAGES TABLE (one row per message, including thread replies)
-- ============================================================================

CREATE TABLE IF NOT EXISTS slack_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Message identity
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    thread_ts TEXT,  -- NULL for non-threaded messages, or parent ts for thread root + replies
    
    -- Message metadata (extracted for querying)
    user_id TEXT,
    bot_id TEXT,
    subtype TEXT,
    text TEXT,
    message_at TIMESTAMPTZ NOT NULL,
    
    -- User profile info (cached from message)
    user_display_name TEXT,
    user_real_name TEXT,
    
    -- Attachments/files summary
    has_files BOOLEAN DEFAULT FALSE,
    file_count INTEGER DEFAULT 0,
    
    -- Full raw JSON
    raw JSONB NOT NULL,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Unique constraint
    CONSTRAINT slack_messages_channel_ts_unique UNIQUE (channel_id, message_ts)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Sync state lookups
CREATE INDEX IF NOT EXISTS idx_slack_channel_sync_state_last_run 
    ON slack_channel_sync_state(last_run_at DESC);

-- Thread lookups
CREATE INDEX IF NOT EXISTS idx_slack_threads_channel_id 
    ON slack_threads(channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_threads_last_checked 
    ON slack_threads(last_checked_at ASC);
CREATE INDEX IF NOT EXISTS idx_slack_threads_last_synced 
    ON slack_threads(last_synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_threads_root_message_at 
    ON slack_threads(root_message_at DESC);

-- Message lookups
CREATE INDEX IF NOT EXISTS idx_slack_messages_channel_id 
    ON slack_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_messages_thread_ts 
    ON slack_messages(thread_ts);
CREATE INDEX IF NOT EXISTS idx_slack_messages_message_at 
    ON slack_messages(message_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_messages_user_id 
    ON slack_messages(user_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at on slack_channel_sync_state
DROP TRIGGER IF EXISTS update_slack_channel_sync_state_updated_at ON slack_channel_sync_state;
CREATE TRIGGER update_slack_channel_sync_state_updated_at
    BEFORE UPDATE ON slack_channel_sync_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at on slack_threads
DROP TRIGGER IF EXISTS update_slack_threads_updated_at ON slack_threads;
CREATE TRIGGER update_slack_threads_updated_at
    BEFORE UPDATE ON slack_threads
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at on slack_messages
DROP TRIGGER IF EXISTS update_slack_messages_updated_at ON slack_messages;
CREATE TRIGGER update_slack_messages_updated_at
    BEFORE UPDATE ON slack_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE slack_channel_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_messages ENABLE ROW LEVEL SECURITY;

-- Permissive policies for service role (matching existing pattern)
CREATE POLICY "Service role full access on slack_channel_sync_state" 
    ON slack_channel_sync_state FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on slack_threads" 
    ON slack_threads FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on slack_messages" 
    ON slack_messages FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE slack_channel_sync_state IS 'Tracks incremental sync state for Slack channel ingestion';
COMMENT ON COLUMN slack_channel_sync_state.cursor_oldest_ts IS 'Oldest message timestamp processed in last sync window';
COMMENT ON COLUMN slack_channel_sync_state.lookback_hours IS 'Safety lookback window to catch late-arriving replies or edits';

COMMENT ON TABLE slack_threads IS 'Slack thread roots with full raw JSON and extracted metadata';
COMMENT ON COLUMN slack_threads.thread_ts IS 'Slack thread timestamp (ts of root message)';
COMMENT ON COLUMN slack_threads.root_raw IS 'Full raw JSON of the root message from Slack API';
COMMENT ON COLUMN slack_threads.doc_chunk_count IS 'Number of document chunks generated for this thread (for cleanup)';

COMMENT ON TABLE slack_messages IS 'Individual Slack messages with full raw JSON';
COMMENT ON COLUMN slack_messages.message_ts IS 'Slack message timestamp (unique identifier)';
COMMENT ON COLUMN slack_messages.thread_ts IS 'Parent thread timestamp (NULL for non-threaded, same as message_ts for root)';
COMMENT ON COLUMN slack_messages.raw IS 'Full raw JSON of the message from Slack API';
