-- Migration: update_feedback_match_metadata
-- Created: 2026-01-28

SET search_path TO volterra_kb, public, extensions;

CREATE OR REPLACE FUNCTION volterra_kb.match_hubspot_categorization_feedback(
  query_embedding extensions.vector(1536),
  match_threshold double precision default 0.55,
  match_count int default 8
) returns table (
  id bigint,
  similarity double precision,
  metadata jsonb
)
language sql
stable
set search_path = volterra_kb, public, extensions
as $$
  select
    f.id,
    1 - (f.embedding <=> query_embedding) as similarity,
    jsonb_build_object(
      'subcategory', f.ops_subcategory,
      'category', coalesce(f.ops_category, 'General'),
      'subject', f.subject,
      'last_reply', f.last_outbound,
      'hubspot_ticket_id', f.hubspot_ticket_id,
      'source', 'feedback'
    ) as metadata
  from volterra_kb.hubspot_ticket_categorization_feedback f
  where f.embedding is not null
    and f.ops_subcategory is not null
    and 1 - (f.embedding <=> query_embedding) >= match_threshold
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
