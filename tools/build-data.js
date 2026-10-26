// Reads the Excel input workbook(s) and updates data/regression.json.
//   node tools/build-data.js [inputDir] [--dry-run]
// Every *.xlsx in inputDir (default: ./input) is merged, so one shared file or one file per developer both work.
// The release is replaced if its Release ID already exists; all other releases are kept.
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const S = require("./schema");

const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "regression.json");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const inputDir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(ROOT, "input"));

const errors = [];
const warnings = [];
const err = (loc, msg) => errors.push(`${loc}: ${msg}`);
const warn = (loc, msg) => warnings.push(`${loc}: ${msg}`);

// ---------- cell helpers ----------
function plain(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if (v.result !== undefined) return plain(v.result);
    if (v.text !== undefined) return plain(v.text);
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.hyperlink) return v.hyperlink;
    if (v.error) return "";
  }
  return typeof v === "string" ? v.trim() : v;
}

function toDate(v, loc, label) {
  if (v === "" || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 30000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(String(v));
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  err(loc, `${label} "${v}" is not a valid date (use yyyy-mm-dd).`);
  return "";
}

function toCount(v, loc, label) {
  if (v === "" || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    err(loc, `${label} "${v}" must be a whole number, 0 or more.`);
    return 0;
  }
  return n;
}

function pick(value, list, loc, label, { allowBlank = true } = {}) {
  if (value === "" || value === undefined) {
    if (!allowBlank) err(loc, `${label} is required.`);
    return "";
  }
  const hit = list.find((x) => x.toLowerCase().replace(/\s+/g, "") === String(value).toLowerCase().replace(/\s+/g, ""));
  if (!hit) err(loc, `${label} "${value}" is not allowed (use: ${list.join(", ")}).`);
  return hit || "";
}

// ---------- reading ----------
function readTable(wb, def, file) {
  const ws = wb.getWorksheet(def.name);
  if (!ws) return null;
  const headerRow = ws.getRow(1);
  const colIndex = {};
  headerRow.eachCell((cell, n) => {
    const text = String(plain(cell.value)).toLowerCase();
    const col = def.columns.find((c) => c[0].toLowerCase() === text);
    if (col) colIndex[col[1]] = n;
  });
  const missing = def.columns.filter((c) => !(c[1] in colIndex) && c[1] !== "status" && c[1] !== "url" && c[1] !== "notes").map((c) => c[0]);
  if (missing.length) err(`${file} / ${def.name}`, `missing column(s): ${missing.join(", ")}. Re-create from the template.`);
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rec = { _loc: `${file} / ${def.name} row ${r}` };
    let any = false;
    def.columns.forEach(([, key]) => {
      const v = key in colIndex ? plain(row.getCell(colIndex[key]).value) : "";
      if (v !== "") any = true;
      rec[key] = v;
    });
    if (any) rows.push(rec);
  }
  return rows;
}

