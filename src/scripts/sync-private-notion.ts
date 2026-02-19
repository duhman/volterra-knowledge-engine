#!/usr/bin/env node
/**
 * Backfill script for syncing private Notion pages to private_kb schema
 *
 * This script:
 * 1. Fetches list of private databases from the registry
 * 2. Uses Notion Search API to find all accessible pages
 * 3. Filters to pages belonging to private databases
 * 4. Extracts content and generates embeddings
 * 5. Upserts to private_kb.documents
 *
 * Usage:
 *   npm run sync:private
 *   npm run sync:private -- --limit 10 --dry-run
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true }); // Override shell env vars with .env values
import { Command } from "commander";
import { Client } from "@notionhq/client";
import type {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { createHash } from "crypto";

// ============================================================================
// TYPES
// ============================================================================

interface PrivateDatabase {
  notion_database_id: string;
  name: string;
  database_type: string;
  target_schema: string;
}

interface ProcessedPage {
  id: string;
  title: string;
  content: string;
  contentHash: string;
  databaseId: string | null;
  url: string;
  createdTime: string;
  lastEditedTime: string;
}

interface SyncStats {
  pagesFound: number;
  pagesProcessed: number;
  pagesCreated: number;
  pagesUpdated: number;
  pagesSkipped: number;
  errors: Array<{ pageId: string; error: string }>;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const MAX_CONTENT_LENGTH = 10000; // ~7500 tokens for embedding

// ============================================================================
// CLIENTS
// ============================================================================

function createNotionClient(): Client {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    throw new Error("NOTION_API_KEY environment variable is required");
  }
  return new Client({ auth: apiKey });
}

function createSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: "public", // Default schema; we'll switch per-operation
    },
  });
}

function createOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }
  return new OpenAI({ apiKey });
}

// ============================================================================
// NOTION HELPERS
// ============================================================================

/**
 * Extract plain text from rich text array
 */
function extractPlainText(richText: RichTextItemResponse[]): string {
  return richText.map((rt) => rt.plain_text).join("");
}

/**
 * Extract title from page properties
 */
function extractPageTitle(page: PageObjectResponse): string {
  const props = page.properties;

  // Try common title property names
  for (const key of ["title", "Title", "Name", "name"]) {
    const prop = props[key];
    if (prop?.type === "title" && prop.title) {
      const title = extractPlainText(prop.title);
      if (title) return title;
    }
  }

  // Fallback: find any title-type property
  for (const prop of Object.values(props)) {
    if (prop.type === "title" && prop.title) {
      const title = extractPlainText(prop.title);
      if (title) return title;
    }
  }

  return "Untitled";
}

/**
 * Extract text content from a block
 */
function extractBlockText(block: BlockObjectResponse): string {
  const parts: string[] = [];

  switch (block.type) {
    case "paragraph":
      parts.push(extractPlainText(block.paragraph.rich_text));
      break;
    case "heading_1":
      parts.push(`# ${extractPlainText(block.heading_1.rich_text)}`);
      break;
    case "heading_2":
      parts.push(`## ${extractPlainText(block.heading_2.rich_text)}`);
      break;
    case "heading_3":
      parts.push(`### ${extractPlainText(block.heading_3.rich_text)}`);
      break;
    case "bulleted_list_item":
      parts.push(`• ${extractPlainText(block.bulleted_list_item.rich_text)}`);
      break;
    case "numbered_list_item":
      parts.push(`- ${extractPlainText(block.numbered_list_item.rich_text)}`);
      break;
    case "to_do":
      const checkbox = block.to_do.checked ? "[x]" : "[ ]";
      parts.push(`${checkbox} ${extractPlainText(block.to_do.rich_text)}`);
      break;
    case "toggle":
      parts.push(`▸ ${extractPlainText(block.toggle.rich_text)}`);
      break;
    case "quote":
      parts.push(`> ${extractPlainText(block.quote.rich_text)}`);
      break;
    case "callout":
      parts.push(`📌 ${extractPlainText(block.callout.rich_text)}`);
      break;
    case "code":
      const lang = block.code.language || "";
      const code = extractPlainText(block.code.rich_text);
      parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
      break;
    case "divider":
      parts.push("---");
      break;
    case "table_row":
      parts.push(
        block.table_row.cells.map((cell) => extractPlainText(cell)).join(" | "),
      );
      break;
  }

  return parts.join("\n");
}

