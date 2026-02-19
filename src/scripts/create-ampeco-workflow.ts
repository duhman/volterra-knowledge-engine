#!/usr/bin/env node
/**
 * Create Ampeco Changelog Monitor n8n Workflow
 *
 * Replaces the failing Edge Function with an n8n workflow that provides:
 * - Better visibility via execution history
 * - Multiple version detection patterns for robustness
 * - Error notifications on failure
 * - Same Supabase state table for continuity
 */

import "dotenv/config";
import { N8nApiClient } from "../services/n8n-api-client.js";
import type {
  WorkflowCreate,
  WorkflowNode,
  WorkflowConnections,
} from "../types/n8n.js";

const WORKFLOW_NAME = "Ampeco Changelog Monitor";
const SLACK_CHANNEL_ID = process.env.AMPECO_SLACK_CHANNEL_ID || "C08S1LE377U"; // #test-automation

// Node positions (visual layout in n8n editor)
const positions = {
  scheduleTrigger: [0, 0] as [number, number],
  fetchChangelog: [220, 0] as [number, number],
  parseVersion: [440, 0] as [number, number],
  checkLastVersion: [660, 0] as [number, number],
  ifNewVersion: [880, 0] as [number, number],
  fetchDetails: [1100, -100] as [number, number],
  parseDetails: [1320, -100] as [number, number],
  buildSlackMessage: [1540, -100] as [number, number],
  postToSlack: [1760, -100] as [number, number],
  updateState: [1980, -100] as [number, number],
  noChangeEnd: [1100, 100] as [number, number],
};

// JavaScript code for version parsing with multiple fallback patterns
const parseVersionCode = `
// Try multiple patterns for robustness
const html = $input.item.json.data;
const patterns = [
  // Primary: URL path pattern
  /release-notes-public-api-of-ampeco-charge-(\\d+)/i,
  // Fallback 1: Version in text (v3.XXX.Y format)
  /AMPECO\\s+Charge\\s+3\\.(\\d+)/i,
  // Fallback 2: Version number standalone
  /Public API.*3\\.(\\d+)/i,
];

let version = null;
let matchedPattern = null;

for (let i = 0; i < patterns.length; i++) {
  const match = html.match(patterns[i]);
  if (match && match[1]) {
    version = match[1];
    matchedPattern = i;
    break;
  }
}

if (!version) {
  throw new Error('Could not extract version from changelog. HTML structure may have changed.');
}

return { version, matchedPattern, timestamp: new Date().toISOString() };
`;

// JavaScript code for parsing features and improvements
const parseDetailsCode = `
const html = $input.item.json.data;
const version = $('Parse Version').item.json.version;

// Extract title
const titleMatch = html.match(/<h1[^>]*>([^<]+)<\\/h1>/i);
const title = titleMatch ? titleMatch[1].trim() : \`Release Notes: AMPECO Charge 3.\${version}\`;

// Extract author (look for "by Name" pattern)
const authorMatch = html.match(/by\\s+([A-Z][a-z]+\\s+[A-Z][a-z]+)/i);
const author = authorMatch ? authorMatch[1] : 'Ampeco Team';

// Extract timestamp (relative time like "2 days ago")
const timeMatch = html.match(/(\\d+\\s+(?:hours?|days?|weeks?)\\s+ago|about\\s+\\d+\\s+(?:hours?|days?))/i);
const publishedAt = timeMatch ? timeMatch[0] : 'Recently';

// Filter function for valid content lines
function isValidLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 20) return false;
  if (/^(✨|New Features|🔧|Improvements|Terms|Jump to|Home|Guides|API Reference|Changelog)/i.test(trimmed)) return false;
  if (/^(var\\s|const\\s|let\\s|\\[\\d+,|\\{|\\}|\\]|;$|namedChunks)/.test(trimmed)) return false;
  if (/^\\[?\\d+[,\\d\\s]+/.test(trimmed)) return false;
  if (!/^(Add|Change|Fix|Update|Remove|Deprecate|[A-Z])/.test(trimmed)) return false;
  return true;
}

// Extract features and improvements
const features = [];
const improvements = [];
const sections = html.split(/(?=✨|🔧)/);

for (const section of sections) {
  const isFeature = section.includes('✨') || section.includes('New Features');
  const isImprovement = section.includes('🔧') || section.includes('Improvements');

  // Extract text content, strip HTML tags
  const textContent = section.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ');
  const lines = textContent.split(/[.\\n]/).filter(isValidLine);

  lines.slice(0, 5).forEach(line => {
    const cleaned = line.trim();
    if (cleaned) {
      if (isFeature && !features.includes(cleaned)) {
        features.push(cleaned);
      } else if (isImprovement && !improvements.includes(cleaned)) {
        improvements.push(cleaned);
      }
    }
  });
}

return {
  version,
  title,
  author,
  publishedAt,
  features: features.slice(0, 5),
  improvements: improvements.slice(0, 5),
  detailUrl: \`https://developers.ampeco.com/changelog/release-notes-public-api-of-ampeco-charge-\${version}\`
};
`;

