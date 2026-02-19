#!/usr/bin/env npx tsx
/**
 * Improve HubSpot Ticket Categorizer Accuracy
 *
 * Modifies the n8n workflow `YOUR_WORKFLOW_ID` to:
 * 1. Add disambiguation rules to the AI Agent's system prompt
 * 2. Increase match threshold from 0.5 to 0.78 for higher quality matches
 *
 * Usage:
 *   npm run improve:categorizer-accuracy         # Apply changes
 *   npm run improve:categorizer-accuracy -- --dry-run  # Preview changes
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type { WorkflowNode, Workflow } from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID";

// New match threshold (increased from 0.5)
const NEW_MATCH_THRESHOLD = 0.78;

// Disambiguation rules to append to system prompt
const DISAMBIGUATION_SECTION = `

## SUBCATEGORY DISAMBIGUATION

When classifying, pay attention to these commonly confused pairs:

| If you see... | It's likely... | NOT... |
|---------------|----------------|--------|
| New customer setup, first-time configuration, welcome process, QR pairing | **Onboarding** | Ordering |
| Placing an order, buying equipment, purchase request, delivery tracking | **Ordering** | Onboarding |
| Charger completely unresponsive, no lights, can't connect to cloud, offline | **Charger offline** | Unstable charging |
| Charging starts then stops, intermittent issues, partial sessions, drops | **Unstable charging** | Charger offline |
| General "how does charging work" questions, cannot start (no offline/drops) | **Charging** | Charger offline |
| Physical damage, broken connector, hardware defect, blown fuse | **Hardware failure** | User error |
| Customer did something wrong, cable locked, EV not connected, wrong usage | **User error** | Hardware failure |
| Backend systems down, API errors, cloud connectivity issues | **IT / Cloud error** | Charger offline |
| Maintenance request, technician visit, repair scheduling | **Service** | Hardware failure |
| App bugs, app crashes, mobile app issues, login problems | **App** | Ordering |
| Payment disputes, billing questions, refunds | **Invoice** | Ordering |
| Subscription changes, pricing questions, plan upgrades | **Subscription and pricing** | Invoice |
| Cancel service, end contract, termination request | **Termination** | Subscription and pricing |

### Key Differentiators

**Onboarding vs Ordering:**
- Onboarding: Customer already HAS the charger, needs help setting it up
- Ordering: Customer wants to BUY/ORDER a charger or equipment

**Charger offline vs Unstable charging:**
- Offline: Charger is DEAD, no response, no connection at all
- Unstable: Charger WORKS but charging sessions fail or interrupt

**Hardware failure vs User error:**
- Hardware: The equipment itself is broken/defective
- User error: Equipment is fine, customer is using it incorrectly

**IT / Cloud error vs Charger offline:**
- IT/Cloud: Backend/server issues affecting multiple chargers or app
- Offline: Single charger connectivity issue`;

// Type helper for node parameters
interface AIAgentOptions {
  systemMessage?: string;
  [key: string]: unknown;
}

interface AIAgentParameters {
  options?: AIAgentOptions;
  [key: string]: unknown;
}

interface CodeNodeParameters {
  jsCode?: string;
  [key: string]: unknown;
}

/**
 * Update AI Agent node with disambiguation rules
 */
function updateAIAgentNode(node: WorkflowNode): WorkflowNode {
  const params = node.parameters as AIAgentParameters;
  const currentPrompt = (params?.options?.systemMessage as string) || "";

  // Check if disambiguation section already exists
  if (currentPrompt.includes("SUBCATEGORY DISAMBIGUATION")) {
    logger.info("Disambiguation section already exists in system prompt");
    return node;
  }

  // Append disambiguation section to the system prompt
  const updatedPrompt = currentPrompt + DISAMBIGUATION_SECTION;

  const currentOptions = (params?.options || {}) as AIAgentOptions;

  return {
    ...node,
    parameters: {
      ...params,
      options: {
        ...currentOptions,
        systemMessage: updatedPrompt,
      },
    },
  };
}

/**
 * Update Match Training Conversations node with higher threshold
 */
