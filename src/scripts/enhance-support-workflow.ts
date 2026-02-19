#!/usr/bin/env npx tsx
/**
 * Enhance #help-me-platform Support Workflow
 *
 * Improves the AI Agent's system prompt with:
 * 1. Resolution detection - Prioritize threads with resolved status
 * 2. Confidence handling - Skip response guidance for low similarity
 * 3. Source attribution - Clear per-source citations
 *
 * Usage: npm run enhance:support-workflow
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type { Workflow, WorkflowNode } from "../types/n8n.js";

config();

const WORKFLOW_ID = "YOUR_WORKFLOW_ID"; // AI agent support - Slack

/**
 * Additional system prompt sections to inject
 */
const RESOLUTION_GUIDANCE = `
## RESOLUTION-FOCUSED RESPONSES

When searching for similar issues, prioritize threads that show resolution:

**Resolution indicators to look for:**
- Keywords: "fixed", "resolved", "done", "works now", "solved", "that worked"
- Positive reactions: :white_check_mark:, :heavy_check_mark:, :tada:
- Agent closing phrases: "let me know if you need anything else"

**Response structure for resolved issues:**
1. Acknowledge the user's issue
2. Note that similar issues have been resolved before
3. Share the resolution approach that worked
4. Offer to help if the suggested approach doesn't work

**When no resolution is found:**
- Be honest: "I found similar discussions but no clear resolution"
- Suggest what to try based on the symptoms
- Recommend escalation if needed
`;

const CONFIDENCE_GUIDANCE = `
## CONFIDENCE HANDLING

**High confidence (similarity > 0.7):**
- Lead with the answer: "This looks like [specific issue]. Here's what worked..."
- Provide detailed steps from the resolved thread

**Medium confidence (0.5-0.7):**
- Frame as suggestion: "This might be related to [issue]. Previous threads suggest..."
- Ask one clarifying question if needed

**Low confidence (< 0.5):**
- Acknowledge uncertainty: "I couldn't find a strong match for this issue"
- Provide general troubleshooting steps relevant to the subcategory
- Suggest posting more details or escalating to @platform-team
`;

const SOURCE_ATTRIBUTION = `
## SOURCE ATTRIBUTION

Always cite which source each piece of information came from:

**Format for citations:**
- Slack thread: "From a similar thread in #help-me-platform (Jan 2026)..."
- HubSpot ticket: "Based on ticket #12345 resolution..."
- KB/Notion: "According to the [Document Name] guide..."

**Example response with attribution:**
> This looks like a shared charger access issue.
>
> *From a similar thread (Jan 15):* The user needed to be added to the shared charger group in Helix.
>
> *Steps from the Shared Charger Setup guide:*
> • Check if user is in the correct parking group
> • Verify subscription status in Ampeco
> • Contact support if billing shows incorrect parking slot
`;

/**
 * Find the injection point in the system prompt
 */
function findInjectionPoint(prompt: string): number {
  // Look for a good spot to inject - after the main instructions
  const markers = [
    "## HOW TO RESPOND",
    "## SEARCH STRATEGY",
    "## KEY VOLTERRA FACTS",
  ];

  for (const marker of markers) {
    const idx = prompt.indexOf(marker);
    if (idx !== -1) {
      return idx;
    }
  }

  // Fallback: inject at the end
  return prompt.length;
}

/**
 * Check if prompt already has these enhancements
 */
function hasEnhancements(prompt: string): boolean {
  return (
    prompt.includes("RESOLUTION-FOCUSED RESPONSES") ||
    prompt.includes("CONFIDENCE HANDLING") ||
    prompt.includes("SOURCE ATTRIBUTION")
  );
}

async function enhanceWorkflow(): Promise<void> {
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

  // 2. Find AI Agent node
  const agentNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  if (!agentNode) {
    throw new Error("AI Agent node not found in workflow");
  }

  const options = agentNode.parameters.options as
    | {
        systemMessage?: string;
      }
    | undefined;

  const currentPrompt = options?.systemMessage || "";

  // 3. Check if already enhanced
  if (hasEnhancements(currentPrompt)) {
    logger.info("Workflow already has resolution/confidence enhancements");
    logger.info("No changes needed.");
    return;
  }

  // 4. Build enhanced prompt
  const injectionPoint = findInjectionPoint(currentPrompt);
  const enhancedPrompt =
    currentPrompt.slice(0, injectionPoint) +
    "\n" +
    RESOLUTION_GUIDANCE +
    "\n" +
    CONFIDENCE_GUIDANCE +
    "\n" +
    SOURCE_ATTRIBUTION +
    "\n" +
    currentPrompt.slice(injectionPoint);

  logger.info(
    `Enhanced prompt: ${currentPrompt.length} → ${enhancedPrompt.length} chars`,
  );

  // 5. Update AI Agent node
  const updatedNodes = workflow.nodes.map((n) => {
    if (n.type === "@n8n/n8n-nodes-langchain.agent") {
      return {
        ...n,
        parameters: {
          ...n.parameters,
          options: {
            ...(n.parameters.options as Record<string, unknown>),
            systemMessage: enhancedPrompt,
          },
        },
      };
    }
    return n;
  });

  // 6. Prepare update payload (only allowed settings)
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

  // 7. Update workflow
  logger.info("Saving enhanced workflow...");

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

  logger.info("Successfully enhanced #help-me-platform support workflow!");
  logger.info("");
  logger.info("Enhancements added:");
  logger.info("  ✅ Resolution-focused response guidance");
  logger.info("  ✅ Confidence-based response handling");
  logger.info("  ✅ Source attribution format");
  logger.info("");
  logger.info("Run verification to confirm:");
  logger.info("  npm run verify:support-workflow");
}

enhanceWorkflow()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Enhancement failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
