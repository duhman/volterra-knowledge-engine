#!/usr/bin/env npx tsx
/**
 * Fix Ampeco Workflow Supabase Nodes
 *
 * Replaces native Supabase nodes with Code nodes using this.helpers.httpRequest
 * to the PostgREST API. The native nodes throw "Could not get parameter: operation"
 * due to a known n8n version incompatibility bug.
 *
 * Nodes replaced:
 * - Check Last Version (getAll) → GET /rest/v1/ampeco_changelog_state
 * - Update State (update) → PATCH /rest/v1/ampeco_changelog_state
 *
 * This is the proven pattern used by:
 * - Store Trial Result in HubSpot categorizer workflow
 * - Store AI Response in support workflow
 *
 * Usage:
 *   npm run fix:ampeco-supabase                # Apply changes
 *   npm run fix:ampeco-supabase -- --dry-run   # Preview changes
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type { WorkflowNode, Workflow } from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID"; // Ampeco Changelog Monitor

// Supabase Cloud anon key (public, read-only with RLS)
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

/**
 * Create Code node for "Check Last Version" (GET operation)
 */
function createCheckLastVersionNode(originalNode: WorkflowNode): WorkflowNode {
  const jsCode = `// Fetch last version from Supabase via PostgREST API
// Replaces native Supabase node that throws "Could not get parameter: operation"

let lastSeenVersion = null;
let lastCheckedAt = null;
let error = null;

try {
  const response = await this.helpers.httpRequest({
    method: 'GET',
    url: 'https://your-project.supabase.co/rest/v1/ampeco_changelog_state',
    headers: {
      'Authorization': 'Bearer ${SUPABASE_ANON_KEY}',
      'apikey': '${SUPABASE_ANON_KEY}',
      'Accept': 'application/json'
    },
    qs: {
      id: 'eq.1',
      select: '*'
    },
    json: true
  });

  if (response && response.length > 0) {
    lastSeenVersion = response[0].last_seen_version;
    lastCheckedAt = response[0].last_checked_at;
  }
} catch (err) {
  const status = err?.response?.status ?? err?.status ?? 'unknown';
  const data = err?.response?.data ?? err?.message ?? err;
  error = \`supabase_get_\${status}: \${JSON.stringify(data).slice(0, 200)}\`;
  console.log('Failed to fetch last version:', error);
}

return [{
  json: {
    last_seen_version: lastSeenVersion,
    last_checked_at: lastCheckedAt,
    fetch_error: error
  }
}];`;

  return {
    id: originalNode.id,
    name: originalNode.name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: originalNode.position,
    parameters: {
      jsCode,
      mode: "runOnceForAllItems",
    },
  };
}

/**
 * Create Code node for "Update State" (PATCH operation)
 */
