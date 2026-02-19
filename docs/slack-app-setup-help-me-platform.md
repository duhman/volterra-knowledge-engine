# Slack App Setup for #help-me-platform Support Bot

Last updated: 2026-01-22

## Overview

This guide covers the complete Slack app configuration required for the #help-me-platform auto-response workflow (`UtsHZSFSpXa6arFN`).

| Property           | Value                                |
| ------------------ | ------------------------------------ |
| **Workflow**       | AI agent support - Slack             |
| **Workflow ID**    | `UtsHZSFSpXa6arFN`                   |
| **Channel**        | #help-me-platform                    |
| **Channel ID**     | `C05FA8B5YPM`                        |
| **n8n Credential** | Slack account 2 (`oPHUpwxSDypu5PnU`) |

## Prerequisites

- Admin access to your Slack workspace
- Access to n8n instance at `https://your-n8n-instance.example.com`
- n8n API key (for workflow management)

## Step 1: Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Select **From scratch**
4. Configure:
   - **App Name**: `Volterra Support Bot` (or your preferred name)
   - **Workspace**: Select your Volterra workspace
5. Click **Create App**

## Step 2: Configure OAuth & Permissions

Navigate to **OAuth & Permissions** in the left sidebar.

### Bot Token Scopes

Scroll to **Scopes** → **Bot Token Scopes** and add:

| Scope              | Purpose                                 | Required    |
| ------------------ | --------------------------------------- | ----------- |
| `channels:history` | Read message history in public channels | Yes         |
| `channels:read`    | View basic channel information          | Yes         |
| `chat:write`       | Send messages as the bot                | Yes         |
| `users:read`       | Resolve user IDs to display names       | Recommended |

### User Token Scopes (Optional)

Only needed if accessing private channels or user-specific data:

| Scope              | Purpose                      |
| ------------------ | ---------------------------- |
| `channels:history` | Read private channel history |

## Step 3: Enable Event Subscriptions

Navigate to **Event Subscriptions** in the left sidebar.

### Enable Events

1. Toggle **Enable Events** to **On**

### Request URL

Set the Request URL to your n8n webhook endpoint:

```
https://your-n8n-instance.example.com/webhook/4cb2ed70-325b-4b45-9da9-76fd71d88f81
```

Slack will send a verification challenge. The n8n Slack Trigger node handles this automatically when the workflow is active.

### Subscribe to Bot Events

Under **Subscribe to bot events**, add:

| Event Name         | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `message.channels` | Triggers when a message is posted to a public channel |

Click **Save Changes**.

## Step 4: Install App to Workspace

1. Navigate to **Install App** in the left sidebar
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

Store this token securely - you'll need it for n8n.

## Step 5: Configure n8n Credential

### In n8n UI

1. Go to **Settings** → **Credentials**
2. Find or create a **Slack API** credential
3. Configure:

| Field               | Value                                      |
| ------------------- | ------------------------------------------ |
| **Credential Name** | `Slack account 2` (or your preferred name) |
| **Access Token**    | `xoxb-your-bot-token-here`                 |

4. Click **Save**

### Verify Credential

Test the credential by:

1. Opening the workflow `UtsHZSFSpXa6arFN`
2. Clicking on the **Slack Trigger** node
3. Confirming the credential shows as connected

## Step 6: Invite Bot to Channel

The bot must be a member of #help-me-platform to receive messages.

### Option A: Slash Command

In Slack, type in any channel:

```
/invite @Volterra Support Bot
```

### Option B: Channel Settings

1. Open #help-me-platform
2. Click the channel name to open settings
3. Go to **Integrations** tab
4. Click **Add apps**
5. Find and add your bot

### Option C: Direct Message

Send a message to the bot first, then it can be invited to channels.

## Step 7: Verify Webhook Registration

After enabling events and setting the Request URL:

1. Ensure the n8n workflow is **Active**
2. In Slack App settings → Event Subscriptions, the Request URL should show **Verified**
3. If not verified:
   - Check the workflow is active
   - Check the webhook URL is correct
   - Review n8n execution logs for errors

## Step 8: Test the Integration

### Post a Test Message

In #help-me-platform, post a message:

```
Test message - how do I reset my charger?
```

### Expected Behavior

1. Slack sends event to n8n webhook
2. n8n workflow triggers
3. Filter Incoming passes the message (not a bot, not a thread reply)
4. Issue Classifier tags: `subcategory: Hardware failure`
5. AI Agent searches knowledge base
6. Response posted as a **thread reply** to the original message

