import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

// ============================================================================
// TYPES
// ============================================================================

interface SyncState {
  cursor_hs_lastmodified_ms: number;
  lookback_hours: number;
}

interface HubSpotTicket {
  id: string;
  properties: {
    subject?: string;
    content?: string;
    createdate?: string;
    hs_lastmodifieddate?: string;
    hs_ticket_priority?: string;
    hs_pipeline?: string;
    hs_pipeline_stage?: string;
    hs_ticket_category?: string;
    subcategory?: string;
    hs_num_times_contacted?: string;
  };
}

interface HubSpotEngagement {
  id: string;
  properties: {
    hs_engagement_type?: string;
    hs_timestamp?: string;
    hs_body_preview?: string;
    hs_email_subject?: string;
    hs_email_text?: string;
    hs_email_html?: string;
    hs_email_from?: string;
    hs_email_to?: string;
    hs_email_direction?: string;
    hubspot_owner_id?: string;
  };
  createdAt?: string;
}

interface ConversationRow {
  hubspot_ticket_id: string;
  subject: string;
  priority: string | null;
  status: string | null;
  pipeline: string | null;
  category: string | null;
  subcategory: string | null;
  create_date: string | null;
  source_type: string;
  primary_language: string | null;
  conversation_summary: string | null;
  participant_count: number;
  thread_length: number;
  training_type: string;
  hs_num_times_contacted: number;
}

interface MessageRow {
  conversation_id: string;
  hubspot_message_id: string;
  source: string;
  timestamp: string;
  from_email: string;
  from_name: string | null;
  participant_role: string | null;
  subject: string | null;
  content: string;
  content_type: string;
  direction: string | null;
  engagement_type: string | null;
  message_type: string;
}

// ============================================================================
// SPAM / AUTO-REPLY DETECTION
// ============================================================================

const SPAM_PATTERNS = [
  /zaptec status notification/i,
  /out of office/i,
  /auto-?reply/i,
  /automatic reply/i,
  /autosvar/i,
  /automatisk svar/i,
  /frånvaro/i,
  /statusoppdatering/i,
];

function detectAutoReply(subject = '', content = ''): boolean {
  const normalizedSubject = subject.toLowerCase();
  const normalizedContent = content.toLowerCase();
  return SPAM_PATTERNS.some(pattern =>
    pattern.test(normalizedSubject) || pattern.test(normalizedContent)
  );
}

// ============================================================================
// CONTENT SANITIZATION
// ============================================================================

const SIGNATURE_PATTERNS = [
  /--\s*[\r\n]+[\s\S]*$/m,
  /^\s*Sent from my .*$/gim,
  /^\s*Best regards[\s\S]*$/gim,
  /^\s*Kind regards[\s\S]*$/gim,
  /^\s*Med vennlig hilsen[\s\S]*$/gim,
];

function sanitizeContent(content: string | null | undefined): string {
  if (!content) return '';
  
  let cleaned = String(content)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  
  for (const pattern of SIGNATURE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  cleaned = cleaned
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
    .replace(/ +/g, ' ');
  
  return cleaned;
}

// ============================================================================
// PARTICIPANT ROLE INFERENCE
// ============================================================================

const VOLTERRA_DOMAIN_REGEX = /@volterra\.io$/i;

function normalizeDirection(rawDirection: string | null | undefined, role: string): string {
  const direction = String(rawDirection || '').toLowerCase();
  if (direction.includes('inbound') || direction.includes('incoming')) return 'inbound';
  if (direction.includes('outbound') || direction.includes('outgoing')) return 'outbound';
  return role === 'customer' ? 'inbound' : 'outbound';
}

function inferRole(direction: string | null | undefined, fromEmail: string | null): string {
  const normalizedDirection = String(direction || '').toUpperCase();
  if (normalizedDirection === 'OUTBOUND') return 'support';
  if (normalizedDirection === 'INBOUND') return 'customer';
  if (fromEmail && VOLTERRA_DOMAIN_REGEX.test(fromEmail)) return 'support';
  return 'customer';
}

function parseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = String(raw).split(',')[0].trim();
  const m = first.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  const simple = first.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return simple ? simple[0] : first;
}

