#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { SlackSource, DEFAULT_SLACK_CHANNELS } from '../sources/slack-source.js';
import { processSourceDocuments } from '../core/document-processor.js';
import { generateComplianceReport } from '../compliance/index.js';
import { getExistingSourcePaths } from '../database/supabase-client.js';
import { logger } from '../utils/logger.js';
import type { IngestionOptions, AccessLevel, SourceDocument } from '../types/index.js';

const program = new Command();

program
  .name('ingest-slack')
  .description('One-time ingestion of Slack export channels into Supabase')
  .requiredOption('-e, --export-path <path>', 'Path to Slack export folder')
  .option('-c, --channels <channels>', 'Comma-separated channel names (default: predefined list)')
  .option('-a, --access <level>', 'Access level (public, internal, restricted, confidential)', 'internal')
  .option('--tags <tags>', 'Additional comma-separated tags')
  .option('--dry-run', 'Validate without inserting into database')
  .option('--limit <n>', 'Maximum number of threads to process', parseInt)
  .option('--enable-chunking', 'Enable chunking for long threads', true)
  .option('--stats-only', 'Only show export statistics, do not ingest')
  .option('--skip-dedup', 'Skip deduplication check (faster but may create duplicates)')
  .action(async (opts) => {
    try {
      logger.info('Starting Slack ingestion', { options: opts });

      // Determine channels to process
      const channels = opts.channels
        ? opts.channels.split(',').map((c: string) => c.trim())
        : DEFAULT_SLACK_CHANNELS;

      console.log('=== Slack Export Ingestion ===\n');
      console.log(`Export path: ${opts.exportPath}`);
      console.log(`Channels: ${channels.length}`);
      console.log(`Mode: ${opts.dryRun ? 'DRY RUN' : 'LIVE'}\n`);

      // Initialize source
      const source = new SlackSource({
        exportPath: opts.exportPath,
        channels,
      });

      await source.initialize();

      // Show stats
      const stats = await source.getExportStats();
      console.log('Channel Statistics:');
      console.log('-'.repeat(50));
      
      let missingChannels = 0;
      for (const channel of stats.channels) {
        const status = channel.exists ? `${channel.fileCount} files` : 'NOT FOUND';
        console.log(`  ${channel.name.padEnd(35)} ${status}`);
        if (!channel.exists) missingChannels++;
      }
      
      console.log('-'.repeat(50));
      console.log(`Total JSON files: ${stats.totalFiles}`);
      if (missingChannels > 0) {
        console.log(`Missing channels: ${missingChannels}`);
      }
      console.log('');

      if (opts.statsOnly) {
        console.log('Stats-only mode, exiting.');
        process.exit(0);
      }

      // List all threads from channels
      console.log('Loading and parsing messages...');
      const allDocuments = await source.listDocuments({ limit: opts.limit });

      if (allDocuments.length === 0) {
        console.log('No threads found to process.');
        process.exit(0);
      }

      console.log(`Found ${allDocuments.length} threads/messages total`);

      // Filter out already-ingested documents by source_path
      let documents: SourceDocument[] = allDocuments;
      if (!opts.dryRun && !opts.skipDedup) {
        console.log('Checking for existing documents...');
        const sourcePaths = allDocuments
          .map(d => d.metadata?.sourcePath as string)
          .filter(Boolean);
        
        const existingPaths = await getExistingSourcePaths(sourcePaths);
        
        if (existingPaths.size > 0) {
          documents = allDocuments.filter(d => {
            const path = d.metadata?.sourcePath as string;
            return !path || !existingPaths.has(path);
          });
          console.log(`Skipping ${existingPaths.size} already-ingested threads`);
        }
      }

      if (documents.length === 0) {
        console.log('All threads already ingested. Nothing new to process.');
        process.exit(0);
      }

      console.log(`Processing ${documents.length} new threads\n`);

      // Build ingestion options
      const options: IngestionOptions = {
        accessLevel: opts.access as AccessLevel,
        tags: opts.tags?.split(',').map((t: string) => t.trim()),
        dryRun: opts.dryRun,
        enableChunking: opts.enableChunking !== false,
        maxChunkSize: 3000,
        chunkOverlap: 150,
        // Skip per-doc duplicate check when using source_path dedup (much faster)
        skipDuplicateCheck: opts.skipDedup,
      };

      // Process documents
      let lastProgress = 0;
      const result = await processSourceDocuments(
        documents,
        { ...source.getDefaultIngestionOptions(), ...options },
        {
          onProgress: (processed, total) => {
            const pct = Math.floor((processed / total) * 100);
            if (pct >= lastProgress + 5 || processed === total) {
              process.stdout.write(`\rProcessing: ${processed}/${total} (${pct}%)`);
              lastProgress = pct;
            }
          },
          downloadContent: (doc) => source.downloadDocument(doc),
        }
      );

      console.log('\n\n=== Slack Ingestion Summary ===');
      console.log(`Total threads:  ${result.total}`);
      console.log(`Successful:     ${result.successful}`);
      console.log(`Failed:         ${result.failed}`);

      if (result.errors.length > 0) {
        console.log('\nFailed threads:');
        for (const err of result.errors.slice(0, 10)) {
          console.log(`  - ${err.identifier}: ${err.error}`);
        }
        if (result.errors.length > 10) {
          console.log(`  ... and ${result.errors.length - 10} more`);
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

      // Show sample of what was ingested
      if (result.successful > 0 && documents.length > 0) {
        console.log('\n=== Sample Documents ===');
        const samples = documents.slice(0, 3);
        for (const doc of samples) {
          console.log(`\nTitle: ${doc.name}`);
          console.log(`Tags: ${(doc.metadata?.tags as string[])?.join(', ')}`);
          console.log(`Department: ${doc.metadata?.department}`);
        }
      }

      if (opts.dryRun) {
        console.log('\n[DRY RUN] No data was inserted into the database.');
      }

      if (result.failed > 0) {
        process.exit(1);
      }

      logger.info('Slack ingestion complete', {
        total: result.total,
        successful: result.successful,
        failed: result.failed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Slack ingestion failed', { error: message });
      console.error(`\nError: ${message}`);
      process.exit(1);
    }
  });

// Add channels list command
program
  .command('list-channels')
  .description('List default channels to be ingested')
  .action(() => {
    console.log('Default Slack channels for ingestion:\n');
    for (const channel of DEFAULT_SLACK_CHANNELS) {
      console.log(`  - ${channel}`);
    }
    console.log(`\nTotal: ${DEFAULT_SLACK_CHANNELS.length} channels`);
  });

program.parse();
