#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { getSupabaseClient } from '../database/supabase-client.js';
import { generateEmbedding } from '../core/embedding-service.js';
import { logger } from '../utils/logger.js';

const program = new Command();

interface ConversationRow {
  id: string;
  hubspot_ticket_id: string;
  subject: string | null;
  category?: string | null;
  subcategory?: string | null;
}

interface MessageRow {
  conversation_id: string;
  timestamp: string | null;
  from_name: string | null;
  from_email: string | null;
  participant_role: string | null;
  content: string | null;
}

function buildConversationText(
  conversation: ConversationRow,
  messages: MessageRow[],
): string {
  let text = `Subject: ${conversation.subject || ""}\n\n`;

  if (conversation.category) {
    text += `Category: ${conversation.category}`;
    if (conversation.subcategory) {
      text += ` > ${conversation.subcategory}`;
    }
    text += "\n\n";
  }

  for (const msg of messages) {
    const role = (msg.participant_role || "unknown").toUpperCase();
    const name = msg.from_name || msg.from_email || "unknown";
    const content = msg.content || "";
    if (!content.trim()) continue;
    text += `[${role}] ${name}:\n${content}\n\n---\n\n`;
  }

  return text.trim();
}

program
  .name('generate-training-embeddings')
  .description('Generate embeddings for training_conversations table')
  .option('-l, --limit <n>', 'Maximum conversations to process', (val) => parseInt(val, 10))
  .option('-b, --batch-size <n>', 'Batch size for processing', (val) => parseInt(val, 10), 50)
  .option('--dry-run', 'Show what would be processed without making changes')
  .action(async (opts) => {
    const startTime = Date.now();
    const client = getSupabaseClient();
    
    console.log('='.repeat(60));
    console.log('TRAINING CONVERSATIONS EMBEDDING GENERATOR');
    console.log('='.repeat(60));
    
    // Get count of conversations without embeddings
    const { count: totalWithoutEmbeddings, error: countError } = await client
      .from('training_conversations')
      .select('*', { count: 'exact', head: true })
      .is('embedding', null);

    if (countError) {
      console.error('Failed to count conversations:', countError.message);
      process.exit(1);
    }

    console.log(`\nConversations without embeddings: ${totalWithoutEmbeddings}`);
    
    if (totalWithoutEmbeddings === 0) {
      console.log('All conversations already have embeddings!');
      process.exit(0);
    }

    const limit = opts.limit || totalWithoutEmbeddings;
    const batchSize = opts.batchSize;
    
    console.log(`Processing: ${Math.min(limit, totalWithoutEmbeddings!)} conversations`);
    console.log(`Batch size: ${batchSize}`);
    console.log(`Dry run: ${opts.dryRun ? 'YES' : 'NO'}`);
    console.log('');

    let processed = 0;
    let successful = 0;
    let failed = 0;
    let offset = 0;
    let totalTokens = 0;
    let rpcAvailable: boolean | null = null;

    while (processed < limit) {
      // Fetch batch of conversations without embeddings
      const { data: conversations, error: fetchError } = await client
        .from('training_conversations')
        .select('id, hubspot_ticket_id, subject, category, subcategory')
        .is('embedding', null)
        .order('created_at', { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (fetchError) {
        console.error('Failed to fetch conversations:', fetchError.message);
        break;
      }

      if (!conversations || conversations.length === 0) {
        console.log('No more conversations to process');
        break;
      }

      console.log(`\nBatch ${Math.floor(offset / batchSize) + 1}: Processing ${conversations.length} conversations...`);

      if (rpcAvailable === null) {
        const probe = conversations[0] as ConversationRow | undefined;
        if (probe) {
          const { error: probeError } = await client
            .rpc('get_conversation_text_for_embedding', { conv_id: probe.id });
          rpcAvailable = !probeError;
          if (!rpcAvailable) {
            console.log(
              'RPC get_conversation_text_for_embedding not available; falling back to message aggregation.',
            );
          }
        } else {
          rpcAvailable = false;
        }
      }

      let messagesByConversation: Map<string, MessageRow[]> | null = null;
      if (!rpcAvailable) {
        const conversationIds = (conversations as ConversationRow[]).map((c) => c.id);
        const { data: messages, error: messageError } = await client
          .from('training_messages')
          .select('conversation_id, timestamp, from_name, from_email, participant_role, content')
          .in('conversation_id', conversationIds)
          .order('timestamp', { ascending: true });

        if (messageError) {
          console.error('Failed to fetch training messages:', messageError.message);
          failed += conversations.length;
          processed += conversations.length;
          continue;
        }

        messagesByConversation = new Map<string, MessageRow[]>();
        for (const msg of (messages || []) as MessageRow[]) {
          const list = messagesByConversation.get(msg.conversation_id) || [];
          list.push(msg);
          messagesByConversation.set(msg.conversation_id, list);
        }
      }

      for (const conv of conversations as ConversationRow[]) {
        if (processed >= limit) break;

        try {
          // Get embedding text using the Supabase function
          let embeddingText = '';
          if (rpcAvailable) {
            const { data: textResult, error: textError } = await client
              .rpc('get_conversation_text_for_embedding', { conv_id: conv.id });

            if (textError) {
              console.error(`  [${conv.hubspot_ticket_id}] Failed to get text: ${textError.message}`);
              failed++;
              processed++;
              continue;
            }

            embeddingText = String(textResult || '');
          } else {
            const messages = messagesByConversation?.get(conv.id) || [];
            embeddingText = buildConversationText(conv, messages);
          }

          if (!embeddingText || embeddingText.trim().length < 10) {
            console.log(`  [${conv.hubspot_ticket_id}] Skipping - insufficient text content`);
            failed++;
            processed++;
            continue;
          }

          if (opts.dryRun) {
            console.log(`  [${conv.hubspot_ticket_id}] Would embed: "${conv.subject?.substring(0, 50) || 'No subject'}..." (${embeddingText.length} chars)`);
            successful++;
            processed++;
            continue;
          }

          // Generate embedding
          const { embedding, tokenUsage } = await generateEmbedding(embeddingText);
          totalTokens += tokenUsage;

          // Update the conversation with the embedding (convert to string for pgvector)
          const { error: updateError } = await client
            .from('training_conversations')
            .update({ embedding: `[${embedding.join(',')}]` })
            .eq('id', conv.id);

          if (updateError) {
            console.error(`  [${conv.hubspot_ticket_id}] Failed to update: ${updateError.message}`);
            failed++;
          } else {
            successful++;
            if (successful % 10 === 0) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              const rate = (successful / parseFloat(elapsed)).toFixed(1);
              console.log(`  Progress: ${successful} embedded (${rate}/sec, ${totalTokens} tokens)`);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`  [${conv.hubspot_ticket_id}] Error: ${message}`);
          failed++;
        }

        processed++;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Move to next batch - don't increment offset since we're fetching NULL embeddings
      // and updating them, so the next query will get new rows
      if (conversations.length < batchSize) {
        break; // No more to process
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total processed: ${processed}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total tokens used: ${totalTokens}`);
    console.log(`Time elapsed: ${elapsed}s`);
    console.log(`Rate: ${(successful / parseFloat(elapsed)).toFixed(2)} conversations/sec`);

    // Get updated count
    if (!opts.dryRun) {
      const { count: remaining } = await client
        .from('training_conversations')
        .select('*', { count: 'exact', head: true })
        .is('embedding', null);
      
      console.log(`\nRemaining without embeddings: ${remaining}`);
    }

    if (failed > 0) {
      process.exit(1);
    }
    
    logger.info('Training embeddings generation complete', { successful, failed, totalTokens });
  });

program.parse();
