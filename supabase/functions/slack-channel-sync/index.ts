import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// ============================================================================
// TYPES
// ============================================================================

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
  client_msg_id?: string;
  parent_user_id?: string;
  edited?: {
    user?: string;
    ts?: string;
  };
  user_profile?: {
    display_name?: string;
    real_name?: string;
    first_name?: string;
    name?: string;
  };
  reply_count?: number;
  latest_reply?: string;
  files?: Array<{
    name?: string;
    title?: string;
    mimetype?: string;
    permalink?: string;
    url_private?: string;
  }>;
  blocks?: any[];
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

interface SlackRepliesResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

interface ThreadData {
  threadTs: string;
  messages: SlackMessage[];
  participants: Set<string>;
  replyCount: number;
  latestReplyTs: string | null;
}

interface SyncState {
  channel_id: string;
  channel_name: string;
  cursor_oldest_ts: string | null;
  lookback_hours: number;
}

type SyncMode = "recent" | "backfill";

interface SlackUser {
  id: string;
  name: string;
  team_id?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    first_name?: string;
  };
}

interface SlackUsersListResponse {
  ok: boolean;
  members?: SlackUser[];
  response_metadata?: {
    next_cursor?: string;
  };
  error?: string;
}

// User cache for display names (Slack conversations.history doesn't include user_profile)
type UserCache = Map<
  string,
  {
    display_name: string | null;
    real_name: string | null;
    first_name: string | null;
    username: string | null;
  }
>;

// ============================================================================
// CONSTANTS
// ============================================================================

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

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const MAX_CHUNK_SIZE = 3000;
const CHUNK_OVERLAP = 150;

// ============================================================================
// SLACK API HELPERS
// ============================================================================

async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

async function slackApiCall<T>(
  token: string,
  method: string,
  params: Record<string, string | number | boolean>,
): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  });

  // Handle Slack 429 rate limits with Retry-After header.
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      const sleepMs = Math.max(1, retryAfter) * 1000;
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }

    if (!response.ok) {
      throw new Error(`Slack API ${method} HTTP error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${data.error || "unknown"}`);
    }

    return data as T;
  }

  throw new Error(`Slack API ${method} rate limited too long`);
}

async function fetchChannelHistory(
  token: string,
  channelId: string,
  opts: {
    oldest?: string;
    latest?: string;
    inclusive?: boolean;
    pageLimit?: number;
    maxPages?: number;
  },
): Promise<SlackMessage[]> {
  const allMessages: SlackMessage[] = [];
  let cursor: string | undefined;
  const maxPages = opts.maxPages ?? 10;
  const pageLimit = Math.min(Math.max(opts.pageLimit ?? 100, 1), 100); // Slack max is 100
  const inclusive = opts.inclusive ?? false;
  let pages = 0;

  while (true) {
    const params: Record<string, string | number | boolean> = {
      channel: channelId,
      limit: pageLimit,
      include_all_metadata: true,
      inclusive,
    };
    if (opts.oldest) params.oldest = opts.oldest;
    if (opts.latest) params.latest = opts.latest;
    if (cursor) params.cursor = cursor;

    const response = await fetchWithRetry(() =>
      slackApiCall<SlackHistoryResponse>(
        token,
        "conversations.history",
        params,
      ),
    );

    if (response.messages) {
      allMessages.push(...response.messages);
    }

    pages++;
    if (pages >= maxPages) {
      break;
    }

    if (!response.has_more || !response.response_metadata?.next_cursor) {
      break;
    }
    cursor = response.response_metadata.next_cursor;

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 100));
  }

  return allMessages;
}

async function fetchThreadReplies(
  token: string,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const allMessages: SlackMessage[] = [];
  let cursor: string | undefined;

  while (true) {
    const params: Record<string, string | number | boolean> = {
      channel: channelId,
      ts: threadTs,
      limit: 100, // Slack max is 100
      include_all_metadata: true,
    };
    if (cursor) params.cursor = cursor;

    const response = await fetchWithRetry(() =>
      slackApiCall<SlackRepliesResponse>(
        token,
        "conversations.replies",
        params,
      ),
    );

    if (response.messages) {
      allMessages.push(...response.messages);
    }

    if (!response.has_more || !response.response_metadata?.next_cursor) {
      break;
    }
    cursor = response.response_metadata.next_cursor;

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 100));
  }

  return allMessages;
}

