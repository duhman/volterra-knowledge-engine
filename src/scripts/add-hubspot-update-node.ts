#!/usr/bin/env npx tsx
/**
 * Add HubSpot Ticket Update to Categorizer Workflow
 *
 * Modifies the n8n workflow `YOUR_WORKFLOW_ID` to update HubSpot ticket
 * properties (hs_ticket_category and subcategory) after classification,
 * in parallel with the existing "Store Trial Result" node.
 *
 * Usage:
 *   npm run hubspot:add-categorizer-update         # Apply changes
 *   npm run hubspot:add-categorizer-update -- --dry-run  # Preview changes
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type {
  WorkflowNode,
  WorkflowConnections,
  Workflow,
} from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID";
const MIN_CONFIDENCE = 0.7;

// Node names
const CONFIDENCE_CHECK_NODE = "Confidence Check";
const MAP_CATEGORY_NODE = "Map Category";
const HUBSPOT_UPDATE_NODE = "Update HubSpot Ticket";
const ERROR_HANDLER_NODE = "HubSpot Update Error Handler";

// HubSpot credentials from the workflow
const HUBSPOT_CREDENTIALS = {
  hubspotAppToken: {
    id: "YOUR_WORKFLOW_ID",
    name: "HubSpot App Token account",
  },
};

/**
 * Create the confidence check IF node
 */
