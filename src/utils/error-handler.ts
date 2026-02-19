import { logger } from './logger.js';
import type { BatchError } from '../types/index.js';

export class DocumentIngestionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DocumentIngestionError';
  }
}

export class ParsingError extends DocumentIngestionError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PARSING_ERROR', context);
    this.name = 'ParsingError';
  }
}

export class EmbeddingError extends DocumentIngestionError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'EMBEDDING_ERROR', context);
    this.name = 'EmbeddingError';
  }
}

export class DatabaseError extends DocumentIngestionError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', context);
    this.name = 'DatabaseError';
  }
}

export class SourceError extends DocumentIngestionError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SOURCE_ERROR', context);
    this.name = 'SourceError';
  }
}

export class ComplianceError extends DocumentIngestionError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'COMPLIANCE_ERROR', context);
    this.name = 'ComplianceError';
  }
}

export function handleError(error: unknown, identifier?: string): BatchError {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorDetails = error instanceof DocumentIngestionError ? error.context : undefined;

  logger.error('Document processing failed', {
    identifier,
    error: errorMessage,
    details: errorDetails,
  });

  return {
    identifier: identifier || 'unknown',
    error: errorMessage,
    timestamp: new Date(),
  };
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof EmbeddingError) {
    // Retry on rate limits but NOT on timeouts or aborts
    const message = error.message.toLowerCase();
    if (message.includes('timeout') || message.includes('abort') || message.includes('cancel')) {
      return false;
    }
    return message.includes('rate') || message.includes('429') || message.includes('temporary');
  }
  if (error instanceof DatabaseError) {
    // Retry on connection issues
    const message = error.message.toLowerCase();
    return message.includes('connection') || message.includes('timeout');
  }
  if (error instanceof SourceError) {
    // Retry on network issues
    const message = error.message.toLowerCase();
    return message.includes('network') || message.includes('timeout') || message.includes('rate');
  }
  return false;
}

