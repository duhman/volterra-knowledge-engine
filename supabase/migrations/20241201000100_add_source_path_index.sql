-- Add index on source_path for deduplication lookups
-- This enables efficient "document exists" checks when re-running ingestion

-- Create index for fast lookups (not unique since chunks share base path)
CREATE INDEX IF NOT EXISTS idx_documents_source_path ON documents(source_path);

-- Add index on source_type for filtering
CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents(source_type);

COMMENT ON INDEX idx_documents_source_path IS 'Index for deduplication checks during ingestion';
COMMENT ON INDEX idx_documents_source_type IS 'Index for filtering documents by source';
