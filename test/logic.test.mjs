import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateIncidents } from "../monitor/incidents.mjs";
import {
  BANNERS,
  averageMs,
  bannerKey,
  checkLabel,
  dayBars,
  dayTooltip,
  formatStamp,
  incidentUpdates,
  isStale,
  plural,
  providerLabel,
  relativeTime,
  uptimePercent,
  visibleIncidents,
} from "../site/logic.js";

const NOW = Date.parse("2026-11-04T06:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const status = (statuses = {}, extra = {}) => ({
  lastConclusiveAt: ago(2),
  checks: [
    { id: "app", severity: "down", status: statuses.app ?? "operational", lastRunAt: ago(2) },
    { id: "database", severity: "down", status: statuses.database ?? "operational", lastRunAt: ago(2) },
    { id: "website", severity: "degraded", status: statuses.website ?? "operational", lastRunAt: ago(2) },
  ],
  incidents: [],
  ...extra,
});
const incident = (severity, resolvedAt = null) => ({ severity, resolvedAt, startedAt: ago(10) });

test("all healthy is operational", () => assert.equal(bannerKey(status(), NOW), "operational"));
test("database down is down", () => assert.equal(bannerKey(status({ database: "down" }), NOW), "down"));
test("website down is degraded, not down", () => assert.equal(bannerKey(status({ website: "down" }), NOW), "degraded"));
test("slow is degraded", () => assert.equal(bannerKey(status({ app: "degraded" }), NOW), "degraded"));
test("one unconfirmed failure never shows down", () => assert.equal(bannerKey(status({ database: "checking" }), NOW), "checking"));

test("data older than the limit is delayed, never a false green", () => {
  assert.equal(bannerKey(status({}, { lastConclusiveAt: ago(31) }), NOW), "delayed");
  assert.equal(bannerKey(status({}, { lastConclusiveAt: ago(29) }), NOW), "operational");
});

test("old failures are not reported as a current outage", () => {
  assert.equal(bannerKey(status({ database: "down" }, { lastConclusiveAt: ago(120) }), NOW), "delayed");
});

test("no completed check yet is delayed", () => {
  assert.equal(bannerKey(status({}, { lastConclusiveAt: null }), NOW), "delayed");
});

test("posted incidents hold while the monitor is delayed", () => {
  const stale = { lastConclusiveAt: ago(120) };
  assert.equal(bannerKey(status({}, { ...stale, incidents: [incident("down")] }), NOW), "down");
  assert.equal(bannerKey(status({}, { ...stale, incidents: [incident("maintenance")] }), NOW), "maintenance");
  assert.equal(bannerKey(status({}, { ...stale, incidents: [incident("degraded")] }), NOW), "degraded");
});

test("maintenance holds over failing checks, a posted outage holds over maintenance", () => {
  assert.equal(bannerKey(status({ database: "down" }, { incidents: [incident("maintenance")] }), NOW), "maintenance");
  assert.equal(bannerKey(status({}, { incidents: [incident("maintenance"), incident("down")] }), NOW), "down");
});

test("resolved incidents do not affect the banner", () => {
  assert.equal(bannerKey(status({}, { incidents: [incident("down", ago(1))] }), NOW), "operational");
});

test("a provider issue alone never changes the banner", () => {
  assert.equal(bannerKey(status({}, { providers: [{ indicator: "critical" }] }), NOW), "operational");
});

test("approved wordings are verbatim", () => {
  assert.equal(BANNERS.operational.body, "Kanbedu is currently operating normally. No known issues or service disruptions are affecting the platform.");
  assert.equal(BANNERS.down.body, "Kanbedu is currently unavailable.\nWe are aware of the issue and are working to restore service as soon as possible.");
  assert.equal(BANNERS.degraded.body, "Some Kanbedu features may be affected.\nWe are currently investigating an issue affecting parts of the platform. Some features may be slower than usual or temporarily unavailable.");
  assert.equal(BANNERS.maintenance.body, "Scheduled maintenance is underway.\nKanbedu is currently undergoing maintenance. Some features may be temporarily unavailable while we work to improve the platform.");
});

test("check labels cover no data and stale", () => {
  const s = status();
  assert.equal(checkLabel({ lastRunAt: null, status: "operational" }, NOW, s).label, "No data yet");
  assert.equal(checkLabel(s.checks[0], NOW, s).label, "Operational");
  assert.equal(checkLabel(s.checks[0], NOW, { ...s, lastConclusiveAt: ago(40) }).label, "Not checked recently");
});

test("an unknown provider indicator is not shown as healthy", () => {
  assert.equal(providerLabel({ indicator: "banana" }).label, "Report unavailable");
});

test("day bars give 90 days, oldest first, in Malaysia time", () => {
  const bars = dayBars({}, 90, Date.parse("2026-11-04T17:00:00Z"));
  assert.equal(bars.length, 90);
  assert.equal(bars[89].key, "2026-11-05");
  assert.ok(bars.every((b) => b.tone === "none"));
});

test("day tones", () => {
  const key = "2026-11-04";
  const tone = (day) => dayBars({ [key]: day }, 1, NOW)[0].tone;
  assert.equal(tone({ runs: 100, down: 0, slow: 0, fail: 0 }), "ok");
  assert.equal(tone({ runs: 100, down: 0, slow: 5, fail: 1 }), "ok");
  assert.equal(tone({ runs: 100, down: 0, slow: 10, fail: 0 }), "warn");
  assert.equal(tone({ runs: 100, down: 1, slow: 0, fail: 1 }), "bad");
  assert.equal(tone({ runs: 0, down: 0, slow: 0, fail: 0 }), "none");
});

