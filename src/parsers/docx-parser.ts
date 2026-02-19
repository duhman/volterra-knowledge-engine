import mammoth from 'mammoth';
import { BaseParser } from './base-parser.js';
import { ParsingError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import type { ParseResult } from '../types/index.js';

export class DocxParser extends BaseParser {
  readonly supportedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
  ];
  readonly supportedExtensions = ['docx', 'doc'];

  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    try {
      logger.debug('Parsing DOCX document', { filename });
      
      const result = await mammoth.extractRawText({ buffer });
      
      if (result.messages.length > 0) {
        logger.warn('DOCX parsing warnings', { 
          filename, 
          warnings: result.messages.map(m => m.message) 
        });
      }

      const content = this.cleanText(result.value);

      return {
        content,
        metadata: {
          title: this.extractTitleFromFilename(filename),
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          originalFilename: filename,
          fileSize: buffer.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse DOCX', { filename, error: message });
      throw new ParsingError(`Failed to parse DOCX: ${message}`, { filename });
    }
  }
}

