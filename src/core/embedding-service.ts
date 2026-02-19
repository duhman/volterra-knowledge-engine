import OpenAI from "openai";
import pLimit from "p-limit";
import { logger } from "../utils/logger.js";
import { EmbeddingError } from "../utils/error-handler.js";
import { getConfig } from "../utils/config.js";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new EmbeddingError(
      "Missing OpenAI API key. Set OPENAI_API_KEY environment variable.",
    );
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

export interface EmbeddingResult {
  embedding: number[];
  tokenUsage: number;
}

export interface BatchEmbeddingResult {
  embeddings: number[][];
  totalTokenUsage: number;
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(
  text: string,
): Promise<EmbeddingResult> {
  const config = getConfig();
  const client = getOpenAIClient();

  logger.debug("Preparing text for embedding", { textLength: text.length });

  // Clean and prepare text
  const cleanedText = prepareTextForEmbedding(text);

  logger.debug("Text prepared", { cleanedLength: cleanedText.length });

  if (!cleanedText) {
    throw new EmbeddingError("Cannot generate embedding for empty text");
  }

  try {
    // Add timeout with AbortController to properly cancel hanging requests
    const timeoutMs = 30000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      logger.warn("Embedding request timeout, aborting");
      abortController.abort();
    }, timeoutMs);

    logger.debug("Calling OpenAI embeddings API", {
      model: config.embedding.model,
      textLength: cleanedText.length,
    });

    const response = await client.embeddings.create(
      {
        model: config.embedding.model,
        input: cleanedText,
        encoding_format: "float",
      },
      { signal: abortController.signal },
    );

    clearTimeout(timeoutId);
    logger.debug("OpenAI API response received");

    const embedding = response.data[0].embedding;
    const tokenUsage = response.usage.total_tokens;

    logger.debug("Generated embedding", {
      model: config.embedding.model,
      dimensions: embedding.length,
      tokens: tokenUsage,
    });

    return { embedding, tokenUsage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to generate embedding", { error: message });
    throw new EmbeddingError(`Failed to generate embedding: ${message}`);
  }
}

/**
 * Generate embeddings for multiple texts in batches
 */
export async function generateEmbeddingsBatch(
  texts: string[],
): Promise<BatchEmbeddingResult> {
  const config = getConfig();
  const client = getOpenAIClient();

  // Clean and filter texts
  const cleanedTexts = texts
    .map(prepareTextForEmbedding)
    .filter(Boolean) as string[];

  if (cleanedTexts.length === 0) {
    return { embeddings: [], totalTokenUsage: 0 };
  }

  // Process in batches (OpenAI has a limit on input array size)
  const batchSize = config.embedding.batchSize;
  const batches = chunkArray(cleanedTexts, batchSize);
  const limit = pLimit(2); // Max 2 concurrent API calls

  const allEmbeddings: number[][] = [];
  let totalTokenUsage = 0;

  logger.info("Generating embeddings in batches", {
    totalTexts: cleanedTexts.length,
    batchSize,
    batches: batches.length,
  });

  const results = await Promise.all(
    batches.map((batch, index) =>
      limit(async () => {
        try {
          const response = await client.embeddings.create({
            model: config.embedding.model,
            input: batch,
            encoding_format: "float",
          });

          logger.debug("Batch embedding complete", {
            batchIndex: index,
            batchSize: batch.length,
            tokens: response.usage.total_tokens,
          });

          return {
            embeddings: response.data.map((d) => d.embedding),
            tokenUsage: response.usage.total_tokens,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error("Batch embedding failed", {
            batchIndex: index,
            error: message,
          });
          throw new EmbeddingError(`Batch ${index} failed: ${message}`);
        }
      }),
    ),
  );

  for (const result of results) {
    allEmbeddings.push(...result.embeddings);
    totalTokenUsage += result.tokenUsage;
  }

  logger.info("Batch embedding complete", {
    totalEmbeddings: allEmbeddings.length,
    totalTokens: totalTokenUsage,
  });

  return { embeddings: allEmbeddings, totalTokenUsage };
}

/**
 * Prepare text for embedding generation
 * - Truncate if too long
 * - Remove excessive whitespace
 * - Replace newlines with spaces (OpenAI recommendation)
 */
function prepareTextForEmbedding(text: string): string {
  if (!text) return "";

  const config = getConfig();

  // Clean text
  let cleaned = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();

  // Estimate tokens very conservatively for multilingual text with email content
  // Email headers, quoted text, and special chars tokenize inefficiently
  // Using ~1.5 chars per token to handle worst cases
  const charsPerToken = 1.5;
  const estimatedTokens = Math.ceil(cleaned.length / charsPerToken);

  // Truncate if exceeds max tokens (leave 1000 token buffer for safety)
  const maxTokens = config.embedding.maxTokensPerRequest - 1000;
  const maxChars = Math.floor(maxTokens * charsPerToken);

  if (cleaned.length > maxChars) {
    // Calculate truncation statistics
    const originalChars = cleaned.length;
    const percentageLost = Math.round(
      ((originalChars - maxChars) / originalChars) * 100,
    );

    // Capture content preview for debugging (first and last 50 chars of original)
    const contentPreview =
      originalChars > 120
        ? `${cleaned.substring(0, 50)}...TRUNCATED...${cleaned.substring(originalChars - 50)}`
        : cleaned;

    cleaned = cleaned.substring(0, maxChars);

    logger.warn("Text truncated for embedding - content lost", {
      originalChars,
      truncatedChars: maxChars,
      charsLost: originalChars - maxChars,
      percentageLost: `${percentageLost}%`,
      estimatedOriginalTokens: estimatedTokens,
      maxAllowedTokens: maxTokens,
      contentPreview,
    });
  }

  return cleaned;
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embedding dimensions must match");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
