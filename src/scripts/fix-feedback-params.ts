#!/usr/bin/env npx tsx
/**
 * Fix feedback RPC parameter names in HubSpot Categorizer Workflow
 *
 * Updates the "Store Trial Result" node to use p_-prefixed parameter names
 * matching the updated upsert_hubspot_categorization_feedback function.
 *
 * Usage:
 *   npx tsx src/scripts/fix-feedback-params.ts         # Apply changes
 *   npx tsx src/scripts/fix-feedback-params.ts --dry-run  # Preview changes
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type { Workflow } from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID";

/**
 * Updated code for Store Trial Result node with p_-prefixed parameters
 */
const UPDATED_CODE = `const response = $json.response || {};
const payload = {
  hubspot_ticket_id: $json.ticket_id || '',
  webhook_id: $json.webhook_id || null,
  subject: $json.ticket_subject || null,
  predicted_category: response.category || $json.issue_category || 'General',
  predicted_subcategory: response.subcategory || $json.issue_subcategory || 'Other',
  predicted_confidence: response.confidence ?? null,
  predicted_rationale: response.rationale ?? null,
  predicted_sources: response.sources ?? null,
  predicted_payload: response,
  comparison_note: $json.comparison_note || null,
};

await this.helpers.httpRequest({
  method: 'POST',
  url: 'https://your-project.supabase.co/rest/v1/hubspot_ticket_categorization_trials',
  headers: {
    Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5eG9pa2R3b2lpdHdpZ3lwbXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjExNjU0MTQsImV4cCI6MjA3Njc0MTQxNH0.lOmgUK9uNKEHOhfC2kxIXDiZ4MSUcMR9IPL_cPZqFgU',
    apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5eG9pa2R3b2lpdHdpZ3lwbXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjExNjU0MTQsImV4cCI6MjA3Njc0MTQxNH0.lOmgUK9uNKEHOhfC2kxIXDiZ4MSUcMR9IPL_cPZqFgU',
    'Content-Type': 'application/json',
    'Accept-Profile': 'volterra_kb',
    'Content-Profile': 'volterra_kb',
    Prefer: 'return=representation'
  },
  body: payload,
  json: true,
});

// Feedback payload with p_-prefixed parameters for RPC function
const feedbackPayload = {
  p_hubspot_ticket_id: $json.ticket_id || '',
  p_subject: $json.ticket_subject || null,
  p_description: $json.ticket_description || null,
  p_last_message: $json.ticket_last_message || null,
  p_search_text: $json.search_text || null,
  p_last_outbound: $json.last_outbound || null,
  p_ops_category: $json.ops_category || null,
  p_ops_subcategory: $json.ops_subcategory || null,
  p_predicted_category: payload.predicted_category,
  p_predicted_subcategory: payload.predicted_subcategory,
  p_predicted_confidence: payload.predicted_confidence,
  p_predicted_rationale: payload.predicted_rationale,
  p_predicted_sources: payload.predicted_sources,
  p_predicted_payload: payload.predicted_payload,
  p_embedding_string: $json.embedding_string || null
};

let feedbackStored = false;
let feedbackError = null;
try {
  await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://your-project.supabase.co/rest/v1/rpc/upsert_hubspot_categorization_feedback',
    headers: {
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5eG9pa2R3b2lpdHdpZ3lwbXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjExNjU0MTQsImV4cCI6MjA3Njc0MTQxNH0.lOmgUK9uNKEHOhfC2kxIXDiZ4MSUcMR9IPL_cPZqFgU',
      apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5eG9pa2R3b2lpdHdpZ3lwbXliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjExNjU0MTQsImV4cCI6MjA3Njc0MTQxNH0.lOmgUK9uNKEHOhfC2kxIXDiZ4MSUcMR9IPL_cPZqFgU',
      'Content-Type': 'application/json',
      'Accept-Profile': 'volterra_kb',
      'Content-Profile': 'volterra_kb'
    },
    body: feedbackPayload,
    json: true
  });
  feedbackStored = true;
} catch (err) {
  const status = err?.response?.status ?? err?.status ?? 'unknown';
  const data = err?.response?.data ?? err?.message ?? err;
  const safe = (() => {
    try { return JSON.stringify(data).slice(0, 300); }
    catch (e) { return String(data).slice(0, 300); }
  })();
  feedbackError = \`supabase_\${status}:\${safe}\`;
}

return [{ json: { ...$json, trial_stored: true, feedback_stored: feedbackStored, feedback_error: feedbackError } }];`;

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

  // Find Store Trial Result node
  const storeTrialNode = workflow.nodes.find(
    (n) => n.name === "Store Trial Result",
  );
  if (!storeTrialNode) {
    throw new Error("Store Trial Result node not found");
  }

  const currentCode =
    (storeTrialNode.parameters as { jsCode?: string }).jsCode || "";

  console.log("\n" + "=".repeat(60));
  console.log("PARAMETER NAME FIX");
  console.log("=".repeat(60));
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`ID: ${WORKFLOW_ID}`);
  console.log(`\nNode: Store Trial Result`);
  console.log(`\nChanges to feedbackPayload object:`);
  console.log(`  hubspot_ticket_id → p_hubspot_ticket_id`);
  console.log(`  subject → p_subject`);
  console.log(`  description → p_description`);
  console.log(`  last_message → p_last_message`);
  console.log(`  search_text → p_search_text`);
  console.log(`  last_outbound → p_last_outbound`);
  console.log(`  ops_category → p_ops_category`);
  console.log(`  ops_subcategory → p_ops_subcategory`);
  console.log(`  predicted_category → p_predicted_category`);
  console.log(`  predicted_subcategory → p_predicted_subcategory`);
  console.log(`  predicted_confidence → p_predicted_confidence`);
  console.log(`  predicted_rationale → p_predicted_rationale`);
  console.log(`  predicted_sources → p_predicted_sources`);
  console.log(`  predicted_payload → p_predicted_payload`);
  console.log(`  embedding_string → p_embedding_string`);
  console.log("=".repeat(60));

  if (dryRun) {
    console.log("\n[DRY RUN] Would apply the changes above.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // Update node code
  const updatedNodes = workflow.nodes.map((node) => {
    if (node.name === "Store Trial Result") {
      return {
        ...node,
        parameters: {
          ...node.parameters,
          jsCode: UPDATED_CODE,
        },
      };
    }
    return node;
  });

  logger.info("Updating workflow...");
  await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: updatedNodes,
    connections: workflow.connections,
    settings: allowedSettings(workflow),
  });

  console.log("\n" + "=".repeat(60));
  console.log("CHANGES APPLIED SUCCESSFULLY");
  console.log("=".repeat(60));
  console.log("  ✓ Updated feedbackPayload to use p_-prefixed parameters");
  console.log(
    "  ✓ RPC function upsert_hubspot_categorization_feedback will now work",
  );
  console.log("\n" + "=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Script failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
