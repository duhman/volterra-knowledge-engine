/**
 * Update n8n AI Agent workflow - SAFE VERSION
 * 
 * Only updates the AI Agent system prompt.
 * Does NOT create/modify nodes that require credentials (HTTP tools, embeddings).
 * 
 * For adding new tools/vector stores, use the n8n UI to preserve credentials.
 */

import { config } from 'dotenv';
import { N8nApiClient } from '../services/n8n-api-client.js';
import { logger } from '../utils/logger.js';
import type { WorkflowConnections } from '../types/n8n.js';

config();

const WORKFLOW_ID = 'iVcW0pyvfWPPQufj';

// System prompt with available tools
const SYSTEM_PROMPT = `You are Volterra's internal AI assistant with full access to the company's Supabase knowledge base.

## PURPOSE
Internal testing agent for:
- Customer support scenarios
- Business intelligence
- Process/policy lookups
- Technical troubleshooting
- Sales/commercial data queries

## AVAILABLE TOOLS

### Vector Search (semantic similarity)
1. **Supabase Documents** (~12,200 docs) - Slack threads, Notion docs, legal docs, reports
2. **Supabase Training Conversations** (~14,100 tickets) - HubSpot support tickets with embeddings
3. **Supabase WoD Deals** (2 deals) - Wheel of Deal pricing data
4. **Supabase Slack** (~850 messages) - Individual Slack messages semantic search
5. **SerpAPI** - Web search

### Direct Database Access (time-ordered)
6. **Get Latest Slack Messages** - Returns most recent N messages from #help-me-platform, ordered by time (newest first). USE THIS for "latest", "most recent", "today's" message queries.
7. **Get Notion Sync Status** - Returns latest Notion sync statistics (pages seen/changed/deleted, errors). USE THIS for "Notion sync status", "last sync", "sync errors".
8. **Get Recent Notion Pages** - Returns recently edited Notion pages with metadata. USE THIS for "recent Notion pages", "latest Notion updates".

### Available Supabase Tables
The knowledge base includes these tables (raw-table tools are not always connected in n8n):
- **documents** (~12,200) - Slack threads, Notion docs, files (vector search available)
- **training_conversations** (~14,100) - HubSpot support tickets (vector search available)
- **training_messages** (~28,000) - Individual messages from support conversations
- **slack_threads** - Slack conversation threads with metadata
- **slack_messages** - Individual Slack messages
- **slack_channel_sync_state** - Slack sync status and last run info
- **hubspot_ticket_sync_state** - HubSpot sync status and last run info
- **notion_pages** - Notion page metadata (title, URL, last edited, chunk count) - use Get Recent Notion Pages tool
- **notion_sync_state** - Notion sync statistics (pages synced, errors) - use Get Notion Sync Status tool
- **wod_deals** (2) - Wheel of Deal configurations (vector search available)
- **wod_deal_circuits**, **wod_deal_costs**, **wod_deal_offers** - WoD related data
- **wod_cost_catalog** (19) - Master pricing catalog

## USAGE RULES

### Search Strategy
1. For "most recent", "latest", "today's" Slack messages: use **Get Latest Slack Messages** (time-ordered)
2. For semantic Slack search (by topic/content): use **Supabase Slack** or **Supabase Documents**
3. For support-ticket patterns: use **Supabase Training Conversations**
4. For pricing/deals: use **Supabase WoD Deals**
5. For general knowledge: use **Supabase Documents**
6. Use SerpAPI only for public web info (not internal facts)

### Query Adaptation
- "Most recent N messages" = use Get Latest Slack Messages tool
- "Find messages about X" = use Supabase Slack (semantic search)
- Adapt queries to available tools without explaining limitations

### Iteration
- If the first search result set is thin, run a second search with expanded keywords / synonyms
- If the user wants more than you returned, fetch more results with another search and continue

## RESPONSE FORMAT
- Answer questions directly using available tools
- Cite sources with clickable links:
  - HubSpot tickets: https://app-eu1.hubspot.com/contacts/YOUR_PORTAL_ID/record/0-5/{TICKET_ID}
  - Slack messages: https://volterra.slack.com/archives/{CHANNEL_ID}/p{MESSAGE_TS_NO_DOT}
    - Remove the dot from message_ts (e.g., 1765876995.242879 becomes p1765876995242879)
    - Channel #help-me-platform = C05FA8B5YPM
- Keep responses under 3500 chars
- Match user's language (Norwegian/Swedish/English)
- Focus on useful answers, not disclaimers

## KEY FACTS
- Markets: Norway, Sweden, Germany, Denmark
- Products: EV charging for housing communities
- Support: 91 59 05 00 (24/7)
- Norgespris: 40 ore/kWh eks. mva (Oct 2025)`;

