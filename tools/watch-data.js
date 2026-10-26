// Rebuilds data/regression.json every time an input workbook is saved:  node tools/watch-data.js [inputDir]
// Without an argument it watches ./input, or ./input/examples when ./input has no workbook of its own.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const isWorkbook = (f) => /\.xlsx$/i.test(f) && !f.startsWith("~$") && !/template/i.test(f);
const hasWorkbook = (dir) => fs.existsSync(dir) && fs.readdirSync(dir).some(isWorkbook);

let dir = process.argv[2] && path.resolve(process.argv[2]);
if (!dir) dir = hasWorkbook(path.join(ROOT, "input")) ? path.join(ROOT, "input") : path.join(ROOT, "input", "examples");
if (!fs.existsSync(dir)) {
  console.error(`Folder not found: ${dir}`);
  process.exit(1);
}

let timer = null;
let running = false;
let again = false;

function build() {
  if (running) return void (again = true);
  running = true;
  console.log(`\n[${new Date().toLocaleTimeString()}] Change detected - rebuilding...`);
  const p = spawn(process.execPath, [path.join(__dirname, "build-data.js"), dir], { stdio: "inherit" });
  p.on("exit", (code) => {
    running = false;
    if (code !== 0) console.log("Build failed - fix the problems above and save again. The dashboard data was not changed.");
    else console.log("Done - reload the dashboard page.");
    if (again) {
      again = false;
      build();
    }
  });
}

fs.watch(dir, (event, file) => {
  if (!file || !isWorkbook(file)) return;
  clearTimeout(timer);
  timer = setTimeout(build, 1500); // Excel writes the file in several steps; wait until it settles
});

console.log(`Watching ${dir}\nSave an Excel workbook there and data/regression.json updates automatically. Press Ctrl+C to stop.`);
build();
