import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  const resp = await fetch(apiUrl + "/executions/12883?includeData=true", {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const exec = await resp.json();
  
  const runData = exec.data?.resultData?.runData;
  const slackOutput = runData?.["Slack Trigger"]?.[0]?.data?.main?.[0]?.[0]?.json;
  
  console.log("=== Full Slack Trigger Output ===");
  console.log("Top-level keys:", Object.keys(slackOutput || {}));
  console.log("\nFull output:");
  console.log(JSON.stringify(slackOutput, null, 2));
}

main().catch(console.error);
