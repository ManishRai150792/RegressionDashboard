// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const STATUS_ORDER = ["Blocked", "Fail", "At Risk", "Pass"];

// Business-standard RAG palette: green = pass, amber = at risk, red = fail,
// orange = blocked (external dependency), slate = skipped / not run.
const COLORS = {
  Pass: "#2E7D32",
  "At Risk": "#F9A825",
  Fail: "#C62828",
  Blocked: "#E65100",
  Skipped: "#78909C",
};
const TEXT_COLORS = { Pass: "#1B5E20", "At Risk": "#7A5A00", Fail: "#B71C1C", Blocked: "#BF360C", Skipped: "#455A64" };
const BG_COLORS = { Pass: "#E8F5E9", "At Risk": "#FFF8E1", Fail: "#FDECEA", Blocked: "#FFF3E0", Skipped: "#ECEFF1" };
const PLATFORM_COLORS = { iOS: "#0B7DD8", Android: "#00897B" };

// Defect severity (distinct from journey status colours) and failure-type colours.
const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low"];
const SEVERITY_COLORS = { Critical: "#7F0000", High: "#C62828", Medium: "#F9A825", Low: "#78909C" };
const SEVERITY_TEXT = { Critical: "#fff", High: "#fff", Medium: "#3D2E00", Low: "#fff" };
const CLOSED_DEFECT_STATUSES = ["Closed", "Rejected"];
const FAILURE_TYPES = [
  { name: "Application defect", color: "#C62828" },
  { name: "Automation script issue", color: "#F9A825" },
  { name: "Environment / test data", color: "#5C6BC0" },
  { name: "Under investigation", color: "#78909C" },
];
const NAVY = "#003875";
const ACCENT = "#0B7DD8";