function createUpdateStateNode(originalNode: WorkflowNode): WorkflowNode {
  const jsCode = `// Update state in Supabase via PostgREST API
// Replaces native Supabase node that throws "Could not get parameter: operation"

const version = $('Parse Version').item.json.version;
const now = new Date().toISOString();

let updated = false;
let error = null;

try {
  const response = await this.helpers.httpRequest({
    method: 'PATCH',
    url: 'https://your-project.supabase.co/rest/v1/ampeco_changelog_state',
    headers: {
      'Authorization': 'Bearer ${SUPABASE_ANON_KEY}',
      'apikey': '${SUPABASE_ANON_KEY}',
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    qs: {
      id: 'eq.1'
    },
    body: {
      last_seen_version: version,
      last_notified_at: now,
      last_checked_at: now
    },
    json: true
  });

  updated = true;
  console.log('State updated:', response);
} catch (err) {
  const status = err?.response?.status ?? err?.status ?? 'unknown';
  const data = err?.response?.data ?? err?.message ?? err;
  error = \`supabase_patch_\${status}: \${JSON.stringify(data).slice(0, 200)}\`;
  console.log('Failed to update state:', error);
}

return [{
  json: {
    version,
    updated_at: now,
    update_success: updated,
    update_error: error
  }
}];`;

  return {
    id: originalNode.id,
    name: originalNode.name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: originalNode.position,
    parameters: {
      jsCode,
      mode: "runOnceForAllItems",
    },
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

  // Find the nodes to replace
  const checkLastVersionNode = workflow.nodes.find(
    (n) => n.name === "Check Last Version",
  );
  const updateStateNode = workflow.nodes.find((n) => n.name === "Update State");

  if (!checkLastVersionNode) {
    throw new Error("Check Last Version node not found in workflow");
  }
  if (!updateStateNode) {
    throw new Error("Update State node not found in workflow");
  }

  // Check if already fixed
  const nodesToFix: { node: WorkflowNode; operation: string }[] = [];

  if (checkLastVersionNode.type === "n8n-nodes-base.supabase") {
    nodesToFix.push({
      node: checkLastVersionNode,
      operation: "getAll (SELECT)",
    });
  } else if (checkLastVersionNode.type === "n8n-nodes-base.code") {
    const jsCode =
      (checkLastVersionNode.parameters as { jsCode?: string })?.jsCode || "";
    if (!jsCode.includes("ampeco_changelog_state")) {
      throw new Error(
        "Check Last Version is a Code node but doesn't have expected PostgREST pattern",
      );
    }
    logger.info("Check Last Version already uses PostgREST pattern");
  } else {
    throw new Error(
      `Unexpected node type for Check Last Version: ${checkLastVersionNode.type}`,
    );
  }

  if (updateStateNode.type === "n8n-nodes-base.supabase") {
    nodesToFix.push({ node: updateStateNode, operation: "update (PATCH)" });
  } else if (updateStateNode.type === "n8n-nodes-base.code") {
    const jsCode =
      (updateStateNode.parameters as { jsCode?: string })?.jsCode || "";
    if (!jsCode.includes("ampeco_changelog_state")) {
      throw new Error(
        "Update State is a Code node but doesn't have expected PostgREST pattern",
      );
    }
    logger.info("Update State already uses PostgREST pattern");
  } else {
    throw new Error(
      `Unexpected node type for Update State: ${updateStateNode.type}`,
    );
  }

  if (nodesToFix.length === 0) {
    console.log("\n" + "=".repeat(60));
    console.log("NO CHANGES NEEDED");
    console.log("=".repeat(60));
    console.log("Both nodes already use PostgREST pattern.");
    return;
  }

  console.log("\n" + "=".repeat(60));
  console.log("FIX PLAN: Replace Native Supabase Nodes with Code Nodes");
  console.log("=".repeat(60));
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`ID: ${WORKFLOW_ID}`);
  console.log(`\nProblem:`);
  console.log(
    `  Native Supabase node throws "Could not get parameter: operation"`,
  );
  console.log(`  This is a known n8n bug with certain node versions.`);
  console.log(`\nSolution:`);
  console.log(`  Replace with Code nodes using this.helpers.httpRequest`);
  console.log(`  (Same pattern as Store Trial Result in HubSpot categorizer)`);

  for (const { node, operation } of nodesToFix) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Node: ${node.name}`);
    console.log(`${"─".repeat(60)}`);
    console.log(`  Current type: ${node.type}`);
    console.log(`  Operation: ${operation}`);
    console.log(`  Position: [${node.position}]`);
    console.log(`  → Will replace with: n8n-nodes-base.code`);
    console.log(`  → Method: this.helpers.httpRequest`);
    console.log(`  → Table: public.ampeco_changelog_state`);
  }

  console.log("\n" + "=".repeat(60));

  if (dryRun) {
    console.log("\n[DRY RUN] Would apply the changes above.");
    console.log("Run without --dry-run to apply changes.\n");
    return;
  }

  // Replace the nodes
  const updatedNodes = workflow.nodes.map((node) => {
    if (
      node.name === "Check Last Version" &&
      node.type === "n8n-nodes-base.supabase"
    ) {
      return createCheckLastVersionNode(node);
    }
    if (
      node.name === "Update State" &&
      node.type === "n8n-nodes-base.supabase"
    ) {
      return createUpdateStateNode(node);
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
  console.log("FIX APPLIED SUCCESSFULLY");
  console.log("=".repeat(60));
  console.log("  ✅ Replaced native Supabase nodes with Code nodes");
  console.log("  ✅ Uses this.helpers.httpRequest (proven pattern)");
  console.log(
    "  ✅ PostgREST API: GET/PATCH to /rest/v1/ampeco_changelog_state",
  );
  console.log("  ✅ Connections preserved (same node names and IDs)");
  console.log("  ✅ No additional credentials needed (inline anon key)");
  console.log("\n" + "=".repeat(60));
  console.log("VERIFICATION:");
  console.log("=".repeat(60));
  console.log("1. Check n8n execution history - no more 'operation' errors");
  console.log("");
  console.log("2. Wait for next scheduled run (12:00 UTC daily)");
  console.log("   Or trigger manually: Execute Workflow in n8n GUI");
  console.log("");
  console.log("3. Optional: Reset state to trigger test notification:");
  console.log(
    "   UPDATE ampeco_changelog_state SET last_seen_version = '31150' WHERE id = 1;",
  );
  console.log("");
  console.log("4. Verify state is being read/updated:");
  console.log("   SELECT * FROM public.ampeco_changelog_state WHERE id = 1;");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Script failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
