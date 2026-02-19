import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.3";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// ============================================================================
// TYPES
// ============================================================================

interface NotionPage {
  id: string;
  object: "page";
  created_time: string;
  last_edited_time: string;
  created_by?: { id: string; object: string };
  last_edited_by?: { id: string; object: string };
  archived: boolean;
  url: string;
  parent: {
    type: "workspace" | "page_id" | "database_id";
    workspace?: boolean;
    page_id?: string;
    database_id?: string;
  };
  properties: Record<string, any>;
}

interface NotionSearchResponse {
  object: "list";
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: any;
}

interface NotionBlocksResponse {
  object: "list";
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionPageRow {
  notion_page_id: string;
  source_path: string;
  title: string;
  url: string | null;
  parent_type: string | null;
  parent_id: string | null;
  database_id: string | null;
  archived: boolean;
  notion_created_time: string | null;
  notion_last_edited_time: string | null;
  content_hash: string | null;
  doc_chunk_count: number;
  last_ingested_at: string | null;
  last_seen_at: string;
  // Enhanced properties (Phase 2)
  platform_lead: string | null;
  stakeholder_lead: string | null;
  status: string | null;
  impact_scale: string | null;
  domain: string | null;
  problem_section: string | null;
  solution_section: string | null;
  definition_of_done: string | null;
  parent_title: string | null;
  parent_project_name: string | null;
  parent_roadmap_name: string | null;
  properties_raw: Record<string, unknown> | null;
  notion_created_by: string | null;
  notion_last_edited_by: string | null;
}

interface ExtractedProperties {
  platformLead?: string;
  stakeholderLead?: string;
  status?: string;
  impactScale?: string;
  domain?: string;
  propertiesRaw?: Record<string, unknown>;
}

interface ExtractedSections {
  problemSection?: string;
  solutionSection?: string;
  definitionOfDone?: string;
}

interface SyncStats {
  pagesSeen: number;
  pagesChanged: number;
  pagesDeleted: number;
  docsUpserted: number;
  docsDeleted: number;
  chunksCreated: number;
  failedPages: number;
  error: string | null;
  durationMs: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 100;
const NOTION_API_VERSION = "2022-06-28";

// ============================================================================
// NOTION API HELPERS
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

async function searchAllPages(
  token: string,
  maxPages: number = 1000,
): Promise<NotionPage[]> {
  const allPages: NotionPage[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const body: Record<string, any> = {
      filter: { property: "object", value: "page" },
      page_size: Math.min(100, maxPages - pagesFetched),
    };
    if (cursor) body.start_cursor = cursor;

    const response = await notionApiCall<NotionSearchResponse>(
      token,
      "/search",
      "POST",
      body,
    );

    for (const page of response.results) {
      if (page.object === "page") {
        allPages.push(page);
        pagesFetched++;
      }
    }

    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 100));
  }

  return allPages;
}

async function getPageBlocks(
  token: string,
  pageId: string,
): Promise<NotionBlock[]> {
  const allBlocks: NotionBlock[] = [];
  let cursor: string | undefined;

  while (true) {
    const endpoint = `/blocks/${pageId}/children${cursor ? `?start_cursor=${cursor}` : ""}`;
    const response = await notionApiCall<NotionBlocksResponse>(token, endpoint);

    for (const block of response.results) {
      allBlocks.push(block);

      // Recursively get children
      if (block.has_children) {
        const children = await getPageBlocks(token, block.id);
        allBlocks.push(...children);
      }
    }

    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;

    await new Promise((r) => setTimeout(r, 50));
  }

  return allBlocks;
}

// ============================================================================
// TEXT EXTRACTION
// ============================================================================

function extractRichText(richText: any[]): string {
  if (!richText || !Array.isArray(richText)) return "";
  return richText.map((item) => item.plain_text || "").join("");
}

