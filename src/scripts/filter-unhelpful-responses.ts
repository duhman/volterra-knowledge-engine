#!/usr/bin/env npx tsx
/**
 * Filter Unhelpful AI Responses in #help-me-platform Support Workflow
 *
 * This script adds a Code node that filters out "can't help" responses
 * before they're posted to Slack. When the AI receives incomplete form
 * submissions or can't extract meaningful context, it stays silent
 * instead of posting unhelpful messages.
 *
 * Usage:
 *   npm run filter:unhelpful
 *   npm run filter:unhelpful -- --dry-run
 *   npm run filter:unhelpful -- --remove
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
const FILTER_NODE_NAME = "Response Quality Filter";

/**
 * Filter logic that detects unhelpful AI responses
 */
const FILTER_CODE = `
// Filter unhelpful AI responses before posting to Slack
// Returns empty array to stop execution when response would be unhelpful

const items = $input.all();

const unhelpfulPatterns = [
  // Empty form submission patterns
  "I don't see any issue description",
  "I don't see any issue details",  // variant phrasing
  "looks like the form came through empty",
  "the following fields are missing",
  "came through without any issue description",
  "No message content found",
  "message content is empty",  // variant phrasing

  // Request for more info patterns
  "could you re-share",
  "To proceed, could you",
  "To be able to triage this properly",
  "To help triage this properly",  // variant phrasing
  "couldn't match this to any known issue patterns without that context",
  "could you confirm",  // confirmation request

  // Generic unable to help
  "I'm unable to help with this request",
  "I need more information to",
  "please provide more details",
];

return items.filter(item => {
  const output = item.json.output || item.json.text || '';
  const lowerOutput = output.toLowerCase();

  // Check if response matches any unhelpful pattern
  const isUnhelpful = unhelpfulPatterns.some(pattern =>
    lowerOutput.includes(pattern.toLowerCase())
  );

  if (isUnhelpful) {
    console.log('Blocked unhelpful response:', output.slice(0, 150) + '...');
    return false; // Filter out - won't reach Slack
  }

  return true; // Allow through to Slack
});
`;

/**
 * Create the filter Code node
 */
function createFilterNode(existingNodes: WorkflowNode[]): WorkflowNode {
  // Find Slack Formatter node to position after it
  const formatterNode = existingNodes.find((n) => n.name === "Slack Formatter");

  // Position to the right of Slack Formatter
  const position: [number, number] = formatterNode?.position
    ? [formatterNode.position[0] + 300, formatterNode.position[1]]
    : [1600, 400];

  return {
    name: FILTER_NODE_NAME,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: {
      jsCode: FILTER_CODE,
      mode: "runOnceForAllItems",
    },
  };
}

/**
 * Check if the workflow already has a filter node
 */
function findFilterNode(nodes: WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find(
    (n) =>
      n.name === FILTER_NODE_NAME ||
      (n.type === "n8n-nodes-base.code" &&
        JSON.stringify(n.parameters).includes("unhelpfulPatterns")),
  );
}

/**
 * Insert filter node between Slack Formatter and Slack Response
 */
