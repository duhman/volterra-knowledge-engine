#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { N8nApiClient } from '../services/n8n-api-client.js';
import { logger } from '../utils/logger.js';

const program = new Command();
const client = new N8nApiClient();

program
  .name('n8n')
  .description('n8n workflow management CLI')
  .version('1.0.0');

// List workflows
program
  .command('list')
  .description('List all workflows')
  .option('-a, --active', 'Show only active workflows')
  .option('-i, --inactive', 'Show only inactive workflows')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const active = opts.active ? true : opts.inactive ? false : undefined;
      const workflows = await client.getWorkflows({ active });

      if (opts.json) {
        console.log(JSON.stringify(workflows, null, 2));
        return;
      }

      console.log(`\nFound ${workflows.length} workflow(s):\n`);
      for (const wf of workflows) {
        const status = wf.active ? '[ACTIVE]' : '[INACTIVE]';
        console.log(`  ${status} ${wf.id} - ${wf.name}`);
      }
      console.log();
    } catch (error) {
      logger.error('Failed to list workflows', { error });
      process.exit(1);
    }
  });

// Get workflow details
program
  .command('get <id>')
  .description('Get workflow details')
  .option('--json', 'Output as JSON')
  .action(async (id: string, opts) => {
    try {
      const workflow = await client.getWorkflow(id);

      if (opts.json) {
        console.log(JSON.stringify(workflow, null, 2));
        return;
      }

      console.log(`\nWorkflow: ${workflow.name}`);
      console.log(`  ID: ${workflow.id}`);
      console.log(`  Active: ${workflow.active}`);
      console.log(`  Created: ${workflow.createdAt}`);
      console.log(`  Updated: ${workflow.updatedAt}`);
      console.log(`  Nodes: ${workflow.nodes.length}`);
      console.log(`  Node Types:`);
      for (const node of workflow.nodes) {
        console.log(`    - ${node.name} (${node.type})`);
      }
      console.log();
    } catch (error) {
      logger.error('Failed to get workflow', { error });
      process.exit(1);
    }
  });

// Create workflow from JSON file
program
  .command('create <json-file>')
  .description('Create workflow from JSON file')
  .option('-a, --activate', 'Activate after creation')
  .action(async (jsonFile: string, opts) => {
    try {
      const json = await readFile(jsonFile, 'utf-8');
      const workflow = await client.importWorkflow(json, opts.activate);
      
      console.log(`\nWorkflow created successfully!`);
      console.log(`  ID: ${workflow.id}`);
      console.log(`  Name: ${workflow.name}`);
      console.log(`  Active: ${workflow.active}`);
      console.log();
    } catch (error) {
      logger.error('Failed to create workflow', { error });
      process.exit(1);
    }
  });

// Update workflow from JSON file
program
  .command('update <id> <json-file>')
  .description('Update workflow from JSON file')
  .action(async (id: string, jsonFile: string) => {
    try {
      const json = await readFile(jsonFile, 'utf-8');
      const data = JSON.parse(json);
      const workflow = await client.updateWorkflow(id, data);
      
      console.log(`\nWorkflow updated successfully!`);
      console.log(`  ID: ${workflow.id}`);
      console.log(`  Name: ${workflow.name}`);
      console.log(`  Active: ${workflow.active}`);
      console.log();
    } catch (error) {
      logger.error('Failed to update workflow', { error });
      process.exit(1);
    }
  });

// Delete workflow
program
  .command('delete <id>')
  .description('Delete a workflow')
  .option('-f, --force', 'Skip confirmation')
  .action(async (id: string, opts) => {
    try {
      if (!opts.force) {
        const workflow = await client.getWorkflow(id);
        console.log(`\nAbout to delete workflow: ${workflow.name} (${id})`);
        console.log('Use --force to skip this confirmation');
        process.exit(0);
      }

      await client.deleteWorkflow(id);
      console.log(`\nWorkflow ${id} deleted successfully!`);
    } catch (error) {
      logger.error('Failed to delete workflow', { error });
      process.exit(1);
    }
  });

// Activate workflow
program
  .command('activate <id>')
  .description('Activate a workflow')
  .action(async (id: string) => {
    try {
      const workflow = await client.activateWorkflow(id);
      console.log(`\nWorkflow "${workflow.name}" activated!`);
    } catch (error) {
      logger.error('Failed to activate workflow', { error });
      process.exit(1);
    }
  });

