#!/usr/bin/env npx tsx
/**
 * Add Slack mrkdwn Formatter node to the @Ela workflow
 *
 * Problem: AI Agent outputs Markdown (**bold**) but Slack uses mrkdwn (*bold*)
 * Solution: Post-process all responses to convert Markdown → Slack mrkdwn
 *
 * This is a hard enforcement mechanism that guarantees consistent formatting
 * regardless of what the LLM outputs.
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";

config();

// JavaScript code for the n8n Code node
const FORMATTER_CODE = `// Convert Markdown to Slack mrkdwn format
// This runs AFTER the AI Agent generates a response

const items = $input.all();
const results = [];

for (const item of items) {
  // Get the AI output - try multiple possible field names
  let text = item.json.output || item.json.text || item.json.response || '';

  // If it's an object, try to stringify it
  if (typeof text === 'object') {
    text = JSON.stringify(text);
  }

  // Convert Markdown to Slack mrkdwn
  const formatted = String(text)
    // Bold: **text** → *text* (must be before italic check)
    .replace(/\\*\\*([^*]+)\\*\\*/g, '*$1*')
    // Headings: # Heading → *Heading*
    .replace(/^#{1,6}\\s+(.+)$/gm, '*$1*')
    // Links: [text](url) → <url|text>
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<$2|$1>')
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~([^~]+)~~/g, '~$1~')
    // Numbered lists: 1. item → • item
    .replace(/^\\d+\\.\\s+/gm, '• ')
    // Dashes to bullets: - item → • item (at start of line)
    .replace(/^-\\s+/gm, '• ');

  results.push({
    json: {
      ...item.json,
      output: formatted,
      text: formatted,
      response: formatted,
    }
  });
}

return results;`;

interface N8nNode {
  id: string;
  name: string;
  type: string;
  position: number[];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
}

interface N8nConnectionTarget {
  node: string;
  type: string;
  index: number;
}

interface N8nConnection {
  main?: N8nConnectionTarget[][];
  ai_tool?: N8nConnectionTarget[][];
}

interface N8nWorkflow {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: Record<string, N8nConnection>;
  settings?: Record<string, unknown>;
}

async function addSlackFormatterNode(): Promise<void> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
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

  // Log all nodes for debugging
  logger.info("Workflow nodes:");
  for (const node of workflow.nodes) {
    logger.info(`  - ${node.name} (${node.type})`);
  }

  // Check if formatter node already exists
  const existingFormatter = workflow.nodes.find(
    (n) => n.name === "Slack Formatter",
  );
  if (existingFormatter) {
    logger.info("Slack Formatter node already exists, updating code...");
    existingFormatter.parameters = {
      jsCode: FORMATTER_CODE,
      mode: "runOnceForAllItems",
    };
  } else {
    // Find AI Agent node
    const agentNode = workflow.nodes.find(
      (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
    );
    if (!agentNode) {
      throw new Error("AI Agent node not found in workflow");
    }
    logger.info(`Found AI Agent node: ${agentNode.name}`);

    // Find Slack Response node (likely named "Slack" or contains "Slack")
    const slackResponseNode = workflow.nodes.find(
      (n) =>
        n.name.toLowerCase().includes("slack") &&
        n.type.includes("slack") &&
        !n.name.toLowerCase().includes("trigger"),
    );

    if (!slackResponseNode) {
      // Try to find by connection from AI Agent
      logger.warn(
        "Could not find Slack Response node by name, looking at connections...",
      );
      const agentConnections = workflow.connections[agentNode.name];
      if (agentConnections?.main?.[0]) {
        const targetNodeName = agentConnections.main[0][0]?.node;
        const targetNode = workflow.nodes.find(
          (n) => n.name === targetNodeName,
        );
        if (targetNode) {
          logger.info(`Found target node via connection: ${targetNode.name}`);
        }
      }
    }

    // Create the Slack Formatter Code node
    const formatterNode: N8nNode = {
      id: crypto.randomUUID(),
      name: "Slack Formatter",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [agentNode.position[0] + 300, agentNode.position[1]],
      parameters: {
        jsCode: FORMATTER_CODE,
        mode: "runOnceForAllItems",
      },
    };

    workflow.nodes.push(formatterNode);
    logger.info("Created Slack Formatter node");

    // Update connections: Insert formatter between AI Agent and its target
    const agentConnections = workflow.connections[agentNode.name];
    if (agentConnections?.main?.[0]) {
      const originalTarget = agentConnections.main[0][0];
      logger.info(
        `Original connection: ${agentNode.name} → ${originalTarget.node}`,
      );

      // Point AI Agent → Slack Formatter
      agentConnections.main[0][0] = {
        node: formatterNode.name,
        type: "main",
        index: 0,
      };
      logger.info(`Updated: ${agentNode.name} → ${formatterNode.name}`);

      // Add Slack Formatter → original target
      workflow.connections[formatterNode.name] = {
        main: [[originalTarget]],
      };
      logger.info(`Added: ${formatterNode.name} → ${originalTarget.node}`);
    } else {
      logger.warn("No main connections found from AI Agent node");
      // Still add the node, manual connection may be needed
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

  logger.info("Successfully added Slack Formatter node to workflow!");
  logger.info("");
  logger.info("The formatter will now convert ALL AI responses:");
  logger.info("  **bold** → *bold*");
  logger.info("  # Heading → *Heading*");
  logger.info("  [text](url) → <url|text>");
  logger.info("  ~~strike~~ → ~strike~");
  logger.info("  1. numbered → • bullet");
  logger.info("");
  logger.info(
    "Test with: @Ela what are the engagement metrics for #help-me-platform?",
  );
}

addSlackFormatterNode()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add Slack Formatter node", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
