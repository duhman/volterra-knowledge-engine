-- Migration: add_sync_hubspot_trial_ops_labels
-- Created: 2026-01-16

SET search_path TO volterra_kb, public;

CREATE OR REPLACE FUNCTION volterra_kb.sync_hubspot_trial_ops_labels()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE volterra_kb.hubspot_ticket_categorization_trials t
  SET
    ops_category = c.category,
    ops_subcategory = c.subcategory,
    ops_set_at = NOW(),
    match_category = (c.category = t.predicted_category),
    match_subcategory = (c.subcategory = t.predicted_subcategory)
  FROM volterra_kb.training_conversations c
  WHERE c.hubspot_ticket_id = t.hubspot_ticket_id
    AND t.ops_subcategory IS NULL
    AND c.subcategory IS NOT NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION volterra_kb.sync_hubspot_trial_ops_labels() TO anon, authenticated, service_role;
