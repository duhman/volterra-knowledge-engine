import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

// ============================================================================
// HUBSPOT BATCH READ
// ============================================================================

interface HubSpotBatchReadResponse {
  results: Array<{
    id: string;
    properties: {
      hs_num_times_contacted?: string;
    };
  }>;
  errors?: Array<{
    id: string;
    message: string;
  }>;
}

async function batchReadTickets(
  token: string,
  ticketIds: string[]
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  
  if (ticketIds.length === 0) return results;
  
  // HubSpot batch read accepts max 100 IDs per request
  const batchSize = 100;
  for (let i = 0; i < ticketIds.length; i += batchSize) {
    const batch = ticketIds.slice(i, i + batchSize);
    
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/tickets/batch/read', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: batch.map(id => ({ id })),
        properties: ['hs_num_times_contacted']
      })
    });
    
    if (!response.ok) {
      const err = await response.text();
      console.error(`HubSpot batch read failed (${response.status}): ${err}`);
      // Continue with partial results rather than failing entirely
      continue;
    }
    
    const data: HubSpotBatchReadResponse = await response.json();
    
    for (const ticket of data.results || []) {
      const contactedValue = parseInt(ticket.properties?.hs_num_times_contacted || '0', 10) || 0;
      results.set(ticket.id, contactedValue);
    }
    
    // Small delay between batches to avoid rate limits
    if (i + batchSize < ticketIds.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return results;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const startTime = Date.now();
  
  try {
    // Verify cron secret (if configured)
    const cronSecret = Deno.env.get('CRON_SECRET');
    const requestSecret = req.headers.get('x-cron-secret');
    if (cronSecret && requestSecret !== cronSecret) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Parse input
    let batchSize = 100;
    try {
      const body = await req.json();
      if (body.batch_size && typeof body.batch_size === 'number') {
        batchSize = Math.min(Math.max(body.batch_size, 1), 500);
      }
    } catch {
      // No body or invalid JSON - use default
    }
    
    // Initialize clients
    const hubspotToken = Deno.env.get('HUBSPOT_PRIVATE_APP_TOKEN');
    if (!hubspotToken) {
      throw new Error('HUBSPOT_PRIVATE_APP_TOKEN not configured');
    }
    
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    
    // Find tickets needing backfill (hs_num_times_contacted IS NULL)
    const { data: ticketsToBackfill, error: queryError } = await supabaseClient
      .schema('volterra_kb').from('training_conversations')
      .select('id, hubspot_ticket_id')
      .is('hs_num_times_contacted', null)
      .not('hubspot_ticket_id', 'is', null)
      .order('updated_at', { ascending: true })
      .limit(batchSize);
    
    if (queryError) {
      throw new Error(`Failed to query tickets: ${queryError.message}`);
    }
    
    const requested = ticketsToBackfill?.length || 0;
    
    if (requested === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          requested: 0,
          updated: 0,
          missingFromHubSpot: 0,
          errors: 0,
          message: 'No tickets need backfill',
          elapsedMs: Date.now() - startTime
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log(`Backfilling ${requested} tickets`);
    
    // Build map of supabase_id -> hubspot_ticket_id (we update existing rows only)
    const ticketMap = new Map<string, { supabaseId: string; hubspotId: string }>();
    const hubspotIds: string[] = [];
    for (const ticket of ticketsToBackfill!) {
      if (!ticket.hubspot_ticket_id) continue;
      ticketMap.set(ticket.hubspot_ticket_id, { supabaseId: ticket.id, hubspotId: ticket.hubspot_ticket_id });
      hubspotIds.push(ticket.hubspot_ticket_id);
    }
    
    // Fetch hs_num_times_contacted from HubSpot
    const hubspotData = await batchReadTickets(hubspotToken, hubspotIds);
    
    // Update Supabase (existing rows only). Use concurrency to reduce runtime.
    let updated = 0;
    let errors = 0;
    const missingFromHubSpot = hubspotIds.length - hubspotData.size;

    const updates = Array.from(ticketMap.values());
    const concurrency = 25;
    for (let i = 0; i < updates.length; i += concurrency) {
      const chunk = updates.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map(async (t) => {
        const contactedValue = hubspotData.get(t.hubspotId) ?? 0;
        const { error: updateError } = await supabaseClient
          .schema('volterra_kb').from('training_conversations')
          .update({ hs_num_times_contacted: contactedValue })
          .eq('id', t.supabaseId);
        return updateError;
      }));

      for (const err of results) {
        if (err) {
          errors++;
          console.error('Backfill update failed:', err);
        } else {
          updated++;
        }
      }
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`Backfill completed in ${elapsed}ms: ${requested} requested, ${updated} updated, ${missingFromHubSpot} missing from HubSpot, ${errors} errors`);
    
    return new Response(
      JSON.stringify({
        success: true,
        requested,
        updated,
        missingFromHubSpot,
        errors,
        elapsedMs: elapsed
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Backfill error:', err.message);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
