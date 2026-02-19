/**
 * Meeting Notes Sync
 *
 * Daily sync of the Meeting Notes Notion database to Supabase
 *
 * Triggered by: pg_cron daily at 08:00 UTC
 * Database: 83080877-05f0-4dbb-bf80-09bb7f15a2fb
 * Pages: 189 (as of 2026-01-13)
 *
 * This function:
 * 1. Queries all pages from the Meeting Notes database via raw Notion API calls
 * 2. Downloads page content as Markdown
 * 3. Generates embeddings via OpenAI
 * 4. Stores in volterra_kb.documents with pgvector
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const DATABASE_ID = "83080877-05f0-4dbb-bf80-09bb7f15a2fb";
const NOTION_API_VERSION = "2022-06-28";

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

// ============================================================================
// NOTION API HELPERS (Raw HTTP calls)
// ============================================================================

async function notionApiCall<T>(
  token: string,
  endpoint: string,
  method: string = "GET",
  body?: Record<string, any>,
): Promise<T> {
  const url = `https://api.notion.com/v1${endpoint}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Notion API ${endpoint} error: ${response.status} - ${errText}`,
      );
    }

    return (await response.json()) as T;
  }

  throw new Error(`Notion API ${endpoint} rate limited too long`);
}

async function queryDatabase(
  token: string,
  databaseId: string,
): Promise<any[]> {
  const allPages: any[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, any> = {
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const response = await notionApiCall<any>(
      token,
      `/databases/${databaseId}/query`,
      "POST",
      body,
    );

    for (const page of response.results) {
      if ("properties" in page) {
        allPages.push(page);
      }
    }

    cursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 100));
  } while (cursor);

  return allPages;
}

async function getPageBlocks(token: string, pageId: string): Promise<any[]> {
  const allBlocks: any[] = [];
  let cursor: string | undefined;

  while (true) {
    const endpoint = `/blocks/${pageId}/children${cursor ? `?start_cursor=${cursor}` : ""}`;
    const response = await notionApiCall<any>(token, endpoint);

    allBlocks.push(...response.results);

    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;

    await new Promise((r) => setTimeout(r, 50));
  }

  return allBlocks;
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
    // Get API keys
    const notionToken = Deno.env.get("NOTION_API_KEY");
    if (!notionToken) {
      throw new Error("NOTION_API_KEY not configured");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "volterra_kb" } },
    );

    console.log("Starting Meeting Notes sync...");

    // Query all pages from the database using raw HTTP
    const pages = await queryDatabase(notionToken, DATABASE_ID);

    result.pagesQueried = pages.length;
    console.log(`Found ${pages.length} pages to sync`);

    // Process each page
    for (const page of pages) {
      result.pagesProcessed++;

      try {
        const pageId = page.id;
        const title = extractPageTitle(page);
        const normalizedPageId = pageId.replace(/-/g, "");
        const normalizedDbId = DATABASE_ID.replace(/-/g, "");
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
        const content = await downloadPageContent(notionToken, pageId);
        const fullContent = `# ${title}\n\n${content}`;

        // Generate embedding
        const embedding = await generateEmbedding(fullContent);

        // Insert to database
        const { error: insertError } = await supabase.from("documents").insert({
          content: fullContent,
          embedding: `[${embedding.join(",")}]`,
          department: "Cross-Functional",
          document_type: "Meeting Notes",
          title,
          access_level: "internal",
          tags: ["notion", "meetings", "collaboration"],
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
  token: string,
  pageId: string,
): Promise<string> {
  const blocks = await getPageBlocks(token, pageId);
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
