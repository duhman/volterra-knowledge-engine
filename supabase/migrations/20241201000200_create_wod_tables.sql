-- Migration: Create Wheel of Deal (WoD) tables for structured deal data
-- This schema supports the ingestion of WoD Excel files with proper normalization
-- for LLM retrieval via semantic search and structured queries

-- ============================================================================
-- STATIC REFERENCE DATA TABLES
-- These contain data from the WoD template that rarely changes
-- ============================================================================

-- Cost catalog: Master price list for all components (from 'Cost list' sheet)
CREATE TABLE IF NOT EXISTS wod_cost_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Component identification
    component_name TEXT NOT NULL,
    category TEXT NOT NULL,  -- 'charger', 'backplate', 'cable', 'attachment', 'mounting', 'connectivity', 'labor'
    subcategory TEXT,
    
    -- Supplier info
    supplier TEXT,
    supplier_article_number TEXT,
    
    -- Pricing
    unit_cost DECIMAL(12, 2),
    unit TEXT,  -- 'pcs', 'm', 'h', etc.
    
    -- Labor associated with this component
    labor_hourly_rate DECIMAL(10, 2),
    labor_time_minutes INTEGER,
    labor_cost DECIMAL(10, 2),
    
    -- Market/version tracking
    market TEXT NOT NULL DEFAULT 'SE',  -- 'SE', 'NO', 'DK', 'DE'
    template_version TEXT NOT NULL,  -- e.g., 'v8', 'v6.4'
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(component_name, category, market, template_version)
);

-- Static configuration: Corporate assumptions and config options (from 'Static values', 'Common input' sheets)
CREATE TABLE IF NOT EXISTS wod_static_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    config_type TEXT NOT NULL,  -- 'geographic_zone', 'power_level', 'charger_type', 'corporate_assumption', 'utilization_forecast'
    config_key TEXT NOT NULL,
    config_value JSONB NOT NULL,  -- Flexible storage for various config types
    
    -- Scope
    market TEXT NOT NULL DEFAULT 'SE',
    country TEXT,
    facility_type TEXT,  -- 'Private', 'Shared'
    charger_model TEXT,  -- 'Easee', 'Zaptec', 'Ctek'
    
    -- Version tracking
    template_version TEXT NOT NULL,
    
    -- Metadata
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(config_type, config_key, market, template_version, COALESCE(country, ''), COALESCE(facility_type, ''), COALESCE(charger_model, ''))
);

-- ============================================================================
-- DEAL-SPECIFIC TABLES
-- These contain data from filled-in customer WoD files
-- ============================================================================

