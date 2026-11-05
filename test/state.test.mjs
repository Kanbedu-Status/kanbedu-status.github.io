import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../monitor/config.mjs";
import { applyRun, assertValidState, buildPublicStatus, dayKey, emptyState, isDue, isInconclusive } from "../monitor/state.mjs";

const reached = [{ reachable: true }, { reachable: true }, { reachable: true }];
const unreachable = [{ reachable: false }, { reachable: false }, { reachable: false }];
const pass = { outcome: "pass", ms: 100, conditions: [{ name: "Status is 200", ok: true }] };
const fail = { outcome: "fail", ms: 15000, note: "Answered 500", conditions: [{ name: "Status is 200", ok: false }] };
const slow = { outcome: "slow", ms: 4000, note: "Slow response", conditions: [] };
const blocked = { outcome: "blocked", ms: 50, note: "The host refused this monitor", conditions: [] };

const all = (result) => Object.fromEntries(config.checks.map((c) => [c.id, result]));
const T0 = Date.parse("2026-11-04T06:00:00Z");
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();

function play(sequence, start = emptyState(config)) {
  let state = start;
  sequence.forEach((result, i) => {
    state = applyRun(state, all(result), reached, at(i * 5), config).state;
  });
  return state;
}

test("one failure is checking, not down", () => {
  assert.equal(play([pass, fail]).checks.app.status, "checking");
});

test("two failures in a row are down", () => {
  assert.equal(play([pass, fail, fail]).checks.app.status, "down");
});

test("a pass after one failure clears it and records no downtime", () => {
  const entry = play([pass, fail, pass]).checks.app;
  assert.equal(entry.status, "operational");
  const day = entry.days[dayKey(at(0), 480)];
  assert.equal(day.fail, 1);
  assert.equal(day.down, 0);
});

test("confirmed down counts the first failed run as well", () => {
  const entry = play([fail, fail, fail]).checks.app;
  const day = entry.days[dayKey(at(0), 480)];
  assert.equal(day.down, 3);
  assert.equal(day.runs, 3);
});

test("downtime spanning midnight lands on both days", () => {
  // 15:58 UTC and 16:03 UTC straddle midnight in Malaysia time.
  const first = Date.parse("2026-11-04T15:58:00Z");
  let state = emptyState(config);
  state = applyRun(state, all(fail), reached, new Date(first).toISOString(), config).state;
  state = applyRun(state, all(fail), reached, new Date(first + 300000).toISOString(), config).state;
  const days = state.checks.app.days;
  assert.equal(days["2026-11-04"].down, 1);
  assert.equal(days["2026-11-05"].down, 1);
});

test("recovery from down goes straight to operational", () => {
  assert.equal(play([fail, fail, pass]).checks.app.status, "operational");
});

test("one slow run stays operational, two are degraded", () => {
  assert.equal(play([slow]).checks.app.status, "operational");
  assert.equal(play([slow, slow]).checks.app.status, "degraded");
  assert.equal(play([slow, slow, pass]).checks.app.status, "operational");
});

test("since only changes when the status changes", () => {
  const state = play([pass, pass, pass]);
  assert.equal(state.checks.app.since, at(0));
  assert.equal(play([pass, pass, fail]).checks.app.since, at(10));
});

test("recent history is capped", () => {
  const state = play(Array(config.recentRuns + 25).fill(pass));
  assert.equal(state.checks.app.recent.length, config.recentRuns);
});

test("daily history is pruned to the window and stays bounded", () => {
  let state = emptyState(config);
  for (let d = 0; d < 200; d += 1) {
    state = applyRun(state, all(pass), reached, new Date(T0 + d * 86400000).toISOString(), config).state;
  }
  assert.equal(Object.keys(state.checks.app.days).length, config.historyDays);
});

test("input state is not mutated", () => {
  const before = play([pass]);
  const copy = structuredClone(before);
  applyRun(before, all(fail), reached, at(5), config);
  assert.deepEqual(before, copy);
});

