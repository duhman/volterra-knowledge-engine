import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

interface ChangelogData {
  version: string;
  title: string;
  author: string;
  publishedAt: string;
  features: string[];
  improvements: string[];
  url: string;
}

Deno.serve(async (req) => {
  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const slackBotToken = Deno.env.get("SLACK_BOT_TOKEN");
    const slackChannelId = Deno.env.get("SLACK_CHANNEL_ID");

    if (!slackBotToken || !slackChannelId) {
      throw new Error("SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not configured");
    }

    console.log("Fetching latest Ampeco changelog...");

    // Fetch the changelog page
    const changelogUrl = "https://developers.ampeco.com/changelog";
    const response = await fetch(changelogUrl);
    const html = await response.text();

    // Extract the latest version from the page
    const versionMatch = html.match(
      /release-notes-public-api-of-ampeco-charge-(\d+)/i,
    );
    if (!versionMatch) {
      console.log("No version found in changelog");
      return new Response(JSON.stringify({ message: "No version found" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }

    const latestVersion = versionMatch[1];
    console.log(`Latest version found: ${latestVersion}`);

    // Check if we've already notified about this version
    const { data: state } = await supabase
      .from("ampeco_changelog_state")
      .select("last_seen_version")
      .eq("id", 1)
      .single();

    // Update last_checked_at
    await supabase
      .from("ampeco_changelog_state")
      .update({ last_checked_at: new Date().toISOString() })
      .eq("id", 1);

    if (state?.last_seen_version === latestVersion) {
      console.log(`Version ${latestVersion} already notified`);
      return new Response(
        JSON.stringify({ message: "No new version", version: latestVersion }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Fetch the detailed changelog for this version
    const detailUrl = `https://developers.ampeco.com/changelog/release-notes-public-api-of-ampeco-charge-${latestVersion}`;
    console.log(`Fetching details from: ${detailUrl}`);

    const detailResponse = await fetch(detailUrl);
    const detailHtml = await detailResponse.text();

    // Parse HTML with Deno DOM parser
    const doc = new DOMParser().parseFromString(detailHtml, "text/html");
    if (!doc) {
      throw new Error("Failed to parse HTML");
    }

    // Extract title
    const titleElement = doc.querySelector("h1");
    const title =
      titleElement?.textContent?.trim() ||
      `Release Notes: Public API of AMPECO Charge 3.${latestVersion}`;

    // Extract author and timestamp by looking for text patterns
    let author = "Ampeco Team";
    let publishedAt = "Recently";

    const bodyText = doc.body?.textContent || "";
    const authorMatch = bodyText.match(/by\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i);
    if (authorMatch) {
      author = authorMatch[1];
    }

    const timeMatch = bodyText.match(
      /(\d+\s+(?:hours?|days?|weeks?)\s+ago|about\s+\d+\s+(?:hours?|days?))/i,
    );
    if (timeMatch) {
      publishedAt = timeMatch[0];
    }

    // Extract features and improvements using text matching
    const features: string[] = [];
    const improvements: string[] = [];

    // Helper function to filter out non-content lines
    const isValidContentLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (trimmed.length < 20) return false;
      if (
        trimmed.match(
          /^(✨|New Features|🔧|Improvements|Terms|Jump to|Home|Guides|API Reference|Changelog)/i,
        )
      )
        return false;
      if (
        trimmed.match(/^(var\s|const\s|let\s|\[\d+,|\{|\}|\]|;$|namedChunks)/)
      )
        return false;
      if (trimmed.match(/^\[?\d+[,\d\s]+/)) return false;
      if (!trimmed.match(/^(Add|Change|Fix|Update|Remove|Deprecate|[A-Z])/))
        return false;
      return true;
    };

    // Split content into sections
    const sections = bodyText.split(/(?=✨|🔧)/);

    for (const section of sections) {
      if (section.includes("✨") || section.includes("New Features")) {
        const lines = section.split("\n").filter(isValidContentLine);
        lines.forEach((line) => {
          const cleaned = line.trim();
          if (cleaned && !features.includes(cleaned)) {
            features.push(cleaned);
          }
        });
      } else if (section.includes("🔧") || section.includes("Improvements")) {
        const lines = section.split("\n").filter(isValidContentLine);
        lines.forEach((line) => {
          const cleaned = line.trim();
          if (cleaned && !improvements.includes(cleaned)) {
            improvements.push(cleaned);
          }
        });
      }
    }

    // Limit to first 5 items each to keep message concise
    const limitedFeatures = features.slice(0, 5);
    const limitedImprovements = improvements.slice(0, 5);

    console.log(
      `Extracted: ${limitedFeatures.length} features, ${limitedImprovements.length} improvements`,
    );

    // Build Slack Block Kit message
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚀 Ampeco API Update",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${title}*\n📅 ${publishedAt}  •  👤 by ${author}`,
        },
      },
      {
        type: "divider",
      },
    ];

    // Add features section
    if (limitedFeatures.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*✨ New Features*",
        },
      });

      const formattedFeatures = limitedFeatures
        .map((f) => {
          return f
            .replace(
              /\b([a-z][a-zA-Z0-9_]*(?:Id|Type|Key|Token|Name|Status|Config|Data|Info|Property|Endpoint|Resource|Request|Response|Enabled))\b/g,
              "`$1`",
            )
            .replace(/\/[a-z0-9\-\/\.]+/gi, "`$&`")
            .replace(/\b(true|false|null)\b/g, "`$1`");
        })
        .join("\n\n• ");

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `• ${formattedFeatures}`,
        },
      });

      blocks.push({
        type: "divider",
      });
    }

    // Add improvements section
    if (limitedImprovements.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*🔧 Improvements*",
        },
      });

      const formattedImprovements = limitedImprovements
        .map((i) => {
          return i
            .replace(
              /\b([a-z][a-zA-Z0-9_]*(?:Id|Type|Key|Token|Name|Status|Config|Data|Info|Property|Endpoint|Resource|Request|Response|Enabled))\b/g,
              "`$1`",
            )
            .replace(/\/[a-z0-9\-\/\.]+/gi, "`$&`")
            .replace(/\b(true|false|null)\b/g, "`$1`");
        })
        .join("\n\n• ");

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `• ${formattedImprovements}`,
        },
      });

      blocks.push({
        type: "divider",
      });
    }

    // Add action buttons
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "📖 View Full Release Notes",
            emoji: true,
          },
          url: detailUrl,
          style: "primary",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "📚 API Documentation",
            emoji: true,
          },
          url: "https://developers.ampeco.com/",
        },
      ],
    });

    // Add footer context
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🔔 Version: \`v3.${latestVersion}\` | 🤖 Auto-posted by Ampeco Monitor`,
        },
      ],
    });

    // Fallback text for notifications
    const fallbackText = `🚀 Ampeco API Update: ${title}`;

    // Post to Slack
    console.log("Posting to Slack with Block Kit formatting...");
    const slackResponse = await fetch(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: slackChannelId,
          text: fallbackText,
          blocks: blocks,
          unfurl_links: false,
          unfurl_media: false,
        }),
      },
    );

    const slackResult = await slackResponse.json();
    console.log("Slack response:", slackResult);

    if (!slackResult.ok) {
      throw new Error(`Slack API error: ${slackResult.error}`);
    }

    // Record notification
    await supabase.from("ampeco_changelog_notifications").insert({
      version: latestVersion,
      slack_response: slackResult,
    });

    // Update state
    await supabase
      .from("ampeco_changelog_state")
      .update({
        last_seen_version: latestVersion,
        last_notified_at: new Date().toISOString(),
      })
      .eq("id", 1);

    return new Response(
      JSON.stringify({
        success: true,
        version: latestVersion,
        title: title,
        features_count: limitedFeatures.length,
        improvements_count: limitedImprovements.length,
        slack_ts: slackResult.ts,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: error.message,
        stack: error.stack,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
