#!/usr/bin/env npx tsx
/**
 * Fix Ampeco Changelog Monitor Duplicate Notifications
 *
 * Problem:
 * The workflow posts duplicate Slack notifications for the same version
 * when the "Check Last Version" node encounters a fetch error. The error
 * is silently returned as `fetch_error` but the IF node only checks:
 *   currentVersion !== lastSeenVersion
 *
 * When fetch fails, lastSeenVersion is null, so comparison becomes:
 *   "31320" !== null  →  TRUE (always triggers notification!)
 *
 * Fix:
 * Update the "New Version?" IF node to add a second condition:
 *   1. currentVersion !== lastSeenVersion (existing)
 *   2. fetch_error IS empty (new - ensures we only notify when fetch succeeded)
 *
 * Usage:
 *   npm run fix:ampeco-duplicates           # Apply fix
 *   npm run fix:ampeco-duplicates -- --dry-run  # Preview changes
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type { Workflow } from "../types/n8n.js";

config();

const WORKFLOW_ID = "s3EajqONZhRf0895"; // Ampeco Changelog Monitor

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

/**
 * Create updated IF node conditions with fetch_error check
 */
function createUpdatedConditions() {
  return {
    options: {
      caseSensitive: true,
      leftValue: "",
      typeValidation: "strict",
    },
    combinator: "and",
    conditions: [
      // Condition 1: Version has changed (existing)
      {
        id: "version-check",
        leftValue: "={{ $('Parse Version').item.json.version }}",
        rightValue:
          "={{ $('Check Last Version').item.json.last_seen_version }}",
        operator: {
          type: "string",
          operation: "notEquals",
        },
      },
      // Condition 2: No fetch error (NEW - prevents duplicate notifications)
      {
        id: "no-fetch-error",
        leftValue: "={{ $('Check Last Version').item.json.fetch_error }}",
        rightValue: "",
        operator: {
          type: "string",
          operation: "empty",
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const client = new N8nApiClient();

  logger.info(`Fetching workflow ${WORKFLOW_ID}...`);
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  logger.info(`Got workflow: ${workflow.name}`);

  // Find the IF node
  const ifNode = workflow.nodes.find((n) => n.name === "New Version?");

  if (!ifNode) {
    throw new Error("'New Version?' IF node not found in workflow");
  }

  if (ifNode.type !== "n8n-nodes-base.if") {
    throw new Error(
      `Unexpected node type for 'New Version?': ${ifNode.type} (expected n8n-nodes-base.if)`,
    );
  }

  // Check current conditions
  const currentConditions = (
    ifNode.parameters as { conditions?: { conditions?: unknown[] } }
  )?.conditions;
  const conditionCount = currentConditions?.conditions?.length ?? 0;

  console.log("\n" + "=".repeat(60));
  console.log("FIX PLAN: Add fetch_error Check to IF Node");
  console.log("=".repeat(60));
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`ID: ${WORKFLOW_ID}`);

  console.log(`\nProblem:`);
  console.log(`  When "Check Last Version" fails to fetch from Supabase,`);
  console.log(`  it returns fetch_error but last_seen_version is null.`);
  console.log(`  The IF node compares: "31320" !== null → TRUE (always!)`);
  console.log(`  This causes duplicate Slack notifications.`);

  console.log(`\nCurrent IF Node:`);
  console.log(`  - Name: ${ifNode.name}`);
  console.log(`  - Conditions: ${conditionCount}`);
  console.log(`  - Only checks: version !== last_seen_version`);

  console.log(`\nFix:`);
  console.log(`  Add second condition: fetch_error IS empty`);
  console.log(`  This ensures notifications only happen when:`);
  console.log(`    1. Version has changed (new release)`);
  console.log(`    2. AND the fetch succeeded (no API errors)`);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Updated Conditions:`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  [1] version-check:`);
  console.log(`      $('Parse Version').item.json.version`);
  console.log(`      !== $('Check Last Version').item.json.last_seen_version`);
  console.log(`  [2] no-fetch-error (NEW):`);
  console.log(`      $('Check Last Version').item.json.fetch_error`);
  console.log(`      IS empty`);
  console.log(`  Combinator: AND (both must be true)`);

  console.log("\n" + "=".repeat(60));

  if (dryRun) {
    console.log("\n[DRY RUN] Would apply the changes above.");
    console.log("Run without --dry-run to apply changes.\n");
    return;
  }

  // Update the IF node with new conditions
  const updatedNodes = workflow.nodes.map((node) => {
    if (node.name === "New Version?" && node.type === "n8n-nodes-base.if") {
      return {
        ...node,
        parameters: {
          ...node.parameters,
          conditions: createUpdatedConditions(),
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
  console.log("FIX APPLIED SUCCESSFULLY");
  console.log("=".repeat(60));
  console.log("  ✅ Added fetch_error check to IF node conditions");
  console.log("  ✅ Uses AND combinator (both conditions must be true)");
  console.log("  ✅ Notifications only trigger when:");
  console.log("     - New version detected");
  console.log("     - AND Supabase fetch succeeded");
  console.log("\n" + "=".repeat(60));
  console.log("VERIFICATION:");
  console.log("=".repeat(60));
  console.log("1. Wait for next scheduled run (12:00 UTC daily)");
  console.log("   Or execute manually in n8n GUI");
  console.log("");
  console.log("2. Check execution logs:");
  console.log("   - With fetch_error: 'New Version?' should take FALSE path");
  console.log("   - With successful fetch + same version: FALSE path");
  console.log("   - With successful fetch + new version: TRUE path → notify");
  console.log("");
  console.log("3. Test scenarios:");
  console.log(
    "   a) Simulate error: Temporarily break Supabase URL → no notification",
  );
  console.log("   b) Simulate new version:");
  console.log(
    "      UPDATE public.ampeco_changelog_state SET last_seen_version = '31150' WHERE id = 1;",
  );
  console.log("      → Should trigger notification");
  console.log("   c) Run again without reset → no notification (same version)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Script failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
