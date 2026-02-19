#!/usr/bin/env npx tsx
/**
 * Fix Extract Message Syntax Error
 *
 * Problem: The fix-extract-message-blocks.ts script put a complex multi-line JavaScript
 * expression directly in the Set node's expression field. n8n's Set node expression
 * evaluator only supports simple single-line expressions, not:
 * - const declarations
 * - if statements
 * - return statements
 * - Function definitions
 *
 * Solution:
 * 1. Add a Code node "Parse Form Data" between Filter Incoming and Extract Message
 * 2. The Code node handles block text extraction
 * 3. Simplify Extract Message to use simple expressions referencing parsedText
 *
 * Usage: npm run fix:extract-message-syntax
 *        npm run fix:extract-message-syntax -- --dry-run
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type {
  Workflow,
  WorkflowNode,
  WorkflowConnections,
} from "../types/n8n.js";

config();

const WORKFLOW_ID = "UtsHZSFSpXa6arFN"; // AI agent support - Slack

/**
 * Code node JavaScript to parse Slack form data from blocks
 *
 * This extracts text from rich_text blocks (used by Slack Workflow form submissions)
 * and falls back to regular event.text for normal messages.
 */
const PARSE_FORM_DATA_CODE = `// Parse Form Data - Extract text from Slack messages and Workflow form blocks
// Note: Uses $json (not $input.first()) because mode is runOnceForEachItem
const json = $json;

// Get the event object (handle both nested and flat structures)
const event = json.event || json;

// Get text - either from top level or from blocks
let parsedText = event.text || "";

// If text exists but has @mention at start, strip it
if (parsedText) {
  parsedText = parsedText.replace(/<@[A-Z0-9]+>\\s*/g, "").trim();
}

// If no text, try to extract from blocks (Workflow form submissions)
if (!parsedText && event.blocks) {
  const extractBlockText = (block) => {
    if (!block) return "";

    // Rich text block (most common for form submissions)
    if (block.type === "rich_text" && block.elements) {
      return block.elements.map(el => {
        if (el.type === "rich_text_section" && el.elements) {
          return el.elements.map(e => {
            if (e.type === "text") return e.text || "";
            if (e.type === "link") return e.url || "";
            if (e.type === "user") return ""; // Skip user mentions
            return "";
          }).join("");
        }
        if (el.type === "rich_text_list" && el.elements) {
          return el.elements.map(item => {
            if (item.elements) {
              return "• " + item.elements.map(e => e.text || "").join("");
            }
            return "";
          }).join("\\n");
        }
        return "";
      }).join("\\n");
    }

    // Section block with text
    if (block.type === "section" && block.text?.text) {
      return block.text.text;
    }

    // Context block
    if (block.type === "context" && block.elements) {
      return block.elements.map(e => e.text || "").join(" ");
    }

    return "";
  };

  parsedText = event.blocks.map(extractBlockText).filter(t => t.trim()).join("\\n\\n");

  // Also strip @mentions from block-extracted text
  parsedText = parsedText.replace(/<@[A-Z0-9]+>\\s*/g, "").trim();
}

// Return the original json with parsedText added
return {
  json: {
    ...json,
    parsedText: parsedText || "No message content found"
  }
};
`;

/**
 * Create the Parse Form Data Code node
 */
function createParseFormDataNode(
  extractMessagePosition: [number, number],
): WorkflowNode {
  // Position it between Filter Incoming and Extract Message
  // Filter Incoming is at ~520, Extract Message at ~640
  // Place this at 580 (middle ground)
  const position: [number, number] = [
    extractMessagePosition[0] - 60, // Slightly before Extract Message
    extractMessagePosition[1],
  ];

  return {
    name: "Parse Form Data",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: {
      jsCode: PARSE_FORM_DATA_CODE,
      mode: "runOnceForEachItem",
    },
  };
}

/**
 * Update Extract Message to use simple expressions
 * Relies on parsedText from Parse Form Data node
 */
function getSimplifiedExtractMessageAssignments() {
  return [
    {
      id: "chatInput",
      name: "chatInput",
      // Simple expression - just reference parsedText or text
      value:
        "={{ $json.parsedText || $json.event?.text || $json.text || 'No message content' }}",
      type: "string",
    },
    {
      id: "channel",
      name: "channel",
      value: "={{ $json.event?.channel || $json.channel || '' }}",
      type: "string",
    },
    {
      id: "thread_ts",
      name: "thread_ts",
      value:
        "={{ $json.event?.thread_ts || $json.event?.ts || $json.ts || '' }}",
      type: "string",
    },
    {
      id: "user",
      name: "user",
      value: "={{ $json.event?.user || $json.user || '' }}",
      type: "string",
    },
    {
      id: "reply_thread_ts",
      name: "reply_thread_ts",
      type: "string",
      value: "={{ $json.event?.thread_ts || $json.event?.ts || $json.ts }}",
    },
    {
      id: "session_key",
      name: "session_key",
      type: "string",
      value:
        "={{ ($json.event?.channel || $json.channel) + '::' + ($json.event?.thread_ts || $json.event?.ts || $json.ts) }}",
    },
  ];
}

/**
 * Update connections to insert Parse Form Data between Filter Incoming and Extract Message
 */
