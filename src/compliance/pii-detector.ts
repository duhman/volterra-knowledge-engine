import { SyncRedactor } from 'redact-pii';
import { logger } from '../utils/logger.js';
import { ComplianceError } from '../utils/error-handler.js';
import { getConfig } from '../utils/config.js';
import type { PIIEntity } from '../types/index.js';

let redactor: SyncRedactor | null = null;

function getRedactor(): SyncRedactor {
  if (redactor) return redactor;
  
  redactor = new SyncRedactor({
    // Configure built-in redactors
    builtInRedactors: {
      emailAddress: { enabled: true },
      phoneNumber: { enabled: true },
      creditCardNumber: { enabled: true },
      usSocialSecurityNumber: { enabled: true },
      ipAddress: { enabled: true },
      names: { enabled: true },
      streetAddress: { enabled: true },
      zipcode: { enabled: true },
      url: { enabled: false }, // Don't redact URLs by default
      digits: { enabled: false }, // Too aggressive
    },
  });

  return redactor;
}

export interface PIIDetectionResult {
  hasPII: boolean;
  entities: PIIEntity[];
  redactedContent: string;
  originalContent: string;
  piiTypes: string[];
}

/**
 * Detect PII in text content
 */
export function detectPII(content: string): PIIDetectionResult {
  const config = getConfig();
  
  if (!config.compliance.piiDetection.enabled) {
    return {
      hasPII: false,
      entities: [],
      redactedContent: content,
      originalContent: content,
      piiTypes: [],
    };
  }

  try {
    const redactorInstance = getRedactor();
    
    // Redact and collect entities
    const entities: PIIEntity[] = [];
    const piiTypes = new Set<string>();
    
    // Run detection using patterns
    const patterns = getPIIPatterns();
    let redactedContent = content;
    
    for (const { type, pattern } of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        entities.push({
          type,
          value: match[0],
          start: match.index,
          end: match.index + match[0].length,
        });
        piiTypes.add(type);
      }
    }

    // Use redact-pii for comprehensive redaction
    if (config.compliance.piiDetection.mode === 'redact') {
      redactedContent = redactorInstance.redact(content);
    }

    // Check if redaction changed anything (indicates PII was found)
    const hasPIIFromRedactor = redactedContent !== content;
    const hasPII = entities.length > 0 || hasPIIFromRedactor;

    if (hasPII) {
      logger.info('PII detected', {
        entityCount: entities.length,
        types: Array.from(piiTypes),
        mode: config.compliance.piiDetection.mode,
      });
    }

    return {
      hasPII,
      entities,
      redactedContent,
      originalContent: content,
      piiTypes: Array.from(piiTypes),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('PII detection failed', { error: message });
    throw new ComplianceError(`PII detection failed: ${message}`);
  }
}

/**
 * Get regex patterns for common PII types
 */
function getPIIPatterns(): Array<{ type: string; pattern: RegExp }> {
  return [
    {
      type: 'email',
      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    },
    {
      type: 'phone',
      pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    },
    {
      type: 'ssn',
      pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
    },
    {
      type: 'creditCard',
      pattern: /\b(?:\d{4}[-.\s]?){3}\d{4}\b/g,
    },
    {
      type: 'ipAddress',
      pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    },
    {
      type: 'norwegianPersonNumber',
      pattern: /\b\d{6}\s?\d{5}\b/g, // Norwegian personnummer: DDMMYY XXXXX
    },
    {
      type: 'iban',
      pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/gi,
    },
  ];
}

/**
 * Redact PII from content
 */
export function redactPII(content: string): string {
  const result = detectPII(content);
  return result.redactedContent;
}

/**
 * Check if content contains PII (quick check)
 */
export function containsPII(content: string): boolean {
  const result = detectPII(content);
  return result.hasPII;
}

