/**
 * n8n REST API Client
 * Provides full CRUD operations for n8n workflows
 */

import { config } from 'dotenv';
import { logger } from '../utils/logger.js';
import type {
  Workflow,
  WorkflowCreate,
  WorkflowUpdate,
  WorkflowListResponse,
  WorkflowFilterOptions,
  Execution,
  ExecutionListResponse,
  ExecutionFilterOptions,
  ChatExecutionInput,
  N8nApiError,
} from '../types/n8n.js';

config();

export interface N8nClientConfig {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
}

export class N8nApiClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;

  constructor(clientConfig?: Partial<N8nClientConfig>) {
    this.apiUrl = clientConfig?.apiUrl || process.env.N8N_API_URL || 'https://your-n8n-instance.example.com/api/v1';
    this.apiKey = clientConfig?.apiKey || process.env.N8N_API_KEY || '';
    this.timeout = clientConfig?.timeout || 30000;

    if (!this.apiKey) {
      throw new Error('N8N_API_KEY is required. Set it in .env or pass via config.');
    }
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;
    
    const headers: Record<string, string> = {
      'X-N8N-API-KEY': this.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      logger.debug(`${method} ${url}`);
      
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as N8nApiError;
        const message = errorData.message || `HTTP ${response.status}: ${response.statusText}`;
        logger.error(`API error: ${message}`, { status: response.status, endpoint });
        throw new Error(message);
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return await response.json() as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  // ==================== WORKFLOW OPERATIONS ====================

  /**
   * List all workflows with optional filters
   */
  async getWorkflows(options?: WorkflowFilterOptions): Promise<Workflow[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.cursor) params.append('cursor', options.cursor);
    if (options?.active !== undefined) params.append('active', options.active.toString());
    if (options?.tags) params.append('tags', options.tags);
    if (options?.name) params.append('name', options.name);

    const query = params.toString();
    const endpoint = `/workflows${query ? `?${query}` : ''}`;
    
    const response = await this.request<WorkflowListResponse>('GET', endpoint);
    return response.data;
  }

  /**
   * Get a single workflow by ID
   */
  async getWorkflow(id: string): Promise<Workflow> {
    return this.request<Workflow>('GET', `/workflows/${id}`);
  }

  /**
   * Create a new workflow
   */
  async createWorkflow(workflow: WorkflowCreate): Promise<Workflow> {
    logger.info(`Creating workflow: ${workflow.name}`);
    return this.request<Workflow>('POST', '/workflows', workflow);
  }

  /**
   * Update an existing workflow
   */
  async updateWorkflow(id: string, workflow: WorkflowUpdate): Promise<Workflow> {
    logger.info(`Updating workflow: ${id}`);
    return this.request<Workflow>('PUT', `/workflows/${id}`, workflow);
  }

  /**
   * Delete a workflow
   */
  async deleteWorkflow(id: string): Promise<void> {
    logger.info(`Deleting workflow: ${id}`);
    await this.request<void>('DELETE', `/workflows/${id}`);
  }

  /**
   * Activate a workflow
   */
  async activateWorkflow(id: string): Promise<Workflow> {
    logger.info(`Activating workflow: ${id}`);
    return this.request<Workflow>('POST', `/workflows/${id}/activate`);
  }

  /**
   * Deactivate a workflow
   */
  async deactivateWorkflow(id: string): Promise<Workflow> {
    logger.info(`Deactivating workflow: ${id}`);
    return this.request<Workflow>('POST', `/workflows/${id}/deactivate`);
  }

  /**
   * Transfer workflow to another project/user
   */
  async transferWorkflow(id: string, destinationProjectId: string): Promise<void> {
    logger.info(`Transferring workflow ${id} to project ${destinationProjectId}`);
    await this.request<void>('PUT', `/workflows/${id}/transfer`, {
      destinationProjectId,
    });
  }

  // ==================== EXECUTION OPERATIONS ====================

  /**
   * List executions with optional filters
   */
  async getExecutions(options?: ExecutionFilterOptions): Promise<Execution[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.append('limit', options.limit.toString());
    if (options?.cursor) params.append('cursor', options.cursor);
    if (options?.workflowId) params.append('workflowId', options.workflowId);
    if (options?.status) params.append('status', options.status);

    const query = params.toString();
    const endpoint = `/executions${query ? `?${query}` : ''}`;
    
    const response = await this.request<ExecutionListResponse>('GET', endpoint);
    return response.data;
  }

  /**
   * Get a single execution by ID
   */
  async getExecution(id: string): Promise<Execution> {
    return this.request<Execution>('GET', `/executions/${id}`);
  }

  /**
   * Delete an execution
   */
  async deleteExecution(id: string): Promise<void> {
    logger.info(`Deleting execution: ${id}`);
    await this.request<void>('DELETE', `/executions/${id}`);
  }

  // ==================== WORKFLOW EXECUTION ====================

  /**
   * Execute a workflow via webhook (for workflows with webhook trigger)
   */
  async executeWorkflowWebhook(
    webhookPath: string,
    data?: Record<string, unknown>,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<unknown> {
    // Webhook URLs are different from API URLs
    const baseUrl = this.apiUrl.replace('/api/v1', '');
    const url = `${baseUrl}/webhook/${webhookPath}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: method === 'POST' && data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Webhook execution failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Execute a chat-based workflow (AI agents)
   */
  async executeChatWorkflow(
    workflowId: string,
    chatInput: string,
    sessionId?: string
  ): Promise<unknown> {
    // Chat workflows use a special endpoint
    const baseUrl = this.apiUrl.replace('/api/v1', '');
    const url = `${baseUrl}/webhook/${workflowId}/chat`;

    const body: ChatExecutionInput & { sessionId?: string } = {
      chatInput,
    };
    if (sessionId) {
      body.sessionId = sessionId;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Chat execution failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Test API connection
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.getWorkflows({ limit: 1 });
      logger.info('n8n API connection successful');
      return true;
    } catch (error) {
      logger.error('n8n API connection failed', { error });
      return false;
    }
  }

  /**
   * Export workflow to JSON
   */
  async exportWorkflow(id: string): Promise<string> {
    const workflow = await this.getWorkflow(id);
    return JSON.stringify(workflow, null, 2);
  }

  /**
   * Import workflow from JSON
   */
  async importWorkflow(json: string, activate = false): Promise<Workflow> {
    const workflowData = JSON.parse(json) as WorkflowCreate & { id?: string };
    // Remove ID if present (to create as new)
    delete workflowData.id;
    
    const workflow = await this.createWorkflow({
      ...workflowData,
      active: activate,
    });

    return workflow;
  }

  /**
   * Clone an existing workflow
   */
  async cloneWorkflow(id: string, newName: string): Promise<Workflow> {
    const original = await this.getWorkflow(id);
    
    const clone: WorkflowCreate = {
      name: newName,
      nodes: original.nodes,
      connections: original.connections,
      settings: original.settings,
      staticData: original.staticData,
      active: false, // Always create as inactive
    };

    return this.createWorkflow(clone);
  }
}

// Singleton instance for convenience
let defaultClient: N8nApiClient | null = null;

export function getN8nClient(clientConfig?: Partial<N8nClientConfig>): N8nApiClient {
  if (!defaultClient) {
    defaultClient = new N8nApiClient(clientConfig);
  }
  return defaultClient;
}

export default N8nApiClient;
