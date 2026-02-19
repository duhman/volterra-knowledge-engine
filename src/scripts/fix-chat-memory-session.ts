#!/usr/bin/env npx tsx
/**
 * Fix Chat Interface Memory Session ID Error
 *
 * Problem: The @Ela Chat Interface workflow (iVcW0pyvfWPPQufj) is failing with:
 *   "Error in sub-node 'Simple Memory': No session ID found"
 *
 * Root Cause: The Simple Memory node has empty parameters ({}), meaning it has
 * no session ID configuration. The node doesn't know how to identify which
 * conversation context to use.
 *
 * Solution: Configure the Simple Memory node with sessionIdOption: "fromInput"
 * which tells n8n to use the session ID automatically provided by the Chat Trigger node.
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type { Workflow, WorkflowNode } from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID"; // AI agent chat (Chat Interface)

interface N8nApiResponse extends Workflow {}

/**
 * Find memory nodes in the workflow (Simple Memory or Window Buffer Memory)
 */
function findMemoryNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.filter(
    (n) =>
      n.type === "@n8n/n8n-nodes-langchain.memoryBufferWindow" ||
      n.name.toLowerCase().includes("memory"),
  );
}

/**
 * Fix memory node parameters for Chat Trigger workflows
 */
function fixMemoryNodeForChatTrigger(node: WorkflowNode): WorkflowNode {
  return {
    ...node,
    parameters: {
      ...node.parameters,
      // Use session ID from the Chat Trigger input
      sessionIdOption: "fromInput",
      // Remember last 10 messages in the conversation
      contextWindowLength: 10,
    },
  };
}

async function fixChatMemorySession(): Promise<void> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  // 1. Get current workflow
  logger.info(`Fetching workflow ${WORKFLOW_ID}...`);
  const getResponse = await fetch(`${apiUrl}/workflows/${WORKFLOW_ID}`, {
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

  const workflow: N8nApiResponse = (await getResponse.json()) as N8nApiResponse;
  logger.info(`Got workflow: ${workflow.name}`);
  logger.info(`Current nodes: ${workflow.nodes.map((n) => n.name).join(", ")}`);

  // 2. Find memory nodes
  const memoryNodes = findMemoryNodes(workflow.nodes);

  if (memoryNodes.length === 0) {
    logger.warn("No memory nodes found in workflow");
    logger.info("Available nodes and their types:");
    for (const node of workflow.nodes) {
      logger.info(`  - ${node.name}: ${node.type}`);
    }
    return;
  }

  logger.info(`Found ${memoryNodes.length} memory node(s):`);
  for (const node of memoryNodes) {
    logger.info(`  - ${node.name} (${node.type})`);
    logger.info(
      `    Current parameters: ${JSON.stringify(node.parameters || {})}`,
    );
  }

  // 3. Check if fix is needed
  const nodesToFix = memoryNodes.filter((node) => {
    const params = node.parameters || {};
    // Fix if sessionIdOption is missing or not set to "fromInput"
    return params.sessionIdOption !== "fromInput";
  });

  if (nodesToFix.length === 0) {
    logger.info(
      "All memory nodes already have correct sessionIdOption, no changes needed",
    );
    return;
  }

  // 4. Apply fixes
  logger.info(`Fixing ${nodesToFix.length} memory node(s)...`);

  const updatedNodes = workflow.nodes.map((node) => {
    const needsFix = nodesToFix.some((n) => n.name === node.name);
    if (needsFix) {
      const fixed = fixMemoryNodeForChatTrigger(node);
      logger.info(`  Fixed ${node.name}:`);
      logger.info(`    New parameters: ${JSON.stringify(fixed.parameters)}`);
      return fixed;
    }
    return node;
  });

  // 5. Prepare update payload (only allowed settings)
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

  // 6. Update workflow
  logger.info("Saving updated workflow...");

  const updateResponse = await fetch(`${apiUrl}/workflows/${WORKFLOW_ID}`, {
    method: "PUT",
    headers: {
      "X-N8N-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: workflow.name,
      nodes: updatedNodes,
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

  const updatedWorkflow = (await updateResponse.json()) as N8nApiResponse;

  logger.info(
    "Successfully fixed Chat Interface memory session configuration!",
  );
  logger.info("");
  logger.info("Changes applied:");
  logger.info(
    "  - sessionIdOption: 'fromInput' (uses Chat Trigger's session ID)",
  );
  logger.info("  - contextWindowLength: 10 (remembers last 10 messages)");
  logger.info("");
  logger.info("Test the fix:");
  logger.info("  1. Open the chat interface:");
  logger.info(
    "     https://your-n8n-instance.example.com/webhook/53c136fe-3e77-4709-a143-fe82746dd8b6/chat",
  );
  logger.info(
    "  2. Send a message - should no longer see 'No session ID found' error",
  );
}

fixChatMemorySession()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to fix chat memory session", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