// Release status rule: "Completed" only when nothing is open, otherwise "In Progress".
const RULES = {
  passTarget: 95, // % pass rate needed before a release can show "Completed"
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let releases = [];
let platformNames = [];
let currentRelease = null;
let currentPlatform = "All";
let currentFilter = "All";
let warnings = [];
let gradientSeq = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statusClass(status) {
  return status.replace(/\s+/g, "-");
}

function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

function shortDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function sortedReleases() {
  return releases.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
}

function badge(status) {
  return `<span class="badge ${statusClass(status)}">${esc(status)}</span>`;
}

function platformChip(platform) {
  const color = PLATFORM_COLORS[platform] || NAVY;
  return `<span class="platform-chip" style="--pc:${color}">${esc(platform)}</span>`;
}

// ---------------------------------------------------------------------------
// Data loading, validation and analysis
// ---------------------------------------------------------------------------
function analyzeJourney(j) {
  const s = { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, ...(j.scenarios || {}) };
  return { ...s, pct: pct(s.passed, s.total) };
}

function deriveStatus(a) {
  if (a.blocked > 0) return "Blocked";
  if (a.failed > 0) return "Fail";
  if (a.skipped > 0) return "At Risk";
  return "Pass";
}

function normalizeStatus(raw) {
  return STATUS_ORDER.find((s) => s.toLowerCase().replace(/\s+/g, "") === String(raw).toLowerCase().replace(/\s+/g, ""));
}

function prepareData(rawReleases) {
  warnings = [];
  const names = new Set();
  rawReleases.forEach((release) => {
    const where = release.name || release.id || "(unnamed release)";
    release.journeys = [];
    release.platformInfo = {};
    release.defects = Array.isArray(release.defects) ? release.defects : [];
    release.summary = release.summary || {};
    const platforms = release.platforms || {};
    if (!Object.keys(platforms).length) warnings.push(`${where}: no "platforms" block found.`);
    Object.entries(platforms).forEach(([platform, block]) => {
      names.add(platform);
      release.platformInfo[platform] = { build: block.build, devices: block.devices };
      (block.journeys || []).forEach((j) => {
        j.platform = platform;
        j.release = release;
        j.a = analyzeJourney(j);
        if (j.status === undefined || j.status === "") {
          j.status = deriveStatus(j.a);
        } else {
          const fixed = normalizeStatus(j.status);
          if (!fixed) {
            warnings.push(`${where} / ${platform} / ${j.name}: unknown status "${j.status}" (use ${STATUS_ORDER.join(", ")}). Shown as At Risk.`);
            j.status = "At Risk";
          } else {
            j.status = fixed;
          }
        }
        if (!j.a.total) warnings.push(`${where} / ${platform} / ${j.name}: no scenario or test counts recorded.`);
        release.journeys.push(j);
      });
    });
    release.journeys.forEach((j) => {
      j.defects = release.defects.filter((d) => d.journey === j.name && (d.platform === "Both" || d.platform === j.platform));
    });
    release.defects.forEach((d) => {
      if (!SEVERITY_ORDER.includes(d.severity)) warnings.push(`${where} / ${d.id}: unknown severity "${d.severity}".`);
    });
  });
  platformNames = Array.from(names);
  return rawReleases.filter((r) => r.journeys.length);
}

async function loadData() {
  try {
    const res = await fetch("data/regression.json");
    const data = await res.json();
    releases = prepareData(data.releases || []);
    if (!releases.length) throw new Error("No releases with journeys found");
  } catch (err) {
    document.querySelector("main").innerHTML =
      '<p class="load-error">Could not load or read data/regression.json. If you opened this file directly (file://), browsers block local JSON fetches. Run <code>node serve.js</code> from this folder and open <code>http://localhost:8000</code>.<br><small>' +
      esc(err.message) +
      "</small></p>";
    throw err;
  }
}

function journeysFor(release, platform = currentPlatform) {
  return release.journeys.filter((j) => platform === "All" || j.platform === platform);
}

function aggregate(journeys) {
  const agg = { journeys: journeys.length, Pass: 0, Fail: 0, Blocked: 0, "At Risk": 0, total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  journeys.forEach((j) => {
    agg[j.status]++;
    agg.total += j.a.total;
    agg.passed += j.a.passed;
    agg.failed += j.a.failed;
    agg.blocked += j.a.blocked;
    agg.skipped += j.a.skipped;
  });
  agg.pct = pct(agg.passed, agg.total);
  agg.executedPct = pct(agg.passed + agg.failed, agg.total);
  agg.journeyPct = pct(agg.Pass, agg.journeys);
  return agg;
}

function defectsFor(release, platform = currentPlatform) {
  return release.defects.filter((d) => platform === "All" || d.platform === platform || d.platform === "Both");
}

const isOpenDefect = (d) => !CLOSED_DEFECT_STATUSES.includes(d.status);

const OVERRIDES = {
  Completed: { label: "COMPLETED", cls: "go", color: COLORS.Pass },
  "In Progress": { label: "IN PROGRESS", cls: "risk", color: COLORS["At Risk"] },
};

// summary is only passed for the whole-release verdict (QA lead can override it in the Release sheet).
function getVerdict(agg, defects = [], summary = null) {
  const override = summary && OVERRIDES[summary.decisionOverride];
  if (override) return { ...override, reason: summary.decisionNote ? `QA decision: ${summary.decisionNote}` : "Decision set by QA lead" };
  const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
  const reasons = [];
  const criticals = defects.filter((d) => isOpenDefect(d) && d.severity === "Critical").length;
  if (agg.Blocked) reasons.push(`${plural(agg.Blocked, "journey")} blocked`);
  if (agg.Fail) reasons.push(`${plural(agg.Fail, "journey")} failed`);
  if (agg["At Risk"]) reasons.push(`${plural(agg["At Risk"], "journey")} at risk`);
  if (criticals) reasons.push(`${plural(criticals, "open critical defect")}`);
  if (agg.pct < RULES.passTarget) reasons.push(`pass rate ${agg.pct}% is below the ${RULES.passTarget}% target`);
  if (reasons.length) return { ...OVERRIDES["In Progress"], reason: reasons.join(", ") };
  return { ...OVERRIDES.Completed, reason: "All journeys passed and the pass-rate target is met" };
}

// Platform rows (Android first) plus a total row, shared by the dashboard table and the email.
function execRows(release) {
  const order = ["Android", "iOS"];
  const names = Object.keys(release.platformInfo)
    .filter((p) => currentPlatform === "All" || p === currentPlatform)
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const rows = names.map((p) => ({ name: p, agg: aggregate(release.journeys.filter((j) => j.platform === p)) }));
  if (rows.length > 1) rows.push({ name: "TOTAL", agg: aggregate(release.journeys.filter((j) => currentPlatform === "All" || j.platform === currentPlatform)), total: true });
  return rows;
}

function renderExecution(release) {
  document.getElementById("execBody").innerHTML = execRows(release)
    .map(({ name, agg, total }) => `<tr class="${total ? "total" : ""}"><td>${esc(name)}</td><td>${agg.total}</td><td>${agg.passed}</td><td>${agg.failed}</td><td>${agg.blocked}</td><td>${agg.skipped}</td><td>${agg.pct}%</td></tr>`)
    .join("");
}

function progressSegments(agg) {
  return [
    { label: "Passed", n: agg.passed, color: COLORS.Pass },
    { label: "Failed", n: agg.failed, color: COLORS.Fail },
    { label: "Blocked", n: agg.blocked, color: COLORS.Blocked },
    { label: "Skipped / not run", n: agg.skipped, color: COLORS.Skipped },
  ];
}

// ---------------------------------------------------------------------------
// Header: verdict + KPI strip
// ---------------------------------------------------------------------------
function renderHero(release) {
  const journeys = journeysFor(release);
  const agg = aggregate(journeys);
  const v = getVerdict(agg, defectsFor(release), release.summary);
  const scope = currentPlatform === "All" ? "iOS + Android" : currentPlatform;

  document.getElementById("heroSub").textContent = currentPlatform === "All" ? release.name : `${release.name} · ${currentPlatform}`;
  document.getElementById("verdict").innerHTML = `<span class="verdict-pill ${v.cls}">${v.label}</span><span class="verdict-reason">${esc(v.reason)}</span>`;

  document.getElementById("heroMeta").innerHTML = `Run date ${esc(release.date)}`;

  const tiles = [
    { label: "Pass rate", value: `${agg.pct}%`, sub: `${agg.passed} of ${agg.total} planned scenarios`, color: agg.pct >= RULES.passTarget ? COLORS.Pass : COLORS["At Risk"] },
    { label: "Executed", value: `${agg.executedPct}%`, sub: `${agg.passed + agg.failed} of ${agg.total} actually ran`, color: "#4FC3F7" },
    { label: "At risk", value: agg["At Risk"], sub: "journeys", color: COLORS["At Risk"] },
    { label: "Failed", value: agg.Fail, sub: `${agg.failed} scenarios`, color: COLORS.Fail },
    { label: "Blocked", value: agg.Blocked, sub: `${agg.blocked} scenarios`, color: COLORS.Blocked },
  ];
  document.getElementById("progress").innerHTML = `
    <div class="progress-head"><span class="progress-title">Execution progress</span><span class="progress-pct">${agg.executedPct}%</span><span class="progress-sub">${agg.passed + agg.failed} of ${agg.total} planned scenarios executed (passed + failed)</span></div>
    <div class="progress-track">${progressSegments(agg)
      .filter((p) => p.n)
      .map((p) => `<span style="width:${(p.n / agg.total) * 100}%;background:${p.color}" data-tip="${esc(`<b>${p.label}</b>: ${p.n} (${pct(p.n, agg.total)}%)`)}"></span>`)
      .join("")}</div>
    <div class="progress-legend">${progressSegments(agg).map((p) => `<span><i style="background:${p.color}"></i>${p.label} ${p.n}</span>`).join("")}</div>`;
  document.getElementById("kpiStrip").innerHTML = tiles
    .map((t) => `<div class="kpi" style="--accent:${t.color}"><div class="kpi-label">${t.label}</div><div class="kpi-value">${t.value}</div><div class="kpi-sub">${t.sub}</div></div>`)
    .join("");
}

function renderWarnings() {
  const el = document.getElementById("warnings");
  el.innerHTML = warnings.length
    ? `<div class="warn-box"><b>Data check:</b><ul>${warnings.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>${warnings.length > 8 ? `<small>+${warnings.length - 8} more</small>` : ""}</div>`
    : "";
}

// ---------------------------------------------------------------------------
// Attention list
// ---------------------------------------------------------------------------
function renderAttention(release) {
  const items = journeysFor(release)
    .filter((j) => j.status !== "Pass")
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  const el = document.getElementById("attentionList");
  if (!items.length) {
    el.innerHTML = '<p class="empty ok">All journeys passed - nothing needs attention.</p>';
    return;
  }
  el.innerHTML = items
    .map((j) => {
      const affected = j.a.failed + j.a.blocked;
      return `<div class="attn-row" style="--accent:${COLORS[j.status]}" data-open="${esc(j.name)}|${esc(j.platform)}">
        <div class="attn-head">${badge(j.status)}<b>${esc(j.name)}</b>${platformChip(j.platform)}<span class="muted">${esc(j.owner || "")}</span></div>
        <div class="attn-note">${esc(j.notes) || '<span class="muted">No notes added.</span>'}</div>
        ${j.defects.filter(isOpenDefect).length ? `<div class="attn-defects">${j.defects.filter(isOpenDefect).map((d) => `${severityBadge(d.severity)} <a href="${esc(d.url || "#")}" target="_blank" rel="noopener">${esc(d.id)}</a> <span class="muted">${esc(d.status)}</span>`).join(" &nbsp; ")}</div>` : ""}
        <div class="attn-meta">${affected ? `${affected} scenario${affected > 1 ? "s" : ""} failing/blocked · ` : ""}${j.a.pct}% pass</div>
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Trend charts (inline SVG, no libraries)
// ---------------------------------------------------------------------------
function legend(items) {
  return items.map((i) => `<span class="legend-item"><i style="background:${i.color}${i.dashed ? ";opacity:.6" : ""}"></i>${esc(i.label)}</span>`).join("");
}

/* series: [{ name, color, dashed, area, labels, values: [number|null], tips: [html] }] */
function lineChart(labels, series, { width = 560, height = 230, target } = {}) {
  const pad = { top: 22, right: 22, bottom: 30, left: 40 };
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;
  const all = series.flatMap((s) => s.values).filter((v) => v !== null);
  const lo = Math.max(0, Math.floor((Math.min(...all, target ?? 100) - 8) / 10) * 10);
  const hi = 100;
  const x = (i) => pad.left + (labels.length === 1 ? iw / 2 : (i * iw) / (labels.length - 1));
  const y = (v) => pad.top + ih - ((v - lo) / (hi - lo)) * ih;

  const ticks = [];
  for (let v = lo; v <= hi; v += (hi - lo) / 4) ticks.push(Math.round(v));
  const grid = ticks
    .map((v) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.left - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}%</text>`)
    .join("");

  const xLabels = labels.map((l, i) => `<text x="${x(i)}" y="${height - 8}" class="axis" text-anchor="middle">${esc(l)}</text>`).join("");

  const targetLine =
    target !== undefined
      ? `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(target)}" y2="${y(target)}" stroke="${COLORS.Pass}" stroke-width="1.2" stroke-dasharray="5 4" opacity=".8"/>
         <text x="${width - pad.right}" y="${y(target) - 5}" class="axis" fill="${COLORS.Pass}" text-anchor="end">Target ${target}%</text>`
      : "";

  let defs = "";
  const layers = series
    .map((s) => {
      const pts = s.values.map((v, i) => (v === null ? null : { x: x(i), y: y(v), v })).filter(Boolean);
      if (!pts.length) return "";
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      let area = "";
      if (s.area) {
        const gid = `g${++gradientSeq}`;
        defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
        area = `<path d="${d} L${pts[pts.length - 1].x.toFixed(1)},${y(lo)} L${pts[0].x.toFixed(1)},${y(lo)} Z" fill="url(#${gid})"/>`;
      }
      const line = `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="6 5"' : ""}/>`;
      const dots = pts
        .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#fff" stroke="${s.color}" stroke-width="2.5"/>${s.showValues ? `<text x="${p.x.toFixed(1)}" y="${(p.y - 11).toFixed(1)}" class="val" text-anchor="middle">${p.v}%</text>` : ""}`)
        .join("");
      return area + line + dots;
    })
    .join("");

  const colW = labels.length === 1 ? iw : iw / (labels.length - 1);
  const hits = labels
    .map((_, i) => {
      const tip = series
        .filter((s) => s.values[i] !== null)
        .map((s) => `<div><i style="background:${s.color}"></i>${esc(s.name)}: <b>${s.values[i]}%</b></div>`)
        .join("");
      return `<rect x="${x(i) - colW / 2}" y="${pad.top}" width="${colW}" height="${ih}" fill="transparent" data-tip="${esc(`<div class="tip-title">${esc(labels[i])}</div>${tip}${series[0].tips?.[i] || ""}`)}"/>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img"><defs>${defs}</defs>${grid}${targetLine}${xLabels}${layers}${hits}</svg>`;
}

function stackedBars(rel, { width = 560, height = 230 } = {}) {
  const pad = { top: 16, right: 16, bottom: 30, left: 30 };
  const iw = width - pad.left - pad.right;
  const ih = height - pad.top - pad.bottom;
  const order = ["Pass", "At Risk", "Fail", "Blocked"];
  const data = rel.map((r) => ({ r, agg: aggregate(journeysFor(r)) }));
  const max = Math.max(...data.map((d) => d.agg.journeys), 1);
  const slot = iw / data.length;
  const bw = Math.min(64, slot * 0.55);

  const grid = [0, 0.5, 1]
    .map((f) => {
      const yy = pad.top + ih - f * ih;
      return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}" class="grid"/><text x="${pad.left - 6}" y="${yy + 4}" class="axis" text-anchor="end">${Math.round(f * max)}</text>`;
    })
    .join("");

  const bars = data
    .map((d, i) => {
      const cx = pad.left + slot * i + slot / 2;
      let acc = 0;
      const segs = order
        .filter((s) => d.agg[s])
        .map((s) => {
          const h = (d.agg[s] / max) * ih;
          const yy = pad.top + ih - acc - h;
          acc += h;
          const label = h > 15 ? `<text x="${cx}" y="${yy + h / 2 + 4}" class="seg-label" fill="${s === "At Risk" ? "#4A3500" : "#fff"}" text-anchor="middle">${d.agg[s]}</text>` : "";
          return `<rect x="${cx - bw / 2}" y="${yy}" width="${bw}" height="${h - 1}" rx="2" fill="${COLORS[s]}"/>${label}`;
        })
        .join("");
      const tip = `<div class="tip-title">${esc(shortDate(d.r.date))}</div>` + order.map((s) => `<div><i style="background:${COLORS[s]}"></i>${s}: <b>${d.agg[s]}</b></div>`).join("") + `<div>Total journeys: <b>${d.agg.journeys}</b></div>`;
      return `${segs}<text x="${cx}" y="${height - 8}" class="axis" text-anchor="middle">${esc(shortDate(d.r.date))}</text><rect x="${cx - slot / 2}" y="${pad.top}" width="${slot}" height="${ih}" fill="transparent" data-tip="${esc(tip)}"/>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">${grid}${bars}</svg>`;
}

function renderTrends() {
  const rel = sortedReleases();
  const labels = rel.map((r) => shortDate(r.date));
  const aggs = rel.map((r) => aggregate(journeysFor(r)));

  const passSeries = [{ name: "Pass rate", color: "#0B7DD8", area: true, showValues: true, values: aggs.map((a) => a.pct) }];
  document.getElementById("trendPass").innerHTML = lineChart(labels, passSeries, { target: RULES.passTarget, height: 250 });
  document.getElementById("legendPass").innerHTML = legend([{ label: "Pass rate", color: "#0B7DD8" }]);

  document.getElementById("trendStatus").innerHTML = stackedBars(rel);
  document.getElementById("legendStatus").innerHTML = legend(["Pass", "At Risk", "Fail", "Blocked"].map((s) => ({ label: s, color: COLORS[s] })));

}

// ---------------------------------------------------------------------------
// Journey table + filters
// ---------------------------------------------------------------------------
function scenarioBar(a) {
  const segs = [
    { n: a.passed, c: COLORS.Pass },
    { n: a.failed, c: COLORS.Fail },
    { n: a.blocked, c: COLORS.Blocked },
    { n: a.skipped, c: COLORS.Skipped },
  ];
  return segs.filter((s) => s.n).map((s) => `<span style="width:${(s.n / a.total) * 100}%;background:${s.c}"></span>`).join("");
}

function renderFilters(release) {
  const journeys = journeysFor(release);
  const defs = [["All", "All"], ["Blocked", "Blocked"], ["At Risk", "At Risk"], ["Fail", "Failed"], ["Pass", "Passed"]];
  document.getElementById("statusFilters").innerHTML = defs
    .map(([key, label]) => {
      const n = key === "All" ? journeys.length : journeys.filter((j) => j.status === key).length;
      const color = COLORS[key] || NAVY;
      return `<button class="filter-chip ${currentFilter === key ? "active" : ""}" data-filter="${esc(key)}" style="--c:${color}"><i></i>${label}<span class="count">${n}</span></button>`;
    })
    .join("");
}

function renderTable(release) {
  const journeys = journeysFor(release)
    .filter((j) => currentFilter === "All" || j.status === currentFilter)
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform));

  document.getElementById("journeyTableBody").innerHTML = journeys.length
    ? journeys
        .map((j) => {
          const a = j.a;
          return `<tr class="journey-row" data-open="${esc(j.name)}|${esc(j.platform)}">
            <td><b>${esc(j.name)}</b></td>
            <td>${platformChip(j.platform)}</td>
            <td>${badge(j.status)}</td>
            <td><div class="scenario-cell"><div class="scenario-pct">${a.pct}%</div><div class="mini-bar">${scenarioBar(a)}</div><div class="scenario-count">${a.passed}/${a.total} passed</div></div></td>
            <td>${esc(j.owner)}</td>
            <td class="notes">${esc(j.notes)}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="6" class="empty">No journeys match this filter.</td></tr>';
}

// ---------------------------------------------------------------------------
// Journey detail modal
// ---------------------------------------------------------------------------
function openJourneyDetail(name, platform) {
  const journey = currentRelease.journeys.find((j) => j.name === name && j.platform === platform);
  if (!journey) return;
  const a = journey.a;

  document.getElementById("detailTitle").innerHTML = `${esc(name)} ${platformChip(platform)}`;
  document.getElementById("detailMeta").innerHTML = `${badge(journey.status)}<span class="muted">Owner: ${esc(journey.owner || "-")}</span>${journey.notes ? `<p class="notes">${esc(journey.notes)}</p>` : ""}`;

  document.getElementById("detailKpis").innerHTML = [
    { l: "Pass rate", v: `${a.pct}%`, c: COLORS.Pass },
    { l: "Total scenarios", v: a.total, c: "#4FC3F7" },
    { l: "Failed", v: a.failed, c: COLORS.Fail },
    { l: "Blocked", v: a.blocked, c: COLORS.Blocked },
    { l: "Skipped", v: a.skipped, c: COLORS.Skipped },
  ]
    .map((k) => `<div class="dk" style="--accent:${k.c}"><div class="dk-v">${k.v}</div><div class="dk-l">${k.l}</div></div>`)
    .join("");

  const segs = [
    { label: "Passed", n: a.passed, color: COLORS.Pass },
    { label: "Failed", n: a.failed, color: COLORS.Fail },
    { label: "Blocked", n: a.blocked, color: COLORS.Blocked },
    { label: "Skipped", n: a.skipped, color: COLORS.Skipped },
  ].filter((s) => s.n > 0);
  document.getElementById("detailScenarioSummary").innerHTML = `
    <div class="breakdown-bar">${segs.map((s) => `<span style="width:${(s.n / a.total) * 100}%;background:${s.color}" title="${s.label}: ${s.n}"></span>`).join("")}</div>
    <div class="legend" style="margin-top:8px">${segs.map((s) => `<span class="legend-item"><i style="background:${s.color}"></i>${s.label}: ${s.n}</span>`).join("")}<span class="legend-item"><b>${a.total} scenarios</b></span></div>`;

  const linked = journey.defects;
  document.getElementById("detailDefects").innerHTML = linked.length
    ? `<table class="plain"><thead><tr><th>Defect</th><th>Title</th><th>Severity</th><th>Status</th><th>Owner</th><th>ETA</th></tr></thead><tbody>${linked
        .map((d) => `<tr><td><b>${defectLink(d)}</b></td><td>${esc(d.title)}</td><td>${severityBadge(d.severity)}</td><td>${esc(d.status)}</td><td>${esc(d.owner || "-")}</td><td class="${isOverdue(d) ? "bad" : ""}">${esc(d.eta || "-")}</td></tr>`)
        .join("")}</tbody></table>`
    : '<p class="empty ok">No defects linked to this journey.</p>';

  const rel = sortedReleases();
  const labels = [];
  const final = [];
  rel.forEach((r) => {
    const j = r.journeys.find((x) => x.name === name && x.platform === platform);
    if (!j) return;
    labels.push(shortDate(r.date));
    final.push(j.a.pct);
  });
  document.getElementById("detailTrend").innerHTML =
    labels.length > 1
      ? lineChart(labels, [{ name: "Pass rate", color: "#0B7DD8", area: true, showValues: true, values: final }], { width: 560, height: 200 })
      : '<p class="empty">Not enough release history for this journey yet.</p>';

  document.getElementById("detailModal").classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Leadership email (inline styles only - email clients strip CSS/JS)
// ---------------------------------------------------------------------------
function buildEmailHtml(release) {
  const journeys = journeysFor(release);
  const agg = aggregate(journeys);
  const defects = defectsFor(release);
  const v = getVerdict(agg, defects, release.summary);
  const f = "font-family:Arial,sans-serif;";
  const td = `padding:8px 10px;border-bottom:1px solid #E0E4E8;${f}font-size:13px;vertical-align:top;`;
  const th = `text-align:left;padding:8px 10px;${f}font-size:12px;color:#fff;background:${NAVY};`;
  const scope = currentPlatform === "All" ? "iOS + Android" : currentPlatform;

  const tile = (label, value, color, sub) =>
    `<td style="padding:10px 12px;border-left:4px solid ${color};background:#F5F7FA;${f}"><div style="font-size:22px;font-weight:bold;color:${NAVY}">${value}</div><div style="font-size:11px;color:#5F6B7A">${label}${sub ? `<br>${sub}` : ""}</div></td><td width="6"></td>`;

  const platRows = execRows(release)
    .map(({ name, agg, total }) => {
      const st = `${td}${total ? "font-weight:bold;background:#EAF0FA;" : ""}`;
      return `<tr><td style="${st}">${esc(name)}</td><td style="${st}">${agg.total}</td><td style="${st}">${agg.passed}</td><td style="${st}">${agg.failed}</td><td style="${st}">${agg.blocked}</td><td style="${st}">${agg.skipped}</td><td style="${st}">${agg.pct}%</td></tr>`;
    })
    .join("");

  const rows = journeys
    .slice()
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name))
    .map((j) => {
      const a = j.a;
      return `<tr>
        <td style="${td}">${esc(j.name)}</td>
        <td style="${td}">${esc(j.platform)}</td>
        <td style="${td}"><span style="background:${BG_COLORS[j.status]};color:${TEXT_COLORS[j.status]};padding:2px 10px;border-radius:12px;font-weight:bold;border-left:4px solid ${COLORS[j.status]}">${esc(j.status)}</span></td>
        <td style="${td}">${a.passed}/${a.total} (${a.pct}%)</td>
        <td style="${td}">${esc(j.owner)}</td>
        <td style="${td}color:#555;">${esc(j.notes) || "-"}</td>
      </tr>`;
    })
    .join("");

  const openDefects = defects.filter(isOpenDefect).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const sevLine = SEVERITY_ORDER.map((s) => `${s} <b style="color:${SEVERITY_COLORS[s]}">${openDefects.filter((d) => d.severity === s).length}</b>`).join(" &nbsp;|&nbsp; ");
  const defectRows = openDefects
    .map(
      (d) => `<tr><td style="${td}"><b>${d.url ? `<a href="${esc(d.url)}" style="color:#1565C0;text-decoration:none">${esc(d.id)}</a>` : esc(d.id)}</b></td><td style="${td}">${esc(d.title)}</td><td style="${td}">${esc(d.journey || "-")}<br><span style="color:#5F6B7A;font-size:11px">${esc(d.platform)}</span></td><td style="${td}"><span style="background:${SEVERITY_COLORS[d.severity] || "#78909C"};color:${SEVERITY_TEXT[d.severity] || "#fff"};padding:2px 8px;border-radius:3px;font-size:11px;font-weight:bold">${esc(d.severity)}</span></td><td style="${td}">${esc(d.status)}</td><td style="${td}">${esc(d.owner || "-")}</td><td style="${td}${isOverdue(d) ? `color:${TEXT_COLORS.Fail};font-weight:bold` : ""}">${esc(d.eta || "-")}${isOverdue(d) ? " (overdue)" : ""}</td></tr>`
    )
    .join("");
  const s = release.summary || {};
  const risks = [s.keyRisk ? `<p style="margin:0 0 6px"><b>Key risk:</b> ${esc(s.keyRisk)}</p>` : "", ...(s.actions || []).map((a, i) => `<p style="margin:0 0 4px">${i + 1}. ${esc(a)}</p>`)].join("");
  const h3 = `font-size:14px;color:${NAVY};margin:18px 0 8px;border-bottom:2px solid #D9E7ED;padding-bottom:5px;`;

  return `
  <div style="${f}">
    <h2 style="font-size:17px;margin:0 0 4px;color:${NAVY};border-bottom:3px solid ${ACCENT};padding-bottom:6px">Mobile Regression Summary - ${esc(release.name)}</h2>
    <p style="font-size:12px;color:#5F6B7A;margin:0 0 10px;">${esc(scope)} &nbsp;|&nbsp; Run date ${esc(release.date)}</p>
    <p style="margin:0 0 12px;"><span style="background:${v.color};color:${v.cls === "risk" ? "#3D2E00" : "#fff"};padding:5px 14px;border-radius:14px;font-weight:bold;font-size:13px;">${v.label}</span> <span style="font-size:12px;color:#444">&nbsp;${esc(v.reason)}</span></p>
    <table style="border-collapse:separate;margin-bottom:14px"><tr>
      ${tile("Pass rate", agg.pct + "%", COLORS.Pass, `${agg.passed}/${agg.total}`)}
      ${tile("Executed", agg.executedPct + "%", "#4FC3F7", `${agg.passed + agg.failed}/${agg.total} ran`)}
      ${tile("At risk", agg["At Risk"], COLORS["At Risk"])}
      ${tile("Failed", agg.Fail, COLORS.Fail)}
      ${tile("Blocked", agg.Blocked, COLORS.Blocked)}
    </tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px"><tr>${progressSegments(agg).filter((p) => p.n).map((p) => `<td width="${((p.n / agg.total) * 100).toFixed(1)}%" bgcolor="${p.color}" height="14" style="font-size:1px;line-height:14px">&nbsp;</td>`).join("")}</tr></table>
    <p style="font-size:12px;color:#5F6B7A;margin:0 0 14px"><b style="color:${NAVY}">Execution progress ${agg.executedPct}%</b> - ${agg.passed + agg.failed} of ${agg.total} planned scenarios executed (passed + failed). ${progressSegments(agg).map((p) => `<span style="color:${p.color === COLORS["At Risk"] ? "#7A5A00" : p.color}">&#9632;</span> ${p.label} ${p.n}`).join(" &nbsp; ")}</p>
    <h3 style="${h3}">Android &amp; iOS execution</h3>
    <table style="border-collapse:collapse;width:100%;border:1px solid #E0E4E8;margin-bottom:14px">
      <thead><tr><th style="${th}">Platform</th><th style="${th}">Planned</th><th style="${th}">Passed</th><th style="${th}">Failed</th><th style="${th}">Blocked</th><th style="${th}">Not Run</th><th style="${th}">Pass %</th></tr></thead>
      <tbody>${platRows}</tbody>
    </table>
    ${risks ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;background:#E4ECF8;border:1px solid #CBD9EF;border-left:6px solid ${ACCENT};"><tr><td style="padding:10px 16px;background:#CBD9EF;border-bottom:1px solid #B5C9E6;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:${NAVY};letter-spacing:0.5px;">KEY RISKS &amp; NEXT ACTIONS</td></tr><tr><td style="padding:12px 16px;font-family:Arial,sans-serif;font-size:13px;color:#00264F;">${risks}</td></tr></table>` : ""}
    <h3 style="${h3}">Journeys</h3>
    <table style="border-collapse:collapse;width:100%;border:1px solid #E0E4E8;">
      <thead><tr><th style="${th}">Journey</th><th style="${th}">Platform</th><th style="${th}">Status</th><th style="${th}">Result</th><th style="${th}">Owner</th><th style="${th}">Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${defects.length ? `<h3 style="${h3}">Open defects</h3><p style="font-size:12px;margin:0 0 8px">${sevLine}</p>${openDefects.length ? `<table style="border-collapse:collapse;width:100%;border:1px solid #E0E4E8;"><thead><tr><th style="${th}">Defect</th><th style="${th}">Title</th><th style="${th}">Journey</th><th style="${th}">Severity</th><th style="${th}">Status</th><th style="${th}">Owner</th><th style="${th}">ETA</th></tr></thead><tbody>${defectRows}</tbody></table>` : "<p>No open defects.</p>"}` : ""}
  </div>`;
}

function setupEmailModal() {
  const modal = document.getElementById("emailModal");
  document.getElementById("emailBtn").addEventListener("click", () => {
    document.getElementById("emailPreview").innerHTML = buildEmailHtml(currentRelease);
    document.getElementById("copyStatus").textContent = "";
    modal.classList.remove("hidden");
  });
  document.getElementById("closeModal").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });

  document.getElementById("copyEmailBtn").addEventListener("click", async () => {
    const preview = document.getElementById("emailPreview");
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([preview.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([preview.innerText], { type: "text/plain" }),
        }),
      ]);
      document.getElementById("copyStatus").textContent = "Copied! Paste into your email.";
    } catch (err) {
      document.getElementById("copyStatus").textContent = "Copy failed - select the content above and copy manually (Ctrl+C).";
    }
  });
}

// ---------------------------------------------------------------------------
// Risks & actions, defects, failure classification
// ---------------------------------------------------------------------------
let openOnly = true;

function severityBadge(s) {
  return `<span class="sev" style="background:${SEVERITY_COLORS[s] || "#78909C"};color:${SEVERITY_TEXT[s] || "#fff"}">${esc(s)}</span>`;
}

function defectLink(d) {
  return d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.id)}</a>` : esc(d.id);
}

function isOverdue(d) {
  return !!d.eta && isOpenDefect(d) && new Date(d.eta) < new Date(new Date().toDateString());
}

function renderSummary(release) {
  const s = release.summary || {};
  const card = document.getElementById("summaryCard");
  const parts = [];
  if (s.keyRisk) parts.push(`<p class="risk-text"><b>Key risk:</b> ${esc(s.keyRisk)}</p>`);
  if (s.actions && s.actions.length) parts.push(`<ol class="actions">${s.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>`);
  card.style.display = parts.length ? "" : "none";
  document.getElementById("summaryBody").innerHTML = parts.join("");
}

function renderClassification(release) {
  const el = document.getElementById("classification");
  const agg = aggregate(journeysFor(release));
  const notPassed = agg.total - agg.passed;
  const defects = defectsFor(release).filter((d) => d.status !== "Rejected");
  if (!notPassed) {
    el.innerHTML = '<p class="empty ok">Every test passed - nothing to classify.</p>';
    return;
  }
  if (!defects.length) {
    el.innerHTML = `<p class="empty">${notPassed} test${notPassed > 1 ? "s" : ""} did not pass, but no defects/issues were recorded to explain them.</p>`;
    return;
  }
  const rows = FAILURE_TYPES.map((t) => ({ ...t, n: defects.filter((d) => (d.failureType || "Under investigation") === t.name).reduce((n, d) => n + (d.affectedTests || 0), 0) }));
  const classified = rows.reduce((n, r) => n + r.n, 0);
  rows.push({ name: "Not yet classified", color: "#CFD8DC", n: Math.max(0, notPassed - classified), gap: true });
  const denom = Math.max(notPassed, classified);
  el.innerHTML =
    `<p class="muted" style="margin:0 0 10px">${notPassed} test${notPassed > 1 ? "s" : ""} did not pass (failed, blocked or skipped).</p>` +
    rows
      .map(
        (r) => `<div class="bar-row"><div class="bar-label">${esc(r.name)}</div><div class="bar-track"><span style="width:${(r.n / denom) * 100}%;background:${r.color}"></span></div><div class="bar-val">${r.n} <small>${pct(r.n, denom)}%</small></div></div>`
      )
      .join("") +
    (rows[rows.length - 1].n ? '<p class="muted" style="margin:8px 0 0">Add the missing failures to the Defects sheet (with Failure Type and Affected Tests) to classify them.</p>' : "");
}

function renderDefects(release) {
  const all = defectsFor(release);
  const open = all.filter(isOpenDefect);
  const sev = document.getElementById("defectSeverity");
  const wrap = document.getElementById("defectTableWrap");
  const emptyMsg = document.getElementById("defectEmpty");
  wrap.style.display = all.length ? "" : "none";
  emptyMsg.textContent = all.length ? "" : "No defects recorded for this release.";
  if (!all.length) {
    sev.innerHTML = "";
    return;
  }
  sev.innerHTML =
    SEVERITY_ORDER.map((s) => `<div class="sev-tile" style="--sc:${SEVERITY_COLORS[s]}"><div class="sev-n">${open.filter((d) => d.severity === s).length}</div><div class="sev-l">Open ${s}</div></div>`).join("") +
    `<div class="sev-tile total"><div class="sev-n">${all.length - open.length}</div><div class="sev-l">Closed / rejected</div></div>`;
  const list = (openOnly ? open : all)
    .slice()
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (isOpenDefect(b) - isOpenDefect(a)));
  document.getElementById("defectTableBody").innerHTML = list.length
    ? list
        .map(
          (d) => `<tr>
            <td><b>${defectLink(d)}</b></td>
            <td>${esc(d.title)}${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ""}</td>
            <td>${esc(d.journey || "-")}</td>
            <td>${d.platform === "Both" ? platformChip("iOS") + " " + platformChip("Android") : platformChip(d.platform)}</td>
            <td>${severityBadge(d.severity)}</td>
            <td>${esc(d.status)}</td>
            <td>${esc(d.owner || "-")}</td>
            <td>${d.eta ? `<span class="${isOverdue(d) ? "bad" : ""}">${esc(d.eta)}${isOverdue(d) ? "<br><small>overdue</small>" : ""}</span>` : "-"}</td>
            <td><span class="muted">${esc(d.failureType || "")}</span></td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="9" class="empty ok">No open defects.</td></tr>';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function render() {
  renderHero(currentRelease);
  renderWarnings();
  renderSummary(currentRelease);
  renderExecution(currentRelease);
  renderAttention(currentRelease);
  renderClassification(currentRelease);
  renderDefects(currentRelease);
  renderTrends();
  renderFilters(currentRelease);
  renderTable(currentRelease);
}

function renderPlatformToggle() {
  document.getElementById("platformToggle").innerHTML = ["All", ...platformNames]
    .map((p) => `<button class="${p === currentPlatform ? "active" : ""}" data-platform="${esc(p)}">${esc(p)}</button>`)
    .join("");
}

function setPlatform(p) {
  currentPlatform = p;
  renderPlatformToggle();
  render();
}

function populateReleaseSelect() {
  const select = document.getElementById("releaseSelect");
  const list = sortedReleases().reverse();
  select.innerHTML = list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${esc(r.date)})</option>`).join("");
  currentRelease = list[0];
  select.value = currentRelease.id;
  select.addEventListener("change", () => {
    currentRelease = releases.find((r) => r.id === select.value);
    render();
  });
}

function setupEvents() {
  document.getElementById("platformToggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-platform]");
    if (b) setPlatform(b.dataset.platform);
  });
  document.getElementById("openOnly").addEventListener("change", (e) => {
    openOnly = e.target.checked;
    renderDefects(currentRelease);
  });
  document.getElementById("statusFilters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    currentFilter = b.dataset.filter;
    renderFilters(currentRelease);
    renderTable(currentRelease);
  });
  document.addEventListener("click", (e) => {
    const row = e.target.closest("[data-open]");
    if (!row) return;
    const [name, platform] = row.dataset.open.split("|");
    openJourneyDetail(name, platform);
  });

  const modal = document.getElementById("detailModal");
  document.getElementById("closeDetailModal").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-overlay").forEach((m) => m.classList.add("hidden"));
  });

  const tip = document.getElementById("tooltip");
  document.addEventListener("mousemove", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) return tip.classList.add("hidden");
    tip.innerHTML = t.dataset.tip;
    tip.classList.remove("hidden");
    const w = tip.offsetWidth;
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - w - 8) + "px";
    tip.style.top = e.clientY + 14 + "px";
  });
}

(async function init() {
  await loadData();
  populateReleaseSelect();
  renderPlatformToggle();
  setupEvents();
  setupEmailModal();
  render();
})();
