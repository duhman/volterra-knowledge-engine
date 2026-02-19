#!/usr/bin/env npx tsx
/**
 * Populate MCP Tools Table
 *
 * Extracts tool definitions from the MCP server and stores them
 * in volterra_kb.mcp_tools with embeddings for semantic search.
 *
 * Usage:
 *   npm run mcp:populate-tools
 *
 * This enables:
 * - Semantic search to find the right tool for a user query
 * - Better tool selection accuracy when tool count > 30
 */

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import "dotenv/config";

// Tool definitions extracted from mcp-readonly/index.ts
// Category mappings based on SYSTEM_INSTRUCTIONS
const TOOL_CATEGORIES: Record<string, string> = {
  // Deep Research compatibility
  search: "Deep Research",
  fetch: "Deep Research",

  // Primary Search
  get_instructions: "Utility",
  kb_search: "Primary Search",

  // Data Browsing
  query_table: "Data Browsing",
  count_rows: "Data Browsing",
  list_tables: "Data Browsing",
  db_table_stats: "Data Browsing",

  // Slack-Specific
  slack_latest_messages: "Slack-Specific",
  slack_latest_threads: "Slack-Specific",

  // WoD-Specific
  wod_get_deal_context: "WoD-Specific",

  // Embedding Tools
  get_embeddings: "Embedding Tools",
  generate_embedding: "Embedding Tools",
  compute_similarity: "Embedding Tools",

  // Relationship Traversal
  fetch_thread_messages: "Relationship Traversal",
  fetch_conversation_messages: "Relationship Traversal",
  fetch_document_full: "Relationship Traversal",
  fetch_notion_children: "Relationship Traversal",
  fetch_wod_deal_full: "Relationship Traversal",

  // Analytics & Insights
  analyze_slack_thread_network: "Analytics",
  get_reaction_analytics: "Analytics",
  analyze_training_resolution_patterns: "Analytics",
  find_similar_documents: "Analytics",
  get_data_freshness_report: "Analytics",
  search_notion_by_date: "Analytics",
  compare_wod_deals: "Analytics",
  aggregate_costs_by_category: "Analytics",
  analyze_release_contributors: "Analytics",
  get_release_details: "Analytics",

  // Private KB
  private_kb_search: "Private KB",
  private_kb_query: "Private KB",
  private_kb_status: "Private KB",
};

// Tool definitions - extracted from mcp-readonly/index.ts
// We use a simplified description for embedding (first sentence + key phrases)
interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

