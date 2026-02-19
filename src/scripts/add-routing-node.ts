#!/usr/bin/env npx tsx
/**
 * Add Routing Suggestion Node to #help-me-platform Support Workflow
 *
 * This script adds a fallback Code node that ensures routing suggestions
 * are added to AI responses when the AI doesn't include one.
 *
 * The AI Agent's system prompt includes routing rules, but this node
 * acts as a safety net for cases where:
 * - AI has low confidence and didn't suggest routing
 * - Issue clearly matches a specialist but AI missed it
 *
 * Usage:
 *   npm run support:add-routing
 *   npm run support:add-routing -- --dry-run
 *   npm run support:add-routing -- --remove
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

const WORKFLOW_ID = "YOUR_WORKFLOW_ID"; // AI agent support - Slack

/**
 * Routing rules - these match what's in the AI Agent's system prompt
 */
const ROUTING_CODE = `
// Routing rules for #help-me-platform support tickets
const routingRules = [
  {
    name: "Payment/Billing",
    routeTo: "@Billing Support",
    keywords: ["invoice", "payment", "billing", "subscription", "pricing", "refund", "charge", "outstanding"],
    subcategories: ["Invoice", "Subscription and pricing", "Payment"]
  },
  {
    name: "Charger/Hardware",
    routeTo: "@team-asset-management",
    keywords: ["charger offline", "hardware", "installation", "physical", "broken", "damaged"],
    subcategories: ["Charger offline", "Hardware failure", "Unstable charging"]
  },
  {
    name: "Ampeco/Integration",
    routeTo: "@Integration Support",
    keywords: ["ampeco", "api", "integration", "connectivity", "cloud error", "sync", "communication"],
    subcategories: ["IT / Cloud error"]
  }
];

// Get the AI response and issue context
const aiResponse = $('AI Agent').item.json.output || '';
const issueSubcategory = $('Issue Classifier').item.json.issue_subcategory || '';
const issueText = $('Extract Message').item.json.text || '';

// Check if AI already included a routing suggestion
const hasRouting = aiResponse.includes('📍') ||
                   aiResponse.toLowerCase().includes('routing suggestion') ||
                   aiResponse.includes('@Billing Support') ||
                   aiResponse.includes('@team-asset-management') ||
                   aiResponse.includes('@Integration Support');

if (hasRouting) {
  // AI already included routing, pass through unchanged
  return [{ json: { output: aiResponse, routing_added: false } }];
}

// Check if we should add routing based on subcategory or keywords
let matchedRule = null;
const lowerIssueText = issueText.toLowerCase();

for (const rule of routingRules) {
  // Check subcategory match
  if (rule.subcategories.some(sub => sub.toLowerCase() === issueSubcategory.toLowerCase())) {
    matchedRule = rule;
    break;
  }

  // Check keyword match in issue text
  if (rule.keywords.some(kw => lowerIssueText.includes(kw.toLowerCase()))) {
    matchedRule = rule;
    break;
  }
}

if (matchedRule) {
  // Add routing suggestion to the response
  const routingSuggestion = \`\\n\\n> 📍 *Routing suggestion:* This looks like a \${matchedRule.name} issue. \${matchedRule.routeTo} may be able to help.\`;
  return [{ json: { output: aiResponse + routingSuggestion, routing_added: true, matched_rule: matchedRule.name } }];
}

// No routing needed
return [{ json: { output: aiResponse, routing_added: false } }];
`;

/**
 * Create the Code node that adds routing suggestions
 */
function createRoutingNode(existingNodes: WorkflowNode[]): WorkflowNode {
  // Find the AI Agent node to position after it
  const agentNode = existingNodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  // Position to the right of AI Agent
  const position: [number, number] = agentNode?.position
    ? [agentNode.position[0] + 400, agentNode.position[1]]
    : [1400, 400];

  return {
    name: "Add Routing Suggestion",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: {
      jsCode: ROUTING_CODE,
      mode: "runOnceForAllItems",
    },
  };
}

/**
 * Check if the workflow already has a routing node
 */
function findRoutingNode(nodes: WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find(
    (n) =>
      n.name === "Add Routing Suggestion" ||
      (n.type === "n8n-nodes-base.code" &&
        JSON.stringify(n.parameters).includes("routingRules")),
  );
}

/**
 * Insert routing node between AI Agent and Slack response
 */
