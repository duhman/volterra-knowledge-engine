/**
 * Fix n8n Slack workflow - update nodes in place without replacing
 */

import { N8nApiClient } from '../services/n8n-api-client.js';
import { logger } from '../utils/logger.js';

const WORKFLOW_ID = 'YOUR_WORKFLOW_ID';

async function main() {
  const client = new N8nApiClient();
  
  logger.info('Fetching current workflow...');
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  
  logger.info(`Current workflow: ${workflow.name}`);
  
  // Deactivate first
  logger.info('Deactivating workflow...');
  try {
    await client.deactivateWorkflow(WORKFLOW_ID);
  } catch (e) {
    logger.warn('Could not deactivate (may already be inactive)');
  }

  // Update nodes in place
  const updatedNodes = workflow.nodes.map(node => {
    if (node.name === 'Slack Trigger') {
      logger.info('Updating Slack Trigger node...');
      return {
        ...node,
        parameters: {
          trigger: 'event',
          events: ['app_mention'],
        },
        typeVersion: 1,
        credentials: {
          slackOAuth2Api: {
            id: 'yZ6iAmMgxRhe1Ukb',
            name: 'Slack account'
          }
        }
      };
    }
    
    if (node.name === 'Extract Message') {
      logger.info('Updating Extract Message node...');
      return {
        ...node,
        parameters: {
          mode: 'manual',
          duplicateItem: false,
          assignments: {
            assignments: [
              {
                id: 'chatInput',
                name: 'chatInput',
                value: "={{ $json.event.text.replace(/<@[A-Z0-9]+>\\s*/g, '').trim() }}",
                type: 'string'
              },
              {
                id: 'channel',
                name: 'channel',
                value: '={{ $json.event.channel }}',
                type: 'string'
              },
              {
                id: 'thread_ts',
                name: 'thread_ts',
                value: '={{ $json.event.thread_ts || $json.event.ts }}',
                type: 'string'
              },
              {
                id: 'user',
                name: 'user',
                value: '={{ $json.event.user }}',
                type: 'string'
              }
            ]
          },
          options: {}
        },
        typeVersion: 3.4
      };
    }
    
    if (node.name === 'Slack Response') {
      logger.info('Updating Slack Response node...');
      // Use the correct parameter structure for n8n Slack node v2.2
      return {
        ...node,
        parameters: {
          select: 'channel',
          channelId: {
            __rl: true,
            value: "={{ $('Extract Message').item.json.channel }}",
            mode: 'id'
          },
          text: "={{ $json.output || $json.text || 'I could not process your request.' }}",
          otherOptions: {
            includeLinkToWorkflow: false,
            thread_ts: "={{ $('Extract Message').item.json.thread_ts }}"
          }
        },
        typeVersion: 2.2,
        credentials: {
          slackOAuth2Api: {
            id: 'yZ6iAmMgxRhe1Ukb',
            name: 'Slack account'
          }
        }
      };
    }
    
    return node;
  });

  // Build correct connections
  const connections: Record<string, any> = {};
  
  // Keep AI-related connections
  for (const [nodeName, conns] of Object.entries(workflow.connections)) {
    if (['SerpAPI', 'Simple Memory', 'OpenAI Chat Model', 'Supabase Vector Store', 'Embeddings OpenAI'].includes(nodeName)) {
      connections[nodeName] = conns;
    }
  }
  
  // Set main flow connections
  connections['Slack Trigger'] = {
    main: [[{ node: 'Extract Message', type: 'main', index: 0 }]]
  };
  connections['Extract Message'] = {
    main: [[{ node: 'Prepare AI Input', type: 'main', index: 0 }]]
  };
  connections['Prepare AI Input'] = {
    main: [[{ node: 'AI Agent', type: 'main', index: 0 }]]
  };
  connections['AI Agent'] = {
    main: [[{ node: 'Slack Response', type: 'main', index: 0 }]]
  };

  // Update workflow - use minimal settings to avoid API validation errors
  const updatedWorkflow = {
    name: workflow.name,
    nodes: updatedNodes,
    connections: connections,
    settings: {},
  };

  logger.info('Updating workflow...');
  const result = await client.updateWorkflow(WORKFLOW_ID, updatedWorkflow);
  
  logger.info('Workflow updated successfully!');
  logger.info(`Active: ${result.active}`);

  // Reactivate
  logger.info('Reactivating workflow...');
  await client.activateWorkflow(WORKFLOW_ID);
  logger.info('Workflow activated!');
  
  // Log the updated Slack Response params
  const slackNode = updatedNodes.find(n => n.name === 'Slack Response');
  logger.info('Slack Response parameters:');
  console.log(JSON.stringify(slackNode?.parameters, null, 2));
}

main().catch((error) => {
  logger.error('Failed:', error);
  process.exit(1);
});