/**
 * Fetch all blocks from a page and extract text content
 */
async function fetchPageContent(
  notion: Client,
  pageId: string,
): Promise<string> {
  const blocks: string[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      if ("type" in block) {
        const text = extractBlockText(block as BlockObjectResponse);
        if (text) blocks.push(text);

        // Recursively fetch children if block has them
        if (block.has_children) {
          try {
            const childContent = await fetchPageContent(notion, block.id);
            if (childContent) blocks.push(childContent);
          } catch {
            // Skip if we can't access children
          }
        }
      }
    }

    cursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (cursor);

  return blocks.join("\n\n");
}

/**
 * Get database ID from page parent
 */
function getDatabaseId(page: PageObjectResponse): string | null {
  if (page.parent.type === "database_id") {
    return page.parent.database_id.replace(/-/g, "");
  }
  return null;
}

// ============================================================================
// EMBEDDING HELPERS
// ============================================================================

/**
 * Generate embedding for text content
 */
async function generateEmbedding(
  openai: OpenAI,
  text: string,
): Promise<number[]> {
  // Truncate if too long
  const truncated =
    text.length > MAX_CONTENT_LENGTH ? text.slice(0, MAX_CONTENT_LENGTH) : text;

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: truncated,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data[0].embedding;
}

/**
 * Generate content hash for deduplication
 */
function generateContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

/**
 * Fetch list of private databases from registry
 * Uses public wrapper function (since volterra_kb isn't exposed via PostgREST)
 */
async function fetchPrivateDatabases(
  _supabase: SupabaseClient,
): Promise<PrivateDatabase[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Uses public.get_private_databases wrapper function
  const response = await fetch(`${url}/rest/v1/rpc/get_private_databases`, {
    method: "POST",
    headers: {
      apikey: key!,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch private databases: ${text}`);
  }

  return (await response.json()) as PrivateDatabase[];
}

/**
 * Check if a document already exists with same content hash
 * Uses public.private_kb_document_exists RPC wrapper
 */
async function documentExistsByHash(
  _supabase: SupabaseClient,
  contentHash: string,
): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${url}/rest/v1/rpc/private_kb_document_exists`,
    {
      method: "POST",
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_content_hash: contentHash }),
    },
  );

  if (!response.ok) {
    console.warn(`Warning: Error checking document existence`);
    return false;
  }

  const exists = (await response.json()) as boolean;
  return exists;
}

/**
 * Upsert a document to private_kb.documents
 * Uses public.private_kb_upsert_document RPC wrapper
 */
