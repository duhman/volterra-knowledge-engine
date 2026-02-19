/**
 * Type definitions for Wheel of Deal (WoD) Excel data structures
 * Used for parsing, storing, and retrieving deal data
 */

// ============================================================================
// STATIC/REFERENCE DATA TYPES
// ============================================================================

/**
 * Cost catalog item from the 'Cost list' sheet
 */
export interface WodCostCatalogItem {
  id?: string;
  componentName: string;
  category: WodCostCategory;
  subcategory?: string;
  supplier?: string;
  supplierArticleNumber?: string;
  unitCost?: number;
  unit?: string;
  laborHourlyRate?: number;
  laborTimeMinutes?: number;
  laborCost?: number;
  market: WodMarket;
  templateVersion: string;
}

export type WodCostCategory =
  | "charger"
  | "backplate"
  | "cable"
  | "attachment"
  | "mounting"
  | "connectivity"
  | "labor"
  | "box_accessories"
  | "fuse"
  | "other";

/**
 * Static configuration from 'Static values' and 'Common input' sheets
 */
export interface WodStaticConfig {
  id?: string;
  configType: WodConfigType;
  configKey: string;
  configValue: Record<string, unknown>;
  market: WodMarket;
  country?: string;
  facilityType?: "Private" | "Shared";
  chargerModel?: WodChargerType;
  templateVersion: string;
  description?: string;
}

export type WodConfigType =
  | "geographic_zone"
  | "power_level"
  | "charger_type"
  | "corporate_assumption"
  | "utilization_forecast"
  | "parking_type"
  | "cable_dimension"
  | "fuse_size";

// ============================================================================
// DEAL DATA TYPES
// ============================================================================

/**
 * Main deal data extracted from a filled WoD Excel file
 */
export interface WodDeal {
  id?: string;

  // Project identification
  dealName: string;
  dealReference?: string;

  // Location
  geographicArea: string;
  country: WodMarket;
  zone?: string;

  // Facility details
  totalParkingSpaces: number;
  housingUnits?: number;
  guestParking?: number;
  realPotential?: number;

  // Configuration
  powerLevel?: WodPowerLevel;
  chargerType?: WodChargerType;

  // Installation requirements
  diggingRequired: boolean;
  asphaltDiggingMeters?: number;
  greenSpaceDiggingMeters?: number;
  signalCoverageAvailable: boolean;

  // Totals
  totalBoxes: number;
  totalInfrastructurePs: number;

  // Economics summary
  totalCostExclVat?: number;
  totalMaterialCost?: number;
  totalWorkCost?: number;
  grossMarginBuy?: number;
  grossMarginRent?: number;
  markupPercentage?: number;

  // Offer prices
  startFeeInclVat?: number;
  startFeeGronTeknik?: number;
  adminFeeInclVat?: number;
  rentMonthlyBuy?: number;
  rentMonthlyRent?: number;

  // Purchase offer totals
  purchaseTotalExclSubsidy?: number;
  purchaseTotalWithSubsidy?: number;

  // Raw data storage
  rawInputs?: WodRawInputs;
  rawEconomy?: Record<string, unknown>;
  rawCostOutput?: Record<string, unknown>;

  // Creator/audit
  creatorName?: string;
  fourEyesName?: string;
  dealDate?: Date;

  // Source tracking
  sourcePath?: string;
  originalFilename?: string;
  templateVersion?: string;
  fileHash?: string;

  // Circuits, costs, and offers
  circuits: WodCircuit[];
  costs: WodCostItem[];
  offers: WodOffer[];

  // Metadata
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Raw input fields from WoD sheet - stored as JSON for flexibility
 */
export interface WodRawInputs {
  // General
  projectName?: string;
  geographicArea?: string;
  totalParking?: number;
  apartments?: number;
  guestParking?: number;
  realPotential?: number;

  // Creator info
  creatorName?: string;
  fourEyesName?: string;
  createdDate?: string;
  latestChange?: string;

  // Digging
  asphaltDigging?: number;
  greenSpaceDigging?: number;
  passingCurbstone?: number;

  // Misc
  holesInConcrete?: number;
  dismantlingHeaters?: number;
  signalCoverageAtCabinets?: boolean;

  // Design
  powerLevel?: string;
  forceMinimumFuse?: string;
  forceMinimumCable?: string;

  // Economy inputs
  startFeeRent?: number;
  additionalCostWorkElectrician?: number;
  additionalCostMaterialsElectrician?: number;
  additionalCostWorkDig?: number;
  additionalCostMaterialsDig?: number;

  // Customer specific
  customerSpecific?: string;

