-- Migration: Create search functions for WoD deals
-- These functions enable semantic search and context retrieval for LLM applications

-- ============================================================================
-- SEMANTIC SEARCH FUNCTION
-- ============================================================================

-- Search WoD deals by embedding similarity
CREATE OR REPLACE FUNCTION match_wod_deals(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.75,
    match_count INT DEFAULT 10,
    filter_country TEXT DEFAULT NULL,
    filter_charger_type TEXT DEFAULT NULL,
    filter_min_parking INT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    deal_name TEXT,
    geographic_area TEXT,
    country TEXT,
    total_parking_spaces INT,
    housing_units INT,
    charger_type TEXT,
    total_boxes INT,
    total_cost_excl_vat DECIMAL,
    deal_date DATE,
    creator_name TEXT,
    embedding_content TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.deal_name,
        d.geographic_area,
        d.country,
        d.total_parking_spaces,
        d.housing_units,
        d.charger_type,
        d.total_boxes,
        d.total_cost_excl_vat,
        d.deal_date,
        d.creator_name,
        d.embedding_content,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM wod_deals d
    WHERE 
        d.embedding IS NOT NULL
        AND (1 - (d.embedding <=> query_embedding)) > match_threshold
        AND (filter_country IS NULL OR d.country = filter_country)
        AND (filter_charger_type IS NULL OR d.charger_type = filter_charger_type)
        AND (filter_min_parking IS NULL OR d.total_parking_spaces >= filter_min_parking)
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ============================================================================
-- CONTEXT RETRIEVAL FUNCTIONS
-- ============================================================================

-- Get full deal context as JSON (for LLM consumption)
CREATE OR REPLACE FUNCTION get_wod_deal_context(deal_uuid UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'deal', jsonb_build_object(
            'id', d.id,
            'name', d.deal_name,
            'location', jsonb_build_object(
                'area', d.geographic_area,
                'country', d.country,
                'zone', d.zone
            ),
            'facility', jsonb_build_object(
                'total_parking_spaces', d.total_parking_spaces,
                'housing_units', d.housing_units,
                'guest_parking', d.guest_parking,
                'power_level', d.power_level,
                'digging_required', d.digging_required
            ),
            'installation', jsonb_build_object(
                'charger_type', d.charger_type,
                'total_boxes', d.total_boxes,
                'total_infrastructure_ps', d.total_infrastructure_ps,
                'signal_coverage_available', d.signal_coverage_available
            ),
            'economics', jsonb_build_object(
                'total_cost_excl_vat', d.total_cost_excl_vat,
                'total_material_cost', d.total_material_cost,
                'total_work_cost', d.total_work_cost,
                'gross_margin_buy', d.gross_margin_buy,
                'gross_margin_rent', d.gross_margin_rent,
                'markup_percentage', d.markup_percentage,
                'start_fee_incl_vat', d.start_fee_incl_vat,
                'admin_fee_incl_vat', d.admin_fee_incl_vat
            ),
            'metadata', jsonb_build_object(
                'creator', d.creator_name,
                'four_eyes', d.four_eyes_name,
                'deal_date', d.deal_date,
                'template_version', d.template_version,
                'source_path', d.source_path
            )
        ),
        'circuits', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'circuit_number', c.circuit_number,
                    'boxes_count', c.boxes_count,
                    'infrastructure_ps', c.infrastructure_ps,
                    'parking_type', c.parking_type,
                    'available_power_amps', c.available_power_amps,
                    'cable_distance_first_box', c.cable_distance_first_box,
                    'signal_coverage', c.signal_coverage
                )
                ORDER BY c.circuit_number
            ), '[]'::jsonb)
            FROM wod_deal_circuits c
            WHERE c.deal_id = d.id
        ),
        'costs_summary', (
            SELECT COALESCE(jsonb_object_agg(
                cost_category,
                jsonb_build_object(
                    'item_count', item_count,
                    'total_cost', total_cost
                )
            ), '{}'::jsonb)
            FROM (
                SELECT 
                    cost_category,
                    COUNT(*) as item_count,
                    SUM(total_cost) as total_cost
                FROM wod_deal_costs
                WHERE deal_id = d.id
                GROUP BY cost_category
            ) cost_summary
        ),
        'offers', (
            SELECT COALESCE(jsonb_agg(
                jsonb_build_object(
                    'type', o.offer_type,
                    'one_time_cost', o.one_time_cost,
                    'one_time_cost_with_subsidy', o.one_time_cost_with_subsidy,
                    'monthly_fee', o.monthly_fee,
                    'start_fee', o.start_fee,
                    'subsidy_eligible', o.subsidy_eligible
                )
            ), '[]'::jsonb)
            FROM wod_deal_offers o
            WHERE o.deal_id = d.id
        )
    ) INTO result
    FROM wod_deals d
    WHERE d.id = deal_uuid;
    
    RETURN result;
END;
$$;

