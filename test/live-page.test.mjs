import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GRACE_SECONDS, REMIND_SECONDS, WINDOW_SECONDS, decide, lagSeconds } from "../scripts/live-page.mjs";

test("a publish within the grace period only warns", () => {
  for (const lag of [1, 60, 600, GRACE_SECONDS]) assert.equal(decide(lag), "warn", `lag ${lag}`);
});

test("the first run past the grace period fails", () => {
  for (const lag of [GRACE_SECONDS + 1, GRACE_SECONDS + 150, GRACE_SECONDS + WINDOW_SECONDS]) {
    assert.equal(decide(lag), "fail", `lag ${lag}`);
  }
});

test("the runs after that warn instead of failing every 5 minutes", () => {
  for (const lag of [GRACE_SECONDS + WINDOW_SECONDS + 1, 1800, 3600, 7200, 12000]) {
    assert.equal(decide(lag), "warn", `lag ${lag}`);
  }
});

test("a stale page fails again once every 6 hours as a reminder", () => {
  const reminder = GRACE_SECONDS + REMIND_SECONDS;
  assert.equal(decide(reminder + 60), "fail");
  assert.equal(decide(reminder + WINDOW_SECONDS + 1), "warn");
  assert.equal(decide(GRACE_SECONDS + 2 * REMIND_SECONDS + 10), "fail");
});

test("one stale episode, a run every 5 minutes for 13 hours, fails 3 times, not 150", () => {
  let fails = 0;
  for (let lag = 300; lag <= 13 * 3600; lag += 300) if (decide(lag) === "fail") fails++;
  assert.equal(fails, 3);
});

test("an unreadable live page still fails", () => {
  assert.equal(decide(-1), "fail");
  assert.equal(decide(NaN), "fail");
});

test("lag is measured from the live data to this run's data", () => {
  assert.equal(lagSeconds("2026-11-11T20:10:00.000Z", "2026-11-11T18:55:27.931Z"), 4472);
  assert.equal(lagSeconds("2026-11-11T20:10:00.000Z", "unreadable"), -1);
});

test("the command line prints the decision and the lag", () => {
  const script = fileURLToPath(new URL("../scripts/live-page.mjs", import.meta.url));
  const run = (want, got) => spawnSync(process.execPath, [script, want, got], { encoding: "utf8" }).stdout.trim();
  assert.equal(run("2026-11-11T20:10:00Z", "2026-11-11T20:05:00Z"), "warn 300");
  assert.equal(run("2026-11-11T20:10:00Z", "2026-11-11T19:52:00Z"), "fail 1080");
  assert.equal(run("2026-11-11T20:10:00Z", "2026-11-11T18:55:27.931Z"), "warn 4472");
  assert.equal(run("2026-11-11T20:10:00Z", "unreadable"), "fail -1");
});
