// Network layer. Publishes fixed labels only: response bodies and raw error
// text never reach the public data file.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Maps a fetch failure to a fixed public label.
export function classifyError(error) {
  const name = error?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return "Timed out";
  const code = error?.cause?.code ?? error?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup failed";
  if (/CERT|SSL|TLS/i.test(String(code))) return "Certificate problem";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") {
    return "Connection failed";
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "ETIMEDOUT") {
    return "Timed out";
  }
  return "Request failed";
}

// Reads at most maxBytes, then stops, so a huge response cannot exhaust memory.
export async function readCapped(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return text;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// One request. Returns { outcome, ms, conditions, note }.
// outcome: "pass" | "slow" | "fail" | "blocked"
export async function attemptCheck(check, cfg, fetchImpl = fetch) {
  const started = performance.now();
  let response;
  let body = "";
  try {
    response = await fetchImpl(check.url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers: { "user-agent": cfg.userAgent, accept: check.kind === "json" ? "application/json" : "text/html" },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    body = await readCapped(response, cfg.maxBodyBytes);
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const note = classifyError(error);
    return { outcome: "fail", ms, note, conditions: [{ name: "Responds", ok: false }] };
  }
  const ms = Math.round(performance.now() - started);

  // A firewall or rate limit refusing this monitor says nothing about users.
  const mitigated = response.headers.get("x-vercel-mitigated");
  if (response.status === 429 || mitigated) {
    return {
      outcome: "blocked",
      ms,
      note: "The host refused this monitor",
      conditions: [{ name: "Monitor allowed by host", ok: false }],
    };
  }

  const conditions = [{ name: "Status is 200", ok: response.status === 200 }];
  let note = null;
  if (response.status === 402 || response.headers.get("x-vercel-error") === "DEPLOYMENT_DISABLED") {
    note = "The host has paused the site";
  } else if (response.status !== 200) {
    note = `Answered ${response.status}`;
  }

  const finalHost = response.url ? hostOf(response.url) : null;
  const allowedHost = cfg.allowedHost;
  conditions.push({ name: `Served from ${allowedHost}`, ok: finalHost === allowedHost });
  if (finalHost !== allowedHost && !note) note = "Redirected to another site";

  if (check.kind === "json") {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    for (const [key, expected] of Object.entries(check.expectJson)) {
      const label = `Reports ${key} is ${expected}`;
      const ok = parsed !== null && typeof parsed === "object" && parsed[key] === expected;
      conditions.push({ name: label, ok });
      if (!ok && !note) note = "Unexpected health answer";
    }
  } else {
    const ok = body.includes(check.marker);
    conditions.push({ name: "Page content is Kanbedu", ok });
    if (!ok && !note) note = "Unexpected page content";
  }

  const healthy = conditions.every((c) => c.ok);
  const fast = ms < check.slowMs;
  conditions.push({ name: `Response under ${check.slowMs} ms`, ok: fast });
  if (!healthy) return { outcome: "fail", ms, note, conditions };
  return { outcome: fast ? "pass" : "slow", ms, note: fast ? null : "Slow response", conditions };
}

// Retries failures within the run. A slow or blocked answer is final.
export async function runCheck(check, cfg, fetchImpl = fetch, wait = sleep) {
  let last = null;
  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    last = await attemptCheck(check, cfg, fetchImpl);
    if (last.outcome !== "fail") return { ...last, attempts: attempt };
    if (attempt < cfg.attempts) await wait(cfg.retryDelaysMs[attempt - 1] ?? 0);
  }
  return { ...last, attempts: cfg.attempts };
}

const INDICATORS = new Set(["none", "minor", "major", "critical", "maintenance"]);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

// Reduces a provider's Statuspage summary to fixed fields. Anything unexpected
// becomes "unknown", which never changes the Kanbedu banner.
export function parseProviderSummary(provider, text) {
  const base = { id: provider.id, name: provider.name, role: provider.role, page: provider.page };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...base, indicator: "unknown", description: "Could not read this provider's report", reachable: true, affected: [], incidents: [] };
  }
  const indicator = parsed?.status?.indicator;
  if (!INDICATORS.has(indicator)) {
    return { ...base, indicator: "unknown", description: "Could not read this provider's report", reachable: true, affected: [], incidents: [] };
  }
  const components = Array.isArray(parsed.components) ? parsed.components : [];
  const affected = components
    .filter((c) => c && c.group !== true && typeof c.status === "string" && c.status !== "operational")
    .slice(0, 8)
    .map((c) => ({ name: clip(c.name, 80), status: clip(c.status, 40) }));
  const incidents = (Array.isArray(parsed.incidents) ? parsed.incidents : [])
    .slice(0, 3)
    .map((i) => ({ name: clip(i?.name, 160), status: clip(i?.status, 40) }));
  return { ...base, indicator, description: clip(parsed.status.description, 120), reachable: true, affected, incidents };
}

export async function fetchProvider(provider, cfg, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(provider.url, {
      headers: { "user-agent": cfg.userAgent, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await readCapped(response, cfg.maxBodyBytes);
    if (!response.ok) {
      return { id: provider.id, name: provider.name, role: provider.role, page: provider.page, indicator: "unknown", description: "Could not read this provider's report", reachable: true, affected: [], incidents: [] };
    }
    return parseProviderSummary(provider, text);
  } catch {
    return { id: provider.id, name: provider.name, role: provider.role, page: provider.page, indicator: "unknown", description: "Could not reach this provider's report", reachable: false, affected: [], incidents: [] };
  }
}
