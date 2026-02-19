#!/usr/bin/env node
/**
 * Import Slack export JSON files directly into slack_messages table
 * Focuses on extracting reaction data for analytics
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "volterra_kb" },
});

interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  username?: string;
  team?: string;
  user_profile?: {
    display_name?: string;
    real_name?: string;
    first_name?: string;
    name?: string;
  };
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
  files?: Array<{ name?: string; title?: string }>;
}

// Subtypes to skip (not real messages)
const SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "pinned_item",
  "unpinned_item",
  "file_comment",
]);

function tsToIso(ts: string): string {
  const [seconds, micros] = ts.split(".");
  const ms = micros ? parseInt(micros.slice(0, 3).padEnd(3, "0")) : 0;
  return new Date(parseInt(seconds) * 1000 + ms).toISOString();
}

function extractMessageText(msg: SlackMessage): string {
  return msg.text?.trim().slice(0, 50000) || "";
}

async function importChannel(
  exportPath: string,
  channelName: string,
  channelId: string,
  dryRun: boolean = false,
): Promise<{
  processed: number;
  inserted: number;
  skipped: number;
  withReactions: number;
}> {
  const channelPath = path.join(exportPath, channelName);

  if (!fs.existsSync(channelPath)) {
    console.error(`Channel folder not found: ${channelPath}`);
    return { processed: 0, inserted: 0, skipped: 0, withReactions: 0 };
  }

  const files = fs
    .readdirSync(channelPath)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`Found ${files.length} JSON files in ${channelName}`);

  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let withReactions = 0;

  for (const file of files) {
    const filePath = path.join(channelPath, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const messages: SlackMessage[] = JSON.parse(content);

    const rows = messages
      .filter((msg) => {
        if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) return false;
        if (msg.type && msg.type !== "message") return false;
        if (!msg.ts) return false;
        return true;
      })
      .map((msg) => {
        const reactionCount =
          msg.reactions?.reduce((sum, r) => sum + r.count, 0) ?? 0;
        if (reactionCount > 0) withReactions++;

        return {
          channel_id: channelId,
          message_ts: msg.ts,
          thread_ts: msg.thread_ts || null,
          user_id: msg.user || null,
          bot_id: msg.bot_id || null,
          subtype: msg.subtype || null,
          text: extractMessageText(msg),
          message_at: tsToIso(msg.ts),
          user_display_name:
            msg.user_profile?.display_name || msg.username || null,
          user_real_name: msg.user_profile?.real_name || null,
          has_files: (msg.files?.length || 0) > 0,
          file_count: msg.files?.length || 0,
          raw: msg,
          // NEW: Reaction data
          reaction_count: reactionCount,
          reactions: msg.reactions ?? [],
        };
      });

    processed += rows.length;

    if (!dryRun && rows.length > 0) {
      const { error, count } = await supabase
        .from("slack_messages")
        .upsert(rows, { onConflict: "channel_id,message_ts", count: "exact" });

      if (error) {
        console.error(`Error inserting from ${file}:`, error.message);
      } else {
        inserted += count || rows.length;
      }
    } else {
      skipped += rows.length;
    }

    // Progress indicator
    if (files.indexOf(file) % 20 === 0) {
      console.log(
        `  Progress: ${files.indexOf(file) + 1}/${files.length} files`,
      );
    }
  }

  return { processed, inserted, skipped, withReactions };
}

async function main() {
  const args = process.argv.slice(2);
  const exportPath = args[0] || "./data/slack-export";
  const channelName = args[1] || "platform-all-deliveries";
  const channelId = args[2] || "YOUR_SLACK_CHANNEL_ID";
  const dryRun = args.includes("--dry-run");

  console.log("=== Slack Reaction Import ===");
  console.log(`Export: ${exportPath}`);
  console.log(`Channel: ${channelName} (${channelId})`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log("");

  const result = await importChannel(
    exportPath,
    channelName,
    channelId,
    dryRun,
  );

  console.log("");
  console.log("=== Results ===");
  console.log(`Messages processed: ${result.processed}`);
  console.log(`Messages with reactions: ${result.withReactions}`);
  console.log(`Messages inserted: ${result.inserted}`);
  console.log(`Messages skipped: ${result.skipped}`);
}

main().catch(console.error);
