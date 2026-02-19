import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { logger } from './logger.js';
import { handleError, isRetryableError } from './error-handler.js';
import type { BatchResult, BatchError } from '../types/index.js';

export interface BatchProcessorOptions {
  batchSize: number;
  concurrency: number;
  retryAttempts: number;
  retryDelayMs: number;
  onProgress?: (processed: number, total: number) => void;
}

const defaultOptions: BatchProcessorOptions = {
  batchSize: 10,
  concurrency: 3,
  retryAttempts: 3,
  retryDelayMs: 1000,
};

export async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  options: Partial<BatchProcessorOptions> = {}
): Promise<{ results: R[]; errors: BatchError[] }> {
  const opts = { ...defaultOptions, ...options };
  const limit = pLimit(opts.concurrency);
  const results: R[] = [];
  const errors: BatchError[] = [];
  let processed = 0;

  const batches = chunkArray(items, opts.batchSize);
  
  logger.info('Starting batch processing', {
    totalItems: items.length,
    batchSize: opts.batchSize,
    batches: batches.length,
    concurrency: opts.concurrency,
  });

  for (const batch of batches) {
    const batchPromises = batch.map((item, index) =>
      limit(async () => {
        const itemId = getItemIdentifier(item, index);
        try {
          const result = await pRetry(
            () => processor(item),
            {
              retries: opts.retryAttempts,
              minTimeout: opts.retryDelayMs,
              onFailedAttempt: (error) => {
                if (!isRetryableError(error)) {
                  throw error;
                }
                logger.warn('Retrying failed item', {
                  itemId,
                  attempt: error.attemptNumber,
                  retriesLeft: error.retriesLeft,
                });
              },
            }
          );
          results.push(result);
        } catch (error) {
          errors.push(handleError(error, itemId));
        } finally {
          processed++;
          opts.onProgress?.(processed, items.length);
        }
      })
    );

    await Promise.all(batchPromises);
  }

  logger.info('Batch processing complete', {
    total: items.length,
    successful: results.length,
    failed: errors.length,
  });

  return { results, errors };
}

export function createBatchResult(
  total: number,
  results: unknown[],
  errors: BatchError[]
): BatchResult {
  return {
    total,
    successful: results.length,
    failed: errors.length,
    errors,
  };
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function getItemIdentifier(item: unknown, index: number): string {
  if (typeof item === 'object' && item !== null) {
    const obj = item as Record<string, unknown>;
    if (typeof obj.id === 'string') return obj.id;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.path === 'string') return obj.path;
  }
  return `item-${index}`;
}