// Deactivate workflow
program
  .command('deactivate <id>')
  .description('Deactivate a workflow')
  .action(async (id: string) => {
    try {
      const workflow = await client.deactivateWorkflow(id);
      console.log(`\nWorkflow "${workflow.name}" deactivated!`);
    } catch (error) {
      logger.error('Failed to deactivate workflow', { error });
      process.exit(1);
    }
  });

// Export workflow to JSON file
program
  .command('export <id> [output-file]')
  .description('Export workflow to JSON file')
  .action(async (id: string, outputFile?: string) => {
    try {
      const workflow = await client.getWorkflow(id);
      const json = JSON.stringify(workflow, null, 2);
      
      if (outputFile) {
        await writeFile(outputFile, json, 'utf-8');
        console.log(`\nWorkflow exported to: ${outputFile}`);
      } else {
        console.log(json);
      }
    } catch (error) {
      logger.error('Failed to export workflow', { error });
      process.exit(1);
    }
  });

// Import workflow from JSON file (alias for create)
program
  .command('import <json-file>')
  .description('Import workflow from JSON file')
  .option('-a, --activate', 'Activate after import')
  .action(async (jsonFile: string, opts) => {
    try {
      const json = await readFile(jsonFile, 'utf-8');
      const workflow = await client.importWorkflow(json, opts.activate);
      
      console.log(`\nWorkflow imported successfully!`);
      console.log(`  ID: ${workflow.id}`);
      console.log(`  Name: ${workflow.name}`);
      console.log(`  Active: ${workflow.active}`);
      console.log();
    } catch (error) {
      logger.error('Failed to import workflow', { error });
      process.exit(1);
    }
  });

// Clone workflow
program
  .command('clone <id> <new-name>')
  .description('Clone an existing workflow with a new name')
  .action(async (id: string, newName: string) => {
    try {
      const workflow = await client.cloneWorkflow(id, newName);
      
      console.log(`\nWorkflow cloned successfully!`);
      console.log(`  New ID: ${workflow.id}`);
      console.log(`  Name: ${workflow.name}`);
      console.log(`  Active: ${workflow.active}`);
      console.log();
    } catch (error) {
      logger.error('Failed to clone workflow', { error });
      process.exit(1);
    }
  });

// Test connection
program
  .command('test')
  .description('Test n8n API connection')
  .action(async () => {
    try {
      const success = await client.testConnection();
      if (success) {
        console.log('\nn8n API connection: OK');
        const workflows = await client.getWorkflows({ limit: 5 });
        console.log(`Found ${workflows.length} workflow(s)`);
      } else {
        console.log('\nn8n API connection: FAILED');
        process.exit(1);
      }
    } catch (error) {
      logger.error('Connection test failed', { error });
      process.exit(1);
    }
  });

// List executions
program
  .command('executions [workflow-id]')
  .description('List recent executions')
  .option('-l, --limit <n>', 'Number of executions to show', '10')
  .option('--status <status>', 'Filter by status (success, error, waiting, etc.)')
  .option('--json', 'Output as JSON')
  .action(async (workflowId: string | undefined, opts) => {
    try {
      const executions = await client.getExecutions({
        workflowId,
        limit: parseInt(opts.limit, 10),
        status: opts.status,
      });

      if (opts.json) {
        console.log(JSON.stringify(executions, null, 2));
        return;
      }

      console.log(`\nFound ${executions.length} execution(s):\n`);
      for (const exec of executions) {
        const status = exec.status.toUpperCase().padEnd(10);
        const date = new Date(exec.startedAt).toLocaleString();
        console.log(`  [${status}] ${exec.id} - ${date} (workflow: ${exec.workflowId})`);
      }
      console.log();
    } catch (error) {
      logger.error('Failed to list executions', { error });
      process.exit(1);
    }
  });

