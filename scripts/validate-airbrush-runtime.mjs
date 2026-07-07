import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

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
const frontBackLeak = args.frontBackLeak === true || process.env.AIRBRUSH_RUNTIME_FRONT_BACK_LEAK === "1";
const visualAirbrushProof = args.visualAirbrushProof === true || process.env.AIRBRUSH_RUNTIME_VISUAL_AIRBRUSH_PROOF === "1";
const visualAirbrushLiveProof = args.visualAirbrushLiveProof === true || process.env.AIRBRUSH_RUNTIME_VISUAL_AIRBRUSH_LIVE_PROOF === "1";
const visualAirbrushMatrixProof = args.visualAirbrushMatrixProof === true || process.env.AIRBRUSH_RUNTIME_VISUAL_AIRBRUSH_MATRIX_PROOF === "1";
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
    await captureVisualAirbrushProofScreenshots(cdp, result);

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
    await captureVisualAirbrushProofScreenshots(cdp, result);

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
    await captureVisualAirbrushProofScreenshots(cdp, result);

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush side-edge softness validation failed: ${failed}`);
    }
  } else if (frontBackLeak) {
    const result = await evaluateRuntime(cdp, runtimeFrontBackLeakExpression(), { awaitPromise: true, timeoutMs });
    const checks = runtimeFrontBackLeakChecks(result);
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      frontBackLeak,
      checks,
      result
    };
    console.log(JSON.stringify(summary, null, 2));
    await captureValidationLayerImage(cdp);
    await captureValidationScreenshot(cdp);
    await captureVisualAirbrushProofScreenshots(cdp, result);

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush front/back leak validation failed: ${failed}`);
    }
  } else if (visualAirbrushLiveProof) {
    const result = await runVisualAirbrushLiveProof(cdp);
    const checks = runtimeVisualAirbrushLiveProofChecks(result);
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      visualAirbrushLiveProof,
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
      throw new Error(`Airbrush live visual proof validation failed: ${failed}`);
    }
  } else if (visualAirbrushMatrixProof) {
    const result = await evaluateRuntime(cdp, runtimeVisualAirbrushMatrixProofExpression(), { awaitPromise: true, timeoutMs });
    const checks = runtimeVisualAirbrushMatrixProofChecks(result);
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      visualAirbrushMatrixProof,
      checks,
      result
    };
    console.log(JSON.stringify(summary, null, 2));
    await captureValidationLayerImage(cdp);
    await captureValidationScreenshot(cdp);
    await captureVisualAirbrushProofScreenshots(cdp, result);

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush matrix visual proof validation failed: ${failed}`);
    }
  } else if (visualAirbrushProof) {
    const result = await evaluateRuntime(cdp, runtimeVisualAirbrushProofExpression(), { awaitPromise: true, timeoutMs });
    const checks = runtimeVisualAirbrushProofChecks(result);
    const summary = {
      ok: Object.values(checks).every(Boolean),
      url: validationUrl,
      headless,
      visualAirbrushProof,
      checks,
      result
    };
    console.log(JSON.stringify(summary, null, 2));
    await captureValidationLayerImage(cdp);
    await captureValidationScreenshot(cdp);
    await captureVisualAirbrushProofScreenshots(cdp, result);

    if (!summary.ok) {
      const failed = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(", ");
      throw new Error(`Airbrush visual proof validation failed: ${failed}`);
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
    } else if (value === "--front-back-leak") {
      parsed.frontBackLeak = true;
    } else if (value === "--visual-airbrush-proof") {
      parsed.visualAirbrushProof = true;
    } else if (value === "--visual-airbrush-live-proof") {
      parsed.visualAirbrushLiveProof = true;
    } else if (value === "--visual-airbrush-matrix-proof") {
      parsed.visualAirbrushMatrixProof = true;
    } else if (value === "--visual-proof-dir") {
      parsed.visualProofDir = argv[++index] || "";
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
  --front-back-leak  Paint the front, orbit to the back, and reject visible rear green leaks.
  --visual-airbrush-proof  Paint large green soft strokes and capture close-up proof crops.
  --visual-airbrush-live-proof  Capture before/live/final close-ups around a real browser drag.
  --visual-airbrush-matrix-proof  Capture control/layer matrix visual proof crops.
  --visual-proof-dir <path> Save visual proof crop screenshots to a directory.
  --hit-callers    Include opt-in texture hit-test caller buckets in validation output.
`);
}

async function runVisualAirbrushLiveProof(cdp) {
  const setup = await evaluateRuntime(cdp, runtimeVisualAirbrushLiveProofSetupExpression(), {
    awaitPromise: true,
    timeoutMs
  });
  const screenshots = [];
  const screenshotsByName = new Map();
  const capture = async (name, clip = setup?.clip) => {
    if (!args.visualProofDir || !clip) {
      return null;
    }
    const screenshot = await captureProofScreenshot(cdp, name, clip);
    screenshots.push(screenshot);
    screenshotsByName.set(screenshot.name, screenshot);
    return screenshot;
  };
  if (!setup?.ready) {
    return { ready: false, setup, screenshots };
  }
  const path = Array.isArray(setup?.stroke?.path) ? setup.stroke.path : [];
  if (path.length < 3) {
    return { ready: false, setup, screenshots, error: "missing-live-stroke-path" };
  }
  await capture("shoulder-torso-before");
  const start = path[0];
  const midIndex = Math.max(1, Math.floor((path.length - 1) / 2));
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: start.x,
    y: start.y,
    button: "none",
    buttons: 0
  });
  await delay(24);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  await delay(28);
  for (let index = 1; index <= midIndex; index += 1) {
    const point = path[index];
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1
    });
    await delay(28);
  }
  await delay(120);
  const liveMid = await evaluateRuntime(cdp, `window.__airbrushLiveProof?.report?.("live-mid") || { ready: false, error: "missing-live-proof-report" }`, {
    awaitPromise: true,
    timeoutMs
  });
  await capture("shoulder-torso-live-mid");
  for (let index = midIndex + 1; index < path.length; index += 1) {
    const point = path[index];
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1
    });
    await delay(28);
  }
  await delay(120);
  const live = await evaluateRuntime(cdp, `window.__airbrushLiveProof?.report?.("live-full") || { ready: false, error: "missing-live-proof-report" }`, {
    awaitPromise: true,
    timeoutMs
  });
  await capture("shoulder-torso-live-full");
  const end = path[path.length - 1];
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  const final = await evaluateRuntime(cdp, `window.__airbrushLiveProof?.finalize?.() || { ready: false, error: "missing-live-proof-finalize" }`, {
    awaitPromise: true,
    timeoutMs
  });
  await capture("shoulder-torso-final");
  const liveFinalPaintDiff = await compareProofGreenPaint(
    screenshotsByName.get("shoulder-torso-live-full"),
    screenshotsByName.get("shoulder-torso-final")
  );
  return {
    ready: setup.ready === true && live?.ready === true && final?.ready === true,
    setup,
    liveMid,
    live,
    final,
    liveFinalPaintDiff,
    screenshots
  };
}

async function captureValidationLayerImage(cdp) {
  if (!args.layerImage) {
    return;
  }
  const dataUrl = await evaluateRuntime(cdp, `(async () => {
    const editor = window.modelCleanupEditor;
    const flushed = editor?.flushTexturePaintLayerGpuTargetsToCanvases?.({
      composite: false,
      preserveWebGpuDisplay: true
    });
    if (flushed && typeof flushed.then === "function") {
      await flushed;
    }
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
  })()`, { awaitPromise: true });
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
  await mkdir(dirname(args.screenshot), { recursive: true });
  await writeFile(args.screenshot, Buffer.from(result.data, "base64"));
}

async function captureVisualAirbrushProofScreenshots(cdp, result = null) {
  if (!args.visualProofDir) {
    return;
  }
  const clips = Array.isArray(result?.screenshotClips) ? result.screenshotClips : [];
  if (!clips.length) {
    console.warn("Visual airbrush proof returned no screenshot clips.");
    return;
  }
  await mkdir(args.visualProofDir, { recursive: true });
  for (const clip of clips) {
    await captureProofScreenshot(cdp, clip?.name || "airbrush-proof", clip);
  }
}

async function captureProofScreenshot(cdp, name, clip) {
  if (!args.visualProofDir) {
    return null;
  }
  await mkdir(args.visualProofDir, { recursive: true });
  const safeName = String(name || "airbrush-proof").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const x = Math.max(0, Number(clip?.x) || 0);
  const y = Math.max(0, Number(clip?.y) || 0);
  const width = Math.max(1, Number(clip?.width) || 1);
  const height = Math.max(1, Number(clip?.height) || 1);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 }
  });
  if (!screenshot?.data) {
    throw new Error(`Visual proof screenshot capture returned no data for ${safeName}.`);
  }
  const path = join(args.visualProofDir, `${safeName}.png`);
  const bytes = Buffer.from(screenshot.data, "base64");
  await writeFile(path, bytes);
  return { name: safeName, path, clip: { x, y, width, height } };
}

async function compareProofGreenPaint(liveScreenshot = null, finalScreenshot = null) {
  if (!liveScreenshot?.path || !finalScreenshot?.path) {
    return { ready: false, error: "missing-screenshot-paths" };
  }
  try {
    const [liveBytes, finalBytes] = await Promise.all([
      readFile(liveScreenshot.path),
      readFile(finalScreenshot.path)
    ]);
    return compareGreenPaintPngBuffers(liveBytes, finalBytes);
  } catch (error) {
    return { ready: false, error: error?.message || String(error) };
  }
}

function compareGreenPaintPngBuffers(liveBytes, finalBytes) {
  const live = decodePngRgba(liveBytes);
  const final = decodePngRgba(finalBytes);
  if (!live || !final) {
    return { ready: false, error: "png-decode-failed" };
  }
  if (live.width !== final.width || live.height !== final.height) {
    return {
      ready: false,
      error: "png-size-mismatch",
      liveSize: { width: live.width, height: live.height },
      finalSize: { width: final.width, height: final.height }
    };
  }
  const paintThreshold = 24;
  let livePaintPixels = 0;
  let finalPaintPixels = 0;
  let missingFinalInLive = 0;
  let extraLivePaint = 0;
  let sharedPaintPixels = 0;
  let strengthDeltaSum = 0;
  let strengthDeltaMax = 0;
  for (let offset = 0; offset < live.rgba.length; offset += 4) {
    const liveStrength = greenPaintStrength(live.rgba, offset);
    const finalStrength = greenPaintStrength(final.rgba, offset);
    const livePainted = liveStrength >= paintThreshold;
    const finalPainted = finalStrength >= paintThreshold;
    if (livePainted) {
      livePaintPixels += 1;
    }
    if (finalPainted) {
      finalPaintPixels += 1;
    }
    if (finalPainted && !livePainted) {
      missingFinalInLive += 1;
    }
    if (livePainted && !finalPainted) {
      extraLivePaint += 1;
    }
    if (livePainted && finalPainted) {
      sharedPaintPixels += 1;
      const delta = Math.abs(liveStrength - finalStrength);
      strengthDeltaSum += delta;
      strengthDeltaMax = Math.max(strengthDeltaMax, delta);
    }
  }
  return {
    ready: true,
    width: live.width,
    height: live.height,
    paintThreshold,
    livePaintPixels,
    finalPaintPixels,
    sharedPaintPixels,
    missingFinalInLive,
    extraLivePaint,
    missingFinalInLiveRatio: finalPaintPixels ? missingFinalInLive / finalPaintPixels : 1,
    extraLivePaintRatio: livePaintPixels ? extraLivePaint / livePaintPixels : 1,
    sharedPaintRatio: finalPaintPixels ? sharedPaintPixels / finalPaintPixels : 0,
    meanSharedStrengthDelta: sharedPaintPixels ? strengthDeltaSum / sharedPaintPixels : 0,
    maxSharedStrengthDelta: strengthDeltaMax
  };
}

function greenPaintStrength(rgba, offset) {
  const red = rgba[offset] || 0;
  const green = rgba[offset + 1] || 0;
  const blue = rgba[offset + 2] || 0;
  const alpha = rgba[offset + 3] || 0;
  if (alpha < 12) {
    return 0;
  }
  return Math.max(0, green - Math.max(red, blue));
}

function decodePngRgba(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.length < 33 || signature.some((value, index) => data[index] !== value)) {
    return null;
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset + 8 <= data.length) {
    const length = readPngUint32(data, offset);
    const type = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + length;
    if (chunkEnd + 4 > data.length) {
      return null;
    }
    if (type === "IHDR") {
      width = readPngUint32(data, chunkStart);
      height = readPngUint32(data, chunkStart + 4);
      bitDepth = data[chunkStart + 8];
      colorType = data[chunkStart + 9];
      const interlace = data[chunkStart + 12];
      if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
        return null;
      }
    } else if (type === "IDAT") {
      idatChunks.push(data.subarray(chunkStart, chunkEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = chunkEnd + 4;
  }
  if (!width || !height || !idatChunks.length) {
    return null;
  }
  const compressedLength = idatChunks.reduce((total, chunk) => total + chunk.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let writeOffset = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  const inflated = inflateSync(compressed);
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const expectedLength = height * (rowBytes + 1);
  if (inflated.length < expectedLength) {
    return null;
  }
  const rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(rowBytes);
  const current = new Uint8Array(rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x] || 0;
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = raw;
      if (filter === 1) {
        value = raw + left;
      } else if (filter === 2) {
        value = raw + up;
      } else if (filter === 3) {
        value = raw + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        value = raw + paethPredictor(left, up, upLeft);
      } else if (filter !== 0) {
        return null;
      }
      current[x] = value & 255;
    }
    sourceOffset += rowBytes;
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      rgba[target] = current[source];
      rgba[target + 1] = current[source + 1];
      rgba[target + 2] = current[source + 2];
      rgba[target + 3] = colorType === 6 ? current[source + 3] : 255;
    }
    previous.set(current);
  }
  return { width, height, rgba };
}

function readPngUint32(data, offset) {
  return (
    ((data[offset] || 0) * 0x1000000)
    + ((data[offset + 1] || 0) << 16)
    + ((data[offset + 2] || 0) << 8)
    + (data[offset + 3] || 0)
  ) >>> 0;
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
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
  const layerTargetReceivedPaint = webGpuStats?.tslSurfaceAirbrush === true
    && webGpuStats?.tslSurfaceLayerTarget === true
    && Number(webGpuStats?.tslSurfaceLayerPaintRevision) > 0;
  const surfaceReceivedPaint = (surfaceDeltaSamples > 0 && surfaceDeltaSum > 0) || layerTargetReceivedPaint;
  const viewerReceivedPaint = painted?.viewerPaintDelta?.changed === true;
  const viewportReceivedPaintColor = painted?.viewerPaintColorDelta?.changed === true;
  const midStrokeViewerReceivedPaint = midStrokePainted?.viewerPaintDelta?.changed === true;
  const midStrokeViewportReceivedPaintColor = midStrokePainted?.viewerPaintColorDelta?.changed === true;
  const midStrokeLiveDisplayWorkPixels = Number(midStrokePainted?.liveDisplayWorkPixels) || 0;
  const midStrokeLiveDisplayStats = Number(midStrokePainted?.liveDisplayPaintStatsCount) || 0;
  const midStrokeStatsDelta = Number(midStrokePainted?.webGpuPaintStatsCountDelta) || 0;
  const midStrokeTslStats = midStrokePainted?.lastWebGpuPaintStats || null;
  const midStrokeTslRealtime = midStrokePainted?.painting === true
    && midStrokePainted?.screenStrokeChanged === true
    && midStrokeTslStats?.tslSurfaceAirbrush === true
    && midStrokeViewerReceivedPaint
    && midStrokeViewportReceivedPaintColor;
  const webGpuChanged = Boolean(webGpuStats)
    && painted?.screenStrokeChanged === true
    && (
      Number(painted?.webGpuPaintStatsCount) > 0
      || Number(webGpuStats?.appliedBytes) > 0
      || webGpuStats?.deferredReadbackCopy === true
      || webGpuStats?.tslSurfaceAirbrush === true
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
      && (
        (
          midStrokeStatsDelta > 0
          && midStrokeLiveDisplayStats > 0
          && midStrokeLiveDisplayWorkPixels > 0
        )
        || midStrokeTslRealtime
      )
      && midStrokeViewerReceivedPaint
      && midStrokeViewportReceivedPaintColor,
    paintPixelsChanged: (projectionChanged > 0 || webGpuChanged) && (
      activeLayerReceivedPaint
      || surfaceReceivedPaint
      || layerTargetReceivedPaint
      || (viewerReceivedPaint && viewportReceivedPaintColor)
    ),
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
  const layerStats = layerPainted?.lastWebGpuPaintStats || layerPainted?.webGpuStatus?.lastPaintStats || null;
  const tslLayerProjected = layerStats?.tslSurfaceAirbrush === true
    && layerStats?.tslSurfaceLayerTarget === true
    && Number(layerStats?.tslSurfaceLayerPaintRevision) > 0;
  const activeGpuLayer = afterPaintLayers.find((layer) => layer?.id === layerPainted?.activeLayerId)
    || afterPaintLayers.find((layer) => layer?.gpuTarget?.hasTarget === true)
    || null;
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
    layerProjectionCalled: Number(layerPainted?.validation?.projectionCalls) > 0 || tslLayerProjected,
    layerProjectedPixelsChanged: Number(layerPainted?.validation?.projectionChanged) > 0 || tslLayerProjected,
    layerPaintQueueDrained: Number(layerPainted?.queueLength) === 0 && Number(layerPainted?.pendingBatches) === 0,
    layerDisplayIncludesPaintBeforeReadback: layerPainted?.displayBeforeReadback?.includesActiveLayer === true,
    layerForceCompositeFlagConsumed: layerPainted?.displayBeforeReadback?.forceDisplayCompositeOnce === false,
    layerCanvasReceivedPaint: Number(layerPainted?.activeLayerAlpha?.count) > 0
      || Number(activeGpuLayer?.alpha?.count) > 0
      || tslLayerProjected,
    noPaint2AfterLayerPaint: !afterPaintLayers.some((layer) => layer?.name === "Paint 2")
  };
}

function runtimeThirdLayerChecks(steps) {
  const third = steps?.[2]?.layerResult || null;
  const thirdLayer = third?.layers?.find((layer) => layer.name === "Paint 3") || null;
  const activeLayer = third?.layers?.find((layer) => layer.id === third?.activeLayerId) || null;
  const thirdStats = third?.lastWebGpuPaintStats || third?.webGpuStatus?.lastPaintStats || null;
  const thirdTslPainted = thirdStats?.tslSurfaceAirbrush === true
    && thirdStats?.tslSurfaceLayerTarget === true
    && Number(thirdStats?.tslSurfaceLayerPaintRevision) > 0;
  return {
    thirdLayerStepsCompleted: Array.isArray(steps) && steps.length === 3,
    thirdLayerCreatedOnce: (third?.layers || []).filter((layer) => layer.name === "Paint 3").length === 1,
    thirdLayerIsActive: Boolean(thirdLayer?.id && thirdLayer.id === third?.activeLayerId),
    thirdLayerPaintPathCalled: Number(third?.validation?.paintEvents) > 0,
    thirdLayerStrokeQueued: Number(third?.validation?.queuedPayloads) > 0,
    thirdLayerProjectionChanged: Number(third?.validation?.projectionChanged) > 0 || thirdTslPainted,
    thirdLayerQueueDrained: Number(third?.queueLength) === 0 && Number(third?.pendingBatches) === 0,
    thirdLayerGpuTargetChanged: Number(thirdLayer?.gpuTarget?.paintRevision) > 0,
    thirdLayerCanvasReceivedPaint: Number(thirdLayer?.alpha?.count) > 0 || thirdTslPainted,
    thirdLayerDisplayIncludesPaintBeforeReadback: third?.displayBeforeReadback?.includesActiveLayer === true,
    thirdLayerTargetMatchesActiveLayer: Boolean(activeLayer && thirdLayer && activeLayer.id === thirdLayer.id)
  };
}

