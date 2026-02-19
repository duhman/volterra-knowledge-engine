-- Migration: add_hubspot_categorization_feedback
-- Created: 2026-01-28

set search_path to volterra_kb, public, extensions;

create table if not exists volterra_kb.hubspot_ticket_categorization_feedback (
  id bigserial primary key,
  hubspot_ticket_id text not null unique,
  subject text,
  description text,
  last_message text,
  search_text text,
  last_outbound text,
  ops_category text,
  ops_subcategory text,
  predicted_category text,
  predicted_subcategory text,
  predicted_confidence double precision,
  predicted_rationale text,
  predicted_sources jsonb,
  predicted_payload jsonb,
  is_correct boolean,
  labeled_at timestamptz,
  embedding extensions.vector(1536),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists hubspot_ticket_categorization_feedback_embedding_idx
  on volterra_kb.hubspot_ticket_categorization_feedback
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists hubspot_ticket_categorization_feedback_ops_subcategory_idx
  on volterra_kb.hubspot_ticket_categorization_feedback (ops_subcategory);

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'set_updated_at_hubspot_ticket_categorization_feedback'
  ) then
    create trigger set_updated_at_hubspot_ticket_categorization_feedback
    before update on volterra_kb.hubspot_ticket_categorization_feedback
    for each row execute function public.update_updated_at_column();
  end if;
end $$;

create or replace function volterra_kb.upsert_hubspot_categorization_feedback(
  hubspot_ticket_id text,
  subject text,
  description text,
  last_message text,
  search_text text,
  last_outbound text,
  ops_category text,
  ops_subcategory text,
  predicted_category text,
  predicted_subcategory text,
  predicted_confidence double precision,
  predicted_rationale text,
  predicted_sources jsonb,
  predicted_payload jsonb,
  embedding_string text
) returns void
language plpgsql
as $$
declare
  normalized_ops_category text := nullif(ops_category, '');
  normalized_ops_subcategory text := nullif(ops_subcategory, '');
    normalized_embedding extensions.vector(1536) := null;
begin
  if embedding_string is not null and embedding_string <> '' then
    normalized_embedding := embedding_string::extensions.vector;
  end if;

  insert into volterra_kb.hubspot_ticket_categorization_feedback (
    hubspot_ticket_id,
    subject,
    description,
    last_message,
    search_text,
    last_outbound,
    ops_category,
    ops_subcategory,
    predicted_category,
    predicted_subcategory,
    predicted_confidence,
    predicted_rationale,
    predicted_sources,
    predicted_payload,
    embedding,
    labeled_at,
    is_correct
  ) values (
    hubspot_ticket_id,
    subject,
    description,
    last_message,
    search_text,
    last_outbound,
    normalized_ops_category,
    normalized_ops_subcategory,
    predicted_category,
    predicted_subcategory,
    predicted_confidence,
    predicted_rationale,
    predicted_sources,
    predicted_payload,
    normalized_embedding,
    case when normalized_ops_subcategory is null then null else now() end,
    case when normalized_ops_subcategory is null then null
         else normalized_ops_subcategory = predicted_subcategory end
  )
  on conflict (hubspot_ticket_id) do update set
    subject = excluded.subject,
    description = excluded.description,
    last_message = excluded.last_message,
    search_text = excluded.search_text,
    last_outbound = coalesce(excluded.last_outbound, volterra_kb.hubspot_ticket_categorization_feedback.last_outbound),
    ops_category = coalesce(excluded.ops_category, volterra_kb.hubspot_ticket_categorization_feedback.ops_category),
    ops_subcategory = coalesce(excluded.ops_subcategory, volterra_kb.hubspot_ticket_categorization_feedback.ops_subcategory),
    predicted_category = excluded.predicted_category,
    predicted_subcategory = excluded.predicted_subcategory,
    predicted_confidence = excluded.predicted_confidence,
    predicted_rationale = excluded.predicted_rationale,
    predicted_sources = excluded.predicted_sources,
    predicted_payload = excluded.predicted_payload,
    embedding = coalesce(excluded.embedding, volterra_kb.hubspot_ticket_categorization_feedback.embedding),
    labeled_at = case
      when excluded.ops_subcategory is null then volterra_kb.hubspot_ticket_categorization_feedback.labeled_at
      else now()
    end,
    is_correct = case
      when excluded.ops_subcategory is null then volterra_kb.hubspot_ticket_categorization_feedback.is_correct
      else excluded.ops_subcategory = excluded.predicted_subcategory
    end,
    updated_at = now();
end;
$$;

create or replace function volterra_kb.match_hubspot_categorization_feedback(
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
as $$
  select
    f.id,
    1 - (f.embedding <=> query_embedding) as similarity,
    jsonb_build_object(
      'subcategory', f.ops_subcategory,
      'category', coalesce(f.ops_category, 'General'),
      'subject', f.subject,
      'last_reply', f.last_outbound,
      'source', 'feedback'
    ) as metadata
  from volterra_kb.hubspot_ticket_categorization_feedback f
  where f.embedding is not null
    and f.ops_subcategory is not null
    and 1 - (f.embedding <=> query_embedding) >= match_threshold
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
