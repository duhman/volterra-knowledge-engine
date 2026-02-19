import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { detectPII, type PIIDetectionResult } from './pii-detector.js';
import { determineSensitivity, upgradeAccessLevelForPII } from '../core/metadata-inference.js';
import type { DocumentMetadata, Sensitivity, AccessLevel } from '../types/index.js';

export interface GDPRComplianceResult {
  isCompliant: boolean;
  sensitivity: Sensitivity;
  accessLevel: AccessLevel;
  piiDetected: boolean;
  piiTypes: string[];
  content: string;
  warnings: string[];
  auditLog: AuditLogEntry;
}

export interface AuditLogEntry {
  timestamp: Date;
  action: 'PII_SCAN';
  documentTitle: string;
  piiFound: boolean;
  piiTypes: string[];
  sensitivityLevel: Sensitivity;
  accessLevelAssigned: AccessLevel;
  redactionApplied: boolean;
}

/**
 * Process document for GDPR compliance
 */
export function processForGDPR(
  content: string,
  metadata: Partial<DocumentMetadata>
): GDPRComplianceResult {
  const config = getConfig();
  const warnings: string[] = [];
  
  // Detect PII
  let piiResult: PIIDetectionResult;
  try {
    piiResult = detectPII(content);
  } catch (error) {
    logger.error('GDPR processing failed during PII detection', { error });
    // Continue with no PII detected as fallback
    piiResult = {
      hasPII: false,
      entities: [],
      redactedContent: content,
      originalContent: content,
      piiTypes: [],
    };
    warnings.push('PII detection encountered an error - document flagged for manual review');
  }

  // Determine sensitivity based on PII types
  const sensitivity = determineSensitivity(piiResult.hasPII, piiResult.piiTypes);

  // Determine access level (upgrade if PII detected)
  const baseAccessLevel = metadata.accessLevel || 'internal';
  const accessLevel = upgradeAccessLevelForPII(baseAccessLevel, sensitivity);

  // Check if access level was upgraded
  if (accessLevel !== baseAccessLevel) {
    warnings.push(`Access level upgraded from '${baseAccessLevel}' to '${accessLevel}' due to ${sensitivity} data`);
  }

  // Determine final content (redacted or original)
  const finalContent = config.compliance.piiDetection.mode === 'redact'
    ? piiResult.redactedContent
    : piiResult.originalContent;

  // Check compliance
  const isCompliant = !piiResult.hasPII || (sensitivity !== 'None' && accessLevel !== 'public');

  if (!isCompliant) {
    warnings.push('Document contains PII but access level is set to public - this violates GDPR');
  }

  // Create audit log entry
  const auditLog: AuditLogEntry = {
    timestamp: new Date(),
    action: 'PII_SCAN',
    documentTitle: metadata.title || 'Unknown',
    piiFound: piiResult.hasPII,
    piiTypes: piiResult.piiTypes,
    sensitivityLevel: sensitivity,
    accessLevelAssigned: accessLevel,
    redactionApplied: config.compliance.piiDetection.mode === 'redact' && piiResult.hasPII,
  };

  // Log audit entry
  logger.info('GDPR compliance check complete', {
    audit: auditLog,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  return {
    isCompliant,
    sensitivity,
    accessLevel,
    piiDetected: piiResult.hasPII,
    piiTypes: piiResult.piiTypes,
    content: finalContent,
    warnings,
    auditLog,
  };
}

/**
 * Validate that document metadata meets GDPR requirements
 */
export function validateGDPRCompliance(
  metadata: DocumentMetadata,
  piiDetected: boolean
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (piiDetected) {
    // Must have sensitivity set
    if (!metadata.sensitivity || metadata.sensitivity === 'None') {
      issues.push('Document contains PII but sensitivity is not set');
    }

    // Cannot be public access
    if (metadata.accessLevel === 'public') {
      issues.push('Document with PII cannot have public access level');
    }

    // Should have an owner for accountability
    if (!metadata.owner) {
      issues.push('Document with PII should have an owner assigned');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Generate GDPR compliance report for a batch of documents
 */
export function generateComplianceReport(
  auditLogs: AuditLogEntry[]
): {
  totalDocuments: number;
  documentsWithPII: number;
  piiTypeBreakdown: Record<string, number>;
  sensitivityBreakdown: Record<string, number>;
  accessLevelBreakdown: Record<string, number>;
  redactionStats: { total: number; redacted: number };
} {
  const piiTypeBreakdown: Record<string, number> = {};
  const sensitivityBreakdown: Record<string, number> = {};
  const accessLevelBreakdown: Record<string, number> = {};
  let documentsWithPII = 0;
  let redactedCount = 0;

  for (const log of auditLogs) {
    // Count PII documents
    if (log.piiFound) {
      documentsWithPII++;
    }

    // Count PII types
    for (const type of log.piiTypes) {
      piiTypeBreakdown[type] = (piiTypeBreakdown[type] || 0) + 1;
    }

    // Count sensitivity levels
    sensitivityBreakdown[log.sensitivityLevel] = 
      (sensitivityBreakdown[log.sensitivityLevel] || 0) + 1;

    // Count access levels
    accessLevelBreakdown[log.accessLevelAssigned] = 
      (accessLevelBreakdown[log.accessLevelAssigned] || 0) + 1;

    // Count redactions
    if (log.redactionApplied) {
      redactedCount++;
    }
  }

  return {
    totalDocuments: auditLogs.length,
    documentsWithPII,
    piiTypeBreakdown,
    sensitivityBreakdown,
    accessLevelBreakdown,
    redactionStats: {
      total: documentsWithPII,
      redacted: redactedCount,
    },
  };
}

