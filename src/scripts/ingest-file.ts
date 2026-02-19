#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { stat } from 'fs/promises';
import { FileSource } from '../sources/file-source.js';
import { processDocument, processSourceDocuments } from '../core/document-processor.js';
import { generateComplianceReport } from '../compliance/index.js';
import { logger } from '../utils/logger.js';
import type { IngestionOptions, AccessLevel } from '../types/index.js';

const program = new Command();

program
  .name('ingest-file')
  .description('Ingest documents from local file system into Supabase')
  .argument('<path>', 'File or directory path to ingest')
  .option('-d, --department <dept>', 'Department (e.g., Operations, Commercial, Platform)')
  .option('-t, --type <type>', 'Document type (e.g., Policy, FAQ, Contract)')
  .option('-o, --owner <owner>', 'Document owner')
  .option('-a, --access <level>', 'Access level (public, internal, restricted, confidential)', 'internal')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--dry-run', 'Validate without inserting into database')
  .option('--recursive', 'Recursively process directories', true)
  .option('--limit <n>', 'Maximum number of documents to process', parseInt)
  .option('--chunking', 'Enable chunking for long documents (better RAG retrieval)')
  .option('--chunk-size <n>', 'Maximum chunk size in characters', parseInt)
  .option('--chunk-overlap <n>', 'Chunk overlap in characters', parseInt)
  .option('--source-path <path>', 'Unique source path for deduplication')
  .action(async (inputPath: string, opts) => {
    try {
      logger.info('Starting file ingestion', { path: inputPath, options: opts });

      const options: IngestionOptions = {
        department: opts.department,
        documentType: opts.type,
        owner: opts.owner,
        accessLevel: opts.access as AccessLevel,
        tags: opts.tags?.split(',').map((t: string) => t.trim()),
        dryRun: opts.dryRun,
        enableChunking: opts.chunking,
        maxChunkSize: opts.chunkSize,
        chunkOverlap: opts.chunkOverlap,
        sourceType: 'file',
        sourcePath: opts.sourcePath,
      };

      // Check if path exists
      const stats = await stat(inputPath);

      if (stats.isFile()) {
        // Process single file
        const source = new FileSource();
        const { buffer, filename } = await source.readFile(inputPath);
        
        const result = await processDocument(buffer, filename, options);
        
        if (result.success) {
          console.log(`[SUCCESS] ${result.title}`);
          if (result.documentId) {
            console.log(`  Document ID: ${result.documentId}`);
          }
          if (result.chunkCount && result.chunkCount > 1) {
            console.log(`  Chunks: ${result.chunkCount}`);
          }
        } else {
          console.error(`[FAILED] ${result.title}: ${result.error}`);
          process.exit(1);
        }
      } else if (stats.isDirectory()) {
        // Process directory
        const source = new FileSource(inputPath);
        await source.initialize();
        
        const documents = await source.listDocuments({ limit: opts.limit });
        
        if (documents.length === 0) {
          console.log('No supported documents found in directory');
          process.exit(0);
        }

        console.log(`Found ${documents.length} documents to process\n`);

        const result = await processSourceDocuments(
          documents,
          options,
          {
            onProgress: (processed, total) => {
              process.stdout.write(`\rProcessing: ${processed}/${total}`);
            },
            downloadContent: (doc) => source.downloadDocument(doc),
          }
        );

        console.log('\n');
        console.log('=== Ingestion Summary ===');
        console.log(`Total:      ${result.total}`);
        console.log(`Successful: ${result.successful}`);
        console.log(`Failed:     ${result.failed}`);

        if (result.errors.length > 0) {
          console.log('\nFailed documents:');
          for (const err of result.errors) {
            console.log(`  - ${err.identifier}: ${err.error}`);
          }
        }

        // Print compliance report
        if (result.auditLogs.length > 0) {
          const report = generateComplianceReport(result.auditLogs);
          console.log('\n=== Compliance Report ===');
          console.log(`Documents with PII: ${report.documentsWithPII}`);
          if (Object.keys(report.piiTypeBreakdown).length > 0) {
            console.log('PII Types found:');
            for (const [type, count] of Object.entries(report.piiTypeBreakdown)) {
              console.log(`  - ${type}: ${count}`);
            }
          }
        }

        if (result.failed > 0) {
          process.exit(1);
        }
      }

      logger.info('File ingestion complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('File ingestion failed', { error: message });
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();

