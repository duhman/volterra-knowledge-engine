-- Add content column to training_messages for full message body storage
-- This column exists in Cloud Supabase but was missing from local sync
SET
  search_path = 'volterra_kb',
  'public';

-- Add content column if it doesn't exist
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'volterra_kb'
      AND table_name = 'training_messages'
      AND column_name = 'content'
  ) THEN
    ALTER TABLE volterra_kb.training_messages
    ADD COLUMN content TEXT;

    COMMENT ON COLUMN volterra_kb.training_messages.content IS 'Full message body content from emails/engagements';
  END IF;
END $$;

-- Rollback SQL (commented):
-- ALTER TABLE volterra_kb.training_messages DROP COLUMN IF EXISTS content;
