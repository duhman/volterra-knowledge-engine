#!/usr/bin/env npx tsx
/**
 * Add Slack Reaction Analytics tool to the n8n AI Agent workflow
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";

config();

const TOOL_DESCRIPTION = `Get reaction analytics for Slack channels - average reactions, top emojis, engagement metrics.

USE FOR:
- "Average reactions in #platform-all-deliveries"
- "Top emojis used for release announcements"
- "How many messages got reactions in 2025?"
- "Engagement metrics for delivery channel"

PARAMETERS:
- p_channel_id: Channel ID (default: YOUR_SLACK_CHANNEL_ID = #platform-all-deliveries)
- p_date_from: Start date (ISO format, e.g., '2025-01-01')
- p_date_to: End date (ISO format, e.g., '2025-12-31')

RETURNS:
- total_messages: Total message count
- messages_with_reactions: Count with reactions
- total_reactions: Sum of all reactions
- avg_reactions_per_message: Average engagement rate
- top_reactions: Array of {name, total_count} for top emojis

CHANNEL IDS:
- YOUR_SLACK_CHANNEL_ID: #platform-all-deliveries
- YOUR_SLACK_CHANNEL_ID: #help-me-platform`;

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

async function addReactionAnalyticsTool(): Promise<void> {
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

  const workflowId = "YOUR_WORKFLOW_ID"; // AI agent chat - Slack

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

  // Check if tool already exists
  const existingTool = workflow.nodes.find(
    (n) => n.name === "Slack Reaction Analytics",
  );
  if (existingTool) {
    logger.info("Slack Reaction Analytics tool already exists, updating...");
    // Update ALL parameters to fix header configuration
    existingTool.parameters = {
      toolDescription: TOOL_DESCRIPTION,
      method: "POST",
      url: "https://your-project.supabase.co/rest/v1/rpc/get_reaction_analytics",
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
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: `{
  "p_channel_id": "{p_channel_id}",
  "p_date_from": "{p_date_from}",
  "p_date_to": "{p_date_to}"
}`,
      placeholderDefinitions: {
        values: [
          {
            name: "p_channel_id",
            description:
              "Slack channel ID. Default: YOUR_SLACK_CHANNEL_ID (#platform-all-deliveries)",
            type: "string",
          },
          {
            name: "p_date_from",
            description: "Start date (ISO format, e.g., 2025-01-01)",
            type: "string",
          },
          {
            name: "p_date_to",
            description: "End date (ISO format, e.g., 2025-12-31)",
            type: "string",
          },
        ],
      },
    };
    logger.info("Updated all parameters including headers");
  } else {
    // Find the existing HTTP Request Tool to get position reference
    const existingHttpTool = workflow.nodes.find(
      (n) => n.type === "@n8n/n8n-nodes-langchain.toolHttpRequest",
    );
    const basePosition = existingHttpTool?.position || [1000, 600];

    // Create new HTTP Request Tool node
    const newToolNode: N8nNode = {
      id: crypto.randomUUID(),
      name: "Slack Reaction Analytics",
      type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
      typeVersion: 1.1,
      position: [basePosition[0], basePosition[1] + 200],
      parameters: {
        toolDescription: TOOL_DESCRIPTION,
        method: "POST",
        url: "https://your-project.supabase.co/rest/v1/rpc/get_reaction_analytics",
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
          ],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody: `{
  "p_channel_id": "{p_channel_id}",
  "p_date_from": "{p_date_from}",
  "p_date_to": "{p_date_to}"
}`,
        placeholderDefinitions: {
          values: [
            {
              name: "p_channel_id",
              description:
                "Slack channel ID. Default: YOUR_SLACK_CHANNEL_ID (#platform-all-deliveries)",
              type: "string",
            },
            {
              name: "p_date_from",
              description: "Start date (ISO format, e.g., 2025-01-01)",
              type: "string",
            },
            {
              name: "p_date_to",
              description: "End date (ISO format, e.g., 2025-12-31)",
              type: "string",
            },
          ],
        },
      },
    };

    workflow.nodes.push(newToolNode);
    logger.info("Added new Slack Reaction Analytics node");

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

  logger.info("Successfully added Slack Reaction Analytics tool to workflow!");
  logger.info(
    "Test with: @Ela what is the average reactions in platform-all-deliveries for 2025?",
  );
}

addReactionAnalyticsTool()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add tool", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
