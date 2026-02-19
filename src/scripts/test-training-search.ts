#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { searchTrainingConversations, searchTrainingConversationsWithMessages } from '../database/supabase-client.js';
import { generateEmbedding } from '../core/embedding-service.js';
import { logger } from '../utils/logger.js';

const program = new Command();

program
  .name('test-training-search')
  .description('Test semantic search on training conversations')
  .argument('<query>', 'Search query')
  .option('-n, --count <n>', 'Number of results', (val) => parseInt(val, 10), 5)
  .option('-t, --threshold <n>', 'Similarity threshold', parseFloat, 0.7)
  .option('--type <type>', 'Filter by training type (email_agent, chatbot)')
  .option('--messages', 'Include full message threads')
  .action(async (query, opts) => {
    console.log(`\nSearching training conversations for: "${query}"\n`);

    try {
      // Generate embedding for query
      const { embedding } = await generateEmbedding(query);
      console.log(`Query embedding generated (${embedding.length} dimensions)\n`);

      if (opts.messages) {
        // Search with messages
        const results = await searchTrainingConversationsWithMessages(embedding, {
          matchThreshold: opts.threshold,
          matchCount: opts.count,
          trainingType: opts.type,
          maxMessagesPerConversation: 5,
        });

        console.log(`Found ${results.length} matching conversations:\n`);

        for (const conv of results) {
          console.log('='.repeat(60));
          console.log(`Subject: ${conv.subject || 'No subject'}`);
          console.log(`Category: ${conv.category || 'Unknown'}`);
          console.log(`Similarity: ${(conv.similarity * 100).toFixed(1)}%`);
          console.log(`Messages: ${conv.messages.length}`);
          console.log('-'.repeat(60));
          
          for (const msg of conv.messages) {
            const role = msg.participant_role || 'unknown';
            const name = msg.from_name || role;
            console.log(`[${role.toUpperCase()}] ${name}:`);
            console.log(msg.content.substring(0, 500) + (msg.content.length > 500 ? '...' : ''));
            console.log('');
          }
        }
      } else {
        // Search without messages
        const results = await searchTrainingConversations(embedding, {
          matchThreshold: opts.threshold,
          matchCount: opts.count,
          trainingType: opts.type,
        });

        console.log(`Found ${results.length} matching conversations:\n`);

        for (let i = 0; i < results.length; i++) {
          const conv = results[i];
          console.log(`${i + 1}. [${(conv.similarity * 100).toFixed(1)}%] ${conv.subject || 'No subject'}`);
          console.log(`   Category: ${conv.category || 'Unknown'}`);
          console.log(`   Summary: ${(conv.conversation_summary || '').substring(0, 200)}...`);
          console.log('');
        }
      }

      logger.info('Training search test complete', { query, resultsCount: opts.count });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
