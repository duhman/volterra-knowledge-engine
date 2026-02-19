import { config } from "dotenv";
config();

const apiUrl = process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
const apiKey = process.env.N8N_API_KEY;

async function main() {
  const resp = await fetch(apiUrl + "/workflows/UtsHZSFSpXa6arFN", {
    headers: { "X-N8N-API-KEY": apiKey }
  });
  const workflow = await resp.json();
  
  // Check Extract Message node
  const extractNode = workflow.nodes.find((n) => n.name === "Extract Message");
  console.log("=== Extract Message Node ===");
  console.log(JSON.stringify(extractNode, null, 2));
  
  // Check what connects Filter Incoming to Extract Message
  console.log("\n=== Connections from Filter Incoming ===");
  console.log(JSON.stringify(workflow.connections["Filter Incoming"], null, 2));
}

main().catch(console.error);
