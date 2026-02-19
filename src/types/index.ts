/**
 * Core type definitions for the document ingestion system
 */

// Re-export WoD types
export * from './wod.js';

// Re-export Database types from Supabase
export type { Database, Tables, TablesInsert, TablesUpdate } from './database.types.js';

export interface DocumentMetadata {
  department?: string;
  documentType?: string;
  title: string;
  owner?: string;
  accessLevel: AccessLevel;
  tags?: string[];
  sensitivity?: Sensitivity;
  language?: string;
  sourceType: SourceType;
  sourcePath?: string;
  originalFilename?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface ParseResult {
  content: string;
  metadata: Partial<DocumentMetadata>;
  attachments?: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string;
  content: Buffer;
  mimeType: string;
}

export interface ProcessedDocument {
  content: string;
  embedding: number[];
  metadata: DocumentMetadata;
  piiDetected: boolean;
  piiEntities?: PIIEntity[];
}

export interface PIIEntity {
  type: string;
  value: string;
  start: number;
  end: number;
}

export interface DocumentRecord {
  id?: string;
  content: string;
  embedding: number[];
  department: string;
  document_type: string;
  title: string;
  owner?: string;
  access_level: AccessLevel;
  tags?: string[];
  sensitivity?: Sensitivity;
  language?: string;
  source_type?: SourceType;
  source_path?: string;
  created_at?: string;
  updated_at?: string;
}

export type AccessLevel = 'public' | 'internal' | 'restricted' | 'confidential';

export type Sensitivity = 'GDPR' | 'PII' | 'None';

export type SourceType = 'file' | 'notion' | 'sharepoint' | 'hubspot' | 'email' | 'slack';

export interface IngestionOptions {
  department?: string;
  documentType?: string;
  owner?: string;
  accessLevel?: AccessLevel;
  tags?: string[];
  skipPiiDetection?: boolean;
  dryRun?: boolean;
  /** Skip title/content duplicate check (faster for bulk imports with source_path dedup) */
  skipDuplicateCheck?: boolean;
  /** Enable chunking for long documents (for better RAG retrieval) */
  enableChunking?: boolean;
  /** Maximum chunk size in characters (default: 2000) */
  maxChunkSize?: number;
  /** Chunk overlap in characters (default: 100) */
  chunkOverlap?: number;
  /** Source type for tracking origin */
  sourceType?: SourceType;
  /** Source path/identifier for deduplication */
  sourcePath?: string;
}

export interface BatchResult {
  total: number;
  successful: number;
  failed: number;
  errors: BatchError[];
}

export interface BatchError {
  identifier: string;
  error: string;
  timestamp: Date;
}

export interface SourceDocument {
  id: string;
  name: string;
  content?: Buffer;
  mimeType: string;
  metadata?: Record<string, unknown>;
  downloadUrl?: string;
}

export interface Config {
  embedding: {
    model: string;
    dimensions: number;
    maxTokensPerRequest: number;
    batchSize: number;
  };
  processing: {
    batchSize: number;
    concurrency: number;
    retryAttempts: number;
    retryDelayMs: number;
  };
  compliance: {
    piiDetection: {
      enabled: boolean;
      mode: 'flag' | 'redact';
      entities: string[];
    };
    gdpr: {
      autoFlagPII: boolean;
      defaultSensitivity: string;
    };
  };
  metadataInference: {
    departments: Record<string, string[]>;
    documentTypes: Record<string, string[]>;
    accessLevels: Record<string, string>;
  };
  sources: {
    notion: { pageSize: number };
    sharepoint: { apiVersion: string; pageSize: number };
    hubspot: { pageSize: number };
  };
  logging: {
    level: string;
    format: string;
    timestampFormat: string;
  };
  n8n?: {
    apiUrl: string;
    timeout: number;
  };
}

