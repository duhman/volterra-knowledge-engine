import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  const response = await fetch(apiUrl + "/executions/12883", {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const detail = await response.json();
  
  console.log("Status:", detail.status);
  
  const runData = detail.data?.resultData?.runData;
  if (runData) {
    console.log("\n=== Node Run Summary ===");
    for (const nodeName of Object.keys(runData)) {
      const runs = runData[nodeName];
      for (const run of runs) {
        if (run.error) {
          console.log(nodeName + ": ERROR");
          console.log(JSON.stringify(run.error, null, 2));
        } else {
          const outputItems = run.data?.main?.[0]?.length || 0;
          console.log(nodeName + ": " + outputItems + " items");
        }
      }
    }
  }
  
  // Check input message
  const slackData = runData?.["Slack Trigger"]?.[0]?.data?.main?.[0]?.[0]?.json;
  if (slackData) {
    console.log("\n=== Input Message ===");
    console.log("Channel:", slackData.event?.channel);
    console.log("User:", slackData.event?.user);
    console.log("Bot ID:", slackData.event?.bot_id);
    console.log("Text:", (slackData.event?.text || "").slice(0, 100));
  }
}

main().catch(console.error);
