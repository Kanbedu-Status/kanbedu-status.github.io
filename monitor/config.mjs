// Monitor configuration. No secrets belong here: this repository is public.

const BASE = "https://kanbedu.com";

export const config = {
  schemaVersion: 1,
  userAgent: "kanbedu-status-monitor/1.0",
  timeoutMs: 15000,
  // Attempts within one run before that run counts as a failure.
  attempts: 3,
  retryDelaysMs: [3000, 7000],
  // Confirmed failures needed before a check shows as down.
  downAfterFailures: 2,
  // Consecutive slow runs needed before a check shows as degraded.
  degradedAfterSlow: 2,
  historyDays: 90,
  recentRuns: 30,
  // Calendar days in Malaysia time (UTC+8).
  dayOffsetMinutes: 480,
  maxBodyBytes: 2 * 1024 * 1024,
  allowedHost: "kanbedu.com",
  // Severity decides the banner when the check is confirmed down.
  // "down" means Kanbedu cannot be used. "degraded" means part of it is affected.
  checks: [
    {
      id: "app",
      name: "App",
      description: "The server answers requests",
      url: `${BASE}/api/health?shallow=1`,
      kind: "json",
      expectJson: { ok: true },
      slowMs: 3000,
      everyMinutes: 0,
      severity: "down",
    },
    {
      id: "database",
      name: "Database",
      description: "The app can reach its database",
      url: `${BASE}/api/health`,
      kind: "json",
      expectJson: { ok: true, db: true },
      slowMs: 3000,
      everyMinutes: 0,
      severity: "down",
    },
    {
      // Pages render on every request, so they cost more hosting CPU than the
      // health routes. They run every 30 minutes unless something looks wrong.
      id: "website",
      name: "Website",
      description: "The public home page loads",
      url: `${BASE}/landing`,
      kind: "page",
      marker: "<title>Kanbedu",
      slowMs: 5000,
      everyMinutes: 30,
      severity: "degraded",
    },
    {
      id: "login",
      name: "Log in page",
      description: "The log in page loads",
      url: `${BASE}/login`,
      kind: "page",
      marker: "<title>Kanbedu",
      slowMs: 5000,
      everyMinutes: 30,
      severity: "degraded",
    },
  ],
  // The official status and incidents the page mirrors.
  officialUrl: `${BASE}/api/public/status`,
  // Internal only: when Kanbedu and all of these fail together, the monitor lost
  // its network, so the run is not recorded as an outage. Never published.
  providers: [
    { id: "vercel", name: "Vercel", role: "Hosting", url: "https://www.vercel-status.com/api/v2/summary.json", page: "https://www.vercel-status.com" },
    { id: "supabase", name: "Supabase", role: "Database", url: "https://status.supabase.com/api/v2/summary.json", page: "https://status.supabase.com" },
    { id: "brevo", name: "Brevo", role: "Email", url: "https://status.brevo.com/api/v2/summary.json", page: "https://status.brevo.com" },
  ],
};
