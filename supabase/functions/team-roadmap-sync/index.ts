/**
 * Team Platform Roadmap Sync
 *
 * Daily sync of the Team Platform Roadmap Notion database to Supabase
 *
 * Triggered by: pg_cron daily at 07:00 UTC
 * Database: c9ea0b87-7c7e-4996-8c99-4419ac08a270
 * Data Source: YOUR_NOTION_DB_ID
 * Pages: 582 (as of 2026-01-12)
 *
 * This function:
 * 1. Queries all pages from the Team Platform Roadmap database
 * 2. Downloads page content as Markdown
 * 3. Generates embeddings via OpenAI
 * 4. Stores in volterra_kb.documents with pgvector
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://esm.sh/@notionhq/client@5.6.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const DATA_SOURCE_ID = "YOUR_NOTION_DB_ID";
const DATABASE_ID = "c9ea0b87-7c7e-4996-8c99-4419ac08a270";

interface SyncResult {
  success: boolean;
  pagesQueried: number;
  pagesProcessed: number;
  pagesSuccess: number;
  pagesSkipped: number;
  pagesFailed: number;
  errors: string[];
  duration: number;
}

serve(async (req) => {
  const startTime = Date.now();
  const result: SyncResult = {
    success: false,
    pagesQueried: 0,
    pagesProcessed: 0,
    pagesSuccess: 0,
    pagesSkipped: 0,
    pagesFailed: 0,
    errors: [],
    duration: 0,
  };

  try {
    // Initialize clients
    const notion = new Client({ auth: Deno.env.get("NOTION_API_KEY") });
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "volterra_kb" } },
    );

    console.log("Starting Team Platform Roadmap sync...");

    // Query all pages from the database
    const pages = [];
    let cursor: string | undefined;

    do {
      const response = await notion.dataSources.query({
        data_source_id: DATA_SOURCE_ID,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const page of response.results) {
        if ("properties" in page) {
          pages.push(page);
        }
      }

      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);

    result.pagesQueried = pages.length;
    console.log(`Found ${pages.length} pages to sync`);

    // Process each page
    for (const page of pages) {
      result.pagesProcessed++;

      try {
        const pageId = page.id;
        const title = extractPageTitle(page);
        const normalizedPageId = pageId.replace(/-/g, "");
        const normalizedDbId = DATA_SOURCE_ID.replace(/-/g, "");
        const sourcePath = `notion://db/${normalizedDbId}/page/${normalizedPageId}`;

        // Check if already exists
        const { data: existing } = await supabase
          .from("documents")
          .select("id")
          .eq("source_path", sourcePath)
          .limit(1);

        if (existing && existing.length > 0) {
          result.pagesSkipped++;
          continue;
        }

        // Download page content
        const content = await downloadPageContent(notion, pageId);
        const fullContent = `# ${title}\n\n${content}`;

        // Generate embedding
        const embedding = await generateEmbedding(fullContent);

        // Insert to database
        const { error: insertError } = await supabase.from("documents").insert({
          content: fullContent,
          embedding: `[${embedding.join(",")}]`,
          department: "Platform",
          document_type: "Documentation",
          title,
          access_level: "internal",
          tags: ["notion", "platform-roadmap"],
          sensitivity: "None",
          source_type: "notion",
          source_path: sourcePath,
        });

        if (insertError) {
          result.pagesFailed++;
          result.errors.push(`${title}: ${insertError.message}`);
        } else {
          result.pagesSuccess++;
        }
      } catch (error) {
        result.pagesFailed++;
        result.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    result.success =
      result.pagesFailed === 0 || result.pagesSuccess > result.pagesFailed;
    result.duration = Date.now() - startTime;

    console.log("Sync complete", result);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.duration = Date.now() - startTime;

    console.error("Sync failed", error);

    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

function extractPageTitle(page: any): string {
  const properties = page.properties;

  // Find the title property (usually "Name" or "Title")
  for (const [key, value] of Object.entries(properties)) {
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "title"
    ) {
      const titleValue = value as any;
      if (
        titleValue.title &&
        Array.isArray(titleValue.title) &&
        titleValue.title.length > 0
      ) {
        return titleValue.title[0]?.plain_text || "Untitled";
      }
    }
  }

  return "Untitled";
}

async function downloadPageContent(
  notion: Client,
  pageId: string,
): Promise<string> {
  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });

    blocks.push(...response.results);
    cursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (cursor);

  return blocks.map(blockToText).filter(Boolean).join("\n");
}

function blockToText(block: any): string {
  if (!block.type) return "";

  const type = block.type;
  const content = block[type];

  if (!content) return "";

  // Extract rich text
  if (content.rich_text && Array.isArray(content.rich_text)) {
    return content.rich_text.map((rt: any) => rt.plain_text || "").join("");
  }

  return "";
}

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.substring(0, 8000), // Limit to ~8K chars
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}
