import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = parseArgs(process.argv.slice(2));
const timeoutMs = positiveInteger(args.timeout || process.env.WEBGPU_AIRBRUSH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const headless = args.headed !== true && process.env.WEBGPU_AIRBRUSH_HEADLESS !== "0";
const keepOpen = args.keepOpen === true || process.env.WEBGPU_AIRBRUSH_KEEP_OPEN === "1";
const skipAssetPaint = args.skipAssetPaint === true || process.env.WEBGPU_AIRBRUSH_SKIP_ASSET_PAINT === "1";

const cleanupTasks = [];

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      if (!message.id) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP command failed."));
      } else {
        pending.resolve(message.result || {});
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Ignore shutdown errors.
    }
  }
}

try {
  const appUrl = args.url || await startDevServer();
  const chromePort = await allocatePort();
  const userDataDir = await mkdtemp(join(tmpdir(), "cleanup-webgpu-airbrush-"));
  cleanupTasks.push(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  const validationUrl = withWebGpuQuery(appUrl);
  const chrome = await launchChrome({
    browserPath: args.browser || process.env.CHROME_PATH || DEFAULT_CHROME_PATH,
    port: chromePort,
    userDataDir,
    url: validationUrl,
    headless
  });
  cleanupTasks.push(async () => {
    if (!keepOpen && !chrome.killed) {
      chrome.kill("SIGTERM");
    }
  });

  const pageWebSocketUrl = await waitForPageWebSocketUrl(chromePort, timeoutMs);
  const cdp = await CdpClient.connect(pageWebSocketUrl);
  cleanupTasks.push(async () => cdp.close());

  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitForRuntime(cdp, "document.readyState === 'complete' || document.readyState === 'interactive'", timeoutMs);
  await waitForRuntime(cdp, "Boolean(window.modelCleanupEditor && window.modelCleanupWebGpuStatus && window.modelCleanupWebGpuSelfTest)", timeoutMs);
  await waitForRuntime(cdp, [
    "window.modelCleanupEditor.textureAirbrushWebGpuRendererReady === true",
    "window.modelCleanupEditor.textureAirbrushWebGpuRendererDisabled === true",
    "!window.modelCleanupEditor.textureAirbrushWebGpuRendererInit"
  ].join(" || "), timeoutMs);

  const statusBefore = await evaluateRuntime(cdp, "window.modelCleanupWebGpuStatus()");
  const selfTest = await evaluateRuntime(cdp, "window.modelCleanupWebGpuSelfTest()", { awaitPromise: true, timeoutMs });
  const assetPaint = skipAssetPaint
    ? { skipped: true }
    : await evaluateRuntime(cdp, webGpuAssetPaintExpression(), { awaitPromise: true, timeoutMs });
  const statusAfter = await evaluateRuntime(cdp, "window.modelCleanupWebGpuStatus()");

  const checks = webGpuAirbrushChecks(statusAfter, selfTest, assetPaint);
  const summary = {
    ok: Object.values(checks).every(Boolean),
    url: validationUrl,
    headless,
    assetPaintSkipped: skipAssetPaint,
    checks,
    statusBefore,
    selfTest,
    assetPaint,
    statusAfter
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    const failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    throw new Error(`WebGPU airbrush validation failed: ${failed}`);
  }
} finally {
  for (const task of cleanupTasks.reverse()) {
    try {
      await task();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--headed") {
      parsed.headed = true;
    } else if (value === "--keep-open") {
      parsed.keepOpen = true;
    } else if (value === "--skip-asset-paint") {
      parsed.skipAssetPaint = true;
    } else if (value === "--url") {
      parsed.url = argv[++index] || "";
    } else if (value === "--browser") {
      parsed.browser = argv[++index] || "";
    } else if (value === "--timeout") {
      parsed.timeout = argv[++index] || "";
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: npm run validate:webgpu-airbrush -- [options]

Options:
  --url <url>       Validate an already running Cleanup app.
  --browser <path>  Chrome/Chromium executable path.
  --timeout <ms>    Timeout for server/browser readiness.
  --headed          Launch Chrome visibly instead of headless.
  --keep-open       Leave Chrome open after validation.
  --skip-asset-paint
                    Only run the tiny compute self-test; skip loading/painting the demo FBX.
`);
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return typeof address === "object" && address ? address.port : 0;
}

function startDevServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    cleanupTasks.push(async () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Timed out waiting for Cleanup dev server URL."));
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      const match = String(chunk).match(/https?:\/\/127\.0\.0\.1:\d+\/?/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Cleanup dev server exited before startup (code ${code}).`));
      }
    });
  });
}

async function launchChrome({ browserPath, port, userDataDir, url, headless: useHeadless }) {
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--enable-unsafe-webgpu",
    "--window-size=1280,900",
    "--autoplay-policy=no-user-gesture-required",
    url
  ];
  if (useHeadless) {
    chromeArgs.unshift("--headless=new");
  }
  const child = spawn(browserPath, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (/error|gpu|webgpu/i.test(chunk)) {
      process.stderr.write(chunk);
    }
  });
  child.once("error", (error) => {
    throw error;
  });
  return child;
}

function withWebGpuQuery(value) {
  const url = new URL(value);
  url.searchParams.set("webgpu-renderer", "1");
  url.searchParams.set("webgpu-airbrush", "1");
  url.searchParams.set("webgpu-validation", String(Date.now()));
  return url.href;
}

