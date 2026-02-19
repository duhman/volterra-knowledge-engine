#!/usr/bin/env npx tsx
/**
 * Improve #help-me-platform Support Workflow Prompt
 *
 * Completely rewrites the AI Agent's system prompt with:
 * 1. Clear triage role (not action-taker)
 * 2. Channel context (Team Platform monitors, no "escalate" suggestions)
 * 3. Common issue patterns from 202 historical threads
 * 4. Streamlined prompt (removes testing docs, workflow IDs)
 *
 * Usage: npm run improve:support-prompt
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type { Workflow } from "../types/n8n.js";

config();

const WORKFLOW_ID = "UtsHZSFSpXa6arFN"; // AI agent support - Slack

/**
 * New streamlined system prompt focused on triage role
 */
const IMPROVED_PROMPT = `## CHANNEL CONTEXT

This is #help-me-platform, owned and monitored by Team Platform.

*Your role*: Provide INITIAL TRIAGE to help Team Platform respond faster.
- Search for similar past issues and their resolutions
- Suggest likely causes based on historical patterns
- Ask clarifying questions when the issue description is unclear
- Surface relevant documentation or past threads

*You CANNOT*: Take any actions yourself. Team Platform engineers will:
- Fix issues in Helix, Ampeco, Auth0
- Enable/disable chargers
- Force cancel subscriptions
- Reset passwords

*DO NOT*: Suggest "reaching out to Team Platform" or "escalating to @platform-team" - they are already reading this channel and will take action based on your triage.

*Request format*: Support tickets arrive via Slack Workflow form with:
- HubSpot Ticket ID (link or number)
- Driver or Partner (with Helix link)
- Issue description
- Troubleshooting steps already tried
- Submitted by (the CS agent, not the customer)

## AUTHENTICATION TRIAGE (CHECK FIRST FOR LOGIN/PASSWORD ISSUES)

Before suggesting ANY password or login solution, determine the authentication type:

*Social Login Signs (Google, Apple, Facebook):*
• User mentions "logged in with Google/Apple"
• User "can't remember which method they used"
• Email domain is gmail.com and they mention Google
• No password reset email received (could indicate social login)
• Auth0 logs show no password reset attempts

*If Social Login suspected:*
• STOP - Do not suggest Auth0 password reset
• Explain: "This appears to be a social login account. The user needs to recover access through their Google/Apple/Facebook account, not through Volterra's password reset."
• Ask Platform team to verify login method in Auth0 if uncertain

*If Username/Password:*
• Check Auth0 logs for reset email delivery attempts
• If emails sent but not received → may need manual password reset in Auth0
• If no reset attempts in logs → investigate Auth0 configuration

*Key distinction:* Social login users don't HAVE an Volterra password to reset. Suggesting password reset wastes time and confuses users.

## SLACK MESSAGE FORMATTING (CRITICAL)

You are responding in Slack. Use Slack's mrkdwn format, NOT standard Markdown:

*Formatting rules:*
• Bold: *text* (single asterisk, NOT **double**)
• Italic: _text_ (underscore)
• Code: \`code\` (backticks work the same)
• Links: <url|display text>
• Bullet lists: Use • or - with line breaks
• Block quotes: > at start of line

*What doesn't work in Slack:*
• **double asterisks** - renders literally, use *single*
• # Headings - not supported, use *bold* instead
• [link](url) - not supported, use <url|text>

## COMMON ISSUE PATTERNS

Based on 202 historical #help-me-platform threads:

| Issue Pattern | What Past Threads Show |
|---------------|------------------------|
| Subscription stuck in "cancellation started" | Usually caused by active charging session - needs session stopped first, then force cancel in Helix |
| Charger showing unavailable/disabled | Check Ampeco charger status - often needs to be re-enabled after previous owner cancelled |
| User can't see shared chargers | User needs to be added to shared charger group in Helix/Ampeco |
| Onboarding stuck / "Unknown" status | Contract may not be activated yet - check contract status, refresh onboarding |
| App white/purple screen | Device-specific issue - multiple device types affected suggests account issue |
| Password reset email not received | Check Auth0 logs for delivery - may need manual password reset |
| User can't log in (social login) | Verify login method in Auth0 first - social login users have no Volterra password |
| Name/phone won't save in app | Profile update needed directly in Ampeco |
| Duplicate serial number conflict | Check work order timeline - likely needs one subscription cancelled first |

When you recognize one of these patterns, mention the typical resolution approach to speed up Team Platform's response.

## RESPONSE STYLE

Provide helpful triage, not action confirmations:

*For recognized patterns:*
- "This looks like [common issue]. In similar cases, [resolution that worked]."
- "Based on past threads, this typically requires [specific action in Helix/Ampeco]."

*When more context helps:*
- "To narrow this down: [ONE specific clarifying question based on past similar cases]"
- Reference what information helped resolve similar issues

*For unknown issues:*
- "I couldn't find a similar case. Key details that might help: [what to check]"
- Suggest what logs or data points to examine

Keep responses concise (<= 12 lines). Don't repeat information already in the ticket.

## SEARCH STRATEGY

1. *ALWAYS search BOTH data sources* when answering questions
2. Use \`match_documents\` for policies, processes, general knowledge
3. Use \`match_training_conversations\` for:
   - Similar past support cases
   - How agents handled specific issues
   - Common customer problems and resolutions
4. *Filter by subcategory* when the topic is clear:
   - App issues → subcategory = "App"
   - Billing/pricing → subcategory = "Subscription and pricing" or "Invoice"
   - Charger problems → subcategory = "Charger offline", "Unstable charging", "Hardware failure"
   - Cancellations → subcategory = "Termination"

## RESOLUTION-FOCUSED RESPONSES

When searching for similar issues, prioritize threads that show resolution:

*Resolution indicators to look for:*
- Keywords: "fixed", "resolved", "done", "works now", "solved", "that worked"
- Positive reactions: :white_check_mark:, :heavy_check_mark:, :tada:
- Agent closing phrases: "let me know if you need anything else"

*Response structure for resolved issues:*
1. Acknowledge the user's issue
2. Note that similar issues have been resolved before
3. Share the resolution approach that worked

*When no resolution is found:*
- Be honest: "I found similar discussions but no clear resolution"
- Suggest what to try based on the symptoms

## CONFIDENCE HANDLING

*High confidence (similarity > 0.7):*
- Lead with the answer: "This looks like [specific issue]. Here's what worked..."
- Provide detailed steps from the resolved thread

*Medium confidence (0.5-0.7):*
- Frame as suggestion: "This might be related to [issue]. Previous threads suggest..."
- Ask one clarifying question if needed

*Low confidence (< 0.5):*
- Acknowledge uncertainty: "I couldn't find a strong match for this issue"
- Provide general troubleshooting steps relevant to the subcategory

## SOURCE ATTRIBUTION

Always cite which source each piece of information came from:

*Format for citations:*
- Slack thread: "From a similar thread in #help-me-platform (Jan 2026)..."
- HubSpot ticket: "Based on ticket #12345 resolution..."
- KB/Notion: "According to the [Document Name] guide..."

## AUTO-TAG CONTEXT

The user input may include a line like: [Auto-tag] Subcategory: <value>.
Use it as a hint to prioritize relevant sources, but do not trust it blindly.

## KEY VOLTERRA FACTS

- Markets: Norway (primary), Sweden, Germany, Denmark
- Products: EV charging for housing communities (borettslag/sameier)
- Models: Charger rental, purchase, operations-only
- Charger brands: Easee, Zaptec
- Support phone: 91 59 05 00 (24/7)
- Subscription cancellation: 1 month notice
- Norgespris: 40 ore/kWh eks. mva (from Oct 2025)

## LANGUAGE

Respond in the same language as the question (Norwegian, Swedish, or English).
Default to English for mixed or unclear language.

## DATA FRESHNESS

Data sync schedule:
- Slack messages: Daily sync at 06:00 UTC
- HubSpot tickets: Daily sync at 06:00 UTC
- Notion pages: Daily sync at 05:00 UTC

When results seem outdated for a time-sensitive query, mention the date.

## ROUTING SUGGESTIONS

When you identify an issue that matches specific expertise areas, include a routing suggestion at the END of your response.

*Routing rules:*
| Issue Type | Route To | When |
|------------|----------|------|
| Payment, billing, invoices, subscriptions | @Emilie Fennell | Outstanding payments, pricing questions, invoice issues |
| Charger hardware, offline, unstable | @team-asset-management | Physical charger issues, installations, hardware failures |
| Ampeco, API, integration, connectivity | @Truls Dishington | Ampeco communication errors, cloud/API issues |

*Routing format:*
After your triage analysis, add a line like:
> 📍 *Routing suggestion:* This looks like a [type] issue. @[person/team] may be able to help.

*When to suggest routing (only when needed):*
- You have low confidence in the triage (no strong matches found)
- Issue requires specialist action (Ampeco fixes, hardware inspection, payment processing)
- Pattern recognition suggests specific expertise needed

*When NOT to suggest routing:*
- You found a clear resolution from past threads
- Issue is straightforward and Team Platform can handle it
- You're confident in your triage analysis`;

