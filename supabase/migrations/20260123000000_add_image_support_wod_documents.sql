-- Migration: Add image support columns to wod_project_documents
-- Enables AI agents to "see" and understand project site photos and diagrams
--
-- Strategy:
--   - Images stored in Supabase Storage bucket
--   - Vision model (GPT-4V) analyzes images at ingestion time
--   - Generated descriptions embedded for semantic search
--   - Structured analysis stored as JSONB for filtering
--
-- Created: 2026-01-23
-- ============================================================================
-- STEP 1: Add columns for image metadata and vision analysis
-- ============================================================================
ALTER TABLE volterra_kb.wod_project_documents
ADD COLUMN IF NOT EXISTS is_image BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS storage_url TEXT,
ADD COLUMN IF NOT EXISTS image_width INTEGER,
ADD COLUMN IF NOT EXISTS image_height INTEGER,
ADD COLUMN IF NOT EXISTS vision_analysis JSONB DEFAULT '{}'::JSONB,
ADD COLUMN IF NOT EXISTS vision_model TEXT,
ADD COLUMN IF NOT EXISTS vision_processed_at TIMESTAMPTZ;

-- ============================================================================
-- STEP 2: Create index for image filtering
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_wod_docs_is_image ON volterra_kb.wod_project_documents (is_image)
WHERE
  is_image = TRUE;

-- ============================================================================
-- STEP 3: Update the document_type CHECK constraint to include site_photo
-- Note: site_photo already exists in the constraint, no change needed
-- ============================================================================
-- ============================================================================
-- STEP 4: Add image MIME type support
-- ============================================================================
COMMENT ON COLUMN volterra_kb.wod_project_documents.is_image IS 'True for image files (JPG, PNG) processed via vision model';

COMMENT ON COLUMN volterra_kb.wod_project_documents.storage_url IS 'Supabase Storage URL for image files (signed or public URL)';

COMMENT ON COLUMN volterra_kb.wod_project_documents.image_width IS 'Image width in pixels';

COMMENT ON COLUMN volterra_kb.wod_project_documents.image_height IS 'Image height in pixels';

COMMENT ON COLUMN volterra_kb.wod_project_documents.vision_analysis IS 'Structured analysis from vision model: {description, location_type, equipment_visible, issues_detected}';

COMMENT ON COLUMN volterra_kb.wod_project_documents.vision_model IS 'Model used for vision analysis (e.g., gpt-4-vision-preview, gpt-4o)';

COMMENT ON COLUMN volterra_kb.wod_project_documents.vision_processed_at IS 'Timestamp when vision analysis was completed';

-- ============================================================================
-- STEP 5: Update match function to optionally filter by images
-- First drop existing function to allow signature change
-- ============================================================================
DROP FUNCTION IF EXISTS volterra_kb.match_wod_project_documents (vector (1536), FLOAT, INT, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION volterra_kb.match_wod_project_documents (
  query_embedding vector (1536),
  match_threshold FLOAT DEFAULT 0.75,
  match_count INT DEFAULT 10,
  filter_deal_id UUID DEFAULT NULL,
  filter_stage TEXT DEFAULT NULL,
  filter_type TEXT DEFAULT NULL,
  filter_images_only BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  document_id UUID,
  chunk_id UUID,
  title TEXT,
  project_stage TEXT,
  document_type TEXT,
  deal_name TEXT,
  content TEXT,
  section_header TEXT,
  similarity FLOAT,
  is_image BOOLEAN,
  storage_url TEXT
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
        1 - (c.embedding <=> query_embedding) AS similarity,
        d.is_image,
        d.storage_url
    FROM volterra_kb.wod_project_document_chunks c
    JOIN volterra_kb.wod_project_documents d ON c.document_id = d.id
    LEFT JOIN volterra_kb.wod_deals wd ON d.deal_id = wd.id
    WHERE
        c.embedding IS NOT NULL
        AND (1 - (c.embedding <=> query_embedding)) > match_threshold
        AND (filter_deal_id IS NULL OR d.deal_id = filter_deal_id)
        AND (filter_stage IS NULL OR d.project_stage = filter_stage)
        AND (filter_type IS NULL OR d.document_type = filter_type)
        AND (NOT filter_images_only OR d.is_image = TRUE)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION volterra_kb.match_wod_project_documents IS 'Semantic search across WoD project documents with optional filtering by deal, stage, type, or images only';

-- ============================================================================
-- STEP 6: Add helper function for getting image documents
-- ============================================================================
CREATE OR REPLACE FUNCTION volterra_kb.get_wod_project_images (
  filter_deal_id UUID DEFAULT NULL,
  filter_stage TEXT DEFAULT NULL,
  limit_count INT DEFAULT 20
) RETURNS TABLE (
  document_id UUID,
  title TEXT,
  description TEXT,
  project_stage TEXT,
  deal_name TEXT,
  storage_url TEXT,
  vision_analysis JSONB,
  image_width INTEGER,
  image_height INTEGER,
  created_at TIMESTAMPTZ
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
        wd.deal_name,
        d.storage_url,
        d.vision_analysis,
        d.image_width,
        d.image_height,
        d.created_at
    FROM volterra_kb.wod_project_documents d
    LEFT JOIN volterra_kb.wod_deals wd ON d.deal_id = wd.id
    WHERE
        d.is_image = TRUE
        AND (filter_deal_id IS NULL OR d.deal_id = filter_deal_id)
        AND (filter_stage IS NULL OR d.project_stage = filter_stage)
    ORDER BY d.created_at DESC
    LIMIT limit_count;
END;
$$;

COMMENT ON FUNCTION volterra_kb.get_wod_project_images IS 'Get project images with optional deal and stage filtering';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE 'Image support columns added to wod_project_documents.';
    RAISE NOTICE 'New columns: is_image, storage_url, image_width, image_height, vision_analysis, vision_model, vision_processed_at';
    RAISE NOTICE 'Updated function: match_wod_project_documents (now includes is_image, storage_url)';
    RAISE NOTICE 'New function: get_wod_project_images';
    RAISE NOTICE 'Verify with: SELECT column_name FROM information_schema.columns WHERE table_name = ''wod_project_documents'' AND column_name LIKE ''%%image%%'';';
END $$;
