/**
 * Verify workflow state after updates
 */

import { config } from 'dotenv';
import { N8nApiClient } from '../services/n8n-api-client.js';

config();

const WORKFLOW_ID = 'iVcW0pyvfWPPQufj';

async function verify() {
  const client = new N8nApiClient();
  const wf = await client.getWorkflow(WORKFLOW_ID);
  
  console.log('\n=== Workflow Verification ===');
  console.log(`Name: ${wf.name}`);
  console.log(`Active: ${wf.active}`);
  console.log(`Node count: ${wf.nodes.length}`);
  
  console.log('\n--- Nodes ---');
  wf.nodes.forEach(n => {
    console.log(`  - ${n.name} (${n.type})`);
  });
  
  console.log('\n--- Connections to AI Agent (tools) ---');
  Object.entries(wf.connections).forEach(([nodeName, conn]) => {
    if (conn.ai_tool) {
      const targets = conn.ai_tool.flat();
      const aiAgentConns = targets.filter(t => t.node === 'AI Agent');
      if (aiAgentConns.length > 0) {
        console.log(`  - ${nodeName} -> AI Agent (ai_tool)`);
      }
    }
  });
  
  console.log('\n--- AI Agent System Prompt (first 500 chars) ---');
  const aiAgent = wf.nodes.find(n => n.name === 'AI Agent');
  if (aiAgent) {
    const prompt = (aiAgent.parameters?.options as any)?.systemMessage as string || '';
    console.log(prompt.substring(0, 500) + '...');
  }
  
  console.log('\n--- Chat Trigger ---');
  const chatTrigger = wf.nodes.find(n => n.type === '@n8n/n8n-nodes-langchain.chatTrigger');
  if (chatTrigger) {
    console.log(`  webhookId: ${chatTrigger.webhookId}`);
    console.log(`  Chat URL: https://your-n8n-instance.example.com/webhook/${chatTrigger.webhookId}/chat`);
  }
}

verify().catch(console.error);
