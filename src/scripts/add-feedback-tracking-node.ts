#!/usr/bin/env npx tsx
/**
 * Add AI Feedback Tracking to #help-me-platform Support Workflow
 *
 * This script adds nodes to the AI agent support workflow that:
 * 1. Store each AI response in ai_response_feedback table
 * 2. Detect when a human responds after the AI (potential correction)
 * 3. Record the correction for accuracy analysis
 *
 * This enables tracking AI response quality over time and identifying
 * areas where the AI frequently makes mistakes.
 *
 * Usage:
 *   npm run support:add-feedback-tracking
 *   npm run support:add-feedback-tracking -- --dry-run
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

const WORKFLOW_ID = "UtsHZSFSpXa6arFN"; // AI agent support - Slack

interface N8nApiResponse extends Workflow {
  // Additional fields from API
}

/**
 * Create the Supabase node that stores AI responses
 */
function createStoreFeedbackNode(existingNodes: WorkflowNode[]): WorkflowNode {
  // Find the AI Agent node to position near it
  const agentNode = existingNodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  // Position below and to the right of AI Agent
  const position: [number, number] = agentNode?.position
    ? [agentNode.position[0] + 300, agentNode.position[1] + 200]
    : [1200, 600];

  return {
    name: "Store AI Response",
    type: "n8n-nodes-base.supabase",
    typeVersion: 1,
    position,
    parameters: {
      resource: "table",
      operation: "insert",
      tableId: "ai_response_feedback",
      fieldsUi: {
        fieldValues: [
          {
            fieldId: "thread_ts",
            fieldValue:
              "={{ $('Extract Message').item.json.thread_ts || $('Extract Message').item.json.ts }}",
          },
          {
            fieldId: "channel_id",
            fieldValue: "={{ $('Extract Message').item.json.channel }}",
          },
          {
            fieldId: "ai_response_ts",
            fieldValue: "={{ $now.toMillis().toString() }}", // Will be replaced by actual Slack response ts
          },
          {
            fieldId: "ai_response_text",
            fieldValue: "={{ $('AI Agent').item.json.output }}",
          },
        ],
      },
      options: {
        returnFields: ["id"],
        onConflict: "do_nothing",
      },
    },
    credentials: {
      supabaseApi: {
        id: "o9MVDNVDiDduF7Ys", // Supabase account 2 (used by other workflows)
        name: "Supabase account 2",
      },
    },
    // This node runs in parallel after AI Agent - don't block the main flow
    continueOnFail: true,
  };
}

/**
 * Check if the workflow already has feedback tracking
 */
function findFeedbackNode(nodes: WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find(
    (n) =>
      n.name === "Store AI Response" ||
      n.name.toLowerCase().includes("feedback") ||
      (n.type === "n8n-nodes-base.supabase" &&
        JSON.stringify(n.parameters).includes("ai_response_feedback")),
  );
}

/**
 * Add feedback node connection to run after AI Agent
 */
function addFeedbackConnection(
  connections: WorkflowConnections,
  agentNodeName: string,
  feedbackNodeName: string,
): WorkflowConnections {
  const updated = JSON.parse(
    JSON.stringify(connections),
  ) as WorkflowConnections;

  // Find existing connections from AI Agent
  if (!updated[agentNodeName]) {
    updated[agentNodeName] = {};
  }

  // Add main output connection to feedback node
  if (!updated[agentNodeName].main) {
    updated[agentNodeName].main = [[]];
  }

  // Add feedback node as an additional destination (parallel execution)
  const existingMainOutputs = updated[agentNodeName].main[0] || [];

  // Check if already connected
  const alreadyConnected = existingMainOutputs.some(
    (conn: ConnectionEndpoint) => conn.node === feedbackNodeName,
  );

  if (!alreadyConnected) {
    updated[agentNodeName].main[0] = [
      ...existingMainOutputs,
      {
        node: feedbackNodeName,
        type: "main",
        index: 0,
      } as ConnectionEndpoint,
    ];
  }

  return updated;
}

async function addFeedbackTracking(): Promise<void> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  const isDryRun = process.argv.includes("--dry-run");

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

  const workflow = (await getResponse.json()) as N8nApiResponse;
  logger.info(`Got workflow: ${workflow.name}`);
  logger.info(`Current nodes: ${workflow.nodes.map((n) => n.name).join(", ")}`);

  // 2. Check if feedback tracking already exists
  const existingFeedback = findFeedbackNode(workflow.nodes);

  if (existingFeedback) {
    logger.info(`Feedback tracking already exists: ${existingFeedback.name}`, {
      type: existingFeedback.type,
    });
    logger.info("No changes needed.");
    return;
  }

  // 3. Find required nodes
  const agentNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  if (!agentNode) {
    throw new Error("AI Agent node not found in workflow");
  }

  logger.info(`Found AI Agent node: ${agentNode.name}`);

  const extractMessageNode = workflow.nodes.find(
    (n) => n.name === "Extract Message",
  );

  if (!extractMessageNode) {
    logger.warn(
      'Warning: "Extract Message" node not found. Field references may need adjustment.',
    );
  }

  // 4. Create feedback tracking node
  const feedbackNode = createStoreFeedbackNode(workflow.nodes);

  console.log("\n" + "=".repeat(60));
  console.log("PLANNED CHANGES:");
  console.log("=".repeat(60));
  console.log(`\nNew node: ${feedbackNode.name}`);
  console.log(`  Type: ${feedbackNode.type}`);
  console.log(`  Position: [${feedbackNode.position.join(", ")}]`);
  console.log(`  Table: ai_response_feedback`);
  console.log(
    `  Fields: thread_ts, channel_id, ai_response_ts, ai_response_text`,
  );
  console.log(
    `\nConnection: ${agentNode.name} → ${feedbackNode.name} (parallel)`,
  );
  console.log("=".repeat(60));

  if (isDryRun) {
    console.log("\n[DRY RUN] Would add feedback tracking node.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // 5. Add node to workflow
  const updatedNodes = [...workflow.nodes, feedbackNode];

  // 6. Add connection
  const updatedConnections = addFeedbackConnection(
    workflow.connections,
    agentNode.name,
    feedbackNode.name,
  );

  // 7. Prepare update payload
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

  // 8. Update workflow
  logger.info("Saving workflow with feedback tracking...");

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

  console.log("\n" + "=".repeat(60));
  console.log("SUCCESS!");
  console.log("=".repeat(60));
  logger.info("Added AI feedback tracking to support workflow!");
  logger.info(
    `Updated nodes: ${updatedWorkflow.nodes.map((n) => n.name).join(", ")}`,
  );
  console.log("\nWhat's now tracked:");
  console.log("  - AI responses stored in ai_response_feedback table");
  console.log("  - Thread context preserved for correlation");
  console.log("  - Response text captured for accuracy analysis");
  console.log("\nNext steps:");
  console.log("  1. Apply migration: Run the SQL in Supabase Dashboard");
  console.log(
    "     supabase/migrations/20260129140000_add_ai_feedback_tracking.sql",
  );
  console.log("  2. Deploy the prompt update: npm run improve:support-prompt");
  console.log(
    "  3. Monitor: SELECT * FROM volterra_kb.ai_response_feedback ORDER BY created_at DESC;",
  );
  console.log("=".repeat(60));
}

addFeedbackTracking()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add feedback tracking", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
