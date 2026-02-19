import { parseDocument } from '../parsers/index.js';
import { generateEmbedding } from './embedding-service.js';
import { inferMetadata } from './metadata-inference.js';
import { processForGDPR, type AuditLogEntry } from '../compliance/index.js';
import { insertDocument, insertDocumentsBatch, documentExists, documentExistsBySourcePath } from '../database/supabase-client.js';
import { processBatch, createBatchResult } from '../utils/batch-processor.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { DocumentIngestionError } from '../utils/error-handler.js';
import { chunkText, shouldChunk } from '../utils/text-chunker.js';
import type { 
  DocumentMetadata, 
  DocumentRecord, 
  IngestionOptions, 
  BatchResult,
  SourceDocument,
} from '../types/index.js';

export interface ProcessingResult {
  success: boolean;
  documentId?: string;
  /** For chunked documents, contains IDs of all chunks */
  documentIds?: string[];
  title: string;
  /** Number of chunks created (1 if not chunked) */
  chunkCount?: number;
  error?: string;
  auditLog?: AuditLogEntry;
}

/**
 * Process a single document through the full ingestion pipeline
 */
export async function processDocument(
  buffer: Buffer,
  filename: string,
  options: IngestionOptions = {},
  mimeType?: string
): Promise<ProcessingResult> {
  const startTime = Date.now();
  
  logger.info('Processing document', { filename, options });

  try {
    // 0. Early source_path deduplication check (cheap, avoids re-embedding)
    if (!options.dryRun && options.sourcePath) {
      // Check both base source_path (non-chunked docs) and #chunk1 (chunked docs)
      // This handles the case where a doc may or may not have been chunked based on size
      const baseExists = await documentExistsBySourcePath(options.sourcePath);
      const chunkExists = options.enableChunking 
        ? await documentExistsBySourcePath(`${options.sourcePath}#chunk1`)
        : false;
      
      if (baseExists || chunkExists) {
        logger.info('Document already ingested (source_path exists)', { 
          sourcePath: options.sourcePath 
        });
        return {
          success: true,
          title: filename,
          chunkCount: 0,
          error: 'Already ingested (skipped)',
        };
      }
    }

    // 1. Parse document (pass mimeType hint for sources like Notion)
    const parseResult = await parseDocument(buffer, filename, mimeType);
    
    if (!parseResult.content || parseResult.content.length < 10) {
      throw new DocumentIngestionError(
        'Document has insufficient content',
        'EMPTY_CONTENT',
        { filename }
      );
    }

    // 2. Process for GDPR compliance (PII detection)
    const gdprResult = processForGDPR(parseResult.content, {
      ...parseResult.metadata,
      title: options.documentType ? `${options.documentType}: ${parseResult.metadata.title}` : parseResult.metadata.title,
    });

    // Use processed content (possibly redacted)
    const processedContent = gdprResult.content;

    // 3. Infer metadata
    const inferredMetadata = inferMetadata(processedContent, {
      ...parseResult.metadata,
      department: options.department,
      documentType: options.documentType,
      accessLevel: options.accessLevel,
    });

    const baseTitle = parseResult.metadata.title || filename;

    // 4. Check if chunking is needed/enabled
    logger.debug('Checking chunking', { contentLength: processedContent.length, maxChunkSize: options.maxChunkSize || 2000 });
    const shouldUseChunking = options.enableChunking && 
      shouldChunk(processedContent, options.maxChunkSize || 2000);

    logger.debug('Chunking decision', { shouldUseChunking, contentLength: processedContent.length });

    if (shouldUseChunking) {
      // Process with chunking
      logger.debug('Starting chunked processing');
      return await processDocumentWithChunking(
        processedContent,
        baseTitle,
        inferredMetadata,
        gdprResult,
        options,
        startTime
      );
    }

    // 5. Generate embedding (non-chunked path)
    const { embedding } = await generateEmbedding(processedContent);

    // 6. Build final document record
    const documentRecord: DocumentRecord = {
      content: processedContent,
      embedding,
      department: inferredMetadata.department,
      document_type: inferredMetadata.documentType,
      title: baseTitle,
      owner: options.owner,
      access_level: gdprResult.accessLevel,
      tags: options.tags,
      sensitivity: gdprResult.sensitivity,
      language: inferredMetadata.language,
      source_type: options.sourceType,
      source_path: options.sourcePath,
    };

    // 7. Check for duplicates (optional, can be skipped for performance)
    if (!options.dryRun && !options.skipDuplicateCheck) {
      const exists = await documentExists(documentRecord.title, documentRecord.content);
      if (exists) {
        logger.warn('Duplicate document detected', { title: documentRecord.title });
        return {
          success: false,
          title: documentRecord.title,
          error: 'Duplicate document detected',
          auditLog: gdprResult.auditLog,
        };
      }
    }

    // 8. Insert into database
    let documentId: string | undefined;
    if (!options.dryRun) {
      documentId = await insertDocument(documentRecord);
    }

    const duration = Date.now() - startTime;
    logger.info('Document processed successfully', {
      documentId,
      title: documentRecord.title,
      department: documentRecord.department,
      documentType: documentRecord.document_type,
      sensitivity: documentRecord.sensitivity,
      piiDetected: gdprResult.piiDetected,
      durationMs: duration,
    });

    return {
      success: true,
      documentId,
      title: documentRecord.title,
      chunkCount: 1,
      auditLog: gdprResult.auditLog,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Document processing failed', { filename, error: errorMessage });
    
    return {
      success: false,
      title: filename,
      error: errorMessage,
    };
  }
}

/**
 * Process a document with chunking for better RAG retrieval
 */
async function processDocumentWithChunking(
  content: string,
  baseTitle: string,
  inferredMetadata: { department: string; documentType: string; language?: string },
  gdprResult: { accessLevel: string; sensitivity?: string; auditLog?: AuditLogEntry },
  options: IngestionOptions,
  startTime: number
): Promise<ProcessingResult> {
  logger.debug('Chunking text', { contentLength: content.length, title: baseTitle });
  
  const chunks = chunkText(content, {
    maxChunkSize: options.maxChunkSize || 2000,
    overlap: options.chunkOverlap || 100,
    splitByHeaders: true,
    preserveQA: true,
  });

  logger.debug('Chunking complete', { chunkCount: chunks.length });
  
  logger.info('Document chunked', { 
    title: baseTitle, 
    chunkCount: chunks.length,
    avgChunkSize: Math.round(content.length / chunks.length),
  });

  // Generate embeddings for all chunks
  const documentRecords: DocumentRecord[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const { embedding } = await generateEmbedding(chunk.content);
    
    // Create chunk title with section info
    let chunkTitle = baseTitle;
    if (chunks.length > 1) {
      if (chunk.metadata.section) {
        chunkTitle = `${baseTitle} - ${chunk.metadata.section}`;
      } else {
        chunkTitle = `${baseTitle} (Part ${i + 1}/${chunks.length})`;
      }
    }

    documentRecords.push({
      content: chunk.content,
      embedding,
      department: inferredMetadata.department,
      document_type: inferredMetadata.documentType,
      title: chunkTitle,
      owner: options.owner,
      access_level: gdprResult.accessLevel as any,
      tags: [
        ...(options.tags || []),
        `chunk:${i + 1}/${chunks.length}`,
        ...(chunk.metadata.isQA ? ['qa'] : []),
      ],
      sensitivity: gdprResult.sensitivity as any,
      language: inferredMetadata.language,
      source_type: options.sourceType,
      source_path: options.sourcePath ? `${options.sourcePath}#chunk${i + 1}` : undefined,
    });
  }

  // Insert all chunks
  let documentIds: string[] = [];
  if (!options.dryRun) {
    documentIds = await insertDocumentsBatch(documentRecords);
  }

  const duration = Date.now() - startTime;
  logger.info('Chunked document processed successfully', {
    title: baseTitle,
    chunkCount: chunks.length,
    documentIds: documentIds.slice(0, 3), // Log first 3 IDs
    durationMs: duration,
  });

  return {
    success: true,
    documentId: documentIds[0], // Primary chunk ID
    documentIds,
    title: baseTitle,
    chunkCount: chunks.length,
    auditLog: gdprResult.auditLog,
  };
}

/**
 * Process multiple documents in batch
 */
export async function processDocumentsBatch(
  documents: Array<{ buffer: Buffer; filename: string; options?: IngestionOptions }>,
  batchOptions: {
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<BatchResult & { auditLogs: AuditLogEntry[] }> {
  const config = getConfig();
  const auditLogs: AuditLogEntry[] = [];

  logger.info('Starting batch document processing', { documentCount: documents.length });

  const { results, errors } = await processBatch(
    documents,
    async (doc) => {
      const result = await processDocument(doc.buffer, doc.filename, doc.options);
      if (result.auditLog) {
        auditLogs.push(result.auditLog);
      }
      if (!result.success) {
        throw new Error(result.error || 'Unknown error');
      }
      return result;
    },
    {
      batchSize: config.processing.batchSize,
      concurrency: config.processing.concurrency,
      retryAttempts: config.processing.retryAttempts,
      retryDelayMs: config.processing.retryDelayMs,
      onProgress: batchOptions.onProgress,
    }
  );

  const batchResult = createBatchResult(documents.length, results, errors);

  logger.info('Batch processing complete', {
    total: batchResult.total,
    successful: batchResult.successful,
    failed: batchResult.failed,
  });

  return {
    ...batchResult,
    auditLogs,
  };
}

/**
 * Process documents from a source
 */
export async function processSourceDocuments(
  sourceDocuments: SourceDocument[],
  defaultOptions: IngestionOptions = {},
  batchOptions: {
    onProgress?: (processed: number, total: number) => void;
    downloadContent?: (doc: SourceDocument) => Promise<Buffer>;
  } = {}
): Promise<BatchResult & { auditLogs: AuditLogEntry[] }> {
  const config = getConfig();
  const auditLogs: AuditLogEntry[] = [];

  logger.info('Processing source documents', { 
    documentCount: sourceDocuments.length,
    defaultOptions,
  });

  const { results, errors } = await processBatch(
    sourceDocuments,
    async (sourceDoc) => {
      // Download content if needed
      let buffer: Buffer;
      if (sourceDoc.content) {
        buffer = sourceDoc.content;
      } else if (batchOptions.downloadContent) {
        buffer = await batchOptions.downloadContent(sourceDoc);
      } else {
        throw new Error(`No content available for document: ${sourceDoc.name}`);
      }

      // Merge source metadata with default options
      const meta = sourceDoc.metadata || {};
      const options: IngestionOptions = {
        ...defaultOptions,
        ...(meta as Partial<IngestionOptions>),
      };

      // Merge Notion-specific tags (notionTags from DB multi_select, notionDbTag)
      const notionTags = (meta.notionTags as string[]) || [];
      const notionDbTag = meta.notionDbTag as string | undefined;
      if (notionTags.length > 0 || notionDbTag) {
        options.tags = [
          ...(options.tags || []),
          ...notionTags,
          ...(notionDbTag ? [notionDbTag] : []),
        ];
      }

      // Pass mimeType from source document (important for Notion which has no file extension)
      const result = await processDocument(buffer, sourceDoc.name, options, sourceDoc.mimeType);
      if (result.auditLog) {
        auditLogs.push(result.auditLog);
      }
      if (!result.success) {
        throw new Error(result.error || 'Unknown error');
      }
      return result;
    },
    {
      batchSize: config.processing.batchSize,
      concurrency: config.processing.concurrency,
      retryAttempts: config.processing.retryAttempts,
      retryDelayMs: config.processing.retryDelayMs,
      onProgress: batchOptions.onProgress,
    }
  );

  const batchResult = createBatchResult(sourceDocuments.length, results, errors);

  return {
    ...batchResult,
    auditLogs,
  };
}

/**
 * Validate a document without ingesting it
 */
export async function validateDocument(
  buffer: Buffer,
  filename: string
): Promise<{
  valid: boolean;
  issues: string[];
  metadata?: Partial<DocumentMetadata>;
}> {
  const issues: string[] = [];
  
  try {
    // Try to parse
    const parseResult = await parseDocument(buffer, filename);
    
    if (!parseResult.content || parseResult.content.length < 10) {
      issues.push('Document has no extractable content');
    }

    if (parseResult.content.length > 100000) {
      issues.push('Document content is very large (>100K chars) - may be truncated during embedding');
    }

    // Check for PII
    const gdprResult = processForGDPR(parseResult.content, parseResult.metadata);
    if (gdprResult.piiDetected) {
      issues.push(`PII detected: ${gdprResult.piiTypes.join(', ')}`);
    }

    return {
      valid: issues.length === 0,
      issues,
      metadata: {
        ...parseResult.metadata,
        sensitivity: gdprResult.sensitivity,
        accessLevel: gdprResult.accessLevel,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    issues.push(`Parsing failed: ${errorMessage}`);
    
    return {
      valid: false,
      issues,
    };
  }
}

