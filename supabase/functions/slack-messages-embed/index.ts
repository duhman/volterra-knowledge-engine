import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 50;

interface SlackMessage {
  id: string;
  text: string;
  channel_id: string;
  message_ts: string;
}

async function generateEmbedding(
  text: string,
  openaiKey: string
): Promise<number[]> {
  const cleaned = text
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10000);

  if (cleaned.length < 10) {
    throw new Error('Text too short for embedding');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: cleaned,
      encoding_format: 'float',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI embedding error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  let processed = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // Verify cron secret
    const cronSecret = Deno.env.get('CRON_SECRET');
    const requestSecret = req.headers.get('x-cron-secret');
    if (cronSecret && requestSecret !== cronSecret) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse input
    let batchSize = BATCH_SIZE;
    let channelId: string | null = null;

    try {
      const body = await req.json();
      if (body.batch_size) batchSize = Math.min(body.batch_size, 200);
      if (body.channel_id) channelId = body.channel_id;
    } catch {
      // Use defaults
    }

    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get messages without embeddings (direct query instead of RPC for schema support)
    let query = supabase
      .schema('volterra_kb').from('slack_messages')
      .select('id, text, channel_id, message_ts')
      .is('embedding', null)
      .not('text', 'is', null)
      .gt('text', '')  // text length > 0
      .order('message_at', { ascending: false })
      .limit(batchSize);

    if (channelId) {
      query = query.eq('channel_id', channelId);
    }

    const { data: messages, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch messages: ${fetchError.message}`);
    }

    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No messages need embeddings',
          processed: 0,
          failed: 0,
          skipped: 0,
          elapsedMs: Date.now() - startTime,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Processing ${messages.length} messages for embeddings`);

    // Process each message
    for (const msg of messages as SlackMessage[]) {
      try {
        if (!msg.text || msg.text.trim().length < 10) {
          skipped++;
          continue;
        }

        const embedding = await generateEmbedding(msg.text, openaiKey);

        const { error: updateError } = await supabase
          .schema('volterra_kb').from('slack_messages')
          .update({ embedding })
          .eq('id', msg.id);

        if (updateError) {
          console.error(`Failed to update ${msg.id}:`, updateError.message);
          failed++;
        } else {
          processed++;
        }

        // Rate limit protection
        await new Promise(r => setTimeout(r, 50));

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to embed message ${msg.id}:`, errMsg);
        failed++;
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`Embedding complete: ${processed} processed, ${failed} failed, ${skipped} skipped in ${elapsed}ms`);

    return new Response(
      JSON.stringify({
        success: true,
        processed,
        failed,
        skipped,
        totalFetched: messages.length,
        elapsedMs: elapsed,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Embedding error:', err.message);

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        processed,
        failed,
        skipped,
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
