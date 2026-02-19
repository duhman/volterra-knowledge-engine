-- Migration: Create HubSpot ticket sync state table for incremental cursor tracking
-- This enables daily automated ingestion without re-scanning all tickets

-- ============================================================================
-- SYNC STATE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS hubspot_ticket_sync_state (
    source TEXT PRIMARY KEY DEFAULT 'tickets',
    
    -- Incremental cursor: last successfully processed hs_lastmodifieddate (ms since epoch)
    cursor_hs_lastmodified_ms BIGINT DEFAULT 0,
    
    -- Safety lookback window in hours (default 48h to catch late updates)
    lookback_hours INTEGER DEFAULT 48,
    
    -- Last run statistics
    last_run_at TIMESTAMPTZ,
    last_run_tickets_fetched INTEGER DEFAULT 0,
    last_run_conversations_upserted INTEGER DEFAULT 0,
    last_run_messages_upserted INTEGER DEFAULT 0,
    last_run_failed_tickets INTEGER DEFAULT 0,
    last_run_error TEXT,
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert initial state row
INSERT INTO hubspot_ticket_sync_state (source)
VALUES ('tickets')
ON CONFLICT (source) DO NOTHING;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS update_hubspot_ticket_sync_state_updated_at ON hubspot_ticket_sync_state;
CREATE TRIGGER update_hubspot_ticket_sync_state_updated_at
    BEFORE UPDATE ON hubspot_ticket_sync_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE hubspot_ticket_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on hubspot_ticket_sync_state" ON hubspot_ticket_sync_state
    FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE hubspot_ticket_sync_state IS 'Tracks incremental sync state for HubSpot ticket ingestion';
COMMENT ON COLUMN hubspot_ticket_sync_state.cursor_hs_lastmodified_ms IS 'Last processed hs_lastmodifieddate in milliseconds since epoch';
COMMENT ON COLUMN hubspot_ticket_sync_state.lookback_hours IS 'Safety lookback window to catch late-arriving ticket updates';
