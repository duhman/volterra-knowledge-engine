#!/usr/bin/env npx tsx
/**
 * Add Slack thread context fetching to @Ela Slack workflow
 *
 * Fetches full Slack thread via conversations.replies and prepends it to chatInput
 * so follow-up questions keep full thread context.
 */

import { config } from 'dotenv';
import { logger } from '../utils/logger.js';
import { N8nApiClient } from '../services/n8n-api-client.js';
import type { WorkflowNode, WorkflowConnections, Workflow } from '../types/n8n.js';

config();

const WORKFLOW_ID = 'c4tHYJcGwSaDAA6c';
const THREAD_FETCH_NODE = 'Fetch Thread Messages';
const THREAD_CONTEXT_NODE = 'Build Thread Context';

const THREAD_CONTEXT_CODE = `// Build Slack thread context and prepend to chatInput
// Assumes upstream node fetched Slack conversations.replies

const items = $input.all();
const results = [];

const source = $node['Extract Message']?.json || {};
const chatInput = source.chatInput || '';

for (const item of items) {
  const response = item.json || {};
  const messages = Array.isArray(response.messages) ? response.messages : [];
  const lines = [];

  for (const msg of messages) {
    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
    if (!text) continue;

    const profile = msg?.user_profile || {};
    const name = profile.display_name || profile.real_name || msg.username || msg.user || 'Unknown';
    lines.push(name + ': ' + text.replace(/\\s+/g, ' '));
  }

  const threadContext = lines.join('\\n');
  const combinedInput = threadContext
    ? 'Slack thread context (chronological):\\n' + threadContext + '\\n\\nLatest user message:\\n' + chatInput
    : chatInput;

  results.push({
    json: {
      ...source,
      chatInput: combinedInput,
      thread_context: threadContext,
    },
  });
}

return results;`;

function findSlackCredentials(workflow: Workflow): WorkflowNode['credentials'] {
  const slackNode = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.slack');
  if (!slackNode?.credentials) {
    return undefined;
  }
  return slackNode.credentials;
}

function createThreadFetchNode(position: [number, number], credentials?: WorkflowNode['credentials']): WorkflowNode {
  return {
    name: THREAD_FETCH_NODE,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: {
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      method: 'GET',
      url: 'https://slack.com/api/conversations.replies?channel={{$json.channel}}&ts={{$json.thread_ts}}&limit=200&inclusive=true',
      options: {},
    },
    continueOnFail: true,
    credentials,
  };
}

function createThreadContextNode(position: [number, number]): WorkflowNode {
  return {
    name: THREAD_CONTEXT_NODE,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: {
      jsCode: THREAD_CONTEXT_CODE,
    },
  };
}

function updateConnections(connections: WorkflowConnections): WorkflowConnections {
  const updated = JSON.parse(JSON.stringify(connections)) as WorkflowConnections;

  updated['Extract Message'] = {
    main: [[{ node: THREAD_FETCH_NODE, type: 'main', index: 0 }]],
  };

  updated[THREAD_FETCH_NODE] = {
    main: [[{ node: THREAD_CONTEXT_NODE, type: 'main', index: 0 }]],
  };

  updated[THREAD_CONTEXT_NODE] = {
    main: [[{ node: 'Prepare AI Input', type: 'main', index: 0 }]],
  };

  return updated;
}

function allowedSettings(workflow: Workflow): Workflow['settings'] {
  const allowedKeys = [
    'executionOrder',
    'errorWorkflow',
    'callerPolicy',
    'saveDataErrorExecution',
    'saveDataSuccessExecution',
    'saveManualExecutions',
    'saveExecutionProgress',
    'timezone',
  ] as const;

  const settings: Record<string, unknown> = {};
  if (workflow.settings) {
    for (const key of allowedKeys) {
      if (key in workflow.settings) {
        settings[key] = (workflow.settings as Record<string, unknown>)[key];
      }
    }
  }
  return settings;
}

async function main(): Promise<void> {
  const client = new N8nApiClient();
  logger.info(`Fetching workflow ${WORKFLOW_ID}...`);
  const workflow = await client.getWorkflow(WORKFLOW_ID);

  const extractNode = workflow.nodes.find((node) => node.name === 'Extract Message');
  if (!extractNode) {
    throw new Error('Extract Message node not found');
  }

  const prepareNode = workflow.nodes.find((node) => node.name === 'Prepare AI Input');
  if (!prepareNode) {
    throw new Error('Prepare AI Input node not found');
  }

  const slackCredentials = findSlackCredentials(workflow);
  if (!slackCredentials) {
    throw new Error('Slack credentials not found on any Slack node');
  }

  const threadFetchExisting = workflow.nodes.find((node) => node.name === THREAD_FETCH_NODE);
  const threadContextExisting = workflow.nodes.find((node) => node.name === THREAD_CONTEXT_NODE);

  const threadFetchPosition: [number, number] = threadFetchExisting?.position || [extractNode.position[0] + 224, extractNode.position[1] - 120];
  const threadContextPosition: [number, number] = threadContextExisting?.position || [threadFetchPosition[0] + 224, threadFetchPosition[1]];

  const threadFetchNode = createThreadFetchNode(threadFetchPosition, slackCredentials);
  const threadContextNode = createThreadContextNode(threadContextPosition);

  const updatedNodes = workflow.nodes.map((node) => {
    if (node.name === THREAD_FETCH_NODE) {
      return {
        ...node,
        ...threadFetchNode,
        id: node.id,
        position: threadFetchPosition,
      };
    }
    if (node.name === THREAD_CONTEXT_NODE) {
      return {
        ...node,
        ...threadContextNode,
        id: node.id,
        position: threadContextPosition,
      };
    }
    return node;
  });

  if (!threadFetchExisting) {
    updatedNodes.push(threadFetchNode);
  }

  if (!threadContextExisting) {
    updatedNodes.push(threadContextNode);
  }

  const updatedConnections = updateConnections(workflow.connections);

  logger.info('Updating workflow with thread context nodes...');
  await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: updatedNodes,
    connections: updatedConnections,
    settings: allowedSettings(workflow),
  });

  logger.info('Workflow updated successfully.');
}

main().catch((error) => {
  logger.error('Failed to add thread context', {
    error: error instanceof Error ? error.message : error,
  });
  process.exit(1);
});
