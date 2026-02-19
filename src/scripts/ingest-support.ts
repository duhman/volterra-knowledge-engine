#!/usr/bin/env node
/**
 * Ingest Customer Support material from Notion into Supabase
 * Targets specific support-related pages and databases
 */
import 'dotenv/config';
import { Command } from 'commander';
import { NotionSource, type NotionListOptions } from '../sources/notion-source.js';
import { processSourceDocuments } from '../core/document-processor.js';
import { generateComplianceReport } from '../compliance/index.js';
import { logger } from '../utils/logger.js';
import type { IngestionOptions, AccessLevel, SourceDocument } from '../types/index.js';

/**
 * Known Support Content Page IDs from Notion
 * These are the root pages containing support/KB material
 */
const SUPPORT_PAGE_IDS = {
  // [SE] Call Center Resources - Swedish call center training & guides
  seCallCenter: 'cae12710-e24b-4b6e-a160-64f7455cce9c',
  
  // Support main page - Process docs and structure
  supportMain: '28d58b6a-accb-8010-9b0b-caca1a66b0a8',
  
  // Support (alternative/legacy)
  supportLegacy: 'b3b6de07-5d27-4a64-ada8-573e5fb48d14',
  
  // Payment - Information and guides
  paymentGuides: '5ec17cd5-43c2-48de-88b5-96f2b25dec0b',
  
  // User guide - Ampeco
  ampecoGuide: '25356eb5-ccb8-4af6-9ff3-08661bfb2c9a',
  
  // Call Centre Resources (main)
  callCenterMain: 'c1683bbe-3bb7-439c-94c4-267b0c1d5904',
  
  // Notion 101 Resources
  notion101: '12858b6a-accb-81e1-832c-f67e62c192e3',
  
  // Customer Support automation project
  supportAutomation: '15e58b6a-accb-803d-877e-d86365c63892',

  // Copy paste questions and answers for ticketing
  ticketingQA: 'b3bfe0c80fad41c4a608cdb8a79bbcc5',
  
  // Troubleshooting Guide
  troubleshootingGuide: 'e79c1a0112784433b1cf3b4e9a866b0e',
  
  // Escalation to different operations teams
  escalationGuide: '14358b6aaccb80e9aa5bc90aa53824cb',
  
  // Recurring issues submitted to team platform
  recurringIssues: '2a958b6aaccb80fc8527cc870bb385f3',
};

/**
 * Known Support Database IDs from Notion
 */
const SUPPORT_DATABASE_IDS = {
  // Vanlige saker og hvordan løse dem (common issues and solutions)
  vanligeSaker: '25758b6aaccb814f85cdd504395e9e49',
};

/**
 * Preset configurations for different support content types
 */
const PRESETS: Record<string, { pageIds: string[]; databaseIds?: string[]; tags: string[]; description: string }> = {
  'call-center': {
    pageIds: [SUPPORT_PAGE_IDS.seCallCenter, SUPPORT_PAGE_IDS.callCenterMain],
    tags: ['call-center', 'training', 'scripts', 'notion'],
    description: 'Call center training materials and scripts',
  },
  'support-docs': {
    pageIds: [SUPPORT_PAGE_IDS.supportMain, SUPPORT_PAGE_IDS.supportLegacy],
    tags: ['support', 'process', 'escalation', 'notion'],
    description: 'Support process documentation',
  },
  'payment': {
    pageIds: [SUPPORT_PAGE_IDS.paymentGuides],
    tags: ['payment', 'billing', 'refund', 'notion'],
    description: 'Payment and billing guides',
  },
  'user-guides': {
    pageIds: [SUPPORT_PAGE_IDS.ampecoGuide],
    tags: ['user-guide', 'ampeco', 'platform', 'notion'],
    description: 'Platform user guides (Ampeco)',
  },
  'ticketing-kb': {
    pageIds: [
      SUPPORT_PAGE_IDS.ticketingQA,
      SUPPORT_PAGE_IDS.troubleshootingGuide,
      SUPPORT_PAGE_IDS.escalationGuide,
      SUPPORT_PAGE_IDS.recurringIssues,
    ],
    databaseIds: [SUPPORT_DATABASE_IDS.vanligeSaker],
    tags: ['support', 'kb', 'ticketing', 'notion'],
    description: 'Ticketing KB: Q&A, troubleshooting, escalation guides, and common issues database',
  },
  'all': {
    pageIds: Object.values(SUPPORT_PAGE_IDS),
    databaseIds: Object.values(SUPPORT_DATABASE_IDS),
    tags: ['support', 'kb', 'notion'],
    description: 'All support content (pages + databases)',
  },
};

