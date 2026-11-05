// Real HTTP against a local server that fails in each way the monitor must handle.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { attemptCheck, classifyError, fetchProvider, parseProviderSummary, runCheck } from "../monitor/checks.mjs";

let server;
let base;
const hits = {};

const routes = {
  "/healthy": (res) => json(res, 200, { ok: true, db: true }),
  "/db-down": (res) => json(res, 503, { ok: false, db: false, error: "DB unreachable" }),
  "/200-db-false": (res) => json(res, 200, { ok: true, db: false }),
  "/200-html": (res) => html(res, 200, "<title>Kanbedu</title>"),
  "/500": (res) => html(res, 500, "secret stack trace"),
  "/paused": (res) => html(res, 402, "payment required"),
  "/challenge": (res) => { res.setHeader("x-vercel-mitigated", "challenge"); html(res, 403, "challenge"); },
  "/rate-limited": (res) => html(res, 429, "slow down"),
  "/page": (res) => html(res, 200, "<html><title>Kanbedu - Boards</title></html>"),
  "/parked": (res) => html(res, 200, "<title>This domain is for sale</title>"),
  "/hang": () => {},
  "/hang-body": (res) => { res.writeHead(200, { "content-type": "text/html" }); res.write("<title>Kanbedu"); },
  "/slow": (res) => setTimeout(() => json(res, 200, { ok: true, db: true }), 120),
  "/reset": (res) => res.socket.destroy(),
  "/flaky": (res, n) => (n < 3 ? html(res, 500, "no") : json(res, 200, { ok: true, db: true })),
  "/huge": (res) => { res.writeHead(200); res.end("x".repeat(5 * 1024 * 1024)); },
  "/away": (res) => { res.writeHead(307, { location: "http://localhost:1/never" }); res.end(); },
  "/redirect-ok": (res) => { res.writeHead(307, { location: "/page" }); res.end(); },
};

