# MCP Server Setup & Workflow Optimization Guide

## Overview

This guide documents the MCP (Model Context Protocol) server configurations and n8n AI Agent workflow optimizations implemented on 2025-12-19.

## MCP Server Configurations

### 1. volterra-kb (Supabase Knowledge Base)

**Purpose:** Read-only access to Volterra's complete knowledge base via 27 specialized tools.

**Endpoint:** `https://your-project.supabase.co/functions/v1/mcp-readonly`

**Available Data (Cloud Supabase):**

- ~9,657 documents
- ~17,725 training conversations (HubSpot tickets)
- ~29,926 training messages
- ~900 Slack messages
- WoD deals
- ~34 Notion pages

**Tool Catalog (27 tools):**

- `search` / `fetch` - Deep Research compatibility
- `kb_search` - Semantic search across all sources
- `query_table` - Query any whitelisted table with filters
- `count_rows` - Row counts with grouping
- `list_tables` - List available tables with schemas
- `slack_latest_messages` / `slack_latest_threads` - Time-ordered Slack queries
- `wod_get_deal_context` - Full WoD deal details
- `db_table_stats` - Row counts for all tables
- `get_embeddings` - Retrieve stored embedding vectors
- `generate_embedding` - Generate embedding for arbitrary text
- `compute_similarity` - Compare text against stored records

**Configuration for Claude Code:**

```json
{
  "mcpServers": {
    "volterra-kb": {
      "type": "http",
      "url": "https://your-project.supabase.co/functions/v1/mcp-readonly",
      "headers": {
        "Authorization": "Bearer <SUPABASE_CLOUD_ANON_KEY>"
      }
    }
  }
}
```

**Configuration for Claude Desktop:**

```json
{
  "mcpServers": {
    "volterra-kb": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://your-project.supabase.co/functions/v1/mcp-readonly",
        "--header",
        "Authorization:Bearer <SUPABASE_CLOUD_ANON_KEY>"
      ]
    }
  }
}
```

### 2. n8n-mcp (Workflow Management)

**Purpose:** Programmatic access to n8n workflow management APIs.

**Endpoint:** `https://your-n8n-instance.example.com/mcp-server/http`

**Available Operations:**

- List, get, create, update, delete workflows
- Activate/deactivate workflows
- Execute workflows
- Monitor execution status

**Configuration for Claude Code:**

```json
{
  "mcpServers": {
    "n8n-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--streamableHttp",
        "https://your-n8n-instance.example.com/mcp-server/http",
        "--header",
        "authorization:Bearer <N8N_MCP_TOKEN>"
      ]
    }
  }
}
```

## n8n AI Agent Workflow Optimizations (2025-12-19)

**Workflow:** AI agent chat (iVcW0pyvfWPPQufj)
**URL:** https://your-n8n-instance.example.com/workflow/iVcW0pyvfWPPQufj

### Changes Applied

#### 1. Enhanced System Prompt (1,639 chars)

Updated the AI Agent node with comprehensive context:

**Available Data Section:**

- Current data volumes (9,588 docs, 15,095 conversations, etc.)
- Data source descriptions

**Core Instructions:**

1. Search First, Then Fetch - Use search tools to find relevant content, then fetch\_\* tools for complete context
2. Multi-Source Synthesis - Combine documents + training conversations + Slack for comprehensive answers
3. Time-Ordered vs Semantic - Guidance on when to use time-ordered vs semantic search
4. WoD Deal Analysis - Specific instructions for deal analysis
5. Citation - Always cite sources with IDs

**Key Fields Reference:**

- Documents: title, category, content, file_type, created_at, chunk_count
- Training Conversations: title, description, resolution_summary, conversation_type, interaction_count
- Slack Messages: text, user_name, channel_name, thread_ts, timestamp, reaction_count
- WoD Deals: facility_name, country, housing_units, costs, margins, connectivity_type

#### 2. Increased Vector Store topK Values

**Before → After:**

- **Documents Vector Store:** 15 → 20 (33% increase)
- **Training Conversations:** 10 → 15 (50% increase)
- **Slack Messages:** 10 → 15 (50% increase)
- **WoD Deals:** 5 → 12 (140% increase)

**Impact:**

- Better recall for complex queries
- More comprehensive context for multi-source synthesis
- Improved ability to find relevant WoD deals with limited dataset

### Testing

Test the optimized workflow:

1. Open: https://your-n8n-instance.example.com/workflow/iVcW0pyvfWPPQufj
2. Click "Chat" button in top-right
3. Test queries:
   - "What is Norgespris?" (documents)
   - "Find customers with charging errors" (training conversations)
   - "What are recent discussions in Slack?" (slack messages)
   - "Show me WoD deals in Norway" (wod deals)
   - "How many rows in each table?" (HTTP tool)

