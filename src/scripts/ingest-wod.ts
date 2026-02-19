#!/usr/bin/env node
/**
 * CLI script for ingesting Wheel of Deal (WoD) Excel files into Supabase
 * Supports batch processing, deduplication, and embedding generation
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { WodParser } from '../parsers/wod-parser.js';
import { getSupabaseClient } from '../database/supabase-client.js';
import { generateEmbedding } from '../core/embedding-service.js';
import { logger } from '../utils/logger.js';
import type {
  WodDeal,
  WodCostCatalogItem,
  WodStaticConfig,
  WodMarket,
  WodIngestionResult,
} from '../types/wod.js';

const program = new Command();

program
  .name('ingest-wod')
  .description('Ingest Wheel of Deal Excel files into Supabase')
  .option('-d, --directory <path>', 'Directory containing WoD Excel files')
  .option('-f, --file <path>', 'Single WoD file to ingest')
  .option('-m, --market <market>', 'Market filter (SE, NO, DK, DE)')
  .option('--extract-static', 'Extract static data (cost catalog, config) from templates')
  .option('--skip-existing', 'Skip files that already exist by source_path', true)
  .option('--dry-run', 'Parse and validate without inserting into database')
  .option('--stats-only', 'Show file statistics without processing')
  .option('--limit <n>', 'Maximum number of files to process', parseInt)
  .option('--no-embeddings', 'Skip embedding generation')
  .option('--no-documents', 'Do not insert summary into documents table')
  .action(async (opts) => {
    try {
      logger.info('Starting WoD ingestion', { options: opts });

      console.log('=== Wheel of Deal Ingestion ===\n');

      // Determine files to process
      const files = await discoverFiles(opts);

      if (files.length === 0) {
        console.log('No WoD files found to process.');
        process.exit(0);
      }

      console.log(`Found ${files.length} WoD files\n`);

      if (opts.statsOnly) {
        await showStats(files);
        process.exit(0);
      }

      // Filter by limit
      const filesToProcess = opts.limit ? files.slice(0, opts.limit) : files;
      console.log(`Processing ${filesToProcess.length} files\n`);

      // Initialize
      const parser = new WodParser();
      const result: WodIngestionResult = {
        totalFiles: filesToProcess.length,
        processedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
        dealsInserted: 0,
        catalogItemsInserted: 0,
        configItemsInserted: 0,
        errors: [],
      };

      // Get existing source paths for deduplication
      let existingPaths = new Set<string>();
      if (opts.skipExisting && !opts.dryRun) {
        console.log('Checking for existing deals...');
        existingPaths = await getExistingWodSourcePaths();
        console.log(`Found ${existingPaths.size} existing deals\n`);
      }

      // Process each file
      for (let i = 0; i < filesToProcess.length; i++) {
        const filePath = filesToProcess[i];
        const filename = path.basename(filePath);

        process.stdout.write(`\r[${i + 1}/${filesToProcess.length}] Processing: ${filename.substring(0, 50).padEnd(50)}`);

        try {
          // Read file
          const buffer = fs.readFileSync(filePath);

          // Parse
          const parseResult = await parser.parse(buffer, filename, {
            extractStaticData: opts.extractStatic,
            market: opts.market as WodMarket | undefined,
          });

          // Skip templates unless extracting static data
          if (parseResult.isTemplate && !opts.extractStatic) {
            result.skippedFiles++;
            continue;
          }

          // Skip if already exists
          if (parseResult.deal.sourcePath && existingPaths.has(parseResult.deal.sourcePath)) {
            result.skippedFiles++;
            continue;
          }

          // Generate embedding if enabled
          let embedding: number[] | undefined;
          let embeddingContent: string | undefined;
          if (opts.embeddings !== false) {
            embeddingContent = parser.generateEmbeddingContent(parseResult.deal);
            const embeddingResult = await generateEmbedding(embeddingContent);
            embedding = embeddingResult.embedding;
          }

          // Insert into database
          if (!opts.dryRun) {
            await insertWodData(
              parseResult.deal,
              parseResult.costCatalog,
              parseResult.staticConfig,
              embedding,
              embeddingContent,
              opts.documents !== false
            );
            result.dealsInserted++;
            if (parseResult.costCatalog) {
              result.catalogItemsInserted += parseResult.costCatalog.length;
            }
            if (parseResult.staticConfig) {
              result.configItemsInserted += parseResult.staticConfig.length;
            }
          }

          result.processedFiles++;

          // Log warnings
          if (parseResult.warnings.length > 0) {
            logger.warn('Parse warnings', { filename, warnings: parseResult.warnings });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.failedFiles++;
          result.errors.push({
            filename,
            error: message,
            timestamp: new Date(),
          });
          logger.error('Failed to process file', { filename, error: message });
        }
      }

      // Print summary
      console.log('\n\n=== WoD Ingestion Summary ===');
      console.log(`Total files:        ${result.totalFiles}`);
      console.log(`Processed:          ${result.processedFiles}`);
      console.log(`Skipped:            ${result.skippedFiles}`);
      console.log(`Failed:             ${result.failedFiles}`);
      console.log(`Deals inserted:     ${result.dealsInserted}`);
      if (result.catalogItemsInserted > 0) {
        console.log(`Catalog items:      ${result.catalogItemsInserted}`);
      }
      if (result.configItemsInserted > 0) {
        console.log(`Config items:       ${result.configItemsInserted}`);
      }

      if (result.errors.length > 0) {
        console.log('\nErrors:');
        for (const err of result.errors.slice(0, 10)) {
          console.log(`  - ${err.filename}: ${err.error}`);
        }
        if (result.errors.length > 10) {
          console.log(`  ... and ${result.errors.length - 10} more`);
        }
      }

      if (opts.dryRun) {
        console.log('\n[DRY RUN] No data was inserted into the database.');
      }

      if (result.failedFiles > 0) {
        process.exit(1);
      }

      logger.info('WoD ingestion complete', result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('WoD ingestion failed', { error: message });
      console.error(`\nError: ${message}`);
      process.exit(1);
    }
  });

// Parse single file command
program
  .command('parse <file>')
  .description('Parse a single WoD file and show extracted data')
  .option('-m, --market <market>', 'Market override (SE, NO, DK, DE)')
  .option('--extract-static', 'Extract static data')
  .action(async (file, opts) => {
    try {
      const parser = new WodParser();
      const buffer = fs.readFileSync(file);
      const result = await parser.parse(buffer, path.basename(file), {
        extractStaticData: opts.extractStatic,
        market: opts.market as WodMarket | undefined,
      });

      console.log('=== WoD Parse Result ===\n');
      console.log(`File: ${path.basename(file)}`);
      console.log(`Is Template: ${result.isTemplate}`);
      console.log(`Template Version: ${result.templateVersion}`);
      console.log(`Market: ${result.market}\n`);

      console.log('--- Deal Data ---');
      console.log(`Name: ${result.deal.dealName}`);
      console.log(`Location: ${result.deal.geographicArea}, ${result.deal.country}`);
      console.log(`Parking Spaces: ${result.deal.totalParkingSpaces}`);
      console.log(`Housing Units: ${result.deal.housingUnits || 'N/A'}`);
      console.log(`Charger Type: ${result.deal.chargerType || 'N/A'}`);
      console.log(`Total Boxes: ${result.deal.totalBoxes}`);
      console.log(`Total Infrastructure PS: ${result.deal.totalInfrastructurePs}`);
      console.log(`Digging Required: ${result.deal.diggingRequired}`);
      console.log(`Creator: ${result.deal.creatorName || 'N/A'}`);
      console.log(`Deal Date: ${result.deal.dealDate?.toISOString().split('T')[0] || 'N/A'}`);

      if (result.deal.circuits.length > 0) {
        console.log('\n--- Circuits ---');
        for (const circuit of result.deal.circuits) {
          console.log(`  Circuit ${circuit.circuitNumber}: ${circuit.boxesCount} boxes, ${circuit.infrastructurePs} ps, ${circuit.parkingType || 'unspecified'}`);
        }
      }

      console.log('\n--- Economics ---');
      console.log(`Total Cost (excl VAT): ${result.deal.totalCostExclVat?.toFixed(0) || 'N/A'} SEK`);
      console.log(`Material Cost: ${result.deal.totalMaterialCost?.toFixed(0) || 'N/A'} SEK`);
      console.log(`Work Cost: ${result.deal.totalWorkCost?.toFixed(0) || 'N/A'} SEK`);
      console.log(`Gross Margin (buy): ${result.deal.grossMarginBuy?.toFixed(0) || 'N/A'} SEK`);
      console.log(`Gross Margin (rent): ${result.deal.grossMarginRent?.toFixed(0) || 'N/A'} SEK`);

      if (result.deal.costs.length > 0) {
        console.log('\n--- Cost Breakdown ---');
        const byCategory = new Map<string, number>();
        for (const cost of result.deal.costs) {
          const current = byCategory.get(cost.costCategory) || 0;
          byCategory.set(cost.costCategory, current + cost.totalCost);
        }
        for (const [category, total] of byCategory) {
          console.log(`  ${category}: ${total.toFixed(0)} SEK`);
        }
      }

      if (result.deal.offers.length > 0) {
        console.log('\n--- Offers ---');
        for (const offer of result.deal.offers) {
          console.log(`  ${offer.offerType}: ${offer.oneTimeCost?.toFixed(0) || 'N/A'} SEK one-time, ${offer.monthlyFee?.toFixed(0) || 'N/A'} SEK/month`);
        }
      }

      if (result.costCatalog && result.costCatalog.length > 0) {
        console.log(`\n--- Cost Catalog (${result.costCatalog.length} items) ---`);
        const byCategory = new Map<string, number>();
        for (const item of result.costCatalog) {
          byCategory.set(item.category, (byCategory.get(item.category) || 0) + 1);
        }
        for (const [category, count] of byCategory) {
          console.log(`  ${category}: ${count} items`);
        }
      }

      if (result.staticConfig && result.staticConfig.length > 0) {
        console.log(`\n--- Static Config (${result.staticConfig.length} items) ---`);
        const byType = new Map<string, number>();
        for (const config of result.staticConfig) {
          byType.set(config.configType, (byType.get(config.configType) || 0) + 1);
        }
        for (const [type, count] of byType) {
          console.log(`  ${type}: ${count} items`);
        }
      }

      if (result.warnings.length > 0) {
        console.log('\n--- Warnings ---');
        for (const warning of result.warnings) {
          console.log(`  - ${warning}`);
        }
      }

      if (result.errors.length > 0) {
        console.log('\n--- Errors ---');
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
      }

      // Show embedding content
      console.log('\n--- Embedding Content ---');
      console.log(parser.generateEmbeddingContent(result.deal));

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function discoverFiles(opts: { directory?: string; file?: string; market?: string }): Promise<string[]> {
  if (opts.file) {
    if (!fs.existsSync(opts.file)) {
      throw new Error(`File not found: ${opts.file}`);
    }
    return [opts.file];
  }

  if (opts.directory) {
    if (!fs.existsSync(opts.directory)) {
      throw new Error(`Directory not found: ${opts.directory}`);
    }

    const files: string[] = [];
    const entries = fs.readdirSync(opts.directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.xlsm' || ext === '.xlsx') {
          // Filter by market if specified
          if (opts.market) {
            const upper = entry.name.toUpperCase();
            if (!upper.includes(` ${opts.market} `) && !upper.includes(`_${opts.market}_`)) {
              continue;
            }
          }
          files.push(path.join(opts.directory, entry.name));
        }
      }
    }

    return files.sort();
  }

  throw new Error('Either --directory or --file must be specified');
}

async function showStats(files: string[]): Promise<void> {
  console.log('=== File Statistics ===\n');

  const byMarket = new Map<string, number>();
  const parser = new WodParser();

  for (const file of files) {
    try {
      const buffer = fs.readFileSync(file);
      const result = await parser.parse(buffer, path.basename(file), { skipValidation: true });
      const market = result.market;
      byMarket.set(market, (byMarket.get(market) || 0) + 1);
    } catch {
      byMarket.set('error', (byMarket.get('error') || 0) + 1);
    }
  }

  console.log('Files by market:');
  for (const [market, count] of byMarket) {
    console.log(`  ${market}: ${count}`);
  }
  console.log(`\nTotal: ${files.length} files`);
}

async function getExistingWodSourcePaths(): Promise<Set<string>> {
  const client = getSupabaseClient();
  const existing = new Set<string>();

  const { data, error } = await client
    .from('wod_deals')
    .select('source_path');

  if (error) {
    logger.warn('Error fetching existing WoD source paths', { error: error.message });
    return existing;
  }

  for (const row of data || []) {
    if (row.source_path) {
      existing.add(row.source_path);
    }
  }

  return existing;
}

async function insertWodData(
  deal: WodDeal,
  costCatalog: WodCostCatalogItem[] | undefined,
  staticConfig: WodStaticConfig[] | undefined,
  embedding: number[] | undefined,
  embeddingContent: string | undefined,
  insertIntoDocuments: boolean
): Promise<void> {
  const client = getSupabaseClient();

  // Insert deal
  const { data: dealData, error: dealError } = await client
    .from('wod_deals')
    .insert({
      deal_name: deal.dealName,
      deal_reference: deal.dealReference,
      geographic_area: deal.geographicArea,
      country: deal.country,
      zone: deal.zone,
      total_parking_spaces: deal.totalParkingSpaces,
      housing_units: deal.housingUnits,
      guest_parking: deal.guestParking,
      real_potential: deal.realPotential,
      power_level: deal.powerLevel,
      charger_type: deal.chargerType,
      digging_required: deal.diggingRequired,
      asphalt_digging_meters: deal.asphaltDiggingMeters,
      green_space_digging_meters: deal.greenSpaceDiggingMeters,
      signal_coverage_available: deal.signalCoverageAvailable,
      total_boxes: deal.totalBoxes,
      total_infrastructure_ps: deal.totalInfrastructurePs,
      total_cost_excl_vat: deal.totalCostExclVat,
      total_material_cost: deal.totalMaterialCost,
      total_work_cost: deal.totalWorkCost,
      gross_margin_buy: deal.grossMarginBuy,
      gross_margin_rent: deal.grossMarginRent,
      markup_percentage: deal.markupPercentage,
      start_fee_incl_vat: deal.startFeeInclVat,
      start_fee_gron_teknik: deal.startFeeGronTeknik,
      admin_fee_incl_vat: deal.adminFeeInclVat,
      rent_monthly_buy: deal.rentMonthlyBuy,
      rent_monthly_rent: deal.rentMonthlyRent,
      purchase_total_excl_subsidy: deal.purchaseTotalExclSubsidy,
      purchase_total_with_subsidy: deal.purchaseTotalWithSubsidy,
      raw_inputs: deal.rawInputs as unknown as Record<string, never>,
      raw_economy: deal.rawEconomy as unknown as Record<string, never>,
      raw_cost_output: deal.rawCostOutput as unknown as Record<string, never>,
      creator_name: deal.creatorName,
      four_eyes_name: deal.fourEyesName,
      deal_date: deal.dealDate?.toISOString().split('T')[0],
      source_path: deal.sourcePath,
      original_filename: deal.originalFilename,
      template_version: deal.templateVersion,
      file_hash: deal.fileHash,
      embedding: embedding ? `[${embedding.join(',')}]` : null,
      embedding_content: embeddingContent,
      sensitivity: 'PII',
    })
    .select('id')
    .single();

  if (dealError) {
    throw new Error(`Failed to insert deal: ${dealError.message}`);
  }

  const dealId = dealData.id;

  // Insert circuits
  if (deal.circuits.length > 0) {
    const circuitRecords = deal.circuits.map(c => ({
      deal_id: dealId,
      circuit_number: c.circuitNumber,
      boxes_count: c.boxesCount,
      infrastructure_ps: c.infrastructurePs,
      parking_type: c.parkingType,
      available_power_amps: c.availablePowerAmps,
      available_fuse_space: c.availableFuseSpace,
      required_min_power_kw: c.requiredMinPowerKw,
      required_min_fuse_amps: c.requiredMinFuseAmps,
      cable_from_cabinet: c.cableFromCabinet,
      cable_distance_first_box: c.cableDistanceFirstBox,
      additional_cable_meters: c.additionalCableMeters,
      existing_cable: c.existingCable,
      existing_cable_dimension: c.existingCableDimension,
      signal_coverage: c.signalCoverage,
    }));

    const { error: circuitError } = await client
      .from('wod_deal_circuits')
      .insert(circuitRecords);

    if (circuitError) {
      logger.warn('Failed to insert circuits', { error: circuitError.message, dealId });
    }
  }

  // Insert costs
  if (deal.costs.length > 0) {
    const costRecords = deal.costs.map(c => ({
      deal_id: dealId,
      cost_category: c.costCategory,
      item_name: c.itemName,
      quantity: c.quantity,
      unit: c.unit,
      unit_cost: c.unitCost,
      total_cost: c.totalCost,
      labor_hours: c.laborHours,
      labor_cost: c.laborCost,
    }));

    const { error: costError } = await client
      .from('wod_deal_costs')
      .insert(costRecords);

    if (costError) {
      logger.warn('Failed to insert costs', { error: costError.message, dealId });
    }
  }

  // Insert offers
  if (deal.offers.length > 0) {
    const offerRecords = deal.offers.map(o => ({
      deal_id: dealId,
      offer_type: o.offerType,
      included_materials: o.includedMaterials as unknown as Record<string, never>[],
      included_work: o.includedWork as unknown as Record<string, never>[],
      one_time_cost: o.oneTimeCost,
      one_time_cost_with_subsidy: o.oneTimeCostWithSubsidy,
      monthly_fee: o.monthlyFee,
      start_fee: o.startFee,
      subsidy_eligible: o.subsidyEligible,
      subsidy_percentage: o.subsidyPercentage,
      subsidy_amount: o.subsidyAmount,
      binding_period_months: o.bindingPeriodMonths,
      notice_period_months: o.noticePeriodMonths,
      offer_text: o.offerText,
    }));

    const { error: offerError } = await client
      .from('wod_deal_offers')
      .insert(offerRecords);

    if (offerError) {
      logger.warn('Failed to insert offers', { error: offerError.message, dealId });
    }
  }

  // Insert cost catalog items (if extracting static data)
  if (costCatalog && costCatalog.length > 0) {
    const catalogRecords = costCatalog.map(c => ({
      component_name: c.componentName,
      category: c.category,
      subcategory: c.subcategory,
      supplier: c.supplier,
      supplier_article_number: c.supplierArticleNumber,
      unit_cost: c.unitCost,
      unit: c.unit,
      labor_hourly_rate: c.laborHourlyRate,
      labor_time_minutes: c.laborTimeMinutes,
      labor_cost: c.laborCost,
      market: c.market,
      template_version: c.templateVersion,
    }));

    // Use upsert to handle duplicates
    const { error: catalogError } = await client
      .from('wod_cost_catalog')
      .upsert(catalogRecords, {
        onConflict: 'component_name,category,market,template_version',
      });

    if (catalogError) {
      logger.warn('Failed to insert cost catalog', { error: catalogError.message });
    }
  }

  // Insert static config (if extracting static data)
  if (staticConfig && staticConfig.length > 0) {
    const configRecords = staticConfig.map(c => ({
      config_type: c.configType,
      config_key: c.configKey,
      config_value: c.configValue as unknown as Record<string, never>,
      market: c.market,
      country: c.country,
      facility_type: c.facilityType,
      charger_model: c.chargerModel,
      template_version: c.templateVersion,
      description: c.description,
    }));

    // Use upsert to handle duplicates
    const { error: configError } = await client
      .from('wod_static_config')
      .upsert(configRecords, {
        onConflict: 'config_type,config_key,market,template_version',
        ignoreDuplicates: true,
      });

    if (configError) {
      logger.warn('Failed to insert static config', { error: configError.message });
    }
  }

  // Also insert into documents table for unified RAG search
  if (insertIntoDocuments && embedding && embeddingContent) {
    const { error: docError } = await client
      .from('documents')
      .insert({
        content: embeddingContent,
        embedding: `[${embedding.join(',')}]`,
        department: 'sales',
        document_type: 'wod-deal',
        title: `Wheel of Deal: ${deal.dealName}`,
        access_level: 'internal',
        tags: ['wod', 'deal', deal.chargerType || 'charger', deal.country].filter(Boolean),
        sensitivity: 'PII',
        source_type: 'file',
        source_path: deal.sourcePath,
        original_filename: deal.originalFilename,
      });

    if (docError) {
      logger.warn('Failed to insert into documents', { error: docError.message, dealName: deal.dealName });
    }
  }
}

program.parse();
