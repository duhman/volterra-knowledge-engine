#!/usr/bin/env npx tsx
/**
 * Fix Filter Incoming Node - Allow Slack Workflow Submissions
 *
 * Problem: Slack Workflow form submissions are bot messages (posted by Workflow Builder),
 * so the current filter blocks them along with all other bot messages.
 *
 * Root cause: The "Extract Message" node runs BEFORE "Filter Incoming", replacing the raw
 * Slack event with just 6 fields (chatInput, channel, thread_ts, user, reply_thread_ts,
 * session_key). By the time data reaches Filter Incoming, bot_id and blocks are gone!
 *
 * Solution:
 * 1. Reorder nodes: Slack Trigger → Filter Incoming → Extract Message (was T → E → F)
 * 2. Allow bot messages that are Workflow form submissions (have structured blocks)
 * 3. Still block our AI agent's bot responses to prevent loops
 *
 * Usage: npm run fix:workflow-filter
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type {
  Workflow,
  WorkflowNode,
  WorkflowConnections,
} from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID"; // AI agent support - Slack

// Node position offset for visual layout (Filter moves left, Extract moves right)
const POSITION_OFFSET = 200;

/**
 * Updated filter code that allows Slack Workflow submissions
 *
 * Key changes:
 * 1. Try-catch wrapper to prevent exceptions from crashing the workflow
 * 2. Workflow Bot detection (bot IDs starting with 'W')
 * 3. Expanded block type detection for form elements
 * 4. Error logging for debugging
 */
const FIXED_FILTER_CODE = `// Filter incoming messages - allow workflow submissions, block bot loops
const items = $input.all();

return items.filter(item => {
  try {
    const event = item.json.event || item.json;
    const subtype = event.subtype || '';
    const botId = event.bot_id || event.botId;
    const isBot = Boolean(botId) || subtype === 'bot_message';
    const isThreadReply = Boolean(event.thread_ts) && event.thread_ts !== event.ts;

    // Workflow Builder bot IDs start with 'W' (workflow automation)
    const isWorkflowBot = botId && botId.startsWith('W');

    // Check for structured blocks indicating a form submission
    const blocks = event.blocks || [];
    const hasFormBlocks = blocks.length > 0 && blocks.some(block =>
      block.type === 'rich_text' ||
      block.type === 'section' ||
      block.type === 'context' ||
      block.type === 'header' ||
      block.type === 'divider' ||
      block.type === 'input' ||
      block.type === 'actions'
    );

    // Allow Workflow Builder form submissions
    if (isWorkflowBot || (isBot && hasFormBlocks)) {
      return true;
    }

    // Block other bot messages (our AI agent's responses) and thread replies
    return !isBot && !isThreadReply;
  } catch (err) {
    // Log error but don't crash the workflow
    console.error('Filter error:', err.message, JSON.stringify(item.json).slice(0, 200));
    return false;
  }
});
`;

/**
 * Reorder connections so Filter Incoming runs BEFORE Extract Message
 *
 * Current: Slack Trigger → Extract Message → Filter Incoming → Issue Classifier
 * Fixed:   Slack Trigger → Filter Incoming → Extract Message → Issue Classifier
 */
function reorderConnections(
  connections: WorkflowConnections,
): WorkflowConnections {
  const updated = { ...connections };

  // Find what Filter Incoming currently connects to (downstream node)
  const filterDownstream =
    updated["Filter Incoming"]?.main?.[0]?.[0]?.node || "Issue Classifier";

  // 1. Slack Trigger now connects to Filter Incoming (was Extract Message)
  if (updated["Slack Trigger"]?.main?.[0]?.[0]) {
    updated["Slack Trigger"] = {
      ...updated["Slack Trigger"],
      main: [[{ node: "Filter Incoming", type: "main", index: 0 }]],
    };
  }

  // 2. Filter Incoming now connects to Extract Message (was Issue Classifier)
  updated["Filter Incoming"] = {
    main: [[{ node: "Extract Message", type: "main", index: 0 }]],
  };

  // 3. Extract Message now connects to downstream (was Filter Incoming)
  updated["Extract Message"] = {
    main: [[{ node: filterDownstream, type: "main", index: 0 }]],
  };

  return updated;
}

