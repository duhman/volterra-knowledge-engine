import { Client } from '@microsoft/microsoft-graph-client';
import { BaseSource, type ListDocumentsOptions } from './base-source.js';
import { logger } from '../utils/logger.js';
import { SourceError } from '../utils/error-handler.js';
import { getConfig } from '../utils/config.js';
import { getSupportedExtensions } from '../parsers/index.js';
import type { SourceDocument, IngestionOptions } from '../types/index.js';

interface SharePointDriveItem {
  id: string;
  name: string;
  file?: {
    mimeType: string;
  };
  folder?: object;
  webUrl: string;
  size?: number;
  createdDateTime: string;
  lastModifiedDateTime: string;
  createdBy?: {
    user?: { displayName: string; email: string };
  };
  lastModifiedBy?: {
    user?: { displayName: string; email: string };
  };
  '@microsoft.graph.downloadUrl'?: string;
}

export class SharePointSource extends BaseSource {
  readonly name = 'SharePoint';
  readonly type = 'sharepoint';

  private client: Client | null = null;
  private siteId: string | null = null;
  private accessToken: string | null = null;

  async initialize(): Promise<void> {
    const clientId = process.env.SHAREPOINT_CLIENT_ID;
    const clientSecret = process.env.SHAREPOINT_CLIENT_SECRET;
    const tenantId = process.env.SHAREPOINT_TENANT_ID;
    this.siteId = process.env.SHAREPOINT_SITE_ID || null;

    if (!clientId || !clientSecret || !tenantId) {
      throw new SourceError(
        'SharePoint credentials not configured. Set SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET, and SHAREPOINT_TENANT_ID.'
      );
    }

    try {
      // Get access token using client credentials flow
      this.accessToken = await this.getAccessToken(clientId, clientSecret, tenantId);

      // Initialize Graph client
      this.client = Client.init({
        authProvider: (done) => {
          done(null, this.accessToken!);
        },
      });

      logger.info('SharePoint source initialized', { siteId: this.siteId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to initialize SharePoint: ${message}`);
    }
  }

  private async getAccessToken(
    clientId: string,
    clientSecret: string,
    tenantId: string
  ): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.statusText}`);
    }

    const data = await response.json() as { access_token: string };
    return data.access_token;
  }

  async listDocuments(options: ListDocumentsOptions = {}): Promise<SourceDocument[]> {
    if (!this.client) {
      throw new SourceError('SharePoint source not initialized');
    }

    const config = getConfig();
    const documents: SourceDocument[] = [];
    const supportedExtensions = options.fileTypes || getSupportedExtensions();

    try {
      // Build the API path
      let apiPath: string;
      if (this.siteId) {
        apiPath = options.path
          ? `/sites/${this.siteId}/drive/root:/${options.path}:/children`
          : `/sites/${this.siteId}/drive/root/children`;
      } else {
        apiPath = options.path
          ? `/me/drive/root:/${options.path}:/children`
          : `/me/drive/root/children`;
      }

      let response = await this.client.api(apiPath)
        .top(options.limit || config.sources.sharepoint.pageSize)
        .get() as { value: SharePointDriveItem[]; '@odata.nextLink'?: string };

      await this.processItems(response.value, documents, supportedExtensions, options.limit);

      // Handle pagination
      while (response['@odata.nextLink'] && (!options.limit || documents.length < options.limit)) {
        response = await this.client.api(response['@odata.nextLink']).get() as { value: SharePointDriveItem[]; '@odata.nextLink'?: string };
        await this.processItems(response.value, documents, supportedExtensions, options.limit);
      }

      logger.info('Listed SharePoint documents', { count: documents.length });
      return documents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to list SharePoint documents: ${message}`);
    }
  }

  private async processItems(
    items: SharePointDriveItem[],
    documents: SourceDocument[],
    supportedExtensions: string[],
    limit?: number
  ): Promise<void> {
    for (const item of items) {
      if (limit && documents.length >= limit) break;

      if (item.file) {
        // It's a file
        const ext = item.name.split('.').pop()?.toLowerCase() || '';
        if (supportedExtensions.includes(ext)) {
          documents.push({
            id: item.id,
            name: item.name,
            mimeType: item.file.mimeType,
            downloadUrl: item['@microsoft.graph.downloadUrl'],
            metadata: {
              webUrl: item.webUrl,
              size: item.size,
              createdAt: item.createdDateTime,
              modifiedAt: item.lastModifiedDateTime,
              createdBy: item.createdBy?.user?.displayName,
              modifiedBy: item.lastModifiedBy?.user?.displayName,
            },
          });
        }
      } else if (item.folder && this.client) {
        // It's a folder - recursively list contents
        try {
          const folderPath = this.siteId
            ? `/sites/${this.siteId}/drive/items/${item.id}/children`
            : `/me/drive/items/${item.id}/children`;
          
          const folderResponse = await this.client.api(folderPath).get();
          await this.processItems(folderResponse.value, documents, supportedExtensions, limit);
        } catch (error) {
          logger.warn('Failed to list folder contents', { 
            folder: item.name, 
            error: error instanceof Error ? error.message : String(error) 
          });
        }
      }
    }
  }

  async downloadDocument(document: SourceDocument): Promise<Buffer> {
    if (!this.client) {
      throw new SourceError('SharePoint source not initialized');
    }

    try {
      // Use download URL if available
      if (document.downloadUrl) {
        const response = await fetch(document.downloadUrl);
        if (!response.ok) {
          throw new Error(`Download failed: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      // Otherwise use Graph API
      const apiPath = this.siteId
        ? `/sites/${this.siteId}/drive/items/${document.id}/content`
        : `/me/drive/items/${document.id}/content`;

      const response = await this.client.api(apiPath).getStream();
      
      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      
      const buffer = Buffer.concat(chunks);
      
      logger.debug('Downloaded SharePoint document', { 
        id: document.id, 
        name: document.name,
        size: buffer.length,
      });

      return buffer;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to download SharePoint document: ${message}`, {
        documentId: document.id,
      });
    }
  }

  getDefaultIngestionOptions(): Partial<IngestionOptions> {
    return {
      accessLevel: 'internal',
    };
  }

  isConfigured(): boolean {
    return !!(
      process.env.SHAREPOINT_CLIENT_ID &&
      process.env.SHAREPOINT_CLIENT_SECRET &&
      process.env.SHAREPOINT_TENANT_ID
    );
  }
}

