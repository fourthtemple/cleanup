import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  if (args.dumpFrames) {
    await writeDebugFrameDumps(args.dumpFrames, assetPaint);
  }
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
    } else if (value === "--dump-frames") {
      parsed.dumpFrames = argv[++index] || "";
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
  --dump-frames <dir>
                    Save debug PNG frames for visual paint failures.
`);
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function statsArray(stats = null) {
  return Array.isArray(stats) ? stats : (stats ? [stats] : []);
}

function statsUseProceduralTriangleVisibility(stats = null) {
  const entries = statsArray(stats);
  return entries.length > 0 && entries.every((stat) => (
    Number(stat?.visibilityMaskBytes) === 0
    && Number(stat?.visibilityTriangleCount) > 0
  ));
}

function fastStrokeUsesProceduralTriangleVisibility(stroke = null) {
  return (
    Number(stroke?.visibilityMaskBytes) === 0
    && Number(stroke?.visibilityTriangleCount) > 0
  ) || statsUseProceduralTriangleVisibility(stroke?.stats);
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
    const frames = result.exceptionDetails.stackTrace?.callFrames || [];
    const stack = frames.map((frame) => (
      `${frame.functionName || "<anonymous>"}@${frame.url || "runtime"}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
    )).join("\n");
    const detail = stack
      ? `${result.exceptionDetails.text || "Runtime evaluation failed."}\n${stack}`
      : result.exceptionDetails.text || "Runtime evaluation failed.";
    throw new Error(detail);
  }
  return result.result?.value;
}

async function writeDebugFrameDumps(directory, assetPaint = null) {
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  const groups = [
    ["large-pointer", assetPaint?.largePointerStroke?.debugFrames || null],
    ["screen-stress", assetPaint?.screenStrokeStress?.debugFrames || null],
    ["default-pointer", assetPaint?.defaultPointerStroke?.debugFrames || null],
    ["visible-pointer", assetPaint?.visiblePointerStroke?.debugFrames || null]
  ];
  for (const [prefix, frames] of groups) {
    if (!frames) {
      continue;
    }
    for (const [name, dataUrl] of Object.entries(frames)) {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
        continue;
      }
      await writeFile(
        join(directory, `${prefix}-${name}.png`),
        Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64")
      );
    }
  }
}

function webGpuAirbrushChecks(status, selfTest, assetPaint = null) {
  const liveStrokeStats = Array.isArray(assetPaint?.liveStrokeStress?.stats)
    ? assetPaint.liveStrokeStress.stats
    : [];
  const liveStrokeDispatchCount = Number(assetPaint?.liveStrokeStress?.dispatchCount) || 0;
  const screenStrokeStats = Array.isArray(assetPaint?.screenStrokeStress?.stats)
    ? assetPaint.screenStrokeStress.stats
    : [];
  const screenStrokeDispatchCount = Number(assetPaint?.screenStrokeStress?.dispatchCount) || 0;
  const coalescedScreenStrokeStats = Array.isArray(assetPaint?.coalescedScreenStroke?.stats)
    ? assetPaint.coalescedScreenStroke.stats
    : [];
  const coalescedScreenStrokeSyncStats = Array.isArray(assetPaint?.coalescedScreenStroke?.syncStats)
    ? assetPaint.coalescedScreenStroke.syncStats
    : [];
  const coalescedScreenStrokeDispatchCount = Number(assetPaint?.coalescedScreenStroke?.dispatchCount) || 0;
  const coalescedScreenStrokeEventCount = Number(assetPaint?.coalescedScreenStroke?.eventCount) || 0;
  const texturePixels = Math.max(
    1,
    (Number(assetPaint?.editableWidth) || 1) * (Number(assetPaint?.editableHeight) || 1)
  );
  const textureBytes = texturePixels * 4;
  const coalescedMaxImmediateDirtyPixels = Math.max(
    0,
    ...coalescedScreenStrokeStats.map((stat) => (
      (Number(stat?.dirtyBounds?.width) || 0) * (Number(stat?.dirtyBounds?.height) || 0)
    ))
  );
  const coalescedMaxSyncReadbackBytes = Math.max(
    0,
    Number(assetPaint?.coalescedScreenStroke?.maxReadbackBytes) || 0,
    ...coalescedScreenStrokeSyncStats.map((stat) => Number(stat?.readbackBytes) || 0)
  );
  const fullSourceByteBudget = Math.max(
    1,
    textureBytes,
    Number(assetPaint?.stats?.sourceBytes) || 0,
    Number(assetPaint?.prewarmStats?.sourceBytes) || 0,
    assetPaint?.prewarmStats?.sourceExternalUploaded === true ? textureBytes : 0
  );
  const liveMaxDisplayWorkPixels = Math.max(
    0,
    ...liveStrokeStats.map((stat) => Number(stat?.liveDisplayWorkPixels) || 0)
  );
  const liveMaxDisplayMipmapPixels = Math.max(
    0,
    ...liveStrokeStats.map((stat) => Number(stat?.liveDisplayMipmapPixels) || 0)
  );
  const screenMaxLiveDisplayWorkPixels = Math.max(
    0,
    ...screenStrokeStats.map((stat) => Number(stat?.liveDisplayWorkPixels) || 0)
  );
  const screenMaxLiveDisplayMipmapPixels = Math.max(
    0,
    ...screenStrokeStats.map((stat) => Number(stat?.liveDisplayMipmapPixels) || 0)
  );
  const screenStrokePaintPixels = Number(
    assetPaint?.screenStrokeStress?.visualPaintColorChange?.changedPixels
  ) || 0;
  const visiblePointerPaintPixels = Number(
    assetPaint?.visiblePointerStroke?.visualPaintColorChange?.changedPixels
  ) || 0;
  const visiblePointerLivePaintPixels = Number(
    assetPaint?.visiblePointerStroke?.liveVisualPaintColorChange?.changedPixels
  ) || 0;
  const defaultPointerPaintPixels = Number(
    assetPaint?.defaultPointerStroke?.visualPaintColorChange?.changedPixels
  ) || 0;
  const defaultPointerLivePaintPixels = Number(
    assetPaint?.defaultPointerStroke?.liveVisualPaintColorChange?.changedPixels
  ) || 0;
  const largePointerPaintPixels = Number(
    assetPaint?.largePointerStroke?.visualPaintColorChange?.changedPixels
  ) || 0;
  const largePointerContainmentPaintPixels = Number(
    assetPaint?.largePointerStroke?.visualPaintContainment?.changedPixels
  ) || 0;
  const screenStrokeMinimumPaintPixels = 96;
  const visiblePointerMinimumPaintPixels = Math.max(
    96,
    Math.floor((Number(assetPaint?.visiblePointerStroke?.radiusPixels) || 0) * 4)
  );
  const visiblePointerMinimumLivePaintPixels = Math.max(
    96,
    Math.floor((Number(assetPaint?.visiblePointerStroke?.radiusPixels) || 0) * 4)
  );
  const defaultPointerMinimumPaintPixels = Math.max(
    24,
    Math.floor((Number(assetPaint?.defaultPointerStroke?.radiusPixels) || 0) * 2)
  );
  const largePointerMinimumPaintPixels = Math.max(
    160,
    Math.floor((Number(assetPaint?.largePointerStroke?.radiusPixels) || 0) * 4)
  );
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
      || Number(assetPaint?.stats?.readbackBytes) < fullSourceByteBudget,
    assetLiveDisplayExternalActive: assetPaint?.skipped === true || assetPaint?.liveDisplayExternalActive === true,
    assetLiveDisplayRendered: assetPaint?.skipped === true || assetPaint?.liveDisplayRenderOk === true,
    assetLiveDisplayApplied: assetPaint?.skipped === true || assetPaint?.liveDisplayApplied === true,
    assetLiveDisplayRestored: assetPaint?.skipped === true
      || assetPaint?.liveDisplayExternalRetained === true
      || assetPaint?.liveDisplayRestored === true,
    assetLiveDisplayExternalRetained: assetPaint?.skipped === true
      || assetPaint?.liveDisplayExternalActive !== true
      || assetPaint?.liveDisplayExternalRetained === true,
    assetLiveDisplayStats: assetPaint?.skipped === true
      || assetPaint?.liveDisplayStats?.liveDisplayExternalTexture === true,
    assetLiveDisplayExternalFlipYReady: assetPaint?.skipped === true
      || assetPaint?.liveDisplayExternalActive !== true
      || assetPaint?.liveDisplayMapInfo?.externalMapFlipY === false,
    assetLiveDisplayExternalColorSpaceReady: assetPaint?.skipped === true
      || assetPaint?.liveDisplayExternalActive !== true
      || assetPaint?.liveDisplayMapInfo?.canvasMapColorSpace !== "srgb"
      || assetPaint?.liveDisplayMapInfo?.externalMapColorSpace === "srgb-linear",
    assetLiveDisplayExternalMipmapReady: assetPaint?.skipped === true
      || assetPaint?.liveDisplayExternalActive !== true
      || assetPaint?.liveDisplayMapInfo?.canvasMapGenerateMipmaps !== true
      || (
        assetPaint?.liveDisplayMapInfo?.externalMapGenerateMipmaps === true
        && assetPaint?.liveDisplayMapInfo?.externalMapMinFilter
          === assetPaint?.liveDisplayMapInfo?.canvasMapMinFilter
      ),
    assetLiveDisplayVisualCaptured: assetPaint?.skipped === true
      || assetPaint?.liveDisplayColorStability?.captured === true,
    assetLiveDisplayVisualStable: assetPaint?.skipped === true
      || assetPaint?.liveDisplayColorStability?.stable === true,
    assetLiveDisplayDeferredReadback: assetPaint?.skipped === true
      || assetPaint?.liveDisplayStats?.deferredReadback === true,
    assetLiveDisplayReusedPrewarm: assetPaint?.skipped === true
      || (
        assetPaint?.liveDisplayStats?.sourceUploaded === false
        && assetPaint?.liveDisplayStats?.reusedResources === true
      ),
    assetFastLiveStrokeFound: assetPaint?.skipped === true || assetPaint?.fastLiveStroke?.found === true,
    assetFastLiveStrokeQueued: assetPaint?.skipped === true || Number(assetPaint?.fastLiveStroke?.estimate) > 0,
    assetFastLiveStrokeDense: assetPaint?.skipped === true
      || (
        Number(assetPaint?.fastLiveStroke?.queuedSegmentCount) >= 1
        && fastStrokeUsesProceduralTriangleVisibility(assetPaint?.fastLiveStroke)
      ),
    assetFastLiveStrokeHiddenEdgeBleed: assetPaint?.skipped === true
      || (
        fastStrokeUsesProceduralTriangleVisibility(assetPaint?.fastLiveStroke)
        && Number(assetPaint?.fastLiveStroke?.minVisibilityBleedRadius) > 0.5
      ),
    assetFastLiveStrokeExternalActive: assetPaint?.skipped === true
      || assetPaint?.prewarmStats?.liveDisplayExternalTexture === true
      || assetPaint?.fastLiveStroke?.liveStats?.liveDisplayExternalTexture === true
      || assetPaint?.fastLiveStroke?.externalActiveAfterFlush === true,
    assetFastLiveStrokeDeferred: assetPaint?.skipped === true
      || assetPaint?.fastLiveStroke?.liveStats?.deferredReadback === true
      || assetPaint?.fastLiveStroke?.stats?.deferredReadback === true,
    assetFastLiveStrokeDeferredCopy: assetPaint?.skipped === true
      || (
        assetPaint?.fastLiveStroke?.liveStats?.deferredReadbackCopy === true
        && assetPaint?.fastLiveStroke?.liveStats?.deferredCanvasSync !== true
        && Number(assetPaint?.fastLiveStroke?.liveStats?.readbackBytes) === 0
        && Number(assetPaint?.fastLiveStroke?.liveStats?.appliedBytes) === 0
      ),
    assetFastLiveStrokeApplied: assetPaint?.skipped === true
      || Number(assetPaint?.fastLiveStroke?.stats?.appliedBytes) > 0,
    assetFastLiveStrokeDirtyReadback: assetPaint?.skipped === true
      || Number(assetPaint?.fastLiveStroke?.stats?.readbackBytes) < fullSourceByteBudget / 10,
    assetFastLiveStrokeUndoCaptured: assetPaint?.skipped === true
      || assetPaint?.fastLiveStroke?.undoCaptured === true,
    assetFastLiveStrokePrewarmSourceReused: assetPaint?.skipped === true
      || assetPaint?.fastLiveStroke?.prewarmSourceReused === true
      || (
        assetPaint?.prewarmStats?.sourceExternalUploaded === true
        && assetPaint?.fastLiveStroke?.liveStats?.sourceUploaded === false
        && assetPaint?.fastLiveStroke?.liveStats?.reusedResources === true
      )
      || (
        assetPaint?.fastLiveStroke?.prewarmStats?.reusedResources === true
        && Number(assetPaint?.fastLiveStroke?.prewarmStats?.sourceBytes) === 0
        && assetPaint?.fastLiveStroke?.liveStats?.sourceUploaded === false
        && assetPaint?.fastLiveStroke?.liveStats?.reusedResources === true
      ),
    assetFastLiveStrokeSkippedStrokeSourceUpload: assetPaint?.skipped === true
      || assetPaint?.fastLiveStroke?.liveStats?.strokeSourceUploaded === false
      || assetPaint?.fastLiveStroke?.stats?.strokeSourceUploaded === false,
    assetLiveStrokeStressFound: assetPaint?.skipped === true
      || assetPaint?.liveStrokeStress?.found === true,
    assetLiveStrokeStressQueued: assetPaint?.skipped === true
      || (
        Number(assetPaint?.liveStrokeStress?.eventCount) >= 6
        && Number(assetPaint?.liveStrokeStress?.positiveEstimateCount) === Number(assetPaint?.liveStrokeStress?.eventCount)
      ),
    assetLiveStrokeStressDispatched: assetPaint?.skipped === true
      || Number(assetPaint?.liveStrokeStress?.dispatchCount) >= 1,
    assetLiveStrokeStressDeferredCopy: assetPaint?.skipped === true
      || (
        Number(assetPaint?.liveStrokeStress?.dispatchCount) >= 1
        && (assetPaint?.liveStrokeStress?.stats || []).every((stat) => (
          stat?.deferredReadbackCopy === true
          && stat?.deferredCanvasSync !== true
          && Number(stat?.readbackBytes) === 0
          && Number(stat?.appliedBytes) === 0
        ))
      ),
    assetLiveStrokeStressTriangleMasks: assetPaint?.skipped === true
      || (
        liveStrokeDispatchCount >= 1
        && statsUseProceduralTriangleVisibility(assetPaint?.liveStrokeStress?.stats)
      ),
    assetLiveStrokeStressDirtyLiveDisplay: assetPaint?.skipped === true
      || (
        liveStrokeDispatchCount >= 1
        && liveStrokeStats.length === liveStrokeDispatchCount
        && liveStrokeStats.every((stat) => (
          stat?.liveDisplayExternalTexture === true
          && stat?.liveDisplayFullUpdate === false
          && Number(stat?.liveDisplayWorkPixels) > 0
          && Number(stat?.liveDisplayWorkPixels) < texturePixels * 0.35
        ))
        && liveMaxDisplayWorkPixels < texturePixels * 0.35
      ),
    assetLiveStrokeStressDirtyLiveMipmaps: assetPaint?.skipped === true
      || (
        liveStrokeDispatchCount >= 1
	        && liveStrokeStats.length === liveStrokeDispatchCount
        && liveStrokeStats.every((stat) => (
          stat?.liveDisplayMipmapDirty === true
          && (
            (
              stat?.liveDisplayMipmapDeferred === true
              && Number(stat?.liveDisplayMipmapPixels) === 0
            )
            || (
              stat?.liveDisplayMipmapDeferred !== true
              && Number(stat?.liveDisplayMipmapPixels) > 0
              && Number(stat?.liveDisplayMipmapPixels) < texturePixels * 0.2
            )
          )
        ))
	        && liveMaxDisplayMipmapPixels < texturePixels * 0.2
	      ),
    assetLiveStrokeStressDrained: assetPaint?.skipped === true
      || (
        Number(assetPaint?.liveStrokeStress?.queuedAfterDrain) === 0
        && Number(assetPaint?.liveStrokeStress?.pendingAfterDrain) === 0
      ),
    assetLiveStrokeStressDirtyReadback: assetPaint?.skipped === true
      || Number(assetPaint?.liveStrokeStress?.maxReadbackBytes) < fullSourceByteBudget / 10,
    assetLiveStrokeStressDrainTime: assetPaint?.skipped === true
      || Number(assetPaint?.liveStrokeStress?.durationMs) < 250,
    assetScreenStrokeStressFound: assetPaint?.skipped === true
      || assetPaint?.screenStrokeStress?.found === true,
    assetScreenStrokeStressQueued: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.eventCount) >= 6
        && Number(assetPaint?.screenStrokeStress?.queueAccepted) === Number(assetPaint?.screenStrokeStress?.eventCount)
        && (
          Number(assetPaint?.screenStrokeStress?.screenQueueBeforeFlush) >= 1
          || Number(assetPaint?.screenStrokeStress?.dispatchCount) >= 1
        )
      ),
    assetScreenStrokeStressUsesWebGpu: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.webGpuPaintCalls) >= 1
        && Number(assetPaint?.screenStrokeStress?.dispatchCount) >= 1
      ),
    assetScreenStrokeStressPaintsRenderedSurface: assetPaint?.skipped === true
      || (
        assetPaint?.screenStrokeStress?.visualChange?.captured === true
        && assetPaint?.screenStrokeStress?.visualChange?.changed === true
        && assetPaint?.screenStrokeStress?.visualPaintColorChange?.captured === true
        && assetPaint?.screenStrokeStress?.visualPaintColorChange?.changed === true
        && screenStrokePaintPixels >= screenStrokeMinimumPaintPixels
      ),
    assetVisiblePointerStrokeFound: assetPaint?.skipped === true
      || assetPaint?.visiblePointerStroke?.found === true,
    assetVisiblePointerStrokeModelLoaded: assetPaint?.skipped === true
      || assetPaint?.visiblePointerStroke?.modelLoadedAtStart === true,
    assetVisiblePointerStrokeUsesDomEvents: assetPaint?.skipped === true
      || (
        assetPaint?.visiblePointerStroke?.pointerEvents?.down?.dispatched === true
	        && assetPaint?.visiblePointerStroke?.pointerEvents?.up?.dispatched === true
	        && (assetPaint?.visiblePointerStroke?.pointerEvents?.moves || [])
	          .every((event) => event?.dispatched === true)
	      ),
	    assetVisiblePointerStrokeUsesWebGpu: assetPaint?.skipped === true
	      || Number(assetPaint?.visiblePointerStroke?.dispatchCount) >= 1,
    assetVisiblePointerStrokePaintsRenderedSurface: assetPaint?.skipped === true
      || (
        assetPaint?.visiblePointerStroke?.visualChange?.captured === true
        && assetPaint?.visiblePointerStroke?.visualChange?.changed === true
        && assetPaint?.visiblePointerStroke?.visualPaintColorChange?.captured === true
        && assetPaint?.visiblePointerStroke?.visualPaintColorChange?.changed === true
        && visiblePointerPaintPixels >= visiblePointerMinimumPaintPixels
      ),
    assetVisiblePointerStrokePaintsLiveSurface: assetPaint?.skipped === true
      || (
        assetPaint?.visiblePointerStroke?.liveVisualChange?.captured === true
        && assetPaint?.visiblePointerStroke?.liveVisualChange?.changed === true
        && assetPaint?.visiblePointerStroke?.liveVisualPaintColorChange?.captured === true
        && assetPaint?.visiblePointerStroke?.liveVisualPaintColorChange?.changed === true
        && visiblePointerLivePaintPixels >= visiblePointerMinimumLivePaintPixels
      ),
    assetDefaultPointerStrokeFound: assetPaint?.skipped === true
      || assetPaint?.defaultPointerStroke?.found === true,
    assetDefaultPointerStrokeModelLoaded: assetPaint?.skipped === true
      || assetPaint?.defaultPointerStroke?.modelLoadedAtStart === true,
    assetDefaultPointerStrokeUsesDomEvents: assetPaint?.skipped === true
      || (
        assetPaint?.defaultPointerStroke?.pointerEvents?.down?.dispatched === true
        && assetPaint?.defaultPointerStroke?.pointerEvents?.up?.dispatched === true
        && (assetPaint?.defaultPointerStroke?.pointerEvents?.moves || [])
          .every((event) => event?.dispatched === true)
      ),
    assetDefaultPointerStrokePaintsRenderedSurface: assetPaint?.skipped === true
      || (
        assetPaint?.defaultPointerStroke?.visualChange?.captured === true
        && assetPaint?.defaultPointerStroke?.visualChange?.changed === true
        && assetPaint?.defaultPointerStroke?.visualPaintColorChange?.captured === true
        && assetPaint?.defaultPointerStroke?.visualPaintColorChange?.changed === true
        && defaultPointerPaintPixels >= defaultPointerMinimumPaintPixels
      ),
    assetDefaultPointerStrokePaintsLiveSurface: assetPaint?.skipped === true
      || (
        assetPaint?.defaultPointerStroke?.liveVisualChange?.captured === true
        && assetPaint?.defaultPointerStroke?.liveVisualChange?.changed === true
        && assetPaint?.defaultPointerStroke?.liveVisualPaintColorChange?.captured === true
        && assetPaint?.defaultPointerStroke?.liveVisualPaintColorChange?.changed === true
        && defaultPointerLivePaintPixels >= defaultPointerMinimumPaintPixels
      ),
    assetDefaultPointerStrokeContinuous: assetPaint?.skipped === true
      || (
        assetPaint?.defaultPointerStroke?.visualPaintPathContinuity?.captured === true
        && assetPaint?.defaultPointerStroke?.visualPaintPathContinuity?.continuous === true
      ),
    assetVisiblePointerStrokeContinuous: assetPaint?.skipped === true
      || (
        assetPaint?.visiblePointerStroke?.visualPaintPathContinuity?.captured === true
        && assetPaint?.visiblePointerStroke?.visualPaintPathContinuity?.continuous === true
      ),
    assetLargePointerStrokeFound: assetPaint?.skipped === true
      || assetPaint?.largePointerStroke?.found === true,
    assetLargePointerStrokeModelLoaded: assetPaint?.skipped === true
      || assetPaint?.largePointerStroke?.modelLoadedAtStart === true,
    assetLargePointerStrokeUsesWebGpu: assetPaint?.skipped === true
      || Number(assetPaint?.largePointerStroke?.dispatchCount) >= 1,
    assetLargePointerStrokePaintsRenderedSurface: assetPaint?.skipped === true
      || (
        assetPaint?.largePointerStroke?.visualPaintColorChange?.captured === true
        && assetPaint?.largePointerStroke?.visualPaintColorChange?.changed === true
        && largePointerPaintPixels >= largePointerMinimumPaintPixels
      ),
    assetLargePointerStrokeContained: assetPaint?.skipped === true
      || (
        assetPaint?.largePointerStroke?.visualPaintContainment?.captured === true
        && assetPaint?.largePointerStroke?.visualPaintContainment?.contained === true
        && largePointerContainmentPaintPixels >= largePointerMinimumPaintPixels
      ),
    assetLargePointerStrokeNoUnexpectedArtifacts: assetPaint?.skipped === true
      || (
        assetPaint?.largePointerStroke?.visualPaintArtifacts?.captured === true
        && assetPaint?.largePointerStroke?.visualPaintArtifacts?.clean === true
      ),
    assetScreenStrokeStressBoundedWebGpuDispatches: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.dispatchCount) >= 1
        && Number(assetPaint?.screenStrokeStress?.dispatchCount)
          <= Number(assetPaint?.screenStrokeStress?.eventCount)
      ),
    assetScreenStrokeStressDeferredCopy: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.dispatchCount) >= 1
        && (assetPaint?.screenStrokeStress?.stats || []).every((stat) => (
          stat?.deferredReadbackCopy === true
          && stat?.deferredCanvasSync !== true
          && Number(stat?.readbackBytes) === 0
          && Number(stat?.appliedBytes) === 0
        ))
      ),
    assetScreenStrokeStressExternalDisplay: assetPaint?.skipped === true
      || (
        screenStrokeDispatchCount >= 1
        && screenStrokeStats.every((stat) => (
          stat?.liveDisplayExternalTexture === true
        ))
      ),
    assetScreenStrokeStressExternalDisplayRetained: assetPaint?.skipped === true
      || (
        screenStrokeDispatchCount >= 1
        && assetPaint?.screenStrokeStress?.mapInfoAfterDrain?.externalMapStillActive === true
      ),
    assetScreenStrokeStressDirtyLiveDisplay: assetPaint?.skipped === true
      || (
        screenStrokeDispatchCount >= 1
        && screenStrokeStats.length === screenStrokeDispatchCount
        && screenStrokeStats.every((stat) => (
          stat?.liveDisplayFullUpdate === false
          && Number(stat?.liveDisplayWorkPixels) > 0
          && Number(stat?.liveDisplayWorkPixels) < texturePixels * 0.35
        ))
      ),
    assetScreenStrokeStressDirtyLiveMipmaps: assetPaint?.skipped === true
      || (
        screenStrokeDispatchCount >= 1
	        && screenStrokeStats.length === screenStrokeDispatchCount
        && screenStrokeStats.every((stat) => (
          stat?.liveDisplayMipmapDirty === true
          && (
            (
              stat?.liveDisplayMipmapDeferred === true
              && Number(stat?.liveDisplayMipmapPixels) === 0
            )
            || (
              stat?.liveDisplayMipmapDeferred !== true
              && Number(stat?.liveDisplayMipmapPixels) > 0
              && Number(stat?.liveDisplayMipmapPixels) < texturePixels * 0.2
            )
          )
        ))
	        && screenMaxLiveDisplayWorkPixels < texturePixels * 0.35
	        && screenMaxLiveDisplayMipmapPixels < texturePixels * 0.2
      ),
    assetScreenStrokeStressTriangleMasks: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.dispatchCount) >= 1
        && statsUseProceduralTriangleVisibility(assetPaint?.screenStrokeStress?.stats)
      ),
    assetScreenStrokeStressHiddenEdgeBleed: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.candidateCount) >= 1
        && Number(assetPaint?.screenStrokeStress?.minVisibilityBleedRadius) > 0.5
      ),
    assetScreenStrokeStressLocalDirtyReadback: assetPaint?.skipped === true
      || Number(assetPaint?.screenStrokeStress?.maxReadbackBytes) < fullSourceByteBudget / 10,
    assetScreenStrokeStressLocalDirtyBounds: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.maxDirtyWidth) < Math.max(1, Number(assetPaint?.editableWidth) || 1) * 0.35
        && Number(assetPaint?.screenStrokeStress?.maxDirtyHeight) < Math.max(1, Number(assetPaint?.editableHeight) || 1) * 0.35
      ),
    assetScreenStrokeStressContinuousCoverage: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.webGpuPaintCalls) >= 1
        && Number(assetPaint?.screenStrokeStress?.dispatchCount) >= 1
        && Number(assetPaint?.screenStrokeStress?.candidateCount) >= 1
        && Number(assetPaint?.screenStrokeStress?.totalCandidateStrokeSegments) >= 2
      ),
    assetScreenStrokeStressUndoCachedSource: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.undoCaptureCount) >= 1
        && Number(assetPaint?.screenStrokeStress?.undoCaptureCachedSourceCount)
          === Number(assetPaint?.screenStrokeStress?.undoCaptureCount)
      ),
    assetScreenStrokeStressDrained: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.screenQueueAfterDrain) === 0
        && Number(assetPaint?.screenStrokeStress?.pendingScreenAfterDrain) === 0
        && Number(assetPaint?.screenStrokeStress?.queuedAfterDrain) === 0
        && Number(assetPaint?.screenStrokeStress?.pendingAfterDrain) === 0
      ),
    assetScreenStrokeStressPreviewCleared: assetPaint?.skipped === true
      || assetPaint?.screenStrokeStress?.screenPreviewActiveAfterDrain !== true,
    assetScreenStrokeStressCanvasFlipY: assetPaint?.skipped === true
      || assetPaint?.screenStrokeStress?.mapInfoAfterDrain?.externalMapStillActive === true
      || assetPaint?.screenStrokeStress?.mapInfoAfterDrain?.expectedCanvasFlipY === null
      || assetPaint?.screenStrokeStress?.mapInfoAfterDrain?.mapFlipY
        === assetPaint?.screenStrokeStress?.mapInfoAfterDrain?.expectedCanvasFlipY,
    assetScreenStrokeStressQueueTime: assetPaint?.skipped === true
      || Number(assetPaint?.screenStrokeStress?.queueMs) < 16,
    assetScreenStrokeStressFlushReturnTime: assetPaint?.skipped === true
      || (
        Number(assetPaint?.screenStrokeStress?.flushReturnMs) < 16
        && Number(assetPaint?.screenStrokeStress?.maxFlushReturnMs) < 16
      ),
    assetScreenStrokeStressDrainTime: assetPaint?.skipped === true
      || Number(assetPaint?.screenStrokeStress?.durationMs) < 350,
    assetCoalescedScreenStrokeFound: assetPaint?.skipped === true
      || assetPaint?.coalescedScreenStroke?.found === true,
    assetCoalescedScreenStrokeBatched: assetPaint?.skipped === true
      || (
        coalescedScreenStrokeEventCount >= 6
        && coalescedScreenStrokeDispatchCount >= 1
        && coalescedScreenStrokeDispatchCount <= coalescedScreenStrokeEventCount
        && Number(assetPaint?.coalescedScreenStroke?.webGpuPaintCalls) === 1
        && Number(assetPaint?.coalescedScreenStroke?.totalCandidateStrokeSegments) >= 2
      ),
    assetCoalescedScreenStrokeDeferredCopy: assetPaint?.skipped === true
      || (
        coalescedScreenStrokeDispatchCount >= 1
        && coalescedScreenStrokeDispatchCount <= coalescedScreenStrokeEventCount
        && coalescedScreenStrokeStats.every((stat) => (
          stat?.deferredReadbackCopy === true
          && stat?.deferredCanvasSync !== true
          && Number(stat?.readbackBytes) === 0
          && Number(stat?.appliedBytes) === 0
        ))
        && coalescedMaxImmediateDirtyPixels < texturePixels * 0.01
        && coalescedMaxSyncReadbackBytes < textureBytes * 0.02
      ),
    assetCoalescedScreenStrokeDrained: assetPaint?.skipped === true
      || (
        Number(assetPaint?.coalescedScreenStroke?.screenQueueAfterDrain) === 0
        && Number(assetPaint?.coalescedScreenStroke?.queuedAfterDrain) === 0
        && Number(assetPaint?.coalescedScreenStroke?.pendingAfterDrain) === 0
      ),
    assetCoalescedScreenStrokeQueueTime: assetPaint?.skipped === true
      || Number(assetPaint?.coalescedScreenStroke?.queueMs) < 16
      || (
        coalescedScreenStrokeDispatchCount >= 1
        && coalescedScreenStrokeDispatchCount <= coalescedScreenStrokeEventCount
        && coalescedScreenStrokeEventCount >= 6
        && Number(assetPaint?.coalescedScreenStroke?.queueMs) < 64
        && Number(assetPaint?.coalescedScreenStroke?.queueMs)
          / Math.max(1, coalescedScreenStrokeEventCount) < 8
      ),
    assetScheduledScreenStrokeFound: assetPaint?.skipped === true
      || assetPaint?.scheduledScreenStroke?.found === true,
    assetScheduledScreenStrokePaintsBeforeDrain: assetPaint?.skipped === true
      || (
        assetPaint?.scheduledScreenStroke?.queued === true
        && Number(assetPaint?.scheduledScreenStroke?.webGpuPaintCalls) >= 1
        && Number(assetPaint?.scheduledScreenStroke?.immediateDispatchCount) >= 1
        && assetPaint?.scheduledScreenStroke?.forcedDrainBeforeDispatch !== true
      ),
    assetScheduledScreenStrokeNoSecondFrameHop: assetPaint?.skipped === true
      || (
        Number(assetPaint?.scheduledScreenStroke?.immediateDispatchCount) >= 1
        && Number(assetPaint?.scheduledScreenStroke?.frameCount) <= 1
      ),
    assetScheduledScreenStrokeExternalDisplay: assetPaint?.skipped === true
      || (
        Number(assetPaint?.scheduledScreenStroke?.immediateDispatchCount) >= 1
        && (assetPaint?.scheduledScreenStroke?.immediateStats || []).every((stat) => (
          stat?.liveDisplayExternalTexture === true
        ))
      ),
    assetScheduledScreenStrokeDeferredCopy: assetPaint?.skipped === true
      || (
        Number(assetPaint?.scheduledScreenStroke?.immediateDispatchCount) >= 1
        && (assetPaint?.scheduledScreenStroke?.immediateStats || []).every((stat) => (
          stat?.deferredReadback === true
          && stat?.deferredReadbackCopy === true
          && Number(stat?.readbackBytes) === 0
          && Number(stat?.appliedBytes) === 0
        ))
      ),
    assetScheduledScreenStrokeTriangleMasks: assetPaint?.skipped === true
      || (
        Number(assetPaint?.scheduledScreenStroke?.immediateDispatchCount) >= 1
        && statsUseProceduralTriangleVisibility(assetPaint?.scheduledScreenStroke?.immediateStats)
      ),
    assetScheduledScreenStrokeActiveTime: assetPaint?.skipped === true
      || Number(assetPaint?.scheduledScreenStroke?.activePaintMs) < 34
  };
}

function webGpuAssetPaintExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { loaded: false, error: "missing-editor" };
    }
    const debugFrameDumps = ${args.dumpFrames ? "true" : "false"};
    const visibilityMaskByteLength = (payload = null) => {
      if (!payload) {
        return 0;
      }
      const direct = Number(payload.byteLength);
      if (Number.isFinite(direct) && direct > 0) {
        return direct;
      }
      const nested = Number(payload.pixels?.byteLength);
      return Number.isFinite(nested) && nested > 0 ? nested : 0;
    };
    const candidateVisibilityMaskBytes = (candidate = null) => (
      visibilityMaskByteLength(candidate?.options?.visibilityMaskPixels)
    );
    const renderOnce = async () => {
      if (typeof editor.renderer?.render !== "function" || !editor.scene || !editor.camera) {
        return "missing-render-target";
      }
      const renderResult = editor.renderer.render(editor.scene, editor.camera);
      if (renderResult && typeof renderResult.then === "function") {
        await renderResult;
      }
      await new Promise((resolve) => {
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 16);
        }
      });
      return "ok";
    };
    const pixelLuma = (data, offset) => (
      Number(data[offset]) * 0.2126
      + Number(data[offset + 1]) * 0.7152
      + Number(data[offset + 2]) * 0.0722
    );
    const colorDistance = (data, offset, color) => {
      const deltaR = Number(data[offset]) - Number(color?.r || 0);
      const deltaG = Number(data[offset + 1]) - Number(color?.g || 0);
      const deltaB = Number(data[offset + 2]) - Number(color?.b || 0);
      return Math.sqrt(deltaR * deltaR + deltaG * deltaG + deltaB * deltaB);
    };
    const paintColorSignal = (data, offset, color) => {
      const r = Number(data[offset]) || 0;
      const g = Number(data[offset + 1]) || 0;
      const b = Number(data[offset + 2]) || 0;
      if (Number(color?.r) > 200 && Number(color?.b) > 200 && Number(color?.g) < 80) {
        return r > g + 24 && b > g + 16;
      }
      if (Number(color?.g) > 200 && Number(color?.b) > 200 && Number(color?.r) < 80) {
        return g > r + 16 && b > r + 16;
      }
      if (Number(color?.r) > 200 && Number(color?.g) < 80 && Number(color?.b) < 80) {
        return r > g + 24 && r > b + 24;
      }
      return true;
    };
    const captureViewerFrame = () => {
      const source = editor.canvas || editor.renderer?.domElement || document.getElementById("viewer-canvas");
      const width = Math.max(1, Math.floor(Number(source?.width) || 0));
      const height = Math.max(1, Math.floor(Number(source?.height) || 0));
      if (!source || !width || !height) {
        return { ok: false, reason: "missing-viewer-canvas", width, height };
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return { ok: false, reason: "missing-2d-context", width, height };
      }
      try {
        context.drawImage(source, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        let modelPixelCount = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumLuma = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const luma = pixelLuma(pixels, offset);
          if (luma < 36) {
            continue;
          }
          modelPixelCount += 1;
          sumR += Number(pixels[offset]);
          sumG += Number(pixels[offset + 1]);
          sumB += Number(pixels[offset + 2]);
          sumLuma += luma;
        }
        return {
          ok: true,
          width,
          height,
          data: pixels,
          modelPixelCount,
          meanR: modelPixelCount ? sumR / modelPixelCount : 0,
          meanG: modelPixelCount ? sumG / modelPixelCount : 0,
          meanB: modelPixelCount ? sumB / modelPixelCount : 0,
          meanLuma: modelPixelCount ? sumLuma / modelPixelCount : 0
        };
      } catch (error) {
        return {
          ok: false,
          reason: error?.message || String(error),
          width,
          height
        };
      }
    };
    const captureViewerFramePng = () => {
      if (!debugFrameDumps) {
        return "";
      }
      const source = editor.canvas || editor.renderer?.domElement || document.getElementById("viewer-canvas");
      const width = Math.max(1, Math.floor(Number(source?.width) || 0));
      const height = Math.max(1, Math.floor(Number(source?.height) || 0));
      if (!source || !width || !height) {
        return "";
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        return "";
      }
      try {
        context.drawImage(source, 0, 0, width, height);
        return canvas.toDataURL("image/png");
      } catch {
        return "";
      }
    };
    const summarizeViewerFrame = (frame = null) => frame
      ? {
          ok: frame.ok === true,
          reason: frame.reason || "",
          width: frame.width || 0,
          height: frame.height || 0,
          modelPixelCount: frame.modelPixelCount || 0,
          meanR: frame.meanR || 0,
          meanG: frame.meanG || 0,
          meanB: frame.meanB || 0,
          meanLuma: frame.meanLuma || 0
        }
      : null;
    const compareViewerFrames = (baseline = null, active = null) => {
      if (!baseline?.ok || !active?.ok) {
        return {
          captured: false,
          stable: false,
          reason: baseline?.reason || active?.reason || "missing-frame"
        };
      }
      if (
        baseline.width !== active.width
        || baseline.height !== active.height
        || !baseline.data
        || !active.data
      ) {
        return {
          captured: true,
          stable: false,
          reason: "frame-size-mismatch"
        };
      }
      let comparedPixels = 0;
      let sumBaselineLuma = 0;
      let sumActiveLuma = 0;
      let sumAbsoluteLumaDelta = 0;
      let brightenedPixels = 0;
      let darkenedPixels = 0;
      let largeColorDeltaPixels = 0;
      for (let offset = 0; offset < baseline.data.length; offset += 4) {
        const baseLuma = pixelLuma(baseline.data, offset);
        if (baseLuma < 36) {
          continue;
        }
        const activeLuma = pixelLuma(active.data, offset);
        const lumaDelta = activeLuma - baseLuma;
        const colorDelta = Math.max(
          Math.abs(Number(active.data[offset]) - Number(baseline.data[offset])),
          Math.abs(Number(active.data[offset + 1]) - Number(baseline.data[offset + 1])),
          Math.abs(Number(active.data[offset + 2]) - Number(baseline.data[offset + 2]))
        );
        comparedPixels += 1;
        sumBaselineLuma += baseLuma;
        sumActiveLuma += activeLuma;
        sumAbsoluteLumaDelta += Math.abs(lumaDelta);
        if (lumaDelta > 28) {
          brightenedPixels += 1;
        } else if (lumaDelta < -28) {
          darkenedPixels += 1;
        }
        if (colorDelta > 48) {
          largeColorDeltaPixels += 1;
        }
      }
      const meanBaselineLuma = comparedPixels ? sumBaselineLuma / comparedPixels : 0;
      const meanActiveLuma = comparedPixels ? sumActiveLuma / comparedPixels : 0;
      const meanAbsoluteLumaDelta = comparedPixels ? sumAbsoluteLumaDelta / comparedPixels : Infinity;
      const meanLumaRatio = meanBaselineLuma > 0 ? meanActiveLuma / meanBaselineLuma : Infinity;
      const brightenedPixelRatio = comparedPixels ? brightenedPixels / comparedPixels : 1;
      const darkenedPixelRatio = comparedPixels ? darkenedPixels / comparedPixels : 1;
      const largeColorDeltaRatio = comparedPixels ? largeColorDeltaPixels / comparedPixels : 1;
      return {
        captured: true,
        stable: comparedPixels > 1000
          && meanLumaRatio > 0.88
          && meanLumaRatio < 1.12
          && meanAbsoluteLumaDelta < 10
          && brightenedPixelRatio < 0.08
          && darkenedPixelRatio < 0.08
          && largeColorDeltaRatio < 0.12,
        comparedPixels,
        meanBaselineLuma,
        meanActiveLuma,
        meanLumaRatio,
        meanAbsoluteLumaDelta,
        brightenedPixelRatio,
        darkenedPixelRatio,
        largeColorDeltaRatio
      };
    };
    const compareViewerFrameChange = (baseline = null, active = null) => {
      if (!baseline?.ok || !active?.ok) {
        return {
          captured: false,
          changed: false,
          reason: baseline?.reason || active?.reason || "missing-frame"
        };
      }
      if (
        baseline.width !== active.width
        || baseline.height !== active.height
        || !baseline.data
        || !active.data
      ) {
        return {
          captured: true,
          changed: false,
          reason: "frame-size-mismatch"
        };
      }
      let comparedPixels = 0;
      let changedPixels = 0;
      let sumColorDelta = 0;
      let maxColorDelta = 0;
      for (let offset = 0; offset < baseline.data.length; offset += 4) {
        const baseLuma = pixelLuma(baseline.data, offset);
        const activeLuma = pixelLuma(active.data, offset);
        if (baseLuma < 36 && activeLuma < 36) {
          continue;
        }
        const colorDelta = Math.max(
          Math.abs(Number(active.data[offset]) - Number(baseline.data[offset])),
          Math.abs(Number(active.data[offset + 1]) - Number(baseline.data[offset + 1])),
          Math.abs(Number(active.data[offset + 2]) - Number(baseline.data[offset + 2]))
        );
        comparedPixels += 1;
        sumColorDelta += colorDelta;
        maxColorDelta = Math.max(maxColorDelta, colorDelta);
        if (colorDelta > 48) {
          changedPixels += 1;
        }
      }
      const changedPixelRatio = comparedPixels ? changedPixels / comparedPixels : 0;
      const meanColorDelta = comparedPixels ? sumColorDelta / comparedPixels : 0;
      return {
        captured: true,
        changed: comparedPixels > 1000
          && changedPixels >= 24
          && (changedPixelRatio > 0.0002 || meanColorDelta > 0.04),
        comparedPixels,
        changedPixels,
        changedPixelRatio,
        meanColorDelta,
        maxColorDelta
      };
    };
    const compareViewerPaintColorChange = (baseline = null, active = null, color = null, bounds = null) => {
      if (!baseline?.ok || !active?.ok) {
        return {
          captured: false,
          changed: false,
          reason: baseline?.reason || active?.reason || "missing-frame"
        };
      }
      if (
        baseline.width !== active.width
        || baseline.height !== active.height
        || !baseline.data
        || !active.data
      ) {
        return {
          captured: true,
          changed: false,
          reason: "frame-size-mismatch"
        };
      }
      if (!color || !Number.isFinite(Number(color.r)) || !Number.isFinite(Number(color.g)) || !Number.isFinite(Number(color.b))) {
        return {
          captured: true,
          changed: false,
          reason: "missing-paint-color"
        };
      }
      const left = Math.max(0, Math.floor(Number(bounds?.x) || 0));
      const top = Math.max(0, Math.floor(Number(bounds?.y) || 0));
      const right = Math.min(active.width, Math.ceil(left + Math.max(1, Number(bounds?.width) || active.width)));
      const bottom = Math.min(active.height, Math.ceil(top + Math.max(1, Number(bounds?.height) || active.height)));
      let comparedPixels = 0;
      let changedPixels = 0;
      let sumImprovement = 0;
      let maxImprovement = 0;
      let maxColorDelta = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * active.width + x) * 4;
          const baseLuma = pixelLuma(baseline.data, offset);
          const activeLuma = pixelLuma(active.data, offset);
          if (baseLuma < 28 && activeLuma < 28) {
            continue;
          }
          const colorDelta = Math.max(
            Math.abs(Number(active.data[offset]) - Number(baseline.data[offset])),
            Math.abs(Number(active.data[offset + 1]) - Number(baseline.data[offset + 1])),
            Math.abs(Number(active.data[offset + 2]) - Number(baseline.data[offset + 2]))
          );
          const improvement = colorDistance(baseline.data, offset, color)
            - colorDistance(active.data, offset, color);
          comparedPixels += 1;
          if (improvement > 0) {
            sumImprovement += improvement;
          }
          maxImprovement = Math.max(maxImprovement, improvement);
          maxColorDelta = Math.max(maxColorDelta, colorDelta);
          if (colorDelta > 18 && improvement > 16 && paintColorSignal(active.data, offset, color)) {
            changedPixels += 1;
          }
        }
      }
      const changedPixelRatio = comparedPixels ? changedPixels / comparedPixels : 0;
      const meanImprovement = comparedPixels ? sumImprovement / comparedPixels : 0;
      return {
        captured: true,
        changed: comparedPixels >= 24
          && changedPixels >= 8
          && (changedPixelRatio > 0.001 || meanImprovement > 0.15),
        bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
        comparedPixels,
        changedPixels,
        changedPixelRatio,
        meanImprovement,
        maxImprovement,
        maxColorDelta,
        color
      };
    };
    const compareViewerUnexpectedPaintArtifacts = (baseline = null, active = null, color = null, bounds = null) => {
      if (!baseline?.ok || !active?.ok) {
        return {
          captured: false,
          clean: false,
          reason: baseline?.reason || active?.reason || "missing-frame"
        };
      }
      if (
        baseline.width !== active.width
        || baseline.height !== active.height
        || !baseline.data
        || !active.data
      ) {
        return {
          captured: true,
          clean: false,
          reason: "frame-size-mismatch"
        };
      }
      if (!color || !Number.isFinite(Number(color.r)) || !Number.isFinite(Number(color.g)) || !Number.isFinite(Number(color.b))) {
        return {
          captured: true,
          clean: false,
          reason: "missing-paint-color"
        };
      }
      const left = Math.max(0, Math.floor(Number(bounds?.x) || 0));
      const top = Math.max(0, Math.floor(Number(bounds?.y) || 0));
      const right = Math.min(active.width, Math.ceil(left + Math.max(1, Number(bounds?.width) || active.width)));
      const bottom = Math.min(active.height, Math.ceil(top + Math.max(1, Number(bounds?.height) || active.height)));
      let comparedPixels = 0;
      let changedPixels = 0;
      let paintLikePixels = 0;
      let unexpectedPixels = 0;
      let worstUnexpectedDelta = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * active.width + x) * 4;
          const baseLuma = pixelLuma(baseline.data, offset);
          const activeLuma = pixelLuma(active.data, offset);
          if (baseLuma < 20 && activeLuma < 20) {
            continue;
          }
          const colorDelta = Math.max(
            Math.abs(Number(active.data[offset]) - Number(baseline.data[offset])),
            Math.abs(Number(active.data[offset + 1]) - Number(baseline.data[offset + 1])),
            Math.abs(Number(active.data[offset + 2]) - Number(baseline.data[offset + 2]))
          );
          comparedPixels += 1;
          if (colorDelta <= 22) {
            continue;
          }
          changedPixels += 1;
          const improvement = colorDistance(baseline.data, offset, color)
            - colorDistance(active.data, offset, color);
          const paintLike = improvement > 8 && paintColorSignal(active.data, offset, color);
          if (paintLike) {
            paintLikePixels += 1;
          } else if (colorDelta > 30) {
            unexpectedPixels += 1;
            worstUnexpectedDelta = Math.max(worstUnexpectedDelta, colorDelta);
          }
        }
      }
      const unexpectedRatio = changedPixels ? unexpectedPixels / changedPixels : 0;
      const allowedUnexpectedPixels = Math.max(16, Math.floor(Math.max(paintLikePixels, changedPixels) * 0.16));
      return {
        captured: true,
        clean: changedPixels >= 8
          && paintLikePixels >= 8
          && unexpectedPixels <= allowedUnexpectedPixels,
        bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
        comparedPixels,
        changedPixels,
        paintLikePixels,
        unexpectedPixels,
        unexpectedRatio,
        allowedUnexpectedPixels,
        worstUnexpectedDelta,
        color
      };
    };
    const compareViewerPaintPathContinuity = (baseline = null, active = null, color = null, points = [], rect = null, options = {}) => {
      if (!baseline?.ok || !active?.ok) {
        return {
          captured: false,
          continuous: false,
          reason: baseline?.reason || active?.reason || "missing-frame"
        };
      }
      if (
        baseline.width !== active.width
        || baseline.height !== active.height
        || !baseline.data
        || !active.data
      ) {
        return {
          captured: true,
          continuous: false,
          reason: "frame-size-mismatch"
        };
      }
      if (!rect?.width || !rect?.height || !Array.isArray(points) || points.length < 2) {
        return {
          captured: true,
          continuous: false,
          reason: "missing-path"
        };
      }
      const validPoints = points.filter((point) => (
        Number.isFinite(point?.clientX)
        && Number.isFinite(point?.clientY)
      ));
      if (validPoints.length < 2) {
        return {
          captured: true,
          continuous: false,
          reason: "missing-valid-path"
        };
      }
      const scaleX = active.width / rect.width;
      const scaleY = active.height / rect.height;
      const toFramePoint = (point) => ({
        x: (point.clientX - (rect.left || 0)) * scaleX,
        y: (point.clientY - (rect.top || 0)) * scaleY
      });
      const distance = (left, right) => Math.hypot(right.x - left.x, right.y - left.y);
      const framePath = validPoints.map(toFramePoint);
      const segmentLengths = [];
      let totalLength = 0;
      for (let index = 1; index < framePath.length; index += 1) {
        const length = distance(framePath[index - 1], framePath[index]);
        segmentLengths.push(length);
        totalLength += length;
      }
      if (!(totalLength > 1)) {
        return {
          captured: true,
          continuous: false,
          reason: "path-too-short"
        };
      }
      const pointAtLength = (targetLength) => {
        let walked = 0;
        for (let index = 1; index < framePath.length; index += 1) {
          const segmentLength = segmentLengths[index - 1] || 0;
          if (walked + segmentLength >= targetLength || index === framePath.length - 1) {
            const ratio = segmentLength > 0 ? Math.max(0, Math.min(1, (targetLength - walked) / segmentLength)) : 0;
            return {
              x: framePath[index - 1].x + (framePath[index].x - framePath[index - 1].x) * ratio,
              y: framePath[index - 1].y + (framePath[index].y - framePath[index - 1].y) * ratio
            };
          }
          walked += segmentLength;
        }
        return framePath.at(-1);
      };
      const stationCount = Math.max(5, Math.min(9, Math.floor(Number(options.stationCount) || 7)));
      const cssRadius = Math.max(2, Number(options.radiusPixels) || 10);
      const frameRadius = Math.max(3, Math.min(32, cssRadius * Math.max(scaleX, scaleY) * 0.55));
      const stations = Array.from({ length: stationCount }, (_, index) => (
        pointAtLength(totalLength * (stationCount <= 1 ? 0 : index / (stationCount - 1)))
      ));
      const stationResults = stations.map((station) => {
        const left = Math.max(0, Math.floor(station.x - frameRadius));
        const top = Math.max(0, Math.floor(station.y - frameRadius));
        const right = Math.min(active.width, Math.ceil(station.x + frameRadius + 1));
        const bottom = Math.min(active.height, Math.ceil(station.y + frameRadius + 1));
        let comparedPixels = 0;
        let paintedPixels = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const offset = (y * active.width + x) * 4;
            const baseLuma = pixelLuma(baseline.data, offset);
            const activeLuma = pixelLuma(active.data, offset);
            if (baseLuma < 28 && activeLuma < 28) {
              continue;
            }
            const colorDelta = Math.max(
              Math.abs(Number(active.data[offset]) - Number(baseline.data[offset])),
              Math.abs(Number(active.data[offset + 1]) - Number(baseline.data[offset + 1])),
              Math.abs(Number(active.data[offset + 2]) - Number(baseline.data[offset + 2]))
            );
            const improvement = colorDistance(baseline.data, offset, color)
              - colorDistance(active.data, offset, color);
            comparedPixels += 1;
            if (colorDelta > 18 && improvement > 12 && paintColorSignal(active.data, offset, color)) {
              paintedPixels += 1;
            }
          }
        }
        const paintedRatio = comparedPixels ? paintedPixels / comparedPixels : 0;
        return {
          x: Math.round(station.x),
          y: Math.round(station.y),
          comparedPixels,
          paintedPixels,
          paintedRatio,
          painted: paintedPixels >= 4 || paintedRatio >= 0.015
        };
      });
      const paintedStations = stationResults.filter((station) => station.painted).length;
      const requiredStations = Math.max(3, Math.ceil(stationCount * 0.72));
	      return {
	        captured: true,
	        continuous: paintedStations >= requiredStations,
	        stationCount,
	        paintedStations,
	        requiredStations,
	        radius: frameRadius,
	        stations: stationResults
	      };
	    };
	    const compareViewerPaintPathContainment = (baseline = null, active = null, color = null, points = [], rect = null, options = {}) => {
	      if (!baseline?.ok || !active?.ok) {
	        return {
	          captured: false,
	          contained: false,
	          reason: baseline?.reason || active?.reason || "missing-frame"
	        };
	      }
	      if (
	        baseline.width !== active.width
	        || baseline.height !== active.height
	        || !baseline.data
	        || !active.data
	      ) {
	        return {
	          captured: true,
	          contained: false,
	          reason: "frame-size-mismatch"
	        };
	      }
	      if (!rect?.width || !rect?.height || !Array.isArray(points) || points.length < 2) {
	        return {
	          captured: true,
	          contained: false,
	          reason: "missing-path"
	        };
	      }
	      const validPoints = points.filter((point) => (
	        Number.isFinite(point?.clientX)
	        && Number.isFinite(point?.clientY)
	      ));
	      if (validPoints.length < 2) {
	        return {
	          captured: true,
	          contained: false,
	          reason: "missing-valid-path"
	        };
	      }
	      const scaleX = active.width / rect.width;
	      const scaleY = active.height / rect.height;
	      const framePath = validPoints.map((point) => ({
	        x: (point.clientX - (rect.left || 0)) * scaleX,
	        y: (point.clientY - (rect.top || 0)) * scaleY
	      }));
	      const pointSegmentDistance = (point, start, end) => {
	        const dx = end.x - start.x;
	        const dy = end.y - start.y;
	        const lengthSq = dx * dx + dy * dy;
	        if (lengthSq <= 0.0001) {
	          return Math.hypot(point.x - start.x, point.y - start.y);
	        }
	        const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
	        return Math.hypot(
	          point.x - (start.x + dx * ratio),
	          point.y - (start.y + dy * ratio)
	        );
	      };
	      const pathDistance = (point) => {
	        let distance = Infinity;
	        for (let index = 1; index < framePath.length; index += 1) {
	          distance = Math.min(distance, pointSegmentDistance(point, framePath[index - 1], framePath[index]));
	        }
	        return distance;
	      };
	      const cssRadius = Math.max(2, Number(options.radiusPixels) || 10);
	      const frameRadius = Math.max(4, cssRadius * Math.max(scaleX, scaleY));
	      const insideLimit = frameRadius * 1.35;
	      const outsideLimit = frameRadius * 1.8;
	      const padding = outsideLimit + 8;
	      const minX = Math.min(...framePath.map((point) => point.x));
	      const maxX = Math.max(...framePath.map((point) => point.x));
	      const minY = Math.min(...framePath.map((point) => point.y));
	      const maxY = Math.max(...framePath.map((point) => point.y));
	      const left = Math.max(0, Math.floor(minX - padding));
	      const top = Math.max(0, Math.floor(minY - padding));
	      const right = Math.min(active.width, Math.ceil(maxX + padding + 1));
	      const bottom = Math.min(active.height, Math.ceil(maxY + padding + 1));
	      let comparedPixels = 0;
	      let changedPixels = 0;
	      let insideChangedPixels = 0;
	      let outsideChangedPixels = 0;
	      let maxOutsideImprovement = 0;
	      for (let y = top; y < bottom; y += 1) {
	        for (let x = left; x < right; x += 1) {
	          const offset = (y * active.width + x) * 4;
	          const baseLuma = pixelLuma(baseline.data, offset);
	          const activeLuma = pixelLuma(active.data, offset);
	          if (baseLuma < 28 && activeLuma < 28) {
	            continue;
	          }
	          comparedPixels += 1;
	          const colorDelta = Math.max(
	            Math.abs(Number(active.data[offset]) - Number(baseline.data[offset])),
	            Math.abs(Number(active.data[offset + 1]) - Number(baseline.data[offset + 1])),
	            Math.abs(Number(active.data[offset + 2]) - Number(baseline.data[offset + 2]))
	          );
	          const improvement = colorDistance(baseline.data, offset, color)
	            - colorDistance(active.data, offset, color);
	          if (!(colorDelta > 18 && improvement > 12 && paintColorSignal(active.data, offset, color))) {
	            continue;
	          }
	          changedPixels += 1;
	          const distance = pathDistance({ x, y });
	          if (distance <= insideLimit) {
	            insideChangedPixels += 1;
	          } else if (distance > outsideLimit) {
	            outsideChangedPixels += 1;
	            maxOutsideImprovement = Math.max(maxOutsideImprovement, improvement);
	          }
	        }
	      }
	      const outsideRatio = changedPixels ? outsideChangedPixels / changedPixels : 0;
	      const allowedOutsidePixels = Math.max(8, Math.floor(changedPixels * 0.08));
	      return {
	        captured: true,
	        contained: changedPixels >= 12
	          && insideChangedPixels >= Math.max(8, changedPixels * 0.65)
	          && outsideChangedPixels <= allowedOutsidePixels,
	        bounds: { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
	        comparedPixels,
	        changedPixels,
	        insideChangedPixels,
	        outsideChangedPixels,
	        outsideRatio,
	        allowedOutsidePixels,
	        maxOutsideImprovement,
	        radius: frameRadius,
	        insideLimit,
	        outsideLimit,
	        color
	      };
	    };
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
    const directStats = editor.textureAirbrushLastWebGpuPaintStats || null;
    await renderOnce();
    const liveDisplayBaselineFrame = captureViewerFrame();
    const livePaint = editor.textureAirbrushRunEditableWebGpuPaint(editable, {
      material: chosen.material,
      liveDisplayExternalTexture: true,
      deferReadbackApply: true,
      radiusPixels: Math.max(4, Math.round(Math.min(width, height) * 0.015)),
      opacity: 1,
      hardness: 0.85,
      scatter: 0,
      color: { r: 0, g: 255, b: 255 },
      strokeSegments: [{
        start: { x: Math.max(0, centerX - 8), y: Math.min(height - 1, centerY + 12) },
        end: { x: Math.min(width - 1, centerX + 8), y: Math.min(height - 1, centerY + 12) }
      }],
      label: "texture-airbrush-asset-validation-live-display"
    });
    const liveUserData = chosen.material.userData || {};
    const liveExternalMap = liveUserData.textureAirbrushWebGpuExternalMap || null;
    const liveCanvasMap = liveUserData.textureAirbrushWebGpuCanvasMap || editable.texture || null;
    const liveDisplayMapInfo = {
      externalMapName: liveExternalMap?.name || "",
      externalMapFlipY: liveExternalMap?.flipY ?? null,
      externalMapColorSpace: liveExternalMap?.colorSpace ?? null,
      externalMapChannel: Number.isFinite(Number(liveExternalMap?.channel)) ? Number(liveExternalMap.channel) : null,
      externalMapMinFilter: liveExternalMap?.minFilter ?? null,
      externalMapMagFilter: liveExternalMap?.magFilter ?? null,
      externalMapGenerateMipmaps: liveExternalMap?.generateMipmaps ?? null,
      externalMapAnisotropy: Number.isFinite(Number(liveExternalMap?.anisotropy))
        ? Number(liveExternalMap.anisotropy)
        : null,
      externalMapIsActive: Boolean(liveExternalMap && chosen.material.map === liveExternalMap),
      canvasMapName: liveCanvasMap?.name || "",
      canvasMapFlipY: liveCanvasMap?.flipY ?? null,
      canvasMapColorSpace: liveCanvasMap?.colorSpace ?? null,
      canvasMapChannel: Number.isFinite(Number(liveCanvasMap?.channel)) ? Number(liveCanvasMap.channel) : null,
      canvasMapMinFilter: liveCanvasMap?.minFilter ?? null,
      canvasMapMagFilter: liveCanvasMap?.magFilter ?? null,
      canvasMapGenerateMipmaps: liveCanvasMap?.generateMipmaps ?? null,
      canvasMapAnisotropy: Number.isFinite(Number(liveCanvasMap?.anisotropy))
        ? Number(liveCanvasMap.anisotropy)
        : null
    };
    const liveDisplayExternalActive = Boolean(
      chosen.material.map
      && (
        chosen.material.map === liveExternalMap
        || chosen.material.map.isExternalTexture === true
        || chosen.material.map.userData?.textureAirbrushExternalWebGpuDisplay === true
      )
    );
    let liveDisplayRenderOk = false;
    let liveDisplayRenderError = "";
    try {
      await renderOnce();
      var liveDisplayActiveFrame = captureViewerFrame();
      liveDisplayRenderOk = true;
    } catch (error) {
      liveDisplayRenderError = error?.message || String(error);
    }
    const liveDisplayColorStability = compareViewerFrames(liveDisplayBaselineFrame, liveDisplayActiveFrame);
    const liveDispatchResult = await livePaint;
    const liveResult = liveDispatchResult?.readbackPromise
      ? await liveDispatchResult.readbackPromise
      : liveDispatchResult;
    const liveDisplayStats = editor.textureAirbrushLastWebGpuPaintStats || null;
    editor.textureAirbrushQueueWebGpuApplyRefresh?.(chosen);
    editor.flushTextureAirbrushDeferredWebGpuApplyRefresh?.();
    const liveDisplayExternalRetained = Boolean(liveExternalMap && chosen.material.map === liveExternalMap);
    const liveDisplayRestored = !liveExternalMap
      || chosen.material.map === liveCanvasMap
      || chosen.material.map !== liveExternalMap;
    const fastLiveStroke = async () => {
      const rect = editor.canvas?.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height || typeof editor.texturePaintHitForEvent !== "function") {
        return { found: false, reason: "missing-canvas-or-hit-test" };
      }
		      const makeEvent = (clientX, clientY) => ({
		        clientX,
		        clientY,
		        pointerType: "pen",
        pressure: 1,
        button: 0,
        buttons: 1,
        preventDefault() {},
        stopPropagation() {}
      });
      const rows = [0.32, 0.4, 0.48, 0.56, 0.64, 0.72];
      const columns = [0.2, 0.275, 0.35, 0.425, 0.5, 0.575, 0.65, 0.725, 0.8];
      const byRow = [];
      const confirmedPoints = [];
      const addConfirmedPoint = (point) => {
        if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
          return;
        }
        confirmedPoints.push({
          clientX: point.clientX,
          clientY: point.clientY
        });
      };
      for (const row of rows) {
        const rowHits = [];
        const clientY = (rect.top || 0) + rect.height * row;
        for (const column of columns) {
          const clientX = (rect.left || 0) + rect.width * column;
          const hit = editor.texturePaintHitForEvent(makeEvent(clientX, clientY), "airbrush");
          if (!hit?.record || !hit?.hit) {
            continue;
          }
          const material = editor.clonePaintMaterialForHit?.(hit.record, hit.hit) || null;
          if (material === chosen.material) {
            const point = { clientX, clientY };
            rowHits.push(point);
            addConfirmedPoint(point);
          }
        }
        if (rowHits.length >= 2) {
          byRow.push(rowHits);
        }
      }
      const projectVector = editor.tempVector || editor.tempWorld || null;
      editor.model?.updateMatrixWorld?.(true);
      for (const record of records) {
        const object = record?.object || null;
        const position = record?.geometry?.attributes?.position || object?.geometry?.attributes?.position || null;
        if (!object || !position || typeof projectVector?.fromBufferAttribute !== "function") {
          continue;
        }
        object.updateMatrixWorld?.(true);
        const step = Math.max(1, Math.floor((position.count || 0) / 320));
        for (let index = 0; index < position.count; index += step) {
          projectVector.fromBufferAttribute(position, index);
          object.localToWorld(projectVector);
          projectVector.project(editor.camera);
          if (
            !Number.isFinite(projectVector.x)
            || !Number.isFinite(projectVector.y)
            || projectVector.z < -1
            || projectVector.z > 1
            || Math.abs(projectVector.x) > 1
            || Math.abs(projectVector.y) > 1
          ) {
            continue;
          }
          const clientX = (rect.left || 0) + (projectVector.x * 0.5 + 0.5) * rect.width;
          const clientY = (rect.top || 0) + (-projectVector.y * 0.5 + 0.5) * rect.height;
          const hit = editor.texturePaintHitForEvent(makeEvent(clientX, clientY), "airbrush");
          if (!hit?.record || !hit?.hit) {
            continue;
          }
          const material = editor.clonePaintMaterialForHit?.(hit.record, hit.hit) || null;
          if (material === chosen.material) {
            addConfirmedPoint({ clientX, clientY });
          }
        }
      }
      const choosePair = (points, maxVerticalDelta = Infinity) => {
        let best = null;
        for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
            const first = points[leftIndex];
            const last = points[rightIndex];
            const verticalDelta = Math.abs(last.clientY - first.clientY);
            if (verticalDelta > maxVerticalDelta) {
              continue;
            }
            const distance = Math.hypot(last.clientX - first.clientX, last.clientY - first.clientY);
            if (!best || distance > best.distance) {
              best = { first, last, distance };
            }
          }
        }
        return best;
      };
      let pair = null;
      for (const rowHits of byRow) {
        const rowPair = choosePair(rowHits, rect.height * 0.04);
        if (rowPair && (!pair || rowPair.distance > pair.distance)) {
          pair = rowPair;
        }
      }
      pair = pair || choosePair(confirmedPoints, rect.height * 0.12) || choosePair(confirmedPoints);
      if (pair?.first?.clientX > pair?.last?.clientX) {
        pair = {
          first: pair.last,
          last: pair.first,
          distance: pair.distance
        };
      }
      if (!pair || pair.distance < 40) {
        return {
          found: false,
          reason: "missing-long-visible-row",
          rowCount: byRow.length,
          confirmedPointCount: confirmedPoints.length,
          bestDistance: pair?.distance || 0
        };
      }
      const strokeSegments = [{
        start: { clientX: pair.first.clientX, clientY: pair.first.clientY },
        end: { clientX: pair.last.clientX, clientY: pair.last.clientY }
      }];
      const strokePrewarm = editor.textureAirbrushPrewarmWebGpuEditable?.(editable, chosen.material, {
        refreshSource: true,
        radiusPixels: 10,
        opacity: 1,
        hardness: 0.8,
        scatter: 0,
        color: { r: 255, g: 255, b: 0 },
        label: "texture-airbrush-asset-validation-fast-live-stroke-prewarm"
      });
      editor.beginTexturePaintStrokeUndo?.("WebGPU validation fast stroke");
      const estimate = editor.textureAirbrushWebGpuPaintFromEvent(makeEvent(pair.last.clientX, pair.last.clientY), {
        visibleSurfaceMaskRequired: true,
        liveProjectedPaint: true,
        requireVisibilityMask: true,
        radiusPixels: 10,
        opacity: 1,
        hardness: 0.8,
        scatter: 0,
        color: { r: 255, g: 255, b: 0 },
        strokeStart: { clientX: pair.first.clientX, clientY: pair.first.clientY },
        strokeSegments,
        visibilityMaskThreshold: 0.5,
        visibilityFeatherRadius: 0,
        label: "texture-airbrush-asset-validation-fast-live-stroke"
      });
	      const strokeUndoBeforeFlush = Array.isArray(editor.texturePaintStrokeUndo?.before)
	        ? [...editor.texturePaintStrokeUndo.before]
	        : [];
	      const undoCapturedBeforeFlush = strokeUndoBeforeFlush.length > 0;
	      const prewarmSourceReused = Boolean(
	        strokePrewarm?.sourceImageData
	        && strokeUndoBeforeFlush.some((entry) => (
	          entry?.beforeSourceImageData === strokePrewarm.sourceImageData
	          || entry?.before === strokePrewarm.sourceImageData
	        ))
	      );
      const queued = [...(editor.textureAirbrushQueuedWebGpuStrokes || [])];
      const visibilitySegmentCount = queued
        .flatMap((candidate) => candidate?.options?.visibilityMaskSamples || [])
        .filter((sample) => sample?.segment).length;
      const visibilityTriangleCount = queued
        .flatMap((candidate) => candidate?.options?.visibilityMaskTriangles || [])
        .length;
      const visibilityMaskBytes = queued.reduce((total, candidate) => (
        total + candidateVisibilityMaskBytes(candidate)
      ), 0);
      const visibilityBleedRadii = queued
        .map((candidate) => Number(candidate?.options?.visibilityBleedRadius))
        .filter((value) => Number.isFinite(value));
	      const queuedSegmentCount = queued.reduce((total, candidate) => (
	        total + (candidate?.strokeSegments?.length || 0)
	      ), 0);
	      await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({ force: true });
	      const strokeUndoAfterFlush = Array.isArray(editor.texturePaintStrokeUndo?.before)
	        ? [...editor.texturePaintStrokeUndo.before]
	        : [];
	      const undoCaptured = strokeUndoAfterFlush.length > 0;
	      const liveStats = editor.textureAirbrushLastWebGpuPaintStats || null;
	      const fastUserData = chosen.material.userData || {};
	      const fastExternalMap = fastUserData.textureAirbrushWebGpuExternalMap || null;
	      const externalActiveAfterFlush = Boolean(
	        fastExternalMap
	        && chosen.material.map === fastExternalMap
	      );
	      await editor.flushTextureAirbrushPendingWebGpuPaints?.();
	      const syncStats = editor.textureAirbrushLastWebGpuPaintStats || null;
	      editor.texturePaintStrokeUndo = null;
	      return {
	        found: true,
	        estimate,
	        distance: pair.distance,
	        pair: {
	          first: { clientX: pair.first.clientX, clientY: pair.first.clientY },
	          last: { clientX: pair.last.clientX, clientY: pair.last.clientY }
		        },
		        undoCaptured,
		        undoCapturedBeforeFlush,
	        prewarmSourceReused,
	        prewarmStats: strokePrewarm?.stats || null,
	        queuedSegmentCount,
        visibilitySegmentCount,
        visibilityTriangleCount,
        visibilityMaskBytes,
	        minVisibilityBleedRadius: visibilityBleedRadii.length
	          ? Math.min(...visibilityBleedRadii)
	          : 0,
	        externalActiveAfterFlush,
		        liveStats,
		        stats: syncStats
		      };
		    };
	    const liveStrokeStress = async (pair = null) => {
	      if (!pair?.first || !pair?.last) {
	        return { found: false, reason: "missing-fast-live-pair" };
	      }
	      const makeEvent = (clientX, clientY) => ({
	        clientX,
	        clientY,
	        pointerType: "pen",
	        pressure: 1,
	        button: 0,
	        buttons: 1,
	        preventDefault() {},
	        stopPropagation() {}
	      });
	      const eventCount = 8;
	      const points = [];
	      for (let index = 0; index <= eventCount; index += 1) {
	        const ratio = index / eventCount;
	        points.push({
	          clientX: pair.first.clientX + (pair.last.clientX - pair.first.clientX) * ratio,
	          clientY: pair.first.clientY + (pair.last.clientY - pair.first.clientY) * ratio
	        });
	      }
	      const now = () => (
	        typeof performance !== "undefined" && typeof performance.now === "function"
	          ? performance.now()
	          : Date.now()
	      );
		      const statsBefore = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
		        ? editor.textureAirbrushWebGpuPaintStats.length
		        : 0;
		      const estimates = [];
		      const originalPainting = editor.painting;
		      const originalRunEditableWebGpuPaint = editor.textureAirbrushRunEditableWebGpuPaint;
		      const directPaintStats = [];
		      const directPaintSettled = [];
		      if (typeof originalRunEditableWebGpuPaint === "function") {
		        editor.textureAirbrushRunEditableWebGpuPaint = function wrappedLiveStressRunEditableWebGpuPaint(...args) {
		          const result = originalRunEditableWebGpuPaint.apply(this, args);
		          const settled = Promise.resolve(result)
		            .then((resolved) => {
		              if (resolved?.stats) {
		                directPaintStats.push(resolved.stats);
		              }
		              return resolved;
		            })
		            .catch(() => null);
		          directPaintSettled.push(settled);
		          return result;
		        };
		      }
		      editor.painting = true;
	      const startedAt = now();
	      editor.beginTexturePaintStrokeUndo?.("WebGPU validation live stroke stress");
	      let firstFlush = null;
	      for (let index = 1; index < points.length; index += 1) {
	        const start = points[index - 1];
	        const end = points[index];
	        const estimate = editor.textureAirbrushWebGpuPaintFromEvent(makeEvent(end.clientX, end.clientY), {
	          visibleSurfaceMaskRequired: true,
	          liveProjectedPaint: true,
	          requireVisibilityMask: true,
	          radiusPixels: 10,
	          opacity: 1,
	          hardness: 0.8,
	          scatter: 0,
	          color: { r: 0, g: 255, b: 0 },
	          strokeStart: { clientX: start.clientX, clientY: start.clientY },
	          strokeSegments: [{
	            start: { clientX: start.clientX, clientY: start.clientY },
	            end: { clientX: end.clientX, clientY: end.clientY }
	          }],
	          visibilityMaskThreshold: 0.5,
	          visibilityFeatherRadius: 0,
	          label: \`texture-airbrush-asset-validation-live-stress-\${index}\`
	        });
	        estimates.push(estimate);
	        if (index === 1) {
	          firstFlush = editor.flushTextureAirbrushQueuedWebGpuStrokes?.();
	        }
	      }
	      const queuedWhileFirstFlush = (editor.textureAirbrushQueuedWebGpuStrokes || []).reduce((total, candidate) => (
	        total + (candidate?.strokeSegments?.length || 0)
	      ), 0);
	      if (firstFlush && typeof firstFlush.then === "function") {
	        await firstFlush.catch(() => null);
		      }
		      await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({ force: true });
		      await editor.flushTextureAirbrushPendingWebGpuPaints?.();
		      if (directPaintSettled.length) {
		        await Promise.allSettled(directPaintSettled);
		      }
		      const durationMs = now() - startedAt;
			      const rollingStats = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
			        ? editor.textureAirbrushWebGpuPaintStats.slice(statsBefore)
			        : [];
			      const allStats = directPaintStats.length
			        ? [
			            ...directPaintStats,
			            ...rollingStats.filter((stat) => stat?.deferredCanvasSync === true)
			          ]
			        : rollingStats;
			      const stats = allStats.filter((stat) => stat?.deferredCanvasSync !== true);
		      const syncStats = allStats.filter((stat) => stat?.deferredCanvasSync === true);
		      const dirtyAreas = stats.map((stat) => (
		        Math.max(0, Number(stat?.dirtyBounds?.width) || 0)
		        * Math.max(0, Number(stat?.dirtyBounds?.height) || 0)
		      ));
		      editor.painting = originalPainting;
		      if (typeof originalRunEditableWebGpuPaint === "function") {
		        editor.textureAirbrushRunEditableWebGpuPaint = originalRunEditableWebGpuPaint;
		      }
		      editor.texturePaintStrokeUndo = null;
	      return {
	        found: true,
	        eventCount,
	        positiveEstimateCount: estimates.filter((estimate) => Number(estimate) > 0).length,
	        totalEstimate: estimates.reduce((total, estimate) => total + Math.max(0, Number(estimate) || 0), 0),
	        queuedWhileFirstFlush,
	        queuedAfterDrain: (editor.textureAirbrushQueuedWebGpuStrokes || []).length,
	        pendingAfterDrain: (editor.textureAirbrushPendingWebGpuPaints || new Set()).size || 0,
	        durationMs,
			        dispatchCount: stats.length,
			        directPaintStatsCount: directPaintStats.length,
		        maxReadbackBytes: Math.max(0, ...allStats.map((stat) => Number(stat?.readbackBytes) || 0)),
		        totalReadbackBytes: allStats.reduce((total, stat) => total + Math.max(0, Number(stat?.readbackBytes) || 0), 0),
		        maxDirtyArea: Math.max(0, ...dirtyAreas),
		        maxDispatchTotalMs: Math.max(0, ...stats.map((stat) => Number(stat?.timings?.totalMs) || 0)),
		        stats,
		        syncStats,
		        allStats
		      };
		    };
	    const screenStrokeStress = async (pair = null) => {
	      if (!pair?.first || !pair?.last) {
	        return { found: false, reason: "missing-fast-live-pair" };
	      }
	      if (
	        typeof editor.textureAirbrushQueueScreenStroke !== "function"
	        || typeof editor.flushTextureAirbrushScreenStroke !== "function"
	        || typeof editor.textureAirbrushWebGpuPaintFromEvent !== "function"
	      ) {
	        return { found: false, reason: "missing-screen-stroke-methods" };
	      }
	      const makeEvent = (clientX, clientY) => ({
	        clientX,
	        clientY,
	        pointerType: "pen",
	        pressure: 1,
	        button: 0,
	        buttons: 1,
		        preventDefault() {},
		        stopPropagation() {}
		      });
		      const localSurfacePair = (() => {
		        const rect = editor.canvas?.getBoundingClientRect?.();
		        if (!rect?.width || !rect?.height || typeof editor.texturePaintHitForEvent !== "function") {
		          return null;
		        }
		        const sameMaterialHit = (point = null) => {
		          const hit = editor.texturePaintHitForEvent(
		            makeEvent(point.clientX, point.clientY),
		            "airbrush"
		          );
		          if (!hit?.record || !hit?.hit) {
		            return false;
		          }
		          return editor.clonePaintMaterialForHit?.(hit.record, hit.hit) === chosen.material;
		        };
		        const centers = [];
		        for (const row of [0.42, 0.48, 0.54, 0.6, 0.66]) {
		          for (const column of [0.42, 0.48, 0.54, 0.6]) {
		            centers.push({
		              clientX: (rect.left || 0) + rect.width * column,
		              clientY: (rect.top || 0) + rect.height * row
		            });
		          }
		        }
		        for (const center of centers) {
		          if (!sameMaterialHit(center)) {
		            continue;
		          }
		          for (const halfLength of [36, 30, 24, 18]) {
		            const first = {
		              clientX: Math.max((rect.left || 0) + 4, center.clientX - halfLength),
		              clientY: center.clientY
		            };
		            const last = {
		              clientX: Math.min((rect.right || 0) - 4, center.clientX + halfLength),
		              clientY: center.clientY
		            };
		            if (sameMaterialHit(first) && sameMaterialHit(last)) {
		              return {
		                first,
		                last,
		                distance: Math.hypot(last.clientX - first.clientX, last.clientY - first.clientY),
		                source: "local-visible-surface"
		              };
		            }
		          }
		        }
		        return null;
		      })();
		      const stressPair = localSurfacePair || pair;
		      const now = () => (
		        typeof performance !== "undefined" && typeof performance.now === "function"
		          ? performance.now()
		          : Date.now()
		      );
		      const eventCount = 8;
		      const points = [];
		      for (let index = 0; index <= eventCount; index += 1) {
		        const ratio = index / eventCount;
		        points.push({
		          clientX: stressPair.first.clientX + (stressPair.last.clientX - stressPair.first.clientX) * ratio,
		          clientY: stressPair.first.clientY + (stressPair.last.clientY - stressPair.first.clientY) * ratio
		        });
		      }
	      const originalActiveTool = editor.activeTool;
	      const originalGpuDisabled = editor.textureAirbrushGpuDisabled;
	      const originalSchedule = editor.scheduleTextureAirbrushScreenStrokeFlush;
	      const originalWebGpuPaintFromEvent = editor.textureAirbrushWebGpuPaintFromEvent;
	      const originalTexturePaintColor = editor.texturePaintColor?.value;
	      const originalPainting = editor.painting;
		      const paintColor = { r: 255, g: 255, b: 0 };
	      const profile = {};
	      const candidateSummaries = [];
	      const undoCaptureSummaries = [];
	      const directPaintStats = [];
	      const directPaintSettled = [];
	      const wrappedMethods = [];
	      const wrapProfile = (name) => {
	        const original = editor[name];
	        if (typeof original !== "function") {
	          return;
	        }
	        wrappedMethods.push([name, original]);
	        profile[name] = {
	          calls: 0,
	          totalMs: 0,
	          maxMs: 0
	        };
	        editor[name] = function wrappedValidationProfiledMethod(...args) {
	          const started = now();
	          try {
	            if (name === "textureAirbrushQueueWebGpuStrokeCandidate") {
	              const candidate = args[0] || null;
	              const candidateOptions = candidate?.options || {};
	              const strokeSegments = Array.isArray(candidate?.strokeSegments)
	                ? candidate.strokeSegments
	                : [];
	              const visibilityTriangles = Array.isArray(candidateOptions.visibilityMaskTriangles)
	                ? candidateOptions.visibilityMaskTriangles
	                : [];
	              const visibilitySamples = Array.isArray(candidateOptions.visibilityMaskSamples)
	                ? candidateOptions.visibilityMaskSamples
	                : [];
	              const bounds = candidate?.paintBounds || null;
	              const paintRegions = Array.isArray(candidate?.paintRegions)
	                ? candidate.paintRegions
	                : [];
		              candidateSummaries.push({
		                strokeSegmentCount: strokeSegments.length,
		                candidateTimingMs: candidateOptions.candidateTimingMs || null,
		                candidateDebugCounts: candidateOptions.candidateDebugCounts || null,
		                maxMergedVisibilityTriangles: Number(candidateOptions.maxMergedVisibilityTriangles) || null,
		                maxVisibilityTriangles: Number(candidateOptions.maxVisibilityTriangles) || null,
		                largeLiveBrushPaint: candidateOptions.largeLiveBrushPaint === true,
		                largeLiveNeighborPaint: candidateOptions.largeLiveNeighborPaint === true,
		                neighborPaintSeed: candidateOptions.neighborPaintSeed?.enabled === true,
		                paintRegionCount: paintRegions.length,
	                paintRegions: paintRegions.slice(0, 24).map((region) => ({
	                  x: Number(region?.x) || 0,
	                  y: Number(region?.y) || 0,
	                  width: Number(region?.width) || 0,
	                  height: Number(region?.height) || 0
	                })),
	                visibilityTriangleCount: visibilityTriangles.length,
	                visibilitySampleCount: visibilitySamples.length,
	                visibilityMaskBytes: candidateVisibilityMaskBytes(candidate),
	                visibilityBleedRadius: Number(candidateOptions.visibilityBleedRadius) || 0,
	                cachedStrokeSamplesOnly: candidateOptions.cachedStrokeSamplesOnly === true,
	                radiusPixels: Number(candidate?.radiusPixels || candidateOptions.radiusPixels) || 0,
	                paintBounds: bounds
	                  ? {
	                      x: Number(bounds.x) || 0,
	                      y: Number(bounds.y) || 0,
	                      width: Number(bounds.width) || 0,
	                      height: Number(bounds.height) || 0
	                    }
	                  : null
	                });
	            }
	            if (name === "captureTexturePaintCanvasUndoTarget") {
	              const options = args[4] || {};
	              const beforeImageData = options.beforeImageData || null;
	              const bounds = options.bounds || null;
	              undoCaptureSummaries.push({
	                hasBeforeImageData: Boolean(beforeImageData?.data),
	                beforeWidth: Number(beforeImageData?.width) || 0,
	                beforeHeight: Number(beforeImageData?.height) || 0,
	                bounds: bounds
	                  ? {
	                      x: Number(bounds.x) || 0,
	                      y: Number(bounds.y) || 0,
	                      width: Number(bounds.width) || 0,
	                      height: Number(bounds.height) || 0
	                    }
	                  : null
	              });
	            }
		            const result = original.apply(this, args);
		            if (name === "textureAirbrushRunEditableWebGpuPaint") {
		              const settled = Promise.resolve(result)
		                .then((resolved) => {
		                  if (resolved?.stats) {
		                    directPaintStats.push(resolved.stats);
		                  }
		                  return resolved;
		                })
		                .catch(() => null);
		              directPaintSettled.push(settled);
		            }
		            return result;
	          } finally {
	            const elapsed = now() - started;
	            const entry = profile[name];
	            entry.calls += 1;
	            entry.totalMs += elapsed;
	            entry.maxMs = Math.max(entry.maxMs, elapsed);
	          }
	        };
	      };
	      let scheduledFlushes = 0;
	      let webGpuPaintCalls = 0;
	      try {
	        editor.activeTool = "airbrush";
	        editor.textureAirbrushGpuDisabled = false;
	        editor.textureAirbrushResetStrokeBrushState?.();
	        editor.textureAirbrushResetStrokePressureState?.();
	        editor.textureAirbrushScreenStrokeQueue = [];
	        editor.textureAirbrushPendingScreenStrokeBatches = [];
	        editor.textureAirbrushScreenFlushScheduled = false;
	        editor.textureAirbrushWebGpuScreenPreviewActive = false;
	        editor.painting = true;
	        if (editor.texturePaintColor) {
		          editor.texturePaintColor.value = "#ffff00";
	          editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
	          editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
	        }
	        editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
	          scheduledFlushes += 1;
	          return true;
	        };
	        editor.textureAirbrushWebGpuPaintFromEvent = function wrappedValidationWebGpuPaintFromEvent(...args) {
	          webGpuPaintCalls += 1;
	          return originalWebGpuPaintFromEvent.apply(this, args);
	        };
	        [
	          "textureAirbrushQueueScreenStroke",
	          "textureAirbrushScreenStrokePayload",
	          "textureAirbrushQueueScreenStrokePayload",
	          "textureAirbrushApplyResetFootprintContinuation",
	          "textureAirbrushApplyWarmLayerStartContinuation",
	          "textureAirbrushRecordResetFootprintContinuation",
	          "textureAirbrushRecordWarmLayerStartContinuation",
	          "textureAirbrushCoalesceQueuedScreenStrokePayload",
	          "drawTextureAirbrushScreenStrokePreview",
	          "scheduleTextureAirbrushScreenStrokeFlush",
	          "scheduleTextureAirbrushImmediateWebGpuScreenFlush",
	          "textureAirbrushScreenStrokeBatches",
	          "textureAirbrushProjectedMeshFromEvent",
	          "textureAirbrushWebGpuPaintFromEvent",
	          "textureAirbrushWebGpuCandidatesFromEvent",
	          "textureAirbrushWebGpuStrokeCandidateFromHit",
	          "textureAirbrushPrewarmScreenHitIndex",
		          "textureAirbrushBuildScreenHitIndex",
		          "textureAirbrushScreenTrianglesNearSegments",
		          "textureAirbrushScreenHitsForEvent",
	          "texturePaintHitForEvent",
	          "refreshSkinnedRaycastBounds",
	          "textureAirbrushQueueWebGpuStrokeCandidate",
	          "textureAirbrushRunEditableWebGpuPaint",
	          "captureTexturePaintCanvasUndoTarget",
	          "texturePaintCanvasStrokeSourceImage",
	          "flushTextureAirbrushDeferredWebGpuApplyRefresh"
	        ].forEach(wrapProfile);
	        const statsBefore = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
	          ? editor.textureAirbrushWebGpuPaintStats.length
	          : 0;
	        let queueAccepted = 0;
	        editor.beginTexturePaintStrokeUndo?.("WebGPU validation screen stroke stress");
	        await renderOnce();
	        const screenStrokeBaselineFrame = captureViewerFrame();
	        const screenStrokeBaselineFramePng = captureViewerFramePng();
	        const viewerSource = editor.canvas || editor.renderer?.domElement || document.getElementById("viewer-canvas");
	        const viewerRect = viewerSource?.getBoundingClientRect?.();
	        const strokeFrameBounds = (() => {
	          if (!screenStrokeBaselineFrame?.ok || !viewerRect?.width || !viewerRect?.height) {
	            return null;
	          }
	          const scaleX = screenStrokeBaselineFrame.width / viewerRect.width;
	          const scaleY = screenStrokeBaselineFrame.height / viewerRect.height;
	          const padding = 64;
	          const minClientX = Math.min(...points.map((point) => Number(point.clientX) || 0));
	          const maxClientX = Math.max(...points.map((point) => Number(point.clientX) || 0));
	          const minClientY = Math.min(...points.map((point) => Number(point.clientY) || 0));
	          const maxClientY = Math.max(...points.map((point) => Number(point.clientY) || 0));
	          const left = Math.max(0, Math.floor((minClientX - viewerRect.left) * scaleX - padding));
	          const top = Math.max(0, Math.floor((minClientY - viewerRect.top) * scaleY - padding));
	          const right = Math.min(screenStrokeBaselineFrame.width, Math.ceil((maxClientX - viewerRect.left) * scaleX + padding));
	          const bottom = Math.min(screenStrokeBaselineFrame.height, Math.ceil((maxClientY - viewerRect.top) * scaleY + padding));
	          return {
	            x: left,
	            y: top,
	            width: Math.max(0, right - left),
	            height: Math.max(0, bottom - top)
	          };
	        })();
	        const startedAt = now();
		        for (let index = 1; index < points.length; index += 1) {
		          const start = points[index - 1];
		          const end = points[index];
		          if (editor.textureAirbrushQueueScreenStroke(makeEvent(end.clientX, end.clientY), {
		            strokeStart: { clientX: start.clientX, clientY: start.clientY },
		            strokeReset: index === 1
		          }) === true) {
		            queueAccepted += 1;
		          }
	        }
	        const queuedAt = now();
	        const screenQueueBeforeFlush = (editor.textureAirbrushScreenStrokeQueue || []).length;
	        const pendingScreenBeforeFlush = (editor.textureAirbrushPendingScreenStrokeBatches || []).length;
	        let changed = 0;
	        let flushCalls = 0;
	        let firstFlushReturnMs = 0;
	        let maxFlushReturnMs = 0;
	        while (
	          flushCalls < 32
	          && (
	            flushCalls === 0
	            || (editor.textureAirbrushScreenStrokeQueue || []).length
	            || (editor.textureAirbrushPendingScreenStrokeBatches || []).length
	          )
	        ) {
	          const flushStartedAt = now();
	          changed += editor.flushTextureAirbrushScreenStroke({
	            live: true,
	            captureCandidateTimings: true
	          }) || 0;
	          const flushReturnMs = now() - flushStartedAt;
	          if (flushCalls === 0) {
	            firstFlushReturnMs = flushReturnMs;
	          }
	          maxFlushReturnMs = Math.max(maxFlushReturnMs, flushReturnMs);
	          flushCalls += 1;
	        }
	        await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({
	          liveDisplayExternalTexture: true,
	          deferReadbackCopy: true
	        });
	        if ((editor.textureAirbrushQueuedWebGpuStrokes || []).length) {
	          await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({ force: true });
	        }
	        await editor.flushTextureAirbrushPendingWebGpuPaints?.();
	        if (directPaintSettled.length) {
	          await Promise.allSettled(directPaintSettled);
	        }
	        await renderOnce();
	        const screenStrokeActiveFrame = captureViewerFrame();
	        const screenStrokeActiveFramePng = captureViewerFramePng();
	        const screenStrokeVisualChange = compareViewerFrameChange(
	          screenStrokeBaselineFrame,
	          screenStrokeActiveFrame
	        );
	        const screenStrokeVisualPaintColorChange = compareViewerPaintColorChange(
	          screenStrokeBaselineFrame,
	          screenStrokeActiveFrame,
	          paintColor,
	          strokeFrameBounds
	        );
	        const durationMs = now() - startedAt;
		        const rollingStats = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
		          ? editor.textureAirbrushWebGpuPaintStats.slice(statsBefore)
		          : [];
		        const allStats = directPaintStats.length
		          ? [
		              ...directPaintStats,
		              ...rollingStats.filter((stat) => stat?.deferredCanvasSync === true)
		            ]
		          : rollingStats;
		        const stats = allStats.filter((stat) => stat?.deferredCanvasSync !== true);
		        const syncStats = allStats.filter((stat) => stat?.deferredCanvasSync === true);
		        const dirtyBounds = stats
		          .map((stat) => stat?.dirtyBounds || null)
		          .filter(Boolean);
	        const dirtyAreas = dirtyBounds.map((bounds) => (
	          Math.max(0, Number(bounds?.width) || 0)
	          * Math.max(0, Number(bounds?.height) || 0)
	        ));
	        const liveDisplayWorkPixels = stats.map((stat) => Number(stat?.liveDisplayWorkPixels) || 0);
	        const liveDisplayMipmapPixels = stats.map((stat) => Number(stat?.liveDisplayMipmapPixels) || 0);
	        const texturePixelCount = Math.max(1, width * height);
	        const visibilityBleedRadii = candidateSummaries
	          .map((candidate) => Number(candidate?.visibilityBleedRadius))
	          .filter((value) => Number.isFinite(value) && value > 0);
	        const materialUserData = chosen.material?.userData || {};
	        const materialMap = chosen.material?.map || null;
	        const originalMap = materialUserData.clonePaintOriginalMap || null;
	        const cloneTexture = materialUserData.clonePaintTexture || null;
	        const originalImageType = originalMap?.image?.constructor?.name || "";
	        const expectedCanvasFlipY = originalImageType === "ImageBitmap"
	          ? false
	          : originalMap
	            ? originalMap.flipY ?? false
	            : null;
	        const mapInfoAfterDrain = {
	          mapName: materialMap?.name || "",
	          mapChannel: Number.isFinite(Number(materialMap?.channel)) ? Number(materialMap.channel) : null,
	          mapFlipY: materialMap?.flipY ?? null,
	          mapImageType: materialMap?.image?.constructor?.name || "",
	          mapMinFilter: materialMap?.minFilter ?? null,
	          originalMapName: originalMap?.name || "",
	          originalMapChannel: Number.isFinite(Number(originalMap?.channel))
	            ? Number(originalMap.channel)
	            : null,
	          originalMapFlipY: originalMap?.flipY ?? null,
	          originalMapImageType: originalImageType,
	          expectedCanvasFlipY,
	          cloneTextureMatchesMap: Boolean(cloneTexture && cloneTexture === materialMap),
	          cloneTextureChannel: Number.isFinite(Number(cloneTexture?.channel))
	            ? Number(cloneTexture.channel)
	            : null,
	          cloneTextureFlipY: cloneTexture?.flipY ?? null,
	          cloneTextureImageType: cloneTexture?.image?.constructor?.name || "",
	          externalMapStillActive: Boolean(
	            materialUserData.textureAirbrushWebGpuExternalMap
	            && materialMap === materialUserData.textureAirbrushWebGpuExternalMap
	          ),
	          canvasMapChannel: Number.isFinite(Number(materialUserData.textureAirbrushWebGpuCanvasMap?.channel))
	            ? Number(materialUserData.textureAirbrushWebGpuCanvasMap.channel)
	            : null
	        };
	        return {
		          found: true,
		          pair: {
		            first: { clientX: stressPair.first.clientX, clientY: stressPair.first.clientY },
		            last: { clientX: stressPair.last.clientX, clientY: stressPair.last.clientY },
		            source: stressPair.source || "fast-live-pair"
		          },
		          eventCount,
	          queueAccepted,
	          scheduledFlushes,
	          screenQueueBeforeFlush,
	          pendingScreenBeforeFlush,
	          changed,
	          webGpuPaintCalls,
	          queueMs: queuedAt - startedAt,
	          flushCalls,
	          flushReturnMs: firstFlushReturnMs,
	          maxFlushReturnMs,
	          screenQueueAfterDrain: (editor.textureAirbrushScreenStrokeQueue || []).length,
	          pendingScreenAfterDrain: (editor.textureAirbrushPendingScreenStrokeBatches || []).length,
	          queuedAfterDrain: (editor.textureAirbrushQueuedWebGpuStrokes || []).length,
	          pendingAfterDrain: (editor.textureAirbrushPendingWebGpuPaints || new Set()).size || 0,
	          screenPreviewActiveAfterDrain: editor.textureAirbrushWebGpuScreenPreviewActive === true,
	          durationMs,
	          dispatchCount: stats.length,
	          candidateCount: candidateSummaries.length,
	          maxCandidateStrokeSegments: Math.max(0, ...candidateSummaries.map((candidate) => (
	            Number(candidate?.strokeSegmentCount) || 0
	          ))),
	          totalCandidateStrokeSegments: candidateSummaries.reduce((total, candidate) => (
	            total + Math.max(0, Number(candidate?.strokeSegmentCount) || 0)
	          ), 0),
	          undoCaptureCount: undoCaptureSummaries.length,
	          undoCaptureCachedSourceCount: undoCaptureSummaries.filter((summary) => summary.hasBeforeImageData).length,
	          undoCaptureSummaries,
	          minVisibilityBleedRadius: visibilityBleedRadii.length
	            ? Math.min(...visibilityBleedRadii)
	            : 0,
	          maxDirtyWidth: Math.max(0, ...dirtyBounds.map((bounds) => Number(bounds?.width) || 0)),
	          maxDirtyHeight: Math.max(0, ...dirtyBounds.map((bounds) => Number(bounds?.height) || 0)),
	          maxDirtyArea: Math.max(0, ...dirtyAreas),
		          maxReadbackBytes: Math.max(0, ...allStats.map((stat) => Number(stat?.readbackBytes) || 0)),
		          maxDispatchTotalMs: Math.max(0, ...stats.map((stat) => Number(stat?.timings?.totalMs) || 0)),
	          liveDisplayFullUpdateCount: stats.filter((stat) => stat?.liveDisplayFullUpdate === true).length,
	          liveDisplayDirtyUpdateCount: stats.filter((stat) => stat?.liveDisplayFullUpdate === false).length,
	          liveDisplayDirtyMipmapCount: stats.filter((stat) => stat?.liveDisplayMipmapDirty === true).length,
	          maxLiveDisplayWorkPixels: Math.max(0, ...liveDisplayWorkPixels),
	          maxLiveDisplayMipmapPixels: Math.max(0, ...liveDisplayMipmapPixels),
	          maxLiveDisplayWorkRatio: Math.max(0, ...liveDisplayWorkPixels) / texturePixelCount,
	          maxLiveDisplayMipmapRatio: Math.max(0, ...liveDisplayMipmapPixels) / texturePixelCount,
	          visualBaselineFrame: summarizeViewerFrame(screenStrokeBaselineFrame),
	          visualActiveFrame: summarizeViewerFrame(screenStrokeActiveFrame),
	          visualChange: screenStrokeVisualChange,
	          visualPaintColorChange: screenStrokeVisualPaintColorChange,
	          debugFrames: {
	            baseline: screenStrokeBaselineFramePng,
	            active: screenStrokeActiveFramePng
	          },
	          mapInfoAfterDrain,
		          profile,
		          candidateSummaries,
		          stats,
		          syncStats,
		          allStats
		        };
	      } finally {
	        for (const [name, original] of wrappedMethods.reverse()) {
	          editor[name] = original;
	        }
	        if (originalActiveTool === undefined) {
	          delete editor.activeTool;
	        } else {
	          editor.activeTool = originalActiveTool;
	        }
	        editor.textureAirbrushGpuDisabled = originalGpuDisabled;
	        editor.scheduleTextureAirbrushScreenStrokeFlush = originalSchedule;
	        editor.textureAirbrushWebGpuPaintFromEvent = originalWebGpuPaintFromEvent;
	        editor.painting = originalPainting;
	        if (editor.texturePaintColor && originalTexturePaintColor !== undefined) {
	          editor.texturePaintColor.value = originalTexturePaintColor;
	          editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
	          editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
	        }
	        editor.texturePaintStrokeUndo = null;
	      }
	    };
	    const visiblePointerStroke = async (settings = {}) => {
	      const useCurrentBrushSettings = settings?.useCurrentBrushSettings === true;
	      const modelLoadedAtStart = Boolean(editor.model);
	      const rect = editor.canvas?.getBoundingClientRect?.();
	      if (
	        !rect?.width
	        || !rect?.height
	        || typeof editor.onPointerDown !== "function"
	        || typeof editor.onPointerMove !== "function"
	        || typeof editor.onPointerUp !== "function"
	        || typeof editor.texturePaintHitForEvent !== "function"
	      ) {
	        return { found: false, reason: "missing-pointer-paint-methods", modelLoadedAtStart };
	      }
	      if (!modelLoadedAtStart) {
	        return { found: false, reason: "model-missing", modelLoadedAtStart };
	      }
	      const makeEvent = (clientX, clientY, buttons = 1) => ({
	        clientX,
	        clientY,
	        button: 0,
	        buttons,
	        pointerId: 917,
	        pointerType: "mouse",
	        pressure: buttons ? 0.75 : 0,
	        altKey: false,
	        ctrlKey: false,
	        metaKey: false,
	        shiftKey: false,
	        preventDefault() {},
	        stopPropagation() {},
	        stopImmediatePropagation() {}
	      });
	      const dispatchPointer = (type, target, point, buttons = 1) => {
	        if (!target?.dispatchEvent) {
	          return {
	            dispatched: false,
	            defaultPrevented: false
	          };
	        }
	        const eventInit = {
	          bubbles: true,
	          cancelable: true,
	          composed: true,
	          clientX: point.clientX,
	          clientY: point.clientY,
	          screenX: point.clientX,
	          screenY: point.clientY,
	          button: type === "pointerup" ? 0 : 0,
	          buttons,
	          pointerId: 917,
	          pointerType: "mouse",
	          isPrimary: true,
	          pressure: buttons ? 0.75 : 0,
	          altKey: false,
	          ctrlKey: false,
	          metaKey: false,
	          shiftKey: false,
	          view: window
	        };
	        const event = typeof PointerEvent === "function"
	          ? new PointerEvent(type, eventInit)
	          : new MouseEvent(type.replace(/^pointer/, "mouse"), eventInit);
	        try {
	          target.dispatchEvent(event);
	          return {
	            dispatched: true,
	            defaultPrevented: event.defaultPrevented === true
	          };
	        } catch (error) {
	          return {
	            dispatched: false,
	            defaultPrevented: false,
	            error: error?.message || String(error)
	          };
	        }
	      };
	      const sameMaterialHit = (point = null) => {
	        const hit = editor.texturePaintHitForEvent(makeEvent(point.clientX, point.clientY), "airbrush");
	        if (!hit?.record || !hit?.hit) {
	          return false;
	        }
	        const material = editor.clonePaintMaterialForHit?.(hit.record, hit.hit) || null;
	        return material === chosen.material;
	      };
	      let stroke = null;
		      for (const row of [0.44, 0.5, 0.56, 0.62]) {
		        for (const column of [0.44, 0.5, 0.56]) {
		          const center = {
		            clientX: (rect.left || 0) + rect.width * column,
		            clientY: (rect.top || 0) + rect.height * row
		          };
		          if (!sameMaterialHit(center)) {
		            continue;
		          }
		          for (const halfLength of [24, 20, 16, 12]) {
		            const candidate = {
		              start: {
		                clientX: Math.max(rect.left + 4, center.clientX - halfLength),
		                clientY: center.clientY
		              },
		              mid: center,
		              end: {
		                clientX: Math.min(rect.right - 4, center.clientX + halfLength),
		                clientY: center.clientY
		              }
		            };
	            if (sameMaterialHit(candidate.start) && sameMaterialHit(candidate.end)) {
	              stroke = candidate;
	              break;
	            }
		          }
		          if (stroke) {
		            break;
		          }
		        }
		        if (stroke) {
		          break;
		        }
		      }
		      if (!stroke) {
		        return { found: false, reason: "missing-visible-pointer-hit", modelLoadedAtStart };
		      }
	      const originalActiveTool = editor.activeTool;
	      const originalGpuDisabled = editor.textureAirbrushGpuDisabled;
	      const originalTexturePaintColor = editor.texturePaintColor?.value;
	      const originalTextureBrushRadius = editor.textureBrushRadius?.value;
	      const originalTextureBrushOpacity = editor.textureBrushOpacity?.value;
		      const originalTextureBrushHardness = editor.textureBrushHardness?.value;
		      const originalTextureBrushScatter = editor.textureBrushScatter?.value;
		      const originalPressureRadius = editor.texturePressureRadius?.checked;
		      const originalPressureOpacity = editor.texturePressureOpacity?.checked;
		      const originalRunEditableWebGpuPaint = editor.textureAirbrushRunEditableWebGpuPaint;
		      const paintColor = { r: 0, g: 255, b: 0 };
		      const directPaintStats = [];
		      const directPaintSettled = [];
		      const setTextureBrushInput = (input = null, value = null) => {
	        if (!input) {
	          return;
	        }
	        input.value = String(value);
	        input.dispatchEvent?.(new Event("input", { bubbles: true }));
	        input.dispatchEvent?.(new Event("change", { bubbles: true }));
	      };
	      try {
	        editor.activeTool = "airbrush";
	        editor.textureAirbrushGpuDisabled = false;
	        editor.textureAirbrushScreenStrokeQueue = [];
	        editor.textureAirbrushPendingScreenStrokeBatches = [];
		        editor.textureAirbrushQueuedWebGpuStrokes = [];
		        editor.textureAirbrushScreenFlushScheduled = false;
		        editor.textureAirbrushWebGpuScreenPreviewActive = false;
		        if (typeof originalRunEditableWebGpuPaint === "function") {
		          editor.textureAirbrushRunEditableWebGpuPaint = function wrappedVisiblePointerRunEditableWebGpuPaint(...args) {
		            const result = originalRunEditableWebGpuPaint.apply(this, args);
		            const settled = Promise.resolve(result)
		              .then((resolved) => {
		                if (resolved?.stats) {
		                  directPaintStats.push(resolved.stats);
		                }
		                return resolved;
		              })
		              .catch(() => null);
		            directPaintSettled.push(settled);
		            return result;
		          };
		        }
	        if (editor.texturePaintColor) {
	          editor.texturePaintColor.value = "#00ff00";
	          editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
	          editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
	        }
	        if (!useCurrentBrushSettings) {
	          if (editor.texturePressureRadius) {
	            editor.texturePressureRadius.checked = false;
	          }
	          if (editor.texturePressureOpacity) {
	            editor.texturePressureOpacity.checked = false;
	          }
	          setTextureBrushInput(editor.textureBrushRadius, 0.12);
	          setTextureBrushInput(editor.textureBrushOpacity, 1);
	          setTextureBrushInput(editor.textureBrushHardness, 0.7);
	          setTextureBrushInput(editor.textureBrushScatter, 0);
	        }
	        editor.textureAirbrushResetStrokeBrushState?.();
	        editor.textureAirbrushResetStrokePressureState?.();
	        const radiusPixels = typeof editor.textureBrushRadiusScreenPixels === "function"
	          ? editor.textureBrushRadiusScreenPixels()
	          : 12;
	        await renderOnce();
	        const baselineFrame = captureViewerFrame();
	        const baselineFramePng = captureViewerFramePng();
	        const strokeFrameBounds = (() => {
	          if (!baselineFrame?.ok || !rect.width || !rect.height) {
	            return null;
	          }
	          const scaleX = baselineFrame.width / rect.width;
	          const scaleY = baselineFrame.height / rect.height;
	          const padding = 64;
	          const minClientX = Math.min(stroke.start.clientX, stroke.mid.clientX, stroke.end.clientX);
	          const maxClientX = Math.max(stroke.start.clientX, stroke.mid.clientX, stroke.end.clientX);
	          const minClientY = Math.min(stroke.start.clientY, stroke.mid.clientY, stroke.end.clientY);
	          const maxClientY = Math.max(stroke.start.clientY, stroke.mid.clientY, stroke.end.clientY);
	          const left = Math.max(0, Math.floor((minClientX - rect.left) * scaleX - padding));
	          const top = Math.max(0, Math.floor((minClientY - rect.top) * scaleY - padding));
	          const right = Math.min(baselineFrame.width, Math.ceil((maxClientX - rect.left) * scaleX + padding));
	          const bottom = Math.min(baselineFrame.height, Math.ceil((maxClientY - rect.top) * scaleY + padding));
	          return {
	            x: left,
	            y: top,
	            width: Math.max(0, right - left),
	            height: Math.max(0, bottom - top)
	          };
	        })();
	        const statsBefore = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
	          ? editor.textureAirbrushWebGpuPaintStats.length
	          : 0;
	        const pointerDownDispatched = dispatchPointer("pointerdown", editor.canvas, stroke.start, 1);
	        await renderOnce();
	        const pointerMoveDispatches = [];
	        for (const point of [stroke.mid, stroke.end]) {
	          pointerMoveDispatches.push(dispatchPointer("pointermove", editor.canvas, point, 1));
	          await renderOnce();
	        }
	        await renderOnce();
	        const liveFrame = captureViewerFrame();
	        const liveFramePng = captureViewerFramePng();
	        const liveVisualChange = compareViewerFrameChange(baselineFrame, liveFrame);
	        const liveVisualPaintColorChange = compareViewerPaintColorChange(
	          baselineFrame,
	          liveFrame,
	          paintColor,
	          strokeFrameBounds
	        );
	        const liveVisualPaintPathContinuity = compareViewerPaintPathContinuity(
	          baselineFrame,
	          liveFrame,
	          paintColor,
	          [stroke.start, stroke.mid, stroke.end],
	          rect,
	          { radiusPixels }
	        );
	        await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({
	          liveDisplayExternalTexture: true,
	          deferReadbackCopy: true
	        });
		        await editor.flushTextureAirbrushPendingWebGpuPaints?.();
		        if (directPaintSettled.length) {
		          await Promise.allSettled(directPaintSettled);
		        }
		        await renderOnce();
	        const activeFrame = captureViewerFrame();
	        const activeFramePng = captureViewerFramePng();
	        const visualChange = compareViewerFrameChange(baselineFrame, activeFrame);
	        const visualPaintColorChange = compareViewerPaintColorChange(
	          baselineFrame,
	          activeFrame,
	          paintColor,
	          strokeFrameBounds
	        );
	        const visualPaintPathContinuity = compareViewerPaintPathContinuity(
	          baselineFrame,
	          activeFrame,
	          paintColor,
	          [stroke.start, stroke.mid, stroke.end],
	          rect,
	          { radiusPixels }
	        );
	        const pointerUpDispatched = dispatchPointer("pointerup", window, stroke.end, 0);
		        await editor.finishTextureAirbrushScreenStrokeFlush?.();
		        await editor.flushTextureAirbrushPendingWebGpuPaints?.();
		        if (directPaintSettled.length) {
		          await Promise.allSettled(directPaintSettled);
		        }
		        const rollingStats = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
		          ? editor.textureAirbrushWebGpuPaintStats.slice(statsBefore)
		          : [];
		        const allStats = directPaintStats.length
		          ? [
		              ...directPaintStats,
		              ...rollingStats.filter((stat) => stat?.deferredCanvasSync === true)
		            ]
		          : rollingStats;
		        const paintStats = allStats.filter((stat) => stat?.deferredCanvasSync !== true);
	        return {
	          found: true,
	          modelLoadedAtStart,
	          useCurrentBrushSettings,
	          stroke,
	          radiusPixels,
	          visualBaselineFrame: summarizeViewerFrame(baselineFrame),
	          liveVisualFrame: summarizeViewerFrame(liveFrame),
	          liveVisualChange,
	          liveVisualPaintColorChange,
	          liveVisualPaintPathContinuity,
	          visualActiveFrame: summarizeViewerFrame(activeFrame),
	          visualChange,
	          visualPaintColorChange,
	          visualPaintPathContinuity,
	          debugFrames: {
	            baseline: baselineFramePng,
	            live: liveFramePng,
	            active: activeFramePng
	          },
	          pointerEvents: {
	            down: pointerDownDispatched,
	            moves: pointerMoveDispatches,
	            up: pointerUpDispatched
		          },
		          directPaintStatsCount: directPaintStats.length,
		          dispatchCount: paintStats.length,
		          stats: allStats
		        };
		      } finally {
		        if (typeof originalRunEditableWebGpuPaint === "function") {
		          editor.textureAirbrushRunEditableWebGpuPaint = originalRunEditableWebGpuPaint;
		        }
		        if (originalActiveTool === undefined) {
	          delete editor.activeTool;
	        } else {
	          editor.activeTool = originalActiveTool;
	        }
	        editor.textureAirbrushGpuDisabled = originalGpuDisabled;
	        if (editor.texturePaintColor && originalTexturePaintColor !== undefined) {
	          editor.texturePaintColor.value = originalTexturePaintColor;
	          editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
	          editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
	        }
	        setTextureBrushInput(editor.textureBrushRadius, originalTextureBrushRadius);
	        setTextureBrushInput(editor.textureBrushOpacity, originalTextureBrushOpacity);
	        setTextureBrushInput(editor.textureBrushHardness, originalTextureBrushHardness);
	        setTextureBrushInput(editor.textureBrushScatter, originalTextureBrushScatter);
	        if (editor.texturePressureRadius && originalPressureRadius !== undefined) {
	          editor.texturePressureRadius.checked = originalPressureRadius;
	        }
	        if (editor.texturePressureOpacity && originalPressureOpacity !== undefined) {
	          editor.texturePressureOpacity.checked = originalPressureOpacity;
	        }
		        editor.texturePaintStrokeUndo = null;
		      }
		    };
		    const largePointerStroke = async () => {
		      const modelLoadedAtStart = Boolean(editor.model);
		      const rect = editor.canvas?.getBoundingClientRect?.();
		      if (
		        !rect?.width
		        || !rect?.height
		        || typeof editor.onPointerDown !== "function"
		        || typeof editor.onPointerMove !== "function"
		        || typeof editor.onPointerUp !== "function"
		        || typeof editor.texturePaintHitForEvent !== "function"
		      ) {
		        return { found: false, reason: "missing-pointer-paint-methods", modelLoadedAtStart };
		      }
		      if (!modelLoadedAtStart) {
		        return { found: false, reason: "model-missing", modelLoadedAtStart };
		      }
		      const makeEvent = (clientX, clientY, buttons = 1) => ({
		        clientX,
		        clientY,
		        button: 0,
		        buttons,
		        pointerId: 918,
		        pointerType: "mouse",
		        pressure: buttons ? 1 : 0,
		        altKey: false,
		        ctrlKey: false,
		        metaKey: false,
		        shiftKey: false,
		        preventDefault() {},
		        stopPropagation() {},
		        stopImmediatePropagation() {}
		      });
		      const dispatchPointer = (type, target, point, buttons = 1) => {
		        if (!target?.dispatchEvent) {
		          return {
		            dispatched: false,
		            defaultPrevented: false
		          };
		        }
		        const eventInit = {
		          bubbles: true,
		          cancelable: true,
		          composed: true,
		          clientX: point.clientX,
		          clientY: point.clientY,
		          screenX: point.clientX,
		          screenY: point.clientY,
		          button: 0,
		          buttons,
		          pointerId: 918,
		          pointerType: "mouse",
		          isPrimary: true,
		          pressure: buttons ? 1 : 0,
		          altKey: false,
		          ctrlKey: false,
		          metaKey: false,
		          shiftKey: false,
		          view: window
		        };
		        const event = typeof PointerEvent === "function"
		          ? new PointerEvent(type, eventInit)
		          : new MouseEvent(type.replace(/^pointer/, "mouse"), eventInit);
		        try {
		          target.dispatchEvent(event);
		          return {
		            dispatched: true,
		            defaultPrevented: event.defaultPrevented === true
		          };
		        } catch (error) {
		          return {
		            dispatched: false,
		            defaultPrevented: false,
		            error: error?.message || String(error)
		          };
		        }
		      };
		      const sameMaterialHit = (point = null) => {
		        const hit = editor.texturePaintHitForEvent(makeEvent(point.clientX, point.clientY), "airbrush");
		        if (!hit?.record || !hit?.hit) {
		          return false;
		        }
		        const material = editor.clonePaintMaterialForHit?.(hit.record, hit.hit) || null;
		        return material === chosen.material;
		      };
		      let stroke = null;
			      for (const row of [0.44, 0.5, 0.56, 0.62, 0.68]) {
		        for (const column of [0.44, 0.5, 0.56, 0.62]) {
		          const center = {
		            clientX: (rect.left || 0) + rect.width * column,
		            clientY: (rect.top || 0) + rect.height * row
		          };
		          if (!sameMaterialHit(center)) {
		            continue;
		          }
		          for (const halfLength of [24, 20, 16]) {
		            const candidate = {
		              start: {
		                clientX: Math.max(rect.left + 4, center.clientX - halfLength),
		                clientY: center.clientY
		              },
		              mid: center,
		              end: {
		                clientX: Math.min(rect.right - 4, center.clientX + halfLength),
		                clientY: center.clientY
		              }
		            };
		            if (sameMaterialHit(candidate.start) && sameMaterialHit(candidate.end)) {
		              stroke = candidate;
		              break;
		            }
		          }
		          if (stroke) {
		            break;
		          }
		        }
		        if (stroke) {
		          break;
		        }
		      }
		      if (!stroke) {
		        return { found: false, reason: "missing-local-large-pointer-hit", modelLoadedAtStart };
		      }
		      const originalActiveTool = editor.activeTool;
		      const originalGpuDisabled = editor.textureAirbrushGpuDisabled;
		      const originalTexturePaintColor = editor.texturePaintColor?.value;
		      const originalTextureBrushRadius = editor.textureBrushRadius?.value;
		      const originalTextureBrushOpacity = editor.textureBrushOpacity?.value;
			      const originalTextureBrushHardness = editor.textureBrushHardness?.value;
			      const originalTextureBrushScatter = editor.textureBrushScatter?.value;
				      const originalPressureRadius = editor.texturePressureRadius?.checked;
				      const originalPressureOpacity = editor.texturePressureOpacity?.checked;
				      const originalRunEditableWebGpuPaint = editor.textureAirbrushRunEditableWebGpuPaint;
				      const originalQueueCandidate = editor.textureAirbrushQueueWebGpuStrokeCandidate;
				      const paintColor = { r: 255, g: 0, b: 255 };
				      const directPaintStats = [];
				      const directPaintSettled = [];
				      const directPaintRunOptions = [];
				      const candidateSummaries = [];
			      const setTextureBrushInput = (input = null, value = null) => {
		        if (!input) {
		          return;
		        }
		        input.value = String(value);
		        input.dispatchEvent?.(new Event("input", { bubbles: true }));
		        input.dispatchEvent?.(new Event("change", { bubbles: true }));
		      };
		      try {
		        editor.activeTool = "airbrush";
		        editor.textureAirbrushGpuDisabled = false;
		        editor.textureAirbrushScreenStrokeQueue = [];
		        editor.textureAirbrushPendingScreenStrokeBatches = [];
		        editor.textureAirbrushQueuedWebGpuStrokes = [];
			        editor.textureAirbrushScreenFlushScheduled = false;
			        editor.textureAirbrushWebGpuScreenPreviewActive = false;
				        if (typeof originalRunEditableWebGpuPaint === "function") {
				          editor.textureAirbrushRunEditableWebGpuPaint = function wrappedLargePointerRunEditableWebGpuPaint(...args) {
				            const options = args[1] || {};
				            directPaintRunOptions.push({
				              paintBounds: options.paintBounds || null,
				              displayDirtyRegionCount: Array.isArray(options.displayDirtyRegions)
				                ? options.displayDirtyRegions.length
				                : 0,
				              displayDirtyRegions: Array.isArray(options.displayDirtyRegions)
				                ? options.displayDirtyRegions
				                : [],
				              strokeSegmentCount: Array.isArray(options.strokeSegments)
				                ? options.strokeSegments.length
				                : 0,
				              liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false,
				              deferReadbackCopy: options.deferReadbackCopy === true,
				              visibilityTriangleCount: Array.isArray(options.visibilityMaskTriangles)
				                ? options.visibilityMaskTriangles.length
				                : 0,
				              visibilitySampleCount: Array.isArray(options.visibilityMaskSamples)
				                ? options.visibilityMaskSamples.length
				                : 0
				            });
				            const result = originalRunEditableWebGpuPaint.apply(this, args);
				            const settled = Promise.resolve(result)
				              .then((resolved) => {
				                if (resolved?.stats) {
			                  directPaintStats.push(resolved.stats);
			                }
			                return resolved;
			              })
			              .catch(() => null);
			            directPaintSettled.push(settled);
				            return result;
				          };
				        }
				        if (typeof originalQueueCandidate === "function") {
				          editor.textureAirbrushQueueWebGpuStrokeCandidate = function wrappedLargePointerQueueCandidate(candidate, ...args) {
				            const candidateOptions = candidate?.options || {};
				            candidateSummaries.push({
				              strokeSegmentCount: Array.isArray(candidate?.strokeSegments)
				                ? candidate.strokeSegments.length
				                : 0,
				              paintRegionCount: Array.isArray(candidate?.paintRegions)
				                ? candidate.paintRegions.length
				                : 0,
				              paintRegions: Array.isArray(candidate?.paintRegions)
				                ? candidate.paintRegions
				                : [],
				              paintBounds: candidate?.paintBounds || null,
				              visibilityTriangleCount: Array.isArray(candidateOptions.visibilityMaskTriangles)
				                ? candidateOptions.visibilityMaskTriangles.length
				                : 0,
				              visibilitySampleCount: Array.isArray(candidateOptions.visibilityMaskSamples)
				                ? candidateOptions.visibilityMaskSamples.length
				                : 0,
				              visibilityMaskBytes: candidateVisibilityMaskBytes(candidate),
				              largeLiveBrushPaint: candidateOptions.largeLiveBrushPaint === true,
				              liveProjectedPaint: candidateOptions.liveProjectedPaint === true
				            });
				            return originalQueueCandidate.call(this, candidate, ...args);
				          };
				        }
			        if (editor.texturePressureRadius) {
		          editor.texturePressureRadius.checked = false;
		        }
		        if (editor.texturePressureOpacity) {
		          editor.texturePressureOpacity.checked = false;
		        }
			        if (editor.texturePaintColor) {
			          editor.texturePaintColor.value = "#ff00ff";
			          editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
			          editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
		        }
		        setTextureBrushInput(editor.textureBrushRadius, 0.22);
		        setTextureBrushInput(editor.textureBrushOpacity, 1);
		        setTextureBrushInput(editor.textureBrushHardness, 0.4);
		        setTextureBrushInput(editor.textureBrushScatter, 0);
		        editor.textureAirbrushResetStrokeBrushState?.();
		        editor.textureAirbrushResetStrokePressureState?.();
		        const radiusPixels = typeof editor.textureBrushRadiusScreenPixels === "function"
		          ? editor.textureBrushRadiusScreenPixels()
		          : 28;
		        await renderOnce();
		        const baselineFrame = captureViewerFrame();
		        const baselineFramePng = captureViewerFramePng();
		        const strokeFrameBounds = (() => {
		          if (!baselineFrame?.ok || !rect.width || !rect.height) {
		            return null;
		          }
		          const scaleX = baselineFrame.width / rect.width;
		          const scaleY = baselineFrame.height / rect.height;
		          const padding = Math.max(96, radiusPixels * Math.max(scaleX, scaleY) * 3);
		          const minClientX = Math.min(stroke.start.clientX, stroke.mid.clientX, stroke.end.clientX);
		          const maxClientX = Math.max(stroke.start.clientX, stroke.mid.clientX, stroke.end.clientX);
		          const minClientY = Math.min(stroke.start.clientY, stroke.mid.clientY, stroke.end.clientY);
		          const maxClientY = Math.max(stroke.start.clientY, stroke.mid.clientY, stroke.end.clientY);
		          const left = Math.max(0, Math.floor((minClientX - rect.left) * scaleX - padding));
		          const top = Math.max(0, Math.floor((minClientY - rect.top) * scaleY - padding));
		          const right = Math.min(baselineFrame.width, Math.ceil((maxClientX - rect.left) * scaleX + padding));
		          const bottom = Math.min(baselineFrame.height, Math.ceil((maxClientY - rect.top) * scaleY + padding));
		          return {
		            x: left,
		            y: top,
		            width: Math.max(0, right - left),
		            height: Math.max(0, bottom - top)
		          };
		        })();
		        const statsBefore = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
		          ? editor.textureAirbrushWebGpuPaintStats.length
		          : 0;
		        const pointerDownDispatched = dispatchPointer("pointerdown", editor.canvas, stroke.start, 1);
		        await renderOnce();
		        const pointerMoveDispatches = [];
			        for (const point of [stroke.mid, stroke.end]) {
			          pointerMoveDispatches.push(dispatchPointer("pointermove", editor.canvas, point, 1));
			          await renderOnce();
			        }
			        let screenFlushDrainCount = 0;
			        while (
			          screenFlushDrainCount < 8
			          && (
			            (editor.textureAirbrushScreenStrokeQueue || []).length
			            || (editor.textureAirbrushPendingScreenStrokeBatches || []).length
			          )
			        ) {
			          screenFlushDrainCount += 1;
			          editor.flushTextureAirbrushScreenStroke?.({
			            live: true,
			            maxBatches: 4,
			            maxBatchSegments: 32,
			            maxSegments: 96,
			            maxBatchMs: 4,
			            immediateWebGpuFlush: true
			          });
			          await Promise.resolve();
			        }
			        await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({
			          liveDisplayExternalTexture: true,
			          deferReadbackCopy: true
			        });
			        await editor.flushTextureAirbrushPendingWebGpuPaints?.();
			        if (directPaintSettled.length) {
			          await Promise.allSettled(directPaintSettled);
			        }
			        await renderOnce();
		        const activeFrame = captureViewerFrame();
		        const activeFramePng = captureViewerFramePng();
		        const visualPaintColorChange = compareViewerPaintColorChange(
		          baselineFrame,
		          activeFrame,
		          paintColor,
		          strokeFrameBounds
		        );
			        const visualPaintContainment = compareViewerPaintPathContainment(
			          baselineFrame,
			          activeFrame,
			          paintColor,
			          [stroke.start, stroke.mid, stroke.end],
			          rect,
			          { radiusPixels }
			        );
			        const visualPaintArtifacts = compareViewerUnexpectedPaintArtifacts(
			          baselineFrame,
			          activeFrame,
			          paintColor,
			          strokeFrameBounds
			        );
			        const pointerUpDispatched = dispatchPointer("pointerup", window, stroke.end, 0);
			        await editor.finishTextureAirbrushScreenStrokeFlush?.();
			        await editor.flushTextureAirbrushPendingWebGpuPaints?.();
			        if (directPaintSettled.length) {
			          await Promise.allSettled(directPaintSettled);
			        }
			        const rollingStats = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
			          ? editor.textureAirbrushWebGpuPaintStats.slice(statsBefore)
			          : [];
			        const allStats = directPaintStats.length
			          ? [
			              ...directPaintStats,
			              ...rollingStats.filter((stat) => stat?.deferredCanvasSync === true)
			            ]
			          : rollingStats;
			        const paintStats = allStats.filter((stat) => stat?.deferredCanvasSync !== true);
			        return {
		          found: true,
		          modelLoadedAtStart,
		          stroke,
			          radiusPixels,
			          visualPaintColorChange,
			          visualPaintContainment,
			          visualPaintArtifacts,
				          pointerEvents: {
			            down: pointerDownDispatched,
			            moves: pointerMoveDispatches,
			            up: pointerUpDispatched
			          },
				          screenFlushDrainCount,
				          directPaintStatsCount: directPaintStats.length,
				          candidateCount: candidateSummaries.length,
				          candidateSummaries,
				          directPaintRunOptions,
				          dispatchCount: paintStats.length,
				          stats: allStats,
				          ...(debugFrameDumps ? {
				            debugFrames: {
				              baseline: baselineFramePng,
				              active: activeFramePng
				            }
				          } : {})
				        };
				      } finally {
				        if (typeof originalRunEditableWebGpuPaint === "function") {
				          editor.textureAirbrushRunEditableWebGpuPaint = originalRunEditableWebGpuPaint;
				        }
				        editor.textureAirbrushQueueWebGpuStrokeCandidate = originalQueueCandidate;
			        if (originalActiveTool === undefined) {
		          delete editor.activeTool;
		        } else {
		          editor.activeTool = originalActiveTool;
		        }
		        editor.textureAirbrushGpuDisabled = originalGpuDisabled;
		        if (editor.texturePaintColor && originalTexturePaintColor !== undefined) {
		          editor.texturePaintColor.value = originalTexturePaintColor;
		          editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
		          editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
		        }
		        setTextureBrushInput(editor.textureBrushRadius, originalTextureBrushRadius);
		        setTextureBrushInput(editor.textureBrushOpacity, originalTextureBrushOpacity);
		        setTextureBrushInput(editor.textureBrushHardness, originalTextureBrushHardness);
		        setTextureBrushInput(editor.textureBrushScatter, originalTextureBrushScatter);
		        if (editor.texturePressureRadius && originalPressureRadius !== undefined) {
		          editor.texturePressureRadius.checked = originalPressureRadius;
		        }
		        if (editor.texturePressureOpacity && originalPressureOpacity !== undefined) {
		          editor.texturePressureOpacity.checked = originalPressureOpacity;
		        }
		        editor.texturePaintStrokeUndo = null;
		      }
		    };
		    const coalescedScreenStrokePacket = async (pair = null) => {
	      if (!pair?.first || !pair?.last) {
	        return { found: false, reason: "missing-fast-live-pair" };
	      }
	      if (
	        typeof editor.queueAirbrushTextureStrokeEvent !== "function"
	        || typeof editor.flushTextureAirbrushScreenStroke !== "function"
	        || typeof editor.textureAirbrushWebGpuPaintFromEvent !== "function"
	      ) {
	        return { found: false, reason: "missing-coalesced-screen-stroke-methods" };
	      }
	      const now = () => (
	        typeof performance !== "undefined" && typeof performance.now === "function"
	          ? performance.now()
	          : Date.now()
	      );
	      const eventCount = 9;
	      const coalesced = [];
	      for (let index = 0; index < eventCount; index += 1) {
	        const ratio = eventCount <= 1 ? 1 : index / (eventCount - 1);
	        coalesced.push({
	          clientX: pair.first.clientX + (pair.last.clientX - pair.first.clientX) * ratio,
	          clientY: pair.first.clientY + (pair.last.clientY - pair.first.clientY) * ratio,
	          pointerType: "pen",
	          pressure: 1,
	          button: 0,
	          buttons: 1,
	          timeStamp: now() + index
	        });
	      }
	      const event = {
	        ...coalesced.at(-1),
	        preventDefault() {},
	        stopPropagation() {},
	        getCoalescedEvents() {
	          return coalesced;
	        }
	      };
	      const originalActiveTool = editor.activeTool;
	      const originalGpuDisabled = editor.textureAirbrushGpuDisabled;
			      const originalSchedule = editor.scheduleTextureAirbrushScreenStrokeFlush;
			      const originalWebGpuPaintFromEvent = editor.textureAirbrushWebGpuPaintFromEvent;
			      const originalRunEditableWebGpuPaint = editor.textureAirbrushRunEditableWebGpuPaint;
			      const originalQueueCandidate = editor.textureAirbrushQueueWebGpuStrokeCandidate;
		      const originalQueueSpacedScreenStroke = editor.textureAirbrushQueueSpacedScreenStroke;
		      const originalScreenStrokePayload = editor.textureAirbrushScreenStrokePayload;
		      const originalBeginNeighborPaintStroke = editor.textureAirbrushBeginNeighborPaintStroke;
		      const originalRewarmNeighborResetProjection = editor.textureAirbrushRewarmNeighborResetProjection;
		      const originalNeighborPaintHitFromEvent = editor.textureAirbrushNeighborPaintHitFromEvent;
		      const originalStrokePoint = editor.texturePaintStrokePoint;
		      const originalPainting = editor.painting;
			      const candidateSummaries = [];
			      const directPaintStats = [];
			      const directPaintSettled = [];
			      let scheduledFlushes = 0;
		      let webGpuPaintCalls = 0;
		      let queueSpacedCalls = 0;
		      let queueSpacedMs = 0;
		      let screenStrokePayloadCalls = 0;
		      let screenStrokePayloadMs = 0;
		      let beginNeighborCalls = 0;
		      let beginNeighborMs = 0;
		      let rewarmNeighborCalls = 0;
		      let rewarmNeighborMs = 0;
		      let neighborHitCalls = 0;
		      let neighborHitMs = 0;
	      try {
	        editor.activeTool = "airbrush";
	        editor.textureAirbrushGpuDisabled = false;
	        editor.textureAirbrushResetStrokeBrushState?.();
	        editor.textureAirbrushResetStrokePressureState?.();
	        editor.textureAirbrushScreenStrokeQueue = [];
	        editor.textureAirbrushPendingScreenStrokeBatches = [];
	        editor.textureAirbrushQueuedWebGpuStrokes = [];
	        editor.textureAirbrushScreenFlushScheduled = false;
	        editor.textureAirbrushWebGpuScreenPreviewActive = false;
	        editor.texturePaintStrokePoint = null;
	        editor.painting = true;
	        editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
	          scheduledFlushes += 1;
	          return true;
	        };
			        editor.textureAirbrushWebGpuPaintFromEvent = function wrappedCoalescedWebGpuPaintFromEvent(...args) {
			          webGpuPaintCalls += 1;
			          return originalWebGpuPaintFromEvent.apply(this, args);
			        };
			        if (typeof originalRunEditableWebGpuPaint === "function") {
			          editor.textureAirbrushRunEditableWebGpuPaint = function wrappedCoalescedRunEditableWebGpuPaint(...args) {
			            const result = originalRunEditableWebGpuPaint.apply(this, args);
			            const settled = Promise.resolve(result)
			              .then((resolved) => {
			                if (resolved?.stats) {
			                  directPaintStats.push(resolved.stats);
			                }
			                return resolved;
			              })
			              .catch(() => null);
			            directPaintSettled.push(settled);
			            return result;
			          };
			        }
			        if (typeof originalQueueSpacedScreenStroke === "function") {
		          editor.textureAirbrushQueueSpacedScreenStroke = function wrappedCoalescedQueueSpacedScreenStroke(...args) {
		            const callStart = now();
		            try {
		              return originalQueueSpacedScreenStroke.apply(this, args);
		            } finally {
		              queueSpacedCalls += 1;
		              queueSpacedMs += now() - callStart;
		            }
		          };
		        }
		        if (typeof originalScreenStrokePayload === "function") {
		          editor.textureAirbrushScreenStrokePayload = function wrappedCoalescedScreenStrokePayload(...args) {
		            const callStart = now();
		            try {
		              return originalScreenStrokePayload.apply(this, args);
		            } finally {
		              screenStrokePayloadCalls += 1;
		              screenStrokePayloadMs += now() - callStart;
		            }
		          };
		        }
		        if (typeof originalBeginNeighborPaintStroke === "function") {
		          editor.textureAirbrushBeginNeighborPaintStroke = function wrappedCoalescedBeginNeighborPaintStroke(...args) {
		            const callStart = now();
		            try {
		              return originalBeginNeighborPaintStroke.apply(this, args);
		            } finally {
		              beginNeighborCalls += 1;
		              beginNeighborMs += now() - callStart;
		            }
		          };
		        }
		        if (typeof originalRewarmNeighborResetProjection === "function") {
		          editor.textureAirbrushRewarmNeighborResetProjection = function wrappedCoalescedRewarmNeighborResetProjection(...args) {
		            const callStart = now();
		            try {
		              return originalRewarmNeighborResetProjection.apply(this, args);
		            } finally {
		              rewarmNeighborCalls += 1;
		              rewarmNeighborMs += now() - callStart;
		            }
		          };
		        }
		        if (typeof originalNeighborPaintHitFromEvent === "function") {
		          editor.textureAirbrushNeighborPaintHitFromEvent = function wrappedCoalescedNeighborPaintHitFromEvent(...args) {
		            const callStart = now();
		            try {
		              return originalNeighborPaintHitFromEvent.apply(this, args);
		            } finally {
		              neighborHitCalls += 1;
		              neighborHitMs += now() - callStart;
		            }
		          };
		        }
		        if (typeof originalQueueCandidate === "function") {
	          editor.textureAirbrushQueueWebGpuStrokeCandidate = function wrappedCoalescedQueueCandidate(candidate, ...args) {
	            const strokeSegments = Array.isArray(candidate?.strokeSegments)
	              ? candidate.strokeSegments
	              : [];
		            const candidateOptions = candidate?.options || {};
			            candidateSummaries.push({
			              materialName: candidate?.material?.name || "",
			              materialIndex: candidate?.materialIndex ?? null,
			              candidateTimingMs: candidateOptions.candidateTimingMs || null,
			              candidateDebugCounts: candidateOptions.candidateDebugCounts || null,
			              editableWidth: Math.max(0, Number(candidate?.editable?.canvas?.width) || 0),
			              editableHeight: Math.max(0, Number(candidate?.editable?.canvas?.height) || 0),
			              center: Number.isFinite(candidate?.center?.x) && Number.isFinite(candidate?.center?.y)
			                ? { x: candidate.center.x, y: candidate.center.y }
			                : null,
			              paintBounds: candidate?.paintBounds || null,
			              paintRegionCount: Array.isArray(candidate?.paintRegions)
			                ? candidate.paintRegions.length
			                : 0,
				              liveBatchSplitReasons: Array.isArray(candidateOptions.liveBatchSplitReasons)
				                ? candidateOptions.liveBatchSplitReasons
				                : [],
				              maxMergedVisibilityTriangles: Number(candidateOptions.maxMergedVisibilityTriangles) || null,
				              maxVisibilityTriangles: Number(candidateOptions.maxVisibilityTriangles) || null,
				              largeLiveBrushPaint: candidateOptions.largeLiveBrushPaint === true,
				              largeLiveNeighborPaint: candidateOptions.largeLiveNeighborPaint === true,
				              neighborPaintSeed: candidateOptions.neighborPaintSeed?.enabled === true,
				              strokeSegmentCount: strokeSegments.length,
			              visibilityTriangleCount: Array.isArray(candidateOptions.visibilityMaskTriangles)
			                ? candidateOptions.visibilityMaskTriangles.length
			                : 0,
		              visibilityMaskBytes: candidateVisibilityMaskBytes(candidate)
		            });
	            return originalQueueCandidate.call(this, candidate, ...args);
	          };
	        }
	        const statsBefore = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
	          ? editor.textureAirbrushWebGpuPaintStats.length
	          : 0;
		        editor.beginTexturePaintStrokeUndo?.("WebGPU validation coalesced packet");
		        const startedAt = now();
		        const queued = editor.queueAirbrushTextureStrokeEvent(event, { reset: true }) === true;
		        const queuedAt = now();
		        const immediateScheduledAfterQueue = editor.textureAirbrushImmediateWebGpuScreenFlushScheduled === true;
		        await Promise.resolve();
		        await Promise.resolve();
		        let screenFlushDrainCount = 0;
		        while (
		          ((editor.textureAirbrushScreenStrokeQueue || []).length
		            || (editor.textureAirbrushPendingScreenStrokeBatches || []).length)
		          && screenFlushDrainCount < 4
		        ) {
		          screenFlushDrainCount += 1;
		          editor.flushTextureAirbrushScreenStroke?.({
		            live: true,
		            maxBatches: 1,
		            maxBatchSegments: 2,
		            maxSegments: 2,
		            maxBatchMs: 1,
		            immediateWebGpuFlush: true,
		            captureCandidateTimings: true
		          });
		          await Promise.resolve();
		        }
		        await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({
		          liveDisplayExternalTexture: true,
		          deferReadbackCopy: true
		        });
	        if ((editor.textureAirbrushQueuedWebGpuStrokes || []).length) {
	          await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({ force: true });
	        }
		        await editor.flushTextureAirbrushPendingWebGpuPaints?.();
		        if (directPaintSettled.length) {
		          await Promise.allSettled(directPaintSettled);
		        }
		        const durationMs = now() - startedAt;
		        const rollingStats = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
		          ? editor.textureAirbrushWebGpuPaintStats.slice(statsBefore)
		          : [];
		        const allStats = directPaintStats.length
		          ? [
		              ...directPaintStats,
		              ...rollingStats.filter((stat) => stat?.deferredCanvasSync === true)
		            ]
		          : rollingStats;
		        const stats = allStats.filter((stat) => stat?.deferredCanvasSync !== true);
	        const syncStats = allStats.filter((stat) => stat?.deferredCanvasSync === true);
	        return {
	          found: true,
	          eventCount,
	          queued,
			          scheduledFlushes,
			          immediateScheduledAfterQueue,
				          screenFlushDrainCount,
				          webGpuPaintCalls,
				          directPaintStatsCount: directPaintStats.length,
				          queueSpacedCalls,
			          queueSpacedMs,
			          screenStrokePayloadCalls,
			          screenStrokePayloadMs,
			          beginNeighborCalls,
			          beginNeighborMs,
			          rewarmNeighborCalls,
			          rewarmNeighborMs,
			          neighborHitCalls,
			          neighborHitMs,
		          queueMs: queuedAt - startedAt,
	          durationMs,
	          dispatchCount: stats.length,
	          candidateCount: candidateSummaries.length,
	          maxCandidateStrokeSegments: Math.max(0, ...candidateSummaries.map((candidate) => (
	            Number(candidate?.strokeSegmentCount) || 0
	          ))),
	          totalCandidateStrokeSegments: candidateSummaries.reduce((total, candidate) => (
	            total + Math.max(0, Number(candidate?.strokeSegmentCount) || 0)
	          ), 0),
	          screenQueueAfterDrain: (editor.textureAirbrushScreenStrokeQueue || []).length,
	          queuedAfterDrain: (editor.textureAirbrushQueuedWebGpuStrokes || []).length,
	          pendingAfterDrain: (editor.textureAirbrushPendingWebGpuPaints || new Set()).size || 0,
	          maxReadbackBytes: Math.max(0, ...allStats.map((stat) => Number(stat?.readbackBytes) || 0)),
	          maxDispatchTotalMs: Math.max(0, ...stats.map((stat) => Number(stat?.timings?.totalMs) || 0)),
	          candidateSummaries,
	          stats,
	          syncStats,
	          allStats
	        };
	      } finally {
	        if (originalActiveTool === undefined) {
	          delete editor.activeTool;
	        } else {
	          editor.activeTool = originalActiveTool;
	        }
		        editor.textureAirbrushGpuDisabled = originalGpuDisabled;
		        editor.scheduleTextureAirbrushScreenStrokeFlush = originalSchedule;
		        editor.textureAirbrushWebGpuPaintFromEvent = originalWebGpuPaintFromEvent;
		        if (typeof originalRunEditableWebGpuPaint === "function") {
		          editor.textureAirbrushRunEditableWebGpuPaint = originalRunEditableWebGpuPaint;
		        }
		        editor.textureAirbrushQueueWebGpuStrokeCandidate = originalQueueCandidate;
		        editor.textureAirbrushQueueSpacedScreenStroke = originalQueueSpacedScreenStroke;
		        editor.textureAirbrushScreenStrokePayload = originalScreenStrokePayload;
		        editor.textureAirbrushBeginNeighborPaintStroke = originalBeginNeighborPaintStroke;
		        editor.textureAirbrushRewarmNeighborResetProjection = originalRewarmNeighborResetProjection;
		        editor.textureAirbrushNeighborPaintHitFromEvent = originalNeighborPaintHitFromEvent;
	        editor.painting = originalPainting;
	        if (originalStrokePoint === undefined) {
	          delete editor.texturePaintStrokePoint;
	        } else {
	          editor.texturePaintStrokePoint = originalStrokePoint;
	        }
	        editor.texturePaintStrokeUndo = null;
	      }
	    };
	    const scheduledScreenStrokeLivePaint = async (pair = null) => {
	      if (!pair?.first || !pair?.last) {
	        return { found: false, reason: "missing-fast-live-pair" };
	      }
	      if (
	        typeof editor.textureAirbrushQueueScreenStroke !== "function"
	        || typeof editor.scheduleTextureAirbrushScreenStrokeFlush !== "function"
	        || typeof editor.textureAirbrushWebGpuPaintFromEvent !== "function"
	        || typeof editor.textureAirbrushRunEditableWebGpuPaint !== "function"
	      ) {
	        return { found: false, reason: "missing-live-scheduled-methods" };
	      }
	      const makeEvent = (clientX, clientY) => ({
	        clientX,
	        clientY,
	        pointerType: "pen",
	        pressure: 1,
	        button: 0,
	        buttons: 1,
	        preventDefault() {},
	        stopPropagation() {}
	      });
	      const now = () => (
	        typeof performance !== "undefined" && typeof performance.now === "function"
	          ? performance.now()
	          : Date.now()
	      );
	      const waitFrame = () => new Promise((resolve) => {
	        if (typeof window.requestAnimationFrame === "function") {
	          window.requestAnimationFrame(() => resolve());
	        } else {
	          setTimeout(resolve, 16);
	        }
	      });
	      const originalActiveTool = editor.activeTool;
	      const originalGpuDisabled = editor.textureAirbrushGpuDisabled;
	      const originalSchedule = editor.scheduleTextureAirbrushScreenStrokeFlush;
	      const originalWebGpuPaintFromEvent = editor.textureAirbrushWebGpuPaintFromEvent;
	      const originalRunEditable = editor.textureAirbrushRunEditableWebGpuPaint;
	      const profiledMethods = [];
	      const profile = {};
	      const candidateSummaries = [];
	      const originalPainting = editor.painting;
	      const immediateStats = [];
	      let scheduledFlushes = 0;
	      let webGpuPaintCalls = 0;
	      let forcedDrainBeforeDispatch = false;
	      const wrapProfiledMethod = (name) => {
	        const original = editor[name];
	        if (typeof original !== "function") {
	          return;
	        }
	        profile[name] = {
	          calls: 0,
	          totalMs: 0,
	          maxMs: 0
	        };
	        profiledMethods.push([name, original]);
	        editor[name] = function validationScheduledProfiledMethod(...args) {
	          const callStartedAt = now();
	          try {
	            if (name === "textureAirbrushQueueWebGpuStrokeCandidate") {
	              const candidate = args[0] || null;
	              const candidateOptions = candidate?.options || {};
	              const strokeSegments = Array.isArray(candidate?.strokeSegments)
	                ? candidate.strokeSegments
	                : [];
	              candidateSummaries.push({
	                candidateTimingMs: candidateOptions.candidateTimingMs || null,
	                candidateDebugCounts: candidateOptions.candidateDebugCounts || null,
	                strokeSegmentCount: strokeSegments.length,
	                visibilityTriangleCount: Array.isArray(candidateOptions.visibilityMaskTriangles)
	                  ? candidateOptions.visibilityMaskTriangles.length
	                  : 0,
	                paintRegionCount: Array.isArray(candidate?.paintRegions)
	                  ? candidate.paintRegions.length
	                  : 0,
	                paintBounds: candidate?.paintBounds || null
	              });
	            }
	            return original.apply(this, args);
	          } finally {
	            const elapsed = now() - callStartedAt;
	            profile[name].calls += 1;
	            profile[name].totalMs += elapsed;
	            profile[name].maxMs = Math.max(profile[name].maxMs, elapsed);
	          }
	        };
	      };
	      try {
	        editor.activeTool = "airbrush";
	        editor.textureAirbrushGpuDisabled = false;
	        editor.textureAirbrushResetStrokeBrushState?.();
	        editor.textureAirbrushResetStrokePressureState?.();
	        editor.textureAirbrushScreenStrokeQueue = [];
	        editor.textureAirbrushPendingScreenStrokeBatches = [];
	        editor.textureAirbrushQueuedWebGpuStrokes = [];
	        editor.textureAirbrushScreenFlushScheduled = false;
	        editor.textureAirbrushWebGpuScreenPreviewActive = false;
	        editor.painting = true;
	        editor.scheduleTextureAirbrushScreenStrokeFlush = function validationScheduledScreenFlush(...args) {
	          scheduledFlushes += 1;
	          return originalSchedule.apply(this, args);
	        };
	        editor.textureAirbrushWebGpuPaintFromEvent = function validationScheduledWebGpuPaint(...args) {
	          webGpuPaintCalls += 1;
	          const [paintEvent, paintOptions = {}] = args;
	          return originalWebGpuPaintFromEvent.call(this, paintEvent, {
	            ...paintOptions,
	            captureCandidateTimings: true
	          });
	        };
	        editor.textureAirbrushRunEditableWebGpuPaint = function validationScheduledRunEditable(...args) {
	          const result = originalRunEditable.apply(this, args);
	          Promise.resolve(result).then((resolved) => {
	            if (resolved?.stats) {
	              immediateStats.push({
	                stats: resolved.stats,
	                atMs: now()
	              });
	            }
	          });
	          return result;
	        };
	        [
	          "textureAirbrushScreenStrokePayload",
	          "textureAirbrushScreenStrokeBatches",
	          "textureAirbrushWebGpuCandidatesFromEvent",
	          "textureAirbrushScreenHitsForEvent",
	          "textureAirbrushScreenTrianglesNearSegments",
	          "textureAirbrushBuildScreenHitIndex",
	          "textureAirbrushQueueWebGpuStrokeCandidate",
	          "textureAirbrushStartWebGpuPaintCandidate",
	          "textureAirbrushRunEditableWebGpuPaint",
	          "textureAirbrushCachedWebGpuStrokeSourceImage",
	          "texturePaintCanvasStrokeSourceImage",
	          "captureTexturePaintCanvasUndoTarget",
	          "flushTextureAirbrushQueuedWebGpuStrokes"
	        ].forEach(wrapProfiledMethod);
	        editor.beginTexturePaintStrokeUndo?.("WebGPU validation scheduled screen stroke");
	        const startedAt = now();
	        const queued = editor.textureAirbrushQueueScreenStroke(makeEvent(pair.last.clientX, pair.last.clientY), {
	          strokeStart: { clientX: pair.first.clientX, clientY: pair.first.clientY },
	          captureCandidateTimings: true
	        }) === true;
	        const queuedAt = now();
	        let microtaskCount = 0;
	        while (microtaskCount < 8 && immediateStats.length <= 0) {
	          await Promise.resolve();
	          microtaskCount += 1;
	        }
	        let frameCount = 0;
	        while (frameCount < 12 && immediateStats.length <= 0) {
	          await waitFrame();
	          await Promise.resolve();
	          await Promise.resolve();
	          frameCount += 1;
	        }
	        const activePaintMs = immediateStats.length
	          ? Math.max(0, immediateStats[0].atMs - startedAt)
	          : now() - startedAt;
	        const activeImmediateStats = immediateStats.map((entry) => entry.stats);
	        if (immediateStats.length <= 0) {
	          forcedDrainBeforeDispatch = true;
	        }
	        await editor.flushTextureAirbrushQueuedWebGpuStrokes?.({ force: true });
	        await editor.flushTextureAirbrushPendingWebGpuPaints?.();
	        const drainStats = immediateStats
	          .slice(activeImmediateStats.length)
	          .map((entry) => entry.stats);
	        return {
	          found: true,
	          queued,
	          scheduledFlushes,
	          webGpuPaintCalls,
	          queueCallMs: queuedAt - startedAt,
	          microtaskCount,
	          frameCount,
	          activePaintMs,
	          forcedDrainBeforeDispatch,
	          immediateDispatchCount: activeImmediateStats.length,
	          immediateStats: activeImmediateStats,
	          drainStats,
	          profile,
	          candidateSummaries,
	          screenQueueAfterDrain: (editor.textureAirbrushScreenStrokeQueue || []).length,
	          queuedAfterDrain: (editor.textureAirbrushQueuedWebGpuStrokes || []).length,
	          pendingAfterDrain: (editor.textureAirbrushPendingWebGpuPaints || new Set()).size || 0
	        };
	      } finally {
	        if (originalActiveTool === undefined) {
	          delete editor.activeTool;
	        } else {
	          editor.activeTool = originalActiveTool;
	        }
	        editor.textureAirbrushGpuDisabled = originalGpuDisabled;
	        editor.scheduleTextureAirbrushScreenStrokeFlush = originalSchedule;
	        editor.textureAirbrushWebGpuPaintFromEvent = originalWebGpuPaintFromEvent;
	        editor.textureAirbrushRunEditableWebGpuPaint = originalRunEditable;
	        for (const [name, original] of profiledMethods.reverse()) {
	          editor[name] = original;
	        }
	        editor.painting = originalPainting;
	        editor.texturePaintStrokeUndo = null;
	      }
	    };
	    const fastLiveStrokeResult = await fastLiveStroke();
		    const largePointerStrokeResult = await largePointerStroke();
		    const liveStrokeStressResult = await liveStrokeStress(fastLiveStrokeResult?.pair);
		    const screenStrokeStressResult = await screenStrokeStress(fastLiveStrokeResult?.pair);
		    const defaultPointerStrokeResult = await visiblePointerStroke({ useCurrentBrushSettings: true });
		    const visiblePointerStrokeResult = await visiblePointerStroke();
		    const coalescedScreenStrokeResult = await coalescedScreenStrokePacket(fastLiveStrokeResult?.pair);
		    const scheduledScreenStrokeResult = await scheduledScreenStrokeLivePaint(fastLiveStrokeResult?.pair);
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
      stats: directStats,
      liveDisplayExternalActive,
      liveDisplayRenderOk,
      liveDisplayRenderError,
      liveDisplayMapInfo,
      liveDisplayBaselineFrame: summarizeViewerFrame(liveDisplayBaselineFrame),
      liveDisplayActiveFrame: summarizeViewerFrame(liveDisplayActiveFrame),
      liveDisplayColorStability,
	      liveDisplayApplied: Boolean(liveResult?.applied),
	      liveDisplayExternalRetained,
	      liveDisplayRestored,
	      liveDisplayStats,
	      fastLiveStroke: fastLiveStrokeResult,
	      liveStrokeStress: liveStrokeStressResult,
	      screenStrokeStress: screenStrokeStressResult,
	      defaultPointerStroke: defaultPointerStrokeResult,
	      visiblePointerStroke: visiblePointerStrokeResult,
		      largePointerStroke: largePointerStrokeResult,
		      coalescedScreenStroke: coalescedScreenStrokeResult,
	      scheduledScreenStroke: scheduledScreenStrokeResult
	    };
	  })()`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
