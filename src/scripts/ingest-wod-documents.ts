#!/usr/bin/env node
/**
 * CLI script for ingesting WoD Project Documents into Supabase
 * Processes complete EV charging project documentation with embeddings
 * for LLM semantic search across all project lifecycle stages.
 */

import dotenv from "dotenv";
// Load .env with override=true so project .env takes precedence over shell environment
dotenv.config({ override: true });
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Command } from "commander";
import { parseDocument } from "../parsers/index.js";
import { getSupabaseClient } from "../database/supabase-client.js";
import { generateEmbedding } from "../core/embedding-service.js";
import { chunkText, estimateTokens } from "../utils/text-chunker.js";
import { logger } from "../utils/logger.js";
import {
  analyzeImage,
  type VisionAnalysis,
} from "../services/vision-service.js";
import {
  uploadImage,
  getMimeTypeFromExtension,
  getImageDimensions,
} from "../services/storage-service.js";
import type {
  WodProjectDocument,
  WodProjectStage,
  WodDocumentType,
  WodDocumentIngestionResult,
  WodVisionAnalysis,
} from "../types/wod.js";

// Re-import constants since they can't be imported as types
const FOLDER_STAGE_MAP: Record<string, WodProjectStage> = {
  "01 Säljmaterial": "sales_material",
  "02 Bilder": "site_photos",
  "03 Översiktsplan": "site_plans",
  "04 Kommunikation": "communication",
  "05 Offert från UE": "contractor_quotes",
  "06 Entreprenad": "implementation",
  "07 Överlämning": "handover",
};

const SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".doc",
  ".xls",
  ".ppt",
];
const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tiff",
  ".webp",
];

const program = new Command();

