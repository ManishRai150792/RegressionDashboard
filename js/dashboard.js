const STATUS_ORDER = ["Blocked", "Fail", "At Risk", "Pass"];
const STATUS_COLORS = {
  Pass: "#1a7f37",
  Fail: "#b3261e",
  Blocked: "#7a1f1f",
  "At Risk": "#9a6700",
  skipped: "#9aa1ab",
};

let releases = [];
let currentRelease = null;
let currentFilter = "All";

function statusClass(status) {
  return status.replace(/\s+/g, "-");
}

function sortedReleases() {
  return releases.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function loadData() {
  try {
    const res = await fetch("data/regression.json");
    const data = await res.json();
    releases = data.releases || [];
  } catch (err) {
    document.querySelector("main").innerHTML =
      '<p style="color:#b3261e">Could not load data/regression.json. If you opened this file directly (file://), browsers block local JSON fetches. Run a local server instead, e.g: <code>python3 -m http.server 8000</code> from this folder, then open <code>http://localhost:8000</code>.</p>';
    throw err;
  }
}

function populateReleaseSelect() {
  const select = document.getElementById("releaseSelect");
  select.innerHTML = "";
  sortedReleases()
    .slice()
    .reverse()
    .forEach((release) => {
      const opt = document.createElement("option");
      opt.value = release.id;
      opt.textContent = `${release.name} (${release.date})`;
      select.appendChild(opt);
    });
  select.addEventListener("change", () => {
    currentRelease = releases.find((r) => r.id === select.value);
    render();
  });
  currentRelease = sortedReleases().reverse()[0];
  select.value = currentRelease.id;
}

function scenarioTotals(journey) {
  const s = journey.scenarios || { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  const pct = s.total ? Math.round((s.passed / s.total) * 100) : 0;
  return { ...s, pct };
}

function computeStats(release) {
  const stats = { Pass: 0, Fail: 0, Blocked: 0, "At Risk": 0, total: release.journeys.length };
  let scenarioTotal = 0;
  let scenarioPassed = 0;
  release.journeys.forEach((j) => {
    stats[j.status]++;
    const s = scenarioTotals(j);
    scenarioTotal += s.total;
    scenarioPassed += s.passed;
  });
  stats.scenarioTotal = scenarioTotal;
  stats.scenarioPassed = scenarioPassed;
  stats.scenarioPassPct = scenarioTotal ? Math.round((scenarioPassed / scenarioTotal) * 100) : 0;
  return stats;
}

function renderStatCards(release) {
  const stats = computeStats(release);
  const passPct = stats.total ? Math.round((stats.Pass / stats.total) * 100) : 0;
  const cards = [
    { label: "Total Journeys", value: stats.total },
    { label: "Blocked", value: stats.Blocked },
    { label: "At Risk", value: stats["At Risk"] },
    { label: "Failed", value: stats.Fail },
    { label: "Journey Pass Rate", value: `${passPct}%` },
    { label: "Scenario Pass Rate", value: `${stats.scenarioPassPct}%`, sub: `${stats.scenarioPassed}/${stats.scenarioTotal} scenarios` },
  ];
  const container = document.getElementById("statCards");
  container.innerHTML = cards
    .map(
      (c) =>
        `<div class="stat-card"><div class="value">${c.value}</div><div class="label">${c.label}</div>${
          c.sub ? `<div class="sub">${c.sub}</div>` : ""
        }</div>`
    )
    .join("");
}

function miniScenarioBar(journey) {
  const s = scenarioTotals(journey);
  if (!s.total) return '<span class="notes">no scenarios logged</span>';
  const segs = [
    { n: s.passed, color: STATUS_COLORS.Pass },
    { n: s.failed, color: STATUS_COLORS.Fail },
    { n: s.blocked, color: STATUS_COLORS.Blocked },
    { n: s.skipped, color: STATUS_COLORS.skipped },
  ];
  const bar = segs
    .filter((seg) => seg.n > 0)
    .map((seg) => `<span style="width:${(seg.n / s.total) * 100}%;background:${seg.color}"></span>`)
    .join("");
  return `
    <div class="scenario-cell">
      <div class="scenario-pct">${s.pct}%</div>
      <div class="mini-bar">${bar}</div>
      <div class="scenario-count">${s.passed}/${s.total} passed</div>
    </div>`;
}

function renderTable(release) {
  const tbody = document.getElementById("journeyTableBody");
  const journeys = release.journeys
    .filter((j) => currentFilter === "All" || j.status === currentFilter)
    .slice()
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  tbody.innerHTML = journeys
    .map(
      (j) => `
      <tr class="journey-row" data-journey="${encodeURIComponent(j.name)}">
        <td>${j.name}</td>
        <td><span class="badge ${statusClass(j.status)}">${j.status}</span></td>
        <td>${miniScenarioBar(j)}</td>
        <td>${j.owner}</td>
        <td class="notes">${j.notes || ""}</td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll(".journey-row").forEach((row) => {
    row.addEventListener("click", () => openJourneyDetail(decodeURIComponent(row.dataset.journey)));
  });
}

function buildSvgLineChart(points, { width = 560, height = 160, suffix = "%" } = {}) {
  const padding = { top: 16, right: 20, bottom: 28, left: 34 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const maxVal = 100;
  const coords = points.map((p, i) => ({
    x: padding.left + (points.length === 1 ? innerW / 2 : (i * innerW) / (points.length - 1)),
    y: padding.top + innerH - (p.value / maxVal) * innerH,
    ...p,
  }));

  const gridLines = [0, 50, 100]
    .map((v) => {
      const y = padding.top + innerH - (v / maxVal) * innerH;
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e2e5e9" stroke-width="1" />
              <text x="${padding.left - 8}" y="${y + 4}" font-size="10" fill="#6b7280" text-anchor="end">${v}${suffix}</text>`;
    })
    .join("");

  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  const dots = coords
    .map(
      (c) => `
      <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="#1f6feb" />
      <text x="${c.x.toFixed(1)}" y="${c.y.toFixed(1) - 10}" font-size="11" fill="#1f2328" text-anchor="middle">${c.value}${suffix}</text>
      <text x="${c.x.toFixed(1)}" y="${height - 8}" font-size="10" fill="#6b7280" text-anchor="middle">${c.label}</text>`
    )
    .join("");

  return `
  <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    ${gridLines}
    <path d="${pathD}" fill="none" stroke="#1f6feb" stroke-width="2" />
    ${dots}
  </svg>`;
}

function renderOverallTrend() {
  const points = sortedReleases().map((r) => {
    const stats = computeStats(r);
    return { label: r.date, value: stats.scenarioPassPct };
  });
  document.getElementById("trendChart").innerHTML = buildSvgLineChart(points);
}

function render() {
  renderStatCards(currentRelease);
  renderTable(currentRelease);
  renderOverallTrend();
}

function setupFilters() {
  document.querySelectorAll(".filter-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderTable(currentRelease);
    });
  });
}