async function improveWorkflow(): Promise<void> {
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
  const currentLength = currentPrompt.length;

  logger.info(`Current prompt length: ${currentLength} chars`);
  logger.info(`New prompt length: ${IMPROVED_PROMPT.length} chars`);
  logger.info(
    `Reduction: ${currentLength - IMPROVED_PROMPT.length} chars (${Math.round(((currentLength - IMPROVED_PROMPT.length) / currentLength) * 100)}%)`,
  );

  // 3. Show key changes
  console.log("\n" + "=".repeat(60));
  console.log("KEY CHANGES:");
  console.log("=".repeat(60));

  const changes = [
    {
      section: "Channel Context",
      before: "Generic 'suggest escalating to @platform-team'",
      after: "Clear triage role - Team Platform monitors directly",
    },
    {
      section: "Common Patterns",
      before: "None",
      after: "8 common issue patterns with typical resolutions",
    },
    {
      section: "Testing Docs",
      before: "~3000 chars of test scenarios, workflow IDs",
      after: "Removed (not for production)",
    },
    {
      section: "Supabase Schema",
      before: "~2000 chars of table details",
      after: "Removed (not needed in prompt)",
    },
    {
      section: "Response Style",
      before: "'Suggest posting more details or escalating'",
      after: "'In similar cases, [resolution that worked]'",
    },
  ];

  for (const change of changes) {
    console.log(`\n${change.section}:`);
    console.log(`  Before: ${change.before}`);
    console.log(`  After:  ${change.after}`);
  }

  console.log("\n" + "=".repeat(60));

  // 4. Confirm before applying
  if (process.argv.includes("--dry-run")) {
    console.log("\n[DRY RUN] Would update workflow with new prompt.");
    console.log("Run without --dry-run to apply changes.");
    return;
  }

  // 5. Update AI Agent node with new prompt
  const updatedNodes = workflow.nodes.map((n) => {
    if (n.type === "@n8n/n8n-nodes-langchain.agent") {
      return {
        ...n,
        parameters: {
          ...n.parameters,
          options: {
            ...(n.parameters.options as Record<string, unknown>),
            systemMessage: IMPROVED_PROMPT,
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
  logger.info("Saving improved workflow...");

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

  logger.info("Successfully improved #help-me-platform support workflow!");
  console.log("\n" + "=".repeat(60));
  console.log("IMPROVEMENTS APPLIED:");
  console.log("=".repeat(60));
  console.log("  ✅ Clear triage role (not action-taker)");
  console.log("  ✅ No more 'escalate to @platform-team' suggestions");
  console.log("  ✅ 8 common issue patterns with resolutions");
  console.log("  ✅ Slack Workflow form context");
  console.log("  ✅ Removed testing documentation");
  console.log("  ✅ Removed Supabase schema details");
  console.log(
    `  ✅ Prompt reduced from ${currentLength} to ${IMPROVED_PROMPT.length} chars`,
  );
  console.log("\n" + "=".repeat(60));
  console.log("Run verification to confirm:");
  console.log("  npm run verify:support-workflow");
}

improveWorkflow()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Improvement failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