function updateMatchTrainingNode(node: WorkflowNode): WorkflowNode {
  const params = node.parameters as CodeNodeParameters;
  const currentCode = (params?.jsCode as string) || "";

  // Check current threshold
  const thresholdMatch = currentCode.match(/match_threshold:\s*([\d.]+)/);
  const currentThreshold = thresholdMatch ? parseFloat(thresholdMatch[1]) : 0.5;

  if (currentThreshold >= NEW_MATCH_THRESHOLD) {
    logger.info(
      `Match threshold already at ${currentThreshold} (>= ${NEW_MATCH_THRESHOLD})`,
    );
    return node;
  }

  // Replace the match_threshold value in the training conversations call
  // We want to update the first match_threshold (training conversations)
  // but NOT the second one (feedback results) which should stay at 0.55
  let updatedCode = currentCode;
  let replacementCount = 0;

  updatedCode = currentCode.replace(
    /match_threshold:\s*0\.5([^5])/g,
    (match, suffix) => {
      if (replacementCount === 0) {
        replacementCount++;
        return `match_threshold: ${NEW_MATCH_THRESHOLD}${suffix}`;
      }
      return match;
    },
  );

  // If the simple replace didn't work, try a more specific pattern
  if (replacementCount === 0) {
    updatedCode = currentCode.replace(
      /(match_training_conversations_with_reply[\s\S]*?match_threshold:\s*)0\.5/,
      `$1${NEW_MATCH_THRESHOLD}`,
    );
  }

  return {
    ...node,
    parameters: {
      ...params,
      jsCode: updatedCode,
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

  // Find the nodes we need to update
  const aiAgentNode = workflow.nodes.find((n) => n.name === "AI Agent");
  const matchTrainingNode = workflow.nodes.find(
    (n) => n.name === "Match Training Conversations (RPC)",
  );

  if (!aiAgentNode) {
    throw new Error("AI Agent node not found");
  }
  if (!matchTrainingNode) {
    throw new Error("Match Training Conversations (RPC) node not found");
  }

  // Analyze current state
  const aiAgentParams = aiAgentNode.parameters as AIAgentParameters;
  const currentPrompt = (aiAgentParams?.options?.systemMessage as string) || "";
  const hasDisambiguation = currentPrompt.includes(
    "SUBCATEGORY DISAMBIGUATION",
  );
  const promptLength = currentPrompt.length;

  const matchParams = matchTrainingNode.parameters as CodeNodeParameters;
  const currentCode = (matchParams?.jsCode as string) || "";
  const thresholdMatch = currentCode.match(/match_threshold:\s*([\d.]+)/);
  const currentThreshold = thresholdMatch ? parseFloat(thresholdMatch[1]) : 0.5;

  console.log("\n" + "=".repeat(60));
  console.log("CATEGORIZER ACCURACY IMPROVEMENT PLAN");
  console.log("=".repeat(60));
  console.log(`\nWorkflow: ${workflow.name}`);
  console.log(`ID: ${WORKFLOW_ID}`);

  console.log(`\n1. AI Agent System Prompt:`);
  console.log(`   Current length: ${promptLength} chars`);
  console.log(
    `   Has disambiguation: ${hasDisambiguation ? "YES (skip)" : "NO (will add)"}`,
  );
  console.log(
    `   Disambiguation section: ${DISAMBIGUATION_SECTION.length} chars`,
  );

  console.log(`\n2. Match Training Conversations Threshold:`);
  console.log(`   Current threshold: ${currentThreshold}`);
  console.log(`   Target threshold: ${NEW_MATCH_THRESHOLD}`);
  console.log(
    `   Change: ${currentThreshold >= NEW_MATCH_THRESHOLD ? "NONE (already high enough)" : `${currentThreshold} → ${NEW_MATCH_THRESHOLD}`}`,
  );

  console.log(`\n3. Expected Impact:`);
  console.log(`   - Reduce Onboarding→Ordering confusion (currently 21.5%)`);
  console.log(
    `   - Reduce Unstable charging→Charger offline confusion (21.6%)`,
  );
  console.log(`   - Higher quality training matches = better majority vote`);
  console.log(`   - Target: Subcategory accuracy 59.99% → 65-70%`);

  console.log("=".repeat(60));

  if (dryRun) {
    console.log("\n[DRY RUN] Would apply the changes above.");

    if (!hasDisambiguation) {
      console.log("\nDisambiguation section to add:");
      console.log("-".repeat(40));
      console.log(DISAMBIGUATION_SECTION);
      console.log("-".repeat(40));
    }

    console.log("\nRun without --dry-run to apply changes.");
    return;
  }

  // Build updated nodes list
  const updatedNodes = workflow.nodes.map((node) => {
    if (node.name === "AI Agent") {
      return updateAIAgentNode(node);
    }
    if (node.name === "Match Training Conversations (RPC)") {
      return updateMatchTrainingNode(node);
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
  if (!hasDisambiguation) {
    console.log("  ✅ Added disambiguation rules to AI Agent system prompt");
  } else {
    console.log("  ⏭️  Disambiguation rules already present (skipped)");
  }
  if (currentThreshold < NEW_MATCH_THRESHOLD) {
    console.log(
      `  ✅ Updated match threshold: ${currentThreshold} → ${NEW_MATCH_THRESHOLD}`,
    );
  } else {
    console.log(`  ⏭️  Match threshold already ${currentThreshold} (skipped)`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("VERIFICATION STEPS:");
  console.log("=".repeat(60));
  console.log("1. Verify workflow in n8n:");
  console.log("   npm run n8n get -- YOUR_WORKFLOW_ID");
  console.log("\n2. Test manually in n8n UI with edge cases:");
  console.log("   - Onboarding ticket (setup, installation, QR code)");
  console.log("   - Ordering ticket (purchase, delivery, order)");
  console.log("   - Unstable charging (starts then stops)");
  console.log("   - Charger offline (no response, dead)");
  console.log("\n3. After 24-48 hours, run evaluation:");
  console.log(
    "   python3 -u scripts/evaluate-hubspot-categorizer.py --full --max-workers 4",
  );
  console.log("\n4. Expected results:");
  console.log("   - Subcategory accuracy: 59.99% → 65-70%");
  console.log("   - Confusion pairs should decrease by ~30%");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Script failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