function blockToText(block: NotionBlock): string {
  const type = block.type;
  const data = block[type];

  if (!data) return "";

  switch (type) {
    case "paragraph":
      return extractRichText(data.rich_text);
    case "heading_1":
      return `# ${extractRichText(data.rich_text)}`;
    case "heading_2":
      return `## ${extractRichText(data.rich_text)}`;
    case "heading_3":
      return `### ${extractRichText(data.rich_text)}`;
    case "bulleted_list_item":
      return `- ${extractRichText(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${extractRichText(data.rich_text)}`;
    case "to_do":
      const checked = data.checked ? "[x]" : "[ ]";
      return `${checked} ${extractRichText(data.rich_text)}`;
    case "toggle":
      return `**Q:** ${extractRichText(data.rich_text)}`;
    case "quote":
      return `> ${extractRichText(data.rich_text)}`;
    case "code":
      return `\`\`\`${data.language || ""}\n${extractRichText(data.rich_text)}\n\`\`\``;
    case "callout":
      const icon = data.icon?.emoji || ">";
      return `${icon} **Note:** ${extractRichText(data.rich_text)}`;
    case "divider":
      return "---";
    case "table_row":
      if (data.cells) {
        return data.cells
          .map((cell: any[]) => extractRichText(cell))
          .join(" | ");
      }
      return "";
    case "bookmark":
      return `[${data.caption ? extractRichText(data.caption) : data.url}](${data.url})`;
    case "link_preview":
      return `Link: ${data.url || ""}`;
    case "embed":
      return `[Embedded: ${data.url || ""}]`;
    case "image":
      const imgCaption = data.caption ? extractRichText(data.caption) : "Image";
      return `[${imgCaption}]`;
    case "video":
      const vidCaption = data.caption ? extractRichText(data.caption) : "Video";
      return `[${vidCaption}]`;
    case "file":
      return `[File: ${data.name || "attachment"}]`;
    case "pdf":
      return `[PDF document]`;
    case "equation":
      return `$${data.expression || ""}$`;
    default:
      return "";
  }
}

function blocksToText(blocks: NotionBlock[]): string {
  return blocks
    .map((block) => blockToText(block))
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function extractPageTitle(page: NotionPage): string {
  const properties = page.properties;

  // Try common title property names
  for (const key of ["title", "Title", "Name", "name", "Page"]) {
    const prop = properties[key];
    if (prop?.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join("");
    }
  }

  // Fallback to first title-type property
  for (const prop of Object.values(properties)) {
    if ((prop as any)?.type === "title" && (prop as any).title?.length > 0) {
      return (prop as any).title.map((t: any) => t.plain_text).join("");
    }
  }

  return "Untitled";
}

// ============================================================================
// PROPERTY EXTRACTION (Phase 2 Enhancement)
// ============================================================================

/**
 * Extract display name(s) from a People property
 */
function extractPeople(
  properties: Record<string, any>,
  propertyName: string,
): string | undefined {
  const prop = properties[propertyName];
  if (!prop || prop.type !== "people") return undefined;

  const names = prop.people
    .map((person: any) => {
      if (person.name) return person.name;
      if (person.person?.email) return person.person.email.split("@")[0];
      return undefined;
    })
    .filter((name: string | undefined): name is string => !!name);

  return names.length > 0 ? names.join(", ") : undefined;
}

/**
 * Extract value from a Select property
 */
function extractSelect(
  properties: Record<string, any>,
  propertyName: string,
): string | undefined {
  const prop = properties[propertyName];
  if (!prop || prop.type !== "select") return undefined;
  return prop.select?.name;
}

/**
 * Extract all relevant properties from a Notion page
 */
function extractProperties(page: NotionPage): ExtractedProperties {
  const props = page.properties;

  return {
    platformLead: extractPeople(props, "Platform Lead"),
    stakeholderLead:
      extractPeople(props, "Stakeholder") ||
      extractPeople(props, "Stakeholder lead"),
    status: extractSelect(props, "Status"),
    impactScale:
      extractSelect(props, "Impact Scale") || extractSelect(props, "Impact"),
    domain: extractSelect(props, "Domain"),
    propertiesRaw: serializeProperties(props),
  };
}

/**
 * Serialize page properties to a JSON-safe format
 */
function serializeProperties(
  properties: Record<string, any>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || !prop.type) continue;

    switch (prop.type) {
      case "title":
        result[key] = prop.title?.map((t: any) => t.plain_text).join("") || "";
        break;
      case "rich_text":
        result[key] =
          prop.rich_text?.map((t: any) => t.plain_text).join("") || "";
        break;
      case "select":
        result[key] = prop.select?.name;
        break;
      case "multi_select":
        result[key] = prop.multi_select?.map((s: any) => s.name) || [];
        break;
      case "people":
        result[key] = prop.people?.map((p: any) => p.name || p.id) || [];
        break;
      case "date":
        result[key] = prop.date?.start;
        break;
      case "checkbox":
        result[key] = prop.checkbox;
        break;
      case "number":
        result[key] = prop.number;
        break;
      case "url":
        result[key] = prop.url;
        break;
      case "email":
        result[key] = prop.email;
        break;
      case "phone_number":
        result[key] = prop.phone_number;
        break;
      case "status":
        result[key] = prop.status?.name;
        break;
      case "relation":
        result[key] = prop.relation?.map((r: any) => r.id) || [];
        break;
    }
  }

  return result;
}

