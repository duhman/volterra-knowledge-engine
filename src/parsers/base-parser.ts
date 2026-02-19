import type { ParseResult } from "../types/index.js";

/**
 * Default timeout for parse operations (30 seconds)
 * Heavy PDFs, large Excel files can take time but shouldn't hang indefinitely
 */
export const DEFAULT_PARSE_TIMEOUT_MS = 30_000;

/**
 * Error thrown when a parse operation exceeds the timeout
 */
export class ParseTimeoutError extends Error {
  constructor(timeoutMs: number, filename?: string) {
    super(
      `Parse operation timed out after ${timeoutMs}ms${filename ? ` for ${filename}` : ""}`,
    );
    this.name = "ParseTimeoutError";
  }
}

/**
 * Abstract base class for document parsers
 * All parsers must implement the parse method
 */
export abstract class BaseParser {
  /**
   * Timeout in milliseconds for parse operations
   * Override in subclasses for parsers that need more/less time
   */
  protected parseTimeoutMs: number = DEFAULT_PARSE_TIMEOUT_MS;
  /**
   * MIME types this parser can handle
   */
  abstract readonly supportedMimeTypes: string[];

  /**
   * File extensions this parser can handle
   */
  abstract readonly supportedExtensions: string[];

  /**
   * Parse document content from a buffer
   * @param buffer - The document content as a buffer
   * @param filename - Original filename (used for metadata extraction)
   * @returns Parsed content and metadata
   */
  abstract parse(buffer: Buffer, filename?: string): Promise<ParseResult>;

  /**
   * Check if this parser can handle the given MIME type
   */
  canParseMimeType(mimeType: string): boolean {
    return this.supportedMimeTypes.some((supported) =>
      mimeType.toLowerCase().includes(supported.toLowerCase()),
    );
  }

  /**
   * Check if this parser can handle the given file extension
   */
  canParseExtension(filename: string): boolean {
    const ext = filename.toLowerCase().split(".").pop() || "";
    return this.supportedExtensions.includes(ext);
  }

  /**
   * Extract title from filename
   */
  protected extractTitleFromFilename(filename?: string): string {
    if (!filename) return "Untitled Document";

    // Remove extension and clean up
    const withoutExt = filename.replace(/\.[^/.]+$/, "");

    // Convert underscores and hyphens to spaces
    const cleaned = withoutExt
      .replace(/[_-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned || "Untitled Document";
  }

  /**
   * Clean extracted text
   */
  protected cleanText(text: string): string {
    return (
      text
        // Remove null bytes and other control characters that break Postgres
        .replace(/\x00/g, "")
        // Remove invalid Unicode escape sequences (common in PDFs)
        .replace(/\\u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/g, "")
        // Remove other problematic Unicode control chars (except newlines, tabs)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
        // Normalize whitespace
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        // Remove excessive newlines
        .replace(/\n{3,}/g, "\n\n")
        // Remove excessive spaces
        .replace(/ {2,}/g, " ")
        // Trim lines
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .trim()
    );
  }

  /**
   * Wrap a promise with a timeout to prevent indefinite hangs
   * Uses AbortController for proper cleanup
   *
   * @param promise - The promise to wrap
   * @param timeoutMs - Timeout in milliseconds (defaults to parseTimeoutMs)
   * @param filename - Optional filename for error context
   * @returns The result of the promise
   * @throws ParseTimeoutError if the operation times out
   */
  protected withTimeout<T>(
    promise: Promise<T>,
    timeoutMs?: number,
    filename?: string,
  ): Promise<T> {
    const timeout = timeoutMs ?? this.parseTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new ParseTimeoutError(timeout, filename));
      }, timeout);

      promise
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
}

/**
 * Get MIME type from file extension
 */
export function getMimeTypeFromExtension(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";

  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    csv: "text/csv",
    txt: "text/plain",
    html: "text/html",
    htm: "text/html",
    eml: "message/rfc822",
    msg: "application/vnd.ms-outlook",
    md: "text/markdown",
    json: "application/json",
    xml: "application/xml",
  };

  return mimeTypes[ext] || "application/octet-stream";
}
