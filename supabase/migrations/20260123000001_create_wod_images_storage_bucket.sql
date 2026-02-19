-- Migration: Create Supabase Storage bucket for WoD project images
-- Note: Storage bucket operations require storage admin permissions
--
-- Created: 2026-01-23
-- ============================================================================
-- Create the storage bucket for WoD project images
-- ============================================================================
INSERT INTO
  storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
  )
VALUES
  (
    'wod-project-images',
    'wod-project-images',
    true, -- Public bucket for signed URL access
    10485760, -- 10MB max file size
    ARRAY[
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp'
    ]::text[]
  )
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================================
-- Storage policies for wod-project-images bucket
-- ============================================================================
-- Allow authenticated users to read all images
CREATE POLICY "Public read access for wod-project-images" ON storage.objects FOR
SELECT
  USING (bucket_id = 'wod-project-images');

-- Allow service role to upload images
CREATE POLICY "Service role upload for wod-project-images" ON storage.objects FOR INSERT
WITH
  CHECK (bucket_id = 'wod-project-images');

-- Allow service role to update images
CREATE POLICY "Service role update for wod-project-images" ON storage.objects
FOR UPDATE
  USING (bucket_id = 'wod-project-images')
WITH
  CHECK (bucket_id = 'wod-project-images');

-- Allow service role to delete images
CREATE POLICY "Service role delete for wod-project-images" ON storage.objects FOR DELETE USING (bucket_id = 'wod-project-images');

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE 'Storage bucket wod-project-images created.';
    RAISE NOTICE 'Settings: public=true, max_size=10MB, types=jpeg,png,gif,webp';
    RAISE NOTICE '';
    RAISE NOTICE 'Verify with: SELECT * FROM storage.buckets WHERE id = ''wod-project-images'';';
END $$;