-- Main deals table: One row per customer deal/project
CREATE TABLE IF NOT EXISTS wod_deals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Project identification
    deal_name TEXT NOT NULL,  -- BRF/project name
    deal_reference TEXT,  -- Optional external reference (HubSpot deal ID, etc.)
    
    -- Location
    geographic_area TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'SE',
    zone TEXT,  -- Zone A, B, C based on static config
    
    -- Facility details
    total_parking_spaces INTEGER NOT NULL,
    housing_units INTEGER,
    guest_parking INTEGER DEFAULT 0,
    real_potential INTEGER,  -- Calculated potential
    
    -- Configuration
    power_level TEXT,  -- 'Minimum (2 A)', 'Average (3 A)', 'Premium (6 A)'
    charger_type TEXT,  -- 'Easee Charge', 'Zaptec Pro', 'Ctek'
    
    -- Installation requirements
    digging_required BOOLEAN DEFAULT FALSE,
    asphalt_digging_meters DECIMAL(8, 2) DEFAULT 0,
    green_space_digging_meters DECIMAL(8, 2) DEFAULT 0,
    signal_coverage_available BOOLEAN DEFAULT TRUE,
    
    -- Totals
    total_boxes INTEGER NOT NULL,
    total_infrastructure_ps INTEGER NOT NULL,
    
    -- Economics summary
    total_cost_excl_vat DECIMAL(12, 2),
    total_material_cost DECIMAL(12, 2),
    total_work_cost DECIMAL(12, 2),
    gross_margin_buy DECIMAL(10, 2),
    gross_margin_rent DECIMAL(10, 2),
    markup_percentage DECIMAL(5, 4),
    
    -- Offer prices
    start_fee_incl_vat DECIMAL(10, 2),
    start_fee_gron_teknik DECIMAL(10, 2),
    admin_fee_incl_vat DECIMAL(10, 2),
    rent_monthly_buy DECIMAL(10, 2),  -- Monthly fee for "buy charger" option
    rent_monthly_rent DECIMAL(10, 2),  -- Monthly fee for "rent charger" option
    
    -- Purchase offer totals
    purchase_total_excl_subsidy DECIMAL(12, 2),
    purchase_total_with_subsidy DECIMAL(12, 2),
    
    -- Raw data storage for flexibility
    raw_inputs JSONB,  -- All input fields from WoD sheet
    raw_economy JSONB,  -- All fields from Economy sheet
    raw_cost_output JSONB,  -- All fields from Cost output sheet
    
    -- Creator/audit
    creator_name TEXT,
    four_eyes_name TEXT,  -- Second reviewer
    deal_date DATE,
    
    -- Source tracking
    source_path TEXT UNIQUE,  -- e.g., 'wod://SE/BRF-Fyrtornet-10/v8/2025-11-18'
    original_filename TEXT,
    template_version TEXT,
    file_hash TEXT,  -- For change detection
    
    -- Embedding for semantic search
    embedding vector(1536),
    embedding_content TEXT,  -- The text that was embedded
    
    -- Metadata
    sensitivity TEXT DEFAULT 'PII' CHECK (sensitivity IN ('GDPR', 'PII', 'None')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Circuit details: Per-circuit configuration (columns in WoD sheet)
CREATE TABLE IF NOT EXISTS wod_deal_circuits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES wod_deals(id) ON DELETE CASCADE,
    
    circuit_number INTEGER NOT NULL,  -- 1-20 typically
    
    -- Configuration
    boxes_count INTEGER NOT NULL DEFAULT 0,
    infrastructure_ps INTEGER NOT NULL DEFAULT 0,  -- Parking spaces with infrastructure
    parking_type TEXT,  -- 'Indoor', 'Outdoor', 'Carport', 'Garage - Above ground', 'Garage - Below ground'
    
    -- Power configuration
    available_power_amps INTEGER,
    available_fuse_space BOOLEAN DEFAULT TRUE,
    required_min_power_kw DECIMAL(8, 4),
    required_min_fuse_amps INTEGER,
    
    -- Cable configuration
    cable_from_cabinet INTEGER,  -- Which cabinet
    cable_distance_first_box DECIMAL(8, 2),  -- meters
    additional_cable_meters DECIMAL(8, 2) DEFAULT 0,
    existing_cable BOOLEAN DEFAULT FALSE,
    existing_cable_dimension TEXT,
    
    -- Connectivity
    signal_coverage BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(deal_id, circuit_number)
);

-- Cost breakdown: Line-item costs for each deal
CREATE TABLE IF NOT EXISTS wod_deal_costs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES wod_deals(id) ON DELETE CASCADE,
    
    -- Cost item identification
    cost_category TEXT NOT NULL,  -- 'charger', 'backplate', 'cable', 'attachment', 'mounting', 'connectivity', 'labor_electrician', 'labor_digging', 'labor_other'
    item_name TEXT NOT NULL,
    
    -- Quantities and amounts
    quantity DECIMAL(10, 2) NOT NULL DEFAULT 0,
    unit TEXT,
    unit_cost DECIMAL(12, 2),
    total_cost DECIMAL(12, 2) NOT NULL,
    
    -- Labor breakdown (if applicable)
    labor_hours DECIMAL(8, 2),
    labor_cost DECIMAL(12, 2),
    
    -- Reference to catalog item
    catalog_item_id UUID REFERENCES wod_cost_catalog(id),
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Offers: Generated offer data for different offer types
CREATE TABLE IF NOT EXISTS wod_deal_offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES wod_deals(id) ON DELETE CASCADE,
    
    offer_type TEXT NOT NULL,  -- 'buy', 'rent', 'box'
    
    -- Offer content (structured extraction from Offert sheets)
    included_materials JSONB,  -- Array of {quantity, unit, description}
    included_work JSONB,  -- Array of {quantity, unit, description}
    
    -- Pricing
    one_time_cost DECIMAL(12, 2),
    one_time_cost_with_subsidy DECIMAL(12, 2),
    monthly_fee DECIMAL(10, 2),
    start_fee DECIMAL(10, 2),
    
    -- Subsidy info (Gron teknik)
    subsidy_eligible BOOLEAN DEFAULT FALSE,
    subsidy_percentage DECIMAL(5, 4),
    subsidy_amount DECIMAL(12, 2),
    
    -- Terms
    binding_period_months INTEGER,
    notice_period_months INTEGER,
    
    -- Raw offer text for embedding
    offer_text TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(deal_id, offer_type)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Cost catalog indexes
