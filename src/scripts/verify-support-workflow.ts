#!/usr/bin/env npx tsx
/**
 * Verify #help-me-platform Support Workflow
 *
 * Checks the AI agent support workflow (UtsHZSFSpXa6arFN) configuration:
 * - Workflow active status
 * - Slack trigger channel
 * - AI Agent system prompt
 * - Search tool configurations (match thresholds, result counts)
 * - Memory configuration
 * - Issue classifier rules
 *
 * Usage: npm run verify:support-workflow
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";
import type { Workflow, WorkflowNode } from "../types/n8n.js";

config();

const WORKFLOW_ID = "UtsHZSFSpXa6arFN"; // AI agent support - Slack
const EXPECTED_CHANNEL = "C05FA8B5YPM"; // #help-me-platform

interface VerificationResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: Record<string, unknown>;
}

interface WorkflowAnalysis {
  workflow: Workflow;
  results: VerificationResult[];
  summary: {
    passes: number;
    warnings: number;
    failures: number;
  };
}

function checkWorkflowActive(workflow: Workflow): VerificationResult {
  return {
    name: "Workflow Active",
    status: workflow.active ? "pass" : "fail",
    message: workflow.active
      ? "Workflow is active and listening for messages"
      : "Workflow is INACTIVE - messages will not be processed",
    details: { active: workflow.active },
  };
}

function checkSlackTrigger(workflow: Workflow): VerificationResult {
  const triggerNode = workflow.nodes.find(
    (n) => n.type === "n8n-nodes-base.slackTrigger",
  );

  if (!triggerNode) {
    return {
      name: "Slack Trigger",
      status: "fail",
      message: "No Slack Trigger node found",
    };
  }

  const channelId =
    (triggerNode.parameters.channelId as { value?: string })?.value || "";
  const triggerType = triggerNode.parameters.trigger as string[] | undefined;

  const isCorrectChannel = channelId === EXPECTED_CHANNEL;
  const isMessageTrigger = triggerType?.includes("message.channels");

  if (!isCorrectChannel) {
    return {
      name: "Slack Trigger",
      status: "fail",
      message: `Wrong channel: ${channelId} (expected ${EXPECTED_CHANNEL})`,
      details: { channelId, triggerType },
    };
  }

  if (!isMessageTrigger) {
    return {
      name: "Slack Trigger",
      status: "warn",
      message: `Trigger type: ${triggerType?.join(", ")} (expected message.channels)`,
      details: { channelId, triggerType },
    };
  }

  return {
    name: "Slack Trigger",
    status: "pass",
    message: "Listening to #help-me-platform (C05FA8B5YPM) for messages",
    details: { channelId, triggerType },
  };
}

function checkFilterIncoming(workflow: Workflow): VerificationResult {
  const filterNode = workflow.nodes.find((n) => n.name === "Filter Incoming");

  if (!filterNode) {
    return {
      name: "Filter Incoming",
      status: "fail",
      message: "No Filter Incoming node found - may respond to bot messages",
    };
  }

  const code = filterNode.parameters.jsCode as string | undefined;
  const filtersBots = code?.includes("bot_id") || code?.includes("bot_message");
  const filtersThreads = code?.includes("thread_ts");

  if (!filtersBots || !filtersThreads) {
    return {
      name: "Filter Incoming",
      status: "warn",
      message:
        `Missing filters: ${!filtersBots ? "bot messages" : ""} ${!filtersThreads ? "thread replies" : ""}`.trim(),
      details: { filtersBots, filtersThreads },
    };
  }

  return {
    name: "Filter Incoming",
    status: "pass",
    message: "Filters bot messages and thread replies to prevent loops",
    details: { filtersBots, filtersThreads },
  };
}

function checkIssueClassifier(workflow: Workflow): VerificationResult {
  const classifierNode = workflow.nodes.find(
    (n) => n.name === "Issue Classifier",
  );

  if (!classifierNode) {
    return {
      name: "Issue Classifier",
      status: "warn",
      message: "No Issue Classifier node - messages won't be auto-tagged",
    };
  }

  const code = classifierNode.parameters.jsCode as string | undefined;
  const subcategories = (code?.match(/sub: '([^']+)'/g) || []).map((m) =>
    m.replace("sub: '", "").replace("'", ""),
  );

  return {
    name: "Issue Classifier",
    status: "pass",
    message: `Auto-tags ${subcategories.length} subcategories`,
    details: { subcategories },
  };
}

function checkMemory(workflow: Workflow): VerificationResult {
  const memoryNode = workflow.nodes.find(
    (n) =>
      n.type === "@n8n/n8n-nodes-langchain.memoryBufferWindow" ||
      n.type.includes("memory"),
  );

  if (!memoryNode) {
    return {
      name: "Memory",
      status: "warn",
      message: "No memory node - each message treated independently",
    };
  }

  const sessionKey = memoryNode.parameters.sessionKey as string | undefined;
  const contextWindow = memoryNode.parameters.contextWindowLength as
    | number
    | undefined;

  const usesThreadKey =
    sessionKey?.includes("thread_ts") || sessionKey?.includes("session_key");

  return {
    name: "Memory",
    status: usesThreadKey ? "pass" : "warn",
    message: usesThreadKey
      ? `Thread-based memory (${contextWindow || "default"} messages)`
      : "Memory key may not be thread-specific",
    details: { sessionKey, contextWindowLength: contextWindow },
  };
}

function checkSearchTools(workflow: Workflow): VerificationResult[] {
  const results: VerificationResult[] = [];

  const vectorStores = workflow.nodes.filter(
    (n) => n.type === "@n8n/n8n-nodes-langchain.vectorStoreSupabase",
  );

  const expectedTools = [
    {
      name: "Documents",
      rpc: "match_documents",
      minK: 5,
    },
    {
      name: "Slack Messages",
      rpc: "match_slack_messages",
      minK: 5,
    },
    {
      name: "Training Conversations",
      rpc: "match_training_conversations",
      minK: 3,
    },
  ];

  for (const expected of expectedTools) {
    const node = vectorStores.find((n) => {
      const table = n.parameters.tableName as { value?: string } | undefined;
      return table?.value?.includes(expected.rpc);
    });

    if (!node) {
      results.push({
        name: `Search: ${expected.name}`,
        status: "fail",
        message: `Missing ${expected.rpc} vector store tool`,
      });
      continue;
    }

    const topK = (node.parameters.topK as number) || 10;
    const mode = node.parameters.mode as string | undefined;

    results.push({
      name: `Search: ${expected.name}`,
      status: topK >= expected.minK ? "pass" : "warn",
      message: `${topK} results (mode: ${mode || "default"})`,
      details: { topK, mode, nodeName: node.name },
    });
  }

  return results;
}

function checkAIAgent(workflow: Workflow): VerificationResult {
  const agentNode = workflow.nodes.find(
    (n) => n.type === "@n8n/n8n-nodes-langchain.agent",
  );

  if (!agentNode) {
    return {
      name: "AI Agent",
      status: "fail",
      message: "No AI Agent node found",
    };
  }

  const options = agentNode.parameters.options as
    | {
        systemMessage?: string;
      }
    | undefined;
  const systemPrompt = options?.systemMessage || "";

  const checks = {
    hasSlackFormatting: systemPrompt.includes("SLACK MESSAGE FORMATTING"),
    hasResolutionGuidance:
      systemPrompt.includes("resolution") || systemPrompt.includes("resolved"),
    hasSourceAttribution:
      systemPrompt.includes("source") || systemPrompt.includes("cite"),
    hasConciseness:
      systemPrompt.includes("concise") || systemPrompt.includes("12 lines"),
    hasAutoTagContext: systemPrompt.includes("Auto-tag"),
  };

  const missing = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  return {
    name: "AI Agent",
    status:
      missing.length === 0 ? "pass" : missing.length <= 2 ? "warn" : "fail",
    message:
      missing.length === 0
        ? "System prompt includes all recommended sections"
        : `Missing guidance: ${missing.join(", ")}`,
    details: {
      promptLength: systemPrompt.length,
      ...checks,
    },
  };
}

function checkSlackFormatter(workflow: Workflow): VerificationResult {
  const formatterNode = workflow.nodes.find(
    (n) => n.name === "Slack Formatter",
  );

  if (!formatterNode) {
    return {
      name: "Slack Formatter",
      status: "fail",
      message: "No Slack Formatter node - **bold** may render literally",
    };
  }

  const code = formatterNode.parameters.jsCode as string | undefined;
  const convertsBold = code?.includes("\\*\\*");
  const convertsLinks = code?.includes("\\[");

  return {
    name: "Slack Formatter",
    status: convertsBold ? "pass" : "warn",
    message: convertsBold
      ? "Converts Markdown to Slack mrkdwn"
      : "May not convert all Markdown syntax",
    details: { convertsBold, convertsLinks },
  };
}

function checkSlackResponse(workflow: Workflow): VerificationResult {
  const responseNode = workflow.nodes.find(
    (n) => n.name === "Slack Response" && n.type === "n8n-nodes-base.slack",
  );

  if (!responseNode) {
    return {
      name: "Slack Response",
      status: "fail",
      message: "No Slack Response node found",
    };
  }

  const options = responseNode.parameters.otherOptions as
    | {
        thread_ts?: unknown;
      }
    | undefined;
  const usesThreading = options?.thread_ts !== undefined;

  return {
    name: "Slack Response",
    status: usesThreading ? "pass" : "warn",
    message: usesThreading
      ? "Replies in thread to original message"
      : "May not reply in thread",
    details: { usesThreading },
  };
}

function checkConnections(workflow: Workflow): VerificationResult {
  // Correct order: Filter runs BEFORE Extract to access raw Slack event (bot_id, blocks)
  const expectedFlow = [
    "Slack Trigger",
    "Filter Incoming",
    "Extract Message",
    "Issue Classifier",
    "Prepare AI Input",
    "AI Agent",
    "Slack Formatter",
    "Slack Response",
  ];

  const mainConnections = workflow.connections;
  const missing: string[] = [];

  for (let i = 0; i < expectedFlow.length - 1; i++) {
    const from = expectedFlow[i];
    const to = expectedFlow[i + 1];

    const fromConnections = mainConnections[from]?.main?.[0] || [];
    const hasConnection = fromConnections.some((c) => c.node === to);

    if (!hasConnection) {
      missing.push(`${from} → ${to}`);
    }
  }

  return {
    name: "Node Connections",
    status: missing.length === 0 ? "pass" : "fail",
    message:
      missing.length === 0
        ? "All main flow connections present"
        : `Missing connections: ${missing.join(", ")}`,
    details: { expectedFlow, missing },
  };
}

async function analyzeWorkflow(): Promise<WorkflowAnalysis> {
  const apiUrl =
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1";
  const apiKey = process.env.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY environment variable is required");
  }

  logger.info(`Fetching workflow ${WORKFLOW_ID}...`);

  const response = await fetch(`${apiUrl}/workflows/${WORKFLOW_ID}`, {
    headers: {
      "X-N8N-API-KEY": apiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to get workflow: ${response.status} ${response.statusText}`,
    );
  }

  const workflow = (await response.json()) as Workflow;

  const results: VerificationResult[] = [
    checkWorkflowActive(workflow),
    checkSlackTrigger(workflow),
    checkFilterIncoming(workflow),
    checkIssueClassifier(workflow),
    checkMemory(workflow),
    ...checkSearchTools(workflow),
    checkAIAgent(workflow),
    checkSlackFormatter(workflow),
    checkSlackResponse(workflow),
    checkConnections(workflow),
  ];

  const summary = {
    passes: results.filter((r) => r.status === "pass").length,
    warnings: results.filter((r) => r.status === "warn").length,
    failures: results.filter((r) => r.status === "fail").length,
  };

  return { workflow, results, summary };
}

function printResults(analysis: WorkflowAnalysis): void {
  const { workflow, results, summary } = analysis;

  console.log("\n" + "=".repeat(60));
  console.log(`WORKFLOW: ${workflow.name}`);
  console.log(`ID: ${workflow.id}`);
  console.log(`Updated: ${workflow.updatedAt}`);
  console.log("=".repeat(60) + "\n");

  for (const result of results) {
    const icon =
      result.status === "pass" ? "✅" : result.status === "warn" ? "⚠️" : "❌";
    console.log(`${icon} ${result.name}`);
    console.log(`   ${result.message}`);
    if (result.details && Object.keys(result.details).length > 0) {
      const detailStr = JSON.stringify(result.details, null, 2)
        .split("\n")
        .map((line) => `   ${line}`)
        .join("\n");
      console.log(detailStr);
    }
    console.log();
  }

  console.log("=".repeat(60));
  console.log(
    `SUMMARY: ${summary.passes} passed, ${summary.warnings} warnings, ${summary.failures} failures`,
  );
  console.log("=".repeat(60) + "\n");

  if (summary.failures > 0) {
    console.log(
      "🔴 ACTION REQUIRED: Fix the failures above before the workflow will function correctly.\n",
    );
  } else if (summary.warnings > 0) {
    console.log(
      "🟡 RECOMMENDATIONS: Consider addressing the warnings for optimal performance.\n",
    );
  } else {
    console.log("🟢 WORKFLOW HEALTHY: All checks passed!\n");
  }
}

async function main(): Promise<void> {
  try {
    const analysis = await analyzeWorkflow();
    printResults(analysis);

    // Exit with error code if there are failures
    if (analysis.summary.failures > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error("Verification failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  }
}

main();
