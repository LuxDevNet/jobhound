import type { Job } from "../model.ts";
import { formatSalary } from "../lib/salary.ts";

export interface AlertNotificationOptions {
  discordWebhook?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  slackWebhook?: string;
  minScore?: number;
}

export interface AlertDispatchResult {
  channel: "discord" | "telegram" | "slack";
  success: boolean;
  jobCount: number;
  error?: string;
}

/**
 * Dispatch rich alert embeds to Discord Webhooks.
 */
export async function sendDiscordAlert(
  webhookUrl: string,
  jobs: Job[],
): Promise<AlertDispatchResult> {
  try {
    const embeds = jobs.slice(0, 10).map((j) => ({
      title: `${j.title} @ ${j.company || "Company"}`,
      url: j.applyUrl || j.url,
      color: 0x5865f2,
      fields: [
        { name: "Salary", value: formatSalary(j.salary) || "Not listed", inline: true },
        { name: "Location", value: `${j.location || "Remote"} (${j.workMode || "remote"})`, inline: true },
        { name: "Score", value: `${j.score}/100`, inline: true },
        { name: "Posted", value: j.postedAt ? new Date(j.postedAt).toLocaleDateString() : "Recent", inline: true },
        { name: "Sources", value: j.seenOn.join(", "), inline: true },
        { name: "Skills", value: j.skills.slice(0, 5).join(", ") || "General", inline: true },
      ],
      footer: { text: "Unjobbed Intelligence Pipeline" },
      timestamp: new Date().toISOString(),
    }));

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🎯 **${jobs.length} Fresh High-Fit Jobs Detected by Unjobbed**`,
        embeds,
      }),
    });

    return {
      channel: "discord",
      success: res.ok,
      jobCount: jobs.length,
      error: res.ok ? undefined : `HTTP ${res.status}: ${res.statusText}`,
    };
  } catch (err: any) {
    return {
      channel: "discord",
      success: false,
      jobCount: jobs.length,
      error: err?.message || String(err),
    };
  }
}

/**
 * Dispatch rich messages to Telegram Bot / Channels.
 */
export async function sendTelegramAlert(
  botToken: string,
  chatId: string,
  jobs: Job[],
): Promise<AlertDispatchResult> {
  try {
    for (const j of jobs.slice(0, 5)) {
      const salary = formatSalary(j.salary) || "Salary not listed";
      const text = `🎯 *${j.title}*\n🏢 *${j.company || "Company"}*\n📍 ${j.location || "Remote"} (${j.workMode || "remote"})\n💰 ${salary}\n⭐ Score: ${j.score}/100\n\n🔗 [Apply Direct](${j.applyUrl || j.url})`;

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: false,
        }),
      });
    }

    return {
      channel: "telegram",
      success: true,
      jobCount: jobs.length,
    };
  } catch (err: any) {
    return {
      channel: "telegram",
      success: false,
      jobCount: jobs.length,
      error: err?.message || String(err),
    };
  }
}

/**
 * Dispatch alert notifications to Slack incoming webhooks.
 */
export async function sendSlackAlert(
  webhookUrl: string,
  jobs: Job[],
): Promise<AlertDispatchResult> {
  try {
    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `🎯 ${jobs.length} New Top-Fit Jobs (Unjobbed)` },
      },
    ];

    for (const j of jobs.slice(0, 5)) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${j.applyUrl || j.url}|${j.title}>* @ *${j.company || "Company"}*\n📍 ${j.location || "Remote"} • 💰 ${formatSalary(j.salary) || "N/A"} • ⭐ Score: ${j.score}/100`,
        },
      });
    }

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
    });

    return {
      channel: "slack",
      success: res.ok,
      jobCount: jobs.length,
      error: res.ok ? undefined : `HTTP ${res.status}: ${res.statusText}`,
    };
  } catch (err: any) {
    return {
      channel: "slack",
      success: false,
      jobCount: jobs.length,
      error: err?.message || String(err),
    };
  }
}
