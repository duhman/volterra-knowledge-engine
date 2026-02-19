#!/usr/bin/env tsx
/**
 * Test script to verify Slack channel sync Edge Function environment variables
 * 
 * Usage:
 *   tsx src/scripts/test-slack-sync-env.ts
 * 
 * This script tests the slack-channel-sync Edge Function to verify:
 * - Environment variables are set correctly
 * - Edge Function is accessible
 * - Authentication works
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  console.error('   Set these in your .env file or environment');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
}

async function testEdgeFunctionEnv(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  console.log('🧪 Testing Slack Channel Sync Edge Function Environment Variables\n');
  console.log('This script verifies that required environment variables are set in Supabase.\n');
  console.log('Required Edge Function secrets:');
  console.log('  - SLACK_USER_TOKEN (xoxp-... with channels:history scope)');
  console.log('  - OPENAI_API_KEY');
  console.log('  - CRON_SECRET (should match Vault cron_secret)\n');
  console.log('─'.repeat(60));
  console.log('');

  // Test 1: Check if Edge Function exists and is accessible
  try {
    const functionUrl = `${SUPABASE_URL}/functions/v1/slack-channel-sync`;
    
    // Make a test request without auth (should fail with 401 or show env var errors)
    const testResponse = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel_id: 'C05FA8B5YPM',
        lookback_hours: 1,
        max_threads: 1,
        recheck_threads: 0,
      }),
    });

    const responseText = await testResponse.text();
    let responseJson: any = {};
    
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      // Not JSON, that's okay
    }

    if (testResponse.status === 401) {
      results.push({
        name: 'Edge Function Access',
        status: 'pass',
        message: 'Edge Function is accessible (401 Unauthorized expected without cron secret)',
      });
    } else if (testResponse.status === 500) {
      // Check error message for missing env vars
      const errorMsg = responseJson.error || responseText;
      
      if (errorMsg.includes('SLACK_USER_TOKEN not configured')) {
        results.push({
          name: 'SLACK_USER_TOKEN',
          status: 'fail',
          message: '❌ Missing: SLACK_USER_TOKEN environment variable',
        });
      } else if (errorMsg.includes('OPENAI_API_KEY not configured')) {
        results.push({
          name: 'OPENAI_API_KEY',
          status: 'fail',
          message: '❌ Missing: OPENAI_API_KEY environment variable',
        });
      } else {
        results.push({
          name: 'Edge Function Error',
          status: 'warning',
          message: `Edge Function returned error: ${errorMsg.substring(0, 200)}`,
        });
      }
    } else if (testResponse.ok) {
      results.push({
        name: 'Edge Function Access',
        status: 'pass',
        message: '✅ Edge Function is accessible and responding',
      });
    } else {
      results.push({
        name: 'Edge Function Access',
        status: 'warning',
        message: `Edge Function returned status ${testResponse.status}`,
      });
    }
  } catch (error) {
    results.push({
      name: 'Edge Function Access',
      status: 'fail',
      message: `Failed to reach Edge Function: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Test 2: Check Vault secrets (for cron invoker)
  // Note: Vault secrets are checked at SQL level, so we can't verify them directly here
  // They will be tested when the cron job runs or when manually invoking via SQL
  results.push({
    name: 'Vault Secrets',
    status: 'warning',
    message: '⚠️ Vault secrets check requires SQL access. Verify manually: SELECT name FROM vault.decrypted_secrets WHERE name IN (\'project_url\', \'service_role_key\', \'cron_secret\');',
  });

  // Test 3: Check sync state table exists
  try {
    const { data: _data, error } = await supabase
      .from('slack_channel_sync_state')
      .select('channel_id, channel_name')
      .limit(1);

    if (error) {
      results.push({
        name: 'Database Tables',
        status: 'fail',
        message: `❌ slack_channel_sync_state table error: ${error.message}`,
      });
    } else {
      results.push({
        name: 'Database Tables',
        status: 'pass',
        message: '✅ slack_channel_sync_state table exists',
      });
    }
  } catch (error) {
    results.push({
      name: 'Database Tables',
      status: 'fail',
      message: `❌ Database check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Test 4: Check cron job exists
  // Note: Cron job check requires SQL access to cron.job table
  results.push({
    name: 'Cron Job',
    status: 'warning',
    message: '⚠️ Cron job check requires SQL access. Verify manually: SELECT jobname, schedule, active FROM cron.job WHERE jobname = \'daily-slack-help-me-platform-sync\';',
  });

  return results;
}

async function main() {
  const results = await testEdgeFunctionEnv();

  console.log('\n📊 Test Results:\n');
  console.log('─'.repeat(60));

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;

  for (const result of results) {
    const icon = result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '⚠️';
    console.log(`${icon} ${result.name}`);
    console.log(`   ${result.message}\n`);

    if (result.status === 'pass') passCount++;
    else if (result.status === 'fail') failCount++;
    else warnCount++;
  }

  console.log('─'.repeat(60));
  console.log(`\nSummary: ${passCount} passed, ${warnCount} warnings, ${failCount} failed\n`);

  if (failCount > 0) {
    console.log('❌ Some tests failed. Self-host check:');
    console.log('   - Verify keys in /root/supabase/docker/.env (functions container env)');
    console.log('   - Restart: cd /root/supabase/docker && docker compose up -d functions\n');
    process.exit(1);
  } else if (warnCount > 0) {
    console.log('⚠️ Some tests had warnings. Review the output above.\n');
    process.exit(0);
  } else {
    console.log('✅ All tests passed! Environment variables are configured correctly.\n');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
