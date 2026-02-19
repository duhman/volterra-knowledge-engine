#!/usr/bin/env node
import "dotenv/config";
import { getSupabaseClient } from "../database/supabase-client.js";
import { logger } from "../utils/logger.js";

async function checkEmbeddings() {
  const client = getSupabaseClient();

  // Check a specific page we know was synced
  const { data, error } = await client
    .from("documents")
    .select("id, title, embedding, source_path")
    .eq("title", "Campaigns")
    .limit(5);

  if (error) {
    logger.error("Error querying documents", { error: error.message });
    return;
  }

  if (data.length === 0) {
    logger.info('No documents found with title "Campaigns"');

    // Check if any documents from the Team Platform Roadmap exist
    const { data: allDocs, error: err2 } = await client
      .from("documents")
      .select("id, title, source_path, embedding")
      .ilike("source_path", "%8c3e5908708d4cf68191e21d5c6d7444%")
      .limit(5);

    if (err2) {
      logger.error("Error checking roadmap docs", { error: err2.message });
      return;
    }

    logger.info(
      `Found ${allDocs?.length || 0} documents from Team Platform Roadmap`,
    );
    allDocs?.forEach((doc) => {
      const hasEmbedding = doc.embedding ? "YES" : "NO";
      logger.info("Document", {
        title: doc.title,
        source_path: doc.source_path,
        has_embedding: hasEmbedding,
      });
    });
    return;
  }

  logger.info(`Found ${data.length} documents with title "Campaigns"`);
  data.forEach((doc) => {
    const hasEmbedding = doc.embedding ? "YES" : "NO";
    logger.info("Document details", {
      title: doc.title,
      id: doc.id,
      source_path: doc.source_path,
      has_embedding: hasEmbedding,
    });
  });
}

checkEmbeddings();
