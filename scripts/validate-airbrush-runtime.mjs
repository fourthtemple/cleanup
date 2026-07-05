import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = parseArgs(process.argv.slice(2));
const timeoutMs = positiveInteger(args.timeout || process.env.AIRBRUSH_RUNTIME_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const headless = args.headed !== true && process.env.AIRBRUSH_RUNTIME_HEADLESS !== "0";
const keepOpen = args.keepOpen === true || process.env.AIRBRUSH_RUNTIME_KEEP_OPEN === "1";
const layerAfterUndo = args.layerAfterUndo === true || process.env.AIRBRUSH_RUNTIME_LAYER_AFTER_UNDO === "1";
const thirdLayer = args.thirdLayer === true || process.env.AIRBRUSH_RUNTIME_THIRD_LAYER === "1";
const afterOrbitNeighbor = args.afterOrbitNeighbor === true || process.env.AIRBRUSH_RUNTIME_AFTER_ORBIT_NEIGHBOR === "1";
const afterOrbitMacro = args.afterOrbitMacro === true || process.env.AIRBRUSH_RUNTIME_AFTER_ORBIT_MACRO === "1";
const reproMacroName = String(args.reproMacro || process.env.AIRBRUSH_RUNTIME_REPRO_MACRO || "after-orbit-paint").trim() || "after-orbit-paint";
const sideEdgeSoftness = args.sideEdgeSoftness === true || process.env.AIRBRUSH_RUNTIME_SIDE_EDGE_SOFTNESS === "1";
const webGpuRendererExpected = true;
const captureHitCallers = args.hitCallers === true || process.env.AIRBRUSH_RUNTIME_HIT_CALLERS === "1";

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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
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
  const userDataDir = await mkdtemp(join(tmpdir(), "cleanup-airbrush-runtime-"));
  cleanupTasks.push(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  const validationUrl = withValidationQuery(appUrl);
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
  await cdp.send("Input.setIgnoreInputEvents", { ignore: false });
  await waitForRuntime(cdp, "document.readyState === 'complete' || document.readyState === 'interactive'", timeoutMs);
  await waitForRuntime(cdp, "Boolean(window.modelCleanupEditor)", timeoutMs);
  if (webGpuRendererExpected) {
    await waitForRuntime(cdp, [
      "window.modelCleanupEditor.textureAirbrushWebGpuRendererReady === true",
      "window.modelCleanupEditor.textureAirbrushWebGpuRendererDisabled === true",
      "!window.modelCleanupEditor.textureAirbrushWebGpuRendererInit"
    ].join(" || "), timeoutMs);
  }

  if (afterOrbitMacro) {
    const result = await evaluateRuntime(cdp, runtimeAfterOrbitMacroExpression(reproMacroName), { awaitPromise: true, timeoutMs });
    const checks = runtimeAfterOrbitMacroChecks(result, {
      strictAfterOrbit: reproMacroName === "after-orbit-paint"
    });
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      afterOrbitMacro,
      reproMacroName,
      checks,
      result
    };
    console.log(JSON.stringify(summary, null, 2));
    await captureValidationLayerImage(cdp);
    await captureValidationScreenshot(cdp);

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush after-orbit macro runtime validation failed: ${failed}`);
    }
  } else if (afterOrbitNeighbor) {
    const result = await evaluateRuntime(cdp, runtimeAfterOrbitNeighborExpression(), { awaitPromise: true, timeoutMs });
    const checks = runtimeAfterOrbitNeighborChecks(result);
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      afterOrbitNeighbor,
      checks,
      result
    };
    console.log(JSON.stringify(summary, null, 2));
    await captureValidationLayerImage(cdp);
    await captureValidationScreenshot(cdp);

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush after-orbit Neighbor runtime validation failed: ${failed}`);
    }
  } else if (sideEdgeSoftness) {
    const result = await evaluateRuntime(cdp, runtimeSideEdgeSoftnessExpression(), { awaitPromise: true, timeoutMs });
    const checks = runtimeSideEdgeSoftnessChecks(result);
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      sideEdgeSoftness,
      checks,
      result
    };
    console.log(JSON.stringify(summary, null, 2));
    await captureValidationLayerImage(cdp);
    await captureValidationScreenshot(cdp);

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush side-edge softness validation failed: ${failed}`);
    }
  } else {
  const prepared = await evaluateRuntime(cdp, runtimePreparationExpression(), { awaitPromise: true, timeoutMs });
  if (!prepared?.ready) {
    throw new Error(`Airbrush runtime preparation failed: ${prepared?.error || "unknown"} ${JSON.stringify(prepared || {})}`);
  }

  const midStrokePainted = await dispatchAirbrushStroke(cdp, prepared.stroke, {
    midStrokeExpression: runtimeMidStrokeResultExpression(),
    timeoutMs
  });
  const painted = await evaluateRuntime(cdp, runtimeResultExpression(), { awaitPromise: true, timeoutMs });
  const layerSetup = layerAfterUndo
    ? await evaluateRuntime(cdp, runtimeLayerAfterUndoSetupExpression(), { awaitPromise: true, timeoutMs })
    : null;
  if (layerAfterUndo && !layerSetup?.ready) {
    throw new Error(`Airbrush layer-after-undo setup failed: ${layerSetup?.error || "unknown"}`);
  }
  if (layerAfterUndo) {
    await dispatchAirbrushStroke(cdp, prepared.stroke);
  }
  const layerPainted = layerAfterUndo
    ? await evaluateRuntime(cdp, runtimeLayerAfterUndoResultExpression(), { awaitPromise: true, timeoutMs })
    : null;
  const thirdLayerSteps = [];
  if (thirdLayer) {
    for (let layerNumber = 1; layerNumber <= 3; layerNumber += 1) {
      const layerSetup = await evaluateRuntime(
        cdp,
        runtimeThirdLayerAddExpression(layerNumber),
        { awaitPromise: true, timeoutMs }
      );
      if (!layerSetup?.ready) {
        throw new Error(`Airbrush third-layer setup failed at Paint ${layerNumber}: ${layerSetup?.error || "unknown"}`);
      }
      await dispatchAirbrushStroke(cdp, thirdLayerStrokeForPrepared(prepared, layerNumber));
      const layerResult = await evaluateRuntime(
        cdp,
        runtimeThirdLayerPaintResultExpression(layerNumber),
        { awaitPromise: true, timeoutMs }
      );
      thirdLayerSteps.push({ layerSetup, layerResult });
    }
  }
  const checks = {
    ...runtimeAirbrushChecks(prepared, painted, midStrokePainted),
    ...(layerAfterUndo ? runtimeLayerAfterUndoChecks(layerSetup, layerPainted) : {}),
    ...(thirdLayer ? runtimeThirdLayerChecks(thirdLayerSteps) : {})
  };
  const summary = {
    ok: Object.values(checks).every(Boolean),
    url: validationUrl,
    headless,
    layerAfterUndo,
    thirdLayer,
    checks,
    prepared,
    midStrokePainted,
    painted,
    ...(layerAfterUndo ? { layerSetup, layerPainted } : {}),
    ...(thirdLayer ? { thirdLayerSteps } : {})
  };

  console.log(JSON.stringify(summary, null, 2));
  await captureValidationLayerImage(cdp);
  await captureValidationScreenshot(cdp);

  if (!summary.ok) {
    const failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    throw new Error(`Airbrush runtime validation failed: ${failed}`);
  }
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
    } else if (value === "--layer-after-undo") {
      parsed.layerAfterUndo = true;
    } else if (value === "--third-layer") {
      parsed.thirdLayer = true;
    } else if (value === "--after-orbit-neighbor") {
      parsed.afterOrbitNeighbor = true;
    } else if (value === "--after-orbit-macro") {
      parsed.afterOrbitMacro = true;
    } else if (value === "--repro-macro") {
      parsed.reproMacro = argv[++index] || "";
    } else if (value === "--side-edge-softness") {
      parsed.sideEdgeSoftness = true;
    } else if (value === "--hit-callers") {
      parsed.hitCallers = true;
    } else if (value === "--url") {
      parsed.url = argv[++index] || "";
    } else if (value === "--screenshot") {
      parsed.screenshot = argv[++index] || "";
    } else if (value === "--screenshot-zoom") {
      parsed.screenshotZoom = argv[++index] || "";
    } else if (value === "--layer-image") {
      parsed.layerImage = argv[++index] || "";
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
  console.log(`Usage: npm run validate:airbrush -- [options]

Options:
  --url <url>       Validate an already running Cleanup app.
  --screenshot <path> Save a final page screenshot for visual inspection.
  --screenshot-zoom <n> Temporarily zoom the final camera before screenshot.
  --layer-image <path> Save the active paint layer canvas after validation.
  --browser <path>  Chrome/Chromium executable path.
  --timeout <ms>    Timeout for server/browser readiness.
  --headed          Launch Chrome visibly instead of headless.
  --keep-open       Leave Chrome open after validation.
  --layer-after-undo  Validate paint, undo, add Paint 1, then paint Paint 1.
  --third-layer     Validate adding and painting Paint 1, Paint 2, and Paint 3.
  --after-orbit-neighbor  Validate Neighbor paint, orbit, then Neighbor paint again.
  --after-orbit-macro  Validate the packaged after-orbit Neighbor paint repro macro.
  --repro-macro <name>  Replay a specific packaged/saved repro macro name.
  --side-edge-softness  Validate a side-view soft-edge stroke for triangle teeth.
  --hit-callers    Include opt-in texture hit-test caller buckets in validation output.
