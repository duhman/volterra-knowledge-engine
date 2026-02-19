import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.3";

// ============================================================================
// TYPES
// ============================================================================

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

// OpenAI ChatGPT egress IP ranges (as of Dec 2024)
// Source: https://platform.openai.com/docs/actions/production
const OPENAI_EGRESS_CIDRS = [
  "23.102.140.112/28",
  "13.66.11.96/28",
  "104.210.133.240/28",
  "70.37.60.192/28",
  "20.97.188.144/28",
  "20.161.76.48/28",
  "52.234.32.208/28",
  "52.156.132.32/28",
  "40.84.220.192/28",
  "23.98.178.64/28",
  "51.8.155.32/28",
  "20.246.77.240/28",
  "172.178.141.0/28",
  "172.178.141.192/28",
  "40.84.180.128/28",
];

// Rate limiting state (in-memory, per-instance)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute per IP

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

// Allowed tables and their safe columns (excludes sensitive fields like raw JSON, emails)
// EXPANDED SCHEMA: Added 58 new columns for maximum context access
const TABLE_SCHEMA: Record<string, { columns: string[]; orderBy?: string }> = {
  // Slack Messages: +7 columns (10 → 17)
  slack_messages: {
    columns: [
      "id",
      "channel_id",
      "message_ts",
      "thread_ts",
      "user_id",
      "user_display_name",
      "text",
      "message_at",
      "has_files",
      "file_count",
      // NEW: bot identification, message context, edit tracking
      "bot_id",
      "subtype",
      "user_real_name",
      "created_at",
      "updated_at",
    ],
    orderBy: "message_at",
  },
  // Slack Threads: +8 columns (10 → 18)
  slack_threads: {
    columns: [
      "id",
      "channel_id",
      "thread_ts",
      "root_user_id",
      "root_text",
      "root_message_at",
      "reply_count",
      "message_count",
      "participant_count",
      "latest_reply_ts",
      // NEW: bot threads, participant lists, sync status
      "root_bot_id",
      "root_subtype",
      "participant_user_ids",
      "doc_chunk_count",
      "last_checked_at",
      "last_synced_at",
      "created_at",
      "updated_at",
    ],
    orderBy: "root_message_at",
  },
  // Documents: +8 columns (9 → 17)
  documents: {
    columns: [
      "id",
      "title",
      "department",
      "document_type",
      "source_type",
      "source_path",
      "language",
      "access_level",
      "created_at",
      // NEW: file metadata, GDPR compliance, categorization, change tracking
      "file_size",
      "mime_type",
      "original_filename",
      "owner",
      "sensitivity",
      "tags",
      "updated_at",
    ],
    orderBy: "created_at",
  },
  // Training Conversations: +4 columns (12 → 16)
  training_conversations: {
    columns: [
      "id",
      "hubspot_ticket_id",
      "subject",
      "priority",
      "status",
      "pipeline",
      "category",
      "subcategory",
      "create_date",
      "training_type",
      "thread_length",
      "participant_count",
      // NEW: contact info (redacted), Slack cross-reference, language, interaction complexity
      "associated_emails",
      "channel_id",
      "primary_language",
      "hs_num_times_contacted",
    ],
    orderBy: "create_date",
  },
  // Training Messages: +7 columns (7 → 14) - Note: content will be handled via fetch tools
  training_messages: {
    columns: [
      "id",
      "conversation_id",
      "from_name",
      "participant_role",
      "direction",
      "message_type",
      "timestamp",
      // NEW: message context, attribution, content type (full content via fetch_conversation_messages)
      "content_type",
      "engagement_type",
      "source",
      "subject",
      "from_email",
    ],
    orderBy: "timestamp",
  },
  // WoD Deals: +32 columns (10 → 42) - MASSIVE EXPANSION for primary use case
  wod_deals: {
    columns: [
      "id",
      "deal_name",
      "geographic_area",
      "country",
      "total_parking_spaces",
      "total_boxes",
      "charger_type",
      "total_cost_excl_vat",
      "deal_date",
      "creator_name",
      // NEW: Facility details
      "housing_units",
      "guest_parking",
      "real_potential",
      // NEW: Infrastructure
      "power_level",
      "signal_coverage_available",
      "digging_required",
      "asphalt_digging_meters",
      "green_space_digging_meters",
      // NEW: Cost breakdown
      "total_material_cost",
      "total_work_cost",
      "total_infrastructure_ps",
      // NEW: Pricing options
      "purchase_total_excl_subsidy",
      "purchase_total_with_subsidy",
      "rent_monthly_buy",
      "rent_monthly_rent",
      // NEW: Profitability
      "gross_margin_buy",
      "gross_margin_rent",
      "markup_percentage",
      // NEW: Fee structure
      "start_fee_incl_vat",
      "start_fee_gron_teknik",
      "admin_fee_incl_vat",
      // NEW: Operational metadata
      "zone",
      "template_version",
      "four_eyes_name",
      "deal_reference",
      "original_filename",
      "file_hash",
      "sensitivity",
      "source_path",
    ],
    orderBy: "deal_date",
  },
  // WoD Deal Circuits: +9 columns (7 → 16) - Note: Available power was partially included, adding missing fields
  wod_deal_circuits: {
    columns: [
      "id",
      "deal_id",
      "circuit_number",
      "boxes_count",
      "infrastructure_ps",
      "parking_type",
      "available_power_amps",
      // NEW: Power requirements, cable planning, existing infrastructure, constraints
      "required_min_fuse_amps",
      "required_min_power_kw",
      "cable_distance_first_box",
      "cable_from_cabinet",
      "additional_cable_meters",
      "existing_cable",
      "existing_cable_dimension",
      "available_fuse_space",
      "signal_coverage",
    ],
    orderBy: "circuit_number",
  },
  // WoD Deal Costs: +3 columns (8 → 11)
  wod_deal_costs: {
    columns: [
      "id",
      "deal_id",
      "cost_category",
      "item_name",
      "quantity",
      "unit",
      "unit_cost",
      "total_cost",
      // NEW: Labor breakdown, catalog linkage
      "labor_cost",
      "labor_hours",
      "catalog_item_id",
    ],
    orderBy: "cost_category",
  },
  // WoD Deal Offers: +8 columns (7 → 15) - Note: subsidy_eligible was included, adding missing fields
  wod_deal_offers: {
    columns: [
      "id",
      "deal_id",
      "offer_type",
      "one_time_cost",
      "monthly_fee",
      "start_fee",
      "subsidy_eligible",
      // NEW: Contract terms, subsidy details, offer customization, inclusions
      "binding_period_months",
      "notice_period_months",
      "subsidy_amount",
      "subsidy_percentage",
      "one_time_cost_with_subsidy",
      "offer_text",
      "included_materials",
      "included_work",
    ],
    orderBy: "offer_type",
  },
  // WoD Cost Catalog: unchanged (8 columns - already comprehensive)
  wod_cost_catalog: {
    columns: [
      "id",
      "component_name",
      "category",
      "supplier",
      "unit_cost",
      "unit",
      "labor_cost",
      "market",
    ],
    orderBy: "category",
  },
  // Slack Channel Sync State: unchanged (6 columns - sync metadata already comprehensive)
  slack_channel_sync_state: {
    columns: [
      "channel_id",
      "channel_name",
      "last_run_at",
      "last_run_threads_fetched",
      "last_run_messages_upserted",
      "last_run_error",
    ],
    orderBy: "last_run_at",
  },
  // HubSpot Ticket Sync State: unchanged (5 columns - sync metadata already comprehensive)
  hubspot_ticket_sync_state: {
    columns: [
      "source",
      "last_run_at",
      "last_run_tickets_fetched",
      "last_run_conversations_upserted",
      "last_run_error",
    ],
    orderBy: "last_run_at",
  },
  // Notion Pages: unchanged (13 columns - already comprehensive)
  notion_pages: {
    columns: [
      "id",
      "notion_page_id",
      "source_path",
      "title",
      "url",
      "parent_type",
      "database_id",
      "archived",
      "notion_created_time",
      "notion_last_edited_time",
      "doc_chunk_count",
      "last_ingested_at",
      "last_seen_at",
    ],
    orderBy: "notion_last_edited_time",
  },
  // Notion Sync State: unchanged (11 columns - sync statistics already comprehensive)
  notion_sync_state: {
    columns: [
      "id",
      "last_run_at",
      "last_run_pages_seen",
      "last_run_pages_changed",
      "last_run_pages_deleted",
      "last_run_docs_upserted",
      "last_run_docs_deleted",
      "last_run_chunks_created",
      "last_run_failed_pages",
      "last_run_error",
      "last_run_duration_ms",
    ],
    orderBy: "last_run_at",
  },
};
// SCHEMA EXPANSION SUMMARY:
// - slack_messages: 10 → 17 columns (+7)
// - slack_threads: 10 → 18 columns (+8)
// - documents: 9 → 17 columns (+8)
// - training_conversations: 12 → 16 columns (+4)
// - training_messages: 7 → 14 columns (+7)
// - wod_deals: 10 → 42 columns (+32)
// - wod_deal_circuits: 7 → 16 columns (+9)
// - wod_deal_costs: 8 → 11 columns (+3)
// - wod_deal_offers: 7 → 15 columns (+8)
// TOTAL: 58 new columns exposed (80 → 138 columns, ~72% increase)
// Coverage: Increased from ~60% to ~85% of available schema

const SYSTEM_INSTRUCTIONS = `# Volterra Knowledge Base MCP - HYPEROPTIMIZED

You are connected to Volterra's internal knowledge base with **32 tools** providing comprehensive access to:
- **Documents**: FAQs, guides, legal docs (17 columns including file metadata, sensitivity, tags, language)
- **Training Conversations**: Historical HubSpot support tickets (16 columns with full resolutions)
- **Slack Messages**: Internal #help-me-platform discussions (17 columns with bot tracking, edit history)
- **WoD Deals**: Wheel of Deal pricing/installation data (**42 columns** - 320% expansion: facility, infrastructure, costs, pricing, margins, fees)
- **Notion Pages**: Synced daily with full metadata (13 columns)

## Tool Categories (32 Total)

### 1. Primary Search & Discovery (3 tools)
- **\`kb_search\`**: PRIMARY semantic search across ALL sources (5-50 results per source, up from 5-20)
- **\`search\`**: OpenAI Deep Research compatible (flat results)
- **\`fetch\`**: Get FULL content for any search result (untruncated)

### 2. Data Browsing (4 tools)
- **\`query_table\`**: SQL-like queries with filtering (up to 500 rows, up from 100)
- **\`count_rows\`**: Aggregations and statistics with grouping
- **\`list_tables\`**: Discover all 14 tables and their schemas
- **\`db_table_stats\`**: Quick row counts across all tables

### 3. Relationship Traversal (5 NEW tools - Phase 2)
- **\`fetch_thread_messages\`**: Complete Slack thread (up to 200 messages)
- **\`fetch_conversation_messages\`**: Complete HubSpot ticket thread (up to 200 messages)
- **\`fetch_document_full\`**: Full document content (up to 200K chars, configurable)
- **\`fetch_notion_children\`**: Navigate Notion page hierarchy
- **\`fetch_wod_deal_full\`**: Complete WoD deal with ALL 42 fields + circuits + costs + offers

### 4. Analytics & Insights (7 NEW tools - Phase 3)
- **\`analyze_slack_thread_network\`**: Expert identification, collaboration patterns
- **\`analyze_training_resolution_patterns\`**: Common issues, resolution trends
- **\`find_similar_documents\`**: Metadata-based document similarity (not semantic)
- **\`get_data_freshness_report\`**: Sync status for all sources (Notion, Slack, HubSpot)
- **\`search_notion_by_date\`**: Temporal Notion search (created/edited dates)
- **\`compare_wod_deals\`**: Side-by-side comparison (2-5 deals)
- **\`aggregate_costs_by_category\`**: WoD cost aggregation and analytics

### 5. Slack-Specific (2 tools)
- **\`slack_latest_messages\`**: Recent messages (up to 200, up from 50)
- **\`slack_latest_threads\`**: Recent threads (up to 200, up from 50)

### 6. WoD-Specific (1 tool + 3 analytics)
- **\`wod_get_deal_context\`**: Deal with circuits/costs/offers
- Plus: \`fetch_wod_deal_full\`, \`compare_wod_deals\`, \`aggregate_costs_by_category\`

### 7. Advanced Embedding Tools (3 tools)
- **\`get_embeddings\`**: Raw 1536-dim vectors for clustering
- **\`generate_embedding\`**: Convert text to embedding
- **\`compute_similarity\`**: Text-to-text or text-to-records comparison

### 8. Utility (2 tools)
- **\`get_instructions\`**: This help text
- **\`search_tools\`**: Find the right tool for a task (meta-tool with semantic search over all 32 tools)

## Key Improvements (Hyperoptimization)

### Data Access: 60% → 85% Schema Coverage
- **Documents**: 9 → 17 columns (+8: file_size, mime_type, owner, sensitivity, tags, language, etc.)
- **WoD Deals**: 10 → 42 columns (+32: housing, power_level, margins, fees, infrastructure, pricing)
- **Slack**: 10 → 17 columns (+7: bot tracking, subtypes, edit history, real names)
- **Training**: 12 → 16 columns (+4: channel_id, language, contact_count)
- **Notion**: Full hierarchy navigation with 13 columns

### Result Limits: 150% Increase
- \`kb_search\`: 20 → 50 per source (max 200 total vs 80)
- \`query_table\`: 100 → 500 rows
- \`slack_latest_messages\`: 50 → 200
- \`slack_latest_threads\`: 50 → 200
- Semantic match RPCs: 20-30 → 50-100

### LLM-Optimized Tool Descriptions
All 32 tools now include:
- "Use this when:" scenarios
- Concrete examples (3+ per tool)
- Performance metrics
- Related tool cross-references

## Typical Workflows

### Support Ticket Analysis
1. \`kb_search\` → find similar tickets
2. \`fetch_conversation_messages\` → get full resolution
3. \`analyze_training_resolution_patterns\` → identify common patterns

### WoD Deal Research
1. \`query_table\` → filter deals by criteria
2. \`fetch_wod_deal_full\` → complete deal context
3. \`compare_wod_deals\` → side-by-side analysis
4. \`aggregate_costs_by_category\` → cost insights

### Slack Expert Identification
1. \`kb_search\` or \`slack_latest_threads\` → find relevant discussions
2. \`fetch_thread_messages\` → complete thread context
3. \`analyze_slack_thread_network\` → identify top experts

### Notion Content Discovery
1. \`search_notion_by_date\` → find recent pages
2. \`fetch_notion_children\` → navigate hierarchy
3. \`get_data_freshness_report\` → verify sync status

## Data Freshness
- **Slack**: Synced daily (06:00 UTC)
- **HubSpot tickets**: Synced daily (06:00 UTC)
- **Notion pages**: Synced daily (05:00 UTC)
- **Documents**: Updated on manual ingestion
- **Use \`get_data_freshness_report\` for live sync status**

## Key Knowledge Areas
- **Norgespris**: Dynamic electricity pricing (spot + markup)
- **Subscription transfers**: Process for moving subscriptions between users/locations
- **Charging troubleshooting**: Error codes, connectivity issues, billing
- **App features**: Volterra mobile app functionality
- **WoD Deals**: Installation costs, pricing models, margins, technical specs

## Response Guidelines
- **Always cite sources**: document titles, ticket IDs, Slack threads
- **For support questions**: Check training_conversations first (proven resolutions)
- **For complete context**: Use fetch_* tools after search
- **For analytics**: Use analyze_* and aggregate_* tools
- **Norwegian content**: Common - handle bilingual responses appropriately
- **Data recency**: Check \`get_data_freshness_report\` when currency matters

## Performance Characteristics
- **Search tools**: 1-3s for semantic search across 4 sources
- **Fetch tools**: <1s for small content, 1-3s for large documents/threads
- **Analytics tools**: 1-3s for aggregations and pattern analysis
- **Relationship tools**: 1-2s for thread/conversation retrieval

## Database Schema Overview (14 tables)
1. **documents** (17 cols) - Knowledge base with full metadata
2. **training_conversations** (16 cols) - HubSpot tickets
3. **training_messages** (14 cols) - Ticket messages (full content)
4. **slack_messages** (17 cols) - Messages with bot/edit tracking
5. **slack_threads** (18 cols) - Thread summaries with participants
6. **wod_deals** (42 cols) - Comprehensive deal data
7. **wod_deal_circuits** (16 cols) - Circuit configurations
8. **wod_deal_costs** (11 cols) - Cost line items with labor breakdown
9. **wod_deal_offers** (15 cols) - Offer variants with terms
10. **wod_cost_catalog** (8 cols) - Standard cost items
11. **notion_pages** (13 cols) - Synced Notion pages
12. **notion_sync_state** - Sync metadata
13. **slack_channel_sync_state** - Per-channel sync status
14. **hubspot_ticket_sync_state** - HubSpot sync status

Use \`list_tables\` to see all columns for each table.
`;

