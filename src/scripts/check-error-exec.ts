import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  // Get error execution 12883 with data
  const resp = await fetch(apiUrl + "/executions/12883?includeData=true", {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const exec = await resp.json();
  
  console.log("=== Error Execution 12883 ===");
  
  const runData = exec.data?.resultData?.runData;
  if (!runData) {
    console.log("No run data");
    return;
  }
  
  // Show each node that ran
  for (const nodeName of Object.keys(runData)) {
    const runs = runData[nodeName];
    for (const run of runs) {
      const outputCount = run.data?.main?.[0]?.length || 0;
      const hasError = !!run.error;
      console.log(nodeName + ":", outputCount, "items", hasError ? "- ERROR" : "");
      if (hasError) {
        console.log("  Error:", run.error.message || JSON.stringify(run.error).slice(0, 300));
      }
    }
  }
  
  // Check the lastNodeExecuted
  console.log("\nLast node executed:", exec.data?.resultData?.lastNodeExecuted);
  console.log("Main error:", exec.data?.resultData?.error?.message);
  
  // Show the input message that passed the filter
  const filterOutput = runData["Filter Incoming"]?.[0]?.data?.main?.[0]?.[0]?.json;
  if (filterOutput) {
    const event = filterOutput.event;
    console.log("\n=== Message that passed filter ===");
    console.log("Channel:", event?.channel);
    console.log("User:", event?.user);
    console.log("Bot ID:", event?.bot_id);
    console.log("Text:", (event?.text || "").slice(0, 150));
  }
}

main().catch(console.error);
