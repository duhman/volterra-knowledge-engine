/**
 * n8n API Types
 * Based on n8n REST API v1
 */

// Node position in the workflow editor
export interface NodePosition {
  x: number;
  y: number;
}

// Node parameters - flexible object for node-specific config
export type NodeParameters = Record<string, unknown>;

// Workflow node definition
export interface WorkflowNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters: NodeParameters;
  credentials?: Record<string, { id: string; name: string }>;
  webhookId?: string;
  disabled?: boolean;
  continueOnFail?: boolean;
}

// Connection endpoint
export interface ConnectionEndpoint {
  node: string;
  type: string;
  index: number;
}

// Connections between nodes
export interface WorkflowConnections {
  [nodeName: string]: {
    [outputType: string]: ConnectionEndpoint[][];
  };
}

// Workflow settings
export interface WorkflowSettings {
  executionOrder?: 'v0' | 'v1';
  saveDataErrorExecution?: 'all' | 'none';
  saveDataSuccessExecution?: 'all' | 'none';
  saveManualExecutions?: boolean;
  callerPolicy?: 'any' | 'none' | 'workflowsFromAList' | 'workflowsFromSameOwner';
  errorWorkflow?: string;
  timezone?: string;
  executionTimeout?: number;
  availableInMCP?: boolean;
  timeSavedMode?: string;
}

// Tag reference
export interface WorkflowTag {
  id: string;
  name: string;
}

// Full workflow object returned from API
export interface Workflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnections;
  settings?: WorkflowSettings;
  staticData?: Record<string, unknown>;
  tags?: WorkflowTag[];
  triggerCount?: number;
  versionId?: string;
  isArchived?: boolean;
  meta?: {
    templateId?: string;
    templateCredsSetupCompleted?: boolean;
  };
  parentFolderId?: string | null;
}

// Workflow creation payload
export interface WorkflowCreate {
  name: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnections;
  settings?: WorkflowSettings;
  staticData?: Record<string, unknown>;
  active?: boolean;
}

// Workflow update payload
export interface WorkflowUpdate {
  name?: string;
  nodes?: WorkflowNode[];
  connections?: WorkflowConnections;
  settings?: WorkflowSettings;
  staticData?: Record<string, unknown>;
  active?: boolean;
}

// Workflow list response
export interface WorkflowListResponse {
  data: Workflow[];
  nextCursor?: string;
}

// Execution status
export type ExecutionStatus = 'new' | 'running' | 'success' | 'error' | 'canceled' | 'waiting';

// Execution mode
export type ExecutionMode = 'cli' | 'error' | 'integrated' | 'internal' | 'manual' | 'retry' | 'trigger' | 'webhook';

// Execution data for a node
export interface NodeExecutionData {
  startTime: number;
  executionTime: number;
  source?: Array<{ previousNode: string }>;
  executionStatus?: string;
  data?: {
    main?: Array<Array<{ json: Record<string, unknown>; binary?: Record<string, unknown> }>>;
  };
}

// Execution result data
export interface ExecutionResultData {
  runData?: Record<string, NodeExecutionData[]>;
  lastNodeExecuted?: string;
}

// Full execution object
export interface Execution {
  id: string;
  finished: boolean;
  mode: ExecutionMode;
  retryOf?: string | null;
  retrySuccessId?: string | null;
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
  data?: ExecutionResultData;
  status: ExecutionStatus;
  workflowData?: Workflow;
}

// Execution list response
export interface ExecutionListResponse {
  data: Execution[];
  nextCursor?: string;
}

// Webhook execution input
export interface WebhookExecutionInput {
  workflowId: string;
  data?: Record<string, unknown>;
}

// Chat execution input (for AI agent workflows)
export interface ChatExecutionInput {
  chatInput: string;
}

// Form execution input
export interface FormExecutionInput {
  formData: Record<string, unknown>;
}

// Credential reference
export interface CredentialReference {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
}

// API error response
export interface N8nApiError {
  code?: number;
  message: string;
  hint?: string;
  stackTrace?: string;
}

// Pagination options
export interface PaginationOptions {
  limit?: number;
  cursor?: string;
}

// Workflow filter options
export interface WorkflowFilterOptions extends PaginationOptions {
  active?: boolean;
  tags?: string;
  name?: string;
}

// Execution filter options
export interface ExecutionFilterOptions extends PaginationOptions {
  workflowId?: string;
  status?: ExecutionStatus;
}
