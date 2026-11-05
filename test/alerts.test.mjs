// Discord alert decisions and delivery, including a whole run on disk.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decideAlert, isValidWebhook, sendDiscord } from "../monitor/alerts.mjs";
import { monitorOnce } from "../monitor/run.mjs";

const SITE = fileURLToPath(new URL("../site", import.meta.url));
const URL_OK = "https://discord.com/api/webhooks/123456/abc-DEF_1";
const status = (down = [], extra = {}) => ({
  checks: ["App", "Database", "Website", "Log in page"].map((name) => ({ id: name.toLowerCase(), name, status: down.includes(name) ? "down" : "operational" })),
  official: null,
  incidents: [],
  ...extra,
});

test("only a real Discord webhook address is accepted", () => {
  assert.ok(isValidWebhook(URL_OK));
  assert.ok(isValidWebhook("https://discordapp.com/api/webhooks/1/x"));
  for (const bad of [undefined, null, "", "http://discord.com/api/webhooks/1/x", "https://evil.com/api/webhooks/1/x", "https://discord.com.evil.com/api/webhooks/1/x", "https://discord.com/api/webhooks/1/x?wait=true", "https://discord.com/api/webhooks/abc/x"]) {
    assert.equal(isValidWebhook(bad), false, String(bad));
  }
});

test("nothing is sent while healthy, on a first run or otherwise", () => {
  assert.equal(decideAlert(undefined, status()), null);
  assert.equal(decideAlert([], status()), null);
});

test("an outage sends once and repeats only when the set of failures changes", () => {
  const first = decideAlert([], status(["App"]));
  assert.deepEqual(first.ids, ["app"]);
  assert.match(first.content, /App is failing/);
  assert.equal(decideAlert(["app"], status(["App"])), null);
  const wider = decideAlert(["app"], status(["App", "Database"]));
  assert.match(wider.content, /App, Database are failing/);
  assert.equal(decideAlert(["database", "app"], status(["App", "Database"])), null);
});

test("a first run during an outage still alerts", () => {
  assert.deepEqual(decideAlert(undefined, status(["App"])).ids, ["app"]);
});

test("recovery sends once", () => {
  const message = decideAlert(["app"], status());
  assert.deepEqual(message.ids, []);
  assert.match(message.content, /recovered/);
  assert.equal(decideAlert(message.ids, status()), null);
});

test("a check only suspected, not confirmed down, sends nothing", () => {
  const s = status();
  s.checks[0].status = "checking";
  assert.equal(decideAlert([], s), null);
  s.checks[0].status = "degraded";
  assert.equal(decideAlert([], s), null);
});

test("posted maintenance holds alerts, whichever list it came from", () => {
  assert.equal(decideAlert([], status(["App"], { official: { status: "maintenance", incidents: [] } })), null);
  assert.equal(decideAlert([], status(["App"], { incidents: [{ severity: "maintenance", resolvedAt: null }] })), null);
  assert.equal(decideAlert([], status(["App"], { official: { status: "operational", incidents: [{ severity: "maintenance", resolvedAt: null }] } })), null);
  assert.ok(decideAlert([], status(["App"], { incidents: [{ severity: "maintenance", resolvedAt: "2026-01-01T00:00:00Z" }] })));
});

test("the message mentions nobody, and passing failures retry while a dead webhook is reported", async () => {
  let body;
  const ok = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 204 }; };
  assert.equal(await sendDiscord(URL_OK, "@everyone hi", ok), "sent");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(await sendDiscord(URL_OK, "x".repeat(3000), ok), "sent");
  assert.equal(body.content.length, 2000);
  for (const code of [429, 500, 503]) assert.equal(await sendDiscord(URL_OK, "x", async () => ({ ok: false, status: code })), "retry", String(code));
  for (const code of [401, 403, 404]) assert.equal(await sendDiscord(URL_OK, "x", async () => ({ ok: false, status: code })), "broken", String(code));
  assert.equal(await sendDiscord(URL_OK, "x", async () => { throw new TypeError("network"); }), "retry");
});

