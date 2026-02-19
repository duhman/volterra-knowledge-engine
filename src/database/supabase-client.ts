import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";
import { DatabaseError } from "../utils/error-handler.js";
import type { DocumentRecord } from "../types/index.js";
import type { Database } from "../types/database.types.js";

let supabaseClient: SupabaseClient<Database> | null = null;

/**
 * Sanitize text content for Postgres to handle Unicode issues
 * Removes null bytes and invalid escape sequences that cause insertion errors
 */
function sanitizeForPostgres(text: string): string {
  return (
    text
      // Remove null bytes
      .replace(/\x00/g, "")
      // Remove invalid Unicode escape sequences (incomplete \uXXXX patterns)
      .replace(/\\u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/g, "")
      // Remove invalid backslash-u patterns that aren't valid escapes
      .replace(/\\u(?![0-9a-fA-F]{4})/g, "u")
      // Remove other problematic control characters (except newlines, tabs, carriage returns)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  );
}

export function getSupabaseClient(): SupabaseClient<Database> {
  if (supabaseClient) return supabaseClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new DatabaseError(
      "Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.",
    );
  }

  supabaseClient = createClient<Database>(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: "volterra_kb",
    },
  });

  logger.info("Supabase client initialized");
  return supabaseClient;
}

export async function insertDocument(
  document: DocumentRecord,
): Promise<string> {
  const client = getSupabaseClient();

  // Convert embedding array to string format for pgvector
  const embeddingString = `[${document.embedding.join(",")}]`;

  const { data, error } = await client
    .from("documents")
    .insert({
      content: sanitizeForPostgres(document.content),
      embedding: embeddingString,
      department: document.department,
      document_type: document.document_type,
      title: sanitizeForPostgres(document.title),
      owner: document.owner,
      access_level: document.access_level,
      tags: document.tags,
      sensitivity: document.sensitivity,
      language: document.language,
      source_type: document.source_type,
      source_path: document.source_path,
    })
    .select("id")
    .single();

  if (error) {
    logger.error("Failed to insert document", {
      error: error.message,
      title: document.title,
    });
    throw new DatabaseError(`Failed to insert document: ${error.message}`, {
      title: document.title,
    });
  }

  logger.debug("Document inserted", { id: data.id, title: document.title });
  return data.id;
}

export async function insertDocumentsBatch(
  documents: DocumentRecord[],
): Promise<string[]> {
  const client = getSupabaseClient();

  const records = documents.map((doc) => ({
    content: sanitizeForPostgres(doc.content),
    embedding: `[${doc.embedding.join(",")}]`,
    department: doc.department,
    document_type: doc.document_type,
    title: sanitizeForPostgres(doc.title),
    owner: doc.owner,
    access_level: doc.access_level,
    tags: doc.tags,
    sensitivity: doc.sensitivity,
    language: doc.language,
    source_type: doc.source_type,
    source_path: doc.source_path,
  }));

  const { data, error } = await client
    .from("documents")
    .insert(records)
    .select("id");

  if (error) {
    logger.error("Failed to insert documents batch", {
      error: error.message,
      count: documents.length,
    });
    throw new DatabaseError(
      `Failed to insert documents batch: ${error.message}`,
      { count: documents.length },
    );
  }

  const ids = data.map((d) => d.id);
  logger.info("Documents batch inserted", { count: ids.length });
  return ids;
}

export async function searchDocuments(
  queryEmbedding: number[],
  options: {
    matchThreshold?: number;
    matchCount?: number;
    department?: string;
    accessLevel?: string;
  } = {},
): Promise<DocumentRecord[]> {
  const client = getSupabaseClient();

  // Convert embedding array to string format for pgvector RPC
  const embeddingString = `[${queryEmbedding.join(",")}]`;

  const { data, error } = await client.rpc("match_documents", {
    query_embedding: embeddingString,
    match_threshold: options.matchThreshold ?? 0.78,
    match_count: options.matchCount ?? 10,
    filter_department: options.department,
    filter_access_level: options.accessLevel,
  });

  if (error) {
    logger.error("Failed to search documents", { error: error.message });
    throw new DatabaseError(`Failed to search documents: ${error.message}`);
  }

  // The RPC returns partial DocumentRecord data (without embedding)
  return (data ?? []) as unknown as DocumentRecord[];
}

export async function documentExists(
  title: string,
  content: string,
): Promise<boolean> {
  const client = getSupabaseClient();

  // Check by title and content hash (simple deduplication)
  const contentPreview = content.substring(0, 500);

  const { data, error } = await client
    .from("documents")
    .select("id")
    .eq("title", title)
    .ilike("content", `${contentPreview}%`)
    .limit(1);

  if (error) {
    logger.warn("Error checking document existence", { error: error.message });
    return false;
  }

  return data.length > 0;
}

/**
 * Check if document exists by source_path (more reliable for sources with unique IDs)
 */
export async function documentExistsBySourcePath(
  sourcePath: string,
): Promise<boolean> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from("documents")
    .select("id")
    .eq("source_path", sourcePath)
    .limit(1);

  if (error) {
    logger.warn("Error checking document by source_path", {
      error: error.message,
      sourcePath,
    });
    return false;
  }

  return data.length > 0;
}

/**
 * Batch check which source paths already exist
 * Returns set of existing source paths
 */
