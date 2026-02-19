import { convert } from 'html-to-text';
import { BaseParser } from './base-parser.js';
import { ParsingError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import type { ParseResult } from '../types/index.js';

export class HtmlParser extends BaseParser {
  readonly supportedMimeTypes = ['text/html', 'application/xhtml+xml'];
  readonly supportedExtensions = ['html', 'htm', 'xhtml'];

  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    try {
      logger.debug('Parsing HTML document', { filename });
      
      const html = buffer.toString('utf-8');
      
      // Extract title from HTML if present
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const extractedTitle = titleMatch ? titleMatch[1].trim() : undefined;
      
      // Convert HTML to plain text
      const text = convert(html, {
        wordwrap: false,
        preserveNewlines: true,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: 'nav', format: 'skip' },
          { selector: 'footer', format: 'skip' },
          { selector: 'header', format: 'skip' },
        ],
      });

      const content = this.cleanText(text);

      return {
        content,
        metadata: {
          title: extractedTitle || this.extractTitleFromFilename(filename),
          mimeType: 'text/html',
          originalFilename: filename,
          fileSize: buffer.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse HTML', { filename, error: message });
      throw new ParsingError(`Failed to parse HTML: ${message}`, { filename });
    }
  }
}

