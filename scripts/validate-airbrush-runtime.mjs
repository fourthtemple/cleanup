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
const afterOrbitNeighbor = args.afterOrbitNeighbor === true || process.env.AIRBRUSH_RUNTIME_AFTER_ORBIT_NEIGHBOR === "1";
const afterOrbitMacro = args.afterOrbitMacro === true || process.env.AIRBRUSH_RUNTIME_AFTER_ORBIT_MACRO === "1";

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

  if (afterOrbitMacro) {
    const result = await evaluateRuntime(cdp, runtimeAfterOrbitMacroExpression(), { awaitPromise: true, timeoutMs });
    const checks = runtimeAfterOrbitMacroChecks(result);
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      afterOrbitMacro,
      checks,
      result
    };
    console.log(JSON.stringify(summary, null, 2));

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

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush after-orbit Neighbor runtime validation failed: ${failed}`);
    }
  } else {
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
  --after-orbit-neighbor  Validate Neighbor paint, orbit, then Neighbor paint again.
  --after-orbit-macro  Validate the packaged after-orbit Neighbor paint repro macro.
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
    visibleOnlyNeighborCutoffConfigured: Number(result?.neighborViewNormalThreshold) >= -1,
    queueDrained: Number(result?.queueLength) === 0 && Number(result?.pendingBatches) === 0,
    activeAirbrushAfterValidation: result?.activeTool === "airbrush"
  };
}

function runtimeAfterOrbitMacroExpression() {
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
    const macro = editor.tutorialMacro?.("after-orbit-paint") || null;
    if (!macro?.events?.length) {
      return { ready: false, loaded: true, loadedAsset, macroLoaded: false, error: "missing-after-orbit-macro" };
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
    const originalCameraChanged = editor.textureAirbrushCameraChanged?.bind(editor);
    const originalSetTexturePaintNeighborMode = editor.setTexturePaintNeighborMode?.bind(editor);
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
    window.__airbrushRuntimeValidation = validation;

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
    const macroPlayed = await editor.playTutorialMacro?.("after-orbit-paint", {
      resetDemo: false,
      preservePointerMoves: true,
      requireCurrentScene: true,
      statusIfMissing: false
    });
    phase = "post-macro";
    await flushPaint();
    editor.flushTexturePaintLayerGpuTargetsToCanvases?.({ composite: true });
    const shader = editor.textureAirbrushBrushShaderMaterial?.();
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
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      macroLoaded: true,
      macroPlayed: macroPlayed === true,
      airbrushStrokeCount: airbrushStrokes.length,
      layerAdded,
      activeTool: editor.activeTool,
      painting: Boolean(editor.painting),
      neighborEnabled: editor.texturePaintNeighborModeEnabled?.() === true,
      paintRecords: editor.paintRecords?.length || 0,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      flushing: Boolean(editor.textureAirbrushFlushingScreenStroke),
      neighborViewNormalThreshold: Number(shader?.uniforms?.neighborViewNormalThreshold?.value ?? 0),
      beforeSecondStrokeSnapshot: {
        captured: Boolean(beforeSecondStrokeSnapshot),
        layerCount: beforeSecondStrokeSnapshot?.layerCount || 0,
        pixelCount: beforeSecondStrokeSnapshot?.pixelCount || 0,
        eventPoint: beforeSecondStrokeEventPoint
      },
      secondStrokeCoverage,
      secondStrokeBandCoverage,
      secondStrokeOffPathPaint,
      validation
    };
  })()`;
}

function runtimeAfterOrbitMacroChecks(result) {
  const pathCoverage = result?.secondStrokeCoverage || {};
  const bandCoverage = result?.secondStrokeBandCoverage || {};
  const pathPaintedMin = Number(pathCoverage.paintedMinAlpha) || 0;
  const pathPaintedMax = Number(pathCoverage.paintedMaxAlpha) || 0;
  const bandPaintedMin = Number(bandCoverage.paintedMinAlpha) || 0;
  const bandPaintedMax = Number(bandCoverage.paintedMaxAlpha) || 0;
  const bandVisibleSamples = Number(bandCoverage.visibleSamples) || 0;
  const bandAllowedEdgeHoles = Math.max(1, Math.floor(bandVisibleSamples * 0.02));
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    macroLoaded: result?.macroLoaded === true,
    macroPlayed: result?.macroPlayed === true,
    macroHasTwoAirbrushStrokes: Number(result?.airbrushStrokeCount) >= 2,
    paintLayerCreated: result?.layerAdded === true,
    neighborEnabled: result?.neighborEnabled === true,
    noNeighborModeResetDuringMacro: !(result?.validation?.neighborModeSetCalls || [])
      .some((call) => String(call?.phase || "") !== "setup"),
    secondNeighborProjectionUsed: Number(result?.validation?.byPhase?.["macro-second"]?.neighborProjectionCalls) > 0,
    secondStrokeProjected: Number(result?.validation?.byPhase?.["macro-second"]?.projectionChanged) > 0,
    beforeSecondStrokeSnapshotCaptured: result?.beforeSecondStrokeSnapshot?.captured === true
      && Number(result?.beforeSecondStrokeSnapshot?.layerCount) > 0,
    finalStrokePathCovered: Number(result?.secondStrokeCoverage?.visibleSamples) >= 8
      && Number(result?.secondStrokeCoverage?.coverageRatio) >= 0.75,
    finalStrokePathSolid: Number(result?.secondStrokeCoverage?.visibleSamples) >= 8
      && Number(result?.secondStrokeCoverage?.strongCoverageRatio) >= 1,
    finalStrokePathUniform: Number(pathCoverage.visibleSamples) >= 8
      && Number(pathCoverage.coverageRatio) >= 1
      && Number(pathCoverage.strongCoverageRatio) >= 1
      && Number(pathCoverage.uniformCoverageRatio) >= 0.95
      && pathPaintedMax > 0
      && pathPaintedMin >= Math.max(72, pathPaintedMax * 0.65),
    finalStrokeBandCovered: Number(result?.secondStrokeBandCoverage?.visibleSamples) >= 24
      && Number(result?.secondStrokeBandCoverage?.coverageRatio) >= 0.92
      && Number(result?.secondStrokeBandCoverage?.strongCoverageRatio) >= 0.82,
    finalStrokeBandUniform: bandVisibleSamples >= 24
      && Number(bandCoverage.coverageRatio) >= 0.98
      && Number(bandCoverage.strongCoverageRatio) >= 0.9
      && Number(bandCoverage.holeSamples) <= bandAllowedEdgeHoles
      && bandPaintedMax > 0
      && bandPaintedMin >= Math.max(3, bandPaintedMax * 0.03),
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
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(25);
      }
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
    let totalSecondVisibleSamples = 0;
    let totalSecondPaintedSamples = 0;
    let previousAlpha = afterFirstAlpha;
    for (let index = 0; index < secondCandidates.length; index += 1) {
      const stroke = strokeFor(secondCandidates[index]);
      const seed = neighborSeedForStroke(stroke);
      const coverageBefore = strokeCoverage(stroke, seed);
      await paintStroke(stroke, "second-" + index, { flush: true });
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
    const shader = editor.textureAirbrushBrushShaderMaterial?.();
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
      neighborViewNormalThreshold: Number(shader?.uniforms?.neighborViewNormalThreshold?.value ?? 0),
      status: document.getElementById("viewer-status")?.textContent || "",
      validation
    };
  })()`;
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
