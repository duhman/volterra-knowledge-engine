#!/usr/bin/env node
/**
 * Sync training_messages content from Cloud Supabase to local PostgreSQL
 *
 * This script fetches message content from Cloud Supabase and updates
 * the local PostgreSQL database with the full message bodies.
 *
 * Usage:
 *   npm run sync:training-content -- [options]
 *
 * Options:
 *   --batch-size <n>    Messages per batch (default: 500)
 *   --limit <n>         Max total messages to sync (default: all)
 *   --dry-run           Count messages without syncing
 */

import "dotenv/config";
import { Command } from "commander";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

const program = new Command();

// ============================================================================
// Database Connections
// ============================================================================

function createCloudClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, key, {
    db: { schema: "volterra_kb" },
  });
}

function createLocalPool() {
  return new Pool({
    host: process.env.LOCAL_DB_HOST || "localhost",
    port: parseInt(process.env.LOCAL_DB_PORT || "5432"),
    database: process.env.LOCAL_DB_NAME || "volterra_kb",
    user: process.env.LOCAL_DB_USER || "local_sync_user",
    password: process.env.LOCAL_DB_PASSWORD || "volterra_kb_sync_2026",
  });
}

// ============================================================================
// Sync Logic
// ============================================================================

interface CloudMessage {
  id: string;
  conversation_id: string;
  content: string | null;
}

async function fetchCloudMessages(
  supabase: ReturnType<typeof createCloudClient>,
  offset: number,
  limit: number,
): Promise<CloudMessage[]> {
  const { data, error } = await supabase
    .from("training_messages")
    .select("id, conversation_id, content")
    .range(offset, offset + limit - 1)
    .order("timestamp", { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch from Cloud: ${error.message}`);
  }

  return data as CloudMessage[];
}

async function updateLocalMessage(
  pool: Pool,
  id: string,
  content: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE volterra_kb.training_messages SET content = $1 WHERE id = $2`,
    [content, id],
  );
}

async function countCloudMessages(
  supabase: ReturnType<typeof createCloudClient>,
): Promise<number> {
  const { count, error } = await supabase
    .from("training_messages")
    .select("id", { count: "exact", head: true });

  if (error) {
    throw new Error(`Failed to count Cloud messages: ${error.message}`);
  }

  return count || 0;
}

async function syncMessages(options: {
  batchSize: number;
  limit?: number;
  dryRun: boolean;
}): Promise<void> {
  const startTime = Date.now();
  const cloud = createCloudClient();
  const local = createLocalPool();

  try {
    console.log("=".repeat(70));
    console.log("SYNC TRAINING MESSAGES CONTENT: CLOUD → LOCAL");
    console.log("=".repeat(70));
    console.log("");
    console.log(`Batch size: ${options.batchSize}`);
    console.log(`Limit: ${options.limit || "all"}`);
    console.log(`Dry run: ${options.dryRun ? "YES" : "NO"}`);
    console.log("");

    // Count total messages
    console.log("Counting Cloud messages...");
    const totalCount = await countCloudMessages(cloud);
    const targetCount = options.limit
      ? Math.min(totalCount, options.limit)
      : totalCount;

    console.log(`Found ${totalCount} messages in Cloud`);
    console.log(`Will sync ${targetCount} messages\n`);

    if (targetCount === 0) {
      console.log("No messages to sync");
      return;
    }

    if (options.dryRun) {
      console.log("Dry run complete - no changes made");
      return;
    }

    // Batch sync
    let processed = 0;
    let updated = 0;
    let offset = 0;

    while (processed < targetCount) {
      const batchSize = Math.min(options.batchSize, targetCount - processed);

      // Fetch batch from Cloud
      const messages = await fetchCloudMessages(cloud, offset, batchSize);

      if (messages.length === 0) {
        break;
      }

      // Update local database
      for (const msg of messages) {
        if (msg.content) {
          await updateLocalMessage(local, msg.id, msg.content);
          updated++;
        }
        processed++;

        if (processed % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const pct = ((processed / targetCount) * 100).toFixed(1);
          console.log(
            `Progress: ${processed}/${targetCount} (${pct}%) - Updated: ${updated} - ${elapsed}s`,
          );
        }
      }

      offset += batchSize;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("");
    console.log("=".repeat(70));
    console.log(
      `Sync complete: ${processed} processed, ${updated} updated in ${elapsed}s`,
    );
    console.log("=".repeat(70));
  } catch (error) {
    console.error("Sync failed:", error);
    throw error;
  } finally {
    await local.end();
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

program
  .name("sync-training-content")
  .description("Sync training_messages content from Cloud to local PostgreSQL")
  .option("--batch-size <n>", "Messages per batch", (v) => parseInt(v, 10), 500)
  .option("--limit <n>", "Max messages to sync", (v) => parseInt(v, 10))
  .option("--dry-run", "Count without syncing", false)
  .action(async (opts) => {
    try {
      await syncMessages({
        batchSize: opts.batchSize,
        limit: opts.limit,
        dryRun: opts.dryRun,
      });
      process.exit(0);
    } catch (error) {
      console.error("Fatal error:", error);
      process.exit(1);
    }
  });

program.parse();
