#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { NotionSource } from '../sources/notion-source.js';
import { processSourceDocuments } from '../core/document-processor.js';
import { generateComplianceReport } from '../compliance/index.js';
import { logger } from '../utils/logger.js';
import type { IngestionOptions, AccessLevel } from '../types/index.js';

const program = new Command();

program
  .name('ingest-notion')
  .description('Ingest documents from Notion into Supabase')
  .option('-d, --department <dept>', 'Department (e.g., Operations, Commercial, Platform)')
  .option('-t, --type <type>', 'Document type (e.g., Policy, FAQ, Contract)')
  .option('-o, --owner <owner>', 'Document owner')
  .option('-a, --access <level>', 'Access level (public, internal, restricted, confidential)', 'internal')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--dry-run', 'Validate without inserting into database')
  .option('--limit <n>', 'Maximum number of pages to process', parseInt)
  .action(async (opts) => {
    try {
      logger.info('Starting Notion ingestion', { options: opts });

      // Check configuration
      if (!process.env.NOTION_API_KEY) {
        console.error('Error: NOTION_API_KEY environment variable is not set');
        console.log('\nTo configure Notion access:');
        console.log('1. Create an integration at https://www.notion.so/my-integrations');
        console.log('2. Share the pages you want to ingest with your integration');
        console.log('3. Set the NOTION_API_KEY environment variable');
        process.exit(1);
      }

      const options: IngestionOptions = {
        department: opts.department,
        documentType: opts.type,
        owner: opts.owner,
        accessLevel: opts.access as AccessLevel,
        tags: opts.tags?.split(',').map((t: string) => t.trim()),
        dryRun: opts.dryRun,
      };

      // Initialize source
      const source = new NotionSource();
      await source.initialize();

      // List pages
      console.log('Fetching Notion pages...');
      const documents = await source.listDocuments({ limit: opts.limit });

      if (documents.length === 0) {
        console.log('No pages found. Make sure your integration has access to the pages.');
        process.exit(0);
      }

      console.log(`Found ${documents.length} pages to process\n`);

      // Process documents
      const result = await processSourceDocuments(
        documents,
        { ...source.getDefaultIngestionOptions(), ...options },
        {
          onProgress: (processed, total) => {
            process.stdout.write(`\rProcessing: ${processed}/${total}`);
          },
          downloadContent: (doc) => source.downloadDocument(doc),
        }
      );

      console.log('\n');
      console.log('=== Notion Ingestion Summary ===');
      console.log(`Total:      ${result.total}`);
      console.log(`Successful: ${result.successful}`);
      console.log(`Failed:     ${result.failed}`);

      if (result.errors.length > 0) {
        console.log('\nFailed pages:');
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

      logger.info('Notion ingestion complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Notion ingestion failed', { error: message });
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();

