-- Migration: 022_add_hnsw_vector_indexes.sql
-- Purpose: Add HNSW indexes for improved pgvector search performance
-- Created: 2025-12-23
--
-- HNSW (Hierarchical Navigable Small World) indexes provide:
-- - Better recall than IVFFlat for same accuracy target
-- - Faster query times for most workloads
-- - O(log n) search complexity vs O(n) for brute force
--
-- Recommended parameters:
-- m = 16 (default): Balance between build time and search quality
-- ef_construction = 64 (default): Higher = better recall, slower build
--
-- Note: These indexes REPLACE existing IVFFlat indexes.
-- Run rollback section if issues occur.

-- ============================================================================
-- STEP 1: Drop existing IVFFlat indexes (if they exist)
-- ============================================================================

DROP INDEX IF EXISTS idx_documents_embedding_idx;
DROP INDEX IF EXISTS idx_training_conversations_embedding_idx;
DROP INDEX IF EXISTS idx_slack_messages_embedding_idx;
DROP INDEX IF EXISTS idx_wod_deals_embedding_idx;

-- ============================================================================
-- STEP 2: Create HNSW indexes on embedding columns
-- Uses cosine distance (<=> operator) for semantic similarity search
-- ============================================================================

-- Documents embedding index
-- Main knowledge base semantic search
CREATE INDEX IF NOT EXISTS idx_documents_embedding_hnsw
ON documents USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Training conversations embedding index
-- HubSpot support ticket semantic search
CREATE INDEX IF NOT EXISTS idx_training_conversations_embedding_hnsw
ON training_conversations USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Slack messages embedding index
-- Internal discussion semantic search
CREATE INDEX IF NOT EXISTS idx_slack_messages_embedding_hnsw
ON slack_messages USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- WoD deals embedding index
-- Wheel of Deal pricing/installation data search
CREATE INDEX IF NOT EXISTS idx_wod_deals_embedding_hnsw
ON wod_deals USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- STEP 3: Add comments for documentation
-- ============================================================================

COMMENT ON INDEX idx_documents_embedding_hnsw IS 'HNSW index for document semantic search. Replaces IVFFlat index.';
COMMENT ON INDEX idx_training_conversations_embedding_hnsw IS 'HNSW index for support ticket search.';
COMMENT ON INDEX idx_slack_messages_embedding_hnsw IS 'HNSW index for Slack message search.';
COMMENT ON INDEX idx_wod_deals_embedding_hnsw IS 'HNSW index for WoD deal search.';

-- ============================================================================
-- STEP 4: Verify index creation
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'HNSW indexes created successfully.';
  RAISE NOTICE 'Verify with: SELECT indexname FROM pg_indexes WHERE indexname LIKE ''%hnsw%'';';
END $$;

-- ============================================================================
-- ROLLBACK (if issues occur)
-- Run this section to revert to IVFFlat indexes:
-- ============================================================================
/*
-- Drop HNSW indexes
DROP INDEX IF EXISTS idx_documents_embedding_hnsw;
DROP INDEX IF EXISTS idx_training_conversations_embedding_hnsw;
DROP INDEX IF EXISTS idx_slack_messages_embedding_hnsw;
DROP INDEX IF EXISTS idx_wod_deals_embedding_hnsw;

-- Recreate IVFFlat indexes
CREATE INDEX idx_documents_embedding_idx ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_training_conversations_embedding_idx ON training_conversations USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_slack_messages_embedding_idx ON slack_messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_wod_deals_embedding_idx ON wod_deals USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
*/
