#!/usr/bin/env npx tsx
/**
 * Add Release Details tool to the n8n AI Agent workflow
 *
 * This tool provides comprehensive release announcement parsing including:
 * - Title (What we are delivering today)
 * - Description (bullet points)
 * - Target audience (Who is it for)
 * - Value proposition (Value)
 * - Contributors (Who has contributed)
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";

config();

const TOOL_DESCRIPTION = `Get comprehensive release details from #platform-all-deliveries announcements.

USE FOR:
- "What releases were for installers?" → filter by target_audience
- "Show me releases about charging" → search in title/description/value
- "Full details of recent releases" → all parsed fields
- "What value did we deliver last month?" → value propositions
- "Releases for HA (housing associations)" → target audience filter

PARAMETERS:
- p_channel_id: Channel ID (default: C078S57MS5P = #platform-all-deliveries)
- p_date_from: Start date (ISO format, e.g., '2025-01-01')
- p_date_to: End date (ISO format, e.g., '2025-12-31')
- p_target_audience: Filter by "Who is it for" (e.g., 'installers', 'HA', 'drivers')
- p_search_term: Search in title, description, and value proposition
- p_limit: Max results (1-50, default: 20)

RETURNS: Array of releases with:
- released_at: Release timestamp
- posted_by: {name, id} - who posted
- title: "What we are delivering today" content
- description: Bullet points of features
- target_audience: "Who is it for"
- value_proposition: "Value" field
- contributors: {count, names, ids}
- reactions: Engagement count
- attachments: Number of images/files
- slack_url: Direct link to message

CHANNEL IDS:
- C078S57MS5P: #platform-all-deliveries (default)`;

interface N8nNode {
  id: string;
  name: string;
  type: string;
  position: number[];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
  webhookId?: string;
  credentials?: Record<string, unknown>;
}

interface N8nConnection {
  main?: Array<Array<{ node: string; type: string; index: number }>>;
  ai_tool?: Array<Array<{ node: string; type: string; index: number }>>;
}

interface N8nWorkflow {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: Record<string, N8nConnection>;
  settings?: Record<string, unknown>;
}

async function addReleaseDetailsTool(): Promise<void> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  if (!supabaseAnonKey) {
    throw new Error("SUPABASE_ANON_KEY environment variable is required");
  }

  const workflowId = "c4tHYJcGwSaDAA6c"; // AI agent chat - Slack

  // Get current workflow
  logger.info(`Fetching workflow ${workflowId}...`);
  const getResponse = await fetch(`${apiUrl}/workflows/${workflowId}`, {
    headers: {
      "X-N8N-API-KEY": apiKey,
      Accept: "application/json",
    },
  });

  if (!getResponse.ok) {
    throw new Error(
      `Failed to get workflow: ${getResponse.status} ${getResponse.statusText}`,
    );
  }

  const workflow: N8nWorkflow = (await getResponse.json()) as N8nWorkflow;
  logger.info(`Got workflow: ${workflow.name}`);

  // Tool parameters configuration
  const toolParameters = {
    toolDescription: TOOL_DESCRIPTION,
    method: "POST",
    url: "https://your-project.supabase.co/rest/v1/rpc/mcp_get_release_details",
    sendHeaders: true,
    specifyHeaders: "keypair",
    parametersHeaders: {
      values: [
        {
          name: "apikey",
          valueProvider: "fieldValue",
          value: supabaseAnonKey,
        },
        {
          name: "Authorization",
          valueProvider: "fieldValue",
          value: `Bearer ${supabaseAnonKey}`,
        },
        {
          name: "Content-Type",
          valueProvider: "fieldValue",
          value: "application/json",
        },
        {
          name: "Content-Profile",
          valueProvider: "fieldValue",
          value: "volterra_kb",
        },
      ],
    },
    sendBody: true,
    specifyBody: "json",
    // Use $fromAI() with default values for optional parameters
    // Empty strings are converted to NULL by the SQL function
    jsonBody: `={
  "p_channel_id": "{{ $fromAI('channel_id', 'Slack channel ID', 'string', 'C078S57MS5P') }}",
  "p_date_from": "{{ $fromAI('date_from', 'Start date (ISO format, e.g., 2025-01-01)', 'string', '') }}",
  "p_date_to": "{{ $fromAI('date_to', 'End date (ISO format, e.g., 2025-12-31)', 'string', '') }}",
  "p_target_audience": "{{ $fromAI('target_audience', 'Filter by Who is it for (e.g., installers, HA, drivers)', 'string', '') }}",
  "p_search_term": "{{ $fromAI('search_term', 'Search in title, description, and value proposition', 'string', '') }}",
  "p_limit": {{ $fromAI('limit', 'Max results (1-50)', 'number', 20) }}
}`,
    // No placeholderDefinitions needed when using $fromAI()
  };

  // Check if tool already exists
  const existingTool = workflow.nodes.find((n) => n.name === "Release Details");
  if (existingTool) {
    logger.info("Release Details tool already exists, updating...");
    existingTool.parameters = toolParameters;
    logger.info("Updated all parameters including headers");
  } else {
    // Find an existing HTTP Request Tool to get position reference
    const existingHttpTools = workflow.nodes.filter(
      (n) => n.type === "@n8n/n8n-nodes-langchain.toolHttpRequest",
    );
    const basePosition =
      existingHttpTools.length > 0
        ? existingHttpTools[existingHttpTools.length - 1].position
        : [1000, 600];

    // Create new HTTP Request Tool node
    const newToolNode: N8nNode = {
      id: crypto.randomUUID(),
      name: "Release Details",
      type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
      typeVersion: 1.1,
      position: [basePosition[0], basePosition[1] + 200],
      parameters: toolParameters,
    };

    workflow.nodes.push(newToolNode);
    logger.info("Added new Release Details node");

    // Find AI Agent node and add connection
    const agentNode = workflow.nodes.find(
      (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
    );
    if (agentNode) {
      // Add tool connection to AI Agent
      if (!workflow.connections[newToolNode.name]) {
        workflow.connections[newToolNode.name] = {};
      }
      workflow.connections[newToolNode.name].ai_tool = [
        [{ node: agentNode.name, type: "ai_tool", index: 0 }],
      ];
      logger.info(`Connected ${newToolNode.name} to ${agentNode.name}`);
    }
  }

  // Update workflow - only send allowed settings
  logger.info("Saving updated workflow...");

  const allowedSettingsKeys = [
    "executionOrder",
    "errorWorkflow",
    "callerPolicy",
    "saveDataErrorExecution",
    "saveDataSuccessExecution",
    "saveManualExecutions",
    "saveExecutionProgress",
    "timezone",
  ];
  const allowedSettings: Record<string, unknown> = {};
  if (workflow.settings) {
    for (const key of allowedSettingsKeys) {
      if (key in workflow.settings) {
        allowedSettings[key] = (workflow.settings as Record<string, unknown>)[
          key
        ];
      }
    }
  }

  const updateResponse = await fetch(`${apiUrl}/workflows/${workflowId}`, {
    method: "PUT",
    headers: {
      "X-N8N-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
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
    throw new Error(
      `Failed to update workflow: ${updateResponse.status} ${updateResponse.statusText}\n${errorText}`,
    );
  }

  logger.info("Successfully added Release Details tool to workflow!");
  logger.info("Test with: @Ela what releases were for installers in 2025?");
  logger.info("Or: @Ela show me the value we delivered last week");
}

addReleaseDetailsTool()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add tool", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
