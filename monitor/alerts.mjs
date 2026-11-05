// Discord alerts for a confirmed outage and for its recovery. State records what
// was last delivered, so a failed send retries on the next run and a long outage
// sends one message, not one per run.

const WEBHOOK = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
const PAGE_URL = "https://kanbedu-status.github.io";

export function isValidWebhook(url) {
  return typeof url === "string" && WEBHOOK.test(url);
}

// Returns the message to send, or null when nothing changed. Failures are expected
// during posted maintenance, so nothing is sent and the outcome is left undecided.
export function decideAlert(lastDownIds, publicStatus) {
  const posted = publicStatus.official?.status === "maintenance";
  const open = [...(publicStatus.official?.incidents ?? []), ...(publicStatus.incidents ?? [])];
  if (posted || open.some((i) => !i.resolvedAt && i.severity === "maintenance")) return null;

  const down = publicStatus.checks.filter((c) => c.status === "down");
  const ids = down.map((c) => c.id).sort();
  const previous = lastDownIds ?? [];
  if (ids.join() === [...previous].sort().join()) return null;

  if (ids.length === 0) {
    return { ids, content: `**Kanbedu recovered**\nEvery check is passing again.\n${PAGE_URL}` };
  }
  const names = down.map((c) => c.name).join(", ");
  const verb = down.length === 1 ? "is" : "are";
  return { ids, content: `**Kanbedu problem**\n${names} ${verb} failing, confirmed by consecutive checks.\n${PAGE_URL}` };
}

// Returns "sent", "retry" for a passing failure, or "broken" when the webhook itself
// is refused. The URL holds a secret, so it never appears in a message or a log.
export async function sendDiscord(url, content, fetchImpl = fetch, timeoutMs = 10000) {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return "sent";
    return [401, 403, 404].includes(response.status) ? "broken" : "retry";
  } catch {
    return "retry";
  }
}
