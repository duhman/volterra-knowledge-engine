-- Migration: Create WoD Project Documents tables for project documentation
-- This schema stores complete EV charging project documentation with embeddings
-- for LLM semantic search across all project lifecycle stages.
--
-- References:
--   - wod_deals: Links to existing deal pricing/calculations
--   - Project stages: sales_material, site_photos, site_plans, communication,
--                    contractor_quotes, implementation, handover
--
-- Created: 2026-01-22
-- ============================================================================
-- TABLE 1: wod_project_documents
-- Project document metadata and extracted text
-- ============================================================================
CREATE TABLE IF NOT EXISTS volterra_kb.wod_project_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Link to parent deal (optional - not all docs have a deal)
  deal_id UUID REFERENCES volterra_kb.wod_deals (id) ON DELETE SET NULL,
  -- Document identification
  title TEXT NOT NULL,
  description TEXT,
  -- Project lifecycle stage classification
  project_stage TEXT NOT NULL CHECK (
    project_stage IN (
      'sales_material', -- 01 Säljmaterial
      'site_photos', -- 02 Bilder
      'site_plans', -- 03 Översiktsplan
      'communication', -- 04 Kommunikation
      'contractor_quotes', -- 05 Offert från UE
      'implementation', -- 06 Entreprenad
      'handover' -- 07 Överlämning
    )
  ),
  -- Document type within stage
  document_type TEXT NOT NULL CHECK (
    document_type IN (
      -- Sales materials
      'presentation',
      'offer_document',
      'wod_calculator',
      -- Site documentation
      'site_photo',
      'site_map',
      'circuit_diagram',
      -- Communication
      'meeting_notes',
      'email',
      -- Contractor documents
      'contractor_quote',
      'contractor_agreement',
      -- Implementation
      'project_binder',
      'quality_plan',
      'dou_document',
      'self_inspection',
      'control_plan',
      'environment_plan',
      -- Handover
      'handover_protocol',
      'ampeco_import',
      -- Generic
      'product_sheet',
      'manual',
      'certificate',
      'order_form',
      'other'
    )
  ),
  -- File metadata
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT,
  file_hash TEXT, -- SHA-256 for deduplication
  -- Unique source path for deduplication
  -- Format: wod://SE/BRF-Fyrhoejden/06-Entreprenad/6.5-DoU-parm/filename.pdf
  source_path TEXT UNIQUE NOT NULL,
  -- Extracted content
  raw_text TEXT, -- Full extracted text from document
  -- Structured metadata extracted from content
  -- Examples: serial_numbers, contact_info, dates, charger_models
  extracted_metadata JSONB DEFAULT '{}'::JSONB,
  -- Processing state
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    processing_status IN (
      'pending', -- Not yet processed
      'processing', -- Currently being processed
      'completed', -- Successfully processed with embeddings
      'failed', -- Processing failed
      'skipped' -- Intentionally skipped (e.g., images)
    )
  ),
  -- Chunk tracking
  chunks_count INTEGER DEFAULT 0,
  -- Document metadata
  language TEXT DEFAULT 'sv',
  document_date DATE, -- Date mentioned in/on document
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- TABLE 2: wod_project_document_chunks
-- Document chunks with vector embeddings for semantic search
-- ============================================================================
CREATE TABLE IF NOT EXISTS volterra_kb.wod_project_document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Parent document reference
  document_id UUID NOT NULL REFERENCES volterra_kb.wod_project_documents (id) ON DELETE CASCADE,
  -- Chunk content
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL, -- 0-based index within document
  -- Optional section context
  section_header TEXT, -- Header/section this chunk belongs to
  -- Token count for embedding budgeting
  token_count INTEGER,
  -- Vector embedding (text-embedding-3-small: 1536 dimensions)
  embedding vector (1536),
  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Ensure unique chunk per document
  UNIQUE (document_id, chunk_index)
);

-- ============================================================================
-- INDEXES
-- ============================================================================
-- Document metadata indexes
CREATE INDEX IF NOT EXISTS idx_wod_project_documents_deal_id ON volterra_kb.wod_project_documents (deal_id);

CREATE INDEX IF NOT EXISTS idx_wod_project_documents_stage ON volterra_kb.wod_project_documents (project_stage);

CREATE INDEX IF NOT EXISTS idx_wod_project_documents_type ON volterra_kb.wod_project_documents (document_type);

CREATE INDEX IF NOT EXISTS idx_wod_project_documents_source_path ON volterra_kb.wod_project_documents (source_path);

CREATE INDEX IF NOT EXISTS idx_wod_project_documents_status ON volterra_kb.wod_project_documents (processing_status);

CREATE INDEX IF NOT EXISTS idx_wod_project_documents_created_at ON volterra_kb.wod_project_documents (created_at DESC);

-- Chunk indexes
CREATE INDEX IF NOT EXISTS idx_wod_project_document_chunks_document_id ON volterra_kb.wod_project_document_chunks (document_id);

-- HNSW vector index for fast semantic search
-- Uses cosine similarity which works well for text embeddings
CREATE INDEX IF NOT EXISTS idx_wod_project_document_chunks_embedding_hnsw ON volterra_kb.wod_project_document_chunks USING hnsw (embedding vector_cosine_ops)
WITH
  (m = 16, ef_construction = 64);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
