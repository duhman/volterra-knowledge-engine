import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Search for all
const response = await notion.search({
  page_size: 100
});

console.log('Found', response.results.length, 'objects total\n');

// Count object types
const types = {};
for (const obj of response.results) {
  types[obj.object] = (types[obj.object] || 0) + 1;
}
console.log('Object types:', types);

// Show pages that might be databases (has database_id)
const pagesWithDb = response.results.filter(obj => obj.parent?.database_id);
console.log('\nPages from databases:', pagesWithDb.length);

// Get unique database IDs
const dbIds = new Set();
for (const obj of response.results) {
  if (obj.parent?.database_id) {
    dbIds.add(obj.parent.database_id);
  }
}
console.log('\nUnique database IDs found:', dbIds.size);
for (const id of dbIds) {
  // Try to get database info
  try {
    const db = await notion.databases.retrieve({ database_id: id });
    const title = db.title?.[0]?.plain_text || 'Untitled';
    console.log(`\n${id}`);
    console.log(`  Title: ${title}`);
  } catch (e) {
    console.log(`\n${id} (no access)`);
  }
}
