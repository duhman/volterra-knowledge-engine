#!/usr/bin/env node
/**
 * HubSpot Ticket Export for LLM RAG
 *
 * Exports HubSpot support tickets from local PostgreSQL database in JSONL format
 * optimized for LLM Retrieval Augmented Generation (RAG) systems.
 *
 * Usage:
 *   npm run export:hubspot -- [options]
 *
 * Options:
 *   -o, --output <path>           Output file path (default: hubspot-tickets-export.jsonl)
 *   --start-date <date>           Start date YYYY-MM-DD (default: 2025-01-01)
 *   --end-date <date>             End date YYYY-MM-DD (default: 2026-02-01)
 *   --batch-size <n>              Conversations per batch (default: 100)
 *   --with-categories-only        Export only tickets with categories
 *   --compress                    Gzip the output file
 *   --dry-run                     Count tickets without exporting
 */

import "dotenv/config";
import { Command } from "commander";
import { Pool } from "pg";
import { createWriteStream, promises as fs } from "fs";
import { createGzip } from "zlib";
import type {
  ExportOptions,
  ConversationRow,
  MessageRow,
  ExportedTicket,
  ExportedMessage,
  CountOptions,
  FetchOptions,
} from "../types/export.types.js";

const program = new Command();

// ============================================================================
// Database Connection
// ============================================================================

function createDatabasePool(): Pool {
  return new Pool({
    host: process.env.LOCAL_DB_HOST || "localhost",
    port: parseInt(process.env.LOCAL_DB_PORT || "5432"),
    database: process.env.LOCAL_DB_NAME || "volterra_kb",
    user: process.env.LOCAL_DB_USER || "local_sync_user",
    password: process.env.LOCAL_DB_PASSWORD || "volterra_kb_sync_2026",
  });
}

// ============================================================================
// Database Queries
// ============================================================================

async function countTickets(
  pool: Pool,
  options: CountOptions,
): Promise<number> {
  const query = `
    SELECT COUNT(*) as count
    FROM volterra_kb.training_conversations
    WHERE create_date >= $1
      AND create_date < $2
      AND ($3::boolean IS NULL OR category IS NOT NULL)
  `;

  const result = await pool.query(query, [
    options.startDate + "T00:00:00+00:00",
    options.endDate + "T00:00:00+00:00",
    options.categoriesOnly ? true : null,
  ]);

  return parseInt(result.rows[0].count, 10);
}

async function fetchConversationsBatch(
  pool: Pool,
  options: FetchOptions,
): Promise<ConversationRow[]> {
  const query = `
    SELECT
      id,
      hubspot_ticket_id,
      subject,
      category,
      subcategory,
      create_date,
      status,
      priority,
      pipeline,
      training_type,
      associated_emails,
      primary_language,
      thread_length,
      participant_count,
      hs_num_times_contacted
    FROM volterra_kb.training_conversations
    WHERE create_date >= $1
      AND create_date < $2
      AND ($3::boolean IS NULL OR category IS NOT NULL)
    ORDER BY create_date DESC
    LIMIT $4 OFFSET $5
  `;

  const result = await pool.query(query, [
    options.startDate + "T00:00:00+00:00",
    options.endDate + "T00:00:00+00:00",
    options.categoriesOnly ? true : null,
    options.limit,
    options.offset,
  ]);

  return result.rows as ConversationRow[];
}

async function fetchMessagesForConversations(
  pool: Pool,
  conversationIds: string[],
): Promise<Map<string, MessageRow[]>> {
  const query = `
    SELECT
      id,
      conversation_id,
      timestamp,
      from_name,
      from_email,
      participant_role,
      direction,
      content,
      subject,
      content_type,
      engagement_type
    FROM volterra_kb.training_messages
    WHERE conversation_id = ANY($1)
    ORDER BY conversation_id, timestamp ASC
  `;

  const result = await pool.query(query, [conversationIds]);
  const messagesMap = new Map<string, MessageRow[]>();

  for (const row of result.rows) {
    const conversationId = row.conversation_id;
    if (!messagesMap.has(conversationId)) {
      messagesMap.set(conversationId, []);
    }
    messagesMap.get(conversationId)!.push(row);
  }

  return messagesMap;
}

// ============================================================================
// Data Transformation
// ============================================================================

function buildConversationText(
  conversation: ConversationRow,
  messages: MessageRow[],
): string {
  let text = `Subject: ${conversation.subject}\n\n`;

  if (conversation.category) {
    text += `Category: ${conversation.category}`;
    if (conversation.subcategory) {
      text += ` > ${conversation.subcategory}`;
    }
    text += "\n\n";
  }

  for (const msg of messages) {
    const role = msg.participant_role || "unknown";
    const name = msg.from_name || msg.from_email;
    text += `[${role.toUpperCase()}] ${name}:\n${msg.content}\n\n---\n\n`;
  }

  return text.trim();
}

