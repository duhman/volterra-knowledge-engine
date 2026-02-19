-- Migration: Add MCP Tools Search Table
-- Purpose: Enable semantic search over MCP tool definitions
-- This helps LLMs find the right tool when there are many tools available
--
-- Based on Anthropic's "Tool Search" documentation recommendations:
-- - Store tool definitions with embeddings for semantic search
-- - Provides accuracy improvements when tool count > 30
SET
  search_path = 'volterra_kb',
  'extensions',
  'public';

-- =============================================================================
-- 1. Create mcp_tools table
-- =============================================================================
CREATE TABLE IF NOT EXISTS volterra_kb.mcp_tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  category TEXT,
  input_schema JSONB,
  embedding extensions.vector (1536),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create HNSW index for fast similarity search
CREATE INDEX IF NOT EXISTS mcp_tools_embedding_idx ON volterra_kb.mcp_tools USING hnsw (embedding extensions.vector_cosine_ops)
WITH
  (m = 16, ef_construction = 64);

-- Index on category for filtering
CREATE INDEX IF NOT EXISTS mcp_tools_category_idx ON volterra_kb.mcp_tools (category);

-- =============================================================================
-- 2. Create search function
-- =============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.search_mcp_tools (
  query_embedding extensions.vector (1536),
  match_count INT DEFAULT 5,
  category_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  name TEXT,
  description TEXT,
  category TEXT,
  input_schema JSONB,
  similarity FLOAT
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'extensions',
  'public' AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.name,
    t.description,
    t.category,
    t.input_schema,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM volterra_kb.mcp_tools t
  WHERE
    t.embedding IS NOT NULL
    AND (category_filter IS NULL OR t.category = category_filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- =============================================================================
-- 3. Create MCP-accessible wrapper
-- =============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.mcp_search_tools (
  p_query_embedding TEXT,
  p_match_count INT DEFAULT 5,
  p_category TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = 'volterra_kb',
  'extensions',
  'public' AS $$
DECLARE
  v_embedding extensions.vector(1536);
  v_results JSONB;
BEGIN
  -- Parse the embedding from JSON text
  v_embedding := p_query_embedding::extensions.vector(1536);

  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
  INTO v_results
  FROM (
    SELECT
      name,
      description,
      category,
      input_schema,
      similarity
    FROM volterra_kb.search_mcp_tools(
      v_embedding,
      p_match_count,
      p_category
    )
  ) r;

  RETURN v_results;
END;
$$;

-- =============================================================================
-- 4. Create upsert function for populating tools
-- =============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.upsert_mcp_tool (
  p_name TEXT,
  p_description TEXT,
  p_category TEXT,
  p_input_schema JSONB,
  p_embedding extensions.vector (1536)
) RETURNS VOID LANGUAGE plpgsql
SET
  search_path = 'volterra_kb',
  'extensions',
  'public' AS $$
BEGIN
  INSERT INTO volterra_kb.mcp_tools (name, description, category, input_schema, embedding, updated_at)
  VALUES (p_name, p_description, p_category, p_input_schema, p_embedding, NOW())
  ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    input_schema = EXCLUDED.input_schema,
    embedding = EXCLUDED.embedding,
    updated_at = NOW();
END;
$$;

-- =============================================================================
-- 5. Grant permissions
-- =============================================================================
GRANT USAGE ON SCHEMA volterra_kb TO service_role,
anon;

GRANT
SELECT
  ON volterra_kb.mcp_tools TO service_role,
  anon;

GRANT INSERT,
UPDATE ON volterra_kb.mcp_tools TO service_role;

GRANT
EXECUTE ON FUNCTION volterra_kb.search_mcp_tools TO service_role,
anon;

GRANT
EXECUTE ON FUNCTION volterra_kb.mcp_search_tools TO service_role,
anon;

GRANT
EXECUTE ON FUNCTION volterra_kb.upsert_mcp_tool TO service_role;

-- =============================================================================
-- 6. Add helpful comment
-- =============================================================================
COMMENT ON TABLE volterra_kb.mcp_tools IS 'MCP tool definitions with embeddings for semantic search.
Enables LLMs to find the right tool when there are many tools available.
Populated by scripts/populate-mcp-tools.ts';

COMMENT ON FUNCTION volterra_kb.search_mcp_tools IS 'Semantic search over MCP tools. Used to find relevant tools for a user query.
Returns tools sorted by similarity to the query embedding.';

COMMENT ON FUNCTION volterra_kb.mcp_search_tools IS 'MCP-accessible wrapper for tool search. Accepts embedding as JSON text.';
