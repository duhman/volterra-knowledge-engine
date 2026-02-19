import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  // Check error executions to see what's being passed
  for (const execId of ["12883", "12821", "12756"]) {
    const resp = await fetch(apiUrl + "/executions/" + execId + "?includeData=true", {
      headers: { "X-N8N-API-KEY": apiKey }
    });
    const exec = await resp.json();
    
    console.log("\n=== Execution " + execId + " ===");
    
    const runData = exec.data?.resultData?.runData;
    if (!runData) {
      console.log("No run data");
      continue;
    }
    
    // Get raw Slack Trigger output
    const slackOutput = runData["Slack Trigger"]?.[0]?.data?.main?.[0]?.[0]?.json;
    console.log("Slack Trigger output structure:");
    console.log(JSON.stringify(slackOutput, null, 2).slice(0, 1500));
    
    // Get Filter Incoming output
    const filterOutput = runData["Filter Incoming"]?.[0]?.data?.main?.[0]?.[0]?.json;
    console.log("\nFilter Incoming output structure:");
    console.log(JSON.stringify(filterOutput, null, 2).slice(0, 1500));
  }
}

main().catch(console.error);
