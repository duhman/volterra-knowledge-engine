export { detectPII, redactPII, containsPII, type PIIDetectionResult } from './pii-detector.js';
export { 
  processForGDPR, 
  validateGDPRCompliance, 
  generateComplianceReport,
  type GDPRComplianceResult,
  type AuditLogEntry,
} from './gdpr-handler.js';

