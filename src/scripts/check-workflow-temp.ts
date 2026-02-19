import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

if (!apiKey) {
  console.error("N8N_API_KEY not set");
  process.exit(1);
}

async function main() {
  const response = await fetch(`${apiUrl}/workflows/UtsHZSFSpXa6arFN`, {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const workflow = await response.json();
  
  const filterNode = workflow.nodes.find((n: any) => n.name === "Filter Incoming");
  console.log("=== Filter Incoming Node ===");
  console.log(JSON.stringify(filterNode, null, 2));
  
  const slackTrigger = workflow.nodes.find((n: any) => n.type === "n8n-nodes-base.slackTrigger");
  console.log("\n=== Slack Trigger Node ===");
  console.log(JSON.stringify(slackTrigger, null, 2));
  
  // Get connections to see the flow
  console.log("\n=== Connections from Slack Trigger ===");
  console.log(JSON.stringify(workflow.connections["Slack Trigger"], null, 2));
}

main().catch(console.error);
