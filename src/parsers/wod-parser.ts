/**
 * Specialized parser for Wheel of Deal (WoD) Excel files
 * Extracts structured deal data, cost catalog, and configuration from .xlsm files
 */

import * as XLSX from 'xlsx';
import * as crypto from 'crypto';
import { logger } from '../utils/logger.js';
import type {
  WodParseResult,
  WodParseOptions,
  WodDeal,
  WodCircuit,
  WodCostItem,
  WodOffer,
  WodOfferLineItem,
  WodCostCatalogItem,
  WodStaticConfig,
  WodRawInputs,
  WodMarket,
  WodChargerType,
  WodPowerLevel,
  WodParkingType,
  WodCostCategory,
} from '../types/wod.js';

// Sheet name constants
const SHEETS = {
  WOD: 'WoD',
  COST_OUTPUT: 'Cost output',
  COST_LIST: 'Cost list',
  ECONOMY: 'Economy',
  PROJECT_MANAGER: 'Project Manager',
  STATIC_VALUES: 'Static values',
  COMMON_INPUT: 'Common input Shared Rent Driver',
  OFFERT_KOP: 'Offert - köp',
  OFFERT_HYR: 'Offert - hyr',
  OFFERT_BOX: 'Offert - box',
  LEXICON_RENT: 'Lexicon - Rent',
  LEXICON_BUY: 'Lexicon - Buy',
  REVISION_TABLE: 'Revision table',
} as const;

// Cell reference helpers (reserved for future use)

export class WodParser {
  private workbook: XLSX.WorkBook | null = null;
  private warnings: string[] = [];
  private errors: string[] = [];

