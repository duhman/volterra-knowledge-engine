/**
 * Vision Service for analyzing images using OpenAI's GPT-4V/GPT-4o
 * Used to generate descriptions and structured analysis of project site photos
 */

import OpenAI from "openai";
import { logger } from "../utils/logger.js";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OpenAI API key. Set OPENAI_API_KEY environment variable.",
    );
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

// ============================================================================
// TYPES
// ============================================================================

export interface VisionAnalysis {
  /** Human-readable description of the image for embedding */
  description: string;
  /** Structured analysis for filtering and querying */
  structured: VisionStructuredAnalysis;
  /** Model used for analysis */
  model: string;
  /** Tokens used */
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface VisionStructuredAnalysis {
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

export interface VisionOptions {
  /** Model to use (default: gpt-4o) */
  model?: "gpt-4o" | "gpt-4-vision-preview" | "gpt-4o-mini";
  /** Max tokens for response */
  maxTokens?: number;
  /** Image detail level */
  detail?: "low" | "high" | "auto";
}

// ============================================================================
// PROMPTS
// ============================================================================

const SITE_PHOTO_ANALYSIS_PROMPT = `You are an expert at analyzing EV charging installation project photos.

Analyze this image from an EV charging installation project. Provide:

1. **Description**: A clear, searchable description (2-3 sentences) that captures:
   - What type of location is shown (parking lot, garage, carport, etc.)
   - What stage of installation is visible (before work, during installation, completed)
   - Key features visible (chargers, electrical panels, cables, parking spaces)

2. **Structured Analysis** (JSON):
   - location_type: one of [outdoor_parking, indoor_parking, carport, garage_above_ground, garage_underground, residential_building, commercial_building, unknown]
   - installation_stage: one of [before, during, after, unknown]
   - equipment_visible: {chargers: [{model?, count}], electrical_panels: bool, cables: bool, conduits: bool, signage: bool}
   - issues_detected: list of any visible concerns (poor cable management, accessibility issues, etc.)
   - parking_spaces_visible: approximate count if visible
   - image_quality: one of [good, acceptable, poor]
   - notes: any other relevant observations

Respond with JSON in this exact format:
{
  "description": "string",
  "location_type": "string",
  "installation_stage": "string",
  "equipment_visible": {...},
  "issues_detected": [...],
  "parking_spaces_visible": number or null,
  "image_quality": "string",
  "notes": "string or null"
}`;

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Analyze an image URL using GPT-4V vision capabilities
 */
export async function analyzeImage(
  imageUrl: string,
  options: VisionOptions = {},
): Promise<VisionAnalysis> {
  const client = getOpenAIClient();
  const model = options.model || "gpt-4o";
  const maxTokens = options.maxTokens || 1000;
  const detail = options.detail || "auto";

  logger.info("Analyzing image with vision model", {
    model,
    imageUrl: imageUrl.substring(0, 100) + "...",
  });

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: SITE_PHOTO_ANALYSIS_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
                detail,
              },
            },
          ],
        },
      ],
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content in vision response");
    }

    const parsed = JSON.parse(content);

    const result: VisionAnalysis = {
      description: parsed.description || "Image analysis unavailable",
      structured: {
        locationType: mapLocationType(parsed.location_type),
        installationStage: mapInstallationStage(parsed.installation_stage),
        equipmentVisible: parsed.equipment_visible || {},
        issuesDetected: parsed.issues_detected || [],
        parkingSpacesVisible: parsed.parking_spaces_visible,
        imageQuality: mapImageQuality(parsed.image_quality),
        notes: parsed.notes,
      },
      model,
      tokenUsage: {
        prompt: response.usage?.prompt_tokens || 0,
        completion: response.usage?.completion_tokens || 0,
        total: response.usage?.total_tokens || 0,
      },
    };

    logger.info("Image analysis complete", {
      model,
      locationType: result.structured.locationType,
      stage: result.structured.installationStage,
      tokensUsed: result.tokenUsage.total,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Vision analysis failed", { error: message, imageUrl });
    throw new Error(`Vision analysis failed: ${message}`);
  }
}

/**
 * Analyze an image from base64 data
 */
export async function analyzeImageBase64(
  base64Data: string,
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  options: VisionOptions = {},
): Promise<VisionAnalysis> {
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  return analyzeImage(dataUrl, options);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function mapLocationType(
  value: string | undefined,
): VisionStructuredAnalysis["locationType"] {
  const mapping: Record<string, VisionStructuredAnalysis["locationType"]> = {
    outdoor_parking: "outdoor_parking",
    indoor_parking: "indoor_parking",
    carport: "carport",
    garage_above_ground: "garage_above_ground",
    garage_underground: "garage_underground",
    residential_building: "residential_building",
    commercial_building: "commercial_building",
  };
  return mapping[value || ""] || "unknown";
}

function mapInstallationStage(
  value: string | undefined,
): VisionStructuredAnalysis["installationStage"] {
  const mapping: Record<string, VisionStructuredAnalysis["installationStage"]> =
    {
      before: "before",
      during: "during",
      after: "after",
    };
  return mapping[value || ""] || "unknown";
}

function mapImageQuality(
  value: string | undefined,
): VisionStructuredAnalysis["imageQuality"] {
  const mapping: Record<string, VisionStructuredAnalysis["imageQuality"]> = {
    good: "good",
    acceptable: "acceptable",
    poor: "poor",
  };
  return mapping[value || ""] || "acceptable";
}

/**
 * Estimate cost of vision API call
 * Based on OpenAI pricing as of Jan 2026
 */
export function estimateVisionCost(
  tokenUsage: VisionAnalysis["tokenUsage"],
  model: string = "gpt-4o",
): number {
  // Approximate costs per 1M tokens (Jan 2026)
  const costs: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 2.5, output: 10.0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4-vision-preview": { input: 10.0, output: 30.0 },
  };

  const modelCost = costs[model] || costs["gpt-4o"];
  const inputCost = (tokenUsage.prompt / 1_000_000) * modelCost.input;
  const outputCost = (tokenUsage.completion / 1_000_000) * modelCost.output;

  return inputCost + outputCost;
}