let root;
before(async () => { root = await mkdtemp(join(tmpdir(), "alerts-test-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

async function paths(name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const incidentsPath = join(dir, "incidents.json");
  await writeFile(incidentsPath, "[]");
  return { stateDir: join(dir, "state"), siteDir: SITE, outDir: join(dir, "out"), incidentsPath, wait: async () => {} };
}

// Kanbedu answers with the given status; everything else behaves.
function kanbedu(health, discord, sent) {
  return async (url, init) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === "discord.com") {
      sent.push(JSON.parse(init.body).content);
      return { ok: discord < 400, status: discord };
    }
    if (hostname !== "kanbedu.com") return { status: 200, ok: true, url, headers: new Headers(), body: new Response(JSON.stringify({ status: { indicator: "none", description: "ok" }, components: [], incidents: [] })).body };
    const text = pathname === "/api/health" ? JSON.stringify({ ok: true, db: true }) : "<title>Kanbedu</title>";
    const status = pathname === "/api/health" ? health : 200;
    return { status, ok: status < 400, url, headers: new Headers(), body: new Response(text).body };
  };
}

test("whole runs: one alert per outage, a failed send retries, recovery follows", async () => {
  const p = await paths("flow");
  const sent = [];
  const run = (health, discord = 204) => monitorOnce({ ...p, webhookUrl: URL_OK, fetchImpl: kanbedu(health, discord, sent) });

  await run(200);
  assert.equal(sent.length, 0);
  await run(500); // first failure: Checking, never an alert
  assert.equal(sent.length, 0);
  const failed = await run(500, 500); // confirmed, Discord fails, so it must retry
  assert.equal(sent.length, 1);
  assert.equal(failed.alert, "retry");
  const retried = await run(500); // retried and delivered
  assert.equal(sent.length, 2);
  assert.equal(retried.alert, "sent");
  await run(500); // still down: nothing new
  assert.equal(sent.length, 2);
  await run(200);
  assert.equal(sent.length, 3);
  assert.match(sent[2], /recovered/);
  await run(200);
  assert.equal(sent.length, 3);
});

test("a run that learned nothing never alerts", async () => {
  const p = await paths("inconclusive");
  const sent = [];
  // Confirmed down, but Discord fails, so the alert is still owed.
  await monitorOnce({ ...p, webhookUrl: URL_OK, fetchImpl: kanbedu(500, 500, sent) });
  await monitorOnce({ ...p, webhookUrl: URL_OK, fetchImpl: kanbedu(500, 500, sent) });
  const before = sent.length;
  // Now every request fails, the monitor's network is gone, and Discord would answer.
  const offline = async (url, init) => {
    if (new URL(url).hostname === "discord.com") {
      sent.push(JSON.parse(init.body).content);
      return { ok: true, status: 204 };
    }
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  const result = await monitorOnce({ ...p, webhookUrl: URL_OK, fetchImpl: offline });
  assert.equal(result.inconclusive, true);
  assert.equal(sent.length, before);
});

test("no webhook configured, or a malformed one, sends nothing and fails nothing", async () => {
  for (const webhookUrl of [undefined, "", "not a url"]) {
    const p = await paths(`none-${webhookUrl}`.replace(/\W/g, ""));
    const sent = [];
    for (let i = 0; i < 2; i += 1) {
      const result = await monitorOnce({ ...p, webhookUrl, fetchImpl: kanbedu(500, 204, sent) });
      assert.equal(result.alert, null);
    }
    assert.equal(sent.length, 0);
  }
});

test("the webhook address is never written to the state or the public file", async () => {
  const p = await paths("secret");
  const sent = [];
  let last;
  for (let i = 0; i < 2; i += 1) last = await monitorOnce({ ...p, webhookUrl: URL_OK, fetchImpl: kanbedu(500, 204, sent) });
  assert.equal(sent.length, 1);
  for (const value of [last.state, last.publicStatus]) assert.ok(!JSON.stringify(value).includes("webhooks"));
  assert.ok(!("alert" in last.publicStatus));
});
