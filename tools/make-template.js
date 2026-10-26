// Creates the blank Excel input template:  node tools/make-template.js [output.xlsx]
const path = require("path");
const ExcelJS = require("exceljs");
const S = require("./schema");

const NAVY = "FF0B2A4A";
const MAX_ROWS = 500;

const INSTRUCTIONS = [
  ["HOW TO USE THIS WORKBOOK", ""],
  ["", ""],
  ["1. Release", "The QA lead fills this sheet once per release (ID, name, date, builds, key risk, actions). Developers leave it alone."],
  ["2. Journeys  (mandatory)", "Each developer adds ONE ROW per journey per platform that they own: final counts, plus notes (blockers, reasons). Total must equal Passed + Failed + Blocked + Skipped."],
  ["3. Defects", "One row per defect or issue. Fill Journey, Severity, Status, Owner, ETA, Jira URL, Failure Type and how many tests it affects. Severity counts and failure classification on the dashboard are calculated from this sheet."],
  ["", ""],
  ["Rules", ""],
  ["", "Use the dropdowns - typed values that do not match are rejected by the build step."],
  ["", "Use the same Journey and Platform spelling on every sheet."],
  ["", "Never type percentages - they are calculated."],
  ["", "Blocked and Skipped scenarios count against the pass rate (pass rate = passed / total planned)."],
  ["", "Several people can work in one shared file (SharePoint / OneDrive co-authoring), or each person can keep a separate copy - put all files in the input folder and the build step merges them."],
  ["", "To publish: node tools/build-data.js   (updates data/regression.json, previous releases are kept)."],
];

function listValidation(items) {
  return { type: "list", allowBlank: true, formulae: [`"${items.join(",")}"`], showErrorMessage: true, errorStyle: "stop", errorTitle: "Pick from the list", error: `Allowed: ${items.join(", ")}` };
}

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.height = 22;
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Segoe UI", size: 10 };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    c.alignment = { vertical: "middle", wrapText: true };
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function addTable(wb, def, validations = {}, extra) {
  const ws = wb.addWorksheet(def.name);
  ws.columns = def.columns.map(([header, key, width]) => ({ header, key, width }));
  styleHeader(ws);
  const keys = def.columns.map((c) => c[1]);
  Object.entries(validations).forEach(([key, v]) => {
    const col = keys.indexOf(key) + 1;
    for (let r = 2; r <= MAX_ROWS; r++) ws.getCell(r, col).dataValidation = v;
  });
  keys.forEach((key, i) => {
    if (key === "date" || key === "reported" || key === "eta") for (let r = 2; r <= MAX_ROWS; r++) ws.getCell(r, i + 1).numFmt = "yyyy-mm-dd";
  });
  if (extra) extra(ws, keys);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: keys.length } };
  return ws;
}

function createWorkbook() {
  const wb = new ExcelJS.Workbook();

  const ins = wb.addWorksheet("Instructions");
  ins.columns = [{ width: 30 }, { width: 120 }];
  INSTRUCTIONS.forEach((r) => ins.addRow(r));
  ins.getRow(1).font = { bold: true, size: 14, color: { argb: NAVY } };
  ins.getColumn(1).font = { bold: true };
  ins.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  ins.getColumn(1).alignment = { vertical: "top" };

  const rel = wb.addWorksheet("Release");
  rel.columns = [{ header: "Field", key: "k", width: 22 }, { header: "Value", key: "v", width: 48 }, { header: "Help", key: "h", width: 90 }];
  styleHeader(rel);
  S.RELEASE_KEYS.forEach(([k, h]) => rel.addRow({ k, v: "", h }));
  rel.getColumn(1).font = { bold: true };
  rel.getColumn(3).font = { color: { argb: "FF5F6B7A" }, italic: true };
  rel.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  rel.getCell("B4").numFmt = "yyyy-mm-dd";
  rel.getCell("B9").dataValidation = listValidation(S.DECISIONS);

  const journeyList = { type: "list", allowBlank: true, formulae: [`Journeys!$A$2:$A$${MAX_ROWS}`], showErrorMessage: true, errorStyle: "warning", errorTitle: "Unknown journey", error: "Journey not found on the Journeys sheet." };
  const whole = { type: "whole", operator: "greaterThanOrEqual", allowBlank: true, formulae: [0], showErrorMessage: true, errorTitle: "Number needed", error: "Enter a whole number, 0 or more." };

  addTable(
    wb,
    S.JOURNEYS,
    { platform: listValidation(S.PLATFORMS), status: listValidation(S.STATUSES), total: whole, passed: whole, failed: whole, blocked: whole, skipped: whole },
    (ws, keys) => {
      ws.getCell("K1").value = "Check";
      ws.getColumn(11).width = 12;
      ws.getCell("K1").font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getCell("K1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
      for (let r = 2; r <= MAX_ROWS; r++) ws.getCell(`K${r}`).value = { formula: `IF(D${r}="","",IF(D${r}=E${r}+F${r}+G${r}+H${r},"OK","Mismatch"))` };
      ws.addConditionalFormatting({
        ref: `K2:K${MAX_ROWS}`,
        rules: [{ type: "cellIs", operator: "equal", formulae: ['"Mismatch"'], style: { font: { color: { argb: "FF9C0006" }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFC7CE" } } } }],
      });
    }
  );
  addTable(wb, S.DEFECTS, {
    journey: journeyList,
    platform: listValidation([...S.PLATFORMS, "Both"]),
    severity: listValidation(S.SEVERITIES),
    status: listValidation(S.DEFECT_STATUSES),
    failureType: listValidation(S.FAILURE_TYPES),
    affectedTests: whole,
  });
  return wb;
}

module.exports = { createWorkbook };

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, "..", "input", "RegressionInput-Template.xlsx"));
  createWorkbook()
    .xlsx.writeFile(out)
    .then(() => console.log("Template written:", out));
}
