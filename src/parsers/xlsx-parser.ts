import * as XLSX from "xlsx";
import { BaseParser } from "./base-parser.js";
import { ParsingError } from "../utils/error-handler.js";
import { logger } from "../utils/logger.js";
import type { ParseResult } from "../types/index.js";

export class XlsxParser extends BaseParser {
  readonly supportedMimeTypes = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
  ];
  readonly supportedExtensions = ["xlsx", "xls", "csv"];

  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    try {
      logger.debug("Parsing spreadsheet document", { filename });

      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheetContents: string[] = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];

        // Guard against missing sheets (defensive - shouldn't happen but be safe)
        if (!sheet) {
          logger.warn("Sheet listed but not found in workbook", {
            sheetName,
            filename,
          });
          continue;
        }

        // Convert sheet to text format
        const text = XLSX.utils.sheet_to_txt(sheet, {
          blankrows: false,
          skipHidden: true,
        });

        if (text?.trim()) {
          sheetContents.push(`--- Sheet: ${sheetName} ---\n${text}`);
        }
      }

      const content = this.cleanText(sheetContents.join("\n\n"));

      return {
        content,
        metadata: {
          title: this.extractTitleFromFilename(filename),
          mimeType: this.getMimeTypeForSpreadsheet(filename),
          originalFilename: filename,
          fileSize: buffer.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to parse spreadsheet", { filename, error: message });
      throw new ParsingError(`Failed to parse spreadsheet: ${message}`, {
        filename,
      });
    }
  }

  private getMimeTypeForSpreadsheet(filename?: string): string {
    if (!filename)
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const ext = filename.toLowerCase().split(".").pop();
    switch (ext) {
      case "csv":
        return "text/csv";
      case "xls":
        return "application/vnd.ms-excel";
      default:
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
  }
}
