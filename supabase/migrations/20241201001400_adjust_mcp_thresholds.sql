-- Migration: Adjust MCP function thresholds for better recall
-- Applied after initial testing showed default thresholds were too high

CREATE OR REPLACE FUNCTION mcp_match_documents(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  title text,
  department text,
  document_type text,
  source_type text,
  source_path text,
  content_preview text,
  similarity float
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
    LEFT(d.content, 500) as content_preview,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE 
    d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT LEAST(match_count, 20);
$$;

COMMENT ON FUNCTION mcp_match_documents IS 'Safe semantic search over documents with truncated content preview. Threshold lowered to 0.5 for better recall.';