// JavaScript code for building Slack Block Kit message
const buildSlackMessageCode = `
const data = $input.item.json;

// Format features with code highlighting
function formatItem(text) {
  return text
    .replace(/\\b([a-z][a-zA-Z0-9_]*(?:Id|Type|Key|Token|Name|Status|Config|Data|Info|Property|Endpoint|Resource|Request|Response|Enabled))\\b/g, '\\\`$1\\\`')
    .replace(/\\/[a-z0-9\\-\\/\\.]+/gi, '\\\`$&\\\`')
    .replace(/\\b(true|false|null)\\b/g, '\\\`$1\\\`');
}

const blocks = [
  {
    type: 'header',
    text: { type: 'plain_text', text: '🚀 Ampeco API Update', emoji: true }
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: \`*\${data.title}*\\n📅 \${data.publishedAt}  •  👤 by \${data.author}\`
    }
  },
  { type: 'divider' }
];

// Add features section
if (data.features.length > 0) {
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*✨ New Features*' }
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '• ' + data.features.map(formatItem).join('\\n\\n• ')
    }
  });
  blocks.push({ type: 'divider' });
}

// Add improvements section
if (data.improvements.length > 0) {
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*🔧 Improvements*' }
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '• ' + data.improvements.map(formatItem).join('\\n\\n• ')
    }
  });
  blocks.push({ type: 'divider' });
}

// Add action buttons
blocks.push({
  type: 'actions',
  elements: [
    {
      type: 'button',
      text: { type: 'plain_text', text: '📖 View Full Release Notes', emoji: true },
      url: data.detailUrl,
      style: 'primary'
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: '📚 API Documentation', emoji: true },
      url: 'https://developers.ampeco.com/'
    }
  ]
});

// Add footer
blocks.push({
  type: 'context',
  elements: [
    {
      type: 'mrkdwn',
      text: \`🔔 Version: \\\`v3.\${data.version}\\\` | 🤖 Auto-posted by Ampeco Monitor (n8n)\`
    }
  ]
});

return {
  channel: '${SLACK_CHANNEL_ID}',
  text: \`🚀 Ampeco API Update: \${data.title}\`,
  blocks,
  unfurl_links: false,
  unfurl_media: false
};
`;

