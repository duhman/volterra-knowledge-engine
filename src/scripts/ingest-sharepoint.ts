#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { SharePointSource } from '../sources/sharepoint-source.js';
import { processSourceDocuments } from '../core/document-processor.js';
import { generateComplianceReport } from '../compliance/index.js';
import { logger } from '../utils/logger.js';
import type { IngestionOptions, AccessLevel } from '../types/index.js';

const program = new Command();

program
  .name('ingest-sharepoint')
  .description('Ingest documents from SharePoint into Supabase')
  .option('-p, --path <path>', 'SharePoint folder path to ingest')
  .option('-d, --department <dept>', 'Department (e.g., Operations, Commercial, Platform)')
  .option('-t, --type <type>', 'Document type (e.g., Policy, FAQ, Contract)')
  .option('-o, --owner <owner>', 'Document owner')
  .option('-a, --access <level>', 'Access level (public, internal, restricted, confidential)', 'internal')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--dry-run', 'Validate without inserting into database')
  .option('--limit <n>', 'Maximum number of documents to process', parseInt)
  .action(async (opts) => {
    try {
      logger.info('Starting SharePoint ingestion', { options: opts });

      // Check configuration
      const requiredVars = [
        'SHAREPOINT_CLIENT_ID',
        'SHAREPOINT_CLIENT_SECRET',
        'SHAREPOINT_TENANT_ID',
      ];
      const missing = requiredVars.filter(v => !process.env[v]);
      
      if (missing.length > 0) {
        console.error('Error: Missing required environment variables:');
        for (const v of missing) {
          console.error(`  - ${v}`);
        }
        console.log('\nTo configure SharePoint access:');
        console.log('1. Register an app in Azure AD');
        console.log('2. Grant Microsoft Graph permissions (Files.Read.All, Sites.Read.All)');
        console.log('3. Create a client secret');
        console.log('4. Set the environment variables');
        console.log('\nOptional: Set SHAREPOINT_SITE_ID to target a specific site');
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
      const source = new SharePointSource();
      await source.initialize();

      // List documents
      console.log('Fetching SharePoint documents...');
      const documents = await source.listDocuments({ 
        path: opts.path,
        limit: opts.limit,
      });

      if (documents.length === 0) {
        console.log('No supported documents found in SharePoint.');
        console.log('Supported formats: PDF, DOCX, XLSX, CSV, HTML, TXT, emails');
        process.exit(0);
      }

      console.log(`Found ${documents.length} documents to process\n`);

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
      console.log('=== SharePoint Ingestion Summary ===');
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

      logger.info('SharePoint ingestion complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('SharePoint ingestion failed', { error: message });
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();