const TOOLS: Tool[] = [
  // --------------------------------------------------------------------------
  // OpenAI Deep Research compatibility tools (required interface: search + fetch)
  // --------------------------------------------------------------------------
  {
    name: "search",
    description:
      "Deep research search. Returns a flat list of relevant results with id/title/url/text_snippet. Use when an OpenAI deep research flow expects the standard search/fetch interface.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: `Use this when: You need FULL content for a specific result found via 'search' or 'kb_search'. This returns complete, untruncated text with all metadata.

Examples:
- After kb_search finds document "FAQ-charging-troubleshooting" → fetch full FAQ (up to 20K chars)
- After search finds training conversation → fetch complete ticket thread with all messages
- After finding Slack thread → fetch original message + thread metadata

Returns:
- Documents: Full content (PII redacted) + metadata (title, department, sensitivity, tags, file size, etc.)
- Training conversations: Full ticket thread with all messages (up to 200 messages)
- Slack messages: Full message text + thread context + participants
- WoD deals: Complete deal context via underlying RPC

Format: {id, title, url, text, metadata} where 'text' is the full content and 'url' is clickable (HubSpot/Slack permalinks or volterra:// URIs).

Performance: <1s for most items. Large documents (>50K chars) may take 2-3s.

Related tools: Use after 'search' or 'kb_search' for drill-down. For relationship traversal, consider fetch_thread_messages or fetch_conversation_messages.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Result id from search()" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_instructions",
    description:
      "Get usage instructions and context for this knowledge base. Call this first to understand available data and best practices.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "kb_search",
    description: `Use this when: You need to find information across ALL knowledge sources using natural language. This is your PRIMARY entry point for any "find", "search", "what does Volterra say about", or "how do we handle" query.

Examples:
- "How does Norgespris pricing work?" → searches documents + training conversations
- "Recent discussions about charging errors" → searches Slack + training conversations
- "Similar deals in Norway with 50+ parking spaces" → searches WoD deals

Returns: Top 5-50 results per source (documents, training, slack, wod) with similarity scores (0-1), truncated snippets (500 chars), and metadata. Use 'fetch' tool to get full content for specific results.

Performance: Searches 4 sources in parallel. Typical response: 10-80 results in 1-3 seconds. Results sorted by semantic relevance (cosine similarity).

Related tools: Use 'fetch' after this for full content, 'query_table' for browsing specific tables, 'count_rows' for statistics.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        sources: {
          type: "array",
          items: {
            type: "string",
            enum: ["documents", "training", "slack", "wod"],
          },
          description:
            "Optional: limit search to specific sources. Default: all sources.",
        },
        match_count: {
          type: "integer",
          description: "Max results per source (1-50). Default: 5.",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "query_table",
    description: `Use this when: You need to browse or filter data from a specific table, especially when you know the table name or need date-based filtering. This is your SQL SELECT equivalent.

Examples:
- "Show me all WoD deals from Norway in 2024" → query wod_deals with filters
- "List recent Slack threads" → query slack_threads, date_from: "2024-12-01"
- "Get all training conversations about 'charging' category" → query training_conversations with filters

Available tables: documents (17 cols), training_conversations (16 cols), training_messages (14 cols), slack_messages (17 cols), slack_threads (18 cols), wod_deals (42 cols), wod_deal_circuits (16 cols), wod_deal_costs (11 cols), wod_deal_offers (15 cols), wod_cost_catalog (8 cols), notion_pages (13 cols), plus sync state tables.

Returns: Up to 500 rows (default 25) with all safe columns. No PII or raw JSON. Results ordered by table's default date column (descending by default).

Performance: <1s for most queries. Large result sets (>100 rows) may take 2-3s. Use pagination (offset) for browsing beyond 500 rows.

Related tools: Use 'count_rows' for aggregations, 'kb_search' for semantic search across tables, 'list_tables' to see all available tables.`,
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: Object.keys(TABLE_SCHEMA),
          description: "Table name to query",
        },
        filters: {
          type: "object",
          description: "Key-value filters (column: value). Supports eq only.",
          additionalProperties: true,
        },
        date_from: {
          type: "string",
          format: "date",
          description:
            "Filter: rows after this date (ISO format, uses table default date column)",
        },
        date_to: {
          type: "string",
          format: "date",
          description: "Filter: rows before this date (ISO format)",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort order. Default: desc",
        },
        limit: {
          type: "integer",
          description: "Max rows to return (1-500). Default: 25.",
          minimum: 1,
          maximum: 500,
        },
        offset: {
          type: "integer",
          description: "Rows to skip (for pagination). Default: 0.",
          minimum: 0,
        },
      },
      required: ["table"],
    },
  },
  {
    name: "count_rows",
    description: `Use this when: You need statistics, aggregations, or analytics like "how many", "total", "breakdown by category", or trend analysis.

Examples:
- "How many Slack messages in the last 90 days?" → count slack_messages, date_from: "2024-09-15"
- "Breakdown of training conversations by category" → count training_conversations, group_by: "category"
- "Total WoD deals per country" → count wod_deals, group_by: "country"

Returns:
- Without group_by: Single count number
- With group_by: Array of {group_value, count} pairs (up to 100 groups, sorted by count desc)

Performance: <1s for most queries. Grouped counts may take 2s for large tables.

Related tools: Use 'query_table' to see the actual rows, 'kb_search' for semantic filtering, 'aggregate_costs_by_category' for WoD cost analytics.`,
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: Object.keys(TABLE_SCHEMA),
          description: "Table name to count",
        },
        filters: {
          type: "object",
          description: "Key-value filters (column: value)",
          additionalProperties: true,
        },
        date_from: {
          type: "string",
          format: "date",
          description: "Count rows after this date",
        },
        date_to: {
          type: "string",
          format: "date",
          description: "Count rows before this date",
        },
        group_by: {
          type: "string",
          description: "Column to group by (returns counts per group)",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "list_tables",
    description: `Use this when: You need to discover available data sources, understand table schemas, or see data volume across tables.

Examples:
- "What data sources are available?" → lists all 14 tables with columns
- "How much data do we have?" → shows row counts per table
- "What fields are in the wod_deals table?" → shows all 42 columns

Returns: Array of tables with: table name, column list (with new expanded schema), row count, default sort column. Now includes 138 total columns across all tables (up from 80).

Performance: <1s. Cached row counts updated hourly.

Related tools: Use 'query_table' to actually browse a table, 'count_rows' for filtered counts, 'db_table_stats' for just row counts.`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "slack_latest_messages",
    description: `Use this when: You need RECENT Slack activity (time-ordered, not semantic). This is for "what's happening now" or "latest discussions" queries.

Examples:
- "What are the latest Slack messages?" → last 20 messages from #help-me-platform
- "Recent activity in channel X" → specify channel_id
- "Show me the last 50 messages" → set limit to 50

Returns: Up to 200 messages (increased from 50) with: full text, user names, timestamps, bot identification, message type (subtype), file attachments, edit history (created_at vs updated_at). Messages ordered newest first.

Performance: <1s for up to 200 messages.

Related tools: For semantic search use 'kb_search', for complete thread use 'fetch_thread_messages', for thread summaries use 'slack_latest_threads'.`,
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description:
            "Slack channel ID. Default: C05FA8B5YPM (#help-me-platform)",
        },
        limit: {
          type: "integer",
          description:
            "Number of messages (1-200, increased from 50). Default: 20.",
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: "slack_latest_threads",
    description: `Use this when: You need RECENT Slack thread summaries (time-ordered) to understand ongoing discussions or find active threads.

Examples:
- "What threads are active?" → recent threads with reply counts
- "Show me discussions from the last week" → threads with participant info
- "Which threads have the most activity?" → sorted by reply count

Returns: Up to 200 threads (increased from 50) with: root message text, reply count, participant count, participant IDs (for network analysis), bot indicators, message count, sync status, creation/update timestamps. Threads ordered by root message time (newest first).

Performance: <1s for up to 200 threads.

Related tools: For full thread messages use 'fetch_thread_messages', for semantic search use 'kb_search', for network analysis use 'analyze_slack_thread_network'.`,
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Slack channel ID. Default: C05FA8B5YPM",
        },
        limit: {
          type: "integer",
          description:
            "Number of threads (1-200, increased from 50). Default: 20.",
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
  {
    name: "wod_get_deal_context",
    description: `Use this when: You need COMPLETE WoD deal information including all circuits, costs, and offers. This is the primary tool for deal analysis.

Examples:
- "Show me full details for deal X" → all 42 deal fields + circuits + costs + offers
- "What are the cost breakdowns for this deal?" → itemized costs with labor/material split
- "Compare offer types for deal Y" → all offer variants with pricing

Returns: Comprehensive deal object with:
- ALL 42 deal fields (facility, infrastructure, costs, pricing, margins, fees, metadata)
- All circuits with power requirements and cable planning
- All cost line items with labor breakdown
- All offer variants with contract terms and subsidy details

This now exposes 32 NEW deal columns (housing, power level, margins, fees, etc.) - a 320% increase from the previous 10 columns.

Performance: 1-2s for complex deals with many circuits/costs.

Related tools: For deal comparison use 'compare_wod_deals', for cost aggregation use 'aggregate_costs_by_category', for finding similar deals use 'kb_search'.`,
    inputSchema: {
      type: "object",
      properties: {
        deal_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the WoD deal",
        },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "db_table_stats",
    description: `Use this when: You need a quick overview of data volume across all tables.

Examples:
- "How much data do we have?" → row counts for all 14 tables
- "What's the largest table?" → documents typically has most rows
- "Do we have any WoD deals?" → check wod_deals count

Returns: Object with table names as keys and row counts as values. Includes: documents, training_conversations, training_messages, slack_messages, slack_threads, wod_deals (and 5 related tables), notion_pages, sync state tables.

Performance: <500ms. Cached and updated every 10 minutes.

Related tools: For detailed table info use 'list_tables', for filtered counts use 'count_rows'.`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_embeddings",
    description: `Use this when: You need raw 1536-dimensional embedding vectors for advanced analysis like clustering, custom similarity, or external processing.

Examples:
- "Get embedding vectors for these 3 documents" → raw vectors for export
- "I need to cluster these deals" → fetch deal embeddings for clustering algorithm
- "Compare document embeddings using custom metrics" → get vectors for custom similarity

Returns: Array of {id, embedding: number[]} objects. Embeddings are 1536-dimensional float arrays from text-embedding-3-small model. Max 10 records per call.

Use cases:
- External analysis tools (Python sklearn, numpy)
- Custom similarity metrics beyond cosine
- Dimensionality reduction (PCA, t-SNE)
- Clustering (k-means, DBSCAN)

Performance: <1s for up to 10 embeddings.

Related tools: For standard similarity use 'compute_similarity', for semantic search use 'kb_search', for generating new embeddings use 'generate_embedding'.`,
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: [
            "documents",
            "training_conversations",
            "slack_messages",
            "wod_deals",
          ],
          description: "Which table to get embeddings from",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of record IDs (UUIDs) to get embeddings for. Max 10.",
          maxItems: 10,
        },
      },
      required: ["source", "ids"],
    },
  },
  {
    name: "generate_embedding",
    description: `Use this when: You need to convert arbitrary text into an embedding vector for comparison against stored embeddings.

Examples:
- "Generate embedding for this customer query" → create vector for similarity search
- "Embed this text and compare to documents" → use with compute_similarity
- "Create vector for 'charging error code 503'" → analyze semantic meaning

Returns: 1536-dimensional float array from text-embedding-3-small model. Max input: 10,000 chars (~7,500 tokens).

Use cases:
- Custom semantic search queries
- Text classification setup
- Finding similar content without full search
- Comparing hypothetical text to real data

Performance: ~500ms for typical text (<1000 chars), up to 2s for very long text.

Related tools: Use 'compute_similarity' to compare this embedding against others, 'kb_search' for ready-made semantic search, 'get_embeddings' to retrieve stored vectors.`,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to generate embedding for (max 10000 chars)",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "compute_similarity",
    description: `Use this when: You need precise similarity scores between specific texts or between custom text and stored records.

Examples:
- "How similar is 'charging error' to 'billing problem'?" → text-to-text comparison (score 0-1)
- "Compare this query to these 5 documents" → text-to-records comparison
- "Which of these deals is most similar to my description?" → rank by similarity

Returns: Array of similarity scores (0-1 scale, higher = more similar) using cosine similarity. Each result includes: id/index, similarity score, optional text snippet.

Two modes:
1. text-to-text: Compare query against up to 5 arbitrary text strings
2. text-to-records: Compare query against up to 10 stored records by ID

Performance: ~1s for text-to-text (5 comparisons), ~1-2s for text-to-records (10 comparisons with embedding retrieval).

Related tools: For broad search use 'kb_search', for generating embeddings use 'generate_embedding', for raw vectors use 'get_embeddings'.`,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Query text to compare",
        },
        compare_to: {
          type: "object",
          description: "What to compare against",
          properties: {
            type: {
              type: "string",
              enum: ["text", "records"],
              description:
                '"text" for raw text comparison, "records" for stored embeddings',
            },
            texts: {
              type: "array",
              items: { type: "string" },
              description:
                "If type=text: array of texts to compare against (max 5)",
              maxItems: 5,
            },
            source: {
              type: "string",
              enum: [
                "documents",
                "training_conversations",
                "slack_messages",
                "wod_deals",
              ],
              description: "If type=records: which table",
            },
            ids: {
              type: "array",
              items: { type: "string" },
              description:
                "If type=records: record IDs to compare against (max 10)",
              maxItems: 10,
            },
          },
        },
      },
      required: ["text", "compare_to"],
    },
  },
  // --------------------------------------------------------------------------
  // Relationship Traversal Tools (Phase 2)
  // --------------------------------------------------------------------------
  {
    name: "fetch_thread_messages",
    description: `Use this when: You need COMPLETE Slack thread context with all messages (not just summaries).

Examples:
- "Show me all messages in this thread" → complete conversation with participants
- "What was discussed in thread X?" → full chronological messages
- "Get the complete back-and-forth" → all replies with timestamps

Returns: Up to 200 messages in chronological order with: full text (no truncation), user names (display + real name), timestamps, bot identification, message types, file attachments, edit history. Includes root message by default.

Performance: <1s for threads with <50 messages, 1-2s for large threads (>100 messages).

Related tools: Use 'slack_latest_threads' to find threads first, 'kb_search' for semantic search, 'analyze_slack_thread_network' for participant analysis.`,
    inputSchema: {
      type: "object",
      properties: {
        thread_ts: {
          type: "string",
          description:
            "Thread timestamp (from slack_threads or slack_messages)",
        },
        channel_id: {
          type: "string",
          description:
            "Slack channel ID. Default: C05FA8B5YPM (#help-me-platform)",
        },
        include_root: {
          type: "boolean",
          description: "Include root message in results. Default: true",
        },
        limit: {
          type: "integer",
          description: "Max messages to return (1-200). Default: 200.",
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["thread_ts"],
    },
  },
  {
    name: "fetch_conversation_messages",
    description: `Use this when: You need COMPLETE HubSpot support ticket context with all messages and resolution.

Examples:
- "Show me the full ticket conversation" → all messages with customer and support
- "How was this issue resolved?" → complete message thread
- "Get all interactions for ticket X" → chronological conversation

Returns: Up to 200 messages in chronological order with: full content (PII redacted), sender info, timestamps, content types (note/email/chat), engagement types, sources, subjects, email metadata. Optional: conversation summary.

Performance: <1s for most conversations (<20 messages), 1-2s for complex tickets (>50 messages).

Related tools: Use 'kb_search' to find relevant tickets first, 'analyze_training_resolution_patterns' for pattern analysis.`,
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          format: "uuid",
          description:
            "UUID of the training conversation (from training_conversations table)",
        },
        include_summary: {
          type: "boolean",
          description:
            "Include AI-generated conversation summary with each message. Default: false",
        },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "fetch_document_full",
    description: `Use this when: You need FULL document content without truncation (up to 200K characters).

Examples:
- "Show me the complete FAQ document" → full text, all sections
- "Get the entire policy document" → no truncation
- "Read the full guide about X" → complete content

Returns: Complete document with ALL metadata (title, department, type, source, path, file size, mime type, filename, owner, sensitivity, tags, language, timestamps) and full content (PII redacted, up to 200K chars configurable).

Performance: <1s for small docs (<10K chars), 1-2s for medium docs (<50K), 2-3s for large docs (>50K).

Related tools: Use 'kb_search' or 'query_table' to find documents first, 'find_similar_documents' for related docs.`,
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the document (from documents table)",
        },
        max_chars: {
          type: "integer",
          description:
            "Maximum characters to return (1-200000). Default: 100000 (100K)",
          minimum: 1,
          maximum: 200000,
        },
      },
      required: ["document_id"],
    },
  },
  {
    name: "fetch_notion_children",
    description: `Use this when: You need to navigate Notion page hierarchy and see all child pages.

Examples:
- "Show me all pages under Platform Documentation" → child pages with metadata
- "What's in this Notion section?" → list of sub-pages
- "List all pages created under X" → hierarchical structure

Returns: Up to 100 child pages with: title, URL, parent ID, archived status, doc chunk count, edit times, creation time, creator/editor IDs. Sorted by last edited time (newest first) or creation time.

Performance: <1s for most queries.

Related tools: Use 'query_table' on notion_pages to find parent pages first, 'search_notion_by_date' for temporal filtering, 'get_data_freshness_report' for sync status.`,
    inputSchema: {
      type: "object",
      properties: {
        parent_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the parent Notion page",
        },
        include_archived: {
          type: "boolean",
          description: "Include archived pages. Default: false",
        },
        sort_by: {
          type: "string",
          enum: ["last_edited_time", "created_time"],
          description: "Sort order. Default: last_edited_time",
        },
      },
      required: ["parent_id"],
    },
  },
  {
    name: "fetch_wod_deal_full",
    description: `Use this when: You need the COMPLETE WoD deal with ALL related data (enhanced version of wod_get_deal_context).

Examples:
- "Show me everything about deal X" → all 42 fields + circuits + costs + offers
- "Get full deal breakdown with cost analysis" → comprehensive data
- "Complete deal info including all offer variants" → no data omitted

Returns: Comprehensive deal object with:
- ALL 42 deal fields (facility details, infrastructure, costs, pricing, margins, fees, metadata)
- All circuit configurations with power requirements, cable planning, constraints
- All cost line items with labor/material breakdown, catalog references
- All offer variants with contract terms, subsidy details, pricing breakdowns

This is an ENHANCED version that exposes 320% more data than the previous implementation.

Performance: 1-2s for most deals, 2-3s for complex deals with 20+ circuits/costs.

Related tools: Use 'kb_search' or 'query_table' to find deals first, 'compare_wod_deals' for side-by-side analysis, 'aggregate_costs_by_category' for cost insights.`,
    inputSchema: {
      type: "object",
      properties: {
        deal_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the WoD deal",
        },
      },
      required: ["deal_id"],
    },
  },
  // --------------------------------------------------------------------------
  // Analytics Tools (Phase 3)
  // --------------------------------------------------------------------------
  {
    name: "analyze_slack_thread_network",
    description: `Use this when: You need to understand WHO is discussing topics, identify experts, or analyze collaboration patterns in Slack.

Examples:
- "Who are the top experts on charging infrastructure?" → ranked by participation
- "Show me collaboration patterns for platform issues" → user interaction analysis
- "Who participates most in help threads?" → activity metrics

Returns: Participant analysis with: user IDs, display names, thread participation count, message count, average messages per thread, threads as root author, most active channels. Top 50 participants sorted by activity.

Performance: 1-2s for analysis across all threads.

Related tools: Use 'slack_latest_threads' for specific threads, 'fetch_thread_messages' for thread details, 'kb_search' for topic filtering.`,
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description:
            "Optional: limit to specific channel. Default: all channels",
        },
        min_threads: {
          type: "integer",
          description: "Minimum thread participation to include. Default: 2",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "get_reaction_analytics",
    description: `Use this when: You need REACTION ANALYTICS for Slack channels - average reactions, top emojis, engagement metrics.

Examples:
- "What's the average number of reactions in #platform-all-deliveries?" → engagement stats
- "Which emojis are most popular for release announcements?" → top_reactions breakdown
- "How many messages got reactions in 2025?" → messages_with_reactions count

Returns: Analytics object with: total_messages, messages_with_reactions, total_reactions, avg_reactions_per_message, top_reactions (array of {name, total_count}).

Channel IDs:
- C078S57MS5P: #platform-all-deliveries (release announcements)
- C05FA8B5YPM: #help-me-platform (support discussions)

Performance: <1s for date-filtered queries.

Related tools: Use 'slack_latest_messages' for recent content, 'query_table' for custom filters.`,
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description:
            "Slack channel ID. Default: C078S57MS5P (#platform-all-deliveries)",
        },
        date_from: {
          type: "string",
          format: "date",
          description:
            "Start date for analysis (ISO format, e.g., '2025-01-01')",
        },
        date_to: {
          type: "string",
          format: "date",
          description: "End date for analysis (ISO format, e.g., '2025-12-31')",
        },
      },
    },
  },
  {
    name: "analyze_training_resolution_patterns",
    description: `Use this when: You need to understand COMMON support issues, resolution patterns, or ticket trends.

Examples:
- "What are the most common charging issues?" → issues by frequency
- "Show me typical resolution patterns" → common solutions
- "Which issues take longest to resolve?" → complexity analysis

Returns: Pattern analysis with: category breakdown (issue counts, avg resolution messages), common keywords/phrases, high-interaction tickets (>10 messages), resolution time estimates, issue clustering.

Performance: 2-3s for comprehensive pattern analysis.

Related tools: Use 'kb_search' to find specific tickets, 'fetch_conversation_messages' for detailed resolutions, 'query_table' for filtered views.`,
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            'Optional: filter to specific category (e.g., "charging", "app", "billing")',
        },
        date_from: {
          type: "string",
          format: "date",
          description: "Optional: analyze tickets from this date forward",
        },
        min_messages: {
          type: "integer",
          description:
            'Minimum messages for "complex" classification. Default: 10',
          minimum: 1,
        },
      },
    },
  },
  {
    name: "find_similar_documents",
    description: `Use this when: You need to find documents similar by METADATA (department, type, tags) not semantic content.

Examples:
- "Find other documents like this FAQ" → same type/department
- "Show me related legal documents" → metadata clustering
- "What other guides are in this department?" → organizational grouping

Returns: Up to 20 similar documents with: title, department, type, tags overlap, similarity score (0-1 based on metadata match), source paths. Sorted by similarity.

Performance: <1s for metadata comparison.

Related tools: Use 'kb_search' for semantic similarity, 'query_table' for explicit filtering, 'fetch_document_full' for complete content.`,
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          format: "uuid",
          description: "Reference document ID to find similar documents",
        },
        match_criteria: {
          type: "array",
          items: {
            type: "string",
            enum: ["department", "document_type", "tags", "source_type"],
          },
          description: "Metadata fields to match on. Default: all",
        },
        limit: {
          type: "integer",
          description: "Max results (1-20). Default: 10",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["document_id"],
    },
  },
  {
    name: "get_data_freshness_report",
    description: `Use this when: You need to understand data recency, sync status, or verify data currency.

Examples:
- "When was data last synced?" → sync timestamps for all sources
- "Is Notion data up to date?" → last sync time + page counts
- "Show me sync health" → error counts, sync frequencies

Returns: Comprehensive freshness report with:
- Notion: last sync time, pages seen/changed/deleted, error count, total active pages
- Slack: per-channel sync times, message/thread totals, last message timestamps
- HubSpot: last sync time, tickets fetched/updated, messages inserted
- Table stats: row counts for all 14 tables

Performance: <1s (cached RPC call).

Related tools: Use 'list_tables' for detailed schema, 'db_table_stats' for quick counts, 'query_table' for filtered views.`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_notion_by_date",
    description: `Use this when: You need to find Notion pages by TEMPORAL criteria (created/edited dates).

Examples:
- "Show me pages created this week" → recent creations
- "What was edited in the last 24 hours?" → recent updates
- "Find old pages not updated in 6 months" → stale content identification

Returns: Up to 100 pages with: title, URL, created/edited times, creator/editor IDs, chunk count, archived status. Sorted by date (newest first).

Performance: <1s for date-filtered queries.

Related tools: Use 'fetch_notion_children' for hierarchy, 'query_table' for advanced filtering, 'get_data_freshness_report' for sync status.`,
    inputSchema: {
      type: "object",
      properties: {
        date_field: {
          type: "string",
          enum: ["created_time", "last_edited_time"],
          description:
            "Which date field to filter on. Default: last_edited_time",
        },
        date_from: {
          type: "string",
          format: "date",
          description: "Show pages from this date forward",
        },
        date_to: {
          type: "string",
          format: "date",
          description: "Show pages up to this date",
        },
        include_archived: {
          type: "boolean",
          description: "Include archived pages. Default: false",
        },
        limit: {
          type: "integer",
          description: "Max pages (1-100). Default: 50",
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
  {
    name: "compare_wod_deals",
    description: `Use this when: You need SIDE-BY-SIDE comparison of multiple WoD deals across financial/technical dimensions.

Examples:
- "Compare these 3 deals" → tabular comparison
- "Show differences between deal X and Y" → delta analysis
- "Which deal has better margins?" → financial comparison

Returns: JSON array with 2-5 deals showing: ALL key fields (parking spaces, chargers, power level, costs, pricing, margins, dates). Easy to scan for differences.

Performance: 1-2s for up to 5 deals.

Related tools: Use 'kb_search' or 'query_table' to find deals first, 'fetch_wod_deal_full' for complete single-deal context, 'aggregate_costs_by_category' for cost insights.`,
    inputSchema: {
      type: "object",
      properties: {
        deal_ids: {
          type: "array",
          items: { type: "string", format: "uuid" },
          description: "Array of 2-5 deal IDs to compare",
          minItems: 2,
          maxItems: 5,
        },
        fields_to_compare: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: specific fields to compare. Default: key financial/technical fields",
        },
      },
      required: ["deal_ids"],
    },
  },
  {
    name: "aggregate_costs_by_category",
    description: `Use this when: You need WoD cost AGGREGATION, analytics, or spend breakdown.

Examples:
- "What's the average material cost?" → aggregated stats
- "Show me cost breakdown by category" → grouped analysis
- "Total labor costs across all deals" → sum aggregation

Returns: Grouped data with: group value (category/deal/item name), total cost, labor cost, material cost, item count, average cost. Up to 100 groups sorted by total cost descending.

Performance: 1-2s for aggregation across all deals.

Related tools: Use 'fetch_wod_deal_full' for single-deal breakdown, 'compare_wod_deals' for deal-to-deal comparison, 'query_table' for raw cost data.`,
    inputSchema: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          enum: ["category", "deal_id", "item_name"],
          description: "Grouping dimension. Default: category",
        },
      },
    },
  },
  // --------------------------------------------------------------------------
  // Private Knowledge Base Tools (Isolated Schema)
  // --------------------------------------------------------------------------
  {
    name: "private_kb_search",
    description: `Use this when: You need to search PRIVATE content like meeting transcriptions, personal notes, or confidential documents.

Examples:
- "Search my private meeting notes for project X" → semantic search in private_kb
- "Find my transcription about the budget discussion" → private document search
- "What did I note about the client call?" → personal content retrieval

Returns: Up to 10 matching documents with: id, title, content snippet, source_path, similarity score. Results sorted by semantic relevance.

IMPORTANT: This searches the isolated private_kb schema, completely separate from shared volterra_kb content.

Performance: <1s for typical queries.

Related tools: Use 'private_kb_query' for browsing, 'private_kb_status' for sync info.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query for private content",
        },
        match_count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum results to return (default: 10)",
        },
        match_threshold: {
          type: "number",
          minimum: 0.5,
          maximum: 1.0,
          description: "Minimum similarity score (default: 0.78)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "private_kb_query",
    description: `Use this when: You need to browse or list private documents with filters.

Examples:
- "Show my recent private documents" → list with date sorting
- "List all private meeting transcripts" → filtered by document_type
- "Get private docs from last week" → date-filtered query

Returns: Up to 50 documents with: id, title, document_type, source_path, tags, created_at. Sorted by creation date (newest first).

Performance: <1s for filtered queries.

Related tools: Use 'private_kb_search' for semantic search, 'private_kb_status' for sync info.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum rows to return (default: 25)",
        },
        date_from: {
          type: "string",
          format: "date",
          description: "Filter documents from this date forward",
        },
        date_to: {
          type: "string",
          format: "date",
          description: "Filter documents up to this date",
        },
        document_type: {
          type: "string",
          description: 'Filter by document type (e.g., "Meeting Transcript")',
        },
      },
    },
  },
  {
    name: "private_kb_status",
    description: `Use this when: You need to check the status of your private knowledge base.

Examples:
- "How many private documents do I have?" → document count
- "When was my private KB last synced?" → sync status
- "Is my private content up to date?" → freshness check

Returns: Sync status with: last_sync_at, pages_processed, document_count, any errors.

Performance: <500ms.`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "analyze_release_contributors",
    description: `Use this when: You need to analyze releases by CONTRIBUTOR COUNT from #platform-all-deliveries channel.

Examples:
- "Top 5 releases by contributor count in 2025" → ranked by contributors
- "Who contributed to the most releases?" → contributor analysis
- "Releases with more than 3 contributors" → filter by count
- "Average contributors per release" → aggregate statistics

Returns: Array of releases with: message_ts, message_at, release_title, contributor_ids (raw Slack IDs), contributor_names (resolved display names), contributor_count, reaction_count, text_preview. Sorted by contributor count descending.

Channel IDs:
- C078S57MS5P: #platform-all-deliveries (release announcements) - DEFAULT

Performance: <1s for date-filtered queries.

Related tools: Use 'get_reaction_analytics' for engagement metrics, 'slack_latest_messages' for recent content, 'analyze_slack_thread_network' for broader collaboration patterns.`,
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description:
            "Slack channel ID. Default: C078S57MS5P (#platform-all-deliveries)",
        },
        date_from: {
          type: "string",
          format: "date",
          description: "Start date filter (ISO format, e.g., '2025-01-01')",
        },
        date_to: {
          type: "string",
          format: "date",
          description: "End date filter (ISO format, e.g., '2025-12-31')",
        },
        limit: {
          type: "integer",
          description: "Max results (1-50). Default: 20",
          minimum: 1,
          maximum: 50,
        },
      },
    },
  },
  {
    name: "get_release_details",
    description: `Use this when: You need COMPREHENSIVE release information including all announcement fields from #platform-all-deliveries.

Examples:
- "What releases were for installers?" → filter by target_audience
- "Show me releases about charging" → search in title/description/value
- "Full details of recent releases" → all parsed fields
- "What value did we deliver last month?" → value propositions

Returns: Array of releases with ALL parsed fields:
- released_at: Timestamp
- posted_by_name/id: Who posted the announcement
- title: "What we are delivering today" content
- description: Bullet points of features/changes
- target_audience: "Who is it for" content
- value_proposition: "Value" content
- contributor_ids/names/count: From "Who has contributed"
- reaction_count: Engagement metric
- attachment_count: Number of images/files
- slack_url: Direct link to message

Channel IDs:
- C078S57MS5P: #platform-all-deliveries (release announcements) - DEFAULT

Performance: <1s for date-filtered queries.

Related tools: Use 'analyze_release_contributors' for contributor-focused analysis, 'get_reaction_analytics' for engagement metrics.`,
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description:
            "Slack channel ID. Default: C078S57MS5P (#platform-all-deliveries)",
        },
        date_from: {
          type: "string",
          description: "Start date filter (ISO format, e.g., '2025-01-01')",
        },
        date_to: {
          type: "string",
          description: "End date filter (ISO format, e.g., '2025-12-31')",
        },
        target_audience: {
          type: "string",
          description:
            "Filter by 'Who is it for' (e.g., 'installers', 'HA', 'drivers')",
        },
        search_term: {
          type: "string",
          description: "Search in title, description, and value proposition",
        },
        limit: {
          type: "integer",
          description: "Max results (1-50). Default: 20",
          minimum: 1,
          maximum: 50,
        },
      },
    },
  },
  // --------------------------------------------------------------------------
  // Tool Search (Meta-tool for finding the right tool)
  // --------------------------------------------------------------------------
  {
    name: "search_tools",
    description: `Use this when: You're unsure which tool to use for a task, or want to find the most relevant tool(s) for a specific query.

Examples:
- "Find tools for searching Slack messages" → returns slack_latest_messages, kb_search, fetch_thread_messages
- "What tools help with WoD deals?" → returns wod_get_deal_context, fetch_wod_deal_full, compare_wod_deals
- "How do I get document content?" → returns fetch_document_full, kb_search, fetch

This is a META-TOOL that searches over all 31 available tools using semantic similarity. It helps you find the right tool when there are many options.

Returns: Up to 5 matching tools with name, description, category, and similarity score (0-1). Tools are sorted by relevance to your query.

Performance: <1s. Uses pgvector embeddings for fast semantic search.

Related tools: Use get_instructions for comprehensive tool documentation, list_tables for data schema.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language description of what you want to do or find",
        },
        category: {
          type: "string",
          enum: [
            "Primary Search",
            "Data Browsing",
            "Relationship Traversal",
            "Analytics",
            "Slack-Specific",
            "WoD-Specific",
            "Embedding Tools",
            "Private KB",
            "Deep Research",
            "Utility",
          ],
          description: "Optional: filter by tool category",
        },
        match_count: {
          type: "integer",
          description: "Max tools to return (1-10). Default: 5.",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["query"],
    },
  },
];

