#!/usr/bin/env npx tsx
/**
 * Fix Support Workflow Supabase Node
 *
 * Replaces the native Supabase node "Store AI Response" with a Code node
 * using this.helpers.httpRequest (PostgREST API). The native node throws
 * "Could not get parameter: operation" due to a version incompatibility bug.
 *
 * This approach matches the proven pattern used by "Store Trial Result" in
 * the HubSpot categorizer workflow.
 *
 * Usage:
 *   npm run fix:support-supabase                # Apply changes
 *   npm run fix:support-supabase -- --dry-run   # Preview changes
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type { WorkflowNode, Workflow } from "../types/n8n.js";

config();

const WORKFLOW_ID = "UtsHZSFSpXa6arFN"; // AI agent support - Slack

// Supabase anon key (read from env, but can use public anon key for inserts with RLS)
// This is the same key used in the HubSpot categorizer workflow
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5eG9pa2R3b2lpdHdpZ3lwbXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjExNjU0MTQsImV4cCI6MjA3Njc0MTQxNH0.lOmgUK9uNKEHOhfC2kxIXDiZ4MSUcMR9IPL_cPZqFgU";

/**
 * Create Code node to replace native Supabase insert
 *
 * Uses this.helpers.httpRequest which is more reliable than native nodes.
 * This pattern is proven in the "Store Trial Result" node.
 */
function createCodeNode(originalNode: WorkflowNode): WorkflowNode {
  // The JavaScript code that does the actual insert
  const jsCode = `// Store AI response to Supabase via PostgREST API
// Uses the same pattern as "Store Trial Result" in HubSpot categorizer

const extractMessage = $('Extract Message').item.json;
const aiAgent = $('AI Agent').item.json;

const payload = {
  thread_ts: extractMessage.thread_ts || extractMessage.ts,
  channel_id: extractMessage.channel,
  ai_response_ts: Date.now().toString(),
  ai_response_text: aiAgent.output || ''
};

let stored = false;
let error = null;

try {
  await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://your-project.supabase.co/rest/v1/ai_response_feedback',
    headers: {
      'Authorization': 'Bearer ${SUPABASE_ANON_KEY}',
      'apikey': '${SUPABASE_ANON_KEY}',
      'Content-Type': 'application/json',
      'Accept-Profile': 'volterra_kb',
      'Content-Profile': 'volterra_kb',
      'Prefer': 'return=representation,resolution=ignore-duplicates'
    },
    body: payload,
    json: true
  });
  stored = true;
} catch (err) {
  const status = err?.response?.status ?? err?.status ?? 'unknown';
  const data = err?.response?.data ?? err?.message ?? err;
  const safe = (() => {
    try { return JSON.stringify(data).slice(0, 300); }
    catch (e) { return String(data).slice(0, 300); }
  })();
  error = \`supabase_\${status}:\${safe}\`;
  console.log('Failed to store AI response:', error);
}

return [{ json: { ...$json, ai_feedback_stored: stored, ai_feedback_error: error } }];`;

  return {
    id: originalNode.id, // Keep the same ID to preserve connections
    name: originalNode.name, // Keep "Store AI Response"
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: originalNode.position,
    parameters: {
      jsCode,
    },
    continueOnFail: true, // Preserve error handling behavior
  };
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

  // Find the Store AI Response node
  const storeNode = workflow.nodes.find((n) => n.name === "Store AI Response");
  if (!storeNode) {
    throw new Error("Store AI Response node not found in workflow");
  }

  // Verify it's the native Supabase node we want to replace
  if (storeNode.type !== "n8n-nodes-base.supabase") {
    if (storeNode.type === "n8n-nodes-base.code") {
      logger.info("Node is already a Code node - checking if update needed");
      const jsCode =
        (storeNode.parameters as { jsCode?: string })?.jsCode || "";
      if (jsCode.includes("ai_response_feedback")) {
        logger.info(
          "Code node already uses PostgREST pattern - no changes needed",
        );
        return;
      }
    }
    throw new Error(
      `Unexpected node type: ${storeNode.type}. Expected n8n-nodes-base.supabase`,
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("FIX PLAN: Replace Native Supabase Node with Code Node");
  console.log("=".repeat(60));
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`ID: ${WORKFLOW_ID}`);
  console.log(`\nProblem:`);
  console.log(
    `  Native Supabase node throws "Could not get parameter: operation"`,
  );
  console.log(`  This is a known n8n bug with certain node versions.`);
  console.log(`\nSolution:`);
  console.log(`  Replace with Code node using this.helpers.httpRequest`);
  console.log(
    `  (Same pattern as "Store Trial Result" in HubSpot categorizer)`,
  );
  console.log(`\nCurrent node:`);
  console.log(`  Type: ${storeNode.type}`);
  console.log(`  Position: [${storeNode.position}]`);
  console.log(`  Table: ai_response_feedback`);
  console.log(`  Operation: insert`);
  console.log(`\nReplacement node:`);
  console.log(`  Type: n8n-nodes-base.code`);
  console.log(`  Method: this.helpers.httpRequest`);
  console.log(
    `  URL: https://your-project.supabase.co/rest/v1/ai_response_feedback`,
  );
  console.log(`  Schema: volterra_kb (via Content-Profile header)`);
  console.log(`  Upsert: resolution=ignore-duplicates`);
  console.log(`\nField mappings (preserved):`);
  console.log(`  thread_ts    <- Extract Message.thread_ts || ts`);
  console.log(`  channel_id   <- Extract Message.channel`);
  console.log(`  ai_response_ts <- Date.now()`);
  console.log(`  ai_response_text <- AI Agent.output`);
  console.log("=".repeat(60));

  if (dryRun) {
    console.log("\n[DRY RUN] Would apply the changes above.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // Replace the node
  const replacementNode = createCodeNode(storeNode);
  const updatedNodes = workflow.nodes.map((node) => {
    if (node.name === "Store AI Response") {
      return replacementNode;
    }
    return node;
  });

  // Connections are preserved since we keep the same node name and ID
  logger.info("Updating workflow...");
  await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: updatedNodes,
    connections: workflow.connections, // Connections unchanged
    settings: allowedSettings(workflow),
  });

  console.log("\n" + "=".repeat(60));
  console.log("FIX APPLIED SUCCESSFULLY");
  console.log("=".repeat(60));
  console.log("  ✅ Replaced native Supabase node with Code node");
  console.log("  ✅ Uses this.helpers.httpRequest (proven pattern)");
  console.log("  ✅ PostgREST API: POST to /rest/v1/ai_response_feedback");
  console.log("  ✅ Schema header: Content-Profile: volterra_kb");
  console.log("  ✅ Upsert behavior: resolution=ignore-duplicates");
  console.log("  ✅ Error handling preserved: continueOnFail: true");
  console.log("  ✅ Connections preserved (same node name and ID)");
  console.log("  ✅ No additional credentials needed (inline anon key)");
  console.log("\n" + "=".repeat(60));
  console.log("VERIFICATION:");
  console.log("=".repeat(60));
  console.log("1. Test by mentioning @Ela in #help-me-platform");
  console.log("");
  console.log("2. Check n8n execution log for:");
  console.log("   - ai_feedback_stored: true");
  console.log("   - No 'Could not get parameter' error");
  console.log("");
  console.log("3. Verify record in volterra_kb.ai_response_feedback:");
  console.log("   SELECT * FROM volterra_kb.ai_response_feedback");
  console.log("   ORDER BY created_at DESC LIMIT 5;");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Script failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
