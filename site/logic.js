// Pure page logic. Shared by the browser and the unit tests.

export const STALE_AFTER_MINUTES = 30;
export const SUPPORTED_SCHEMA = 1;
export const DAY_OFFSET_MINUTES = 480;

const MINUTE = 60000;
const DAY = 86400000;

// The approved status wordings. Do not paraphrase.
export const BANNERS = {
  operational: {
    tone: "ok",
    label: "All Systems Operational",
    body: "Kanbedu is currently operating normally. No known issues or service disruptions are affecting the platform.",
  },
  degraded: {
    tone: "warn",
    label: "Degraded Performance",
    body: "Some Kanbedu features may be affected.\nWe are currently investigating an issue affecting parts of the platform. Some features may be slower than usual or temporarily unavailable.",
  },
  maintenance: {
    tone: "info",
    label: "Under Maintenance",
    body: "Scheduled maintenance is underway.\nKanbedu is currently undergoing maintenance. Some features may be temporarily unavailable while we work to improve the platform.",
  },
  down: {
    tone: "bad",
    label: "Down",
    body: "Kanbedu is currently unavailable.\nWe are aware of the issue and are working to restore service as soon as possible.",
  },
  checking: {
    tone: "warn",
    label: "Checking a Possible Issue",
    body: "One check failed. It will be checked again before anything is reported as down.",
  },
  delayed: {
    tone: "neutral",
    label: "Monitor Delayed",
    body: "This page has not completed a check recently, so it cannot say whether Kanbedu is up right now. This does not mean Kanbedu is down.",
  },
};

export function isStale(status, nowMs) {
  if (!status.lastConclusiveAt) return true;
  return nowMs - Date.parse(status.lastConclusiveAt) > STALE_AFTER_MINUTES * MINUTE;
}

export function openIncidents(status) {
  return (status.incidents ?? []).filter((i) => !i.resolvedAt);
}

// Posted incidents outrank automatic checks for maintenance, because failures
// are expected during it. Old check results never drive the banner.
export function bannerKey(status, nowMs) {
  const open = openIncidents(status);
  const incidentIs = (severity) => open.some((i) => i.severity === severity);
  if (incidentIs("down")) return "down";
  if (incidentIs("maintenance")) return "maintenance";
  if (isStale(status, nowMs)) return incidentIs("degraded") ? "degraded" : "delayed";

  const checks = status.checks ?? [];
  if (checks.some((c) => c.status === "down" && c.severity === "down")) return "down";
  if (incidentIs("degraded") || checks.some((c) => c.status === "down" || c.status === "degraded")) return "degraded";
  if (checks.some((c) => c.status === "checking")) return "checking";
  return "operational";
}

export const CHECK_LABELS = {
  operational: { tone: "ok", label: "Operational" },
  degraded: { tone: "warn", label: "Degraded" },
  checking: { tone: "warn", label: "Checking" },
  down: { tone: "bad", label: "Down" },
  unknown: { tone: "neutral", label: "No data yet" },
  stale: { tone: "neutral", label: "Not checked recently" },
};

export function checkLabel(check, nowMs, status) {
  if (!check.lastRunAt) return CHECK_LABELS.unknown;
  if (isStale(status, nowMs)) return CHECK_LABELS.stale;
  return CHECK_LABELS[check.status] ?? CHECK_LABELS.unknown;
}

export const PROVIDER_LABELS = {
  none: { tone: "ok", label: "Operational" },
  minor: { tone: "warn", label: "Minor issue reported" },
  major: { tone: "bad", label: "Major issue reported" },
  critical: { tone: "bad", label: "Critical issue reported" },
  maintenance: { tone: "info", label: "Maintenance reported" },
  unknown: { tone: "neutral", label: "Report unavailable" },
};

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider.indicator] ?? PROVIDER_LABELS.unknown;
}

function keyForMs(ms) {
  return new Date(ms + DAY_OFFSET_MINUTES * MINUTE).toISOString().slice(0, 10);
}

// Oldest first. A day with no recorded runs stays "none", never green.
export function dayBars(days, count, nowMs) {
  const bars = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const key = keyForMs(nowMs - back * DAY);
    const day = days?.[key];
    if (!day || !day.runs) {
      bars.push({ key, tone: "none", day: null });
      continue;
    }
    let tone = "ok";
    if (day.down > 0) tone = "bad";
    else if (day.slow / day.runs >= 0.1) tone = "warn";
    bars.push({ key, tone, day });
  }
  return bars;
}

// Rounds down, so any confirmed failure can never display as 100.00%.
export function uptimePercent(days) {
  let runs = 0;
  let down = 0;
  for (const day of Object.values(days ?? {})) {
    runs += day.runs ?? 0;
    down += day.down ?? 0;
  }
  if (runs === 0) return null;
  return (Math.floor(((runs - down) / runs) * 10000) / 100).toFixed(2);
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function relativeTime(iso, nowMs) {
  const elapsed = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(elapsed / MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

const ZONE = "Asia/Kuala_Lumpur";

export function formatStamp(iso) {
  const text = new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: ZONE,
  });
  return `${text.replace(", 24:", ", 00:")} MYT`;
}

export function formatDayKey(key) {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatIncidentDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: ZONE });
}

// Lines for one day bar tooltip.
export function dayTooltip(bar) {
  const lines = [formatDayKey(bar.key)];
  if (!bar.day) {
    lines.push("No checks recorded");
    return lines;
  }
  const { runs, down, fail, slow, msSum, msCount } = bar.day;
  lines.push(down > 0 ? `${plural(down, "failed check")} of ${runs}` : `No confirmed failures in ${plural(runs, "check")}`);
  const brief = fail - down;
  if (brief > 0) lines.push(`${plural(brief, "brief failure")}, passed on the next check`);
  if (slow > 0) lines.push(`${plural(slow, "slow response")}`);
  if (msCount > 0) lines.push(`Average response ${Math.round(msSum / msCount)} ms`);
  return lines;
}

const OUTCOMES = { pass: "Passed", slow: "Slow", fail: "Failed", blocked: "Refused by host" };

export function outcomeLabel(outcome) {
  return OUTCOMES[outcome] ?? "Unknown";
}

export function averageMs(recent) {
  const values = (recent ?? []).filter((r) => r.outcome === "pass" || r.outcome === "slow").map((r) => r.ms);
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

// Newest first, kept to the history window. Open incidents are always kept.
export function visibleIncidents(status, nowMs) {
  const windowMs = (status.historyDays ?? 90) * DAY;
  return (status.incidents ?? [])
    .filter((i) => !i.resolvedAt || nowMs - Date.parse(i.startedAt) <= windowMs)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function incidentUpdates(incident) {
  const labels = { degraded: "Degraded Performance", down: "Outage", maintenance: "Maintenance" };
  const updates = [];
  if (incident.resolvedAt) updates.push({ label: "Resolved", body: "This issue has been resolved.", at: incident.resolvedAt });
  updates.push({
    label: incident.severity === "maintenance" ? "Scheduled" : "Investigating",
    body: incident.message ?? `${labels[incident.severity] ?? "Issue"} reported.`,
    at: incident.startedAt,
  });
  return updates;
}
