// One monitor run: check, update state, write the deployable site.
// Exit code 0 means the monitor worked, even if Kanbedu is down.
// Exit code 1 means the monitor needs attention, so GitHub notifies the owner.

import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as defaultConfig } from "./config.mjs";
import { fetchOfficial, fetchProvider, runCheck } from "./checks.mjs";
import { validateIncidents } from "./incidents.mjs";
import { applyRun, assertValidState, buildPublicStatus, emptyState, isDue } from "./state.mjs";

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path, text) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

// A missing file is a first run. A file that cannot be parsed stops the run,
// so history is never replaced with an empty state.
export async function loadState(path, cfg) {
  const text = await readIfExists(path);
  if (text === null) return emptyState(cfg);
  const state = JSON.parse(text);
  assertValidState(state, cfg);
  return state;
}

export async function runChecks(state, nowIso, cfg, fetchImpl, wait) {
  const results = {};
  const everyRun = cfg.checks.filter((c) => !c.everyMinutes);
  const interval = cfg.checks.filter((c) => c.everyMinutes);
  for (const check of everyRun) results[check.id] = await runCheck(check, cfg, fetchImpl, wait);
  const anyHealthFailed = everyRun.some((c) => results[c.id].outcome === "fail");
  for (const check of interval) {
    if (isDue(check, state.checks[check.id], nowIso, anyHealthFailed)) {
      results[check.id] = await runCheck(check, cfg, fetchImpl, wait);
    }
  }
  return results;
}

export async function monitorOnce({ stateDir, siteDir, outDir, incidentsPath, cfg = defaultConfig, fetchImpl = fetch, wait, now = () => new Date() }) {
  const statePath = join(stateDir, "state.json");
  const lastGoodPath = join(stateDir, "incidents-last-good.json");
  await mkdir(stateDir, { recursive: true });

  const previous = await loadState(statePath, cfg);

  // Incidents: a bad edit keeps the last good list published and flags the job.
  const incidentsText = await readFile(incidentsPath, "utf8");
  const validation = validateIncidents(incidentsText);
  let incidents;
  let incidentErrors = [];
  if (validation.ok) {
    incidents = validation.incidents;
    await writeAtomic(lastGoodPath, JSON.stringify(incidents, null, 1));
  } else {
    incidentErrors = validation.errors;
    const lastGood = await readIfExists(lastGoodPath);
    incidents = lastGood === null ? [] : JSON.parse(lastGood);
  }

  const startedAt = now().toISOString();
  const results = await runChecks(previous, startedAt, cfg, fetchImpl, wait);
  const providers = await Promise.all(cfg.providers.map((p) => fetchProvider(p, cfg, fetchImpl)));
  const official = await fetchOfficial(cfg, fetchImpl);
  const { state, inconclusive } = applyRun(previous, results, providers, startedAt, cfg);
  if (official) state.official = official;
  const publicStatus = buildPublicStatus(state, incidents, inconclusive, startedAt, cfg);

  await writeAtomic(statePath, JSON.stringify(state));

  await mkdir(outDir, { recursive: true });
  await cp(siteDir, outDir, { recursive: true });
  await mkdir(join(outDir, "data"), { recursive: true });
  await writeAtomic(join(outDir, "data", "status.json"), JSON.stringify(publicStatus));

  return { state, publicStatus, providers, official, inconclusive, incidentErrors };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const { state, publicStatus, providers, official, inconclusive, incidentErrors } = await monitorOnce({
      stateDir: args.state ?? "state",
      siteDir: args.site ?? "site",
      outDir: args.out ?? "_site",
      incidentsPath: args.incidents ?? "incidents/incidents.json",
    });
    for (const check of publicStatus.checks) {
      console.log(`${check.id}: ${check.status} ${state.checks[check.id]?.lastMs ?? "-"} ms ${check.note ?? ""}`);
    }
    for (const provider of providers) console.log(`${provider.id}: ${provider.indicator}`);
    console.log(official ? `official: ${official.status}, ${official.incidents.length} incidents` : "official: no answer, kept the last copy");
    if (inconclusive) console.log("Run was inconclusive and was not recorded against Kanbedu.");
    if (incidentErrors.length > 0) {
      console.error("incidents/incidents.json is invalid. The last good list was published.");
      for (const message of incidentErrors) console.error(`  ${message}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Monitor failed: ${error.message}`);
    process.exitCode = 1;
  }
}
