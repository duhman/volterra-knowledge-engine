#!/usr/bin/env node
/**
 * Apply SQL migration to Supabase Cloud via direct PostgreSQL connection
 * Usage: npx tsx src/scripts/apply-migration-pg.ts <migration.sql>
 */

import "dotenv/config";
import { Client } from "pg";
import { readFileSync } from "fs";

// Supabase Cloud connection via pooler
const PROJECT_REF = "your-supabase-project-id";
const config = {
  host: "aws-0-eu-north-1.pooler.supabase.com",
  port: 6543,
  database: "postgres",
  user: `postgres.${PROJECT_REF}`,
  password: process.env.SUPABASE_CLOUD_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
};

if (!config.password) {
  console.error("Error: SUPABASE_CLOUD_DB_PASSWORD not set");
  console.error("Set it in .env or export SUPABASE_CLOUD_DB_PASSWORD=...");
  process.exit(1);
}

async function main() {
  const migrationPath = process.argv[2];
  if (!migrationPath) {
    console.error(
      "Usage: npx tsx src/scripts/apply-migration-pg.ts <migration.sql>",
    );
    process.exit(1);
  }

  const sql = readFileSync(migrationPath, "utf-8");
  console.log(`Applying migration from ${migrationPath}...`);
  console.log(`Connecting to ${config.host}:${config.port}...`);

  const client = new Client(config);

  try {
    await client.connect();
    console.log("Connected successfully");

    // Execute the entire migration as one transaction
    await client.query("BEGIN");

    try {
      await client.query(sql);
      await client.query("COMMIT");
      console.log("Migration applied successfully!");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } catch (err: unknown) {
    const error = err as Error;
    if (error.message?.includes("already exists")) {
      console.log("Migration objects already exist (skipped)");
    } else {
      console.error("Error:", error.message);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch(console.error);
