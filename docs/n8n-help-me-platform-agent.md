# n8n Help-Me-Platform Support Agent

Last updated: 2026-01-22

## Purpose

Auto-reply in #help-me-platform with a suggested answer or next step based on historical Slack threads, HubSpot training conversations, and internal KB/Notion docs.

## Workflow

- Name: AI agent support - Slack
- ID: UtsHZSFSpXa6arFN
- URL: https://your-n8n-instance.example.com/workflow/UtsHZSFSpXa6arFN
- Trigger: Slack message.channels in #help-me-platform (channel ID YOUR_SLACK_CHANNEL_ID)
- Reply: Threaded response to the original message

## Node Flow (high level)

Slack Trigger
-> Extract Message
-> Filter Incoming (drops bot messages + thread replies)
-> Issue Classifier (auto-tags subcategory + tags)
-> Prepare AI Input (adds Auto-tag lines to chatInput)
-> AI Agent
-> Slack Formatter
-> Slack Response

## Retrieval Tools Used by the AI Agent

- Supabase Vector Store: rpc/match_documents (KB, Notion, internal docs)
- Supabase Slack Messages: rpc/match_slack_messages (similar Slack messages)
- Supabase Training Conversations: rpc/match_training_conversations (HubSpot support patterns)
- Slack Chronological Query + Reaction Analytics (time-based queries; not primary for support answers)

## Issue Classifier

The Issue Classifier is a lightweight keyword-based pre-tagging step that adds:

- issue_subcategory (one of: App, Invoice, Ordering, Charger offline, Subscription and pricing, Onboarding, Unstable charging, Termination, Hardware failure, Charging, Service, IT / Cloud error, RFID, User error, Other)
- issue_tags (optional: shared-charger, payment-method, refund, helix, ampeco, easee, zaptec)

It also strips common noise from #help-me-platform messages:

- URLs, Slack mentions
- Subteam asset management strings
- Attachment and file-type tokens (png, pdf, etc.)

### Common trigger phrases from #help-me-platform data

These were derived from the Slack export (2021-11-18 to 2026-01-12):

- Onboarding / Activation: "onboard", "activate", "add new subscription", "driver onboarding"
- Cancellation: "cancel", "cancelled", "force cancel", "stuck cancellation"
- Ordering / Installation: "order", "install", "delivery", "work order", "service order"
- Shared charger: "shared charger", "shared subscription", "parking spot"
- Payment / Refunds: "payment card", "payment method", "refund"
- Charging session: "charging session", "active session", "start charging", "stuck cable"
- Hardware: "serial number", "easee", "zaptec", "reset", "sikring"
- App login: "login", "password", "username"

### Output format injected into chatInput

[Auto-tag] Subcategory: <value>
[Auto-tag] Tags: <tag1, tag2>

This is used as a hint for retrieval and response framing. The AI should not treat it as a hard rule.

## Editing the Classifier

Update the code in the n8n node:

- Node name: Issue Classifier
- Workflow: AI agent support - Slack (UtsHZSFSpXa6arFN)

After edits, verify:

- Filter Incoming -> Issue Classifier -> Prepare AI Input remains connected
- Prepare AI Input still prefixes Auto-tag lines
- Bot replies are still threaded

## AI Agent System Prompt Enhancements

The AI Agent includes enhanced guidance sections (added 2026-01-22):

### Resolution-Focused Responses

- Prioritizes threads showing resolution ("fixed", "resolved", "works now")
- Looks for positive reactions (:white_check_mark:, :tada:)
- Structures responses to lead with resolutions when available

### Confidence-Based Handling

| Similarity       | Response Style                                           |
| ---------------- | -------------------------------------------------------- |
| > 0.7 (High)     | Lead with answer, provide detailed steps                 |
| 0.5-0.7 (Medium) | Frame as suggestion, ask one clarifying question         |
| < 0.5 (Low)      | Acknowledge uncertainty, provide general troubleshooting |

### Source Attribution

All responses cite which source the information came from:

- Slack thread: "From a similar thread in #help-me-platform (Jan 2026)..."
- HubSpot ticket: "Based on ticket #12345 resolution..."
- KB/Notion: "According to the [Document Name] guide..."

## Management Scripts

```bash
# Verify workflow configuration
npm run verify:support-workflow

# Enhance system prompt with resolution/confidence guidance
npm run enhance:support-workflow
```

### Verification Checks

The verify script checks 12 aspects:

| Check                          | What It Validates                            |
| ------------------------------ | -------------------------------------------- |
| Workflow Active                | Listening for messages                       |
| Slack Trigger                  | Correct channel (YOUR_SLACK_CHANNEL_ID)                |
| Filter Incoming                | Bot messages and thread replies filtered     |
| Issue Classifier               | Auto-tagging configured                      |
| Memory                         | Thread-based session key                     |
| Search: Documents              | match_documents tool configured              |
| Search: Slack Messages         | match_slack_messages tool configured         |
| Search: Training Conversations | match_training_conversations tool configured |
| AI Agent                       | System prompt completeness                   |
| Slack Formatter                | Markdown to mrkdwn conversion                |
| Slack Response                 | Threading enabled                            |
| Node Connections               | Main flow intact                             |

## Troubleshooting

| Issue              | Solution                                              |
| ------------------ | ----------------------------------------------------- |
| Bot not responding | Run `npm run verify:support-workflow` to check status |
| Wrong formatting   | Check Slack Formatter node, run enhancement script    |
| Missing sources    | Verify Supabase credentials in n8n                    |
| Loop detected      | Check Filter Incoming drops bot_id and thread replies |

## Related Documentation

- [Slack App Setup Guide](./slack-app-setup-help-me-platform.md) - Complete Slack app configuration
- [n8n Agent System Prompt](./n8n-agent-system-prompt.md) - AI agent configuration details
