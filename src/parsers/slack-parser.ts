import { z } from "zod";
import { BaseParser } from "./base-parser.js";
import { ParsingError } from "../utils/error-handler.js";
import type { ParseResult } from "../types/index.js";

/**
 * Zod schema for Slack message validation at runtime
 * Validates the critical fields while allowing additional properties
 */
const SlackMessageSchema = z
  .object({
    ts: z.string(),
    text: z.string().optional().default(""),
    type: z.string().optional().default("message"),
    user: z.string().optional(),
    user_profile: z
      .object({
        display_name: z.string().optional().default(""),
        real_name: z.string().optional().default(""),
        first_name: z.string().optional(),
      })
      .optional(),
    thread_ts: z.string().optional(),
    parent_user_id: z.string().optional(),
    reply_count: z.number().optional(),
    replies: z.array(z.object({ user: z.string(), ts: z.string() })).optional(),
    reactions: z
      .array(z.object({ name: z.string(), count: z.number() }))
      .optional(),
    subtype: z.string().optional(),
    username: z.string().optional(),
    blocks: z.array(z.any()).optional(), // Complex nested structure, allow any
    files: z
      .array(
        z.object({
          name: z.string().optional(),
          title: z.string().optional(),
          mimetype: z.string().optional(),
          filetype: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough(); // Allow additional fields

const SlackMessagesArraySchema = z.array(SlackMessageSchema);

/**
 * Slack message structure from export JSON
 */
export interface SlackMessage {
  ts: string;
  text: string;
  type: string;
  user?: string;
  user_profile?: {
    display_name: string;
    real_name: string;
    first_name?: string;
  };
  thread_ts?: string;
  parent_user_id?: string;
  reply_count?: number;
  replies?: Array<{ user: string; ts: string }>;
  reactions?: Array<{ name: string; count: number }>;
  subtype?: string;
  username?: string; // For bot messages
  blocks?: SlackBlock[];
  files?: SlackFile[];
}

interface SlackBlock {
  type: string;
  elements?: SlackElement[];
}

interface SlackElement {
  type: string;
  text?: string;
  elements?: SlackElement[];
  style?: Record<string, boolean>;
  user_id?: string;
  url?: string;
  name?: string; // emoji name
}

interface SlackFile {
  name: string;
  title: string;
  mimetype: string;
  filetype: string;
}

/**
 * Grouped thread with parent and replies
 */
export interface SlackThread {
  threadTs: string;
  channel: string;
  parentMessage: SlackMessage;
  replies: SlackMessage[];
  participants: Set<string>;
  reactionCount: number;
  messageCount: number;
}

/**
 * Parser for Slack JSON export files
 * Groups messages by thread and formats for RAG ingestion
 */
export class SlackParser extends BaseParser {
  readonly supportedMimeTypes = [
    "application/x-slack-export",
    "application/json",
  ];
  readonly supportedExtensions = ["slack.json"];

  private userCache: Map<string, string> = new Map();

  /**
   * Parse a Slack export JSON file (single day)
   * Returns messages grouped by thread as separate documents
   */
  async parse(buffer: Buffer, filename?: string): Promise<ParseResult> {
    const jsonStr = buffer.toString("utf-8");

    // Parse and validate JSON with proper error handling
    const messages = this.parseAndValidateJson(jsonStr, filename);

    // Extract channel name from filename if available
    const channel = this.extractChannelFromPath(filename);

    // Build user cache from messages
    this.buildUserCache(messages);

    // Group messages by thread
    const threads = this.groupByThread(messages, channel);

    // Format all threads as content
    const formattedContent = threads
      .map((thread) => this.formatThread(thread))
      .join("\n\n---\n\n");

    return {
      content: this.cleanText(formattedContent),
      metadata: {
        title: `Slack: #${channel} (${this.extractDateFromFilename(filename)})`,
        sourceType: "slack",
        sourcePath: `slack://${channel}`,
      },
    };
  }

  /**
   * Parse JSON string and validate against Slack message schema
   * @throws ParsingError if JSON is invalid or doesn't match expected structure
   */
  private parseAndValidateJson(
    jsonStr: string,
    filename?: string,
  ): SlackMessage[] {
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonStr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ParsingError(
        `Invalid JSON in Slack export${filename ? ` (${filename})` : ""}: ${message}`,
        { filename },
      );
    }

    // Validate against zod schema
    const result = SlackMessagesArraySchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 3)
        .map((i) => i.message)
        .join("; ");
      throw new ParsingError(
        `Slack export validation failed${filename ? ` (${filename})` : ""}: ${issues}`,
        { filename, zodError: result.error.format() },
      );
    }

    return result.data as SlackMessage[];
  }

  /**
   * Parse multiple JSON files from a channel and return grouped threads
   */
  parseChannelExport(
    files: Array<{ buffer: Buffer; filename: string }>,
    channel: string,
  ): SlackThread[] {
    const allMessages: SlackMessage[] = [];

    for (const file of files) {
      const jsonStr = file.buffer.toString("utf-8");
      const messages = this.parseAndValidateJson(jsonStr, file.filename);
      allMessages.push(...messages);
    }

    // Build user cache from all messages
    this.buildUserCache(allMessages);

    // Group messages by thread
    return this.groupByThread(allMessages, channel);
  }

  /**
   * Format a single thread as a document
   */
  formatThreadAsDocument(thread: SlackThread): {
    content: string;
    title: string;
    metadata: Record<string, unknown>;
  } {
    const content = this.formatThread(thread);
    const firstLine = this.getFirstMeaningfulLine(thread.parentMessage);
    const truncatedTitle =
      firstLine.slice(0, 60) + (firstLine.length > 60 ? "..." : "");

    const isThread = thread.replies.length > 0;
    const title = isThread
      ? `[#${thread.channel}] Thread: ${truncatedTitle}`
      : `[#${thread.channel}] ${truncatedTitle}`;

    return {
      content: this.cleanText(content),
      title,
      metadata: {
        channel: thread.channel,
        threadTs: thread.threadTs,
        timestamp: new Date(parseFloat(thread.threadTs) * 1000).toISOString(),
        messageCount: thread.messageCount,
        participants: Array.from(thread.participants),
        reactionCount: thread.reactionCount,
        isThread,
      },
    };
  }

  /**
   * Group messages by thread
   */
  private groupByThread(
    messages: SlackMessage[],
    channel: string,
  ): SlackThread[] {
    const threadMap = new Map<string, SlackThread>();

    for (const msg of messages) {
      // Skip channel join/leave messages
      if (msg.subtype === "channel_join" || msg.subtype === "channel_leave") {
        continue;
      }

      const threadTs = msg.thread_ts || msg.ts;

      if (!threadMap.has(threadTs)) {
        threadMap.set(threadTs, {
          threadTs,
          channel,
          parentMessage: msg,
          replies: [],
          participants: new Set(),
          reactionCount: 0,
          messageCount: 0,
        });
      }

      const thread = threadMap.get(threadTs)!;

      // Add participant
      const userName = this.getUserName(msg);
      if (userName) {
        thread.participants.add(userName);
      }

      // Count reactions
      if (msg.reactions) {
        thread.reactionCount += msg.reactions.reduce(
          (sum, r) => sum + r.count,
          0,
        );
      }

      // Determine if this is parent or reply
      if (msg.ts === threadTs) {
        thread.parentMessage = msg;
      } else {
        thread.replies.push(msg);
      }

      thread.messageCount++;
    }

    // Sort threads by timestamp and replies within threads
    const threads = Array.from(threadMap.values());
    threads.sort((a, b) => parseFloat(a.threadTs) - parseFloat(b.threadTs));

    for (const thread of threads) {
      thread.replies.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    }

    return threads;
  }

  /**
   * Format a thread as readable text
   */
  private formatThread(thread: SlackThread): string {
    const lines: string[] = [];
    const timestamp = new Date(parseFloat(thread.threadTs) * 1000);

    // Header
    lines.push(
      `## #${thread.channel} - ${timestamp.toISOString().split("T")[0]}`,
    );
    lines.push("");

    // Parent message
    lines.push(this.formatMessage(thread.parentMessage));

    // Replies
    if (thread.replies.length > 0) {
      lines.push("");
      lines.push("**Replies:**");
      for (const reply of thread.replies) {
        lines.push("");
        lines.push(this.formatMessage(reply, true));
      }
    }

    // Metadata footer
    if (thread.reactionCount > 0 || thread.participants.size > 1) {
      lines.push("");
      const meta: string[] = [];
      if (thread.participants.size > 1) {
        meta.push(
          `Participants: ${Array.from(thread.participants).join(", ")}`,
        );
      }
      if (thread.reactionCount > 0) {
        meta.push(`Reactions: ${thread.reactionCount}`);
      }
      lines.push(`_${meta.join(" | ")}_`);
    }

    return lines.join("\n");
  }

  /**
   * Format a single message
   */
  private formatMessage(msg: SlackMessage, isReply = false): string {
    const userName = this.getUserName(msg);
    const timestamp = new Date(parseFloat(msg.ts) * 1000);
    const timeStr = timestamp.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const prefix = isReply ? "> " : "";
    const text = this.extractText(msg);

    // Handle files
    let fileInfo = "";
    if (msg.files && msg.files.length > 0) {
      const fileNames = msg.files.map((f) => f.name || f.title).join(", ");
      fileInfo = ` [Files: ${fileNames}]`;
    }

    return `${prefix}**${userName}** (${timeStr}): ${text}${fileInfo}`;
  }

  /**
   * Extract clean text from message
   */
  private extractText(msg: SlackMessage): string {
    // Try to extract from blocks first (more structured)
    if (msg.blocks && msg.blocks.length > 0) {
      const blockText = this.extractTextFromBlocks(msg.blocks);
      if (blockText) {
        return this.resolveUserMentions(blockText);
      }
    }

    // Fall back to text field
    return this.resolveUserMentions(msg.text || "");
  }

  /**
   * Extract text from Slack blocks structure
   */
  private extractTextFromBlocks(blocks: SlackBlock[]): string {
    const parts: string[] = [];

    for (const block of blocks) {
      if (block.type === "rich_text" && block.elements) {
        for (const element of block.elements) {
          parts.push(this.extractTextFromElement(element));
        }
      }
    }

    return parts.join("\n").trim();
  }

  /**
   * Extract text from a single block element
   */
  private extractTextFromElement(element: SlackElement): string {
    if (element.type === "rich_text_section" && element.elements) {
      return element.elements
        .map((el) => {
          if (el.type === "text") return el.text || "";
          if (el.type === "user")
            return `@${this.userCache.get(el.user_id || "") || el.user_id}`;
          if (el.type === "link") return el.url || "";
          if (el.type === "emoji") return ""; // Skip emojis for cleaner text
          if (el.type === "broadcast") return "@channel";
          return "";
        })
        .join("");
    }

    if (element.type === "rich_text_list" && element.elements) {
      return element.elements
        .map((el, i) => `${i + 1}. ${this.extractTextFromElement(el)}`)
        .join("\n");
    }

    if (element.type === "rich_text_preformatted" && element.elements) {
      return (
        "```\n" + element.elements.map((el) => el.text || "").join("") + "\n```"
      );
    }

    return "";
  }

  /**
   * Resolve user mentions like <@U123ABC> to display names
   */
  private resolveUserMentions(text: string): string {
    return text.replace(/<@([A-Z0-9]+)>/g, (_, userId) => {
      const name = this.userCache.get(userId);
      return name ? `@${name}` : `@user`;
    });
  }

  /**
   * Get user display name from message
   */
  private getUserName(msg: SlackMessage): string {
    if (msg.user_profile) {
      return (
        msg.user_profile.display_name || msg.user_profile.real_name || "Unknown"
      );
    }
    if (msg.username) {
      return msg.username; // Bot messages
    }
    if (msg.user) {
      return this.userCache.get(msg.user) || "Unknown";
    }
    return "Unknown";
  }

  /**
   * Build user cache from messages
   */
  private buildUserCache(messages: SlackMessage[]): void {
    for (const msg of messages) {
      if (msg.user && msg.user_profile) {
        const name =
          msg.user_profile.display_name || msg.user_profile.real_name;
        if (name) {
          this.userCache.set(msg.user, name);
        }
      }
    }
  }

  /**
   * Get first meaningful line of text for title
   */
  private getFirstMeaningfulLine(msg: SlackMessage): string {
    const text = this.extractText(msg);
    // Remove formatting, get first line
    const cleaned = text
      .replace(/\*\*/g, "")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned || "Message";
  }

  /**
   * Extract channel name from file path
   */
  private extractChannelFromPath(filename?: string): string {
    if (!filename) return "unknown";
    // Expected: /path/to/export/channel-name/2024-01-01.json
    const parts = filename.split("/");
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return "unknown";
  }

  /**
   * Extract date from filename
   */
  private extractDateFromFilename(filename?: string): string {
    if (!filename) return "unknown";
    const match = filename.match(/(\d{4}-\d{2}-\d{2})\.json$/);
    return match ? match[1] : "unknown";
  }
}