async function waitForPageWebSocketUrl(port, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl)
          || pages.find((item) => item.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Chrome may not have opened the debugging endpoint yet.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for Chrome DevTools page websocket.");
}

async function waitForRuntime(cdp, expression, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await evaluateRuntime(cdp, expression).catch(() => false);
    if (value === true) {
      return true;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for runtime condition: ${expression}`);
}

async function evaluateRuntime(cdp, expression, { awaitPromise = false, timeoutMs: evalTimeoutMs = timeoutMs } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    timeout: evalTimeoutMs
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
  }
  return result.result?.value;
}

function webGpuAirbrushChecks(status, selfTest, assetPaint = null) {
  return {
    nativeWebGpuAvailable: status?.nativeWebGpuAvailable === true,
    rendererRequested: status?.requested?.renderer === true,
    airbrushRequested: status?.requested?.airbrush === true,
    nativeRendererBackend: status?.rendererState?.isNativeWebGpuBackend === true,
    rendererReady: status?.rendererReady === true,
    deviceReady: status?.deviceReady === true,
    airbrushReady: status?.airbrushReady === true,
    selfTestOk: selfTest?.ok === true,
    selfTestPaintedPixels: Number(selfTest?.paintedPixels) > 0,
    assetLoaded: assetPaint?.skipped === true || assetPaint?.loaded === true,
    assetPaintable: assetPaint?.skipped === true || Number(assetPaint?.paintRecords) > 0,
    assetPrewarmed: assetPaint?.skipped === true
      || assetPaint?.prewarmed === true
      || Boolean(assetPaint?.prewarmStats)
      || (assetPaint?.stats?.sourceUploaded === false && assetPaint?.stats?.reusedResources === true),
    assetPaintApplied: assetPaint?.skipped === true || assetPaint?.applied === true,
    assetPaintReusedPrewarm: assetPaint?.skipped === true
      || (assetPaint?.stats?.sourceUploaded === false && assetPaint?.stats?.reusedResources === true),
    assetPaintReadback: assetPaint?.skipped === true || Number(assetPaint?.stats?.readbackBytes) > 0,
    assetDirtyReadback: assetPaint?.skipped === true
      || Number(assetPaint?.stats?.readbackBytes) < Math.max(
        Number(assetPaint?.stats?.sourceBytes) || 0,
        Number(assetPaint?.prewarmStats?.sourceBytes) || 0
      )
  };
}

function webGpuAssetPaintExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { loaded: false, error: "missing-editor" };
    }
    await editor.loadAnimationLibraryAsset({
      key: "webgpu-validation:test-walking-8",
      name: "walking-8.fbx",
      label: "walking-8",
      extension: "fbx",
      folder: "test",
      path: "assets/models/animation-library/test/walking-8.fbx",
      url: "./assets/models/animation-library/test/walking-8.fbx",
      cleanupFile: "",
      cleanupPath: "",
      engine: true,
      demo: true
    });
    const records = Array.isArray(editor.paintRecords) ? editor.paintRecords : [];
    let chosen = null;
    for (const record of records) {
      const materials = Array.isArray(record?.object?.material)
        ? record.object.material
        : [record?.object?.material].filter(Boolean);
      const index = materials.findIndex((material) => material && (material.map || material.color));
      if (index >= 0) {
        chosen = {
          record,
          material: materials[index],
          materialIndex: index
        };
        break;
      }
    }
    if (!chosen) {
      return {
        loaded: Boolean(editor.model),
        paintRecords: records.length,
        error: "missing-paintable-material"
      };
    }
    const editable = editor.editableClonePaintTexture?.(chosen.material);
    if (!editable?.canvas) {
      return {
        loaded: Boolean(editor.model),
        paintRecords: records.length,
        materialName: chosen.material.name || "",
        error: "missing-editable-texture"
      };
    }
    const width = editable.canvas.width;
    const height = editable.canvas.height;
    const centerX = Math.max(0, Math.round(width * 0.5));
    const centerY = Math.max(0, Math.round(height * 0.5));
    const prewarm = editor.textureAirbrushPrewarmWebGpuEditable?.(editable, chosen.material, {
      radiusPixels: Math.max(4, Math.round(Math.min(width, height) * 0.015)),
      opacity: 1,
      hardness: 0.85,
      scatter: 0,
      color: { r: 255, g: 0, b: 255 },
      label: "texture-airbrush-asset-validation-prewarm"
    });
    const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
      material: chosen.material,
      radiusPixels: Math.max(4, Math.round(Math.min(width, height) * 0.015)),
      opacity: 1,
      hardness: 0.85,
      scatter: 0,
      color: { r: 255, g: 0, b: 255 },
      strokeSegments: [{
        start: { x: Math.max(0, centerX - 8), y: centerY },
        end: { x: Math.min(width - 1, centerX + 8), y: centerY }
      }],
      label: "texture-airbrush-asset-validation"
    });
    return {
      loaded: Boolean(editor.model),
      paintRecords: records.length,
      materialName: chosen.material.name || "",
      editableWidth: width,
      editableHeight: height,
      prewarmed: Boolean(prewarm) || Boolean(editor.textureAirbrushLastWebGpuPrewarmStats),
      prewarmStats: editor.textureAirbrushLastWebGpuPrewarmStats || null,
      applied: Boolean(result?.applied),
      appliedBytes: Number(result?.applied?.byteLength) || 0,
      stats: editor.textureAirbrushLastWebGpuPaintStats || null
    };
  })()`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
