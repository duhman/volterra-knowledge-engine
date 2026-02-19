import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import { BaseParser } from "./base-parser.js";
import { ParsingError } from "../utils/error-handler.js";
import { logger } from "../utils/logger.js";
import type { ParseResult } from "../types/index.js";

// Use legacy build for Node.js - doesn't require web worker
// The legacy build is compatible with older environments and Node.js

export class PdfParser extends BaseParser {
  readonly supportedMimeTypes = ["application/pdf"];
  readonly supportedExtensions = ["pdf"];

  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    try {
      logger.debug("Parsing PDF document", { filename });

      // Convert Buffer to Uint8Array for pdfjs
      const uint8Array = new Uint8Array(buffer);

      // Load the PDF document
      const loadingTask = pdfjs.getDocument({
        data: uint8Array,
        useSystemFonts: true,
      });

      const doc = await loadingTask.promise;

      // Extract text from all pages
      const textContent: string[] = [];

      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const content = await page.getTextContent();

        // Join text items with spaces, preserving rough structure
        const pageText = content.items
          .filter((item): item is TextItem => "str" in item)
          .map((item) => item.str)
          .join(" ");

        textContent.push(pageText);
      }

      const rawText = textContent.join("\n\n");
      const content = this.cleanText(rawText);

      if (!content || content.length < 10) {
        logger.warn(
          "PDF has minimal text content, may be scanned/image-based",
          { filename },
        );
      }

      // Extract metadata
      let title = this.extractTitleFromFilename(filename);
      try {
        const metadata = await doc.getMetadata();
        if (metadata.info && typeof metadata.info === "object") {
          const info = metadata.info as Record<string, unknown>;
          if (!title && typeof info.Title === "string" && info.Title) {
            title = info.Title;
          }
        }
      } catch {
        // Metadata extraction failed, use filename-based title
        logger.debug("Could not extract PDF metadata", { filename });
      }

      return {
        content,
        metadata: {
          title: title || "Untitled PDF",
          mimeType: "application/pdf",
          originalFilename: filename,
          fileSize: buffer.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to parse PDF", { filename, error: message });
      throw new ParsingError(`Failed to parse PDF: ${message}`, { filename });
    }
  }
}
