import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  // Check error execution
  console.log("=== Error Execution 12883 ===");
  const errResp = await fetch(apiUrl + "/executions/12883", {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const errDetail = await errResp.json();
  console.log("Keys:", Object.keys(errDetail));
  console.log("Data keys:", Object.keys(errDetail.data || {}));
  console.log("ResultData:", JSON.stringify(errDetail.data?.resultData, null, 2).slice(0, 1000));
  
  // Check success execution
  console.log("\n=== Success Execution 12912 ===");
  const okResp = await fetch(apiUrl + "/executions/12912", {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const okDetail = await okResp.json();
  const runData = okDetail.data?.resultData?.runData;
  if (runData) {
    for (const nodeName of Object.keys(runData)) {
      const runs = runData[nodeName];
      for (const run of runs) {
        const outputItems = run.data?.main?.[0]?.length || 0;
        console.log(nodeName + ": " + outputItems + " items");
      }
    }
    
    // Check input
    const slackData = runData["Slack Trigger"]?.[0]?.data?.main?.[0]?.[0]?.json;
    if (slackData) {
      console.log("\nInput - Channel:", slackData.event?.channel);
      console.log("Input - Bot ID:", slackData.event?.bot_id);
      console.log("Input - User:", slackData.event?.user);
    }
    
    // Check Filter output
    const filterOut = runData["Filter Incoming"]?.[0]?.data?.main?.[0]?.[0]?.json;
    if (filterOut) {
      console.log("\nFilter passed - Channel:", filterOut.event?.channel);
    }
  }
}

main().catch(console.error);