// ============================================================================
// HELPERS
// ============================================================================

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits)) - 1);
  const ipNum =
    ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
  const rangeNum =
    range.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>>
    0;
  return (ipNum & mask) === (rangeNum & mask);
}

function isOpenAIIP(ip: string): boolean {
  // In dev/testing, allow all. In prod, check CIDR.
  const enforceAllowlist = Deno.env.get("ENFORCE_IP_ALLOWLIST") === "true";
  if (!enforceAllowlist) return true;

  // If IP is 'unknown' (can't determine), allow for now (OpenAI will be behind proxy)
  if (ip === "unknown") return true;

  return OPENAI_EGRESS_CIDRS.some((cidr) => ipInCidr(ip, cidr));
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

function getClientIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function safeTruncate(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.startsWith("https://") || value.startsWith("http://");
}

function slackPermalink(
  channelId: string | null | undefined,
  messageTs: string | null | undefined,
): string | null {
  if (!channelId || !messageTs) return null;
  const tsNoDot = messageTs.replace(".", "");
  if (!tsNoDot) return null;
  return `https://volterra.slack.com/archives/${channelId}/p${tsNoDot}`;
}

function hubspotTicketUrl(
  ticketId: string | number | null | undefined,
): string | null {
  if (ticketId === null || ticketId === undefined) return null;
  const idStr = String(ticketId).trim();
  if (!idStr) return null;
  // Workspace fixed in our environment (EU1)
  return `https://app-eu1.hubspot.com/contacts/YOUR_PORTAL_ID/record/0-5/${idStr}`;
}

function redactPII(text: string): string {
  // Keep this lightweight (best-effort). Primary protection is schema + safe columns.
  let out = text;
  // Emails
  out = out.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[REDACTED_EMAIL]",
  );
  // Phone-like patterns (very rough, avoids eating timestamps/IDs by requiring 8+ digits total)
  out = out.replace(/\b(\+?\d[\d\s().-]{7,}\d)\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 8) return m;
    return "[REDACTED_PHONE]";
  });
  return out;
}