`);
}

async function captureValidationLayerImage(cdp) {
  if (!args.layerImage) {
    return;
  }
  const dataUrl = await evaluateRuntime(cdp, `(() => {
    const editor = window.modelCleanupEditor;
    editor?.flushTexturePaintLayerGpuTargetsToCanvases?.({ composite: true });
    const materials = editor?.textureAirbrushPaintableMaterials?.() || [];
    let bestCanvas = null;
    let bestAlpha = -1;
    for (const entry of materials) {
      const material = entry?.material || entry || null;
      const stack = material?.userData?.texturePaintLayerStack || null;
      const layer = (stack?.layers || []).find((item) => item.id === stack?.activeLayerId) || null;
      const canvas = layer?.canvas || null;
      if (canvas?.width && canvas?.height && typeof canvas.toDataURL === "function") {
        const context = canvas.getContext?.("2d", { willReadFrequently: true }) || null;
        const image = context?.getImageData?.(0, 0, canvas.width, canvas.height) || null;
        let alpha = 0;
        if (image?.data) {
          for (let index = 3; index < image.data.length; index += 4) {
            alpha += image.data[index] || 0;
          }
        }
        if (alpha > bestAlpha) {
          bestAlpha = alpha;
          bestCanvas = canvas;
        }
      }
    }
    return bestCanvas?.toDataURL("image/png") || "";
  })()`);
  const match = String(dataUrl || "").match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    console.warn("Validation layer image capture returned no PNG data.");
    return;
  }
  await writeFile(args.layerImage, Buffer.from(match[1], "base64"));
}

async function captureValidationScreenshot(cdp) {
  if (!args.screenshot) {
    return;
  }
  const screenshotZoom = Number(args.screenshotZoom);
  if (Number.isFinite(screenshotZoom) && screenshotZoom > 0) {
    await evaluateRuntime(cdp, `(() => {
      const editor = window.modelCleanupEditor;
      if (!editor?.camera) return false;
      editor.camera.zoom = ${JSON.stringify(screenshotZoom)};
      editor.camera.updateProjectionMatrix?.();
      editor.render?.();
      return true;
    })()`);
  }
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  if (!result?.data) {
    throw new Error("Validation screenshot capture returned no data.");
  }
  await writeFile(args.screenshot, Buffer.from(result.data, "base64"));
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
    "--window-size=1280,900",
    "--autoplay-policy=no-user-gesture-required",
    url
  ];
  if (webGpuRendererExpected) {
    chromeArgs.splice(6, 0, "--enable-unsafe-webgpu");
  }
  if (useHeadless) {
    chromeArgs.unshift("--headless=new");
  }
  const child = spawn(browserPath, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (/error|gpu|webgl|warning/i.test(chunk)) {
      process.stderr.write(chunk);
    }
  });
  child.once("error", (error) => {
    throw error;
  });
  return child;
}

function withValidationQuery(value) {
  const url = new URL(value);
  url.searchParams.set("library", url.searchParams.get("library") || "server");
  url.searchParams.set("airbrush-runtime-validation", String(Date.now()));
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
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime evaluation failed.";
    throw new Error(text);
  }
  return result.result?.value;
}

async function dispatchAirbrushStroke(cdp, stroke, options = {}) {
  const { start, mid, end } = stroke;
  let midStrokeResult = null;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: start.x,
    y: start.y,
    button: "none",
    buttons: 0
  });
  await delay(20);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  await delay(30);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: mid.x,
    y: mid.y,
    button: "left",
    buttons: 1
  });
  await delay(30);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 1
  });
  if (options.midStrokeExpression) {
    await delay(120);
    midStrokeResult = await evaluateRuntime(cdp, options.midStrokeExpression, {
      awaitPromise: true,
      timeoutMs: options.timeoutMs || timeoutMs
    });
  } else {
    await delay(30);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  return midStrokeResult;
}

function runtimeAirbrushChecks(prepared, painted, midStrokePainted = null) {
  const projectionCalls = Number(painted?.validation?.projectionCalls) || 0;
  const projectionChanged = Number(painted?.validation?.projectionChanged) || 0;
  const webGpuPaintCalls = Number(painted?.validation?.timings?.webGpuPaintCalls) || 0;
  const webGpuStats = painted?.lastWebGpuPaintStats || painted?.webGpuStatus?.lastPaintStats || null;
  const activeLayerAlphaCount = Number(painted?.activeLayerAlpha?.count) || 0;
  const activeLayerAlphaSum = Number(painted?.activeLayerAlpha?.sum) || 0;
  const activeLayerReceivedPaint = activeLayerAlphaCount > 0 && activeLayerAlphaSum > 0;
  const surfaceDeltaSamples = Number(painted?.surfacePaintDelta?.changedSamples) || 0;
  const surfaceDeltaSum = Number(painted?.surfacePaintDelta?.sumAbsDelta) || 0;
  const surfaceReceivedPaint = surfaceDeltaSamples > 0 && surfaceDeltaSum > 0;
  const viewerReceivedPaint = painted?.viewerPaintDelta?.changed === true;
  const viewportReceivedPaintColor = painted?.viewerPaintColorDelta?.changed === true;
  const midStrokeViewerReceivedPaint = midStrokePainted?.viewerPaintDelta?.changed === true;
  const midStrokeViewportReceivedPaintColor = midStrokePainted?.viewerPaintColorDelta?.changed === true;
  const midStrokeLiveDisplayWorkPixels = Number(midStrokePainted?.liveDisplayWorkPixels) || 0;
  const midStrokeLiveDisplayStats = Number(midStrokePainted?.liveDisplayPaintStatsCount) || 0;
  const midStrokeStatsDelta = Number(midStrokePainted?.webGpuPaintStatsCountDelta) || 0;
  const webGpuChanged = Boolean(webGpuStats)
    && painted?.screenStrokeChanged === true
    && (
      Number(painted?.webGpuPaintStatsCount) > 0
      || Number(webGpuStats?.appliedBytes) > 0
      || webGpuStats?.deferredReadbackCopy === true
    );
  return {
    editorReady: prepared?.ready === true,
    assetLoaded: prepared?.loaded === true,
    paintRecordsAvailable: Number(prepared?.paintRecords) > 0,
    paintableHit: prepared?.hitFound === true,
    activeAirbrush: painted?.activeTool === "airbrush",
    pointerReachedCanvas: Number(painted?.validation?.pointerDowns) > 0,
    paintPathCalled: Number(painted?.validation?.paintEvents) > 0,
    strokeQueued: Number(painted?.validation?.queuedPayloads) > 0,
    paintBackendCalled: projectionCalls > 0 || webGpuPaintCalls > 0 || Boolean(webGpuStats),
    midStrokeStillPainting: midStrokePainted?.painting === true,
    midStrokeRealtimePaint: midStrokePainted?.painting === true
      && midStrokePainted?.screenStrokeChanged === true
      && midStrokeStatsDelta > 0
      && midStrokeLiveDisplayStats > 0
      && midStrokeLiveDisplayWorkPixels > 0
      && midStrokeViewerReceivedPaint
      && midStrokeViewportReceivedPaintColor,
    paintPixelsChanged: (projectionChanged > 0 || webGpuChanged) && (activeLayerReceivedPaint || surfaceReceivedPaint),
    surfaceReceivedPaint,
    viewerReceivedPaint,
    viewportReceivedPaintColor,
    midStrokeViewerReceivedPaint,
    midStrokeViewportReceivedPaintColor,
    screenStrokeChanged: painted?.screenStrokeChanged === true,
    queueDrained: Number(painted?.queueLength) === 0 && Number(painted?.pendingBatches) === 0
  };
}

function runtimeLayerAfterUndoChecks(layerSetup, layerPainted) {
  const afterUndoPaintRows = layerSetup?.afterUndo?.rows || [];
  const afterAddLayers = layerSetup?.afterAdd?.layers || [];
  const afterPaintLayers = layerPainted?.layers || [];
  return {
    undoAfterBackgroundPaintSucceeded: layerSetup?.undoResult === true,
    undoAfterBackgroundPaintReturnedPromptly: Number(layerSetup?.undoDurationMs) < 750,
    undoLeftOnlyBackgroundVisible: afterUndoPaintRows.length === 1
      && afterUndoPaintRows[0]?.locked === true
      && /Background/.test(afterUndoPaintRows[0]?.text || ""),
    addLayerAfterUndoSucceeded: layerSetup?.addResult === true,
    addLayerReusedPaint1: afterAddLayers.length === 1
      && afterAddLayers[0]?.name === "Paint 1"
      && afterAddLayers[0]?.autoCreated === false,
    noPaint2AfterUndoLayerAdd: !afterAddLayers.some((layer) => layer?.name === "Paint 2"),
    layerPaintPathCalled: Number(layerPainted?.validation?.paintEvents) > 0,
    layerStrokeQueued: Number(layerPainted?.validation?.queuedPayloads) > 0,
    layerProjectionCalled: Number(layerPainted?.validation?.projectionCalls) > 0,
    layerProjectedPixelsChanged: Number(layerPainted?.validation?.projectionChanged) > 0,
    layerPaintQueueDrained: Number(layerPainted?.queueLength) === 0 && Number(layerPainted?.pendingBatches) === 0,
    layerDisplayIncludesPaintBeforeReadback: layerPainted?.displayBeforeReadback?.includesActiveLayer === true,
    layerForceCompositeFlagConsumed: layerPainted?.displayBeforeReadback?.forceDisplayCompositeOnce === false,
    layerCanvasReceivedPaint: Number(layerPainted?.activeLayerAlpha?.count) > 0,
    noPaint2AfterLayerPaint: !afterPaintLayers.some((layer) => layer?.name === "Paint 2")
  };
}

function runtimeThirdLayerChecks(steps) {
  const third = steps?.[2]?.layerResult || null;
  const thirdLayer = third?.layers?.find((layer) => layer.name === "Paint 3") || null;
  const activeLayer = third?.layers?.find((layer) => layer.id === third?.activeLayerId) || null;
  return {
    thirdLayerStepsCompleted: Array.isArray(steps) && steps.length === 3,
    thirdLayerCreatedOnce: (third?.layers || []).filter((layer) => layer.name === "Paint 3").length === 1,
    thirdLayerIsActive: Boolean(thirdLayer?.id && thirdLayer.id === third?.activeLayerId),
    thirdLayerPaintPathCalled: Number(third?.validation?.paintEvents) > 0,
    thirdLayerStrokeQueued: Number(third?.validation?.queuedPayloads) > 0,
    thirdLayerProjectionChanged: Number(third?.validation?.projectionChanged) > 0,
    thirdLayerQueueDrained: Number(third?.queueLength) === 0 && Number(third?.pendingBatches) === 0,
    thirdLayerGpuTargetChanged: Number(thirdLayer?.gpuTarget?.paintRevision) > 0,
    thirdLayerCanvasReceivedPaint: Number(thirdLayer?.alpha?.count) > 0,
    thirdLayerDisplayIncludesPaintBeforeReadback: third?.displayBeforeReadback?.includesActiveLayer === true,
    thirdLayerTargetMatchesActiveLayer: Boolean(activeLayer && thirdLayer && activeLayer.id === thirdLayer.id)
  };
}

function runtimeAfterOrbitNeighborChecks(result) {
  const secondDeltas = Array.isArray(result?.secondAlphaDeltas) ? result.secondAlphaDeltas : [];
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    paintRecordsAvailable: Number(result?.paintRecords) > 0,
    neighborEnabled: result?.neighborEnabled === true,
    paintLayerCreated: result?.layerAdded === true,
    firstVisibleHitFound: result?.firstHitFound === true,
    secondVisibleHitsFound: Number(result?.secondHitCount) >= 2,
    firstStrokeQueued: Number(result?.validation?.byPhase?.first?.queuedPayloads) > 0,
    firstStrokeProjected: Number(result?.firstProjectionChanged) > 0,
    firstStrokeAddedAlpha: Number(result?.firstAlphaDelta) > 0,
    orbitChangedCamera: Number(result?.validation?.cameraChangedCalls) > 0,
    orbitToolSwitchFlushedWhileAirbrush: result?.validation?.toolSwitchFlushUnderAirbrush === true,
    orbitToolSwitchHadQueuedPaint: result?.validation?.toolSwitchHadQueuedPaint === true,
    neighborStayedEnabledAfterOrbit: result?.neighborStayedEnabledAfterOrbit === true,
    noNeighborModeResetAfterOrbit: !(result?.validation?.neighborModeSetCalls || [])
      .some((call) => String(call?.phase || "") !== "setup"),
    secondNeighborProjectionUsed: Number(result?.validation?.neighborProjectionCalls) > 0,
    secondStrokesProjected: Number(result?.secondProjectionChanged) > 0,
    secondStrokesAddedAlpha: Number(result?.secondAlphaDelta) > 0,
    multipleSecondStrokesStuck: secondDeltas.filter((delta) => Number(delta) > 0).length >= 2,
    secondStrokePathCovered: Number(result?.secondPathCoverage?.visibleSamples) >= 6
      && Number(result?.secondPathCoverage?.coverageRatio) >= 0.75,
    visibleOnlyNeighborCutoffConfigured: result?.cameraFacingNormalGate === "webgpu-visible-surface-mask",
    queueDrained: Number(result?.queueLength) === 0 && Number(result?.pendingBatches) === 0,
    activeAirbrushAfterValidation: result?.activeTool === "airbrush"
  };
}

function runtimeSideEdgeSoftnessChecks(result) {
  const edgeRows = Number(result?.edgeMetrics?.edgeRows) || 0;
  const fragmentedEdgeRowRatio = Number(result?.edgeMetrics?.fragmentedEdgeRowRatio) || 0;
  const edgeSoftSampleRatio = Number(result?.edgeMetrics?.edgeSoftSampleRatio) || 0;
  const hardTransitionRatio = Number(result?.edgeMetrics?.hardTransitionRatio) || 1;
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    paintRecordsAvailable: Number(result?.paintRecords) > 0,
    sideHitFound: result?.sideHitFound === true,
    paintLayerCreated: result?.layerAdded === true,
    strokeProjected: result?.lastWebGpuPaintStats?.screenProjectedCoverageActive === true
      && Number(result?.lastWebGpuPaintStats?.screenProjectedStrokeSegmentCount) > 0,
    layerReceivedPaint: Number(result?.alphaStats?.count) > 0,
    enoughVisibleSamples: Number(result?.edgeMetrics?.visibleSamples) >= 80,
    insideMostlyCovered: Number(result?.edgeMetrics?.insideCoverageRatio) >= 0.82,
    insideHolesLimited: Number(result?.edgeMetrics?.insideHoleRatio) <= 0.16,
    softEdgeSamplesPresent: Number(result?.edgeMetrics?.edgeSoftSampleRatio) >= 0.06,
    hardTransitionsLimited: Number(result?.edgeMetrics?.hardTransitionRatio) <= 0.58,
    edgeRowsNotFragmented: fragmentedEdgeRowRatio <= 0.34
      || (
        edgeRows <= 1
        && edgeSoftSampleRatio >= 0.4
        && hardTransitionRatio <= 0.05
      ),
    queueDrained: Number(result?.queueLength) === 0 && Number(result?.pendingBatches) === 0,
    activeAirbrushAfterValidation: result?.activeTool === "airbrush"
  };
}

function runtimeSideEdgeSoftnessExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flushPaint = async () => {
      for (let index = 0; index < 24; index += 1) {
        const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
        if (pending && typeof pending.then === "function") {
          await pending;
        }
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(25);
      }
      await editor.flushTextureAirbrushPendingWebGpuPaints?.({
        deferredCanvasSyncTileBytes: false,
        deferredCanvasSyncMaxTiles: false,
        canvasSyncApplyBudgetMs: 0
      });
      await delay(80);
    };
    const assets = [
      {
        key: "airbrush-runtime:test-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "test",
        path: "assets/models/animation-library/test/walking-8.fbx",
        url: "./assets/models/animation-library/test/walking-8.fbx",
        engine: true,
        demo: true
      },
      {
        key: "airbrush-runtime:etes-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "etes",
        path: "assets/models/animation-library/etes/walking-8.fbx",
        url: "./assets/models/animation-library/etes/walking-8.fbx",
        engine: true,
        demo: true
      }
    ];
    let loadedAsset = "";
    let loadError = "";
    for (const asset of assets) {
      try {
        const loaded = await editor.loadAnimationLibraryAsset(asset);
        if (loaded && editor.model) {
          loadedAsset = asset.path;
          break;
        }
        loadError = "load returned without a model";
      } catch (error) {
        loadError = error?.message || String(error);
      }
    }
    if (!loadedAsset) {
      return { ready: false, loaded: false, error: "asset-load-failed", loadError };
    }
    for (let index = 0; index < 8; index += 1) {
      await waitFrame();
    }
    editor.setTool?.("airbrush");
    editor.textureAirbrushCaptureCandidateDebug = true;
    editor.setTexturePaintNeighborMode?.(false, { status: false });
    if (editor.textureBrushRadius) {
      editor.textureBrushRadius.value = "34";
    }
    if (editor.textureBrushOpacity) {
      editor.textureBrushOpacity.value = "0.42";
    }
    if (editor.textureBrushSpacing) {
      editor.textureBrushSpacing.value = "1";
    }
    if (editor.textureBrushHardness) {
      editor.textureBrushHardness.value = "0.38";
    }
    if (editor.textureBrushScatter) {
      editor.textureBrushScatter.value = "0.36";
    }
    if (editor.texturePaintColor) {
      editor.texturePaintColor.value = "#ff7a3d";
      editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
      editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
    }
    if (editor.textureVisibleEdgeMode) {
      editor.textureVisibleEdgeMode.value = "soft";
      editor.textureVisibleEdgeMode.dispatchEvent?.(new Event("input", { bubbles: true }));
      editor.textureVisibleEdgeMode.dispatchEvent?.(new Event("change", { bubbles: true }));
    }
    if (editor.texturePressureRadius) {
      editor.texturePressureRadius.checked = false;
    }
    if (editor.texturePressureOpacity) {
      editor.texturePressureOpacity.checked = false;
    }
    editor.updateRangeOutputs?.();
    editor.textureAirbrushInvalidateBrushSettings?.();
    editor.setCameraPreset?.("right");
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 8; index += 1) {
      await waitFrame();
    }
    editor.render?.();

    const rect = editor.canvas?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) {
      return { ready: false, loaded: Boolean(editor.model), loadedAsset, error: "missing-canvas-rect" };
    }
    if (editor.canvas) {
      editor.canvas.setPointerCapture = () => {};
      editor.canvas.releasePointerCapture = () => {};
    }
    const validation = {
      pointerDowns: 0,
      paintEvents: 0,
      queuedPayloads: 0,
      projectionCalls: 0,
      projectionChanged: 0
    };
    const originalOnPointerDown = editor.onPointerDown?.bind(editor);
    const originalPaintTextureStrokeFromEvent = editor.paintTextureStrokeFromEvent?.bind(editor);
    const originalQueuePayload = editor.textureAirbrushQueueScreenStrokePayload?.bind(editor);
    const originalProjection = editor.textureAirbrushProjectedMeshFromEvent?.bind(editor);
    editor.onPointerDown = function(event) {
      validation.pointerDowns += 1;
      return originalOnPointerDown?.(event);
    };
    editor.paintTextureStrokeFromEvent = function(event, options = {}) {
      validation.paintEvents += 1;
      return originalPaintTextureStrokeFromEvent?.(event, options);
    };
    editor.textureAirbrushQueueScreenStrokePayload = function(payload) {
      const queued = originalQueuePayload?.(payload);
      if (queued) {
        validation.queuedPayloads += 1;
      }
      return queued;
    };
    editor.textureAirbrushProjectedMeshFromEvent = function(event, options = {}) {
      validation.projectionCalls += 1;
      const changed = originalProjection?.(event, options) || 0;
      validation.projectionChanged += Number(changed) || 0;
      return changed;
    };
    window.__airbrushRuntimeValidation = validation;

    const eventAt = (clientX, clientY, buttons = 1) => ({
      clientX,
      clientY,
      button: 0,
      buttons,
      pointerId: 711,
      pointerType: "mouse",
      pressure: 0.75,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const hitAt = (clientX, clientY) => editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush") || null;
    const viewNormalZForPaintHit = (paintHit) => {
      const normal = paintHit?.hit?.face?.normal?.clone?.() || null;
      const object = paintHit?.record?.object || paintHit?.hit?.object || null;
      if (!normal || !object || !editor.camera) {
        return null;
      }
      object.updateMatrixWorld?.(true);
      editor.camera.updateMatrixWorld?.(true);
      normal.transformDirection?.(object.matrixWorld);
      normal.transformDirection?.(editor.camera.matrixWorldInverse);
      const z = Number(normal.z);
      return Number.isFinite(z) ? z : null;
    };
    const candidates = [];
    const xFractions = [0.78, 0.75, 0.72, 0.69, 0.66, 0.63, 0.60, 0.57, 0.54, 0.51, 0.48, 0.45, 0.42];
    const yFractions = [0.48, 0.52, 0.56, 0.60, 0.64, 0.68, 0.44, 0.72, 0.40, 0.76];
    for (const yFraction of yFractions) {
      for (const xFraction of xFractions) {
        const clientX = rect.left + rect.width * xFraction;
        const clientY = rect.top + rect.height * yFraction;
        const hit = hitAt(clientX, clientY);
        if (hit?.record && hit?.hit) {
          const viewNormalZ = viewNormalZForPaintHit(hit);
          const cameraFacing = Number.isFinite(viewNormalZ) ? viewNormalZ : 1;
          const grazingScore = cameraFacing > 0
            ? 1 - Math.min(1, Math.abs(cameraFacing - 0.12) / 0.42)
            : -2;
          const centerBandScore = 1 - Math.min(1, Math.abs(yFraction - 0.58) / 0.26);
          const score = grazingScore * 8 + xFraction * 1.5 + centerBandScore;
          candidates.push({ clientX, clientY, xFraction, yFraction, hit, viewNormalZ, score });
        }
      }
    }
    candidates.sort((left, right) => right.score - left.score || right.clientX - left.clientX);
    const sideHit = candidates[0] || null;
    if (!sideHit) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        loadedAsset,
        paintRecords: editor.paintRecords?.length || 0,
        error: "missing-side-hit",
        validation
      };
    }
    const firstMaterial = editor.clonePaintMaterialForHit?.(sideHit.hit.record, sideHit.hit.hit) || editor.texturePaintFirstLayerMaterial?.() || null;
    if (firstMaterial) {
      editor.texturePaintActiveMaterial = firstMaterial;
    }
    const layerAdded = editor.addTexturePaintLayer?.() === true;
    await waitFrame();
    const material = editor.texturePaintActiveMaterial || firstMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
    const stack = material?.userData?.texturePaintLayerStack || null;
    const activeLayer = (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId) || null;
    const radius = 34;
    const centerX = Math.max(rect.left + 90, Math.min(rect.right - 45, sideHit.clientX - 12));
    const centerY = Math.max(rect.top + 130, Math.min(rect.bottom - 80, sideHit.clientY));
    const strokeRows = [-38, -18, 2, 22, 42];
    const strokes = strokeRows.map((offsetY) => ({
      start: { x: Math.max(rect.left + 4, centerX - 78), y: centerY + offsetY },
      mid: { x: centerX - 12, y: centerY + offsetY },
      end: { x: Math.min(rect.right - 4, centerX + 50), y: centerY + offsetY }
    }));
    const paintStroke = async (stroke) => {
      editor.onPointerDown?.(eventAt(stroke.start.x, stroke.start.y, 1));
      await waitFrame();
      const steps = 8;
      for (let index = 1; index <= steps; index += 1) {
        const ratio = index / steps;
        const x = stroke.start.x + (stroke.end.x - stroke.start.x) * ratio;
        const y = stroke.start.y + (stroke.end.y - stroke.start.y) * ratio;
        editor.onPointerMove?.(eventAt(x, y, 1));
        await waitFrame();
      }
      editor.onPointerUp?.(eventAt(stroke.end.x, stroke.end.y, 0));
      await flushPaint();
    };
    for (const stroke of strokes) {
      await paintStroke(stroke);
    }
    await flushPaint();
    await editor.flushTextureAirbrushPendingWebGpuPaints?.({
      deferredCanvasSyncTileBytes: false,
      deferredCanvasSyncMaxTiles: false,
      canvasSyncApplyBudgetMs: 0
    });
    editor.flushTexturePaintLayerGpuTargetsToCanvases?.({ material, composite: true });
    editor.render?.();

    const layerCanvas = activeLayer?.canvas || null;
    const layerContext = layerCanvas?.getContext?.("2d", { willReadFrequently: true }) || null;
    const layerReferenceTexture = material?.userData?.clonePaintTexture
      || material?.userData?.clonePaintOriginalMap
      || material?.map
      || null;
    const alphaAtHit = (paintHit) => {
      const uv = paintHit?.hit?.uv || null;
      if (!uv || !layerCanvas || !layerContext) {
        return null;
      }
      const centerPixel = editor.clonePaintPixelFromUv?.(uv, layerCanvas, layerReferenceTexture, { wrap: true }) || null;
      if (!Number.isFinite(Number(centerPixel?.x)) || !Number.isFinite(Number(centerPixel?.y))) {
        return null;
      }
      const centerPixelX = Math.max(0, Math.min(layerCanvas.width - 1, Math.round(Number(centerPixel.x))));
      const centerPixelY = Math.max(0, Math.min(layerCanvas.height - 1, Math.round(Number(centerPixel.y))));
      let alpha = 0;
      for (let y = Math.max(0, centerPixelY - 1); y <= Math.min(layerCanvas.height - 1, centerPixelY + 1); y += 1) {
        for (let x = Math.max(0, centerPixelX - 1); x <= Math.min(layerCanvas.width - 1, centerPixelX + 1); x += 1) {
          alpha = Math.max(alpha, layerContext.getImageData(x, y, 1, 1).data[3]);
        }
      }
      return alpha;
    };
    const distanceToSegment = (point, segment) => {
      const dx = segment.end.x - segment.start.x;
      const dy = segment.end.y - segment.start.y;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0.0001
        ? Math.max(0, Math.min(1, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSq))
        : 0;
      const closestX = segment.start.x + dx * t;
      const closestY = segment.start.y + dy * t;
      const pointDx = point.x - closestX;
      const pointDy = point.y - closestY;
      return Math.sqrt(pointDx * pointDx + pointDy * pointDy);
    };
    const distanceToStroke = (point) => {
      let best = Infinity;
      for (const stroke of strokes) {
        best = Math.min(best, distanceToSegment(point, stroke));
      }
      return best;
    };
    const samples = [];
    const sampleByKey = new Map();
    const step = 5;
    let rowIndex = 0;
    for (let y = centerY - 86; y <= centerY + 86; y += step, rowIndex += 1) {
      let columnIndex = 0;
      for (let x = centerX - 100; x <= centerX + 72; x += step, columnIndex += 1) {
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          continue;
        }
        const paintHit = hitAt(x, y);
        if (!paintHit?.record || !paintHit?.hit) {
          continue;
        }
        const alpha = alphaAtHit(paintHit);
        if (!Number.isFinite(Number(alpha))) {
          continue;
        }
        const viewNormalZ = viewNormalZForPaintHit(paintHit);
        const normalNumber = Number(viewNormalZ);
        if (viewNormalZ != null && Number.isFinite(normalNumber) && normalNumber <= 0) {
          continue;
        }
        const distance = distanceToStroke({ x, y });
        if (distance > radius * 1.45) {
          continue;
        }
        const sampleMaterial = editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null;
        const sample = {
          x,
          y,
          rowIndex,
          columnIndex,
          distance,
          alpha,
          viewNormalZ,
          materialName: sampleMaterial?.name || "",
          materialMatchesActive: sampleMaterial === material
        };
        samples.push(sample);
        sampleByKey.set(rowIndex + ":" + columnIndex, sample);
      }
    }
    const insideSamples = samples.filter((sample) => sample.distance <= radius * 0.68);
    const insidePainted = insideSamples.filter((sample) => sample.alpha > 8);
    const insideHoles = insideSamples.filter((sample) => sample.alpha <= 8);
    const edgeBandSamples = samples.filter((sample) => sample.distance > radius * 0.68 && sample.distance <= radius * 1.22);
    const edgeSoftSamples = edgeBandSamples.filter((sample) => sample.alpha >= 16 && sample.alpha <= 230);
    const edgePaintedSamples = edgeBandSamples.filter((sample) => sample.alpha > 8);
    let adjacentPairs = 0;
    let hardTransitions = 0;
    const rows = new Map();
    for (const sample of samples) {
      const row = rows.get(sample.rowIndex) || [];
      row.push(sample);
      rows.set(sample.rowIndex, row);
      for (const neighborKey of [
        sample.rowIndex + ":" + (sample.columnIndex + 1),
        (sample.rowIndex + 1) + ":" + sample.columnIndex
      ]) {
        const neighbor = sampleByKey.get(neighborKey);
        if (!neighbor) {
          continue;
        }
        adjacentPairs += 1;
        const low = Math.min(sample.alpha, neighbor.alpha);
        const high = Math.max(sample.alpha, neighbor.alpha);
        if (low <= 18 && high >= 190) {
          hardTransitions += 1;
        }
      }
    }
    let edgeRows = 0;
    let fragmentedEdgeRows = 0;
    const materialSampleSummary = {};
    for (const sample of samples) {
      const key = sample.materialName || "(unnamed)";
      const entry = materialSampleSummary[key] || {
        samples: 0,
        inside: 0,
        insideHoles: 0,
        active: sample.materialMatchesActive === true
      };
      entry.samples += 1;
      if (sample.distance <= radius * 0.68) {
        entry.inside += 1;
        if (sample.alpha <= 8) {
          entry.insideHoles += 1;
        }
      }
      entry.active = entry.active || sample.materialMatchesActive === true;
      materialSampleSummary[key] = entry;
    }
    for (const row of rows.values()) {
      row.sort((left, right) => left.columnIndex - right.columnIndex);
      const edgeRowSamples = row.filter((sample) => sample.distance <= radius * 1.22);
      if (edgeRowSamples.length < 5) {
        continue;
      }
      const paintedStates = edgeRowSamples.map((sample) => sample.alpha > 32);
      const paintedCount = paintedStates.filter(Boolean).length;
      const emptyCount = paintedStates.length - paintedCount;
      if (paintedCount < 2 || emptyCount < 2) {
        continue;
      }
      let transitions = 0;
      for (let index = 1; index < paintedStates.length; index += 1) {
        if (paintedStates[index] !== paintedStates[index - 1]) {
          transitions += 1;
        }
      }
      edgeRows += 1;
      if (transitions > 2) {
        fragmentedEdgeRows += 1;
      }
    }
    const alphaStats = (() => {
      if (!layerCanvas || !layerContext) {
        return { count: 0, sum: 0 };
      }
      const image = layerContext.getImageData(0, 0, layerCanvas.width, layerCanvas.height).data;
      let count = 0;
      let sum = 0;
      for (let index = 3; index < image.length; index += 4) {
        const alpha = image[index];
        if (alpha > 0) {
          count += 1;
          sum += alpha;
        }
      }
      return { count, sum };
    })();
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      paintRecords: editor.paintRecords?.length || 0,
      activeTool: editor.activeTool,
      rendererMode: editor.textureAirbrushRendererMode || "",
      webGpuStatus: editor.textureAirbrushWebGpuRuntimeStatus?.() || null,
      lastBackend: editor.textureAirbrushLastBackend || null,
      lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
      webGpuPaintStatsCount: Array.isArray(editor.textureAirbrushWebGpuPaintStats)
        ? editor.textureAirbrushWebGpuPaintStats.length
        : 0,
      lastWebGpuCandidateDebug: editor.textureAirbrushLastWebGpuCandidateDebug || null,
      debugDataset: Object.fromEntries(Object.entries(document.documentElement?.dataset || {})
        .filter(([key]) => key.startsWith("textureAirbrushDebug"))),
      debugLogTail: Array.isArray(window.__textureAirbrushDebugLog)
        ? window.__textureAirbrushDebugLog.slice(-8)
        : [],
      layerAdded,
      sideHitFound: Boolean(sideHit),
      sideHit: {
        xFraction: sideHit.xFraction,
        yFraction: sideHit.yFraction,
        viewNormalZ: sideHit.viewNormalZ,
        score: sideHit.score
      },
      alphaStats,
      edgeMetrics: {
        visibleSamples: samples.length,
        insideSamples: insideSamples.length,
        insidePainted: insidePainted.length,
        insideHoles: insideHoles.length,
        insideCoverageRatio: insideSamples.length ? insidePainted.length / insideSamples.length : 0,
        insideHoleRatio: insideSamples.length ? insideHoles.length / insideSamples.length : 1,
        edgeBandSamples: edgeBandSamples.length,
        edgePaintedSamples: edgePaintedSamples.length,
        edgeSoftSamples: edgeSoftSamples.length,
        edgeSoftSampleRatio: edgeBandSamples.length ? edgeSoftSamples.length / edgeBandSamples.length : 0,
        adjacentPairs,
        hardTransitions,
        hardTransitionRatio: adjacentPairs ? hardTransitions / adjacentPairs : 1,
        edgeRows,
        fragmentedEdgeRows,
        fragmentedEdgeRowRatio: edgeRows ? fragmentedEdgeRows / edgeRows : 0,
        materialSampleSummary,
        alphaPreview: samples.slice(0, 80).map((sample) => sample.alpha)
      },
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      validation
    };
  })()`;
}

