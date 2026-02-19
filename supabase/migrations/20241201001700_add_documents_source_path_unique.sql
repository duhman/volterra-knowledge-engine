-- Migration: Add unique constraint on documents(source_type, source_path)
-- Enables upsert semantics for Notion (and other sources) sync
-- Also cleans up existing duplicates before adding constraint

-- ============================================================================
-- CLEANUP: Remove duplicate documents by source_path (keep newest)
-- ============================================================================

-- Delete older duplicates, keeping only the most recent row per (source_type, source_path)
WITH duplicates AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY source_type, source_path 
               ORDER BY updated_at DESC, created_at DESC, id DESC
           ) as rn
    FROM documents
    WHERE source_path IS NOT NULL
)
DELETE FROM documents
WHERE id IN (
    SELECT id FROM duplicates WHERE rn > 1
);

-- ============================================================================
-- ADD UNIQUE CONSTRAINT (partial index - only for rows with source_path)
-- ============================================================================

-- Create unique index for upsert operations
-- Partial index: only applies to rows where source_path IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_type_path_unique
    ON documents(source_type, source_path)
    WHERE source_path IS NOT NULL;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON INDEX idx_documents_source_type_path_unique IS 
    'Unique constraint for upsert operations by source. Enables Notion sync to update existing docs.';
