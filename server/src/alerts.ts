import { config } from "./config.js";

/** Operator alerts: console always, plus a JSON POST ({ text }) to ALERT_WEBHOOK_URL when set (Slack/Discord-compatible). */
export async function alert(text: string) {
  console.error(`[alert] ${text}`);
  const url = config.guard.alertWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) });
  } catch (e) {
    console.error(`[alert] webhook failed: ${(e as Error).message}`);
  }
}
