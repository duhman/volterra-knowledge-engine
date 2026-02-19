/**
 * Fix Extract Message to parse Slack Workflow form blocks
 *
 * Problem: Slack Workflow form submissions store their data in `blocks` (rich_text sections),
 * not in `event.text`. The current Extract Message only looks at `event.text`, which is empty.
 *
 * Solution: Add a "Parse Workflow Form" Code node that extracts text from blocks
 * and places it in a new field, then update Extract Message to use that field.
 */

import { N8nApiClient } from "../services/n8n-api-client.js";

const WORKFLOW_ID = "YOUR_WORKFLOW_ID";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const client = new N8nApiClient();

  console.log(`Fetching workflow ${WORKFLOW_ID}...`);
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  console.log(`Found: ${workflow.name}`);

  // Find the Extract Message node
  const extractMessageNode = workflow.nodes.find(
    (n) => n.name === "Extract Message",
  );
  if (!extractMessageNode) {
    console.error("Could not find Extract Message node");
    process.exit(1);
  }

  // Current chatInput expression only looks at event.text
  console.log("\n=== CURRENT EXTRACT MESSAGE ===");
  const assignments = extractMessageNode.parameters?.assignments?.assignments;
  const chatInputAssignment = assignments?.find(
    (a: { name: string }) => a.name === "chatInput",
  );
  console.log("Current chatInput:", chatInputAssignment?.value);

  // New expression that extracts text from blocks if event.text is empty
  const newChatInputExpression = `={{
// Extract text from Slack message, handling both regular messages and Workflow form submissions
const event = $json.event || $json;
const text = event.text || '';
const blocks = event.blocks || [];

// If we have text, use it (strip @mentions)
if (text.trim()) {
  return text.replace(/<@[A-Z0-9]+>\\s*/g, '').trim();
}

// Otherwise, extract text from blocks (Workflow form submissions)
const extractBlockText = (block) => {
  if (!block) return '';

  // Rich text block
  if (block.type === 'rich_text' && block.elements) {
    return block.elements.map(el => {
      if (el.type === 'rich_text_section' && el.elements) {
        return el.elements.map(e => {
          if (e.type === 'text') return e.text || '';
          if (e.type === 'link') return e.url || '';
          if (e.type === 'user') return ''; // Skip user mentions
          return '';
        }).join('');
      }
      if (el.type === 'rich_text_list' && el.elements) {
        return el.elements.map(item => {
          if (item.elements) {
            return '• ' + item.elements.map(e => e.text || '').join('');
          }
          return '';
        }).join('\\n');
      }
      return '';
    }).join('\\n');
  }

  // Section block with text
  if (block.type === 'section' && block.text?.text) {
    return block.text.text;
  }

  // Context block
  if (block.type === 'context' && block.elements) {
    return block.elements.map(e => e.text || '').join(' ');
  }

  return '';
};

const blockText = blocks.map(extractBlockText).filter(t => t.trim()).join('\\n\\n');
return blockText.replace(/<@[A-Z0-9]+>\\s*/g, '').trim() || 'No message content found';
}}`;

  console.log("\n=== NEW EXTRACT MESSAGE ===");
  console.log("New chatInput will extract from blocks if text is empty");

  if (dryRun) {
    console.log("\n[DRY RUN] Would update chatInput expression");
    console.log("\nNew expression (truncated):");
    console.log(newChatInputExpression.slice(0, 500) + "...");
    return;
  }

  // Update the chatInput assignment
  const updatedAssignments = assignments.map(
    (a: { name: string; id: string; type: string; value: string }) => {
      if (a.name === "chatInput") {
        return {
          ...a,
          value: newChatInputExpression,
        };
      }
      return a;
    },
  );

  // Update the node
  extractMessageNode.parameters.assignments.assignments = updatedAssignments;

  // Filter settings to only allowed keys (n8n API rejects extra properties)
  const allowedSettingsKeys = [
    "executionOrder",
    "errorWorkflow",
    "callerPolicy",
    "saveDataErrorExecution",
    "saveDataSuccessExecution",
    "saveManualExecutions",
    "saveExecutionProgress",
    "timezone",
  ];
  const allowedSettings: Record<string, unknown> = {};
  if (workflow.settings) {
    for (const key of allowedSettingsKeys) {
      if (key in workflow.settings) {
        allowedSettings[key] = (workflow.settings as Record<string, unknown>)[
          key
        ];
      }
    }
  }

  // Update the workflow
  console.log("\nUpdating workflow...");
  await client.updateWorkflow(WORKFLOW_ID, {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: allowedSettings,
  });

  console.log("✓ Extract Message updated to parse Workflow form blocks");
  console.log("\nTest by submitting a form in #help-me-platform");
}

main().catch(console.error);