function runtimeAfterOrbitNeighborChecks(result) {
  const secondDeltas = Array.isArray(result?.secondAlphaDeltas) ? result.secondAlphaDeltas : [];
  const flushes = Array.isArray(result?.validation?.flushes) ? result.validation.flushes : [];
  const phaseChanged = (phasePrefix = "") => flushes.some((flush) => (
    String(flush?.phase || "").startsWith(phasePrefix)
    && Number(flush?.changed) > 0
  ));
  const firstTslProjected = phaseChanged("first");
  const secondTslProjected = phaseChanged("second")
    || Number(result?.secondAlphaDelta) > 0;
  const orbitFlushObserved = flushes.some((flush) => String(flush?.phase || "") === "orbit-switch");
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    paintRecordsAvailable: Number(result?.paintRecords) > 0,
    neighborEnabled: result?.neighborEnabled === true,
    paintLayerCreated: result?.layerAdded === true,
    firstVisibleHitFound: result?.firstHitFound === true,
    secondVisibleHitsFound: Number(result?.secondHitCount) >= 2,
    firstStrokeQueued: Number(result?.validation?.byPhase?.first?.queuedPayloads) > 0,
    firstStrokeProjected: Number(result?.firstProjectionChanged) > 0 || firstTslProjected,
    firstStrokeAddedAlpha: Number(result?.firstAlphaDelta) > 0 || firstTslProjected,
    orbitChangedCamera: Number(result?.validation?.cameraChangedCalls) > 0,
    orbitToolSwitchFlushedWhileAirbrush: result?.validation?.toolSwitchFlushUnderAirbrush === true,
    orbitToolSwitchHadQueuedPaint: result?.validation?.toolSwitchHadQueuedPaint === true
      || (orbitFlushObserved && firstTslProjected),
    neighborStayedEnabledAfterOrbit: result?.neighborStayedEnabledAfterOrbit === true,
    noNeighborModeResetAfterOrbit: !(result?.validation?.neighborModeSetCalls || [])
      .some((call) => String(call?.phase || "") !== "setup"),
    secondNeighborProjectionUsed: Number(result?.validation?.neighborProjectionCalls) > 0
      || (result?.neighborStayedEnabledAfterOrbit === true && secondTslProjected),
    secondStrokesProjected: Number(result?.secondProjectionChanged) > 0 || secondTslProjected,
    secondStrokesAddedAlpha: Number(result?.secondAlphaDelta) > 0,
    multipleSecondStrokesStuck: secondDeltas.filter((delta) => Number(delta) > 0).length >= 2,
    secondStrokePathCovered: Number(result?.secondPathCoverage?.visibleSamples) >= 6
      && Number(result?.secondPathCoverage?.coverageRatio) >= 0.6,
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

function runtimeFrontBackLeakChecks(result) {
  const backChange = result?.backPaintChange || {};
  const changedPixels = Number(backChange.changedPixels) || 0;
  const changedPixelRatio = Number(backChange.changedPixelRatio) || 0;
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    paintLayerCreated: result?.layerAdded === true,
    frontHitFound: result?.frontHitFound === true,
    frontStrokePainted: Number(result?.frontPaint?.coverage?.paintedSamples) >= 4
      && Number(result?.frontPaint?.coverage?.coverageRatio) >= 0.5,
    midDragPaintObserved: result?.frontPaint?.midDragPaintObserved === true,
    tslSurfaceUsed: result?.lastWebGpuPaintStats?.tslSurfaceAirbrush === true,
    frontmostVisibilityUsed: result?.lastWebGpuPaintStats?.tslSurfaceVisibleSurface === true,
    sourceRasterClipUsed: result?.lastWebGpuPaintStats?.tslSurfaceSourceRasterClipActive === true,
    strokeMaskNotDilated: result?.lastWebGpuPaintStats?.tslSurfaceStrokeMaskDilation !== true,
    backFramesCaptured: result?.backBefore?.ok === true && result?.backAfter?.ok === true,
    noBackGreenLeak: backChange.captured === true
      && changedPixels <= 18
      && changedPixelRatio <= 0.00008,
    queueDrained: Number(result?.queueLength) === 0 && Number(result?.pendingBatches) === 0,
    backClipAvailable: Array.isArray(result?.screenshotClips) && result.screenshotClips.length >= 1
  };
}

function runtimeVisualAirbrushProofChecks(result) {
  const timings = result?.validation?.timings || {};
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    paintLayerCreated: Number(result?.layerCount) >= 1,
    torsoHitFound: result?.torso?.hitFound === true,
    shoulderHitFound: result?.shoulder?.hitFound === true,
    upperArmHitFound: result?.upperArm?.hitFound === true,
    legHitFound: result?.leg?.hitFound === true,
    greenSoftBrushConfigured: result?.brush?.color === "#00ff60"
      && result?.brush?.visibleEdgeMode === "soft"
      && Number(result?.brush?.radiusPixels) >= 36
      && Number(result?.brush?.opacity) > 0.25
      && Number(result?.brush?.hardness) < 0.45,
    torsoStrokePainted: Number(result?.torso?.coverage?.paintedSamples) >= 4
      && Number(result?.torso?.coverage?.coverageRatio) >= 0.5,
    shoulderStrokePainted: Number(result?.shoulder?.coverage?.paintedSamples) >= 3
      && Number(result?.shoulder?.coverage?.coverageRatio) >= 0.4,
    upperArmStrokePainted: Number(result?.upperArm?.coverage?.paintedSamples) >= 3
      && Number(result?.upperArm?.coverage?.coverageRatio) >= 0.4,
    legStrokePainted: Number(result?.leg?.coverage?.paintedSamples) >= 3
      && Number(result?.leg?.coverage?.coverageRatio) >= 0.4,
    midDragPaintObserved: result?.torso?.midDragPaintObserved === true
      || result?.shoulder?.midDragPaintObserved === true
      || result?.upperArm?.midDragPaintObserved === true
      || result?.leg?.midDragPaintObserved === true,
    tslSurfaceUsed: result?.lastWebGpuPaintStats?.tslSurfaceAirbrush === true,
    noMaterialRebinds: Number(result?.lastWebGpuPaintStats?.tslSurfaceReboundMaterials) === 0,
    baseTextureUnchanged: result?.materialStateIntegrity?.baseCanvasUnchanged === true,
    noRawLayerMaterialMap: Number(result?.materialStateIntegrity?.rawMaterialMapCount) === 0,
    noRawLayerBaseReferences: Number(result?.materialStateIntegrity?.rawCloneTextureCount) === 0
      && Number(result?.materialStateIntegrity?.rawCanvasMapCount) === 0,
    realtimeFlushBudget: Number(timings.webGpuFlushReturnMaxMs) <= 40,
    realtimePaintBudget: Number(timings.webGpuPaintMaxMs) <= 40,
    queueDrained: Number(result?.queueLength) === 0 && Number(result?.pendingBatches) === 0,
    cropsAvailable: Array.isArray(result?.screenshotClips) && result.screenshotClips.length >= 3
  };
}

function runtimeVisualAirbrushLiveProofChecks(result) {
  const liveTimings = result?.live?.validation?.timings || {};
  const finalTimings = result?.final?.validation?.timings || {};
  const finalCoverage = result?.final?.coverage || {};
  const finalFalloff = result?.final?.falloff || {};
  const liveFinalPaintDiff = result?.liveFinalPaintDiff || {};
  const finalAlphas = Array.isArray(finalCoverage.alphas) ? finalCoverage.alphas.map(Number) : [];
  return {
    setupReady: result?.setup?.ready === true && result?.ready === true,
    assetLoaded: result?.setup?.loaded === true,
    shoulderHitFound: result?.setup?.shoulderHitFound === true,
    torsoHitFound: result?.setup?.torsoHitFound === true,
    greenSoftBrushConfigured: result?.setup?.brush?.color === "#00ff60"
      && result?.setup?.brush?.visibleEdgeMode === "soft"
      && Number(result?.setup?.brush?.radiusPixels) >= 36
      && Number(result?.setup?.brush?.opacity) > 0.25
      && Number(result?.setup?.brush?.hardness) < 0.45,
    sameMaterialTorsoPath: Number(result?.setup?.torsoCandidateCount) > 0
      && Number(result?.setup?.pathScore?.coverageRatio) >= 0.86,
    preStrokeQueueEmpty: result?.setup?.preStrokeQueueEmpty === true,
    screenshotsCaptured: Array.isArray(result?.screenshots) && result.screenshots.length >= 4,
    livePointerStillDown: result?.live?.painting === true,
    livePaintObserved: result?.live?.lastWebGpuPaintStats?.tslSurfaceAirbrush === true
      && Number(result?.live?.validation?.paintEvents) > 0,
    liveNoLegacyProjection: Number(result?.live?.validation?.projectionCalls) === 0,
    liveRealtimePaintBudget: Number(liveTimings.webGpuPaintMaxMs) <= 40,
    liveRealtimeFlushBudget: Number(liveTimings.webGpuFlushReturnMaxMs) <= 40,
    liveFullMatchesFinalPaint: liveFinalPaintDiff.ready === true
      && Number(liveFinalPaintDiff.finalPaintPixels) > 400
      && Number(liveFinalPaintDiff.missingFinalInLiveRatio) <= 0.08,
    finalTslSurfaceUsed: result?.final?.lastWebGpuPaintStats?.tslSurfaceAirbrush === true,
    finalStrokePainted: Number(finalCoverage.paintedSamples) >= 14
      && Number(finalCoverage.coverageRatio) >= 0.93,
    finalNoCenterlineHoles: finalAlphas.length >= 10
      && finalAlphas.every((alpha) => Number.isFinite(alpha) && alpha > 8),
    finalNoOffStrokeLeaks: Number(result?.final?.offStroke?.changedSamples) === 0,
    finalFalloffSampled: Number(finalFalloff.profileCount) >= 5,
    finalFalloffNoCenterHoles: Number(finalFalloff.centerHoles) === 0,
    finalFalloffNoOuterHalos: Number(finalFalloff.outerHaloSamples) === 0,
    finalFalloffNoDisconnectedIslands: Number(finalFalloff.disconnectedIslandSamples) === 0,
    finalNoMaterialRebinds: Number(result?.final?.lastWebGpuPaintStats?.tslSurfaceReboundMaterials) === 0,
    finalQueueDrained: Number(result?.final?.queueLength) === 0
      && Number(result?.final?.pendingBatches) === 0
      && result?.final?.pendingWork === false,
    finalRealtimePaintBudget: Number(finalTimings.webGpuPaintMaxMs) <= 40,
    finalRealtimeFlushBudget: Number(finalTimings.webGpuFlushReturnMaxMs) <= 40,
    activeAirbrushAfterValidation: result?.final?.activeTool === "airbrush"
  };
}

function runtimeVisualAirbrushMatrixProofChecks(result) {
  const timings = result?.validation?.timings || {};
  const opacityLowAlpha = Number(result?.opacity?.low?.coverage?.maxAlpha) || 0;
  const opacityHighAlpha = Number(result?.opacity?.high?.coverage?.maxAlpha) || 0;
  const baseAfterFirst = Number(result?.sameLayer?.afterFirst?.nonzeroAlphaPixels) || 0;
  const baseAfterSecond = Number(result?.sameLayer?.afterSecond?.nonzeroAlphaPixels) || 0;
  const baseAfterSecondLayer = Number(result?.twoLayer?.baseAfterSecondLayer?.nonzeroAlphaPixels) || 0;
  const newLayerPixels = Number(result?.twoLayer?.newLayer?.nonzeroAlphaPixels) || 0;
  const denseSegments = Number(result?.spacing?.dense?.stats?.tslSurfaceAccumulatedPaintSegmentCount || result?.spacing?.dense?.stats?.tslSurfacePaintSegmentCount) || 0;
  const sparseSegments = Number(result?.spacing?.sparse?.stats?.tslSurfaceAccumulatedPaintSegmentCount || result?.spacing?.sparse?.stats?.tslSurfacePaintSegmentCount) || 0;
  const denseMaxAlpha = Number(result?.spacing?.dense?.coverage?.maxAlpha) || 0;
  const sparseMaxAlpha = Number(result?.spacing?.sparse?.coverage?.maxAlpha) || 0;
  const denseRadiusEstimate = Number(result?.spacing?.dense?.coverage?.paintedRadiusEstimate) || 0;
  const sparseRadiusEstimate = Number(result?.spacing?.sparse?.coverage?.paintedRadiusEstimate) || 0;
  const lowScatterRadius = Number(result?.scatter?.low?.coverage?.paintedRadiusEstimate) || 0;
  const highScatterRadius = Number(result?.scatter?.high?.coverage?.paintedRadiusEstimate) || 0;
  const pressureLowAlpha = Number(result?.pressure?.low?.coverage?.maxAlpha) || 0;
  const pressureHighAlpha = Number(result?.pressure?.high?.coverage?.maxAlpha) || 0;
  const pressureLowRadius = Number(result?.pressure?.low?.coverage?.paintedRadiusEstimate) || 0;
  const pressureHighRadius = Number(result?.pressure?.high?.coverage?.paintedRadiusEstimate) || 0;
  return {
    editorReady: result?.ready === true,
    assetLoaded: result?.loaded === true,
    matrixLayerCreated: result?.sameLayer?.layerName === "Paint Matrix 1",
    backgroundBlendModeApplied: result?.sameLayer?.backgroundBlend?.blendModeSet === true
      && result?.sameLayer?.backgroundBlend?.blendModeRestored === true
      && result?.sameLayer?.backgroundBlend?.stroke?.stats?.tslSurfaceLayerBlendMode === "multiply"
      && result?.sameLayer?.backgroundBlend?.stroke?.stats?.tslSurfaceLayerDisplayBaseTextureName === "Diffuse Texture"
      && result?.sameLayer?.backgroundBlend?.stroke?.stats?.tslSurfaceLayerDisplayUsedLiveUnderlay === false,
    postStrokeOpacityRefresh: result?.sameLayer?.backgroundBlend?.opacityChanged === true
      && result?.sameLayer?.backgroundBlend?.opacityRestored === true
      && result?.sameLayer?.backgroundBlend?.opacityRefresh?.refreshed === true
      && result?.sameLayer?.backgroundBlend?.opacityRefresh?.reason === "opacity"
      && Number(result?.sameLayer?.backgroundBlend?.opacityRefresh?.layerOpacity) < 0.5
      && result?.sameLayer?.backgroundBlend?.opacityRestoreRefresh?.refreshed === true
      && Number(result?.sameLayer?.backgroundBlend?.opacityRestoreRefresh?.layerOpacity) > 0.99,
    postStrokeBlendRefresh: result?.sameLayer?.backgroundBlend?.blendRestoreRefresh?.refreshed === true
      && result?.sameLayer?.backgroundBlend?.blendRestoreRefresh?.reason === "blend-mode"
      && result?.sameLayer?.backgroundBlend?.blendRestoreRefresh?.layerBlendMode === "normal",
    secondLayerCreated: result?.twoLayer?.layerName === "Paint Matrix 2",
    secondLayerBlendModeApplied: result?.twoLayer?.blendMode === "multiply"
      && result?.twoLayer?.stroke?.stats?.tslSurfaceLayerBlendMode === "multiply",
    opacityLowPainted: Number(result?.opacity?.low?.coverage?.paintedSamples) >= 3,
    opacityHighPainted: Number(result?.opacity?.high?.coverage?.paintedSamples) >= 3,
    opacityVisiblyDifferent: opacityHighAlpha >= opacityLowAlpha + 32,
    sameLayerFirstStrokePersists: baseAfterFirst > 0 && baseAfterSecond >= baseAfterFirst,
    sameLayerSecondStrokeAddsPaint: Number(result?.sameLayer?.second?.coverage?.paintedSamples) >= 3
      && baseAfterSecond > baseAfterFirst,
    secondLayerPainted: newLayerPixels > 0,
    firstLayerSurvivesSecondLayer: baseAfterSecondLayer >= baseAfterSecond,
    spacingDenseAndSparsePaint: Number(result?.spacing?.dense?.coverage?.paintedSamples) >= 3
      && Number(result?.spacing?.sparse?.coverage?.paintedSamples) >= 1,
    spacingAffectsStrokePlanning: Number(result?.spacing?.sparse?.brush?.spacing) > 100
      && (
        denseSegments !== sparseSegments
        || Number(result?.spacing?.sparse?.coverage?.coverageRatio) < Number(result?.spacing?.dense?.coverage?.coverageRatio)
        || sparseMaxAlpha < denseMaxAlpha - 10
        || Math.abs(sparseRadiusEstimate - denseRadiusEstimate) >= 8
      ),
    scatterPaintsBothModes: Number(result?.scatter?.low?.coverage?.paintedSamples) >= 3
      && Number(result?.scatter?.high?.coverage?.paintedSamples) >= 3,
    scatterAffectsFootprint: highScatterRadius >= lowScatterRadius,
    pressurePaintsBothModes: Number(result?.pressure?.low?.coverage?.paintedSamples) >= 1
      && Number(result?.pressure?.high?.coverage?.paintedSamples) >= 3,
    pressureAffectsStroke: result?.pressure?.low?.brush?.pressureRadius === true
      && result?.pressure?.low?.brush?.pressureOpacity === true
      && result?.pressure?.high?.brush?.pressureRadius === true
      && result?.pressure?.high?.brush?.pressureOpacity === true
      && (
        pressureHighAlpha >= pressureLowAlpha + 24
        || pressureHighRadius >= pressureLowRadius + 8
      ),
    neighborPaintedOnTslSurface: result?.neighbor?.enabled === true
      && Number(result?.neighbor?.coverage?.paintedSamples) >= 3
      && result?.neighbor?.stats?.tslSurfaceAirbrush === true,
    softEdgeTslSurface: result?.edgeModes?.soft?.stats?.tslSurfaceAirbrush === true
      && result?.edgeModes?.soft?.stats?.tslSurfaceVisibleEdgeMode === "soft",
    hardEdgeTslSurface: result?.edgeModes?.hard?.stats?.tslSurfaceAirbrush === true
      && result?.edgeModes?.hard?.stats?.tslSurfaceVisibleEdgeMode === "hard",
    noLegacyProjection: Number(result?.validation?.projectionCalls) === 0,
    realtimePaintBudget: Number(timings.webGpuPaintMaxMs) <= 40,
    realtimeFlushBudget: Number(timings.webGpuFlushReturnMaxMs) <= 40,
    queueDrained: Number(result?.queueLength) === 0 && Number(result?.pendingBatches) === 0,
    matrixCropsAvailable: Array.isArray(result?.screenshotClips) && result.screenshotClips.length >= 4
  };
}

