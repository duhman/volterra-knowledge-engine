#!/usr/bin/env npx tsx
/**
 * Script to update the n8n AI Agent chatbot system prompt
 */

import { config } from 'dotenv';
import { logger } from '../utils/logger.js';

config();

const NEW_SYSTEM_PROMPT = `You are Volterra's internal AI assistant for testing and knowledge exploration. You have access to the company's full Supabase knowledge base.

## PURPOSE
This is an INTERNAL TESTING agent. You help Volterra team members with:
- Customer support scenarios (simulate customer questions)
- Business intelligence and operational questions
- Process and policy lookups
- Technical troubleshooting information
- Sales and commercial data queries
- Any question related to Volterra's operations

## KNOWLEDGE BASE CONTENTS
You have access to the following data in Supabase:
1. **Slack Threads** (~11,000+ docs) - Internal team discussions from sales, platform, customer-success, operations, finance
2. **Support Knowledge Base** (~300 docs) - Customer-facing FAQs, troubleshooting guides, process documentation
3. **Legal Documents** (~140 docs) - Terms & Conditions, Sales Agreements, contracts
4. **Monthly Reports** (~34 docs) - Executive metrics, KPIs, financial summaries
5. **Notion Documentation** (~235 docs) - Process docs, onboarding guides, internal wikis
6. **WoD (Wheel of Deal)** - Pricing calculator data, deal configurations

## HOW TO RESPOND
1. ALWAYS search the Supabase knowledge base first
2. Cite your sources - mention which type of document the information comes from
3. If information spans multiple sources, synthesize and summarize
4. For customer support testing: respond as if you were the customer-facing chatbot
5. For business questions: provide data-driven answers with context
6. If you can't find relevant information, say so clearly

## LANGUAGE
- Respond in the same language as the question (Norwegian, Swedish, or English)
- Default to English for mixed or unclear language

## KEY VOLTERRA FACTS
- Markets: Norway (primary), Sweden, Germany, Denmark
- Products: EV charging for housing communities (borettslag/sameier)
- Models: Charger rental, purchase, operations-only
- Charger brands: Easee, Zaptec
- Support phone: 91 59 05 00 (24/7)
- Subscription cancellation: 1 month notice
- New installation: within 15 working days
- Norgespris: 40 ore/kWh eks. mva (from Oct 2025)

## TESTING SCENARIOS
When asked to test specific scenarios, adapt your response style:
- "Test customer support:" -> Respond as customer-facing chatbot
- "Test business question:" -> Provide analytical/strategic response
- "Test technical:" -> Focus on troubleshooting and technical details
- "Find information about:" -> Search and summarize relevant docs

## LIMITATIONS
- I search semantic similarity, so rephrase queries if results seem off
- Slack content may contain informal discussions, not official policy
- For real-time data (current deals, live metrics), I only have historical snapshots`;

const TOOL_DESCRIPTION = `Search Volterra's complete Supabase knowledge base containing 12,000+ documents.

DATA SOURCES:
- Slack threads: Internal discussions from all departments (sales, platform, customer-success, operations, finance)
- Knowledge Base: Customer support FAQs, troubleshooting guides, process documentation
- Legal: Terms & Conditions, Sales Agreements, contracts
- Monthly Reports: Executive summaries, KPIs, financial metrics
- Notion: Process documentation, onboarding guides, internal wikis
- WoD: Wheel of Deal pricing data, deal configurations

USE FOR:
- Customer support questions (app, charging, subscriptions, troubleshooting)
- Business intelligence (metrics, market data, operational insights)
- Process and policy lookups
- Technical information (Easee, Zaptec, infrastructure)
- Sales and commercial data
- Legal and compliance questions

TIPS:
- Use specific keywords for better results
- Try different phrasings if results seem off
- Results are ranked by semantic similarity`;

interface N8nNode {
  id: string;
  name: string;
  type: string;
  position: number[];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
  webhookId?: string;
}

interface N8nWorkflow {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

async function updateChatbotPrompt(): Promise<void> {
  const apiUrl = process.env.N8N_API_URL || 'https://your-n8n-instance.example.com/api/v1';
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error('N8N_API_KEY environment variable is required');
  }

  const workflowId = 'iVcW0pyvfWPPQufj';

  // Get current workflow
  logger.info(`Fetching workflow ${workflowId}...`);
  const getResponse = await fetch(`${apiUrl}/workflows/${workflowId}`, {
    headers: {
      'X-N8N-API-KEY': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!getResponse.ok) {
    throw new Error(`Failed to get workflow: ${getResponse.status} ${getResponse.statusText}`);
  }

  const workflow: N8nWorkflow = await getResponse.json() as N8nWorkflow;
  logger.info(`Got workflow: ${workflow.name}`);

  // Find and update the AI Agent node
  let agentUpdated = false;
  let vectorStoreUpdated = false;

  for (const node of workflow.nodes) {
    if (node.type === '@n8n/n8n-nodes-langchain.agent') {
      logger.info('Updating AI Agent system prompt...');
      node.parameters = node.parameters || {};
      node.parameters.options = node.parameters.options || {};
      (node.parameters.options as Record<string, unknown>).systemMessage = NEW_SYSTEM_PROMPT;
      agentUpdated = true;
    }

    if (node.type === '@n8n/n8n-nodes-langchain.vectorStoreSupabase') {
      logger.info('Updating Vector Store tool description...');
      node.parameters = node.parameters || {};
      node.parameters.toolDescription = TOOL_DESCRIPTION;
      vectorStoreUpdated = true;
    }
  }

  if (!agentUpdated) {
    logger.warn('AI Agent node not found in workflow');
  }

  if (!vectorStoreUpdated) {
    logger.warn('Supabase Vector Store node not found in workflow');
  }

  // Update workflow - only send allowed settings
  logger.info('Saving updated workflow...');
  
  // Filter settings to only include allowed properties
  const allowedSettings: Record<string, unknown> = {};
  const allowedSettingsKeys = ['executionOrder', 'errorWorkflow', 'callerPolicy', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveManualExecutions', 'saveExecutionProgress', 'timezone'];
  if (workflow.settings) {
    for (const key of allowedSettingsKeys) {
      if (key in workflow.settings) {
        allowedSettings[key] = (workflow.settings as Record<string, unknown>)[key];
      }
    }
  }
  
  const updateResponse = await fetch(`${apiUrl}/workflows/${workflowId}`, {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: allowedSettings,
    }),
  });

  if (!updateResponse.ok) {
    const errorText = await updateResponse.text();
    throw new Error(`Failed to update workflow: ${updateResponse.status} ${updateResponse.statusText}\n${errorText}`);
  }

  logger.info('Successfully updated AI Agent chatbot configuration!');
  logger.info(`- System prompt: ${agentUpdated ? 'Updated' : 'Not found'}`);
  logger.info(`- Tool description: ${vectorStoreUpdated ? 'Updated' : 'Not found'}`);
}

updateChatbotPrompt()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Failed to update chatbot prompt', { error: error instanceof Error ? error.message : error });
    process.exit(1);
  });