function openJourneyDetail(journeyName) {
  const modal = document.getElementById("detailModal");
  const journey = currentRelease.journeys.find((j) => j.name === journeyName);
  const s = scenarioTotals(journey);

  const history = sortedReleases()
    .map((r) => {
      const j = r.journeys.find((jj) => jj.name === journeyName);
      if (!j) return null;
      return { label: r.date, value: scenarioTotals(j).pct };
    })
    .filter(Boolean);

  const segs = [
    { label: "Passed", n: s.passed, color: STATUS_COLORS.Pass },
    { label: "Failed", n: s.failed, color: STATUS_COLORS.Fail },
    { label: "Blocked", n: s.blocked, color: STATUS_COLORS.Blocked },
    { label: "Skipped", n: s.skipped, color: STATUS_COLORS.skipped },
  ].filter((seg) => seg.n > 0);

  document.getElementById("detailTitle").textContent = journeyName;
  document.getElementById("detailMeta").innerHTML = `
    <span class="badge ${statusClass(journey.status)}">${journey.status}</span>
    <span class="notes">Owner: ${journey.owner}</span>
    ${journey.notes ? `<p class="notes">${journey.notes}</p>` : ""}
  `;
  document.getElementById("detailScenarioSummary").innerHTML = `
    <div class="scenario-breakdown">
      <div class="breakdown-bar">${segs.map((seg) => `<span style="width:${(seg.n / s.total) * 100}%;background:${seg.color}" title="${seg.label}: ${seg.n}"></span>`).join("")}</div>
      <div class="breakdown-legend">
        ${segs.map((seg) => `<span class="legend-item"><i style="background:${seg.color}"></i>${seg.label}: ${seg.n}</span>`).join("")}
        <span class="legend-item"><b>${s.total} total scenarios &middot; ${s.pct}% pass</b></span>
      </div>
    </div>
  `;
  document.getElementById("detailTrend").innerHTML =
    history.length > 1
      ? buildSvgLineChart(history, { width: 520, height: 150 })
      : '<p class="notes">Not enough release history for this journey yet.</p>';

  modal.classList.remove("hidden");
}

