# Repository Guidelines

## Project Structure & Module Organization

- `src/` holds the TypeScript source. Key areas: `core/` (pipeline orchestration), `parsers/` (file format extraction), `sources/` (Notion/SharePoint/HubSpot/Slack/file), `services/` (n8n client), `compliance/` (PII/GDPR), `database/` (Supabase client + migrations), `scripts/` (CLI entry points), and `types/`.
- `supabase/migrations/` contains timestamped SQL migrations that must be applied in order.
- `supabase/functions/` contains Edge Functions for daily syncs (Notion, Slack, HubSpot).
- `config/default.json` is the non-secret runtime configuration. `docs/` houses operational documentation.
- Claude skills live in `.claude/skills/` (e.g. `volterra-kb/`, `n8n/`).

## Build, Test, and Development Commands

- `npm run dev` runs `tsx watch` for local development.
- `npm run build` compiles TypeScript to `dist/`; `npm run start` runs `dist/index.js`.
- `npm run typecheck` runs `tsc --noEmit` for static checks.
- Ingestion entry points live in `src/scripts/` (e.g., `npm run ingest:file`, `npm run ingest:notion`, `npm run ingest:slack -- --export-path /path`).
- `npm run n8n` manages n8n workflows (list/get/update/etc.), incl `test` + `patch-supabase`.
- `npm run test:slack-env` validates Slack Edge Function configuration.

## Coding Style & Naming Conventions

- TypeScript ESM (`"type": "module"`), strict mode; import paths include `.js` extensions.
- Indentation is 2 spaces; prefer small, focused modules.
- Naming: `PascalCase` for classes, `camelCase` for functions/vars, `kebab-case` for filenames (e.g., `batch-ingest.ts`).
- No formatter/linter is configured; keep style consistent with nearby files.

## Testing Guidelines

- There is no dedicated test framework or `tests/` directory.
- Validate changes with `npm run typecheck` and by running the relevant CLI script(s) for the area you touched (ingestion, sync, or training tools).

## Commit & Pull Request Guidelines

- Recent commit messages are sentence-case, descriptive summaries (e.g., “Add Notion integration features…”). Follow that pattern.
- PRs should include: a brief summary, any new/updated env vars, migration files (if schema changes), and the exact commands used to validate changes.
- If adding migrations, note they must be run manually in Supabase SQL Editor and consider updating `src/types/database.types.ts`.

## Security & Configuration Tips

- Keep secrets in `.env` (see `.env.example`); never commit service role keys.
- Use `config/default.json` for non-secret defaults and document any changes in `README.md` or `docs/` when behavior shifts.