function createNodes(): WorkflowNode[] {
  return [
    // 1. Schedule Trigger - Daily at 12:00 UTC
    {
      id: "schedule-trigger",
      name: "Schedule Trigger",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: positions.scheduleTrigger,
      parameters: {
        rule: {
          interval: [
            {
              field: "cronExpression",
              expression: "0 12 * * *",
            },
          ],
        },
      },
    },

    // 2. HTTP Request - Fetch Changelog Page
    {
      id: "fetch-changelog",
      name: "Fetch Changelog",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: positions.fetchChangelog,
      parameters: {
        url: "https://developers.ampeco.com/changelog",
        method: "GET",
        options: {
          response: {
            response: {
              responseFormat: "text",
            },
          },
        },
      },
    },

    // 3. Code - Parse Version with Multiple Patterns
    {
      id: "parse-version",
      name: "Parse Version",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: positions.parseVersion,
      parameters: {
        jsCode: parseVersionCode,
        mode: "runOnceForAllItems",
      },
    },

    // 4. Supabase - Check Last Notified Version
    {
      id: "check-last-version",
      name: "Check Last Version",
      type: "n8n-nodes-base.supabase",
      typeVersion: 1,
      position: positions.checkLastVersion,
      parameters: {
        operation: "getAll",
        tableId: "ampeco_changelog_state",
        returnAll: false,
        limit: 1,
        filterType: "string",
        filterString: "id=eq.1",
      },
      credentials: {
        supabaseApi: {
          id: "YOUR_WORKFLOW_ID",
          name: "Supabase account 2",
        },
      },
    },

    // 5. IF - Check if New Version
    {
      id: "if-new-version",
      name: "New Version?",
      type: "n8n-nodes-base.if",
      typeVersion: 2,
      position: positions.ifNewVersion,
      parameters: {
        conditions: {
          options: {
            leftValue: "",
            caseSensitive: true,
            typeValidation: "strict",
          },
          combinator: "and",
          conditions: [
            {
              id: "version-check",
              leftValue: "={{ $('Parse Version').item.json.version }}",
              rightValue:
                "={{ $('Check Last Version').item.json.last_seen_version }}",
              operator: {
                type: "string",
                operation: "notEquals",
              },
            },
          ],
        },
      },
    },

    // 6. HTTP Request - Fetch Detailed Changelog (on new version)
    {
      id: "fetch-details",
      name: "Fetch Details",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: positions.fetchDetails,
      parameters: {
        url: "=https://developers.ampeco.com/changelog/release-notes-public-api-of-ampeco-charge-{{ $('Parse Version').item.json.version }}",
        method: "GET",
        options: {
          response: {
            response: {
              responseFormat: "text",
            },
          },
        },
      },
    },

    // 7. Code - Parse Features/Improvements
    {
      id: "parse-details",
      name: "Parse Details",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: positions.parseDetails,
      parameters: {
        jsCode: parseDetailsCode,
        mode: "runOnceForAllItems",
      },
    },

    // 8. Code - Build Slack Block Kit Message
    {
      id: "build-slack-message",
      name: "Build Slack Message",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: positions.buildSlackMessage,
      parameters: {
        jsCode: buildSlackMessageCode,
        mode: "runOnceForAllItems",
      },
    },

    // 9. Slack - Post Message
    {
      id: "post-to-slack",
      name: "Post to Slack",
      type: "n8n-nodes-base.slack",
      typeVersion: 2.2,
      position: positions.postToSlack,
      parameters: {
        operation: "post",
        channel: {
          __rl: true,
          value: SLACK_CHANNEL_ID,
          mode: "id",
        },
        text: "={{ $json.text }}",
        blocksUi: "={{ $json.blocks }}",
        otherOptions: {
          unfurl_links: false,
          unfurl_media: false,
        },
      },
      credentials: {
        slackApi: {
          id: "YOUR_WORKFLOW_ID",
          name: "Slack account 2",
        },
      },
    },

    // 10. Supabase - Update State
    {
      id: "update-state",
      name: "Update State",
      type: "n8n-nodes-base.supabase",
      typeVersion: 1,
      position: positions.updateState,
      parameters: {
        operation: "update",
        tableId: "ampeco_changelog_state",
        filterType: "string",
        filterString: "id=eq.1",
        fieldsUi: {
          fieldValues: [
            {
              fieldName: "last_seen_version",
              fieldValue: "={{ $('Parse Version').item.json.version }}",
            },
            {
              fieldName: "last_notified_at",
              fieldValue: "={{ new Date().toISOString() }}",
            },
            {
              fieldName: "last_checked_at",
              fieldValue: "={{ new Date().toISOString() }}",
            },
          ],
        },
      },
      credentials: {
        supabaseApi: {
          id: "YOUR_WORKFLOW_ID",
          name: "Supabase account 2",
        },
      },
    },

    // 11. No-Op End Node (when no new version)
    {
      id: "no-change-end",
      name: "No New Version",
      type: "n8n-nodes-base.noOp",
      typeVersion: 1,
      position: positions.noChangeEnd,
      parameters: {},
    },
  ];
}