test("a run that cannot reach anything records nothing against Kanbedu", () => {
  const start = play([pass]);
  const { state, inconclusive } = applyRun(start, all(fail), unreachable, at(5), config);
  assert.equal(inconclusive, true);
  assert.equal(state.checks.app.status, "operational");
  assert.equal(state.checks.app.failStreak, 0);
  assert.equal(state.lastConclusiveAt, at(0));
  assert.equal(state.lastRunAt, at(5));
});

test("Kanbedu failing while providers answer is a real failure", () => {
  const { inconclusive, state } = applyRun(emptyState(config), all(fail), reached, at(0), config);
  assert.equal(inconclusive, false);
  assert.equal(state.checks.app.failStreak, 1);
});

test("every check refused by the host is inconclusive", () => {
  assert.equal(isInconclusive(all(blocked), reached), true);
});

test("a pass with unreachable providers is conclusive", () => {
  assert.equal(isInconclusive(all(pass), unreachable), false);
});

test("a blocked check keeps its streak and adds no run", () => {
  const start = play([pass, fail]);
  const results = { ...all(pass), app: blocked };
  const entry = applyRun(start, results, reached, at(10), config).state.checks.app;
  assert.equal(entry.failStreak, 1);
  assert.equal(entry.days[dayKey(at(0), 480)].runs, 2);
});

test("a check that was not due keeps its status", () => {
  const start = play([fail, fail]);
  const results = { app: pass, database: pass };
  const { state } = applyRun(start, results, reached, at(10), config);
  assert.equal(state.checks.website.status, "down");
  assert.equal(state.checks.app.status, "operational");
});

const website = config.checks.find((c) => c.id === "website");
const app = config.checks.find((c) => c.id === "app");

test("health checks are always due", () => {
  assert.equal(isDue(app, { lastRunAt: at(0), failStreak: 0, slowStreak: 0 }, at(0), false), true);
});

test("page checks wait for their interval", () => {
  const entry = { lastRunAt: at(0), failStreak: 0, slowStreak: 0 };
  assert.equal(isDue(website, entry, at(5), false), false);
  assert.equal(isDue(website, entry, at(29), false), true);
});

test("page checks run early when something looks wrong", () => {
  const entry = { lastRunAt: at(0), failStreak: 0, slowStreak: 0 };
  assert.equal(isDue(website, entry, at(5), true), true);
  assert.equal(isDue(website, { ...entry, failStreak: 1 }, at(5), false), true);
  assert.equal(isDue(website, { ...entry, slowStreak: 1 }, at(5), false), true);
  assert.equal(isDue(website, undefined, at(5), false), true);
});

test("a corrupt or mismatched state is refused", () => {
  assert.throws(() => assertValidState(null, config));
  assert.throws(() => assertValidState([], config));
  assert.throws(() => assertValidState({ schemaVersion: 99, checks: {} }, config));
  assert.throws(() => assertValidState({ schemaVersion: 1 }, config));
  assert.throws(() => assertValidState({ schemaVersion: 1, checks: { app: { recent: "x", days: {} } } }, config));
  assert.doesNotThrow(() => assertValidState(emptyState(config), config));
});

test("the public file only carries configured checks and known fields", () => {
  const state = play([pass]);
  const output = buildPublicStatus(state, [], [], false, at(0), config);
  assert.deepEqual(output.checks.map((c) => c.id), config.checks.map((c) => c.id));
  assert.ok(!("failStreak" in output.checks[0]));
  assert.ok(!JSON.stringify(output).includes("Authorization"));
});

test("config uses only https kanbedu.com and no retries beyond delays", () => {
  for (const check of config.checks) assert.ok(check.url.startsWith("https://kanbedu.com/"));
  assert.equal(config.retryDelaysMs.length, config.attempts - 1);
});
