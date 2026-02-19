-- Migration: 016_mcp_count_grouped.sql
-- Purpose: Add dynamic grouped count function for MCP read-only server
-- Security: Whitelisted tables only, no raw SQL injection

-- Safe table whitelist for grouped counts
CREATE OR REPLACE FUNCTION mcp_count_grouped(
  p_table_name text,
  p_group_column text,
  p_date_column text DEFAULT NULL,
  p_date_from text DEFAULT NULL,
  p_date_to text DEFAULT NULL,
  p_filters jsonb DEFAULT NULL
)
RETURNS TABLE (
  group_value text,
  count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  allowed_tables text[] := ARRAY[
    'slack_messages', 'slack_threads', 'documents', 
    'training_conversations', 'training_messages',
    'wod_deals', 'wod_deal_circuits', 'wod_deal_costs', 'wod_deal_offers',
    'wod_cost_catalog', 'slack_channel_sync_state', 'hubspot_ticket_sync_state'
  ];
  query text;
BEGIN
  -- Validate table name (prevent injection)
  IF NOT p_table_name = ANY(allowed_tables) THEN
    RAISE EXCEPTION 'Table % not in whitelist', p_table_name;
  END IF;
  
  -- Build dynamic query
  query := format(
    'SELECT COALESCE(%I::text, ''(null)'') as group_value, COUNT(*) as count FROM %I WHERE 1=1',
    p_group_column,
    p_table_name
  );
  
  -- Add date filter if provided
  IF p_date_column IS NOT NULL AND p_date_from IS NOT NULL THEN
    query := query || format(' AND %I >= %L::timestamptz', p_date_column, p_date_from);
  END IF;
  
  IF p_date_column IS NOT NULL AND p_date_to IS NOT NULL THEN
    query := query || format(' AND %I <= %L::timestamptz', p_date_column, p_date_to);
  END IF;
  
  -- Add JSON filters (simple equality only)
  IF p_filters IS NOT NULL THEN
    DECLARE
      filter_key text;
      filter_value text;
    BEGIN
      FOR filter_key, filter_value IN SELECT * FROM jsonb_each_text(p_filters)
      LOOP
        query := query || format(' AND %I = %L', filter_key, filter_value);
      END LOOP;
    END;
  END IF;
  
  -- Group and order
  query := query || format(' GROUP BY %I ORDER BY count DESC LIMIT 100', p_group_column);
  
  RETURN QUERY EXECUTE query;
END;
$$;

-- Grant execute to service role only (no anon access)
REVOKE ALL ON FUNCTION mcp_count_grouped FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mcp_count_grouped TO service_role;

COMMENT ON FUNCTION mcp_count_grouped IS 'MCP read-only: Grouped counts with whitelist validation';