-- Search cost catalog items
CREATE OR REPLACE FUNCTION search_wod_cost_catalog(
    search_term TEXT,
    filter_category TEXT DEFAULT NULL,
    filter_market TEXT DEFAULT NULL,
    result_limit INT DEFAULT 20
)
RETURNS TABLE (
    id UUID,
    component_name TEXT,
    category TEXT,
    supplier TEXT,
    unit_cost DECIMAL,
    unit TEXT,
    labor_cost DECIMAL,
    market TEXT,
    template_version TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.component_name,
        c.category,
        c.supplier,
        c.unit_cost,
        c.unit,
        c.labor_cost,
        c.market,
        c.template_version
    FROM wod_cost_catalog c
    WHERE 
        (search_term IS NULL OR c.component_name ILIKE '%' || search_term || '%')
        AND (filter_category IS NULL OR c.category = filter_category)
        AND (filter_market IS NULL OR c.market = filter_market)
    ORDER BY c.component_name
    LIMIT result_limit;
END;
$$;

-- Get static configuration by type
CREATE OR REPLACE FUNCTION get_wod_static_config(
    config_type_filter TEXT,
    market_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
    config_key TEXT,
    config_value JSONB,
    market TEXT,
    template_version TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.config_key,
        c.config_value,
        c.market,
        c.template_version
    FROM wod_static_config c
    WHERE 
        c.config_type = config_type_filter
        AND (market_filter IS NULL OR c.market = market_filter)
    ORDER BY c.config_key;
END;
$$;

-- ============================================================================
-- AGGREGATION FUNCTIONS FOR ANALYTICS
-- ============================================================================

-- Get deal statistics by market
CREATE OR REPLACE FUNCTION get_wod_deal_stats(
    market_filter TEXT DEFAULT NULL,
    date_from DATE DEFAULT NULL,
    date_to DATE DEFAULT NULL
)
RETURNS TABLE (
    market TEXT,
    total_deals BIGINT,
    total_boxes BIGINT,
    total_parking_spaces BIGINT,
    avg_cost_per_deal DECIMAL,
    avg_boxes_per_deal DECIMAL,
    charger_type_breakdown JSONB
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.country as market,
        COUNT(*)::BIGINT as total_deals,
        COALESCE(SUM(d.total_boxes), 0)::BIGINT as total_boxes,
        COALESCE(SUM(d.total_parking_spaces), 0)::BIGINT as total_parking_spaces,
        ROUND(AVG(d.total_cost_excl_vat), 2) as avg_cost_per_deal,
        ROUND(AVG(d.total_boxes), 2) as avg_boxes_per_deal,
        (
            SELECT jsonb_object_agg(charger_type, count)
            FROM (
                SELECT charger_type, COUNT(*) as count
                FROM wod_deals d2
                WHERE d2.country = d.country
                    AND d2.charger_type IS NOT NULL
                    AND (market_filter IS NULL OR d2.country = market_filter)
                    AND (date_from IS NULL OR d2.deal_date >= date_from)
                    AND (date_to IS NULL OR d2.deal_date <= date_to)
                GROUP BY charger_type
            ) sub
        ) as charger_type_breakdown
    FROM wod_deals d
    WHERE 
        (market_filter IS NULL OR d.country = market_filter)
        AND (date_from IS NULL OR d.deal_date >= date_from)
        AND (date_to IS NULL OR d.deal_date <= date_to)
    GROUP BY d.country
    ORDER BY total_deals DESC;
END;
$$;

-- Find similar deals by characteristics (not embedding)
CREATE OR REPLACE FUNCTION find_similar_wod_deals(
    target_parking_spaces INT,
    target_boxes INT,
    target_country TEXT DEFAULT NULL,
    tolerance_percent FLOAT DEFAULT 0.2,
    result_limit INT DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    deal_name TEXT,
    geographic_area TEXT,
    country TEXT,
    total_parking_spaces INT,
    total_boxes INT,
    charger_type TEXT,
    total_cost_excl_vat DECIMAL,
    deal_date DATE,
    similarity_score FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    parking_tolerance INT;
    boxes_tolerance INT;
BEGIN
    parking_tolerance := GREATEST(1, (target_parking_spaces * tolerance_percent)::INT);
    boxes_tolerance := GREATEST(1, (target_boxes * tolerance_percent)::INT);
    
    RETURN QUERY
    SELECT
        d.id,
        d.deal_name,
        d.geographic_area,
        d.country,
        d.total_parking_spaces,
        d.total_boxes,
        d.charger_type,
        d.total_cost_excl_vat,
        d.deal_date,
        -- Calculate similarity based on parking and boxes match
        (1.0 - (
            ABS(d.total_parking_spaces - target_parking_spaces)::FLOAT / NULLIF(target_parking_spaces, 0) +
            ABS(d.total_boxes - target_boxes)::FLOAT / NULLIF(target_boxes, 0)
        ) / 2.0)::FLOAT as similarity_score
    FROM wod_deals d
    WHERE 
        d.total_parking_spaces BETWEEN (target_parking_spaces - parking_tolerance) 
            AND (target_parking_spaces + parking_tolerance)
        AND d.total_boxes BETWEEN (target_boxes - boxes_tolerance) 
            AND (target_boxes + boxes_tolerance)
        AND (target_country IS NULL OR d.country = target_country)
    ORDER BY similarity_score DESC, d.deal_date DESC
    LIMIT result_limit;
END;
$$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON FUNCTION match_wod_deals IS 'Semantic search over WoD deals using vector embedding similarity';
COMMENT ON FUNCTION get_wod_deal_context IS 'Get complete deal context as JSON for LLM consumption';
COMMENT ON FUNCTION search_wod_cost_catalog IS 'Search cost catalog by component name with filters';
COMMENT ON FUNCTION get_wod_static_config IS 'Get static configuration values by type';
COMMENT ON FUNCTION get_wod_deal_stats IS 'Get aggregated deal statistics by market';
COMMENT ON FUNCTION find_similar_wod_deals IS 'Find deals with similar characteristics (parking spaces, boxes)';
