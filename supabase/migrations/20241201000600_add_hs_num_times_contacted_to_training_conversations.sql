-- Migration: Add hs_num_times_contacted column to training_conversations
-- This stores HubSpot's interaction count for high-interaction ticket analysis

-- Add the column (nullable, will be backfilled)
ALTER TABLE training_conversations
ADD COLUMN IF NOT EXISTS hs_num_times_contacted INTEGER;

-- Add index for efficient high-interaction queries (descending for top-N)
CREATE INDEX IF NOT EXISTS idx_training_conversations_hs_num_times_contacted
ON training_conversations (hs_num_times_contacted DESC NULLS LAST);

-- Comment
COMMENT ON COLUMN training_conversations.hs_num_times_contacted IS 'HubSpot hs_num_times_contacted property - number of interactions/touches on this ticket';
