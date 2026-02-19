#!/usr/bin/env npx tsx
/**
 * Add Window Buffer Memory to @Ela Slack workflow
 *
 * Problem: @Ela loses conversational context in Slack threads. When a user asks
 * a follow-up question like "last month", @Ela doesn't remember what was asked
 * in the previous message.
 *
 * Solution: Add a Window Buffer Memory node that uses thread_ts as the session key,
 * allowing n8n to maintain context within a Slack thread conversation.
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type {
  Workflow,
  WorkflowNode,
  WorkflowConnections,
  ConnectionEndpoint,
} from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID"; // AI agent chat - Slack

interface N8nApiResponse extends Workflow {
  // Additional fields that may come from API
}

/**
 * Create the Window Buffer Memory node configuration
 */
function createMemoryNode(existingNodes: WorkflowNode[]): WorkflowNode {
  // Find a position near the AI Agent node
  const agentNode = existingNodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  // Position the memory node above and to the left of the AI Agent
  const position: [number, number] = agentNode?.position
    ? [agentNode.position[0] - 200, agentNode.position[1] - 100]
    : [600, 200];

  return {
    name: "Thread Memory",
    type: "@n8n/n8n-nodes-langchain.memoryBufferWindow",
    typeVersion: 1.3,
    position,
    parameters: {
      // Use thread_ts as session key - this ensures each Slack thread has its own memory
      sessionKey: "={{ $('Extract Message').item.json.thread_ts }}",
      // Remember last 10 messages in the thread
      contextWindowLength: 10,
    },
  };
}

/**
 * Add memory node connections to the AI Agent
 */
function addMemoryConnection(
  connections: WorkflowConnections,
  memoryNodeName: string,
  agentNodeName: string,
): WorkflowConnections {
  // Clone connections to avoid mutating original
  const updatedConnections = JSON.parse(
    JSON.stringify(connections),
  ) as WorkflowConnections;

  // Add the memory node connection to AI Agent's ai_memory input
  updatedConnections[memoryNodeName] = {
    ai_memory: [
      [
        {
          node: agentNodeName,
          type: "ai_memory",
          index: 0,
        } as ConnectionEndpoint,
      ],
    ],
  };

  return updatedConnections;
}

/**
 * Find existing memory node in workflow
 */
function findMemoryNode(nodes: WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find(
    (n) =>
      n.type === "@n8n/n8n-nodes-langchain.memoryBufferWindow" ||
      n.type.includes("memory"),
  );
}

/**
 * Ensure memory node has adequate context window
 */
function ensureMemoryConfig(
  memoryNode: WorkflowNode,
  minContextWindow: number = 10,
): { updated: boolean; node: WorkflowNode } {
  const currentWindow =
    (memoryNode.parameters?.contextWindowLength as number) || 0;

  if (currentWindow >= minContextWindow) {
    return { updated: false, node: memoryNode };
  }

  // Update the context window length
  return {
    updated: true,
    node: {
      ...memoryNode,
      parameters: {
        ...memoryNode.parameters,
        contextWindowLength: minContextWindow,
      },
    },
  };
}

async function addMemoryToElaWorkflow(): Promise<void> {
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

  // 2. Check if memory node already exists
  const existingMemory = findMemoryNode(workflow.nodes);

  if (existingMemory) {
    logger.info(`Found existing memory node: ${existingMemory.name}`, {
      type: existingMemory.type,
      parameters: existingMemory.parameters,
    });

    // Ensure it has adequate context window
    const { updated, node: updatedMemoryNode } = ensureMemoryConfig(
      existingMemory,
      10,
    );

    if (!updated) {
      logger.info(
        "Memory node already has adequate contextWindowLength, no changes needed",
      );
      logger.info("");
      logger.info(
        "If @Ela is still losing context, run the formatting update script:",
      );
      logger.info("  npm run ela:update-formatting");
      return;
    }

    // Update the memory node with new config
    logger.info(
      `Updating memory node contextWindowLength to ${updatedMemoryNode.parameters?.contextWindowLength}`,
    );

    const updatedNodes = workflow.nodes.map((n) =>
      n.name === existingMemory.name ? updatedMemoryNode : n,
    );

    // Prepare update payload
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

    logger.info("Successfully updated memory node contextWindowLength!");
    logger.info("");
    logger.info(
      "Next step: Update the AI Agent's system prompt for thread awareness:",
    );
    logger.info("  npm run ela:update-formatting");
    return;
  }

  // 3. Find the AI Agent node
  const agentNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  if (!agentNode) {
    throw new Error("AI Agent node not found in workflow");
  }

  logger.info(`Found AI Agent node: ${agentNode.name}`);

  // 4. Find the Extract Message node to verify it exists (for session key expression)
  const extractMessageNode = workflow.nodes.find(
    (n) => n.name === "Extract Message",
  );

  if (!extractMessageNode) {
    logger.warn(
      'Warning: "Extract Message" node not found. The session key expression may need adjustment.',
    );
  } else {
    logger.info(`Found Extract Message node: ${extractMessageNode.name}`);
  }

  // 5. Create memory node
  const memoryNode = createMemoryNode(workflow.nodes);
  logger.info(`Creating memory node: ${memoryNode.name}`, {
    type: memoryNode.type,
    sessionKey: memoryNode.parameters.sessionKey,
    contextWindowLength: memoryNode.parameters.contextWindowLength,
  });

  // 6. Add memory node to workflow nodes
  const updatedNodes = [...workflow.nodes, memoryNode];

  // 7. Add memory connection to AI Agent
  const updatedConnections = addMemoryConnection(
    workflow.connections,
    memoryNode.name,
    agentNode.name,
  );

  // 8. Prepare update payload (only allowed settings)
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

  // 9. Update workflow
  logger.info("Saving updated workflow with memory node...");

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
      connections: updatedConnections,
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

  logger.info("Successfully added Thread Memory node to @Ela workflow!");
  logger.info(
    `Updated nodes: ${updatedWorkflow.nodes.map((n) => n.name).join(", ")}`,
  );
  logger.info("");
  logger.info("Test the fix with a multi-turn conversation:");
  logger.info(
    "  1. @Ela what are the support ticket statistics for help-me-platform?",
  );
  logger.info("  2. [Ela asks: this month or last month?]");
  logger.info("  3. last month");
  logger.info(
    "  4. [Ela should now respond with December statistics, NOT ask for clarification]",
  );
}

addMemoryToElaWorkflow()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add memory node", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
