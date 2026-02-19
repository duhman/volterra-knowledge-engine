#!/usr/bin/env node
/**
 * Apply SQL migration to Supabase Cloud
 * Usage: npx tsx src/scripts/apply-migration.ts <migration.sql>
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_CLOUD_URL || "https://your-project.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_CLOUD_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error(
    "Error: SUPABASE_CLOUD_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY not set",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: "volterra_kb" },
});

async function main() {
  // Read migration file
  const migrationPath = process.argv[2];
  if (!migrationPath) {
    console.error(
      "Usage: npx tsx src/scripts/apply-migration.ts <migration.sql>",
    );
    process.exit(1);
  }

  const sql = readFileSync(migrationPath, "utf-8");
  console.log(`Applying migration from ${migrationPath}...`);

  // Try exec_sql RPC first
  const { data, error } = await supabase.rpc("exec_sql", { query: sql });

  if (error) {
    if (error.code === "PGRST202") {
      console.log("exec_sql RPC not available.");
      console.log("");
      console.log(
        "Please apply this migration manually via Supabase SQL Editor:",
      );
      console.log(
        "1. Go to https://supabase.com/dashboard/project/your-supabase-project-id/sql",
      );
      console.log(`2. Copy and paste the contents of: ${migrationPath}`);
      console.log('3. Click "Run"');
      process.exit(1);
    } else if (error.message?.includes("already exists")) {
      console.log("Migration objects already exist (skipped)");
    } else {
      console.error(`Error: ${error.message}`);
      console.log("");
      console.log("Please apply manually via Supabase SQL Editor:");
      console.log(
        "https://supabase.com/dashboard/project/your-supabase-project-id/sql",
      );
      process.exit(1);
    }
  } else {
    console.log("Migration applied successfully!");
    console.log("Result:", data);
  }
}

main().catch(console.error);
