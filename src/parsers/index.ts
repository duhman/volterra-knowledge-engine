import { BaseParser, getMimeTypeFromExtension } from './base-parser.js';
import { PdfParser } from './pdf-parser.js';
import { DocxParser } from './docx-parser.js';
import { XlsxParser } from './xlsx-parser.js';
import { PptxParser } from './pptx-parser.js';
import { HtmlParser } from './html-parser.js';
import { EmailParser } from './email-parser.js';
import { TextParser } from './text-parser.js';
import { SlackParser } from './slack-parser.js';
import { ParsingError } from '../utils/error-handler.js';
import { logger } from '../utils/logger.js';
import type { ParseResult } from '../types/index.js';

// Initialize all available parsers
const parsers: BaseParser[] = [
  new PdfParser(),
  new DocxParser(),
  new XlsxParser(),
  new PptxParser(),
  new HtmlParser(),
  new EmailParser(),
  new TextParser(),
  new SlackParser(),
];

/**
 * Get the appropriate parser for a given MIME type or filename
 */
export function getParser(mimeType?: string, filename?: string): BaseParser | null {
  // Try by MIME type first
  if (mimeType) {
    for (const parser of parsers) {
      if (parser.canParseMimeType(mimeType)) {
        return parser;
      }
    }
  }

  // Fallback to filename extension
  if (filename) {
    for (const parser of parsers) {
      if (parser.canParseExtension(filename)) {
        return parser;
      }
    }
  }

  return null;
}

/**
 * Parse a document using the appropriate parser
 */
export async function parseDocument(
  buffer: Buffer,
  filename?: string,
  mimeType?: string
): Promise<ParseResult> {
  // Determine MIME type if not provided
  const resolvedMimeType = mimeType || (filename ? getMimeTypeFromExtension(filename) : undefined);
  
  const parser = getParser(resolvedMimeType, filename);
  
  if (!parser) {
    const msg = `No parser available for MIME type: ${resolvedMimeType}, filename: ${filename}`;
    logger.error(msg);
    throw new ParsingError(msg, { mimeType: resolvedMimeType, filename });
  }

  logger.debug('Selected parser', { 
    parser: parser.constructor.name, 
    filename, 
    mimeType: resolvedMimeType 
  });

  return parser.parse(buffer, filename);
}

/**
 * Check if a file can be parsed
 */
export function canParse(mimeType?: string, filename?: string): boolean {
  return getParser(mimeType, filename) !== null;
}

/**
 * Get all supported MIME types
 */
export function getSupportedMimeTypes(): string[] {
  const mimeTypes = new Set<string>();
  for (const parser of parsers) {
    for (const type of parser.supportedMimeTypes) {
      mimeTypes.add(type);
    }
  }
  return Array.from(mimeTypes);
}

/**
 * Get all supported file extensions
 */
export function getSupportedExtensions(): string[] {
  const extensions = new Set<string>();
  for (const parser of parsers) {
    for (const ext of parser.supportedExtensions) {
      extensions.add(ext);
    }
  }
  return Array.from(extensions);
}

// Re-export
export { BaseParser, getMimeTypeFromExtension };
export { PdfParser } from './pdf-parser.js';
export { DocxParser } from './docx-parser.js';
export { XlsxParser } from './xlsx-parser.js';
export { PptxParser } from './pptx-parser.js';
export { HtmlParser } from './html-parser.js';
export { EmailParser } from './email-parser.js';
export { TextParser } from './text-parser.js';
export { SlackParser } from './slack-parser.js';
export { WodParser, wodParser } from './wod-parser.js';

