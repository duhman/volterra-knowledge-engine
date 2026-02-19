/**
 * Add Notion query tools to the n8n AI Agent workflow
 */

import { config } from 'dotenv';
import { N8nApiClient } from '../services/n8n-api-client.js';
import { logger } from '../utils/logger.js';
import type { WorkflowNode, WorkflowConnections } from '../types/n8n.js';

config();

const WORKFLOW_ID = 'iVcW0pyvfWPPQufj';
const SUPABASE_URL = process.env.SUPABASE_URL;

if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL (expected self-host base, e.g. https://srv1209224.hstgr.cloud)');
}

// New tools to add
const notionSyncStateTool: WorkflowNode = {
  name: 'Get Notion Sync Status',
  type: 'n8n-nodes-base.httpRequestTool',
  typeVersion: 4.3,
  position: [2256, 584], // Below the Slack tool
  parameters: {
    toolDescription: `Get the latest Notion sync status and statistics.
USE FOR: "Notion sync status", "last Notion sync", "sync errors", "pages synced" queries.
Returns: last_run_at, pages_seen, pages_changed, pages_deleted, docs_upserted, errors.`,
    method: 'GET',
    url: `${SUPABASE_URL}/rest/v1/notion_sync_state?select=id,last_run_at,last_run_pages_seen,last_run_pages_changed,last_run_pages_deleted,last_run_docs_upserted,last_run_docs_deleted,last_run_chunks_created,last_run_failed_pages,last_run_error,last_run_duration_ms&limit=1`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'apikey', value: '' } // Will be set by credential
      ]
    },
    options: {}
  },
  credentials: {
    httpHeaderAuth: {
      id: 'op9ceu99ngtd7SDU',
      name: 'Header Auth account'
    }
  }
};

const notionPagesTool: WorkflowNode = {
  name: 'Get Recent Notion Pages',
  type: 'n8n-nodes-base.httpRequestTool',
  typeVersion: 4.3,
  position: [2256, 704], // Below sync status tool
  parameters: {
    toolDescription: `Get recently edited Notion pages with metadata.
USE FOR: "recent Notion pages", "latest Notion updates", "Notion page list" queries.
Returns: title, url, notion_last_edited_time, doc_chunk_count, database_id.`,
    method: 'GET',
    url: `${SUPABASE_URL}/rest/v1/notion_pages?select=id,title,url,notion_page_id,notion_last_edited_time,doc_chunk_count,database_id,archived,last_ingested_at&order=notion_last_edited_time.desc&limit=10`,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'apikey', value: '' } // Will be set by credential
      ]
    },
    options: {}
  },
  credentials: {
    httpHeaderAuth: {
      id: 'op9ceu99ngtd7SDU',
      name: 'Header Auth account'
    }
  }
};

async function addNotionTools(): Promise<void> {
  const client = new N8nApiClient();

  logger.info('Fetching current workflow...');
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  logger.info(`Current workflow: ${workflow.name} (${workflow.nodes.length} nodes)`);

  // Check if tools already exist
  const existingNotionSync = workflow.nodes.find(n => n.name === 'Get Notion Sync Status');
  const existingNotionPages = workflow.nodes.find(n => n.name === 'Get Recent Notion Pages');

  if (existingNotionSync && existingNotionPages) {
    logger.info('Notion tools already exist in workflow. Nothing to do.');
    return;
  }

  // Add new nodes
  const newNodes = [...workflow.nodes];
  const newConnections: WorkflowConnections = { ...workflow.connections };

  if (!existingNotionSync) {
    logger.info('Adding Get Notion Sync Status tool...');
    newNodes.push(notionSyncStateTool);
    
    // Connect to AI Agent
    newConnections['Get Notion Sync Status'] = {
      ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]]
    };
  }

  if (!existingNotionPages) {
    logger.info('Adding Get Recent Notion Pages tool...');
    newNodes.push(notionPagesTool);
    
    // Connect to AI Agent
    newConnections['Get Recent Notion Pages'] = {
      ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]]
    };
  }

  // Update workflow
  logger.info(`Updating workflow with ${newNodes.length} nodes...`);
  
  const cleanSettings: Record<string, unknown> = {
    executionOrder: workflow.settings?.executionOrder || 'v1',
  };
  if (workflow.settings?.saveDataErrorExecution) cleanSettings.saveDataErrorExecution = workflow.settings.saveDataErrorExecution;
  if (workflow.settings?.saveDataSuccessExecution) cleanSettings.saveDataSuccessExecution = workflow.settings.saveDataSuccessExecution;
  if (workflow.settings?.saveManualExecutions !== undefined) cleanSettings.saveManualExecutions = workflow.settings.saveManualExecutions;
  if (workflow.settings?.callerPolicy) cleanSettings.callerPolicy = workflow.settings.callerPolicy;
  if (workflow.settings?.errorWorkflow) cleanSettings.errorWorkflow = workflow.settings.errorWorkflow;
  if (workflow.settings?.timezone) cleanSettings.timezone = workflow.settings.timezone;

  const updated = await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: newNodes,
    connections: newConnections,
    settings: cleanSettings,
    staticData: workflow.staticData
  });

  logger.info(`Workflow updated successfully!`);
  logger.info(`Total nodes: ${updated.nodes.length}`);

  // Verify tools connected to AI Agent
  const toolConnections = Object.entries(updated.connections)
    .filter(([_, conn]) => conn.ai_tool?.some(arr => arr.some(c => c.node === 'AI Agent')))
    .map(([name]) => name);
  
  logger.info(`Tools connected to AI Agent (${toolConnections.length}):`);
  toolConnections.forEach(name => logger.info(`  - ${name}`));
}

// Main execution
addNotionTools()
  .then(() => {
    logger.info('Done!');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Failed to add Notion tools', { error: error.message });
    process.exit(1);
  });