// Patch Supabase URLs in workflows (migrate from *.supabase.co to self-hosted)
program
  .command('patch-supabase')
  .description('Patch workflow Supabase URLs from *.supabase.co to self-hosted SUPABASE_URL')
  .option('-w, --workflow <id>', 'Workflow ID to patch (can be used multiple times)', (val, prev: string[]) => [...prev, val], [])
  .option('--supabase-url <url>', 'Target Supabase URL', process.env.SUPABASE_URL || 'https://srv1209224.hstgr.cloud')
  .option('--dry-run', 'Show changes without applying them')
  .action(async (opts) => {
    try {
      const workflowIds: string[] = opts.workflow;
      const targetUrl = opts.supabaseUrl;
      const dryRun = opts.dryRun || false;
      
      if (workflowIds.length === 0) {
        console.error('Error: At least one --workflow <id> is required');
        process.exit(1);
      }
      
      if (!targetUrl) {
        console.error('Error: SUPABASE_URL env var or --supabase-url is required');
        process.exit(1);
      }
      
      console.log(`\nPatching ${workflowIds.length} workflow(s) to use: ${targetUrl}`);
      if (dryRun) console.log('  (DRY RUN - no changes will be saved)\n');
      else console.log();
      
      // Regex to match any *.supabase.co URL (cloud instances)
      const supabaseCloudPattern = /https:\/\/[a-z0-9-]+\.supabase\.co/gi;
      
      for (const workflowId of workflowIds) {
        console.log(`Processing workflow: ${workflowId}`);
        
        const workflow = await client.getWorkflow(workflowId);
        console.log(`  Name: ${workflow.name}`);
        console.log(`  Nodes: ${workflow.nodes.length}`);
        
        let modified = false;
        const patchedNodes = workflow.nodes.map((node) => {
          // Only patch HTTP Request Tool nodes
          if (node.type !== 'n8n-nodes-base.httpRequestTool') {
            return node;
          }
          
          const params = node.parameters as Record<string, unknown> | undefined;
          if (!params) return node;
          
          // Check if URL contains supabase.co
          const url = params.url as string | undefined;
          if (url && supabaseCloudPattern.test(url)) {
            const newUrl = url.replace(supabaseCloudPattern, targetUrl);
            console.log(`  [PATCH] ${node.name}`);
            console.log(`    URL: ${url.slice(0, 60)}...`);
            console.log(`     -> ${newUrl.slice(0, 60)}...`);
            params.url = newUrl;
            modified = true;
          }
          
          // Remove Authorization headers - let n8n credential (apikey header) handle auth
          const headerParams = params.headerParameters as { parameters?: Array<{ name: string; value: string }> } | undefined;
          if (headerParams?.parameters) {
            const originalLength = headerParams.parameters.length;
            headerParams.parameters = headerParams.parameters.filter(
              (header) => header.name?.toLowerCase() !== 'authorization'
            );
            if (headerParams.parameters.length < originalLength) {
              console.log(`  [AUTH] ${node.name} - Removed Authorization header (using credential instead)`);
              modified = true;
            }
          }
          
          return node;
        });
        
        if (modified && !dryRun) {
          console.log(`  Saving workflow...`);
          
          // Clean settings to only include valid n8n API properties
          const cleanSettings: Record<string, unknown> = {};
          if (workflow.settings?.executionOrder) cleanSettings.executionOrder = workflow.settings.executionOrder;
          if (workflow.settings?.saveDataErrorExecution) cleanSettings.saveDataErrorExecution = workflow.settings.saveDataErrorExecution;
          if (workflow.settings?.saveDataSuccessExecution) cleanSettings.saveDataSuccessExecution = workflow.settings.saveDataSuccessExecution;
          if (workflow.settings?.saveManualExecutions !== undefined) cleanSettings.saveManualExecutions = workflow.settings.saveManualExecutions;
          if (workflow.settings?.callerPolicy) cleanSettings.callerPolicy = workflow.settings.callerPolicy;
          if (workflow.settings?.errorWorkflow) cleanSettings.errorWorkflow = workflow.settings.errorWorkflow;
          if (workflow.settings?.timezone) cleanSettings.timezone = workflow.settings.timezone;
          // Preserve MCP availability setting
          if ((workflow.settings as Record<string, unknown>)?.availableInMCP !== undefined) {
            cleanSettings.availableInMCP = (workflow.settings as Record<string, unknown>).availableInMCP;
          }
          
          await client.updateWorkflow(workflowId, {
            name: workflow.name,
            nodes: patchedNodes,
            connections: workflow.connections,
            settings: cleanSettings,
            staticData: workflow.staticData,
          });
          console.log(`  Saved!`);
        } else if (modified) {
          console.log(`  (Would save - dry run)`);
        } else {
          console.log(`  No changes needed`);
        }
        console.log();
      }
      
      console.log('Done!');
    } catch (error) {
      logger.error('Failed to patch workflows', { error });
      process.exit(1);
    }
  });

program.parse();