  // Any additional fields
  [key: string]: unknown;
}

/**
 * Circuit configuration (one per circuit column in WoD sheet)
 */
export interface WodCircuit {
  id?: string;
  dealId?: string;
  circuitNumber: number;
  boxesCount: number;
  infrastructurePs: number;
  parkingType?: WodParkingType;
  availablePowerAmps?: number;
  availableFuseSpace?: boolean;
  requiredMinPowerKw?: number;
  requiredMinFuseAmps?: number;
  cableFromCabinet?: number;
  cableDistanceFirstBox?: number;
  additionalCableMeters?: number;
  existingCable?: boolean;
  existingCableDimension?: string;
  signalCoverage?: boolean;
}

/**
 * Cost line item for a deal
 */
export interface WodCostItem {
  id?: string;
  dealId?: string;
  costCategory: WodCostCategory;
  itemName: string;
  quantity: number;
  unit?: string;
  unitCost?: number;
  totalCost: number;
  laborHours?: number;
  laborCost?: number;
  catalogItemId?: string;
}

/**
 * Offer data (buy/rent/box options)
 */
export interface WodOffer {
  id?: string;
  dealId?: string;
  offerType: WodOfferType;
  includedMaterials?: WodOfferLineItem[];
  includedWork?: WodOfferLineItem[];
  oneTimeCost?: number;
  oneTimeCostWithSubsidy?: number;
  monthlyFee?: number;
  startFee?: number;
  subsidyEligible?: boolean;
  subsidyPercentage?: number;
  subsidyAmount?: number;
  bindingPeriodMonths?: number;
  noticePeriodMonths?: number;
  offerText?: string;
}

export interface WodOfferLineItem {
  quantity: number;
  unit: string;
  description: string;
}

// ============================================================================
// ENUMS AND CONSTANTS
// ============================================================================

export type WodMarket = "SE" | "NO" | "DK" | "DE";

export type WodChargerType = "Easee Charge" | "Zaptec Pro" | "Ctek";

export type WodPowerLevel =
  | "Not allowed! (1.5 A)"
  | "Minimum (2 A)"
  | "Average (3 A)"
  | "Premium (6 A)";

export type WodParkingType =
  | "Outdoor"
  | "Indoor"
  | "Outdoors - Carport"
  | "Garage - Above ground"
  | "Garage - Below ground";

export type WodOfferType = "buy" | "rent" | "box";

export type WodFacilityType = "Private" | "Shared";

// ============================================================================
// PARSER TYPES
// ============================================================================

/**
 * Result from parsing a WoD Excel file
 */
export interface WodParseResult {
  deal: WodDeal;
  costCatalog?: WodCostCatalogItem[];
  staticConfig?: WodStaticConfig[];
  isTemplate: boolean;
  templateVersion: string;
  market: WodMarket;
  warnings: string[];
  errors: string[];
}

/**
 * Options for WoD file parsing
 */
export interface WodParseOptions {
  /** Extract static/reference data (cost catalog, config) - typically only for templates */
  extractStaticData?: boolean;
  /** Market override if not detected from filename */
  market?: WodMarket;
  /** Template version override */
  templateVersion?: string;
  /** Skip validation of required fields */
  skipValidation?: boolean;
}

/**
 * Options for WoD ingestion
 */
export interface WodIngestionOptions {
  /** Source directory containing WoD files */
  sourceDirectory?: string;
  /** Single file to ingest */
  filePath?: string;
  /** Market filter */
  market?: WodMarket;
  /** Skip files that already exist (by source_path) */
  skipExisting?: boolean;
  /** Dry run - parse but don't insert */
  dryRun?: boolean;
  /** Show stats only */
  statsOnly?: boolean;
  /** Limit number of files to process */
  limit?: number;
  /** Generate and store embeddings */
  generateEmbeddings?: boolean;
  /** Also insert summary into documents table for unified RAG */
  insertIntoDocuments?: boolean;
}

/**
 * Result from WoD ingestion
 */
export interface WodIngestionResult {
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  dealsInserted: number;
  catalogItemsInserted: number;
  configItemsInserted: number;
  errors: WodIngestionError[];
}

export interface WodIngestionError {
  filename: string;
  error: string;
  timestamp: Date;
}

// ============================================================================
// DATABASE RECORD TYPES (matching Supabase schema)
// ============================================================================

export interface WodDealRecord {
  id: string;
  deal_name: string;
  deal_reference?: string;
  geographic_area: string;
  country: string;
  zone?: string;
  total_parking_spaces: number;
  housing_units?: number;
  guest_parking?: number;
  real_potential?: number;
  power_level?: string;
  charger_type?: string;
  digging_required: boolean;
  asphalt_digging_meters?: number;
  green_space_digging_meters?: number;
  signal_coverage_available: boolean;
  total_boxes: number;
  total_infrastructure_ps: number;
  total_cost_excl_vat?: number;
  total_material_cost?: number;
  total_work_cost?: number;
  gross_margin_buy?: number;
  gross_margin_rent?: number;
  markup_percentage?: number;
  start_fee_incl_vat?: number;
  start_fee_gron_teknik?: number;
  admin_fee_incl_vat?: number;
  rent_monthly_buy?: number;
  rent_monthly_rent?: number;
  purchase_total_excl_subsidy?: number;
  purchase_total_with_subsidy?: number;
  raw_inputs?: Record<string, unknown>;
  raw_economy?: Record<string, unknown>;
  raw_cost_output?: Record<string, unknown>;
  creator_name?: string;
  four_eyes_name?: string;
  deal_date?: string;
  source_path?: string;
  original_filename?: string;
  template_version?: string;
  file_hash?: string;
  embedding?: number[];
  embedding_content?: string;
  sensitivity: string;
  created_at: string;
  updated_at: string;
}

export interface WodCircuitRecord {
  id: string;
  deal_id: string;
  circuit_number: number;
  boxes_count: number;
  infrastructure_ps: number;
  parking_type?: string;
  available_power_amps?: number;
  available_fuse_space?: boolean;
  required_min_power_kw?: number;
  required_min_fuse_amps?: number;
  cable_from_cabinet?: number;
  cable_distance_first_box?: number;
  additional_cable_meters?: number;
  existing_cable?: boolean;
  existing_cable_dimension?: string;
  signal_coverage?: boolean;
  created_at: string;
}

export interface WodCostRecord {
  id: string;
  deal_id: string;
  cost_category: string;
  item_name: string;
  quantity: number;
  unit?: string;
  unit_cost?: number;
  total_cost: number;
  labor_hours?: number;
  labor_cost?: number;
  catalog_item_id?: string;
  created_at: string;
}

export interface WodOfferRecord {
  id: string;
  deal_id: string;
  offer_type: string;
  included_materials?: Record<string, unknown>[];
  included_work?: Record<string, unknown>[];
  one_time_cost?: number;
  one_time_cost_with_subsidy?: number;
  monthly_fee?: number;
  start_fee?: number;
  subsidy_eligible?: boolean;
  subsidy_percentage?: number;
  subsidy_amount?: number;
  binding_period_months?: number;
  notice_period_months?: number;
  offer_text?: string;
  created_at: string;
}

export interface WodCostCatalogRecord {
  id: string;
  component_name: string;
  category: string;
  subcategory?: string;
  supplier?: string;
  supplier_article_number?: string;
  unit_cost?: number;
  unit?: string;
  labor_hourly_rate?: number;
  labor_time_minutes?: number;
  labor_cost?: number;
  market: string;
  template_version: string;
  created_at: string;
  updated_at: string;
}

export interface WodStaticConfigRecord {
  id: string;
  config_type: string;
  config_key: string;
  config_value: Record<string, unknown>;
  market: string;
  country?: string;
  facility_type?: string;
  charger_model?: string;
  template_version: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// PROJECT DOCUMENTS TYPES
// ============================================================================

/**
 * Project lifecycle stage corresponding to folder structure
 */
export type WodProjectStage =
  | "sales_material" // 01 Säljmaterial
  | "site_photos" // 02 Bilder
  | "site_plans" // 03 Översiktsplan
  | "communication" // 04 Kommunikation
  | "contractor_quotes" // 05 Offert från UE
  | "implementation" // 06 Entreprenad
  | "handover"; // 07 Överlämning

/**
 * Document type classification
 */
export type WodDocumentType =
  // Sales materials
  | "presentation"
  | "offer_document"
  | "wod_calculator"
  // Site documentation
  | "site_photo"
  | "site_map"
  | "circuit_diagram"
  // Communication
  | "meeting_notes"
  | "email"
  // Contractor documents
  | "contractor_quote"
  | "contractor_agreement"
  // Implementation
  | "project_binder"
  | "quality_plan"
  | "dou_document"
  | "self_inspection"
  | "control_plan"
  | "environment_plan"
  // Handover
  | "handover_protocol"
  | "ampeco_import"
  // Generic
  | "product_sheet"
  | "manual"
  | "certificate"
  | "order_form"
  | "other";

/**
 * Processing status for document ingestion
 */
export type WodDocumentProcessingStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

/**
 * Project document metadata and extracted content
 */
export interface WodProjectDocument {
  id?: string;
  dealId?: string;

