import { BaseParser } from './base-parser.js';
import { ParsingError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import type { ParseResult } from '../types/index.js';

export class TextParser extends BaseParser {
  readonly supportedMimeTypes = [
    'text/plain',
    'text/markdown',
    'application/json',
    'application/xml',
    'text/xml',
  ];
  readonly supportedExtensions = ['txt', 'md', 'markdown', 'json', 'xml', 'log', 'rtf'];

  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    try {
      logger.debug('Parsing text document', { filename });
      
      // Try UTF-8 first, then fallback to latin1
      let text: string;
      try {
        text = buffer.toString('utf-8');
        // Check for invalid UTF-8 sequences
        if (text.includes('\ufffd')) {
          text = buffer.toString('latin1');
        }
      } catch {
        text = buffer.toString('latin1');
      }

      const content = this.cleanText(text);
      const mimeType = this.detectMimeType(filename, content);

      return {
        content,
        metadata: {
          title: this.extractTitleFromFilename(filename),
          mimeType,
          originalFilename: filename,
          fileSize: buffer.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse text file', { filename, error: message });
      throw new ParsingError(`Failed to parse text file: ${message}`, { filename });
    }
  }

  private detectMimeType(filename?: string, content?: string): string {
    if (filename) {
      const ext = filename.toLowerCase().split('.').pop();
      switch (ext) {
        case 'md':
        case 'markdown':
          return 'text/markdown';
        case 'json':
          return 'application/json';
        case 'xml':
          return 'application/xml';
        default:
          break;
      }
    }

    // Try to detect from content
    if (content) {
      const trimmed = content.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return 'application/json';
      }
      if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
        return 'application/xml';
      }
    }

    return 'text/plain';
  }
}

