#!/usr/bin/env npx tsx
/**
 * Fix @Ela "No response received" streaming error
 *
 * Problem: @Ela returns "No response received. This could happen if streaming
 * is enabled in the trigger but disabled in agent node(s)"
 *
 * Root cause: Mismatch between Chat Trigger responseMode and AI Agent streaming settings.
 * According to n8n docs: "Both the input node (Chat Trigger) and the output node (AI Agent)
 * must have streaming enabled for chat streaming to work."
 *
 * Solution:
 * 1. Set Chat Trigger responseMode to "lastNode" (non-streaming) as a workaround
 * 2. Or ensure all nodes in the chain have streaming properly configured
 *
 * Pass --disable-streaming to disable streaming entirely (recommended workaround)
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";

config();

interface N8nNode {
  id: string;
  name: string;
  type: string;
  position: number[];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
}

interface N8nWorkflow {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

async function fixElaStreaming(): Promise<void> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  const workflowId = "YOUR_WORKFLOW_ID"; // AI agent chat (the workflow with streaming issue)

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

  const disableStreaming = process.argv.includes("--disable-streaming");
  let changesNeeded = false;

  // Find Chat Trigger node
  const chatTrigger = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.chatTrigger",
  );

  if (chatTrigger) {
    logger.info(`Found Chat Trigger node: ${chatTrigger.name}`);
    logger.info(`  typeVersion: ${chatTrigger.typeVersion}`);

    if (!chatTrigger.parameters) {
      chatTrigger.parameters = {};
    }
    if (!chatTrigger.parameters.options) {
      chatTrigger.parameters.options = {};
    }

    const triggerOptions = chatTrigger.parameters.options as Record<
      string,
      unknown
    >;
    // responseMode is inside options, not at top level of parameters
    // Also check legacy location for backwards compatibility
    const currentResponseMode =
      triggerOptions.responseMode ?? chatTrigger.parameters.responseMode;
    logger.info(
      `  responseMode: ${currentResponseMode === undefined ? "undefined (default=streaming)" : currentResponseMode}`,
    );

    if (disableStreaming) {
      // Set to "lastNode" to disable streaming and wait for AI Agent to complete
      // Note: responseMode goes in options for typeVersion 1.2+
      if (currentResponseMode !== "lastNode") {
        logger.info("  → Setting responseMode to 'lastNode' (non-streaming)");
        triggerOptions.responseMode = "lastNode";
        // Remove legacy location if it exists
        delete chatTrigger.parameters.responseMode;
        changesNeeded = true;
      }
    } else {
      // Enable streaming
      if (currentResponseMode !== "streaming") {
        logger.info("  → Setting responseMode to 'streaming'");
        triggerOptions.responseMode = "streaming";
        // Remove legacy location if it exists
        delete chatTrigger.parameters.responseMode;
        changesNeeded = true;
      }
    }
  } else {
    logger.warn("Chat Trigger node not found");
  }

  // Find and fix AI Agent node
  const agentNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  if (!agentNode) {
    throw new Error("AI Agent node not found in workflow");
  }

  logger.info(`Found AI Agent node: ${agentNode.name}`);

  // Ensure parameters.options exists for agent
  if (!agentNode.parameters) {
    agentNode.parameters = {};
  }
  if (!agentNode.parameters.options) {
    agentNode.parameters.options = {};
  }

  const agentOptions = agentNode.parameters.options as Record<string, unknown>;

  if (disableStreaming) {
    // Disable streaming on agent
    if (agentOptions.streaming !== false) {
      logger.info("Disabling streaming on AI Agent...");
      agentOptions.streaming = false;
      changesNeeded = true;
    }
  } else {
    // Enable streaming on agent
    if (agentOptions.streaming !== true) {
      logger.info(
        `AI Agent streaming: ${agentOptions.streaming === undefined ? "undefined" : agentOptions.streaming} → true`,
      );
      agentOptions.streaming = true;
      changesNeeded = true;
    } else {
      logger.info("AI Agent streaming: already enabled");
    }
  }

  // Find and fix OpenAI Chat Model node
  const modelNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  );

  if (modelNode) {
    logger.info(`Found OpenAI Model node: ${modelNode.name}`);

    // Ensure parameters.options exists for model
    if (!modelNode.parameters) {
      modelNode.parameters = {};
    }
    if (!modelNode.parameters.options) {
      modelNode.parameters.options = {};
    }

    const modelOptions = modelNode.parameters.options as Record<
      string,
      unknown
    >;

    if (disableStreaming) {
      // Disable streaming on model
      if (modelOptions.streaming !== false) {
        logger.info("Disabling streaming on OpenAI Model...");
        modelOptions.streaming = false;
        changesNeeded = true;
      }
    } else {
      // Enable streaming on model
      if (modelOptions.streaming !== true) {
        logger.info(
          `OpenAI Model streaming: ${modelOptions.streaming === undefined ? "undefined" : modelOptions.streaming} → true`,
        );
        modelOptions.streaming = true;
        changesNeeded = true;
      } else {
        logger.info("OpenAI Model streaming: already enabled");
      }
    }
  } else {
    logger.warn("OpenAI Model node not found");
  }

  if (!changesNeeded) {
    logger.info("No changes needed.");
    return;
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

  if (disableStreaming) {
    logger.info("Successfully disabled streaming for @Ela!");
    logger.info(
      "The chat will now wait for the full response before displaying.",
    );
  } else {
    logger.info("Successfully enabled streaming for @Ela!");
  }
  logger.info(
    "Test at: https://your-n8n-instance.example.com/webhook/53c136fe-3e77-4709-a143-fe82746dd8b6/chat",
  );
}

fixElaStreaming()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to fix streaming", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
