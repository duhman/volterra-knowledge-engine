/**
 * Type definitions for HubSpot ticket export system
 * Schema version: 1.0
 *
 * These types define the structure of exported tickets in JSONL format,
 * optimized for LLM RAG (Retrieval Augmented Generation) systems.
 */

/**
 * Individual message within a conversation
 */
export interface ExportedMessage {
  id: string;
  timestamp: string;
  from_name: string | null;
  from_email: string;
  participant_role: string | null; // 'customer', 'support'
  direction: string | null; // 'inbound', 'outbound'
  content: string;
  subject: string | null;
  content_type: string | null; // 'email', 'note', etc.
  engagement_type: string | null; // 'EMAIL', 'NOTE', etc.
}

/**
 * Complete ticket export with metadata and full conversation
 * Optimized for vector database ingestion
 */
export interface ExportedTicket {
  // Identifiers
  id: string;
  hubspot_ticket_id: string;

  // Core Metadata
  subject: string;
  category: string | null;
  subcategory: string | null;
  create_date: string; // ISO 8601
  status: string | null;
  priority: string | null;
  pipeline: string | null;
  training_type: string | null;
  associated_emails: string | null;
  primary_language: string | null;

  // Conversation Details
  thread_length: number | null;
  participant_count: number | null;
  hs_num_times_contacted: number | null;

  // Structured Messages (chronological)
  messages: ExportedMessage[];

  // RAG-Optimized Fields
  conversation_text: string; // Formatted full conversation for embeddings
  conversation_summary: string | null; // From database if available
  message_count: number; // Computed from messages array

  // Metadata
  has_embedding: boolean; // Whether ticket already has vector embedding
  export_metadata: {
    exported_at: string; // ISO 8601 timestamp
    schema_version: "1.0";
  };
}

/**
 * CLI options for export script
 */
export interface ExportOptions {
  output: string;
  startDate: string;
  endDate: string;
  batchSize: number;
  withCategoriesOnly: boolean;
  compress: boolean;
  dryRun: boolean;
}

/**
 * Database row types (from PostgreSQL)
 */
export interface ConversationRow {
  id: string;
  hubspot_ticket_id: string;
  subject: string;
  category: string | null;
  subcategory: string | null;
  create_date: string;
  status: string | null;
  priority: string | null;
  pipeline: string | null;
  training_type: string | null;
  associated_emails: string | null;
  primary_language: string | null;
  thread_length: number | null;
  participant_count: number | null;
  hs_num_times_contacted: number | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  timestamp: string;
  from_name: string | null;
  from_email: string;
  participant_role: string | null;
  direction: string | null;
  content: string;
  subject: string | null;
  content_type: string | null;
  engagement_type: string | null;
}

/**
 * Count query options
 */
export interface CountOptions {
  startDate: string;
  endDate: string;
  categoriesOnly: boolean;
}

/**
 * Fetch options for conversations
 */
export interface FetchOptions extends CountOptions {
  limit: number;
  offset: number;
}
