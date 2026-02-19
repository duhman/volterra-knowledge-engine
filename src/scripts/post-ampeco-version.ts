#!/usr/bin/env node
/**
 * Post a specific Ampeco changelog version to Slack
 * Usage: npm run ampeco:post -- --version 31280
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.AMPECO_SLACK_CHANNEL_ID || "C069JNXNYGG";
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface VersionData {
  version: string;
  title: string;
  author: string;
  publishedAt: string;
  features: string[];
  improvements: string[];
}

// Format item with code highlighting for API terms
function formatItem(text: string): string {
  return text
    .replace(
      /\b([a-z][a-zA-Z0-9_]*(?:Id|Type|Key|Token|Name|Status|Config|Data|Info|Property|Endpoint|Resource|Request|Response|Enabled))\b/g,
      "`$1`",
    )
    .replace(/`([^`]+)`/g, "`$1`") // Keep existing backticks
    .replace(/\/[a-z0-9\-\/\.\{\}]+/gi, "`$&`") // API paths
    .replace(/\b(true|false|null)\b/g, "`$1`")
    .replace(/\bv\d+\.\d+\b/g, "`$&`"); // Version numbers like v1.1
}

function buildSlackBlocks(data: VersionData) {
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🚀 Ampeco API Update", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${data.title}*\n📅 ${data.publishedAt}  •  👤 by ${data.author}`,
      },
    },
    { type: "divider" },
  ];

  // Add features section
  if (data.features.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*✨ New Features*" },
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "• " + data.features.map(formatItem).join("\n\n• "),
      },
    });
    blocks.push({ type: "divider" });
  }

  // Add improvements section
  if (data.improvements.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*🔧 Improvements*" },
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "• " + data.improvements.map(formatItem).join("\n\n• "),
      },
    });
    blocks.push({ type: "divider" });
  }

  // Add action buttons
  const detailUrl = `https://developers.ampeco.com/changelog/release-notes-public-api-of-ampeco-charge-${data.version}`;
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "📖 View Full Release Notes",
          emoji: true,
        },
        url: detailUrl,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "📚 API Documentation", emoji: true },
        url: "https://developers.ampeco.com/",
      },
    ],
  });

  // Add footer
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `🔔 Version: \`v3.${data.version}\` | 🤖 Auto-posted by Ampeco Monitor (n8n)`,
      },
    ],
  });

  return blocks;
}

async function postToSlack(data: VersionData): Promise<void> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN not set");
  }

  const blocks = buildSlackBlocks(data);
  const fallbackText = `🚀 Ampeco API Update: ${data.title}`;

  console.log("Posting to Slack channel:", SLACK_CHANNEL_ID);

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text: fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error}`);
  }

  console.log("Posted successfully! Message ts:", result.ts);
  return result;
}

async function updateState(version: string): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Update state table
  const { error: stateError } = await supabase
    .from("ampeco_changelog_state")
    .update({
      last_seen_version: version,
      last_notified_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (stateError) {
    throw new Error(`Failed to update state: ${stateError.message}`);
  }

  // Record notification
  const { error: notifError } = await supabase
    .from("ampeco_changelog_notifications")
    .insert({
      version,
      slack_response: { manual: true, posted_at: new Date().toISOString() },
    });

  if (notifError) {
    console.warn("Warning: Failed to record notification:", notifError.message);
  }

  console.log(`State updated to version: ${version}`);
}

async function main() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : null;

  if (!version) {
    console.error("Usage: npm run ampeco:post -- --version 31280");
    process.exit(1);
  }

  // v3.128.0 data (hardcoded for this specific post)
  const versionData: Record<string, VersionData> = {
    "31280": {
      version: "31280",
      title: "Release Notes: Public API of AMPECO Charge 3.128.0",
      author: "Valentin Alexiev",
      publishedAt: "5 days ago",
      features: [
        "Add new optional query parameter `cursor` to Payment Terminals v1.1 and Templates v1.0 endpoints for cursor-based pagination",
        "Add support for Cursor Pagination as an alternative to Basic Pagination in the `meta` response property",
        "Add new endpoint GET `/public-api/resources/payment-terminals/v1.1/{paymentTerminal}` for retrieving individual payment terminal details",
      ],
      improvements: [
        "Make `links/first` response property optional and nullable in Payment Terminals v1.1 and Templates v1.0 endpoints",
        "Remove optional pagination properties from 200 responses in Payment Terminals and Templates endpoints",
        "Deprecate Payment Terminals v1.0 endpoints in favor of v1.1",
      ],
    },
  };

  const data = versionData[version];
  if (!data) {
    console.error(`No data available for version ${version}`);
    console.error("Available versions:", Object.keys(versionData).join(", "));
    process.exit(1);
  }

  console.log(`\n=== Posting Ampeco v3.${version} to Slack ===\n`);
  console.log(`Title: ${data.title}`);
  console.log(`Author: ${data.author}`);
  console.log(`Features: ${data.features.length}`);
  console.log(`Improvements: ${data.improvements.length}`);
  console.log();

  const dryRun = args.includes("--dry-run");

  if (dryRun) {
    console.log("DRY RUN - Would post these blocks:");
    console.log(JSON.stringify(buildSlackBlocks(data), null, 2));
    return;
  }

  await postToSlack(data);
  await updateState(version);

  console.log("\n=== Done ===");
  console.log(
    "The n8n workflow will detect v3.130.0 on the next scheduled run (12:00 UTC daily).",
  );
  console.log("Or trigger manually in n8n to post v3.130.0 now.");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