function createConnections(): WorkflowConnections {
  return {
    "Schedule Trigger": {
      main: [[{ node: "Fetch Changelog", type: "main", index: 0 }]],
    },
    "Fetch Changelog": {
      main: [[{ node: "Parse Version", type: "main", index: 0 }]],
    },
    "Parse Version": {
      main: [[{ node: "Check Last Version", type: "main", index: 0 }]],
    },
    "Check Last Version": {
      main: [[{ node: "New Version?", type: "main", index: 0 }]],
    },
    "New Version?": {
      main: [
        // True branch (index 0) - new version found
        [{ node: "Fetch Details", type: "main", index: 0 }],
        // False branch (index 1) - no new version
        [{ node: "No New Version", type: "main", index: 0 }],
      ],
    },
    "Fetch Details": {
      main: [[{ node: "Parse Details", type: "main", index: 0 }]],
    },
    "Parse Details": {
      main: [[{ node: "Build Slack Message", type: "main", index: 0 }]],
    },
    "Build Slack Message": {
      main: [[{ node: "Post to Slack", type: "main", index: 0 }]],
    },
    "Post to Slack": {
      main: [[{ node: "Update State", type: "main", index: 0 }]],
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const activate = args.includes("--activate");
  const resetState = args.includes("--reset-state");

  const client = new N8nApiClient();

  console.log("\n=== Ampeco Changelog Monitor - n8n Workflow ===\n");

  // Check for existing workflow
  const existingWorkflows = await client.getWorkflows({ name: WORKFLOW_NAME });
  const existing = existingWorkflows.find((w) => w.name === WORKFLOW_NAME);

  if (existing) {
    console.log(`Found existing workflow: ${existing.id}`);
    console.log(`  Active: ${existing.active}`);
    console.log(`  Updated: ${existing.updatedAt}`);
    console.log(
      "\nUse 'npm run n8n delete <id>' to remove first, or update manually.\n",
    );

    if (!dryRun && args.includes("--force")) {
      console.log("Deleting existing workflow...");
      await client.deleteWorkflow(existing.id);
    } else {
      process.exit(0);
    }
  }

  const workflow: WorkflowCreate = {
    name: WORKFLOW_NAME,
    nodes: createNodes(),
    connections: createConnections(),
    settings: {
      executionOrder: "v1",
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "all",
      saveManualExecutions: true,
      timezone: "UTC",
    },
  };

  if (dryRun) {
    console.log("DRY RUN - Workflow definition:\n");
    console.log(JSON.stringify(workflow, null, 2));
    console.log("\n\nUse without --dry-run to create the workflow.\n");
    return;
  }

  console.log("Creating workflow...");
  const created = await client.createWorkflow(workflow);
  console.log(`\nWorkflow created!`);
  console.log(`  ID: ${created.id}`);
  console.log(`  Name: ${created.name}`);
  console.log(`  Active: ${created.active}`);
  console.log(`  Nodes: ${created.nodes.length}`);

  if (activate) {
    console.log("\nActivating workflow...");
    await client.activateWorkflow(created.id);
    console.log("Workflow activated!");
  }

  console.log("\n=== Next Steps ===");
  console.log("1. Open n8n GUI and verify the workflow");
  console.log("2. Test manually by clicking 'Execute Workflow'");
  console.log("3. Activate via: npm run n8n activate " + created.id);
  console.log("4. Disable old pg_cron job:");
  console.log("   SELECT cron.unschedule('ampeco-changelog-monitor');");
  console.log();

  if (resetState) {
    console.log("Note: Use SQL to reset state for testing:");
    console.log(
      "   UPDATE ampeco_changelog_state SET last_seen_version = '31150' WHERE id = 1;",
    );
    console.log();
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
