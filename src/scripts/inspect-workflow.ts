/**
 * Inspect n8n workflow configuration
 */

import { N8nApiClient } from '../services/n8n-api-client.js';

const WORKFLOW_ID = 'c4tHYJcGwSaDAA6c';

async function main() {
  const client = new N8nApiClient();
  const workflow = await client.getWorkflow(WORKFLOW_ID);

  console.log('=== WORKFLOW INFO ===');
  console.log(`Name: ${workflow.name}`);
  console.log(`Active: ${workflow.active}`);
  
  console.log('\n=== NODES ===');
  workflow.nodes.forEach(n => {
    console.log(`\n${n.name}`);
    console.log(`  ID: ${n.id}`);
    console.log(`  Type: ${n.type}`);
    if (n.name === 'Extract Message' || n.name === 'Slack Response' || n.name === 'Prepare AI Input') {
      console.log(`  Parameters: ${JSON.stringify(n.parameters, null, 4)}`);
    }
  });

  console.log('\n=== CONNECTIONS ===');
  for (const [nodeName, conns] of Object.entries(workflow.connections)) {
    console.log(`${nodeName} -> ${JSON.stringify(conns)}`);
  }
}

main().catch(console.error);