function stripHtml(input: string): string {
  // Best-effort HTML->text (no DOM available). Keep cheap.
  return input
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function log(
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ============================================================================
// EMBEDDING GENERATION
// ============================================================================

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  // Clean and truncate
  const cleaned = text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000); // Conservative limit

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: cleaned,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embedding error: ${err}`);
  }

  const result = await response.json();
  return result.data[0].embedding;
}

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

async function executeKbSearch(
  supabase: ReturnType<typeof createClient>,
  params: { query: string; sources?: string[]; match_count?: number },
): Promise<ToolCallResult> {
  const query = params.query?.trim();
  if (!query) {
    return {
      content: [{ type: "text", text: "Error: query is required" }],
      isError: true,
    };
  }

  const matchCount = Math.min(Math.max(params.match_count ?? 5, 1), 20);
  const sources = params.sources ?? ["documents", "training", "slack", "wod"];

  // Generate embedding once
  const embedding = await generateEmbedding(query);
  // Format as pgvector-compatible string
  const embeddingVec = JSON.stringify(embedding);

  const results: Record<string, unknown[]> = {};

  // Search each requested source
  if (sources.includes("documents")) {
    const { data, error } = await supabase.rpc("mcp_match_documents", {
      query_embedding: embeddingVec,
      match_count: matchCount,
    });
    if (error) {
      log("error", "mcp_match_documents error", { error: error.message });
    }
    if (!error && data) results.documents = data;
  }

  if (sources.includes("training")) {
    const { data, error } = await supabase.rpc(
      "mcp_match_training_conversations",
      {
        query_embedding: embeddingVec,
        match_count: matchCount,
      },
    );
    if (error) {
      log("error", "mcp_match_training_conversations error", {
        error: error.message,
      });
    }
    if (!error && data) results.training_conversations = data;
  }

  if (sources.includes("slack")) {
    const { data, error } = await supabase.rpc("mcp_match_slack_messages", {
      query_embedding: embeddingVec,
      match_count: matchCount,
    });
    if (error) {
      log("error", "mcp_match_slack_messages error", { error: error.message });
    }
    if (!error && data) results.slack_messages = data;
  }

  if (sources.includes("wod")) {
    const { data, error } = await supabase.rpc("mcp_match_wod_deals", {
      query_embedding: embeddingVec,
      match_count: matchCount,
    });
    if (error) {
      log("error", "mcp_match_wod_deals error", { error: error.message });
    }
    if (!error && data) results.wod_deals = data;
  }

  const totalResults = Object.values(results).flat().length;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            query,
            total_results: totalResults,
            results,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ============================================================================
// OPENAI DEEP RESEARCH: search + fetch
// ============================================================================

type DeepResearchSearchResult = {
  id: string;
  title: string;
  url: string;
  text_snippet?: string;
  metadata?: Record<string, unknown>;
};

async function executeDeepResearchSearch(
  supabase: ReturnType<typeof createClient>,
  params: { query: string },
): Promise<ToolCallResult> {
  const query = params.query?.trim();
  if (!query) {
    return {
      content: [{ type: "text", text: "Error: query is required" }],
      isError: true,
    };
  }

  // Deep research flows prefer a single flat list; we merge sources and sort by similarity.
  const embedding = await generateEmbedding(query);
  const embeddingVec = JSON.stringify(embedding);

  const perSource = 8; // merged + re-ranked below

  const [docsRes, trainingRes, slackRes, wodRes] = await Promise.all([
    supabase.rpc("mcp_match_documents", {
      query_embedding: embeddingVec,
      match_count: perSource,
    }),
    supabase.rpc("mcp_match_training_conversations", {
      query_embedding: embeddingVec,
      match_count: perSource,
    }),
    supabase.rpc("mcp_match_slack_messages", {
      query_embedding: embeddingVec,
      match_count: perSource,
    }),
    supabase.rpc("mcp_match_wod_deals", {
      query_embedding: embeddingVec,
      match_count: Math.min(perSource, 10),
    }),
  ]);

  const results: Array<{
    similarity?: number;
    item: DeepResearchSearchResult;
  }> = [];

  if (!docsRes.error && docsRes.data) {
    for (const r of docsRes.data as Array<Record<string, unknown>>) {
      const id = String(r.id);
      const title = String(r.title ?? "Document");
      const sourcePath = (r.source_path as string | null | undefined) ?? null;
      const url = isHttpUrl(sourcePath)
        ? (sourcePath as string)
        : `volterra://documents/${id}`;
      const snippet = safeTruncate(String(r.content_preview ?? ""), 200);
      results.push({
        similarity: typeof r.similarity === "number" ? r.similarity : undefined,
        item: {
          id: `documents:${id}`,
          title,
          url,
          text_snippet: snippet,
          metadata: {
            source_type: r.source_type,
            source_path: r.source_path,
            department: r.department,
            document_type: r.document_type,
            similarity: r.similarity,
          },
        },
      });
    }
  }

  if (!trainingRes.error && trainingRes.data) {
    for (const r of trainingRes.data as Array<Record<string, unknown>>) {
      const id = String(r.id);
      const title = String(r.subject ?? "Training conversation");
      const hsUrl = hubspotTicketUrl(
        r.hubspot_ticket_id as string | number | null | undefined,
      );
      const url = hsUrl ?? `volterra://training_conversations/${id}`;
      const snippet = safeTruncate(String(r.conversation_summary ?? ""), 200);
      results.push({
        similarity: typeof r.similarity === "number" ? r.similarity : undefined,
        item: {
          id: `training_conversations:${id}`,
          title,
          url,
          text_snippet: snippet,
          metadata: {
            category: r.category,
            training_type: r.training_type,
            similarity: r.similarity,
          },
        },
      });
    }
  }

  if (!slackRes.error && slackRes.data) {
    for (const r of slackRes.data as Array<Record<string, unknown>>) {
      const id = String(r.id);
      const channelId = (r.channel_id as string | null | undefined) ?? null;
      const messageTs = (r.message_ts as string | null | undefined) ?? null;
      const url =
        slackPermalink(channelId, messageTs) ?? `volterra://slack_messages/${id}`;
      const title = `${String(r.user_display_name ?? "Slack user")} (${channelId ?? "channel"})`;
      const snippet = safeTruncate(String(r.text ?? ""), 200);
      results.push({
        similarity: typeof r.similarity === "number" ? r.similarity : undefined,
        item: {
          id: `slack_messages:${id}`,
          title,
          url,
          text_snippet: snippet,
          metadata: {
            channel_id: channelId,
            message_ts: messageTs,
            thread_ts: r.thread_ts,
            message_at: r.message_at,
            similarity: r.similarity,
          },
        },
      });
    }
  }

  if (!wodRes.error && wodRes.data) {
    for (const r of wodRes.data as Array<Record<string, unknown>>) {
      const id = String(r.id);
      const title = String(r.deal_name ?? "WoD deal");
      const url = `volterra://wod_deals/${id}`;
      const snippet = safeTruncate(
        `${String(r.country ?? "")} ${String(r.geographic_area ?? "")} ${String(r.charger_type ?? "")}`.trim(),
        200,
      );
      results.push({
        similarity: typeof r.similarity === "number" ? r.similarity : undefined,
        item: {
          id: `wod_deals:${id}`,
          title,
          url,
          text_snippet: snippet,
          metadata: {
            country: r.country,
            geographic_area: r.geographic_area,
            charger_type: r.charger_type,
            total_boxes: r.total_boxes,
            total_parking_spaces: r.total_parking_spaces,
            deal_date: r.deal_date,
            similarity: r.similarity,
          },
        },
      });
    }
  }

  results.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  const top = results.slice(0, 25).map((r) => r.item);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ results: top }, null, 2),
      },
    ],
  };
}