## Verification

### Test MCP Connection

```bash
# Test volterra-kb
curl -X POST "https://your-project.supabase.co/functions/v1/mcp-readonly" \
  -H "Authorization: Bearer <SUPABASE_CLOUD_ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Expected: JSON with 27 tools listed
```

### Test Claude Code

```bash
cd /path/to/volterra-knowledge-engine
claude

# In Claude Code session:
"Search for Norgespris information using the volterra-kb MCP server"
```

### Test Claude Desktop

1. Restart Claude Desktop
2. Start new conversation
3. Ask: "Search for Norgespris information"
4. Verify MCP tools are being called

## Files Modified

### Configuration Files

- `.mcp.json` - Added volterra-kb and n8n-mcp servers
- `~/Library/Application Support/Claude/claude_desktop_config.json` - Added volterra-kb server

### Documentation Updates

- `README.md` - Added MCP Server Setup section
- `docs/mcp-openai-setup.md` - Added Claude Code and Claude Desktop sections
- `.cursor/rules/internal-mcp-readonly.mdc` - Added Claude usage section
- `.cursor/rules/n8n-supabase-mcp.mdc` - Added optimization details and n8n-mcp config

### Database Fixes

- `supabase/migrations/20241201002000_fix_data_freshness.sql` - Fixed mcp_get_data_freshness function

## Next Steps

### For Future Workflow Updates

When updating the AI Agent workflow:

1. Export current workflow:

   ```bash
   npm run n8n get -- iVcW0pyvfWPPQufj --json > workflow.json
   ```

2. Modify workflow JSON (be careful with settings validation)

3. Update workflow:
   ```bash
   npm run n8n update -- iVcW0pyvfWPPQufj workflow.json
   ```

**Note:** Avoid including non-standard settings like `availableInMCP` or `timeSavedMode` in update payloads, as n8n's API validation may reject them.

### For Adding New MCP Tools

1. Update Edge Function: `supabase/functions/mcp-readonly/index.ts`
2. Add RPC functions if needed: `src/database/migrations/*.sql`
3. Test with curl before deploying
4. Update documentation: `.cursor/rules/internal-mcp-readonly.mdc`

### For Data Updates

The system prompt references current data volumes. Update when:

- Running major ingestion batches
- Syncing new data sources
- Data counts change significantly (>10%)

Check current counts:

```sql
SELECT
  (SELECT count(*) FROM documents) as docs,
  (SELECT count(*) FROM training_conversations) as conversations,
  (SELECT count(*) FROM slack_messages) as slack,
  (SELECT count(*) FROM wod_deals) as wod_deals,
  (SELECT count(*) FROM notion_pages WHERE NOT archived) as notion;
```

## References

- MCP Specification: https://modelcontextprotocol.io/
- n8n MCP Docs: https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/
- n8n REST API: https://docs.n8n.io/api/
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Claude Code Docs: https://docs.anthropic.com/claude/docs/claude-code

## Security Notes

### Cloud Supabase vs Self-Hosted

**volterra-kb MCP now uses Cloud Supabase** (`your-supabase-project-id.supabase.co`), not self-hosted.

| Component                       | URL                                                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| volterra-kb MCP                   | `https://your-project.supabase.co/functions/v1/mcp-readonly` |
| Self-hosted (personal projects) | `https://your-server.example.com`                                     |

### IP Allowlisting (Production)

For production Cloud Supabase, configure via Supabase Dashboard > Edge Functions > Settings.

### Rate Limiting

Current limits:

- 60 requests/minute per source IP (in-memory, resets on cold start)
- Hard caps on result counts (10-50 depending on tool)

### Authentication

- MCP servers use Supabase anon key (limited RLS permissions)
- n8n MCP uses API token (scoped to workflow operations)
- Both use HTTPS for transport security

## Troubleshooting

### MCP Connection Issues

**"401 Unauthorized"**

- Verify anon key is correct
- Check Authorization header format (`Bearer <key>`)

**"Tools not appearing"**

- Restart Claude Desktop
- Verify `.mcp.json` syntax
- Check Supabase Edge Function logs

### Workflow Update Errors

**"must NOT have additional properties"**

- Remove custom settings fields (`availableInMCP`, `timeSavedMode`)
- Only send standard workflow fields (name, nodes, connections, settings)

**"Workflow not found"**

- Verify workflow ID is correct
- Check workflow is not archived

### Search Issues

**"No results"**

- Check match threshold (default: 0.5 for documents)
- Verify embeddings exist in source table
- Review Edge Function logs for RPC errors

**"Timeout"**

- Reduce match_count parameter
- Check database performance
- Review query complexity
