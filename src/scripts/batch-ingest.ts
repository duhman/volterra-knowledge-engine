#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { FileSource } from '../sources/file-source.js';
import { NotionSource } from '../sources/notion-source.js';
import { SharePointSource } from '../sources/sharepoint-source.js';
import { HubSpotSource } from '../sources/hubspot-source.js';
import { processSourceDocuments } from '../core/document-processor.js';
import { generateComplianceReport, type AuditLogEntry } from '../compliance/index.js';
import { getSourceStatus, type BaseSource } from '../sources/index.js';
import { logger } from '../utils/logger.js';
import type { IngestionOptions, AccessLevel, BatchResult } from '../types/index.js';

const program = new Command();

program
  .name('batch-ingest')
  .description('Ingest documents from multiple sources into Supabase')
  .option('-s, --sources <sources>', 'Comma-separated list of sources (file,notion,sharepoint,hubspot)', 'file')
  .option('-p, --path <path>', 'Path for file source')
  .option('-d, --department <dept>', 'Department (e.g., Operations, Commercial, Platform)')
  .option('-t, --type <type>', 'Document type (e.g., Policy, FAQ, Contract)')
  .option('-o, --owner <owner>', 'Document owner')
  .option('-a, --access <level>', 'Access level (public, internal, restricted, confidential)', 'internal')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--dry-run', 'Validate without inserting into database')
  .option('--limit <n>', 'Maximum documents per source', parseInt)
  .option('--status', 'Show configured sources status and exit')
  .action(async (opts) => {
    try {
      // Show source status
      if (opts.status) {
        console.log('=== Source Configuration Status ===\n');
        const status = getSourceStatus();
        for (const [type, info] of Object.entries(status)) {
          const icon = info.configured ? '[OK]' : '[--]';
          console.log(`${icon} ${info.name} (${type})`);
        }
        console.log('\nSet environment variables to enable sources.');
        process.exit(0);
      }

      logger.info('Starting batch ingestion', { options: opts });

      const requestedSources = opts.sources.split(',').map((s: string) => s.trim().toLowerCase());
      const options: IngestionOptions = {
        department: opts.department,
        documentType: opts.type,
        owner: opts.owner,
        accessLevel: opts.access as AccessLevel,
        tags: opts.tags?.split(',').map((t: string) => t.trim()),
        dryRun: opts.dryRun,
      };

      const allResults: Array<{ source: string; result: BatchResult & { auditLogs: AuditLogEntry[] } }> = [];
      const allAuditLogs: AuditLogEntry[] = [];

      // Process each requested source
      for (const sourceName of requestedSources) {
        let source: BaseSource;
        
        switch (sourceName) {
          case 'file':
            source = new FileSource(opts.path || process.cwd());
            break;
          case 'notion':
            source = new NotionSource();
            break;
          case 'sharepoint':
            source = new SharePointSource();
            break;
          case 'hubspot':
            source = new HubSpotSource();
            break;
          default:
            console.warn(`Unknown source: ${sourceName}, skipping`);
            continue;
        }

        if (!source.isConfigured()) {
          console.warn(`Source ${source.name} is not configured, skipping`);
          continue;
        }

        console.log(`\n=== Processing ${source.name} ===`);

        try {
          await source.initialize();
          
          const documents = await source.listDocuments({ limit: opts.limit });
          
          if (documents.length === 0) {
            console.log(`No documents found in ${source.name}`);
            continue;
          }

          console.log(`Found ${documents.length} documents`);

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
          allResults.push({ source: source.name, result });
          allAuditLogs.push(...result.auditLogs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Failed to process ${source.name}: ${message}`);
        }
      }

      // Print summary
      console.log('\n==============================');
      console.log('=== Batch Ingestion Summary ===');
      console.log('==============================\n');

      let totalDocs = 0;
      let totalSuccess = 0;
      let totalFailed = 0;

      for (const { source, result } of allResults) {
        console.log(`${source}:`);
        console.log(`  Total:      ${result.total}`);
        console.log(`  Successful: ${result.successful}`);
        console.log(`  Failed:     ${result.failed}`);
        
        totalDocs += result.total;
        totalSuccess += result.successful;
        totalFailed += result.failed;

        if (result.errors.length > 0) {
          console.log('  Errors:');
          for (const err of result.errors.slice(0, 5)) {
            console.log(`    - ${err.identifier}: ${err.error}`);
          }
          if (result.errors.length > 5) {
            console.log(`    ... and ${result.errors.length - 5} more`);
          }
        }
        console.log('');
      }

      console.log('--- Overall ---');
      console.log(`Total Documents: ${totalDocs}`);
      console.log(`Successful:      ${totalSuccess}`);
      console.log(`Failed:          ${totalFailed}`);

      // Print compliance report
      if (allAuditLogs.length > 0) {
        const report = generateComplianceReport(allAuditLogs);
        console.log('\n=== Compliance Report ===');
        console.log(`Documents scanned:  ${report.totalDocuments}`);
        console.log(`Documents with PII: ${report.documentsWithPII}`);
        
        if (Object.keys(report.piiTypeBreakdown).length > 0) {
          console.log('\nPII Types found:');
          for (const [type, count] of Object.entries(report.piiTypeBreakdown)) {
            console.log(`  - ${type}: ${count}`);
          }
        }

        console.log('\nSensitivity breakdown:');
        for (const [level, count] of Object.entries(report.sensitivityBreakdown)) {
          console.log(`  - ${level}: ${count}`);
        }
      }

      if (totalFailed > 0) {
        process.exit(1);
      }

      logger.info('Batch ingestion complete', { totalDocs, totalSuccess, totalFailed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Batch ingestion failed', { error: message });
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();