const TOOLS: ToolDef[] = [
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
    description:
      "Fetch FULL content for a specific result found via search or kb_search. Returns complete, untruncated text with all metadata. Use after finding a document, training conversation, Slack thread, or WoD deal to get full details.",
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
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kb_search",
    description:
      "PRIMARY entry point for semantic search across ALL knowledge sources. Find information using natural language. Searches documents, training conversations, Slack messages, and WoD deals in parallel. Use for any 'find', 'search', 'what does Volterra say about', or 'how do we handle' query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        sources: {
          type: "array",
          description: "Optional: limit to specific sources",
        },
        match_count: { type: "integer", description: "Max results per source" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_table",
    description:
      "Browse or filter data from a specific table. SQL SELECT equivalent. Use for date-based filtering, specific column queries, or when you know the table name. Available tables: documents, training_conversations, slack_messages, slack_threads, wod_deals, and more.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name to query" },
        filters: { type: "object", description: "Key-value filters" },
        date_from: { type: "string", description: "Filter by date" },
        limit: { type: "integer", description: "Max rows" },
      },
      required: ["table"],
    },
  },
  {
    name: "count_rows",
    description:
      "Get statistics, aggregations, or analytics. Use for 'how many', 'total', 'breakdown by category', or trend analysis. Supports group_by for breakdowns.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
        group_by: { type: "string", description: "Column to group by" },
        filters: { type: "object", description: "Optional filters" },
      },
      required: ["table"],
    },
  },
  {
    name: "list_tables",
    description:
      "Discover available data sources, understand table schemas, see data volume. Shows all 14 tables with columns and row counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slack_latest_messages",
    description:
      "Get RECENT Slack activity, time-ordered (not semantic). Use for 'what's happening now', 'latest discussions', recent messages from #help-me-platform or other channels.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        limit: { type: "integer", description: "Number of messages" },
      },
    },
  },
  {
    name: "slack_latest_threads",
    description:
      "Get RECENT Slack thread summaries, time-ordered. Use for 'what threads are active', 'recent discussions', ongoing conversations with reply counts and participant info.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        limit: { type: "integer", description: "Number of threads" },
      },
    },
  },
  {
    name: "wod_get_deal_context",
    description:
      "Get COMPLETE WoD (Wheel of Deal) deal information including all circuits, costs, and offers. Primary tool for deal analysis with 42 fields covering facility, infrastructure, pricing, margins, and fees.",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string", description: "UUID of the WoD deal" },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "db_table_stats",
    description:
      "Quick overview of data volume across all tables. Shows row counts for all 14 tables including documents, conversations, messages, deals.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_embeddings",
    description:
      "Get raw 1536-dimensional embedding vectors for advanced analysis like clustering, custom similarity, or external processing. Max 10 records per call.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Table name" },
        ids: { type: "array", description: "Record IDs" },
      },
      required: ["source", "ids"],
    },
  },
  {
    name: "generate_embedding",
    description:
      "Convert arbitrary text into an embedding vector for comparison against stored embeddings. Returns 1536-dimensional vector from text-embedding-3-small model.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to embed" },
      },
      required: ["text"],
    },
  },
  {
    name: "compute_similarity",
    description:
      "Get precise similarity scores between texts or between text and stored records. Supports text-to-text (up to 5) or text-to-records (up to 10) comparison using cosine similarity.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Query text" },
        compare_to: { type: "object", description: "What to compare against" },
      },
      required: ["text", "compare_to"],
    },
  },
  {
    name: "fetch_thread_messages",
    description:
      "Get COMPLETE Slack thread context with all messages (not just summaries). Returns up to 200 messages in chronological order with full text, user names, timestamps, and file attachments.",
    inputSchema: {
      type: "object",
      properties: {
        thread_ts: { type: "string", description: "Thread timestamp" },
        channel_id: { type: "string", description: "Slack channel ID" },
        include_root: {
          type: "boolean",
          description: "Include root message",
        },
      },
      required: ["thread_ts"],
    },
  },
  {
    name: "fetch_conversation_messages",
    description:
      "Get COMPLETE HubSpot support ticket context with all messages and resolution. Returns up to 200 messages with full content, sender info, timestamps, and message types.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation UUID" },
        include_summary: {
          type: "boolean",
          description: "Include AI summary",
        },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "fetch_document_full",
    description:
      "Get FULL document content without truncation (up to 200K characters). Returns complete document with ALL metadata including title, department, type, sensitivity, tags.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Document UUID" },
        max_chars: {
          type: "integer",
          description: "Max characters to return",
        },
      },
      required: ["document_id"],
    },
  },
  {
    name: "fetch_notion_children",
    description:
      "Navigate Notion page hierarchy and see all child pages. Returns up to 100 child pages with title, URL, parent ID, archived status, and edit times.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: { type: "string", description: "Parent Notion page UUID" },
        include_archived: {
          type: "boolean",
          description: "Include archived pages",
        },
      },
      required: ["parent_id"],
    },
  },
  {
    name: "fetch_wod_deal_full",
    description:
      "Get COMPLETE WoD deal with ALL related data. Enhanced version with 42 deal fields plus all circuits, costs, and offers. 320% more data than basic version.",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string", description: "UUID of the WoD deal" },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "analyze_slack_thread_network",
    description:
      "Understand WHO is discussing topics, identify experts, analyze collaboration patterns in Slack. Returns participant analysis with activity metrics, thread counts, and most active channels.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Optional channel filter" },
        min_threads: {
          type: "integer",
          description: "Min thread participation",
        },
      },
    },
  },
  {
    name: "get_reaction_analytics",
    description:
      "Get REACTION ANALYTICS for Slack channels - average reactions, top emojis, engagement metrics. Use for release announcements and engagement analysis.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        date_from: { type: "string", description: "Start date" },
        date_to: { type: "string", description: "End date" },
      },
    },
  },
  {
    name: "analyze_training_resolution_patterns",
    description:
      "Understand COMMON support issues, resolution patterns, ticket trends. Returns category breakdown, common keywords, high-interaction tickets, and resolution time estimates.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional category filter" },
        date_from: { type: "string", description: "Start date" },
        min_messages: {
          type: "integer",
          description: "Min messages for complex classification",
        },
      },
    },
  },
  {
    name: "find_similar_documents",
    description:
      "Find documents similar by METADATA (department, type, tags) not semantic content. Use for organizational grouping and related document discovery.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Reference document UUID" },
        match_criteria: { type: "array", description: "Metadata fields" },
        limit: { type: "integer", description: "Max results" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "get_data_freshness_report",
    description:
      "Understand data recency, sync status, verify data currency. Returns comprehensive freshness report for Notion, Slack, HubSpot with sync times and error counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_notion_by_date",
    description:
      "Find Notion pages by TEMPORAL criteria (created/edited dates). Use for 'pages created this week', 'recent updates', 'old pages not updated in 6 months'.",
    inputSchema: {
      type: "object",
      properties: {
        date_field: {
          type: "string",
          description: "created_time or last_edited_time",
        },
        date_from: { type: "string", description: "From date" },
        date_to: { type: "string", description: "To date" },
        include_archived: { type: "boolean", description: "Include archived" },
        limit: { type: "integer", description: "Max pages" },
      },
    },
  },
  {
    name: "compare_wod_deals",
    description:
      "SIDE-BY-SIDE comparison of multiple WoD deals across financial/technical dimensions. Compare 2-5 deals showing parking spaces, chargers, power level, costs, pricing, margins.",
    inputSchema: {
      type: "object",
      properties: {
        deal_ids: { type: "array", description: "Array of 2-5 deal IDs" },
        fields_to_compare: { type: "array", description: "Specific fields" },
      },
      required: ["deal_ids"],
    },
  },
  {
    name: "aggregate_costs_by_category",
    description:
      "WoD cost AGGREGATION, analytics, spend breakdown. Returns grouped data with total cost, labor cost, material cost, item count by category or deal.",
    inputSchema: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          description: "category, deal_id, or item_name",
        },
      },
    },
  },
  {
    name: "private_kb_search",
    description:
      "Search PRIVATE content like meeting transcriptions, personal notes, confidential documents. Searches isolated private_kb schema, completely separate from shared volterra_kb.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        match_count: { type: "integer", description: "Max results" },
        match_threshold: {
          type: "number",
          description: "Similarity threshold",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "private_kb_query",
    description:
      "Browse or list private documents with filters. Use for 'recent private documents', 'private meeting transcripts', date-filtered private content.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max rows" },
        date_from: { type: "string", description: "From date" },
        document_type: { type: "string", description: "Filter by type" },
      },
    },
  },
  {
    name: "private_kb_status",
    description:
      "Check status of private knowledge base. Returns document count, sync status, and freshness information.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "analyze_release_contributors",
    description:
      "Analyze releases by CONTRIBUTOR COUNT from #platform-all-deliveries channel. Returns releases ranked by contributors with resolved display names.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        date_from: { type: "string", description: "Start date" },
        date_to: { type: "string", description: "End date" },
        limit: { type: "integer", description: "Max results" },
      },
    },
  },
  {
    name: "get_release_details",
    description:
      "Get COMPREHENSIVE release information including all announcement fields from #platform-all-deliveries. Returns title, description, target_audience, value_proposition, contributors.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Slack channel ID" },
        date_from: { type: "string", description: "Start date" },
        date_to: { type: "string", description: "End date" },
        target_audience: { type: "string", description: "Filter by audience" },
        search_term: {
          type: "string",
          description: "Search in title/description",
        },
        limit: { type: "integer", description: "Max results" },
      },
    },
  },
];