function insertFilterNode(
  connections: WorkflowConnections,
  formatterNodeName: string,
  filterNodeName: string,
  slackResponseNodeName: string,
): WorkflowConnections {
  const updated = JSON.parse(
    JSON.stringify(connections),
  ) as WorkflowConnections;

  // Find current connection from Slack Formatter to Slack Response
  const formatterOutputs = updated[formatterNodeName]?.main?.[0] || [];
  const slackIndex = formatterOutputs.findIndex(
    (conn: ConnectionEndpoint) => conn.node === slackResponseNodeName,
  );

  if (slackIndex === -1) {
    logger.warn(
      `Could not find connection from ${formatterNodeName} to ${slackResponseNodeName}`,
    );
    // Still add the filter node, connect after formatter
    if (!updated[formatterNodeName]) {
      updated[formatterNodeName] = {};
    }
    if (!updated[formatterNodeName].main) {
      updated[formatterNodeName].main = [[]];
    }
    updated[formatterNodeName].main[0].push({
      node: filterNodeName,
      type: "main",
      index: 0,
    } as ConnectionEndpoint);
    return updated;
  }

  // Remove direct connection from Slack Formatter to Slack Response
  formatterOutputs.splice(slackIndex, 1);

  // Add connection from Slack Formatter to Filter node
  formatterOutputs.push({
    node: filterNodeName,
    type: "main",
    index: 0,
  } as ConnectionEndpoint);

  // Add connection from Filter node to Slack Response
  updated[filterNodeName] = {
    main: [
      [
        {
          node: slackResponseNodeName,
          type: "main",
          index: 0,
        } as ConnectionEndpoint,
      ],
    ],
  };

  return updated;
}

/**
 * Remove filter node and restore direct connection
 */
function removeFilterNode(
  nodes: WorkflowNode[],
  connections: WorkflowConnections,
  filterNodeName: string,
): { nodes: WorkflowNode[]; connections: WorkflowConnections } {
  // Remove the node
  const filteredNodes = nodes.filter((n) => n.name !== filterNodeName);

  // Find what the filter node connected to
  const filterConnections = connections[filterNodeName]?.main?.[0] || [];
  const downstreamNode = filterConnections[0]?.node;

  // Find what connected to the filter node
  const updatedConnections = JSON.parse(
    JSON.stringify(connections),
  ) as WorkflowConnections;

  for (const [nodeName, nodeConns] of Object.entries(updatedConnections)) {
    if (nodeConns.main) {
      for (const outputGroup of nodeConns.main) {
        const filterIndex = outputGroup.findIndex(
          (conn: ConnectionEndpoint) => conn.node === filterNodeName,
        );
        if (filterIndex !== -1) {
          // Reconnect to downstream node
          if (downstreamNode) {
            outputGroup[filterIndex] = {
              node: downstreamNode,
              type: "main",
              index: 0,
            } as ConnectionEndpoint;
          } else {
            outputGroup.splice(filterIndex, 1);
          }
        }
      }
    }
  }

  // Remove filter node's own connections
  delete updatedConnections[filterNodeName];

  return { nodes: filteredNodes, connections: updatedConnections };
}

async function saveWorkflow(
  apiUrl: string,
  apiKey: string,
  workflow: Workflow,
  nodes: WorkflowNode[],
  connections: WorkflowConnections,
): Promise<void> {
  // Prepare update payload (only allowed settings)
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

  logger.info("Saving workflow...");

  const updateResponse = await fetch(`${apiUrl}/workflows/${WORKFLOW_ID}`, {
    method: "PUT",
    headers: {
      "X-N8N-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: workflow.name,
      nodes,
      connections,
      settings: allowedSettings,
    }),
  });

  if (!updateResponse.ok) {
    const errorText = await updateResponse.text();
    throw new Error(
      `Failed to update workflow: ${updateResponse.status} ${updateResponse.statusText}\n${errorText}`,
    );
  }
}

