#!/usr/bin/env npx tsx
/**
 * Fix Parse Form Data Code Node Error
 *
 * Problem: The Parse Form Data Code node uses `$input.first()` but is configured
 * with `mode: runOnceForEachItem`. In n8n:
 * - "Run Once for Each Item" mode: Use `$json` to access current item data
 * - "Run Once for All Items" mode: Use `$input.first()`, `$input.all()`, etc.
 *
 * Error: "Can't use .first() here - This is only available in 'Run Once for All Items' mode"
 *
 * Solution: Replace `$input.first().json` with `$json` (correct accessor for per-item mode)
 *
 * Usage: npm run fix:parse-form-data-mode
 *        npm run fix:parse-form-data-mode -- --dry-run
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type { Workflow, WorkflowNode } from "../types/n8n.js";

config();

const WORKFLOW_ID = "UtsHZSFSpXa6arFN"; // AI agent support - Slack

/**
 * Fixed Code node JavaScript - uses $json instead of $input.first()
 */
const FIXED_PARSE_FORM_DATA_CODE = `// Parse Form Data - Extract text from Slack messages and Workflow form blocks
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
 * Check if Parse Form Data node has the bug
 */
function hasInputFirstBug(nodes: WorkflowNode[]): boolean {
  const parseNode = nodes.find((n) => n.name === "Parse Form Data");
  if (!parseNode) return false;

  const jsCode = (parseNode.parameters as { jsCode?: string })?.jsCode || "";
  const mode = (parseNode.parameters as { mode?: string })?.mode;

  // Bug: uses $input.first() in runOnceForEachItem mode
  return mode === "runOnceForEachItem" && jsCode.includes("$input.first()");
}

async function fixParseFormDataMode(): Promise<void> {
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
  const hasBug = hasInputFirstBug(workflow.nodes);

  logger.info("");
  logger.info("Current state:");
  logger.info(
    `  Parse Form Data node: ${hasBug ? "❌ Has $input.first() bug" : "✅ OK"}`,
  );

  if (!hasBug) {
    logger.info("");
    logger.info("No changes needed - Parse Form Data node is already fixed.");
    return;
  }

  // 3. Log what we're going to do
  logger.info("");
  logger.info("Changes to apply:");
  logger.info("  1. Update 'Parse Form Data' Code node");
  logger.info("     - Remove: const item = $input.first();");
  logger.info("     - Remove: const json = item.json;");
  logger.info("     - Add:    const json = $json;");

  if (dryRun) {
    logger.info("");
    logger.info("[DRY RUN] No changes applied.");
    logger.info("");
    logger.info("Fixed code would be:");
    logger.info("----------------------------------------");
    console.log(FIXED_PARSE_FORM_DATA_CODE.slice(0, 300) + "...");
    logger.info("----------------------------------------");
    return;
  }

  // 4. Apply changes
  const updatedNodes = workflow.nodes.map((node) => {
    if (node.name === "Parse Form Data") {
      return {
        ...node,
        parameters: {
          ...(node.parameters as Record<string, unknown>),
          jsCode: FIXED_PARSE_FORM_DATA_CODE,
        },
      };
    }
    return node;
  });

  // 5. Filter settings to allowed keys
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

  // 6. Update the workflow
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

  logger.info("");
  logger.info("✅ Parse Form Data node fixed!");
  logger.info("");
  logger.info("Change summary:");
  logger.info("  - Replaced $input.first() with $json");
  logger.info("  - Node mode remains: runOnceForEachItem");
  logger.info("");
  logger.info(
    "Test by sending a message or form submission in #help-me-platform",
  );
}

fixParseFormDataMode().catch((err) => {
  logger.error("Failed to fix workflow:", err);
  process.exit(1);
});