function runtimeAfterOrbitMacroExpression(macroName = "after-orbit-paint") {
  const macroNameLiteral = JSON.stringify(String(macroName || "after-orbit-paint"));
  const captureHitCallersLiteral = captureHitCallers ? "true" : "false";
  return `(async () => {
    const macroName = ${macroNameLiteral};
    const captureHitCallers = ${captureHitCallersLiteral};
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flushPaint = async () => {
      for (let index = 0; index < 24; index += 1) {
        const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
        if (pending && typeof pending.then === "function") {
          await pending;
        }
        const webGpuPending = editor.flushTextureAirbrushPendingWebGpuPaints?.();
        if (webGpuPending && typeof webGpuPending.then === "function") {
          await webGpuPending;
        }
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(25);
      }
      const finalWebGpuPending = editor.flushTextureAirbrushPendingWebGpuPaints?.();
      if (finalWebGpuPending && typeof finalWebGpuPending.then === "function") {
        await finalWebGpuPending;
      }
      await delay(80);
    };
    const assets = [
      {
        key: "airbrush-runtime:test-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "test",
        path: "assets/models/animation-library/test/walking-8.fbx",
        url: "./assets/models/animation-library/test/walking-8.fbx",
        engine: true,
        demo: true
      },
      {
        key: "airbrush-runtime:etes-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "etes",
        path: "assets/models/animation-library/etes/walking-8.fbx",
        url: "./assets/models/animation-library/etes/walking-8.fbx",
        engine: true,
        demo: true
      }
    ];
    let loadedAsset = "";
    let loadError = "";
    for (const asset of assets) {
      try {
        await editor.loadAnimationLibraryAsset(asset);
        loadedAsset = asset.path;
        break;
      } catch (error) {
        loadError = error?.message || String(error);
      }
    }
    if (!loadedAsset) {
      return { ready: false, loaded: false, error: "asset-load-failed", loadError };
    }
    await editor.loadPackagedTutorialMacros?.();
    const macro = editor.tutorialMacro?.(macroName) || null;
    if (!macro?.events?.length) {
      return { ready: false, loaded: true, loadedAsset, macroLoaded: false, requestedMacro: macroName, error: "missing-repro-macro" };
    }
    const macroEvents = editor.tutorialMacroPlaybackEvents?.(macro) || [...macro.events].sort((left, right) => left.t - right.t);
    const airbrushStrokes = [];
    let currentStroke = null;
    for (const event of macroEvents) {
      if (event?.type !== "pointer" || event.tool !== "airbrush") {
        continue;
      }
      if (event.kind === "down") {
        currentStroke = { events: [event] };
      } else if (currentStroke) {
        currentStroke.events.push(event);
        if (event.kind === "up") {
          airbrushStrokes.push(currentStroke);
          currentStroke = null;
        }
      }
    }
    const secondStroke = airbrushStrokes.at(-1) || null;
    const startCamera = macroEvents.find((event) => event?.type === "camera" && event.reason === "start" && event.camera);
    if (startCamera?.camera) {
      editor.applyTutorialMacroCameraSnapshot?.(startCamera.camera);
    }
    for (let index = 0; index < 6; index += 1) {
      await waitFrame();
    }
    editor.render?.();
    const validation = {
      pointerDowns: 0,
      paintEvents: 0,
      queuedPayloads: 0,
      projectionCalls: 0,
      projectionChanged: 0,
      neighborProjectionCalls: 0,
      neighborProjectionRewarmedCalls: 0,
      postCameraProjectionRewarmedCalls: 0,
      cameraChangedCalls: 0,
      neighborModeSetCalls: [],
      timings: {
        projectionMs: 0,
        projectionMaxMs: 0,
        queuePayloadMs: 0,
        queuePayloadMaxMs: 0,
        webGpuPaintCalls: 0,
        webGpuPaintMs: 0,
        webGpuPaintMaxMs: 0,
        webGpuCandidatesCalls: 0,
        webGpuCandidatesMs: 0,
        webGpuCandidatesMaxMs: 0,
        webGpuStrokeCandidateCalls: 0,
        webGpuStrokeCandidateMs: 0,
        webGpuStrokeCandidateMaxMs: 0,
        hitTestCalls: 0,
        hitTestMs: 0,
        hitTestMaxMs: 0,
        webGpuFlushCalls: 0,
        webGpuFlushReturnMs: 0,
        webGpuFlushReturnMaxMs: 0,
        webGpuFlushSettledMs: 0,
        webGpuFlushSettledMaxMs: 0
      },
      hitTestCallers: {},
      byPhase: {}
    };
    let phase = "setup";
    let seenOrbit = false;
    let beforeSecondStrokeSnapshot = null;
    let beforeSecondStrokeEventPoint = null;
    const snapshotLayerCanvases = () => {
      editor.flushTexturePaintLayerGpuTargetsToCanvases?.({ composite: true });
      const canvases = new WeakMap();
      let layerCount = 0;
      let pixelCount = 0;
      const materials = editor.textureAirbrushPaintableMaterials?.() || [];
      for (const entry of materials) {
        const material = entry?.material || entry || null;
        const stack = material?.userData?.texturePaintLayerStack || null;
        const layer = (stack?.layers || []).find((item) => item.id === stack?.activeLayerId) || null;
        const canvas = layer?.canvas || null;
        const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
        if (!canvas?.width || !canvas?.height || !context) {
          continue;
        }
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        canvases.set(canvas, {
          width: canvas.width,
          height: canvas.height,
          data: new Uint8ClampedArray(image.data)
        });
        layerCount += 1;
        pixelCount += canvas.width * canvas.height;
      }
      return { canvases, layerCount, pixelCount };
    };
    const phaseStats = () => {
      validation.byPhase[phase] ||= {
        pointerDowns: 0,
        paintEvents: 0,
        queuedPayloads: 0,
        projectionCalls: 0,
        projectionChanged: 0,
        neighborProjectionCalls: 0,
        neighborProjectionRewarmedCalls: 0,
        postCameraProjectionRewarmedCalls: 0
      };
      return validation.byPhase[phase];
    };
    const originalApplyMacroEvent = editor.applyTutorialMacroEvent?.bind(editor);
    const originalOnPointerDown = editor.onPointerDown?.bind(editor);
    const originalPaintTextureStrokeFromEvent = editor.paintTextureStrokeFromEvent?.bind(editor);
    const originalQueuePayload = editor.textureAirbrushQueueScreenStrokePayload?.bind(editor);
    const originalProjection = editor.textureAirbrushProjectedMeshFromEvent?.bind(editor);
    const originalWebGpuPaint = editor.textureAirbrushWebGpuPaintFromEvent?.bind(editor);
    const originalWebGpuCandidates = editor.textureAirbrushWebGpuCandidatesFromEvent?.bind(editor);
    const originalWebGpuStrokeCandidate = editor.textureAirbrushWebGpuStrokeCandidateFromHit?.bind(editor);
    const originalHitForEvent = editor.texturePaintHitForEvent?.bind(editor);
    const originalWebGpuFlush = editor.flushTextureAirbrushQueuedWebGpuStrokes?.bind(editor);
    const originalCameraChanged = editor.textureAirbrushCameraChanged?.bind(editor);
    const originalSetTexturePaintNeighborMode = editor.setTexturePaintNeighborMode?.bind(editor);
    const hitTestCallerKey = () => {
      const stack = String(new Error().stack || "")
        .split("\\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const caller = stack.find((line) => (
        line !== "Error"
        && !line.includes("hitTestCallerKey")
        && !line.includes("editor.texturePaintHitForEvent")
        && !line.includes("texturePaintHitForEvent")
      )) || "unknown";
      return caller
        .replace(/^at\\s+/, "")
        .replace(/^https?:\\/\\/[^/]+\\//, "")
        .replace(/[?#].*$/, "")
        .slice(0, 180);
    };
    editor.applyTutorialMacroEvent = async function(event, nextEvent) {
      let nextPhase = phase;
      if (event?.type === "ui" && event.selector === "#tool-orbit") {
        seenOrbit = true;
        nextPhase = "macro-orbit";
      } else if (event?.type === "tool" && event.tool === "orbit") {
        seenOrbit = true;
        nextPhase = "macro-orbit";
      } else if (event?.type === "pointer" && event.tool === "orbit") {
        seenOrbit = true;
        nextPhase = "macro-orbit";
      } else if (event?.type === "camera" && event.reason === "camera") {
        seenOrbit = true;
        nextPhase = "macro-orbit";
      } else if (event?.type === "ui" && event.selector === "#texture-airbrush-tool") {
        nextPhase = "macro-second";
      } else if (event?.type === "tool" && event.tool === "airbrush") {
        nextPhase = seenOrbit ? "macro-second" : "macro-first";
      } else if (event?.type === "pointer" && event.tool === "airbrush") {
        nextPhase = seenOrbit ? "macro-second" : "macro-first";
      }
      if (
        !beforeSecondStrokeSnapshot
        && nextPhase === "macro-second"
        && event?.type === "pointer"
        && event.tool === "airbrush"
        && event.kind === "down"
      ) {
        phase = "macro-before-second";
        await flushPaint();
        beforeSecondStrokeSnapshot = snapshotLayerCanvases();
        beforeSecondStrokeEventPoint = {
          x: Number(event.x || 0),
          y: Number(event.y || 0)
        };
      }
      phase = nextPhase;
      return originalApplyMacroEvent?.(event, nextEvent);
    };
    editor.onPointerDown = function(event) {
      validation.pointerDowns += 1;
      phaseStats().pointerDowns += 1;
      return originalOnPointerDown?.(event);
    };
    editor.paintTextureStrokeFromEvent = function(event, options = {}) {
      validation.paintEvents += 1;
      phaseStats().paintEvents += 1;
      return originalPaintTextureStrokeFromEvent?.(event, options);
    };
    editor.textureAirbrushQueueScreenStrokePayload = function(payload) {
      const started = performance.now();
      const queued = originalQueuePayload?.(payload);
      const elapsed = performance.now() - started;
      validation.timings.queuePayloadMs += elapsed;
      validation.timings.queuePayloadMaxMs = Math.max(validation.timings.queuePayloadMaxMs, elapsed);
      if (queued) {
        validation.queuedPayloads += 1;
        phaseStats().queuedPayloads += 1;
      }
      return queued;
    };
    editor.textureAirbrushProjectedMeshFromEvent = function(event, options = {}) {
      validation.projectionCalls += 1;
      phaseStats().projectionCalls += 1;
      if (options?.neighborPaintSeed?.enabled) {
        validation.neighborProjectionCalls += 1;
        phaseStats().neighborProjectionCalls += 1;
      }
      if (options?.neighborProjectionRewarmed === true) {
        validation.neighborProjectionRewarmedCalls += 1;
        phaseStats().neighborProjectionRewarmedCalls += 1;
      }
      if (options?.postCameraProjectionRewarmed === true) {
        validation.postCameraProjectionRewarmedCalls += 1;
        phaseStats().postCameraProjectionRewarmedCalls += 1;
      }
      const started = performance.now();
      const changed = originalProjection?.(event, options) || 0;
      const elapsed = performance.now() - started;
      validation.timings.projectionMs += elapsed;
      validation.timings.projectionMaxMs = Math.max(validation.timings.projectionMaxMs, elapsed);
      validation.projectionChanged += Number(changed) || 0;
      phaseStats().projectionChanged += Number(changed) || 0;
      return changed;
    };
    if (originalWebGpuPaint) {
      editor.textureAirbrushWebGpuPaintFromEvent = function(event, options = {}) {
        validation.timings.webGpuPaintCalls += 1;
        const started = performance.now();
        const result = originalWebGpuPaint(event, options);
        const elapsed = performance.now() - started;
        validation.timings.webGpuPaintMs += elapsed;
        validation.timings.webGpuPaintMaxMs = Math.max(validation.timings.webGpuPaintMaxMs, elapsed);
        return result;
      };
    }
    if (originalWebGpuCandidates) {
      editor.textureAirbrushWebGpuCandidatesFromEvent = function(event, options = {}) {
        validation.timings.webGpuCandidatesCalls += 1;
        const started = performance.now();
        const result = originalWebGpuCandidates(event, options);
        const elapsed = performance.now() - started;
        validation.timings.webGpuCandidatesMs += elapsed;
        validation.timings.webGpuCandidatesMaxMs = Math.max(validation.timings.webGpuCandidatesMaxMs, elapsed);
        return result;
      };
    }
    if (originalWebGpuStrokeCandidate) {
      editor.textureAirbrushWebGpuStrokeCandidateFromHit = function(record, hit, event, options = {}) {
        validation.timings.webGpuStrokeCandidateCalls += 1;
        const started = performance.now();
        const result = originalWebGpuStrokeCandidate(record, hit, event, options);
        const elapsed = performance.now() - started;
        validation.timings.webGpuStrokeCandidateMs += elapsed;
        validation.timings.webGpuStrokeCandidateMaxMs = Math.max(validation.timings.webGpuStrokeCandidateMaxMs, elapsed);
        return result;
      };
    }
    if (originalHitForEvent) {
      editor.texturePaintHitForEvent = function(event, mode, options = {}) {
        validation.timings.hitTestCalls += 1;
        const callerKey = captureHitCallers ? hitTestCallerKey() : "";
        if (callerKey) {
          validation.hitTestCallers[callerKey] ||= {
            calls: 0,
            ms: 0,
            maxMs: 0
          };
          validation.hitTestCallers[callerKey].calls += 1;
        }
        const started = performance.now();
        const result = originalHitForEvent(event, mode, options);
        const elapsed = performance.now() - started;
        validation.timings.hitTestMs += elapsed;
        validation.timings.hitTestMaxMs = Math.max(validation.timings.hitTestMaxMs, elapsed);
        if (callerKey) {
          validation.hitTestCallers[callerKey].ms += elapsed;
          validation.hitTestCallers[callerKey].maxMs = Math.max(validation.hitTestCallers[callerKey].maxMs, elapsed);
        }
        return result;
      };
    }
    if (originalWebGpuFlush) {
      editor.flushTextureAirbrushQueuedWebGpuStrokes = function(...args) {
        validation.timings.webGpuFlushCalls += 1;
        const started = performance.now();
        const result = originalWebGpuFlush(...args);
        const returnElapsed = performance.now() - started;
        validation.timings.webGpuFlushReturnMs += returnElapsed;
        validation.timings.webGpuFlushReturnMaxMs = Math.max(validation.timings.webGpuFlushReturnMaxMs, returnElapsed);
        if (result && typeof result.finally === "function") {
          result.finally(() => {
            const settledElapsed = performance.now() - started;
            validation.timings.webGpuFlushSettledMs += settledElapsed;
            validation.timings.webGpuFlushSettledMaxMs = Math.max(
              validation.timings.webGpuFlushSettledMaxMs,
              settledElapsed
            );
          }).catch(() => {});
        }
        return result;
      };
    }
    editor.textureAirbrushCameraChanged = function(...args) {
      validation.cameraChangedCalls += 1;
      return originalCameraChanged?.(...args);
    };
    editor.setTexturePaintNeighborMode = function(enabled, options = {}) {
      validation.neighborModeSetCalls.push({
        phase,
        enabled: enabled === true,
        status: options?.status !== false
      });
      return originalSetTexturePaintNeighborMode?.(enabled, options);
    };
    window.__airbrushRuntimeValidation = validation;
    editor.textureAirbrushCaptureCandidateDebug = true;
    editor.textureAirbrushLastWebGpuCandidateDebug = null;

    editor.setTool?.("airbrush");
    editor.setTexturePaintNeighborMode?.(true, { status: false });
    const rect = editor.canvas?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) {
      return { ready: false, loaded: Boolean(editor.model), loadedAsset, macroLoaded: true, error: "missing-canvas-rect" };
    }
    if (editor.canvas) {
      editor.canvas.setPointerCapture = () => {};
      editor.canvas.releasePointerCapture = () => {};
    }
    const eventAt = (clientX, clientY, buttons = 1) => ({
      clientX,
      clientY,
      button: 0,
      buttons,
      pointerId: 917,
      pointerType: "mouse",
      pressure: 0.7,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const hitAt = (clientX, clientY) => editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush") || null;
    const findHit = () => {
      const xFractions = [0.5, 0.47, 0.53, 0.44, 0.56, 0.41, 0.59, 0.38, 0.62];
      const yFractions = [0.5, 0.54, 0.58, 0.46, 0.62, 0.42, 0.66, 0.38, 0.7];
      for (const yFraction of yFractions) {
        for (const xFraction of xFractions) {
          const clientX = rect.left + rect.width * xFraction;
          const clientY = rect.top + rect.height * yFraction;
          const hit = hitAt(clientX, clientY);
          if (hit?.record && hit?.hit) {
            return { clientX, clientY, hit };
          }
        }
      }
      return null;
    };
    const firstHit = findHit();
    if (!firstHit) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        loadedAsset,
        macroLoaded: true,
        paintRecords: editor.paintRecords?.length || 0,
        error: "missing-visible-hit-before-macro"
      };
    }
    const firstMaterial = editor.clonePaintMaterialForHit?.(firstHit.hit.record, firstHit.hit.hit) || editor.texturePaintFirstLayerMaterial?.() || null;
    if (firstMaterial) {
      editor.texturePaintActiveMaterial = firstMaterial;
    }
    const layerAdded = editor.addTexturePaintLayer?.() === true;
    await waitFrame();
    if (editor.tutorialMacroSpeedSelect) {
      editor.tutorialMacroSpeedSelect.value = "8";
    }
    if (editor.tutorialMacroScrubInput) {
      editor.tutorialMacroScrubInput.value = "0";
    }
    const macroPlayed = await editor.playTutorialMacro?.(macroName, {
      resetDemo: false,
      preservePointerMoves: true,
      requireCurrentScene: true,
      statusIfMissing: false
    });
    phase = "post-macro";
    await flushPaint();
    editor.flushTexturePaintLayerGpuTargetsToCanvases?.({ composite: true });
    const toClientPoint = (event) => ({
      x: rect.left + Number(event.x || 0) * rect.width,
      y: rect.top + Number(event.y || 0) * rect.height
    });
    const neighborSeedForStroke = (stroke) => {
      for (const event of stroke?.events || []) {
        if (event.kind === "up") {
          continue;
        }
        const point = toClientPoint(event);
        const hit = hitAt(point.x, point.y);
        const seed = editor.textureAirbrushNeighborSeedFromHit?.(hit) || null;
        if (seed?.enabled) {
          return seed;
        }
      }
      return null;
    };
    const neighborAllowsSample = (seed, paintHit) => {
      if (!seed?.enabled || !paintHit?.record || !paintHit?.hit) {
        return true;
      }
      const material = editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null;
      const materialIndex = paintHit.hit.face?.materialIndex ?? 0;
      return editor.textureAirbrushNeighborHitAllowed?.(
        seed,
        paintHit.record,
        paintHit.hit,
        material,
        materialIndex
      ) !== false;
    };
    const alphaAtHit = (paintHit, snapshot = null) => {
      const uv = paintHit?.hit?.uv || null;
      const material = paintHit?.record && paintHit?.hit
        ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || firstMaterial
        : firstMaterial;
      const stack = material?.userData?.texturePaintLayerStack || null;
      const layer = (stack?.layers || []).find((item) => item.id === stack?.activeLayerId) || null;
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!uv || !canvas || !context) {
        return null;
      }
      const source = snapshot?.canvases?.get?.(canvas) || null;
      const width = source?.width || canvas.width;
      const height = source?.height || canvas.height;
      const centerX = Math.max(0, Math.min(width - 1, Math.floor(Number(uv.x || 0) * width)));
      const centerY = Math.max(0, Math.min(height - 1, Math.floor((1 - Number(uv.y || 0)) * height)));
      const readAlpha = (x, y) => {
        if (source?.data) {
          return source.data[(y * width + x) * 4 + 3] || 0;
        }
        return context.getImageData(x, y, 1, 1).data[3];
      };
      let alpha = 0;
      for (let y = Math.max(0, centerY - 1); y <= Math.min(height - 1, centerY + 1); y += 1) {
        for (let x = Math.max(0, centerX - 1); x <= Math.min(width - 1, centerX + 1); x += 1) {
          alpha = Math.max(alpha, readAlpha(x, y));
        }
      }
      return alpha;
    };
    const strokeCoverage = (stroke) => {
      const seed = neighborSeedForStroke(stroke);
      const strokeEvents = (stroke?.events || []).filter((event) => event.kind !== "up");
      const step = Math.max(1, Math.floor(strokeEvents.length / 24));
      const samples = [];
      const seen = new Set();
      for (let index = 0; index < strokeEvents.length; index += step) {
        samples.push(strokeEvents[index]);
      }
      if (strokeEvents.length) {
        samples.push(strokeEvents.at(-1));
      }
      const measured = [];
      for (const event of samples) {
        const point = toClientPoint(event);
        const key = Math.round(point.x) + ":" + Math.round(point.y);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const paintHit = hitAt(point.x, point.y);
        if (!paintHit?.record || !paintHit?.hit || !neighborAllowsSample(seed, paintHit)) {
          continue;
        }
        const alpha = alphaAtHit(paintHit);
        if (!Number.isFinite(Number(alpha))) {
          continue;
        }
        measured.push({
          index: strokeEvents.indexOf(event),
          x: point.x,
          y: point.y,
          alpha
        });
      }
      const paintedSamples = measured.filter((sample) => sample.alpha > 0).length;
      const strongAlphaThreshold = 24;
      const strongSamples = measured.filter((sample) => sample.alpha >= strongAlphaThreshold).length;
      const paintedAlphas = measured.map((sample) => sample.alpha).filter((alpha) => alpha > 0);
      const uniformAlphaThreshold = 90;
      const uniformSamples = measured.filter((sample) => sample.alpha === 0 || sample.alpha >= uniformAlphaThreshold).length;
      return {
        visibleSamples: measured.length,
        paintedSamples,
        strongSamples,
        uniformSamples,
        coverageRatio: measured.length ? paintedSamples / measured.length : 0,
        strongCoverageRatio: measured.length ? strongSamples / measured.length : 0,
        uniformCoverageRatio: measured.length ? uniformSamples / measured.length : 0,
        strongAlphaThreshold,
        uniformAlphaThreshold,
        minAlpha: measured.length ? Math.min(...measured.map((sample) => sample.alpha)) : 0,
        maxAlpha: measured.length ? Math.max(...measured.map((sample) => sample.alpha)) : 0,
        paintedMinAlpha: paintedAlphas.length ? Math.min(...paintedAlphas) : 0,
        paintedMaxAlpha: paintedAlphas.length ? Math.max(...paintedAlphas) : 0,
        seedKey: seed?.key || "",
        alphas: measured.map((sample) => sample.alpha),
        weakExamples: measured
          .filter((sample) => sample.alpha > 0 && sample.alpha < 90)
          .slice(0, 12)
          .map((sample) => ({
            index: sample.index,
            x: Math.round(sample.x),
            y: Math.round(sample.y),
            alpha: sample.alpha
          }))
      };
    };
    const strokePathPoints = (stroke) => (stroke?.events || [])
      .filter((event) => event.kind !== "up")
      .map(toClientPoint)
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const macroBrushRadiusPixels = () => {
      const screenRadius = Number(editor.textureBrushRadiusScreenPixels?.());
      if (Number.isFinite(screenRadius) && screenRadius > 0) {
        return screenRadius;
      }
      const valueRadius = Number(editor.textureBrushRadiusValue?.());
      if (Number.isFinite(valueRadius) && valueRadius > 0) {
        return Math.max(1, valueRadius * Math.max(rect.width, rect.height));
      }
      return 10;
    };
    const distanceToSegment = (point, start, end) => {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq <= 0.0001) {
        return Math.hypot(point.x - start.x, point.y - start.y);
      }
      const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
      return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
    };
    const distanceToStrokePath = (point, path) => {
      if (!path.length) {
        return Infinity;
      }
      if (path.length === 1) {
        return Math.hypot(point.x - path[0].x, point.y - path[0].y);
      }
      let distance = Infinity;
      for (let index = 1; index < path.length; index += 1) {
        distance = Math.min(distance, distanceToSegment(point, path[index - 1], path[index]));
      }
      return distance;
    };
    const strokeBandCoverage = (stroke) => {
      const seed = neighborSeedForStroke(stroke);
      const path = strokePathPoints(stroke);
      const radiusPixels = macroBrushRadiusPixels();
      const step = Math.max(1, Math.floor(path.length / 30));
      const offsets = [-0.55, -0.25, 0, 0.25, 0.55];
      const measured = [];
      const seen = new Set();
      for (let index = 0; index < path.length; index += step) {
        const point = path[index];
        const previous = path[Math.max(0, index - 1)] || point;
        const next = path[Math.min(path.length - 1, index + 1)] || point;
        const tangentX = next.x - previous.x;
        const tangentY = next.y - previous.y;
        const tangentLength = Math.hypot(tangentX, tangentY) || 1;
        const normalX = -tangentY / tangentLength;
        const normalY = tangentX / tangentLength;
        for (const offsetScale of offsets) {
          const samplePoint = {
            x: point.x + normalX * radiusPixels * offsetScale,
            y: point.y + normalY * radiusPixels * offsetScale
          };
          const key = Math.round(samplePoint.x) + ":" + Math.round(samplePoint.y);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const paintHit = hitAt(samplePoint.x, samplePoint.y);
          if (!paintHit?.record || !paintHit?.hit || !neighborAllowsSample(seed, paintHit)) {
            continue;
          }
          const alpha = alphaAtHit(paintHit);
          if (!Number.isFinite(Number(alpha))) {
            continue;
          }
          measured.push({
            x: samplePoint.x,
            y: samplePoint.y,
            alpha,
            distance: distanceToStrokePath(samplePoint, path)
          });
        }
      }
      const paintedSamples = measured.filter((sample) => sample.alpha > 0).length;
      const strongAlphaThreshold = 12;
      const strongSamples = measured.filter((sample) => sample.alpha >= strongAlphaThreshold).length;
      const paintedAlphas = measured.map((sample) => sample.alpha).filter((alpha) => alpha > 0);
      const uniformAlphaThreshold = 90;
      const uniformSamples = measured.filter((sample) => sample.alpha === 0 || sample.alpha >= uniformAlphaThreshold).length;
      return {
        visibleSamples: measured.length,
        paintedSamples,
        strongSamples,
        uniformSamples,
        coverageRatio: measured.length ? paintedSamples / measured.length : 0,
        strongCoverageRatio: measured.length ? strongSamples / measured.length : 0,
        uniformCoverageRatio: measured.length ? uniformSamples / measured.length : 0,
        strongAlphaThreshold,
        uniformAlphaThreshold,
        seedKey: seed?.key || "",
        radiusPixels,
        minAlpha: measured.length ? Math.min(...measured.map((sample) => sample.alpha)) : 0,
        maxAlpha: measured.length ? Math.max(...measured.map((sample) => sample.alpha)) : 0,
        paintedMinAlpha: paintedAlphas.length ? Math.min(...paintedAlphas) : 0,
        paintedMaxAlpha: paintedAlphas.length ? Math.max(...paintedAlphas) : 0,
        holeSamples: measured.filter((sample) => sample.alpha <= 0).length,
        alphas: measured.slice(0, 60).map((sample) => sample.alpha)
      };
    };
    const offStrokeSurfacePaint = (stroke, beforeSnapshot) => {
      const seed = neighborSeedForStroke(stroke);
      const path = strokePathPoints(stroke);
      const radiusPixels = macroBrushRadiusPixels();
      const outsideMargin = Math.max(24, Math.min(72, radiusPixels * 2.35));
      const samples = [];
      const seen = new Set();
      for (let yFraction = 0.22; yFraction <= 0.88; yFraction += 0.025) {
        for (let xFraction = 0.18; xFraction <= 0.82; xFraction += 0.025) {
          const point = {
            x: rect.left + rect.width * xFraction,
            y: rect.top + rect.height * yFraction
          };
          const distance = distanceToStrokePath(point, path);
          if (!Number.isFinite(distance) || distance <= outsideMargin) {
            continue;
          }
          const paintHit = hitAt(point.x, point.y);
          if (!paintHit?.record || !paintHit?.hit) {
            continue;
          }
          const materialIndex = paintHit.hit.face?.materialIndex ?? 0;
          const key = Math.round(point.x) + ":" + Math.round(point.y) + ":" + materialIndex;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const before = alphaAtHit(paintHit, beforeSnapshot);
          const after = alphaAtHit(paintHit);
          if (!Number.isFinite(Number(before)) || !Number.isFinite(Number(after))) {
            continue;
          }
          samples.push({
            x: point.x,
            y: point.y,
            distance,
            before,
            after,
            delta: after - before,
            materialIndex,
            neighborAllowed: neighborAllowsSample(seed, paintHit)
          });
        }
      }
      const alphaThreshold = 8;
      const deltaThreshold = 8;
      const beforePainted = samples.filter((sample) => sample.before > alphaThreshold);
      const afterPainted = samples.filter((sample) => sample.after > alphaThreshold);
      const changed = samples.filter((sample) => sample.delta > deltaThreshold);
      const neighborRejectedPainted = samples.filter((sample) => sample.neighborAllowed === false && sample.after > alphaThreshold);
      return {
        samples: samples.length,
        outsideMargin,
        radiusPixels,
        beforePaintedSamples: beforePainted.length,
        afterPaintedSamples: afterPainted.length,
        changedSamples: changed.length,
        neighborRejectedPaintedSamples: neighborRejectedPainted.length,
        maxBeforeAlpha: samples.length ? Math.max(...samples.map((sample) => sample.before)) : 0,
        maxAfterAlpha: samples.length ? Math.max(...samples.map((sample) => sample.after)) : 0,
        maxDelta: samples.length ? Math.max(...samples.map((sample) => sample.delta)) : 0,
        changedExamples: changed
          .sort((left, right) => right.delta - left.delta)
          .slice(0, 8)
          .map((sample) => ({
            x: Math.round(sample.x),
            y: Math.round(sample.y),
            distance: Math.round(sample.distance),
            before: sample.before,
            after: sample.after,
            delta: sample.delta,
            materialIndex: sample.materialIndex,
            neighborAllowed: sample.neighborAllowed
          })),
        beforePaintedExamples: beforePainted
          .sort((left, right) => right.before - left.before)
          .slice(0, 8)
          .map((sample) => ({
            x: Math.round(sample.x),
            y: Math.round(sample.y),
            distance: Math.round(sample.distance),
            before: sample.before,
            after: sample.after,
            materialIndex: sample.materialIndex,
            neighborAllowed: sample.neighborAllowed
          }))
      };
    };
    const secondStrokeCoverage = strokeCoverage(secondStroke);
    const secondStrokeBandCoverage = strokeBandCoverage(secondStroke);
    const secondStrokeOffPathPaint = offStrokeSurfacePaint(secondStroke, beforeSecondStrokeSnapshot);
    const webGpuPaintStats = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
      ? editor.textureAirbrushWebGpuPaintStats.slice(-24).map((stats) => ({
          liveDisplayExternalTexture: stats?.liveDisplayExternalTexture === true,
          liveDisplayFullUpdate: stats?.liveDisplayFullUpdate ?? null,
          liveDisplayWorkPixels: Number(stats?.liveDisplayWorkPixels) || 0,
	          liveDisplayBounds: stats?.liveDisplayBounds || null,
	          liveDisplayMipmapDirty: stats?.liveDisplayMipmapDirty ?? null,
	          liveDisplayMipmapDeferred: stats?.liveDisplayMipmapDeferred === true,
	          liveDisplayMipmapPixels: Number(stats?.liveDisplayMipmapPixels) || 0,
          liveDisplayMipmapDowngraded: stats?.liveDisplayMipmapDowngraded === true,
          liveDisplayMipmapDowngradeBlocked: stats?.liveDisplayMipmapDowngradeBlocked === true,
          deferredReadback: stats?.deferredReadback === true,
          deferredReadbackCopy: stats?.deferredReadbackCopy === true,
          deferredCanvasSync: stats?.deferredCanvasSync === true,
          sourceUploaded: stats?.sourceUploaded === true,
          sourceExternalUploaded: stats?.sourceExternalUploaded === true,
          strokeSourceUploaded: stats?.strokeSourceUploaded === true,
          reusedResources: stats?.reusedResources === true,
          timings: stats?.timings || null
        }))
      : [];
    const controlsState = editor.controls ? {
      enabled: editor.controls.enabled === true,
      enableRotate: editor.controls.enableRotate !== false,
      enablePan: editor.controls.enablePan !== false,
      enableZoom: editor.controls.enableZoom !== false
    } : null;
    return {
      ready: true,
      requestedMacro: macroName,
      loaded: Boolean(editor.model),
      loadedAsset,
      macroLoaded: true,
      macroPlayed: macroPlayed === true,
      airbrushStrokeCount: airbrushStrokes.length,
      layerAdded,
      activeTool: editor.activeTool,
      painting: Boolean(editor.painting),
      activePointerId: editor.texturePaintActivePointerId ?? null,
      controlsState,
      neighborEnabled: editor.texturePaintNeighborModeEnabled?.() === true,
      paintRecords: editor.paintRecords?.length || 0,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      cameraFacingNormalGate: "webgpu-visible-surface-mask",
      beforeSecondStrokeSnapshot: {
        captured: Boolean(beforeSecondStrokeSnapshot),
        layerCount: beforeSecondStrokeSnapshot?.layerCount || 0,
        pixelCount: beforeSecondStrokeSnapshot?.pixelCount || 0,
        eventPoint: beforeSecondStrokeEventPoint
      },
      secondStrokeCoverage,
      secondStrokeBandCoverage,
      secondStrokeOffPathPaint,
      lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
      webGpuPaintStats,
      webGpuPaintStatsCount: Array.isArray(editor.textureAirbrushWebGpuPaintStats)
        ? editor.textureAirbrushWebGpuPaintStats.length
        : 0,
      lastWebGpuCandidateDebug: editor.textureAirbrushLastWebGpuCandidateDebug || null,
      validation
    };
  })()`;
}