async function upsertDocument(
  _supabase: SupabaseClient,
  page: ProcessedPage,
  embedding: number[],
): Promise<{ created: boolean }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const normalizedId = page.id.replace(/-/g, "");
  const sourcePath = `notion://page/${normalizedId}`;
  const embeddingString = `[${embedding.join(",")}]`;

  const response = await fetch(
    `${url}/rest/v1/rpc/private_kb_upsert_document`,
    {
      method: "POST",
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_content: page.content,
        p_embedding: embeddingString,
        p_title: page.title,
        p_document_type: "Meeting Transcript",
        p_source_type: "notion",
        p_source_path: sourcePath,
        p_notion_page_id: normalizedId,
        p_notion_database_id: page.databaseId,
        p_tags: ["notion", "private", "meeting"],
        p_content_hash: page.contentHash,
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upsert failed: ${errorText}`);
  }

  const result = (await response.json()) as Array<{
    id: string;
    created: boolean;
  }>;
  return { created: result[0]?.created ?? true };
}

/**
 * Update sync state
 * Uses public.private_kb_update_sync_state RPC wrapper
 */
async function updateSyncState(
  _supabase: SupabaseClient,
  stats: SyncStats,
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const lastError =
    stats.errors.length > 0
      ? stats.errors.map((e) => `${e.pageId}: ${e.error}`).join("; ")
      : null;

  const response = await fetch(
    `${url}/rest/v1/rpc/private_kb_update_sync_state`,
    {
      method: "POST",
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_pages_processed: stats.pagesProcessed,
        p_pages_created: stats.pagesCreated,
        p_pages_updated: stats.pagesUpdated,
        p_last_error: lastError,
      }),
    },
  );

  if (!response.ok) {
    console.warn(`Warning: Failed to update sync state`);
  }
}

// ============================================================================
// MAIN SYNC LOGIC
// ============================================================================

async function syncPrivatePages(options: {
  limit?: number;
  dryRun?: boolean;
  verbose?: boolean;
}): Promise<SyncStats> {
  const { limit, dryRun = false, verbose = false } = options;

  console.log("🔐 Starting private Notion sync...\n");

  // Initialize clients
  const notion = createNotionClient();
  const supabase = createSupabaseClient();
  const openai = createOpenAIClient();

  // Fetch private database IDs
  console.log("📚 Fetching private database registry...");
  const privateDatabases = await fetchPrivateDatabases(supabase);

  if (privateDatabases.length === 0) {
    console.log("⚠️  No private databases registered. Nothing to sync.");
    return {
      pagesFound: 0,
      pagesProcessed: 0,
      pagesCreated: 0,
      pagesUpdated: 0,
      pagesSkipped: 0,
      errors: [],
    };
  }

  console.log(`   Found ${privateDatabases.length} private database(s):`);
  for (const db of privateDatabases) {
    console.log(`   • ${db.name} (${db.notion_database_id})`);
  }
  console.log();

  // Query pages directly from each private database
  // (Search API doesn't reliably return pages from all databases)
  console.log("🔍 Querying private databases directly...");
  const privatePages: PageObjectResponse[] = [];

  for (const db of privateDatabases) {
    const dbId = db.notion_database_id;
    console.log(`   Querying: ${db.name}...`);

    let cursor: string | undefined;
    let dbPageCount = 0;

    do {
      try {
        // Use raw fetch since notion.databases.query doesn't exist in this SDK version
        const queryBody: Record<string, unknown> = { page_size: 100 };
        if (cursor) queryBody.start_cursor = cursor;

        const response = await fetch(
          `https://api.notion.com/v1/databases/${dbId}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(queryBody),
          },
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = (await response.json()) as {
          results: PageObjectResponse[];
          has_more: boolean;
          next_cursor: string | null;
        };

        for (const result of data.results) {
          if (result.object === "page" && "properties" in result) {
            privatePages.push(result);
            dbPageCount++;
          }
        }

        cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;

        // Respect limit if set
        if (limit && privatePages.length >= limit) {
          privatePages.splice(limit);
          cursor = undefined;
          break;
        }
      } catch (err) {
        console.log(`   ⚠️  Error querying ${db.name}: ${err}`);
        break;
      }
    } while (cursor);

    console.log(`   Found ${dbPageCount} pages in ${db.name}`);
  }

  console.log(
    `\n📄 Total: ${privatePages.length} pages in private databases\n`,
  );

  if (privatePages.length === 0) {
    console.log("⚠️  No pages found in private databases.");
    console.log("   Make sure your integration has access to the pages.");
    return {
      pagesFound: 0,
      pagesProcessed: 0,
      pagesCreated: 0,
      pagesUpdated: 0,
      pagesSkipped: 0,
      errors: [],
    };
  }

  // Process pages
  const stats: SyncStats = {
    pagesFound: privatePages.length,
    pagesProcessed: 0,
    pagesCreated: 0,
    pagesUpdated: 0,
    pagesSkipped: 0,
    errors: [],
  };

  for (let i = 0; i < privatePages.length; i++) {
    const page = privatePages[i];
    const title = extractPageTitle(page);
    const progress = `[${i + 1}/${privatePages.length}]`;

    process.stdout.write(
      `\r${progress} Processing: ${title.slice(0, 50).padEnd(50)}...`,
    );

    try {
      // Fetch page content
      const content = await fetchPageContent(notion, page.id);

      if (!content || content.length < 10) {
        if (verbose)
          console.log(`\n   ⚠️  Skipping "${title}" - insufficient content`);
        stats.pagesSkipped++;
        continue;
      }

      const contentHash = generateContentHash(content);

      // Check if already exists with same content
      const exists = await documentExistsByHash(supabase, contentHash);
      if (exists) {
        if (verbose) console.log(`\n   ⏭️  Skipping "${title}" - unchanged`);
        stats.pagesSkipped++;
        continue;
      }

      if (dryRun) {
        console.log(`\n   🔍 [DRY RUN] Would process: ${title}`);
        stats.pagesProcessed++;
        continue;
      }

      // Generate embedding
      const embedding = await generateEmbedding(
        openai,
        `${title}\n\n${content}`,
      );

      // Upsert to database
      const processedPage: ProcessedPage = {
        id: page.id,
        title,
        content,
        contentHash,
        databaseId: getDatabaseId(page),
        url: page.url,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
      };

      const { created } = await upsertDocument(
        supabase,
        processedPage,
        embedding,
      );

      if (created) {
        stats.pagesCreated++;
      } else {
        stats.pagesUpdated++;
      }
      stats.pagesProcessed++;

      // Rate limiting
      if (i < privatePages.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push({ pageId: page.id, error: message });
      if (verbose) console.log(`\n   ❌ Error: ${message}`);
    }
  }

  console.log("\n");

  // Update sync state
  if (!dryRun) {
    await updateSyncState(supabase, stats);
  }

  return stats;
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name("sync-private-notion")
  .description("Sync private Notion pages to private_kb schema")
  .option("-l, --limit <n>", "Maximum number of pages to process", parseInt)
  .option("-d, --dry-run", "Validate without inserting into database")
  .option("-v, --verbose", "Show detailed progress")
  .action(async (opts) => {
    try {
      const stats = await syncPrivatePages({
        limit: opts.limit,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      });

      console.log("═══════════════════════════════════════════");
      console.log("           SYNC SUMMARY                    ");
      console.log("═══════════════════════════════════════════");
      console.log(`  Pages found:     ${stats.pagesFound}`);
      console.log(`  Pages processed: ${stats.pagesProcessed}`);
      console.log(`  Pages created:   ${stats.pagesCreated}`);
      console.log(`  Pages updated:   ${stats.pagesUpdated}`);
      console.log(`  Pages skipped:   ${stats.pagesSkipped}`);
      console.log(`  Errors:          ${stats.errors.length}`);
      console.log("═══════════════════════════════════════════");

      if (stats.errors.length > 0) {
        console.log("\n❌ Errors:");
        for (const err of stats.errors.slice(0, 10)) {
          console.log(`   • ${err.pageId}: ${err.error}`);
        }
        if (stats.errors.length > 10) {
          console.log(`   ... and ${stats.errors.length - 10} more`);
        }
      }

      if (opts.dryRun) {
        console.log("\n📝 This was a dry run. No changes were made.");
      } else if (stats.pagesCreated > 0 || stats.pagesUpdated > 0) {
        console.log(
          "\n✅ Sync complete! Pages are now searchable via private_kb_search.",
        );
      }

      process.exit(stats.errors.length > 0 ? 1 : 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n❌ Fatal error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
