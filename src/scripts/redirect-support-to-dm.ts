/**
 * Redirect Support Workflow Responses to DM
 *
 * Modifies the "AI agent support - Slack" workflow (UtsHZSFSpXa6arFN) to send
 * responses as DMs to dev.user instead of thread replies in #help-me-platform.
 *
 * Purpose: Testing support bot responses without polluting the channel.
 *
 * Usage: npm run redirect:support-dm
 * Rollback: npm run redirect:support-thread (to restore original behavior)
 */

import { N8nApiClient } from "../services/n8n-api-client.js";
import { logger } from "../utils/logger.js";

const WORKFLOW_ID = "UtsHZSFSpXa6arFN";
const TARGET_USER_ID = "YOUR_SLACK_USER_ID"; // dev.user

interface SlackNodeParams {
  select: string;
  user?: {
    value: string;
    cachedResultName: string;
    __rl?: boolean;
    mode?: string;
  };
  channelId?: unknown;
  text: string;
  otherOptions: {
    includeLinkToWorkflow?: boolean;
    thread_ts?: unknown;
  };
}

async function main() {
  const args = process.argv.slice(2);
  const restoreThread = args.includes("--restore") || args.includes("--thread");
  const dryRun = args.includes("--dry-run");

  const client = new N8nApiClient();

  logger.info("Fetching support workflow...");
  const workflow = await client.getWorkflow(WORKFLOW_ID);

  logger.info(`Workflow: ${workflow.name}`);
  logger.info(`Active: ${workflow.active}`);

  // Find the Slack Response node
  const slackNode = workflow.nodes.find((n) => n.name === "Slack Response");
  if (!slackNode) {
    throw new Error("Slack Response node not found in workflow");
  }

  logger.info("Current Slack Response parameters:");
  console.log(JSON.stringify(slackNode.parameters, null, 2));

  const currentParams = slackNode.parameters as SlackNodeParams;

  // Build new parameters
  let newParams: SlackNodeParams;

  if (restoreThread) {
    // Restore to thread reply mode
    logger.info("\n--- RESTORING TO THREAD REPLY MODE ---");
    newParams = {
      select: "user",
      user: {
        value: TARGET_USER_ID,
        cachedResultName: "dev.user",
        __rl: true,
        mode: "id",
      },
      text:
        currentParams.text ||
        "={{ $json.output || $json.text || 'I could not process your request.' }}",
      otherOptions: {
        includeLinkToWorkflow: false,
        thread_ts: {
          replyValues: {
            thread_ts: "={{ $('Extract Message').item.json.reply_thread_ts }}",
          },
        },
      },
    };
  } else {
    // Redirect to DM (remove thread_ts)
    logger.info("\n--- REDIRECTING TO DM MODE ---");
    newParams = {
      select: "user",
      user: {
        value: TARGET_USER_ID,
        cachedResultName: "dev.user",
        __rl: true,
        mode: "id",
      },
      text:
        currentParams.text ||
        "={{ $json.output || $json.text || 'I could not process your request.' }}",
      otherOptions: {
        includeLinkToWorkflow: false,
        // thread_ts REMOVED - now sends as DM
      },
    };
  }

  logger.info("New Slack Response parameters:");
  console.log(JSON.stringify(newParams, null, 2));

  if (dryRun) {
    logger.info("\n[DRY RUN] Would update workflow with above parameters");
    return;
  }

  // Deactivate workflow before updating
  logger.info("\nDeactivating workflow...");
  try {
    await client.deactivateWorkflow(WORKFLOW_ID);
  } catch (e) {
    logger.warn("Could not deactivate (may already be inactive)");
  }

  // Update the node
  const updatedNodes = workflow.nodes.map((node) => {
    if (node.name === "Slack Response") {
      return {
        ...node,
        parameters: newParams,
      };
    }
    return node;
  });

  // Update workflow - use minimal settings to avoid API validation errors
  logger.info("Updating workflow...");
  const result = await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: updatedNodes,
    connections: workflow.connections,
    settings: {}, // Empty settings to avoid validation errors
  });

  logger.info("Workflow updated successfully!");

  // Reactivate
  logger.info("Reactivating workflow...");
  await client.activateWorkflow(WORKFLOW_ID);
  logger.info("Workflow activated!");

  // Summary
  if (restoreThread) {
    logger.info("\n✅ Workflow restored to THREAD REPLY mode");
    logger.info("   Responses will reply in #help-me-platform threads");
  } else {
    logger.info("\n✅ Workflow redirected to DM mode");
    logger.info("   Responses will be sent as DM to dev.user");
    logger.info("   To restore: npm run redirect:support-thread");
  }
}

main().catch((error) => {
  logger.error("Failed:", error);
  process.exit(1);
});