program
  .name("ingest-wod-documents")
  .description("Ingest WoD project documents into Supabase with embeddings")
  .requiredOption(
    "-d, --directory <path>",
    "Project directory containing stage folders",
  )
  .option("-n, --deal-name <name>", "Deal name to associate documents with")
  .option("-m, --market <market>", "Market code (SE, NO, DK, DE)", "SE")
  .option(
    "--skip-existing",
    "Skip files that already exist by source_path",
    true,
  )
  .option("--dry-run", "Parse and validate without inserting into database")
  .option("--limit <n>", "Maximum number of files to process", parseInt)
  .option("--no-embeddings", "Skip embedding generation")
  .option("--skip-images", "Skip image files (don't process via vision API)")
  .option("--vision-model <model>", "Vision model to use", "gpt-4o")
  .option("--verbose", "Show verbose output")
  .action(async (opts) => {
    try {
      logger.info("Starting WoD document ingestion", { options: opts });

      console.log("=== WoD Project Documents Ingestion ===\n");

      // Validate directory
      if (!fs.existsSync(opts.directory)) {
        throw new Error(`Directory not found: ${opts.directory}`);
      }

      // Discover files
      const files = await discoverProjectFiles(opts.directory);
      console.log(`Found ${files.length} processable documents\n`);

      if (files.length === 0) {
        console.log("No documents found to process.");
        process.exit(0);
      }

      // Filter by limit
      const filesToProcess = opts.limit ? files.slice(0, opts.limit) : files;
      console.log(`Processing ${filesToProcess.length} files\n`);

      // Check existing if needed
      let existingPaths = new Set<string>();
      if (opts.skipExisting && !opts.dryRun) {
        console.log("Checking for existing documents...");
        existingPaths = await getExistingWodDocumentPaths();
        console.log(`Found ${existingPaths.size} existing documents\n`);
      }

      // Process files
      const result: WodDocumentIngestionResult = {
        totalFiles: filesToProcess.length,
        processedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        documentsInserted: 0,
        chunksInserted: 0,
        errors: [],
      };

      for (let i = 0; i < filesToProcess.length; i++) {
        const fileInfo = filesToProcess[i];
        const filename = path.basename(fileInfo.path);

        process.stdout.write(
          `\r[${i + 1}/${filesToProcess.length}] Processing: ${filename.substring(0, 50).padEnd(50)}`,
        );

        try {
          // Generate source path for deduplication
          const sourcePath = generateSourcePath(
            opts.market,
            opts.dealName || path.basename(opts.directory),
            fileInfo,
          );

          // Skip if exists
          if (existingPaths.has(sourcePath)) {
            result.skippedFiles++;
            continue;
          }

          // Read file
          const buffer = fs.readFileSync(fileInfo.path);
          const fileHash = crypto
            .createHash("sha256")
            .update(buffer)
            .digest("hex");

          // Branch: Image processing vs Document parsing
          let document: WodProjectDocument;

          if (fileInfo.isImage && !opts.skipImages) {
            // ============================================
            // IMAGE PROCESSING VIA VISION API
            // ============================================
            const imageMimeType = getMimeTypeFromExtension(filename);
            if (!imageMimeType) {
              logger.warn("Unknown image type, skipping", { filename });
              result.skippedFiles++;
              continue;
            }

            // Upload to Supabase Storage
            let storageUrl = "";
            if (!opts.dryRun) {
              try {
                const uploadResult = await uploadImage(buffer, {
                  market: opts.market,
                  dealName: opts.dealName || path.basename(opts.directory),
                  projectStage: fileInfo.stage,
                  originalFilename: filename,
                  contentType: imageMimeType as
                    | "image/jpeg"
                    | "image/png"
                    | "image/gif"
                    | "image/webp",
                });
                storageUrl = uploadResult.publicUrl;
              } catch (uploadError) {
                const msg =
                  uploadError instanceof Error
                    ? uploadError.message
                    : String(uploadError);
                logger.error("Failed to upload image", {
                  filename,
                  error: msg,
                });
                throw new Error(`Image upload failed: ${msg}`);
              }
            }

            // Get image dimensions
            const dimensions = await getImageDimensions(buffer);

            // Analyze with vision model
            let visionAnalysis: VisionAnalysis | null = null;
            let rawText = "";
            if (storageUrl && !opts.dryRun) {
              try {
                visionAnalysis = await analyzeImage(storageUrl, {
                  model: opts.visionModel || "gpt-4o",
                });
                rawText = visionAnalysis.description;
                if (opts.verbose) {
                  console.log(`\n  Vision: ${rawText.substring(0, 80)}...`);
                }
              } catch (visionError) {
                const msg =
                  visionError instanceof Error
                    ? visionError.message
                    : String(visionError);
                logger.warn("Vision analysis failed", { filename, error: msg });
                // Continue without vision analysis
              }
            }

            // Create document record for image
            document = {
              title: extractTitle(filename),
              description:
                visionAnalysis?.description ||
                generateDescription(fileInfo, filename),
              projectStage: fileInfo.stage,
              documentType: "site_photo",
              originalFilename: filename,
              mimeType: imageMimeType,
              fileSize: buffer.length,
              fileHash,
              sourcePath,
              rawText,
              extractedMetadata: {},
              processingStatus: visionAnalysis ? "completed" : "skipped",
              chunksCount: 0,
              language: "sv",
              documentDate: extractDateFromFilename(filename),
              // Image-specific fields
              isImage: true,
              storageUrl,
              imageWidth: dimensions?.width,
              imageHeight: dimensions?.height,
              visionAnalysis: visionAnalysis?.structured as
                | WodVisionAnalysis
                | undefined,
              visionModel: visionAnalysis?.model,
              visionProcessedAt: visionAnalysis ? new Date() : undefined,
              chunks: [],
            };

            // Create single chunk from vision description for embedding
            if (rawText && rawText.length > 0) {
              document.chunksCount = 1;
              document.chunks = [
                {
                  documentId: "",
                  content: rawText,
                  chunkIndex: 0,
                  sectionHeader: "Vision Description",
                  tokenCount: estimateTokens(rawText),
                },
              ];
            }
          } else if (fileInfo.isImage && opts.skipImages) {
            // Skip image when --skip-images flag is set
            result.skippedFiles++;
            continue;
          } else {
            // ============================================
            // DOCUMENT PARSING (existing logic)
            // ============================================
            let rawText = "";
            try {
              const parseResult = await parseDocument(buffer, filename);
              rawText = parseResult.content;
            } catch (parseError) {
              const parseMsg =
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError);
              if (opts.verbose) {
                console.log(
                  `\n  Warning: Could not parse ${filename}: ${parseMsg}`,
                );
              }
              logger.warn("Failed to parse document", {
                filename,
                error: parseMsg,
              });
            }

            document = {
              title: extractTitle(filename),
              description: generateDescription(fileInfo, filename),
              projectStage: fileInfo.stage,
              documentType: classifyDocumentType(
                filename,
                fileInfo.stage,
                fileInfo.subFolder,
              ),
              originalFilename: filename,
              mimeType: getMimeType(filename),
              fileSize: buffer.length,
              fileHash,
              sourcePath,
              rawText,
              extractedMetadata: {},
              processingStatus: rawText ? "completed" : "skipped",
              chunksCount: 0,
              language: "sv",
              documentDate: extractDateFromFilename(filename),
              isImage: false,
              chunks: [],
            };

            // Chunk text if we have content
            if (rawText && rawText.length > 0) {
              const chunks = chunkText(rawText, {
                maxChunkSize: 2000,
                minChunkSize: 200,
                overlap: 100,
                splitByHeaders: true,
              });

              document.chunksCount = chunks.length;
              document.chunks = chunks.map((chunk, index) => ({
                documentId: "",
                content: chunk.content,
                chunkIndex: index,
                sectionHeader: chunk.metadata.section,
                tokenCount: estimateTokens(chunk.content),
              }));
            }
          }

          // Generate embeddings if enabled (for both images and documents)
          if (
            opts.embeddings !== false &&
            document.chunks &&
            document.chunks.length > 0
          ) {
            for (const chunk of document.chunks) {
              try {
                const embeddingResult = await generateEmbedding(chunk.content);
                chunk.embedding = embeddingResult.embedding;
              } catch (embError) {
                logger.warn("Failed to generate embedding for chunk", {
                  filename,
                  chunkIndex: chunk.chunkIndex,
                  error:
                    embError instanceof Error
                      ? embError.message
                      : String(embError),
                });
              }
            }
          }

          // Insert into database
          if (!opts.dryRun) {
            const { chunksInserted } = await insertWodDocument(
              document,
              opts.dealName,
            );
            result.documentsInserted++;
            result.chunksInserted += chunksInserted;
          }

          result.processedFiles++;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          result.failedFiles++;
          result.errors.push({
            filename,
            error: message,
            timestamp: new Date(),
          });
          logger.error("Failed to process file", { filename, error: message });
        }
      }

      // Print summary
      console.log("\n\n=== Ingestion Summary ===");
      console.log(`Total files:        ${result.totalFiles}`);
      console.log(`Processed:          ${result.processedFiles}`);
      console.log(`Skipped:            ${result.skippedFiles}`);
      console.log(`Failed:             ${result.failedFiles}`);
      console.log(`Documents inserted: ${result.documentsInserted}`);
      console.log(`Chunks inserted:    ${result.chunksInserted}`);

      if (result.errors.length > 0) {
        console.log("\nErrors:");
        for (const err of result.errors.slice(0, 10)) {
          console.log(`  - ${err.filename}: ${err.error}`);
        }
        if (result.errors.length > 10) {
          console.log(`  ... and ${result.errors.length - 10} more`);
        }
      }

      if (opts.dryRun) {
        console.log("\n[DRY RUN] No data was inserted into the database.");
      }

      if (result.failedFiles > 0) {
        process.exit(1);
      }

      logger.info("WoD document ingestion complete", result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("WoD document ingestion failed", { error: message });
      console.error(`\nError: ${message}`);
      process.exit(1);
    }
  });

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

