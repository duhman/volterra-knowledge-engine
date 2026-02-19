/**
 * Test n8n AI Agent workflow with prompts that exercise different tools
 */

import { config } from 'dotenv';
import { N8nApiClient } from '../services/n8n-api-client.js';
import { logger } from '../utils/logger.js';

config();

const WORKFLOW_ID = 'YOUR_WORKFLOW_ID';
const WEBHOOK_ID = '53c136fe-3e77-4709-a143-fe82746dd8b6';
const CHAT_URL = `https://your-n8n-instance.example.com/webhook/${WEBHOOK_ID}/chat`;

interface ChatResponse {
  output?: string;
  text?: string;
  response?: string;
  error?: string;
}

const TEST_PROMPTS = [
  {
    name: 'Documents Vector Search',
    prompt: 'What is Norgespris?',
    expectedTool: 'Supabase Vector Store'
  },
  {
    name: 'Training Conversations Vector Search',
    prompt: 'Find similar cases where customers had app login issues',
    expectedTool: 'Supabase Training Conversations'
  },
  {
    name: 'WoD Deals Vector Search',
    prompt: 'Show me information about WoD deals',
    expectedTool: 'Supabase WoD Deals'
  },
  {
    name: 'WoD Cost Catalog',
    prompt: 'What are the standard installation costs in the WoD cost catalog?',
    expectedTool: 'Get WoD Cost Catalog'
  },
  {
    name: 'Table Stats',
    prompt: 'How many rows are in each Supabase table?',
    expectedTool: 'Get Table Stats'
  }
];

async function executeChat(prompt: string): Promise<ChatResponse> {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatInput: prompt }),
  });
  
  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.status} ${response.statusText}`);
  }
  
  return response.json() as Promise<ChatResponse>;
}

async function testWorkflow(): Promise<void> {
  const client = new N8nApiClient();
  
  // Verify workflow is active
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  if (!workflow.active) {
    logger.warn('Workflow is not active, activating...');
    await client.activateWorkflow(WORKFLOW_ID);
  }
  
  logger.info(`Chat URL: ${CHAT_URL}`);
  logger.info('Starting workflow tests...\n');
  
  const results: { name: string; success: boolean; response?: string; error?: string }[] = [];
  
  for (const test of TEST_PROMPTS) {
    logger.info(`\n=== Test: ${test.name} ===`);
    logger.info(`Prompt: ${test.prompt}`);
    logger.info(`Expected tool: ${test.expectedTool}`);
    
    try {
      const response = await executeChat(test.prompt);
      const output = response.output || response.text || response.response || JSON.stringify(response);
      
      logger.info(`Response (first 500 chars): ${output.substring(0, 500)}...`);
      
      results.push({
        name: test.name,
        success: true,
        response: output.substring(0, 200)
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Test failed: ${errorMsg}`);
      
      results.push({
        name: test.name,
        success: false,
        error: errorMsg
      });
    }
    
    // Wait between tests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  // Summary
  logger.info('\n\n=== TEST SUMMARY ===');
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  logger.info(`Passed: ${passed}/${results.length}`);
  logger.info(`Failed: ${failed}/${results.length}`);
  
  results.forEach(r => {
    const status = r.success ? 'PASS' : 'FAIL';
    logger.info(`  [${status}] ${r.name}${r.error ? ': ' + r.error : ''}`);
  });
}

testWorkflow()
  .then(() => {
    logger.info('\nTest run complete!');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Test run failed', { error: error.message });
    process.exit(1);
  });
