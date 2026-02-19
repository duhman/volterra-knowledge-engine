-- Enable pgvector extension for vector embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Create documents table for storing ingested company documents
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Core content
    content TEXT NOT NULL,
    embedding vector(1536),  -- text-embedding-3-small dimensions
    
    -- Metadata
    department TEXT NOT NULL,
    document_type TEXT NOT NULL,
    title TEXT NOT NULL,
    owner TEXT,
    access_level TEXT NOT NULL DEFAULT 'internal' 
        CHECK (access_level IN ('public', 'internal', 'restricted', 'confidential')),
    
    -- Optional metadata
    tags TEXT[],
    sensitivity TEXT CHECK (sensitivity IN ('GDPR', 'PII', 'None')),
    language TEXT,
    
    -- Source tracking
    source_type TEXT,
    source_path TEXT,
    original_filename TEXT,
    mime_type TEXT,
    file_size BIGINT,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create trigger function for auto-updating updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for documents table
DROP TRIGGER IF EXISTS update_documents_updated_at ON documents;
CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_documents_department ON documents(department);
CREATE INDEX IF NOT EXISTS idx_documents_document_type ON documents(document_type);
CREATE INDEX IF NOT EXISTS idx_documents_access_level ON documents(access_level);
CREATE INDEX IF NOT EXISTS idx_documents_sensitivity ON documents(sensitivity);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_tags ON documents USING GIN(tags);

-- Create vector similarity search index (IVFFlat for better performance)
CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents 
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Function for semantic search
CREATE OR REPLACE FUNCTION match_documents(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.78,
    match_count INT DEFAULT 10,
    filter_department TEXT DEFAULT NULL,
    filter_access_level TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    department TEXT,
    document_type TEXT,
    title TEXT,
    access_level TEXT,
    sensitivity TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.content,
        d.department,
        d.document_type,
        d.title,
        d.access_level,
        d.sensitivity,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM documents d
    WHERE 
        (1 - (d.embedding <=> query_embedding)) > match_threshold
        AND (filter_department IS NULL OR d.department = filter_department)
        AND (filter_access_level IS NULL OR d.access_level = filter_access_level)
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Grant necessary permissions (adjust role as needed)
-- GRANT ALL ON documents TO authenticated;
-- GRANT EXECUTE ON FUNCTION match_documents TO authenticated;

COMMENT ON TABLE documents IS 'Stores ingested company documents with vector embeddings for semantic search';
COMMENT ON COLUMN documents.embedding IS 'Vector embedding from text-embedding-3-small (1536 dimensions)';
COMMENT ON COLUMN documents.sensitivity IS 'Data sensitivity classification: GDPR (contains GDPR-relevant data), PII (contains personal information), None';
COMMENT ON COLUMN documents.access_level IS 'Access control level: public, internal, restricted, confidential';