const program = new Command();

program
  .name('ingest-support')
  .description('Ingest Customer Support material from Notion into Supabase')
  .option('-p, --preset <preset>', `Preset to use: ${Object.keys(PRESETS).join(', ')}`, 'all')
  .option('--page-ids <ids>', 'Comma-separated Notion page IDs (overrides preset)')
  .option('--database-ids <ids>', 'Comma-separated Notion database IDs (overrides preset)')
  .option('-r, --recursive', 'Recursively fetch child pages', true)
  .option('--max-depth <n>', 'Maximum recursion depth', parseInt, 3)
  .option('-d, --department <dept>', 'Department', 'Support')
  .option('-t, --type <type>', 'Document type', 'Knowledge Base')
  .option('-o, --owner <owner>', 'Document owner')
  .option('-a, --access <level>', 'Access level (public, internal, restricted, confidential)', 'internal')
  .option('--tags <tags>', 'Additional comma-separated tags')
  .option('--enable-chunking', 'Enable document chunking for long pages', true)
  .option('--max-chunk-size <n>', 'Maximum chunk size in characters', parseInt, 2000)
  .option('--dry-run', 'Validate without inserting into database')
  .option('--limit <n>', 'Maximum number of pages to process', parseInt)
  .option('--list-presets', 'List available presets and exit')
  .action(async (opts) => {
    // List presets mode
    if (opts.listPresets) {
      console.log('\nAvailable presets:\n');
      for (const [name, config] of Object.entries(PRESETS)) {
        console.log(`  ${name}`);
        console.log(`    Description: ${config.description}`);
        console.log(`    Pages: ${config.pageIds.length}`);
        console.log(`    Databases: ${config.databaseIds?.length || 0}`);
        console.log(`    Tags: ${config.tags.join(', ')}`);
        console.log();
      }
      process.exit(0);
    }

    try {
      logger.info('Starting Support content ingestion', { options: opts });

      // Check configuration
      if (!process.env.NOTION_API_KEY) {
        console.error('Error: NOTION_API_KEY environment variable is not set');
        console.log('\nTo configure Notion access:');
        console.log('1. Create an integration at https://www.notion.so/my-integrations');
        console.log('2. Share the support pages with your integration');
        console.log('3. Set the NOTION_API_KEY environment variable');
        process.exit(1);
      }

      // Determine page IDs and database IDs to fetch
      let pageIds: string[] = [];
      let databaseIds: string[] = [];
      let presetTags: string[] = [];

      if (opts.pageIds || opts.databaseIds) {
        // Custom IDs override preset
        if (opts.pageIds) {
          pageIds = opts.pageIds.split(',').map((id: string) => id.trim());
          console.log(`Using custom page IDs: ${pageIds.length} pages`);
        }
        if (opts.databaseIds) {
          databaseIds = opts.databaseIds.split(',').map((id: string) => id.trim());
          console.log(`Using custom database IDs: ${databaseIds.length} databases`);
        }
      } else {
        const preset = PRESETS[opts.preset];
        if (!preset) {
          console.error(`Unknown preset: ${opts.preset}`);
          console.log(`Available presets: ${Object.keys(PRESETS).join(', ')}`);
          process.exit(1);
        }
        pageIds = preset.pageIds;
        databaseIds = preset.databaseIds || [];
        presetTags = preset.tags;
        console.log(`Using preset "${opts.preset}": ${preset.description}`);
      }

      // Merge tags
      const allTags = [
        ...presetTags,
        ...(opts.tags?.split(',').map((t: string) => t.trim()) || []),
      ];

      const ingestionOptions: IngestionOptions = {
        department: opts.department,
        documentType: opts.type,
        owner: opts.owner,
        accessLevel: opts.access as AccessLevel,
        tags: allTags.length > 0 ? allTags : undefined,
        dryRun: opts.dryRun,
        enableChunking: opts.enableChunking,
        maxChunkSize: opts.maxChunkSize,
      };

      // Initialize source
      const source = new NotionSource();
      await source.initialize();

      // Fetch pages and database pages separately, then merge (dedup by id)
      console.log(`\nFetching Notion content (recursive: ${opts.recursive}, maxDepth: ${opts.maxDepth})...`);
      
      const allDocuments: Map<string, SourceDocument> = new Map();

      // Fetch from page IDs
      if (pageIds.length > 0) {
        console.log(`  - Fetching ${pageIds.length} page roots...`);
        const pageListOptions: NotionListOptions = {
          pageIds,
          recursive: opts.recursive,
          maxDepth: opts.maxDepth,
          limit: opts.limit,
        };
        const pageDocs = await source.listDocuments(pageListOptions);
        for (const doc of pageDocs) {
          allDocuments.set(doc.id, doc);
        }
        console.log(`    Found ${pageDocs.length} pages`);
      }

      // Fetch from database IDs
      if (databaseIds.length > 0) {
        console.log(`  - Fetching from ${databaseIds.length} databases...`);
        const dbListOptions: NotionListOptions = {
          databaseIds,
          limit: opts.limit ? opts.limit - allDocuments.size : undefined,
        };
        const dbDocs = await source.listDocuments(dbListOptions);
        for (const doc of dbDocs) {
          if (!allDocuments.has(doc.id)) {
            allDocuments.set(doc.id, doc);
          }
        }
        console.log(`    Found ${dbDocs.length} database pages`);
      }

      const documents = Array.from(allDocuments.values());

      if (documents.length === 0) {
        console.log('No pages found. Make sure:');
        console.log('  1. Your integration has access to the pages');
        console.log('  2. The page IDs are correct');
        console.log('  3. The pages have content');
        process.exit(0);
      }

      console.log(`Found ${documents.length} pages to process\n`);

      // Show document list
      console.log('Pages to ingest:');
      for (const doc of documents.slice(0, 10)) {
        const depth = (doc.metadata?.depth as number) || 0;
        const indent = '  '.repeat(depth);
        console.log(`${indent}- ${doc.name}`);
      }
      if (documents.length > 10) {
        console.log(`  ... and ${documents.length - 10} more\n`);
      }

      if (opts.dryRun) {
        console.log('\n[DRY RUN] No documents will be inserted into the database.\n');
      }

      // Process documents
      const result = await processSourceDocuments(
        documents,
        { ...source.getDefaultIngestionOptions(), ...ingestionOptions },
        {
          onProgress: (processed, total) => {
            process.stdout.write(`\rProcessing: ${processed}/${total}`);
          },
          downloadContent: (doc) => source.downloadDocument(doc),
        }
      );

      console.log('\n');
      console.log('=== Support Content Ingestion Summary ===');
      console.log(`Preset:       ${opts.preset}`);
      console.log(`Total pages:  ${result.total}`);
      console.log(`Successful:   ${result.successful}`);
      console.log(`Failed:       ${result.failed}`);
      
      if (ingestionOptions.enableChunking) {
        console.log(`Chunking:     Enabled (max ${opts.maxChunkSize} chars)`);
      }

      if (result.errors.length > 0) {
        console.log('\nFailed pages:');
        for (const err of result.errors.slice(0, 5)) {
          console.log(`  - ${err.identifier}: ${err.error}`);
        }
        if (result.errors.length > 5) {
          console.log(`  ... and ${result.errors.length - 5} more errors`);
        }
      }

      // Print compliance report
      if (result.auditLogs.length > 0) {
        const report = generateComplianceReport(result.auditLogs);
        console.log('\n=== Compliance Report ===');
        console.log(`Documents scanned:  ${report.totalDocuments}`);
        console.log(`Documents with PII: ${report.documentsWithPII}`);
        if (Object.keys(report.piiTypeBreakdown).length > 0) {
          console.log('PII Types found:');
          for (const [type, count] of Object.entries(report.piiTypeBreakdown)) {
            console.log(`  - ${type}: ${count}`);
          }
        }
      }

      console.log('\n=== Next Steps ===');
      console.log('1. Verify ingested documents in Supabase:');
      console.log("   SELECT title, department, tags FROM documents WHERE 'support' = ANY(tags) LIMIT 10;");
      console.log('2. Test semantic search:');
      console.log("   SELECT * FROM match_documents('<embedding>', 0.7, 5, 'Support', NULL);");

      if (result.failed > 0) {
        process.exit(1);
      }

      logger.info('Support content ingestion complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Support content ingestion failed', { error: message });
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