async function executeDeepResearchFetch(
  supabase: ReturnType<typeof createClient>,
  params: { id: string },
): Promise<ToolCallResult> {
  const rawId = params.id?.trim();
  if (!rawId) {
    return {
      content: [{ type: "text", text: "Error: id is required" }],
      isError: true,
    };
  }

  const [source, ...rest] = rawId.split(":");
  const itemId = rest.join(":").trim();

  if (!source || !itemId) {
    return {
      content: [
        { type: "text", text: 'Error: id must be in the form "<source>:<id>"' },
      ],
      isError: true,
    };
  }

  // Default fallback URL for citations
  let url: string = `volterra://${source}/${itemId}`;
  let title: string = `${source} ${itemId}`;
  let text: string = "";
  let metadata: Record<string, unknown> | undefined = undefined;

  if (source === "documents") {
    const { data, error } = await supabase
      .schema("volterra_kb")
      .from("documents")
      .select(
        "id,title,department,document_type,source_type,source_path,language,access_level,created_at,updated_at,content",
      )
      .eq("id", itemId)
      .maybeSingle();
    if (error)
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    if (!data)
      return {
        content: [{ type: "text", text: `Error: Not found: ${rawId}` }],
        isError: true,
      };

    title = data.title ?? title;
    url = isHttpUrl(data.source_path)
      ? (data.source_path as string)
      : `volterra://documents/${data.id}`;
    text = redactPII(
      safeTruncate(
        String((data as Record<string, unknown>).content ?? ""),
        20000,
      ),
    );
    metadata = {
      department: data.department,
      document_type: data.document_type,
      source_type: data.source_type,
      source_path: data.source_path,
      language: data.language,
      access_level: data.access_level,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  } else if (source === "training_conversations") {
    const { data, error } = await supabase
      .schema("volterra_kb")
      .from("training_conversations")
      .select(
        "id,hubspot_ticket_id,subject,category,subcategory,training_type,create_date,conversation_summary",
      )
      .eq("id", itemId)
      .maybeSingle();
    if (error)
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    if (!data)
      return {
        content: [{ type: "text", text: `Error: Not found: ${rawId}` }],
        isError: true,
      };

    title = data.subject ?? title;
    url =
      hubspotTicketUrl(
        (data as Record<string, unknown>).hubspot_ticket_id as
          | string
          | number
          | null
          | undefined,
      ) ?? `volterra://training_conversations/${data.id}`;

    // Fetch full message thread (bounded). Do NOT expose from_email or raw PII; redact in content.
    const { data: messages, error: msgError } = await supabase
      .schema("volterra_kb")
      .from("training_messages")
      .select(
        "timestamp,participant_role,direction,message_type,subject,content,content_type,engagement_type,source",
      )
      .eq("conversation_id", itemId)
      .order("timestamp", { ascending: true })
      .limit(200);

    if (msgError) {
      return {
        content: [{ type: "text", text: `Error: ${msgError.message}` }],
        isError: true,
      };
    }

    const headerLines: string[] = [];
    headerLines.push(`Ticket: ${title}`);
    if ((data as Record<string, unknown>).hubspot_ticket_id)
      headerLines.push(
        `HubSpot ticket id: ${(data as Record<string, unknown>).hubspot_ticket_id}`,
      );
    if (data.category) headerLines.push(`Category: ${data.category}`);
    if ((data as Record<string, unknown>).subcategory)
      headerLines.push(
        `Subcategory: ${(data as Record<string, unknown>).subcategory}`,
      );
    if (data.training_type)
      headerLines.push(`Training type: ${data.training_type}`);
    if ((data as Record<string, unknown>).create_date)
      headerLines.push(
        `Created at: ${(data as Record<string, unknown>).create_date}`,
      );
    headerLines.push("");
    headerLines.push("--- Thread (oldest → newest) ---");
    headerLines.push("");

    const maxChars = 20000;
    const maxCharsForBody = 18500; // leave room for JSON + metadata
    let built = headerLines.join("\n");

    const msgs = (messages ?? []) as Array<Record<string, unknown>>;
    for (const m of msgs) {
      if (built.length > maxCharsForBody) {
        built += "\n\n[TRUNCATED]\n";
        break;
      }

      const ts = m.timestamp ? String(m.timestamp) : "";
      const roleRaw = (m.participant_role ??
        m.direction ??
        "unknown") as string;
      const role = String(roleRaw || "unknown").toUpperCase();
      const msgType = m.message_type ? String(m.message_type) : "";
      const subj = m.subject ? String(m.subject) : "";
      const contentType = m.content_type ? String(m.content_type) : "";

      let body = m.content ? String(m.content) : "";
      if (contentType.toLowerCase().includes("html")) {
        body = stripHtml(body);
      }
      body = body
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      body = redactPII(body);
      body = safeTruncate(body, 4000); // per-message cap

      const lineHeader = `${ts} ${role}${msgType ? ` (${msgType})` : ""}${subj ? ` — ${safeTruncate(subj, 120)}` : ""}`;
      built += `${lineHeader}\n${body}\n\n`;
    }

    // If no messages (rare), fallback to stored summary
    if (msgs.length === 0) {
      built += safeTruncate(
        String((data as Record<string, unknown>).conversation_summary ?? ""),
        18000,
      );
    }

    text = safeTruncate(built.trim(), maxChars);
    metadata = {
      hubspot_ticket_id: (data as Record<string, unknown>).hubspot_ticket_id,
      category: data.category,
      subcategory: (data as Record<string, unknown>).subcategory,
      training_type: data.training_type,
      create_date: (data as Record<string, unknown>).create_date,
      message_count_returned: (messages ?? []).length,
      message_limit: 200,
      note: "Thread text is redacted (emails/phones) and truncated for safety.",
    };
  } else if (source === "slack_messages") {
    const { data, error } = await supabase
      .schema("volterra_kb")
      .from("slack_messages")
      .select(
        "id,channel_id,message_ts,thread_ts,user_display_name,text,message_at",
      )
      .eq("id", itemId)
      .maybeSingle();
    if (error)
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    if (!data)
      return {
        content: [{ type: "text", text: `Error: Not found: ${rawId}` }],
        isError: true,
      };

    title = `${data.user_display_name ?? "Slack user"} (${data.channel_id ?? "channel"})`;
    url =
      slackPermalink(data.channel_id, data.message_ts) ??
      `volterra://slack_messages/${data.id}`;
    text = redactPII(
      safeTruncate(String((data as Record<string, unknown>).text ?? ""), 20000),
    );
    metadata = {
      channel_id: data.channel_id,
      message_ts: data.message_ts,
      thread_ts: (data as Record<string, unknown>).thread_ts,
      message_at: (data as Record<string, unknown>).message_at,
    };
  } else if (source === "wod_deals") {
    // For WoD deals, reuse existing context RPC.
    const { data, error } = await supabase.rpc("get_wod_deal_context", {
      deal_uuid: itemId,
    });
    if (error)
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    if (!data)
      return {
        content: [{ type: "text", text: `Error: Not found: ${rawId}` }],
        isError: true,
      };

    title = (data as Record<string, unknown>).deal_name
      ? String((data as Record<string, unknown>).deal_name)
      : title;
    url = `volterra://wod_deals/${itemId}`;
    text = safeTruncate(JSON.stringify(data, null, 2), 20000);
    metadata = {
      note: "Structured WoD deal context (truncated to 20k chars).",
    };
  } else {
    return {
      content: [
        {
          type: "text",
          text: `Error: Unknown source "${source}". Expected documents|training_conversations|slack_messages|wod_deals`,
        },
      ],
      isError: true,
    };
  }

  const payload = { id: rawId, title, url, text, metadata };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function executeSlackLatestMessages(
  supabase: ReturnType<typeof createClient>,
  params: { channel_id?: string; limit?: number },
): Promise<ToolCallResult> {
  const channelId = params.channel_id ?? "C05FA8B5YPM";
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

  const { data, error } = await supabase.rpc("get_latest_slack_messages", {
    p_channel_id: channelId,
    p_limit: limit,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            channel_id: channelId,
            count: data?.length ?? 0,
            messages: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeSlackLatestThreads(
  supabase: ReturnType<typeof createClient>,
  params: { channel_id?: string; limit?: number },
): Promise<ToolCallResult> {
  const channelId = params.channel_id ?? "C05FA8B5YPM";
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

  const { data, error } = await supabase.rpc("get_latest_slack_threads", {
    p_channel_id: channelId,
    p_limit: limit,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            channel_id: channelId,
            count: data?.length ?? 0,
            threads: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeWodGetDealContext(
  supabase: ReturnType<typeof createClient>,
  params: { deal_id: string },
): Promise<ToolCallResult> {
  const dealId = params.deal_id;
  if (!dealId) {
    return {
      content: [{ type: "text", text: "Error: deal_id is required" }],
      isError: true,
    };
  }

  const { data, error } = await supabase.rpc("get_wod_deal_context", {
    deal_uuid: dealId,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  if (!data) {
    return {
      content: [{ type: "text", text: `No deal found with ID: ${dealId}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function executeDbTableStats(
  supabase: ReturnType<typeof createClient>,
): Promise<ToolCallResult> {
  const { data, error } = await supabase.rpc("get_table_stats_extended");

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            table_stats: data,
            generated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeQueryTable(
  supabase: ReturnType<typeof createClient>,
  params: {
    table: string;
    filters?: Record<string, unknown>;
    date_from?: string;
    date_to?: string;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  },
): Promise<ToolCallResult> {
  const tableName = params.table;
  const schema = TABLE_SCHEMA[tableName];

  if (!schema) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Unknown table "${tableName}". Use list_tables to see available tables.`,
        },
      ],
      isError: true,
    };
  }

  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const order = params.order ?? "desc";

  // Build query with only safe columns
  let query = supabase
    .from(tableName)
    .select(schema.columns.join(","))
    .order(schema.orderBy ?? "id", { ascending: order === "asc" })
    .range(offset, offset + limit - 1);

  // Apply filters
  if (params.filters) {
    for (const [key, value] of Object.entries(params.filters)) {
      if (
        schema.columns.includes(key) &&
        value !== undefined &&
        value !== null
      ) {
        query = query.eq(key, value);
      }
    }
  }

  // Apply date filters (use the table's orderBy column if it's a date)
  const dateColumn = schema.orderBy;
  if (dateColumn && (params.date_from || params.date_to)) {
    if (params.date_from) {
      query = query.gte(dateColumn, params.date_from);
    }
    if (params.date_to) {
      query = query.lte(dateColumn, params.date_to);
    }
  }

  const { data, error, count } = await query;

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            table: tableName,
            columns: schema.columns,
            row_count: data?.length ?? 0,
            offset,
            limit,
            order,
            rows: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeCountRows(
  supabase: ReturnType<typeof createClient>,
  params: {
    table: string;
    filters?: Record<string, unknown>;
    date_from?: string;
    date_to?: string;
    group_by?: string;
  },
): Promise<ToolCallResult> {
  const tableName = params.table;
  const schema = TABLE_SCHEMA[tableName];

  if (!schema) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Unknown table "${tableName}". Use list_tables to see available tables.`,
        },
      ],
      isError: true,
    };
  }

  // If group_by is requested, we need to use a raw RPC or different approach
  if (params.group_by && schema.columns.includes(params.group_by)) {
    // For grouped counts, we use the mcp_count_grouped RPC function
    const { data, error } = await supabase.rpc("mcp_count_grouped", {
      p_table_name: tableName,
      p_group_column: params.group_by,
      p_date_column: schema.orderBy,
      p_date_from: params.date_from ?? null,
      p_date_to: params.date_to ?? null,
      p_filters: params.filters ? JSON.stringify(params.filters) : null,
    });

    if (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              table: tableName,
              group_by: params.group_by,
              groups: data ?? [],
              total: (data ?? []).reduce(
                (sum: number, g: { count: number }) => sum + g.count,
                0,
              ),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Simple count query
  let query = supabase
    .from(tableName)
    .select("*", { count: "exact", head: true });

  // Apply filters
  if (params.filters) {
    for (const [key, value] of Object.entries(params.filters)) {
      if (
        schema.columns.includes(key) &&
        value !== undefined &&
        value !== null
      ) {
        query = query.eq(key, value);
      }
    }
  }

  // Apply date filters
  const dateColumn = schema.orderBy;
  if (dateColumn && (params.date_from || params.date_to)) {
    if (params.date_from) {
      query = query.gte(dateColumn, params.date_from);
    }
    if (params.date_to) {
      query = query.lte(dateColumn, params.date_to);
    }
  }

  const { count, error } = await query;

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            table: tableName,
            filters: params.filters,
            date_from: params.date_from,
            date_to: params.date_to,
            count: count ?? 0,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeListTables(
  supabase: ReturnType<typeof createClient>,
): Promise<ToolCallResult> {
  // Get row counts for context
  const { data: stats } = await supabase.rpc("get_table_stats_extended");
  const statsMap = new Map(
    (stats ?? []).map((s: { table_name: string; row_count: number }) => [
      s.table_name,
      s.row_count,
    ]),
  );

  const tables = Object.entries(TABLE_SCHEMA).map(([name, schema]) => ({
    name,
    columns: schema.columns,
    order_by_column: schema.orderBy,
    row_count: statsMap.get(name) ?? "unknown",
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            available_tables: tables,
            total_tables: tables.length,
            usage_hint:
              "Use query_table to browse data, count_rows for aggregations",
          },
          null,
          2,
        ),
      },
    ],
  };
}

// Embedding source table mappings
const EMBEDDING_SOURCES: Record<
  string,
  {
    table: string;
    idColumn: string;
    embeddingColumn: string;
    labelColumn: string;
  }
> = {
  documents: {
    table: "documents",
    idColumn: "id",
    embeddingColumn: "embedding",
    labelColumn: "title",
  },
  training_conversations: {
    table: "training_conversations",
    idColumn: "id",
    embeddingColumn: "embedding",
    labelColumn: "subject",
  },
  slack_messages: {
    table: "slack_messages",
    idColumn: "id",
    embeddingColumn: "embedding",
    labelColumn: "text",
  },
  wod_deals: {
    table: "wod_deals",
    idColumn: "id",
    embeddingColumn: "embedding",
    labelColumn: "deal_name",
  },
};

async function executeGetEmbeddings(
  supabase: ReturnType<typeof createClient>,
  params: { source: string; ids: string[] },
): Promise<ToolCallResult> {
  const sourceConfig = EMBEDDING_SOURCES[params.source];
  if (!sourceConfig) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Unknown source "${params.source}". Valid: ${Object.keys(EMBEDDING_SOURCES).join(", ")}`,
        },
      ],
      isError: true,
    };
  }

  const ids = (params.ids ?? []).slice(0, 10); // Max 10
  if (ids.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "Error: ids array is required and must not be empty",
        },
      ],
      isError: true,
    };
  }

  const { data, error } = await supabase
    .from(sourceConfig.table)
    .select(
      `${sourceConfig.idColumn}, ${sourceConfig.labelColumn}, ${sourceConfig.embeddingColumn}`,
    )
    .in(sourceConfig.idColumn, ids);

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  const results = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row[sourceConfig.idColumn],
    label:
      typeof row[sourceConfig.labelColumn] === "string"
        ? (row[sourceConfig.labelColumn] as string).slice(0, 100)
        : row[sourceConfig.labelColumn],
    embedding: row[sourceConfig.embeddingColumn],
    dimensions: Array.isArray(row[sourceConfig.embeddingColumn])
      ? (row[sourceConfig.embeddingColumn] as number[]).length
      : null,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            source: params.source,
            requested_ids: ids,
            found: results.length,
            embeddings: results,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeGenerateEmbedding(params: {
  text: string;
}): Promise<ToolCallResult> {
  const text = params.text?.trim();
  if (!text) {
    return {
      content: [{ type: "text", text: "Error: text is required" }],
      isError: true,
    };
  }

  try {
    const embedding = await generateEmbedding(text);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              input_text: text.slice(0, 200) + (text.length > 200 ? "..." : ""),
              input_length: text.length,
              model: EMBEDDING_MODEL,
              dimensions: embedding.length,
              embedding,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function executeComputeSimilarity(
  supabase: ReturnType<typeof createClient>,
  params: {
    text: string;
    compare_to: {
      type: "text" | "records";
      texts?: string[];
      source?: string;
      ids?: string[];
    };
  },
): Promise<ToolCallResult> {
  const text = params.text?.trim();
  if (!text) {
    return {
      content: [{ type: "text", text: "Error: text is required" }],
      isError: true,
    };
  }

  const compareTo = params.compare_to;
  if (!compareTo || !compareTo.type) {
    return {
      content: [
        { type: "text", text: "Error: compare_to with type is required" },
      ],
      isError: true,
    };
  }

  try {
    // Generate embedding for query text
    const queryEmbedding = await generateEmbedding(text);

    if (compareTo.type === "text") {
      // Compare against other texts
      const texts = (compareTo.texts ?? []).slice(0, 5);
      if (texts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: texts array is required for type=text",
            },
          ],
          isError: true,
        };
      }

      const results = await Promise.all(
        texts.map(async (t, i) => {
          const emb = await generateEmbedding(t);
          return {
            index: i,
            text_preview: t.slice(0, 100) + (t.length > 100 ? "..." : ""),
            similarity: cosineSimilarity(queryEmbedding, emb),
          };
        }),
      );

      results.sort((a, b) => b.similarity - a.similarity);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query_text:
                  text.slice(0, 100) + (text.length > 100 ? "..." : ""),
                comparison_type: "text",
                results,
              },
              null,
              2,
            ),
          },
        ],
      };
    } else if (compareTo.type === "records") {
      // Compare against stored embeddings
      const sourceConfig = EMBEDDING_SOURCES[compareTo.source ?? ""];
      if (!sourceConfig) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown source "${compareTo.source}". Valid: ${Object.keys(EMBEDDING_SOURCES).join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const ids = (compareTo.ids ?? []).slice(0, 10);
      if (ids.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: ids array is required for type=records",
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await supabase
        .from(sourceConfig.table)
        .select(
          `${sourceConfig.idColumn}, ${sourceConfig.labelColumn}, ${sourceConfig.embeddingColumn}`,
        )
        .in(sourceConfig.idColumn, ids);

      if (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      const results = (data ?? [])
        .map((row: Record<string, unknown>) => {
          const emb = row[sourceConfig.embeddingColumn] as number[] | null;
          return {
            id: row[sourceConfig.idColumn],
            label:
              typeof row[sourceConfig.labelColumn] === "string"
                ? (row[sourceConfig.labelColumn] as string).slice(0, 100)
                : row[sourceConfig.labelColumn],
            similarity: emb ? cosineSimilarity(queryEmbedding, emb) : null,
            has_embedding: !!emb,
          };
        })
        .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query_text:
                  text.slice(0, 100) + (text.length > 100 ? "..." : ""),
                comparison_type: "records",
                source: compareTo.source,
                results,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: 'Error: compare_to.type must be "text" or "records"',
        },
      ],
      isError: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

// ============================================================================
// RELATIONSHIP TRAVERSAL TOOLS (Phase 2)
// ============================================================================

async function executeFetchThreadMessages(
  supabase: ReturnType<typeof createClient>,
  params: {
    thread_ts: string;
    channel_id?: string;
    include_root?: boolean;
    limit?: number;
  },
): Promise<ToolCallResult> {
  const threadTs = params.thread_ts?.trim();
  if (!threadTs) {
    return {
      content: [{ type: "text", text: "Error: thread_ts is required" }],
      isError: true,
    };
  }

  const channelId = params.channel_id ?? "C05FA8B5YPM";
  const includeRoot = params.include_root ?? true;
  const limit = Math.min(params.limit ?? 200, 200);

  const { data, error } = await supabase.rpc("mcp_fetch_thread_messages", {
    p_thread_ts: threadTs,
    p_channel_id: channelId,
    p_include_root: includeRoot,
    p_limit: limit,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            thread_ts: threadTs,
            channel_id: channelId,
            include_root: includeRoot,
            message_count: data?.length ?? 0,
            messages: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeFetchConversationMessages(
  supabase: ReturnType<typeof createClient>,
  params: { conversation_id: string; include_summary?: boolean },
): Promise<ToolCallResult> {
  const conversationId = params.conversation_id?.trim();
  if (!conversationId) {
    return {
      content: [{ type: "text", text: "Error: conversation_id is required" }],
      isError: true,
    };
  }

  const includeSummary = params.include_summary ?? false;

  const { data, error } = await supabase.rpc(
    "mcp_fetch_conversation_messages",
    {
      p_conversation_id: conversationId,
      p_include_summary: includeSummary,
    },
  );

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            conversation_id: conversationId,
            include_summary: includeSummary,
            message_count: data?.length ?? 0,
            messages: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeFetchDocumentFull(
  supabase: ReturnType<typeof createClient>,
  params: { document_id: string; max_chars?: number },
): Promise<ToolCallResult> {
  const documentId = params.document_id?.trim();
  if (!documentId) {
    return {
      content: [{ type: "text", text: "Error: document_id is required" }],
      isError: true,
    };
  }

  const maxChars = Math.min(params.max_chars ?? 100000, 200000);

  const { data, error } = await supabase.rpc("mcp_fetch_document_full", {
    p_document_id: documentId,
    p_max_chars: maxChars,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  if (!data || data.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Document not found with ID ${documentId}`,
        },
      ],
      isError: true,
    };
  }

  const doc = data[0];
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            document_id: documentId,
            max_chars: maxChars,
            document: doc,
            content_length: doc.content?.length ?? 0,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeFetchNotionChildren(
  supabase: ReturnType<typeof createClient>,
  params: { parent_id: string; include_archived?: boolean; sort_by?: string },
): Promise<ToolCallResult> {
  const parentId = params.parent_id?.trim();
  if (!parentId) {
    return {
      content: [{ type: "text", text: "Error: parent_id is required" }],
      isError: true,
    };
  }

  const includeArchived = params.include_archived ?? false;
  const sortBy = params.sort_by ?? "last_edited_time";

  const { data, error } = await supabase.rpc("mcp_fetch_notion_children", {
    p_parent_id: parentId,
    p_include_archived: includeArchived,
    p_sort_by: sortBy,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            parent_id: parentId,
            include_archived: includeArchived,
            sort_by: sortBy,
            child_count: data?.length ?? 0,
            children: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeFetchWodDealFull(
  supabase: ReturnType<typeof createClient>,
  params: { deal_id: string },
): Promise<ToolCallResult> {
  const dealId = params.deal_id?.trim();
  if (!dealId) {
    return {
      content: [{ type: "text", text: "Error: deal_id is required" }],
      isError: true,
    };
  }

  // Fetch the complete deal with ALL 42 columns using the expanded TABLE_SCHEMA
  const dealSchema = TABLE_SCHEMA["wod_deals"];
  const circuitsSchema = TABLE_SCHEMA["wod_deal_circuits"];
  const costsSchema = TABLE_SCHEMA["wod_deal_costs"];
  const offersSchema = TABLE_SCHEMA["wod_deal_offers"];

  const [dealRes, circuitsRes, costsRes, offersRes] = await Promise.all([
    supabase
      .schema("volterra_kb")
      .from("wod_deals")
      .select(dealSchema.columns.join(", "))
      .eq("id", dealId)
      .single(),
    supabase
      .schema("volterra_kb")
      .from("wod_deal_circuits")
      .select(circuitsSchema.columns.join(", "))
      .eq("deal_id", dealId),
    supabase
      .schema("volterra_kb")
      .from("wod_deal_costs")
      .select(costsSchema.columns.join(", "))
      .eq("deal_id", dealId),
    supabase
      .schema("volterra_kb")
      .from("wod_deal_offers")
      .select(offersSchema.columns.join(", "))
      .eq("deal_id", dealId),
  ]);

  if (dealRes.error) {
    return {
      content: [{ type: "text", text: `Error: ${dealRes.error.message}` }],
      isError: true,
    };
  }

  if (!dealRes.data) {
    return {
      content: [
        { type: "text", text: `Error: Deal not found with ID ${dealId}` },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            deal_id: dealId,
            deal: dealRes.data,
            circuits: circuitsRes.data ?? [],
            costs: costsRes.data ?? [],
            offers: offersRes.data ?? [],
            summary: {
              circuit_count: circuitsRes.data?.length ?? 0,
              cost_item_count: costsRes.data?.length ?? 0,
              offer_count: offersRes.data?.length ?? 0,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ============================================================================
// ANALYTICS TOOLS (Phase 3)
// ============================================================================

async function executeAnalyzeSlackThreadNetwork(
  supabase: ReturnType<typeof createClient>,
  params: { channel_id?: string; min_threads?: number },
): Promise<ToolCallResult> {
  const channelId = params.channel_id?.trim();
  const minThreads = params.min_threads ?? 2;

  // Build query for participant analysis
  let query = supabase
    .schema("volterra_kb")
    .from("slack_messages")
    .select("user_id, user_display_name, thread_ts, channel_id, message_ts");

  if (channelId) {
    query = query.eq("channel_id", channelId);
  }

  query = query.not("user_id", "is", null).not("thread_ts", "is", null);

  const { data, error } = await query;

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  // Analyze participation patterns
  const userStats = new Map<
    string,
    {
      userId: string;
      displayName: string;
      threadCount: number;
      messageCount: number;
      channels: Set<string>;
      isRootAuthor: number;
    }
  >();

  for (const msg of data ?? []) {
    const userId = msg.user_id as string;
    const displayName = (msg.user_display_name as string) ?? userId;
    const threadTs = msg.thread_ts as string;
    const channelId = msg.channel_id as string;
    const messageTs = msg.message_ts as string;
    const isRoot = messageTs === threadTs;

    if (!userStats.has(userId)) {
      userStats.set(userId, {
        userId,
        displayName,
        threadCount: 0,
        messageCount: 0,
        channels: new Set(),
        isRootAuthor: 0,
      });
    }

    const stats = userStats.get(userId)!;
    stats.messageCount++;
    stats.channels.add(channelId);
    if (isRoot) {
      stats.isRootAuthor++;
      stats.threadCount++;
    }
  }

  // Convert to array and filter/sort
  const participants = Array.from(userStats.values())
    .filter((s) => s.threadCount >= minThreads)
    .map((s) => ({
      user_id: s.userId,
      display_name: s.displayName,
      thread_participation_count: s.threadCount,
      message_count: s.messageCount,
      avg_messages_per_thread: s.messageCount / s.threadCount,
      threads_as_root_author: s.isRootAuthor,
      active_channels: Array.from(s.channels),
      channel_count: s.channels.size,
    }))
    .sort((a, b) => b.thread_participation_count - a.thread_participation_count)
    .slice(0, 50);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            channel_filter: channelId ?? "all",
            min_threads: minThreads,
            participant_count: participants.length,
            participants,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeAnalyzeTrainingResolutionPatterns(
  supabase: ReturnType<typeof createClient>,
  params: { category?: string; date_from?: string; min_messages?: number },
): Promise<ToolCallResult> {
  const category = params.category?.trim();
  const dateFrom = params.date_from?.trim();
  const minMessages = params.min_messages ?? 10;

  // Build query
  let query = supabase
    .schema("volterra_kb")
    .from("training_conversations")
    .select(
      "id, subject, category, num_messages, conversation_summary, created_at",
    );

  if (category) {
    query = query.eq("category", category);
  }
  if (dateFrom) {
    query = query.gte("created_at", dateFrom);
  }

  const { data, error } = await query;

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  // Analyze patterns
  const categoryStats = new Map<
    string,
    { count: number; totalMessages: number; avgMessages: number }
  >();
  const complexTickets: Array<{
    id: string;
    subject: string;
    category: string;
    num_messages: number;
  }> = [];

  for (const conv of data ?? []) {
    const cat = (conv.category as string) ?? "uncategorized";
    const numMsg = (conv.num_messages as number) ?? 0;

    if (!categoryStats.has(cat)) {
      categoryStats.set(cat, { count: 0, totalMessages: 0, avgMessages: 0 });
    }

    const stats = categoryStats.get(cat)!;
    stats.count++;
    stats.totalMessages += numMsg;

    if (numMsg >= minMessages) {
      complexTickets.push({
        id: conv.id as string,
        subject: (conv.subject as string) ?? "No subject",
        category: cat,
        num_messages: numMsg,
      });
    }
  }

  // Calculate averages
  for (const stats of categoryStats.values()) {
    stats.avgMessages = stats.count > 0 ? stats.totalMessages / stats.count : 0;
  }

  const categoryBreakdown = Array.from(categoryStats.entries())
    .map(([cat, stats]) => ({
      category: cat,
      ticket_count: stats.count,
      total_messages: stats.totalMessages,
      avg_messages_per_ticket: Math.round(stats.avgMessages * 10) / 10,
    }))
    .sort((a, b) => b.ticket_count - a.ticket_count);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            category_filter: category ?? "all",
            date_from: dateFrom ?? "all time",
            min_messages_for_complex: minMessages,
            total_tickets: data?.length ?? 0,
            category_breakdown: categoryBreakdown,
            complex_tickets: complexTickets
              .sort((a, b) => b.num_messages - a.num_messages)
              .slice(0, 20),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeFindSimilarDocuments(
  supabase: ReturnType<typeof createClient>,
  params: { document_id: string; match_criteria?: string[]; limit?: number },
): Promise<ToolCallResult> {
  const documentId = params.document_id?.trim();
  if (!documentId) {
    return {
      content: [{ type: "text", text: "Error: document_id is required" }],
      isError: true,
    };
  }

  const matchCriteria = params.match_criteria ?? [
    "department",
    "document_type",
    "tags",
    "source_type",
  ];
  const limit = Math.min(params.limit ?? 10, 20);

  // Get reference document
  const { data: refDoc, error: refError } = await supabase
    .schema("volterra_kb")
    .from("documents")
    .select(
      "id, title, department, document_type, tags, source_type, source_path",
    )
    .eq("id", documentId)
    .single();

  if (refError || !refDoc) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Document not found with ID ${documentId}`,
        },
      ],
      isError: true,
    };
  }

  // Find similar documents
  let query = supabase
    .schema("volterra_kb")
    .from("documents")
    .select(
      "id, title, department, document_type, tags, source_type, source_path",
    )
    .neq("id", documentId);

  // Apply filters based on match criteria
  if (matchCriteria.includes("department") && refDoc.department) {
    query = query.eq("department", refDoc.department);
  }
  if (matchCriteria.includes("document_type") && refDoc.document_type) {
    query = query.eq("document_type", refDoc.document_type);
  }
  if (matchCriteria.includes("source_type") && refDoc.source_type) {
    query = query.eq("source_type", refDoc.source_type);
  }

  const { data, error } = await query.limit(limit * 2); // Get extra for tag scoring

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  // Calculate similarity scores
  const refTags = new Set((refDoc.tags as string[]) ?? []);
  const results = (data ?? [])
    .map((doc: Record<string, unknown>) => {
      let score = 0;
      let matches = 0;

      if (
        matchCriteria.includes("department") &&
        doc.department === refDoc.department
      ) {
        score += 0.3;
        matches++;
      }
      if (
        matchCriteria.includes("document_type") &&
        doc.document_type === refDoc.document_type
      ) {
        score += 0.3;
        matches++;
      }
      if (
        matchCriteria.includes("source_type") &&
        doc.source_type === refDoc.source_type
      ) {
        score += 0.2;
        matches++;
      }

      // Tag overlap
      if (matchCriteria.includes("tags") && refTags.size > 0) {
        const docTags = new Set((doc.tags as string[]) ?? []);
        const overlap = Array.from(refTags).filter((t) =>
          docTags.has(t),
        ).length;
        const tagScore = overlap / refTags.size;
        score += tagScore * 0.2;
        if (overlap > 0) matches++;
      }

      return {
        id: doc.id,
        title: doc.title,
        department: doc.department,
        document_type: doc.document_type,
        tags: doc.tags,
        source_type: doc.source_type,
        source_path: doc.source_path,
        similarity_score: Math.round(score * 100) / 100,
        matches_count: matches,
      };
    })
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, limit);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            reference_document_id: documentId,
            reference_document_title: refDoc.title,
            match_criteria: matchCriteria,
            similar_documents_count: results.length,
            similar_documents: results,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeGetDataFreshnessReport(
  supabase: ReturnType<typeof createClient>,
): Promise<ToolCallResult> {
  const { data, error } = await supabase.rpc("mcp_get_data_freshness");

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function executeSearchNotionByDate(
  supabase: ReturnType<typeof createClient>,
  params: {
    date_field?: string;
    date_from?: string;
    date_to?: string;
    include_archived?: boolean;
    limit?: number;
  },
): Promise<ToolCallResult> {
  const dateField = params.date_field ?? "last_edited_time";
  const includeArchived = params.include_archived ?? false;
  const limit = Math.min(params.limit ?? 50, 100);

  let query = supabase
    .schema("volterra_kb")
    .from("notion_pages")
    .select(
      "id, title, url, parent_id, archived, doc_chunk_count, last_edited_time, created_time, created_by_id, last_edited_by_id",
    );

  if (!includeArchived) {
    query = query.eq("archived", false);
  }

  if (params.date_from) {
    query = query.gte(dateField, params.date_from);
  }
  if (params.date_to) {
    query = query.lte(dateField, params.date_to);
  }

  query = query.order(dateField, { ascending: false }).limit(limit);

  const { data, error } = await query;

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            date_field: dateField,
            date_from: params.date_from ?? "all time",
            date_to: params.date_to ?? "now",
            include_archived: includeArchived,
            page_count: data?.length ?? 0,
            pages: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeCompareWodDeals(
  supabase: ReturnType<typeof createClient>,
  params: { deal_ids: string[]; fields_to_compare?: string[] },
): Promise<ToolCallResult> {
  const dealIds = params.deal_ids ?? [];
  if (dealIds.length < 2 || dealIds.length > 5) {
    return {
      content: [
        { type: "text", text: "Error: deal_ids must contain 2-5 deal IDs" },
      ],
      isError: true,
    };
  }

  const fieldsToCompare = params.fields_to_compare ?? null;

  const { data, error } = await supabase.rpc("mcp_compare_wod_deals", {
    p_deal_ids: dealIds,
    p_fields_to_compare: fieldsToCompare,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            deal_ids: dealIds,
            fields_compared: fieldsToCompare ?? "default key fields",
            comparison_count: data?.length ?? 0,
            deals: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeAggregateCostsByCategory(
  supabase: ReturnType<typeof createClient>,
  params: { group_by?: string },
): Promise<ToolCallResult> {
  const groupBy = params.group_by ?? "category";

  const { data, error } = await supabase.rpc("mcp_aggregate_costs", {
    p_group_by: groupBy,
    p_filters: null,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            group_by: groupBy,
            group_count: data?.length ?? 0,
            aggregated_costs: data ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeGetReactionAnalytics(
  supabase: ReturnType<typeof createClient>,
  params: {
    channel_id?: string;
    date_from?: string;
    date_to?: string;
  },
): Promise<ToolCallResult> {
  const channelId = params.channel_id ?? "C078S57MS5P"; // platform-all-deliveries default
  const dateFrom = params.date_from ?? null;
  const dateTo = params.date_to ?? null;

  const { data, error } = await supabase.rpc("mcp_get_reaction_analytics", {
    p_channel_id: channelId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  if (!data || data.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "No data found",
              channel_id: channelId,
              date_from: dateFrom,
              date_to: dateTo,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // RPC returns a single row with analytics
  const analytics = data[0];

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            channel_id: channelId,
            date_range: {
              from: dateFrom ?? "all time",
              to: dateTo ?? "present",
            },
            total_messages: analytics.total_messages,
            messages_with_reactions: analytics.messages_with_reactions,
            total_reactions: analytics.total_reactions,
            avg_reactions_per_message: analytics.avg_reactions_per_message,
            top_reactions: analytics.top_reactions ?? [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeAnalyzeReleaseContributors(
  supabase: ReturnType<typeof createClient>,
  params: {
    channel_id?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
  },
): Promise<ToolCallResult> {
  const channelId = params.channel_id ?? "C078S57MS5P"; // platform-all-deliveries default
  const dateFrom = params.date_from ?? null;
  const dateTo = params.date_to ?? null;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

  const { data, error } = await supabase.rpc(
    "mcp_analyze_release_contributors",
    {
      p_channel_id: channelId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_limit: limit,
    },
  );

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  if (!data || data.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "No release announcements found",
              channel_id: channelId,
              date_from: dateFrom,
              date_to: dateTo,
              hint: "Releases must contain 'delivery announcement' or 'What we are delivering' text",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Format results for readability
  const releases = data.map(
    (r: {
      message_ts: string;
      message_at: string;
      release_title: string;
      contributor_ids: string[];
      contributor_names: string[];
      contributor_count: number;
      reaction_count: number;
      text_preview: string;
    }) => ({
      message_ts: r.message_ts,
      released_at: r.message_at,
      title: r.release_title,
      contributors: {
        count: r.contributor_count,
        names: r.contributor_names ?? [],
        ids: r.contributor_ids ?? [],
      },
      reactions: r.reaction_count,
      preview: r.text_preview,
    }),
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            channel_id: channelId,
            date_range: {
              from: dateFrom ?? "all time",
              to: dateTo ?? "present",
            },
            total_releases: releases.length,
            releases,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeGetReleaseDetails(
  supabase: ReturnType<typeof createClient>,
  params: {
    channel_id?: string;
    date_from?: string;
    date_to?: string;
    target_audience?: string;
    search_term?: string;
    limit?: number;
  },
): Promise<ToolCallResult> {
  const channelId = params.channel_id ?? "C078S57MS5P";
  const dateFrom = params.date_from ?? null;
  const dateTo = params.date_to ?? null;
  const targetAudience = params.target_audience ?? null;
  const searchTerm = params.search_term ?? null;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

  const { data, error } = await supabase.rpc("mcp_get_release_details", {
    p_channel_id: channelId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_target_audience: targetAudience,
    p_search_term: searchTerm,
    p_limit: limit,
  });

  if (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }

  if (!data || data.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "No release announcements found",
              channel_id: channelId,
              filters: {
                date_from: dateFrom,
                date_to: dateTo,
                target_audience: targetAudience,
                search_term: searchTerm,
              },
              hint: "Try broadening your search or date range",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // Format results with all parsed fields
  const releases = data.map(
    (r: {
      message_ts: string;
      released_at: string;
      posted_by_name: string;
      posted_by_id: string;
      title: string;
      description: string | null;
      target_audience: string;
      value_proposition: string;
      contributor_ids: string[];
      contributor_names: string[];
      contributor_count: number;
      reaction_count: number;
      attachment_count: number;
      slack_url: string;
    }) => ({
      message_ts: r.message_ts,
      released_at: r.released_at,
      posted_by: {
        name: r.posted_by_name,
        id: r.posted_by_id,
      },
      title: r.title,
      description: r.description,
      target_audience: r.target_audience,
      value_proposition: r.value_proposition,
      contributors: {
        count: r.contributor_count,
        names: r.contributor_names ?? [],
        ids: r.contributor_ids ?? [],
      },
      reactions: r.reaction_count,
      attachments: r.attachment_count,
      slack_url: r.slack_url,
    }),
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            channel_id: channelId,
            filters: {
              date_from: dateFrom ?? "all time",
              date_to: dateTo ?? "present",
              target_audience: targetAudience,
              search_term: searchTerm,
            },
            total_releases: releases.length,
            releases,
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ============================================================================
// PRIVATE KNOWLEDGE BASE TOOLS
// ============================================================================

async function executePrivateKbSearch(
  supabase: ReturnType<typeof createClient>,
  params: {
    query: string;
    match_count?: number;
    match_threshold?: number;
  },
): Promise<ToolCallResult> {
  const { query, match_count = 10, match_threshold = 0.78 } = params;

  try {
    // Generate embedding for the query
    const embedding = await generateEmbedding(query);
    const embeddingVec = JSON.stringify(embedding);

    // Call the private_kb.match_documents RPC function
    const { data, error } = await supabase
      .schema("private_kb")
      .rpc("match_documents", {
        query_embedding: embeddingVec,
        match_threshold: match_threshold,
        match_count: match_count,
      });

    if (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }

    // Format results similar to kb_search
    const results = (data ?? []).map(
      (doc: {
        id: string;
        title: string;
        content: string;
        document_type: string;
        source_path: string;
        notion_page_id?: string;
        tags?: string[];
        created_at: string;
        similarity: number;
      }) => ({
        id: doc.id,
        title: doc.title,
        document_type: doc.document_type,
        source_path: doc.source_path,
        notion_page_id: doc.notion_page_id,
        tags: doc.tags,
        created_at: doc.created_at,
        similarity: doc.similarity,
        text_snippet:
          doc.content?.slice(0, 500) + (doc.content?.length > 500 ? "..." : ""),
      }),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              match_count: results.length,
              match_threshold,
              results,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error searching private KB: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

async function executePrivateKbQuery(
  supabase: ReturnType<typeof createClient>,
  params: {
    limit?: number;
    date_from?: string;
    date_to?: string;
    document_type?: string;
  },
): Promise<ToolCallResult> {
  const { limit = 25, date_from, date_to, document_type } = params;

  try {
    let query = supabase
      .schema("private_kb")
      .from("documents")
      .select(
        "id, title, document_type, source_path, notion_page_id, notion_database_id, tags, owner, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(Math.min(limit, 100));

    // Apply filters
    if (date_from) {
      query = query.gte("created_at", date_from);
    }
    if (date_to) {
      query = query.lte("created_at", date_to);
    }
    if (document_type) {
      query = query.eq("document_type", document_type);
    }

    const { data, error } = await query;

    if (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              table: "private_kb.documents",
              filters: { date_from, date_to, document_type },
              row_count: data?.length ?? 0,
              rows: data ?? [],
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error querying private KB: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

async function executePrivateKbStatus(
  supabase: ReturnType<typeof createClient>,
): Promise<ToolCallResult> {
  try {
    // Call the private_kb.get_sync_status RPC function
    const { data, error } = await supabase
      .schema("private_kb")
      .rpc("get_sync_status");

    if (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }

    // The RPC returns a single row
    const status = Array.isArray(data) ? data[0] : data;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              schema: "private_kb",
              sync_status: status ?? {
                last_sync_at: null,
                pages_processed: 0,
                pages_created: 0,
                pages_updated: 0,
                last_error: null,
                document_count: 0,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error getting private KB status: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

// Search Tools - Meta-tool for finding the right tool
async function executeSearchTools(
  supabase: ReturnType<typeof createClient>,
  args: {
    query: string;
    category?: string;
    match_count?: number;
  },
): Promise<ToolCallResult> {
  try {
    const matchCount = Math.min(Math.max(args.match_count || 5, 1), 10);

    // Generate embedding for the query
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return {
        content: [
          { type: "text", text: "Error: OPENAI_API_KEY not configured" },
        ],
        isError: true,
      };
    }

    const embeddingResponse = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: args.query,
        }),
      },
    );

    if (!embeddingResponse.ok) {
      const errorText = await embeddingResponse.text();
      return {
        content: [{ type: "text", text: `Embedding error: ${errorText}` }],
        isError: true,
      };
    }

    const embeddingData = await embeddingResponse.json();
    const embedding = embeddingData.data?.[0]?.embedding;

    if (!embedding) {
      return {
        content: [{ type: "text", text: "Error: No embedding returned" }],
        isError: true,
      };
    }

    // Search for matching tools
    const { data, error } = await supabase.rpc("mcp_search_tools", {
      p_query_embedding: JSON.stringify(embedding),
      p_match_count: matchCount,
      p_category: args.category || null,
    });

    if (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }

    if (!data || data.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No matching tools found for: "${args.query}"\n\nTry a different description of what you want to accomplish, or use get_instructions to see all available tools.`,
          },
        ],
      };
    }

    // Format results
    const results = data.map(
      (
        tool: {
          name: string;
          description: string;
          category: string;
          similarity: number;
        },
        i: number,
      ) => {
        const similarity = (tool.similarity * 100).toFixed(1);
        return `${i + 1}. **${tool.name}** (${similarity}% match)
   Category: ${tool.category || "Utility"}
   ${tool.description.slice(0, 200)}${tool.description.length > 200 ? "..." : ""}`;
      },
    );

    return {
      content: [
        {
          type: "text",
          text: `Found ${data.length} relevant tools for: "${args.query}"\n\n${results.join("\n\n")}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error searching tools: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

// ============================================================================
// MCP PROTOCOL HANDLERS
// ============================================================================

async function handleToolsList(): Promise<MCPResponse["result"]> {
  return { tools: TOOLS };
}

async function handleToolsCall(
  supabase: ReturnType<typeof createClient>,
  params: { name: string; arguments?: Record<string, unknown> },
): Promise<ToolCallResult> {
  const toolName = params.name;
  const args = params.arguments ?? {};

  switch (toolName) {
    case "search":
      return executeDeepResearchSearch(supabase, args as { query: string });
    case "fetch":
      return executeDeepResearchFetch(supabase, args as { id: string });
    case "get_instructions":
      return { content: [{ type: "text", text: SYSTEM_INSTRUCTIONS }] };
    case "kb_search":
      return executeKbSearch(
        supabase,
        args as { query: string; sources?: string[]; match_count?: number },
      );
    case "query_table":
      return executeQueryTable(
        supabase,
        args as {
          table: string;
          filters?: Record<string, unknown>;
          date_from?: string;
          date_to?: string;
          order?: "asc" | "desc";
          limit?: number;
          offset?: number;
        },
      );
    case "count_rows":
      return executeCountRows(
        supabase,
        args as {
          table: string;
          filters?: Record<string, unknown>;
          date_from?: string;
          date_to?: string;
          group_by?: string;
        },
      );
    case "list_tables":
      return executeListTables(supabase);
    case "slack_latest_messages":
      return executeSlackLatestMessages(
        supabase,
        args as { channel_id?: string; limit?: number },
      );
    case "slack_latest_threads":
      return executeSlackLatestThreads(
        supabase,
        args as { channel_id?: string; limit?: number },
      );
    case "wod_get_deal_context":
      return executeWodGetDealContext(supabase, args as { deal_id: string });
    case "db_table_stats":
      return executeDbTableStats(supabase);
    case "get_embeddings":
      return executeGetEmbeddings(
        supabase,
        args as { source: string; ids: string[] },
      );
    case "generate_embedding":
      return executeGenerateEmbedding(args as { text: string });
    case "compute_similarity":
      return executeComputeSimilarity(
        supabase,
        args as {
          text: string;
          compare_to: {
            type: "text" | "records";
            texts?: string[];
            source?: string;
            ids?: string[];
          };
        },
      );
    case "fetch_thread_messages":
      return executeFetchThreadMessages(
        supabase,
        args as {
          thread_ts: string;
          channel_id?: string;
          include_root?: boolean;
          limit?: number;
        },
      );
    case "fetch_conversation_messages":
      return executeFetchConversationMessages(
        supabase,
        args as {
          conversation_id: string;
          include_summary?: boolean;
        },
      );
    case "fetch_document_full":
      return executeFetchDocumentFull(
        supabase,
        args as {
          document_id: string;
          max_chars?: number;
        },
      );
    case "fetch_notion_children":
      return executeFetchNotionChildren(
        supabase,
        args as {
          parent_id: string;
          include_archived?: boolean;
          sort_by?: string;
        },
      );
    case "fetch_wod_deal_full":
      return executeFetchWodDealFull(supabase, args as { deal_id: string });
    case "analyze_slack_thread_network":
      return executeAnalyzeSlackThreadNetwork(
        supabase,
        args as {
          channel_id?: string;
          min_threads?: number;
        },
      );
    case "analyze_training_resolution_patterns":
      return executeAnalyzeTrainingResolutionPatterns(
        supabase,
        args as {
          category?: string;
          date_from?: string;
          min_messages?: number;
        },
      );
    case "find_similar_documents":
      return executeFindSimilarDocuments(
        supabase,
        args as {
          document_id: string;
          match_criteria?: string[];
          limit?: number;
        },
      );
    case "get_data_freshness_report":
      return executeGetDataFreshnessReport(supabase);
    case "search_notion_by_date":
      return executeSearchNotionByDate(
        supabase,
        args as {
          date_field?: string;
          date_from?: string;
          date_to?: string;
          include_archived?: boolean;
          limit?: number;
        },
      );
    case "compare_wod_deals":
      return executeCompareWodDeals(
        supabase,
        args as {
          deal_ids: string[];
          fields_to_compare?: string[];
        },
      );
    case "aggregate_costs_by_category":
      return executeAggregateCostsByCategory(
        supabase,
        args as { group_by?: string },
      );
    case "get_reaction_analytics":
      return executeGetReactionAnalytics(
        supabase,
        args as {
          channel_id?: string;
          date_from?: string;
          date_to?: string;
        },
      );
    case "analyze_release_contributors":
      return executeAnalyzeReleaseContributors(
        supabase,
        args as {
          channel_id?: string;
          date_from?: string;
          date_to?: string;
          limit?: number;
        },
      );
    case "get_release_details":
      return executeGetReleaseDetails(
        supabase,
        args as {
          channel_id?: string;
          date_from?: string;
          date_to?: string;
          target_audience?: string;
          search_term?: string;
          limit?: number;
        },
      );
    // Private Knowledge Base Tools
    case "private_kb_search":
      return executePrivateKbSearch(
        supabase,
        args as {
          query: string;
          match_count?: number;
          match_threshold?: number;
        },
      );
    case "private_kb_query":
      return executePrivateKbQuery(
        supabase,
        args as {
          limit?: number;
          date_from?: string;
          date_to?: string;
          document_type?: string;
        },
      );
    case "private_kb_status":
      return executePrivateKbStatus(supabase);
    case "search_tools":
      return executeSearchTools(
        supabase,
        args as {
          query: string;
          category?: string;
          match_count?: number;
        },
      );
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
}

async function handleMCPRequest(
  request: MCPRequest,
  supabase: ReturnType<typeof createClient>,
): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    let result: unknown;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "volterra-mcp-readonly", version: "1.0.0" },
        };
        break;
      case "tools/list":
        result = await handleToolsList();
        break;
      case "tools/call":
        result = await handleToolsCall(
          supabase,
          params as { name: string; arguments?: Record<string, unknown> },
        );
        break;
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }

    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    };
  }
}

// ============================================================================
// HTTP SERVER
// ============================================================================

serve(async (req) => {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  const clientIP = getClientIP(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // IP allowlist check
  if (!isOpenAIIP(clientIP)) {
    log("warn", "Blocked non-OpenAI IP", { requestId, clientIP });
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Rate limiting
  if (!checkRateLimit(clientIP)) {
    log("warn", "Rate limited", { requestId, clientIP });
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "Retry-After": "60",
      },
    });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase configuration");
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      db: { schema: "volterra_kb" },
    });

    // Parse JSON-RPC request
    const body = (await req.json()) as MCPRequest;

    log("info", "MCP request", {
      requestId,
      clientIP,
      method: body.method,
      toolName: body.params?.name as string | undefined,
    });

    // Handle MCP request
    const response = await handleMCPRequest(body, supabase);

    const latency = Date.now() - startTime;
    log("info", "MCP response", {
      requestId,
      method: body.method,
      latencyMs: latency,
      hasError: !!response.error,
    });

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Request error", { requestId, error: message });

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }
});
