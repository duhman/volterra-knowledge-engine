-- Migration: MCP relationship traversal and analytics tools
-- Adds deep context access, navigation, and analytical RPC functions

-- ============================================================================
-- SLACK THREAD MESSAGES - Complete thread retrieval
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_fetch_thread_messages(
  p_thread_ts text,
  p_channel_id text DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_include_root boolean DEFAULT true,
  p_limit int DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  channel_id text,
  message_ts text,
  thread_ts text,
  user_id text,
  user_display_name text,
  user_real_name text,
  text text,
  message_at timestamptz,
  bot_id text,
  subtype text,
  has_files boolean,
  file_count int,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE
AS $$
  SELECT
    sm.id,
    sm.channel_id,
    sm.message_ts,
    sm.thread_ts,
    sm.user_id,
    sm.user_display_name,
    sm.user_real_name,
    sm.text,  -- full text, no truncation
    sm.message_at,
    sm.bot_id,
    sm.subtype,
    sm.has_files,
    sm.file_count,
    sm.created_at,
    sm.updated_at
  FROM slack_messages sm
  WHERE
    sm.channel_id = p_channel_id
    AND (
      (p_include_root AND sm.message_ts = p_thread_ts)
      OR sm.thread_ts = p_thread_ts
    )
  ORDER BY sm.message_at ASC
  LIMIT LEAST(p_limit, 200);  -- hard cap at 200
$$;

COMMENT ON FUNCTION mcp_fetch_thread_messages IS 'Get all messages in a Slack thread with full content (no truncation)';

-- ============================================================================
-- HUBSPOT CONVERSATION MESSAGES - Complete ticket thread
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_fetch_conversation_messages(
  p_conversation_id uuid,
  p_include_summary boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  conversation_id uuid,
  message_timestamp timestamptz,
  participant_role text,
  direction text,
  message_type text,
  content text,
  content_type text,
  engagement_type text,
  source text,
  subject text,
  from_email text,
  from_name text,
  conversation_summary text
)
LANGUAGE sql STABLE
AS $$
  SELECT
    tm.id,
    tm.conversation_id,
    tm.timestamp as message_timestamp,
    tm.participant_role,
    tm.direction,
    tm.message_type,
    tm.content,  -- full content (PII redacted at source)
    tm.content_type,
    tm.engagement_type,
    tm.source,
    tm.subject,
    tm.from_email,
    tm.from_name,
    CASE
      WHEN p_include_summary THEN tc.conversation_summary
      ELSE NULL
    END as conversation_summary
  FROM training_messages tm
  LEFT JOIN training_conversations tc ON tm.conversation_id = tc.id
  WHERE tm.conversation_id = p_conversation_id
  ORDER BY tm.timestamp ASC
  LIMIT 200;  -- hard cap at 200 messages
$$;

COMMENT ON FUNCTION mcp_fetch_conversation_messages IS 'Get all messages in a HubSpot support conversation with full content';

-- ============================================================================
-- FULL DOCUMENT CONTENT - No truncation
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_fetch_document_full(
  p_document_id uuid,
  p_max_chars int DEFAULT 100000
)
RETURNS TABLE (
  id uuid,
  title text,
  department text,
  document_type text,
  source_type text,
  source_path text,
  content text,
  file_size bigint,
  mime_type text,
  original_filename text,
  owner text,
  sensitivity text,
  tags text[],
  language text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE
AS $$
  SELECT
    d.id,
    d.title,
    d.department,
    d.document_type,
    d.source_type,
    d.source_path,
    LEFT(d.content, LEAST(p_max_chars, 200000)) as content,  -- max 200K chars
    d.file_size,
    d.mime_type,
    d.original_filename,
    d.owner,
    d.sensitivity,
    d.tags,
    d.language,
    d.created_at,
    d.updated_at
  FROM documents d
  WHERE d.id = p_document_id;
$$;

COMMENT ON FUNCTION mcp_fetch_document_full IS 'Get full document content with configurable character limit (max 200K)';

-- ============================================================================
-- NOTION HIERARCHY NAVIGATION - Child pages
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_fetch_notion_children(
  p_parent_id uuid,
  p_include_archived boolean DEFAULT false,
  p_sort_by text DEFAULT 'notion_last_edited_time'
)
RETURNS TABLE (
  id uuid,
  title text,
  url text,
  parent_id uuid,
  archived boolean,
  doc_chunk_count int,
  notion_last_edited_time timestamptz,
  notion_created_time timestamptz,
  source_path text
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    np.id,
    np.title,
    np.url,
    np.parent_id,
    np.archived,
    np.doc_chunk_count,
    np.notion_last_edited_time,
    np.notion_created_time,
    np.source_path
  FROM notion_pages np
  WHERE
    np.parent_id = p_parent_id
    AND (p_include_archived OR NOT COALESCE(np.archived, false))
  ORDER BY
    CASE
      WHEN p_sort_by = 'notion_last_edited_time' THEN np.notion_last_edited_time
      WHEN p_sort_by = 'notion_created_time' THEN np.notion_created_time
      ELSE np.notion_last_edited_time
    END DESC
  LIMIT 100;  -- reasonable cap for navigation
END;
$$;

COMMENT ON FUNCTION mcp_fetch_notion_children IS 'Navigate Notion page hierarchy - get all child pages of a parent';

-- ============================================================================
-- DATA FRESHNESS REPORT - Sync state for all sources
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_get_data_freshness()
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'notion_sync', (
      SELECT jsonb_build_object(
        'last_sync_at', nss.last_run_at,
        'pages_seen', nss.last_run_pages_seen,
        'pages_changed', nss.last_run_pages_changed,
        'pages_deleted', nss.last_run_pages_deleted,
        'error_count', nss.last_run_failed_pages,
        'total_pages', (SELECT count(*) FROM notion_pages WHERE NOT COALESCE(archived, false))
      )
      FROM notion_sync_state nss
      ORDER BY nss.last_run_at DESC
      LIMIT 1
    ),
    'slack_sync', (
      SELECT jsonb_agg(row_data)
      FROM (
        SELECT jsonb_build_object(
          'channel_id', scss.channel_id,
          'last_synced_at', scss.last_run_at,
          'messages_total', scss.last_run_messages_upserted,
          'threads_total', scss.last_run_threads_upserted,
          'threads_fetched', scss.last_run_threads_fetched
        ) as row_data
        FROM slack_channel_sync_state scss
        ORDER BY scss.last_run_at DESC
        LIMIT 5
      ) subquery
    ),
    'hubspot_sync', (
      SELECT jsonb_build_object(
        'last_sync_at', htss.last_run_at,
        'tickets_fetched', htss.last_run_tickets_fetched,
        'tickets_updated', htss.last_run_conversations_upserted,
        'messages_inserted', htss.last_run_messages_upserted
      )
      FROM hubspot_ticket_sync_state htss
      ORDER BY htss.last_run_at DESC
      LIMIT 1
    ),
    'table_stats', (
      SELECT jsonb_build_object(
        'documents', (SELECT count(*) FROM documents),
        'training_conversations', (SELECT count(*) FROM training_conversations),
        'training_messages', (SELECT count(*) FROM training_messages),
        'slack_messages', (SELECT count(*) FROM slack_messages),
        'slack_threads', (SELECT count(*) FROM slack_threads),
        'wod_deals', (SELECT count(*) FROM wod_deals),
        'notion_pages', (SELECT count(*) FROM notion_pages WHERE NOT archived)
      )
    )
  ) INTO result;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION mcp_get_data_freshness IS 'Get comprehensive data freshness report with sync times and row counts';

-- ============================================================================
-- WOD DEAL COMPARISON - Side-by-side analysis
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_compare_wod_deals(
  p_deal_ids uuid[],
  p_fields_to_compare text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  result jsonb;
  default_fields text[];
BEGIN
  -- Default comparison fields if not specified
  IF p_fields_to_compare IS NULL THEN
    default_fields := ARRAY[
      'deal_name', 'country', 'total_parking_spaces', 'total_boxes',
      'charger_type', 'housing_units', 'power_level', 'total_cost_excl_vat',
      'total_material_cost', 'total_work_cost', 'purchase_total_excl_subsidy',
      'gross_margin_buy', 'gross_margin_rent', 'deal_date'
    ];
  ELSE
    default_fields := p_fields_to_compare;
  END IF;

  -- Limit to 5 deals for performance
  IF array_length(p_deal_ids, 1) > 5 THEN
    RAISE EXCEPTION 'Maximum 5 deals can be compared at once';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'deal_name', d.deal_name,
      'country', d.country,
      'total_parking_spaces', d.total_parking_spaces,
      'total_boxes', d.total_boxes,
      'charger_type', d.charger_type,
      'housing_units', d.housing_units,
      'power_level', d.power_level,
      'total_cost_excl_vat', d.total_cost_excl_vat,
      'total_material_cost', d.total_material_cost,
      'total_work_cost', d.total_work_cost,
      'purchase_total_excl_subsidy', d.purchase_total_excl_subsidy,
      'purchase_total_with_subsidy', d.purchase_total_with_subsidy,
      'gross_margin_buy', d.gross_margin_buy,
      'gross_margin_rent', d.gross_margin_rent,
      'markup_percentage', d.markup_percentage,
      'deal_date', d.deal_date
    )
  ) INTO result
  FROM wod_deals d
  WHERE d.id = ANY(p_deal_ids);

  RETURN result;
END;
$$;

COMMENT ON FUNCTION mcp_compare_wod_deals IS 'Side-by-side comparison of 2-5 WoD deals with key financial and technical fields';

-- ============================================================================
-- COST AGGREGATION - Flexible grouping and filtering
-- ============================================================================

CREATE OR REPLACE FUNCTION mcp_aggregate_costs(
  p_group_by text DEFAULT 'cost_category',
  p_filters jsonb DEFAULT NULL
)
RETURNS TABLE (
  group_value text,
  total_cost numeric,
  total_labor_cost numeric,
  total_material_cost numeric,
  item_count bigint,
  avg_cost numeric
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  -- Validate group_by parameter
  IF p_group_by NOT IN ('cost_category', 'deal_id', 'item_name') THEN
    RAISE EXCEPTION 'Invalid group_by value. Must be: cost_category, deal_id, or item_name';
  END IF;

  RETURN QUERY EXECUTE format('
    SELECT
      %I::text as group_value,
      SUM(total_cost)::numeric as total_cost,
      SUM(labor_cost)::numeric as total_labor_cost,
      SUM(total_cost - COALESCE(labor_cost, 0))::numeric as total_material_cost,
      COUNT(*)::bigint as item_count,
      AVG(total_cost)::numeric as avg_cost
    FROM wod_deal_costs
    GROUP BY %I
    ORDER BY total_cost DESC
    LIMIT 100
  ', p_group_by, p_group_by);
END;
$$;

COMMENT ON FUNCTION mcp_aggregate_costs IS 'Aggregate WoD deal costs with flexible grouping (cost_category, deal_id, or item_name)';

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Slack thread navigation
CREATE INDEX IF NOT EXISTS idx_slack_messages_thread_lookup
  ON slack_messages(thread_ts, message_at)
  WHERE thread_ts IS NOT NULL;

-- Conversation message lookup
CREATE INDEX IF NOT EXISTS idx_training_messages_conversation
  ON training_messages(conversation_id, timestamp);

-- Notion hierarchy navigation
CREATE INDEX IF NOT EXISTS idx_notion_pages_parent
  ON notion_pages(parent_id, archived, notion_last_edited_time)
  WHERE parent_id IS NOT NULL;

-- WoD cost aggregation
CREATE INDEX IF NOT EXISTS idx_wod_costs_grouping
  ON wod_deal_costs(cost_category, deal_id, total_cost);

COMMENT ON INDEX idx_slack_messages_thread_lookup IS 'Fast thread message retrieval';
COMMENT ON INDEX idx_training_messages_conversation IS 'Fast conversation message lookup';
COMMENT ON INDEX idx_notion_pages_parent IS 'Fast Notion hierarchy navigation';
COMMENT ON INDEX idx_wod_costs_grouping IS 'Fast cost aggregation queries';
