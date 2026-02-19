/**
 * Volterra Document Ingestion System
 * 
 * Main entry point for programmatic usage.
 * For CLI usage, see the scripts in src/scripts/
 */

// Core exports
export { processDocument, processDocumentsBatch, processSourceDocuments, validateDocument } from './core/document-processor.js';
export { generateEmbedding, generateEmbeddingsBatch, cosineSimilarity } from './core/embedding-service.js';
export { inferMetadata, determineSensitivity, upgradeAccessLevelForPII } from './core/metadata-inference.js';

// Parser exports
export { parseDocument, canParse, getSupportedMimeTypes, getSupportedExtensions } from './parsers/index.js';

// Source exports
export { createSource, getConfiguredSources, getSourceStatus, BaseSource } from './sources/index.js';
export { FileSource } from './sources/file-source.js';
export { NotionSource } from './sources/notion-source.js';
export { SharePointSource } from './sources/sharepoint-source.js';
export { HubSpotSource } from './sources/hubspot-source.js';

// Database exports
export { getSupabaseClient, insertDocument, insertDocumentsBatch, searchDocuments, documentExists, deleteDocument } from './database/supabase-client.js';

// Compliance exports
export { detectPII, redactPII, containsPII, processForGDPR, validateGDPRCompliance, generateComplianceReport } from './compliance/index.js';

// Utility exports
export { logger, createChildLogger } from './utils/logger.js';
export { processBatch, createBatchResult } from './utils/batch-processor.js';
export { loadConfig, getConfig } from './utils/config.js';
export { 
  DocumentIngestionError, 
  ParsingError, 
  EmbeddingError, 
  DatabaseError, 
  SourceError, 
  ComplianceError,
  handleError,
  isRetryableError,
} from './utils/error-handler.js';

// Type exports
export type {
  DocumentMetadata,
  ParseResult,
  ParsedAttachment,
  ProcessedDocument,
  PIIEntity,
  DocumentRecord,
  AccessLevel,
  Sensitivity,
  SourceType,
  IngestionOptions,
  BatchResult,
  BatchError,
  SourceDocument,
  Config,
} from './types/index.js';

