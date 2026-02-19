#!/usr/bin/env node
/**
 * List meeting transcript pages from volterra_kb.notion_pages that need content updates
 * (private_kb isn't exposed via PostgREST, so we use notion_pages instead)
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "volterra_kb" } },
);

async function main() {
  // Get meeting pages from notion_pages
  const { data: docs, error } = await supabase
    .from("notion_pages")
    .select("notion_page_id, title")
    .not("database_id", "is", null)
    .order("notion_last_edited_time", { ascending: false })
    .limit(150);

  if (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }

  console.log(`Found ${docs.length} notion pages with meeting notes`);
  console.log("\n=== Page IDs ===");
  docs.slice(0, 20).forEach((d) => {
    const title = d.title ? d.title.substring(0, 60) : "(no title)";
    console.log(`${d.notion_page_id}: ${title}`);
  });
}

main().catch(console.error);
