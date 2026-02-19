import { BaseSource, type ListDocumentsOptions } from "./base-source.js";
import { FileSource } from "./file-source.js";
import { NotionSource } from "./notion-source.js";
import { SharePointSource } from "./sharepoint-source.js";
import { HubSpotSource } from "./hubspot-source.js";
import { SlackSource } from "./slack-source.js";
import { logger } from "../utils/logger.js";
import type { SourceType } from "../types/index.js";

export { BaseSource, type ListDocumentsOptions };
export { FileSource } from "./file-source.js";
export { NotionSource } from "./notion-source.js";
export { SharePointSource } from "./sharepoint-source.js";
export { HubSpotSource } from "./hubspot-source.js";
export {
  SlackSource,
  DEFAULT_SLACK_CHANNELS,
  type SlackSourceOptions,
} from "./slack-source.js";

/**
 * Create a source instance by type
 */
export function createSource(
  type: SourceType,
  options?: Record<string, unknown>,
): BaseSource {
  switch (type) {
    case "file":
      return new FileSource(options?.basePath as string);
    case "notion":
      return new NotionSource();
    case "sharepoint":
      return new SharePointSource();
    case "hubspot":
      return new HubSpotSource();
    case "slack":
      return new SlackSource({
        exportPath: options?.exportPath as string,
        channels: options?.channels as string[] | undefined,
      });
    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}

/**
 * Get all configured sources (uninitialized)
 * Use getInitializedSources() if you need ready-to-use sources
 */
export function getConfiguredSources(): BaseSource[] {
  const sources: BaseSource[] = [];

  // File source is always available
  sources.push(new FileSource());

  // Add optional sources if configured
  const notionSource = new NotionSource();
  if (notionSource.isConfigured()) {
    sources.push(notionSource);
  }

  const sharepointSource = new SharePointSource();
  if (sharepointSource.isConfigured()) {
    sources.push(sharepointSource);
  }

  const hubspotSource = new HubSpotSource();
  if (hubspotSource.isConfigured()) {
    sources.push(hubspotSource);
  }

  logger.info("Configured sources", {
    sources: sources.map((s) => s.name),
  });

  return sources;
}

/**
 * Get all configured sources, initialized and ready to use
 * Sources that fail to initialize are logged and skipped
 */
export async function getInitializedSources(): Promise<BaseSource[]> {
  const configured = getConfiguredSources();
  const initialized: BaseSource[] = [];

  for (const source of configured) {
    try {
      await source.ensureInitialized();
      initialized.push(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to initialize ${source.name} source, skipping`, {
        source: source.name,
        error: message,
      });
    }
  }

  return initialized;
}

/**
 * Check which sources are configured
 */
export function getSourceStatus(): Record<
  SourceType,
  { configured: boolean; name: string }
> {
  return {
    file: { configured: true, name: "Local File System" },
    notion: { configured: new NotionSource().isConfigured(), name: "Notion" },
    sharepoint: {
      configured: new SharePointSource().isConfigured(),
      name: "SharePoint",
    },
    hubspot: {
      configured: new HubSpotSource().isConfigured(),
      name: "HubSpot",
    },
    email: { configured: false, name: "Email (attachments only)" },
    slack: { configured: false, name: "Slack Export (manual)" },
  };
}
