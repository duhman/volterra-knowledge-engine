# Setting Up MCP Server Access

This guide covers multiple ways to access the Volterra MCP server across different platforms.

## Option 1: Claude Code (Anthropic CLI)

### Setup

Create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "volterra-kb": {
      "type": "http",
      "url": "https://your-project.supabase.co/functions/v1/mcp-readonly",
      "headers": {
        "Authorization": "Bearer <SUPABASE_CLOUD_ANON_KEY>"
      }
    }
  }
}
```

### Testing

Start Claude Code in your project directory:

```bash
claude
```

Then test with: `"Search for information about Norgespris"`

## Option 2: Claude Desktop (Anthropic Desktop App)

### Setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "volterra-kb": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://your-project.supabase.co/functions/v1/mcp-readonly",
        "--header",
        "Authorization:Bearer <SUPABASE_CLOUD_ANON_KEY>"
      ]
    }
  }
}
```

### Testing

1. Restart Claude Desktop
2. Start a new conversation
3. The MCP tools will be automatically available
4. Test with: `"Search for information about Norgespris"`

## Option 3: OpenAI ChatGPT App/Connector (New App Beta)

### Step 1: Create New App

1. Go to ChatGPT → Click **"+"** → **"New App (Beta)"**
2. Or navigate to Apps section in ChatGPT

### Step 2: Configure MCP Server

1. Fill in the form:
   - **Name:** `Volterra Knowledge Base`
   - **Description:** `Internal read-only access to company knowledge base, support conversations, Slack messages, and WoD deals`
   - **MCP Server URL:** `https://your-project.supabase.co/functions/v1/mcp-readonly`
2. **Authentication:** Select **"No Auth"** from the dropdown
   - ⚠️ **Important:** You'll see an error message: "Error fetching OAuth configuration. MCP server does not implement OAuth."
   - **This is expected and can be ignored** - our server doesn't use OAuth
   - Select **"No Auth"** because we handle authentication via custom headers (see below)
3. **Custom Headers (if available):** Add:
   - **Header Name:** `Authorization`
   - **Header Value:** `Bearer <SUPABASE_CLOUD_ANON_KEY>`
   - Note: If the UI doesn't show custom headers option, OpenAI will pass the Authorization header automatically based on your MCP server's requirements

4. **Security Acknowledgment:**
   - Check the box: **"I understand and want to continue"**
   - Read the warning about custom MCP servers

5. Click **"Create"**

### Step 3: Use in ChatGPT

1. Start a new chat
2. Click the **"+"** button near the message composer
3. Select **"More"** → Choose **"Volterra Knowledge Base"**
4. Test with: `"Search for information about Norgespris"`

## Option 4: Custom GPT (GPT Builder)

### Step 1: Create Custom GPT

1. Go to https://chat.openai.com/gpts
2. Click **"Create"** → **"Create a GPT"**

### Step 2: Configure GPT

1. **Name:** `Volterra Knowledge Assistant`
2. **Description:** `Internal assistant with access to company knowledge base`
3. **Instructions:** Add:
   ```
   You have access to the Volterra knowledge base through MCP tools. Use kb_search to find information, slack_latest_messages for recent Slack activity, and db_table_stats to understand data volume.
   ```

### Step 3: Add MCP Connector

1. Go to **"Configure"** tab
2. Under **"Actions"** → Click **"Create new action"**
3. Select **"MCP"** as the action type
4. Configure:
   - **Server URL:** `https://your-project.supabase.co/functions/v1/mcp-readonly`
   - **Authentication:** Select **"No Auth"**
     - ⚠️ Ignore any OAuth error message - it's expected
     - Add custom header if UI provides option:
       - **Header:** `Authorization`
       - **Value:** `Bearer <SUPABASE_CLOUD_ANON_KEY>`
5. Click **"Save"**

### Step 4: Publish

1. Click **"Save"** → Choose visibility:
   - **Only me** (for personal use)
   - **Only people with link** (for team sharing)
   - **Your organization** (if on team plan)

