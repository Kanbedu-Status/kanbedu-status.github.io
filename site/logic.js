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

const OFFICIAL_STATUSES = new Set(["operational", "degraded", "maintenance", "down"]);
const SEVERITIES = new Set(["degraded", "down", "maintenance"]);
const isDate = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const optionalText = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

// Reduces kanbedu.com/api/public/status to known fields. Anything malformed
// returns null, so the caller keeps its last good copy.
export function parseOfficial(data) {
  if (!data || typeof data !== "object" || !OFFICIAL_STATUSES.has(data.status) || !Array.isArray(data.incidents)) return null;
  const incidents = [];
  for (const item of data.incidents) {
    if (!item || typeof item.id !== "string" || typeof item.title !== "string" || !SEVERITIES.has(item.severity)) return null;
    if (!isDate(item.startedAt) || (item.resolvedAt != null && !isDate(item.resolvedAt))) return null;
    incidents.push({
      id: item.id.slice(0, 64),
      title: item.title.slice(0, 200),
      severity: item.severity,
      message: optionalText(item.message, 2000),
      startedAt: item.startedAt,
      resolvedAt: item.resolvedAt ?? null,
    });
  }
  return {
    status: data.status,
    message: optionalText(data.message, 2000),
    updatedAt: isDate(data.updatedAt) ? data.updatedAt : null,
    incidents,
  };
}

const sameIncident = (a, b) => a.title === b.title && Math.floor(Date.parse(a.startedAt) / MINUTE) === Math.floor(Date.parse(b.startedAt) / MINUTE);

// The official history comes first. A local entry stays only if the official
// list does not already hold it, because local entries exist for when the app
// is down and nobody can post there.
export function allIncidents(status) {
  const official = status.official?.incidents ?? [];
  const local = (status.incidents ?? []).filter((i) => !official.some((o) => sameIncident(o, i)));
  return [...official, ...local];
}

export function openIncidents(status) {
  return allIncidents(status).filter((i) => !i.resolvedAt);
}

// What an admin set on the official status page, or null when it is operational.
function postedStatus(status) {
  const posted = status.official?.status;
  return posted && posted !== "operational" ? posted : null;
}

// An admin's message replaces the standard wording while that status is shown.
export function bannerBody(status, key) {
  const message = status.official?.message;
  return postedStatus(status) === key && message ? message : BANNERS[key].body;
}

// Posted incidents outrank automatic checks for maintenance, because failures
// are expected during it. Old check results never drive the banner.
export function bannerKey(status, nowMs) {
  const open = openIncidents(status);
  const posted = postedStatus(status);
  const incidentIs = (severity) => posted === severity || open.some((i) => i.severity === severity);
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

// Newest first, kept to the history window. Open incidents are always kept.
// Official incidents always show, matching the official page. Local entries age out.
export function visibleIncidents(status, nowMs) {
  const windowMs = (status.historyDays ?? 90) * DAY;
  const official = new Set((status.official?.incidents ?? []).map((i) => i.id));
  return allIncidents(status)
    .filter((i) => official.has(i.id) || !i.resolvedAt || nowMs - Date.parse(i.startedAt) <= windowMs)
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
