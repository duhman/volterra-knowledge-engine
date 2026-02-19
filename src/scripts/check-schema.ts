import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "volterra_kb" } },
);

async function main() {
  const { data, error } = await supabase
    .from("notion_pages")
    .select("*")
    .limit(1);

  if (error) {
    console.error("Query failed:", error);
    process.exit(1);
  }

  if (data && data.length > 0) {
    console.log("Columns:", Object.keys(data[0]).join(", "));
  }
}

main().catch(console.error);
