/**
 * Unjobbed Pro Addons Engine
 * Provides advanced AI matching, ATS auto-applying, multi-channel alert bots, and ghost job detection.
 */
export * from "./ai-matcher.ts";
export * from "./auto-applier.ts";
export * from "./alert-bots.ts";
export * from "./ghost-detector.ts";

export const UNJOBBED_PRO_VERSION = "1.0.0";
export const PRO_FEATURES = [
  "ai_resume_matcher",
  "ats_auto_applier",
  "alert_bots_discord_telegram_slack",
  "ghost_job_radar",
  "monochrome_terminal_tui",
] as const;