  // Document identification
  title: string;
  description?: string;
  projectStage: WodProjectStage;
  documentType: WodDocumentType;

  // File metadata
  originalFilename: string;
  mimeType: string;
  fileSize?: number;
  fileHash?: string;
  sourcePath: string;

  // Extracted content
  rawText?: string;
  extractedMetadata?: WodExtractedMetadata;

  // Processing state
  processingStatus: WodDocumentProcessingStatus;
  chunksCount: number;

  // Document metadata
  language: string;
  documentDate?: Date;

  // Image-specific fields (when isImage=true)
  isImage?: boolean;
  storageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  visionAnalysis?: WodVisionAnalysis;
  visionModel?: string;
  visionProcessedAt?: Date;

  // Timestamps
  createdAt?: Date;
  updatedAt?: Date;

  // Related chunks (for in-memory processing)
  chunks?: WodProjectDocumentChunk[];
}

/**
 * Vision analysis results from GPT-4V for project images
 */
export interface WodVisionAnalysis {
  /** Human-readable description for embedding/search */
  description: string;
  /** Type of location shown */
  locationType?:
    | "outdoor_parking"
    | "indoor_parking"
    | "carport"
    | "garage_above_ground"
    | "garage_underground"
    | "residential_building"
    | "commercial_building"
    | "unknown";
  /** Installation stage visible */
  installationStage?: "before" | "during" | "after" | "unknown";
  /** Equipment visible in the image */
  equipmentVisible?: {
    chargers?: { model?: string; count: number }[];
    electricalPanels?: boolean;
    cables?: boolean;
    conduits?: boolean;
    signage?: boolean;
  };
  /** Any issues or concerns visible */
  issuesDetected?: string[];
  /** Parking spaces visible */
  parkingSpacesVisible?: number;
  /** Quality assessment of the image */
  imageQuality?: "good" | "acceptable" | "poor";
  /** Additional notes */
  notes?: string;
}

/**
 * Structured metadata extracted from document content
 */
export interface WodExtractedMetadata {
  serialNumbers?: string[];
  contactInfo?: WodContactInfo[];
  chargerModels?: string[];
  dates?: string[];
  amounts?: { value: number; currency: string; description?: string }[];
  addresses?: string[];
  [key: string]: unknown;
}

/**
 * Contact information extracted from documents
 */
export interface WodContactInfo {
  name?: string;
  phone?: string;
  email?: string;
  role?: string;
  company?: string;
}

/**
 * Document chunk with embedding for semantic search
 */
export interface WodProjectDocumentChunk {
  id?: string;
  documentId: string;