  /**
   * Parse a WoD Excel file
   */
  async parse(buffer: Buffer, filename?: string, options?: WodParseOptions): Promise<WodParseResult> {
    this.warnings = [];
    this.errors = [];

    try {
      logger.debug('Parsing WoD file', { filename });

      // Load workbook
      this.workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

      // Detect market from filename or option
      const market = options?.market || this.detectMarket(filename);

      // Detect template version
      const templateVersion = options?.templateVersion || this.detectTemplateVersion();

      // Check if this is a template (no customer data) or filled file
      const isTemplate = this.isTemplateFile();

      // Parse deal data
      const deal = this.parseDeal(filename, market, templateVersion);

      // Parse static data if requested
      let costCatalog: WodCostCatalogItem[] | undefined;
      let staticConfig: WodStaticConfig[] | undefined;

      if (options?.extractStaticData || isTemplate) {
        costCatalog = this.parseCostCatalog(market, templateVersion);
        staticConfig = this.parseStaticConfig(market, templateVersion);
      }

      // Validate if not skipped
      if (!options?.skipValidation && !isTemplate) {
        this.validateDeal(deal);
      }

      // Calculate file hash for change detection
      deal.fileHash = crypto.createHash('md5').update(buffer).digest('hex');

      return {
        deal,
        costCatalog,
        staticConfig,
        isTemplate,
        templateVersion,
        market,
        warnings: this.warnings,
        errors: this.errors,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push(`Failed to parse WoD file: ${message}`);
      logger.error('WoD parsing failed', { filename, error: message });
      throw error;
    }
  }

  /**
   * Generate embedding content for a deal - semantic summary for LLM retrieval
   */
  generateEmbeddingContent(deal: WodDeal): string {
    const parts: string[] = [
      `Wheel of Deal for ${deal.dealName}`,
      `Location: ${deal.geographicArea}, ${deal.country}`,
      `Facility: ${deal.totalParkingSpaces} parking spaces, ${deal.housingUnits || 'unknown'} housing units`,
      `Installation: ${deal.totalBoxes} EV chargers (${deal.chargerType || 'type not specified'})`,
      `Infrastructure: ${deal.totalInfrastructurePs} parking spaces with infrastructure`,
    ];

    if (deal.powerLevel) {
      parts.push(`Power level: ${deal.powerLevel}`);
    }

    if (deal.diggingRequired) {
      parts.push('Digging required for installation');
    }

    if (deal.totalCostExclVat) {
      parts.push(`Total cost: ${deal.totalCostExclVat.toFixed(0)} SEK excl VAT`);
    }

    // Add circuit summary
    const circuitSummary = deal.circuits
      .filter(c => c.boxesCount > 0)
      .map(c => `Circuit ${c.circuitNumber}: ${c.boxesCount} boxes, ${c.parkingType || 'unspecified type'}`)
      .join('; ');
    if (circuitSummary) {
      parts.push(`Circuit configuration: ${circuitSummary}`);
    }

    // Add offer summary
    const offers = deal.offers.map(o => {
      if (o.offerType === 'buy') {
        return `Purchase option: ${o.oneTimeCost?.toFixed(0) || 'N/A'} SEK`;
      } else if (o.offerType === 'rent') {
        return `Rental option: ${o.monthlyFee?.toFixed(0) || 'N/A'} SEK/month`;
      } else {
        return `Box subscription: ${o.monthlyFee?.toFixed(0) || 'N/A'} SEK/month`;
      }
    });
    if (offers.length > 0) {
      parts.push(`Offers: ${offers.join(', ')}`);
    }

    return parts.join('\n');
  }

  // ==========================================================================
  // PRIVATE METHODS - Detection
  // ==========================================================================

  private detectMarket(filename?: string): WodMarket {
    if (!filename) return 'SE';

    const upper = filename.toUpperCase();
    if (upper.includes(' SE ') || upper.includes('_SE_') || upper.endsWith(' SE.XLSM')) return 'SE';
    if (upper.includes(' NO ') || upper.includes('_NO_')) return 'NO';
    if (upper.includes(' DK ') || upper.includes('_DK_')) return 'DK';
    if (upper.includes(' DE ') || upper.includes('_DE_')) return 'DE';

    // Default to SE
    return 'SE';
  }

  private detectTemplateVersion(): string {
    const sheet = this.getSheet(SHEETS.REVISION_TABLE);
    if (!sheet) return 'unknown';

    // Look for version in first column
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:F20');
    for (let row = range.s.r; row <= range.e.r; row++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: 0 })];
      if (cell?.v) {
        const val = String(cell.v);
        // Match version patterns like "6.4", "v8", etc.
        const match = val.match(/^(\d+\.?\d*)/);
        if (match) {
          return `v${match[1]}`;
        }
      }
    }

    return 'unknown';
  }

  private isTemplateFile(): boolean {
    // Check if project name is empty (row 4, col C in WoD sheet)
    const wodSheet = this.getSheet(SHEETS.WOD);
    if (!wodSheet) return true;

    const projectNameCell = wodSheet['C4'];
    return !projectNameCell?.v || String(projectNameCell.v).trim() === '';
  }

  // ==========================================================================
  // PRIVATE METHODS - Deal Parsing
  // ==========================================================================

  private parseDeal(filename: string | undefined, market: WodMarket, templateVersion: string): WodDeal {
    const wodSheet = this.getSheet(SHEETS.WOD);
    if (!wodSheet) {
      throw new Error('WoD sheet not found');
    }

    // Parse raw inputs first
    const rawInputs = this.parseRawInputs(wodSheet);

    // Extract main deal fields
    const deal: WodDeal = {
      dealName: this.getCellString(wodSheet, 'C4') || 'Unknown Project',
      geographicArea: this.getCellString(wodSheet, 'C5') || 'Unknown',
      country: market,
      zone: this.determineZone(this.getCellString(wodSheet, 'C5')),

      totalParkingSpaces: this.getCellNumber(wodSheet, 'C7') || 0,
      housingUnits: this.getCellNumber(wodSheet, 'C8'),
      guestParking: this.getCellNumber(wodSheet, 'C9'),
      realPotential: this.getCellNumber(wodSheet, 'C11'),

      powerLevel: this.getCellString(wodSheet, 'C31') as WodPowerLevel | undefined,
      chargerType: this.detectChargerType(wodSheet),

      diggingRequired: this.hasDigging(wodSheet),
      asphaltDiggingMeters: this.getCellNumber(wodSheet, 'C21'),
      greenSpaceDiggingMeters: this.getCellNumber(wodSheet, 'C22'),
      signalCoverageAvailable: this.getCellString(wodSheet, 'C28')?.toLowerCase() !== 'no',

      totalBoxes: this.calculateTotalFromCircuits(wodSheet, 4), // Row 4 = Boxes
      totalInfrastructurePs: this.calculateTotalFromCircuits(wodSheet, 5), // Row 5 = Infrastructure

      creatorName: this.getCellString(wodSheet, 'C13'),
      fourEyesName: this.getCellString(wodSheet, 'C14'),
      dealDate: this.parseDealDate(wodSheet),

      rawInputs,
      templateVersion,
      originalFilename: filename,

      circuits: [],
      costs: [],
      offers: [],
    };

    // Generate source path for deduplication
    const datePart = deal.dealDate ? deal.dealDate.toISOString().split('T')[0] : 'unknown';
    const namePart = deal.dealName.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
    deal.sourcePath = `wod://${market}/${namePart}/${templateVersion}/${datePart}`;

    // Parse circuits
    deal.circuits = this.parseCircuits(wodSheet);

    // Parse economy data
    this.parseEconomyData(deal);

    // Parse costs
    deal.costs = this.parseCosts();

    // Parse offers
    deal.offers = this.parseOffers(deal);

    return deal;
  }

  private parseRawInputs(sheet: XLSX.WorkSheet): WodRawInputs {
    return {
      projectName: this.getCellString(sheet, 'C4'),
      geographicArea: this.getCellString(sheet, 'C5'),
      totalParking: this.getCellNumber(sheet, 'C7'),
      apartments: this.getCellNumber(sheet, 'C8'),
      guestParking: this.getCellNumber(sheet, 'C9'),
      realPotential: this.getCellNumber(sheet, 'C11'),
      creatorName: this.getCellString(sheet, 'C13'),
      fourEyesName: this.getCellString(sheet, 'C14'),
      latestChange: this.getCellString(sheet, 'C16'),
      asphaltDigging: this.getCellNumber(sheet, 'C21'),
      greenSpaceDigging: this.getCellNumber(sheet, 'C22'),
      passingCurbstone: this.getCellNumber(sheet, 'C23'),
      holesInConcrete: this.getCellNumber(sheet, 'C26'),
      dismantlingHeaters: this.getCellNumber(sheet, 'C27'),
      signalCoverageAtCabinets: this.getCellString(sheet, 'C28')?.toLowerCase() === 'yes',
      powerLevel: this.getCellString(sheet, 'C31'),
      forceMinimumFuse: this.getCellString(sheet, 'C32'),
      forceMinimumCable: this.getCellString(sheet, 'C33'),
      startFeeRent: this.getCellNumber(sheet, 'C36'),
      additionalCostWorkElectrician: this.getCellNumber(sheet, 'C37'),
      additionalCostMaterialsElectrician: this.getCellNumber(sheet, 'C38'),
      additionalCostWorkDig: this.getCellNumber(sheet, 'C39'),
      additionalCostMaterialsDig: this.getCellNumber(sheet, 'C40'),
    };
  }

  private parseCircuits(wodSheet: XLSX.WorkSheet): WodCircuit[] {
    const circuits: WodCircuit[] = [];

    // Circuits are in columns H onwards (col index 7+), up to 20 circuits
    for (let circuitNum = 1; circuitNum <= 20; circuitNum++) {
      const col = 6 + circuitNum; // Column G is 6, H is 7, etc.
      const colLetter = XLSX.utils.encode_col(col);

      const boxesCount = this.getCellNumber(wodSheet, `${colLetter}4`) || 0;
      const infrastructurePs = this.getCellNumber(wodSheet, `${colLetter}5`) || 0;

      // Skip empty circuits
      if (boxesCount === 0 && infrastructurePs === 0) continue;

      const circuit: WodCircuit = {
        circuitNumber: circuitNum,
        boxesCount,
        infrastructurePs,
        parkingType: this.getCellString(wodSheet, `${colLetter}6`) as WodParkingType | undefined,
        availablePowerAmps: this.getCellNumber(wodSheet, `${colLetter}9`),
        availableFuseSpace: this.getCellString(wodSheet, `${colLetter}10`)?.toLowerCase() === 'yes',
        cableFromCabinet: this.getCellNumber(wodSheet, `${colLetter}13`),
        cableDistanceFirstBox: this.getCellNumber(wodSheet, `${colLetter}14`),
        signalCoverage: this.getCellString(wodSheet, `${colLetter}20`)?.toLowerCase() !== 'no',
      };

      circuits.push(circuit);
    }

    return circuits;
  }

  private parseEconomyData(deal: WodDeal): void {
    const economySheet = this.getSheet(SHEETS.ECONOMY);
    if (!economySheet) {
      this.warnings.push('Economy sheet not found');
      return;
    }

    deal.totalCostExclVat = this.getCellNumber(economySheet, 'D4');
    deal.totalWorkCost = this.getCellNumber(economySheet, 'D7');
    deal.totalMaterialCost = this.getCellNumber(economySheet, 'D14');
    deal.grossMarginBuy = this.getCellNumber(economySheet, 'B28');
    deal.grossMarginRent = this.getCellNumber(economySheet, 'B29');
    deal.markupPercentage = this.getCellNumber(economySheet, 'B30');
    deal.startFeeInclVat = this.getCellNumber(economySheet, 'B13');
    deal.startFeeGronTeknik = this.getCellNumber(economySheet, 'B14');
    deal.adminFeeInclVat = this.getCellNumber(economySheet, 'B15');
    deal.rentMonthlyBuy = this.getCellNumber(economySheet, 'B34');
    deal.rentMonthlyRent = this.getCellNumber(economySheet, 'L34');

    // Store raw economy data
    deal.rawEconomy = this.extractSheetAsJson(economySheet, 1, 40, 1, 15);
  }

  private parseCosts(): WodCostItem[] {
    const costSheet = this.getSheet(SHEETS.COST_OUTPUT);
    if (!costSheet) {
      this.warnings.push('Cost output sheet not found');
      return [];
    }

    const costs: WodCostItem[] = [];

    // Parse chargers section (rows 4-6)
    this.parseCostSection(costSheet, costs, 4, 6, 'charger');

    // Parse backplate section (rows 11-12)
    this.parseCostSection(costSheet, costs, 11, 12, 'backplate');

    // Parse box accessories (rows 19-21)
    this.parseCostSection(costSheet, costs, 19, 21, 'box_accessories');

    // Parse attachment (rows 26-32)
    this.parseCostSection(costSheet, costs, 26, 32, 'attachment');

    // Parse mounting (rows 36-40)
    this.parseCostSection(costSheet, costs, 36, 40, 'mounting');

    // Parse cable sections
    this.parseCostSection(costSheet, costs, 46, 70, 'cable');

    // Parse connectivity
    this.parseCostSection(costSheet, costs, 110, 130, 'connectivity');

    return costs;
  }

  private parseCostSection(
    sheet: XLSX.WorkSheet,
    costs: WodCostItem[],
    startRow: number,
    endRow: number,
    category: WodCostCategory
  ): void {
    for (let row = startRow; row <= endRow; row++) {
      const itemName = this.getCellString(sheet, `A${row}`);
      const quantity = this.getCellNumber(sheet, `B${row}`);
      const totalCost = this.getCellNumber(sheet, `D${row}`);

      if (itemName && (quantity || totalCost)) {
        costs.push({
          costCategory: category,
          itemName,
          quantity: quantity || 0,
          unit: this.getCellString(sheet, `C${row}`),
          totalCost: totalCost || 0,
        });
      }
    }
  }

  private parseOffers(deal: WodDeal): WodOffer[] {
    const offers: WodOffer[] = [];

    // Parse Buy offer
    const buyOffer = this.parseOffer('buy');
    if (buyOffer) offers.push(buyOffer);

    // Parse Rent offer
    const rentOffer = this.parseOffer('rent');
    if (rentOffer) offers.push(rentOffer);

    // Parse Box offer
    const boxOffer = this.parseBoxOffer(deal);
    if (boxOffer) offers.push(boxOffer);

    return offers;
  }

  private parseOffer(type: 'buy' | 'rent'): WodOffer | null {
    const sheetName = type === 'buy' ? SHEETS.OFFERT_KOP : SHEETS.OFFERT_HYR;
    const sheet = this.getSheet(sheetName);
    if (!sheet) return null;

    const materials: WodOfferLineItem[] = [];
    const work: WodOfferLineItem[] = [];

    // Parse included materials (typically rows 9-18 in column A-B)
    for (let row = 9; row <= 18; row++) {
      const qty = this.getCellNumber(sheet, `A${row}`);
      const desc = this.getCellString(sheet, `B${row}`);
      if (qty && desc) {
        materials.push({ quantity: qty, unit: 'st', description: desc });
      }
    }

    // Parse included work (typically column J-K)
    for (let row = 9; row <= 18; row++) {
      const qty = this.getCellNumber(sheet, `J${row}`);
      const desc = this.getCellString(sheet, `K${row}`);
      if (qty && desc) {
        work.push({ quantity: qty, unit: 'st', description: desc });
      }
    }

    return {
      offerType: type,
      includedMaterials: materials,
      includedWork: work,
      subsidyEligible: true, // Swedish market typically has Gron teknik
    };
  }

  private parseBoxOffer(deal: WodDeal): WodOffer | null {
    const sheet = this.getSheet(SHEETS.OFFERT_BOX);
    if (!sheet) return null;

    return {
      offerType: 'box',
      monthlyFee: deal.rentMonthlyBuy,
      startFee: deal.startFeeInclVat,
      oneTimeCost: deal.purchaseTotalExclSubsidy,
      oneTimeCostWithSubsidy: deal.purchaseTotalWithSubsidy,
      subsidyEligible: true,
      subsidyPercentage: 0.485, // 50% of 97%
    };
  }

  // ==========================================================================
  // PRIVATE METHODS - Static Data Parsing
  // ==========================================================================

  private parseCostCatalog(market: WodMarket, templateVersion: string): WodCostCatalogItem[] {
    const sheet = this.getSheet(SHEETS.COST_LIST);
    if (!sheet) return [];

    const items: WodCostCatalogItem[] = [];

    // Parse chargers (rows 4-6)
    for (let row = 4; row <= 6; row++) {
      const item = this.parseCatalogRow(sheet, row, 'charger', market, templateVersion);
      if (item) items.push(item);
    }

    // Parse backplates (rows 11-12)
    for (let row = 11; row <= 12; row++) {
      const item = this.parseCatalogRow(sheet, row, 'backplate', market, templateVersion);
      if (item) items.push(item);
    }

    // Parse box accessories (rows 19-21)
    for (let row = 19; row <= 21; row++) {
      const item = this.parseCatalogRow(sheet, row, 'box_accessories', market, templateVersion);
      if (item) items.push(item);
    }

    // Parse attachment (rows 26-32)
    for (let row = 26; row <= 32; row++) {
      const item = this.parseCatalogRow(sheet, row, 'attachment', market, templateVersion);
      if (item) items.push(item);
    }

    // Parse mounting (rows 36-40)
    for (let row = 36; row <= 40; row++) {
      const item = this.parseCatalogRow(sheet, row, 'mounting', market, templateVersion);
      if (item) items.push(item);
    }

    return items;
  }

  private parseCatalogRow(
    sheet: XLSX.WorkSheet,
    row: number,
    category: WodCostCategory,
    market: WodMarket,
    templateVersion: string
  ): WodCostCatalogItem | null {
    const componentName = this.getCellString(sheet, `A${row}`);
    if (!componentName) return null;

    return {
      componentName,
      category,
      supplier: this.getCellString(sheet, `B${row}`),
      supplierArticleNumber: this.getCellString(sheet, `C${row}`),
      unitCost: this.getCellNumber(sheet, `D${row}`),
      unit: this.getCellString(sheet, `E${row}`),
      laborHourlyRate: this.getCellNumber(sheet, `H${row}`),
      laborTimeMinutes: this.getCellNumber(sheet, `I${row}`),
      laborCost: this.getCellNumber(sheet, `J${row}`),
      market,
      templateVersion,
    };
  }

  private parseStaticConfig(market: WodMarket, templateVersion: string): WodStaticConfig[] {
    const configs: WodStaticConfig[] = [];

    // Parse static values sheet
    const staticSheet = this.getSheet(SHEETS.STATIC_VALUES);
    if (staticSheet) {
      // Geographic zones (column E, rows 4-6)
      for (let row = 4; row <= 6; row++) {
        const zone = this.getCellString(staticSheet, `E${row}`);
        if (zone) {
          configs.push({
            configType: 'geographic_zone',
            configKey: zone,
            configValue: { name: zone, index: row - 3 },
            market,
            templateVersion,
          });
        }
      }

      // Power levels (column D, rows 36-39)
      for (let row = 36; row <= 39; row++) {
        const level = this.getCellString(staticSheet, `D${row}`);
        const value = this.getCellNumber(staticSheet, `C${row}`);
        if (level) {
          configs.push({
            configType: 'power_level',
            configKey: level,
            configValue: { name: level, valueKw: value },
            market,
            templateVersion,
          });
        }
      }

      // Charger types (column E, rows 28-30)
      for (let row = 28; row <= 30; row++) {
        const chargerType = this.getCellString(staticSheet, `E${row}`);
        if (chargerType) {
          configs.push({
            configType: 'charger_type',
            configKey: chargerType,
            configValue: { name: chargerType },
            market,
            templateVersion,
          });
        }
      }

      // Parking types (column G, rows 4-8)
      for (let row = 4; row <= 8; row++) {
        const parkingType = this.getCellString(staticSheet, `G${row}`);
        if (parkingType) {
          configs.push({
            configType: 'parking_type',
            configKey: parkingType,
            configValue: { name: parkingType },
            market,
            templateVersion,
          });
        }
      }
    }

    return configs;
  }

  // ==========================================================================
  // PRIVATE METHODS - Helpers
  // ==========================================================================

  private getSheet(name: string): XLSX.WorkSheet | null {
    if (!this.workbook) return null;
    return this.workbook.Sheets[name] || null;
  }

  private getCellString(sheet: XLSX.WorkSheet, cellRef: string): string | undefined {
    const cell = sheet[cellRef];
    if (!cell) return undefined;
    if (cell.v === null || cell.v === undefined) return undefined;
    return String(cell.v).trim();
  }

  private getCellNumber(sheet: XLSX.WorkSheet, cellRef: string): number | undefined {
    const cell = sheet[cellRef];
    if (!cell) return undefined;
    if (cell.v === null || cell.v === undefined) return undefined;
    const num = Number(cell.v);
    return isNaN(num) ? undefined : num;
  }

  private getCellDate(sheet: XLSX.WorkSheet, cellRef: string): Date | undefined {
    const cell = sheet[cellRef];
    if (!cell) return undefined;
    if (cell.v instanceof Date) return cell.v;
    if (typeof cell.v === 'number') {
      // Excel date serial number
      return new Date((cell.v - 25569) * 86400 * 1000);
    }
    return undefined;
  }

  private calculateTotalFromCircuits(sheet: XLSX.WorkSheet, row: number): number {
    let total = 0;
    // Column G (index 6) onwards for circuits
    for (let col = 7; col <= 27; col++) {
      const cellRef = XLSX.utils.encode_cell({ r: row - 1, c: col });
      const value = this.getCellNumber(sheet, cellRef);
      if (value) total += value;
    }
    return total;
  }

  private detectChargerType(_wodSheet: XLSX.WorkSheet): WodChargerType | undefined {
    // Check Cost output sheet for which charger has quantity > 0
    const costSheet = this.getSheet(SHEETS.COST_OUTPUT);
    if (!costSheet) return undefined;

    const easee = this.getCellNumber(costSheet, 'B4');
    const zaptec = this.getCellNumber(costSheet, 'B5');
    const ctek = this.getCellNumber(costSheet, 'B6');

    if (zaptec && zaptec > 0) return 'Zaptec Pro';
    if (easee && easee > 0) return 'Easee Charge';
    if (ctek && ctek > 0) return 'Ctek';

    return undefined;
  }

  private hasDigging(sheet: XLSX.WorkSheet): boolean {
    const asphalt = this.getCellNumber(sheet, 'C21') || 0;
    const greenSpace = this.getCellNumber(sheet, 'C22') || 0;
    return asphalt > 0 || greenSpace > 0;
  }

  private determineZone(geographicArea?: string): string | undefined {
    if (!geographicArea) return undefined;
    const area = geographicArea.toLowerCase();
    if (area.includes('stockholm') || area.includes('göteborg') || area.includes('malmö')) {
      return 'Zone A';
    }
    if (area.includes('uppsala') || area.includes('eskilstuna')) {
      return 'Zone B';
    }
    return 'Zone C';
  }

  private parseDealDate(sheet: XLSX.WorkSheet): Date | undefined {
    // Try latest change date first (C16)
    const latestChange = this.getCellDate(sheet, 'C16');
    if (latestChange) return latestChange;

    // Try created date (C15)
    const created = this.getCellDate(sheet, 'C15');
    if (created) return created;

    return undefined;
  }

  private extractSheetAsJson(
    sheet: XLSX.WorkSheet,
    startRow: number,
    endRow: number,
    startCol: number,
    _endCol?: number  // Reserved for future multi-column extraction
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    for (let row = startRow; row <= endRow; row++) {
      const label = this.getCellString(sheet, `${XLSX.utils.encode_col(startCol - 1)}${row}`);
      if (!label) continue;

      const key = label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const value = this.getCellNumber(sheet, `${XLSX.utils.encode_col(startCol)}${row}`) ??
        this.getCellString(sheet, `${XLSX.utils.encode_col(startCol)}${row}`);

      if (value !== undefined) {
        data[key] = value;
      }
    }

    return data;
  }

  private validateDeal(deal: WodDeal): void {
    if (!deal.dealName || deal.dealName === 'Unknown Project') {
      this.errors.push('Missing project/BRF name');
    }
    if (!deal.geographicArea || deal.geographicArea === 'Unknown') {
      this.warnings.push('Missing geographic area');
    }
    if (deal.totalParkingSpaces === 0) {
      this.warnings.push('Total parking spaces is 0');
    }
    if (deal.totalBoxes === 0) {
      this.warnings.push('No charger boxes configured');
    }
    if (deal.circuits.length === 0) {
      this.warnings.push('No circuits configured');
    }
  }
}

// Export singleton for convenience
export const wodParser = new WodParser();