function runtimeAfterOrbitMacroChecks(result, options = {}) {
  const strictAfterOrbit = options.strictAfterOrbit === true;
  const pathCoverage = result?.secondStrokeCoverage || {};
  const bandCoverage = result?.secondStrokeBandCoverage || {};
  const pathPaintedMin = Number(pathCoverage.paintedMinAlpha) || 0;
  const pathPaintedMax = Number(pathCoverage.paintedMaxAlpha) || 0;
  const bandPaintedMin = Number(bandCoverage.paintedMinAlpha) || 0;
  const bandPaintedMax = Number(bandCoverage.paintedMaxAlpha) || 0;
  const bandVisibleSamples = Number(bandCoverage.visibleSamples) || 0;
  const bandAllowedEdgeHoles = Math.max(1, Math.floor(bandVisibleSamples * 0.02));
  const macroSecond = result?.validation?.byPhase?.["macro-second"] || {};
  const anyProjectionChanged = Number(result?.validation?.projectionChanged) > 0
    || Number(macroSecond.projectionChanged) > 0;
  const pathMinAlphaThreshold = strictAfterOrbit
    ? Math.max(72, pathPaintedMax * 0.65)
    : 8;
  const bandMinAlphaThreshold = strictAfterOrbit
    ? Math.max(3, bandPaintedMax * 0.03)
    : 1;
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    macroLoaded: result?.macroLoaded === true,
    macroPlayed: result?.macroPlayed === true,
    macroHasExpectedAirbrushStrokes: Number(result?.airbrushStrokeCount) >= (strictAfterOrbit ? 2 : 1),
    paintLayerCreated: result?.layerAdded === true,
    neighborEnabled: result?.neighborEnabled === true,
    noNeighborModeResetDuringMacro: !(result?.validation?.neighborModeSetCalls || [])
      .some((call) => String(call?.phase || "") !== "setup"),
    secondNeighborProjectionUsed: !strictAfterOrbit || Number(macroSecond.neighborProjectionCalls) > 0,
    finalStrokeProjected: anyProjectionChanged,
    beforeFinalStrokeSnapshotCaptured: !strictAfterOrbit || result?.beforeSecondStrokeSnapshot?.captured === true
      && Number(result?.beforeSecondStrokeSnapshot?.layerCount) > 0,
    orbitControlsUsableAfterPaint: result?.painting === false
      && result?.activePointerId == null
      && result?.controlsState?.enabled === true
      && result?.controlsState?.enableRotate === true,
    finalStrokePathCovered: Number(result?.secondStrokeCoverage?.visibleSamples) >= 8
      && Number(result?.secondStrokeCoverage?.coverageRatio) >= 0.75,
    finalStrokePathSolid: Number(result?.secondStrokeCoverage?.visibleSamples) >= 8
      && Number(result?.secondStrokeCoverage?.strongCoverageRatio) >= (strictAfterOrbit ? 1 : 0.65),
    finalStrokePathUniform: Number(pathCoverage.visibleSamples) >= 8
      && Number(pathCoverage.coverageRatio) >= (strictAfterOrbit ? 1 : 0.75)
      && Number(pathCoverage.strongCoverageRatio) >= (strictAfterOrbit ? 1 : 0.65)
      && Number(pathCoverage.uniformCoverageRatio) >= (strictAfterOrbit ? 0.95 : 0.65)
      && pathPaintedMax > 0
      && pathPaintedMin >= pathMinAlphaThreshold,
    finalStrokeBandCovered: Number(result?.secondStrokeBandCoverage?.visibleSamples) >= (strictAfterOrbit ? 24 : 8)
      && Number(result?.secondStrokeBandCoverage?.coverageRatio) >= (strictAfterOrbit ? 0.92 : 0.5)
      && Number(result?.secondStrokeBandCoverage?.strongCoverageRatio) >= (strictAfterOrbit ? 0.82 : 0.4),
    finalStrokeBandUniform: bandVisibleSamples >= (strictAfterOrbit ? 24 : 8)
      && Number(bandCoverage.coverageRatio) >= (strictAfterOrbit ? 0.98 : 0.5)
      && Number(bandCoverage.strongCoverageRatio) >= (strictAfterOrbit ? 0.9 : 0.4)
      && Number(bandCoverage.holeSamples) <= (strictAfterOrbit ? bandAllowedEdgeHoles : bandVisibleSamples)
      && bandPaintedMax > 0
      && bandPaintedMin >= bandMinAlphaThreshold,
    noOffPathPaintBeforeSecondStroke: Number(result?.secondStrokeOffPathPaint?.samples) >= 12
      && Number(result?.secondStrokeOffPathPaint?.beforePaintedSamples) === 0,
    noOffPathPaintAddedBySecondStroke: Number(result?.secondStrokeOffPathPaint?.samples) >= 12
      && Number(result?.secondStrokeOffPathPaint?.changedSamples) === 0,
    noNeighborRejectedOffPathPaintAfterMacro: Number(result?.secondStrokeOffPathPaint?.samples) >= 12
      && Number(result?.secondStrokeOffPathPaint?.neighborRejectedPaintedSamples) === 0,
    queueDrained: Number(result?.queueLength) === 0 && Number(result?.pendingBatches) === 0
  };
}