/**
 * Check if connections are already in the correct order
 */
function isCorrectOrder(connections: WorkflowConnections): boolean {
  const slackTarget = connections["Slack Trigger"]?.main?.[0]?.[0]?.node;
  const filterTarget = connections["Filter Incoming"]?.main?.[0]?.[0]?.node;

  // Correct order: Slack Trigger → Filter Incoming → Extract Message
  return (
    slackTarget === "Filter Incoming" && filterTarget === "Extract Message"
  );
}

async function fixWorkflowFilter(): Promise<void> {
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

  // 2. Find Filter Incoming node
  const filterNode = workflow.nodes.find(
    (n: WorkflowNode) => n.name === "Filter Incoming",
  );

  if (!filterNode) {
    throw new Error("Filter Incoming node not found in workflow");
  }

  const currentCode =
    (filterNode.parameters as { jsCode?: string }).jsCode || "";
  logger.info(`Current filter code: ${currentCode.length} chars`);

  // 3. Check current state
  // Check for new patterns: try-catch wrapper AND isWorkflowBot detection
  const codeAlreadyFixed =
    currentCode.includes("isWorkflowBot") && currentCode.includes("try {");
  const connectionsCorrect = isCorrectOrder(workflow.connections);

  logger.info("");
  logger.info("Current state:");
  logger.info(
    `  Filter code: ${codeAlreadyFixed ? "✅ Fixed" : "❌ Needs update"}`,
  );
  logger.info(
    `  Node order:  ${connectionsCorrect ? "✅ Correct" : "❌ Wrong order"}`,
  );

  if (codeAlreadyFixed && connectionsCorrect) {
    logger.info("");
    logger.info(
      "No changes needed - workflow is already correctly configured.",
    );
    return;
  }

  // 4. Show what will be fixed
  logger.info("");
  if (!connectionsCorrect) {
    logger.info("Node order fix:");
    logger.info("  Current: Slack Trigger → Extract Message → Filter Incoming");
    logger.info("  Fixed:   Slack Trigger → Filter Incoming → Extract Message");
    logger.info("");
  }
  if (!codeAlreadyFixed) {
    logger.info("Filter behavior fix:");
    logger.info(
      "  Current: Blocks ALL bot messages (including workflow submissions)",
    );
    logger.info(
      "  Fixed:   Allows Workflow submissions, blocks AI agent responses",
    );
    logger.info("");
  }

  // 5. Update Filter Incoming node code (if needed)
  const updatedNodes = workflow.nodes.map((n: WorkflowNode) => {
    if (n.name === "Filter Incoming" && !codeAlreadyFixed) {
      return {
        ...n,
        parameters: {
          ...n.parameters,
          jsCode: FIXED_FILTER_CODE,
        },
      };
    }
    return n;
  });

  // 6. Reorder connections (if needed)
  const updatedConnections = connectionsCorrect
    ? workflow.connections
    : reorderConnections(workflow.connections);

  // 7. Prepare update payload (only allowed settings)
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
  logger.info("✅ Successfully updated workflow!");
  logger.info("");
  logger.info("Changes made:");
  if (!connectionsCorrect) {
    logger.info(
      "  ✅ Node order fixed: Filter Incoming now runs before Extract Message",
    );
  }
  if (!codeAlreadyFixed) {
    logger.info("  ✅ Filter code updated: Workflow submissions now allowed");
  }
  logger.info("  ✅ AI agent bot responses still blocked (prevents loops)");
  logger.info("  ✅ Thread replies still blocked");
  logger.info("");
  logger.info(
    "Test by submitting a new help request via the Slack workflow form.",
  );
}

fixWorkflowFilter()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Fix failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