// Updated vector store description
const DOCUMENTS_TOOL_DESCRIPTION = `Search Volterra's company knowledge base (~12,200 documents).

DATA SOURCES:
- Slack threads (~11,300): Internal discussions
- Notion (~235): Process docs, wikis
- Files (~215): Legal docs, reports

USE FOR: Policies, processes, technical docs, internal discussions.
Returns: id, title, content snippet, source_type, similarity.`;

// Slack messages vector store description
const SLACK_TOOL_DESCRIPTION = `Search individual Slack messages (~850 messages from #help-me-platform).

USE FOR: Finding specific Slack messages by content, user queries, platform issues.
Returns: id, channel_id, message_ts, thread_ts, user_id, user_display_name, text, message_at, similarity.

TIP: Results include timestamps; use message_at to identify most recent messages.`;

async function updateWorkflow(): Promise<void> {
  const client = new N8nApiClient();

  logger.info('Fetching current workflow...');
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  logger.info(`Current workflow: ${workflow.name} (${workflow.nodes.length} nodes)`);

  // Only update AI Agent system prompt and Supabase Vector Store description
  // Keep all other nodes exactly as-is to preserve credentials
  const updatedNodes = workflow.nodes.map(node => {
    if (node.name === 'AI Agent') {
      logger.info('Updating AI Agent system prompt');
      return {
        ...node,
        parameters: {
          ...node.parameters,
          options: {
            ...(node.parameters.options as Record<string, unknown> || {}),
            systemMessage: SYSTEM_PROMPT
          }
        }
      };
    }
    if (node.name === 'Supabase Vector Store') {
      logger.info('Updating Supabase Vector Store description');
      return {
        ...node,
        parameters: {
          ...node.parameters,
          toolDescription: DOCUMENTS_TOOL_DESCRIPTION
        }
      };
    }
    if (node.name === 'Supabase Slack') {
      logger.info('Updating Supabase Slack description');
      return {
        ...node,
        parameters: {
          ...node.parameters,
          toolDescription: SLACK_TOOL_DESCRIPTION
        }
      };
    }
    return node;
  });

  // Keep existing connections exactly as-is
  const connections: WorkflowConnections = { ...workflow.connections };
  // Only remove legacy SQL nodes if present
  delete connections['Supabase SQL (read-only)'];
  delete connections['Supabase SQL Query'];

  logger.info(`Updating workflow with ${updatedNodes.length} nodes...`);

  // Clean settings
  const cleanSettings: Record<string, unknown> = {
    executionOrder: workflow.settings?.executionOrder || 'v1',
    availableInMCP: true,
  };
  if (workflow.settings?.saveDataErrorExecution) cleanSettings.saveDataErrorExecution = workflow.settings.saveDataErrorExecution;
  if (workflow.settings?.saveDataSuccessExecution) cleanSettings.saveDataSuccessExecution = workflow.settings.saveDataSuccessExecution;
  if (workflow.settings?.saveManualExecutions !== undefined) cleanSettings.saveManualExecutions = workflow.settings.saveManualExecutions;
  if (workflow.settings?.callerPolicy) cleanSettings.callerPolicy = workflow.settings.callerPolicy;
  if (workflow.settings?.errorWorkflow) cleanSettings.errorWorkflow = workflow.settings.errorWorkflow;
  if (workflow.settings?.timezone) cleanSettings.timezone = workflow.settings.timezone;
  if (workflow.settings?.executionTimeout) cleanSettings.executionTimeout = workflow.settings.executionTimeout;

  const updated = await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: updatedNodes,
    connections,
    settings: cleanSettings,
    staticData: workflow.staticData
  });

  logger.info(`Workflow updated successfully!`);
  logger.info(`Total nodes: ${updated.nodes.length}`);

  // List all tools connected to AI Agent
  const toolConnections = Object.entries(updated.connections)
    .filter(([_, conn]) => conn.ai_tool?.some(arr => arr.some(c => c.node === 'AI Agent')))
    .map(([name]) => name);
  
  logger.info(`Tools connected to AI Agent (${toolConnections.length}):`);
  toolConnections.forEach(name => logger.info(`  - ${name}`));

  logger.info('');
  logger.info('NOTE: To add new tools or modify HTTP tools, use the n8n UI:');
  logger.info('  https://your-n8n-instance.example.com/workflow/iVcW0pyvfWPPQufj');
  logger.info('  (API cannot assign credentials to nodes)');

  // Activate workflow if not already active
  if (!updated.active) {
    logger.info('Activating workflow...');
    await client.activateWorkflow(WORKFLOW_ID);
    logger.info('Workflow activated!');
  }
}

// Main execution
updateWorkflow()
  .then(() => {
    logger.info('Done!');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Failed to update workflow', { error: error.message });
    process.exit(1);
  });
