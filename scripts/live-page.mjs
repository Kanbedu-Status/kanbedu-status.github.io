// Decides whether a stale live page fails the monitor run. Used by the
// "Confirm the live page updated" step in .github/workflows/monitor.yml.
//
// GitHub Pages sometimes reports a deploy as successful and keeps serving an
// older build for hours (2026-11-08, 2026-11-11). Every run during such an
// outage sees the same stale page. Failing all of them sent an email every
// 5 minutes. A run fails only when the lag first crosses the threshold, and
// once more every REMIND_SECONDS while it lasts; the runs between warn.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A publish up to this many seconds late is normal and never fails a run. */
export const GRACE_SECONDS = 900;

/** Runs are scheduled every 5 minutes; each failure window is one run wide. */
export const WINDOW_SECONDS = 300;

/** While the page stays stale, fail again this often as a reminder. */
export const REMIND_SECONDS = 6 * 60 * 60;

/**
 * lag: seconds the live page is behind this run's data, or -1 when the live
 * data could not be read or parsed.
 * Returns "ok", "warn" or "fail".
 */
export function decide(lag) {
  if (!Number.isFinite(lag)) return "fail";
  if (lag < 0) return "fail";
  if (lag <= GRACE_SECONDS) return "warn";
  const past = lag - GRACE_SECONDS;
  if (past <= WINDOW_SECONDS) return "fail";
  // Half-open, so a run that lands exactly on a window edge is counted once.
  if (past >= REMIND_SECONDS && past % REMIND_SECONDS < WINDOW_SECONDS) return "fail";
  return "warn";
}

/** Seconds from got to want, both ISO timestamps, or -1 if either is unreadable. */
export function lagSeconds(want, got) {
  const l = (Date.parse(want) - Date.parse(got)) / 1000;
  return Number.isFinite(l) ? Math.round(l) : -1;
}

// Run as a command: node scripts/live-page.mjs <this run's generatedAt> <live generatedAt>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [want, got] = process.argv.slice(2);
  const lag = lagSeconds(want, got);
  console.log(`${decide(lag)} ${lag}`);
}
