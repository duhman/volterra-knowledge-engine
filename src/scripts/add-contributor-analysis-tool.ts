#!/usr/bin/env npx tsx
/**
 * Add Release Contributor Analysis tool to the n8n AI Agent workflow
 *
 * This tool extracts contributors from "Who has contributed:" sections in
 * release announcements and ranks releases by contributor count.
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";

config();

const TOOL_DESCRIPTION = `Analyze release announcements by contributor count - extracts "Who has contributed:" mentions.

USE FOR:
- "Top 5 releases by contributor count in 2025"
- "Who contributed to the most releases?"
- "Releases with more than 3 contributors"
- "Average contributors per release"

PARAMETERS:
- p_channel_id: Channel ID (default: C078S57MS5P = #platform-all-deliveries)
- p_date_from: Start date (ISO format, e.g., '2025-01-01')
- p_date_to: End date (ISO format, e.g., '2025-12-31')
- p_limit: Max results (1-50, default: 20)

RETURNS: Array of releases with:
- message_ts: Slack message timestamp
- released_at: Release date
- title: Release title
- contributors.count: Number of contributors
- contributors.names: Array of contributor display names
- contributors.ids: Array of Slack user IDs
- reactions: Reaction count
- preview: Text preview (200 chars)

Sorted by contributor count descending.

CHANNEL IDS:
- C078S57MS5P: #platform-all-deliveries`;

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

async function addContributorAnalysisTool(): Promise<void> {
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

  // Check if tool already exists
  const existingTool = workflow.nodes.find(
    (n) => n.name === "Release Contributor Analysis",
  );
  if (existingTool) {
    logger.info(
      "Release Contributor Analysis tool already exists, updating...",
    );
    // Update ALL parameters
    existingTool.parameters = {
      toolDescription: TOOL_DESCRIPTION,
      method: "POST",
      url: "https://your-project.supabase.co/rest/v1/rpc/mcp_analyze_release_contributors",
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
      jsonBody: `{
  "p_channel_id": "{p_channel_id}",
  "p_date_from": "{p_date_from}",
  "p_date_to": "{p_date_to}",
  "p_limit": {p_limit}
}`,
      placeholderDefinitions: {
        values: [
          {
            name: "p_channel_id",
            description:
              "Slack channel ID. Default: C078S57MS5P (#platform-all-deliveries)",
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
          {
            name: "p_limit",
            description: "Max results (1-50, default: 20)",
            type: "number",
          },
        ],
      },
    };
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
      name: "Release Contributor Analysis",
      type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
      typeVersion: 1.1,
      position: [basePosition[0], basePosition[1] + 200],
      parameters: {
        toolDescription: TOOL_DESCRIPTION,
        method: "POST",
        url: "https://your-project.supabase.co/rest/v1/rpc/mcp_analyze_release_contributors",
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
        jsonBody: `{
  "p_channel_id": "{p_channel_id}",
  "p_date_from": "{p_date_from}",
  "p_date_to": "{p_date_to}",
  "p_limit": {p_limit}
}`,
        placeholderDefinitions: {
          values: [
            {
              name: "p_channel_id",
              description:
                "Slack channel ID. Default: C078S57MS5P (#platform-all-deliveries)",
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
            {
              name: "p_limit",
              description: "Max results (1-50, default: 20)",
              type: "number",
            },
          ],
        },
      },
    };

    workflow.nodes.push(newToolNode);
    logger.info("Added new Release Contributor Analysis node");

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

  logger.info(
    "Successfully added Release Contributor Analysis tool to workflow!",
  );
  logger.info(
    "Test with: @Ela what were the top releases by contributor count in 2025?",
  );
}

addContributorAnalysisTool()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add tool", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
