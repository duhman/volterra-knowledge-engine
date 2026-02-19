-- Migration: grant_feedback_rpc
-- Created: 2026-01-28

SET search_path TO volterra_kb, public;

GRANT EXECUTE ON FUNCTION volterra_kb.upsert_hubspot_categorization_feedback(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  text,
  jsonb,
  jsonb,
  text
) TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION volterra_kb.match_hubspot_categorization_feedback(
  extensions.vector,
  double precision,
  int
) TO anon, authenticated, service_role;
