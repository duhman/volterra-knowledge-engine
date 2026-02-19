-- Quick fix for mcp_get_data_freshness function
-- This is part of migration 020 but can be run standalone

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
        'notion_pages', (SELECT count(*) FROM notion_pages WHERE NOT COALESCE(archived, false))
      )
    )
  ) INTO result;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION mcp_get_data_freshness IS 'Get comprehensive data freshness report with sync times and row counts';
