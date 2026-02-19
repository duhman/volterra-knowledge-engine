import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config: Config | null = null;

export function loadConfig(): Config {
  if (config) return config;

  const configPath = join(__dirname, '../..', 'config', 'default.json');
  
  try {
    const configFile = readFileSync(configPath, 'utf-8');
    config = JSON.parse(configFile) as Config;
    
    // Apply environment variable overrides
    if (process.env.BATCH_SIZE) {
      config.processing.batchSize = parseInt(process.env.BATCH_SIZE, 10);
    }
    if (process.env.BATCH_CONCURRENCY) {
      config.processing.concurrency = parseInt(process.env.BATCH_CONCURRENCY, 10);
    }
    if (process.env.EMBEDDING_MODEL) {
      config.embedding.model = process.env.EMBEDDING_MODEL;
    }
    if (process.env.LOG_LEVEL) {
      config.logging.level = process.env.LOG_LEVEL;
    }
    if (process.env.PII_DETECTION_ENABLED) {
      config.compliance.piiDetection.enabled = process.env.PII_DETECTION_ENABLED === 'true';
    }
    if (process.env.PII_REDACTION_MODE) {
      config.compliance.piiDetection.mode = process.env.PII_REDACTION_MODE as 'flag' | 'redact';
    }
    
    return config;
  } catch (error) {
    throw new Error(`Failed to load config from ${configPath}: ${error}`);
  }
}

export function getConfig(): Config {
  return loadConfig();
}