// ============================================================================
// LANGUAGE DETECTION
// ============================================================================

function detectLanguage(text: string): string {
  const norwegianWords = ['og', 'er', 'det', 'jeg', 'ikke', 'en', 'til', 'med', 'på', 'hei', 'takk'];
  const englishWords = ['and', 'is', 'the', 'it', 'not', 'a', 'to', 'with', 'on', 'hello', 'thank'];
  const lowerText = text.toLowerCase();
  const norwegianCount = norwegianWords.filter(word => lowerText.includes(` ${word} `)).length;
  const englishCount = englishWords.filter(word => lowerText.includes(` ${word} `)).length;
  return norwegianCount > englishCount ? 'no' : 'en';
}

// ============================================================================
// HUBSPOT API HELPERS
// ============================================================================

async function searchTickets(
  token: string,
  sinceMs: number,
  limit: number
): Promise<{ tickets: HubSpotTicket[]; maxLastModified: number }> {
  const allTickets: HubSpotTicket[] = [];
  let maxLastModified = sinceMs;
  let after: string | undefined;
  const pageSize = Math.min(limit, 100);
  
  while (allTickets.length < limit) {
    const body: any = {
      filterGroups: [{
        filters: [{
          propertyName: 'hs_lastmodifieddate',
          operator: 'GTE',
          value: sinceMs.toString()
        }]
      }],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: [
        'subject', 'content', 'createdate', 'hs_lastmodifieddate',
        'hs_ticket_priority', 'hs_pipeline', 'hs_pipeline_stage',
        'hs_ticket_category', 'subcategory', 'hs_num_times_contacted'
      ],
      limit: pageSize
    };
    if (after) body.after = after;
    
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`HubSpot tickets search failed (${response.status}): ${err}`);
    }
    
    const data = await response.json();
    const tickets: HubSpotTicket[] = data.results || [];
    allTickets.push(...tickets);
    
    // Track max lastModified
    for (const t of tickets) {
      const lm = t.properties.hs_lastmodifieddate ? new Date(t.properties.hs_lastmodifieddate).getTime() : 0;
      if (lm > maxLastModified) maxLastModified = lm;
    }
    
    if (data.paging?.next?.after && allTickets.length < limit) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }
  
  return { tickets: allTickets.slice(0, limit), maxLastModified };
}

