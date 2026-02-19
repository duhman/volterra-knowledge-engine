#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { HubSpotSource } from '../sources/hubspot-source.js';
import { processSourceDocuments } from '../core/document-processor.js';
import { generateComplianceReport } from '../compliance/index.js';
import { logger } from '../utils/logger.js';
import type { IngestionOptions, AccessLevel } from '../types/index.js';

const program = new Command();

program
  .name('ingest-hubspot')
  .description('Ingest documents from HubSpot into Supabase')
  .option('-p, --path <path>', 'HubSpot folder path to ingest')
  .option('-d, --department <dept>', 'Department (e.g., Operations, Commercial, Platform)', 'Commercial')
  .option('-t, --type <type>', 'Document type (e.g., Policy, FAQ, Contract)')
  .option('-o, --owner <owner>', 'Document owner')
  .option('-a, --access <level>', 'Access level (public, internal, restricted, confidential)', 'internal')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--dry-run', 'Validate without inserting into database')
  .option('--limit <n>', 'Maximum number of files to process', parseInt)
  .action(async (opts) => {
    try {
      logger.info('Starting HubSpot ingestion', { options: opts });

      // Check configuration
      if (!process.env.HUBSPOT_API_KEY) {
        console.error('Error: HUBSPOT_API_KEY environment variable is not set');
        console.log('\nTo configure HubSpot access:');
        console.log('1. Go to HubSpot Settings > Integrations > Private Apps');
        console.log('2. Create a private app with Files scope');
        console.log('3. Copy the access token');
        console.log('4. Set the HUBSPOT_API_KEY environment variable');
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
      const source = new HubSpotSource();
      await source.initialize();

      // List files
      console.log('Fetching HubSpot files...');
      const documents = await source.listDocuments({
        path: opts.path,
        limit: opts.limit,
      });

      if (documents.length === 0) {
        console.log('No supported files found in HubSpot.');
        console.log('Supported formats: PDF, DOCX, XLSX, CSV, HTML, TXT');
        process.exit(0);
      }

      console.log(`Found ${documents.length} files to process\n`);

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
      console.log('=== HubSpot Ingestion Summary ===');
      console.log(`Total:      ${result.total}`);
      console.log(`Successful: ${result.successful}`);
      console.log(`Failed:     ${result.failed}`);

      if (result.errors.length > 0) {
        console.log('\nFailed files:');
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

      logger.info('HubSpot ingestion complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('HubSpot ingestion failed', { error: message });
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();