/**
 * Extract Problem/Solution/Definition of Done sections from page blocks
 */
function extractSections(blocks: NotionBlock[]): ExtractedSections {
  const sections: ExtractedSections = {};

  const sectionPatterns = {
    problemSection: [/^1\.\s*the\s*problem/i, /^problem/i, /^the\s*problem/i],
    solutionSection: [
      /^2\.\s*the\s*solution/i,
      /^solution/i,
      /^the\s*solution/i,
      /^proposed\s*solution/i,
    ],
    definitionOfDone: [
      /^3\.\s*definition\s*of\s*done/i,
      /^definition\s*of\s*done/i,
      /^dod/i,
      /^done\s*criteria/i,
      /^acceptance\s*criteria/i,
    ],
  };

  let currentSection: keyof ExtractedSections | null = null;
  let currentContent: string[] = [];

  const saveCurrentSection = () => {
    if (currentSection && currentContent.length > 0) {
      sections[currentSection] = currentContent.join("\n").trim();
    }
    currentContent = [];
  };

  for (const block of blocks) {
    const type = block.type;
    const data = block[type];
    if (!data) continue;

    let text = "";
    let isHeading = false;

    if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
      isHeading = true;
      text = extractRichText(data.rich_text);
    } else if (type === "paragraph") {
      text = extractRichText(data.rich_text);
    } else if (type === "bulleted_list_item") {
      text = `- ${extractRichText(data.rich_text)}`;
    } else if (type === "numbered_list_item") {
      text = `1. ${extractRichText(data.rich_text)}`;
    } else if (type === "to_do") {
      const checked = data.checked ? "[x]" : "[ ]";
      text = `${checked} ${extractRichText(data.rich_text)}`;
    } else if (type === "toggle") {
      text = extractRichText(data.rich_text);
    } else if (type === "quote") {
      text = `> ${extractRichText(data.rich_text)}`;
    } else if (type === "callout") {
      text = extractRichText(data.rich_text);
    }

    if (isHeading && text) {
      let foundSection: keyof ExtractedSections | null = null;

      for (const [sectionKey, patterns] of Object.entries(sectionPatterns)) {
        if (patterns.some((p) => p.test(text))) {
          foundSection = sectionKey as keyof ExtractedSections;
          break;
        }
      }

      if (foundSection) {
        saveCurrentSection();
        currentSection = foundSection;
      } else if (currentSection) {
        saveCurrentSection();
        currentSection = null;
      }
    } else if (currentSection && text) {
      currentContent.push(text);
    }
  }

  saveCurrentSection();
  return sections;
}

// ============================================================================
// CHUNKING
// ============================================================================

interface TextChunk {
  content: string;
  index: number;
}