async function getTicketEngagements(token: string, ticketId: string, maxMessages = 100): Promise<HubSpotEngagement[]> {
  try {
    const body = {
      filterGroups: [{
        filters: [{
          propertyName: 'associations.ticket',
          operator: 'EQ',
          value: ticketId
        }]
      }],
      sorts: ['hs_timestamp'],
      limit: maxMessages,
      properties: [
        'hs_engagement_type', 'hs_timestamp', 'hs_body_preview',
        'hs_email_subject', 'hs_email_text', 'hs_email_html',
        'hs_email_from', 'hs_email_to', 'hs_email_direction', 'hubspot_owner_id'
      ]
    };
    
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/engagements/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      console.warn(`Failed to get engagements for ticket ${ticketId}: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const all: HubSpotEngagement[] = data.results || [];
    // Filter to EMAIL engagements only
    return all.filter(e => (e.properties?.hs_engagement_type || '').toUpperCase() === 'EMAIL');
  } catch (error) {
    console.warn(`Error fetching engagements for ticket ${ticketId}:`, error);
    return [];
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  
  const startTime = Date.now();
  let ticketsFetched = 0;
  let conversationsUpserted = 0;
  let messagesUpserted = 0;
  let failedTickets = 0;
  let lastError: string | null = null;
  let maxCursor = 0;
  
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
    let lookbackHoursOverride: number | undefined;
    let limitOverride: number | undefined;
    try {
      const body = await req.json();
      lookbackHoursOverride = body.lookback_hours;
      limitOverride = body.limit;
    } catch {
      // No body or invalid JSON - use defaults
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
    
    // Read sync state
    const { data: stateRow, error: stateError } = await supabaseClient
      .schema('volterra_kb').from('hubspot_ticket_sync_state')
      .select('cursor_hs_lastmodified_ms, lookback_hours')
      .eq('source', 'tickets')
      .single();
    
    if (stateError) {
      console.error('Failed to read sync state:', stateError);
      throw new Error(`Failed to read sync state: ${stateError.message}`);
    }
    
    const state: SyncState = stateRow || { cursor_hs_lastmodified_ms: 0, lookback_hours: 48 };
    const lookbackHours = lookbackHoursOverride ?? state.lookback_hours;
    const limit = limitOverride ?? 500;
    
    // Compute effective since timestamp
    const lookbackMs = Date.now() - (lookbackHours * 60 * 60 * 1000);
    const sinceMs = Math.max(state.cursor_hs_lastmodified_ms, lookbackMs);
    
    console.log(`Starting sync: cursor=${state.cursor_hs_lastmodified_ms}, lookback=${lookbackHours}h, sinceMs=${sinceMs}, limit=${limit}`);
    
    // Fetch tickets from HubSpot
    const { tickets, maxLastModified } = await searchTickets(hubspotToken, sinceMs, limit);
    ticketsFetched = tickets.length;
    maxCursor = maxLastModified;
    
    console.log(`Fetched ${tickets.length} tickets from HubSpot`);
    
    // Process each ticket
    for (const ticket of tickets) {
      try {
        // Fetch engagements for this ticket
        const engagements = await getTicketEngagements(hubspotToken, ticket.id);
        
        // Build messages from engagements
        const participants = new Map<string, { email: string; name: string; role: string }>();
        const messages: Array<{
          id: string;
          timestamp: string;
          fromEmail: string;
          fromName: string;
          role: string;
          subject: string;
          content: string;
          direction: string;
          engagementType: string;
        }> = [];
        
        for (const eng of engagements) {
          const rawContent = sanitizeContent(
            eng.properties?.hs_email_text ||
            eng.properties?.hs_email_html ||
            eng.properties?.hs_body_preview
          );
          
          if (!rawContent.trim()) continue;
          
          const subj = eng.properties?.hs_email_subject || ticket.properties.subject || '';
          if (detectAutoReply(subj, rawContent)) continue;
          
          const fromEmail = parseEmail(eng.properties?.hs_email_from) || 'unknown@unknown.com';
          const rawDirection = eng.properties?.hs_email_direction;
          const role = inferRole(rawDirection, fromEmail);
          const direction = normalizeDirection(rawDirection, role);
          
          // Track participant
          if (!participants.has(fromEmail)) {
            participants.set(fromEmail, {
              email: fromEmail,
              name: role === 'customer' ? 'Customer' : 'Support Agent',
              role
            });
          }
          
          messages.push({
            id: eng.id,
            timestamp: eng.properties?.hs_timestamp || eng.createdAt || new Date().toISOString(),
            fromEmail,
            fromName: participants.get(fromEmail)?.name || 'Unknown',
            role,
            subject: subj,
            content: rawContent,
            direction,
            engagementType: eng.properties?.hs_engagement_type || 'EMAIL'
          });
        }
        
        // Sort messages by timestamp
        messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        
        // Detect language from all message content
        const allContent = messages.map(m => `${m.subject} ${m.content}`).join(' ');
        const primaryLanguage = allContent.trim() ? detectLanguage(allContent) : null;
        
        // Build conversation row
        const conversationRow: ConversationRow = {
          hubspot_ticket_id: ticket.id,
          subject: ticket.properties.subject || 'No Subject',
          priority: ticket.properties.hs_ticket_priority || null,
          status: ticket.properties.hs_pipeline_stage || null,
          pipeline: ticket.properties.hs_pipeline || null,
          category: ticket.properties.hs_ticket_category || null,
          subcategory: ticket.properties.subcategory || null,
          create_date: ticket.properties.createdate || null,
          source_type: 'hubspot_ticket',
          primary_language: primaryLanguage,
          conversation_summary: `${ticket.properties.subject || 'Support ticket'} - ${messages.length} messages`,
          participant_count: participants.size,
          thread_length: messages.length,
          training_type: 'email_agent',
          hs_num_times_contacted: parseInt(ticket.properties.hs_num_times_contacted || '0', 10) || 0
        };
        
        // Upsert conversation
        const { data: convData, error: convError } = await supabaseClient
          .schema('volterra_kb').from('training_conversations')
          .upsert(conversationRow, { onConflict: 'hubspot_ticket_id' })
          .select('id')
          .single();
        
        if (convError) {
          console.error(`Failed to upsert conversation for ticket ${ticket.id}:`, convError);
          failedTickets++;
          lastError = convError.message;
          continue;
        }
        
        conversationsUpserted++;
        const conversationId = convData.id;
        
        // Upsert messages
        if (messages.length > 0) {
          const messageRows: MessageRow[] = messages.map(m => ({
            conversation_id: conversationId,
            hubspot_message_id: m.id,
            source: 'hubspot_engagement',
            timestamp: m.timestamp,
            from_email: m.fromEmail,
            from_name: m.fromName,
            participant_role: m.role,
            subject: m.subject,
            content: m.content,
            content_type: 'email',
            direction: m.direction,
            engagement_type: m.engagementType,
            message_type: 'email'
          }));
          
          const { error: msgError, count } = await supabaseClient
            .schema('volterra_kb').from('training_messages')
            .upsert(messageRows, { onConflict: 'hubspot_message_id', count: 'exact' });
          
          if (msgError) {
            console.error(`Failed to upsert messages for ticket ${ticket.id}:`, msgError);
            lastError = msgError.message;
          } else {
            messagesUpserted += count || messageRows.length;
          }
        }
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 50));
        
      } catch (ticketError) {
        const err = ticketError instanceof Error ? ticketError : new Error(String(ticketError));
        console.error(`Error processing ticket ${ticket.id}:`, err.message);
        failedTickets++;
        lastError = err.message;
      }
    }
    
    // Update sync state
    if (maxCursor > state.cursor_hs_lastmodified_ms) {
      const { error: updateError } = await supabaseClient
        .schema('volterra_kb').from('hubspot_ticket_sync_state')
        .update({
          cursor_hs_lastmodified_ms: maxCursor,
          last_run_at: new Date().toISOString(),
          last_run_tickets_fetched: ticketsFetched,
          last_run_conversations_upserted: conversationsUpserted,
          last_run_messages_upserted: messagesUpserted,
          last_run_failed_tickets: failedTickets,
          last_run_error: lastError
        })
        .eq('source', 'tickets');
      
      if (updateError) {
        console.error('Failed to update sync state:', updateError);
      }
    } else {
      // Still update run stats even if cursor didn't advance
      await supabaseClient
        .schema('volterra_kb').from('hubspot_ticket_sync_state')
        .update({
          last_run_at: new Date().toISOString(),
          last_run_tickets_fetched: ticketsFetched,
          last_run_conversations_upserted: conversationsUpserted,
          last_run_messages_upserted: messagesUpserted,
          last_run_failed_tickets: failedTickets,
          last_run_error: lastError
        })
        .eq('source', 'tickets');
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`Sync completed in ${elapsed}ms: ${ticketsFetched} tickets, ${conversationsUpserted} conversations, ${messagesUpserted} messages, ${failedTickets} failed`);
    
    return new Response(
      JSON.stringify({
        success: true,
        ticketsFetched,
        conversationsUpserted,
        messagesUpserted,
        failedTickets,
        cursorAdvanced: maxCursor > state.cursor_hs_lastmodified_ms,
        newCursor: maxCursor,
        elapsedMs: elapsed
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Sync error:', err.message);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        ticketsFetched,
        conversationsUpserted,
        messagesUpserted,
        failedTickets
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
