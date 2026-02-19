#!/usr/bin/env node
import "dotenv/config";
/**
 * Manual sync script for a specific Notion database
 * Uses the NotionSource.listDocumentsFromDatabase() method to query all pages
 *
 * Usage:
 *   npm run sync-notion-db -- --data-source <data-source-id> [--limit <n>]
 */

import { Command } from "commander";
import { NotionSource } from "../sources/notion-source.js";
import { processDocument } from "../core/document-processor.js";
import { logger } from "../utils/logger.js";

interface SyncOptions {
  dataSource: string;
  limit?: number;
  dryRun?: boolean;
}

async function syncNotionDatabase(options: SyncOptions): Promise<void> {
  const { dataSource, limit, dryRun = false } = options;

  logger.info("Starting Notion database sync", {
    dataSource,
    limit,
    dryRun,
  });

  // Initialize NotionSource
  const notionSource = new NotionSource();
  await notionSource.ensureInitialized();

  try {
    // Query all pages from the database
    logger.info("Querying database pages...");
    const documents = await notionSource.listDocumentsFromDatabase(dataSource, {
      limit,
    });

    logger.info(`Found ${documents.length} pages in database`);

    if (dryRun) {
      logger.info("Dry run mode - listing pages without ingesting:");
      documents.forEach((doc, idx) => {
        console.log(`${idx + 1}. ${doc.name} (${doc.id})`);
        console.log(`   Source: ${doc.metadata.sourcePath}`);
        console.log(`   URL: ${doc.metadata.url}`);
        console.log("");
      });
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    // Process each document
    for (const [idx, doc] of documents.entries()) {
      logger.info(
        `Processing page ${idx + 1}/${documents.length}: ${doc.name}`,
      );

      try {
        // Download the document content
        const buffer = await notionSource.downloadDocument(doc);

        // Process and ingest
        const result = await processDocument(
          buffer,
          `${doc.name}.md`,
          {
            department: "Platform",
            documentType: "Documentation",
            accessLevel: "internal",
            source: "notion",
            sourcePath: doc.metadata.sourcePath,
            title: doc.name,
            url: doc.metadata.url,
            notionId: doc.metadata.notionId,
            databaseId: doc.metadata.databaseId,
            createdTime: doc.metadata.createdTime,
            lastEditedTime: doc.metadata.lastEditedTime,
          },
          doc.mimeType,
        );

        if (result.success) {
          successCount++;
          logger.info(`✓ Successfully ingested: ${doc.name}`);
        } else {
          errorCount++;
          logger.error(`✗ Failed to ingest: ${doc.name}`, {
            error: result.error,
          });
        }
      } catch (error) {
        errorCount++;
        logger.error(`✗ Error processing ${doc.name}:`, error);
      }
    }

    // Summary
    logger.info("Sync complete", {
      total: documents.length,
      success: successCount,
      errors: errorCount,
    });
  } catch (error) {
    logger.error("Failed to sync database:", error);
    throw error;
  }
}

// CLI setup
const program = new Command();

program
  .name("sync-notion-database")
  .description("Manually sync a specific Notion database by data source ID")
  .requiredOption(
    "-d, --data-source <id>",
    "Notion data source ID (collection ID) to sync",
  )
  .option("-l, --limit <n>", "Maximum number of pages to process", parseInt)
  .option("--dry-run", "List pages without ingesting")
  .action(async (options) => {
    try {
      await syncNotionDatabase({
        dataSource: options.dataSource,
        limit: options.limit,
        dryRun: options.dryRun,
      });
      process.exit(0);
    } catch (error) {
      logger.error("Sync failed:", error);
      process.exit(1);
    }
  });

program.parse();
