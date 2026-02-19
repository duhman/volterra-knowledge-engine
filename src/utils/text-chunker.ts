/**
 * Text chunking utilities for RAG optimization
 * Splits long documents into semantically meaningful chunks
 */

export interface ChunkOptions {
  /** Maximum characters per chunk (default: 2000) */
  maxChunkSize?: number;
  /** Minimum characters per chunk (default: 200) */
  minChunkSize?: number;
  /** Overlap between chunks in characters (default: 100) */
  overlap?: number;
  /** Split by headers (H1, H2, H3) for semantic chunking */
  splitByHeaders?: boolean;
  /** Preserve Q&A patterns (keep question and answer together) */
  preserveQA?: boolean;
}

export interface TextChunk {
  content: string;
  index: number;
  metadata: {
    section?: string;
    startChar: number;
    endChar: number;
    isQA?: boolean;
  };
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  maxChunkSize: 2000,
  minChunkSize: 200,
  overlap: 100,
  splitByHeaders: true,
  preserveQA: true,
};

/**
 * Chunk text into semantically meaningful pieces
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  // If text is small enough, return as single chunk
  if (text.length <= opts.maxChunkSize) {
    return [{
      content: text,
      index: 0,
      metadata: { startChar: 0, endChar: text.length },
    }];
  }

  // Try semantic chunking by headers first
  if (opts.splitByHeaders) {
    const headerChunks = chunkByHeaders(text, opts);
    if (headerChunks.length > 1) {
      return headerChunks;
    }
  }

  // Fall back to sliding window chunking
  return chunkBySlidingWindow(text, opts);
}

/**
 * Split text by markdown headers (H1, H2, H3)
 */
function chunkByHeaders(text: string, opts: Required<ChunkOptions>): TextChunk[] {
  // Match H1, H2, H3 headers
  const headerPattern = /^(#{1,3})\s+(.+)$/gm;
  const chunks: TextChunk[] = [];
  
  const matches: Array<{ index: number; level: number; title: string }> = [];
  
  let match;
  while ((match = headerPattern.exec(text)) !== null) {
    matches.push({
      index: match.index,
      level: match[1].length,
      title: match[2].trim(),
    });
  }

  if (matches.length === 0) {
    // No headers found, try Q&A pattern
    if (opts.preserveQA) {
      const qaChunks = chunkByQAPattern(text, opts);
      if (qaChunks.length > 1) {
        return qaChunks;
      }
    }
    return [];
  }

  // Split by headers
  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i];
    const nextMatch = matches[i + 1];
    
    const startIndex = currentMatch.index;
    const endIndex = nextMatch ? nextMatch.index : text.length;
    const sectionContent = text.slice(startIndex, endIndex).trim();
    
    // If section is too large, split it further
    if (sectionContent.length > opts.maxChunkSize) {
      const subChunks = chunkBySlidingWindow(sectionContent, opts);
      for (const subChunk of subChunks) {
        chunks.push({
          content: subChunk.content,
          index: chunks.length,
          metadata: {
            section: currentMatch.title,
            startChar: startIndex + subChunk.metadata.startChar,
            endChar: startIndex + subChunk.metadata.endChar,
          },
        });
      }
    } else if (sectionContent.length >= opts.minChunkSize) {
      chunks.push({
        content: sectionContent,
        index: chunks.length,
        metadata: {
          section: currentMatch.title,
          startChar: startIndex,
          endChar: endIndex,
        },
      });
    }
  }

  // Handle content before first header
  if (matches.length > 0 && matches[0].index > opts.minChunkSize) {
    const preamble = text.slice(0, matches[0].index).trim();
    if (preamble.length >= opts.minChunkSize) {
      chunks.unshift({
        content: preamble,
        index: 0,
        metadata: {
          section: 'Introduction',
          startChar: 0,
          endChar: matches[0].index,
        },
      });
      // Re-index other chunks
      for (let i = 1; i < chunks.length; i++) {
        chunks[i].index = i;
      }
    }
  }

  return chunks;
}

/**
 * Split text by Q&A pattern (common in support FAQs)
 */