CREATE INDEX IF NOT EXISTS idx_wod_cost_catalog_category ON wod_cost_catalog(category);
CREATE INDEX IF NOT EXISTS idx_wod_cost_catalog_market ON wod_cost_catalog(market);
CREATE INDEX IF NOT EXISTS idx_wod_cost_catalog_version ON wod_cost_catalog(template_version);

-- Static config indexes
CREATE INDEX IF NOT EXISTS idx_wod_static_config_type ON wod_static_config(config_type);
CREATE INDEX IF NOT EXISTS idx_wod_static_config_market ON wod_static_config(market);

-- Deals indexes
CREATE INDEX IF NOT EXISTS idx_wod_deals_deal_name ON wod_deals(deal_name);
CREATE INDEX IF NOT EXISTS idx_wod_deals_geographic_area ON wod_deals(geographic_area);
CREATE INDEX IF NOT EXISTS idx_wod_deals_country ON wod_deals(country);
CREATE INDEX IF NOT EXISTS idx_wod_deals_charger_type ON wod_deals(charger_type);
CREATE INDEX IF NOT EXISTS idx_wod_deals_deal_date ON wod_deals(deal_date DESC);
CREATE INDEX IF NOT EXISTS idx_wod_deals_created_at ON wod_deals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wod_deals_source_path ON wod_deals(source_path);

-- Vector similarity search index for deals
CREATE INDEX IF NOT EXISTS idx_wod_deals_embedding ON wod_deals 
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Circuit indexes
CREATE INDEX IF NOT EXISTS idx_wod_deal_circuits_deal_id ON wod_deal_circuits(deal_id);

-- Cost indexes
CREATE INDEX IF NOT EXISTS idx_wod_deal_costs_deal_id ON wod_deal_costs(deal_id);
CREATE INDEX IF NOT EXISTS idx_wod_deal_costs_category ON wod_deal_costs(cost_category);

-- Offer indexes
CREATE INDEX IF NOT EXISTS idx_wod_deal_offers_deal_id ON wod_deal_offers(deal_id);
CREATE INDEX IF NOT EXISTS idx_wod_deal_offers_type ON wod_deal_offers(offer_type);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at for cost catalog
DROP TRIGGER IF EXISTS update_wod_cost_catalog_updated_at ON wod_cost_catalog;
CREATE TRIGGER update_wod_cost_catalog_updated_at
    BEFORE UPDATE ON wod_cost_catalog
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for static config
DROP TRIGGER IF EXISTS update_wod_static_config_updated_at ON wod_static_config;
CREATE TRIGGER update_wod_static_config_updated_at
    BEFORE UPDATE ON wod_static_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for deals
DROP TRIGGER IF EXISTS update_wod_deals_updated_at ON wod_deals;
CREATE TRIGGER update_wod_deals_updated_at
    BEFORE UPDATE ON wod_deals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE wod_cost_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE wod_static_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE wod_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE wod_deal_circuits ENABLE ROW LEVEL SECURITY;
ALTER TABLE wod_deal_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE wod_deal_offers ENABLE ROW LEVEL SECURITY;

-- Policies for service role (full access)
CREATE POLICY "Service role full access on wod_cost_catalog" ON wod_cost_catalog
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on wod_static_config" ON wod_static_config
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on wod_deals" ON wod_deals
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on wod_deal_circuits" ON wod_deal_circuits
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on wod_deal_costs" ON wod_deal_costs
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on wod_deal_offers" ON wod_deal_offers
    FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE wod_cost_catalog IS 'Master price list for WoD components - extracted from template Cost list sheet';
COMMENT ON TABLE wod_static_config IS 'Corporate assumptions and configuration options from WoD templates';
COMMENT ON TABLE wod_deals IS 'Customer-specific deal data from filled WoD Excel files';
COMMENT ON TABLE wod_deal_circuits IS 'Per-circuit configuration for each deal (up to 20 circuits per deal)';
COMMENT ON TABLE wod_deal_costs IS 'Detailed cost breakdown for each deal';
COMMENT ON TABLE wod_deal_offers IS 'Generated offer data (buy/rent/box options) for each deal';

COMMENT ON COLUMN wod_deals.embedding IS 'Vector embedding from text-embedding-3-small (1536 dimensions) for semantic search';
COMMENT ON COLUMN wod_deals.source_path IS 'Unique identifier for deduplication: wod://{market}/{deal-name}/{version}/{date}';
COMMENT ON COLUMN wod_deals.raw_inputs IS 'All input fields from WoD sheet stored as JSON for flexibility';