/**
 * Build a user cache mapping user IDs to display/real names.
 * The conversations.history API doesn't include user_profile, so we need to
 * fetch users separately and cache them for message mapping.
 */
async function buildUserCache(token: string): Promise<UserCache> {
  const cache: UserCache = new Map();
  let cursor: string | undefined;

  console.log("Building user cache from Slack users.list API...");

  while (true) {
    const params: Record<string, string | number | boolean> = {
      limit: 200, // Max per page
    };
    if (cursor) params.cursor = cursor;

    try {
      const response = await fetchWithRetry(() =>
        slackApiCall<SlackUsersListResponse>(token, "users.list", params),
      );

      if (response.members) {
        for (const user of response.members) {
          cache.set(user.id, {
            display_name: user.profile?.display_name || user.name || null,
            real_name: user.profile?.real_name || user.name || null,
            first_name: user.profile?.first_name || null,
            username: user.name || null,
          });
        }
      }

      if (!response.response_metadata?.next_cursor) {
        break;
      }
      cursor = response.response_metadata.next_cursor;

      // Rate limit protection
      await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      // Log but don't fail - we can still sync without user names
      console.warn(
        "Failed to fetch users:",
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
  }

  console.log(`User cache built with ${cache.size} users`);
  return cache;
}

// ============================================================================
// MESSAGE PROCESSING
// ============================================================================

function tsToDate(ts: string): Date {
  const [seconds, micros] = ts.split(".");
  const ms = micros ? parseInt(micros.slice(0, 3).padEnd(3, "0")) : 0;
  return new Date(parseInt(seconds) * 1000 + ms);
}

function tsToIso(ts: string): string {
  return tsToDate(ts).toISOString();
}

function shouldSkipMessage(msg: SlackMessage): boolean {
  if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) return true;
  if (msg.type && msg.type !== "message") return true;
  return false;
}

function extractBlockText(blocks?: any[]): string {
  if (!blocks) return "";
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.type !== "rich_text" || !Array.isArray(block.elements)) continue;

    for (const el of block.elements) {
      if (el.type === "rich_text_section" && Array.isArray(el.elements)) {
        const section = el.elements
          .map((child: any) => child.text || "")
          .filter(Boolean)
          .join("");
        if (section) lines.push(section);
      }
      if (el.type === "rich_text_list" && Array.isArray(el.elements)) {
        for (const item of el.elements) {
          const section =
            item?.elements
              ?.map((child: any) => child.text || "")
              ?.filter(Boolean)
              ?.join("") ?? "";
          if (section) lines.push(`- ${section}`);
        }
      }
      if (el.type === "rich_text_preformatted" && Array.isArray(el.elements)) {
        const code = el.elements.map((c: any) => c.text || "").join("");
        if (code) lines.push("```\n" + code + "\n```");
      }
    }
  }

  return lines.join("\n");
}

function extractMessageText(msg: SlackMessage): string {
  // Extract block text (rich formatting) and plain text
  const blockText = extractBlockText(msg.blocks);
  const base = msg.text?.trim() || "";

  // Prioritize block text over plain text to avoid duplication
  // Slack includes BOTH for backward compatibility, but they often contain the same content
  const mainText = blockText.trim() || base;

  const attachmentText =
    msg.files
      ?.map((file) => {
        const name = file.name || file.title || "file";
        const url = file.permalink || file.url_private;
        const type = file.mimetype ? ` (${file.mimetype})` : "";
        return url
          ? `Attachment: ${name}${type} -> ${url}`
          : `Attachment: ${name}${type}`;
      })
      .join("\n") || "";

  return [mainText, attachmentText]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function getDisplayName(msg: SlackMessage): string {
  if (msg.user_profile?.display_name) return msg.user_profile.display_name;
  if (msg.user_profile?.real_name) return msg.user_profile.real_name;
  if (msg.username) return msg.username;
  if (msg.user) return msg.user;
  if (msg.bot_id) return `bot:${msg.bot_id}`;
  return "unknown";
}

function groupMessagesIntoThreads(
  messages: SlackMessage[],
  channelId: string,
): Map<string, ThreadData> {
  const threads = new Map<string, ThreadData>();

  for (const msg of messages) {
    if (shouldSkipMessage(msg)) continue;
    if (!msg.ts) continue;

    const threadTs = msg.thread_ts || msg.ts;

    if (!threads.has(threadTs)) {
      threads.set(threadTs, {
        threadTs,
        messages: [],
        participants: new Set(),
        replyCount: 0,
        latestReplyTs: null,
      });
    }

    const thread = threads.get(threadTs)!;
    thread.messages.push(msg);

    // Track participant
    const userId = msg.user || msg.bot_id;
    if (userId) {
      thread.participants.add(userId);
    }

    // Update reply tracking
    if (msg.ts !== threadTs) {
      thread.replyCount++;
      if (!thread.latestReplyTs || msg.ts > thread.latestReplyTs) {
        thread.latestReplyTs = msg.ts;
      }
    }
  }

  // Sort messages within each thread
  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  }

  return threads;
}

