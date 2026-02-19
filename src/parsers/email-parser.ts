import { simpleParser, ParsedMail } from 'mailparser';
import { BaseParser } from './base-parser.js';
import { ParsingError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import type { ParseResult, ParsedAttachment } from '../types/index.js';

export class EmailParser extends BaseParser {
  readonly supportedMimeTypes = ['message/rfc822', 'application/vnd.ms-outlook'];
  readonly supportedExtensions = ['eml', 'msg'];

  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    try {
      logger.debug('Parsing email document', { filename });
      
      const parsed: ParsedMail = await simpleParser(buffer);
      
      // Build email content
      const parts: string[] = [];
      
      // Add headers
      if (parsed.from?.text) {
        parts.push(`From: ${parsed.from.text}`);
      }
      if (parsed.to) {
        const toText = Array.isArray(parsed.to) 
          ? parsed.to.map(t => t.text).join(', ')
          : parsed.to.text;
        parts.push(`To: ${toText}`);
      }
      if (parsed.subject) {
        parts.push(`Subject: ${parsed.subject}`);
      }
      if (parsed.date) {
        parts.push(`Date: ${parsed.date.toISOString()}`);
      }
      
      parts.push(''); // Empty line separator
      
      // Add body
      if (parsed.text) {
        parts.push(parsed.text);
      } else if (parsed.html) {
        // Convert HTML body to text if no plain text version
        const { convert } = await import('html-to-text');
        parts.push(convert(parsed.html, { wordwrap: false }));
      }

      const content = this.cleanText(parts.join('\n'));
      
      // Process attachments
      const attachments: ParsedAttachment[] = [];
      if (parsed.attachments && parsed.attachments.length > 0) {
        for (const att of parsed.attachments) {
          attachments.push({
            filename: att.filename || 'attachment',
            content: att.content,
            mimeType: att.contentType || 'application/octet-stream',
          });
        }
        logger.info('Email has attachments', { 
          filename, 
          attachmentCount: attachments.length 
        });
      }

      return {
        content,
        metadata: {
          title: parsed.subject || this.extractTitleFromFilename(filename),
          mimeType: 'message/rfc822',
          originalFilename: filename,
          fileSize: buffer.length,
          documentType: 'Email',
        },
        attachments,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse email', { filename, error: message });
      throw new ParsingError(`Failed to parse email: ${message}`, { filename });
    }
  }
}

