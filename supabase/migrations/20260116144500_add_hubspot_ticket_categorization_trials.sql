-- Migration: add_hubspot_ticket_categorization_trials
-- Created: 2026-01-16

SET search_path TO volterra_kb, public;

CREATE TABLE IF NOT EXISTS hubspot_ticket_categorization_trials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hubspot_ticket_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  webhook_id TEXT NULL,
  subject TEXT NULL,
  predicted_category TEXT NOT NULL,
  predicted_subcategory TEXT NOT NULL,
  predicted_confidence NUMERIC(4,3) NULL,
  predicted_rationale TEXT NULL,
  predicted_sources JSONB NULL,
  predicted_payload JSONB NULL,
  ops_category TEXT NULL,
  ops_subcategory TEXT NULL,
  ops_set_at TIMESTAMPTZ NULL,
  ops_payload JSONB NULL,
  match_category BOOLEAN NULL,
  match_subcategory BOOLEAN NULL,
  comparison_note TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_hubspot_ticket_categorization_trials_ticket_id
  ON hubspot_ticket_categorization_trials (hubspot_ticket_id);

CREATE INDEX IF NOT EXISTS idx_hubspot_ticket_categorization_trials_received_at
  ON hubspot_ticket_categorization_trials (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_hubspot_ticket_categorization_trials_ops_pending
  ON hubspot_ticket_categorization_trials (ops_subcategory)
  WHERE ops_subcategory IS NULL;
