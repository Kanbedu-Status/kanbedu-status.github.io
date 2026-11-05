// Whole-run behavior on disk, and the git scripts against a throwaway remote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { config } from "../monitor/config.mjs";
import { monitorOnce } from "../monitor/run.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(REPO, "site");
let root;

before(async () => { root = await mkdtemp(join(tmpdir(), "status-test-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

const HEALTH = { ok: true, db: true };
const PROVIDER = { status: { indicator: "none", description: "All Systems Operational" }, components: [], incidents: [] };

// Serves healthy answers unless a test overrides a path.
function fakeFetch(overrides = {}, calls = []) {
  return async (url) => {
    calls.push(url);
    const { hostname, pathname } = new URL(url);
    const override = overrides[pathname] ?? overrides[hostname];
    if (override === "throw") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const status = override ?? 200;
    const isHealth = pathname === "/api/health";
    if (pathname === "/api/public/status" && overrides.official) {
      return { status, ok: status < 400, url, headers: new Headers(), body: new Response(JSON.stringify(overrides.official)).body };
    }
    const isProvider = hostname !== "kanbedu.com";
    const text = isProvider ? JSON.stringify(PROVIDER) : isHealth ? JSON.stringify(HEALTH) : "<title>Kanbedu</title>";
    return { status, ok: status < 400, url, headers: new Headers(), body: new Response(text).body };
  };
}

async function setup(name, incidents = "[]") {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const incidentsPath = join(dir, "incidents.json");
  await writeFile(incidentsPath, incidents);
  return { stateDir: join(dir, "state"), outDir: join(dir, "out"), siteDir: SITE, incidentsPath, wait: async () => {} };
}

test("a first run writes state and a complete site", async () => {
  const paths = await setup("first");
  const { publicStatus } = await monitorOnce({ ...paths, fetchImpl: fakeFetch() });
  assert.equal(publicStatus.checks.length, config.checks.length);
  assert.ok(publicStatus.checks.every((c) => c.status === "operational"));
  for (const file of ["index.html", "app.js", "logic.js", "styles.css", "fonts/Geist-Regular.woff2", "data/status.json"]) {
    assert.ok(existsSync(join(paths.outDir, file)), file);
  }
  assert.ok(existsSync(join(paths.stateDir, "state.json")));
});

test("Kanbedu being down does not fail the run, and shows down on the second run", async () => {
  const paths = await setup("down");
  const fetchImpl = fakeFetch({ "/api/health": 503 });
  const first = await monitorOnce({ ...paths, fetchImpl });
  assert.equal(first.publicStatus.checks.find((c) => c.id === "database").status, "checking");
  const second = await monitorOnce({ ...paths, fetchImpl });
  assert.equal(second.publicStatus.checks.find((c) => c.id === "database").status, "down");
});

test("history survives across runs", async () => {
  const paths = await setup("survive");
  await monitorOnce({ ...paths, fetchImpl: fakeFetch() });
  const { publicStatus } = await monitorOnce({ ...paths, fetchImpl: fakeFetch() });
  assert.equal(Object.values(publicStatus.checks[0].days)[0].runs, 2);
});

test("page checks skip when not due and run when health fails", async () => {
  const paths = await setup("due");
  const times = [new Date("2026-11-04T06:00:00Z"), new Date("2026-11-04T06:05:00Z"), new Date("2026-11-04T06:10:00Z")];
  let i = 0;
  const now = () => times[i];
  const countLanding = (calls) => calls.filter((u) => u.endsWith("/landing")).length;
  let calls = [];
  await monitorOnce({ ...paths, now, fetchImpl: fakeFetch({}, calls) });
  assert.equal(countLanding(calls), 1);
  i = 1; calls = [];
  await monitorOnce({ ...paths, now, fetchImpl: fakeFetch({}, calls) });
  assert.equal(countLanding(calls), 0);
  i = 2; calls = [];
  await monitorOnce({ ...paths, now, fetchImpl: fakeFetch({ "/api/health": 500 }, calls) });
  assert.equal(countLanding(calls), 1);
});

test("a corrupt state file stops the run and is left untouched", async () => {
  const paths = await setup("corrupt");
  await mkdir(paths.stateDir, { recursive: true });
  const statePath = join(paths.stateDir, "state.json");
  await writeFile(statePath, "{ truncated");
  await assert.rejects(monitorOnce({ ...paths, fetchImpl: fakeFetch() }));
  assert.equal(await readFile(statePath, "utf8"), "{ truncated");
  assert.ok(!existsSync(join(paths.outDir, "data", "status.json")));
});

test("a state file from another schema stops the run and is left untouched", async () => {
  const paths = await setup("schema");
  await mkdir(paths.stateDir, { recursive: true });
  const statePath = join(paths.stateDir, "state.json");
  const original = JSON.stringify({ schemaVersion: 99, checks: { app: { keep: true } } });
  await writeFile(statePath, original);
  await assert.rejects(monitorOnce({ ...paths, fetchImpl: fakeFetch() }), /schema/i);
  assert.equal(await readFile(statePath, "utf8"), original);
});

test("a bad incident edit keeps the last good list and still publishes", async () => {
  const good = JSON.stringify([{ id: "a", title: "Real", severity: "down", message: null, startedAt: "2026-11-05T14:30:00+08:00", resolvedAt: null }]);
  const paths = await setup("incidents", good);
  await monitorOnce({ ...paths, fetchImpl: fakeFetch() });
  await writeFile(paths.incidentsPath, "[{ oops");
  const { publicStatus, incidentErrors } = await monitorOnce({ ...paths, fetchImpl: fakeFetch() });
  assert.ok(incidentErrors.length > 0);
  assert.equal(publicStatus.incidents[0].title, "Real");
  assert.ok(existsSync(join(paths.outDir, "data", "status.json")));
});

test("the monitor losing its network does not record an outage", async () => {
  const paths = await setup("offline");
  await monitorOnce({ ...paths, now: () => new Date("2026-11-04T06:00:00Z"), fetchImpl: fakeFetch() });
  const offline = async () => { throw new TypeError("fetch failed"); };
  const { publicStatus, inconclusive } = await monitorOnce({ ...paths, now: () => new Date("2026-11-04T06:05:00Z"), fetchImpl: offline });
  assert.equal(inconclusive, true);
  assert.ok(publicStatus.checks.every((c) => c.status === "operational"));
  assert.equal(publicStatus.lastConclusiveAt, "2026-11-04T06:00:00.000Z");
});

test("a provider outage does not change Kanbedu checks", async () => {
  const paths = await setup("provider");
  const { publicStatus } = await monitorOnce({ ...paths, fetchImpl: fakeFetch({ "status.supabase.com": "throw" }) });
  assert.ok(publicStatus.checks.every((c) => c.status === "operational"));
  assert.ok(!JSON.stringify(publicStatus).includes("Supabase"));
});

test("the published file holds no response bodies", async () => {
  const paths = await setup("bodies");
  const { publicStatus } = await monitorOnce({ ...paths, fetchImpl: fakeFetch({ "/login": 500 }) });
  assert.ok(!JSON.stringify(publicStatus).includes("<title>"));
});

// Git scripts. Skipped only if bash is missing.
// On Windows, plain "bash" can resolve to the WSL stub, which cannot run these paths.
const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";
const BASH = process.platform === "win32" ? GIT_BASH : "bash";
const hasBash = spawnSync(BASH, ["--version"]).status === 0;
const sh = (cwd, script) => spawnSync(BASH, [join(REPO, "scripts", script)], { cwd, encoding: "utf8" });
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

async function gitClone(name) {
  const dir = join(root, name);
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", remote);
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  return { remote, work };
}

test("state scripts: first run, save, restore, one commit only", { skip: !hasBash }, async () => {
  const { remote, work } = await gitClone("git-ok");
  let r = sh(work, "restore-state.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Starting a new history/);

  for (const value of ["one", "two", "three"]) {
    await writeFile(join(work, "state", "state.json"), JSON.stringify({ value }));
    r = sh(work, "save-state.sh");
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(git(remote, "rev-list", "--count", "status-data"), "1");
  assert.equal(git(remote, "show", "status-data:state.json"), '{"value":"three"}');
  assert.equal(git(remote, "rev-list", "--count", "main"), "1");

  await rm(join(work, "state"), { recursive: true });
  r = sh(work, "restore-state.sh");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await readFile(join(work, "state", "state.json"), "utf8"), '{"value":"three"}');
});

test("restore stops on a remote error rather than starting fresh", { skip: !hasBash }, async () => {
  const { work } = await gitClone("git-dead");
  git(work, "remote", "set-url", "origin", join(root, "does-not-exist.git"));
  const r = sh(work, "restore-state.sh");
  assert.notEqual(r.status, 0);
  assert.deepEqual(await readdir(join(work, "state")), []);
});

test("save refuses to push when there is no state", { skip: !hasBash }, async () => {
  const { remote, work } = await gitClone("git-empty");
  const r = sh(work, "save-state.sh");
  assert.notEqual(r.status, 0);
  const refs = spawnSync("git", ["show-ref", "status-data"], { cwd: remote, encoding: "utf8" });
  assert.notEqual(refs.status, 0);
});

test("scripts and workflow use LF line endings", async () => {
  for (const file of ["scripts/restore-state.sh", "scripts/save-state.sh", ".github/workflows/monitor.yml"]) {
    assert.ok(!(await readFile(join(REPO, file), "utf8")).includes("\r"), file);
  }
});

test("workflow pins every action to a full commit and never pushes to main", async () => {
  const text = await readFile(join(REPO, ".github/workflows/monitor.yml"), "utf8");
  const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(uses.length, 4);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);
  const save = await readFile(join(REPO, "scripts/save-state.sh"), "utf8");
  assert.match(save, /refs\/heads\/status-data/);
  assert.ok(!/refs\/heads\/main/.test(save));
});

test("no file in the repo uses banned characters", async () => {
  const banned = new RegExp(String.raw`\u2014|\p{Extended_Pictographic}`, "u");
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "fonts", "assets", "_site", "state"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else assert.ok(!banned.test(await readFile(path, "utf8")), path);
    }
  };
  await walk(REPO);
});

test("site copy does not depend on anything outside itself", async () => {
  const html = await readFile(join(SITE, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.every((r) => r.startsWith("https://kanbedu.com/")), refs.join());
  await cp(SITE, join(root, "site-copy"), { recursive: true });
});

const OFFICIAL = {
  status: "operational",
  message: null,
  updatedAt: "2026-10-13T22:43:00.000Z",
  incidents: [{ id: "cuid1", title: "Elevated errors", severity: "down", message: "Database issue.", startedAt: "2026-08-28T11:45:00.000Z", resolvedAt: "2026-08-28T13:18:00.000Z" }],
};

test("the official status is published, and the last copy survives a failed fetch", async () => {
  const paths = await setup("official");
  const first = await monitorOnce({ ...paths, fetchImpl: fakeFetch({ official: OFFICIAL }) });
  assert.deepEqual(first.publicStatus.official, OFFICIAL);
  const second = await monitorOnce({ ...paths, fetchImpl: fakeFetch({ "/api/public/status": 404 }) });
  assert.deepEqual(second.publicStatus.official, OFFICIAL);
  assert.equal(second.official, null);
});

test("a missing official route publishes nothing and fails nothing", async () => {
  const paths = await setup("official-missing");
  const { publicStatus } = await monitorOnce({ ...paths, fetchImpl: fakeFetch({ "/api/public/status": 404 }) });
  assert.equal(publicStatus.official, null);
  assert.ok(publicStatus.checks.every((c) => c.status === "operational"));
});

test("an error status is never read as an official answer, even with a valid body", async () => {
  const paths = await setup("official-error");
  const { publicStatus } = await monitorOnce({ ...paths, fetchImpl: fakeFetch({ official: OFFICIAL, "/api/public/status": 500 }) });
  assert.equal(publicStatus.official, null);
});

test("a malformed official answer does not replace the last copy", async () => {
  const paths = await setup("official-bad");
  await monitorOnce({ ...paths, fetchImpl: fakeFetch({ official: OFFICIAL }) });
  const { publicStatus } = await monitorOnce({ ...paths, fetchImpl: fakeFetch({ official: { status: "fine", incidents: "none" } }) });
  assert.deepEqual(publicStatus.official, OFFICIAL);
});