function json(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function html(res, status, body) { res.writeHead(status, { "content-type": "text/html" }); res.end(body); }

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    (routes[path] ?? ((r) => html(r, 404, "no")))(res, hits[path]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

const cfg = () => ({ userAgent: "test", timeoutMs: 400, attempts: 3, retryDelaysMs: [0, 0], maxBodyBytes: 1024 * 1024, allowedHost: "127.0.0.1" });
const db = (path) => ({ url: base + path, kind: "json", expectJson: { ok: true, db: true }, slowMs: 3000 });
const page = (path) => ({ url: base + path, kind: "page", marker: "<title>Kanbedu", slowMs: 3000 });
const failed = (result) => result.conditions.filter((c) => !c.ok).map((c) => c.name);

test("healthy JSON passes", async () => {
  const r = await attemptCheck(db("/healthy"), cfg());
  assert.equal(r.outcome, "pass");
  assert.deepEqual(failed(r), []);
});

test("503 from a dead database fails", async () => {
  const r = await attemptCheck(db("/db-down"), cfg());
  assert.equal(r.outcome, "fail");
  assert.equal(r.note, "Answered 503");
});

test("200 with db false still fails", async () => {
  const r = await attemptCheck(db("/200-db-false"), cfg());
  assert.equal(r.outcome, "fail");
  assert.deepEqual(failed(r), ["Reports db is true"]);
});

test("200 HTML where JSON is expected fails", async () => {
  const r = await attemptCheck(db("/200-html"), cfg());
  assert.equal(r.outcome, "fail");
  assert.equal(r.note, "Unexpected health answer");
});

test("a 500 never publishes the response body", async () => {
  const r = await attemptCheck(page("/500"), cfg());
  assert.equal(r.outcome, "fail");
  assert.ok(!JSON.stringify(r).includes("secret"));
});

test("a 402 is reported as the host pausing the site", async () => {
  const r = await attemptCheck(page("/paused"), cfg());
  assert.equal(r.outcome, "fail");
  assert.equal(r.note, "The host has paused the site");
});

test("a firewall challenge is blocked, not a failure", async () => {
  assert.equal((await attemptCheck(page("/challenge"), cfg())).outcome, "blocked");
});

test("a 429 is blocked, not a failure", async () => {
  assert.equal((await attemptCheck(page("/rate-limited"), cfg())).outcome, "blocked");
});

test("a page with the right title passes", async () => {
  assert.equal((await attemptCheck(page("/page"), cfg())).outcome, "pass");
});

test("a 200 from a parked domain fails", async () => {
  const r = await attemptCheck(page("/parked"), cfg());
  assert.equal(r.outcome, "fail");
  assert.equal(r.note, "Unexpected page content");
});

test("a server that never answers times out", async () => {
  const r = await attemptCheck(page("/hang"), cfg());
  assert.equal(r.outcome, "fail");
  assert.equal(r.note, "Timed out");
});

test("a body that never finishes times out", async () => {
  const r = await attemptCheck(page("/hang-body"), cfg());
  assert.equal(r.outcome, "fail");
  assert.equal(r.note, "Timed out");
});

test("a dropped connection fails with a fixed label", async () => {
  const r = await attemptCheck(page("/reset"), cfg());
  assert.equal(r.outcome, "fail");
  assert.ok(["Connection failed", "Request failed"].includes(r.note));
});

test("an unresolvable host fails with a fixed label", async () => {
  const r = await attemptCheck({ ...page("/x"), url: "http://kanbedu-status-does-not-exist.invalid/" }, { ...cfg(), timeoutMs: 5000 });
  assert.equal(r.outcome, "fail");
  assert.ok(["DNS lookup failed", "Timed out", "Request failed"].includes(r.note));
});

test("a slow but correct answer is slow, not failed", async () => {
  const r = await attemptCheck({ ...db("/slow"), slowMs: 50 }, cfg());
  assert.equal(r.outcome, "slow");
});

test("an oversized body is cut off without failing the read", async () => {
  const r = await attemptCheck({ ...page("/huge"), marker: "xxx" }, cfg());
  assert.equal(r.outcome, "pass");
});

test("an internal redirect is followed", async () => {
  assert.equal((await attemptCheck(page("/redirect-ok"), cfg())).outcome, "pass");
});

test("a redirect to another host fails", async () => {
  const r = await attemptCheck(page("/redirect-ok"), { ...cfg(), allowedHost: "kanbedu.com" });
  assert.equal(r.outcome, "fail");
  assert.deepEqual(failed(r), ["Served from kanbedu.com"]);
});

test("retries recover a brief failure", async () => {
  hits["/flaky"] = 0;
  const r = await runCheck(db("/flaky"), cfg());
  assert.equal(r.outcome, "pass");
  assert.equal(r.attempts, 3);
});

test("retries stop at the limit and keep failing", async () => {
  hits["/500"] = 0;
  const r = await runCheck(page("/500"), cfg());
  assert.equal(r.outcome, "fail");
  assert.equal(r.attempts, 3);
  assert.equal(hits["/500"], 3);
});

test("a blocked answer is not retried", async () => {
  hits["/rate-limited"] = 0;
  await runCheck(page("/rate-limited"), cfg());
  assert.equal(hits["/rate-limited"], 1);
});

test("classifyError never returns raw error text", () => {
  assert.equal(classifyError(new Error("password=abc")), "Request failed");
  assert.equal(classifyError({ cause: { code: "CERT_HAS_EXPIRED" } }), "Certificate problem");
  assert.equal(classifyError({ cause: { code: "ENOTFOUND" } }), "DNS lookup failed");
});

const provider = { id: "p", name: "P", role: "R", page: "https://p", url: "" };

test("provider summary keeps fixed fields and lists affected parts", () => {
  const r = parseProviderSummary(provider, JSON.stringify({
    status: { indicator: "major", description: "Outage" },
    components: [{ name: "SIN1", status: "major_outage" }, { name: "OK", status: "operational" }, { name: "Group", status: "major_outage", group: true }],
    incidents: [{ name: "Errors", status: "investigating", secret: "x" }],
  }));
  assert.equal(r.indicator, "major");
  assert.deepEqual(r.affected, [{ name: "SIN1", status: "major_outage" }]);
  assert.deepEqual(r.incidents, [{ name: "Errors", status: "investigating" }]);
});

test("provider garbage becomes unknown", () => {
  assert.equal(parseProviderSummary(provider, "<html>").indicator, "unknown");
  assert.equal(parseProviderSummary(provider, '{"status":{"indicator":"weird"}}').indicator, "unknown");
  assert.equal(parseProviderSummary(provider, "null").indicator, "unknown");
});

test("an unreachable provider is marked unreachable, a 500 is reachable", async () => {
  const dead = await fetchProvider({ ...provider, url: "http://127.0.0.1:1/" }, cfg());
  assert.equal(dead.indicator, "unknown");
  assert.equal(dead.reachable, false);
  const errored = await fetchProvider({ ...provider, url: `${base}/500` }, cfg());
  assert.equal(errored.indicator, "unknown");
  assert.equal(errored.reachable, true);
});
