import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function startDevServer() {
  const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });

  const url = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting dev server\n${output}${errors}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        clearTimeout(timeout);
        accept(match[0]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dev server exited with ${code}\n${output}${errors}`));
    });
  });

  return { child, url };
}

async function stopDevServer(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill();
  await once(child, "exit");
}

test("server library save accepts cleanup JSON larger than the old 16 MiB limit", { timeout: 30_000 }, async (t) => {
  const folder = `save-payload-${process.pid}-${Date.now()}`;
  const folderPath = resolve(projectRoot, "assets/models/animation-library", folder);
  const fileName = "large-texture-weight-patch.json";
  const content = JSON.stringify({
    version: 1,
    texturePaintLayers: [{
      layers: [{
        name: "Imported texture",
        source: `data:image/png;base64,${"A".repeat((16 * 1024 * 1024) + 1024)}`
      }]
    }]
  });
  const { child, url } = await startDevServer();

  t.after(async () => {
    await stopDevServer(child);
    await rm(folderPath, { recursive: true, force: true });
  });

  const response = await fetch(new URL("/api/animation-library/cleanup", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, fileName, content })
  });
  const responseText = await response.text();

  assert.equal(response.status, 200, responseText);
  const saved = await readFile(resolve(folderPath, fileName), "utf8");
  assert.equal(saved, content);
});