async function main(): Promise<void> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  const isDryRun = process.argv.includes("--dry-run");
  const isRemove = process.argv.includes("--remove");

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

  const workflow = (await getResponse.json()) as Workflow;
  logger.info(`Got workflow: ${workflow.name}`);
  logger.info(`Current nodes: ${workflow.nodes.map((n) => n.name).join(", ")}`);

  // Check if filter node exists
  const existingFilter = findFilterNode(workflow.nodes);

  if (isRemove) {
    if (!existingFilter) {
      logger.info("No filter node found. Nothing to remove.");
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log("REMOVING RESPONSE QUALITY FILTER:");
    console.log("=".repeat(60));
    console.log(`\nNode to remove: ${existingFilter.name}`);

    if (isDryRun) {
      console.log("\n[DRY RUN] Would remove filter node.");
      console.log("Run without --dry-run to apply changes.");
      return;
    }

    const { nodes: updatedNodes, connections: updatedConnections } =
      removeFilterNode(
        workflow.nodes,
        workflow.connections,
        existingFilter.name,
      );

    await saveWorkflow(
      apiUrl,
      apiKey,
      workflow,
      updatedNodes,
      updatedConnections,
    );

    console.log("\n✅ Filter node removed successfully!");
    console.log("Direct connection restored: Slack Formatter → Slack Response");
    return;
  }

  // Adding mode
  if (existingFilter) {
    logger.info(`Filter node already exists: ${existingFilter.name}`);
    logger.info("Use --remove to remove it, or update manually.");
    return;
  }

  // 2. Find required nodes
  const formatterNode = workflow.nodes.find(
    (n) => n.name === "Slack Formatter",
  );
  if (!formatterNode) {
    throw new Error("Slack Formatter node not found in workflow");
  }
  logger.info(`Found Slack Formatter node: ${formatterNode.name}`);

  const slackResponseNode = workflow.nodes.find(
    (n) => n.name === "Slack Response",
  );
  if (!slackResponseNode) {
    throw new Error("Slack Response node not found in workflow");
  }
  logger.info(`Found Slack Response node: ${slackResponseNode.name}`);

  // Verify current connection exists
  const currentConnection = workflow.connections[
    "Slack Formatter"
  ]?.main?.[0]?.find((conn) => conn.node === "Slack Response");
  if (!currentConnection) {
    logger.warn(
      "Warning: No direct connection from Slack Formatter to Slack Response found",
    );
    logger.info("Will create new connections anyway...");
  }

  // 3. Create filter node
  const filterNode = createFilterNode(workflow.nodes);

  console.log("\n" + "=".repeat(60));
  console.log("PLANNED CHANGES:");
  console.log("=".repeat(60));
  console.log(`\nNew node: ${filterNode.name}`);
  console.log(`  Type: ${filterNode.type}`);
  console.log(`  Position: [${filterNode.position.join(", ")}]`);
  console.log("\nFilter patterns (will block responses containing):");
  console.log('  • "I don\'t see any issue description"');
  console.log('  • "looks like the form came through empty"');
  console.log('  • "could you re-share"');
  console.log('  • "To proceed, could you"');
  console.log("  • ...and more (see FILTER_CODE)");
  console.log(
    `\nConnection: ${formatterNode.name} → ${filterNode.name} → ${slackResponseNode.name}`,
  );
  console.log("\nNote: Store AI Response continues to receive ALL responses");
  console.log("      (parallel path from AI Agent, unaffected by filter)");
  console.log("=".repeat(60));

  if (isDryRun) {
    console.log("\n[DRY RUN] Would add filter node.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // 4. Add node and update connections
  const updatedNodes = [...workflow.nodes, filterNode];
  const updatedConnections = insertFilterNode(
    workflow.connections,
    formatterNode.name,
    filterNode.name,
    slackResponseNode.name,
  );

  // 5. Save workflow
  await saveWorkflow(
    apiUrl,
    apiKey,
    workflow,
    updatedNodes,
    updatedConnections,
  );

  console.log("\n" + "=".repeat(60));
  console.log("SUCCESS!");
  console.log("=".repeat(60));
  logger.info("Added response quality filter to support workflow!");
  console.log("\nHow it works:");
  console.log("  1. AI Agent responds to support request");
  console.log("  2. Slack Formatter formats the response");
  console.log("  3. Response Quality Filter checks for unhelpful patterns");
  console.log("  4. If unhelpful → execution stops (no Slack post)");
  console.log("  5. If helpful → posted to Slack");
  console.log("\nAnalytics unaffected:");
  console.log(
    "  Store AI Response still receives ALL responses (parallel path)",
  );
  console.log("\nTo remove the filter:");
  console.log("  npm run filter:unhelpful -- --remove");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add response filter", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
