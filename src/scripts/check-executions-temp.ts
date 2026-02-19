import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  // Get recent executions
  const response = await fetch(`${apiUrl}/executions?workflowId=YOUR_WORKFLOW_ID&limit=5`, {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const result = await response.json();
  
  for (const exec of result.data) {
    console.log(`\n=== Execution ${exec.id} (${exec.status}) ===`);
    console.log(`Finished: ${exec.stoppedAt}`);
    
    // Get execution details
    const detailResponse = await fetch(`${apiUrl}/executions/${exec.id}`, {
      headers: { "X-N8N-API-KEY": apiKey }
    });
    const detail = await detailResponse.json();
    
    // Check what went through Filter Incoming
    const filterData = detail.data?.resultData?.runData?.["Filter Incoming"];
    if (filterData) {
      const output = filterData[0]?.data?.main?.[0];
      console.log("Filter output items:", output?.length || 0);
      if (output?.length === 0) {
        // Check input to see what was filtered
        const slackData = detail.data?.resultData?.runData?.["Slack Trigger"];
        const input = slackData?.[0]?.data?.main?.[0]?.[0]?.json;
        if (input) {
          console.log("Filtered message from:", input.event?.user || input.event?.bot_id);
          console.log("Subtype:", input.event?.subtype || "none");
          console.log("Channel:", input.event?.channel);
          console.log("Has thread_ts:", Boolean(input.event?.thread_ts));
        }
      }
    }
    
    // Check for errors
    if (exec.status === "error") {
      const error = detail.data?.resultData?.error;
      console.log("Error:", error?.message || JSON.stringify(error));
    }
  }
}

main().catch(console.error);