function setupDetailModal() {
  const modal = document.getElementById("detailModal");
  document.getElementById("closeDetailModal").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
}

function buildEmailHtml(release) {
  const stats = computeStats(release);
  const passPct = stats.total ? Math.round((stats.Pass / stats.total) * 100) : 0;
  const colors = { Pass: ["#e6f4ea", "#1a7f37"], Fail: ["#fdecea", "#b3261e"], Blocked: ["#f6dede", "#7a1f1f"], "At Risk": ["#fff4ce", "#9a6700"] };
  const rows = release.journeys
    .slice()
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
    .map((j) => {
      const [bg, fg] = colors[j.status];
      const s = scenarioTotals(j);
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e5e9;font-family:Arial,sans-serif;font-size:13px;">${j.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e5e9;font-family:Arial,sans-serif;font-size:13px;"><span style="background:${bg};color:${fg};padding:2px 10px;border-radius:12px;font-weight:bold;">${j.status}</span></td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e5e9;font-family:Arial,sans-serif;font-size:13px;">${s.passed}/${s.total} (${s.pct}%)</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e5e9;font-family:Arial,sans-serif;font-size:13px;">${j.owner}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e5e9;font-family:Arial,sans-serif;font-size:13px;color:#555;">${j.notes || "-"}</td>
      </tr>`;
    })
    .join("");

  return `
  <div style="font-family:Arial,sans-serif;">
    <h2 style="font-size:16px;margin:0 0 4px;">Regression Summary — ${release.name}</h2>
    <p style="font-size:13px;color:#555;margin:0 0 12px;">Run date: ${release.date} &nbsp;|&nbsp; Journey pass rate: <b>${passPct}%</b> (${stats.Pass}/${stats.total}) &nbsp;|&nbsp; Scenario pass rate: <b>${stats.scenarioPassPct}%</b> (${stats.scenarioPassed}/${stats.scenarioTotal}) &nbsp;|&nbsp; Blocked: <b style="color:#7a1f1f">${stats.Blocked}</b> &nbsp;|&nbsp; At Risk: <b style="color:#9a6700">${stats["At Risk"]}</b></p>
    <table style="border-collapse:collapse;width:100%;border:1px solid #e2e5e9;">
      <thead>
        <tr style="background:#fafbfc;">
          <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;">Journey</th>
          <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;">Status</th>
          <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;">Scenarios</th>
          <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;">Owner</th>
          <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;">Notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function setupEmailModal() {
  const modal = document.getElementById("emailModal");
  document.getElementById("emailBtn").addEventListener("click", () => {
    const html = buildEmailHtml(currentRelease);
    document.getElementById("emailPreview").innerHTML = html;
    document.getElementById("copyStatus").textContent = "";
    modal.classList.remove("hidden");
  });
  document.getElementById("closeModal").addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });

  document.getElementById("copyEmailBtn").addEventListener("click", async () => {
    const html = document.getElementById("emailPreview").innerHTML;
    const text = document.getElementById("emailPreview").innerText;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      document.getElementById("copyStatus").textContent = "Copied! Paste into your email.";
    } catch (err) {
      document.getElementById("copyStatus").textContent = "Copy failed — select the table above and copy manually (Cmd+C).";
    }
  });
}

(async function init() {
  await loadData();
  populateReleaseSelect();
  setupFilters();
  setupEmailModal();
  setupDetailModal();
  render();
})();