function thirdLayerStrokeForPrepared(prepared, layerNumber) {
  const canvas = prepared?.canvas || null;
  if (!canvas?.width || !canvas?.height) {
    return prepared?.stroke;
  }
  const yFraction = layerNumber === 1 ? 0.52 : 0.57;
  const point = (xFraction) => ({
    x: canvas.left + canvas.width * xFraction,
    y: canvas.top + canvas.height * yFraction
  });
  return {
    start: point(0.43),
    mid: point(0.49),
    end: point(0.55)
  };
}

function runtimeAfterOrbitNeighborExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flushPaint = async () => {
      for (let index = 0; index < 18; index += 1) {
        const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
        if (pending && typeof pending.then === "function") {
          await pending;
        }
        const webGpuPending = editor.flushTextureAirbrushPendingWebGpuPaints?.();
        if (webGpuPending && typeof webGpuPending.then === "function") {
          await webGpuPending;
        }
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(25);
      }
      const finalWebGpuPending = editor.flushTextureAirbrushPendingWebGpuPaints?.();
      if (finalWebGpuPending && typeof finalWebGpuPending.then === "function") {
        await finalWebGpuPending;
      }
      await waitFrame();
      await delay(50);
    };
    const assets = [
      {
        key: "airbrush-runtime:test-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "test",
        path: "assets/models/animation-library/test/walking-8.fbx",
        url: "./assets/models/animation-library/test/walking-8.fbx",
        engine: true,
        demo: true
      },
      {
        key: "airbrush-runtime:etes-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "etes",
        path: "assets/models/animation-library/etes/walking-8.fbx",
        url: "./assets/models/animation-library/etes/walking-8.fbx",
        engine: true,
        demo: true
      }
    ];
    let loadedAsset = "";
    let loadError = "";
    for (const asset of assets) {
      try {
        await editor.loadAnimationLibraryAsset(asset);
        loadedAsset = asset.path;
        break;
      } catch (error) {
        loadError = error?.message || String(error);
      }
    }
    if (!loadedAsset) {
      return { ready: false, loaded: false, error: "asset-load-failed", loadError };
    }
    for (let index = 0; index < 8; index += 1) {
      await waitFrame();
    }
    editor.render?.();

    const validation = {
      pointerDowns: 0,
      paintEvents: 0,
      queuedPayloads: 0,
      projectionCalls: 0,
      projectionChanged: 0,
      neighborProjectionCalls: 0,
      cameraChangedCalls: 0,
      neighborModeSetCalls: [],
      flushes: [],
      toolSwitchFlushUnderAirbrush: false,
      toolSwitchHadQueuedPaint: false,
      byPhase: {}
    };
    let phase = "setup";
    const phaseStats = () => {
      validation.byPhase[phase] ||= {
        pointerDowns: 0,
        paintEvents: 0,
        queuedPayloads: 0,
        projectionCalls: 0,
        projectionChanged: 0
      };
      return validation.byPhase[phase];
    };
    const originalOnPointerDown = editor.onPointerDown?.bind(editor);
    const originalPaintTextureStrokeFromEvent = editor.paintTextureStrokeFromEvent?.bind(editor);
    const originalQueuePayload = editor.textureAirbrushQueueScreenStrokePayload?.bind(editor);
    const originalProjection = editor.textureAirbrushProjectedMeshFromEvent?.bind(editor);
    const originalCameraChanged = editor.textureAirbrushCameraChanged?.bind(editor);
    const originalFlushScreenStroke = editor.flushTextureAirbrushScreenStroke?.bind(editor);
    const originalSetTexturePaintNeighborMode = editor.setTexturePaintNeighborMode?.bind(editor);
    editor.onPointerDown = function(event) {
      validation.pointerDowns += 1;
      phaseStats().pointerDowns += 1;
      return originalOnPointerDown?.(event);
    };
    editor.paintTextureStrokeFromEvent = function(event, options = {}) {
      validation.paintEvents += 1;
      phaseStats().paintEvents += 1;
      return originalPaintTextureStrokeFromEvent?.(event, options);
    };
    editor.textureAirbrushQueueScreenStrokePayload = function(payload) {
      const queued = originalQueuePayload?.(payload);
      if (queued) {
        validation.queuedPayloads += 1;
        phaseStats().queuedPayloads += 1;
      }
      return queued;
    };
    editor.textureAirbrushProjectedMeshFromEvent = function(event, options = {}) {
      validation.projectionCalls += 1;
      phaseStats().projectionCalls += 1;
      if (options?.neighborPaintSeed?.enabled) {
        validation.neighborProjectionCalls += 1;
      }
      const changed = originalProjection?.(event, options) || 0;
      validation.projectionChanged += Number(changed) || 0;
      phaseStats().projectionChanged += Number(changed) || 0;
      return changed;
    };
    editor.textureAirbrushCameraChanged = function(...args) {
      validation.cameraChangedCalls += 1;
      return originalCameraChanged?.(...args);
    };
    editor.setTexturePaintNeighborMode = function(enabled, options = {}) {
      validation.neighborModeSetCalls.push({
        phase,
        enabled: enabled === true,
        status: options?.status !== false
      });
      return originalSetTexturePaintNeighborMode?.(enabled, options);
    };
    editor.flushTextureAirbrushScreenStroke = function(options = {}) {
      const entry = {
        phase,
        activeTool: editor.activeTool,
        queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
        pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
        live: options?.live === true
      };
      if (phase === "orbit-switch" && editor.activeTool === "airbrush") {
        validation.toolSwitchFlushUnderAirbrush = true;
        validation.toolSwitchHadQueuedPaint = validation.toolSwitchHadQueuedPaint
          || entry.queueLength > 0
          || entry.pendingBatches > 0;
      }
      const flushOptions = phase === "first" && options?.live === true
        ? {
            ...options,
            maxBatches: 1,
            maxSegments: 1,
            maxBatchSegments: 1,
            maxBatchMs: 0
          }
        : options;
      const changed = originalFlushScreenStroke?.(flushOptions) || 0;
      validation.flushes.push({ ...entry, changed });
      return changed;
    };
    window.__airbrushRuntimeValidation = validation;
    editor.textureAirbrushCaptureCandidateDebug = true;
    editor.textureAirbrushLastWebGpuCandidateDebug = null;

    editor.setTool?.("airbrush");
    editor.setTexturePaintNeighborMode?.(true, { status: false });
    if (editor.textureBrushRadius) {
      editor.textureBrushRadius.value = "26";
    }
    if (editor.textureBrushOpacity) {
      editor.textureBrushOpacity.value = "1";
    }
    if (editor.textureBrushSpacing) {
      editor.textureBrushSpacing.value = "1";
    }
    if (editor.textureBrushHardness) {
      editor.textureBrushHardness.value = "0.75";
    }
    if (editor.textureBrushScatter) {
      editor.textureBrushScatter.value = "0";
    }
    if (editor.texturePressureRadius) {
      editor.texturePressureRadius.checked = false;
    }
    if (editor.texturePressureOpacity) {
      editor.texturePressureOpacity.checked = false;
    }
    editor.updateRangeOutputs?.();
    editor.textureAirbrushInvalidateBrushSettings?.();

    editor.setCameraPreset?.("right");
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 4; index += 1) {
      await waitFrame();
    }

    const rect = editor.canvas?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) {
      return { ready: false, loaded: Boolean(editor.model), error: "missing-canvas-rect" };
    }
    if (editor.canvas) {
      editor.canvas.setPointerCapture = () => {};
      editor.canvas.releasePointerCapture = () => {};
    }
    const eventAt = (clientX, clientY, buttons = 1) => ({
      clientX,
      clientY,
      button: 0,
      buttons,
      pointerId: 901,
      pointerType: "mouse",
      pressure: 0.7,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const hitAt = (clientX, clientY) => editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush") || null;
    const findHit = (options = {}) => {
      const xFractions = options.xFractions || [0.5, 0.47, 0.53, 0.44, 0.56, 0.41, 0.59, 0.38, 0.62, 0.35, 0.65];
      const yFractions = options.yFractions || [0.58, 0.54, 0.62, 0.5, 0.66, 0.46, 0.7, 0.42, 0.74, 0.38];
      for (const yFraction of yFractions) {
        for (const xFraction of xFractions) {
          const clientX = rect.left + rect.width * xFraction;
          const clientY = rect.top + rect.height * yFraction;
          const hit = hitAt(clientX, clientY);
          if (hit?.record && hit?.hit) {
            return { clientX, clientY, xFraction, yFraction, hit };
          }
        }
      }
      return null;
    };
    const firstHit = findHit();
    if (!firstHit) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        paintRecords: editor.paintRecords?.length || 0,
        error: "missing-first-visible-hit"
      };
    }
    const firstMaterial = editor.clonePaintMaterialForHit?.(firstHit.hit.record, firstHit.hit.hit) || editor.texturePaintFirstLayerMaterial?.() || null;
    if (firstMaterial) {
      editor.texturePaintActiveMaterial = firstMaterial;
    }
    const layerAdded = editor.addTexturePaintLayer?.() === true;
    await waitFrame();
    const materialForLayers = editor.texturePaintActiveMaterial || firstMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
    const alphaStats = () => {
      editor.flushTexturePaintLayerGpuTargetsToCanvases?.({ composite: true });
      let count = 0;
      let sum = 0;
      const materials = editor.textureAirbrushPaintableMaterials?.() || [];
      for (const entry of materials) {
        const stack = entry?.material?.userData?.texturePaintLayerStack || null;
        for (const layer of (stack?.layers || [])) {
          const canvas = layer?.canvas || null;
          const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
          if (!canvas || !context) {
            continue;
          }
          const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let index = 3; index < image.length; index += 4) {
            const alpha = image[index];
            if (alpha > 0) {
              count += 1;
              sum += alpha;
            }
          }
        }
      }
      return { count, sum };
    };
    const strokeFor = (point, verticalOffset = 0) => {
      const radius = Math.max(8, Math.min(28, rect.width * 0.026));
      const y = Math.max(rect.top + 4, Math.min(rect.bottom - 4, point.clientY + verticalOffset));
      const x = Math.max(rect.left + radius + 4, Math.min(rect.right - radius - 4, point.clientX));
      return {
        start: { x: x - radius, y },
        mid: { x, y },
        end: { x: x + radius, y }
      };
    };
    const strokeSamplePoints = (stroke) => [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((ratio) => ({
      x: stroke.start.x + (stroke.end.x - stroke.start.x) * ratio,
      y: stroke.start.y + (stroke.end.y - stroke.start.y) * ratio
    }));
    const neighborSeedForStroke = (stroke) => (
      editor.textureAirbrushNeighborSeedFromHit?.(hitAt(stroke.start.x, stroke.start.y)) || null
    );
    const neighborAllowsSample = (seed, paintHit) => {
      if (!seed?.enabled || !paintHit?.record || !paintHit?.hit) {
        return true;
      }
      const material = editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null;
      const materialIndex = paintHit.hit.face?.materialIndex ?? 0;
      return editor.textureAirbrushNeighborHitAllowed?.(
        seed,
        paintHit.record,
        paintHit.hit,
        material,
        materialIndex
      ) !== false;
    };
    const alphaAtHit = (paintHit) => {
      const uv = paintHit?.hit?.uv || null;
      const material = paintHit?.record && paintHit?.hit
        ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || materialForLayers
        : materialForLayers;
      const stack = material?.userData?.texturePaintLayerStack || null;
      const layer = (stack?.layers || []).find((item) => item.id === stack?.activeLayerId) || null;
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!uv || !canvas || !context) {
        return null;
      }
      const centerX = Math.max(0, Math.min(canvas.width - 1, Math.floor(Number(uv.x || 0) * canvas.width)));
      const centerY = Math.max(0, Math.min(canvas.height - 1, Math.floor((1 - Number(uv.y || 0)) * canvas.height)));
      let alpha = 0;
      for (let y = Math.max(0, centerY - 1); y <= Math.min(canvas.height - 1, centerY + 1); y += 1) {
        for (let x = Math.max(0, centerX - 1); x <= Math.min(canvas.width - 1, centerX + 1); x += 1) {
          alpha = Math.max(alpha, context.getImageData(x, y, 1, 1).data[3]);
        }
      }
      return alpha;
    };
    const strokeCoverage = (stroke, seed = neighborSeedForStroke(stroke)) => {
      const samples = [];
      for (const point of strokeSamplePoints(stroke)) {
        const paintHit = hitAt(point.x, point.y);
        if (!paintHit?.record || !paintHit?.hit) {
          continue;
        }
        if (!neighborAllowsSample(seed, paintHit)) {
          continue;
        }
        const alpha = alphaAtHit(paintHit);
        if (!Number.isFinite(Number(alpha))) {
          continue;
        }
        samples.push({ x: point.x, y: point.y, alpha });
      }
      const paintedSamples = samples.filter((sample) => sample.alpha > 0).length;
      return {
        visibleSamples: samples.length,
        paintedSamples,
        coverageRatio: samples.length ? paintedSamples / samples.length : 0,
        seedKey: seed?.key || "",
        alphas: samples.map((sample) => sample.alpha)
      };
    };
    const paintStroke = async (stroke, phaseName, options = {}) => {
      phase = phaseName;
      editor.onPointerDown?.(eventAt(stroke.start.x, stroke.start.y, 1));
      if (options.fast !== true) {
        await waitFrame();
      }
      const points = Array.isArray(options.points) && options.points.length
        ? options.points
        : [stroke.mid, stroke.end];
      for (const point of points) {
        editor.onPointerMove?.(eventAt(point.x, point.y, 1));
        if (options.fast !== true) {
          await waitFrame();
        }
      }
      editor.onPointerUp?.(eventAt(stroke.end.x, stroke.end.y, 0));
      if (options.flush !== false) {
        await flushPaint();
      }
    };
    const beforeAlpha = alphaStats();
    const firstStroke = strokeFor(firstHit);
    const firstFastPoints = Array.from({ length: 18 }, (_, index) => {
      const ratio = (index + 1) / 18;
      return {
        x: firstStroke.start.x + (firstStroke.end.x - firstStroke.start.x) * ratio,
        y: firstStroke.start.y + Math.sin(ratio * Math.PI * 2) * 6
      };
    });
    await paintStroke(firstStroke, "first", {
      fast: true,
      flush: false,
      points: firstFastPoints
    });
    phase = "orbit-switch";
    editor.setTool?.("orbit");
    await flushPaint();
    const afterFirstAlpha = alphaStats();

    phase = "orbit";
    if (typeof editor.orbitCameraByPixels === "function") {
      editor.orbitCameraByPixels(520, 0);
    } else {
      editor.setCameraPreset?.("back");
      editor.textureAirbrushCameraChanged?.();
    }
    for (let index = 0; index < 8; index += 1) {
      await waitFrame();
    }
    editor.setTool?.("airbrush");
    const neighborStayedEnabledAfterOrbit = editor.texturePaintNeighborModeEnabled?.() === true;
    await waitFrame();

    const baseSecondHit = findHit({
      yFractions: [0.58, 0.62, 0.54, 0.66, 0.5, 0.7, 0.46, 0.74, 0.42]
    });
    if (!baseSecondHit) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        paintRecords: editor.paintRecords?.length || 0,
        firstHitFound: true,
        layerAdded,
        error: "missing-second-visible-hit",
        validation
      };
    }
    const secondCandidates = [];
    const secondOffsets = [-20, 0, 20, -40, 40];
    for (const offset of secondOffsets) {
      const candidateY = Math.max(rect.top + 4, Math.min(rect.bottom - 4, baseSecondHit.clientY + offset));
      const hit = hitAt(baseSecondHit.clientX, candidateY);
      if (hit?.record && hit?.hit) {
        secondCandidates.push({ ...baseSecondHit, clientY: candidateY, hit });
      }
      if (secondCandidates.length >= 3) {
        break;
      }
    }
    if (!secondCandidates.length) {
      secondCandidates.push(baseSecondHit);
    }
    const secondAlphaDeltas = [];
    const secondCoverage = [];
    const secondCandidateDebug = [];
    let totalSecondVisibleSamples = 0;
    let totalSecondPaintedSamples = 0;
    let previousAlpha = afterFirstAlpha;
    for (let index = 0; index < secondCandidates.length; index += 1) {
      const stroke = strokeFor(secondCandidates[index]);
      const seed = neighborSeedForStroke(stroke);
      const coverageBefore = strokeCoverage(stroke, seed);
      await paintStroke(stroke, "second-" + index, { flush: true });
      secondCandidateDebug.push(editor.textureAirbrushLastWebGpuCandidateDebug || null);
      const nextAlpha = alphaStats();
      const coverageAfter = strokeCoverage(stroke, seed);
      secondAlphaDeltas.push(nextAlpha.count - previousAlpha.count);
      secondCoverage.push({
        before: coverageBefore,
        after: coverageAfter
      });
      totalSecondVisibleSamples += coverageAfter.visibleSamples;
      totalSecondPaintedSamples += coverageAfter.paintedSamples;
      previousAlpha = nextAlpha;
    }
    const afterSecondAlpha = previousAlpha;
    await flushPaint();
    const materialStack = materialForLayers?.userData?.texturePaintLayerStack || null;
    const activeLayer = (materialStack?.layers || []).find((layer) => layer.id === materialStack?.activeLayerId) || null;
    phase = "done";
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      paintRecords: editor.paintRecords?.length || 0,
      activeTool: editor.activeTool,
      painting: Boolean(editor.painting),
      neighborEnabled: editor.texturePaintNeighborModeEnabled?.() === true,
      neighborStayedEnabledAfterOrbit,
      layerAdded,
      activeLayerName: activeLayer?.name || "",
      firstHitFound: Boolean(firstHit),
      secondHitCount: secondCandidates.length,
      beforeAlpha,
      afterFirstAlpha,
      afterSecondAlpha,
      firstAlphaDelta: afterFirstAlpha.count - beforeAlpha.count,
      firstProjectionChanged: (Number(validation.byPhase.first?.projectionChanged) || 0)
        + (Number(validation.byPhase["orbit-switch"]?.projectionChanged) || 0),
      secondAlphaDelta: afterSecondAlpha.count - afterFirstAlpha.count,
      secondAlphaDeltas,
      secondCandidateDebug,
      secondCoverage,
      secondPathCoverage: {
        visibleSamples: totalSecondVisibleSamples,
        paintedSamples: totalSecondPaintedSamples,
        coverageRatio: totalSecondVisibleSamples ? totalSecondPaintedSamples / totalSecondVisibleSamples : 0
      },
      secondProjectionChanged: Object.entries(validation.byPhase)
        .filter(([key]) => key.indexOf("second-") === 0)
        .reduce((total, [, item]) => total + (Number(item.projectionChanged) || 0), 0),
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      cameraFacingNormalGate: "webgpu-visible-surface-mask",
      webGpuStatus: editor.textureAirbrushWebGpuRuntimeStatus?.() || null,
      lastBackend: editor.textureAirbrushLastBackend || null,
      status: document.getElementById("viewer-status")?.textContent || "",
      validation
    };
  })()`;
}

function runtimeViewerFrameHelpersExpression() {
  return `
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
        const data = context.getImageData(0, 0, width, height).data;
        let modelPixelCount = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumLuma = 0;
        for (let offset = 0; offset < data.length; offset += 4) {
          const luma = pixelLuma(data, offset);
          if (luma < 36) {
            continue;
          }
          modelPixelCount += 1;
          sumR += Number(data[offset]);
          sumG += Number(data[offset + 1]);
          sumB += Number(data[offset + 2]);
          sumLuma += luma;
        }
        return {
          ok: true,
          width,
          height,
          data,
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
  `;
}

function runtimePreparationExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    ${runtimeViewerFrameHelpersExpression()}
    const assets = [
      {
        key: "airbrush-runtime:test-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "test",
        path: "assets/models/animation-library/test/walking-8.fbx",
        url: "./assets/models/animation-library/test/walking-8.fbx",
        engine: true,
        demo: true
      },
      {
        key: "airbrush-runtime:etes-walking-8",
        name: "walking-8.fbx",
        label: "walking-8",
        extension: "fbx",
        folder: "etes",
        path: "assets/models/animation-library/etes/walking-8.fbx",
        url: "./assets/models/animation-library/etes/walking-8.fbx",
        engine: true,
        demo: true
      }
    ];
    let loadedAsset = "";
    let loadError = "";
    for (const asset of assets) {
      try {
        const loaded = await editor.loadAnimationLibraryAsset(asset);
        if (loaded && editor.model) {
          loadedAsset = asset.path;
          break;
        }
        loadError = "load returned without a model";
      } catch (error) {
        loadError = error?.message || String(error);
      }
    }
    if (!loadedAsset) {
      return { ready: false, loaded: false, error: "asset-load-failed", loadError };
    }
    for (let index = 0; index < 6; index += 1) {
      await waitFrame();
    }
    editor.render?.();
    editor.setTool?.("airbrush");
    const paintColor = { hex: "#ff00ff", r: 255, g: 0, b: 255 };
    if (editor.textureBrushRadius) {
      editor.textureBrushRadius.value = "0.06";
    }
    if (editor.textureBrushOpacity) {
      editor.textureBrushOpacity.value = "1";
    }
    if (editor.textureBrushSpacing) {
      editor.textureBrushSpacing.value = "1";
    }
    if (editor.textureBrushHardness) {
      editor.textureBrushHardness.value = "0.65";
    }
    if (editor.textureBrushScatter) {
      editor.textureBrushScatter.value = "0";
    }
    if (editor.texturePaintColor) {
      editor.texturePaintColor.value = paintColor.hex;
      editor.texturePaintColor.dispatchEvent?.(new Event("input", { bubbles: true }));
      editor.texturePaintColor.dispatchEvent?.(new Event("change", { bubbles: true }));
    }
    if (editor.texturePressureRadius) {
      editor.texturePressureRadius.checked = false;
    }
    if (editor.texturePressureOpacity) {
      editor.texturePressureOpacity.checked = false;
    }
    editor.updateRangeOutputs?.();
    editor.textureAirbrushInvalidateBrushSettings?.();
    const rect = editor.canvas?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) {
      return { ready: false, loaded: Boolean(editor.model), error: "missing-canvas-rect" };
    }
    const eventAt = (clientX, clientY) => ({
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      pointerId: 77,
      pointerType: "mouse",
      pressure: 0.6,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const xFractions = [0.5, 0.46, 0.54, 0.42, 0.58, 0.38, 0.62, 0.34, 0.66, 0.3, 0.7, 0.26, 0.74, 0.22, 0.78, 0.18, 0.82];
    const yFractions = [0.5, 0.46, 0.54, 0.42, 0.58, 0.38, 0.62, 0.34, 0.66, 0.3, 0.7, 0.26, 0.74, 0.22, 0.78, 0.18, 0.82];
    let chosen = null;
    let tried = 0;
    for (const yFraction of yFractions) {
      for (const xFraction of xFractions) {
        const clientX = rect.left + rect.width * xFraction;
        const clientY = rect.top + rect.height * yFraction;
        tried += 1;
        const hit = editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush");
        if (hit?.record && hit?.hit) {
          chosen = { clientX, clientY, xFraction, yFraction };
          break;
        }
      }
      if (chosen) {
        break;
      }
    }
    if (!chosen) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        loadedAsset,
        paintRecords: editor.paintRecords?.length || 0,
        tried,
        rendererMode: editor.textureAirbrushLastRendererMode || null,
        webGpuStatus: editor.textureAirbrushWebGpuRuntimeStatus?.() || null,
        error: "missing-paintable-hit"
      };
    }
    const offset = Math.max(8, Math.min(24, rect.width * 0.025));
    const clampX = (value) => Math.max(rect.left + 2, Math.min(rect.right - 2, value));
    const stroke = {
      start: { x: clampX(chosen.clientX - offset), y: chosen.clientY },
      mid: { x: chosen.clientX, y: chosen.clientY },
      end: { x: clampX(chosen.clientX + offset), y: chosen.clientY }
    };
    const chosenEvent = eventAt(chosen.clientX, chosen.clientY);
    const directHitAtChosen = editor.texturePaintHitForEvent?.(chosenEvent, "airbrush") || null;
    const raycastHitAtChosen = editor.texturePaintHitForEvent?.(
      chosenEvent,
      "airbrush",
      { useScreenHitIndex: false }
    ) || null;
    const directMaterialAtChosen = directHitAtChosen?.record
      ? editor.clonePaintMaterialForHit?.(directHitAtChosen.record, directHitAtChosen.hit) || null
      : null;
    const directEditableAtChosen = directMaterialAtChosen
      ? editor.editableClonePaintTexture?.(directMaterialAtChosen) || null
      : null;
    const directPixelAtChosen = directHitAtChosen?.hit?.uv && directEditableAtChosen?.canvas && directEditableAtChosen?.texture
      ? editor.clonePaintPixelFromUv?.(
          directHitAtChosen.hit.uv,
          directEditableAtChosen.canvas,
          directEditableAtChosen.texture,
          { wrap: true }
        ) || null
      : null;
    const raycastPixelAtChosen = raycastHitAtChosen?.hit?.uv && directEditableAtChosen?.canvas && directEditableAtChosen?.texture
      ? editor.clonePaintPixelFromUv?.(
          raycastHitAtChosen.hit.uv,
          directEditableAtChosen.canvas,
          directEditableAtChosen.texture,
          { wrap: true }
        ) || null
      : null;
    const directOriginalMapAtChosen = directMaterialAtChosen?.userData?.clonePaintOriginalMap || null;
    const directCloneTextureAtChosen = directMaterialAtChosen?.userData?.clonePaintTexture || null;
    const sampleEditableSurface = (editable, pixel, radius = 5) => {
      const canvas = editable?.canvas || null;
      const context = editable?.context || canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!canvas || !context || !pixel) {
        return { ok: false, reason: "missing-surface-probe" };
      }
      const centerX = Math.max(0, Math.min(canvas.width - 1, Math.round(Number(pixel.x) || 0)));
      const centerY = Math.max(0, Math.min(canvas.height - 1, Math.round(Number(pixel.y) || 0)));
      const left = Math.max(0, centerX - radius);
      const top = Math.max(0, centerY - radius);
      const right = Math.min(canvas.width - 1, centerX + radius);
      const bottom = Math.min(canvas.height - 1, centerY + radius);
      const width = right - left + 1;
      const height = bottom - top + 1;
      if (width <= 0 || height <= 0) {
        return { ok: false, reason: "empty-surface-probe" };
      }
      const image = context.getImageData(left, top, width, height).data;
      const samples = [];
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let index = 0; index < image.length; index += 4) {
        const sample = [
          image[index] || 0,
          image[index + 1] || 0,
          image[index + 2] || 0,
          image[index + 3] || 0
        ];
        samples.push(sample);
        sumR += sample[0];
        sumG += sample[1];
        sumB += sample[2];
        sumA += sample[3];
      }
      return {
        ok: true,
        left,
        top,
        width,
        height,
        count: samples.length,
        sumR,
        sumG,
        sumB,
        sumA,
        samples
      };
    };
    const surfaceProbeBefore = sampleEditableSurface(directEditableAtChosen, directPixelAtChosen);
    const webGpuCandidatesAtHit = editor.textureAirbrushWebGpuCandidatesFromEvent?.(chosenEvent, {
      visibleSurfaceMaskRequired: true,
      liveProjectedPaint: true,
      requireVisibilityMask: true
    }) || [];
    const validation = {
      pointerDowns: 0,
      paintEvents: 0,
      resetPaintEvents: 0,
      queuedPayloads: 0,
      projectionCalls: 0,
      projectionChanged: 0
    };
    const originalOnPointerDown = editor.onPointerDown?.bind(editor);
    const originalPaintTextureStrokeFromEvent = editor.paintTextureStrokeFromEvent?.bind(editor);
    const originalQueuePayload = editor.textureAirbrushQueueScreenStrokePayload?.bind(editor);
    const originalProjection = editor.textureAirbrushProjectedMeshFromEvent?.bind(editor);
    editor.onPointerDown = function(event) {
      validation.pointerDowns += 1;
      return originalOnPointerDown?.(event);
    };
    editor.paintTextureStrokeFromEvent = function(event, options = {}) {
      validation.paintEvents += 1;
      if (options.reset === true) {
        validation.resetPaintEvents += 1;
      }
      return originalPaintTextureStrokeFromEvent?.(event, options);
    };
    editor.textureAirbrushQueueScreenStrokePayload = function(payload) {
      const queued = originalQueuePayload?.(payload);
      if (queued) {
        validation.queuedPayloads += 1;
      }
      return queued;
    };
    editor.textureAirbrushProjectedMeshFromEvent = function(event, options = {}) {
      validation.projectionCalls += 1;
      const changed = originalProjection?.(event, options) || 0;
      validation.projectionChanged += Number(changed) || 0;
      return changed;
    };
    window.__airbrushRuntimeValidation = validation;
    window.__airbrushRuntimeValidationSurfaceProbe = {
      material: directMaterialAtChosen,
      editable: directEditableAtChosen,
      pixel: directPixelAtChosen ? { x: directPixelAtChosen.x, y: directPixelAtChosen.y } : null,
      before: surfaceProbeBefore
    };
    window.__airbrushRuntimeValidationWebGpuBaseline = {
      paintStatsCount: Array.isArray(editor.textureAirbrushWebGpuPaintStats)
        ? editor.textureAirbrushWebGpuPaintStats.length
        : 0
    };
    await waitFrame();
    const viewerFrameBefore = captureViewerFrame();
    const strokeFrameBounds = (() => {
      if (!viewerFrameBefore?.ok || !rect?.width || !rect?.height) {
        return null;
      }
      const scaleX = viewerFrameBefore.width / rect.width;
      const scaleY = viewerFrameBefore.height / rect.height;
      const padding = 64;
      const minClientX = Math.min(stroke.start.x, stroke.mid.x, stroke.end.x);
      const maxClientX = Math.max(stroke.start.x, stroke.mid.x, stroke.end.x);
      const minClientY = Math.min(stroke.start.y, stroke.mid.y, stroke.end.y);
      const maxClientY = Math.max(stroke.start.y, stroke.mid.y, stroke.end.y);
      const left = Math.max(0, Math.floor((minClientX - rect.left) * scaleX - padding));
      const top = Math.max(0, Math.floor((minClientY - rect.top) * scaleY - padding));
      const right = Math.min(viewerFrameBefore.width, Math.ceil((maxClientX - rect.left) * scaleX + padding));
      const bottom = Math.min(viewerFrameBefore.height, Math.ceil((maxClientY - rect.top) * scaleY + padding));
      return {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
      };
    })();
    window.__airbrushRuntimeValidationViewerBaseline = viewerFrameBefore;
    window.__airbrushRuntimeValidationPaintColor = paintColor;
    window.__airbrushRuntimeValidationStrokeFrameBounds = strokeFrameBounds;
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      paintRecords: editor.paintRecords?.length || 0,
      activeTool: editor.activeTool,
      hitFound: true,
      hit: chosen,
      paintColor,
      strokeFrameBounds,
      directWebGpuPrereq: {
        hasHitRecord: Boolean(directHitAtChosen?.record),
        hasHit: Boolean(directHitAtChosen?.hit),
        hasUv: Boolean(directHitAtChosen?.hit?.uv),
        hitUv: directHitAtChosen?.hit?.uv
          ? {
              x: Number(directHitAtChosen.hit.uv.x),
              y: Number(directHitAtChosen.hit.uv.y)
            }
          : null,
        raycastHitRecord: Boolean(raycastHitAtChosen?.record),
        raycastHasHit: Boolean(raycastHitAtChosen?.hit),
        raycastUv: raycastHitAtChosen?.hit?.uv
          ? {
              x: Number(raycastHitAtChosen.hit.uv.x),
              y: Number(raycastHitAtChosen.hit.uv.y)
            }
          : null,
        sameRecordAsRaycast: Boolean(directHitAtChosen?.record && directHitAtChosen.record === raycastHitAtChosen?.record),
        sameFaceAsRaycast: Number.isInteger(directHitAtChosen?.hit?.faceIndex)
          && directHitAtChosen.hit.faceIndex === raycastHitAtChosen?.hit?.faceIndex,
        hasMaterial: Boolean(directMaterialAtChosen),
        materialHasMap: Boolean(directMaterialAtChosen?.map),
        mapName: directMaterialAtChosen?.map?.name || "",
        mapImageType: directMaterialAtChosen?.map?.image?.constructor?.name || "",
        mapImageWidth: directMaterialAtChosen?.map?.image?.width || directMaterialAtChosen?.map?.image?.naturalWidth || 0,
        mapImageHeight: directMaterialAtChosen?.map?.image?.height || directMaterialAtChosen?.map?.image?.naturalHeight || 0,
        mapIsTexture: directMaterialAtChosen?.map?.isTexture === true,
        mapFlipY: directMaterialAtChosen?.map?.flipY ?? null,
        mapChannel: Number.isFinite(Number(directMaterialAtChosen?.map?.channel))
          ? Number(directMaterialAtChosen.map.channel)
          : null,
        originalMapName: directOriginalMapAtChosen?.name || "",
        originalMapImageType: directOriginalMapAtChosen?.image?.constructor?.name || "",
        originalMapFlipY: directOriginalMapAtChosen?.flipY ?? null,
        originalMapChannel: Number.isFinite(Number(directOriginalMapAtChosen?.channel))
          ? Number(directOriginalMapAtChosen.channel)
          : null,
        cloneTextureMatchesMap: Boolean(directCloneTextureAtChosen && directCloneTextureAtChosen === directMaterialAtChosen?.map),
        cloneTextureFlipY: directCloneTextureAtChosen?.flipY ?? null,
        cloneTextureChannel: Number.isFinite(Number(directCloneTextureAtChosen?.channel))
          ? Number(directCloneTextureAtChosen.channel)
          : null,
        hasEditable: Boolean(directEditableAtChosen),
        hasCanvas: Boolean(directEditableAtChosen?.canvas),
        canvasWidth: directEditableAtChosen?.canvas?.width || 0,
        canvasHeight: directEditableAtChosen?.canvas?.height || 0,
        hasTexture: Boolean(directEditableAtChosen?.texture),
        hasPixel: Boolean(directPixelAtChosen),
        surfaceProbeBefore: surfaceProbeBefore?.ok === true
          ? {
              count: surfaceProbeBefore.count,
              sumR: surfaceProbeBefore.sumR,
              sumG: surfaceProbeBefore.sumG,
              sumB: surfaceProbeBefore.sumB,
              sumA: surfaceProbeBefore.sumA
            }
          : surfaceProbeBefore,
        pixel: directPixelAtChosen
          ? {
              x: directPixelAtChosen.x,
              y: directPixelAtChosen.y
            }
          : null,
        raycastPixel: raycastPixelAtChosen
          ? {
              x: raycastPixelAtChosen.x,
              y: raycastPixelAtChosen.y
            }
          : null
      },
      webGpuCandidateCountAtHit: webGpuCandidatesAtHit.length || 0,
      webGpuCandidateDebug: webGpuCandidatesAtHit.slice(0, 3).map((candidate) => ({
        hasRecord: Boolean(candidate?.record),
        hasMaterial: Boolean(candidate?.material),
        hasEditable: Boolean(candidate?.editable),
        hasCanvas: Boolean(candidate?.editable?.canvas),
        hasTexture: Boolean(candidate?.editable?.texture),
        materialIndex: candidate?.materialIndex ?? null,
        estimate: candidate?.estimate ?? 0,
        visibleSurfaceMaskReady: candidate?.options?.visibleSurfaceMaskReady === true
      })),
      viewerFrameBefore: summarizeViewerFrame(viewerFrameBefore),
      canvas: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      },
      stroke
    };
  })()`;
}

function runtimeResultExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { error: "missing-editor" };
    }
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    ${runtimeViewerFrameHelpersExpression()}
    for (let index = 0; index < 12; index += 1) {
      const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
      if (pending && typeof pending.then === "function") {
        await pending;
      }
      const webGpuPending = editor.flushTextureAirbrushPendingWebGpuPaints?.();
      if (webGpuPending && typeof webGpuPending.then === "function") {
        await webGpuPending;
      }
      if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
        break;
      }
      await delay(25);
    }
    const finalWebGpuPending = editor.flushTextureAirbrushPendingWebGpuPaints?.();
    if (finalWebGpuPending && typeof finalWebGpuPending.then === "function") {
      await finalWebGpuPending;
    }
    await delay(50);
    editor.render?.();
    await waitFrame();
    const viewerFrameAfter = captureViewerFrame();
    const viewerPaintDelta = compareViewerFrameChange(
      window.__airbrushRuntimeValidationViewerBaseline || null,
      viewerFrameAfter
    );
    const viewerPaintColorDelta = compareViewerPaintColorChange(
      window.__airbrushRuntimeValidationViewerBaseline || null,
      viewerFrameAfter,
      window.__airbrushRuntimeValidationPaintColor || null,
      window.__airbrushRuntimeValidationStrokeFrameBounds || null
    );
    const material = editor.texturePaintActiveMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
    editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      material,
      composite: true
    });
    const stack = material?.userData?.texturePaintLayerStack || null;
    const activeLayer = (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId) || null;
    const alphaStats = (layer) => {
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!canvas || !context) {
        return { count: 0, sum: 0 };
      }
      const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      let sum = 0;
      for (let index = 3; index < image.length; index += 4) {
        const alpha = image[index] || 0;
        if (alpha > 0) {
          count += 1;
          sum += alpha;
        }
      }
      return { count, sum };
    };
    const sampleEditableSurface = (editable, pixel, radius = 5) => {
      const canvas = editable?.canvas || null;
      const context = editable?.context || canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!canvas || !context || !pixel) {
        return { ok: false, reason: "missing-surface-probe" };
      }
      const centerX = Math.max(0, Math.min(canvas.width - 1, Math.round(Number(pixel.x) || 0)));
      const centerY = Math.max(0, Math.min(canvas.height - 1, Math.round(Number(pixel.y) || 0)));
      const left = Math.max(0, centerX - radius);
      const top = Math.max(0, centerY - radius);
      const right = Math.min(canvas.width - 1, centerX + radius);
      const bottom = Math.min(canvas.height - 1, centerY + radius);
      const width = right - left + 1;
      const height = bottom - top + 1;
      if (width <= 0 || height <= 0) {
        return { ok: false, reason: "empty-surface-probe" };
      }
      const image = context.getImageData(left, top, width, height).data;
      const samples = [];
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let index = 0; index < image.length; index += 4) {
        const sample = [
          image[index] || 0,
          image[index + 1] || 0,
          image[index + 2] || 0,
          image[index + 3] || 0
        ];
        samples.push(sample);
        sumR += sample[0];
        sumG += sample[1];
        sumB += sample[2];
        sumA += sample[3];
      }
      return {
        ok: true,
        left,
        top,
        width,
        height,
        count: samples.length,
        sumR,
        sumG,
        sumB,
        sumA,
        samples
      };
    };
    const surfaceProbe = window.__airbrushRuntimeValidationSurfaceProbe || null;
    const surfaceProbeAfter = sampleEditableSurface(surfaceProbe?.editable, surfaceProbe?.pixel);
    const surfacePaintDelta = (() => {
      const before = surfaceProbe?.before || null;
      const after = surfaceProbeAfter || null;
      if (!before?.ok || !after?.ok || before.samples?.length !== after.samples?.length) {
        return {
          ok: false,
          reason: before?.reason || after?.reason || "surface-probe-mismatch"
        };
      }
      let changedSamples = 0;
      let sumAbsDelta = 0;
      let maxAbsDelta = 0;
      for (let index = 0; index < before.samples.length; index += 1) {
        const left = before.samples[index] || [];
        const right = after.samples[index] || [];
        let sampleDelta = 0;
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs((Number(right[channel]) || 0) - (Number(left[channel]) || 0));
          sampleDelta += delta;
          maxAbsDelta = Math.max(maxAbsDelta, delta);
        }
        if (sampleDelta > 0) {
          changedSamples += 1;
          sumAbsDelta += sampleDelta;
        }
      }
      return {
        ok: true,
        count: before.samples.length,
        changedSamples,
        sumAbsDelta,
        maxAbsDelta,
        before: {
          sumR: before.sumR,
          sumG: before.sumG,
          sumB: before.sumB,
          sumA: before.sumA
        },
        after: {
          sumR: after.sumR,
          sumG: after.sumG,
          sumB: after.sumB,
          sumA: after.sumA
        }
      };
    })();
    return {
      activeTool: editor.activeTool,
      painting: Boolean(editor.painting),
      screenStrokeChanged: editor.textureAirbrushScreenStrokeChanged === true,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      webGpuStatus: editor.textureAirbrushWebGpuRuntimeStatus?.() || null,
      lastBackend: editor.textureAirbrushLastBackend || null,
      status: document.getElementById("viewer-status")?.textContent || "",
      undoStackLength: editor.undoStack?.length || 0,
      activeLayerId: stack?.activeLayerId || "",
      activeLayerAlpha: alphaStats(activeLayer),
      surfacePaintDelta,
      viewerFrameAfter: summarizeViewerFrame(viewerFrameAfter),
      viewerPaintDelta,
      viewerPaintColorDelta,
      layerCount: stack?.layers?.length || 0,
      validation: window.__airbrushRuntimeValidation || null
    };
  })()`;
}

function runtimeMidStrokeResultExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    ${runtimeViewerFrameHelpersExpression()}
    editor.render?.();
    await waitFrame();
    const viewerFrameMidStroke = captureViewerFrame();
    const viewerPaintDelta = compareViewerFrameChange(
      window.__airbrushRuntimeValidationViewerBaseline || null,
      viewerFrameMidStroke
    );
    const viewerPaintColorDelta = compareViewerPaintColorChange(
      window.__airbrushRuntimeValidationViewerBaseline || null,
      viewerFrameMidStroke,
      window.__airbrushRuntimeValidationPaintColor || null,
      window.__airbrushRuntimeValidationStrokeFrameBounds || null
    );
    const baseline = window.__airbrushRuntimeValidationWebGpuBaseline || {};
    const baselinePaintStatsCount = Math.max(0, Math.floor(Number(baseline.paintStatsCount) || 0));
    const allStats = Array.isArray(editor.textureAirbrushWebGpuPaintStats)
      ? editor.textureAirbrushWebGpuPaintStats
      : [];
    const newStats = allStats.slice(baselinePaintStatsCount);
    const liveDisplayStats = newStats.filter((stats) => (
      stats?.liveDisplayExternalTexture === true
      && Number(stats?.liveDisplayWorkPixels) > 0
    ));
    return {
      activeTool: editor.activeTool,
      painting: Boolean(editor.painting),
      screenStrokeChanged: editor.textureAirbrushScreenStrokeChanged === true,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      baselinePaintStatsCount,
      webGpuPaintStatsCount: allStats.length,
      webGpuPaintStatsCountDelta: Math.max(0, allStats.length - baselinePaintStatsCount),
      liveDisplayPaintStatsCount: liveDisplayStats.length,
      liveDisplayWorkPixels: liveDisplayStats.reduce((total, stats) => (
        total + Math.max(0, Math.floor(Number(stats?.liveDisplayWorkPixels) || 0))
      ), 0),
      lastLiveDisplayStats: liveDisplayStats.at(-1) || null,
      viewerFrameMidStroke: summarizeViewerFrame(viewerFrameMidStroke),
      viewerPaintDelta,
      viewerPaintColorDelta,
      validation: window.__airbrushRuntimeValidation || null,
      status: document.getElementById("viewer-status")?.textContent || ""
    };
  })()`;
}

function runtimeLayerAfterUndoSetupExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    ${runtimeViewerFrameHelpersExpression()}
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flushPaint = async () => {
      for (let index = 0; index < 12; index += 1) {
        const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
        if (pending && typeof pending.then === "function") {
          await pending;
        }
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(25);
      }
      await delay(50);
    };
    const summarizeLayer = (layer) => ({
      id: layer?.id || "",
      name: layer?.name || "",
      autoCreated: layer?.autoCreated === true,
      isEmpty: layer?.isEmpty === true,
      visible: layer?.visible !== false,
      opacity: Number(layer?.opacity ?? 1),
      gpuTarget: layer?.gpuTarget ? {
        emptyTransparent: layer.gpuTarget.emptyTransparent === true,
        paintRevision: Math.max(0, Math.floor(Number(layer.gpuTarget.paintRevision) || 0)),
        hasTarget: Boolean(layer.gpuTarget.target?.texture)
      } : null
    });
    const summarize = () => {
      const material = editor.texturePaintActiveMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
      const stack = material?.userData?.texturePaintLayerStack || null;
      return {
        rows: Array.from(document.querySelectorAll(".texture-layer-row")).map((row) => ({
          text: row.textContent.trim(),
          layerId: row.dataset.layerId || "",
          locked: row.classList.contains("is-locked"),
          active: row.classList.contains("is-active"),
          selected: row.classList.contains("is-selected")
        })),
        activeLayerId: stack?.activeLayerId || "",
        selectedLayerIds: stack?.selectedLayerIds || [],
        layers: (stack?.layers || []).map(summarizeLayer),
        undoStackLength: editor.undoStack?.length || 0,
        redoStackLength: editor.redoStack?.length || 0
      };
    };
    const sampleSurfaceProbe = () => {
      const probe = window.__airbrushRuntimeValidationSurfaceProbe || null;
      const editable = probe?.editable || null;
      const canvas = editable?.canvas || null;
      const context = editable?.context || canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      const pixel = probe?.pixel || null;
      if (!canvas || !context || !pixel) {
        return { ok: false, reason: "missing-surface-probe" };
      }
      const radius = 5;
      const centerX = Math.max(0, Math.min(canvas.width - 1, Math.round(Number(pixel.x) || 0)));
      const centerY = Math.max(0, Math.min(canvas.height - 1, Math.round(Number(pixel.y) || 0)));
      const left = Math.max(0, centerX - radius);
      const top = Math.max(0, centerY - radius);
      const right = Math.min(canvas.width - 1, centerX + radius);
      const bottom = Math.min(canvas.height - 1, centerY + radius);
      const width = right - left + 1;
      const height = bottom - top + 1;
      const image = context.getImageData(left, top, width, height).data;
      const samples = [];
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let index = 0; index < image.length; index += 4) {
        const sample = [
          image[index] || 0,
          image[index + 1] || 0,
          image[index + 2] || 0,
          image[index + 3] || 0
        ];
        samples.push(sample);
        sumR += sample[0];
        sumG += sample[1];
        sumB += sample[2];
        sumA += sample[3];
      }
      return { ok: true, left, top, width, height, count: samples.length, sumR, sumG, sumB, sumA, samples };
    };
    const compareSurfaceProbe = (after) => {
      const before = window.__airbrushRuntimeValidationSurfaceProbe?.before || null;
      if (!before?.samples?.length || !after?.samples?.length || before.samples.length !== after.samples.length) {
        return { ok: false, reason: "missing-comparable-surface-probe" };
      }
      let changedSamples = 0;
      let sumAbsDelta = 0;
      let maxAbsDelta = 0;
      for (let index = 0; index < before.samples.length; index += 1) {
        const left = before.samples[index] || [];
        const right = after.samples[index] || [];
        let sampleDelta = 0;
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs((Number(right[channel]) || 0) - (Number(left[channel]) || 0));
          sampleDelta += delta;
          maxAbsDelta = Math.max(maxAbsDelta, delta);
        }
        if (sampleDelta > 0) {
          changedSamples += 1;
          sumAbsDelta += sampleDelta;
        }
      }
      return { ok: true, changedSamples, sumAbsDelta, maxAbsDelta };
    };
    const summarizeDisplay = async () => {
      editor.render?.();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const viewerFrame = captureViewerFrame();
      const viewerPaintDelta = compareViewerFrameChange(
        window.__airbrushRuntimeValidationViewerBaseline || null,
        viewerFrame
      );
      const viewerPaintColorDelta = compareViewerPaintColorChange(
        window.__airbrushRuntimeValidationViewerBaseline || null,
        viewerFrame,
        window.__airbrushRuntimeValidationPaintColor || null,
        window.__airbrushRuntimeValidationStrokeFrameBounds || null
      );
      const surface = sampleSurfaceProbe();
      return {
        surface,
        surfaceDeltaFromBefore: compareSurfaceProbe(surface),
        viewerFrame: summarizeViewerFrame(viewerFrame),
        viewerPaintDelta,
        viewerPaintColorDelta
      };
    };
    const summarizeHistoryState = (state = null) => {
      const probe = window.__airbrushRuntimeValidationSurfaceProbe || null;
      const pixel = probe?.pixel || null;
      const summarizeBounds = (bounds = null) => bounds
        ? {
            x: Math.floor(Number(bounds.x) || 0),
            y: Math.floor(Number(bounds.y) || 0),
            width: Math.floor(Number(bounds.width) || 0),
            height: Math.floor(Number(bounds.height) || 0),
            containsProbe: pixel
              ? (
                  Number(pixel.x) >= Number(bounds.x)
                  && Number(pixel.x) < Number(bounds.x) + Number(bounds.width)
                  && Number(pixel.y) >= Number(bounds.y)
                  && Number(pixel.y) < Number(bounds.y) + Number(bounds.height)
                )
              : false
          }
        : null;
      return {
        kind: state?.kind || "",
        label: state?.label || "",
        entryCount: state?.entries?.length || 0,
        entries: (state?.entries || []).map((entry) => ({
          type: entry?.type || "",
          bounds: summarizeBounds(entry?.bounds || null),
          regionCount: entry?.regions?.length || 0,
          regions: (entry?.regions || []).slice(0, 16).map((region) => summarizeBounds(region?.bounds || null)),
          regionsContainProbe: (entry?.regions || []).some((region) => summarizeBounds(region?.bounds || null)?.containsProbe === true),
          hasBefore: Boolean(entry?.before),
          hasAfter: Boolean(entry?.after),
          hasBeforeSourceImageData: Boolean(entry?.beforeSourceImageData)
        }))
      };
    };
    const undoTiming = {};
    const profileMethod = (name) => {
      const original = editor[name];
      if (typeof original !== "function") {
        return;
      }
      editor[name] = function(...methodArgs) {
        const started = performance.now();
        try {
          return original.apply(this, methodArgs);
        } finally {
          const entry = undoTiming[name] || { count: 0, ms: 0 };
          entry.count += 1;
          entry.ms += performance.now() - started;
          undoTiming[name] = entry;
        }
      };
    };
    [
      "restoreTexturePaintSnapshot",
      "clearTexturePaintGpuTarget",
      "texturePaintCompositeMaterialLayerDisplay",
      "texturePaintCompositeMaterialLayerGpuTargets",
      "flushTexturePaintLayerGpuTargetsToCanvases",
      "prepareTexturePaintLayerTargetChange",
      "renderTexturePaintLayerPanel",
      "updateClonePaintPreviews",
      "syncPatchJson",
      "updateUndoButton"
    ].forEach(profileMethod);
    const waitUntil = async (predicate, timeout = 3000) => {
      const started = performance.now();
      while (performance.now() - started < timeout) {
        if (predicate()) {
          return true;
        }
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      return false;
    };
    const clickUiButton = async (selector) => {
      const button = document.querySelector(selector);
      if (!button) {
        return { selector, found: false, disabled: true, clicked: false };
      }
      const disabled = button.disabled === true;
      if (!disabled) {
        button.click();
      }
      return { selector, found: true, disabled, clicked: !disabled };
    };
    await flushPaint();
    const beforeUndo = summarize();
    const undoStarted = performance.now();
    const undoClick = await clickUiButton("#undo-edit");
    await waitUntil(() => (editor.undoStack?.length || 0) === 0 && (editor.redoStack?.length || 0) > 0);
    const undoDurationMs = performance.now() - undoStarted;
    await flushPaint();
    const afterUndo = summarize();
    const afterUndoDisplay = await summarizeDisplay();
    const redoTopAfterUndo = summarizeHistoryState(editor.redoStack?.at?.(-1) || editor.redoStack?.[editor.redoStack.length - 1] || null);
    const addClick = await clickUiButton("#texture-layer-add");
    await waitUntil(() => {
      const material = editor.texturePaintActiveMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
      const stack = material?.userData?.texturePaintLayerStack || null;
      const active = (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId) || null;
      return active?.autoCreated === false && document.querySelector(".texture-layer-row[data-layer-id]");
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const afterAdd = summarize();
    const validation = window.__airbrushRuntimeValidation || {};
    validation.pointerDowns = 0;
    validation.paintEvents = 0;
    validation.resetPaintEvents = 0;
    validation.queuedPayloads = 0;
    validation.projectionCalls = 0;
    validation.projectionChanged = 0;
    window.__airbrushRuntimeValidation = validation;
    return {
      ready: true,
      undoResult: undoClick.clicked && afterUndo.undoStackLength === 0 && afterUndo.redoStackLength > 0,
      undoClick,
      undoDurationMs,
      undoTiming,
      addResult: addClick.clicked && afterAdd.layers.some((layer) => layer.name === "Paint 1" && layer.autoCreated === false),
      addClick,
      beforeUndo,
      afterUndo,
      afterUndoDisplay,
      redoTopAfterUndo,
      afterAdd
    };
  })()`;
}

function runtimeLayerAfterUndoResultExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { error: "missing-editor" };
    }
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < 12; index += 1) {
      const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
      if (pending && typeof pending.then === "function") {
        await pending;
      }
      if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
        break;
      }
      await delay(25);
    }
    await delay(50);
    const material = editor.texturePaintActiveMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
    const stack = material?.userData?.texturePaintLayerStack || null;
    const activeLayer = (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId)
      || stack?.layers?.[0]
      || null;
    const targetTexture = activeLayer?.gpuTarget?.target?.texture || null;
    const composite = material?.userData?.texturePaintCompositeGpuTarget || null;
    const liveState = material?.userData?.texturePaintLiveLayerShaderComposite || null;
    const displayBeforeReadback = {
      hasActiveLayerTarget: Boolean(targetTexture),
      materialMapIsLayer: Boolean(targetTexture && material?.map === targetTexture),
      materialMapIsComposite: Boolean(composite?.target?.texture && material?.map === composite.target.texture),
      liveShaderInstalled: Boolean(liveState),
      liveShaderUsesActiveLayer: Boolean(targetTexture && liveState?.layerTexture === targetTexture),
      liveShaderLayerOpacity: Number(liveState?.layerOpacity ?? 0),
      forceDisplayCompositeOnce: activeLayer?.gpuTarget?.forceDisplayCompositeOnce === true,
      includesActiveLayer: Boolean(
        targetTexture
        && (
          material?.map === targetTexture
          || (composite?.target?.texture && material?.map === composite.target.texture)
          || (liveState?.layerTexture === targetTexture && Number(liveState.layerOpacity ?? 0) > 0)
        )
      )
    };
    editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      material,
      composite: true
    });
    const alphaStats = (layer) => {
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!canvas || !context) {
        return { count: 0, sum: 0 };
      }
      const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      let sum = 0;
      for (let index = 3; index < image.length; index += 4) {
        const alpha = image[index];
        if (alpha > 0) {
          count += 1;
          sum += alpha;
        }
      }
      return { count, sum };
    };
    const summarizeLayer = (layer) => ({
      id: layer?.id || "",
      name: layer?.name || "",
      autoCreated: layer?.autoCreated === true,
      isEmpty: layer?.isEmpty === true,
      visible: layer?.visible !== false,
      opacity: Number(layer?.opacity ?? 1),
      alpha: alphaStats(layer),
      gpuTarget: layer?.gpuTarget ? {
        emptyTransparent: layer.gpuTarget.emptyTransparent === true,
        paintRevision: Math.max(0, Math.floor(Number(layer.gpuTarget.paintRevision) || 0)),
        hasTarget: Boolean(layer.gpuTarget.target?.texture)
      } : null
    });
    const summarizeMaterial = (entry, index) => {
      const material = entry?.material || null;
      const materialStack = material?.userData?.texturePaintLayerStack || null;
      return {
        index,
        name: material?.name || "",
        activeLayerId: materialStack?.activeLayerId || "",
        layers: (materialStack?.layers || []).map(summarizeLayer)
      };
    };
    return {
      activeTool: editor.activeTool,
      painting: Boolean(editor.painting),
      screenStrokeChanged: editor.textureAirbrushScreenStrokeChanged === true,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      status: document.getElementById("viewer-status")?.textContent || "",
      undoStackLength: editor.undoStack?.length || 0,
      redoStackLength: editor.redoStack?.length || 0,
      rows: Array.from(document.querySelectorAll(".texture-layer-row")).map((row) => ({
        text: row.textContent.trim(),
        layerId: row.dataset.layerId || "",
        locked: row.classList.contains("is-locked"),
        active: row.classList.contains("is-active"),
        selected: row.classList.contains("is-selected")
      })),
      layers: (stack?.layers || []).map(summarizeLayer),
      materials: (editor.textureAirbrushPaintableMaterials?.() || []).map(summarizeMaterial),
      activeLayerAlpha: alphaStats(activeLayer),
      displayBeforeReadback,
      validation: window.__airbrushRuntimeValidation || null
    };
  })()`;
}