function transformToExport(
  conversation: ConversationRow,
  messages: MessageRow[],
): ExportedTicket {
  const exportedMessages: ExportedMessage[] = messages.map((msg) => ({
    id: msg.id,
    timestamp: msg.timestamp,
    from_name: msg.from_name,
    from_email: msg.from_email,
    participant_role: msg.participant_role,
    direction: msg.direction,
    content: msg.content,
    subject: msg.subject,
    content_type: msg.content_type,
    engagement_type: msg.engagement_type,
  }));

  return {
    id: conversation.id,
    hubspot_ticket_id: conversation.hubspot_ticket_id,
    subject: conversation.subject,
    category: conversation.category,
    subcategory: conversation.subcategory,
    create_date: conversation.create_date,
    status: conversation.status,
    priority: conversation.priority,
    pipeline: conversation.pipeline,
    training_type: conversation.training_type,
    associated_emails: conversation.associated_emails,
    primary_language: conversation.primary_language,
    thread_length: conversation.thread_length,
    participant_count: conversation.participant_count,
    hs_num_times_contacted: conversation.hs_num_times_contacted,
    messages: exportedMessages,
    conversation_text: buildConversationText(conversation, messages),
    conversation_summary: null, // Not available in this database
    message_count: messages.length,
    has_embedding: false, // Not available in this database
    export_metadata: {
      exported_at: new Date().toISOString(),
      schema_version: "1.0",
    },
  };
}

// ============================================================================
// Main Export Logic
// ============================================================================

async function exportTickets(options: ExportOptions): Promise<void> {
  const startTime = Date.now();
  const pool = createDatabasePool();

  try {
    console.log("=".repeat(70));
    console.log("HUBSPOT TICKET EXPORT FOR LLM RAG");
    console.log("=".repeat(70));
    console.log("");
    console.log(`Date range: ${options.startDate} to ${options.endDate}`);
    console.log(
      `Categories only: ${options.withCategoriesOnly ? "YES" : "NO"}`,
    );
    console.log(`Output: ${options.output}`);
    console.log(`Compress: ${options.compress ? "YES" : "NO"}`);
    console.log(`Dry run: ${options.dryRun ? "YES" : "NO"}`);
    console.log("");

    // Count total tickets
    console.log("Counting tickets...");
    const totalCount = await countTickets(pool, {
      startDate: options.startDate,
      endDate: options.endDate,
      categoriesOnly: options.withCategoriesOnly,
    });

    console.log(`Found ${totalCount} tickets to export\n`);

    if (totalCount === 0) {
      console.log("No tickets found matching criteria");
      return;
    }

    if (options.dryRun) {
      console.log("Dry run complete - no files written");
      return;
    }

    // Create output stream
    const outputPath = options.compress
      ? `${options.output}.gz`
      : options.output;
    let writeStream = createWriteStream(outputPath);
    if (options.compress) {
      const gzipStream = createGzip();
      gzipStream.pipe(writeStream);
      writeStream = gzipStream as any;
    }

    // Batch export
    let processed = 0;
    let offset = 0;
    const batchSize = options.batchSize;

    while (processed < totalCount) {
      // Fetch conversations batch
      const conversations = await fetchConversationsBatch(pool, {
        startDate: options.startDate,
        endDate: options.endDate,
        categoriesOnly: options.withCategoriesOnly,
        limit: batchSize,
        offset,
      });

      if (conversations.length === 0) {
        break;
      }

      // Fetch messages for batch
      const conversationIds = conversations.map((c) => c.id);
      const messagesMap = await fetchMessagesForConversations(
        pool,
        conversationIds,
      );

      // Transform and write
      for (const conv of conversations) {
        const messages = messagesMap.get(conv.id) || [];
        const exported = transformToExport(conv, messages);
        writeStream.write(JSON.stringify(exported) + "\n");
        processed++;

        if (processed % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const pct = ((processed / totalCount) * 100).toFixed(1);
          console.log(
            `Progress: ${processed}/${totalCount} (${pct}%) - ${elapsed}s`,
          );
        }
      }

      offset += batchSize;
    }

    // Finalize
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      writeStream.end();
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = await fs.stat(outputPath);

    console.log("");
    console.log("=".repeat(70));
    console.log(`Export complete: ${processed} tickets in ${elapsed}s`);
    console.log(`Output: ${outputPath}`);
    console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log("=".repeat(70));
  } catch (error) {
    console.error("Export failed:", error);
    throw error;
  } finally {
    await pool.end();
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

program
  .name("export-hubspot-tickets")
  .description("Export HubSpot tickets from local PostgreSQL for LLM RAG")
  .option(
    "-o, --output <path>",
    "Output file path",
    "hubspot-tickets-export.jsonl",
  )
  .option("--start-date <date>", "Start date (YYYY-MM-DD)", "2025-01-01")
  .option("--end-date <date>", "End date (YYYY-MM-DD)", "2026-02-01")
  .option(
    "--batch-size <n>",
    "Conversations per batch",
    (v) => parseInt(v, 10),
    100,
  )
  .option(
    "--with-categories-only",
    "Export only tickets with categories",
    false,
  )
  .option("--compress", "Gzip the output file", false)
  .option("--dry-run", "Count tickets without exporting", false)
  .action(async (opts) => {
    const options: ExportOptions = {
      output: opts.output,
      startDate: opts.startDate,
      endDate: opts.endDate,
      batchSize: opts.batchSize,
      withCategoriesOnly: opts.withCategoriesOnly,
      compress: opts.compress,
      dryRun: opts.dryRun,
    };

    try {
      await exportTickets(options);
      process.exit(0);
    } catch (error) {
      console.error("Fatal error:", error);
      process.exit(1);
    }
  });

program.parse();
