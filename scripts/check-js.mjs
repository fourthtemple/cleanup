import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const roots = ["src", "scripts"];

function collectJavaScriptFiles(root) {
  const files = [];
  const visit = (entry) => {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry).sort()) {
        visit(path.join(entry, child));
      }
      return;
    }
    if (/\.(mjs|js)$/i.test(entry)) {
      files.push(entry);
    }
  };
  visit(path.resolve(repoRoot, root));
  return files;
}

const files = roots.flatMap(collectJavaScriptFiles);
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    failures.push({
      file: path.relative(repoRoot, file),
      output: `${result.stdout || ""}${result.stderr || ""}`.trim()
    });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\n${failure.file}\n${failure.output}`);
  }
  process.exit(1);
}

console.log(`Checked ${files.length} JavaScript files.`);