function runtimeThirdLayerAddExpression(layerNumber) {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flushPaint = async () => {
      for (let index = 0; index < 12; index += 1) {
        const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
        if (pending && typeof pending.then === "function") {
          await pending;
        }
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(25);
      }
      await delay(50);
    };
    const summarizeLayer = (layer) => ({
      id: layer?.id || "",
      name: layer?.name || "",
      autoCreated: layer?.autoCreated === true,
      isEmpty: layer?.isEmpty === true,
      visible: layer?.visible !== false,
      opacity: Number(layer?.opacity ?? 1),
      gpuTarget: layer?.gpuTarget ? {
        emptyTransparent: layer.gpuTarget.emptyTransparent === true,
        paintRevision: Math.max(0, Math.floor(Number(layer.gpuTarget.paintRevision) || 0)),
        hasTarget: Boolean(layer.gpuTarget.target?.texture)
      } : null
    });
    const summarize = () => {
      const material = editor.texturePaintActiveMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
      const stack = material?.userData?.texturePaintLayerStack || null;
      return {
        activeLayerId: stack?.activeLayerId || "",
        selectedLayerIds: stack?.selectedLayerIds || [],
        layers: (stack?.layers || []).map(summarizeLayer),
        rows: Array.from(document.querySelectorAll(".texture-layer-row")).map((row) => ({
          text: row.textContent.trim(),
          layerId: row.dataset.layerId || "",
          locked: row.classList.contains("is-locked"),
          active: row.classList.contains("is-active"),
          selected: row.classList.contains("is-selected")
        }))
      };
    };
    await flushPaint();
    const button = document.querySelector("#texture-layer-add");
    if (!button || button.disabled) {
      return { ready: false, error: "missing-add-button", beforeAdd: summarize() };
    }
    button.click();
    const expectedName = "Paint ${Number(layerNumber) || 1}";
    const waitUntil = async (predicate, timeout = 3000) => {
      const started = performance.now();
      while (performance.now() - started < timeout) {
        if (predicate()) {
          return true;
        }
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
      return false;
    };
    await waitUntil(() => {
      const material = editor.texturePaintActiveMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
      const stack = material?.userData?.texturePaintLayerStack || null;
      const active = (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId) || null;
      return active?.name === expectedName && active?.autoCreated === false;
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const validation = window.__airbrushRuntimeValidation || {};
    validation.pointerDowns = 0;
    validation.paintEvents = 0;
    validation.resetPaintEvents = 0;
    validation.queuedPayloads = 0;
    validation.projectionCalls = 0;
    validation.projectionChanged = 0;
    window.__airbrushRuntimeValidation = validation;
    const afterAdd = summarize();
    const activeLayer = afterAdd.layers.find((layer) => layer.id === afterAdd.activeLayerId) || null;
    return {
      ready: activeLayer?.name === expectedName,
      expectedName,
      afterAdd,
      activeLayer
    };
  })()`;
}

function runtimeThirdLayerPaintResultExpression(layerNumber) {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { error: "missing-editor" };
    }
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < 12; index += 1) {
      const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
      if (pending && typeof pending.then === "function") {
        await pending;
      }
      if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
        break;
      }
      await delay(25);
    }
    await delay(50);
    const material = editor.texturePaintActiveMaterial || editor.texturePaintFirstLayerMaterial?.() || null;
    const stack = material?.userData?.texturePaintLayerStack || null;
    const activeLayer = (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId)
      || null;
    const targetTexture = activeLayer?.gpuTarget?.target?.texture || null;
    const composite = material?.userData?.texturePaintCompositeGpuTarget || null;
    const liveState = material?.userData?.texturePaintLiveLayerShaderComposite || null;
    const displayBeforeReadback = {
      hasActiveLayerTarget: Boolean(targetTexture),
      materialMapIsLayer: Boolean(targetTexture && material?.map === targetTexture),
      materialMapIsComposite: Boolean(composite?.target?.texture && material?.map === composite.target.texture),
      liveShaderInstalled: Boolean(liveState),
      liveShaderUsesActiveLayer: Boolean(targetTexture && liveState?.layerTexture === targetTexture),
      liveShaderLayerOpacity: Number(liveState?.layerOpacity ?? 0),
      forceDisplayCompositeOnce: activeLayer?.gpuTarget?.forceDisplayCompositeOnce === true,
      includesActiveLayer: Boolean(
        targetTexture
        && (
          material?.map === targetTexture
          || (composite?.target?.texture && material?.map === composite.target.texture)
          || (liveState?.layerTexture === targetTexture && Number(liveState.layerOpacity ?? 0) > 0)
        )
      )
    };
    editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      material,
      composite: true
    });
    const alphaStats = (layer) => {
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!canvas || !context) {
        return { count: 0, sum: 0 };
      }
      const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      let sum = 0;
      for (let index = 3; index < image.length; index += 4) {
        const alpha = image[index];
        if (alpha > 0) {
          count += 1;
          sum += alpha;
        }
      }
      return { count, sum };
    };
    const summarizeLayer = (layer) => ({
      id: layer?.id || "",
      name: layer?.name || "",
      autoCreated: layer?.autoCreated === true,
      isEmpty: layer?.isEmpty === true,
      visible: layer?.visible !== false,
      opacity: Number(layer?.opacity ?? 1),
      alpha: alphaStats(layer),
      gpuTarget: layer?.gpuTarget ? {
        emptyTransparent: layer.gpuTarget.emptyTransparent === true,
        paintRevision: Math.max(0, Math.floor(Number(layer.gpuTarget.paintRevision) || 0)),
        hasTarget: Boolean(layer.gpuTarget.target?.texture)
      } : null
    });
    return {
      layerNumber: ${Number(layerNumber) || 1},
      activeTool: editor.activeTool,
      activeLayerId: stack?.activeLayerId || "",
      selectedLayerIds: stack?.selectedLayerIds || [],
      painting: Boolean(editor.painting),
      screenStrokeChanged: editor.textureAirbrushScreenStrokeChanged === true,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      status: document.getElementById("viewer-status")?.textContent || "",
      rows: Array.from(document.querySelectorAll(".texture-layer-row")).map((row) => ({
        text: row.textContent.trim(),
        layerId: row.dataset.layerId || "",
        locked: row.classList.contains("is-locked"),
        active: row.classList.contains("is-active"),
        selected: row.classList.contains("is-selected")
      })),
      layers: (stack?.layers || []).map(summarizeLayer),
      activeLayerAlpha: alphaStats(activeLayer),
      displayBeforeReadback,
      validation: window.__airbrushRuntimeValidation || null
    };
  })()`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
