import { parseOfficeAsync } from 'officeparser';
import { BaseParser } from './base-parser.js';
import { ParsingError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import type { ParseResult } from '../types/index.js';

export class PptxParser extends BaseParser {
  readonly supportedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
  ];
  readonly supportedExtensions = ['pptx', 'ppt'];

  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    try {
      logger.debug('Parsing PPTX document', { filename });

      const content = await parseOfficeAsync(buffer, {
        newlineDelimiter: '\n',
        ignoreNotes: false, // Include speaker notes for additional context
        putNotesAtLast: true, // Organize notes after main slide content
      });

      if (!content || content.length === 0) {
        throw new ParsingError('No text content extracted from PPTX', { filename });
      }

      const cleanedContent = this.cleanText(content);

      return {
        content: cleanedContent,
        metadata: {
          title: this.extractTitleFromFilename(filename),
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          originalFilename: filename,
          fileSize: buffer.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse PPTX', { filename, error: message });
      throw new ParsingError(`Failed to parse PPTX: ${message}`, { filename });
    }
  }
}