interface DiscoveredFile {
  path: string;
  stage: WodProjectStage;
  subFolder?: string;
  relativePath: string;
  isImage: boolean;
}

/**
 * Discover all processable files in a project directory
 */
async function discoverProjectFiles(
  projectDir: string,
): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];

  // Look for stage folders (01 Säljmaterial, etc.)
  const entries = fs.readdirSync(projectDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Check if this is a known stage folder
    const stage = FOLDER_STAGE_MAP[entry.name];
    if (!stage) continue;

    const stageDir = path.join(projectDir, entry.name);
    const stageFiles = discoverFilesRecursively(stageDir, stage, entry.name);
    files.push(...stageFiles);
  }

  return files;
}

/**
 * Recursively discover files in a directory
 */
function discoverFilesRecursively(
  dir: string,
  stage: WodProjectStage,
  baseFolderName: string,
  subFolder?: string,
): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden folders
      if (entry.name.startsWith(".")) continue;

      const newSubFolder = subFolder
        ? `${subFolder}/${entry.name}`
        : entry.name;
      files.push(
        ...discoverFilesRecursively(
          fullPath,
          stage,
          baseFolderName,
          newSubFolder,
        ),
      );
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();

      // Skip hidden files
      if (entry.name.startsWith(".")) continue;

      const relativePath = subFolder
        ? `${baseFolderName}/${subFolder}/${entry.name}`
        : `${baseFolderName}/${entry.name}`;

      // Include images for vision processing
      if (IMAGE_EXTENSIONS.includes(ext)) {
        files.push({
          path: fullPath,
          stage,
          subFolder,
          relativePath,
          isImage: true,
        });
        continue;
      }

      // Check if we can parse this file (documents)
      if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

      files.push({
        path: fullPath,
        stage,
        subFolder,
        relativePath,
        isImage: false,
      });
    }
  }

  return files;
}