function createConfidenceCheckNode(position: [number, number]): WorkflowNode {
  return {
    name: CONFIDENCE_CHECK_NODE,
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position,
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "strict",
        },
        conditions: [
          {
            id: "confidence-check",
            leftValue: `={{ $json.response?.confidence ?? 0 }}`,
            rightValue: MIN_CONFIDENCE,
            operator: {
              type: "number",
              operation: "gte",
            },
          },
          {
            id: "ticket-id-check",
            leftValue: `={{ $json.ticket_id }}`,
            rightValue: "",
            operator: {
              type: "string",
              operation: "notEmpty",
            },
          },
          {
            id: "category-check",
            leftValue: `={{ $json.response?.category }}`,
            rightValue: "",
            operator: {
              type: "string",
              operation: "notEmpty",
            },
          },
          {
            id: "subcategory-check",
            leftValue: `={{ $json.response?.subcategory }}`,
            rightValue: "",
            operator: {
              type: "string",
              operation: "notEmpty",
            },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
  };
}

/**
 * Create the Map Category code node
 *
 * Maps AI classifier categories (8 values) to HubSpot valid categories (3 values).
 * Uses both category AND subcategory for intelligent mapping, since ~95% of historical
 * tickets have category "General" and subcategory is the primary signal.
 */
function createMapCategoryNode(position: [number, number]): WorkflowNode {
  return {
    name: MAP_CATEGORY_NODE,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: {
      jsCode: `// Data-driven mapping using both category AND subcategory
// Based on analysis of 200+ training_conversations records
// ~95% of historical tickets have category "General", so subcategory is primary signal

// Primary AI category → HubSpot category mapping
const CATEGORY_MAP = {
  'Administrative': 'Administrative',
  'Payment': 'Payment',
  'Technical Support': 'Technical',
  'RFID Support': 'Technical',
  'Order Support': 'Administrative',
  'Documentation': 'Administrative',
  'General': 'Technical',  // Most common - use subcategory override
  'Unknown': 'Technical',
};

// Subcategory overrides (takes precedence when subcategory is set)
// Based on historical data frequency and business logic
const SUBCATEGORY_OVERRIDE = {
  // Payment-related
  'Subscription and pricing': 'Payment',
  'Invoice': 'Payment',

  // Administrative/Business process
  'Onboarding': 'Administrative',
  'Ordering': 'Administrative',
  'Service': 'Administrative',
  'Termination': 'Administrative',
  'Other': 'Administrative',

  // Technical issues
  'App': 'Technical',
  'Hardware failure': 'Technical',
  'IT / Cloud error': 'Technical',
  'Unstable charging': 'Technical',
  'Charger offline': 'Technical',
  'User error': 'Technical',
  'RFID': 'Technical',
  'Charging': 'Technical',
};

const input = $input.first().json;
const aiCategory = input.response?.category || 'Unknown';
const subcategory = input.response?.subcategory || '';

// Determine HubSpot category: subcategory override takes precedence
let hubspotCategory;
if (subcategory && SUBCATEGORY_OVERRIDE[subcategory]) {
  hubspotCategory = SUBCATEGORY_OVERRIDE[subcategory];
} else {
  hubspotCategory = CATEGORY_MAP[aiCategory] || 'Technical';
}

return [{
  json: {
    ...input,
    response: {
      ...input.response,
      hubspot_category: hubspotCategory,
      original_category: aiCategory,
    }
  }
}];`,
    },
  };
}

/**
 * Create the HubSpot HTTP Request node for PATCH
 *
 * Uses hubspot_category (mapped value) instead of category (AI value)
 */
function createHubSpotUpdateNode(position: [number, number]): WorkflowNode {
  return {
    name: HUBSPOT_UPDATE_NODE,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    parameters: {
      method: "PATCH",
      url: `=https://api.hubapi.com/crm/v3/objects/tickets/{{ $json.ticket_id }}`,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "hubspotAppToken",
      sendBody: true,
      specifyBody: "json",
      jsonBody: `={
  "properties": {
    "hs_ticket_category": "{{ $json.response.hubspot_category }}",
    "subcategory": "{{ $json.response.subcategory }}"
  }
}`,
      options: {
        response: {
          response: {
            fullResponse: false,
          },
        },
      },
    },
    credentials: HUBSPOT_CREDENTIALS,
    continueOnFail: true,
  };
}

/**
 * Create the error handler code node
 */
function createErrorHandlerNode(position: [number, number]): WorkflowNode {
  return {
    name: ERROR_HANDLER_NODE,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: {
      jsCode: `// Handle HubSpot update result
const input = $input.all();
const item = input[0]?.json || {};

// Check if there was an error (continueOnFail passes error in item)
const statusCode = item.statusCode || item.code || 200;
const hasError = statusCode >= 400 || item.error || item.message?.includes('error');

let hubspot_updated = false;
let hubspot_error = null;

if (hasError) {
  const errorMessage = item.message || item.error || JSON.stringify(item).slice(0, 200);
  hubspot_error = \`hubspot_\${statusCode}:\${errorMessage}\`;
  console.log('HubSpot update failed:', hubspot_error);
} else {
  hubspot_updated = true;
  console.log('HubSpot ticket updated successfully:', item.id || 'unknown');
}

// Return original context with update status
// Note: We need to get the original data since HTTP Request replaced it
return [{
  json: {
    hubspot_updated,
    hubspot_error,
    hubspot_response: hasError ? null : item,
  }
}];`,
    },
  };
}

/**
 * Update workflow connections to add parallel path from Format Response
 *
 * Flow: Format Response -> [Store Trial Result (parallel), Confidence Check]
 *       Confidence Check (true) -> Map Category -> Update HubSpot Ticket -> Error Handler
 */
function updateConnections(
  connections: WorkflowConnections,
  formatResponsePosition: [number, number],
): WorkflowConnections {
  const updated = JSON.parse(
    JSON.stringify(connections),
  ) as WorkflowConnections;

  // Format Response should now connect to both:
  // 1. Store Trial Result (existing)
  // 2. Confidence Check (new) -> Map Category -> Update HubSpot Ticket -> Error Handler
  const existingConnections = updated["Format Response"]?.main?.[0] || [];

  updated["Format Response"] = {
    main: [
      [
        ...existingConnections,
        { node: CONFIDENCE_CHECK_NODE, type: "main", index: 0 },
      ],
    ],
  };

  // Confidence Check connects to Map Category (true branch only)
  updated[CONFIDENCE_CHECK_NODE] = {
    main: [
      [{ node: MAP_CATEGORY_NODE, type: "main", index: 0 }], // true branch
      [], // false branch - do nothing
    ],
  };

  // Map Category connects to Update HubSpot
  updated[MAP_CATEGORY_NODE] = {
    main: [[{ node: HUBSPOT_UPDATE_NODE, type: "main", index: 0 }]],
  };

  // Update HubSpot connects to Error Handler
  updated[HUBSPOT_UPDATE_NODE] = {
    main: [[{ node: ERROR_HANDLER_NODE, type: "main", index: 0 }]],
  };

  return updated;
}

/**
 * Get allowed settings for workflow update
 */
function allowedSettings(workflow: Workflow): Workflow["settings"] {
  const allowedKeys = [
    "executionOrder",
    "errorWorkflow",
    "callerPolicy",
    "saveDataErrorExecution",
    "saveDataSuccessExecution",
    "saveManualExecutions",
    "saveExecutionProgress",
    "timezone",
  ] as const;

  const settings: Record<string, unknown> = {};
  if (workflow.settings) {
    for (const key of allowedKeys) {
      if (key in workflow.settings) {
        settings[key] = (workflow.settings as Record<string, unknown>)[key];
      }
    }
  }
  return settings;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const client = new N8nApiClient();

  logger.info(`Fetching workflow ${WORKFLOW_ID}...`);
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  logger.info(`Got workflow: ${workflow.name}`);
  logger.info(`Current nodes: ${workflow.nodes.length}`);

  // Find the Format Response node to determine positions
  const formatResponseNode = workflow.nodes.find(
    (n) => n.name === "Format Response",
  );
  if (!formatResponseNode) {
    throw new Error("Format Response node not found");
  }

  const storeTrialNode = workflow.nodes.find(
    (n) => n.name === "Store Trial Result",
  );
  if (!storeTrialNode) {
    throw new Error("Store Trial Result node not found");
  }

  logger.info(`Format Response position: [${formatResponseNode.position}]`);
  logger.info(`Store Trial Result position: [${storeTrialNode.position}]`);

  // Calculate positions for new nodes (below the Store Trial Result path)
  const baseX = formatResponseNode.position[0] + 224;
  const baseY = formatResponseNode.position[1] + 200; // Below the main flow
  const nodeSpacing = 224; // Standard n8n node spacing

  const confidenceCheckPos: [number, number] = [baseX, baseY];
  const mapCategoryPos: [number, number] = [baseX + nodeSpacing, baseY];
  const hubspotUpdatePos: [number, number] = [baseX + nodeSpacing * 2, baseY];
  const errorHandlerPos: [number, number] = [baseX + nodeSpacing * 3, baseY];

  // Check if nodes already exist
  const confidenceCheckExists = workflow.nodes.some(
    (n) => n.name === CONFIDENCE_CHECK_NODE,
  );
  const mapCategoryExists = workflow.nodes.some(
    (n) => n.name === MAP_CATEGORY_NODE,
  );
  const hubspotUpdateExists = workflow.nodes.some(
    (n) => n.name === HUBSPOT_UPDATE_NODE,
  );
  const errorHandlerExists = workflow.nodes.some(
    (n) => n.name === ERROR_HANDLER_NODE,
  );

  console.log("\n" + "=".repeat(60));
  console.log("WORKFLOW MODIFICATION PLAN");
  console.log("=".repeat(60));
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`ID: ${WORKFLOW_ID}`);
  console.log(`\nNew nodes to add/update:`);
  console.log(
    `  1. ${CONFIDENCE_CHECK_NODE} at [${confidenceCheckPos}] ${confidenceCheckExists ? "(update)" : "(new)"}`,
  );
  console.log(
    `  2. ${MAP_CATEGORY_NODE} at [${mapCategoryPos}] ${mapCategoryExists ? "(update)" : "(new)"}`,
  );
  console.log(
    `  3. ${HUBSPOT_UPDATE_NODE} at [${hubspotUpdatePos}] ${hubspotUpdateExists ? "(update)" : "(new)"}`,
  );
  console.log(
    `  4. ${ERROR_HANDLER_NODE} at [${errorHandlerPos}] ${errorHandlerExists ? "(update)" : "(new)"}`,
  );
  console.log(`\nConnection changes:`);
  console.log(
    `  Format Response -> [Store Trial Result, ${CONFIDENCE_CHECK_NODE}]`,
  );
  console.log(`  ${CONFIDENCE_CHECK_NODE} (true) -> ${MAP_CATEGORY_NODE}`);
  console.log(`  ${MAP_CATEGORY_NODE} -> ${HUBSPOT_UPDATE_NODE}`);
  console.log(`  ${HUBSPOT_UPDATE_NODE} -> ${ERROR_HANDLER_NODE}`);
  console.log(`\nCategory mapping:`);
  console.log(`  AI "Order Support" -> HubSpot "Administrative"`);
  console.log(`  AI "Technical Support" -> HubSpot "Technical"`);
  console.log(`  AI "RFID Support" -> HubSpot "Technical"`);
  console.log(
    `  Subcategory overrides take precedence (e.g., "Invoice" -> "Payment")`,
  );
  console.log(`\nConfidence threshold: >= ${MIN_CONFIDENCE}`);
  console.log("=".repeat(60));

  if (dryRun) {
    console.log("\n[DRY RUN] Would apply the changes above.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // Build updated nodes list
  const updatedNodes = workflow.nodes.map((node) => {
    // Update existing nodes if they exist
    if (node.name === CONFIDENCE_CHECK_NODE) {
      return {
        ...node,
        ...createConfidenceCheckNode(confidenceCheckPos),
        id: node.id,
      };
    }
    if (node.name === MAP_CATEGORY_NODE) {
      return {
        ...node,
        ...createMapCategoryNode(mapCategoryPos),
        id: node.id,
      };
    }
    if (node.name === HUBSPOT_UPDATE_NODE) {
      return {
        ...node,
        ...createHubSpotUpdateNode(hubspotUpdatePos),
        id: node.id,
      };
    }
    if (node.name === ERROR_HANDLER_NODE) {
      return {
        ...node,
        ...createErrorHandlerNode(errorHandlerPos),
        id: node.id,
      };
    }
    return node;
  });

  // Add new nodes if they don't exist
  if (!confidenceCheckExists) {
    updatedNodes.push(createConfidenceCheckNode(confidenceCheckPos));
  }
  if (!mapCategoryExists) {
    updatedNodes.push(createMapCategoryNode(mapCategoryPos));
  }
  if (!hubspotUpdateExists) {
    updatedNodes.push(createHubSpotUpdateNode(hubspotUpdatePos));
  }
  if (!errorHandlerExists) {
    updatedNodes.push(createErrorHandlerNode(errorHandlerPos));
  }

  // Update connections
  const updatedConnections = updateConnections(
    workflow.connections,
    formatResponseNode.position,
  );

  logger.info("Updating workflow...");
  await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: updatedNodes,
    connections: updatedConnections,
    settings: allowedSettings(workflow),
  });

  console.log("\n" + "=".repeat(60));
  console.log("CHANGES APPLIED SUCCESSFULLY");
  console.log("=".repeat(60));
  console.log("  ✅ Added/updated Confidence Check IF node");
  console.log(
    "  ✅ Added/updated Map Category code node (AI → HubSpot category)",
  );
  console.log("  ✅ Added/updated Update HubSpot Ticket HTTP Request node");
  console.log("  ✅ Added/updated HubSpot Update Error Handler code node");
  console.log("  ✅ Updated connections for parallel execution");
  console.log(`\nTotal nodes: ${updatedNodes.length}`);
  console.log("\n" + "=".repeat(60));
  console.log("VERIFICATION:");
  console.log("=".repeat(60));
  console.log("1. Open n8n workflow editor and verify node positions");
  console.log("2. Test with a ticket that would produce 'Order Support':");
  console.log("   - Trigger workflow manually");
  console.log("   - Verify Map Category transforms to 'Administrative'");
  console.log(
    "   - Check HubSpot ticket gets 'Administrative' (not 'Order Support')",
  );
  console.log("   - Check original_category preserved in response");
  console.log("3. Monitor execution logs for errors");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Script failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