-- Auto-update updated_at for project documents
DROP TRIGGER IF EXISTS update_wod_project_documents_updated_at ON volterra_kb.wod_project_documents;

CREATE TRIGGER update_wod_project_documents_updated_at BEFORE
UPDATE ON volterra_kb.wod_project_documents FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column ();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE volterra_kb.wod_project_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE volterra_kb.wod_project_document_chunks ENABLE ROW LEVEL SECURITY;

-- Full access for service role (backend operations)
CREATE POLICY "Service role full access on wod_project_documents" ON volterra_kb.wod_project_documents FOR ALL USING (true)
WITH
  CHECK (true);

CREATE POLICY "Service role full access on wod_project_document_chunks" ON volterra_kb.wod_project_document_chunks FOR ALL USING (true)
WITH
  CHECK (true);

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE volterra_kb.wod_project_documents IS 'Project documentation metadata for WoD deals - contracts, specs, quality plans, etc.';

COMMENT ON TABLE volterra_kb.wod_project_document_chunks IS 'Text chunks with embeddings for semantic search across project documents';

COMMENT ON COLUMN volterra_kb.wod_project_documents.project_stage IS 'Lifecycle stage: sales_material, site_photos, site_plans, communication, contractor_quotes, implementation, handover';

COMMENT ON COLUMN volterra_kb.wod_project_documents.source_path IS 'Unique identifier for deduplication: wod://{market}/{deal-name}/{folder}/{filename}';

COMMENT ON COLUMN volterra_kb.wod_project_documents.extracted_metadata IS 'Structured data extracted from document: serial_numbers, contacts, charger_models, dates';

COMMENT ON COLUMN volterra_kb.wod_project_document_chunks.embedding IS 'Vector embedding from text-embedding-3-small (1536 dimensions) for semantic search';

COMMENT ON INDEX volterra_kb.idx_wod_project_document_chunks_embedding_hnsw IS 'HNSW index for fast approximate nearest neighbor search on document chunks';

-- ============================================================================
-- SEMANTIC SEARCH FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.match_wod_project_documents (
  query_embedding vector (1536),
  match_threshold FLOAT DEFAULT 0.75,
  match_count INT DEFAULT 10,
  filter_deal_id UUID DEFAULT NULL,
  filter_stage TEXT DEFAULT NULL,
  filter_type TEXT DEFAULT NULL
) RETURNS TABLE (
  document_id UUID,
  chunk_id UUID,
  title TEXT,
  project_stage TEXT,
  document_type TEXT,
  deal_name TEXT,
  content TEXT,
  section_header TEXT,
  similarity FLOAT
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = extensions,
  volterra_kb,
  public AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id AS document_id,
        c.id AS chunk_id,
        d.title,
        d.project_stage,
        d.document_type,
        wd.deal_name,
        c.content,
        c.section_header,
        1 - (c.embedding <=> query_embedding) AS similarity
    FROM volterra_kb.wod_project_document_chunks c
    JOIN volterra_kb.wod_project_documents d ON c.document_id = d.id
    LEFT JOIN volterra_kb.wod_deals wd ON d.deal_id = wd.id
    WHERE
        c.embedding IS NOT NULL
        AND (1 - (c.embedding <=> query_embedding)) > match_threshold
        AND (filter_deal_id IS NULL OR d.deal_id = filter_deal_id)
        AND (filter_stage IS NULL OR d.project_stage = filter_stage)
        AND (filter_type IS NULL OR d.document_type = filter_type)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION volterra_kb.match_wod_project_documents IS 'Semantic search across WoD project documents with optional filtering by deal, stage, or type';

-- ============================================================================
-- HELPER FUNCTION: Get document with all chunks
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.get_wod_document_context (doc_id UUID) RETURNS TABLE (
  document_id UUID,
  title TEXT,
  description TEXT,
  project_stage TEXT,
  document_type TEXT,
  original_filename TEXT,
  deal_name TEXT,
  deal_id UUID,
  extracted_metadata JSONB,
  full_text TEXT,
  chunks_count INTEGER
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = extensions,
  volterra_kb,
  public AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id AS document_id,
        d.title,
        d.description,
        d.project_stage,
        d.document_type,
        d.original_filename,
        wd.deal_name,
        d.deal_id,
        d.extracted_metadata,
        d.raw_text AS full_text,
        d.chunks_count
    FROM volterra_kb.wod_project_documents d
    LEFT JOIN volterra_kb.wod_deals wd ON d.deal_id = wd.id
    WHERE d.id = doc_id;
END;
$$;

COMMENT ON FUNCTION volterra_kb.get_wod_document_context IS 'Retrieve full document context including metadata, text, and linked deal info';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE 'WoD Project Documents tables created successfully.';
    RAISE NOTICE 'Tables: wod_project_documents, wod_project_document_chunks';
    RAISE NOTICE 'Functions: match_wod_project_documents, get_wod_document_context';
    RAISE NOTICE '';
    RAISE NOTICE 'Verify with: SELECT COUNT(*) FROM volterra_kb.wod_project_documents;';
END $$;
