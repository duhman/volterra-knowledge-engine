# Volterra Knowledge Engine

> Enterprise document ingestion pipeline with AI embeddings, multi-source connectors, and GDPR-compliant semantic search.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933)
![Supabase](https://img.shields.io/badge/Supabase-pgvector-3ECF8E)
![OpenAI](https://img.shields.io/badge/OpenAI-Embeddings-412991)

## Architecture

```mermaid
graph TB
    CLI[CLI Commands] -->|Ingest| DP[Document Processor]
    DP -->|Parse| Parsers[Format Parsers]
    DP -->|Embed| OAI[OpenAI API]
    DP -->|Store| DB[(PostgreSQL + pgvector)]
    DP -->|Compliance| PII[PII Detector]

    subgraph Sources
        FS[Local Files]
        NO[Notion API]
        SP[SharePoint]
        HS[HubSpot]
        SL[Slack Export]
    end

    Sources -->|Fetch| DP

    subgraph Edge Functions
        HTS[HubSpot Ticket Sync]
        NPS[Notion Pages Sync]
        SCS[Slack Channel Sync]
        MCP[MCP Server]
    end

    Cron[pg_cron] -->|Scheduled| Edge Functions
    Edge Functions -->|Read/Write| DB
```

## Key Features

- **Multi-source ingestion** — Local files, Notion, SharePoint, HubSpot, Slack with unified processing pipeline
- **Format support** — PDF, DOCX, XLSX, CSV, HTML, email, plain text with extensible parser architecture
- **pgvector embeddings** — OpenAI text-embedding-3-small (1536d) with HNSW indexes for semantic search
- **GDPR compliance** — Automatic PII detection, sensitivity classification, and access level enforcement
- **Automated sync** — pg_cron + Edge Functions for daily data ingestion from Notion, HubSpot, Slack
- **MCP server** — Read-only Model Context Protocol server exposing 27 tools for AI agent access
- **n8n integration** — Workflow management CLI for automating ingestion pipelines

## Tech Stack

| Layer      | Technology                                            |
| ---------- | ----------------------------------------------------- |
| Runtime    | Node.js 18+ with TypeScript (ESM)                     |
| Database   | PostgreSQL + pgvector (Supabase)                      |
| Embeddings | OpenAI text-embedding-3-small (1536d)                 |
| Parsers    | pdfjs-dist, mammoth, xlsx, mailparser                 |
| Sources    | Notion API, Microsoft Graph, HubSpot API, Slack API   |
| Compliance | Custom PII detector with redact-pii, franc (language) |
| Scheduling | pg_cron + Supabase Edge Functions                     |
| CLI        | Commander.js with structured logging (Winston)        |

## Project Structure

```
src/
├── core/
│   ├── document-processor.ts    # Main orchestration (451 lines)
│   ├── embedding-service.ts     # OpenAI embedding generation
│   └── metadata-inference.ts    # Auto-classification
├── parsers/                     # Format-specific text extraction
│   ├── pdf-parser.ts
│   ├── docx-parser.ts
│   ├── xlsx-parser.ts
│   ├── wod-parser.ts            # Structured deal data extraction
│   └── ...
├── sources/                     # Data source connectors
│   ├── notion-source.ts
│   ├── sharepoint-source.ts
│   ├── hubspot-source.ts
│   └── slack-source.ts
├── compliance/
│   ├── pii-detector.ts          # PII pattern detection
│   └── gdpr-handler.ts          # Sensitivity classification
├── services/
│   ├── n8n-api-client.ts        # n8n REST API client
│   └── vision-service.ts        # GPT-4o image analysis
└── scripts/                     # CLI entry points
supabase/
├── functions/                   # Edge Functions (sync, MCP)
└── migrations/                  # PostgreSQL schema migrations
```

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment:

   ```bash
   cp .env.example .env
   ```

3. Set up database (run migrations in Supabase SQL Editor):

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   -- Then apply migration files in chronological order
   ```

4. Ingest documents:

   ```bash
   # Local files
   npm run ingest:file ./documents/

   # From Notion
   npm run ingest:notion

   # From HubSpot
   npm run ingest:hubspot

   # Slack export
   npm run ingest:slack -- --export-path /path/to/export
   ```

## GDPR Compliance

The system automatically detects PII (emails, phone numbers, SSNs, names) and classifies document sensitivity:

| Mode       | Behavior                                       |
| ---------- | ---------------------------------------------- |
| **Flag**   | Detects and flags PII, stores original content |
| **Redact** | Replaces PII with placeholders before storing  |

Documents with detected PII are automatically upgraded to `restricted` or `confidential` access levels.

## Key Design Decisions

- **Extensible parser architecture** — Base class pattern makes adding new format parsers trivial
- **Source-agnostic processing** — All sources normalize to the same document interface before embedding
- **HNSW over IVFFlat** — Better recall accuracy for semantic search at slightly higher index build cost
- **pg_cron for sync** — Database-native scheduling avoids external cron services
- **MCP server** — Exposes knowledge base to AI agents via standardized protocol

## Built By

Adrian Marten — [GitHub](https://github.com/adrianmarten)
