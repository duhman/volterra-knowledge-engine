# n8n Workflow Update: Slack Chronological Queries

**Workflow ID**: `c4tHYJcGwSaDAA6c`
**Date**: 2026-01-15

## Problem

The n8n AI agent (Ela) couldn't answer queries like "Summarize the most recent 10 messages from #help-me-platform" because it only had semantic search capabilities, not chronological query functions.

## Solution Implemented

Created 4 new PostgreSQL RPC functions in Cloud Supabase that n8n can call via PostgREST:

| Function                                                            | Purpose                    |
| ------------------------------------------------------------------- | -------------------------- |
| `get_latest_slack_messages(channel_id, limit)`                      | Get N most recent messages |
| `get_slack_messages_by_date(channel_id, date_from, date_to, limit)` | Messages in date range     |
| `get_slack_thread_messages(thread_ts, channel_id)`                  | Full thread conversation   |
| `get_slack_channel_summary(channel_id, days)`                       | Channel activity stats     |

## How to Enable in n8n

### Option 1: Add HTTP Request Tool (Recommended)

Add a new **HTTP Request Tool** node connected to the AI Agent:

**Configuration:**

```
Tool Name: slack_chronological_query
Tool Description: Query Slack messages by time (latest N messages, date ranges, full threads)
```

**HTTP Request Settings:**

- Method: POST
- URL: `https://your-project.supabase.co/rest/v1/rpc/get_latest_slack_messages`
- Headers:
  - `apikey`: `{{ $env.SUPABASE_ANON_KEY }}`
  - `Authorization`: `Bearer {{ $env.SUPABASE_ANON_KEY }}`
  - `Content-Type`: `application/json`
- Body:

```json
{
  "p_channel_id": "C05FA8B5YPM",
  "p_limit": 10
}
```

### Option 2: Update System Prompt

Add this section to the AI Agent's system prompt:

```markdown
## SLACK CHRONOLOGICAL QUERIES (NEW)

For questions about recent Slack activity or time-based queries, use these RPC functions:

### get_latest_slack_messages(channel_id, limit)

Get the N most recent messages from a channel.

- Default channel: C05FA8B5YPM (#help-me-platform)
- Max limit: 200
- Example: "Show me the latest 10 messages from #help-me-platform"

### get_slack_messages_by_date(channel_id, date_from, date_to, limit)

Get messages within a specific date range.

- Default range: last 7 days
- Max limit: 500
- Example: "What was discussed in #help-me-platform yesterday?"

### get_slack_thread_messages(thread_ts, channel_id)

Get all messages in a specific thread.

- Requires thread_ts from a previous search
- Returns full conversation chronologically
- Example: "Show me the full thread about [topic]"

### get_slack_channel_summary(channel_id, days)

Get quick statistics for a channel.

- Total messages, unique users, thread count
- Example: "How active was #help-me-platform last week?"

### WHEN TO USE

- "Latest messages" → get_latest_slack_messages
- "Recent activity" → get_slack_messages_by_date
- "Full thread/conversation" → get_slack_thread_messages
- "Channel activity/stats" → get_slack_channel_summary

### CHANNEL IDS

- #help-me-platform: C05FA8B5YPM (default)
- Other channels: Ask user or search documents first
```

## PostgREST API Endpoints

All functions are available at:

```
POST https://your-project.supabase.co/rest/v1/rpc/{function_name}
```

### Example API Calls

**Latest 10 messages:**

```bash
curl -X POST \
  'https://your-project.supabase.co/rest/v1/rpc/get_latest_slack_messages' \
  -H 'apikey: YOUR_ANON_KEY' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"p_channel_id": "C05FA8B5YPM", "p_limit": 10}'
```

**Messages from last 24 hours:**

```bash
curl -X POST \
  'https://your-project.supabase.co/rest/v1/rpc/get_slack_messages_by_date' \
  -H 'apikey: YOUR_ANON_KEY' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "p_channel_id": "C05FA8B5YPM",
    "p_date_from": "2026-01-14T00:00:00Z",
    "p_date_to": "2026-01-15T00:00:00Z",
    "p_limit": 50
  }'
```

**Full thread:**

```bash
curl -X POST \
  'https://your-project.supabase.co/rest/v1/rpc/get_slack_thread_messages' \
  -H 'apikey: YOUR_ANON_KEY' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"p_thread_ts": "1768402473.696469", "p_channel_id": "C05FA8B5YPM"}'
```

## Response Format

All functions return consistent fields:

- `id` - UUID
- `channel_id` - Slack channel ID
- `message_ts` - Slack timestamp
- `thread_ts` - Thread parent timestamp (if reply)
- `user_id` - Slack user ID
- `user_display_name` - User's display name (NEW - was null before fix)
- `user_real_name` - User's real name (NEW - was null before fix)
- `text` - Message content (no longer duplicated after fix)
- `message_at` - ISO timestamp
- `has_files`, `file_count` - Attachment info
- `bot_id`, `subtype` - Slack message metadata

## Migration Files

Apply these migrations to Cloud Supabase:

1. `supabase/migrations/20260115000000_add_slack_chronological_functions.sql`
   - Creates the 4 RPC functions

2. `supabase/migrations/20260115000001_backfill_slack_user_names.sql`
   - Creates backfill function for existing messages

## Testing

After applying migrations, test with:

```sql
-- Test latest messages
SELECT * FROM get_latest_slack_messages('C05FA8B5YPM', 5);

-- Test date range
SELECT * FROM get_slack_messages_by_date(
  'C05FA8B5YPM',
  NOW() - INTERVAL '24 hours',
  NOW(),
  10
);

-- Test channel summary
SELECT * FROM get_slack_channel_summary('C05FA8B5YPM', 7);
```

## Related Changes

- **Edge Function Fix**: `slack-channel-sync/index.ts` now includes user cache
- **Text Deduplication**: Messages no longer have duplicated content
- **User Names**: New messages will have `user_display_name` and `user_real_name` populated