async function main() {
  // Validate environment
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!supabaseUrl || !supabaseKey || !openaiKey) {
    console.error(
      "Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY",
    );
    process.exit(1);
  }

  // Initialize clients
  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: "volterra_kb" },
  });
  const openai = new OpenAI({ apiKey: openaiKey });

  console.log(`Populating ${TOOLS.length} MCP tools with embeddings...`);

  let success = 0;
  let errors = 0;

  for (const tool of TOOLS) {
    try {
      // Build embedding text from description
      const embeddingText = `Tool: ${tool.name}. ${tool.description}`;

      // Generate embedding
      const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: embeddingText,
      });
      const embedding = response.data[0].embedding;

      // Get category
      const category = TOOL_CATEGORIES[tool.name] || "Utility";

      // Upsert into database
      const { error } = await supabase.rpc("upsert_mcp_tool", {
        p_name: tool.name,
        p_description: tool.description,
        p_category: category,
        p_input_schema: tool.inputSchema,
        p_embedding: JSON.stringify(embedding),
      });

      if (error) {
        console.error(`Error upserting ${tool.name}:`, error.message);
        errors++;
      } else {
        console.log(`✓ ${tool.name} (${category})`);
        success++;
      }
    } catch (err) {
      console.error(
        `Error processing ${tool.name}:`,
        err instanceof Error ? err.message : err,
      );
      errors++;
    }
  }

  console.log(`\nDone: ${success} succeeded, ${errors} failed`);
}

main().catch(console.error);
