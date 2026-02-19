import { franc } from 'franc';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import type { DocumentMetadata, AccessLevel, Sensitivity } from '../types/index.js';

export interface InferredMetadata {
  department: string;
  documentType: string;
  language: string;
  accessLevel: AccessLevel;
}

/**
 * Infer metadata from document content and existing metadata
 */
export function inferMetadata(
  content: string,
  existingMetadata: Partial<DocumentMetadata>
): InferredMetadata {
  const config = getConfig();
  
  // Use provided values or infer
  const department = existingMetadata.department || inferDepartment(content, config);
  const documentType = existingMetadata.documentType || inferDocumentType(content, existingMetadata, config);
  const language = existingMetadata.language || inferLanguage(content);
  const accessLevel = existingMetadata.accessLevel || inferAccessLevel(content, config);

  logger.debug('Metadata inferred', { department, documentType, language, accessLevel });

  return {
    department,
    documentType,
    language,
    accessLevel,
  };
}

/**
 * Infer department from content keywords
 */
function inferDepartment(
  content: string,
  config: ReturnType<typeof getConfig>
): string {
  const lowerContent = content.toLowerCase();
  const departments = config.metadataInference.departments;

  // Score each department based on keyword matches
  const scores: Record<string, number> = {};
  
  for (const [dept, keywords] of Object.entries(departments)) {
    scores[dept] = 0;
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = lowerContent.match(regex);
      if (matches) {
        scores[dept] += matches.length;
      }
    }
  }

  // Find department with highest score
  let maxDept = 'General';
  let maxScore = 0;
  
  for (const [dept, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxDept = dept;
    }
  }

  // Require minimum threshold to assign department
  if (maxScore < 2) {
    return 'General';
  }

  return maxDept;
}

/**
 * Infer document type from content and filename
 */
function inferDocumentType(
  content: string,
  metadata: Partial<DocumentMetadata>,
  config: ReturnType<typeof getConfig>
): string {
  const lowerContent = content.toLowerCase();
  const documentTypes = config.metadataInference.documentTypes;

  // Check filename first
  if (metadata.originalFilename) {
    const filename = metadata.originalFilename.toLowerCase();
    for (const [type, keywords] of Object.entries(documentTypes)) {
      for (const keyword of keywords) {
        if (filename.includes(keyword)) {
          return type;
        }
      }
    }
  }

  // Check MIME type for emails
  if (metadata.mimeType === 'message/rfc822') {
    return 'Email';
  }

  // Score document types based on content
  const scores: Record<string, number> = {};
  
  for (const [type, keywords] of Object.entries(documentTypes)) {
    scores[type] = 0;
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = lowerContent.match(regex);
      if (matches) {
        scores[type] += matches.length;
      }
    }
  }

  // Find type with highest score
  let maxType = 'Document';
  let maxScore = 0;
  
  for (const [type, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxType = type;
    }
  }

  // Require minimum threshold
  if (maxScore < 2) {
    return 'Document';
  }

  return maxType;
}

/**
 * Detect language using franc
 */
function inferLanguage(content: string): string {
  // Need sufficient text for reliable detection
  if (content.length < 50) {
    return 'en'; // Default to English
  }

  const langCode = franc(content, { minLength: 50 });
  
  // Map franc language codes to standard codes
  const langMap: Record<string, string> = {
    eng: 'en',
    nob: 'no', // Norwegian Bokmal
    nno: 'no', // Norwegian Nynorsk
    dan: 'da',
    swe: 'sv',
    deu: 'de',
    fra: 'fr',
    spa: 'es',
    ita: 'it',
    nld: 'nl',
    por: 'pt',
    pol: 'pl',
    und: 'en', // Undetermined
  };

  return langMap[langCode] || langCode || 'en';
}

/**
 * Infer access level based on content analysis
 */
function inferAccessLevel(
  content: string,
  config: ReturnType<typeof getConfig>
): AccessLevel {
  const lowerContent = content.toLowerCase();
  const accessConfig = config.metadataInference.accessLevels;

  // Check for confidential keywords
  const confidentialKeywords = [
    'confidential', 'nda', 'non-disclosure', 'trade secret',
    'proprietary', 'classified', 'secret',
  ];
  for (const keyword of confidentialKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'confidential';
    }
  }

  // Check for restricted keywords
  const restrictedKeywords = [
    'restricted', 'internal only', 'not for distribution',
    'private', 'sensitive',
  ];
  for (const keyword of restrictedKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'restricted';
    }
  }

  // Check for contract-related content
  if (
    lowerContent.includes('contract') ||
    lowerContent.includes('agreement') ||
    lowerContent.includes('terms and conditions')
  ) {
    return (accessConfig.contractKeywords as AccessLevel) || 'confidential';
  }

  return (accessConfig.default as AccessLevel) || 'internal';
}

/**
 * Determine sensitivity based on PII detection results
 */
export function determineSensitivity(
  piiDetected: boolean,
  piiTypes: string[] = []
): Sensitivity {
  if (!piiDetected) {
    return 'None';
  }

  // Check for GDPR-specific data types
  const gdprTypes = [
    'ssn', 'social security',
    'passport', 'national id',
    'health', 'medical',
    'race', 'ethnicity', 'religion',
    'political', 'sexual orientation',
    'biometric', 'genetic',
  ];

  for (const type of piiTypes) {
    const lowerType = type.toLowerCase();
    for (const gdprType of gdprTypes) {
      if (lowerType.includes(gdprType)) {
        return 'GDPR';
      }
    }
  }

  return 'PII';
}

/**
 * Upgrade access level if PII is detected
 */
export function upgradeAccessLevelForPII(
  currentLevel: AccessLevel,
  sensitivity: Sensitivity
): AccessLevel {
  if (sensitivity === 'None') {
    return currentLevel;
  }

  const levelOrder: AccessLevel[] = ['public', 'internal', 'restricted', 'confidential'];
  const currentIndex = levelOrder.indexOf(currentLevel);
  
  // PII requires at least 'restricted'
  const minIndex = sensitivity === 'GDPR' ? 3 : 2; // confidential for GDPR, restricted for PII
  
  if (currentIndex < minIndex) {
    const newLevel = levelOrder[minIndex];
    logger.info('Access level upgraded due to PII', {
      original: currentLevel,
      upgraded: newLevel,
      sensitivity,
    });
    return newLevel;
  }

  return currentLevel;
}