function runtimeVisualAirbrushLiveProofSetupExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flushPaint = async () => {
      for (let index = 0; index < 32; index += 1) {
        const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
        if (pending && typeof pending.then === "function") {
          await pending;
        }
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(20);
      }
      await editor.flushTextureAirbrushPendingWebGpuPaints?.({
        deferredCanvasSyncTileBytes: false,
        deferredCanvasSyncMaxTiles: false,
        canvasSyncApplyBudgetMs: 0
      });
      const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
        composite: false,
        preserveWebGpuDisplay: true
      });
      if (layerFlush && typeof layerFlush.then === "function") {
        await layerFlush;
      }
      await waitFrame();
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
    editor.pausePlayback?.();
    editor.setCameraPreset?.("front");
    if (editor.camera) {
      editor.camera.zoom = 2.15;
      editor.camera.updateProjectionMatrix?.();
    }
    editor.textureAirbrushCameraChanged?.();
    editor.setTool?.("airbrush");
    editor.textureAirbrushCaptureCandidateDebug = true;
    editor.setTexturePaintNeighborMode?.(false, { status: false });
    const setInput = (input, value) => {
      if (!input) {
        return;
      }
      input.value = String(value);
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    const setChecked = (input, value) => {
      if (!input) {
        return;
      }
      input.checked = Boolean(value);
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    setInput(editor.textureBrushRadius, 0.22);
    setInput(editor.textureBrushOpacity, 0.58);
    setInput(editor.textureBrushSpacing, 1);
    setInput(editor.textureBrushHardness, 0.14);
    setInput(editor.textureBrushScatter, 0.18);
    setInput(editor.textureVisibleEdgeMode, "soft");
    setInput(editor.texturePaintColor, "#00ff60");
    setChecked(editor.texturePressureRadius, false);
    setChecked(editor.texturePressureOpacity, false);
    editor.updateRangeOutputs?.();
    editor.textureAirbrushInvalidateBrushSettings?.();
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
    const validation = {
      pointerDowns: 0,
      paintEvents: 0,
      queuedPayloads: 0,
      projectionCalls: 0,
      projectionChanged: 0,
      timings: {
        webGpuPaintCalls: 0,
        webGpuPaintMs: 0,
        webGpuPaintMaxMs: 0,
        webGpuFlushCalls: 0,
        webGpuFlushReturnMs: 0,
        webGpuFlushReturnMaxMs: 0
      }
    };
    const originalOnPointerDown = editor.onPointerDown?.bind(editor);
    const originalPaintTextureStrokeFromEvent = editor.paintTextureStrokeFromEvent?.bind(editor);
    const originalQueuePayload = editor.textureAirbrushQueueScreenStrokePayload?.bind(editor);
    const originalProjection = editor.textureAirbrushProjectedMeshFromEvent?.bind(editor);
    const originalWebGpuPaint = editor.textureAirbrushWebGpuPaintFromEvent?.bind(editor);
    const originalWebGpuFlush = editor.flushTextureAirbrushQueuedWebGpuStrokes?.bind(editor);
    if (originalOnPointerDown) {
      editor.onPointerDown = function(event) {
        validation.pointerDowns += 1;
        return originalOnPointerDown(event);
      };
    }
    if (originalPaintTextureStrokeFromEvent) {
      editor.paintTextureStrokeFromEvent = function(event, options = {}) {
        validation.paintEvents += 1;
        return originalPaintTextureStrokeFromEvent(event, options);
      };
    }
    if (originalQueuePayload) {
      editor.textureAirbrushQueueScreenStrokePayload = function(payload) {
        const queued = originalQueuePayload(payload);
        if (queued) {
          validation.queuedPayloads += 1;
        }
        return queued;
      };
    }
    if (originalProjection) {
      editor.textureAirbrushProjectedMeshFromEvent = function(event, options = {}) {
        validation.projectionCalls += 1;
        const changed = originalProjection(event, options) || 0;
        validation.projectionChanged += Number(changed) || 0;
        return changed;
      };
    }
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
    if (originalWebGpuFlush) {
      editor.flushTextureAirbrushQueuedWebGpuStrokes = function(...flushArgs) {
        validation.timings.webGpuFlushCalls += 1;
        const started = performance.now();
        const result = originalWebGpuFlush(...flushArgs);
        const elapsed = performance.now() - started;
        validation.timings.webGpuFlushReturnMs += elapsed;
        validation.timings.webGpuFlushReturnMaxMs = Math.max(validation.timings.webGpuFlushReturnMaxMs, elapsed);
        return result;
      };
    }
    window.__airbrushLiveValidation = validation;
    const eventAt = (clientX, clientY, buttons = 1) => ({
      clientX,
      clientY,
      button: 0,
      buttons,
      pointerId: 941,
      pointerType: "mouse",
      pressure: 0.72,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const hitAt = (clientX, clientY) => editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush") || null;
    const findHit = (xFractions, yFractions) => {
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
    const shoulderHit = findHit(
      [0.38, 0.35, 0.41, 0.32, 0.44, 0.29, 0.47],
      [0.28, 0.30, 0.26, 0.32, 0.24, 0.34, 0.36]
    );
    const torsoHit = findHit(
      [0.50, 0.52, 0.48, 0.54, 0.46, 0.56, 0.44],
      [0.28, 0.26, 0.30, 0.24, 0.32, 0.34, 0.36]
    );
    if (!shoulderHit || !torsoHit) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        loadedAsset,
        shoulderHitFound: Boolean(shoulderHit),
        torsoHitFound: Boolean(torsoHit),
        error: "missing-live-proof-hit"
      };
    }
    const resetLayerForHit = (paintHit) => {
      const material = paintHit?.record && paintHit?.hit
        ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null
        : null;
      if (!material) {
        return null;
      }
      material.userData ||= {};
      const originalTexture = material.userData.clonePaintOriginalMap
        || material.userData.textureAirbrushWebGpuCanvasMap
        || material.userData.clonePaintTexture?.userData?.textureAirbrushWebGpuCanvasMap
        || material.map?.userData?.textureAirbrushWebGpuCanvasMap
        || null;
      if (originalTexture) {
        material.map = originalTexture;
        material.userData.clonePaintTexture = originalTexture;
        material.needsUpdate = true;
      }
      editor.textureAirbrushInvalidateWebGpuCache?.(material);
      editor.textureAirbrushInvalidateWebGpuCache?.(material.map);
      editor.textureAirbrushInvalidateWebGpuCache?.(originalTexture);
      editor.texturePaintTslSurfaceAirbrushInvalidate?.(material);
      editor.texturePaintActiveMaterial = material;
      const editable = material.userData?.clonePaintCanvas && material.userData?.clonePaintContext
        ? {
            canvas: material.userData.clonePaintCanvas,
            context: material.userData.clonePaintContext,
            texture: material.userData.clonePaintTexture || material.map
          }
        : editor.editableClonePaintTexture?.(material);
      const stack = editor.texturePaintLayerStackForMaterial?.(material, editable, { create: true }) || null;
      if (!stack) {
        return material;
      }
      for (const layer of stack.layers || []) {
        editor.disposeTexturePaintLayerGpuState?.(layer);
      }
      stack.layers = [];
      const layer = editor.texturePaintNewLayer?.(stack, { name: "Paint 1", autoCreated: false });
      if (layer) {
        stack.layers.push(layer);
        editor.texturePaintSetSingleLayerSelection?.(stack, layer.id);
        editor.rememberTexturePaintLayerSelection?.(stack, layer);
      }
      editor.invalidateTexturePaintMaterialGpuCaches?.(material, { resetSurfaceStroke: true });
      editor.textureAirbrushInvalidateWebGpuCache?.(material);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable?.canvas);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable?.texture);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer?.canvas);
      editor.discardTexturePaintMaterialAirbrushGpuTarget?.(material);
      editor.discardTexturePaintMaterialGpuComposite?.(material);
      editor.resetTexturePaintMaterialLayerDisplayCache?.(material);
      editor.texturePaintTslSurfaceAirbrushInvalidate?.(material);
      editor.textureAirbrushResetSurfaceStroke?.();
      return material;
    };
    const material = resetLayerForHit(torsoHit.hit);
    if (!material) {
      return { ready: false, loaded: true, loadedAsset, error: "missing-live-proof-material" };
    }
    const preStrokeQueueEmpty = Number(editor.textureAirbrushScreenStrokeQueue?.length || 0) === 0
      && Number(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0) === 0
      && editor.textureAirbrushScreenStrokeHasPendingWork?.() !== true;
    const warmupStarted = performance.now();
    editor.prewarmTexturePaintActiveLayerForAction?.(material, {
      label: "visual-airbrush-live-proof-layer-prewarm",
      preserveLayerDisplay: true,
      renderCompilePass: true
    });
    for (let index = 0; index < 8; index += 1) {
      await waitFrame();
    }
    const warmupMs = performance.now() - warmupStarted;
    const radiusPixels = Number(editor.textureBrushRadiusScreenPixels?.()) || 48;
    const clampPoint = (point) => ({
      x: Math.max(rect.left + 4, Math.min(rect.right - 4, point.x)),
      y: Math.max(rect.top + 4, Math.min(rect.bottom - 4, point.y))
    });
    const materialForHit = (paintHit) => paintHit?.record && paintHit?.hit
      ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null
      : null;
    const viewNormalZForPaintHit = (paintHit) => {
      const normal = paintHit?.hit?.face?.normal?.clone?.() || null;
      const object = paintHit?.record?.object || paintHit?.hit?.object || null;
      if (!normal || !object || !editor.camera) {
        return 1;
      }
      object.updateMatrixWorld?.(true);
      normal.transformDirection?.(object.matrixWorld);
      normal.transformDirection?.(editor.camera.matrixWorldInverse);
      return Number.isFinite(normal.z) ? normal.z : 1;
    };
    const sameMaterialHit = (point, options = {}) => {
      const paintHit = hitAt(point.x, point.y);
      if (materialForHit(paintHit) !== material) {
        return null;
      }
      const minViewNormalZ = Number.isFinite(Number(options.minViewNormalZ))
        ? Number(options.minViewNormalZ)
        : -Infinity;
      return viewNormalZForPaintHit(paintHit) >= minViewNormalZ ? paintHit : null;
    };
    const buildPath = (startPoint, endPoint, curveScale = 0.08, steps = 14) => {
      const built = [];
      for (let index = 0; index <= steps; index += 1) {
        const ratio = index / steps;
        const curve = Math.sin(ratio * Math.PI);
        built.push(clampPoint({
          x: startPoint.x + (endPoint.x - startPoint.x) * ratio,
          y: startPoint.y + (endPoint.y - startPoint.y) * ratio + curve * radiusPixels * curveScale
        }));
      }
      return built;
    };
    const scorePath = (candidatePath) => {
      let samples = 0;
      let sameMaterialSamples = 0;
      let missingSamples = 0;
      for (let index = 0; index <= 20; index += 1) {
        const ratio = index / 20;
        const scaled = ratio * (candidatePath.length - 1);
        const leftIndex = Math.floor(scaled);
        const rightIndex = Math.min(candidatePath.length - 1, leftIndex + 1);
        const t = scaled - leftIndex;
        const left = candidatePath[leftIndex];
        const right = candidatePath[rightIndex];
        const point = {
          x: left.x + (right.x - left.x) * t,
          y: left.y + (right.y - left.y) * t
        };
        samples += 1;
        const paintHit = sameMaterialHit(point, { minViewNormalZ: 0.25 });
        if (paintHit) {
          sameMaterialSamples += 1;
        } else {
          missingSamples += 1;
        }
      }
      return {
        samples,
        sameMaterialSamples,
        missingSamples,
        coverageRatio: samples ? sameMaterialSamples / samples : 0
      };
    };
    const torsoCandidates = [];
    const preferredPecYFraction = 0.275;
    for (const yFraction of [0.24, 0.26, 0.28, 0.30, 0.32, 0.34]) {
      for (const xFraction of [0.43, 0.45, 0.47, 0.49, 0.51, 0.53, 0.55, 0.57]) {
        const point = {
          x: rect.left + rect.width * xFraction,
          y: rect.top + rect.height * yFraction
        };
        const paintHit = sameMaterialHit(point, { minViewNormalZ: 0.25 });
        if (paintHit) {
          torsoCandidates.push({ ...point, xFraction, yFraction, paintHit });
        }
      }
    }
    let chosenPath = null;
    let chosenPathScore = null;
    let chosenPathName = "torso-continuous-live-proof";
    for (const startCandidate of torsoCandidates) {
      for (const endCandidate of torsoCandidates) {
        const dx = endCandidate.x - startCandidate.x;
        const dy = endCandidate.y - startCandidate.y;
        const distance = Math.hypot(dx, dy);
        if (
          dx <= radiusPixels * 1.15
          || distance < radiusPixels * 1.8
          || distance > radiusPixels * 3.35
          || Math.abs(dy) > radiusPixels * 1.15
        ) {
          continue;
        }
        const candidatePath = buildPath(startCandidate, endCandidate, 0.06, 16);
        const score = scorePath(candidatePath);
        const midYFraction = (startCandidate.yFraction + endCandidate.yFraction) * 0.5;
        const candidateValue = score.coverageRatio * 1000
          + distance * 0.05
          - Math.abs(dy) * 0.1
          - Math.abs(midYFraction - preferredPecYFraction) * 520;
        const bestValue = chosenPathScore
          ? chosenPathScore.coverageRatio * 1000
            + chosenPathScore.distance * 0.05
            - Math.abs(chosenPathScore.dy) * 0.1
            - Math.abs(chosenPathScore.midYFraction - preferredPecYFraction) * 520
          : -Infinity;
        if (candidateValue > bestValue) {
          chosenPath = candidatePath;
          chosenPathScore = { ...score, distance, dy, midYFraction };
        }
      }
    }
    if (!chosenPath || (chosenPathScore?.coverageRatio || 0) < 0.86) {
      const fallbackStart = clampPoint({
        x: shoulderHit.clientX - radiusPixels * 1.30,
        y: shoulderHit.clientY - radiusPixels * 0.18
      });
      const fallbackEnd = clampPoint({
        x: torsoHit.clientX + radiusPixels * 1.55,
        y: torsoHit.clientY + radiusPixels * 0.20
      });
      chosenPath = buildPath(fallbackStart, fallbackEnd, 0.18, 12);
      chosenPathScore = scorePath(chosenPath);
      chosenPathName = "shoulder-torso-live-proof";
    }
    const path = chosenPath;
    const clipForPath = (name, margin = 135) => {
      const viewportWidth = window.innerWidth || 1280;
      const viewportHeight = window.innerHeight || 900;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of path) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      const x = Math.max(0, Math.floor(minX - margin));
      const y = Math.max(0, Math.floor(minY - margin));
      const right = Math.min(viewportWidth, Math.ceil(maxX + margin));
      const bottom = Math.min(viewportHeight, Math.ceil(maxY + margin));
      return { name, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
    };
    const snapshotLayerCanvases = () => {
      const canvases = new Map();
      for (const candidateMaterial of editor.textureAirbrushPaintableMaterials?.() || []) {
        const stack = candidateMaterial?.userData?.texturePaintLayerStack || null;
        for (const layer of stack?.layers || []) {
          const canvas = layer?.canvas || null;
          const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
          if (!canvas?.width || !canvas?.height || !context || canvases.has(canvas)) {
            continue;
          }
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          canvases.set(canvas, {
            width: canvas.width,
            height: canvas.height,
            data: new Uint8ClampedArray(image.data)
          });
        }
      }
      return { canvases };
    };
    const beforeStrokeSnapshot = snapshotLayerCanvases();
    const activeLayerForMaterial = (candidateMaterial = material) => {
      const stack = candidateMaterial?.userData?.texturePaintLayerStack || null;
      return (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId) || null;
    };
    const alphaAtHit = (paintHit, snapshot = null) => {
      const hitMaterial = materialForHit(paintHit) || material;
      const layer = activeLayerForMaterial(hitMaterial);
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      const uv = paintHit?.hit?.uv || null;
      if (!canvas || !context || !uv) {
        return null;
      }
      const source = snapshot?.canvases?.get?.(canvas) || null;
      const width = source?.width || canvas.width;
      const height = source?.height || canvas.height;
      const x = Math.max(0, Math.min(width - 1, Math.floor(Number(uv.x || 0) * width)));
      const y = Math.max(0, Math.min(height - 1, Math.floor((1 - Number(uv.y || 0)) * height)));
      const readAlpha = (xx, yy) => source?.data
        ? source.data[(yy * width + xx) * 4 + 3] || 0
        : context.getImageData(xx, yy, 1, 1).data[3];
      let alpha = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
          alpha = Math.max(alpha, readAlpha(xx, yy));
        }
      }
      return alpha;
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
    const distanceToPath = (point) => {
      let distance = Infinity;
      for (let index = 1; index < path.length; index += 1) {
        distance = Math.min(distance, distanceToSegment(point, path[index - 1], path[index]));
      }
      return distance;
    };
    const pointAtPathRatio = (ratio) => {
      const scaled = Math.max(0, Math.min(1, ratio)) * (path.length - 1);
      const leftIndex = Math.max(0, Math.min(path.length - 1, Math.floor(scaled)));
      const rightIndex = Math.min(path.length - 1, leftIndex + 1);
      const t = scaled - leftIndex;
      const left = path[leftIndex];
      const right = path[rightIndex] || left;
      const previous = path[Math.max(0, leftIndex - 1)] || left;
      const next = path[Math.min(path.length - 1, rightIndex + 1)] || right;
      const point = {
        x: left.x + (right.x - left.x) * t,
        y: left.y + (right.y - left.y) * t
      };
      let tangentX = next.x - previous.x;
      let tangentY = next.y - previous.y;
      const tangentLength = Math.hypot(tangentX, tangentY);
      if (tangentLength <= 0.001) {
        tangentX = right.x - left.x;
        tangentY = right.y - left.y;
      }
      const length = Math.max(0.001, Math.hypot(tangentX, tangentY));
      return {
        point,
        normal: {
          x: -tangentY / length,
          y: tangentX / length
        }
      };
    };
    const offStrokePaint = () => {
      const sampleStep = Math.max(10, Math.floor(radiusPixels * 0.24));
      const allowedRadius = radiusPixels * 1.35;
      const deltaThreshold = 8;
      const samples = [];
      for (let y = clip.y; y <= clip.y + clip.height; y += sampleStep) {
        for (let x = clip.x; x <= clip.x + clip.width; x += sampleStep) {
          const point = { x, y };
          const distance = distanceToPath(point);
          if (!Number.isFinite(distance) || distance <= allowedRadius) {
            continue;
          }
          const paintHit = hitAt(x, y);
          if (!paintHit?.record || !paintHit?.hit) {
            continue;
          }
          const before = alphaAtHit(paintHit, beforeStrokeSnapshot);
          const after = alphaAtHit(paintHit);
          if (!Number.isFinite(Number(before)) || !Number.isFinite(Number(after))) {
            continue;
          }
          const delta = after - before;
          if (delta > deltaThreshold) {
            samples.push({
              x: Math.round(x),
              y: Math.round(y),
              distance: Math.round(distance),
              before,
              after,
              delta
            });
          }
        }
      }
      samples.sort((left, right) => right.delta - left.delta);
      return {
        sampleStep,
        allowedRadius,
        deltaThreshold,
        changedSamples: samples.length,
        maxDelta: samples[0]?.delta || 0,
        examples: samples.slice(0, 16)
      };
    };
    const falloffProfiles = () => {
      const ratios = [0.18, 0.34, 0.5, 0.66, 0.82];
      const offsets = [-1.35, -1.2, -1.0, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1.0, 1.2, 1.35];
      const profiles = [];
      let centerHoles = 0;
      let outerHaloSamples = 0;
      let disconnectedIslandSamples = 0;
      for (const ratio of ratios) {
        const { point, normal } = pointAtPathRatio(ratio);
        const samples = [];
        for (const offsetScale of offsets) {
          const samplePoint = {
            x: point.x + normal.x * radiusPixels * offsetScale,
            y: point.y + normal.y * radiusPixels * offsetScale
          };
          const paintHit = hitAt(samplePoint.x, samplePoint.y);
          if (!paintHit?.record || !paintHit?.hit) {
            continue;
          }
          const before = alphaAtHit(paintHit, beforeStrokeSnapshot);
          const after = alphaAtHit(paintHit);
          if (!Number.isFinite(Number(before)) || !Number.isFinite(Number(after))) {
            continue;
          }
          const hitMaterial = materialForHit(paintHit);
          samples.push({
            offsetScale,
            x: Math.round(samplePoint.x),
            y: Math.round(samplePoint.y),
            before,
            after,
            delta: after - before,
            sameMaterial: hitMaterial === material,
            materialName: String(hitMaterial?.name || ""),
            materialIndex: Number.isInteger(paintHit?.hit?.face?.materialIndex)
              ? paintHit.hit.face.materialIndex
              : null,
            faceIndex: Number.isInteger(paintHit?.hit?.faceIndex)
              ? paintHit.hit.faceIndex
              : null
          });
        }
        const center = samples.reduce((best, sample) => (
          !best || Math.abs(sample.offsetScale) < Math.abs(best.offsetScale) ? sample : best
        ), null);
        if (!center || center.after <= 8) {
          centerHoles += 1;
        }
        for (const sample of samples) {
          if (Math.abs(sample.offsetScale) >= 1.2 && sample.delta > 8 && sample.after > 8) {
            outerHaloSamples += 1;
          }
        }
        for (const side of [-1, 1]) {
          const sideSamples = samples
            .filter((sample) => sample.offsetScale * side >= 0)
            .sort((left, right) => Math.abs(left.offsetScale) - Math.abs(right.offsetScale));
          let sawInteriorHole = false;
          for (const sample of sideSamples) {
            const offset = Math.abs(sample.offsetScale);
            if (offset <= 1.0 && sample.after <= 8) {
              sawInteriorHole = true;
            } else if (sawInteriorHole && offset <= 1.2 && sample.after > 32) {
              disconnectedIslandSamples += 1;
            }
          }
        }
        profiles.push({
          ratio,
          centerAlpha: center?.after ?? null,
          samples
        });
      }
      return {
        profileCount: profiles.length,
        centerHoles,
        outerHaloSamples,
        disconnectedIslandSamples,
        profiles
      };
    };
    const sampleCoverage = () => {
      const samples = [];
      for (let index = 0; index <= 14; index += 1) {
        const ratio = index / 14;
        const scaled = ratio * (path.length - 1);
        const leftIndex = Math.floor(scaled);
        const rightIndex = Math.min(path.length - 1, leftIndex + 1);
        const t = scaled - leftIndex;
        const left = path[leftIndex];
        const right = path[rightIndex];
        const x = left.x + (right.x - left.x) * t;
        const y = left.y + (right.y - left.y) * t;
        const paintHit = hitAt(x, y);
        if (!paintHit?.record || !paintHit?.hit) {
          continue;
        }
        const hitMaterial = materialForHit(paintHit);
        const alpha = alphaAtHit(paintHit);
        if (!Number.isFinite(Number(alpha))) {
          continue;
        }
        samples.push({
          x,
          y,
          alpha,
          sameMaterial: hitMaterial === material,
          materialName: String(hitMaterial?.name || ""),
          materialIndex: Number.isInteger(paintHit?.hit?.face?.materialIndex)
            ? paintHit.hit.face.materialIndex
            : null,
          faceIndex: Number.isInteger(paintHit?.hit?.faceIndex)
            ? paintHit.hit.faceIndex
            : null
        });
      }
      const paintedSamples = samples.filter((sample) => sample.alpha > 4).length;
      return {
        visibleSamples: samples.length,
        paintedSamples,
        coverageRatio: samples.length ? paintedSamples / samples.length : 0,
        samples: samples.map((sample) => ({
          x: Math.round(sample.x),
          y: Math.round(sample.y),
          alpha: sample.alpha,
          sameMaterial: sample.sameMaterial,
          materialName: sample.materialName,
          materialIndex: sample.materialIndex,
          faceIndex: sample.faceIndex
        })),
        alphas: samples.map((sample) => sample.alpha)
      };
    };
    const report = async (phase) => {
      await waitFrame();
      return {
        ready: true,
        phase,
        loaded: Boolean(editor.model),
        activeTool: editor.activeTool,
        painting: editor.painting === true,
        queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
        pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
        pendingWork: editor.textureAirbrushScreenStrokeHasPendingWork?.() === true,
        lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
        validation,
        coverage: sampleCoverage(),
        offStroke: phase === "final" ? offStrokePaint() : null,
        falloff: phase === "final" ? falloffProfiles() : null
      };
    };
    const finalize = async () => {
      await flushPaint();
      editor.render?.();
      return report("final");
    };
    const clip = clipForPath(chosenPathName);
    window.__airbrushLiveProof = {
      stroke: { path },
      clip,
      report,
      finalize
    };
    editor.render?.();
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      shoulderHitFound: true,
      torsoHitFound: true,
      hit: {
        shoulder: { xFraction: shoulderHit.xFraction, yFraction: shoulderHit.yFraction },
        torso: { xFraction: torsoHit.xFraction, yFraction: torsoHit.yFraction }
      },
      preStrokeQueueEmpty,
      warmupMs,
      pathScore: chosenPathScore,
      torsoCandidateCount: torsoCandidates.length,
      stroke: { path },
      clip,
      brush: {
        color: String(editor.texturePaintColor?.value || "").toLowerCase(),
        radiusPixels,
        opacity: Number(editor.textureAirbrushOpacity?.() ?? editor.textureBrushOpacity?.value),
        hardness: Number(editor.textureAirbrushHardness?.() ?? editor.textureBrushHardness?.value),
        scatter: Number(editor.textureAirbrushScatter?.() ?? editor.textureBrushScatter?.value),
        spacing: Number(editor.textureAirbrushSpacingPercent?.() ?? editor.textureBrushSpacing?.value),
        visibleEdgeMode: editor.textureAirbrushVisibleEdgeMode?.() || ""
      }
    };
  })()`;
}

function runtimeVisualAirbrushProofExpression() {
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
        await delay(20);
      }
      await editor.flushTextureAirbrushPendingWebGpuPaints?.({
        deferredCanvasSyncTileBytes: false,
        deferredCanvasSyncMaxTiles: false,
        canvasSyncApplyBudgetMs: 0
      });
      const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
        composite: false,
        preserveWebGpuDisplay: true
      });
      if (layerFlush && typeof layerFlush.then === "function") {
        await layerFlush;
      }
      await waitFrame();
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
    editor.pausePlayback?.();
    editor.setCameraPreset?.("front");
    if (editor.camera) {
      editor.camera.zoom = 2.0;
      editor.camera.updateProjectionMatrix?.();
    }
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 4; index += 1) {
      await waitFrame();
    }
    editor.setTool?.("airbrush");
    editor.textureAirbrushCaptureCandidateDebug = true;
    editor.setTexturePaintNeighborMode?.(false, { status: false });
    const setInput = (input, value) => {
      if (!input) {
        return;
      }
      input.value = String(value);
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    setInput(editor.textureBrushRadius, 0.22);
    setInput(editor.textureBrushOpacity, 0.55);
    setInput(editor.textureBrushSpacing, 1);
    setInput(editor.textureBrushHardness, 0.16);
    setInput(editor.textureBrushScatter, 0.2);
    setInput(editor.textureVisibleEdgeMode, "soft");
    setInput(editor.texturePaintColor, "#00ff60");
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
    if (editor.canvas) {
      editor.canvas.setPointerCapture = () => {};
      editor.canvas.releasePointerCapture = () => {};
    }
    const validation = {
      timings: {
        webGpuPaintCalls: 0,
        webGpuPaintMs: 0,
        webGpuPaintMaxMs: 0,
        webGpuFlushCalls: 0,
        webGpuFlushReturnMs: 0,
        webGpuFlushReturnMaxMs: 0
      }
    };
    const originalWebGpuPaint = editor.textureAirbrushWebGpuPaintFromEvent?.bind(editor);
    const originalWebGpuFlush = editor.flushTextureAirbrushQueuedWebGpuStrokes?.bind(editor);
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
    if (originalWebGpuFlush) {
      editor.flushTextureAirbrushQueuedWebGpuStrokes = function(...flushArgs) {
        validation.timings.webGpuFlushCalls += 1;
        const started = performance.now();
        const result = originalWebGpuFlush(...flushArgs);
        const elapsed = performance.now() - started;
        validation.timings.webGpuFlushReturnMs += elapsed;
        validation.timings.webGpuFlushReturnMaxMs = Math.max(validation.timings.webGpuFlushReturnMaxMs, elapsed);
        return result;
      };
    }
    const eventAt = (clientX, clientY, buttons = 1) => ({
      clientX,
      clientY,
      button: 0,
      buttons,
      pointerId: 912,
      pointerType: "mouse",
      pressure: 0.72,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const hitAt = (clientX, clientY) => editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush") || null;
    const findHit = (xFractions, yFractions) => {
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
    const ensureLayerForHit = (paintHit) => {
      const material = paintHit?.record && paintHit?.hit
        ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null
        : null;
      if (!material) {
        return null;
      }
      material.userData ||= {};
      const originalTexture = material.userData.clonePaintOriginalMap
        || material.userData.textureAirbrushWebGpuCanvasMap
        || material.userData.clonePaintTexture?.userData?.textureAirbrushWebGpuCanvasMap
        || material.map?.userData?.textureAirbrushWebGpuCanvasMap
        || null;
      if (originalTexture) {
        material.map = originalTexture;
        material.userData.clonePaintTexture = originalTexture;
        material.needsUpdate = true;
      }
      delete material.userData.texturePaintTslSurfaceAirbrushTarget;
      delete material.userData.texturePaintCompositeGpuTarget;
      delete material.userData.textureAirbrushGpuTarget;
      editor.texturePaintActiveMaterial = material;
      const stack = material.userData?.texturePaintLayerStack || null;
      const activeLayer = stack?.layers?.find?.((layer) => layer.id === stack.activeLayerId) || null;
      if (!activeLayer) {
        editor.addTexturePaintLayer?.();
      }
      return material;
    };
    const resetLayerForHit = (paintHit) => {
      const material = paintHit?.record && paintHit?.hit
        ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null
        : null;
      if (!material) {
        return null;
      }
      material.userData ||= {};
      const originalTexture = material.userData.clonePaintOriginalMap
        || material.userData.textureAirbrushWebGpuCanvasMap
        || material.userData.clonePaintTexture?.userData?.textureAirbrushWebGpuCanvasMap
        || material.map?.userData?.textureAirbrushWebGpuCanvasMap
        || null;
      if (originalTexture) {
        material.map = originalTexture;
        material.userData.clonePaintTexture = originalTexture;
        material.needsUpdate = true;
      }
      editor.textureAirbrushInvalidateWebGpuCache?.(material);
      editor.textureAirbrushInvalidateWebGpuCache?.(material.map);
      editor.textureAirbrushInvalidateWebGpuCache?.(originalTexture);
      editor.texturePaintTslSurfaceAirbrushInvalidate?.(material);
      editor.texturePaintActiveMaterial = material;
      const editable = material.userData?.clonePaintCanvas && material.userData?.clonePaintContext
        ? {
            canvas: material.userData.clonePaintCanvas,
            context: material.userData.clonePaintContext,
            texture: material.userData.clonePaintTexture || material.map
          }
        : editor.editableClonePaintTexture?.(material);
      const stack = editor.texturePaintLayerStackForMaterial?.(material, editable, { create: true }) || null;
      if (!stack) {
        return material;
      }
      for (const layer of stack.layers || []) {
        editor.disposeTexturePaintLayerGpuState?.(layer);
      }
      stack.layers = [];
      const layer = editor.texturePaintNewLayer?.(stack, { name: "Paint 1", autoCreated: false });
      if (layer) {
        stack.layers.push(layer);
        editor.texturePaintSetSingleLayerSelection?.(stack, layer.id);
        editor.rememberTexturePaintLayerSelection?.(stack, layer);
      }
      editor.invalidateTexturePaintMaterialGpuCaches?.(material, {
        resetSurfaceStroke: true
      });
      editor.textureAirbrushInvalidateWebGpuCache?.(material);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable?.canvas);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable?.texture);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer?.canvas);
      editor.discardTexturePaintMaterialAirbrushGpuTarget?.(material);
      editor.discardTexturePaintMaterialGpuComposite?.(material);
      editor.resetTexturePaintMaterialLayerDisplayCache?.(material);
      editor.texturePaintTslSurfaceAirbrushInvalidate?.(material);
      editor.textureAirbrushResetSurfaceStroke?.();
      return material;
    };
    const layerForMaterial = (material) => {
      const stack = material?.userData?.texturePaintLayerStack || null;
      return (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId) || null;
    };
    const canvasDigest = (canvas = null) => {
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      const width = Math.max(0, Math.floor(Number(canvas?.width) || 0));
      const height = Math.max(0, Math.floor(Number(canvas?.height) || 0));
      if (!canvas || !context || !width || !height) {
        return null;
      }
      const image = context.getImageData(0, 0, width, height);
      let hash = 2166136261 >>> 0;
      let alphaSum = 0;
      let rgbSum = 0;
      let maxAlpha = 0;
      for (let index = 0; index < image.data.length; index += 4) {
        const r = image.data[index] || 0;
        const g = image.data[index + 1] || 0;
        const b = image.data[index + 2] || 0;
        const a = image.data[index + 3] || 0;
        hash = Math.imul(hash ^ r, 16777619) >>> 0;
        hash = Math.imul(hash ^ g, 16777619) >>> 0;
        hash = Math.imul(hash ^ b, 16777619) >>> 0;
        hash = Math.imul(hash ^ a, 16777619) >>> 0;
        alphaSum += a;
        rgbSum += r + g + b;
        maxAlpha = Math.max(maxAlpha, a);
      }
      return {
        width,
        height,
        hash,
        alphaSum,
        rgbSum,
        maxAlpha
      };
    };
    const textureFlags = (texture = null) => texture ? {
      name: String(texture.name || ""),
      uuid: String(texture.uuid || ""),
      tslTarget: texture.userData?.texturePaintTslSurfaceAirbrushTargetTexture === true,
      tslDisplay: texture.userData?.texturePaintTslSurfaceAirbrushDisplayTexture === true,
      externalDisplay: texture.userData?.textureAirbrushExternalWebGpuDisplay === true,
      hasStableCanvasMap: Boolean(texture.userData?.textureAirbrushWebGpuCanvasMap),
      hasOriginalMap: Boolean(texture.userData?.texturePaintTslSurfaceDisplayOriginalMap || texture.userData?.clonePaintOriginalMap)
    } : null;
    const materialStateSnapshot = () => {
      const materials = editor.textureAirbrushPaintableMaterials?.() || [];
      const entries = [];
      let rawMaterialMapCount = 0;
      let rawCloneTextureCount = 0;
      let rawCanvasMapCount = 0;
      let baseCanvasChanged = false;
      for (const entry of materials) {
        const material = entry?.material || entry || null;
        const stack = material?.userData?.texturePaintLayerStack || null;
        if (!material || !stack) {
          continue;
        }
        const rawTargets = new Set((stack.layers || [])
          .map((layer) => layer?.gpuTarget?.target?.texture)
          .filter(Boolean));
        const materialMapIsRaw = rawTargets.has(material.map);
        const clonePaintTextureIsRaw = rawTargets.has(material.userData?.clonePaintTexture);
        const canvasMapIsRaw = rawTargets.has(material.userData?.textureAirbrushWebGpuCanvasMap);
        rawMaterialMapCount += materialMapIsRaw ? 1 : 0;
        rawCloneTextureCount += clonePaintTextureIsRaw ? 1 : 0;
        rawCanvasMapCount += canvasMapIsRaw ? 1 : 0;
        entries.push({
          materialName: String(material.name || ""),
          baseCanvas: canvasDigest(stack.baseCanvas),
          materialMap: textureFlags(material.map),
          clonePaintTexture: textureFlags(material.userData?.clonePaintTexture),
          clonePaintOriginalMap: textureFlags(material.userData?.clonePaintOriginalMap),
          textureAirbrushWebGpuCanvasMap: textureFlags(material.userData?.textureAirbrushWebGpuCanvasMap),
          materialMapIsRawLayerTarget: materialMapIsRaw,
          clonePaintTextureIsRawLayerTarget: clonePaintTextureIsRaw,
          canvasMapIsRawLayerTarget: canvasMapIsRaw,
          activeLayerId: String(stack.activeLayerId || ""),
          layerCount: stack.layers?.length || 0
        });
      }
      return {
        rawMaterialMapCount,
        rawCloneTextureCount,
        rawCanvasMapCount,
        baseCanvasChanged,
        entries
      };
    };
    const compareMaterialState = (before = null, after = null) => {
      const beforeEntries = before?.entries || [];
      const afterEntries = after?.entries || [];
      let baseCanvasUnchanged = beforeEntries.length === afterEntries.length;
      for (let index = 0; index < Math.max(beforeEntries.length, afterEntries.length); index += 1) {
        const beforeBase = beforeEntries[index]?.baseCanvas || null;
        const afterBase = afterEntries[index]?.baseCanvas || null;
        if (
          !beforeBase
          || !afterBase
          || beforeBase.width !== afterBase.width
          || beforeBase.height !== afterBase.height
          || beforeBase.hash !== afterBase.hash
          || beforeBase.alphaSum !== afterBase.alphaSum
          || beforeBase.rgbSum !== afterBase.rgbSum
        ) {
          baseCanvasUnchanged = false;
          break;
        }
      }
      return {
        baseCanvasUnchanged,
        rawMaterialMapCount: Number(after?.rawMaterialMapCount) || 0,
        rawCloneTextureCount: Number(after?.rawCloneTextureCount) || 0,
        rawCanvasMapCount: Number(after?.rawCanvasMapCount) || 0,
        before,
        after
      };
    };
    const alphaAtHit = (paintHit) => {
      const material = paintHit?.record && paintHit?.hit
        ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null
        : null;
      const layer = layerForMaterial(material);
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      const uv = paintHit?.hit?.uv || null;
      if (!canvas || !context || !uv) {
        return null;
      }
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(Number(uv.x || 0) * canvas.width)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((1 - Number(uv.y || 0)) * canvas.height)));
      let alpha = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(canvas.height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(canvas.width - 1, x + 1); xx += 1) {
          alpha = Math.max(alpha, context.getImageData(xx, yy, 1, 1).data[3]);
        }
      }
      return alpha;
    };
    const sampleCoverage = (stroke) => {
      const samples = [];
      for (let index = 0; index <= 10; index += 1) {
        const ratio = index / 10;
        const x = stroke.start.x + (stroke.end.x - stroke.start.x) * ratio;
        const y = stroke.start.y + (stroke.end.y - stroke.start.y) * ratio;
        const paintHit = hitAt(x, y);
        if (!paintHit?.record || !paintHit?.hit) {
          continue;
        }
        const alpha = alphaAtHit(paintHit);
        if (!Number.isFinite(Number(alpha))) {
          continue;
        }
        samples.push({ x, y, alpha });
      }
      const paintedSamples = samples.filter((sample) => sample.alpha > 4).length;
      return {
        visibleSamples: samples.length,
        paintedSamples,
        coverageRatio: samples.length ? paintedSamples / samples.length : 0,
        alphas: samples.map((sample) => sample.alpha)
      };
    };
    const clampPoint = (point) => ({
      x: Math.max(rect.left + 4, Math.min(rect.right - 4, point.x)),
      y: Math.max(rect.top + 4, Math.min(rect.bottom - 4, point.y))
    });
    const clipForStroke = (name, stroke, margin = 120) => {
      const viewportWidth = window.innerWidth || 1280;
      const viewportHeight = window.innerHeight || 900;
      const minX = Math.min(stroke.start.x, stroke.end.x) - margin;
      const minY = Math.min(stroke.start.y, stroke.end.y) - margin;
      const maxX = Math.max(stroke.start.x, stroke.end.x) + margin;
      const maxY = Math.max(stroke.start.y, stroke.end.y) + margin;
      const x = Math.max(0, Math.floor(minX));
      const y = Math.max(0, Math.floor(minY));
      const right = Math.min(viewportWidth, Math.ceil(maxX));
      const bottom = Math.min(viewportHeight, Math.ceil(maxY));
      return {
        name,
        x,
        y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y)
      };
    };
    const paintStroke = async (name, stroke, hit) => {
      const material = ensureLayerForHit(hit);
      if (material) {
        editor.prewarmTexturePaintActiveLayerForAction?.(material, {
          label: "visual-airbrush-proof-layer-prewarm",
          preserveLayerDisplay: true,
          renderCompilePass: true
        });
        for (let index = 0; index < 6; index += 1) {
          await waitFrame();
        }
      }
      editor.onPointerDown?.(eventAt(stroke.start.x, stroke.start.y, 1));
      await waitFrame();
      let midDragPaintObserved = false;
      const steps = 18;
      for (let index = 1; index <= steps; index += 1) {
        const ratio = index / steps;
        const x = stroke.start.x + (stroke.end.x - stroke.start.x) * ratio;
        const y = stroke.start.y + (stroke.end.y - stroke.start.y) * ratio;
        editor.onPointerMove?.(eventAt(x, y, 1));
        await waitFrame();
        if (index === Math.floor(steps / 2)) {
          await delay(80);
          midDragPaintObserved = editor.painting === true
            && editor.textureAirbrushLastWebGpuPaintStats?.tslSurfaceAirbrush === true;
        }
      }
      editor.onPointerUp?.(eventAt(stroke.end.x, stroke.end.y, 0));
      await flushPaint();
      return {
        name,
        midDragPaintObserved,
        coverage: sampleCoverage(stroke),
        clip: clipForStroke(name, stroke)
      };
    };
    const torsoHit = findHit(
      [0.50, 0.52, 0.48, 0.54, 0.46, 0.56, 0.44],
      [0.28, 0.26, 0.30, 0.24, 0.32, 0.34, 0.36]
    );
    const legHit = findHit(
      [0.50, 0.47, 0.53, 0.44, 0.56, 0.41, 0.59],
      [0.66, 0.70, 0.74, 0.62, 0.78, 0.58, 0.82]
    );
    const shoulderHit = findHit(
      [0.38, 0.35, 0.41, 0.32, 0.44, 0.29, 0.47],
      [0.31, 0.34, 0.37, 0.28, 0.40, 0.43]
    );
    const upperArmHit = findHit(
      [0.18, 0.21, 0.24, 0.27, 0.30, 0.33, 0.36, 0.39, 0.61, 0.64, 0.67, 0.70, 0.73, 0.76, 0.79, 0.82],
      [0.28, 0.32, 0.36, 0.40, 0.44, 0.48, 0.52, 0.56, 0.60, 0.64, 0.68]
    );
    if (!torsoHit || !shoulderHit || !upperArmHit || !legHit) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        loadedAsset,
        torsoHitFound: Boolean(torsoHit),
        shoulderHitFound: Boolean(shoulderHit),
        upperArmHitFound: Boolean(upperArmHit),
        legHitFound: Boolean(legHit),
        error: "missing-proof-hit"
      };
    }
    resetLayerForHit(torsoHit.hit);
    if (shoulderHit.hit?.record && shoulderHit.hit.record !== torsoHit.hit?.record) {
      resetLayerForHit(shoulderHit.hit);
    }
    if (upperArmHit.hit?.record && upperArmHit.hit.record !== torsoHit.hit?.record) {
      resetLayerForHit(upperArmHit.hit);
    }
    if (legHit.hit?.record && legHit.hit.record !== torsoHit.hit?.record) {
      resetLayerForHit(legHit.hit);
    }
    const materialStateBeforePaint = materialStateSnapshot();
    const radiusPixels = Number(editor.textureBrushRadiusScreenPixels?.()) || 48;
    const torsoStroke = {
      start: clampPoint({ x: torsoHit.clientX - radiusPixels * 1.9, y: torsoHit.clientY - radiusPixels * 0.18 }),
      end: clampPoint({ x: torsoHit.clientX + radiusPixels * 2.25, y: torsoHit.clientY + radiusPixels * 0.22 })
    };
    const legStroke = {
      start: clampPoint({ x: legHit.clientX - radiusPixels * 1.05, y: legHit.clientY - radiusPixels * 1.45 }),
      end: clampPoint({ x: legHit.clientX + radiusPixels * 1.05, y: legHit.clientY + radiusPixels * 1.45 })
    };
    const shoulderStroke = {
      start: clampPoint({ x: shoulderHit.clientX - radiusPixels * 1.35, y: shoulderHit.clientY - radiusPixels * 0.38 }),
      end: clampPoint({ x: shoulderHit.clientX + radiusPixels * 1.55, y: shoulderHit.clientY + radiusPixels * 0.34 })
    };
    const upperArmStroke = {
      start: clampPoint({ x: upperArmHit.clientX - radiusPixels * 0.58, y: upperArmHit.clientY - radiusPixels * 1.25 }),
      end: clampPoint({ x: upperArmHit.clientX + radiusPixels * 0.68, y: upperArmHit.clientY + radiusPixels * 1.32 })
    };
    const layerAlphaStats = () => {
      const materials = editor.textureAirbrushPaintableMaterials?.() || [];
      let best = null;
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
        let nonzero = 0;
        let strong = 0;
        let maxAlpha = 0;
        let minX = canvas.width;
        let minY = canvas.height;
        let maxX = -1;
        let maxY = -1;
        for (let index = 3, pixel = 0; index < image.data.length; index += 4, pixel += 1) {
          const alpha = image.data[index] || 0;
          maxAlpha = Math.max(maxAlpha, alpha);
          if (alpha > 4) {
            nonzero += 1;
            const x = pixel % canvas.width;
            const y = Math.floor(pixel / canvas.width);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
          if (alpha > 128) {
            strong += 1;
          }
        }
        const total = canvas.width * canvas.height;
        const stats = {
          width: canvas.width,
          height: canvas.height,
          nonzeroRatio: total ? nonzero / total : 0,
          strongRatio: total ? strong / total : 0,
          maxAlpha,
          bbox: maxX >= minX && maxY >= minY ? { minX, minY, maxX, maxY } : null,
          layerIsEmpty: layer?.isEmpty === true,
          layerHasPaint: layer?.texturePaintHasPaint === true,
          gpuHasPaint: layer?.gpuTarget?.texturePaintLayerHasPaint === true,
          gpuEmptyTransparent: layer?.gpuTarget?.emptyTransparent === true
        };
        if (!best || stats.nonzeroRatio > best.nonzeroRatio) {
          best = stats;
        }
      }
      return best;
    };
    const rasterDebugForStroke = (stroke) => {
      const output = [];
      const caches = editor.texturePaintTslSurfaceAirbrushCacheSet instanceof Set
        ? [...editor.texturePaintTslSurfaceAirbrushCacheSet]
        : editor.texturePaintTslSurfaceAirbrushCaches instanceof Map
          ? [...editor.texturePaintTslSurfaceAirbrushCaches.values()]
          : [];
      const distanceToStroke = (x, y) => {
        const dx = stroke.end.x - stroke.start.x;
        const dy = stroke.end.y - stroke.start.y;
        const lengthSq = Math.max(0.000001, dx * dx + dy * dy);
        const t = Math.max(0, Math.min(1, ((x - stroke.start.x) * dx + (y - stroke.start.y) * dy) / lengthSq));
        const cx = stroke.start.x + dx * t;
        const cy = stroke.start.y + dy * t;
        return Math.hypot(x - cx, y - cy);
      };
      for (const cache of caches) {
        for (const entry of cache?.surfaceMeshes || []) {
          const screen = entry?.mesh?.geometry?.getAttribute?.("paintScreen") || null;
          const view = entry?.mesh?.geometry?.getAttribute?.("paintView") || null;
          if (!screen?.array?.length) {
            continue;
          }
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          let minViewZ = Infinity;
          let maxViewZ = -Infinity;
          let finite = 0;
          let near = 0;
          for (let index = 0; index < screen.count; index += 1) {
            const x = screen.array[index * 3];
            const y = screen.array[index * 3 + 1];
            const z = view?.array?.[index * 3 + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              continue;
            }
            finite += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            if (Number.isFinite(z)) {
              minViewZ = Math.min(minViewZ, z);
              maxViewZ = Math.max(maxViewZ, z);
            }
            if (distanceToStroke(x, y) <= radiusPixels * 1.85) {
              near += 1;
            }
          }
          output.push({
            name: entry?.sourceObject?.name || "",
            paintMode: entry?.paintMode || "",
            originalMeshUvRaster: entry?.originalMeshUvRaster === true,
            screenCount: screen.count,
            finite,
            nearRatio: finite ? near / finite : 0,
            screenBounds: finite ? { minX, minY, maxX, maxY } : null,
            viewZBounds: Number.isFinite(minViewZ) && Number.isFinite(maxViewZ) ? { minViewZ, maxViewZ } : null
          });
        }
      }
      return output;
    };
    const readbackTargetStats = async () => {
      const renderer = editor.renderer || null;
      if (!renderer || typeof renderer.readRenderTargetPixelsAsync !== "function") {
        return [];
      }
      const output = [];
      const seen = new Set();
      const statsForBytes = (name, target, bytes) => {
        const width = Math.max(1, Math.floor(Number(target?.width) || 1));
        const height = Math.max(1, Math.floor(Number(target?.height) || 1));
        const source = bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray
          ? bytes
          : bytes?.buffer
            ? new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength)
            : null;
        if (!source) {
          return { name, width, height, error: "missing-bytes" };
        }
        let nonzeroAlpha = 0;
        let strongAlpha = 0;
        let alphaSum = 0;
        let maxAlpha = 0;
        let nonzeroRgb = 0;
        let strongRgb = 0;
        let rgbSum = 0;
        let maxRgb = 0;
        for (let index = 0; index + 3 < source.length; index += 4) {
          const r = source[index] || 0;
          const g = source[index + 1] || 0;
          const b = source[index + 2] || 0;
          const a = source[index + 3] || 0;
          const rgb = Math.max(r, g, b);
          alphaSum += a;
          rgbSum += rgb;
          maxAlpha = Math.max(maxAlpha, a);
          maxRgb = Math.max(maxRgb, rgb);
          if (a > 4) {
            nonzeroAlpha += 1;
          }
          if (a > 128) {
            strongAlpha += 1;
          }
          if (rgb > 4) {
            nonzeroRgb += 1;
          }
          if (rgb > 128) {
            strongRgb += 1;
          }
        }
        const total = width * height;
        return {
          name,
          width,
          height,
          textureName: String(target?.texture?.name || ""),
          nonzeroAlphaRatio: total ? nonzeroAlpha / total : 0,
          strongAlphaRatio: total ? strongAlpha / total : 0,
          nonzeroRgbRatio: total ? nonzeroRgb / total : 0,
          strongRgbRatio: total ? strongRgb / total : 0,
          maxAlpha,
          maxRgb,
          alphaMean: total ? alphaSum / total : 0,
          rgbMean: total ? rgbSum / total : 0
        };
      };
      const add = async (name, target) => {
        if (!target?.texture || seen.has(target)) {
          return;
        }
        seen.add(target);
        const width = Math.max(1, Math.floor(Number(target.width) || 1));
        const height = Math.max(1, Math.floor(Number(target.height) || 1));
        try {
          const bytes = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
          output.push(statsForBytes(name, target, bytes));
        } catch (error) {
          output.push({ name, width, height, textureName: String(target?.texture?.name || ""), error: String(error?.message || error) });
        }
      };
      const caches = editor.texturePaintTslSurfaceAirbrushCacheSet instanceof Set
        ? [...editor.texturePaintTslSurfaceAirbrushCacheSet]
        : editor.texturePaintTslSurfaceAirbrushCaches instanceof Map
          ? [...editor.texturePaintTslSurfaceAirbrushCaches.values()]
          : [];
      for (const cache of caches) {
        await add("cache.strokeMaskTarget", cache?.strokeMaskTarget);
        await add("cache.maskTarget", cache?.maskTarget);
        await add("cache.dilationTarget0", cache?.dilationTargets?.[0]);
        await add("cache.dilationTarget1", cache?.dilationTargets?.[1]);
        await add("cache.currentTarget", cache?.targets?.[cache?.targetIndex || 0]);
        await add("cache.currentTextureTarget", cache?.currentTarget);
        await add("cache.layerCompositeTarget", cache?.layerCompositeTarget);
      }
      const materials = editor.textureAirbrushPaintableMaterials?.() || [];
      for (const entry of materials) {
        const material = entry?.material || entry || null;
        const stack = material?.userData?.texturePaintLayerStack || null;
        const activeLayer = (stack?.layers || []).find((item) => item.id === stack?.activeLayerId) || null;
        await add("activeLayer.gpuTarget", activeLayer?.gpuTarget?.target);
        await add("activeLayer.displayTarget", activeLayer?.gpuTarget?.displayTarget);
        await add("material.surfaceTarget", material?.userData?.texturePaintTslSurfaceAirbrushTarget?.target);
        await add("material.surfaceDisplayTarget", material?.userData?.texturePaintTslSurfaceAirbrushTarget?.displayTarget);
      }
      return output;
    };
    const torsoPaint = await paintStroke("torso-green-soft", torsoStroke, torsoHit.hit);
    const torsoStats = editor.textureAirbrushLastWebGpuPaintStats || null;
    const torsoLayerAlpha = layerAlphaStats();
    const torsoRasterDebug = rasterDebugForStroke(torsoStroke);
    const torsoTargetStats = await readbackTargetStats();
    const shoulderPaint = await paintStroke("shoulder-pec-green-soft", shoulderStroke, shoulderHit.hit);
    const shoulderStats = editor.textureAirbrushLastWebGpuPaintStats || null;
    const shoulderLayerAlpha = layerAlphaStats();
    const shoulderRasterDebug = rasterDebugForStroke(shoulderStroke);
    const shoulderTargetStats = await readbackTargetStats();
    const upperArmPaint = await paintStroke("upper-arm-green-soft", upperArmStroke, upperArmHit.hit);
    const upperArmStats = editor.textureAirbrushLastWebGpuPaintStats || null;
    const upperArmLayerAlpha = layerAlphaStats();
    const upperArmRasterDebug = rasterDebugForStroke(upperArmStroke);
    const upperArmTargetStats = await readbackTargetStats();
    const legPaint = await paintStroke("leg-green-soft", legStroke, legHit.hit);
    await flushPaint();
    editor.render?.();
    const materials = editor.textureAirbrushPaintableMaterials?.() || [];
    const layerCount = materials.reduce((total, entry) => {
      const stack = entry?.material?.userData?.texturePaintLayerStack || null;
      return total + (stack?.layers?.length || 0);
    }, 0);
    const lastStats = editor.textureAirbrushLastWebGpuPaintStats || null;
    const materialStateAfterPaint = materialStateSnapshot();
    const materialStateIntegrity = compareMaterialState(materialStateBeforePaint, materialStateAfterPaint);
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      paintRecords: editor.paintRecords?.length || 0,
      layerCount,
      activeTool: editor.activeTool,
      brush: {
        color: String(editor.texturePaintColor?.value || "").toLowerCase(),
        radiusPixels,
        opacity: Number(editor.textureAirbrushOpacity?.() ?? editor.textureBrushOpacity?.value),
        hardness: Number(editor.textureAirbrushHardness?.() ?? editor.textureBrushHardness?.value),
        scatter: Number(editor.textureAirbrushScatter?.() ?? editor.textureBrushScatter?.value),
        spacing: Number(editor.textureAirbrushSpacingPercent?.() ?? editor.textureBrushSpacing?.value),
        visibleEdgeMode: editor.textureAirbrushVisibleEdgeMode?.() || ""
      },
      torso: {
        hitFound: true,
        hit: { xFraction: torsoHit.xFraction, yFraction: torsoHit.yFraction },
        midDragPaintObserved: torsoPaint.midDragPaintObserved,
        coverage: torsoPaint.coverage,
        stats: torsoStats,
        layerAlpha: torsoLayerAlpha,
        rasterDebug: torsoRasterDebug,
        targetStats: torsoTargetStats
      },
      shoulder: {
        hitFound: true,
        hit: { xFraction: shoulderHit.xFraction, yFraction: shoulderHit.yFraction },
        midDragPaintObserved: shoulderPaint.midDragPaintObserved,
        coverage: shoulderPaint.coverage,
        stats: shoulderStats,
        layerAlpha: shoulderLayerAlpha,
        rasterDebug: shoulderRasterDebug,
        targetStats: shoulderTargetStats
      },
      upperArm: {
        hitFound: true,
        hit: { xFraction: upperArmHit.xFraction, yFraction: upperArmHit.yFraction },
        midDragPaintObserved: upperArmPaint.midDragPaintObserved,
        coverage: upperArmPaint.coverage,
        stats: upperArmStats,
        layerAlpha: upperArmLayerAlpha,
        rasterDebug: upperArmRasterDebug,
        targetStats: upperArmTargetStats
      },
      leg: {
        hitFound: true,
        hit: { xFraction: legHit.xFraction, yFraction: legHit.yFraction },
        midDragPaintObserved: legPaint.midDragPaintObserved,
        coverage: legPaint.coverage,
        layerAlpha: layerAlphaStats(),
        rasterDebug: rasterDebugForStroke(legStroke),
        targetStats: await readbackTargetStats()
      },
      screenshotClips: [torsoPaint.clip, shoulderPaint.clip, upperArmPaint.clip, legPaint.clip],
      lastWebGpuPaintStats: lastStats,
      materialStateIntegrity,
      validation,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      debugDataset: Object.fromEntries(Object.entries(document.documentElement?.dataset || {})
        .filter(([key]) => key.startsWith("textureAirbrushDebug")))
    };
  })()`;
}