async function readFiles() {
  if (!fs.existsSync(inputDir)) {
    console.error(`Input folder not found: ${inputDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(inputDir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$") && !/template/i.test(f));
  if (!files.length) {
    console.error(`No .xlsx input files found in ${inputDir} (files with "template" in the name are ignored).`);
    process.exit(1);
  }
  const all = { files, release: {}, journeys: [], defects: [] };
  for (const f of files) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(path.join(inputDir, f));
    } catch (e) {
      err(f, `cannot be read (${e.message}). Is it open/locked or not a real .xlsx?`);
      continue;
    }
    const rel = wb.getWorksheet("Release");
    if (rel) {
      for (let r = 2; r <= rel.rowCount; r++) {
        const key = String(plain(rel.getCell(r, 1).value));
        const val = plain(rel.getCell(r, 2).value);
        if (!key || val === "") continue;
        if (key in all.release && String(all.release[key]) !== String(val)) warn(`${f} / Release`, `"${key}" differs from an earlier file (kept "${all.release[key]}", ignored "${val}").`);
        else all.release[key] = val;
      }
    }
    const j = readTable(wb, S.JOURNEYS, f);
    if (!j) err(f, 'has no "Journeys" sheet.');
    else all.journeys.push(...j);
    all.defects.push(...(readTable(wb, S.DEFECTS, f) || []));
  }
  return all;
}

// ---------- building ----------
const keyOf = (j, p) => `${j}|${p}`;

function build(all) {
  const R = all.release;
  const id = String(R["Release ID"] || "").trim();
  if (!id) err("Release sheet", '"Release ID" is empty.');
  if (!R["Release Name"]) err("Release sheet", '"Release Name" is empty.');
  const date = toDate(R["Release Date"], "Release sheet", "Release Date");
  if (!date) err("Release sheet", '"Release Date" is empty.');

  const release = {
    id,
    name: R["Release Name"] || id,
    date,
    summary: {},
    platforms: {},
    defects: [],
  };
  if (R["Decision Override"]) release.summary.decisionOverride = pick(R["Decision Override"], S.DECISIONS, "Release sheet", "Decision Override");
  if (R["Decision Note"]) release.summary.decisionNote = String(R["Decision Note"]);
  if (R["Key Risk"]) release.summary.keyRisk = String(R["Key Risk"]);
  const actions = ["Action 1", "Action 2", "Action 3"].map((k) => R[k]).filter(Boolean).map(String);
  if (actions.length) release.summary.actions = actions;
  S.PLATFORMS.forEach((p) => {
    if (R[`${p} Build`] || R[`${p} Devices`]) release.platforms[p] = { build: R[`${p} Build`] || "", devices: R[`${p} Devices`] || "", journeys: [] };
  });

  // Journeys
  const journeys = new Map();
  all.journeys.forEach((r) => {
    const name = String(r.journey);
    if (!name) return err(r._loc, "Journey name is required.");
    const platform = pick(r.platform, S.PLATFORMS, r._loc, "Platform", { allowBlank: false });
    if (!platform) return;
    const k = keyOf(name, platform);
    if (journeys.has(k)) return err(r._loc, `duplicate row for "${name}" on ${platform} (also in ${journeys.get(k)._loc}).`);
    if (!r.owner) warn(r._loc, `"${name}" (${platform}) has no Owner.`);
    const status = pick(r.status, S.STATUSES, r._loc, "Status");
    const counts = { total: toCount(r.total, r._loc, "Total Tests"), passed: toCount(r.passed, r._loc, "Passed"), failed: toCount(r.failed, r._loc, "Failed"), blocked: toCount(r.blocked, r._loc, "Blocked"), skipped: toCount(r.skipped, r._loc, "Skipped") };
    const sum = counts.passed + counts.failed + counts.blocked + counts.skipped;
    if (counts.total !== sum) err(r._loc, `"${name}" (${platform}): Total ${counts.total} does not equal Passed+Failed+Blocked+Skipped = ${sum}.`);
    journeys.set(k, { _loc: r._loc, name, platform, owner: String(r.owner || ""), status, notes: String(r.notes || ""), counts });
  });

  journeys.forEach((j) => {
    const out = { name: j.name, owner: j.owner, notes: j.notes, scenarios: { ...j.counts } };
    if (j.status) out.status = j.status;
    if (!release.platforms[j.platform]) {
      warn("Release sheet", `no build/devices for ${j.platform}; add "${j.platform} Build".`);
      release.platforms[j.platform] = { build: "", devices: "", journeys: [] };
    }
    release.platforms[j.platform].journeys.push(out);
  });

  // Defects
  const seen = new Map();
  const closed = ["Closed", "Rejected"];
  all.defects.forEach((r) => {
    if (!r.id) return err(r._loc, "Defect ID is required.");
    if (seen.has(r.id)) return err(r._loc, `duplicate Defect ID ${r.id} (also in ${seen.get(r.id)}).`);
    seen.set(r.id, r._loc);
    const d = { id: String(r.id), title: String(r.title || "") };
    if (!d.title) err(r._loc, "Title is required.");
    d.journey = String(r.journey || "");
    if (d.journey && ![...journeys.values()].some((j) => j.name === d.journey)) warn(r._loc, `${d.id}: journey "${d.journey}" is not on the Journeys sheet.`);
    d.platform = pick(r.platform, [...S.PLATFORMS, "Both"], r._loc, "Platform", { allowBlank: false }) || "";
    d.severity = pick(r.severity, S.SEVERITIES, r._loc, "Severity", { allowBlank: false });
    d.status = pick(r.status, S.DEFECT_STATUSES, r._loc, "Status", { allowBlank: false });
    d.owner = String(r.owner || "");
    d.reported = toDate(r.reported, r._loc, "Reported");
    d.eta = toDate(r.eta, r._loc, "Target Fix / ETA");
    if (r.url) d.url = String(r.url);
    d.failureType = pick(r.failureType, S.FAILURE_TYPES, r._loc, "Failure Type") || "Under investigation";
    d.affectedTests = toCount(r.affectedTests, r._loc, "Affected Tests");
    d.notes = String(r.notes || "");
    if (!closed.includes(d.status)) {
      if (!d.owner) warn(r._loc, `${d.id} is ${d.status} but has no Owner.`);
      if (["Critical", "High"].includes(d.severity) && !d.eta) warn(r._loc, `${d.id} (${d.severity}) has no Target Fix / ETA.`);
    }
    release.defects.push(d);
  });

  if (!Object.keys(release.summary).length) delete release.summary;
  if (!release.defects.length) warn("Defects", "no defects entered.");
  return release;
}

function compactNumberArrays(json) {
  return json.replace(/\[\s*(\d[\d,\s]*?)\s*\]/g, (m, a) => "[" + a.replace(/\s+/g, " ").trim() + "]");
}

(async function main() {
  const all = await readFiles();
  const release = build(all);

  const jc = Object.values(release.platforms).reduce((n, p) => n + p.journeys.length, 0);
  console.log(`Input files : ${all.files.join(", ")}`);
  console.log(`Release     : ${release.id} - ${release.name} (${release.date})`);
  console.log(`Journeys    : ${jc}   Defects: ${release.defects.length}`);
  if (warnings.length) console.log(`\nWarnings (${warnings.length}):\n  - ${warnings.join("\n  - ")}`);
  if (errors.length) {
    console.error(`\nErrors (${errors.length}) - data NOT updated:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  if (dryRun) return console.log("\nDry run - nothing written.");

  let data = { releases: [] };
  if (fs.existsSync(DATA_FILE)) data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const replaced = data.releases.some((r) => r.id === release.id);
  data.releases = data.releases.filter((r) => r.id !== release.id).concat(release).sort((a, b) => new Date(b.date) - new Date(a.date));
  fs.writeFileSync(DATA_FILE, compactNumberArrays(JSON.stringify(data, null, 2)) + "\n");
  console.log(`\n${replaced ? "Replaced" : "Added"} release ${release.id} in data/regression.json (${data.releases.length} releases total).`);
})();
