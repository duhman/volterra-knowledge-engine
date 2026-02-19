/**
 * Storage Service for Supabase Storage operations
 * Used to upload and manage project images in the wod-project-images bucket
 */

import { getSupabaseClient } from "../database/supabase-client.js";
import { logger } from "../utils/logger.js";
import * as crypto from "crypto";

// Optional sharp import for image dimensions (loaded lazily)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharp: any = null;
let sharpLoadAttempted = false;

async function loadSharp(): Promise<void> {
  if (sharpLoadAttempted) return;
  sharpLoadAttempted = true;
  try {
    // @ts-ignore - sharp is an optional dependency
    const sharpModule = await import("sharp");
    sharp = sharpModule.default;
  } catch {
    logger.warn("Sharp not available - image dimensions will not be extracted");
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

const WOD_IMAGES_BUCKET = "wod-project-images";

// ============================================================================
// TYPES
// ============================================================================

export interface StorageUploadResult {
  /** Full public URL to the uploaded image */
  publicUrl: string;
  /** Storage path within the bucket */
  storagePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Content hash for deduplication */
  contentHash: string;
}

export interface StorageUploadOptions {
  /** Market code (SE, NO, DK, DE) */
  market: string;
  /** Deal name (normalized for URL) */
  dealName: string;
  /** Project stage folder */
  projectStage: string;
  /** Original filename */
  originalFilename: string;
  /** Content type */
  contentType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Whether to upsert if file exists */
  upsert?: boolean;
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Upload an image to Supabase Storage
 * Returns the public URL for vision API access
 */
export async function uploadImage(
  buffer: Buffer,
  options: StorageUploadOptions,
): Promise<StorageUploadResult> {
  const client = getSupabaseClient();

  // Generate content hash for deduplication
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");

  // Create storage path: market/deal-name/stage/filename
  const normalizedDeal = normalizePath(options.dealName);
  const normalizedFilename = normalizePath(options.originalFilename);
  const storagePath = `${options.market}/${normalizedDeal}/${options.projectStage}/${normalizedFilename}`;

  logger.info("Uploading image to storage", {
    bucket: WOD_IMAGES_BUCKET,
    path: storagePath,
    size: buffer.length,
    contentType: options.contentType,
  });

  const { error } = await client.storage
    .from(WOD_IMAGES_BUCKET)
    .upload(storagePath, buffer, {
      contentType: options.contentType,
      upsert: options.upsert ?? true,
      cacheControl: "3600",
    });

  if (error) {
    logger.error("Storage upload failed", {
      error: error.message,
      path: storagePath,
    });
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  // Get public URL
  const {
    data: { publicUrl },
  } = client.storage.from(WOD_IMAGES_BUCKET).getPublicUrl(storagePath);

  logger.info("Image uploaded successfully", {
    path: storagePath,
    publicUrl,
    size: buffer.length,
  });

  return {
    publicUrl,
    storagePath,
    fileSize: buffer.length,
    contentHash,
  };
}

/**
 * Check if an image already exists in storage by content hash
 * Useful for deduplication
 */
export async function imageExistsByHash(contentHash: string): Promise<boolean> {
  const client = getSupabaseClient();

  // Query the documents table for existing image with this hash
  // Note: Type assertion needed until database types are regenerated after migration
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (client as any)
    .from("wod_project_documents")
    .select("id")
    .eq("file_hash", contentHash)
    .eq("is_image", true)
    .limit(1);

  if (error) {
    logger.warn("Error checking for existing image", { error: error.message });
    return false;
  }

  return data !== null && data.length > 0;
}

/**
 * Delete an image from storage
 */
export async function deleteImage(storagePath: string): Promise<void> {
  const client = getSupabaseClient();

  const { error } = await client.storage
    .from(WOD_IMAGES_BUCKET)
    .remove([storagePath]);

  if (error) {
    logger.error("Storage delete failed", {
      error: error.message,
      path: storagePath,
    });
    throw new Error(`Storage delete failed: ${error.message}`);
  }

  logger.info("Image deleted from storage", { path: storagePath });
}

/**
 * Get a signed URL for an image (for temporary access)
 */
export async function getSignedUrl(
  storagePath: string,
  expiresInSeconds: number = 3600,
): Promise<string> {
  const client = getSupabaseClient();

  const { data, error } = await client.storage
    .from(WOD_IMAGES_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    logger.error("Failed to create signed URL", {
      error: error?.message,
      path: storagePath,
    });
    throw new Error(`Failed to create signed URL: ${error?.message}`);
  }

  return data.signedUrl;
}

/**
 * List images in a specific deal folder
 */
export async function listDealImages(
  market: string,
  dealName: string,
): Promise<string[]> {
  const client = getSupabaseClient();
  const prefix = `${market}/${normalizePath(dealName)}/`;

  const { data, error } = await client.storage
    .from(WOD_IMAGES_BUCKET)
    .list(prefix, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" },
    });

  if (error) {
    logger.error("Failed to list deal images", {
      error: error.message,
      prefix,
    });
    throw new Error(`Failed to list images: ${error.message}`);
  }

  return (data || []).map((file) => `${prefix}${file.name}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize a string for use in storage paths
 * - Remove Swedish characters
 * - Replace spaces with hyphens
 * - Remove special characters
 */
function normalizePath(input: string): string {
  return input
    .replace(/[åäÅÄ]/g, "a")
    .replace(/[öÖ]/g, "o")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9\-_.]/g, "")
    .toLowerCase();
}

/**
 * Get MIME type from file extension
 */
export function getMimeTypeFromExtension(
  filename: string,
): StorageUploadOptions["contentType"] | null {
  const ext = filename.toLowerCase().split(".").pop();
  const mimeMap: Record<string, StorageUploadOptions["contentType"]> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mimeMap[ext || ""] || null;
}

/**
 * Get image dimensions using sharp (optional dependency)
 */
export async function getImageDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  await loadSharp();

  if (!sharp) {
    return null; // Sharp not available
  }

  try {
    const metadata = await sharp(buffer).metadata();
    if (metadata.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
    return null;
  } catch (error) {
    logger.warn("Failed to get image dimensions", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
