-- Migration: Add comprehensive release details parsing function
-- Extracts all fields from release announcements in #platform-all-deliveries:
-- - Title (What we are delivering today)
-- - Description (bullet points)
-- - Target audience (Who is it for)
-- - Contributors (Who has contributed)
-- - Value proposition (Value)
-- ============================================================================
-- MCP FUNCTION: Parse Release Details
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_get_release_details (
  p_channel_id text DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_date_from text DEFAULT NULL,
  p_date_to text DEFAULT NULL,
  p_target_audience text DEFAULT NULL, -- Filter by "Who is it for"
  p_search_term text DEFAULT NULL, -- Search in title/description/value
  p_limit int DEFAULT 20
) RETURNS TABLE (
  message_ts text,
  released_at timestamptz,
  posted_by_name text,
  posted_by_id text,
  title text,
  description text,
  target_audience text,
  value_proposition text,
  contributor_ids text[],
  contributor_names text[],
  contributor_count int,
  reaction_count int,
  attachment_count int,
  slack_url text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
  v_date_from date;
  v_date_to date;
  v_search text;
  v_audience text;
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

  v_audience := CASE
    WHEN p_target_audience IS NULL OR trim(p_target_audience) = '' THEN NULL
    ELSE trim(p_target_audience)
  END;

  RETURN QUERY
  WITH extracted AS (
    SELECT
      m.message_ts,
      m.message_at,
      COALESCE(m.user_display_name, m.user_real_name, 'Unknown') AS posted_by_name,
      m.user_id AS posted_by_id,

      -- Extract title: "What we are delivering today:" until first newline or section
      COALESCE(
        trim((regexp_match(m.text, 'What we are delivering[^:]*:\s*([^\n]+)', 'i'))[1]),
        'Untitled release'
      ) AS title,

      -- Extract description: Content between title and "Who is it for" (including bullet points)
      trim((regexp_match(m.text,
        'What we are delivering[^:]*:[^\n]*\n((?:[-•*]\s*[^\n]+\n?)+)',
        'is'))[1]
      ) AS description,

      -- Extract target audience: "Who is it for:" value
      COALESCE(
        trim((regexp_match(m.text, 'Who is it for:?\s*([^\n]+)', 'i'))[1]),
        'Not specified'
      ) AS target_audience,

      -- Extract value proposition: "Value:" until next section or end
      COALESCE(
        trim((regexp_match(m.text, 'Value:?\s*([^\n]+(?:\n(?![A-Z][a-z]+ ?:)[^\n]+)*)', 'i'))[1]),
        'Not specified'
      ) AS value_proposition,

      -- Extract contributor IDs from "Who has contributed:" section
      (SELECT array_agg(mention[1])
       FROM regexp_matches(
         COALESCE(
           (regexp_match(m.text, 'Who has contributed:?\s*(.+?)(?:\n(?:Value|What|When|Attachment)|$)', 'is'))[1],
           ''
         ),
         '<@([A-Z0-9]+)>',
         'g'
       ) AS mention
      ) AS contributor_ids,

      m.reaction_count,
      m.file_count AS attachment_count,

      -- Build Slack permalink
      'https://your-workspace.slack.com/archives/' || m.channel_id || '/p' ||
        replace(m.message_ts, '.', '') AS slack_url

    FROM volterra_kb.slack_messages m
    WHERE m.channel_id = COALESCE(NULLIF(trim(p_channel_id), ''), 'YOUR_SLACK_CHANNEL_ID')
      AND m.thread_ts IS NULL  -- Root messages only
      AND (
        m.text ILIKE '%delivery announcement%'
        OR m.text ILIKE '%What we are delivering%'
      )
      AND (v_date_from IS NULL OR m.message_at >= v_date_from)
      AND (v_date_to IS NULL OR m.message_at <= v_date_to)
  )
  SELECT
    e.message_ts,
    e.message_at AS released_at,
    e.posted_by_name,
    e.posted_by_id,
    e.title,
    e.description,
    e.target_audience,
    e.value_proposition,
    COALESCE(e.contributor_ids, ARRAY[]::text[]) AS contributor_ids,
    -- Resolve user IDs to names
    (SELECT array_agg(DISTINCT COALESCE(u.user_display_name, u.user_real_name, uid))
     FROM unnest(e.contributor_ids) AS uid
     LEFT JOIN LATERAL (
       SELECT user_display_name, user_real_name
       FROM volterra_kb.slack_messages
       WHERE user_id = uid
         AND (user_display_name IS NOT NULL OR user_real_name IS NOT NULL)
       LIMIT 1
     ) u ON true
    ) AS contributor_names,
    COALESCE(array_length(e.contributor_ids, 1), 0)::int AS contributor_count,
    COALESCE(e.reaction_count, 0)::int AS reaction_count,
    COALESCE(e.attachment_count, 0)::int AS attachment_count,
    e.slack_url
  FROM extracted e
  WHERE
    -- Filter by target audience if specified
    (v_audience IS NULL OR e.target_audience ILIKE '%' || v_audience || '%')
    -- Search filter across title, description, and value
    AND (v_search IS NULL OR (
      e.title ILIKE '%' || v_search || '%'
      OR e.description ILIKE '%' || v_search || '%'
      OR e.value_proposition ILIKE '%' || v_search || '%'
    ))
  ORDER BY e.message_at DESC
  LIMIT COALESCE(NULLIF(p_limit, 0), 20);
END;
$$;

-- Grant execute permissions for MCP and PostgREST access
GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_release_details (text, text, text, text, text, int) TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_get_release_details (text, text, text, text, text, int) TO anon;

COMMENT ON FUNCTION volterra_kb.mcp_get_release_details IS 'Parses release announcements extracting: title, description (bullet points), target audience, value proposition, and contributors. Supports filtering by audience and search terms. Used by n8n agent for release analytics.';

-- ============================================================================
-- ROLLBACK (run manually if needed)
-- ============================================================================
-- DROP FUNCTION IF EXISTS volterra_kb.mcp_get_release_details(text, text, text, text, text, int);
