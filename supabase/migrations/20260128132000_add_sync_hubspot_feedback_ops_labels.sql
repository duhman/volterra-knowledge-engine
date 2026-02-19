-- Migration: add_sync_hubspot_feedback_ops_labels
-- Created: 2026-01-28

SET search_path TO volterra_kb, public;

CREATE OR REPLACE FUNCTION volterra_kb.sync_hubspot_feedback_ops_labels()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE volterra_kb.hubspot_ticket_categorization_feedback f
  SET
    ops_category = c.category,
    ops_subcategory = c.subcategory,
    labeled_at = NOW(),
    is_correct = (c.subcategory = f.predicted_subcategory)
  FROM volterra_kb.training_conversations c
  WHERE c.hubspot_ticket_id = f.hubspot_ticket_id
    AND f.ops_subcategory IS NULL
    AND c.subcategory IS NOT NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION volterra_kb.sync_hubspot_feedback_ops_labels() TO anon, authenticated, service_role;
