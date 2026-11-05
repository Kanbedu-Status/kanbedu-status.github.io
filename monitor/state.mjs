// Pure state logic. No network or disk access, so every path is unit tested.

export function emptyState(cfg) {
  return { schemaVersion: cfg.schemaVersion, lastRunAt: null, lastConclusiveAt: null, checks: {} };
}

function emptyCheck() {
  return {
    status: "operational",
    since: null,
    failStreak: 0,
    slowStreak: 0,
    firstFailDay: null,
    lastRunAt: null,
    lastMs: null,
    note: null,
    recent: [],
    days: {},
  };
}

// Throws on a state file that does not match, so it is never overwritten.
export function assertValidState(state, cfg) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("State is not an object");
  if (state.schemaVersion !== cfg.schemaVersion) throw new Error(`State schema ${state.schemaVersion} is not ${cfg.schemaVersion}`);
  if (!state.checks || typeof state.checks !== "object") throw new Error("State has no checks");
  for (const [id, check] of Object.entries(state.checks)) {
    if (!check || typeof check !== "object" || !Array.isArray(check.recent) || typeof check.days !== "object" || check.days === null) {
      throw new Error(`State for check ${id} is malformed`);
    }
  }
}

export function dayKey(iso, offsetMinutes) {
  return new Date(new Date(iso).getTime() + offsetMinutes * 60000).toISOString().slice(0, 10);
}

function emptyDay() {
  return { runs: 0, pass: 0, slow: 0, fail: 0, down: 0, msSum: 0, msCount: 0, msMax: 0 };
}

function pruneDays(days, nowIso, cfg) {
  const cutoff = dayKey(new Date(new Date(nowIso).getTime() - (cfg.historyDays - 1) * 86400000).toISOString(), cfg.dayOffsetMinutes);
  for (const key of Object.keys(days)) {
    if (key < cutoff) delete days[key];
  }
}

// A check runs when its interval has passed, when it is already unhealthy, or
// when a health check just failed in this same run.
export function isDue(check, stateCheck, nowIso, anyHealthFailed) {
  if (!check.everyMinutes) return true;
  if (anyHealthFailed) return true;
  if (!stateCheck?.lastRunAt) return true;
  if (stateCheck.failStreak > 0 || stateCheck.slowStreak > 0) return true;
  // One minute of tolerance, because runs do not start exactly on time.
  const elapsedMin = (new Date(nowIso).getTime() - new Date(stateCheck.lastRunAt).getTime()) / 60000;
  return elapsedMin >= check.everyMinutes - 1;
}

// All results refused or unreachable means the monitor learned nothing. It
// must not record that as a Kanbedu outage.
export function isInconclusive(results, providers) {
  const values = Object.values(results);
  if (values.length === 0) return false;
  if (values.every((r) => r.outcome === "blocked")) return true;
  const allFailed = values.every((r) => r.outcome === "fail" || r.outcome === "blocked");
  const noProviderReached = providers.length > 0 && providers.every((p) => p.reachable === false);
  return allFailed && noProviderReached;
}

function deriveStatus(entry, cfg) {
  if (entry.failStreak >= cfg.downAfterFailures) return "down";
  if (entry.failStreak > 0) return "checking";
  if (entry.slowStreak >= cfg.degradedAfterSlow) return "degraded";
  return "operational";
}

function applyResult(entry, result, nowIso, cfg) {
  const today = dayKey(nowIso, cfg.dayOffsetMinutes);
  entry.days[today] ??= emptyDay();
  const day = entry.days[today];

  if (result.outcome === "blocked") {
    // Not counted for or against uptime, and streaks stay as they were.
    entry.note = result.note ?? null;
    entry.lastRunAt = nowIso;
  } else {
    day.runs += 1;
    if (result.outcome === "fail") {
      day.fail += 1;
      entry.failStreak += 1;
      entry.slowStreak = 0;
      if (entry.failStreak === 1) entry.firstFailDay = today;
      if (entry.failStreak === cfg.downAfterFailures) {
        // Confirmed, so the first failed run counts as down as well.
        (entry.days[entry.firstFailDay] ?? day).down += 1;
        day.down += cfg.downAfterFailures - 1;
      } else if (entry.failStreak > cfg.downAfterFailures) {
        day.down += 1;
      }
    } else {
      entry.failStreak = 0;
      entry.firstFailDay = null;
      if (result.outcome === "slow") {
        day.slow += 1;
        entry.slowStreak += 1;
      } else {
        day.pass += 1;
        entry.slowStreak = 0;
      }
      day.msSum += result.ms;
      day.msCount += 1;
      day.msMax = Math.max(day.msMax, result.ms);
    }
    entry.note = result.note ?? null;
    entry.lastRunAt = nowIso;
    entry.lastMs = result.ms;
  }

  const status = deriveStatus(entry, cfg);
  if (status !== entry.status || entry.since === null) entry.since = nowIso;
  entry.status = status;

  entry.recent.push({
    at: nowIso,
    outcome: result.outcome,
    ms: result.ms,
    attempts: result.attempts ?? 1,
    note: result.note ?? null,
    conditions: result.conditions ?? [],
  });
  if (entry.recent.length > cfg.recentRuns) entry.recent.splice(0, entry.recent.length - cfg.recentRuns);
  pruneDays(entry.days, nowIso, cfg);
}

// Returns a new state. Checks missing from results keep their last status.
export function applyRun(previous, results, providers, nowIso, cfg) {
  const state = structuredClone(previous);
  const inconclusive = isInconclusive(results, providers);
  state.lastRunAt = nowIso;
  if (!inconclusive) {
    state.lastConclusiveAt = nowIso;
    for (const check of cfg.checks) {
      state.checks[check.id] ??= emptyCheck();
      if (results[check.id]) applyResult(state.checks[check.id], results[check.id], nowIso, cfg);
      pruneDays(state.checks[check.id].days, nowIso, cfg);
    }
  }
  for (const id of Object.keys(state.checks)) {
    // Keeps history for a check removed from config until it ages out.
    if (!cfg.checks.some((c) => c.id === id)) pruneDays(state.checks[id].days, nowIso, cfg);
  }
  return { state, inconclusive };
}

// The public file. Contains no bodies, headers or raw errors.
export function buildPublicStatus(state, providers, incidents, inconclusive, nowIso, cfg) {
  return {
    schemaVersion: cfg.schemaVersion,
    generatedAt: nowIso,
    lastConclusiveAt: state.lastConclusiveAt,
    inconclusive,
    historyDays: cfg.historyDays,
    checks: cfg.checks.map((check) => {
      const entry = state.checks[check.id] ?? emptyCheck();
      return {
        id: check.id,
        name: check.name,
        description: check.description,
        severity: check.severity,
        everyMinutes: check.everyMinutes,
        status: entry.status,
        since: entry.since,
        note: entry.note,
        lastRunAt: entry.lastRunAt,
        lastMs: entry.lastMs,
        recent: entry.recent,
        days: entry.days,
      };
    }),
    providers,
    incidents,
  };
}
