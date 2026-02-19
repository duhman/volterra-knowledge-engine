#!/usr/bin/env npx tsx
/**
 * Cleanup HubSpot Ticket Categorizer Workflow
 *
 * Removes orphan nodes and stale connections:
 * 1. "Parse Embedding" node - has no incoming connections
 * 2. "Merge AI Output" connection - references non-existent node
 * 3. "Supabase Training Conversations Deterministic" reference - doesn't exist
 *
 * Usage:
 *   npx tsx src/scripts/cleanup-categorizer-workflow.ts         # Apply changes
 *   npx tsx src/scripts/cleanup-categorizer-workflow.ts --dry-run  # Preview
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type { Workflow, WorkflowConnections } from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID";

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

  const issues: string[] = [];

  // 1. Check for orphan nodes (nodes with no incoming connections)
  const allTargets = new Set<string>();
  for (const [, conn] of Object.entries(workflow.connections)) {
    if (conn.main) {
      for (const outputs of conn.main) {
        for (const target of outputs || []) {
          allTargets.add(target.node);
        }
      }
    }
    // Also check ai_* connections
    for (const [key, outputs] of Object.entries(conn)) {
      if (key.startsWith("ai_") && Array.isArray(outputs)) {
        for (const targetList of outputs) {
          for (const target of targetList || []) {
            allTargets.add(target.node);
          }
        }
      }
    }
  }

  // Nodes that have no incoming connections (excluding webhook trigger)
  const orphanNodes = workflow.nodes
    .filter(
      (n) => !allTargets.has(n.name) && n.type !== "n8n-nodes-base.webhook",
    )
    // Also exclude langchain nodes that connect via ai_* (they don't need main connections)
    .filter((n) => !n.type?.includes("langchain") || n.type?.includes("agent"));

  for (const node of orphanNodes) {
    if (workflow.connections[node.name]) {
      issues.push(
        `Orphan node with outgoing connections: "${node.name}" (${node.type})`,
      );
    }
  }

  // 2. Check for stale connections (connections from non-existent nodes)
  const nodeNames = new Set(workflow.nodes.map((n) => n.name));
  const staleConnections: string[] = [];
  for (const sourceName of Object.keys(workflow.connections)) {
    if (!nodeNames.has(sourceName)) {
      staleConnections.push(sourceName);
      issues.push(`Stale connection from non-existent node: "${sourceName}"`);
    }
  }

  // 3. Check for references to non-existent target nodes
  for (const [sourceName, conn] of Object.entries(workflow.connections)) {
    for (const [connType, outputs] of Object.entries(conn)) {
      if (Array.isArray(outputs)) {
        for (const targetList of outputs) {
          for (const target of targetList || []) {
            if (!nodeNames.has(target.node)) {
              issues.push(
                `Reference to non-existent node: "${sourceName}" → "${target.node}" (${connType})`,
              );
            }
          }
        }
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("WORKFLOW REVIEW SUMMARY");
  console.log("=".repeat(70));
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`ID: ${WORKFLOW_ID}`);
  console.log(`Total nodes: ${workflow.nodes.length}`);
  console.log(
    `Total connection sources: ${Object.keys(workflow.connections).length}`,
  );

  if (issues.length === 0) {
    console.log("\n✅ No issues found! Workflow is clean.");
    return;
  }

  console.log(`\n⚠️  Found ${issues.length} issue(s):`);
  for (const issue of issues) {
    console.log(`  - ${issue}`);
  }

  console.log("\n" + "-".repeat(70));
  console.log("CLEANUP PLAN");
  console.log("-".repeat(70));

  // Plan removals
  const nodesToRemove = orphanNodes
    .filter((n) => workflow.connections[n.name]) // Only remove if it has outgoing connections (truly orphan with output)
    .map((n) => n.name);

  console.log(
    `\nNodes to remove: ${nodesToRemove.length > 0 ? nodesToRemove.join(", ") : "(none)"}`,
  );
  console.log(
    `Stale connections to remove: ${staleConnections.length > 0 ? staleConnections.join(", ") : "(none)"}`,
  );

  if (nodesToRemove.length === 0 && staleConnections.length === 0) {
    console.log(
      "\n⚠️  Issues found but auto-cleanup not safe. Manual review recommended.",
    );
    console.log("=".repeat(70));
    return;
  }

  if (dryRun) {
    console.log("\n[DRY RUN] Would apply the cleanup above.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // Apply cleanup
  const updatedNodes = workflow.nodes.filter(
    (n) => !nodesToRemove.includes(n.name),
  );
  const updatedConnections: WorkflowConnections = {};

  for (const [sourceName, conn] of Object.entries(workflow.connections)) {
    // Skip connections from removed nodes or stale sources
    if (
      nodesToRemove.includes(sourceName) ||
      staleConnections.includes(sourceName)
    ) {
      continue;
    }

    // Filter out connections to removed nodes
    const cleanedConn: WorkflowConnections[string] = {};
    for (const [connType, outputs] of Object.entries(conn)) {
      if (Array.isArray(outputs)) {
        const cleanedOutputs = outputs.map((targetList) =>
          (targetList || []).filter(
            (target) =>
              !nodesToRemove.includes(target.node) &&
              nodeNames.has(target.node),
          ),
        );
        (cleanedConn as Record<string, unknown>)[connType] = cleanedOutputs;
      }
    }
    updatedConnections[sourceName] = cleanedConn;
  }

  logger.info("Updating workflow...");
  await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: updatedNodes,
    connections: updatedConnections,
    settings: allowedSettings(workflow),
  });

  console.log("\n" + "=".repeat(70));
  console.log("CLEANUP COMPLETE");
  console.log("=".repeat(70));
  console.log(`  ✓ Removed ${nodesToRemove.length} orphan node(s)`);
  console.log(`  ✓ Removed ${staleConnections.length} stale connection(s)`);
  console.log(`  Final node count: ${updatedNodes.length}`);
  console.log("=".repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Cleanup failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
