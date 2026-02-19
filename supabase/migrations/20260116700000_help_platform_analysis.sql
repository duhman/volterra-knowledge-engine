-- Migration: Add #help-me-platform support ticket analysis functions
-- Purpose: Enable @Ela to analyze support tickets from Slack Workflow Forms
-- Channel: YOUR_SLACK_CHANNEL_ID (#help-me-platform)
--
-- Message format (Slack Workflow "Submit Help Request"):
-- - What is the HubSpot Ticket Id?
-- - Is this for a driver or partner?
-- - Please provide a Helix link to the Driver or Partner
-- - Name of the Driver/Partner
-- - Describe the issue in detail
-- - Troubleshooting Steps
-- - Submitted By
SET
  search_path TO volterra_kb,
  public;

-- ============================================================================
-- FUNCTION 1: Parse Support Tickets
-- Extracts structured data from Slack Workflow form submissions
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_get_support_tickets (
  p_channel_id text DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_date_from text DEFAULT NULL,
  p_date_to text DEFAULT NULL,
  p_request_type text DEFAULT NULL, -- 'Driver' or 'Partner'
  p_search_term text DEFAULT NULL,
  p_limit int DEFAULT 20
) RETURNS TABLE (
  message_ts text,
  created_at timestamptz,
  hubspot_ticket_id text,
  hubspot_url text,
  request_type text,
  helix_link text,
  entity_name text,
  issue_description text,
  troubleshooting_steps text,
  submitted_by_mention text,
  submitted_by_name text,
  thread_reply_count int,
  slack_url text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
  v_date_from date;
  v_date_to date;
  v_search text;
  v_request_type text;
BEGIN
  -- Convert empty strings to NULL (n8n sends "" when AI doesn't fill placeholders)
  v_date_from := CASE
    WHEN p_date_from IS NULL OR trim(p_date_from) = '' THEN NULL
    ELSE p_date_from::date
  END;

  v_date_to := CASE
    WHEN p_date_to IS NULL OR trim(p_date_to) = '' THEN NULL
    ELSE p_date_to::date
  END;

  v_search := CASE
    WHEN p_search_term IS NULL OR trim(p_search_term) = '' THEN NULL
    ELSE trim(p_search_term)
  END;

  v_request_type := CASE
    WHEN p_request_type IS NULL OR trim(p_request_type) = '' THEN NULL
    ELSE trim(p_request_type)
  END;

  RETURN QUERY
  WITH extracted AS (
    SELECT
      m.message_ts,
      m.message_at,

      -- Extract HubSpot Ticket ID (number only or full URL → extract number)
      trim(regexp_replace(
        COALESCE(
          (regexp_match(m.text, 'What is the HubSpot Ticket Id\??\s*\n([^\n]+)', 'i'))[1],
          ''
        ),
        '^https?://[^\s]+/(\d+).*$', '\1', 'i'
      )) AS hubspot_ticket_id_raw,

      -- Extract request type (Driver/Partner)
      trim((regexp_match(m.text, 'Is this for a driver or partner\??\s*\n([^\n]+)', 'i'))[1]) AS request_type_raw,

      -- Extract Helix link
      trim((regexp_match(m.text, 'Helix link[^:]*:?\s*\n?(https?://[^\s\n]+)', 'i'))[1]) AS helix_link_raw,

      -- Extract entity name
      trim((regexp_match(m.text, 'Name of the Driver/Partner\s*\n([^\n]+)', 'i'))[1]) AS entity_name_raw,

      -- Extract issue description (multiline until next field)
      trim((regexp_match(m.text,
        'Describe the issue in detail\s*\n([\s\S]*?)(?=\nTroubleshooting Steps|\n\*?Submitted By|$)', 'i'))[1]) AS issue_description_raw,

      -- Extract troubleshooting steps (may be empty)
      trim((regexp_match(m.text,
        'Troubleshooting Steps\s*\n([\s\S]*?)(?=\n\*?Submitted By|$)', 'i'))[1]) AS troubleshooting_steps_raw,

      -- Extract submitted by (@mention format)
      trim((regexp_match(m.text, 'Submitted By\s*\n?<?@?([^\n>]+)', 'i'))[1]) AS submitted_by_raw,

      -- Get thread reply count from slack_threads if available
      COALESCE(t.reply_count, 0) AS reply_count,

      -- Build Slack permalink
      'https://your-workspace.slack.com/archives/' || m.channel_id || '/p' ||
        replace(m.message_ts, '.', '') AS slack_permalink

    FROM volterra_kb.slack_messages m
    LEFT JOIN volterra_kb.slack_threads t
      ON t.channel_id = m.channel_id AND t.thread_ts = m.message_ts
    WHERE m.channel_id = COALESCE(NULLIF(trim(p_channel_id), ''), 'YOUR_SLACK_CHANNEL_ID')
      AND m.thread_ts IS NULL  -- Root messages only (workflow submissions are root messages)
      AND (
        m.text ILIKE '%Submit Help Request%'
        OR m.text ILIKE '%What is the HubSpot Ticket Id%'
        OR m.text ILIKE '%Is this for a driver or partner%'
      )
      AND (v_date_from IS NULL OR m.message_at >= v_date_from)
      AND (v_date_to IS NULL OR m.message_at <= v_date_to + interval '1 day')
  )
  SELECT
    e.message_ts,
    e.message_at AS created_at,
    NULLIF(e.hubspot_ticket_id_raw, '') AS hubspot_ticket_id,
    -- Build HubSpot URL if we have a ticket ID
    CASE
      WHEN e.hubspot_ticket_id_raw ~ '^\d+$' THEN
        'https://app-eu1.hubspot.com/contacts/YOUR_PORTAL_ID/record/0-5/' || e.hubspot_ticket_id_raw
      ELSE NULL
    END AS hubspot_url,
    COALESCE(NULLIF(e.request_type_raw, ''), 'Unknown') AS request_type,
    e.helix_link_raw AS helix_link,
    COALESCE(NULLIF(e.entity_name_raw, ''), 'Not specified') AS entity_name,
    COALESCE(NULLIF(e.issue_description_raw, ''), 'No description') AS issue_description,
    NULLIF(e.troubleshooting_steps_raw, '') AS troubleshooting_steps,
    e.submitted_by_raw AS submitted_by_mention,
    -- Resolve @mention to display name if possible
    (SELECT COALESCE(u.user_display_name, u.user_real_name, e.submitted_by_raw)
     FROM volterra_kb.slack_messages u
     WHERE (u.user_display_name ILIKE '%' || e.submitted_by_raw || '%'
            OR u.user_real_name ILIKE '%' || e.submitted_by_raw || '%')
       AND (u.user_display_name IS NOT NULL OR u.user_real_name IS NOT NULL)
     LIMIT 1
    ) AS submitted_by_name,
    e.reply_count::int AS thread_reply_count,
    e.slack_permalink AS slack_url
  FROM extracted e
  WHERE
    -- Filter by request type if specified
    (v_request_type IS NULL OR e.request_type_raw ILIKE '%' || v_request_type || '%')
    -- Search filter across multiple fields
    AND (v_search IS NULL OR (
      e.hubspot_ticket_id_raw ILIKE '%' || v_search || '%'
      OR e.entity_name_raw ILIKE '%' || v_search || '%'
      OR e.issue_description_raw ILIKE '%' || v_search || '%'
      OR e.helix_link_raw ILIKE '%' || v_search || '%'
    ))
  ORDER BY e.message_at DESC
  LIMIT COALESCE(NULLIF(p_limit, 0), 20);
END;
$$;

-- Grant execute permissions
GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_support_tickets (text, text, text, text, text, int) TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_support_tickets (text, text, text, text, text, int) TO anon;

COMMENT ON FUNCTION volterra_kb.mcp_get_support_tickets IS 'Parse support tickets from #help-me-platform Slack Workflow submissions.
Extracts: HubSpot ticket ID/URL, request type (Driver/Partner), Helix link, entity name, issue description, troubleshooting steps, submitter.
Filters: date range, request_type, search_term.
Example: SELECT * FROM volterra_kb.mcp_get_support_tickets(''YOUR_SLACK_CHANNEL_ID'', ''2025-01-01'', NULL, ''Driver'', NULL, 10);';

-- ============================================================================
-- FUNCTION 2: Support Ticket Analytics
-- Aggregate statistics for support tickets
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_get_support_analytics (
  p_channel_id text DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_date_from text DEFAULT NULL,
  p_date_to text DEFAULT NULL
) RETURNS TABLE (
  total_tickets bigint,
  driver_tickets bigint,
  partner_tickets bigint,
  unknown_type_tickets bigint,
  avg_thread_replies numeric,
  tickets_with_troubleshooting bigint,
  top_submitters jsonb,
  tickets_by_week jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
  v_date_from date;
  v_date_to date;
BEGIN
  -- Convert empty strings to NULL
  v_date_from := CASE
    WHEN p_date_from IS NULL OR trim(p_date_from) = '' THEN NULL
    ELSE p_date_from::date
  END;

  v_date_to := CASE
    WHEN p_date_to IS NULL OR trim(p_date_to) = '' THEN NULL
    ELSE p_date_to::date
  END;

  RETURN QUERY
  WITH tickets AS (
    SELECT
      m.message_ts,
      m.message_at,
      -- Extract request type
      trim((regexp_match(m.text, 'Is this for a driver or partner\??\s*\n([^\n]+)', 'i'))[1]) AS request_type,
      -- Check if troubleshooting steps provided
      (regexp_match(m.text, 'Troubleshooting Steps\s*\n([^\n]+)', 'i'))[1] IS NOT NULL
        AND trim((regexp_match(m.text, 'Troubleshooting Steps\s*\n([^\n]+)', 'i'))[1]) != '' AS has_troubleshooting,
      -- Extract submitter
      trim((regexp_match(m.text, 'Submitted By\s*\n?<?@?([^\n>]+)', 'i'))[1]) AS submitter,
      -- Get thread reply count
      COALESCE(t.reply_count, 0) AS reply_count
    FROM volterra_kb.slack_messages m
    LEFT JOIN volterra_kb.slack_threads t
      ON t.channel_id = m.channel_id AND t.thread_ts = m.message_ts
    WHERE m.channel_id = COALESCE(NULLIF(trim(p_channel_id), ''), 'YOUR_SLACK_CHANNEL_ID')
      AND m.thread_ts IS NULL
      AND (
        m.text ILIKE '%Submit Help Request%'
        OR m.text ILIKE '%What is the HubSpot Ticket Id%'
        OR m.text ILIKE '%Is this for a driver or partner%'
      )
      AND (v_date_from IS NULL OR m.message_at >= v_date_from)
      AND (v_date_to IS NULL OR m.message_at <= v_date_to + interval '1 day')
  ),
  stats AS (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE request_type ILIKE '%driver%') AS drivers,
      COUNT(*) FILTER (WHERE request_type ILIKE '%partner%') AS partners,
      COUNT(*) FILTER (WHERE request_type IS NULL OR (request_type NOT ILIKE '%driver%' AND request_type NOT ILIKE '%partner%')) AS unknown,
      ROUND(AVG(reply_count)::numeric, 2) AS avg_replies,
      COUNT(*) FILTER (WHERE has_troubleshooting) AS with_troubleshooting
    FROM tickets
  ),
  top_submitters AS (
    SELECT jsonb_agg(
      jsonb_build_object('name', submitter, 'count', cnt)
      ORDER BY cnt DESC
    ) AS submitters
    FROM (
      SELECT submitter, COUNT(*) AS cnt
      FROM tickets
      WHERE submitter IS NOT NULL AND submitter != ''
      GROUP BY submitter
      ORDER BY cnt DESC
      LIMIT 10
    ) s
  ),
  weekly AS (
    SELECT jsonb_agg(
      jsonb_build_object('week', week_start, 'count', cnt)
      ORDER BY week_start DESC
    ) AS by_week
    FROM (
      SELECT
        date_trunc('week', message_at)::date AS week_start,
        COUNT(*) AS cnt
      FROM tickets
      GROUP BY date_trunc('week', message_at)
      ORDER BY week_start DESC
      LIMIT 12
    ) w
  )
  SELECT
    s.total,
    s.drivers,
    s.partners,
    s.unknown,
    s.avg_replies,
    s.with_troubleshooting,
    COALESCE(ts.submitters, '[]'::jsonb),
    COALESCE(wk.by_week, '[]'::jsonb)
  FROM stats s, top_submitters ts, weekly wk;
END;
$$;

-- Grant execute permissions
GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_support_analytics (text, text, text) TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_support_analytics (text, text, text) TO anon;

COMMENT ON FUNCTION volterra_kb.mcp_get_support_analytics IS 'Get aggregate statistics for #help-me-platform support tickets.
Returns: total_tickets, driver_tickets, partner_tickets, avg_thread_replies, top_submitters, tickets_by_week.
Example: SELECT * FROM volterra_kb.mcp_get_support_analytics(''YOUR_SLACK_CHANNEL_ID'', ''2025-01-01'', NULL);';

-- ============================================================================
-- FUNCTION 3: Ticket Thread Insights
-- Get full thread context for a specific support ticket
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_get_ticket_thread_insights (
  p_thread_ts text,
  p_channel_id text DEFAULT 'YOUR_SLACK_CHANNEL_ID'
) RETURNS TABLE (
  message_ts text,
  message_at timestamptz,
  user_display_name text,
  user_id text,
  message_text text,
  is_root boolean,
  is_potential_resolution boolean,
  time_since_ticket interval
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
  v_root_at timestamptz;
BEGIN
  -- Get root message timestamp for calculating time since ticket
  SELECT message_at INTO v_root_at
  FROM volterra_kb.slack_messages
  WHERE channel_id = p_channel_id
    AND message_ts = p_thread_ts
  LIMIT 1;

  RETURN QUERY
  SELECT
    m.message_ts,
    m.message_at,
    COALESCE(m.user_display_name, m.user_real_name, 'Unknown') AS user_display_name,
    m.user_id,
    m.text AS message_text,
    m.message_ts = p_thread_ts AS is_root,
    -- Heuristic: potential resolution if message contains resolution keywords
    (m.text ILIKE '%done%' OR m.text ILIKE '%fixed%' OR m.text ILIKE '%resolved%'
     OR m.text ILIKE '%completed%' OR m.text ILIKE '%sorted%'
     OR m.text ILIKE '%:white_check_mark:%' OR m.text ILIKE '%:heavy_check_mark:%') AS is_potential_resolution,
    m.message_at - v_root_at AS time_since_ticket
  FROM volterra_kb.slack_messages m
  WHERE m.channel_id = p_channel_id
    AND (m.thread_ts = p_thread_ts OR m.message_ts = p_thread_ts)
  ORDER BY m.message_at ASC;
END;
$$;

-- Grant execute permissions
GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_ticket_thread_insights (text, text) TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_ticket_thread_insights (text, text) TO anon;

COMMENT ON FUNCTION volterra_kb.mcp_get_ticket_thread_insights IS 'Get full thread context for a support ticket.
Returns all messages in thread with timestamps, authors, and resolution heuristics.
Use thread_ts from mcp_get_support_tickets to retrieve the full conversation.
Example: SELECT * FROM volterra_kb.mcp_get_ticket_thread_insights(''1704067200.123456'', ''YOUR_SLACK_CHANNEL_ID'');';

-- ============================================================================
-- ROLLBACK (run manually if needed)
-- ============================================================================
-- DROP FUNCTION IF EXISTS volterra_kb.mcp_get_support_tickets(text, text, text, text, text, int);
-- DROP FUNCTION IF EXISTS volterra_kb.mcp_get_support_analytics(text, text, text);
-- DROP FUNCTION IF EXISTS volterra_kb.mcp_get_ticket_thread_insights(text, text);
