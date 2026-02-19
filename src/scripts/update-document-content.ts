#!/usr/bin/env node
/**
 * Update a document in private_kb.documents with new content
 * Used to update meeting transcriptions from MCP-fetched content
 *
 * Usage:
 *   npx tsx src/scripts/update-document-content.ts --id <notion_page_id> --content-file <path>
 *   echo "content" | npx tsx src/scripts/update-document-content.ts --id <notion_page_id> --stdin
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

import { Command } from "commander";
// Supabase client not used - script uses direct fetch to REST API
import OpenAI from "openai";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";

// ============================================================================
// CONFIG
// ============================================================================

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const MAX_CONTENT_LENGTH = 10000;

// ============================================================================
// CLIENTS
// ============================================================================

function createOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }
  return new OpenAI({ apiKey });
}

// ============================================================================
// HELPERS
// ============================================================================

function generateContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

async function generateEmbedding(
  openai: OpenAI,
  text: string,
): Promise<number[]> {
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
 * Extract title from MCP meeting notes content
 * Looks for **Title** pattern at the start of meeting-notes
 */
function extractTitle(raw: string): string | null {
  // Match **Title** pattern after <meeting-notes>
  const titleMatch = raw.match(/<meeting-notes>\s*\*\*([^*]+)\*\*/);
  if (titleMatch) {
    return titleMatch[1].trim();
  }

  // Fallback: first line with ** markers
  const fallbackMatch = raw.match(/\*\*([^*]+)\*\*/);
  if (fallbackMatch) {
    return fallbackMatch[1].trim();
  }

  return null;
}

/**
 * Extract clean text from MCP markdown format
 * Preserves structure but simplifies for embedding
 */
function cleanMcpContent(raw: string): string {
  let content = raw;

  // Extract meeting notes content if present
  const meetingNotesMatch = content.match(
    /<meeting-notes>([\s\S]*?)<\/meeting-notes>/,
  );
  if (meetingNotesMatch) {
    content = meetingNotesMatch[1];
  }

  // Extract and label sections
  const sections: string[] = [];

  // Summary section
  const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    sections.push("## Summary\n" + summaryMatch[1].trim());
  }

  // Notes section
  const notesMatch = content.match(/<notes>([\s\S]*?)<\/notes>/);
  if (notesMatch) {
    sections.push("## Notes\n" + notesMatch[1].trim());
  }

  // Transcript section
  const transcriptMatch = content.match(/<transcript>([\s\S]*?)<\/transcript>/);
  if (transcriptMatch) {
    sections.push("## Transcript\n" + transcriptMatch[1].trim());
  }

  // If we found tagged sections, use them; otherwise use raw content
  if (sections.length > 0) {
    content = sections.join("\n\n");
  }

  // Remove remaining HTML-like tags but preserve content
  content = content.replace(/<[^>]+>/g, "").trim();

  return content;
}

/**
 * Update document content via public wrapper RPC
 */
async function updateDocumentContent(params: {
  notionPageId: string;
  content: string;
  title?: string;
}): Promise<{ success: boolean; updated: boolean; message: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openai = createOpenAIClient();

  const { notionPageId, content, title } = params;
  const normalizedId = notionPageId.replace(/-/g, "");
  const contentHash = generateContentHash(content);

  // Generate new embedding
  const embeddingText = title ? `${title}\n\n${content}` : content;
  const embedding = await generateEmbedding(openai, embeddingText);
  const embeddingString = `[${embedding.join(",")}]`;

  // Use upsert RPC to update
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
        p_content: content,
        p_embedding: embeddingString,
        p_title: title || null,
        p_document_type: "Meeting Transcript",
        p_source_type: "notion",
        p_source_path: `notion://page/${normalizedId}`,
        p_notion_page_id: normalizedId,
        p_notion_database_id: null, // Keep existing
        p_tags: ["notion", "private", "meeting", "transcription"],
        p_content_hash: contentHash,
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      updated: false,
      message: `Update failed: ${errorText}`,
    };
  }

  const result = (await response.json()) as Array<{
    id: string;
    created: boolean;
  }>;

  return {
    success: true,
    updated: !result[0]?.created,
    message: result[0]?.created
      ? `Created new document: ${result[0].id}`
      : `Updated document: ${result[0]?.id}`,
  };
}

/**
 * Read content from stdin
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("readable", () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ============================================================================
// CLI
// ============================================================================

const program = new Command();

program
  .name("update-document-content")
  .description("Update a private_kb document with new content")
  .requiredOption(
    "--id <notion_page_id>",
    "Notion page ID (with or without dashes)",
  )
  .option("--content-file <path>", "Path to file containing new content")
  .option("--stdin", "Read content from stdin")
  .option("--title <title>", "Page title (for embedding)")
  .option("--raw", "Do not clean MCP tags from content")
  .action(async (opts) => {
    try {
      // Get content
      let content: string;

      if (opts.stdin) {
        content = await readStdin();
      } else if (opts.contentFile) {
        if (!existsSync(opts.contentFile)) {
          throw new Error(`File not found: ${opts.contentFile}`);
        }
        content = readFileSync(opts.contentFile, "utf8");
      } else {
        throw new Error("Must provide --content-file or --stdin");
      }

      if (!content.trim()) {
        throw new Error("Content is empty");
      }

      // Auto-extract title from raw content if not provided
      const rawContent = content;
      const title = opts.title || extractTitle(rawContent);

      // Clean content unless --raw flag
      if (!opts.raw) {
        content = cleanMcpContent(content);
      }

      console.log(`📝 Updating document: ${opts.id}`);
      console.log(`   Title: ${title || "(none)"}`);
      console.log(`   Content length: ${content.length} chars`);

      const result = await updateDocumentContent({
        notionPageId: opts.id,
        content,
        title: title || undefined,
      });

      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