// ============================================================================
// DOCUMENT RENDERING
// ============================================================================

function renderThreadAsMarkdown(
  thread: ThreadData,
  channelId: string,
  channelName: string,
): string {
  const rootMsg = thread.messages[0];
  if (!rootMsg) return "";

  const startIso = tsToIso(thread.messages[0].ts);
  const endIso = tsToIso(thread.messages[thread.messages.length - 1].ts);
  const participants = Array.from(thread.participants);
  const rootUser = getDisplayName(rootMsg);

  const header = [
    `Channel: #${channelName} (${channelId})`,
    `Thread TS: ${thread.threadTs}`,
    `Messages: ${thread.messages.length}`,
    `Participants: ${participants.length}`,
    `Root author: ${rootUser}`,
    `Date range: ${startIso} → ${endIso}`,
  ];

  const body = thread.messages
    .map((msg) => {
      const when = tsToIso(msg.ts);
      const author = getDisplayName(msg);
      const text = extractMessageText(msg) || "(no text)";
      return `[${when}] ${author}: ${text}`;
    })
    .join("\n\n");

  return `${header.join("\n")}\n\n----\n${body}\n`;
}

// ============================================================================
// TEXT CHUNKING
// ============================================================================

function chunkText(
  text: string,
  maxSize: number,
  overlap: number,
): Array<{ content: string; index: number }> {
  if (text.length <= maxSize) {
    return [{ content: text, index: 1 }];
  }

  const chunks: Array<{ content: string; index: number }> = [];
  let start = 0;
  let index = 1;

  while (start < text.length) {
    let end = start + maxSize;

    // Try to break at a newline or space
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      const lastSpace = text.lastIndexOf(" ", end);
      const breakPoint = Math.max(lastNewline, lastSpace);
      if (breakPoint > start + maxSize / 2) {
        end = breakPoint;
      }
    }

    chunks.push({
      content: text.slice(start, end).trim(),
      index,
    });

    start = end - overlap;
    if (start >= text.length - overlap) break;
    index++;
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
  // Clean and truncate text
  const cleaned = text
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000); // Conservative limit for token safety

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
// DATABASE OPERATIONS
// ============================================================================