/**
 * Generate a unique source path for deduplication
 */
function generateSourcePath(
  market: string,
  dealName: string,
  fileInfo: DiscoveredFile,
): string {
  // Normalize deal name for URL
  const normalizedDeal = dealName
    .replace(/[åä]/gi, "a")
    .replace(/[ö]/gi, "o")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "");

  // Normalize relative path
  const normalizedPath = fileInfo.relativePath
    .replace(/[åäÅÄ]/g, "a")
    .replace(/[öÖ]/g, "o")
    .replace(/\s+/g, "-");

  return `wod://${market}/${normalizedDeal}/${normalizedPath}`;
}

/**
 * Extract title from filename
 */
function extractTitle(filename: string): string {
  // Remove extension
  const nameWithoutExt = path.basename(filename, path.extname(filename));

  // Replace underscores and hyphens with spaces
  const title = nameWithoutExt
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return title || filename;
}

/**
 * Generate description from file info
 */
function generateDescription(
  fileInfo: DiscoveredFile,
  filename: string,
): string {
  const stageName =
    Object.entries(FOLDER_STAGE_MAP).find(
      ([_, v]) => v === fileInfo.stage,
    )?.[0] || fileInfo.stage;
  const subPath = fileInfo.subFolder ? ` > ${fileInfo.subFolder}` : "";
  return `${stageName}${subPath}: ${filename}`;
}

/**
 * Classify document type based on filename and context
 */