export async function getExistingSourcePaths(
  sourcePaths: string[],
): Promise<Set<string>> {
  if (sourcePaths.length === 0) return new Set();

  const client = getSupabaseClient();
  const existing = new Set<string>();

  // Query in batches of 100 to avoid URL length limits
  const batchSize = 100;
  for (let i = 0; i < sourcePaths.length; i += batchSize) {
    const batch = sourcePaths.slice(i, i + batchSize);

    const { data, error } = await client
      .from("documents")
      .select("source_path")
      .in("source_path", batch);

    if (error) {
      logger.warn("Error checking existing source paths", {
        error: error.message,
      });
      continue;
    }

    for (const row of data) {
      if (row.source_path) {
        existing.add(row.source_path);
      }
    }
  }

  return existing;
}

export async function deleteDocument(id: string): Promise<void> {
  const client = getSupabaseClient();

  const { error } = await client.from("documents").delete().eq("id", id);

  if (error) {
    throw new DatabaseError(`Failed to delete document: ${error.message}`, {
      id,
    });
  }

  logger.info("Document deleted", { id });
}

// Training Conversations Search Types
export interface TrainingConversationMatch {
  id: string;
  subject: string | null;
  category: string | null;
  conversation_summary: string | null;
  training_type: string | null;
  similarity: number;
}

export interface TrainingMessage {
  id: string;
  from_name: string | null;
  participant_role: string | null;
  content: string;
  direction: string | null;
  timestamp: string;
}

export interface TrainingConversationWithMessages extends TrainingConversationMatch {
  messages: TrainingMessage[];
}

/**
 * Search training conversations by semantic similarity
 */
export async function searchTrainingConversations(
  queryEmbedding: number[],
  options: {
    matchThreshold?: number;
    matchCount?: number;
    trainingType?: "email_agent" | "chatbot" | null;
  } = {},
): Promise<TrainingConversationMatch[]> {
  const client = getSupabaseClient();

  // Convert embedding array to string format for pgvector RPC
  const embeddingString = `[${queryEmbedding.join(",")}]`;

  const { data, error } = await client.rpc("match_training_conversations", {
    query_embedding: embeddingString,
    training_type_filter: options.trainingType,
    match_threshold: options.matchThreshold ?? 0.7,
    match_count: options.matchCount ?? 10,
  });

  if (error) {
    logger.error("Failed to search training conversations", {
      error: error.message,
    });
    throw new DatabaseError(
      `Failed to search training conversations: ${error.message}`,
    );
  }

  return (data ?? []) as TrainingConversationMatch[];
}

/**
 * Search training conversations and include full message threads
 */
export async function searchTrainingConversationsWithMessages(
  queryEmbedding: number[],
  options: {
    matchThreshold?: number;
    matchCount?: number;
    trainingType?: "email_agent" | "chatbot" | null;
    maxMessagesPerConversation?: number;
  } = {},
): Promise<TrainingConversationWithMessages[]> {
  const client = getSupabaseClient();

  // First get matching conversations
  const conversations = await searchTrainingConversations(queryEmbedding, {
    matchThreshold: options.matchThreshold,
    matchCount: options.matchCount,
    trainingType: options.trainingType,
  });

  if (conversations.length === 0) {
    return [];
  }

  // Get messages for each conversation
  const conversationIds = conversations.map((c) => c.id);
  const maxMessages = options.maxMessagesPerConversation ?? 10;

  const { data: allMessages, error: messagesError } = await client
    .from("training_messages")
    .select(
      "id, conversation_id, from_name, participant_role, content, direction, timestamp",
    )
    .in("conversation_id", conversationIds)
    .order("timestamp", { ascending: true });

  if (messagesError) {
    logger.error("Failed to fetch training messages", {
      error: messagesError.message,
    });
    throw new DatabaseError(
      `Failed to fetch training messages: ${messagesError.message}`,
    );
  }

  // Group messages by conversation
  const messagesByConversation = new Map<string, TrainingMessage[]>();
  for (const msg of allMessages || []) {
    const convId = msg.conversation_id;
    if (!messagesByConversation.has(convId)) {
      messagesByConversation.set(convId, []);
    }
    const messages = messagesByConversation.get(convId)!;
    if (messages.length < maxMessages) {
      messages.push({
        id: msg.id,
        from_name: msg.from_name,
        participant_role: msg.participant_role,
        content: msg.content,
        direction: msg.direction,
        timestamp: msg.timestamp,
      });
    }
  }

  // Combine conversations with their messages
  return conversations.map((conv) => ({
    ...conv,
    messages: messagesByConversation.get(conv.id) || [],
  }));
}

/**
 * Get a single training conversation with all messages
 */
export async function getTrainingConversation(
  conversationId: string,
): Promise<TrainingConversationWithMessages | null> {
  const client = getSupabaseClient();

  const { data: conversation, error: convError } = await client
    .from("training_conversations")
    .select("id, subject, category, conversation_summary, training_type")
    .eq("id", conversationId)
    .single();

  if (convError) {
    if (convError.code === "PGRST116") return null; // Not found
    throw new DatabaseError(
      `Failed to fetch conversation: ${convError.message}`,
    );
  }

  const { data: messages, error: msgError } = await client
    .from("training_messages")
    .select("id, from_name, participant_role, content, direction, timestamp")
    .eq("conversation_id", conversationId)
    .order("timestamp", { ascending: true });

  if (msgError) {
    throw new DatabaseError(`Failed to fetch messages: ${msgError.message}`);
  }

  return {
    ...conversation,
    similarity: 1, // Not from search, full match
    messages: messages || [],
  };
}
