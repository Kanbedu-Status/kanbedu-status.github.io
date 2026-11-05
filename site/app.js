// Page rendering. All text goes through textContent, so data cannot inject markup.
import {
  BANNERS,
  SUPPORTED_SCHEMA,
  averageMs,
  bannerKey,
  checkLabel,
  dayBars,
  dayTooltip,
  formatIncidentDate,
  formatStamp,
  incidentUpdates,
  isStale,
  outcomeLabel,
  plural,
  providerLabel,
  relativeTime,
  uptimePercent,
  visibleIncidents,
} from "./logic.js";

const REFRESH_MS = 60000;
const root = document.getElementById("app");
const tip = document.getElementById("tip");
let current = null;
let lastFetchFailed = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function pill(tone, label) {
  const node = el("span", `pill tone-${tone}`);
  node.append(el("span", "dot"), el("span", null, label));
  return node;
}

function hideTip() {
  tip.hidden = true;
  tip.replaceChildren();
}

function showTip(lines, anchor) {
  tip.replaceChildren(...lines.map((line, index) => el("div", index === 0 ? "tip-title" : line.className ?? null, line.text ?? line)));
  tip.hidden = false;
  const box = anchor.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2));
  const above = box.top - height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above >= 8 ? above : box.bottom + 8}px`;
}

// Mouse, touch and keyboard all reach the same details.
function wireStrip(strip, cells, linesFor) {
  let active = -1;
  const select = (index) => {
    active = Math.max(0, Math.min(cells.length - 1, index));
    cells.forEach((cell, i) => cell.classList.toggle("is-active", i === active));
    showTip(linesFor(active), cells[active]);
  };
  const clear = () => {
    active = -1;
    cells.forEach((cell) => cell.classList.remove("is-active"));
    hideTip();
  };
  const fromEvent = (event) => {
    const cell = event.target.closest("[data-i]");
    if (cell) select(Number(cell.dataset.i));
  };
  strip.addEventListener("pointermove", fromEvent);
  strip.addEventListener("pointerdown", fromEvent);
  strip.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") clear();
  });
  strip.addEventListener("focus", () => {
    if (strip.matches(":focus-visible")) select(cells.length - 1);
  });
  strip.addEventListener("blur", clear);
  strip.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") select((active < 0 ? cells.length : active) - 1);
    else if (event.key === "ArrowRight") select((active < 0 ? cells.length - 2 : active) + 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(cells.length - 1);
    else if (event.key === "Escape") clear();
    else return;
    event.preventDefault();
  });
}

function renderBanner(status, now) {
  const key = bannerKey(status, now);
  const banner = BANNERS[key];
  const card = el("section", "card banner");
  card.setAttribute("aria-live", "polite");
  const head = el("div", `banner-head tone-${banner.tone}`);
  head.append(el("span", key === "delayed" ? "dot" : "dot dot-pulse"), el("h2", "banner-label", banner.label));
  card.append(head, el("p", "banner-body", banner.body));
  const stamp = status.lastConclusiveAt
    ? `Last completed check ${relativeTime(status.lastConclusiveAt, now)} (${formatStamp(status.lastConclusiveAt)})`
    : "No check has completed yet.";
  card.append(el("p", "banner-stamp", stamp));
  const troubled = (status.providers ?? []).filter((p) => ["major", "critical"].includes(p.indicator));
  if (troubled.length > 0) {
    card.append(el("p", "banner-note", `${troubled.map((p) => p.name).join(" and ")} ${troubled.length === 1 ? "reports" : "report"} an issue of their own. See Service Providers below.`));
  }
  return card;
}

function renderDayStrip(check, now) {
  const bars = dayBars(check.days, 90, now);
  const uptime = uptimePercent(check.days);
  const strip = el("div", "strip days");
  strip.tabIndex = 0;
  strip.id = `days-${check.id}`;
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", `${check.name}, daily history. ${uptime === null ? "No uptime recorded yet" : `${uptime}% uptime`}. Use the arrow keys for each day.`);
  const cells = bars.map((bar, index) => {
    const cell = el("span", `bar bar-${bar.tone}`);
    cell.dataset.i = String(index);
    return cell;
  });
  strip.append(...cells);
  wireStrip(strip, cells, (i) => dayTooltip(bars[i]));
  const foot = el("div", "strip-foot");
  const range = el("span");
  range.append(el("span", "only-wide", "90 days ago"), el("span", "only-narrow", "30 days ago"));
  foot.append(range, el("span", null, uptime === null ? "No uptime yet" : `${uptime}% uptime`), el("span", null, "Today"));
  const wrap = el("div", "history");
  wrap.append(strip, foot);
  return wrap;
}

function renderRecentStrip(check) {
  const recent = check.recent ?? [];
  const wrap = el("div", "recent");
  const average = averageMs(recent);
  const head = el("div", "recent-head");
  head.append(
    el("span", null, "Recent checks"),
    el("span", null, average === null ? "No response times yet" : `Average ${average} ms${check.lastMs != null ? `, latest ${check.lastMs} ms` : ""}`),
  );
  wrap.append(head);
  if (recent.length === 0) {
    wrap.append(el("p", "empty", "No checks yet."));
    return wrap;
  }
  const strip = el("div", "strip ticks");
  strip.tabIndex = 0;
  strip.id = `recent-${check.id}`;
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", `${check.name}, last ${plural(recent.length, "check")}. Use the arrow keys for each check.`);
  const cells = recent.map((run, index) => {
    const cell = el("span", `tick tick-${run.outcome}`);
    cell.dataset.i = String(index);
    return cell;
  });
  strip.append(...cells);
  wireStrip(strip, cells, (i) => {
    const run = recent[i];
    const lines = [formatStamp(run.at), `${outcomeLabel(run.outcome)} in ${run.ms} ms`];
    if (run.attempts > 1) lines.push(`After ${plural(run.attempts, "attempt")}`);
    if (run.note) lines.push(run.note);
    for (const condition of run.conditions ?? []) {
      lines.push({ text: `${condition.ok ? "Pass" : "Fail"}: ${condition.name}`, className: condition.ok ? "cond-ok" : "cond-bad" });
    }
    return lines;
  });
  const foot = el("div", "strip-foot");
  foot.append(el("span", null, relativeTime(recent[0].at, Date.now())), el("span", null, "Latest"));
  wrap.append(strip, foot);
  return wrap;
}

function renderChecks(status, now) {
  const section = el("section", "section");
  section.append(el("h2", "section-title", "Kanbedu"));
  const card = el("div", "card rows");
  for (const check of status.checks ?? []) {
    const label = checkLabel(check, now, status);
    const row = el("article", "row");
    const head = el("div", "row-head");
    const title = el("div");
    title.append(el("h3", "row-name", check.name), el("p", "row-desc", check.description));
    head.append(title, pill(label.tone, label.label));
    row.append(head);
    if (check.note && check.status !== "operational") row.append(el("p", "row-note", check.note));
    row.append(renderDayStrip(check, now), renderRecentStrip(check));
    card.append(row);
  }
  section.append(card);
  return section;
}

function renderProviders(status) {
  const section = el("section", "section");
  section.append(el("h2", "section-title", "Service Providers"));
  section.append(el("p", "section-desc", "What the companies Kanbedu runs on report about themselves. An issue here does not always affect Kanbedu."));
  const card = el("div", "card rows");
  for (const provider of status.providers ?? []) {
    const label = providerLabel(provider);
    const row = el("article", "row row-compact");
    const head = el("div", "row-head");
    const title = el("div");
    const name = el("h3", "row-name");
    const link = el("a", "text-link", provider.name);
    link.href = provider.page;
    link.rel = "noopener noreferrer";
    name.append(link);
    title.append(name, el("p", "row-desc", provider.role));
    head.append(title, pill(label.tone, label.label));
    row.append(head);
    if (provider.indicator !== "none" && provider.description) row.append(el("p", "row-note", provider.description));
    for (const incident of provider.incidents ?? []) row.append(el("p", "row-note", incident.name));
    if ((provider.affected ?? []).length > 0) row.append(el("p", "row-note", `Affected: ${provider.affected.map((c) => c.name).join(", ")}`));
    card.append(row);
  }
  section.append(card);
  return section;
}

function renderIncidents(status, now) {
  const section = el("section", "section");
  section.append(el("h2", "section-title", "Incident History"));
  const incidents = visibleIncidents(status, now);
  if (incidents.length === 0) {
    section.append(el("p", "section-desc", "No incidents reported."));
    return section;
  }
  let lastDate = null;
  for (const incident of incidents) {
    const date = formatIncidentDate(incident.startedAt);
    if (date !== lastDate) {
      section.append(el("h3", "incident-date", date));
      lastDate = date;
    }
    const article = el("article", "incident");
    article.append(el("h4", `incident-title severity-${incident.severity}`, incident.title));
    if (!incident.resolvedAt) article.append(el("p", "incident-ongoing", "Ongoing"));
    for (const update of incidentUpdates(incident)) {
      const block = el("div", "incident-update");
      const text = el("p", "incident-text");
      text.append(el("strong", null, update.label), document.createTextNode(`: ${update.body}`));
      block.append(text, el("p", "incident-stamp", formatStamp(update.at)));
      article.append(block);
    }
    section.append(article);
  }
  return section;
}

function renderUnavailable() {
  const card = el("section", "card banner");
  const head = el("div", "banner-head tone-neutral");
  head.append(el("span", "dot"), el("h2", "banner-label", "Status Unavailable"));
  card.append(
    head,
    el("p", "banner-body", "This page could not load its data. It runs separately from Kanbedu, so this does not tell you whether Kanbedu is up."),
  );
  return card;
}

function render() {
  const focusedId = document.activeElement?.id || null;
  hideTip();
  const now = Date.now();
  if (!current) {
    root.replaceChildren(renderUnavailable());
    return;
  }
  const nodes = [renderBanner(current, now)];
  if (lastFetchFailed && !isStale(current, now)) {
    nodes.push(el("p", "fetch-note", "Could not refresh just now. Showing the last loaded data."));
  }
  nodes.push(renderChecks(current, now), renderProviders(current), renderIncidents(current, now));
  root.replaceChildren(...nodes);
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

async function refresh() {
  let next = null;
  try {
    const response = await fetch(`data/status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Status data answered ${response.status}`);
    const parsed = await response.json();
    if (parsed?.schemaVersion !== SUPPORTED_SCHEMA) throw new Error("Unsupported status data version");
    next = parsed;
  } catch (error) {
    console.warn(`Status refresh failed: ${error.message}`);
  }
  lastFetchFailed = next === null;
  const changed = next !== null && next.generatedAt !== current?.generatedAt;
  if (next !== null) current = next;
  // Leaves an open tooltip alone unless there is new data to show.
  if (changed || lastFetchFailed || !root.firstElementChild || tip.hidden) {
    try {
      render();
    } catch (error) {
      console.error(`Status render failed: ${error.message}`);
      root.replaceChildren(renderUnavailable());
    }
  }
}

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".strip")) hideTip();
});
window.addEventListener("scroll", hideTip, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);
refresh();