function classifyDocumentType(
  filename: string,
  stage: WodProjectStage,
  subFolder?: string,
): WodDocumentType {
  const lowerFilename = filename.toLowerCase();
  const lowerSubFolder = (subFolder || "").toLowerCase();

  // Presentations
  if (lowerFilename.endsWith(".pptx") || lowerFilename.endsWith(".ppt")) {
    if (lowerFilename.includes("offert")) return "offer_document";
    if (lowerFilename.includes("projektuppfattning")) return "project_binder";
    return "presentation";
  }

  // Specific document types by keywords
  if (
    lowerFilename.includes("kvalitetsplan") ||
    lowerFilename.includes("kvalitet")
  ) {
    return "quality_plan";
  }
  if (lowerFilename.includes("miljöplan") || lowerFilename.includes("miljo")) {
    return "environment_plan";
  }
  if (
    lowerFilename.includes("kontrolplan") ||
    lowerFilename.includes("kontroll")
  ) {
    return "control_plan";
  }
  if (
    lowerFilename.includes("egenkontroll") ||
    lowerFilename.includes("self")
  ) {
    return "self_inspection";
  }
  if (
    lowerFilename.includes("drift och underhåll") ||
    lowerFilename.includes("dou") ||
    lowerSubFolder.includes("dou")
  ) {
    return "dou_document";
  }
  if (
    lowerFilename.includes("projektpärm") ||
    lowerFilename.includes("projektparm")
  ) {
    return "project_binder";
  }
  if (
    lowerFilename.includes("entreprenad") ||
    lowerFilename.includes("kontrakt") ||
    lowerFilename.includes("avtal")
  ) {
    return "contractor_agreement";
  }
  if (lowerFilename.includes("offert") && !lowerFilename.includes("wod")) {
    return "contractor_quote";
  }
  if (
    lowerFilename.includes("produktblad") ||
    lowerFilename.includes("product")
  ) {
    return "product_sheet";
  }
  if (
    lowerFilename.includes("manual") ||
    lowerFilename.includes("instruktion")
  ) {
    return "manual";
  }
  if (
    lowerFilename.includes("certifikat") ||
    lowerFilename.includes("doc") ||
    lowerFilename.includes("declaration")
  ) {
    return "certificate";
  }
  if (
    lowerFilename.includes("beställning") ||
    lowerFilename.includes("order")
  ) {
    return "order_form";
  }
  if (
    lowerFilename.includes("överlämning") ||
    lowerFilename.includes("handover")
  ) {
    return "handover_protocol";
  }
  if (lowerFilename.includes("ampeco")) {
    return "ampeco_import";
  }
  if (lowerFilename.includes("wod") || lowerFilename.includes("wheel")) {
    return "wod_calculator";
  }
  if (
    lowerFilename.includes("karta") ||
    lowerFilename.includes("plan") ||
    lowerFilename.includes("layout")
  ) {
    return "site_map";
  }
  if (lowerFilename.includes("schema") || lowerFilename.includes("diagram")) {
    return "circuit_diagram";
  }
  if (lowerFilename.includes("möte") || lowerFilename.includes("meeting")) {
    return "meeting_notes";
  }
  if (lowerFilename.includes("mail") || lowerFilename.includes("email")) {
    return "email";
  }

  // Default by stage
  switch (stage) {
    case "sales_material":
      if (lowerFilename.endsWith(".xlsx")) return "wod_calculator";
      return "presentation";
    case "site_photos":
      return "site_photo";
    case "site_plans":
      return "site_map";
    case "communication":
      return "email";
    case "contractor_quotes":
      return "contractor_quote";
    case "implementation":
      return "project_binder";
    case "handover":
      return "handover_protocol";
    default:
      return "other";
  }
}

/**
 * Get MIME type from filename extension
 */
function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
  };
  return mimeMap[ext] || "application/octet-stream";
}

/**
 * Extract date from filename if present
 */
