# Notion Support Content Ingestion

Ingestion pipeline for customer support material from Notion into Supabase with vector embeddings for RAG-based AI agent retrieval.

## Overview

- **Source**: Notion workspace (customer support KB, call center resources, payment guides)
- **Target**: Supabase `documents` table with pgvector embeddings
- **Model**: OpenAI `text-embedding-3-small` (1536 dimensions)
- **Chunking**: Semantic chunking by headers/Q&A patterns for optimal retrieval

## Quick Start

```bash
# List available presets
npm run ingest:support -- --list-presets

# Dry run (validate without inserting)
npm run ingest:support -- --preset all --dry-run

# Ingest all support content
npm run ingest:support -- --preset all

# Ingest specific category
npm run ingest:support -- --preset call-center
npm run ingest:support -- --preset payment
```

## Presets

| Preset | Description | Content |
|--------|-------------|---------|
| `all` | All support content | All pages below |
| `call-center` | Call center training | Scripts, training materials |
| `support-docs` | Process documentation | Escalation, workflows |
| `payment` | Billing guides | Tariffs, subscriptions, refunds |
| `user-guides` | Platform guides | Ampeco user documentation |

## CLI Options

```
--preset <name>      Preset to use (default: all)
--page-ids <ids>     Custom comma-separated Notion page IDs
-r, --recursive      Fetch child pages recursively (default: true)
--max-depth <n>      Recursion depth limit (default: 3)
-d, --department     Department tag (default: Support)
-t, --type           Document type (default: Knowledge Base)
--tags <tags>        Additional comma-separated tags
--enable-chunking    Enable semantic chunking (default: true)
--max-chunk-size     Chunk size in chars (default: 2000)
--dry-run            Validate without DB insert
--limit <n>          Max pages to process
```

## Chunking Strategy

Long documents are split into semantically meaningful chunks for better RAG retrieval:

1. **Header-based**: Splits by H1/H2/H3 markdown headers
2. **Q&A pattern**: Preserves question-answer pairs together (toggle blocks)
3. **Sliding window**: Fallback with overlap for unstructured content

Each chunk stored as separate document with:
- `tags` includes `chunk:N/M` (e.g., `chunk:3/17`)
- Title format: `{Parent Title} - {Section Title}`
- Shared metadata (department, access_level, source URL)

## Notion Block Handling

Enhanced parsing for support-specific content:

| Block Type | Rendering |
|------------|-----------|
| Toggle | `**Q:** {text}` (FAQ pattern) |
| Callout | `{icon} **Note:** {text}` |
| Bookmark/Link | `[Link: {url}]` |
| Image/Video | `[Image: {url}]` |
| Table | Markdown table format |

## Data Flow

```
Notion API → NotionSource.listDocuments()
           → NotionSource.downloadDocument() (blocks → text)
           → document-processor.processDocument()
             → text-chunker.chunkText() (if enabled)
             → pii-detector (GDPR scan)
             → embedding-service (OpenAI)
             → supabase-client.insertDocuments()
```

## Database Schema

Documents stored with:

```sql
SELECT title, department, document_type, tags, sensitivity, access_level
FROM documents
WHERE 'support' = ANY(tags);
```

Key fields:
- `content`: Full text or chunk content
- `embedding`: vector(1536) for semantic search
- `tags`: Array including `support`, `kb`, chunk info
- `metadata`: JSONB with Notion URL, created/edited times

## Semantic Search

```typescript
const { data } = await supabase.rpc('match_documents', {
  query_embedding: embedding,
  match_threshold: 0.7,
  match_count: 5,
  filter_department: 'Support',
});
```

## Setup Requirements

1. Create Notion integration at https://www.notion.so/my-integrations
2. Share support pages with the integration
3. Set environment variable:
   ```
   NOTION_API_KEY=secret_xxx
   ```

## Adding New Support Pages

1. Get page ID from Notion URL (last segment before `?`)
2. Add to `SUPPORT_PAGE_IDS` in `src/scripts/ingest-support.ts`
3. Create or update preset if needed
4. Share page with Notion integration
5. Run ingestion

## Verification

```bash
# Run verification script
npx tsx src/scripts/verify-support.ts
```

Or query directly:
```sql
SELECT title, tags FROM documents 
WHERE 'support' = ANY(tags) 
ORDER BY created_at DESC LIMIT 20;
```
