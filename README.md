# Kanbedu Status

An independent status page for Kanbedu. It shares nothing with the app: hosting is GitHub Pages, checks run on GitHub Actions, and it has no dependencies or secrets.

Built with Node 22 (monitor and tests, standard library only) and plain HTML, CSS and JavaScript (page).

## How it works

Each run of `.github/workflows/monitor.yml`:

1. Restores history from the `status-data` branch.
2. Checks the app, the database, and, every 30 minutes or sooner if something looks wrong, the website and log in page.
3. Reads the official status and incidents from `kanbedu.com/api/public/status`, and what Vercel, Supabase and Brevo report about themselves. The provider reports are internal only and are never published.
4. Saves history as one replacement commit on `status-data`, so the repository does not grow.
5. Deploys `site/` plus `data/status.json` to GitHub Pages.

| Rule | Behavior |
|---|---|
| Failed request | Retried twice within the run |
| First failed run | Shows "Checking", never "Down" |
| Second failed run in a row | Shows "Down" |
| Second slow run in a row | Shows "Degraded" |
| App or database down | Banner says Down |
| Website or log in page down | Banner says Degraded |
| No completed check for 30 minutes | Banner says Monitor Delayed, never a false green |
| Host firewall refuses the monitor, or the monitor loses its network | Recorded as no result, not as an outage |
| Admin posts a status or incident on kanbedu.com | Shown here within about 30 seconds, because the page reads it from the app directly |
| Kanbedu cannot answer | The last copy saved by the monitor stays on the page |
| Open maintenance incident | Banner says Under Maintenance, even if checks fail |

The job fails, and GitHub notifies whoever last edited the cron line, only when the monitor itself has a problem. Kanbedu being down is not a job failure.

## First-time setup

Before going public, tell Ming Hao: the page carries the product's name.

1. Create a free GitHub organization named `kanbedu-status`.
2. Create a public repository in it named `kanbedu-status.github.io`.
3. Settings, Pages, Build and deployment, Source: choose **GitHub Actions**.
4. Push this folder to `main`.
5. Actions tab: open the Monitor run and confirm it is green. If it is not listed, press **Run workflow**.
6. Open `https://kanbedu-status.github.io` and confirm the banner and the last check time.
7. Wait 30 minutes and confirm new checks keep arriving.
8. In Actions, confirm the logged status lines show all checks passing from GitHub's servers.

Do not add a custom domain under `kanbedu.com`. GitHub would redirect the `github.io` address to it, and that domain's DNS is on Vercel.

## Scheduled runs

GitHub's schedule alone is not reliable here, so cron-job.org starts a run every 5 minutes. The cron line stays as a backup.

| Setting | Value |
|---|---|
| URL | `https://api.github.com/repos/Kanbedu-Status/kanbedu-status.github.io/actions/workflows/monitor.yml/dispatches` |
| Method | POST |
| Body | `{"ref":"main"}` |
| Headers | `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json` |
| Token | Fine-grained, resource owner `Kanbedu-Status`, only this repository, Actions: Read and write, nothing else |

The token can start and read runs in this one repository, and nothing else. It expires, so note the date and replace it before then, or the page goes to Monitor Delayed.

## Outage alerts

Set the `DISCORD_WEBHOOK_URL` repository secret to turn alerts on. One message when a check is confirmed down, one if the set of failing checks changes, and one on recovery. Nothing is sent during posted maintenance. To test the channel, run the Monitor workflow with `test_alert` on.

Alerts run inside the monitor, so they stop if the runs stop. cron-job.org's own failure email covers that.

## Posting an incident

Post on the admin dashboard at kanbedu.com: the incident shows here too. Use the file below only when the app is down and the dashboard cannot be reached. It works from a phone. A copy of an official incident, with the same title and start minute, shows once.

1. Open `incidents/incidents.json` on GitHub and press the edit button.
2. Add an entry, using the template below, and commit to `main`. The page updates in about a minute.
3. When it is over, change `resolvedAt` from `null` to the end time and commit again.

```json
[
  {
    "id": "2026-11-05-database",
    "title": "Database connection problems",
    "severity": "down",
    "message": "Kanbedu is currently unavailable.\nWe are aware of the issue and are working to restore service as soon as possible.",
    "startedAt": "2026-11-05T14:30:00+08:00",
    "resolvedAt": null
  }
]
```

`severity` is `degraded`, `down` or `maintenance`. Entries are separated by commas. `\n` is a line break. A broken edit does not harm the page: the last valid list stays published and the Actions run turns red with the exact error.

### Approved wordings

Use these verbatim as `message`.

| State | Message |
|---|---|
| Major update | `A major update is being rolled out.\nKanbedu is receiving a significant update with improvements across the platform. The rollout is currently underway and no service interruption is expected.` |
| Degraded | `Some Kanbedu features may be affected.\nWe are currently investigating an issue affecting parts of the platform. Some features may be slower than usual or temporarily unavailable.` |
| Maintenance | `Scheduled maintenance is underway.\nKanbedu is currently undergoing maintenance. Some features may be temporarily unavailable while we work to improve the platform.` |
| Down | `Kanbedu is currently unavailable.\nWe are aware of the issue and are working to restore service as soon as possible.` |
| Security | `Kanbedu has been temporarily restricted.\nWe have identified an issue requiring immediate attention and have temporarily restricted access while we investigate and resolve it.` |

## Local commands

```
node --test
node scripts/preview.mjs
```

The preview runs at `http://localhost:4173` with fake data for every state. It is not deployed.

## Limits

- GitHub cron has a 5 minute minimum and can run late, especially under load.
- GitHub can delay or drop scheduled runs. After the first push on 2026-11-05 it ran the schedule once in 9.5 hours. A manual run proves nothing about the schedule, so read the run list.
- It does not check signed-in actions, email delivery or notifications.
- If GitHub Actions is down, the page shows Monitor Delayed. If GitHub Pages is down, the page is down.
- GitHub's Actions terms limit hosted runners to activity related to the repository's own software project. Monitoring is common practice but sits in a grey area. If GitHub restricted it, the page would show Monitor Delayed and the checks would need a new home.

## After moving hosts

Checks target `kanbedu.com`, so they keep working through a move to Cloudflare. In `monitor/config.mjs`, replace the Vercel provider with Cloudflare (`https://www.cloudflarestatus.com/api/v2/summary.json`). The `x-vercel-*` header handling in `monitor/checks.mjs` becomes unused at that point.