function extractDateFromFilename(filename: string): Date | undefined {
  // Match patterns like 20250604, 2025-06-04, 20250604
  const patterns = [
    /(\d{4})(\d{2})(\d{2})/, // 20250604
    /(\d{4})-(\d{2})-(\d{2})/, // 2025-06-04
    /(\d{2})(\d{2})(\d{4})/, // 04062025
  ];

  for (const pattern of patterns) {
    const match = filename.match(pattern);
    if (match) {
      try {
        let year: number, month: number, day: number;
        if (match[1].length === 4) {
          year = parseInt(match[1], 10);
          month = parseInt(match[2], 10);
          day = parseInt(match[3], 10);
        } else {
          day = parseInt(match[1], 10);
          month = parseInt(match[2], 10);
          year = parseInt(match[3], 10);
        }

        // Validate date
        if (
          year >= 2020 &&
          year <= 2030 &&
          month >= 1 &&
          month <= 12 &&
          day >= 1 &&
          day <= 31
        ) {
          return new Date(year, month - 1, day);
        }
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

/**
 * Get existing WoD document source paths for deduplication
 */
async function getExistingWodDocumentPaths(): Promise<Set<string>> {
  const client = getSupabaseClient();
  const existing = new Set<string>();

  // Note: Type assertion needed until database types are regenerated after migration
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (client as any)
    .from("wod_project_documents")
    .select("source_path");

  if (error) {
    logger.warn("Error fetching existing document paths", {
      error: error.message,
    });
    return existing;
  }

  for (const row of data || []) {
    if (row.source_path) {
      existing.add(row.source_path);
    }
  }

  return existing;
}

/**
 * Insert a WoD document and its chunks into Supabase
 */
async function insertWodDocument(
  document: WodProjectDocument,
  dealName?: string,
): Promise<{ documentId: string; chunksInserted: number }> {
  const client = getSupabaseClient();

  // Try to find associated deal
  let dealId: string | undefined;
  if (dealName) {
    const { data: dealData } = await client
      .from("wod_deals")
      .select("id")
      .ilike("deal_name", `%${dealName}%`)
      .limit(1);

    if (dealData && dealData.length > 0) {
      dealId = dealData[0].id;
    }
  }

  // Insert document
  // Note: Type assertion needed until database types are regenerated after migration
  // The wod_project_documents table is created by migration 20260122000000
  const insertData = {
    deal_id: dealId,
    title: document.title,
    description: document.description,
    project_stage: document.projectStage,
    document_type: document.documentType,
    original_filename: document.originalFilename,
    mime_type: document.mimeType,
    file_size: document.fileSize,
    file_hash: document.fileHash,
    source_path: document.sourcePath,
    raw_text: document.rawText,
    extracted_metadata: document.extractedMetadata,
    processing_status: document.processingStatus,
    chunks_count: document.chunksCount,
    language: document.language,
    document_date: document.documentDate?.toISOString().split("T")[0],
    // Image-specific fields
    is_image: document.isImage || false,
    storage_url: document.storageUrl,
    image_width: document.imageWidth,
    image_height: document.imageHeight,
    vision_analysis: document.visionAnalysis,
    vision_model: document.visionModel,
    vision_processed_at: document.visionProcessedAt?.toISOString(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: docData, error: docError } = await (client as any)
    .from("wod_project_documents")
    .insert(insertData)
    .select("id")
    .single();

  if (docError) {
    throw new Error(`Failed to insert document: ${docError.message}`);
  }

  const documentId = docData.id;
  let chunksInserted = 0;

  // Insert chunks
  if (document.chunks && document.chunks.length > 0) {
    const chunkRecords = document.chunks.map((chunk) => ({
      document_id: documentId,
      content: chunk.content,
      chunk_index: chunk.chunkIndex,
      section_header: chunk.sectionHeader,
      token_count: chunk.tokenCount,
      embedding: chunk.embedding ? `[${chunk.embedding.join(",")}]` : null,
    }));

    // Note: Type assertion needed until database types are regenerated after migration
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: chunkError } = await (client as any)
      .from("wod_project_document_chunks")
      .insert(chunkRecords);

    if (chunkError) {
      logger.warn("Failed to insert chunks", {
        error: chunkError.message,
        documentId,
      });
    } else {
      chunksInserted = chunkRecords.length;
    }
  }

  return { documentId, chunksInserted };
}

program.parse();
