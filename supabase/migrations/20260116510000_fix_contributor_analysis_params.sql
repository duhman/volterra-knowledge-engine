-- Migration: Fix contributor analysis function to handle empty string parameters
-- n8n toolHttpRequest may send empty strings when AI doesn't fill placeholders
-- This update accepts TEXT parameters and converts empty strings to NULL
-- ============================================================================
-- DROP AND RECREATE FUNCTION WITH TEXT PARAMS
-- ============================================================================
DROP FUNCTION IF EXISTS volterra_kb.mcp_analyze_release_contributors (text, date, date, int);

CREATE OR REPLACE FUNCTION volterra_kb.mcp_analyze_release_contributors (
  p_channel_id text DEFAULT 'YOUR_SLACK_CHANNEL_ID',
  p_date_from text DEFAULT NULL, -- Changed from date to text
  p_date_to text DEFAULT NULL, -- Changed from date to text
  p_limit int DEFAULT 20
) RETURNS TABLE (
  message_ts text,
  message_at timestamptz,
  release_title text,
  contributor_ids text[],
  contributor_names text[],
  contributor_count int,
  reaction_count int,
  text_preview text
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'public' AS $$
DECLARE
  v_date_from date;
  v_date_to date;
BEGIN
  -- Convert empty strings to NULL, otherwise parse as date
  v_date_from := CASE
    WHEN p_date_from IS NULL OR trim(p_date_from) = '' THEN NULL
    ELSE p_date_from::date
  END;

  v_date_to := CASE
    WHEN p_date_to IS NULL OR trim(p_date_to) = '' THEN NULL
    ELSE p_date_to::date
  END;

  RETURN QUERY
  WITH extracted AS (
    SELECT
      m.message_ts,
      m.message_at,
      -- Extract title: look for "What we are delivering" or similar patterns
      COALESCE(
        -- Pattern 1: "What we are delivering today: :emoji: Title"
        (regexp_match(m.text, 'What we are delivering[^:]*:\s*:[^:]+:\s*(.+?)(?:\n|$)', 'i'))[1],
        -- Pattern 2: "What we are delivering today: Title"
        (regexp_match(m.text, 'What we are delivering[^:]*:\s*\*?([^*\n]+)', 'i'))[1],
        -- Pattern 3: First non-empty line after title marker
        (regexp_match(m.text, 'delivering[^:]*:\s*(.+?)(?:\n|$)', 'i'))[1]
      ) AS release_title,
      -- Extract all user mentions from "Who has contributed:" section
      (SELECT array_agg(mention[1])
       FROM regexp_matches(
         COALESCE(
           -- Match everything after "Who has contributed:" until next section or end
           (regexp_match(m.text, 'Who has contributed:?\*?\s*(.+?)(?:\n\*?(?:Value|What|When|$)|\n\n|$)', 'is'))[1],
           ''
         ),
         '<@([A-Z0-9]+)>',
         'g'
       ) AS mention
      ) AS contributor_ids,
      m.reaction_count,
      substring(m.text, 1, 200) AS text_preview
    FROM volterra_kb.slack_messages m
    WHERE m.channel_id = COALESCE(NULLIF(trim(p_channel_id), ''), 'YOUR_SLACK_CHANNEL_ID')
      AND m.thread_ts IS NULL  -- Root messages only (releases are root messages)
      AND (
        m.text ILIKE '%delivery announcement%'
        OR m.text ILIKE '%What we are delivering%'
      )
      AND (v_date_from IS NULL OR m.message_at >= v_date_from)
      AND (v_date_to IS NULL OR m.message_at <= v_date_to)
  )
  SELECT
    e.message_ts,
    e.message_at,
    COALESCE(NULLIF(trim(e.release_title), ''), 'Untitled release') AS release_title,
    COALESCE(e.contributor_ids, ARRAY[]::text[]) AS contributor_ids,
    -- Resolve user IDs to names using existing slack_messages author data
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
    e.text_preview
  FROM extracted e
  ORDER BY COALESCE(array_length(e.contributor_ids, 1), 0) DESC, e.message_at DESC
  LIMIT COALESCE(NULLIF(p_limit, 0), 20);
END;
$$;

-- Grant execute permissions for MCP and PostgREST access
GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_analyze_release_contributors (text, text, text, int) TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_analyze_release_contributors (text, text, text, int) TO anon;

COMMENT ON FUNCTION volterra_kb.mcp_analyze_release_contributors IS 'Analyzes release announcements by contributor count. Accepts TEXT params (converts empty strings to NULL). Used by n8n agent for release analytics.';

-- ============================================================================
-- ROLLBACK (run manually if needed)
-- ============================================================================
-- DROP FUNCTION IF EXISTS volterra_kb.mcp_analyze_release_contributors(text, text, text, int);
