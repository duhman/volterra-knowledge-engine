import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseSource, type ListDocumentsOptions } from './base-source.js';
import { SlackParser, type SlackThread } from '../parsers/slack-parser.js';
import { logger } from '../utils/logger.js';
import type { SourceDocument, IngestionOptions } from '../types/index.js';

export interface SlackSourceOptions {
  exportPath: string;
  channels?: string[];
}

/**
 * Default channels to ingest from Slack export
 */
export const DEFAULT_SLACK_CHANNELS = [
  'allwinsnolosses',
  'general',
  'help-me-cpms-ampeco',
  'help-me-crm-hubspot',
  'help-me-customer-and-driver-care',
  'help-me-data-and-insights',
  'help-me-delivery',
  'help-me-drivers-portal',
  'help-me-volterra-app',
  'help-me-hardware',
  'help-me-helix-portal',
  'help-me-platform',
  'help-me-payments',
  'platform-everyone',
  'platform-all-deliveries',
  'pt-managment',
];

/**
 * Map channel names to departments
 */
const CHANNEL_DEPARTMENT_MAP: Record<string, string> = {
  'allwinsnolosses': 'sales',
  'general': 'company',
  'help-me-cpms-ampeco': 'platform',
  'help-me-crm-hubspot': 'sales',
  'help-me-customer-and-driver-care': 'customer-success',
  'help-me-data-and-insights': 'data',
  'help-me-delivery': 'operations',
  'help-me-drivers-portal': 'platform',
  'help-me-volterra-app': 'platform',
  'help-me-hardware': 'operations',
  'help-me-helix-portal': 'platform',
  'help-me-platform': 'platform',
  'help-me-payments': 'finance',
  'platform-everyone': 'platform',
  'platform-all-deliveries': 'platform',
  'pt-managment': 'platform',
};

/**
 * Source for reading Slack export data from local filesystem
 */
export class SlackSource extends BaseSource {
  readonly name = 'Slack Export';
  readonly type = 'slack';

  private exportPath: string;
  private channels: string[];
  private parser: SlackParser;

  constructor(options: SlackSourceOptions) {
    super();
    this.exportPath = options.exportPath;
    this.channels = options.channels || DEFAULT_SLACK_CHANNELS;
    this.parser = new SlackParser();
  }

  async initialize(): Promise<void> {
    // Verify export path exists
    try {
      await fs.access(this.exportPath);
      logger.info('Slack export path verified', { path: this.exportPath });
    } catch {
      throw new Error(`Slack export path not found: ${this.exportPath}`);
    }
  }

  isConfigured(): boolean {
    return !!this.exportPath;
  }

  /**
   * List all documents (threads) from configured channels
   */
  async listDocuments(options?: ListDocumentsOptions): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];
    const limit = options?.limit;
    let totalCount = 0;

    for (const channel of this.channels) {
      if (limit && totalCount >= limit) break;

      const channelDocs = await this.listChannelDocuments(channel);
      
      for (const doc of channelDocs) {
        if (limit && totalCount >= limit) break;
        documents.push(doc);
        totalCount++;
      }
    }

    logger.info('Listed Slack documents', { 
      channelCount: this.channels.length,
      documentCount: documents.length,
    });

    return documents;
  }

  /**
   * List all thread documents from a specific channel
   */
  async listChannelDocuments(channel: string): Promise<SourceDocument[]> {
    const channelPath = path.join(this.exportPath, channel);
    
    try {
      await fs.access(channelPath);
    } catch {
      logger.warn('Channel folder not found', { channel, path: channelPath });
      return [];
    }

    // Read all JSON files in channel folder
    const files = await fs.readdir(channelPath);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    logger.info('Processing channel', { channel, fileCount: jsonFiles.length });

    // Load all messages from all files
    const fileContents: Array<{ buffer: Buffer; filename: string }> = [];
    
    for (const file of jsonFiles) {
      const filePath = path.join(channelPath, file);
      const buffer = await fs.readFile(filePath);
      fileContents.push({ buffer, filename: filePath });
    }

    // Parse and group into threads
    const threads = this.parser.parseChannelExport(fileContents, channel);

    // Convert threads to SourceDocuments
    const documents: SourceDocument[] = threads.map(thread => 
      this.threadToSourceDocument(thread, channel)
    );

    logger.info('Channel processed', { 
      channel, 
      threadCount: threads.length,
      messageCount: threads.reduce((sum, t) => sum + t.messageCount, 0),
    });

    return documents;
  }

  /**
   * Download document content (threads are pre-loaded, so just return content)
   */
  async downloadDocument(document: SourceDocument): Promise<Buffer> {
    if (document.content) {
      return document.content;
    }
    throw new Error('Document content not available');
  }

  /**
   * Get default ingestion options for Slack
   */
  override getDefaultIngestionOptions(): Partial<IngestionOptions> {
    return {
      accessLevel: 'internal',
      enableChunking: true,
      maxChunkSize: 3000, // Threads can be longer
      chunkOverlap: 150,
    };
  }

  /**
   * Convert a SlackThread to SourceDocument
   */
  private threadToSourceDocument(thread: SlackThread, channel: string): SourceDocument {
    const formatted = this.parser.formatThreadAsDocument(thread);
    const department = CHANNEL_DEPARTMENT_MAP[channel] || 'general';
    const isHelpChannel = channel.startsWith('help-me-');

    const tags = ['slack', channel];
    if (isHelpChannel) {
      tags.push('support-request');
    }

    return {
      id: `slack-${channel}-${thread.threadTs}`,
      name: formatted.title,
      content: Buffer.from(formatted.content, 'utf-8'),
      mimeType: 'text/markdown',
      metadata: {
        ...formatted.metadata,
        department,
        documentType: thread.replies.length > 0 ? 'slack-thread' : 'slack-message',
        tags,
        sourceType: 'slack',
        sourcePath: `slack://${channel}/${thread.threadTs}`,
      },
    };
  }

  /**
   * Get statistics about the export
   */
  async getExportStats(): Promise<{
    channels: Array<{ name: string; fileCount: number; exists: boolean }>;
    totalFiles: number;
  }> {
    const stats: Array<{ name: string; fileCount: number; exists: boolean }> = [];
    let totalFiles = 0;

    for (const channel of this.channels) {
      const channelPath = path.join(this.exportPath, channel);
      
      try {
        const files = await fs.readdir(channelPath);
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        stats.push({ name: channel, fileCount: jsonFiles.length, exists: true });
        totalFiles += jsonFiles.length;
      } catch {
        stats.push({ name: channel, fileCount: 0, exists: false });
      }
    }

    return { channels: stats, totalFiles };
  }
}
