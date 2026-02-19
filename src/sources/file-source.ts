import { readFile, readdir, stat } from "fs/promises";
import { join, extname, basename } from "path";
import { BaseSource, type ListDocumentsOptions } from "./base-source.js";
import {
  getMimeTypeFromExtension,
  getSupportedExtensions,
} from "../parsers/index.js";
import { logger } from "../utils/logger.js";
import { SourceError } from "../utils/error-handler.js";
import type { SourceDocument, IngestionOptions } from "../types/index.js";

export class FileSource extends BaseSource {
  readonly name = "Local File System";
  readonly type = "file";

  private basePath: string;

  constructor(basePath: string = process.cwd()) {
    super();
    this.basePath = basePath;
  }

  async initialize(): Promise<void> {
    // Verify base path exists
    try {
      const stats = await stat(this.basePath);
      if (!stats.isDirectory()) {
        throw new SourceError(`Base path is not a directory: ${this.basePath}`);
      }
      this._initialized = true;
      logger.info("File source initialized", { basePath: this.basePath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SourceError(`Base path does not exist: ${this.basePath}`);
      }
      throw error;
    }
  }

  async listDocuments(
    options: ListDocumentsOptions = {},
  ): Promise<SourceDocument[]> {
    const targetPath = options.path
      ? join(this.basePath, options.path)
      : this.basePath;
    const supportedExtensions = options.fileTypes || getSupportedExtensions();
    const documents: SourceDocument[] = [];

    await this.scanDirectory(
      targetPath,
      documents,
      supportedExtensions,
      options.limit,
    );

    // Note: Modification date filtering would require storing mtime in metadata during scan

    logger.info("Listed documents from file source", {
      path: targetPath,
      count: documents.length,
    });

    return documents;
  }

  private async scanDirectory(
    dirPath: string,
    documents: SourceDocument[],
    supportedExtensions: string[],
    limit?: number,
  ): Promise<void> {
    if (limit && documents.length >= limit) return;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (limit && documents.length >= limit) break;

        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // Skip hidden directories and common non-document directories
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "__pycache__"
          ) {
            continue;
          }
          await this.scanDirectory(
            fullPath,
            documents,
            supportedExtensions,
            limit,
          );
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase().slice(1);

          if (supportedExtensions.includes(ext)) {
            const stats = await stat(fullPath);
            const mimeType = getMimeTypeFromExtension(entry.name);

            documents.push({
              id: fullPath,
              name: entry.name,
              mimeType,
              metadata: {
                path: fullPath,
                relativePath: fullPath
                  .replace(this.basePath, "")
                  .replace(/^\//, ""),
                size: stats.size,
                modifiedAt: stats.mtime,
              },
            });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Error scanning directory", {
        path: dirPath,
        error: message,
      });
    }
  }

  async downloadDocument(document: SourceDocument): Promise<Buffer> {
    const filePath = document.id; // ID is the full path for file source

    try {
      const buffer = await readFile(filePath);
      logger.debug("Downloaded file", { path: filePath, size: buffer.length });
      return buffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to read file: ${message}`, {
        path: filePath,
      });
    }
  }

  /**
   * Read a single file directly
   */
  async readFile(
    filePath: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const fullPath = filePath.startsWith("/")
      ? filePath
      : join(this.basePath, filePath);
    const buffer = await readFile(fullPath);
    return {
      buffer,
      filename: basename(fullPath),
    };
  }

  getDefaultIngestionOptions(): Partial<IngestionOptions> {
    return {
      accessLevel: "internal",
    };
  }

  isConfigured(): boolean {
    return true; // File source is always available
  }
}
