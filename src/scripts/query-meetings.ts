import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  // Query private_kb.documents directly via REST API (exposed as view)
  const params = new URLSearchParams({
    select: "notion_page_id,title,content",
    document_type: "eq.Meeting Transcript",
    order: "created_at.desc",
    limit: "150",
  });

  const response = await fetch(
    `${url}/rest/v1/private_kb_documents?${params}`,
    {
      method: "GET",
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    console.error("Query failed:", await response.text());
    process.exit(1);
  }

  const docs = (await response.json()) as Array<{
    notion_page_id: string;
    title: string | null;
    content: string | null;
  }>;

  // Filter to ones with short content (need transcription)
  const needsUpdate = docs.filter(
    (d: any) => d.notion_page_id && (!d.content || d.content.length < 1000),
  );

  console.log(
    `Found ${docs.length} meeting docs, ${needsUpdate.length} need content update:`,
  );
  needsUpdate.slice(0, 30).forEach((d: any) => {
    const len = d.content ? d.content.length : 0;
    const title = d.title ? d.title.substring(0, 50) : "(no title)";
    console.log(`  ${d.notion_page_id}: ${title} (${len} chars)`);
  });

  // Output just the IDs for batch processing
  console.log("\nPage IDs to process (first 10):");
  needsUpdate.slice(0, 10).forEach((d: any) => console.log(d.notion_page_id));
}

main().catch(console.error);
