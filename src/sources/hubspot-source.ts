import { Client } from "@hubspot/api-client";
import { BaseSource, type ListDocumentsOptions } from "./base-source.js";
import { logger } from "../utils/logger.js";
import { SourceError } from "../utils/error-handler.js";
import { getConfig } from "../utils/config.js";
import { getSupportedExtensions } from "../parsers/index.js";
import type { SourceDocument, IngestionOptions } from "../types/index.js";

interface HubSpotFile {
  id: string;
  name: string;
  extension: string;
  type: string;
  url: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  path: string;
  access: string;
  defaultHostingUrl?: string;
}

export class HubSpotSource extends BaseSource {
  readonly name = "HubSpot";
  readonly type = "hubspot";

  private client: Client | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.HUBSPOT_API_KEY;

    if (!apiKey) {
      throw new SourceError(
        "HubSpot API key not configured. Set HUBSPOT_API_KEY environment variable.",
      );
    }

    try {
      this.client = new Client({ accessToken: apiKey });

      // Verify connection by making a simple API call
      await this.client.files.filesApi.doSearch();

      this._initialized = true;
      logger.info("HubSpot source initialized");
    } catch (error) {
      this.client = null;
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to initialize HubSpot: ${message}`);
    }
  }

  async listDocuments(
    options: ListDocumentsOptions = {},
  ): Promise<SourceDocument[]> {
    if (!this.client) {
      throw new SourceError("HubSpot source not initialized");
    }

    const config = getConfig();
    const documents: SourceDocument[] = [];
    const supportedExtensions = options.fileTypes || getSupportedExtensions();
    let after: string | undefined;

    try {
      do {
        const response = await this.client.files.filesApi.doSearch(
          undefined, // properties
          after, // after
          undefined, // before
          Math.min(options.limit || config.sources.hubspot.pageSize, 100), // limit
        );

        for (const file of response.results) {
          const fileData = file as unknown as HubSpotFile;

          // Filter by extension
          const ext = fileData.extension?.toLowerCase() || "";
          if (!supportedExtensions.includes(ext)) {
            continue;
          }

          // Filter by path if specified
          if (options.path && !fileData.path.startsWith(options.path)) {
            continue;
          }

          documents.push({
            id: fileData.id,
            name: fileData.name,
            mimeType: fileData.type || "application/octet-stream",
            downloadUrl: fileData.url || fileData.defaultHostingUrl,
            metadata: {
              path: fileData.path,
              size: fileData.size,
              createdAt: fileData.createdAt,
              updatedAt: fileData.updatedAt,
              access: fileData.access,
            },
          });

          if (options.limit && documents.length >= options.limit) {
            break;
          }
        }

        // Get pagination cursor
        after = response.paging?.next?.after;
      } while (after && (!options.limit || documents.length < options.limit));

      logger.info("Listed HubSpot files", { count: documents.length });
      return documents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to list HubSpot files: ${message}`);
    }
  }

  async downloadDocument(document: SourceDocument): Promise<Buffer> {
    if (!this.client) {
      throw new SourceError("HubSpot source not initialized");
    }

    try {
      // Get signed URL for download
      const fileDetails = await this.client.files.filesApi.getById(document.id);
      const downloadUrl =
        (fileDetails as unknown as HubSpotFile).url || document.downloadUrl;

      if (!downloadUrl) {
        throw new Error("No download URL available for file");
      }

      // Download the file
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      logger.debug("Downloaded HubSpot file", {
        id: document.id,
        name: document.name,
        size: buffer.length,
      });

      return buffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to download HubSpot file: ${message}`, {
        fileId: document.id,
      });
    }
  }

  /**
   * List files in a specific folder
   * Note: HubSpot API v3 has limited folder filtering support
   */
  async listFilesInFolder(_folderId: string): Promise<SourceDocument[]> {
    if (!this.client) {
      throw new SourceError("HubSpot source not initialized");
    }

    const documents: SourceDocument[] = [];
    const supportedExtensions = getSupportedExtensions();

    try {
      // Note: HubSpot API v3 doesn't support direct folder filtering in search
      // This is a simplified implementation that lists all files
      const response = await this.client.files.filesApi.doSearch();

      for (const file of response.results) {
        const fileData = file as unknown as HubSpotFile;
        const ext = fileData.extension?.toLowerCase() || "";

        if (supportedExtensions.includes(ext)) {
          documents.push({
            id: fileData.id,
            name: fileData.name,
            mimeType: fileData.type || "application/octet-stream",
            downloadUrl: fileData.url,
            metadata: {
              path: fileData.path,
              size: fileData.size,
              createdAt: fileData.createdAt,
              updatedAt: fileData.updatedAt,
            },
          });
        }
      }

      return documents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to list HubSpot folder: ${message}`);
    }
  }

  getDefaultIngestionOptions(): Partial<IngestionOptions> {
    return {
      accessLevel: "internal",
      department: "Commercial", // HubSpot is typically used by sales/marketing
    };
  }

  isConfigured(): boolean {
    return !!process.env.HUBSPOT_API_KEY;
  }
}