### Verify in n8n

1. Go to **Executions** in n8n
2. Filter by workflow `UtsHZSFSpXa6arFN`
3. Check the latest execution succeeded

## Workflow Node Configuration Reference

### Slack Trigger Node

```json
{
  "parameters": {
    "trigger": ["message.channels"],
    "channelId": {
      "value": "C05FA8B5YPM",
      "mode": "id"
    }
  },
  "credentials": {
    "slackApi": {
      "id": "oPHUpwxSDypu5PnU",
      "name": "Slack account 2"
    }
  }
}
```

### Slack Response Node

```json
{
  "parameters": {
    "select": "channel",
    "channelId": {
      "value": "={{ $('Extract Message').item.json.channel }}",
      "mode": "id"
    },
    "text": "={{ $json.output || $json.text || 'I could not process your request.' }}",
    "otherOptions": {
      "includeLinkToWorkflow": false,
      "thread_ts": {
        "replyValues": {
          "thread_ts": "={{ $('Extract Message').item.json.reply_thread_ts }}"
        }
      }
    }
  },
  "credentials": {
    "slackApi": {
      "id": "oPHUpwxSDypu5PnU",
      "name": "Slack account 2"
    }
  }
}
```

## Troubleshooting

### Bot Not Responding

| Symptom               | Cause                | Solution                         |
| --------------------- | -------------------- | -------------------------------- |
| No response at all    | Workflow inactive    | Activate workflow in n8n         |
| No response at all    | Bot not in channel   | Invite bot to #help-me-platform  |
| No response at all    | Webhook not verified | Check Event Subscriptions URL    |
| Response not threaded | Missing thread_ts    | Check Slack Response node config |

### Verification Errors

| Error                     | Solution                                       |
| ------------------------- | ---------------------------------------------- |
| `url_verification_failed` | Ensure workflow is active before setting URL   |
| `invalid_token`           | Regenerate bot token and update n8n credential |
| `missing_scope`           | Add required scopes and reinstall app          |

### Message Loop (Bot Responds to Itself)

The workflow includes a **Filter Incoming** node that prevents this:

```javascript
// Drops bot messages and thread replies
const isBot = Boolean(event.bot_id) || subtype === "bot_message";
const isThreadReply = Boolean(event.thread_ts) && event.thread_ts !== event.ts;
return !isBot && !isThreadReply;
```

If loops occur:

1. Check Filter Incoming node is connected
2. Verify the filter code is intact
3. Run `npm run verify:support-workflow` to check

### Run Verification Script

```bash
npm run verify:support-workflow
```

This checks 12 aspects of the workflow configuration including Slack trigger setup.

## Security Considerations

### Token Storage

- Store bot tokens in n8n credentials (encrypted)
- Never commit tokens to version control
- Use environment variables for automation scripts

### Channel Restrictions

The workflow only listens to `C05FA8B5YPM` (#help-me-platform). To add more channels:

1. Update the Slack Trigger node's `channelId` parameter
2. Or use `channels:read` scope with dynamic channel selection

### Rate Limits

Slack API rate limits:

- Posting messages: ~1 per second per channel
- Reading history: ~50 requests per minute

The workflow handles single messages, so rate limits are rarely hit.

## Appendix: Complete Scope Reference

### Minimum Required (Current Setup)

| Scope              | Type | Purpose               |
| ------------------ | ---- | --------------------- |
| `channels:history` | Bot  | Read channel messages |
| `channels:read`    | Bot  | Get channel info      |
| `chat:write`       | Bot  | Post responses        |

### Recommended Additions

| Scope            | Type | Purpose                                |
| ---------------- | ---- | -------------------------------------- |
| `users:read`     | Bot  | Resolve user display names             |
| `reactions:read` | Bot  | Read message reactions (for analytics) |
| `files:read`     | Bot  | Access file attachments                |

### For Private Channels

| Scope            | Type | Purpose                       |
| ---------------- | ---- | ----------------------------- |
| `groups:history` | Bot  | Read private channel messages |
| `groups:read`    | Bot  | Get private channel info      |

## Related Documentation

- [n8n Help-Me-Platform Agent](./n8n-help-me-platform-agent.md) - Workflow documentation
- [n8n Agent System Prompt](./n8n-agent-system-prompt.md) - AI agent configuration
- [Slack API Documentation](https://api.slack.com/apis) - Official Slack docs
