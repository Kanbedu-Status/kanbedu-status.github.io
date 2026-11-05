// Local preview with fake data. Open http://localhost:4173 and pick a scenario.
// Nothing here is deployed: the workflow publishes the site folder only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../site/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

const CHECKS = [
  ["app", "App", "The server answers requests", "down", 0],
  ["database", "Database", "The app can reach its database", "down", 0],
  ["website", "Website", "The public home page loads", "degraded", 30],
  ["login", "Log in page", "The log in page loads", "degraded", 30],
];

function dayKey(ms) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}

function days(now, overrides = {}) {
  const out = {};
  for (let back = 0; back < 76; back += 1) {
    out[dayKey(now - back * 86400000)] = { runs: 240, pass: 238, slow: 2, fail: 0, down: 0, msSum: 238 * 410, msCount: 240, msMax: 2100 };
  }
  for (const [back, value] of Object.entries(overrides)) out[dayKey(now - Number(back) * 86400000)] = value;
  return out;
}

function base(now, statusFor = () => "operational", opts = {}) {
  const at = new Date(now - (opts.ageMin ?? 2) * 60000).toISOString();
  return {
    schemaVersion: 1,
    generatedAt: at,
    lastConclusiveAt: at,
    inconclusive: false,
    historyDays: 90,
    checks: CHECKS.map(([id, name, description, severity, everyMinutes]) => {
      const status = statusFor(id);
      const failing = status === "down" || status === "checking";
      return {
        id, name, description, severity, everyMinutes, status, since: at, lastRunAt: at,
        note: failing ? "Answered 500" : status === "degraded" ? "Slow response" : null,
        days: days(now, {
          3: { runs: 240, pass: 230, slow: 40, fail: 0, down: 0, msSum: 240 * 900, msCount: 240, msMax: 4000 },
          20: { runs: 240, pass: 220, slow: 0, fail: 20, down: 18, msSum: 220 * 500, msCount: 220, msMax: 2500 },
          41: { runs: 240, pass: 239, slow: 0, fail: 1, down: 0, msSum: 239 * 420, msCount: 239, msMax: 900 },
        }),
      };
    }),
    official: null,
    incidents: [],
  };
}

export function scenario(name, now = Date.now()) {
  const resolved = {
    id: "db-slow", title: "Slow database responses", severity: "degraded",
    message: "Some Kanbedu features may be affected.\nWe are currently investigating an issue affecting parts of the platform. Some features may be slower than usual or temporarily unavailable.",
    startedAt: new Date(now - 20 * 86400000).toISOString(), resolvedAt: new Date(now - 20 * 86400000 + 3600000).toISOString(),
  };
  switch (name) {
    case "operational": return { ...base(now), incidents: [resolved] };
    case "checking": return base(now, (id) => (id === "database" ? "checking" : "operational"));
    case "degraded": return base(now, (id) => (id === "website" ? "degraded" : "operational"));
    case "down": return base(now, () => "down");
    case "database-down": return base(now, (id) => (id === "database" ? "down" : "operational"));
    case "delayed": return base(now, () => "operational", { ageMin: 47 });
    case "maintenance": return { ...base(now, () => "down"), incidents: [{ id: "maint", title: "Database maintenance", severity: "maintenance", message: "Scheduled maintenance is underway.\nKanbedu is currently undergoing maintenance. Some features may be temporarily unavailable while we work to improve the platform.", startedAt: new Date(now - 600000).toISOString(), resolvedAt: null }] };
    case "official-mirror": return { ...base(now), official: { status: "maintenance", message: "Database upgrade tonight.\nBoards stay readable.", updatedAt: new Date(now).toISOString(), incidents: [{ id: "official-1", title: "Elevated errors on login and board access", severity: "down", message: "We identified an issue with database connectivity that caused elevated errors on login and other features.", startedAt: "2026-08-28T11:45:00.000Z", resolvedAt: "2026-08-28T13:18:00.000Z" }] } };
    case "hostile": return { ...base(now), incidents: [{ id: "x", title: "<img src=x onerror=alert(1)>", severity: "down", message: "<script>window.__pwned=1</script>", startedAt: new Date(now - 60000).toISOString(), resolvedAt: null }] };
    case "first-run": return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), lastConclusiveAt: null, inconclusive: false, historyDays: 90, checks: CHECKS.map(([id, name, description, severity, everyMinutes]) => ({ id, name, description, severity, everyMinutes, status: "operational", since: null, note: null, lastRunAt: null, days: {} })), official: null, incidents: [] };
    case "bad-schema": return { schemaVersion: 99 };
    default: return null;
  }
}

const NAMES = ["operational", "checking", "degraded", "down", "database-down", "delayed", "maintenance", "official-mirror", "hostile", "first-run", "bad-schema", "missing-data"];

export function startPreview(port = 4173) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const match = path.match(/^\/s\/([a-z-]+)(\/.*)$/);
    if (!match) {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(NAMES.map((n) => `<p><a href="/s/${n}/">${n}</a></p>`).join(""));
      return;
    }
    const [, name, rest] = match;
    if (rest === "/data/status.json") {
      const data = scenario(name);
      res.statusCode = data ? 200 : 404;
      res.setHeader("content-type", "application/json");
      res.end(data ? JSON.stringify(data) : "{}");
      return;
    }
    const file = normalize(join(SITE, rest === "/" ? "index.html" : rest));
    if (!file.startsWith(normalize(SITE))) {
      res.statusCode = 403;
      res.end();
      return;
    }
    try {
      const content = await readFile(file);
      res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "localhost", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  await startPreview();
  console.log("Preview at http://localhost:4173");
}
