import { Client } from "@notionhq/client";
import type {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import { BaseSource, type ListDocumentsOptions } from "./base-source.js";
import { logger } from "../utils/logger.js";
import { SourceError } from "../utils/error-handler.js";
import { getConfig } from "../utils/config.js";
import type { SourceDocument, IngestionOptions } from "../types/index.js";

/**
 * Extracted properties from Notion page properties
 */
export interface ExtractedProperties {
  platformLead?: string;
  stakeholderLead?: string;
  status?: string;
  impactScale?: string;
  domain?: string;
  propertiesRaw?: Record<string, unknown>;
}

/**
 * Extracted sections from Notion page content
 */
export interface ExtractedSections {
  problemSection?: string;
  solutionSection?: string;
  definitionOfDone?: string;
}

/**
 * Combined extracted data for notion_pages table
 */
export interface NotionPageExtractedData
  extends ExtractedProperties, ExtractedSections {
  notionCreatedBy?: string;
  notionLastEditedBy?: string;
}

/**
 * Normalize a tag string: lowercase, remove diacritics, replace non-alnum with '-'
 */
function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^a-z0-9]+/g, "-") // replace non-alnum with dash
    .replace(/^-|-$/g, ""); // trim leading/trailing dashes
}

export interface NotionListOptions extends ListDocumentsOptions {
  /** Specific page IDs to fetch (and optionally their children) */
  pageIds?: string[];
  /** Specific database IDs to query */
  databaseIds?: string[];
  /** Recursively fetch child pages */
  recursive?: boolean;
  /** Maximum recursion depth (default: 3) */
  maxDepth?: number;
}

export class NotionSource extends BaseSource {
  readonly name = "Notion";
  readonly type = "notion";

  private client: Client | null = null;

  async initialize(): Promise<void> {
    const apiKey = process.env.NOTION_API_KEY;

    if (!apiKey) {
      throw new SourceError(
        "Notion API key not configured. Set NOTION_API_KEY environment variable.",
      );
    }

    this.client = new Client({ auth: apiKey });

    // Verify connection
    try {
      await this.client.users.me({});
      this._initialized = true;
      logger.info("Notion source initialized");
    } catch (error) {
      this.client = null;
      throw new SourceError(
        "Failed to connect to Notion API. Check your API key.",
      );
    }
  }