  content: string;
  chunkIndex: number;
  sectionHeader?: string;
  tokenCount?: number;

  embedding?: number[];
  createdAt?: Date;
}

// ============================================================================
// PROJECT DOCUMENTS DATABASE RECORD TYPES
// ============================================================================

export interface WodProjectDocumentRecord {
  id: string;
  deal_id?: string;
  title: string;
  description?: string;
  project_stage: string;
  document_type: string;
  original_filename: string;
  mime_type: string;
  file_size?: number;
  file_hash?: string;
  source_path: string;
  raw_text?: string;
  extracted_metadata?: Record<string, unknown>;
  processing_status: string;
  chunks_count: number;
  language: string;
  document_date?: string;
  // Image-specific fields
  is_image?: boolean;
  storage_url?: string;
  image_width?: number;
  image_height?: number;
  vision_analysis?: Record<string, unknown>;
  vision_model?: string;
  vision_processed_at?: string;
  // Timestamps
  created_at: string;
  updated_at: string;
}

export interface WodProjectDocumentChunkRecord {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  section_header?: string;
  token_count?: number;
  embedding?: number[];
  created_at: string;
}

// ============================================================================
// PROJECT DOCUMENTS INGESTION TYPES
// ============================================================================

/**
 * Options for project document ingestion
 */
export interface WodDocumentIngestionOptions {
  /** Source directory containing project folders */
  sourceDirectory: string;
  /** Deal name to associate documents with */
  dealName?: string;
  /** Market (country code) */
  market: WodMarket;
  /** Skip files that already exist by source_path */
  skipExisting?: boolean;
  /** Dry run - parse but don't insert */
  dryRun?: boolean;
  /** Limit number of files to process */
  limit?: number;
  /** Generate and store embeddings */
  generateEmbeddings?: boolean;
  /** Skip image files (always true for now) */
  skipImages?: boolean;
}

/**
 * Result from project document ingestion
 */
export interface WodDocumentIngestionResult {
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  documentsInserted: number;
  chunksInserted: number;
  errors: WodIngestionError[];
}

/**
 * Folder to stage mapping for project structure
 */
export const WOD_FOLDER_STAGE_MAP: Record<string, WodProjectStage> = {
  "01 Säljmaterial": "sales_material",
  "02 Bilder": "site_photos",
  "03 Översiktsplan": "site_plans",
  "04 Kommunikation": "communication",
  "05 Offert från UE": "contractor_quotes",
  "06 Entreprenad": "implementation",
  "07 Överlämning": "handover",
};

/**
 * MIME type mappings for supported document formats
 */
export const WOD_SUPPORTED_MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

/**
 * Image MIME type mappings for vision processing
 */
export const WOD_IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
};