function chunkText(
  text: string,
  maxSize: number,
  overlap: number,
): TextChunk[] {
  if (text.length <= maxSize) {
    return [{ content: text, index: 1 }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 1;

  while (start < text.length) {
    let end = Math.min(start + maxSize, text.length);

    // Try to break at a natural boundary
    if (end < text.length) {
      const searchStart = Math.max(start + maxSize / 2, end - 200);
      const searchText = text.slice(searchStart, end);

      // Look for paragraph or sentence boundary
      const lastPara = searchText.lastIndexOf("\n\n");
      const lastNewline = searchText.lastIndexOf("\n");
      const lastSentence = Math.max(
        searchText.lastIndexOf(". "),
        searchText.lastIndexOf("? "),
        searchText.lastIndexOf("! "),
      );

      if (lastPara > searchText.length / 2) {
        end = searchStart + lastPara;
      } else if (lastSentence > searchText.length / 2) {
        end = searchStart + lastSentence + 1;
      } else if (lastNewline > searchText.length / 2) {
        end = searchStart + lastNewline;
      }
    }

    const content = text.slice(start, end).trim();
    if (content.length >= 50) {
      // Min chunk size
      chunks.push({ content, index });
      index++;
    }

    start = Math.max(start + 1, end - overlap);
    if (start >= text.length - overlap) break;
  }

  return chunks;
}

// ============================================================================
// EMBEDDINGS
// ============================================================================

async function generateEmbedding(
  text: string,
  openaiKey: string,
): Promise<number[]> {
  const cleaned = text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000); // Token limit safety

  if (cleaned.length < 10) {
    throw new Error("Text too short for embedding");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: cleaned,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI embedding error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// ============================================================================
// HASHING
// ============================================================================

async function computeContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("MD5", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

async function upsertNotionPage(
  supabase: any,
  page: NotionPage,
  contentHash: string,
  chunkCount: number,
  sourcePath: string,
  extractedProps?: ExtractedProperties,
  extractedSections?: ExtractedSections,
): Promise<void> {
  const title = extractPageTitle(page);
  const normalizedId = page.id.replace(/-/g, "");

  const row: Partial<NotionPageRow> = {
    notion_page_id: normalizedId,
    source_path: sourcePath,
    title,
    url: page.url,
    parent_type: page.parent.type,
    parent_id: page.parent.page_id || page.parent.database_id || null,
    database_id:
      page.parent.type === "database_id" ? page.parent.database_id : null,
    archived: page.archived,
    notion_created_time: page.created_time,
    notion_last_edited_time: page.last_edited_time,
    content_hash: contentHash,
    doc_chunk_count: chunkCount,
    last_ingested_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    // Enhanced properties (Phase 2)
    platform_lead: extractedProps?.platformLead || null,
    stakeholder_lead: extractedProps?.stakeholderLead || null,
    status: extractedProps?.status || null,
    impact_scale: extractedProps?.impactScale || null,
    domain: extractedProps?.domain || null,
    properties_raw: extractedProps?.propertiesRaw || null,
    // Extracted sections
    problem_section: extractedSections?.problemSection || null,
    solution_section: extractedSections?.solutionSection || null,
    definition_of_done: extractedSections?.definitionOfDone || null,
    // Created/edited by
    notion_created_by: page.created_by?.id || null,
    notion_last_edited_by: page.last_edited_by?.id || null,
  };

  const { error } = await supabase
    .schema("volterra_kb")
    .from("notion_pages")
    .upsert(row, { onConflict: "notion_page_id" });

  if (error) {
    throw new Error(
      `Failed to upsert notion_page ${normalizedId}: ${error.message}`,
    );
  }
}

async function markPageSeen(
  supabase: any,
  notionPageId: string,
): Promise<void> {
  const { error } = await supabase
    .schema("volterra_kb")
    .from("notion_pages")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("notion_page_id", notionPageId);

  if (error) {
    console.warn(
      `Failed to mark page ${notionPageId} as seen: ${error.message}`,
    );
  }
}

async function getStoredPage(
  supabase: any,
  notionPageId: string,
): Promise<NotionPageRow | null> {
  const { data, error } = await supabase
    .schema("volterra_kb")
    .from("notion_pages")
    .select("*")
    .eq("notion_page_id", notionPageId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.warn(
      `Error fetching stored page ${notionPageId}: ${error.message}`,
    );
  }

  return data || null;
}

async function upsertDocumentChunks(
  supabase: any,
  page: NotionPage,
  chunks: TextChunk[],
  sourcePath: string,
  openaiKey: string,
): Promise<number> {
  const title = extractPageTitle(page);
  let upserted = 0;

  for (const chunk of chunks) {
    try {
      const embedding = await generateEmbedding(chunk.content, openaiKey);
      const chunkSourcePath =
        chunks.length > 1 ? `${sourcePath}#chunk${chunk.index}` : sourcePath;

      const docRecord = {
        content: chunk.content,
        embedding,
        department: "Support",
        document_type: "Knowledge Base",
        title:
          chunks.length > 1
            ? `${title} (Part ${chunk.index}/${chunks.length})`
            : title,
        access_level: "internal",
        tags: ["notion", "kb", `chunk:${chunk.index}/${chunks.length}`],
        sensitivity: "None",
        source_type: "notion",
        source_path: chunkSourcePath,
      };

      // Upsert: insert or update based on unique constraint
      const { error: upsertError } = await supabase
        .schema("volterra_kb")
        .from("documents")
        .upsert(docRecord, {
          onConflict: "source_type,source_path",
          ignoreDuplicates: false,
        });

      if (upsertError) {
        // Fallback: try insert then delete older duplicates (like Slack pattern)
        const { data: inserted, error: insertError } = await supabase
          .schema("volterra_kb")
          .from("documents")
          .insert(docRecord)
          .select("id")
          .single();

        if (insertError) {
          console.error(
            `Failed to insert doc chunk ${chunkSourcePath}:`,
            insertError.message,
          );
          continue;
        }

        // Delete older duplicates
        await supabase
          .schema("volterra_kb")
          .from("documents")
          .delete()
          .eq("source_type", "notion")
          .eq("source_path", chunkSourcePath)
          .neq("id", inserted.id);
      }

      upserted++;

      // Rate limit protection
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to process chunk ${chunk.index} for page ${page.id}:`,
        errMsg,
      );
    }
  }

  return upserted;
}

async function deletePageDocuments(
  supabase: any,
  sourcePath: string,
): Promise<number> {
  // Delete base path and all chunks
  const { data, error } = await supabase
    .from("documents")
    .delete()
    .eq("source_type", "notion")
    .or(`source_path.eq.${sourcePath},source_path.like.${sourcePath}#chunk%`)
    .select("id");

  if (error) {
    console.error(
      `Failed to delete documents for ${sourcePath}:`,
      error.message,
    );
    return 0;
  }

  return data?.length || 0;
}

async function cleanupStaleChunks(
  supabase: any,
  sourcePath: string,
  oldChunkCount: number,
  newChunkCount: number,
): Promise<number> {
  if (oldChunkCount <= newChunkCount) return 0;

  let deleted = 0;
  for (let i = newChunkCount + 1; i <= oldChunkCount; i++) {
    const stalePath = `${sourcePath}#chunk${i}`;
    const { error } = await supabase
      .schema("volterra_kb")
      .from("documents")
      .delete()
      .eq("source_type", "notion")
      .eq("source_path", stalePath);

    if (!error) deleted++;
  }

  return deleted;
}

async function getStalePages(
  supabase: any,
  syncStartTime: string,
): Promise<NotionPageRow[]> {
  const { data, error } = await supabase
    .schema("volterra_kb")
    .from("notion_pages")
    .select("*")
    .lt("last_seen_at", syncStartTime);

  if (error) {
    console.error("Failed to get stale pages:", error.message);
    return [];
  }

  return data || [];
}

async function deleteNotionPage(
  supabase: any,
  notionPageId: string,
): Promise<void> {
  const { error } = await supabase
    .schema("volterra_kb")
    .from("notion_pages")
    .delete()
    .eq("notion_page_id", notionPageId);

  if (error) {
    console.warn(
      `Failed to delete notion_page ${notionPageId}:`,
      error.message,
    );
  }
}

async function updateSyncState(supabase: any, stats: SyncStats): Promise<void> {
  const { error } = await supabase
    .schema("volterra_kb")
    .from("notion_sync_state")
    .update({
      last_run_at: new Date().toISOString(),
      last_run_pages_seen: stats.pagesSeen,
      last_run_pages_changed: stats.pagesChanged,
      last_run_pages_deleted: stats.pagesDeleted,
      last_run_docs_upserted: stats.docsUpserted,
      last_run_docs_deleted: stats.docsDeleted,
      last_run_chunks_created: stats.chunksCreated,
      last_run_failed_pages: stats.failedPages,
      last_run_error: stats.error,
      last_run_duration_ms: stats.durationMs,
    })
    .eq("id", "default");

  if (error) {
    console.error("Failed to update sync state:", error.message);
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const syncStartTime = new Date().toISOString();

  const stats: SyncStats = {
    pagesSeen: 0,
    pagesChanged: 0,
    pagesDeleted: 0,
    docsUpserted: 0,
    docsDeleted: 0,
    chunksCreated: 0,
    failedPages: 0,
    error: null,
    durationMs: 0,
  };

  try {
    // Verify cron secret
    const cronSecret = Deno.env.get("CRON_SECRET");
    const requestSecret = req.headers.get("x-cron-secret");
    if (cronSecret && requestSecret !== cronSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse input
    let maxPages = 1000;
    let forceReembed = false;

    try {
      const body = await req.json();
      if (body.max_pages) maxPages = Math.min(body.max_pages, 5000);
      if (body.force_reembed) forceReembed = body.force_reembed;
    } catch {
      // Use defaults
    }

    // Initialize clients
    const notionToken = Deno.env.get("NOTION_API_KEY");
    if (!notionToken) {
      throw new Error("NOTION_API_KEY not configured");
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    console.log(
      `Starting Notion sync, maxPages=${maxPages}, forceReembed=${forceReembed}`,
    );

    // Step 1: List all pages from Notion
    const pages = await searchAllPages(notionToken, maxPages);
    stats.pagesSeen = pages.length;
    console.log(`Found ${pages.length} pages in Notion`);

    // Step 2: Process each page
    for (const page of pages) {
      try {
        const normalizedId = page.id.replace(/-/g, "");
        const sourcePath =
          page.parent.type === "database_id"
            ? `notion://db/${page.parent.database_id?.replace(/-/g, "")}/page/${normalizedId}`
            : `notion://page/${normalizedId}`;

        // Check stored state
        const storedPage = await getStoredPage(supabase, normalizedId);

        // Mark as seen (for delete detection)
        if (storedPage) {
          await markPageSeen(supabase, normalizedId);
        }

        // Check if page needs re-ingestion
        const storedEditTime = storedPage?.notion_last_edited_time
          ? new Date(storedPage.notion_last_edited_time).getTime()
          : 0;
        const currentEditTime = new Date(page.last_edited_time).getTime();

        const needsReembed =
          forceReembed ||
          !storedPage ||
          currentEditTime > storedEditTime ||
          page.archived !== storedPage.archived;

        if (!needsReembed) {
          continue; // Skip unchanged pages
        }

        // Skip archived pages (delete their docs)
        if (page.archived) {
          if (storedPage && storedPage.doc_chunk_count > 0) {
            const deleted = await deletePageDocuments(supabase, sourcePath);
            stats.docsDeleted += deleted;
          }
          await upsertNotionPage(supabase, page, "", 0, sourcePath);
          continue;
        }

        // Fetch and process page content
        const blocks = await getPageBlocks(notionToken, page.id);
        const title = extractPageTitle(page);
        const fullContent = `# ${title}\n\n${blocksToText(blocks)}`;

        // Extract properties and sections (Phase 2 Enhancement)
        const extractedProps = extractProperties(page);
        const extractedSections = extractSections(blocks);

        // Check content hash to skip if content hasn't actually changed
        const contentHash = await computeContentHash(fullContent);
        if (storedPage?.content_hash === contentHash && !forceReembed) {
          // Content identical, just update metadata and extracted data
          await upsertNotionPage(
            supabase,
            page,
            contentHash,
            storedPage.doc_chunk_count,
            sourcePath,
            extractedProps,
            extractedSections,
          );
          continue;
        }

        // Chunk the content
        const chunks = chunkText(fullContent, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
        stats.chunksCreated += chunks.length;

        // Upsert document chunks with embeddings
        const upserted = await upsertDocumentChunks(
          supabase,
          page,
          chunks,
          sourcePath,
          openaiKey,
        );
        stats.docsUpserted += upserted;

        // Cleanup stale chunks if count decreased
        if (storedPage && storedPage.doc_chunk_count > chunks.length) {
          const cleaned = await cleanupStaleChunks(
            supabase,
            sourcePath,
            storedPage.doc_chunk_count,
            chunks.length,
          );
          stats.docsDeleted += cleaned;
        }

        // Update notion_pages record with extracted properties and sections
        await upsertNotionPage(
          supabase,
          page,
          contentHash,
          chunks.length,
          sourcePath,
          extractedProps,
          extractedSections,
        );
        stats.pagesChanged++;

        // Rate limit protection
        await new Promise((r) => setTimeout(r, 100));
      } catch (pageErr) {
        const errMsg =
          pageErr instanceof Error ? pageErr.message : String(pageErr);
        console.error(`Failed to process page ${page.id}:`, errMsg);
        stats.failedPages++;
        stats.error = errMsg;
      }
    }

    // Step 3: Handle deleted pages (not seen in this sync)
    const stalePages = await getStalePages(supabase, syncStartTime);
    console.log(`Found ${stalePages.length} stale pages to delete`);

    for (const stalePage of stalePages) {
      try {
        // Delete documents
        const deleted = await deletePageDocuments(
          supabase,
          stalePage.source_path,
        );
        stats.docsDeleted += deleted;

        // Delete notion_pages record
        await deleteNotionPage(supabase, stalePage.notion_page_id);
        stats.pagesDeleted++;
      } catch (deleteErr) {
        const errMsg =
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        console.error(
          `Failed to delete stale page ${stalePage.notion_page_id}:`,
          errMsg,
        );
      }
    }

    // Update sync state
    stats.durationMs = Date.now() - startTime;
    await updateSyncState(supabase, stats);

    console.log(
      `Sync completed in ${stats.durationMs}ms: ${stats.pagesSeen} seen, ${stats.pagesChanged} changed, ${stats.pagesDeleted} deleted, ${stats.docsUpserted} docs upserted, ${stats.failedPages} failed`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        ...stats,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Sync error:", err.message);

    stats.error = err.message;
    stats.durationMs = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        success: false,
        ...stats,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
