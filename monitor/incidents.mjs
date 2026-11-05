// Validates the hand-edited incident file, usually changed from a phone during
// an outage, so a typo must never take the page down.

const SEVERITIES = new Set(["degraded", "down", "maintenance"]);
const MAX_INCIDENTS = 200;
const MAX_TITLE = 160;
const MAX_MESSAGE = 2000;

function isIso(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

// Returns { ok: true, incidents } or { ok: false, errors }.
export function validateIncidents(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Not valid JSON: ${error.message}`] };
  }
  if (!Array.isArray(parsed)) return { ok: false, errors: ["The file must be a list in square brackets"] };
  if (parsed.length > MAX_INCIDENTS) return { ok: false, errors: [`More than ${MAX_INCIDENTS} incidents`] };

  const errors = [];
  const seen = new Set();
  const incidents = parsed.map((item, index) => {
    const where = `Incident ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${where}: must be an object`);
      return null;
    }
    if (typeof item.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(item.id)) errors.push(`${where}: id must use lowercase letters, numbers and hyphens`);
    else if (seen.has(item.id)) errors.push(`${where}: id ${item.id} is used twice`);
    else seen.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > MAX_TITLE) errors.push(`${where}: title is required, up to ${MAX_TITLE} characters`);
    if (!SEVERITIES.has(item.severity)) errors.push(`${where}: severity must be degraded, down or maintenance`);
    if (item.message != null && (typeof item.message !== "string" || item.message.length > MAX_MESSAGE)) errors.push(`${where}: message must be text, up to ${MAX_MESSAGE} characters`);
    if (!isIso(item.startedAt)) errors.push(`${where}: startedAt must look like 2026-11-05T14:30:00+08:00`);
    if (item.resolvedAt != null && !isIso(item.resolvedAt)) errors.push(`${where}: resolvedAt must be null or look like 2026-11-05T15:00:00+08:00`);
    if (isIso(item.startedAt) && isIso(item.resolvedAt) && Date.parse(item.resolvedAt) < Date.parse(item.startedAt)) errors.push(`${where}: resolvedAt is before startedAt`);
    return {
      id: item.id,
      title: item.title,
      severity: item.severity,
      message: item.message ?? null,
      startedAt: item.startedAt,
      resolvedAt: item.resolvedAt ?? null,
    };
  });
  if (errors.length > 0) return { ok: false, errors };
  incidents.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { ok: true, incidents };
}
