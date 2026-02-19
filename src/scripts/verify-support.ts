#!/usr/bin/env node
/**
 * Verify ingested support documents in Supabase
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Query support documents
  const { data, error } = await client
    .from('documents')
    .select('title, department, document_type, tags, sensitivity, access_level')
    .or('tags.cs.{support},tags.cs.{kb}')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  console.log('\n=== Support Documents in Supabase ===');
  console.log(`Total found: ${data.length}\n`);

  if (data.length === 0) {
    console.log('No support documents found.');
    return;
  }

  console.log('Documents:');
  for (let i = 0; i < data.length; i++) {
    const doc = data[i];
    console.log(`${i + 1}. ${doc.title}`);
    console.log(`   Department: ${doc.department} | Type: ${doc.document_type}`);
    console.log(`   Tags: ${doc.tags?.join(', ') || 'none'}`);
    console.log(`   Access: ${doc.access_level} | Sensitivity: ${doc.sensitivity}`);
  }

  // Count by type
  const { data: counts } = await client
    .from('documents')
    .select('document_type')
    .or('tags.cs.{support},tags.cs.{kb}');

  if (counts) {
    const typeCounts: Record<string, number> = {};
    for (const row of counts) {
      typeCounts[row.document_type] = (typeCounts[row.document_type] || 0) + 1;
    }
    console.log('\n=== By Document Type ===');
    for (const [type, count] of Object.entries(typeCounts)) {
      console.log(`  ${type}: ${count}`);
    }
  }
}

main().catch(console.error);
