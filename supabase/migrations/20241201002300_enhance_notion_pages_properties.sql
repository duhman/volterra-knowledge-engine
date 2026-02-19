-- Migration: Enhance notion_pages with property extraction and denormalized parent context
-- Purpose: Enable fast retrieval of project properties (Platform Lead, Status, Domain, etc.)
-- Date: 2025-12-29
-- ============================================================================
-- ADD COLUMNS TO notion_pages
-- ============================================================================
-- Core project properties (from Notion People/Select properties)
ALTER TABLE volterra_kb.notion_pages
ADD COLUMN IF NOT EXISTS platform_lead TEXT,
ADD COLUMN IF NOT EXISTS stakeholder_lead TEXT,
ADD COLUMN IF NOT EXISTS status TEXT,
ADD COLUMN IF NOT EXISTS impact_scale TEXT,
ADD COLUMN IF NOT EXISTS domain TEXT;

-- Extracted sections (from page content blocks)
ALTER TABLE volterra_kb.notion_pages
ADD COLUMN IF NOT EXISTS problem_section TEXT,
ADD COLUMN IF NOT EXISTS solution_section TEXT,
ADD COLUMN IF NOT EXISTS definition_of_done TEXT;

-- Denormalized parent context (for fast retrieval without joins)
ALTER TABLE volterra_kb.notion_pages
ADD COLUMN IF NOT EXISTS parent_title TEXT,
ADD COLUMN IF NOT EXISTS parent_project_name TEXT,
ADD COLUMN IF NOT EXISTS parent_roadmap_name TEXT;

-- Full properties JSONB (for future expansion, stores raw Notion properties)
ALTER TABLE volterra_kb.notion_pages
ADD COLUMN IF NOT EXISTS properties_raw JSONB;

-- Webhook tracking (for real-time meeting transcription sync)
ALTER TABLE volterra_kb.notion_pages
ADD COLUMN IF NOT EXISTS webhook_event_id TEXT,
ADD COLUMN IF NOT EXISTS webhook_event_at TIMESTAMPTZ;

-- Notion API metadata (user IDs for people properties)
ALTER TABLE volterra_kb.notion_pages
ADD COLUMN IF NOT EXISTS notion_created_by TEXT,
ADD COLUMN IF NOT EXISTS notion_last_edited_by TEXT;

-- ============================================================================
-- INDEXES
-- ============================================================================
-- Filter by status (most common query)
CREATE INDEX IF NOT EXISTS idx_notion_pages_status ON volterra_kb.notion_pages (status)
WHERE
  status IS NOT NULL;

-- Filter by platform lead
CREATE INDEX IF NOT EXISTS idx_notion_pages_platform_lead ON volterra_kb.notion_pages (platform_lead)
WHERE
  platform_lead IS NOT NULL;

-- Filter by domain
CREATE INDEX IF NOT EXISTS idx_notion_pages_domain ON volterra_kb.notion_pages (domain)
WHERE
  domain IS NOT NULL;

-- Filter by impact scale
CREATE INDEX IF NOT EXISTS idx_notion_pages_impact_scale ON volterra_kb.notion_pages (impact_scale)
WHERE
  impact_scale IS NOT NULL;

-- Composite index for common filter combinations
CREATE INDEX IF NOT EXISTS idx_notion_pages_status_domain ON volterra_kb.notion_pages (status, domain)
WHERE
  status IS NOT NULL;

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON COLUMN volterra_kb.notion_pages.platform_lead IS 'Display name of Platform Lead (from People property)';

COMMENT ON COLUMN volterra_kb.notion_pages.stakeholder_lead IS 'Display name of Stakeholder (from People property)';

COMMENT ON COLUMN volterra_kb.notion_pages.status IS 'Status value (from Select property)';

COMMENT ON COLUMN volterra_kb.notion_pages.impact_scale IS 'Impact Scale value (from Select property)';

COMMENT ON COLUMN volterra_kb.notion_pages.domain IS 'Domain value (from Select/Multi-select property)';

COMMENT ON COLUMN volterra_kb.notion_pages.problem_section IS 'Extracted text from "1. The Problem" section';

COMMENT ON COLUMN volterra_kb.notion_pages.solution_section IS 'Extracted text from "2. The Solution" section';

COMMENT ON COLUMN volterra_kb.notion_pages.definition_of_done IS 'Extracted text from "3. Definition of Done" section';

COMMENT ON COLUMN volterra_kb.notion_pages.parent_title IS 'Title of immediate parent page';

COMMENT ON COLUMN volterra_kb.notion_pages.parent_project_name IS 'Title of parent project (denormalized)';

COMMENT ON COLUMN volterra_kb.notion_pages.parent_roadmap_name IS 'Title of parent roadmap (denormalized)';

COMMENT ON COLUMN volterra_kb.notion_pages.properties_raw IS 'Full Notion properties JSON for future expansion';

COMMENT ON COLUMN volterra_kb.notion_pages.webhook_event_id IS 'ID of webhook event that triggered last update';

COMMENT ON COLUMN volterra_kb.notion_pages.webhook_event_at IS 'Timestamp of webhook event';

COMMENT ON COLUMN volterra_kb.notion_pages.notion_created_by IS 'Notion user ID who created the page';

COMMENT ON COLUMN volterra_kb.notion_pages.notion_last_edited_by IS 'Notion user ID who last edited the page';
