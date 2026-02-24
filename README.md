# Volterra Knowledge Engine

> The data backbone powering Volterra's AI tools -- ingesting documents from 5 sources, generating embeddings, and enforcing GDPR compliance so every other platform component can search company knowledge.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933)
![Supabase](https://img.shields.io/badge/Supabase-pgvector-3ECF8E)
![OpenAI](https://img.shields.io/badge/OpenAI-Embeddings-412991)

## The Problem

Operational knowledge was scattered across five systems -- Notion wikis, SharePoint drives, HubSpot tickets, Slack threads, and local file shares. Support agents re-answered questions that had been solved months earlier. Product and leadership had no way to search across sources. And with EU-based customers, any AI tool touching this data needed automatic PII detection and GDPR-compliant handling.

## What This Does

- **Multi-source ingestion** -- Pulls documents from Notion, SharePoint, HubSpot, Slack, and local files through a unified processing pipeline with format-specific parsers (PDF, DOCX, XLSX, CSV, HTML, email)
- **Automatic PII detection and GDPR compliance** -- Flags or redacts personal data before embedding, classifies document sensitivity, enforces access levels
- **27 MCP tools for AI agents** -- Exposes the entire knowledge base via Model Context Protocol so downstream apps (Semantic Platform, website AI chat) can query it programmatically

## Impact

| Metric                | Detail                                                                   |
| --------------------- | ------------------------------------------------------------------------ |
| Ingestion sources     | 5 systems unified into one searchable pipeline                           |
| MCP tools shipped     | 27 read-only tools for AI agent access                                   |
| Ticket categorization | 90.6% accuracy over 11,800+ tickets (auto-classifier built on this data) |
| PII handling          | Automatic detection and sensitivity classification                       |
| Sync frequency        | Daily automated ingestion via pg_cron + Edge Functions                   |

## Part of the Volterra Platform

Knowledge Engine is the foundation layer. It generates the embeddings that power the [Semantic Platform](../volterra-semantic-platform/)'s 5 GPT apps, feeds the [website](../volterra-web/) AI chat via n8n, and provides ticket data for [Call Intelligence](../volterra-call-intelligence/) analysis.

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