  async listDocuments(
    options: NotionListOptions = {},
  ): Promise<SourceDocument[]> {
    if (!this.client) {
      throw new SourceError("Notion source not initialized");
    }

    const config = getConfig();
    const documents: SourceDocument[] = [];

    try {
      // If specific page IDs provided, fetch those (and optionally their children)
      if (options.pageIds && options.pageIds.length > 0) {
        for (const pageId of options.pageIds) {
          const pageDocs = await this.listDocumentsFromPage(pageId, {
            recursive: options.recursive ?? true,
            maxDepth: options.maxDepth ?? 3,
            limit: options.limit ? options.limit - documents.length : undefined,
          });
          documents.push(...pageDocs);

          if (options.limit && documents.length >= options.limit) break;
        }
        logger.info("Listed Notion pages from specific IDs", {
          count: documents.length,
        });
        return documents;
      }

      // If specific database IDs provided, query those
      if (options.databaseIds && options.databaseIds.length > 0) {
        for (const dbId of options.databaseIds) {
          const dbDocs = await this.listDocumentsFromDatabase(dbId, {
            limit: options.limit ? options.limit - documents.length : undefined,
          });
          documents.push(...dbDocs);

          if (options.limit && documents.length >= options.limit) break;
        }
        logger.info("Listed Notion pages from databases", {
          count: documents.length,
        });
        return documents;
      }

      // Default: search for all accessible pages
      let cursor: string | undefined = options.cursor;
      do {
        const response = await this.client.search({
          filter: { property: "object", value: "page" },
          page_size: Math.min(
            options.limit || config.sources.notion.pageSize,
            100,
          ),
          start_cursor: cursor,
        });

        for (const page of response.results) {
          if (page.object !== "page") continue;

          const pageObj = page as PageObjectResponse;
          const title = this.extractPageTitle(pageObj);

          // Normalize page ID for stable source_path
          const normalizedId = pageObj.id.replace(/-/g, "");

          documents.push({
            id: pageObj.id,
            name: title,
            mimeType: "text/plain",
            metadata: {
              notionId: pageObj.id,
              url: pageObj.url,
              createdTime: pageObj.created_time,
              lastEditedTime: pageObj.last_edited_time,
              createdBy: pageObj.created_by?.id,
              lastEditedBy: pageObj.last_edited_by?.id,
              sourceType: "notion",
              sourcePath: `notion://page/${normalizedId}`,
            },
          });

          if (options.limit && documents.length >= options.limit) {
            break;
          }
        }

        cursor = response.has_more
          ? (response.next_cursor ?? undefined)
          : undefined;
      } while (cursor && (!options.limit || documents.length < options.limit));

      logger.info("Listed Notion pages", { count: documents.length });
      return documents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to list Notion pages: ${message}`);
    }
  }

  /**
   * List documents from a specific Notion page and optionally its children
   */
  async listDocumentsFromPage(
    pageId: string,
    options: {
      recursive?: boolean;
      maxDepth?: number;
      limit?: number;
      currentDepth?: number;
    } = {},
  ): Promise<SourceDocument[]> {
    if (!this.client) {
      throw new SourceError("Notion source not initialized");
    }

    const { recursive = true, maxDepth = 3, limit, currentDepth = 0 } = options;
    const documents: SourceDocument[] = [];

    try {
      // Fetch the page itself
      const page = await this.client.pages.retrieve({ page_id: pageId });

      if ("properties" in page) {
        const pageObj = page as PageObjectResponse;
        const title = this.extractPageTitle(pageObj);
        const normalizedId = pageObj.id.replace(/-/g, "");

        documents.push({
          id: pageObj.id,
          name: title,
          mimeType: "text/plain",
          metadata: {
            notionId: pageObj.id,
            url: pageObj.url,
            createdTime: pageObj.created_time,
            lastEditedTime: pageObj.last_edited_time,
            createdBy: pageObj.created_by?.id,
            lastEditedBy: pageObj.last_edited_by?.id,
            depth: currentDepth,
            sourceType: "notion",
            sourcePath: `notion://page/${normalizedId}`,
          },
        });

        // Recursively fetch child pages if enabled
        if (recursive && currentDepth < maxDepth) {
          const childPages = await this.getChildPages(pageId);

          for (const childPageId of childPages) {
            if (limit && documents.length >= limit) break;

            const childDocs = await this.listDocumentsFromPage(childPageId, {
              recursive,
              maxDepth,
              limit: limit ? limit - documents.length : undefined,
              currentDepth: currentDepth + 1,
            });
            documents.push(...childDocs);
          }
        }
      }

      return documents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Failed to fetch Notion page", { pageId, error: message });
      return documents;
    }
  }

  /**
   * List documents from a Notion database
   */
  async listDocumentsFromDatabase(
    databaseId: string,
    options: { limit?: number; filter?: Record<string, unknown> } = {},
  ): Promise<SourceDocument[]> {
    if (!this.client) {
      throw new SourceError("Notion source not initialized");
    }

    const documents: SourceDocument[] = [];
    let cursor: string | undefined;

    try {
      // Debug: log available APIs
      logger.info("Available Notion client APIs", {
        hasDatabases: !!this.client.databases,
        hasDataSources: !!(this.client as any).dataSources,
        clientKeys: Object.keys(this.client),
        databasesMethods: this.client.databases
          ? Object.keys(this.client.databases)
          : [],
        dataSourcesMethods: (this.client as any).dataSources
          ? Object.keys((this.client as any).dataSources)
          : [],
      });

      do {
        // Use dataSources.query API (SDK v5+)
        const response = await (this.client as any).dataSources.query({
          data_source_id: databaseId,
          start_cursor: cursor,
          page_size: 100,
          filter: options.filter as any,
        });

        for (const page of response.results) {
          // In v5, results include PageObjectResponse and PartialPageObjectResponse
          if (!("properties" in page)) continue;

          const pageObj = page as PageObjectResponse;
          const title = this.extractPageTitle(pageObj);
          const normalizedPageId = pageObj.id.replace(/-/g, "");
          const normalizedDbId = databaseId.replace(/-/g, "");

          // Extract tags from Notion multi_select property named "Tags"
          const notionTags = this.extractMultiSelectTags(pageObj, "Tags");

          documents.push({
            id: pageObj.id,
            name: title,
            mimeType: "text/plain",
            metadata: {
              notionId: pageObj.id,
              url: pageObj.url,
              createdTime: pageObj.created_time,
              lastEditedTime: pageObj.last_edited_time,
              databaseId,
              sourceType: "notion",
              sourcePath: `notion://db/${normalizedDbId}/page/${normalizedPageId}`,
              // Normalized tags from Notion DB Tags property
              notionTags,
              // Add db reference tag
              notionDbTag: `notion_db:${normalizedDbId}`,
            },
          });

          if (options.limit && documents.length >= options.limit) break;
        }

        cursor = response.has_more
          ? (response.next_cursor ?? undefined)
          : undefined;
      } while (cursor && (!options.limit || documents.length < options.limit));

      return documents;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to query Notion database: ${message}`, {
        databaseId,
      });
    }
  }

  /**
   * Get child page IDs from a parent page
   */
  private async getChildPages(parentId: string): Promise<string[]> {
    if (!this.client) return [];

    const childPageIds: string[] = [];
    let cursor: string | undefined;

    try {
      do {
        const response = await this.client.blocks.children.list({
          block_id: parentId,
          page_size: 100,
          start_cursor: cursor,
        });

        for (const block of response.results) {
          if ("type" in block) {
            // Check for child_page or child_database blocks
            if (block.type === "child_page") {
              childPageIds.push(block.id);
            } else if (block.type === "child_database") {
              // Optionally handle databases as children
              childPageIds.push(block.id);
            }
          }
        }

        cursor = response.has_more
          ? (response.next_cursor ?? undefined)
          : undefined;
      } while (cursor);

      return childPageIds;
    } catch (error) {
      logger.warn("Failed to get child pages", { parentId });
      return childPageIds;
    }
  }

  async downloadDocument(document: SourceDocument): Promise<Buffer> {
    if (!this.client) {
      throw new SourceError("Notion source not initialized");
    }

    try {
      // Get page content as blocks
      const blocks = await this.getPageBlocks(document.id);
      const content = this.blocksToText(blocks);

      // Include title
      const fullContent = `# ${document.name}\n\n${content}`;

      logger.debug("Downloaded Notion page", {
        id: document.id,
        title: document.name,
        contentLength: fullContent.length,
      });

      return Buffer.from(fullContent, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SourceError(`Failed to download Notion page: ${message}`, {
        pageId: document.id,
      });
    }
  }

  private async getPageBlocks(pageId: string): Promise<BlockObjectResponse[]> {
    if (!this.client) throw new SourceError("Not initialized");

    const blocks: BlockObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        page_size: 100,
        start_cursor: cursor,
      });

      for (const block of response.results) {
        if ("type" in block) {
          blocks.push(block as BlockObjectResponse);

          // Recursively get children for blocks that have them
          if (block.has_children) {
            const children = await this.getPageBlocks(block.id);
            blocks.push(...children);
          }
        }
      }

      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);

    return blocks;
  }

  private blocksToText(blocks: BlockObjectResponse[]): string {
    const lines: string[] = [];
    let i = 0;

    while (i < blocks.length) {
      const block = blocks[i];
      const text = this.blockToText(block);

      if (text) {
        lines.push(text);

        // For toggle blocks (FAQs), check if next blocks are children (indented content)
        // This helps capture Q&A patterns common in support docs
        if (block.type === "toggle" && block.has_children) {
          // Children are already fetched recursively in getPageBlocks
          // Look ahead for blocks that came from this toggle's children
          // They'll be the next blocks until we hit another top-level block
          const childBlocks: BlockObjectResponse[] = [];
          let j = i + 1;

          // Collect blocks that are children of this toggle
          // (identified by being fetched right after this block)
          while (j < blocks.length && this.isChildBlock(blocks[j], block.id)) {
            childBlocks.push(blocks[j]);
            j++;
          }

          if (childBlocks.length > 0) {
            const childText = this.blocksToText(childBlocks);
            if (childText.trim()) {
              lines.push(`**A:** ${childText.trim()}`);
            }
            i = j - 1; // Skip processed children
          }
        }
      }
      i++;
    }

    return lines.join("\n");
  }

  /**
   * Check if a block is a child of a parent (heuristic based on order)
   */
  private isChildBlock(
    _block: BlockObjectResponse,
    _parentId: string,
  ): boolean {
    // In our recursive fetch, children come right after parent
    // This is a simplified heuristic; a more robust solution would track parent IDs
    return false; // Disable for now - children are inline in the list
  }

  private blockToText(block: BlockObjectResponse): string {
    const type = block.type;

    switch (type) {
      case "paragraph":
        return this.richTextToString(block.paragraph.rich_text);
      case "heading_1":
        return `# ${this.richTextToString(block.heading_1.rich_text)}`;
      case "heading_2":
        return `## ${this.richTextToString(block.heading_2.rich_text)}`;
      case "heading_3":
        return `### ${this.richTextToString(block.heading_3.rich_text)}`;
      case "bulleted_list_item":
        return `- ${this.richTextToString(block.bulleted_list_item.rich_text)}`;
      case "numbered_list_item":
        return `1. ${this.richTextToString(block.numbered_list_item.rich_text)}`;
      case "to_do":
        const checked = block.to_do.checked ? "[x]" : "[ ]";
        return `${checked} ${this.richTextToString(block.to_do.rich_text)}`;
      case "toggle":
        // Toggles often contain FAQ Q&A - mark them clearly
        return `**Q:** ${this.richTextToString(block.toggle.rich_text)}`;
      case "quote":
        return `> ${this.richTextToString(block.quote.rich_text)}`;
      case "code":
        return `\`\`\`${block.code.language}\n${this.richTextToString(block.code.rich_text)}\n\`\`\``;
      case "callout":
        // Callouts are important for support docs (tips, warnings, notes)
        const calloutIcon = this.extractCalloutIcon(block.callout);
        const calloutText = this.richTextToString(block.callout.rich_text);
        return `${calloutIcon} **Note:** ${calloutText}`;
      case "divider":
        return "---";
      case "table_row":
        return block.table_row.cells
          .map((cell) => this.richTextToString(cell))
          .join(" | ");
      case "bookmark":
        const bookmarkUrl = (block.bookmark as any).url || "";
        const bookmarkCaption = (block.bookmark as any).caption
          ? this.richTextToString((block.bookmark as any).caption)
          : bookmarkUrl;
        return `[${bookmarkCaption}](${bookmarkUrl})`;
      case "link_preview":
        return `Link: ${(block.link_preview as any).url || ""}`;
      case "embed":
        return `[Embedded content: ${(block.embed as any).url || ""}]`;
      case "image":
        const imageCaption = (block.image as any).caption
          ? this.richTextToString((block.image as any).caption)
          : "Image";
        return `[${imageCaption}]`;
      case "video":
        const videoCaption = (block.video as any).caption
          ? this.richTextToString((block.video as any).caption)
          : "Video";
        return `[${videoCaption}]`;
      case "file":
        const fileName = (block.file as any).name || "File";
        return `[Attached file: ${fileName}]`;
      case "pdf":
        return `[PDF document]`;
      case "equation":
        return `$${(block.equation as any).expression || ""}$`;
      case "column_list":
        // Column lists are handled via children
        return "";
      case "column":
        // Columns are handled via children
        return "";
      case "synced_block":
        // Synced blocks are handled via children
        return "";
      case "template":
        // Template blocks are handled via children
        return "";
      case "link_to_page":
        return "[Link to another page]";
      case "table_of_contents":
        return "[Table of Contents]";
      case "breadcrumb":
        return "";
      default:
        return "";
    }
  }

  /**
   * Extract icon from callout block
   */
  private extractCalloutIcon(callout: {
    icon?: { type: string; emoji?: string } | null;
  }): string {
    if (!callout.icon) return ">";
    if (callout.icon.type === "emoji" && callout.icon.emoji) {
      return callout.icon.emoji;
    }
    return ">";
  }

  private richTextToString(richText: RichTextItemResponse[]): string {
    return richText.map((item) => item.plain_text).join("");
  }

  private extractPageTitle(page: PageObjectResponse): string {
    const properties = page.properties;

    // Try common title property names
    for (const key of ["title", "Title", "Name", "name", "Page"]) {
      const prop = properties[key];
      if (prop && prop.type === "title" && prop.title.length > 0) {
        return prop.title.map((t) => t.plain_text).join("");
      }
    }

    // Fallback to first title-type property
    for (const prop of Object.values(properties)) {
      if (prop.type === "title" && prop.title.length > 0) {
        return prop.title.map((t) => t.plain_text).join("");
      }
    }

    return "Untitled";
  }

  /**
   * Extract and normalize tags from a multi_select property
   */
  private extractMultiSelectTags(
    page: PageObjectResponse,
    propertyName: string,
  ): string[] {
    const properties = page.properties;
    const prop = properties[propertyName];

    if (!prop || prop.type !== "multi_select") {
      return [];
    }

    return prop.multi_select
      .map((option: { name: string }) => normalizeTag(option.name))
      .filter((tag: string) => tag.length > 0);
  }

  // ==========================================================================
  // Property Extraction Methods (for enhanced notion_pages columns)
  // ==========================================================================

  /**
   * Extract display name(s) from a People property
   * Returns comma-separated names if multiple people assigned
   */
  extractPeople(
    properties: PageObjectResponse["properties"],
    propertyName: string,
  ): string | undefined {
    const prop = properties[propertyName];
    if (!prop || prop.type !== "people") return undefined;

    const names = prop.people
      .map((person) => {
        if ("name" in person && person.name) {
          return person.name;
        }
        // Fallback to email if name not available
        if ("person" in person && person.person?.email) {
          return person.person.email.split("@")[0];
        }
        return undefined;
      })
      .filter((name): name is string => !!name);

    return names.length > 0 ? names.join(", ") : undefined;
  }

  /**
   * Extract value from a Select property
   */
  extractSelect(
    properties: PageObjectResponse["properties"],
    propertyName: string,
  ): string | undefined {
    const prop = properties[propertyName];
    if (!prop || prop.type !== "select") return undefined;
    return prop.select?.name;
  }

  /**
   * Extract all relevant properties from a Notion page
   * Maps to the enhanced notion_pages columns
   */
  extractProperties(page: PageObjectResponse): ExtractedProperties {
    const props = page.properties;

    return {
      // People properties
      platformLead: this.extractPeople(props, "Platform Lead"),
      stakeholderLead:
        this.extractPeople(props, "Stakeholder") ||
        this.extractPeople(props, "Stakeholder lead"),

      // Select properties
      status: this.extractSelect(props, "Status"),
      impactScale:
        this.extractSelect(props, "Impact Scale") ||
        this.extractSelect(props, "Impact"),
      domain: this.extractSelect(props, "Domain"),

      // Store raw properties for future expansion
      propertiesRaw: this.serializeProperties(props),
    };
  }

  /**
   * Serialize page properties to a JSON-safe format
   * Strips internal Notion metadata, keeps useful values
   */
  private serializeProperties(
    properties: PageObjectResponse["properties"],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, prop] of Object.entries(properties)) {
      switch (prop.type) {
        case "title":
          result[key] = prop.title.map((t) => t.plain_text).join("");
          break;
        case "rich_text":
          result[key] = prop.rich_text.map((t) => t.plain_text).join("");
          break;
        case "select":
          result[key] = prop.select?.name;
          break;
        case "multi_select":
          result[key] = prop.multi_select.map((s) => s.name);
          break;
        case "people":
          result[key] = prop.people.map((p) => ("name" in p ? p.name : p.id));
          break;
        case "date":
          result[key] = prop.date?.start;
          break;
        case "checkbox":
          result[key] = prop.checkbox;
          break;
        case "number":
          result[key] = prop.number;
          break;
        case "url":
          result[key] = prop.url;
          break;
        case "email":
          result[key] = prop.email;
          break;
        case "phone_number":
          result[key] = prop.phone_number;
          break;
        case "status":
          result[key] = prop.status?.name;
          break;
        case "relation":
          result[key] = prop.relation.map((r) => r.id);
          break;
        // Skip formula, rollup, created_by, last_edited_by, created_time, last_edited_time
        // These are computed or already stored elsewhere
      }
    }

    return result;
  }

  /**
   * Extract Problem/Solution/Definition of Done sections from page blocks
   * Looks for headings matching these patterns and extracts content underneath
   */
  extractSections(blocks: BlockObjectResponse[]): ExtractedSections {
    const sections: ExtractedSections = {};

    // Patterns to match section headings (case-insensitive)
    const sectionPatterns = {
      problemSection: [/^1\.\s*the\s*problem/i, /^problem/i, /^the\s*problem/i],
      solutionSection: [
        /^2\.\s*the\s*solution/i,
        /^solution/i,
        /^the\s*solution/i,
        /^proposed\s*solution/i,
      ],
      definitionOfDone: [
        /^3\.\s*definition\s*of\s*done/i,
        /^definition\s*of\s*done/i,
        /^dod/i,
        /^done\s*criteria/i,
        /^acceptance\s*criteria/i,
      ],
    };

    let currentSection: keyof ExtractedSections | null = null;
    let currentContent: string[] = [];

    const saveCurrentSection = () => {
      if (currentSection && currentContent.length > 0) {
        sections[currentSection] = currentContent.join("\n").trim();
      }
      currentContent = [];
    };

    for (const block of blocks) {
      if (!("type" in block)) continue;

      const type = block.type;
      let text = "";
      let isHeading = false;

      // Extract text and check if heading
      if (type === "heading_1") {
        isHeading = true;
        text = this.richTextToString(block.heading_1.rich_text);
      } else if (type === "heading_2") {
        isHeading = true;
        text = this.richTextToString(block.heading_2.rich_text);
      } else if (type === "heading_3") {
        isHeading = true;
        text = this.richTextToString(block.heading_3.rich_text);
      } else if (type === "paragraph") {
        text = this.richTextToString(block.paragraph.rich_text);
      } else if (type === "bulleted_list_item") {
        text = `- ${this.richTextToString(block.bulleted_list_item.rich_text)}`;
      } else if (type === "numbered_list_item") {
        text = `1. ${this.richTextToString(block.numbered_list_item.rich_text)}`;
      } else if (type === "to_do") {
        const checked = block.to_do.checked ? "[x]" : "[ ]";
        text = `${checked} ${this.richTextToString(block.to_do.rich_text)}`;
      } else if (type === "toggle") {
        text = this.richTextToString(block.toggle.rich_text);
      } else if (type === "quote") {
        text = `> ${this.richTextToString(block.quote.rich_text)}`;
      } else if (type === "callout") {
        text = this.richTextToString(block.callout.rich_text);
      }

      // If it's a heading, check if it starts a new section
      if (isHeading && text) {
        let foundSection: keyof ExtractedSections | null = null;

        for (const [sectionKey, patterns] of Object.entries(sectionPatterns)) {
          if (patterns.some((p) => p.test(text))) {
            foundSection = sectionKey as keyof ExtractedSections;
            break;
          }
        }

        if (foundSection) {
          // Save previous section before starting new one
          saveCurrentSection();
          currentSection = foundSection;
        } else if (currentSection) {
          // A different heading ends the current section
          saveCurrentSection();
          currentSection = null;
        }
      } else if (currentSection && text) {
        // Add content to current section
        currentContent.push(text);
      }
    }

    // Save any remaining section
    saveCurrentSection();

    return sections;
  }

  /**
   * Extract all data needed for enhanced notion_pages columns
   * Combines properties and sections extraction
   */
  async extractPageData(
    page: PageObjectResponse,
  ): Promise<NotionPageExtractedData> {
    const properties = this.extractProperties(page);

    // Get blocks for section extraction
    let sections: ExtractedSections = {};
    try {
      const blocks = await this.getPageBlocks(page.id);
      sections = this.extractSections(blocks);
    } catch (error) {
      logger.warn("Failed to extract sections from page", {
        pageId: page.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      ...properties,
      ...sections,
      notionCreatedBy: page.created_by?.id,
      notionLastEditedBy: page.last_edited_by?.id,
    };
  }

  getDefaultIngestionOptions(): Partial<IngestionOptions> {
    return {
      accessLevel: "internal",
      documentType: "Document",
      sourceType: "notion",
    };
  }

  isConfigured(): boolean {
    return !!process.env.NOTION_API_KEY;
  }
}
