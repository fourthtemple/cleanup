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
const timeoutMs = positiveInteger(args.timeout || process.env.AIRBRUSH_RUNTIME_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const headless = args.headed !== true && process.env.AIRBRUSH_RUNTIME_HEADLESS !== "0";
const keepOpen = args.keepOpen === true || process.env.AIRBRUSH_RUNTIME_KEEP_OPEN === "1";
const layerAfterUndo = args.layerAfterUndo === true || process.env.AIRBRUSH_RUNTIME_LAYER_AFTER_UNDO === "1";
const thirdLayer = args.thirdLayer === true || process.env.AIRBRUSH_RUNTIME_THIRD_LAYER === "1";

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

  const prepared = await evaluateRuntime(cdp, runtimePreparationExpression(), { awaitPromise: true, timeoutMs });
  if (!prepared?.ready) {
    throw new Error(`Airbrush runtime preparation failed: ${prepared?.error || "unknown"}`);
  }

  await dispatchAirbrushStroke(cdp, prepared.stroke);
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
    ...runtimeAirbrushChecks(prepared, painted),
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
    painted,
    ...(layerAfterUndo ? { layerSetup, layerPainted } : {}),
    ...(thirdLayer ? { thirdLayerSteps } : {})
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    const failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    throw new Error(`Airbrush runtime validation failed: ${failed}`);
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
  console.log(`Usage: npm run validate:airbrush -- [options]

Options:
  --url <url>       Validate an already running Cleanup app.
  --browser <path>  Chrome/Chromium executable path.
  --timeout <ms>    Timeout for server/browser readiness.
  --headed          Launch Chrome visibly instead of headless.
  --keep-open       Leave Chrome open after validation.
  --layer-after-undo  Validate paint, undo, add Paint 1, then paint Paint 1.
  --third-layer     Validate adding and painting Paint 1, Paint 2, and Paint 3.
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

async function dispatchAirbrushStroke(cdp, stroke) {
  const { start, mid, end } = stroke;
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
  await delay(30);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
}

function runtimeAirbrushChecks(prepared, painted) {
  return {
    editorReady: prepared?.ready === true,
    assetLoaded: prepared?.loaded === true,
    paintRecordsAvailable: Number(prepared?.paintRecords) > 0,
    paintableHit: prepared?.hitFound === true,
    activeAirbrush: painted?.activeTool === "airbrush",
    pointerReachedCanvas: Number(painted?.validation?.pointerDowns) > 0,
    paintPathCalled: Number(painted?.validation?.paintEvents) > 0,
    strokeQueued: Number(painted?.validation?.queuedPayloads) > 0,
    projectionCalled: Number(painted?.validation?.projectionCalls) > 0,
    projectedPixelsChanged: Number(painted?.validation?.projectionChanged) > 0,
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

function runtimePreparationExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await editor.loadAnimationLibraryAsset({
      key: "airbrush-runtime:humanoid-cat-walking",
      name: "humanoid-cat-walking.fbx",
      label: "humanoid-cat-walking",
      extension: "fbx",
      folder: "cat",
      path: "assets/models/animation-library/cat/humanoid-cat-walking.fbx",
      url: "./assets/models/animation-library/cat/humanoid-cat-walking.fbx",
      cleanupFile: "humanoid-cat-walking-weight-patch.json",
      cleanupPath: "assets/models/animation-library/cat/humanoid-cat-walking-weight-patch.json",
      engine: true,
      demo: true
    });
    for (let index = 0; index < 6; index += 1) {
      await waitFrame();
    }
    editor.render?.();
    editor.setTool?.("airbrush");
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
    const xFractions = [0.5, 0.46, 0.54, 0.42, 0.58, 0.38, 0.62, 0.34, 0.66];
    const yFractions = [0.5, 0.46, 0.54, 0.42, 0.58, 0.38, 0.62, 0.34, 0.66, 0.3, 0.7];
    let chosen = null;
    for (const yFraction of yFractions) {
      for (const xFraction of xFractions) {
        const clientX = rect.left + rect.width * xFraction;
        const clientY = rect.top + rect.height * yFraction;
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
        paintRecords: editor.paintRecords?.length || 0,
        error: "missing-paintable-hit"
      };
    }
    const offset = Math.max(8, Math.min(24, rect.width * 0.025));
    const clampX = (value) => Math.max(rect.left + 2, Math.min(rect.right - 2, value));
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
    return {
      ready: true,
      loaded: Boolean(editor.model),
      paintRecords: editor.paintRecords?.length || 0,
      activeTool: editor.activeTool,
      hitFound: true,
      hit: chosen,
      canvas: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      },
      stroke: {
        start: { x: clampX(chosen.clientX - offset), y: chosen.clientY },
        mid: { x: chosen.clientX, y: chosen.clientY },
        end: { x: clampX(chosen.clientX + offset), y: chosen.clientY }
      }
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
    return {
      activeTool: editor.activeTool,
      painting: Boolean(editor.painting),
      screenStrokeChanged: editor.textureAirbrushScreenStrokeChanged === true,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      status: document.getElementById("viewer-status")?.textContent || "",
      undoStackLength: editor.undoStack?.length || 0,
      validation: window.__airbrushRuntimeValidation || null
    };
  })()`;
}

function runtimeLayerAfterUndoSetupExpression() {
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
