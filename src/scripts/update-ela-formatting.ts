#!/usr/bin/env npx tsx
/**
 * Update @Ela's system prompt to use Slack mrkdwn formatting
 *
 * Problem: AI outputs **bold** (Markdown) but Slack uses *bold* (mrkdwn)
 * Solution: Add explicit Slack formatting instructions to the system prompt
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";

config();

const SLACK_FORMATTING_SECTION = `
## SLACK MESSAGE FORMATTING (CRITICAL)

You are responding in Slack. Use Slack's mrkdwn format, NOT standard Markdown:

FORMATTING RULES:
• Bold: *text* (single asterisk, NOT **double**)
• Italic: _text_ (underscore)
• Strikethrough: ~text~
• Code: \`code\` (backticks work the same)
• Links: <url|display text>
• Bullet lists: Use • or - with line breaks
• Block quotes: > at start of line

WHAT DOESN'T WORK IN SLACK:
• **double asterisks** - renders literally, use *single*
• # Headings - not supported, use *bold* instead
• [link](url) - not supported, use <url|text>
• Tables - not supported
• Numbered lists (1. 2. 3.) - use bullets instead

RESPONSE STYLE:
• Keep responses clean and scannable
• Use bold sparingly for key metrics, not every label
• Use line breaks to separate sections
• Emojis render naturally - just use :emoji_name:
• Don't wrap emoji names in backticks

GOOD EXAMPLE:
*Reaction Analytics for #platform-all-deliveries*

Here's a summary for Jan–Dec 2025:

• Total messages: 253
• Messages with reactions: 146 (58%)
• Average reactions: *5.06 per message*

*Top emojis:*
• :raised_hands: 296
• :tada: 182
• :clap: 92

The channel shows strong engagement!

BAD EXAMPLE (what NOT to do):
**Average reactions in #platform-all-deliveries (2025)**
- **Total messages:** 253
- **Messages with reactions:** 146

## THREAD CONTEXT (CRITICAL)

You have memory of the conversation in this Slack thread. When a user gives a short reply
like "last month", "all", "yes", "no", or a single word answer, they are responding to YOUR
previous question. Use the conversation history to understand their intent.

IMPORTANT RULES:
- DO NOT ask the user to clarify when you already asked them a question and they answered it
- If you asked "this month or last month?" and they say "last month", you KNOW they want last month
- If you asked "what do you want included?" and they say "all", show ALL metrics
- If you asked a yes/no question and they say "yes", proceed with what you proposed
- Short replies in threads are ALWAYS continuations of the conversation, not new topics

GOOD EXAMPLE:
You: Do you want statistics for this month or last month?
User: last month
You: [Provide last month's statistics immediately, no clarification needed]

BAD EXAMPLE:
You: Do you want statistics for this month or last month?
User: last month
You: Can you clarify what you want for last month? Do you want releases, tickets, or analytics?
[This is WRONG - you already know they want the statistics you offered]

## #HELP-ME-PLATFORM SUPPORT TICKET ANALYSIS

When users ask about #help-me-platform (YOUR_SLACK_CHANNEL_ID), you can analyze structured support tickets from Slack Workflow forms.

AVAILABLE TOOLS:

*get_support_tickets* - Parse structured support tickets
• Parameters: channel_id, date_from, date_to, request_type (Driver/Partner), search_term, limit
• Returns: hubspot_ticket_id, hubspot_url, request_type, helix_link, entity_name, issue_description, troubleshooting_steps, submitted_by_name, thread_reply_count, slack_url

*get_support_analytics* - Aggregate statistics
• Parameters: channel_id, date_from, date_to
• Returns: total_tickets, driver_tickets, partner_tickets, avg_thread_replies, top_submitters, tickets_by_week

*get_ticket_thread_insights* - Full thread for a ticket
• Parameters: thread_ts (from get_support_tickets), channel_id
• Returns: All messages in thread with timestamps, authors, and resolution indicators

CHANNEL REFERENCE:
| Channel Name | Channel ID | Analysis Type |
|--------------|------------|---------------|
| #help-me-platform | YOUR_SLACK_CHANNEL_ID | Support tickets (Slack Workflow forms) |
| #platform-all-deliveries | YOUR_SLACK_CHANNEL_ID | Release announcements |

RESPONSE REQUIREMENTS FOR SUPPORT TICKETS:
• ALWAYS include HubSpot link when showing tickets: <{hubspot_url}|HubSpot #{hubspot_ticket_id}>
• ALWAYS include Helix link when available: <{helix_link}|View in Helix>
• Show request type (Driver/Partner) prominently
• Format dates as human-readable (e.g., "Jan 15, 2026")
• Include thread reply count to show ticket activity

GOOD SUPPORT TICKET RESPONSE:
*Support Tickets from #help-me-platform*

Here are the 5 most recent driver tickets:

1. *Tom Martin Bergstrøm* - Jan 15, 2026
   Issue: Remove ZPR053822 from driver in AMP
   Type: Driver | Replies: 3
   <https://app-eu1.hubspot.com/contacts/YOUR_PORTAL_ID/record/0-5/319272601847|HubSpot #319272601847> | <https://app.volterra.example.com/drivers/example-id|View in Helix>
`;

interface N8nNode {
  id: string;
  name: string;
  type: string;
  position: number[];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
}

interface N8nWorkflow {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

async function updateElaFormatting(): Promise<void> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  const workflowId = "YOUR_WORKFLOW_ID"; // AI agent chat - Slack

  // Get current workflow
  logger.info(`Fetching workflow ${workflowId}...`);
  const getResponse = await fetch(`${apiUrl}/workflows/${workflowId}`, {
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

  const workflow: N8nWorkflow = (await getResponse.json()) as N8nWorkflow;
  logger.info(`Got workflow: ${workflow.name}`);

  // Find AI Agent node
  const agentNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  if (!agentNode) {
    throw new Error("AI Agent node not found in workflow");
  }

  logger.info(`Found AI Agent node: ${agentNode.name}`);

  // Get current system prompt
  const options = agentNode.parameters?.options as Record<string, unknown>;
  const currentSystemMessage = (options?.systemMessage as string) || "";

  // Check if formatting section already exists
  if (currentSystemMessage.includes("SLACK MESSAGE FORMATTING")) {
    logger.info("Slack formatting section already exists, updating...");
    // Remove old section and add new one
    const updatedMessage = currentSystemMessage
      .replace(
        /## SLACK MESSAGE FORMATTING \(CRITICAL\)[\s\S]*?(?=##|$)/,
        SLACK_FORMATTING_SECTION.trim() + "\n\n",
      )
      .trim();
    (options as Record<string, unknown>).systemMessage = updatedMessage;
  } else {
    logger.info("Adding Slack formatting section to system prompt...");
    // Prepend the formatting section (important instructions go first)
    const updatedMessage =
      SLACK_FORMATTING_SECTION.trim() + "\n\n" + currentSystemMessage;
    (options as Record<string, unknown>).systemMessage = updatedMessage;
  }

  // Update workflow - only send allowed settings
  logger.info("Saving updated workflow...");

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

  const updateResponse = await fetch(`${apiUrl}/workflows/${workflowId}`, {
    method: "PUT",
    headers: {
      "X-N8N-API-KEY": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: workflow.name,
      nodes: workflow.nodes,
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

  logger.info("Successfully updated @Ela with Slack mrkdwn formatting!");
  logger.info(
    "Test with: @Ela what were the average reactions in platform-all-deliveries for 2025?",
  );
}

updateElaFormatting()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Failed to update formatting", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