function runtimeVisualAirbrushMatrixProofExpression() {
  return `(async () => {
    const editor = window.modelCleanupEditor;
    if (!editor) {
      return { ready: false, error: "missing-editor" };
    }
    const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const flushPaint = async () => {
      for (let index = 0; index < 30; index += 1) {
        const pending = editor.finishTextureAirbrushScreenStrokeFlush?.();
        if (pending && typeof pending.then === "function") {
          await pending;
        }
        if (!editor.textureAirbrushScreenStrokeHasPendingWork?.()) {
          break;
        }
        await delay(20);
      }
      const pendingGpu = editor.flushTextureAirbrushPendingWebGpuPaints?.({
        deferredCanvasSyncTileBytes: false,
        deferredCanvasSyncMaxTiles: false,
        canvasSyncApplyBudgetMs: 0
      });
      if (pendingGpu && typeof pendingGpu.then === "function") {
        await pendingGpu;
      }
      const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
        composite: false,
        preserveWebGpuDisplay: true
      });
      if (layerFlush && typeof layerFlush.then === "function") {
        await layerFlush;
      }
      await waitFrame();
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
    editor.pausePlayback?.();
    editor.setCameraPreset?.("front");
    if (editor.camera) {
      editor.camera.zoom = 2.0;
      editor.camera.updateProjectionMatrix?.();
    }
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 6; index += 1) {
      await waitFrame();
    }
    editor.setTool?.("airbrush");
    editor.textureAirbrushCaptureCandidateDebug = true;
    if (editor.canvas) {
      editor.canvas.setPointerCapture = () => {};
      editor.canvas.releasePointerCapture = () => {};
    }
    const setInput = (input, value) => {
      if (!input) {
        return;
      }
      input.value = String(value);
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    const setChecked = (input, checked) => {
      if (!input) {
        return;
      }
      input.checked = checked === true;
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    const setBrush = (options = {}) => {
      setInput(editor.textureBrushRadius, options.radius ?? 0.18);
      setInput(editor.textureBrushOpacity, options.opacity ?? 0.55);
      setInput(editor.textureBrushSpacing, options.spacing ?? 1);
      setInput(editor.textureBrushHardness, options.hardness ?? 0.18);
      setInput(editor.textureBrushScatter, options.scatter ?? 0.18);
      setInput(editor.textureVisibleEdgeMode, options.visibleEdgeMode || "soft");
      setInput(editor.texturePaintColor, options.color || "#00ff60");
      setChecked(editor.texturePressureRadius, options.pressureRadius === true);
      setChecked(editor.texturePressureOpacity, options.pressureOpacity === true);
      editor.setTexturePaintNeighborMode?.(options.neighbor === true, { status: false });
      editor.updateRangeOutputs?.();
      editor.textureAirbrushInvalidateBrushSettings?.();
    };
    setBrush({ color: "#00ff60", radius: 0.2, opacity: 0.56, hardness: 0.14, scatter: 0.18, spacing: 0.1 });
    const rect = editor.canvas?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) {
      return { ready: false, loaded: Boolean(editor.model), loadedAsset, error: "missing-canvas-rect" };
    }
    const validation = {
      projectionCalls: 0,
      projectionChanged: 0,
      timings: {
        webGpuPaintCalls: 0,
        webGpuPaintMs: 0,
        webGpuPaintMaxMs: 0,
        webGpuFlushCalls: 0,
        webGpuFlushReturnMs: 0,
        webGpuFlushReturnMaxMs: 0
      }
    };
    const originalProjection = editor.textureAirbrushProjectedMeshFromEvent?.bind(editor);
    const originalWebGpuPaint = editor.textureAirbrushWebGpuPaintFromEvent?.bind(editor);
    const originalWebGpuFlush = editor.flushTextureAirbrushQueuedWebGpuStrokes?.bind(editor);
    if (originalProjection) {
      editor.textureAirbrushProjectedMeshFromEvent = function(event, options = {}) {
        validation.projectionCalls += 1;
        const changed = originalProjection(event, options) || 0;
        validation.projectionChanged += Number(changed) || 0;
        return changed;
      };
    }
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
    if (originalWebGpuFlush) {
      editor.flushTextureAirbrushQueuedWebGpuStrokes = function(...flushArgs) {
        validation.timings.webGpuFlushCalls += 1;
        const started = performance.now();
        const result = originalWebGpuFlush(...flushArgs);
        const elapsed = performance.now() - started;
        validation.timings.webGpuFlushReturnMs += elapsed;
        validation.timings.webGpuFlushReturnMaxMs = Math.max(validation.timings.webGpuFlushReturnMaxMs, elapsed);
        return result;
      };
    }
    const eventAt = (clientX, clientY, buttons = 1, pressure = 0.72, pointerType = "mouse") => ({
      clientX,
      clientY,
      button: 0,
      buttons,
      pointerId: 1321,
      pointerType,
      pressure,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const hitAt = (clientX, clientY) => editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush") || null;
    const findHit = (xFractions, yFractions) => {
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
    const resetLayerForHit = (paintHit, name = "Paint Matrix 1") => {
      const material = paintHit?.record && paintHit?.hit
        ? editor.clonePaintMaterialForHit?.(paintHit.record, paintHit.hit) || null
        : null;
      if (!material) {
        return null;
      }
      material.userData ||= {};
      const originalTexture = material.userData.clonePaintOriginalMap
        || material.userData.textureAirbrushWebGpuCanvasMap
        || material.userData.clonePaintTexture?.userData?.textureAirbrushWebGpuCanvasMap
        || material.map?.userData?.textureAirbrushWebGpuCanvasMap
        || material.map
        || null;
      if (originalTexture) {
        material.map = originalTexture;
        material.userData.clonePaintTexture = originalTexture;
        material.needsUpdate = true;
      }
      const editable = material.userData?.clonePaintCanvas && material.userData?.clonePaintContext
        ? {
            canvas: material.userData.clonePaintCanvas,
            context: material.userData.clonePaintContext,
            texture: material.userData.clonePaintTexture || material.map
          }
        : editor.editableClonePaintTexture?.(material);
      const stack = editor.texturePaintLayerStackForMaterial?.(material, editable, { create: true }) || null;
      if (!stack) {
        return null;
      }
      for (const layer of stack.layers || []) {
        editor.disposeTexturePaintLayerGpuState?.(layer);
      }
      stack.layers = [];
      const layer = editor.texturePaintNewLayer?.(stack, { name, autoCreated: false });
      if (layer) {
        layer.name = name;
        stack.layers.push(layer);
        editor.texturePaintSetSingleLayerSelection?.(stack, layer.id);
        editor.rememberTexturePaintLayerSelection?.(stack, layer);
      }
      editor.texturePaintActiveMaterial = material;
      editor.invalidateTexturePaintMaterialGpuCaches?.(material, { resetSurfaceStroke: true });
      editor.textureAirbrushInvalidateWebGpuCache?.(material);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable?.canvas);
      editor.textureAirbrushInvalidateWebGpuCache?.(editable?.texture);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer?.canvas);
      editor.discardTexturePaintMaterialAirbrushGpuTarget?.(material);
      editor.discardTexturePaintMaterialGpuComposite?.(material);
      editor.resetTexturePaintMaterialLayerDisplayCache?.(material);
      editor.texturePaintTslSurfaceAirbrushInvalidate?.(material);
      editor.textureAirbrushResetSurfaceStroke?.();
      return { material, stack, layer };
    };
    const activeLayerForMaterial = (material) => {
      const stack = material?.userData?.texturePaintLayerStack || null;
      return (stack?.layers || []).find((layer) => layer.id === stack?.activeLayerId) || null;
    };
    const addLayerForMaterial = async (material, name = "Paint Matrix 2") => {
      editor.texturePaintActiveMaterial = material;
      const added = editor.addTexturePaintLayer?.() === true;
      await waitFrame();
      const layer = activeLayerForMaterial(material);
      if (layer) {
        layer.name = name;
      }
      editor.scheduleTexturePaintLayerPanelRender?.();
      editor.textureAirbrushInvalidateWebGpuCache?.(material);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer);
      editor.textureAirbrushInvalidateWebGpuCache?.(layer?.canvas);
      editor.texturePaintTslSurfaceAirbrushInvalidate?.(material);
      editor.textureAirbrushResetSurfaceStroke?.();
      return { added, layer };
    };
    const layerStats = (layer = null) => {
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!canvas?.width || !canvas?.height || !context) {
        return { nonzeroAlphaPixels: 0, maxAlpha: 0, alphaSum: 0 };
      }
      const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonzeroAlphaPixels = 0;
      let maxAlpha = 0;
      let alphaSum = 0;
      for (let index = 3; index < image.length; index += 4) {
        const alpha = image[index] || 0;
        alphaSum += alpha;
        maxAlpha = Math.max(maxAlpha, alpha);
        if (alpha > 4) {
          nonzeroAlphaPixels += 1;
        }
      }
      return {
        nonzeroAlphaPixels,
        maxAlpha,
        alphaSum,
        layerIsEmpty: layer?.isEmpty === true,
        gpuHasPaint: layer?.gpuTarget?.texturePaintLayerHasPaint === true,
        gpuEmptyTransparent: layer?.gpuTarget?.emptyTransparent === true
      };
    };
    const alphaAtHit = (paintHit, layer = null, material = null) => {
      const uv = paintHit?.hit?.uv || null;
      const canvas = layer?.canvas || null;
      const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!uv || !canvas || !context) {
        return null;
      }
      const referenceTexture = material?.userData?.clonePaintTexture
        || material?.userData?.clonePaintOriginalMap
        || material?.map
        || null;
      const pixel = editor.clonePaintPixelFromUv?.(uv, canvas, referenceTexture, { wrap: true }) || null;
      const x = Number.isFinite(Number(pixel?.x))
        ? Math.max(0, Math.min(canvas.width - 1, Math.round(Number(pixel.x))))
        : Math.max(0, Math.min(canvas.width - 1, Math.floor(Number(uv.x || 0) * canvas.width)));
      const y = Number.isFinite(Number(pixel?.y))
        ? Math.max(0, Math.min(canvas.height - 1, Math.round(Number(pixel.y))))
        : Math.max(0, Math.min(canvas.height - 1, Math.floor((1 - Number(uv.y || 0)) * canvas.height)));
      let alpha = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(canvas.height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(canvas.width - 1, x + 1); xx += 1) {
          alpha = Math.max(alpha, context.getImageData(xx, yy, 1, 1).data[3] || 0);
        }
      }
      return alpha;
    };
    const sampleCoverage = (stroke, layer, material) => {
      const samples = [];
      for (let index = 0; index <= 12; index += 1) {
        const ratio = index / 12;
        const x = stroke.start.x + (stroke.end.x - stroke.start.x) * ratio;
        const y = stroke.start.y + (stroke.end.y - stroke.start.y) * ratio;
        const paintHit = hitAt(x, y);
        if (!paintHit?.record || !paintHit?.hit) {
          continue;
        }
        const alpha = alphaAtHit(paintHit, layer, material);
        if (Number.isFinite(Number(alpha))) {
          samples.push({ x, y, alpha });
        }
      }
      const dx = stroke.end.x - stroke.start.x;
      const dy = stroke.end.y - stroke.start.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;
      const mid = {
        x: (stroke.start.x + stroke.end.x) * 0.5,
        y: (stroke.start.y + stroke.end.y) * 0.5
      };
      const radiusPixels = Math.max(1, Number(editor.textureBrushRadiusScreenPixels?.()) || 48);
      let paintedRadiusEstimate = 0;
      const crossSamples = [];
      for (let offsetScale = -1.35; offsetScale <= 1.351; offsetScale += 0.15) {
        const x = mid.x + nx * radiusPixels * offsetScale;
        const y = mid.y + ny * radiusPixels * offsetScale;
        const paintHit = hitAt(x, y);
        if (!paintHit?.record || !paintHit?.hit) {
          continue;
        }
        const alpha = alphaAtHit(paintHit, layer, material);
        if (!Number.isFinite(Number(alpha))) {
          continue;
        }
        crossSamples.push({ offsetScale, alpha });
        if (alpha > 8) {
          paintedRadiusEstimate = Math.max(paintedRadiusEstimate, Math.abs(offsetScale) * radiusPixels);
        }
      }
      const paintedSamples = samples.filter((sample) => sample.alpha > 8).length;
      return {
        visibleSamples: samples.length,
        paintedSamples,
        coverageRatio: samples.length ? paintedSamples / samples.length : 0,
        minAlpha: samples.length ? Math.min(...samples.map((sample) => sample.alpha)) : 0,
        maxAlpha: samples.length ? Math.max(...samples.map((sample) => sample.alpha)) : 0,
        alphas: samples.map((sample) => sample.alpha),
        paintedRadiusEstimate,
        crossAlphas: crossSamples.map((sample) => ({ offsetScale: Number(sample.offsetScale.toFixed(2)), alpha: sample.alpha }))
      };
    };
    const clampPoint = (point) => ({
      x: Math.max(rect.left + 4, Math.min(rect.right - 4, point.x)),
      y: Math.max(rect.top + 4, Math.min(rect.bottom - 4, point.y))
    });
    const makeStroke = (center, dx0, dx1, dy = 0) => ({
      start: clampPoint({ x: center.clientX + dx0, y: center.clientY + dy }),
      end: clampPoint({ x: center.clientX + dx1, y: center.clientY + dy })
    });
    const paintStroke = async (name, stroke, layer, material, options = {}) => {
      const prewarmStart = performance.now();
      editor.prewarmTexturePaintActiveLayerForAction?.(material, {
        label: "visual-airbrush-matrix-prewarm-" + name,
        preserveLayerDisplay: true,
        renderCompilePass: true
      });
      for (let index = 0; index < 2; index += 1) {
        await waitFrame();
      }
      const prewarmMs = performance.now() - prewarmStart;
      const pointerType = options.pointerType || "mouse";
      editor.onPointerDown?.(eventAt(stroke.start.x, stroke.start.y, 1, options.pressure ?? 0.72, pointerType));
      await waitFrame();
      const steps = Math.max(2, Math.floor(Number(options.steps) || 16));
      let midDragPaintObserved = false;
      for (let index = 1; index <= steps; index += 1) {
        const ratio = index / steps;
        const x = stroke.start.x + (stroke.end.x - stroke.start.x) * ratio;
        const y = stroke.start.y + (stroke.end.y - stroke.start.y) * ratio;
        editor.onPointerMove?.(eventAt(x, y, 1, options.pressure ?? 0.72, pointerType));
        await waitFrame();
        if (index === Math.floor(steps / 2)) {
          await delay(40);
          midDragPaintObserved = editor.painting === true
            && editor.textureAirbrushLastWebGpuPaintStats?.tslSurfaceAirbrush === true;
        }
      }
      editor.onPointerUp?.(eventAt(stroke.end.x, stroke.end.y, 0, options.pressure ?? 0, pointerType));
      await flushPaint();
      const stats = editor.textureAirbrushLastWebGpuPaintStats || null;
      return {
        name,
        prewarmMs,
        midDragPaintObserved,
        brush: {
          color: String(editor.texturePaintColor?.value || "").toLowerCase(),
          radiusPixels: Number(editor.textureBrushRadiusScreenPixels?.()) || 0,
          opacity: Number(editor.textureAirbrushOpacity?.() ?? editor.textureBrushOpacity?.value),
          hardness: Number(editor.textureAirbrushHardness?.() ?? editor.textureBrushHardness?.value),
          scatter: Number(editor.textureAirbrushScatter?.() ?? editor.textureBrushScatter?.value),
          spacing: Number(editor.textureAirbrushSpacingPercent?.() ?? editor.textureBrushSpacing?.value),
          visibleEdgeMode: editor.textureAirbrushVisibleEdgeMode?.() || "",
          neighbor: editor.texturePaintNeighborModeEnabled?.() === true,
          pressureRadius: editor.texturePressureRadius?.checked === true,
          pressureOpacity: editor.texturePressureOpacity?.checked === true
        },
        coverage: sampleCoverage(stroke, layer, material),
        stats
      };
    };
    const clipForStrokes = (name, strokes, margin = 110) => {
      const viewportWidth = window.innerWidth || 1280;
      const viewportHeight = window.innerHeight || 900;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const stroke of strokes || []) {
        for (const point of [stroke.start, stroke.end]) {
          if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
            continue;
          }
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
      }
      const x = Math.max(0, Math.floor(minX - margin));
      const y = Math.max(0, Math.floor(minY - margin));
      const right = Math.min(viewportWidth, Math.ceil(maxX + margin));
      const bottom = Math.min(viewportHeight, Math.ceil(maxY + margin));
      return { name, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
    };
    const torsoHit = findHit(
      [0.50, 0.52, 0.48, 0.54, 0.46, 0.56, 0.44],
      [0.28, 0.31, 0.34, 0.37, 0.40]
    );
    const shoulderHit = findHit(
      [0.38, 0.35, 0.41, 0.32, 0.44, 0.29, 0.47],
      [0.31, 0.34, 0.37, 0.28, 0.40, 0.43]
    );
    const legHit = findHit(
      [0.50, 0.47, 0.53, 0.44, 0.56, 0.41, 0.59],
      [0.66, 0.70, 0.74, 0.62, 0.78, 0.58, 0.82]
    );
    if (!torsoHit || !shoulderHit || !legHit) {
      return {
        ready: false,
        loaded: Boolean(editor.model),
        loadedAsset,
        torsoHitFound: Boolean(torsoHit),
        shoulderHitFound: Boolean(shoulderHit),
        legHitFound: Boolean(legHit),
        error: "missing-matrix-hit"
      };
    }
    const reset = resetLayerForHit(torsoHit.hit, "Paint Matrix 1");
    if (!reset?.material || !reset?.layer) {
      return { ready: false, loaded: true, loadedAsset, error: "missing-matrix-layer" };
    }
    const material = reset.material;
    const baseLayer = reset.layer;
    const radius = Math.max(36, Number(editor.textureBrushRadiusScreenPixels?.()) || 48);
    const matrixStrokes = {
      backgroundBlend: makeStroke(torsoHit, -radius * 0.9, radius * 1.0, -radius * 1.55),
      opacityLow: makeStroke(torsoHit, -radius * 1.3, radius * 1.05, radius * 0.85),
      opacityHigh: makeStroke(torsoHit, -radius * 1.15, radius * 1.2, radius * 1.45),
      sameLayerSecond: makeStroke(torsoHit, -radius * 1.0, radius * 1.35, radius * 2.0),
      denseSpacing: makeStroke(shoulderHit, -radius * 1.1, radius * 1.2, -radius * 0.35),
      sparseSpacing: makeStroke(shoulderHit, -radius * 1.45, radius * 1.55, radius * 1.0),
      lowScatter: makeStroke(legHit, -radius * 0.85, radius * 0.85, -radius * 0.9),
      highScatter: makeStroke(legHit, -radius * 0.85, radius * 0.85, -radius * 0.35),
      pressureLow: makeStroke(torsoHit, -radius * 1.15, radius * 1.15, -radius * 0.05),
      pressureHigh: makeStroke(torsoHit, -radius * 1.15, radius * 1.15, radius * 0.55),
      neighbor: makeStroke(shoulderHit, -radius * 1.2, radius * 1.25, radius * 0.85),
      softEdge: makeStroke(torsoHit, -radius * 0.9, radius * 1.15, -radius * 0.75),
      hardEdge: makeStroke(torsoHit, -radius * 0.9, radius * 1.15, -radius * 1.2)
    };
    const backgroundBlendSet = baseLayer?.id
      ? editor.setTexturePaintLayerBlendMode?.(baseLayer.id, "multiply") === true
      : false;
    await waitFrame();
    setBrush({ color: "#8fb2ff", radius: 0.19, opacity: 0.68, hardness: 0.15, scatter: 0.12, spacing: 0.1, visibleEdgeMode: "soft" });
    const backgroundBlend = await paintStroke("matrix-background-multiply", matrixStrokes.backgroundBlend, baseLayer, material);
    const backgroundOpacityChanged = baseLayer?.id
      ? editor.setTexturePaintLayerOpacity?.(baseLayer.id, 0.34) === true
      : false;
    await waitFrame();
    const backgroundOpacityRefresh = { ...(editor.textureAirbrushLastLayerDisplayRefreshStats || {}) };
    const backgroundOpacityRestored = baseLayer?.id
      ? editor.setTexturePaintLayerOpacity?.(baseLayer.id, 1) === true
      : false;
    await waitFrame();
    const backgroundOpacityRestoreRefresh = { ...(editor.textureAirbrushLastLayerDisplayRefreshStats || {}) };
    const backgroundBlendRestored = baseLayer?.id
      ? editor.setTexturePaintLayerBlendMode?.(baseLayer.id, "normal") === true
      : false;
    await waitFrame();
    const backgroundBlendRestoreRefresh = { ...(editor.textureAirbrushLastLayerDisplayRefreshStats || {}) };
    setBrush({ color: "#00ff60", radius: 0.22, opacity: 0.22, hardness: 0.14, scatter: 0.18, spacing: 0.1 });
    const opacityLow = await paintStroke("matrix-opacity-low", matrixStrokes.opacityLow, baseLayer, material);
    setBrush({ color: "#00ff60", radius: 0.22, opacity: 0.72, hardness: 0.14, scatter: 0.18, spacing: 0.1 });
    const opacityHigh = await paintStroke("matrix-opacity-high", matrixStrokes.opacityHigh, baseLayer, material);
    const afterFirst = layerStats(baseLayer);
    setBrush({ color: "#ffe14a", radius: 0.2, opacity: 0.58, hardness: 0.18, scatter: 0.18, spacing: 0.1 });
    const sameLayerSecond = await paintStroke("matrix-same-layer-second", matrixStrokes.sameLayerSecond, baseLayer, material);
    const afterSecond = layerStats(baseLayer);
    setBrush({ color: "#37d5ff", radius: 0.16, opacity: 0.58, hardness: 0.2, scatter: 0.08, spacing: 0.1 });
    const denseSpacing = await paintStroke("matrix-spacing-dense", matrixStrokes.denseSpacing, baseLayer, material, { steps: 22 });
    setBrush({ color: "#37d5ff", radius: 0.16, opacity: 0.58, hardness: 0.2, scatter: 0.08, spacing: 120 });
    const sparseSpacing = await paintStroke("matrix-spacing-sparse", matrixStrokes.sparseSpacing, baseLayer, material, { steps: 22 });
    setBrush({ color: "#ff4df0", radius: 0.17, opacity: 0.55, hardness: 0.2, scatter: 0.02, spacing: 0.1 });
    const lowScatter = await paintStroke("matrix-scatter-low", matrixStrokes.lowScatter, baseLayer, material);
    setBrush({ color: "#ff4df0", radius: 0.17, opacity: 0.55, hardness: 0.2, scatter: 0.65, spacing: 0.1 });
    const highScatter = await paintStroke("matrix-scatter-high", matrixStrokes.highScatter, baseLayer, material);
    let pressureLow = null;
    let pressureHigh = null;
    setBrush({ color: "#7aff66", radius: 0.2, opacity: 0.56, hardness: 0.14, scatter: 0.22, spacing: 0.1, neighbor: true });
    const neighborStroke = await paintStroke("matrix-neighbor", matrixStrokes.neighbor, baseLayer, material);
    setBrush({ color: "#ffb347", radius: 0.2, opacity: 0.58, hardness: 0.12, scatter: 0.18, spacing: 0.1, neighbor: false, visibleEdgeMode: "soft" });
    const softEdge = await paintStroke("matrix-soft-edge", matrixStrokes.softEdge, baseLayer, material);
    setBrush({ color: "#ff7a3d", radius: 0.2, opacity: 0.58, hardness: 0.12, scatter: 0.18, spacing: 0.1, neighbor: false, visibleEdgeMode: "hard" });
    const hardEdge = await paintStroke("matrix-hard-edge", matrixStrokes.hardEdge, baseLayer, material);
    const beforeSecondLayer = layerStats(baseLayer);
    const secondLayer = await addLayerForMaterial(material, "Paint Matrix 2");
    const newLayer = secondLayer.layer || activeLayerForMaterial(material);
    const secondLayerBlendSet = newLayer?.id
      ? editor.setTexturePaintLayerBlendMode?.(newLayer.id, "multiply") === true
      : false;
    await waitFrame();
    setBrush({ color: "#3f7cff", radius: 0.21, opacity: 0.62, hardness: 0.16, scatter: 0.18, spacing: 0.1, visibleEdgeMode: "soft" });
    const twoLayerStrokeShape = makeStroke(torsoHit, -radius * 1.25, radius * 1.25, radius * 2.55);
    const twoLayerStroke = await paintStroke("matrix-two-layer", twoLayerStrokeShape, newLayer, material);
    setBrush({ color: "#ff0055", radius: 0.22, opacity: 0.92, hardness: 0.12, scatter: 0.14, spacing: 0.1, pressureRadius: true, pressureOpacity: true });
    pressureLow = await paintStroke("matrix-pressure-low", matrixStrokes.pressureLow, newLayer, material, { pressure: 0.28, pointerType: "pen" });
    pressureHigh = await paintStroke("matrix-pressure-high", matrixStrokes.pressureHigh, newLayer, material, { pressure: 1, pointerType: "pen" });
    const baseAfterSecondLayer = layerStats(baseLayer);
    const newLayerStats = layerStats(newLayer);
    await flushPaint();
    editor.render?.();
    const screenshotClips = [
      clipForStrokes("matrix-opacity-spacing-scatter", [
        matrixStrokes.backgroundBlend,
        matrixStrokes.opacityLow,
        matrixStrokes.opacityHigh,
        matrixStrokes.sameLayerSecond,
        matrixStrokes.denseSpacing,
        matrixStrokes.sparseSpacing
      ]),
      clipForStrokes("matrix-neighbor-hard-soft", [
        matrixStrokes.neighbor,
        matrixStrokes.softEdge,
        matrixStrokes.hardEdge
      ]),
      clipForStrokes("matrix-pressure", [
        matrixStrokes.pressureLow,
        matrixStrokes.pressureHigh
      ]),
      clipForStrokes("matrix-two-layer", [twoLayerStrokeShape])
    ].filter(Boolean);
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      torsoHitFound: true,
      shoulderHitFound: true,
      legHitFound: true,
      activeTool: editor.activeTool,
      rendererMode: editor.textureAirbrushRendererMode || "",
      sameLayer: {
        layerName: baseLayer?.name || "",
        backgroundBlend: {
          blendModeSet: backgroundBlendSet,
          opacityChanged: backgroundOpacityChanged,
          opacityRefresh: backgroundOpacityRefresh,
          opacityRestored: backgroundOpacityRestored,
          opacityRestoreRefresh: backgroundOpacityRestoreRefresh,
          blendModeRestored: backgroundBlendRestored,
          blendRestoreRefresh: backgroundBlendRestoreRefresh,
          stroke: backgroundBlend
        },
        afterFirst,
        second: sameLayerSecond,
        afterSecond
      },
      opacity: {
        low: opacityLow,
        high: opacityHigh
      },
      spacing: {
        dense: denseSpacing,
        sparse: sparseSpacing
      },
      scatter: {
        low: lowScatter,
        high: highScatter
      },
      pressure: {
        low: pressureLow,
        high: pressureHigh
      },
      neighbor: {
        enabled: neighborStroke?.brush?.neighbor === true,
        ...neighborStroke
      },
      edgeModes: {
        soft: softEdge,
        hard: hardEdge
      },
      twoLayer: {
        layerAdded: secondLayer.added === true,
        layerName: newLayer?.name || "",
        blendModeSet: secondLayerBlendSet,
        blendMode: newLayer?.blendMode || "",
        stroke: twoLayerStroke,
        baseBeforeSecondLayer: beforeSecondLayer,
        baseAfterSecondLayer,
        newLayer: newLayerStats
      },
      screenshotClips,
      lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      validation,
      debugDataset: {
        screenQueuedDrainCount: document.documentElement?.dataset?.textureAirbrushDebugScreenQueuedDrainCount || "",
        scheduledFlushRunCount: document.documentElement?.dataset?.textureAirbrushDebugScheduledFlushRunCount || "",
        screenFlushBatchChanged: document.documentElement?.dataset?.textureAirbrushDebugScreenFlushBatchChanged || "",
        liveCandidatePaint: document.documentElement?.dataset?.textureAirbrushDebugLiveCandidatePaint || "",
        liveCandidateQueuedAfter: document.documentElement?.dataset?.textureAirbrushDebugLiveCandidateQueuedAfter || ""
      }
    };
  })()`;
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
      const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
        composite: false,
        preserveWebGpuDisplay: true
      });
      if (layerFlush && typeof layerFlush.then === "function") {
        await layerFlush;
      }
      await waitFrame();
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
    const setInput = (input, value) => {
      if (!input) {
        return;
      }
      input.value = String(value);
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    setInput(editor.textureBrushRadius, 0.18);
    setInput(editor.textureBrushOpacity, 0.42);
    setInput(editor.textureBrushSpacing, 1);
    setInput(editor.textureBrushHardness, 0.38);
    setInput(editor.textureBrushScatter, 0.36);
    setInput(editor.texturePaintColor, "#ff7a3d");
    setInput(editor.textureVisibleEdgeMode, "soft");
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
    const radius = Math.max(18, Number(editor.textureBrushRadiusScreenPixels?.()) || 34);
    const centerX = Math.max(rect.left + 90, Math.min(rect.right - 45, sideHit.clientX - 12));
    const centerY = Math.max(rect.top + 130, Math.min(rect.bottom - 80, sideHit.clientY));
    const pointNear = (x, y) => {
      const xOffsets = [0, -8, 8, -16, 16, -26, 26, -38, 38, -52, 52];
      const yOffsets = [0, -5, 5, -10, 10];
      for (const yOffset of yOffsets) {
        for (const xOffset of xOffsets) {
          const point = {
            x: Math.max(rect.left + 4, Math.min(rect.right - 4, x + xOffset)),
            y: Math.max(rect.top + 4, Math.min(rect.bottom - 4, y + yOffset))
          };
          const hit = hitAt(point.x, point.y);
          if (hit?.record && hit?.hit) {
            return { ...point, hit };
          }
        }
      }
      return null;
    };
    const strokeRows = [-34, -17, 0, 17, 34];
    const strokes = [];
    for (const offsetY of strokeRows) {
      const y = centerY + offsetY;
      const start = pointNear(centerX - 30, y) || pointNear(centerX, y);
      const end = pointNear(centerX + 34, y) || pointNear(centerX + 18, y) || pointNear(centerX, y + 16);
      if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) < 8) {
        continue;
      }
      strokes.push({
        start: { x: start.x, y: start.y },
        mid: { x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 },
        end: { x: end.x, y: end.y }
      });
    }
    if (!strokes.length) {
      const fallbackEnd = pointNear(sideHit.clientX, sideHit.clientY + 32);
      if (fallbackEnd && Math.hypot(fallbackEnd.x - sideHit.clientX, fallbackEnd.y - sideHit.clientY) >= 8) {
        strokes.push({
          start: { x: sideHit.clientX, y: sideHit.clientY },
          mid: { x: (sideHit.clientX + fallbackEnd.x) * 0.5, y: (sideHit.clientY + fallbackEnd.y) * 0.5 },
          end: { x: fallbackEnd.x, y: fallbackEnd.y }
        });
      }
    }
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
    const finalLayerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      material,
      composite: false,
      preserveWebGpuDisplay: true
    });
    if (finalLayerFlush && typeof finalLayerFlush.then === "function") {
      await finalLayerFlush;
    }
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
    const clipForStrokes = (name, strokeList, margin = 110) => {
      const viewportWidth = window.innerWidth || 1280;
      const viewportHeight = window.innerHeight || 900;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const stroke of strokeList || []) {
        for (const point of [stroke.start, stroke.mid, stroke.end]) {
          if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
            continue;
          }
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
      }
      const x = Math.max(0, Math.floor(minX - margin));
      const y = Math.max(0, Math.floor(minY - margin));
      const right = Math.min(viewportWidth, Math.ceil(maxX + margin));
      const bottom = Math.min(viewportHeight, Math.ceil(maxY + margin));
      return { name, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
    };
    const sideEdgeClip = clipForStrokes("side-edge-soft-normal-feather", strokes);
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
      screenshotClips: sideEdgeClip ? [sideEdgeClip] : [],
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0,
      validation
    };
  })()`;
}

function runtimeFrontBackLeakExpression() {
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
        const webGpuPending = editor.flushTextureAirbrushPendingWebGpuPaints?.();
        if (webGpuPending && typeof webGpuPending.then === "function") {
          await webGpuPending;
        }
        const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
          composite: false,
          preserveWebGpuDisplay: true
        });
        if (layerFlush && typeof layerFlush.then === "function") {
          await layerFlush;
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
    editor.pausePlayback?.();
    editor.setCameraPreset?.("front");
    if (editor.camera) {
      editor.camera.zoom = 2.0;
      editor.camera.updateProjectionMatrix?.();
    }
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 6; index += 1) {
      await waitFrame();
    }
    editor.setTool?.("airbrush");
    editor.textureAirbrushCaptureCandidateDebug = true;
    if (editor.canvas) {
      editor.canvas.setPointerCapture = () => {};
      editor.canvas.releasePointerCapture = () => {};
    }
    const setInput = (input, value) => {
      if (!input) {
        return;
      }
      input.value = String(value);
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    const setChecked = (input, checked) => {
      if (!input) {
        return;
      }
      input.checked = checked === true;
      input.dispatchEvent?.(new Event("input", { bubbles: true }));
      input.dispatchEvent?.(new Event("change", { bubbles: true }));
    };
    const setBrush = (options = {}) => {
      setInput(editor.textureBrushRadius, options.radius ?? 0.22);
      setInput(editor.textureBrushOpacity, options.opacity ?? 0.72);
      setInput(editor.textureBrushSpacing, options.spacing ?? 0.1);
      setInput(editor.textureBrushHardness, options.hardness ?? 0.14);
      setInput(editor.textureBrushScatter, options.scatter ?? 0.18);
      setInput(editor.textureVisibleEdgeMode, options.visibleEdgeMode || "soft");
      setInput(editor.texturePaintColor, options.color || "#00ff60");
      setChecked(editor.texturePressureRadius, false);
      setChecked(editor.texturePressureOpacity, false);
      editor.setTexturePaintNeighborMode?.(options.neighbor === true, { status: false });
      editor.updateRangeOutputs?.();
      editor.textureAirbrushInvalidateBrushSettings?.();
    };
    const frontBackParams = new URLSearchParams(window.location.search || "");
    const frontBackNeighborEnabled = !frontBackParams.has("debugAirbrushFrontBackNeighborOff");
    setBrush({
      color: "#00ff60",
      radius: 0.22,
      opacity: 0.72,
      hardness: 0.14,
      scatter: 0.18,
      spacing: 0.1,
      neighbor: frontBackNeighborEnabled,
      visibleEdgeMode: "soft"
    });
    const rect = editor.canvas?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) {
      return { ready: false, loaded: Boolean(editor.model), loadedAsset, error: "missing-canvas-rect" };
    }
    const eventAt = (clientX, clientY, buttons = 1, pressure = 0.72) => ({
      clientX,
      clientY,
      button: 0,
      buttons,
      pointerId: 3317,
      pointerType: "mouse",
      pressure,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {}
    });
    const hitAt = (clientX, clientY) => editor.texturePaintHitForEvent?.(eventAt(clientX, clientY), "airbrush") || null;
    const findHit = (xFractions, yFractions) => {
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
    const frontHit = findHit(
      [0.50, 0.52, 0.48, 0.54, 0.46, 0.56, 0.44],
      [0.30, 0.34, 0.38, 0.42, 0.46]
    );
    if (!frontHit) {
      return { ready: false, loaded: Boolean(editor.model), loadedAsset, frontHitFound: false, error: "missing-front-hit" };
    }
    const material = editor.clonePaintMaterialForHit?.(frontHit.hit.record, frontHit.hit.hit)
      || editor.texturePaintFirstLayerMaterial?.()
      || null;
    if (!material) {
      return { ready: false, loaded: true, loadedAsset, frontHitFound: true, error: "missing-material" };
    }
    editor.texturePaintActiveMaterial = material;
    const layerAdded = editor.addTexturePaintLayer?.() === true;
    await waitFrame();
    const stack = material.userData?.texturePaintLayerStack || null;
    const layer = (stack?.layers || []).find((item) => item.id === stack?.activeLayerId) || null;
    if (!layer?.canvas) {
      return { ready: false, loaded: true, loadedAsset, frontHitFound: true, layerAdded, error: "missing-layer" };
    }
    editor.textureAirbrushInvalidateWebGpuCache?.(material);
    editor.textureAirbrushInvalidateWebGpuCache?.(layer);
    editor.textureAirbrushInvalidateWebGpuCache?.(layer.canvas);
    editor.texturePaintTslSurfaceAirbrushInvalidate?.(material);
    editor.textureAirbrushResetSurfaceStroke?.();

    ${runtimeViewerFrameHelpersExpression()}

    const alphaAtHit = (paintHit) => {
      const uv = paintHit?.hit?.uv || null;
      const context = layer.canvas.getContext?.("2d", { willReadFrequently: true }) || null;
      if (!uv || !context) {
        return null;
      }
      const referenceTexture = material?.userData?.clonePaintTexture
        || material?.userData?.clonePaintOriginalMap
        || material?.map
        || null;
      const pixel = editor.clonePaintPixelFromUv?.(uv, layer.canvas, referenceTexture, { wrap: true }) || null;
      const x = Number.isFinite(Number(pixel?.x))
        ? Math.max(0, Math.min(layer.canvas.width - 1, Math.round(Number(pixel.x))))
        : Math.max(0, Math.min(layer.canvas.width - 1, Math.floor(Number(uv.x || 0) * layer.canvas.width)));
      const y = Number.isFinite(Number(pixel?.y))
        ? Math.max(0, Math.min(layer.canvas.height - 1, Math.round(Number(pixel.y))))
        : Math.max(0, Math.min(layer.canvas.height - 1, Math.floor((1 - Number(uv.y || 0)) * layer.canvas.height)));
      let alpha = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(layer.canvas.height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(layer.canvas.width - 1, x + 1); xx += 1) {
          alpha = Math.max(alpha, context.getImageData(xx, yy, 1, 1).data[3] || 0);
        }
      }
      return alpha;
    };
    const sampleCoverage = (stroke) => {
      const samples = [];
      for (let index = 0; index <= 12; index += 1) {
        const ratio = index / 12;
        const x = stroke.start.x + (stroke.end.x - stroke.start.x) * ratio;
        const y = stroke.start.y + (stroke.end.y - stroke.start.y) * ratio;
        const paintHit = hitAt(x, y);
        if (!paintHit?.record || !paintHit?.hit) {
          continue;
        }
        const alpha = alphaAtHit(paintHit);
        if (Number.isFinite(Number(alpha))) {
          samples.push({ x, y, alpha });
        }
      }
      const paintedSamples = samples.filter((sample) => sample.alpha > 8).length;
      return {
        visibleSamples: samples.length,
        paintedSamples,
        coverageRatio: samples.length ? paintedSamples / samples.length : 0,
        alphas: samples.map((sample) => sample.alpha)
      };
    };
    const radiusPixels = Math.max(42, Number(editor.textureBrushRadiusScreenPixels?.()) || 48);
    const stroke = {
      start: {
        x: Math.max(rect.left + 6, frontHit.clientX - radiusPixels * 1.15),
        y: Math.max(rect.top + 6, Math.min(rect.bottom - 6, frontHit.clientY + radiusPixels * 0.92))
      },
      end: {
        x: Math.min(rect.right - 6, frontHit.clientX + radiusPixels * 1.25),
        y: Math.max(rect.top + 6, Math.min(rect.bottom - 6, frontHit.clientY + radiusPixels * 0.92))
      }
    };
    const fullClip = (name) => ({
      name,
      x: 0,
      y: 0,
      width: Math.max(1, Math.floor(window.innerWidth || rect.width || 1)),
      height: Math.max(1, Math.floor(window.innerHeight || rect.height || 1))
    });

    editor.setCameraPreset?.("back");
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 8; index += 1) {
      await waitFrame();
    }
    editor.render?.();
    await waitFrame();
    const backBefore = captureViewerFrame();

    editor.setCameraPreset?.("front");
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 8; index += 1) {
      await waitFrame();
    }
    editor.setTool?.("airbrush");
    editor.onPointerDown?.(eventAt(stroke.start.x, stroke.start.y, 1));
    await waitFrame();
    let midDragPaintObserved = false;
    const steps = 18;
    for (let index = 1; index <= steps; index += 1) {
      const ratio = index / steps;
      const x = stroke.start.x + (stroke.end.x - stroke.start.x) * ratio;
      const y = stroke.start.y + (stroke.end.y - stroke.start.y) * ratio;
      editor.onPointerMove?.(eventAt(x, y, 1));
      await waitFrame();
      if (index === Math.floor(steps / 2)) {
        await delay(40);
        midDragPaintObserved = editor.painting === true
          && editor.textureAirbrushLastWebGpuPaintStats?.tslSurfaceAirbrush === true;
      }
    }
    editor.onPointerUp?.(eventAt(stroke.end.x, stroke.end.y, 0, 0));
    await flushPaint();
    const frontStats = editor.textureAirbrushLastWebGpuPaintStats || null;
    const frontCoverage = sampleCoverage(stroke);
    const frontViewMatrix = editor.camera?.matrixWorldInverse?.clone?.() || null;

    editor.setCameraPreset?.("back");
    editor.textureAirbrushCameraChanged?.();
    for (let index = 0; index < 10; index += 1) {
      await waitFrame();
    }
    editor.render?.();
    await waitFrame();
    const backAfter = captureViewerFrame();
    const backPaintChange = compareViewerPaintColorChange(
      backBefore,
      backAfter,
      { r: 0, g: 255, b: 96 },
      { x: 0, y: 0, width: backAfter?.width || 1, height: backAfter?.height || 1 }
    );
    const serializePaintHit = (paintHit) => {
      if (!paintHit?.record || !paintHit?.hit) {
        return null;
      }
      const overlapMaskAtUv = (materialForHit, sourceObject, uv) => {
        let texture = materialForHit?.userData?.texturePaintTslSurfaceAirbrush?.overlapMaskTexture
          || material?.userData?.texturePaintTslSurfaceAirbrush?.overlapMaskTexture
          || null;
        if (!texture) {
          for (const cache of editor.texturePaintTslSurfaceAirbrushCacheSet || []) {
            for (const entry of cache?.surfaceMeshes || []) {
              if (
                sourceObject
                && entry?.sourceObject !== sourceObject
                && entry?.sourceObject?.geometry !== sourceObject.geometry
              ) {
                continue;
              }
              texture = entry?.material?.userData?.texturePaintTslSurfaceAirbrush?.overlapMaskTexture || null;
              if (texture) {
                break;
              }
            }
            if (texture) {
              break;
            }
          }
        }
        const data = texture?.image?.data || null;
        const width = Math.max(0, Math.floor(Number(texture?.image?.width) || 0));
        const height = Math.max(0, Math.floor(Number(texture?.image?.height) || 0));
        if (!data || !width || !height || !uv) {
          return null;
        }
        const x = Math.max(0, Math.min(width - 1, Math.floor(Number(uv.x || 0) * width)));
        const y = Math.max(0, Math.min(height - 1, Math.floor(Number(uv.y || 0) * height)));
        const yFlipped = Math.max(0, Math.min(height - 1, height - 1 - y));
        let nearestZero = null;
        let minNeighborhoodValue = 255;
        const neighborhoodRadius = 32;
        for (let yy = Math.max(0, y - neighborhoodRadius); yy <= Math.min(height - 1, y + neighborhoodRadius); yy += 1) {
          for (let xx = Math.max(0, x - neighborhoodRadius); xx <= Math.min(width - 1, x + neighborhoodRadius); xx += 1) {
            const value = Number(data[(yy * width + xx) * 4] || 0);
            minNeighborhoodValue = Math.min(minNeighborhoodValue, value);
            if (value <= 0) {
              const distance = Math.hypot(xx - x, yy - y);
              if (nearestZero === null || distance < nearestZero) {
                nearestZero = distance;
              }
            }
          }
        }
        return {
          size: { width, height },
          value: Number(data[(y * width + x) * 4] || 0),
          valueFlipY: Number(data[(yFlipped * width + x) * 4] || 0),
          minNeighborhoodValue,
          nearestZero
        };
      };
      const uv = paintHit.hit.uv || null;
      const point = paintHit.hit.point || null;
      const normal = paintHit.hit.face?.normal || null;
      const object = paintHit.record.object || paintHit.hit.object || null;
      const materialForHit = paintHit.record.material || object?.material || null;
      const componentState = editor.textureAirbrushNeighborComponentState?.(paintHit.record) || null;
      const componentIds = componentState?.componentIds || null;
      const geometry = object?.geometry || null;
      const indexAttr = geometry?.index || null;
      const faceIndex = Number.isFinite(Number(paintHit.hit.faceIndex)) ? Math.max(0, Math.floor(Number(paintHit.hit.faceIndex))) : -1;
      const componentVote = new Map();
      if (componentIds && faceIndex >= 0) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertexIndex = indexAttr
            ? Math.max(0, Math.floor(Number(indexAttr.getX(faceIndex * 3 + corner)) || 0))
            : faceIndex * 3 + corner;
          const componentId = Math.floor(Number(componentIds[vertexIndex]));
          if (componentId >= 0) {
            componentVote.set(componentId, (componentVote.get(componentId) || 0) + 1);
          }
        }
      }
      let componentId = null;
      let componentCount = -1;
      for (const [id, count] of componentVote) {
        if (count > componentCount) {
          componentId = id;
          componentCount = count;
        }
      }
      return {
        objectName: object?.name || "",
        objectUuid: object?.uuid || "",
        materialName: materialForHit?.name || "",
        materialUuid: materialForHit?.uuid || "",
        faceIndex: faceIndex >= 0 ? faceIndex : null,
        materialIndex: Number.isFinite(Number(paintHit.hit.face?.materialIndex)) ? Number(paintHit.hit.face.materialIndex) : null,
        componentId,
        uv: uv ? { x: Number(uv.x), y: Number(uv.y) } : null,
        overlapMask: overlapMaskAtUv(materialForHit, object, uv),
        point: point ? { x: Number(point.x), y: Number(point.y), z: Number(point.z) } : null,
        faceNormal: normal ? { x: Number(normal.x), y: Number(normal.y), z: Number(normal.z) } : null,
        layerAlpha: alphaAtHit(paintHit)
      };
    };
    const geometryMaterialIndexForFace = (geometry, faceIndex) => {
      const groups = Array.isArray(geometry?.groups) ? geometry.groups : [];
      const firstIndex = Math.max(0, Math.floor(Number(faceIndex) || 0)) * 3;
      for (const group of groups) {
        const start = Math.max(0, Math.floor(Number(group.start) || 0));
        const end = start + Math.max(0, Math.floor(Number(group.count) || 0));
        if (firstIndex >= start && firstIndex < end) {
          return Number.isFinite(Number(group.materialIndex)) ? Number(group.materialIndex) : 0;
        }
      }
      return 0;
    };
    const uvTriangleBarycentric = (point, a, b, c) => {
      const v0x = c.x - a.x;
      const v0y = c.y - a.y;
      const v1x = b.x - a.x;
      const v1y = b.y - a.y;
      const v2x = point.x - a.x;
      const v2y = point.y - a.y;
      const dot00 = v0x * v0x + v0y * v0y;
      const dot01 = v0x * v1x + v0y * v1y;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot11 = v1x * v1x + v1y * v1y;
      const dot12 = v1x * v2x + v1y * v2y;
      const denom = dot00 * dot11 - dot01 * dot01;
      if (Math.abs(denom) <= 1e-12) {
        return null;
      }
      const inv = 1 / denom;
      const u = (dot11 * dot02 - dot01 * dot12) * inv;
      const v = (dot00 * dot12 - dot01 * dot02) * inv;
      return { a: 1 - u - v, b: v, c: u };
    };
    const trianglesForUv = (paintHit, uv, limit = 24) => {
      const object = paintHit?.record?.object || paintHit?.hit?.object || null;
      const geometry = object?.geometry || null;
      const uvAttr = geometry?.attributes?.uv || null;
      const positionAttr = geometry?.attributes?.position || null;
      if (!geometry || !uvAttr || !uv || !Number.isFinite(Number(uv.x)) || !Number.isFinite(Number(uv.y))) {
        return [];
      }
      const indexAttr = geometry.index || null;
      const faceCount = indexAttr
        ? Math.floor(indexAttr.count / 3)
        : Math.floor(uvAttr.count / 3);
      const readIndex = (faceIndex, corner) => indexAttr
        ? indexAttr.getX(faceIndex * 3 + corner)
        : faceIndex * 3 + corner;
      const readUv = (vertexIndex) => ({
        x: Number(uvAttr.getX(vertexIndex)),
        y: Number(uvAttr.getY(vertexIndex))
      });
      const readPosition = (vertexIndex) => positionAttr
        ? {
            x: Number(positionAttr.getX(vertexIndex)),
            y: Number(positionAttr.getY(vertexIndex)),
            z: Number(positionAttr.getZ(vertexIndex))
          }
        : null;
      const output = [];
      for (let faceIndex = 0; faceIndex < faceCount && output.length < limit; faceIndex += 1) {
        const ia = readIndex(faceIndex, 0);
        const ib = readIndex(faceIndex, 1);
        const ic = readIndex(faceIndex, 2);
        const a = readUv(ia);
        const b = readUv(ib);
        const c = readUv(ic);
        const barycentric = uvTriangleBarycentric(uv, a, b, c);
        if (
          !barycentric
          || barycentric.a < -0.0015
          || barycentric.b < -0.0015
          || barycentric.c < -0.0015
        ) {
          continue;
        }
        const pa = readPosition(ia);
        const pb = readPosition(ib);
        const pc = readPosition(ic);
        output.push({
          faceIndex,
          materialIndex: geometryMaterialIndexForFace(geometry, faceIndex),
          vertexIndices: [ia, ib, ic],
          barycentric,
          uv: { a, b, c },
          centroidUv: {
            x: (a.x + b.x + c.x) / 3,
            y: (a.y + b.y + c.y) / 3
          },
          centroidPosition: pa && pb && pc
            ? {
                x: (pa.x + pb.x + pc.x) / 3,
                y: (pa.y + pb.y + pc.y) / 3,
                z: (pa.z + pb.z + pc.z) / 3
              }
            : null
        });
      }
      return output;
    };
    const metricsForFrontViewPoint = (vector, segment = null) => {
      const start = segment?.viewStart || null;
      const end = segment?.viewEnd || null;
      const radius = Math.max(0.0001, Number(segment?.viewRadius) || Number(segment?.worldRadius) || 0);
      let distance = null;
      let depthDelta = null;
      let closest = null;
      if (start && end && Number.isFinite(radius)) {
        const vx = Number(end.x) - Number(start.x);
        const vy = Number(end.y) - Number(start.y);
        const vz = Number(end.z) - Number(start.z);
        const lengthSq = Math.max(0.000001, vx * vx + vy * vy + vz * vz);
        const t = Math.max(0, Math.min(1, (
          (vector.x - Number(start.x)) * vx
          + (vector.y - Number(start.y)) * vy
          + (vector.z - Number(start.z)) * vz
        ) / lengthSq));
        closest = {
          x: Number(start.x) + vx * t,
          y: Number(start.y) + vy * t,
          z: Number(start.z) + vz * t,
          t
        };
        distance = Math.hypot(vector.x - closest.x, vector.y - closest.y, vector.z - closest.z);
        depthDelta = Math.abs(vector.z - closest.z);
      }
      return {
        closest,
        distance,
        depthDelta,
        radius
      };
    };
    const bestFrontViewSegmentMetrics = (vector, segments = []) => {
      let best = null;
      for (const segment of segments || []) {
        const metrics = metricsForFrontViewPoint(vector, segment);
        if (!Number.isFinite(Number(metrics.distance))) {
          continue;
        }
        if (!best || Number(metrics.distance) < Number(best.distance)) {
          best = { ...metrics, segment };
        }
      }
      return best || metricsForFrontViewPoint(vector, null);
    };
    const frontViewMetricsForHit = (paintHit, segments = []) => {
      const object = paintHit?.record?.object || paintHit?.hit?.object || null;
      let point = paintHit?.hit?.point?.clone?.() || null;
      let normal = paintHit?.hit?.face?.normal?.clone?.() || null;
      if (!object || !point || !frontViewMatrix) {
        const geometry = object?.geometry || null;
        const uvAttr = geometry?.attributes?.uv || null;
        const positionAttr = geometry?.attributes?.position || null;
        const indexAttr = geometry?.index || null;
        const uv = paintHit?.hit?.uv || null;
        const faceIndex = Number.isFinite(Number(paintHit?.hit?.faceIndex))
          ? Math.max(0, Math.floor(Number(paintHit.hit.faceIndex)))
          : -1;
        if (!object || !geometry || !uvAttr || !positionAttr || !frontViewMatrix || !uv || faceIndex < 0) {
          return null;
        }
        const readIndex = (corner) => indexAttr
          ? Math.max(0, Math.floor(Number(indexAttr.getX(faceIndex * 3 + corner)) || 0))
          : faceIndex * 3 + corner;
        const ia = readIndex(0);
        const ib = readIndex(1);
        const ic = readIndex(2);
        const uvA = { x: Number(uvAttr.getX(ia)), y: Number(uvAttr.getY(ia)) };
        const uvB = { x: Number(uvAttr.getX(ib)), y: Number(uvAttr.getY(ib)) };
        const uvC = { x: Number(uvAttr.getX(ic)), y: Number(uvAttr.getY(ic)) };
        const bary = uvTriangleBarycentric(uv, uvA, uvB, uvC);
        if (!bary) {
          return null;
        }
        const vertexPosition = (vertexIndex) => {
          const vector = object.position?.clone?.() || null;
          if (!vector?.set) {
            return null;
          }
          if (typeof vector.fromBufferAttribute === "function") {
            vector.fromBufferAttribute(positionAttr, vertexIndex);
          } else {
            vector.set(
              Number(positionAttr.getX(vertexIndex)),
              Number(positionAttr.getY(vertexIndex)),
              Number(positionAttr.getZ(vertexIndex))
            );
          }
          if (typeof object.applyBoneTransform === "function") {
            object.applyBoneTransform(vertexIndex, vector);
          } else if (typeof object.boneTransform === "function") {
            object.boneTransform(vertexIndex, vector);
          }
          return { x: vector.x, y: vector.y, z: vector.z };
        };
        const pa = vertexPosition(ia);
        const pb = vertexPosition(ib);
        const pc = vertexPosition(ic);
        if (!pa || !pb || !pc) {
          return null;
        }
        const ax = Number(pa.x);
        const ay = Number(pa.y);
        const az = Number(pa.z);
        const bx = Number(pb.x);
        const by = Number(pb.y);
        const bz = Number(pb.z);
        const cx = Number(pc.x);
        const cy = Number(pc.y);
        const cz = Number(pc.z);
        point = object.position?.clone?.() || null;
        if (!point?.set) {
          return null;
        }
        point.set(
          ax * bary.a + bx * bary.b + cx * bary.c,
          ay * bary.a + by * bary.b + cy * bary.c,
          az * bary.a + bz * bary.b + cz * bary.c
        );
        object.updateMatrixWorld?.(true);
        object.localToWorld?.(point);
        if (!normal) {
          const abx = bx - ax;
          const aby = by - ay;
          const abz = bz - az;
          const acx = cx - ax;
          const acy = cy - ay;
          const acz = cz - az;
          normal = object.position?.clone?.() || null;
          normal?.set?.(
            aby * acz - abz * acy,
            abz * acx - abx * acz,
            abx * acy - aby * acx
          );
        }
      }
      point.applyMatrix4(frontViewMatrix);
      if (normal?.transformDirection) {
        object.updateMatrixWorld?.(true);
        normal.transformDirection(object.matrixWorld);
        normal.transformDirection(frontViewMatrix);
      }
      const metrics = bestFrontViewSegmentMetrics(point, segments);
      return {
        view: { x: point.x, y: point.y, z: point.z },
        viewNormal: normal ? { x: normal.x, y: normal.y, z: normal.z } : null,
        ...metrics
      };
    };
    const frontViewMetricsForUv = (paintHit, uv, segment = null) => {
      const object = paintHit?.record?.object || paintHit?.hit?.object || null;
      const geometry = object?.geometry || null;
      const uvAttr = geometry?.attributes?.uv || null;
      const positionAttr = geometry?.attributes?.position || null;
      if (!object || !geometry || !uvAttr || !positionAttr || !frontViewMatrix || !uv) {
        return null;
      }
      const triangle = trianglesForUv(paintHit, uv, 1)[0] || null;
      if (!triangle) {
        return null;
      }
      const bary = triangle.barycentric || null;
      const [ia, ib, ic] = triangle.vertexIndices || [];
      if (!bary || !Number.isFinite(ia) || !Number.isFinite(ib) || !Number.isFinite(ic)) {
        return null;
      }
      const vector = object.position?.clone?.() || null;
      if (!vector?.set || !vector?.applyMatrix4) {
        return null;
      }
      const x = Number(positionAttr.getX(ia)) * bary.a
        + Number(positionAttr.getX(ib)) * bary.b
        + Number(positionAttr.getX(ic)) * bary.c;
      const y = Number(positionAttr.getY(ia)) * bary.a
        + Number(positionAttr.getY(ib)) * bary.b
        + Number(positionAttr.getY(ic)) * bary.c;
      const z = Number(positionAttr.getZ(ia)) * bary.a
        + Number(positionAttr.getZ(ib)) * bary.b
        + Number(positionAttr.getZ(ic)) * bary.c;
      vector.set(x, y, z);
      object.updateMatrixWorld?.(true);
      object.localToWorld?.(vector);
      vector.applyMatrix4(frontViewMatrix);
      const metrics = metricsForFrontViewPoint(vector, segment);
      return {
        faceIndex: triangle.faceIndex,
        uv,
        view: { x: vector.x, y: vector.y, z: vector.z },
        ...metrics
      };
    };
    const backChangedHitSamples = [];
    let firstBackLeakPaintHit = null;
    const changedBounds = backPaintChange?.changedBounds || null;
    const changedPixelSamples = Array.isArray(backPaintChange?.changedPixelSamples)
      ? backPaintChange.changedPixelSamples
      : [];
    for (const sample of changedPixelSamples.slice(0, 12)) {
      const clientX = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + Number(sample.x)));
      const clientY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, rect.top + Number(sample.y)));
      const paintHit = hitAt(clientX, clientY);
      if (!firstBackLeakPaintHit && paintHit?.record && paintHit?.hit) {
        firstBackLeakPaintHit = paintHit;
      }
      const hitSegments = frontStats?.tslSurfaceAccumulatedSegmentSamples || [frontStats?.tslSurfaceFirstSegment].filter(Boolean);
      backChangedHitSamples.push({
        clientX,
        clientY,
        changedPixel: sample,
        hit: serializePaintHit(paintHit),
        frontViewMetrics: frontViewMetricsForHit(paintHit, hitSegments)
      });
    }
    if (changedBounds) {
      const samplePoints = [
        [0.5, 0.5],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75]
      ];
      for (const [sampleX, sampleY] of samplePoints) {
        const clientX = Math.max(rect.left + 1, Math.min(rect.right - 1, rect.left + Number(changedBounds.x) + Number(changedBounds.width) * sampleX));
        const clientY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, rect.top + Number(changedBounds.y) + Number(changedBounds.height) * sampleY));
        const paintHit = hitAt(clientX, clientY);
        if (!firstBackLeakPaintHit && paintHit?.record && paintHit?.hit) {
          firstBackLeakPaintHit = paintHit;
        }
        const hitSegments = frontStats?.tslSurfaceAccumulatedSegmentSamples || [frontStats?.tslSurfaceFirstSegment].filter(Boolean);
        backChangedHitSamples.push({
          clientX,
          clientY,
          changedPixel: null,
          hit: serializePaintHit(paintHit),
          frontViewMetrics: frontViewMetricsForHit(paintHit, hitSegments)
        });
      }
    }
    return {
      ready: true,
      loaded: Boolean(editor.model),
      loadedAsset,
      paintRecords: editor.paintRecords?.length || 0,
      layerAdded,
      activeTool: editor.activeTool,
      frontHitFound: true,
      frontHit: { xFraction: frontHit.xFraction, yFraction: frontHit.yFraction },
      frontHitDetail: serializePaintHit(frontHit.hit),
      brush: {
        color: String(editor.texturePaintColor?.value || "").toLowerCase(),
        radiusPixels,
        opacity: Number(editor.textureAirbrushOpacity?.() ?? editor.textureBrushOpacity?.value),
        hardness: Number(editor.textureAirbrushHardness?.() ?? editor.textureBrushHardness?.value),
        scatter: Number(editor.textureAirbrushScatter?.() ?? editor.textureBrushScatter?.value),
        spacing: Number(editor.textureAirbrushSpacingPercent?.() ?? editor.textureBrushSpacing?.value),
        visibleEdgeMode: editor.textureAirbrushVisibleEdgeMode?.() || "",
        neighbor: editor.texturePaintNeighborModeEnabled?.() === true
      },
      frontPaint: {
        midDragPaintObserved,
        coverage: frontCoverage
      },
      backBefore: summarizeViewerFrame(backBefore),
      backAfter: summarizeViewerFrame(backAfter),
      backPaintChange,
      backChangedHitSamples,
      backLeakUvTriangles: (() => {
        const leakSample = backChangedHitSamples.find((sample) => sample?.hit?.uv) || null;
        if (!leakSample) {
          return [];
        }
        return trianglesForUv(firstBackLeakPaintHit, leakSample.hit.uv);
      })(),
      backLeakFrontViewMetrics: (() => {
        const leakSample = backChangedHitSamples.find((sample) => sample?.hit?.uv) || null;
        if (!leakSample) {
          return null;
        }
        return frontViewMetricsForUv(firstBackLeakPaintHit, leakSample.hit.uv, frontStats?.tslSurfaceFirstSegment || null);
      })(),
      frontHitUvTriangles: trianglesForUv(frontHit.hit, frontHit.hit?.hit?.uv || null),
      screenshotClips: [fullClip("front-stroke-back-view-no-leak")],
      lastWebGpuPaintStats: frontStats,
      queueLength: editor.textureAirbrushScreenStrokeQueue?.length || 0,
      pendingBatches: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0
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
    const snapshotLayerCanvases = async () => {
      const flushed = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
        composite: false,
        preserveWebGpuDisplay: true
      });
      if (flushed && typeof flushed.then === "function") {
        await flushed;
      }
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
        beforeSecondStrokeSnapshot = await snapshotLayerCanvases();
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
    const finalLayerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      composite: false,
      preserveWebGpuDisplay: true
    });
    if (finalLayerFlush && typeof finalLayerFlush.then === "function") {
      await finalLayerFlush;
    }
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
    const clipForPath = (name, path, margin = 125) => {
      const viewportWidth = window.innerWidth || 1280;
      const viewportHeight = window.innerHeight || 900;
      if (!Array.isArray(path) || !path.length) {
        return null;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of path) {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
          continue;
        }
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
      }
      const x = Math.max(0, Math.floor(minX - margin));
      const y = Math.max(0, Math.floor(minY - margin));
      const right = Math.min(viewportWidth, Math.ceil(maxX + margin));
      const bottom = Math.min(viewportHeight, Math.ceil(maxY + margin));
      return { name, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
    };
    const secondStrokeClip = clipForPath("neighbor-after-orbit-final-stroke", strokePathPoints(secondStroke));
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
      screenshotClips: secondStrokeClip ? [secondStrokeClip] : [],
      lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
      webGpuPaintStats,
      webGpuPaintStatsCount: Array.isArray(editor.textureAirbrushWebGpuPaintStats)
        ? editor.textureAirbrushWebGpuPaintStats.length
        : 0,
      lastWebGpuCandidateDebug: editor.textureAirbrushLastWebGpuCandidateDebug || null,
      debugDataset: Object.fromEntries(Object.entries(document.documentElement?.dataset || {})
        .filter(([key]) => key.startsWith("textureAirbrushDebug"))),
      debugLogTail: Array.isArray(window.__textureAirbrushDebugLog)
        ? window.__textureAirbrushDebugLog.slice(-24)
        : [],
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
  const lastPaintStats = result?.lastWebGpuPaintStats || null;
  const tslSurfaceProjected = lastPaintStats?.tslSurfaceAirbrush === true
    && lastPaintStats?.screenProjectedCoverageActive === true
    && Number(lastPaintStats?.tslSurfaceAccumulatedPaintSegmentCount || lastPaintStats?.tslSurfacePaintSegmentCount || 0) > 0;
  const anyProjectionChanged = Number(result?.validation?.projectionChanged) > 0
    || Number(macroSecond.projectionChanged) > 0
    || tslSurfaceProjected;
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
  void layerNumber;
  return prepared?.stroke;
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
    const flushLayerCanvases = async () => {
      const flushed = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
        composite: false,
        preserveWebGpuDisplay: true
      });
      if (flushed && typeof flushed.then === "function") {
        await flushed;
      }
      await waitFrame();
    };
    const alphaStats = async () => {
      await flushLayerCanvases();
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
      const referenceTexture = material?.userData?.clonePaintTexture
        || material?.userData?.clonePaintOriginalMap
        || material?.map
        || null;
      const pixel = editor.clonePaintPixelFromUv?.(uv, canvas, referenceTexture, { wrap: true }) || null;
      const centerX = Number.isFinite(Number(pixel?.x))
        ? Math.max(0, Math.min(canvas.width - 1, Math.round(Number(pixel.x))))
        : Math.max(0, Math.min(canvas.width - 1, Math.floor(Number(uv.x || 0) * canvas.width)));
      const centerY = Number.isFinite(Number(pixel?.y))
        ? Math.max(0, Math.min(canvas.height - 1, Math.round(Number(pixel.y))))
        : Math.max(0, Math.min(canvas.height - 1, Math.floor((1 - Number(uv.y || 0)) * canvas.height)));
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
    const beforeAlpha = await alphaStats();
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
    const afterFirstAlpha = await alphaStats();

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
      await flushLayerCanvases();
      const coverageBefore = strokeCoverage(stroke, seed);
      await paintStroke(stroke, "second-" + index, { flush: true });
      secondCandidateDebug.push(editor.textureAirbrushLastWebGpuCandidateDebug || null);
      await flushLayerCanvases();
      const nextAlpha = await alphaStats();
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
    await flushLayerCanvases();
    const materialStack = materialForLayers?.userData?.texturePaintLayerStack || null;
    const activeLayer = (materialStack?.layers || []).find((layer) => layer.id === materialStack?.activeLayerId) || null;
    const clipForStrokes = (name, strokeList, margin = 125) => {
      const viewportWidth = window.innerWidth || 1280;
      const viewportHeight = window.innerHeight || 900;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const stroke of strokeList || []) {
        for (const point of [stroke.start, stroke.mid, stroke.end]) {
          if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
            continue;
          }
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
      }
      const x = Math.max(0, Math.floor(minX - margin));
      const y = Math.max(0, Math.floor(minY - margin));
      const right = Math.min(viewportWidth, Math.ceil(maxX + margin));
      const bottom = Math.min(viewportHeight, Math.ceil(maxY + margin));
      return { name, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
    };
    const firstStrokeClip = clipForStrokes("neighbor-before-orbit-first-stroke", [firstStroke]);
    const secondStrokeClip = clipForStrokes("neighbor-after-orbit-second-strokes", secondCandidates.map(strokeFor));
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
      screenshotClips: [firstStrokeClip, secondStrokeClip].filter(Boolean),
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
      if (Number(color?.g) > 200 && Number(color?.r) < 80 && Number(color?.b) < 180) {
        return g > 48 && g > r + 24 && g > b + 18;
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
      let minChangedX = active.width;
      let minChangedY = active.height;
      let maxChangedX = -1;
      let maxChangedY = -1;
      const changedPixelSamples = [];
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
            minChangedX = Math.min(minChangedX, x);
            minChangedY = Math.min(minChangedY, y);
            maxChangedX = Math.max(maxChangedX, x);
            maxChangedY = Math.max(maxChangedY, y);
            if (changedPixelSamples.length < 24) {
              changedPixelSamples.push({
                x,
                y,
                colorDelta,
                improvement,
                before: [
                  Number(baseline.data[offset]),
                  Number(baseline.data[offset + 1]),
                  Number(baseline.data[offset + 2])
                ],
                after: [
                  Number(active.data[offset]),
                  Number(active.data[offset + 1]),
                  Number(active.data[offset + 2])
                ]
              });
            }
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
        changedBounds: changedPixels > 0
          ? {
              x: minChangedX,
              y: minChangedY,
              width: maxChangedX - minChangedX + 1,
              height: maxChangedY - minChangedY + 1
            }
          : null,
        changedPixelSamples,
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
    const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      material,
      composite: true
    });
    if (layerFlush && typeof layerFlush.then === "function") {
      await layerFlush;
    }
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
      (
        stats?.liveDisplayExternalTexture === true
        && Number(stats?.liveDisplayWorkPixels) > 0
      )
      || stats?.liveDisplayTslRenderTarget === true
    ));
    const lastWebGpuPaintStats = editor.textureAirbrushLastWebGpuPaintStats
      || editor.textureAirbrushWebGpuRuntimeStatus?.()?.lastPaintStats
      || null;
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
        total + Math.max(
          0,
          Math.floor(Number(stats?.liveDisplayWorkPixels) || 0),
          stats?.liveDisplayTslRenderTarget === true ? 1 : 0
        )
      ), 0),
      lastLiveDisplayStats: liveDisplayStats.at(-1) || null,
      lastWebGpuPaintStats,
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
    const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      material,
      composite: true
    });
    if (layerFlush && typeof layerFlush.then === "function") {
      await layerFlush;
    }
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
      webGpuStatus: editor.textureAirbrushWebGpuRuntimeStatus?.() || null,
      lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
      status: document.getElementById("viewer-status")?.textContent || "",
      undoStackLength: editor.undoStack?.length || 0,
      redoStackLength: editor.redoStack?.length || 0,
      activeLayerId: stack?.activeLayerId || "",
      webGpuStatus: editor.textureAirbrushWebGpuRuntimeStatus?.() || null,
      lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
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
    const expectedName = "Paint ${Number(layerNumber) || 1}";
    const beforeAdd = summarize();
    const existingActive = beforeAdd.layers.find((layer) => layer.id === beforeAdd.activeLayerId) || null;
    if (${Number(layerNumber) || 1} === 1 && existingActive?.name === expectedName) {
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
        expectedName,
        reusedExistingPaint1: true,
        beforeAdd,
        afterAdd: beforeAdd,
        activeLayer: existingActive
      };
    }
    const button = document.querySelector("#texture-layer-add");
    if (!button || button.disabled) {
      return { ready: false, error: "missing-add-button", beforeAdd };
    }
    button.click();
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
    const layerFlush = editor.flushTexturePaintLayerGpuTargetsToCanvases?.({
      material,
      composite: true
    });
    if (layerFlush && typeof layerFlush.then === "function") {
      await layerFlush;
    }
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
      webGpuStatus: editor.textureAirbrushWebGpuRuntimeStatus?.() || null,
      lastWebGpuPaintStats: editor.textureAirbrushLastWebGpuPaintStats || null,
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