test("uptime rounds down and handles no data", () => {
  assert.equal(uptimePercent({}), null);
  assert.equal(uptimePercent({ a: { runs: 0, down: 0 } }), null);
  assert.equal(uptimePercent({ a: { runs: 100, down: 0 } }), "100.00");
  assert.equal(uptimePercent({ a: { runs: 100000, down: 1 } }), "99.99");
  assert.equal(uptimePercent({ a: { runs: 10, down: 10 } }), "0.00");
});

test("plural handles 0, 1 and 2", () => {
  assert.equal(plural(0, "check"), "0 checks");
  assert.equal(plural(1, "check"), "1 check");
  assert.equal(plural(2, "check"), "2 checks");
});

test("relative time", () => {
  assert.equal(relativeTime(ago(0), NOW), "just now");
  assert.equal(relativeTime(ago(1), NOW), "1 minute ago");
  assert.equal(relativeTime(ago(47), NOW), "47 minutes ago");
  assert.equal(relativeTime(ago(120), NOW), "2 hours ago");
  assert.equal(relativeTime(ago(60 * 72), NOW), "3 days ago");
  assert.equal(relativeTime(new Date(NOW + 60000).toISOString(), NOW), "just now");
});

test("stamps are Malaysia time and labelled", () => {
  assert.equal(formatStamp("2026-11-04T06:30:00Z"), "Nov 4, 14:30 MYT");
  assert.equal(formatStamp("2026-11-04T16:05:00Z"), "Nov 5, 00:05 MYT");
});

test("day tooltip wording", () => {
  assert.deepEqual(dayTooltip({ key: "2026-11-04", day: null }), ["Nov 4, 2026", "No checks recorded"]);
  const lines = dayTooltip({ key: "2026-11-04", day: { runs: 288, down: 2, fail: 3, slow: 1, msSum: 1000, msCount: 2 } });
  assert.deepEqual(lines, ["Nov 4, 2026", "2 failed checks of 288", "1 brief failure, passed on the next check", "1 slow response", "Average response 500 ms"]);
});

test("average ignores failures and blocked runs", () => {
  assert.equal(averageMs([{ outcome: "pass", ms: 100 }, { outcome: "slow", ms: 300 }, { outcome: "fail", ms: 15000 }, { outcome: "blocked", ms: 5 }]), 200);
  assert.equal(averageMs([{ outcome: "fail", ms: 1 }]), null);
  assert.equal(averageMs(undefined), null);
});

test("incident list keeps open ones and drops old resolved ones", () => {
  const s = { historyDays: 90, incidents: [
    { id: "old", startedAt: ago(91 * 1440), resolvedAt: ago(91 * 1440 - 60) },
    { id: "old-open", startedAt: ago(100 * 1440), resolvedAt: null },
    { id: "new", startedAt: ago(10), resolvedAt: ago(5) },
  ] };
  assert.deepEqual(visibleIncidents(s, NOW).map((i) => i.id), ["new", "old-open"]);
});

test("incident timeline wording", () => {
  assert.deepEqual(incidentUpdates({ severity: "maintenance", startedAt: ago(1), resolvedAt: null, message: null }).map((u) => [u.label, u.body]), [["Scheduled", "Maintenance reported."]]);
  assert.equal(incidentUpdates({ severity: "down", startedAt: ago(9), resolvedAt: ago(1), message: "x" })[0].label, "Resolved");
});

const good = { id: "a-1", title: "T", severity: "down", message: "M", startedAt: "2026-11-05T14:30:00+08:00", resolvedAt: null };
const check = (item) => validateIncidents(JSON.stringify([item]));

test("the shipped incident file is valid", async () => {
  assert.equal(validateIncidents(await readFile(new URL("../incidents/incidents.json", import.meta.url), "utf8")).ok, true);
});

test("incident validation accepts a good entry and sorts newest first", () => {
  assert.equal(check(good).ok, true);
  const r = validateIncidents(JSON.stringify([good, { ...good, id: "b", startedAt: "2026-11-06T14:30:00+08:00" }]));
  assert.equal(r.incidents[0].id, "b");
});

test("incident validation rejects each kind of bad edit", () => {
  assert.equal(validateIncidents("[{").ok, false);
  assert.equal(validateIncidents("{}").ok, false);
  assert.equal(validateIncidents("[1]").ok, false);
  assert.equal(check({ ...good, id: "Has Space" }).ok, false);
  assert.equal(check({ ...good, title: " " }).ok, false);
  assert.equal(check({ ...good, severity: "bad" }).ok, false);
  assert.equal(check({ ...good, message: 5 }).ok, false);
  assert.equal(check({ ...good, startedAt: "yesterday" }).ok, false);
  assert.equal(check({ ...good, startedAt: "2026-11-05" }).ok, false);
  assert.equal(check({ ...good, resolvedAt: "2026-11-05T13:00:00+08:00" }).ok, false);
  assert.equal(validateIncidents(JSON.stringify([good, good])).ok, false);
});

test("isStale boundary", () => {
  assert.equal(isStale({ lastConclusiveAt: ago(30) }, NOW), false);
  assert.equal(isStale({ lastConclusiveAt: null }, NOW), true);
});
