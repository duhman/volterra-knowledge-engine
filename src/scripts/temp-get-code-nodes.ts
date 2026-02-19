import { N8nApiClient } from "../services/n8n-api-client.js";

async function main() {
  const client = new N8nApiClient();
  const workflow = await client.getWorkflow("YOUR_WORKFLOW_ID");
  const codeNodes = workflow.nodes.filter((n: any) => n.type === "n8n-nodes-base.code");
  for (const node of codeNodes) {
    console.log("=== " + node.name + " ===");
    console.log("Mode:", node.parameters?.mode || "runOnceForEachItem (default)");
    console.log("Code:");
    console.log(node.parameters?.jsCode || "(no code)");
    console.log("");
  }
}

main().catch(console.error);
