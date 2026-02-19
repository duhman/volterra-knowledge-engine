-- Migration: Create public schema wrapper for reaction analytics
-- Purpose: Enable n8n/PostgREST access to volterra_kb.mcp_get_reaction_analytics
-- Note: PostgREST defaults to public schema, so we need a wrapper function
-- ============================================================================
-- PUBLIC SCHEMA WRAPPER FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_reaction_analytics (
  p_channel_id TEXT DEFAULT 'C078S57MS5P',
  p_date_from DATE DEFAULT NULL,
  p_date_to DATE DEFAULT NULL
) RETURNS TABLE (
  total_messages BIGINT,
  messages_with_reactions BIGINT,
  total_reactions BIGINT,
  avg_reactions_per_message NUMERIC,
  top_reactions JSONB
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT * FROM volterra_kb.mcp_get_reaction_analytics(p_channel_id, p_date_from, p_date_to);
$$;

-- Grant permissions for PostgREST access
GRANT
EXECUTE ON FUNCTION public.get_reaction_analytics TO anon;

GRANT
EXECUTE ON FUNCTION public.get_reaction_analytics TO service_role;

-- Documentation
COMMENT ON FUNCTION public.get_reaction_analytics IS 'Get Slack reaction analytics for a channel.

Wrapper for volterra_kb.mcp_get_reaction_analytics to enable n8n/PostgREST access.

Parameters:
- p_channel_id: Slack channel ID (default: C078S57MS5P = #platform-all-deliveries)
- p_date_from: Start date for analysis (ISO format)
- p_date_to: End date for analysis (ISO format)

Returns:
- total_messages: Count of messages in the date range
- messages_with_reactions: Count of messages that received at least one reaction
- total_reactions: Sum of all reactions across all messages
- avg_reactions_per_message: Average engagement rate
- top_reactions: Array of {name, total_count} for top 10 emojis

Channel IDs:
- C078S57MS5P: #platform-all-deliveries (release announcements)
- C05FA8B5YPM: #help-me-platform (support discussions)

Example:
  SELECT * FROM get_reaction_analytics(''C078S57MS5P'', ''2025-01-01'', ''2025-12-31'');
';
