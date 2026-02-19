import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  // Get more recent executions with includeData
  const resp = await fetch(apiUrl + "/executions?workflowId=UtsHZSFSpXa6arFN&limit=10&includeData=true", {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const result = await resp.json();
  
  for (const exec of result.data) {
    console.log("\n=== Execution " + exec.id + " (" + exec.status + ") ===");
    
    const runData = exec.data?.resultData?.runData;
    if (!runData) {
      console.log("No run data available");
      continue;
    }
    
    // Check Filter Incoming
    const filterRun = runData["Filter Incoming"]?.[0];
    const filterOutput = filterRun?.data?.main?.[0];
    console.log("Filter output items:", filterOutput?.length || 0);
    
    // If filter blocked everything, show what was blocked
    if (!filterOutput || filterOutput.length === 0) {
      const slackData = runData["Slack Trigger"]?.[0]?.data?.main?.[0]?.[0]?.json;
      if (slackData) {
        const event = slackData.event;
        console.log("  Blocked msg - bot_id:", event?.bot_id);
        console.log("  Blocked msg - user:", event?.user);
        console.log("  Blocked msg - thread_ts:", event?.thread_ts);
        console.log("  Blocked msg - text:", (event?.text || "").slice(0, 80));
      }
    }
    
    // Check if AI Agent ran
    const aiRun = runData["AI Agent"]?.[0];
    if (aiRun) {
      const aiOutput = aiRun.data?.main?.[0];
      console.log("AI Agent output:", aiOutput?.length || 0, "items");
      if (aiRun.error) {
        console.log("AI Agent error:", JSON.stringify(aiRun.error).slice(0, 200));
      }
    }
    
    // Check Slack Response
    const slackResp = runData["Slack Response"]?.[0];
    if (slackResp) {
      console.log("Slack Response ran:", slackResp.error ? "ERROR" : "OK");
      if (slackResp.error) {
        console.log("  Error:", JSON.stringify(slackResp.error).slice(0, 200));
      }
    }
  }
}

main().catch(console.error);
