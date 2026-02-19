import type { SourceDocument, IngestionOptions } from "../types/index.js";

/**
 * Abstract base class for document sources
 * All sources must implement the listDocuments and downloadDocument methods
 */
export abstract class BaseSource {
  /**
   * Human-readable name of the source
   */
  abstract readonly name: string;

  /**
   * Source type identifier
   */
  abstract readonly type: string;

  /**
   * Tracks whether initialize() has been called successfully
   */
  protected _initialized = false;

  /**
   * Initialize the source (authenticate, etc.)
   * Sets _initialized to true on success
   */
  abstract initialize(): Promise<void>;

  /**
   * Check if the source has been initialized
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Initialize the source if not already initialized
   * Safe to call multiple times - only initializes once
   * @throws SourceError if initialization fails
   */
  async ensureInitialized(): Promise<void> {
    if (!this._initialized) {
      await this.initialize();
      this._initialized = true;
    }
  }

  /**
   * List available documents from the source
   * @param options - Filtering and pagination options
   */
  abstract listDocuments(
    options?: ListDocumentsOptions,
  ): Promise<SourceDocument[]>;

  /**
   * Download a document's content
   * @param document - The document to download
   */
  abstract downloadDocument(document: SourceDocument): Promise<Buffer>;

  /**
   * Get default ingestion options for this source
   */
  getDefaultIngestionOptions(): Partial<IngestionOptions> {
    return {};
  }

  /**
   * Check if the source is properly configured (has required env vars, etc.)
   * Note: A source can be configured but not yet initialized
   */
  abstract isConfigured(): boolean;
}

export interface ListDocumentsOptions {
  /** Filter by folder/path */
  path?: string;
  /** Filter by file types (extensions) */
  fileTypes?: string[];
  /** Maximum number of documents to return */
  limit?: number;
  /** Pagination cursor/token */
  cursor?: string;
  /** Include documents modified after this date */
  modifiedAfter?: Date;
  /** Custom filters specific to the source */
  customFilters?: Record<string, unknown>;
}
