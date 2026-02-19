/**
 * Check recent workflow executions
 */

import { N8nApiClient } from '../services/n8n-api-client.js';

const WORKFLOW_ID = 'c4tHYJcGwSaDAA6c';

async function main() {
  const client = new N8nApiClient();
  
  console.log('=== RECENT EXECUTIONS ===\n');
  
  const executions = await client.getExecutions({ 
    workflowId: WORKFLOW_ID,
    limit: 10
  });
  
  for (const exec of executions) {
    console.log(`ID: ${exec.id}`);
    console.log(`Status: ${exec.status}`);
    console.log(`Started: ${exec.startedAt}`);
    console.log(`Finished: ${exec.stoppedAt}`);
    console.log(`Mode: ${exec.mode}`);
    console.log('---');
  }
  
  // Get the latest failed execution details
  const failedExec = executions.find(e => e.status === 'error');
  if (failedExec) {
    console.log('\n=== LATEST FAILED EXECUTION DETAILS ===');
    try {
      const details = await client.getExecution(failedExec.id);
      console.log('Data:', JSON.stringify(details, null, 2).slice(0, 2000));
    } catch (e) {
      console.log('Could not fetch details:', e);
    }
  }
}

main().catch(console.error);