## Option 5: Responses API (Programmatic)

### Python Example

```python
from openai import OpenAI

client = OpenAI()

response = client.responses.create(
    model="gpt-4o",
    input="Search for Norgespris charging price information",
    tools=[{
        "type": "mcp",
        "server_url": "https://your-project.supabase.co/functions/v1/mcp-readonly",
        "headers": {
            "Authorization": "Bearer <SUPABASE_CLOUD_ANON_KEY>"
        },
        "require_approval": "always"  # Require explicit approval for tool calls
    }]
)

print(response.output)
```

### Node.js Example

```javascript
import OpenAI from "openai";

const openai = new OpenAI();

const response = await openai.responses.create({
  model: "gpt-4o",
  input: "Search for Norgespris charging price information",
  tools: [
    {
      type: "mcp",
      server_url:
        "https://your-project.supabase.co/functions/v1/mcp-readonly",
      headers: {
        Authorization: "Bearer <SUPABASE_CLOUD_ANON_KEY>",
      },
      require_approval: "always",
    },
  ],
});

console.log(response.output);
```

## Verification

### Test the Connection

```bash
# Test tools/list
curl -X POST "https://your-project.supabase.co/functions/v1/mcp-readonly" \
  -H "Authorization: Bearer <SUPABASE_CLOUD_ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected response: JSON with 5 tools listed.

## Security Notes

### IP Allowlisting (Production)

For production use, enable IP allowlisting:

1. Self-host: set `ENFORCE_IP_ALLOWLIST=true` for the Functions container env (see `docker-compose.yml` in your self-host stack)
2. Restart functions: `cd /root/supabase/docker && docker compose up -d functions`
3. Configure WAF/CDN to allow only OpenAI egress IPs (see `.cursor/rules/internal-mcp-readonly.mdc`)

### Approval Settings

- **`require_approval: "always"`** - User must approve each tool call (recommended for initial rollout)
- **`require_approval: "never"`** - Automatic tool calls (only if you trust the tools completely)

## Authentication Options Explained

When setting up the MCP server, you'll see three authentication options:

1. **"OAuth"** - ❌ Don't use this. Our server doesn't implement OAuth.
2. **"No Auth"** - ✅ **Use this option.** This means OpenAI won't try to authenticate via OAuth, but you can still pass custom headers (like our Authorization header with the Supabase anon key).
3. **"Mixed"** - Don't use this unless you have some endpoints that need OAuth and others that don't.

**Expected Error:** You'll see: "Error fetching OAuth configuration. MCP server does not implement OAuth." This is **normal and can be ignored** - just select "No Auth" and continue.

## Troubleshooting

### "401 Unauthorized" Error (self-host)

**Root cause:** JWT verification enabled in the self-host Edge Runtime.

**Fix:** Set `FUNCTIONS_VERIFY_JWT=false` in your self-host Supabase `.env` (the one next to `docker-compose.yml`), then restart the functions container:

```bash
cd /root/supabase/docker
docker compose up -d functions
```

Self-host functions server details: [Supabase self-hosting functions docs](https://supabase.com/docs/reference/self-hosting-functions/introduction).

### "Error fetching OAuth configuration" message

- ✅ **This is expected** - our server doesn't implement OAuth
- Select **"No Auth"** from the authentication dropdown
- The error will disappear after selecting "No Auth"

### "Connector not found" or "Failed to connect"

- Verify the endpoint URL is accessible
- **Ensure JWT verification is disabled** (see above)
- Check Authorization header format (must include `Bearer ` prefix)
- Ensure Developer Mode is enabled (for ChatGPT Connector)

### "Invalid JWT" error

- Verify the anon key is correct
- Check that the key hasn't been rotated in Supabase

### Tools not appearing

- Wait a few seconds after creating connector
- Refresh ChatGPT/GPT Builder
- Check Supabase Edge Function logs for errors

### No search results

- Verify embeddings exist in the database
- Check match threshold (default 0.5)
- Review Edge Function logs for RPC errors