function chunkByQAPattern(text: string, opts: Required<ChunkOptions>): TextChunk[] {
  // Match Q&A patterns: "**Q:**" or "Q:" at start of line
  const qaPattern = /(?:^|\n)\*?\*?Q:?\*?\*?\s+/gi;
  const chunks: TextChunk[] = [];
  
  const matches: number[] = [];
  let match;
  while ((match = qaPattern.exec(text)) !== null) {
    matches.push(match.index);
  }

  if (matches.length < 2) {
    return [];
  }

  // Split by Q&A pairs
  for (let i = 0; i < matches.length; i++) {
    const startIndex = matches[i];
    const endIndex = matches[i + 1] || text.length;
    const qaContent = text.slice(startIndex, endIndex).trim();
    
    if (qaContent.length >= opts.minChunkSize) {
      // Further split if too large
      if (qaContent.length > opts.maxChunkSize) {
        const subChunks = chunkBySlidingWindow(qaContent, opts);
        chunks.push(...subChunks.map((sc, idx) => ({
          ...sc,
          index: chunks.length + idx,
          metadata: {
            ...sc.metadata,
            isQA: true,
            startChar: startIndex + sc.metadata.startChar,
            endChar: startIndex + sc.metadata.endChar,
          },
        })));
      } else {
        chunks.push({
          content: qaContent,
          index: chunks.length,
          metadata: {
            isQA: true,
            startChar: startIndex,
            endChar: endIndex,
          },
        });
      }
    }
  }

  return chunks;
}

/**
 * Sliding window chunking with overlap
 */
function chunkBySlidingWindow(text: string, opts: Required<ChunkOptions>): TextChunk[] {
  const chunks: TextChunk[] = [];
  let startChar = 0;
  let iterations = 0;
  const maxIterations = Math.ceil(text.length / Math.max(opts.minChunkSize, 1)) + 10; // Safety limit

  while (startChar < text.length) {
    // Safety check to prevent infinite loops
    if (++iterations > maxIterations) {
      // Add remaining content as final chunk and break
      const remaining = text.slice(startChar).trim();
      if (remaining.length > 0) {
        chunks.push({
          content: remaining,
          index: chunks.length,
          metadata: { startChar, endChar: text.length },
        });
      }
      break;
    }
    let endChar = Math.min(startChar + opts.maxChunkSize, text.length);
    
    // Try to end at a sentence or paragraph boundary
    if (endChar < text.length) {
      const searchStart = Math.max(startChar + opts.minChunkSize, endChar - 200);
      const searchText = text.slice(searchStart, endChar);
      
      // Look for sentence boundaries (. ! ?)
      const sentenceEnd = findLastSentenceEnd(searchText);
      if (sentenceEnd !== -1) {
        endChar = searchStart + sentenceEnd + 1;
      } else {
        // Look for paragraph boundaries
        const paragraphEnd = searchText.lastIndexOf('\n\n');
        if (paragraphEnd !== -1) {
          endChar = searchStart + paragraphEnd;
        }
      }
    }

    const content = text.slice(startChar, endChar).trim();
    if (content.length >= opts.minChunkSize) {
      chunks.push({
        content,
        index: chunks.length,
        metadata: {
          startChar,
          endChar,
        },
      });
    }

    // Move start position with overlap
    const newStartChar = endChar - opts.overlap;
    
    // Prevent infinite loop: if we're not making progress, force move forward
    if (newStartChar <= startChar) {
      startChar = endChar;
    } else {
      startChar = newStartChar;
    }
    
    if (startChar >= text.length) break;
  }

  return chunks;
}

/**
 * Find the last sentence ending in text
 */
function findLastSentenceEnd(text: string): number {
  let lastEnd = -1;
  
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i];
    if (char === '.' || char === '!' || char === '?') {
      // Make sure it's not an abbreviation or decimal
      const nextChar = text[i + 1];
      if (!nextChar || nextChar === ' ' || nextChar === '\n') {
        return i;
      }
    }
  }
  
  return lastEnd;
}

/**
 * Check if text should be chunked
 */
export function shouldChunk(text: string, maxSize: number = 2000): boolean {
  return text.length > maxSize;
}

/**
 * Estimate token count (rough approximation)
 */
export function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}