async function upsertThread(
  supabase: any,
  channelId: string,
  thread: ThreadData,
): Promise<string> {
  const rootMsg = thread.messages[0];
  if (!rootMsg) throw new Error("Thread has no messages");

  const threadRow = {
    channel_id: channelId,
    thread_ts: thread.threadTs,
    root_user_id: rootMsg.user || null,
    root_bot_id: rootMsg.bot_id || null,
    root_subtype: rootMsg.subtype || null,
    root_text: extractMessageText(rootMsg).slice(0, 10000),
    root_message_at: tsToIso(rootMsg.ts),
    reply_count: thread.replyCount,
    latest_reply_ts: thread.latestReplyTs,
    message_count: thread.messages.length,
    participant_user_ids: Array.from(thread.participants),
    participant_count: thread.participants.size,
    root_raw: rootMsg,
    last_checked_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .schema("volterra_kb")
    .from("slack_threads")
    .upsert(threadRow, { onConflict: "channel_id,thread_ts" })
    .select("id")
    .single();

  if (error) {
    throw new Error(
      `Failed to upsert thread ${thread.threadTs}: ${error.message}`,
    );
  }

  return data.id;
}

async function upsertMessages(
  supabase: any,
  channelId: string,
  messages: SlackMessage[],
  userCache?: UserCache,
): Promise<number> {
  if (messages.length === 0) return 0;

  const rows = messages
    .filter((msg) => !shouldSkipMessage(msg))
    .map((msg) => {
      // Look up user from cache (conversations.history doesn't include user_profile)
      const userId = msg.user || null;
      const cachedUser = userId ? userCache?.get(userId) : undefined;

      // Parse edited timestamp if present
      let editedAt: string | null = null;
      if (msg.edited?.ts) {
        try {
          editedAt = tsToIso(msg.edited.ts);
        } catch {
          // Invalid timestamp, leave as null
        }
      }

      return {
        channel_id: channelId,
        message_ts: msg.ts,
        thread_ts: msg.thread_ts || null,
        user_id: userId,
        bot_id: msg.bot_id || null,
        subtype: msg.subtype || null,
        text: extractMessageText(msg).slice(0, 50000),
        message_at: tsToIso(msg.ts),
        // Prefer cache, fall back to msg.user_profile (rare), then null
        user_display_name:
          cachedUser?.display_name || msg.user_profile?.display_name || null,
        user_real_name:
          cachedUser?.real_name || msg.user_profile?.real_name || null,
        has_files: (msg.files?.length || 0) > 0,
        file_count: msg.files?.length || 0,
        raw: msg,
        // NEW FIELDS: Extended Slack data capture
        user_first_name:
          cachedUser?.first_name || msg.user_profile?.first_name || null,
        username: cachedUser?.username || msg.user_profile?.name || null,
        team_id: msg.team || null,
        edited_at: editedAt,
        edited_by: msg.edited?.user || null,
        client_msg_id: msg.client_msg_id || null,
        parent_user_id: msg.parent_user_id || null,
        // Reaction data for analytics
        reaction_count:
          msg.reactions?.reduce((sum, r) => sum + r.count, 0) ?? 0,
        reactions: msg.reactions ?? [],
      };
    });

  if (rows.length === 0) return 0;

  const { error, count } = await supabase
    .schema("volterra_kb")
    .from("slack_messages")
    .upsert(rows, { onConflict: "channel_id,message_ts", count: "exact" });

  if (error) {
    throw new Error(`Failed to upsert messages: ${error.message}`);
  }

  return count || rows.length;
}

async function upsertDocumentChunks(
  supabase: any,
  thread: ThreadData,
  channelId: string,
  channelName: string,
  openaiKey: string,
): Promise<{ upserted: number; oldChunkCount: number }> {
  const markdown = renderThreadAsMarkdown(thread, channelId, channelName);
  if (!markdown.trim()) return { upserted: 0, oldChunkCount: 0 };

  const chunks = chunkText(markdown, MAX_CHUNK_SIZE, CHUNK_OVERLAP);
  const basePath = `slack://${channelId}/${thread.threadTs}`;
  const insertedIds: string[] = [];

  // Get old chunk count from thread (for cleanup)
  const { data: threadData } = await supabase
    .schema("volterra_kb")
    .from("slack_threads")
    .select("doc_chunk_count")
    .eq("channel_id", channelId)
    .eq("thread_ts", thread.threadTs)
    .single();

  const oldChunkCount = threadData?.doc_chunk_count || 0;

  for (const chunk of chunks) {
    try {
      const embedding = await generateEmbedding(chunk.content, openaiKey);
      const sourcePath =
        chunks.length > 1 ? `${basePath}#chunk${chunk.index}` : basePath;

      // Build document record
      const docRecord = {
        content: chunk.content,
        embedding,
        department: "platform",
        document_type: "slack-thread",
        title:
          chunks.length > 1
            ? `[#${channelName}] Thread ${thread.threadTs} (Part ${chunk.index}/${chunks.length})`
            : `[#${channelName}] Thread ${thread.threadTs}`,
        access_level: "internal",
        tags: ["slack", channelName, "help-me-platform"],
        sensitivity: "None",
        source_type: "slack",
        source_path: sourcePath,
      };

      // Insert new document
      const { data: insertedDoc, error: insertError } = await supabase
        .schema("volterra_kb")
        .from("documents")
        .insert(docRecord)
        .select("id")
        .single();

      if (insertError) {
        console.error(
          `Failed to insert doc chunk ${sourcePath}:`,
          insertError.message,
        );
        continue;
      }

      insertedIds.push(insertedDoc.id);

      // Delete older duplicates with same source_path (keep only the new one)
      const { error: deleteError } = await supabase
        .schema("volterra_kb")
        .from("documents")
        .delete()
        .eq("source_type", "slack")
        .eq("source_path", sourcePath)
        .neq("id", insertedDoc.id);

      if (deleteError) {
        console.warn(
          `Failed to cleanup old docs for ${sourcePath}:`,
          deleteError.message,
        );
      }

      // Small delay for rate limiting
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to process chunk ${chunk.index} for thread ${thread.threadTs}:`,
        errMsg,
      );
    }
  }

  // Cleanup stale chunks if chunk count decreased
  if (oldChunkCount > chunks.length) {
    for (let i = chunks.length + 1; i <= oldChunkCount; i++) {
      const stalePath = `${basePath}#chunk${i}`;
      await supabase
        .schema("volterra_kb")
        .from("documents")
        .delete()
        .eq("source_type", "slack")
        .eq("source_path", stalePath);
    }
  }

  // Update thread with new chunk count
  await supabase
    .schema("volterra_kb")
    .from("slack_threads")
    .update({ doc_chunk_count: chunks.length })
    .eq("channel_id", channelId)
    .eq("thread_ts", thread.threadTs);

  return { upserted: insertedIds.length, oldChunkCount };
}

async function getThreadsToRecheck(
  supabase: any,
  channelId: string,
  limit: number,
): Promise<string[]> {
  const { data, error } = await supabase
    .schema("volterra_kb")
    .from("slack_threads")
    .select("thread_ts")
    .eq("channel_id", channelId)
    .order("last_checked_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.warn("Failed to get threads to recheck:", error.message);
    return [];
  }

  return data?.map((r: any) => r.thread_ts) || [];
}

async function updateSyncState(
  supabase: any,
  channelId: string,
  stats: {
    threadsFetched: number;
    threadsUpserted: number;
    messagesUpserted: number;
    docsUpserted: number;
    failedThreads: number;
    error: string | null;
    cursorOldestTs?: string | null;
  },
): Promise<void> {
  const patch: Record<string, any> = {
    last_run_at: new Date().toISOString(),
    last_run_threads_fetched: stats.threadsFetched,
    last_run_threads_upserted: stats.threadsUpserted,
    last_run_messages_upserted: stats.messagesUpserted,
    last_run_docs_upserted: stats.docsUpserted,
    last_run_failed_threads: stats.failedThreads,
    last_run_error: stats.error,
  };
  if (stats.cursorOldestTs !== undefined) {
    patch.cursor_oldest_ts = stats.cursorOldestTs;
  }

  const { error } = await supabase
    .schema("volterra_kb")
    .from("slack_channel_sync_state")
    .update(patch)
    .eq("channel_id", channelId);

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
  let threadsFetched = 0;
  let threadsUpserted = 0;
  let messagesUpserted = 0;
  let docsUpserted = 0;
  let failedThreads = 0;
  let lastError: string | null = null;

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
    let channelId = Deno.env.get("SLACK_CHANNEL_ID") || "YOUR_SLACK_CHANNEL_ID";
    let lookbackHours = 48;
    let maxThreads = 200;
    let recheckThreads = 50;
    let mode: SyncMode = "recent";
    let maxHistoryPages = 10;
    let historyPageLimit = 100;
    let generateDocs = true;
    let targetOldestIso: string | null = null;
    let generateDocsSpecified = false;
    let maxHistoryPagesSpecified = false;
    let historyPageLimitSpecified = false;
    let maxThreadsSpecified = false;

    try {
      const body = await req.json();
      if (body.channel_id) channelId = body.channel_id;
      if (body.lookback_hours) lookbackHours = body.lookback_hours;
      if (body.max_threads) {
        maxThreads = body.max_threads;
        maxThreadsSpecified = true;
      }
      if (body.recheck_threads) recheckThreads = body.recheck_threads;
      if (body.mode === "backfill" || body.mode === "recent") mode = body.mode;
      if (typeof body.max_history_pages === "number") {
        maxHistoryPages = body.max_history_pages;
        maxHistoryPagesSpecified = true;
      }
      if (typeof body.history_page_limit === "number") {
        historyPageLimit = body.history_page_limit;
        historyPageLimitSpecified = true;
      }
      if (typeof body.generate_docs === "boolean") {
        generateDocs = body.generate_docs;
        generateDocsSpecified = true;
      }
      if (typeof body.target_oldest_iso === "string")
        targetOldestIso = body.target_oldest_iso;
    } catch {
      // No body or invalid JSON - use defaults
    }

    // Initialize clients
    const slackToken = Deno.env.get("SLACK_USER_TOKEN");
    if (!slackToken) {
      throw new Error("SLACK_USER_TOKEN not configured");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Read sync state
    const { data: stateRow, error: stateError } = await supabase
      .schema("volterra_kb")
      .from("slack_channel_sync_state")
      .select("*")
      .eq("channel_id", channelId)
      .single();

    if (stateError && stateError.code !== "PGRST116") {
      throw new Error(`Failed to read sync state: ${stateError.message}`);
    }

    const channelName = stateRow?.channel_name || "help-me-platform";

    // Build user cache for display names (conversations.history doesn't include user_profile)
    const userCache = await buildUserCache(slackToken);

    // Resolve run window
    const nowTs = (Date.now() / 1000).toFixed(6);
    const isBackfill = mode === "backfill";
    const defaultTargetOldestIso = "2023-07-03T00:00:00Z";
    const resolveIsoToTs = (iso: string, fallbackIso: string): string => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) {
        return (new Date(fallbackIso).getTime() / 1000).toFixed(6);
      }
      return (d.getTime() / 1000).toFixed(6);
    };

    const targetOldestTs = isBackfill
      ? resolveIsoToTs(
          targetOldestIso ?? defaultTargetOldestIso,
          defaultTargetOldestIso,
        )
      : undefined;

    const lookbackMs = Date.now() - lookbackHours * 60 * 60 * 1000;
    const recentOldestTs = (lookbackMs / 1000).toFixed(6);

    const historyOldest = isBackfill ? targetOldestTs : recentOldestTs;
    const historyLatest = isBackfill
      ? stateRow?.cursor_oldest_ts || nowTs
      : undefined;
    const historyInclusive = false; // avoid repeating boundary message on backfill

    if (isBackfill) {
      // Backfill defaults: small bounded runs; no embeddings unless explicitly enabled.
      if (!generateDocsSpecified) generateDocs = false;
      if (!maxHistoryPagesSpecified) maxHistoryPages = 2;
      if (!historyPageLimitSpecified) historyPageLimit = 100;
      if (!maxThreadsSpecified) maxThreads = 50;
      recheckThreads = 0;
    }

    const openaiKey = generateDocs ? Deno.env.get("OPENAI_API_KEY") : null;
    if (generateDocs && !openaiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    console.log(
      `Starting ${mode} sync for channel ${channelId} (${channelName}), oldest=${historyOldest}, latest=${historyLatest ?? "(none)"}, maxThreads=${maxThreads}, maxHistoryPages=${maxHistoryPages}`,
    );

    // Step 1: Fetch a bounded window of channel history (paged, capped)
    const channelMessages = await fetchChannelHistory(slackToken, channelId, {
      oldest: historyOldest,
      latest: historyLatest,
      inclusive: historyInclusive,
      pageLimit: historyPageLimit,
      maxPages: maxHistoryPages,
    });
    console.log(
      `Fetched ${channelMessages.length} messages from channel history window`,
    );

    // Always upsert raw messages we saw in channel history (roots + broadcasts, etc).
    // Thread replies are fetched separately (Slack doesn't return them in history).
    messagesUpserted += await upsertMessages(
      supabase,
      channelId,
      channelMessages,
      userCache,
    );

    // Step 2: Build thread candidates from the window
    const rootByTs = new Map<string, SlackMessage>();
    const threadTsSet = new Set<string>();
    const threadTsNeedsReplies = new Set<string>();

    for (const msg of channelMessages) {
      if (shouldSkipMessage(msg)) continue;
      if (!msg.ts) continue;
      rootByTs.set(msg.ts, msg);

      const rootThreadTs = msg.thread_ts || msg.ts;
      threadTsSet.add(rootThreadTs);

      const isReplyBroadcast = !!msg.thread_ts && msg.thread_ts !== msg.ts;
      const hasReplies = (msg.reply_count ?? 0) > 0;
      if (isReplyBroadcast || hasReplies) {
        threadTsNeedsReplies.add(rootThreadTs);
      }
    }

    const threadTsToProcess = Array.from(threadTsSet).slice(0, maxThreads);
    threadsFetched = threadTsToProcess.length;

    // Step 3: Optionally add older threads to recheck for new replies (recent mode)
    const recheckTs = isBackfill
      ? []
      : await getThreadsToRecheck(supabase, channelId, recheckThreads);
    const allThreadsToProcess = new Set([...threadTsToProcess, ...recheckTs]);

    console.log(
      `Processing ${allThreadsToProcess.size} threads (${threadTsToProcess.length} from window, ${recheckTs.length} recheck), generateDocs=${generateDocs}`,
    );

    // Step 4: Process each thread (root-only fast path; replies only when needed)
    for (const threadTs of allThreadsToProcess) {
      try {
        const rootMsg = rootByTs.get(threadTs);
        const shouldFetchReplies = threadTsNeedsReplies.has(threadTs);

        const threadMessages = shouldFetchReplies
          ? await fetchThreadReplies(slackToken, channelId, threadTs)
          : rootMsg
            ? [rootMsg]
            : [];

        if (threadMessages.length === 0) {
          // If we don't have a root in-window, skip; it will be picked up when its root appears in the window.
          continue;
        }

        // Build thread data from fetched messages
        const thread: ThreadData = {
          threadTs,
          messages: threadMessages.filter((m) => !shouldSkipMessage(m)),
          participants: new Set(),
          replyCount: 0,
          latestReplyTs: null,
        };

        for (const msg of thread.messages) {
          const userId = msg.user || msg.bot_id;
          if (userId) thread.participants.add(userId);
          if (msg.ts !== threadTs) {
            thread.replyCount++;
            if (!thread.latestReplyTs || msg.ts > thread.latestReplyTs) {
              thread.latestReplyTs = msg.ts;
            }
          }
        }

        thread.messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

        // Upsert thread
        await upsertThread(supabase, channelId, thread);
        threadsUpserted++;

        // Upsert messages
        const msgCount = await upsertMessages(
          supabase,
          channelId,
          thread.messages,
          userCache,
        );
        messagesUpserted += msgCount;

        if (generateDocs) {
          // Generate and upsert document chunks (embeddings)
          const docResult = await upsertDocumentChunks(
            supabase,
            thread,
            channelId,
            channelName,
            openaiKey,
          );
          docsUpserted += docResult.upserted;
        }

        // Small delay between threads
        await new Promise((r) => setTimeout(r, 100));
      } catch (threadErr) {
        const errMsg =
          threadErr instanceof Error ? threadErr.message : String(threadErr);
        console.error(`Failed to process thread ${threadTs}:`, errMsg);
        failedThreads++;
        lastError = errMsg;
      }
    }

    // Update sync state
    const oldestSeenTs = channelMessages.reduce<string | null>((acc, m) => {
      if (!m.ts) return acc;
      if (acc === null) return m.ts;
      return parseFloat(m.ts) < parseFloat(acc) ? m.ts : acc;
    }, null);

    await updateSyncState(supabase, channelId, {
      threadsFetched,
      threadsUpserted,
      messagesUpserted,
      docsUpserted,
      failedThreads,
      error: lastError,
      cursorOldestTs: isBackfill ? oldestSeenTs : undefined,
    });

    const elapsed = Date.now() - startTime;
    console.log(
      `Sync completed in ${elapsed}ms: ${threadsFetched} threads fetched, ${threadsUpserted} upserted, ${messagesUpserted} messages, ${docsUpserted} docs, ${failedThreads} failed`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        channelId,
        channelName,
        threadsFetched,
        threadsUpserted,
        messagesUpserted,
        docsUpserted,
        failedThreads,
        elapsedMs: elapsed,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Sync error:", err.message);

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        threadsFetched,
        threadsUpserted,
        messagesUpserted,
        docsUpserted,
        failedThreads,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