function insertRoutingNode(
  connections: WorkflowConnections,
  agentNodeName: string,
  routingNodeName: string,
  slackResponseNodeName: string,
): WorkflowConnections {
  const updated = JSON.parse(
    JSON.stringify(connections),
  ) as WorkflowConnections;

  // Find current connection from AI Agent to Slack response
  const agentOutputs = updated[agentNodeName]?.main?.[0] || [];
  const slackIndex = agentOutputs.findIndex(
    (conn: ConnectionEndpoint) => conn.node === slackResponseNodeName,
  );

  if (slackIndex === -1) {
    logger.warn(
      `Could not find connection from ${agentNodeName} to ${slackResponseNodeName}`,
    );
    // Still add the routing node, just connect after agent
    if (!updated[agentNodeName]) {
      updated[agentNodeName] = {};
    }
    if (!updated[agentNodeName].main) {
      updated[agentNodeName].main = [[]];
    }
    updated[agentNodeName].main[0].push({
      node: routingNodeName,
      type: "main",
      index: 0,
    } as ConnectionEndpoint);
    return updated;
  }

  // Remove direct connection from AI Agent to Slack
  agentOutputs.splice(slackIndex, 1);

  // Add connection from AI Agent to Routing node
  agentOutputs.push({
    node: routingNodeName,
    type: "main",
    index: 0,
  } as ConnectionEndpoint);

  // Add connection from Routing node to Slack response
  updated[routingNodeName] = {
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
 * Remove routing node and restore direct connection
 */
function removeRoutingNode(
  nodes: WorkflowNode[],
  connections: WorkflowConnections,
  routingNodeName: string,
): { nodes: WorkflowNode[]; connections: WorkflowConnections } {
  // Remove the node
  const filteredNodes = nodes.filter((n) => n.name !== routingNodeName);

  // Find what the routing node connected to
  const routingConnections = connections[routingNodeName]?.main?.[0] || [];
  const downstreamNode = routingConnections[0]?.node;

  // Find what connected to the routing node
  const updatedConnections = JSON.parse(
    JSON.stringify(connections),
  ) as WorkflowConnections;

  for (const [nodeName, nodeConns] of Object.entries(updatedConnections)) {
    if (nodeConns.main) {
      for (const outputGroup of nodeConns.main) {
        const routingIndex = outputGroup.findIndex(
          (conn: ConnectionEndpoint) => conn.node === routingNodeName,
        );
        if (routingIndex !== -1) {
          // Reconnect to downstream node
          if (downstreamNode) {
            outputGroup[routingIndex] = {
              node: downstreamNode,
              type: "main",
              index: 0,
            } as ConnectionEndpoint;
          } else {
            outputGroup.splice(routingIndex, 1);
          }
        }
      }
    }
  }

  // Remove routing node's own connections
  delete updatedConnections[routingNodeName];

  return { nodes: filteredNodes, connections: updatedConnections };
}

async function addRoutingNode(): Promise<void> {
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

  // Check if routing node exists
  const existingRouting = findRoutingNode(workflow.nodes);

  if (isRemove) {
    if (!existingRouting) {
      logger.info("No routing node found. Nothing to remove.");
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log("REMOVING ROUTING NODE:");
    console.log("=".repeat(60));
    console.log(`\nNode to remove: ${existingRouting.name}`);

    if (isDryRun) {
      console.log("\n[DRY RUN] Would remove routing node.");
      console.log("Run without --dry-run to apply changes.");
      return;
    }

    const { nodes: updatedNodes, connections: updatedConnections } =
      removeRoutingNode(
        workflow.nodes,
        workflow.connections,
        existingRouting.name,
      );

    // Update workflow
    await saveWorkflow(
      apiUrl,
      apiKey,
      workflow,
      updatedNodes,
      updatedConnections,
    );

    console.log("\n✅ Routing node removed successfully!");
    return;
  }

  // Adding mode
  if (existingRouting) {
    logger.info(`Routing node already exists: ${existingRouting.name}`);
    logger.info("Use --remove to remove it, or update manually.");
    return;
  }

  // 2. Find required nodes
  const agentNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  if (!agentNode) {
    throw new Error("AI Agent node not found in workflow");
  }

  logger.info(`Found AI Agent node: ${agentNode.name}`);

  // Find the Slack response node (typically named "Slack" or "Send Message")
  const slackResponseNode = workflow.nodes.find(
    (n) =>
      n.type === "n8n-nodes-base.slack" &&
      (n.parameters as Record<string, unknown>).operation === "postMessage",
  );

  const slackNodeName = slackResponseNode?.name || "Slack";
  logger.info(`Found Slack response node: ${slackNodeName}`);

  // Check for Issue Classifier node
  const classifierNode = workflow.nodes.find(
    (n) => n.name === "Issue Classifier",
  );
  if (!classifierNode) {
    logger.warn(
      'Warning: "Issue Classifier" node not found. Subcategory-based routing may not work.',
    );
  }

  // 3. Create routing node
  const routingNode = createRoutingNode(workflow.nodes);

  console.log("\n" + "=".repeat(60));
  console.log("PLANNED CHANGES:");
  console.log("=".repeat(60));
  console.log(`\nNew node: ${routingNode.name}`);
  console.log(`  Type: ${routingNode.type}`);
  console.log(`  Position: [${routingNode.position.join(", ")}]`);
  console.log("\nRouting rules:");
  console.log("  • Payment/Billing → @Billing Support");
  console.log("  • Charger/Hardware → @team-asset-management");
  console.log("  • Ampeco/Integration → @Integration Support");
  console.log(
    `\nConnection: ${agentNode.name} → ${routingNode.name} → ${slackNodeName}`,
  );
  console.log("=".repeat(60));

  if (isDryRun) {
    console.log("\n[DRY RUN] Would add routing node.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // 4. Add node and update connections
  const updatedNodes = [...workflow.nodes, routingNode];
  const updatedConnections = insertRoutingNode(
    workflow.connections,
    agentNode.name,
    routingNode.name,
    slackNodeName,
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
  logger.info("Added routing suggestion node to support workflow!");
  console.log("\nHow it works:");
  console.log("  1. AI Agent responds with triage analysis");
  console.log("  2. Routing node checks if AI already included routing");
  console.log("  3. If not, adds routing based on subcategory/keywords");
  console.log("  4. Response sent to Slack with routing suggestion");
  console.log("\nNext steps:");
  console.log("  1. Update AI prompt: npm run improve:support-prompt");
  console.log(
    "  2. Test in #help-me-platform with payment/charger/Ampeco issues",
  );
  console.log("=".repeat(60));
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

addRoutingNode()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to add routing node", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
