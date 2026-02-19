/**
 * Get Slack webhook URL for the workflow
 */

import { N8nApiClient } from '../services/n8n-api-client.js';

const WORKFLOW_ID = 'c4tHYJcGwSaDAA6c';

async function main() {
  const client = new N8nApiClient();
  const workflow = await client.getWorkflow(WORKFLOW_ID);
  
  const slackTrigger = workflow.nodes.find(n => n.name === 'Slack Trigger');
  
  console.log('=== SLACK TRIGGER DETAILS ===');
  console.log('Node ID:', slackTrigger?.id);
  console.log('Type:', slackTrigger?.type);
  console.log('Type Version:', slackTrigger?.typeVersion);
  console.log('Parameters:', JSON.stringify(slackTrigger?.parameters, null, 2));
  console.log('Credentials:', JSON.stringify(slackTrigger?.credentials, null, 2));
  console.log('');
  console.log('=== WEBHOOK URLS (based on n8n documentation) ===');
  console.log('Production Webhook URL:');
  console.log(`  https://your-n8n-instance.example.com/webhook/${WORKFLOW_ID}/slack`);
  console.log('');
  console.log('Alternative formats:');
  console.log(`  https://your-n8n-instance.example.com/webhook-waiting/${WORKFLOW_ID}`);
  console.log(`  https://your-n8n-instance.example.com/webhook/${slackTrigger?.id}`);
  console.log('');
  console.log('=== REQUIRED SLACK CONFIGURATION ===');
  console.log('1. Go to https://api.slack.com/apps');
  console.log('2. Select your ElaBot app');
  console.log('3. Go to "Event Subscriptions"');
  console.log('4. Enable Events: ON');
  console.log('5. Request URL: paste the webhook URL above');
  console.log('6. Subscribe to bot events: app_mention');
  console.log('7. Go to "OAuth & Permissions"');
  console.log('8. Required scopes: app_mentions:read, chat:write, channels:history, channels:read');
  console.log('9. Reinstall app to workspace if scopes changed');
  console.log('10. Invite bot to channel: /invite @ElaBot');
}

main().catch(console.error);