function updateConnections(
  connections: WorkflowConnections,
): WorkflowConnections {
  const updated = { ...connections };

  // Filter Incoming → Parse Form Data (was → Extract Message)
  updated["Filter Incoming"] = {
    main: [[{ node: "Parse Form Data", type: "main", index: 0 }]],
  };

  // Parse Form Data → Extract Message
  updated["Parse Form Data"] = {
    main: [[{ node: "Extract Message", type: "main", index: 0 }]],
  };

  // Extract Message → Issue Classifier (should already exist, keep it)
  // This connection should already be correct from fix-workflow-filter.ts

  return updated;
}

/**
 * Check if Parse Form Data node already exists
 */
function hasParseFormDataNode(nodes: WorkflowNode[]): boolean {
  return nodes.some((n) => n.name === "Parse Form Data");
}

/**
 * Check if Extract Message has the problematic expression
 */
function hasProblematicExpression(nodes: WorkflowNode[]): boolean {
  const extractNode = nodes.find((n) => n.name === "Extract Message");
  if (!extractNode) return false;

  const assignments = (
    extractNode.parameters as {
      assignments?: { assignments?: Array<{ value?: string }> };
    }
  )?.assignments?.assignments;

  const chatInput = assignments?.find(
    (a: { name?: string }) => a.name === "chatInput",
  );

  // Check for multi-line JavaScript in expression
  return Boolean(
    chatInput?.value?.includes("const ") ||
    chatInput?.value?.includes("if (") ||
    chatInput?.value?.includes("return "),
  );
}

async function fixExtractMessageSyntax(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  // 1. Fetch current workflow
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

  // 2. Check current state
  const alreadyHasParseNode = hasParseFormDataNode(workflow.nodes);
  const hasProblematic = hasProblematicExpression(workflow.nodes);

  logger.info("");
  logger.info("Current state:");
  logger.info(
    `  Parse Form Data node: ${alreadyHasParseNode ? "✅ Exists" : "❌ Missing"}`,
  );
  logger.info(
    `  Extract Message:      ${hasProblematic ? "❌ Has problematic expression" : "✅ OK"}`,
  );

  if (alreadyHasParseNode && !hasProblematic) {
    logger.info("");
    logger.info("No changes needed - workflow is already fixed.");
    return;
  }

  // 3. Find Extract Message node for positioning
  const extractMessageNode = workflow.nodes.find(
    (n: WorkflowNode) => n.name === "Extract Message",
  );

  if (!extractMessageNode) {
    throw new Error("Extract Message node not found in workflow");
  }

  // 4. Log what we're going to do
  logger.info("");
  logger.info("Changes to apply:");
  if (!alreadyHasParseNode) {
    logger.info("  1. Add 'Parse Form Data' Code node");
    logger.info(
      "     - Extracts text from blocks for Workflow form submissions",
    );
    logger.info("     - Falls back to event.text for regular messages");
  }
  if (hasProblematic) {
    logger.info("  2. Simplify 'Extract Message' expressions");
    logger.info("     - Remove complex JavaScript (const, if, return)");
    logger.info("     - Use simple expression: $json.parsedText");
  }
  logger.info("  3. Update connections:");
  logger.info("     - Filter Incoming → Parse Form Data → Extract Message");

  if (dryRun) {
    logger.info("");
    logger.info("[DRY RUN] No changes applied.");
    logger.info("");
    logger.info("Parse Form Data code would be:");
    logger.info("----------------------------------------");
    console.log(PARSE_FORM_DATA_CODE.slice(0, 500) + "...");
    logger.info("----------------------------------------");
    return;
  }

  // 5. Apply changes
  const updatedNodes = [...workflow.nodes];

  // Add Parse Form Data node if it doesn't exist
  if (!alreadyHasParseNode) {
    const parseFormDataNode = createParseFormDataNode(
      extractMessageNode.position as [number, number],
    );
    updatedNodes.push(parseFormDataNode);
    logger.info("Added Parse Form Data node");
  }

  // Update Extract Message assignments if problematic
  if (hasProblematic) {
    const extractIdx = updatedNodes.findIndex(
      (n) => n.name === "Extract Message",
    );
    if (extractIdx >= 0) {
      updatedNodes[extractIdx] = {
        ...updatedNodes[extractIdx],
        parameters: {
          ...updatedNodes[extractIdx].parameters,
          assignments: {
            assignments: getSimplifiedExtractMessageAssignments(),
          },
          options: {},
        },
      };
      logger.info("Updated Extract Message with simple expressions");
    }
  }

  // Update connections
  const updatedConnections = updateConnections(workflow.connections);
  logger.info("Updated connections");

  // 6. Filter settings to allowed keys
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

  // 7. Update the workflow
  logger.info("");
  logger.info("Updating workflow...");

  const updateResponse = await fetch(`${apiUrl}/workflows/${WORKFLOW_ID}`, {
    method: "PUT",
    headers: {
      "X-N8N-API-KEY": apiKey,
      "Content-Type": "application/json",
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

  logger.info("");
  logger.info("✅ Workflow fixed successfully!");
  logger.info("");
  logger.info("New flow:");
  logger.info(
    "  Slack Trigger → Filter Incoming → Parse Form Data → Extract Message → Issue Classifier → ...",
  );
  logger.info("");
  logger.info("Test by submitting a form in #help-me-platform");
}

fixExtractMessageSyntax().catch((err) => {
  logger.error("Failed to fix workflow:", err);
  process.exit(1);
});
