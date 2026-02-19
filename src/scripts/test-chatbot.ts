#!/usr/bin/env npx tsx
/**
 * Test script to validate the Elacare chatbot with common customer questions
 */

import { config } from "dotenv";
import { logger } from "../utils/logger.js";

config();

interface TestQuestion {
  category: string;
  question: string;
  expectedTopics: string[];
}

const TEST_QUESTIONS: TestQuestion[] = [
  {
    category: "Norgespris",
    question: "Hva er Norgespris og hvordan bestiller jeg det?",
    expectedTopics: [
      "norgespris",
      "40 øre",
      "Elhub",
      "styrepost@volterra.example.com",
    ],
  },
  {
    category: "App - Login",
    question: "Jeg har glemt passordet mitt i appen, hva gjor jeg?",
    expectedTopics: ["glemt passord", "e-post", "tilbakestill"],
  },
  {
    category: "App - RFID",
    question: "Hvordan bestiller jeg ladebrikke?",
    expectedTopics: ["ladebrikke", "gratis", "bestillingsskjema"],
  },
  {
    category: "Subscription Transfer",
    question:
      "Jeg har solgt boligen min. Hvordan overforer jeg abonnementet til ny eier?",
    expectedTopics: ["si opp", "serienummer", "ny eier", "bestill"],
  },
  {
    category: "Troubleshooting - Red Light",
    question: "Easee laderen min lyser rodt, hva betyr det?",
    expectedTopics: ["feil", "koble fra", "30 sekunder", "koble til"],
  },
  {
    category: "Troubleshooting - Cable Stuck",
    question:
      "Ladekabelen sitter fast i ladestasjonen. Hvordan losner jeg den?",
    expectedTopics: ["trykk", "skyv", "dra", "ladehjelp"],
  },
  {
    category: "Pricing",
    question: "Hvordan beregnes strompris for lading?",
    expectedTopics: ["spotpris", "paslag", "Norgespris"],
  },
  {
    category: "App - Settings",
    question: "Hvordan endrer jeg sprak i Volterra-appen?",
    expectedTopics: ["Innstillinger", "sprak", "velg"],
  },
  {
    category: "Cancellation",
    question: "Hvordan sier jeg opp abonnementet mitt?",
    expectedTopics: ["Administrer Abonnement", "Avslutt", "1 maned"],
  },
  {
    category: "Human Agent",
    question: "Jeg vil snakke med et menneske",
    expectedTopics: ["00 00 00 00", "24/7", "kontaktskjema"],
  },
];

async function testChatbot(): Promise<void> {
  const n8nBaseUrl = (
    process.env.N8N_API_URL || "https://your-n8n-instance.example.com/api/v1"
  ).replace("/api/v1", "");
  const workflowId = "YOUR_WORKFLOW_ID";
  const chatUrl = `${n8nBaseUrl}/webhook/${workflowId}/chat`;

  logger.info("Starting chatbot validation tests...");
  logger.info(`Chat endpoint: ${chatUrl}`);

  const results: {
    category: string;
    passed: boolean;
    response: string;
    missingTopics: string[];
  }[] = [];

  for (const test of TEST_QUESTIONS) {
    logger.info(`Testing: ${test.category} - "${test.question}"`);

    try {
      const response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          chatInput: test.question,
          sessionId: `test-${Date.now()}`,
        }),
      });

      if (!response.ok) {
        logger.error(
          `Request failed: ${response.status} ${response.statusText}`,
        );
        results.push({
          category: test.category,
          passed: false,
          response: `HTTP ${response.status}`,
          missingTopics: test.expectedTopics,
        });
        continue;
      }

      const data = (await response.json()) as {
        output?: string;
        text?: string;
        response?: string;
      };
      const answerText = (
        data.output ||
        data.text ||
        data.response ||
        JSON.stringify(data)
      ).toLowerCase();

      const foundTopics = test.expectedTopics.filter((topic) =>
        answerText.includes(topic.toLowerCase()),
      );
      const missingTopics = test.expectedTopics.filter(
        (topic) => !answerText.includes(topic.toLowerCase()),
      );

      const passed =
        foundTopics.length >= Math.ceil(test.expectedTopics.length / 2);

      results.push({
        category: test.category,
        passed,
        response: answerText.substring(0, 200) + "...",
        missingTopics,
      });

      logger.info(
        `  Result: ${passed ? "PASS" : "FAIL"} (${foundTopics.length}/${test.expectedTopics.length} topics found)`,
      );
      if (missingTopics.length > 0) {
        logger.info(`  Missing: ${missingTopics.join(", ")}`);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(
        `Test failed with error: ${error instanceof Error ? error.message : error}`,
      );
      results.push({
        category: test.category,
        passed: false,
        response: `Error: ${error instanceof Error ? error.message : error}`,
        missingTopics: test.expectedTopics,
      });
    }
  }

  // Summary
  console.log("\n========================================");
  console.log("CHATBOT VALIDATION SUMMARY");
  console.log("========================================\n");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`Total Tests: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Pass Rate: ${Math.round((passed / results.length) * 100)}%\n`);

  if (failed > 0) {
    console.log("Failed Tests:");
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  - ${r.category}: Missing ${r.missingTopics.join(", ")}`);
      });
  }
}

testChatbot()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error("Validation failed", {
      error: error instanceof Error ? error.message : error,
    });
    process.exit(1);
  });
