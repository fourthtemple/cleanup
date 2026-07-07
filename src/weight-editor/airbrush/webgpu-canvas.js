import { textureAirbrushRunWebGpuPaint } from "./webgpu-dispatch.js";
import {
  textureAirbrushApplyPixelsToEditable,
  textureAirbrushEditableCanvasSize,
  textureAirbrushSourcePixelsFromEditable
} from "./webgpu-editable.js";
import { textureAirbrushReadWebGpuPaintResult } from "./webgpu-readback.js";
import {
  textureAirbrushCopyWebGpuSourceToStrokeTexture,
  textureAirbrushCreateWebGpuPaintResources
} from "./webgpu-resources.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
  textureAirbrushWebGpuReadbackBufferDescriptor,
  textureAirbrushWebGpuUsageConstants
} from "./webgpu-plan.js";

const TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_MAX_REGIONS = 32;
const TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_TILE_BYTES = 128 * 1024;
const TEXTURE_AIRBRUSH_DEFERRED_ACTIVE_LIVE_CANVAS_SYNC_TILE_BYTES = 1024 * 1024;
const TEXTURE_AIRBRUSH_DEFERRED_IDLE_LIVE_CANVAS_SYNC_TILE_BYTES = 4 * 1024 * 1024;
const TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_PRECOPY_MAX_BYTES = 512 * 1024;
const TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_MAX_TILES = 32;
const TEXTURE_AIRBRUSH_DEFERRED_LIVE_CANVAS_SYNC_APPLY_BUDGET_MS = 4;
const TEXTURE_AIRBRUSH_WEBGPU_PAINT_STATS_LIMIT = 512;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_MIN_IMMEDIATE_PIXELS = 128 * 128;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_MAX_IMMEDIATE_PIXELS = 64 * 1024 * 1024;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_IMMEDIATE_FRACTION = 1;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_IDLE_RETRY_MS = 48;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_DIRTY_REGION_MAX_UNION_FILL = 0.98;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_DEFERRED_UNION_MAX_WASTE_RATIO = 2;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_DEFERRED_UNION_MAX_ABSOLUTE_PIXELS = 4_000_000;
const TEXTURE_AIRBRUSH_LIVE_DISPLAY_DEFERRED_UNION_MAX_TEXTURE_FRACTION = 0.25;
const TEXTURE_AIRBRUSH_CANVAS_DEBUG_VERBOSE_LABELS = new Set([
  "canvas-sync-skip",
  "canvas-sync-queued",
  "canvas-sync-start",
  "canvas-sync-cache",
  "canvas-sync-region",
  "canvas-sync-applied"
]);

export {
  textureAirbrushApplyPixelsToEditable,
  textureAirbrushEditableCanvasSize,
  textureAirbrushSourcePixelsFromEditable
} from "./webgpu-editable.js";

function textureAirbrushNow(options = {}) {
  if (typeof options.now === "function") {
    const value = Number(options.now());
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function exposeCanvasWebGpuDebugEntry(entry = null) {
  const root = window?.document?.documentElement || null;
  if (!root?.dataset || !entry) {
    return;
  }
  const detail = entry.detail || {};
  root.dataset.textureAirbrushDebugCount = String(
    Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugCount) || 0)) + 1
  );
  root.dataset.textureAirbrushDebugSource = entry.source || "";
  root.dataset.textureAirbrushDebugLabel = entry.label || "";
  root.dataset.textureAirbrushDebugTime = String(entry.time || 0);
  root.dataset.textureAirbrushDebugSummary = JSON.stringify({
    source: entry.source || "",
    label: entry.label || "",
    liveDisplayWorkPixels: detail.liveDisplayWorkPixels ?? null,
    displayMipmapsGenerated: detail.displayMipmapsGenerated ?? null,
    displayMipmapsDeferred: detail.displayMipmapsDeferred ?? null,
    resultCount: detail.resultCount ?? null,
    regionCount: detail.regionCount ?? null
  });
  if (entry.label === "live-display") {
    const workPixels = Math.max(0, Math.floor(Number(detail.liveDisplayWorkPixels) || 0));
    const mipmapPixels = Math.max(0, Math.floor(Number(detail.liveDisplayMipmapPixels) || 0));
    root.dataset.textureAirbrushDebugLiveDisplayCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveDisplayCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugLiveDisplayPixels = String(detail.liveDisplayWorkPixels ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayPixelsTotal = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveDisplayPixelsTotal) || 0)) + workPixels
    );
    root.dataset.textureAirbrushDebugLiveDisplayBounds = JSON.stringify(detail.liveDisplayBounds || null);
    root.dataset.textureAirbrushDebugLiveDisplayRegions = JSON.stringify(detail.liveDisplayRegions || null);
    root.dataset.textureAirbrushDebugLiveDisplayRegionCount = String(detail.liveDisplayRegionCount ?? "");
    root.dataset.textureAirbrushDebugLiveDisplaySource = String(detail.displaySourceKind || "");
    root.dataset.textureAirbrushDebugLiveDisplaySourceMipLevels = String(detail.sourceMipLevelCount ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayFlipY = String(detail.displayFlipY ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayLinearizeSrgb = String(detail.displayLinearizeSrgb ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayCanCarryTransform = String(
      detail.sourceTextureCanCarryDisplayTransform ?? ""
    );
    root.dataset.textureAirbrushDebugLiveDisplayNeedsCopy = String(detail.needsDisplayCopy ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayMipmapsUsable = String(detail.displayMipmapsUsable ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayFullUpdate = String(detail.displayFullUpdate ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayMipmapsGenerated = String(detail.displayMipmapsGenerated ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayMipmapsDeferred = String(detail.displayMipmapsDeferred ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayMipmapPixels = String(detail.liveDisplayMipmapPixels ?? "");
    root.dataset.textureAirbrushDebugLiveDisplayMipmapPixelsTotal = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveDisplayMipmapPixelsTotal) || 0)) + mipmapPixels
    );
    if (detail.displayFullUpdate === true) {
      root.dataset.textureAirbrushDebugLiveDisplayFullUpdateCount = String(
        Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveDisplayFullUpdateCount) || 0)) + 1
      );
      root.dataset.textureAirbrushDebugLiveDisplayFullUpdateLabel = String(detail.operationLabel || "");
      root.dataset.textureAirbrushDebugLiveDisplayFullUpdateMode = String(detail.mode || "");
    }
    root.dataset.textureAirbrushDebugLiveDisplayMaxPixels = String(Math.max(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveDisplayMaxPixels) || 0)),
      workPixels
    ));
  } else if (entry.label === "canvas-sync-start") {
    root.dataset.textureAirbrushDebugCanvasSyncStartCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugCanvasSyncStartCount) || 0)) + 1
    );
  } else if (entry.label === "canvas-sync-queued") {
    root.dataset.textureAirbrushDebugCanvasSyncQueuedCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugCanvasSyncQueuedCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugCanvasSyncBounds = JSON.stringify(detail.bounds || null);
    root.dataset.textureAirbrushDebugCanvasSyncPriorityBounds = JSON.stringify(detail.priorityBounds || null);
    root.dataset.textureAirbrushDebugCanvasSyncPriorityPointCount = String(detail.priorityPointCount ?? "");
    root.dataset.textureAirbrushDebugCanvasSyncFirstPriorityPoint = detail.firstPriorityPoint
      ? JSON.stringify(detail.firstPriorityPoint)
      : "";
    root.dataset.textureAirbrushDebugCanvasSyncLastPriorityPoint = detail.lastPriorityPoint
      ? JSON.stringify(detail.lastPriorityPoint)
      : "";
    root.dataset.textureAirbrushDebugCanvasSyncRegionCount = String(detail.regionCount ?? "");
    root.dataset.textureAirbrushDebugCanvasSyncReadbackCopyCount = String(detail.readbackCopyCount ?? "");
  } else if (entry.label === "canvas-sync-cache") {
    root.dataset.textureAirbrushDebugCanvasSyncCacheCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugCanvasSyncCacheCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugCanvasSyncBounds = JSON.stringify(detail.bounds || null);
    root.dataset.textureAirbrushDebugCanvasSyncPriorityBounds = JSON.stringify(detail.priorityBounds || null);
    root.dataset.textureAirbrushDebugCanvasSyncPriorityPointCount = String(detail.priorityPointCount ?? "");
    root.dataset.textureAirbrushDebugCanvasSyncFirstPriorityPoint = detail.firstPriorityPoint
      ? JSON.stringify(detail.firstPriorityPoint)
      : "";
    root.dataset.textureAirbrushDebugCanvasSyncLastPriorityPoint = detail.lastPriorityPoint
      ? JSON.stringify(detail.lastPriorityPoint)
      : "";
    root.dataset.textureAirbrushDebugCanvasSyncRegionCount = String(detail.regionCount ?? "");
    root.dataset.textureAirbrushDebugCanvasSyncTiledRegionCount = String(detail.tiledReadbackRegionCount ?? "");
    root.dataset.textureAirbrushDebugCanvasSyncGeneratedRegionCount = String(detail.generatedReadbackRegionCount ?? "");
    root.dataset.textureAirbrushDebugCanvasSyncDeferredRegionCount = String(detail.deferredReadbackRegionCount ?? "");
    root.dataset.textureAirbrushDebugCanvasSyncReadbackWorkCount = String(detail.readbackWorkCount ?? "");
  }
}

function debugCanvasWebGpuAirbrush(label = "", detail = {}) {
  if (
    typeof window === "undefined"
    || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")
  ) {
    return;
  }
  const params = new URLSearchParams(window.location?.search || "");
  if (
    TEXTURE_AIRBRUSH_CANVAS_DEBUG_VERBOSE_LABELS.has(label)
    && !params.has("debugAirbrushVerbose")
  ) {
    return;
  }
  const entry = {
    time: Date.now(),
    source: "webgpu-canvas",
    label,
    detail
  };
  exposeCanvasWebGpuDebugEntry(entry);
  try {
    if (params.has("debugAirbrushTrace")) {
      window.__textureAirbrushDebugLog ||= [];
      window.__textureAirbrushDebugLog.push(entry);
    }
    if (window.__textureAirbrushDebugLog?.length > 1000) {
      window.__textureAirbrushDebugLog.splice(0, window.__textureAirbrushDebugLog.length - 1000);
    }
  } catch {}
  if (params.has("debugAirbrushConsole")) {
    try {
      console.info(`[airbrush-debug] ${label}`, JSON.stringify(detail));
    } catch {
      console.info(`[airbrush-debug] ${label}`);
    }
  }
}

function textureAirbrushDebugSnapshotRequested() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location?.search || "");
  return params.has("debugAirbrushSnapshot");
}

function textureAirbrushDebugSnapshotFullSyncRequested() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location?.search || "");
  return params.has("debugAirbrushSnapshotFullSync");
}

function textureAirbrushDebugSnapshotBestRequested() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location?.search || "");
  return params.has("debugAirbrushSnapshotBest");
}

function textureAirbrushDebugSnapshotGlobalStatsRequested() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location?.search || "");
  return params.has("debugAirbrushSnapshotGlobalStats");
}

function textureAirbrushDebugSnapshotSize() {
  if (typeof window === "undefined") {
    return 512;
  }
  const params = new URLSearchParams(window.location?.search || "");
  const explicit = Math.floor(Number(params.get("debugAirbrushSnapshotSize")));
  return Number.isFinite(explicit) && explicit > 0
    ? Math.max(64, Math.min(1024, explicit))
    : 512;
}

function textureAirbrushDebugPixelStats(data = null, width = 0, height = 0) {
  if (!data || !width || !height) {
    return null;
  }
  let greenDominant = 0;
  let brightGreen = 0;
  let nonBlack = 0;
  let maxG = 0;
  let maxGreenExcess = -999;
  let greenBounds = null;
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const offset = (py * width + px) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      if (a > 0 && (r > 8 || g > 8 || b > 8)) {
        nonBlack += 1;
      }
      maxG = Math.max(maxG, g);
      maxGreenExcess = Math.max(maxGreenExcess, g - Math.max(r, b));
      const isGreen = a > 0 && g > 80 && g > r + 35 && g > b + 35;
      if (isGreen) {
        greenDominant += 1;
        greenBounds = greenBounds ? {
          x: Math.min(greenBounds.x, px),
          y: Math.min(greenBounds.y, py),
          right: Math.max(greenBounds.right, px + 1),
          bottom: Math.max(greenBounds.bottom, py + 1)
        } : {
          x: px,
          y: py,
          right: px + 1,
          bottom: py + 1
        };
      }
      if (a > 0 && g > 150 && g > r + 60 && g > b + 60) {
        brightGreen += 1;
      }
    }
  }
  return {
    nonBlack,
    greenDominant,
    brightGreen,
    maxG,
    maxGreenExcess,
    greenBounds: greenBounds ? {
      x: greenBounds.x,
      y: greenBounds.y,
      width: greenBounds.right - greenBounds.x,
      height: greenBounds.bottom - greenBounds.y
    } : null
  };
}

function textureAirbrushExposeDebugCanvasSnapshot(editable = null, bounds = null, detail = {}) {
  if (!textureAirbrushDebugSnapshotRequested()) {
    return null;
  }
  const documentRef = window?.document || null;
  const sourceCanvas = editable?.canvas || null;
  if (!documentRef || !sourceCanvas?.width || !sourceCanvas?.height || typeof sourceCanvas.getContext !== "function") {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(sourceCanvas.width) || 1));
  const height = Math.max(1, Math.floor(Number(sourceCanvas.height) || 1));
  const crop = textureAirbrushUnionDirtyBounds(null, bounds, width, height)
    || textureAirbrushFullDirtyBounds(width, height);
  const maxSize = textureAirbrushDebugSnapshotSize();
  const scale = Math.max(
    1 / Math.max(crop.width, crop.height, 1),
    Math.min(maxSize / Math.max(1, crop.width), maxSize / Math.max(1, crop.height))
  );
  const outputWidth = Math.max(1, Math.min(maxSize, Math.round(crop.width * scale)));
  const outputHeight = Math.max(1, Math.min(maxSize, Math.round(crop.height * scale)));
  let canvas = documentRef.getElementById("texture-airbrush-debug-snapshot-canvas");
  if (!canvas) {
    canvas = documentRef.createElement("canvas");
    canvas.id = "texture-airbrush-debug-snapshot-canvas";
    canvas.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:260px;max-height:260px;border:1px solid #f6c44f;background:#000;display:none;";
    canvas.setAttribute("aria-hidden", "true");
    documentRef.body?.appendChild?.(canvas);
  }
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  context.clearRect(0, 0, outputWidth, outputHeight);
  context.imageSmoothingEnabled = scale < 1;
  context.drawImage(
    sourceCanvas,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    outputWidth,
    outputHeight
  );
  let pixelStats = null;
  try {
    const data = context.getImageData(0, 0, outputWidth, outputHeight).data;
    let greenDominant = 0;
    let brightGreen = 0;
    let nonBlack = 0;
    let maxG = 0;
    let maxGreenExcess = -999;
    let greenBounds = null;
    for (let py = 0; py < outputHeight; py += 1) {
      for (let px = 0; px < outputWidth; px += 1) {
        const offset = (py * outputWidth + px) * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const a = data[offset + 3];
        if (a > 0 && (r > 8 || g > 8 || b > 8)) {
          nonBlack += 1;
        }
        maxG = Math.max(maxG, g);
        maxGreenExcess = Math.max(maxGreenExcess, g - Math.max(r, b));
        const isGreen = a > 0 && g > 80 && g > r + 35 && g > b + 35;
        if (isGreen) {
          greenDominant += 1;
          greenBounds = greenBounds ? {
            x: Math.min(greenBounds.x, px),
            y: Math.min(greenBounds.y, py),
            right: Math.max(greenBounds.right, px + 1),
            bottom: Math.max(greenBounds.bottom, py + 1)
          } : {
            x: px,
            y: py,
            right: px + 1,
            bottom: py + 1
          };
        }
        if (a > 0 && g > 150 && g > r + 60 && g > b + 60) {
          brightGreen += 1;
        }
      }
    }
    pixelStats = {
      nonBlack,
      greenDominant,
      brightGreen,
      maxG,
      maxGreenExcess,
      greenBounds: greenBounds ? {
        x: greenBounds.x,
        y: greenBounds.y,
        width: greenBounds.right - greenBounds.x,
        height: greenBounds.bottom - greenBounds.y
      } : null
    };
  } catch {
    pixelStats = null;
  }
  let globalPixelStats = null;
  if (textureAirbrushDebugSnapshotGlobalStatsRequested()) {
    try {
      const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
      const sourceImage = sourceContext?.getImageData?.(0, 0, width, height);
      globalPixelStats = textureAirbrushDebugPixelStats(sourceImage?.data, width, height);
    } catch {
      globalPixelStats = null;
    }
  }
  let dataUrl = "";
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch {
    dataUrl = "";
  }
  let image = documentRef.getElementById("texture-airbrush-debug-snapshot");
  if (!image) {
    image = documentRef.createElement("img");
    image.id = "texture-airbrush-debug-snapshot";
    image.alt = "Texture airbrush debug snapshot";
    image.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:260px;max-height:260px;border:1px solid #f6c44f;background:#000;display:none;";
    documentRef.body?.appendChild?.(image);
  }
  if (dataUrl) {
    image.src = dataUrl;
  }
  const root = documentRef.documentElement || null;
  const snapshotScore = Math.max(
    0,
    Number(pixelStats?.greenDominant) || 0
  ) * 1_000_000
    + Math.max(0, Number(pixelStats?.brightGreen) || 0) * 1_000
    + Math.max(0, Number(pixelStats?.maxGreenExcess) || 0);
  if (root?.dataset) {
    root.dataset.textureAirbrushDebugSnapshotCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugSnapshotCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugSnapshotBounds = JSON.stringify(crop);
    root.dataset.textureAirbrushDebugSnapshotSize = JSON.stringify({
      width: outputWidth,
      height: outputHeight
    });
    root.dataset.textureAirbrushDebugSnapshotDetail = JSON.stringify({
      applied: detail.applied === true,
      deferredCanvasSync: detail.deferredCanvasSync === true,
      materialName: detail.materialName || "",
      byteLength: detail.byteLength ?? null
    });
    root.dataset.textureAirbrushDebugSnapshotPixelStats = JSON.stringify(pixelStats);
    root.dataset.textureAirbrushDebugSnapshotGlobalPixelStats = JSON.stringify(globalPixelStats);
    root.dataset.textureAirbrushDebugSnapshotScore = String(snapshotScore);
    if (textureAirbrushDebugSnapshotBestRequested()) {
      const previousBestScore = Number(root.dataset.textureAirbrushDebugSnapshotBestScore);
      const shouldReplaceBest = !Number.isFinite(previousBestScore) || snapshotScore >= previousBestScore;
      if (shouldReplaceBest) {
        let bestImage = documentRef.getElementById("texture-airbrush-debug-snapshot-best");
        if (!bestImage) {
          bestImage = documentRef.createElement("img");
          bestImage.id = "texture-airbrush-debug-snapshot-best";
          bestImage.alt = "Best texture airbrush debug snapshot";
          bestImage.style.cssText = "position:fixed;right:8px;bottom:280px;z-index:2147483647;max-width:260px;max-height:260px;border:1px solid #3ee66b;background:#000;display:none;";
          documentRef.body?.appendChild?.(bestImage);
        }
        if (dataUrl) {
          bestImage.src = dataUrl;
        }
        root.dataset.textureAirbrushDebugSnapshotBestScore = String(snapshotScore);
        root.dataset.textureAirbrushDebugSnapshotBestBounds = JSON.stringify(crop);
        root.dataset.textureAirbrushDebugSnapshotBestSize = JSON.stringify({
          width: outputWidth,
          height: outputHeight
        });
        root.dataset.textureAirbrushDebugSnapshotBestPixelStats = JSON.stringify(pixelStats);
      }
    }
  }
  return {
    bounds: crop,
    width: outputWidth,
    height: outputHeight,
    byteLength: dataUrl.length
  };
}

function textureAirbrushYieldDeferredCanvasSync(options = {}) {
  if (typeof options.canvasSyncYield === "function") {
    return Promise.resolve(options.canvasSyncYield());
  }
  const host = typeof window !== "undefined" ? window : globalThis;
  if (typeof host?.scheduler?.yield === "function") {
    return host.scheduler.yield();
  }
  if (typeof host?.requestAnimationFrame === "function") {
    return new Promise((resolve) => host.requestAnimationFrame(() => resolve()));
  }
  if (typeof host?.setTimeout === "function") {
    return new Promise((resolve) => host.setTimeout(resolve, 0));
  }
  return Promise.resolve();
}

function textureAirbrushLiveDisplayMipmapIdle(editor = null) {
  if (!editor) {
    return true;
  }
  return !(
    editor.painting === true
    || editor.textureAirbrushFlushingScreenStroke === true
    || editor.textureAirbrushWebGpuFlushInFlight
    || (editor.textureAirbrushQueuedWebGpuStrokes || []).length
    || (editor.textureAirbrushScreenStrokeQueue || []).length
    || (editor.textureAirbrushPendingScreenStrokeBatches || []).length
    || (editor.textureAirbrushPendingWebGpuPaints instanceof Set && editor.textureAirbrushPendingWebGpuPaints.size > 0)
  );
}

function textureAirbrushDirtyBoundsFromLayout(layout = null) {
  if (!layout) {
    return null;
  }
  return {
    x: Math.max(0, Math.floor(Number(layout.x) || 0)),
    y: Math.max(0, Math.floor(Number(layout.y) || 0)),
    width: Math.max(0, Math.floor(Number(layout.width) || 0)),
    height: Math.max(0, Math.floor(Number(layout.height) || 0))
  };
}

function textureAirbrushUnionDirtyBounds(first = null, second = null, width = 1, height = 1) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const safeHeight = Math.max(1, Math.floor(Number(height) || 1));
  const normalize = (bounds = null) => {
    if (!bounds) {
      return null;
    }
    const x = Math.max(0, Math.min(safeWidth - 1, Math.floor(Number(bounds.x) || 0)));
    const y = Math.max(0, Math.min(safeHeight - 1, Math.floor(Number(bounds.y) || 0)));
    const right = Math.max(x + 1, Math.min(safeWidth, Math.ceil(x + Math.max(1, Number(bounds.width) || 1))));
    const bottom = Math.max(y + 1, Math.min(safeHeight, Math.ceil(y + Math.max(1, Number(bounds.height) || 1))));
    return {
      x,
      y,
      width: right - x,
      height: bottom - y
    };
  };
  const a = normalize(first);
  const b = normalize(second);
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

function textureAirbrushMergeDeferredSyncRegions(regions = [], bounds = null, width = 1, height = 1) {
  const next = textureAirbrushUnionDirtyBounds(null, bounds, width, height);
  if (!next) {
    return Array.isArray(regions) ? regions : [];
  }
  const merged = Array.isArray(regions) ? [...regions] : [];
  for (let index = 0; index < merged.length; index += 1) {
    const current = merged[index];
    if (
      current
      && current.x < next.x + next.width
      && current.x + current.width > next.x
      && current.y < next.y + next.height
      && current.y + current.height > next.y
    ) {
      merged[index] = textureAirbrushUnionDirtyBounds(current, next, width, height);
      return merged;
    }
  }
  merged.push(next);
  while (merged.length > TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_MAX_REGIONS) {
    let bestLeftIndex = 0;
    let bestRightIndex = 1;
    let bestCost = Infinity;
    for (let leftIndex = 0; leftIndex < merged.length - 1; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
        const current = merged[leftIndex];
        const following = merged[rightIndex];
        const union = textureAirbrushUnionDirtyBounds(current, following, width, height);
        const currentArea = Math.max(1, current.width) * Math.max(1, current.height);
        const followingArea = Math.max(1, following.width) * Math.max(1, following.height);
        const unionArea = Math.max(1, union.width) * Math.max(1, union.height);
        const cost = unionArea - currentArea - followingArea;
        if (cost < bestCost) {
          bestCost = cost;
          bestLeftIndex = leftIndex;
          bestRightIndex = rightIndex;
        }
      }
    }
    const union = textureAirbrushUnionDirtyBounds(merged[bestLeftIndex], merged[bestRightIndex], width, height);
    merged.splice(bestRightIndex, 1);
    merged.splice(bestLeftIndex, 1, union);
  }
  return merged;
}

function textureAirbrushNormalizeDirtyRegions(regions = [], width = 1, height = 1) {
  return (Array.isArray(regions) ? regions : [])
    .map((region) => textureAirbrushUnionDirtyBounds(null, region, width, height))
    .filter(Boolean);
}

function textureAirbrushUnionDirtyRegions(regions = [], width = 1, height = 1) {
  return textureAirbrushNormalizeDirtyRegions(regions, width, height)
    .reduce((union, region) => textureAirbrushUnionDirtyBounds(union, region, width, height), null);
}

function textureAirbrushAppendDirtyRegion(regions = [], bounds = null, width = 1, height = 1) {
  return textureAirbrushMergeDeferredSyncRegions(regions, bounds, width, height);
}

function textureAirbrushDirtyRegionsArea(regions = []) {
  return (Array.isArray(regions) ? regions : []).reduce(
    (total, region) => total + textureAirbrushBoundsArea(region),
    0
  );
}

function textureAirbrushDisplayRegionsFromSourceRegions(regions = [], width = 1, height = 1, flipY = false) {
  return textureAirbrushNormalizeDirtyRegions(regions, width, height)
    .map((region) => textureAirbrushDisplayBoundsFromSourceBounds(region, width, height, flipY));
}

function textureAirbrushUseDirtyRegions(regions = [], bounds = null, width = 1, height = 1) {
  const normalized = textureAirbrushNormalizeDirtyRegions(regions, width, height);
  if (normalized.length <= 1) {
    return false;
  }
  const union = textureAirbrushUnionDirtyBounds(null, bounds, width, height)
    || textureAirbrushUnionDirtyRegions(normalized, width, height);
  const unionArea = textureAirbrushBoundsArea(union);
  const regionArea = textureAirbrushDirtyRegionsArea(normalized);
  return regionArea > 0 && regionArea < unionArea * TEXTURE_AIRBRUSH_LIVE_DISPLAY_DIRTY_REGION_MAX_UNION_FILL;
}

function textureAirbrushBoundsArea(bounds = null) {
  return Math.max(0, Math.floor(Number(bounds?.width) || 0))
    * Math.max(0, Math.floor(Number(bounds?.height) || 0));
}

function textureAirbrushDeferredLiveDisplayUnionTooLarge(existing = null, next = null, width = 1, height = 1, options = {}) {
  const previousBounds = textureAirbrushUnionDirtyBounds(null, existing, width, height);
  const nextBounds = textureAirbrushUnionDirtyBounds(null, next, width, height);
  if (!previousBounds || !nextBounds) {
    return false;
  }
  const union = textureAirbrushUnionDirtyBounds(previousBounds, nextBounds, width, height);
  const previousArea = textureAirbrushBoundsArea(previousBounds);
  const nextArea = textureAirbrushBoundsArea(nextBounds);
  const unionArea = textureAirbrushBoundsArea(union);
  const separateArea = Math.max(1, previousArea + nextArea);
  const textureArea = Math.max(1, Math.floor(Number(width) || 1)) * Math.max(1, Math.floor(Number(height) || 1));
  const wasteRatio = Number(options.liveDisplayDeferredUnionMaxWasteRatio);
  const maxWasteRatio = Number.isFinite(wasteRatio) && wasteRatio >= 1
    ? wasteRatio
    : TEXTURE_AIRBRUSH_LIVE_DISPLAY_DEFERRED_UNION_MAX_WASTE_RATIO;
  const absolutePixels = Number(options.liveDisplayDeferredUnionMaxPixels);
  const maxAbsolutePixels = Number.isFinite(absolutePixels) && absolutePixels > 0
    ? absolutePixels
    : Math.min(
        TEXTURE_AIRBRUSH_LIVE_DISPLAY_DEFERRED_UNION_MAX_ABSOLUTE_PIXELS,
        textureArea * TEXTURE_AIRBRUSH_LIVE_DISPLAY_DEFERRED_UNION_MAX_TEXTURE_FRACTION
      );
  return unionArea > Math.max(separateArea * maxWasteRatio, maxAbsolutePixels);
}

function textureAirbrushBoundsContains(outer = null, inner = null) {
  if (!outer || !inner) {
    return false;
  }
  const outerX = Number(outer.x) || 0;
  const outerY = Number(outer.y) || 0;
  const innerX = Number(inner.x) || 0;
  const innerY = Number(inner.y) || 0;
  return innerX >= outerX
    && innerY >= outerY
    && innerX + Math.max(0, Number(inner.width) || 0) <= outerX + Math.max(0, Number(outer.width) || 0)
    && innerY + Math.max(0, Number(inner.height) || 0) <= outerY + Math.max(0, Number(outer.height) || 0);
}

function textureAirbrushBoundsOverlap(first = null, second = null) {
  if (!first || !second) {
    return false;
  }
  const firstX = Number(first.x) || 0;
  const firstY = Number(first.y) || 0;
  const secondX = Number(second.x) || 0;
  const secondY = Number(second.y) || 0;
  const firstWidth = Math.max(0, Number(first.width) || 0);
  const firstHeight = Math.max(0, Number(first.height) || 0);
  const secondWidth = Math.max(0, Number(second.width) || 0);
  const secondHeight = Math.max(0, Number(second.height) || 0);
  return firstX < secondX + secondWidth
    && firstX + firstWidth > secondX
    && firstY < secondY + secondHeight
    && firstY + firstHeight > secondY;
}

function textureAirbrushBoundsCenter(bounds = null) {
  if (!bounds) {
    return null;
  }
  return {
    x: (Number(bounds.x) || 0) + Math.max(0, Number(bounds.width) || 0) * 0.5,
    y: (Number(bounds.y) || 0) + Math.max(0, Number(bounds.height) || 0) * 0.5
  };
}

function textureAirbrushBoundsCenterDistanceSq(first = null, second = null) {
  const firstCenter = textureAirbrushBoundsCenter(first);
  const secondCenter = textureAirbrushBoundsCenter(second);
  if (!firstCenter || !secondCenter) {
    return Infinity;
  }
  const dx = firstCenter.x - secondCenter.x;
  const dy = firstCenter.y - secondCenter.y;
  return dx * dx + dy * dy;
}

function textureAirbrushNormalizePriorityPoints(points = [], width = 1, height = 1) {
  const maxX = Math.max(0, Math.floor(Number(width) || 1) - 1);
  const maxY = Math.max(0, Math.floor(Number(height) || 1) - 1);
  return (Array.isArray(points) ? points : [])
    .map((point) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      return {
        x: Math.max(0, Math.min(maxX, x)),
        y: Math.max(0, Math.min(maxY, y))
      };
    })
    .filter(Boolean);
}

function textureAirbrushPointDistanceToBoundsSq(point = null, bounds = null) {
  if (!point || !bounds) {
    return Infinity;
  }
  const x = Number(bounds.x) || 0;
  const y = Number(bounds.y) || 0;
  const right = x + Math.max(0, Number(bounds.width) || 0);
  const bottom = y + Math.max(0, Number(bounds.height) || 0);
  const dx = point.x < x ? x - point.x : point.x > right ? point.x - right : 0;
  const dy = point.y < y ? y - point.y : point.y > bottom ? point.y - bottom : 0;
  return dx * dx + dy * dy;
}

function textureAirbrushPointBounds(point = null, padding = 0, width = 1, height = 1) {
  if (!point) {
    return null;
  }
  const pad = Math.max(0, Math.floor(Number(padding) || 0));
  return textureAirbrushUnionDirtyBounds(null, {
    x: point.x - pad,
    y: point.y - pad,
    width: pad * 2 + 1,
    height: pad * 2 + 1
  }, width, height);
}

function textureAirbrushPriorityPointSnapshotBounds(
  priorityPoints = [],
  appliedBounds = null,
  width = 1,
  height = 1,
  padding = 192
) {
  const points = textureAirbrushNormalizePriorityPoints(priorityPoints, width, height);
  if (!points.length) {
    return null;
  }
  const applied = textureAirbrushUnionDirtyBounds(null, appliedBounds, width, height);
  const scored = points
    .map((point, index) => ({
      point,
      index,
      distanceSq: applied ? textureAirbrushPointDistanceToBoundsSq(point, applied) : index
    }))
    .sort((left, right) => left.distanceSq - right.distanceSq || left.index - right.index);
  const bestDistance = scored[0]?.distanceSq ?? Infinity;
  const closePoints = scored
    .filter((entry) => entry.distanceSq <= bestDistance + 0.000001)
    .slice(0, 8)
    .map((entry) => entry.point);
  return closePoints.reduce((bounds, point) => textureAirbrushUnionDirtyBounds(
    bounds,
    textureAirbrushPointBounds(point, padding, width, height),
    width,
    height
  ), null);
}

function textureAirbrushPriorityPointDistanceSq(region = null, priorityPoints = []) {
  if (!region || !priorityPoints.length) {
    return Infinity;
  }
  return priorityPoints.reduce((best, point) => Math.min(
    best,
    textureAirbrushPointDistanceToBoundsSq(point, region)
  ), Infinity);
}

function textureAirbrushPrioritizeReadbackRegions(
  regions = [],
  priorityBounds = null,
  width = 1,
  height = 1,
  priorityPoints = []
) {
  const normalized = textureAirbrushNormalizeDirtyRegions(regions, width, height);
  const priority = textureAirbrushUnionDirtyBounds(null, priorityBounds, width, height);
  const points = textureAirbrushNormalizePriorityPoints(priorityPoints, width, height);
  if (!normalized.length || (!priority && !points.length)) {
    return normalized;
  }
  return normalized
    .map((region, index) => ({
      region,
      index,
      pointDistanceSq: textureAirbrushPriorityPointDistanceSq(region, points),
      distanceSq: textureAirbrushBoundsCenterDistanceSq(region, priority),
      overlaps: priority ? textureAirbrushBoundsOverlap(region, priority) : false
    }))
    .sort((left, right) => (
      left.pointDistanceSq - right.pointDistanceSq
      || (left.overlaps === right.overlaps ? 0 : left.overlaps ? -1 : 1)
      || left.distanceSq - right.distanceSq
      || left.index - right.index
    ))
    .map((entry) => entry.region);
}

function textureAirbrushBoundsCoveredByRegions(bounds = null, regions = []) {
  if (!bounds) {
    return false;
  }
  const target = textureAirbrushUnionDirtyBounds(null, bounds, Infinity, Infinity);
  if (!target) {
    return false;
  }
  const covers = (Array.isArray(regions) ? regions : [])
    .map((region) => textureAirbrushUnionDirtyBounds(null, region, Infinity, Infinity))
    .filter(Boolean)
    .filter((region) => (
      region.x < target.x + target.width
      && region.x + region.width > target.x
      && region.y < target.y + target.height
      && region.y + region.height > target.y
    ));
  if (!covers.length) {
    return false;
  }
  if (covers.some((region) => textureAirbrushBoundsContains(region, target))) {
    return true;
  }
  const xEdges = new Set([target.x, target.x + target.width]);
  const yEdges = new Set([target.y, target.y + target.height]);
  for (const region of covers) {
    xEdges.add(Math.max(target.x, region.x));
    xEdges.add(Math.min(target.x + target.width, region.x + region.width));
    yEdges.add(Math.max(target.y, region.y));
    yEdges.add(Math.min(target.y + target.height, region.y + region.height));
  }
  const xs = [...xEdges].sort((left, right) => left - right);
  const ys = [...yEdges].sort((left, right) => left - right);
  for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
    for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
      const cell = {
        x: xs[xIndex],
        y: ys[yIndex],
        width: xs[xIndex + 1] - xs[xIndex],
        height: ys[yIndex + 1] - ys[yIndex]
      };
      if (cell.width <= 0 || cell.height <= 0) {
        continue;
      }
      if (!covers.some((region) => textureAirbrushBoundsContains(region, cell))) {
        return false;
      }
    }
  }
  return true;
}

function textureAirbrushDeferredCanvasSyncTileBytes(options = {}) {
  if (options.deferredCanvasSyncTileBytes === false) {
    return Infinity;
  }
  const explicit = Number(options.deferredCanvasSyncTileBytes);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  if (options.liveDisplayExternalTexture === true) {
    return options.deferCanvasSyncUntilIdle === true
      ? TEXTURE_AIRBRUSH_DEFERRED_IDLE_LIVE_CANVAS_SYNC_TILE_BYTES
      : TEXTURE_AIRBRUSH_DEFERRED_ACTIVE_LIVE_CANVAS_SYNC_TILE_BYTES;
  }
  return TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_TILE_BYTES;
}

function textureAirbrushDeferredCanvasSyncMaxTiles(options = {}) {
  if (options.deferredCanvasSyncMaxTiles === false) {
    return Infinity;
  }
  const explicit = Math.floor(Number(options.deferredCanvasSyncMaxTiles));
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_MAX_TILES;
}

function textureAirbrushDeferredCanvasSyncPrecopyMaxBytes(options = {}) {
  if (options.deferredCanvasSyncPrecopyMaxBytes === false) {
    return Infinity;
  }
  const explicit = Number(options.deferredCanvasSyncPrecopyMaxBytes);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return TEXTURE_AIRBRUSH_DEFERRED_CANVAS_SYNC_PRECOPY_MAX_BYTES;
}

function textureAirbrushReadbackDescriptorSize(width = 1, height = 1, bounds = null) {
  const normalized = textureAirbrushUnionDirtyBounds(null, bounds, width, height);
  if (!normalized) {
    return 0;
  }
  return textureAirbrushWebGpuReadbackBufferDescriptor(width, height, globalThis, normalized)?.size || 0;
}

function textureAirbrushTileDeferredSyncRegion(bounds = null, width = 1, height = 1, options = {}) {
  const normalized = textureAirbrushUnionDirtyBounds(null, bounds, width, height);
  const maxBytes = textureAirbrushDeferredCanvasSyncTileBytes(options);
  if (!normalized || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return normalized ? [normalized] : [];
  }
  if (textureAirbrushReadbackDescriptorSize(width, height, normalized) <= maxBytes) {
    return [normalized];
  }
  const tiles = [];
  const minRows = 1;
  let y = normalized.y;
  while (y < normalized.y + normalized.height) {
    let tileHeight = Math.min(normalized.y + normalized.height - y, normalized.height);
    while (
      tileHeight > minRows
      && textureAirbrushReadbackDescriptorSize(width, height, {
        x: normalized.x,
        y,
        width: normalized.width,
        height: tileHeight
      }) > maxBytes
    ) {
      tileHeight = Math.max(minRows, Math.floor(tileHeight / 2));
    }
    if (tileHeight <= 0) {
      break;
    }
    tiles.push({
      x: normalized.x,
      y,
      width: normalized.width,
      height: tileHeight
    });
    y += tileHeight;
  }
  return tiles.length ? tiles : [normalized];
}

function textureAirbrushTileDeferredSyncRegions(regions = [], width = 1, height = 1, options = {}) {
  const maxTiles = textureAirbrushDeferredCanvasSyncMaxTiles(options);
  const tiled = [];
  for (const region of regions) {
    tiled.push(...textureAirbrushTileDeferredSyncRegion(region, width, height, options));
    if (Number.isFinite(maxTiles) && tiled.length > maxTiles && options.returnAllDeferredCanvasSyncTiles !== true) {
      break;
    }
  }
  return tiled.length ? tiled : regions;
}

function textureAirbrushTakeReadbackRegionsWithinBudget(regions = [], width = 1, height = 1, byteBudget = Infinity) {
  if (!Array.isArray(regions) || !regions.length || !Number.isFinite(byteBudget)) {
    return Array.isArray(regions) ? regions : [];
  }
  const selected = [];
  let totalBytes = 0;
  for (const region of regions) {
    const bytes = textureAirbrushReadbackDescriptorSize(width, height, region);
    if (selected.length && totalBytes + bytes > byteBudget) {
      break;
    }
    selected.push(region);
    totalBytes += bytes;
  }
  return selected.length ? selected : regions.slice(0, 1);
}

function textureAirbrushPixelsFromImageData(imageData = null, width = 0, height = 0) {
  if (
    imageData?.width !== width
    || imageData?.height !== height
    || !imageData?.data?.byteLength
    || imageData.data.byteLength !== width * height * 4
  ) {
    return null;
  }
  return new Uint8Array(
    imageData.data.buffer,
    imageData.data.byteOffset || 0,
    imageData.data.byteLength
  );
}

function textureAirbrushSourcePixelsFromCanvas(canvas = null, context = null) {
  const width = Math.max(0, Math.floor(Number(canvas?.width) || 0));
  const height = Math.max(0, Math.floor(Number(canvas?.height) || 0));
  if (!canvas || !context || !width || !height || typeof context.getImageData !== "function") {
    return null;
  }
  const imageData = context.getImageData(0, 0, width, height);
  if (!textureAirbrushImageDataMatchesSize(imageData, width, height)) {
    return null;
  }
  return {
    width,
    height,
    imageData,
    sourcePixels: new Uint8Array(
      imageData.data.buffer,
      imageData.data.byteOffset || 0,
      imageData.data.byteLength
    )
  };
}

function textureAirbrushImageDataMatchesSize(imageData = null, width = 0, height = 0) {
  return imageData?.width === width
    && imageData?.height === height
    && imageData.data?.byteLength === width * height * 4;
}

function textureAirbrushMarkEditableLayerWebGpuPainted(editor = null, editable = null) {
  if (editable?.layerMode !== true || !editable.layer) {
    return false;
  }
  editable.layer.isEmpty = false;
  editable.layer.texturePaintHasPaint = true;
  editable.layer.texturePaintGpuPainted = true;
  if (editable.layer.gpuTarget) {
    editable.layer.gpuTarget.emptyTransparent = false;
    editable.layer.gpuTarget.texturePaintLayerHasPaint = true;
    editor?.markTexturePaintGpuTargetMutated?.(editable.layer.gpuTarget);
  }
  return true;
}

function textureAirbrushWebGpuLayerCompositeSource(editable = null) {
  if (editable?.layerMode !== true) {
    return null;
  }
  const stack = editable.layerStack || null;
  const baseCanvas = stack?.baseCanvas || editable.compositeCanvas || null;
  const baseContext = stack?.baseContext || editable.compositeContext || null;
  const width = Math.max(0, Math.floor(Number(baseCanvas?.width) || 0));
  const height = Math.max(0, Math.floor(Number(baseCanvas?.height) || 0));
  const layerOpacity = Number(editable.layer?.opacity);
  if (!baseCanvas || !baseContext || !width || !height) {
    return null;
  }
  return {
    canvas: baseCanvas,
    context: baseContext,
    width,
    height,
    key: [
      stack?.baseCanvas ? "stack-base" : "composite",
      stack?.width || width,
      stack?.height || height,
      editable.layer?.id || "",
      Number.isFinite(layerOpacity) ? layerOpacity.toFixed(4) : "1.0000"
    ].join(":"),
    opacity: Math.max(0, Math.min(1, Number.isFinite(layerOpacity) ? layerOpacity : 1))
  };
}

function textureAirbrushStableLiveDisplayReferenceTexture(texture = null) {
  if (!texture) {
    return null;
  }
  const userData = texture.userData || {};
  if (
    userData.texturePaintTslSurfaceAirbrushDisplayTexture === true
    || userData.texturePaintTslSurfaceAirbrushTargetTexture === true
    || userData.textureAirbrushExternalWebGpuDisplay === true
  ) {
    return userData.textureAirbrushWebGpuCanvasMap
      || userData.texturePaintTslSurfaceDisplayOriginalMap
      || userData.clonePaintOriginalMap
      || null;
  }
  return texture;
}

function textureAirbrushLiveDisplayReferenceTexture(material = null, editable = null) {
  const userData = material?.userData || {};
  const canvasMap = textureAirbrushStableLiveDisplayReferenceTexture(userData.textureAirbrushWebGpuCanvasMap || null);
  if (canvasMap) {
    return canvasMap;
  }
  const materialMap = material?.map || null;
  const materialMapIsExternal = materialMap?.userData?.textureAirbrushExternalWebGpuDisplay === true;
  const materialMapStable = textureAirbrushStableLiveDisplayReferenceTexture(materialMap);
  const editableStable = textureAirbrushStableLiveDisplayReferenceTexture(editable?.texture || null);
  const cloneStable = textureAirbrushStableLiveDisplayReferenceTexture(userData.clonePaintTexture || null);
  const originalStable = textureAirbrushStableLiveDisplayReferenceTexture(userData.clonePaintOriginalMap || null);
  if (editable?.layerMode === true) {
    return materialMapIsExternal
      ? editableStable || cloneStable || originalStable || null
      : materialMapStable || editableStable || originalStable || null;
  }
  return editableStable || (materialMapIsExternal ? null : materialMapStable) || cloneStable || originalStable || null;
}

function textureAirbrushTextureNeedsLiveLinearDisplay(texture = null) {
  const colorSpace = texture?.colorSpace || "";
  // Three uploads a normal SRGB material map as an SRGB GPU texture, so shader
  // sampling yields linear values. The live airbrush texture is a writable
  // rgba8unorm storage texture; it cannot be an SRGB storage texture. Convert
  // SRGB bytes into linear RGB before the ExternalTexture replaces material.map
  // or the model visibly brightens as soon as painting starts.
  return colorSpace === "srgb";
}

function textureAirbrushTextureUsesMipmapMinFilter(texture = null) {
  const minFilter = texture?.minFilter;
  if (typeof minFilter === "string") {
    return minFilter.toLowerCase().includes("mipmap");
  }
  const numericFilter = Number(minFilter);
  return Number.isFinite(numericFilter) && (
    numericFilter === 1004
    || numericFilter === 1005
    || numericFilter === 1007
    || numericFilter === 1008
  );
}

function textureAirbrushTexturePrefersMipmappedDisplay(texture = null) {
  return textureAirbrushTextureUsesMipmapMinFilter(texture)
    || texture?.generateMipmaps === true;
}

function textureAirbrushLiveDisplayMipLevelCount(width = 1, height = 1) {
  const maxDimension = Math.max(
    1,
    Math.floor(Number(width) || 1),
    Math.floor(Number(height) || 1)
  );
  return Math.max(1, Math.floor(Math.log2(maxDimension)) + 1);
}

function textureAirbrushGpuTextureMipLevelCount(gpuTexture = null, options = {}) {
  const explicit = Math.floor(Number(options.mipLevelCount ?? options.displayMipLevelCount));
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const textureMipCount = Math.floor(Number(gpuTexture?.mipLevelCount));
  return Number.isFinite(textureMipCount) && textureMipCount > 0
    ? textureMipCount
    : 1;
}

function textureAirbrushFullDirtyBounds(width = 1, height = 1) {
  return {
    x: 0,
    y: 0,
    width: Math.max(1, Math.floor(Number(width) || 1)),
    height: Math.max(1, Math.floor(Number(height) || 1))
  };
}

function textureAirbrushDirtyBoundsIsFull(bounds = null, width = 1, height = 1) {
  const normalized = textureAirbrushUnionDirtyBounds(null, bounds, width, height);
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const safeHeight = Math.max(1, Math.floor(Number(height) || 1));
  return !normalized
    || (
      normalized.x <= 0
      && normalized.y <= 0
      && normalized.width >= safeWidth
      && normalized.height >= safeHeight
    );
}

function textureAirbrushDisplayBoundsFromSourceBounds(bounds = null, width = 1, height = 1, flipY = false) {
  const normalized = textureAirbrushUnionDirtyBounds(null, bounds, width, height)
    || textureAirbrushFullDirtyBounds(width, height);
  if (!flipY) {
    return normalized;
  }
  const safeHeight = Math.max(1, Math.floor(Number(height) || 1));
  return {
    x: normalized.x,
    y: Math.max(0, safeHeight - normalized.y - normalized.height),
    width: normalized.width,
    height: normalized.height
  };
}

function textureAirbrushNextMipDirtyBounds(bounds = null, sourceWidth = 1, sourceHeight = 1) {
  const normalized = textureAirbrushUnionDirtyBounds(null, bounds, sourceWidth, sourceHeight)
    || textureAirbrushFullDirtyBounds(sourceWidth, sourceHeight);
  const safeSourceWidth = Math.max(1, Math.floor(Number(sourceWidth) || 1));
  const safeSourceHeight = Math.max(1, Math.floor(Number(sourceHeight) || 1));
  const paddedX = Math.max(0, normalized.x - 1);
  const paddedY = Math.max(0, normalized.y - 1);
  const paddedRight = Math.min(safeSourceWidth, normalized.x + normalized.width + 1);
  const paddedBottom = Math.min(safeSourceHeight, normalized.y + normalized.height + 1);
  const destinationWidth = Math.max(1, Math.ceil(safeSourceWidth / 2));
  const destinationHeight = Math.max(1, Math.ceil(safeSourceHeight / 2));
  const x = Math.max(0, Math.min(destinationWidth - 1, Math.floor(paddedX / 2)));
  const y = Math.max(0, Math.min(destinationHeight - 1, Math.floor(paddedY / 2)));
  const right = Math.max(
    x + 1,
    Math.min(destinationWidth, Math.ceil(paddedRight / 2))
  );
  const bottom = Math.max(
    y + 1,
    Math.min(destinationHeight, Math.ceil(paddedBottom / 2))
  );
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function textureAirbrushDirtyMipmapShaderSource() {
  return `
struct TextureAirbrushDirtyMipmapParams {
  sourceWidth: u32,
  sourceHeight: u32,
  destinationX: u32,
  destinationY: u32,
  destinationWidth: u32,
  destinationHeight: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var destinationTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: TextureAirbrushDirtyMipmapParams;

@compute @workgroup_size(8, 8, 1)
fn textureAirbrushGenerateDirtyMipmap(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.destinationWidth || id.y >= params.destinationHeight) {
    return;
  }
  let destinationPixel = vec2<u32>(params.destinationX + id.x, params.destinationY + id.y);
  let sourceBase = destinationPixel * 2u;
  let maxSource = vec2<u32>(
    max(params.sourceWidth, 1u) - 1u,
    max(params.sourceHeight, 1u) - 1u
  );
  let p00 = vec2<i32>(min(sourceBase, maxSource));
  let p10 = vec2<i32>(min(sourceBase + vec2<u32>(1u, 0u), maxSource));
  let p01 = vec2<i32>(min(sourceBase + vec2<u32>(0u, 1u), maxSource));
  let p11 = vec2<i32>(min(sourceBase + vec2<u32>(1u, 1u), maxSource));
  let color = (
    textureLoad(sourceTexture, p00, 0)
    + textureLoad(sourceTexture, p10, 0)
    + textureLoad(sourceTexture, p01, 0)
    + textureLoad(sourceTexture, p11, 0)
  ) * 0.25;
  textureStore(destinationTexture, vec2<i32>(destinationPixel), color);
}`;
}

function textureAirbrushEnsureDirtyMipmapResources(device = null, cache = null, options = {}) {
  if (!device || !cache) {
    return null;
  }
  const computeStage = textureAirbrushWebGpuUsageConstants(globalThis).shaderStage.compute;
  const bufferUsage = textureAirbrushWebGpuUsageConstants(globalThis).buffer;
  let resources = cache.dirtyMipmapResources || null;
  if (
    !resources
    || resources.device !== device
    || !resources.pipeline
    || !resources.bindGroupLayout
  ) {
    const shaderModule = device.createShaderModule({
      label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-shader`,
      code: textureAirbrushDirtyMipmapShaderSource()
    });
    const bindGroupLayout = device.createBindGroupLayout({
      label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-bind-group-layout`,
      entries: [
        {
          binding: 0,
          visibility: computeStage,
          texture: { sampleType: "float", viewDimension: "2d" }
        },
        {
          binding: 1,
          visibility: computeStage,
          storageTexture: {
            access: "write-only",
            format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
            viewDimension: "2d"
          }
        },
        {
          binding: 2,
          visibility: computeStage,
          buffer: { type: "uniform" }
        }
      ]
    });
    const pipelineLayout = device.createPipelineLayout({
      label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-pipeline-layout`,
      bindGroupLayouts: [bindGroupLayout]
    });
    resources = {
      device,
      bindGroupLayout,
      pipelineLayout,
      pipeline: device.createComputePipeline({
        label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-pipeline`,
        layout: pipelineLayout,
        compute: {
          module: shaderModule,
          entryPoint: "textureAirbrushGenerateDirtyMipmap"
        }
      }),
      uniformBuffers: []
    };
    cache.dirtyMipmapResources = resources;
  }
  resources.uniformBuffers ||= [];
  resources.uniformBufferForLevel = (level, regionIndex = 0) => {
    const index = Math.max(0, Math.floor(Number(level) || 0));
    const region = Math.max(0, Math.floor(Number(regionIndex) || 0));
    resources.uniformBuffers[index] ||= [];
    if (!resources.uniformBuffers[index][region]) {
      resources.uniformBuffers[index][region] = device.createBuffer({
        label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-level-${index}-region-${region}-uniform-buffer`,
        size: 32,
        usage: bufferUsage.uniform | bufferUsage.copyDst
      });
    }
    return resources.uniformBuffers[index][region];
  };
  resources.bindGroupCache ||= new WeakMap();
  resources.bindGroupForTextureLevel = (gpuTexture, level, regionIndex = 0) => {
    if (
      !gpuTexture
      || !resources.bindGroupLayout
      || (typeof gpuTexture !== "object" && typeof gpuTexture !== "function")
    ) {
      return null;
    }
    const index = Math.max(1, Math.floor(Number(level) || 1));
    const region = Math.max(0, Math.floor(Number(regionIndex) || 0));
    let textureCache = resources.bindGroupCache.get(gpuTexture);
    if (!textureCache) {
      textureCache = new Map();
      resources.bindGroupCache.set(gpuTexture, textureCache);
    }
    const key = `${index}:${region}`;
    const cached = textureCache.get(key);
    if (cached?.bindGroup && cached.uniformBuffer) {
      return cached;
    }
    const uniformBuffer = resources.uniformBufferForLevel(index, region);
    const entry = {
      uniformBuffer,
      bindGroup: device.createBindGroup({
        label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-level-${index}-region-${region}-bind-group`,
        layout: resources.bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: gpuTexture.createView({
              baseMipLevel: index - 1,
              mipLevelCount: 1
            })
          },
          {
            binding: 1,
            resource: gpuTexture.createView({
              baseMipLevel: index,
              mipLevelCount: 1
            })
          },
          {
            binding: 2,
            resource: { buffer: uniformBuffer }
          }
        ]
      })
    };
    textureCache.set(key, entry);
    return entry;
  };
  return resources;
}

function textureAirbrushGenerateDirtyWebGpuDisplayMipmaps(editor = null, cache = null, gpuTexture = null, options = {}) {
  const device = cache?.device || options.device || editor?.textureAirbrushWebGpuDevice?.();
  const mipLevelCount = textureAirbrushGpuTextureMipLevelCount(gpuTexture, options);
  const width = Math.max(1, Math.floor(Number(options.width) || 1));
  const height = Math.max(1, Math.floor(Number(options.height) || 1));
  const dirtyBounds = textureAirbrushUnionDirtyBounds(null, options.dirtyBounds || null, width, height);
  const dirtyRegions = textureAirbrushNormalizeDirtyRegions(options.dirtyRegions || [], width, height);
  const mipmapRegions = dirtyRegions.length ? dirtyRegions : (dirtyBounds ? [dirtyBounds] : []);
  if (
    !device
    || !cache
    || !gpuTexture
    || mipLevelCount <= 1
    || !mipmapRegions.length
  ) {
    return null;
  }
  const resources = textureAirbrushEnsureDirtyMipmapResources(device, cache, options);
  if (!resources?.pipeline || !resources.bindGroupLayout) {
    return null;
  }
  const providedCommandEncoder = options.commandEncoder || null;
  const encoder = providedCommandEncoder || device.createCommandEncoder({
    label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-command-encoder`
  });
  let totalPixels = 0;
  let sourceWidth = width;
  let sourceHeight = height;
  let sourceRegions = mipmapRegions;
  for (let level = 1; level < mipLevelCount; level += 1) {
    const destinationWidth = Math.max(1, Math.ceil(sourceWidth / 2));
    const destinationHeight = Math.max(1, Math.ceil(sourceHeight / 2));
    let destinationRegions = [];
    for (const sourceBounds of sourceRegions) {
      const destinationBounds = textureAirbrushNextMipDirtyBounds(sourceBounds, sourceWidth, sourceHeight);
      destinationRegions = textureAirbrushAppendDirtyRegion(
        destinationRegions,
        destinationBounds,
        destinationWidth,
        destinationHeight
      );
    }
    destinationRegions = textureAirbrushNormalizeDirtyRegions(
      destinationRegions,
      destinationWidth,
      destinationHeight
    );
    if (!destinationRegions.length) {
      break;
    }
    for (let regionIndex = 0; regionIndex < destinationRegions.length; regionIndex += 1) {
      const destinationBounds = destinationRegions[regionIndex];
      const uniformData = new Uint32Array([
        sourceWidth,
        sourceHeight,
        destinationBounds.x,
        destinationBounds.y,
        destinationBounds.width,
        destinationBounds.height,
        0,
        0
      ]);
      const levelResources = resources.bindGroupForTextureLevel?.(gpuTexture, level, regionIndex);
      const uniformBuffer = levelResources?.uniformBuffer || resources.uniformBufferForLevel(level, regionIndex);
      device.queue?.writeBuffer?.(
        uniformBuffer,
        0,
        uniformData.buffer,
        uniformData.byteOffset || 0,
        uniformData.byteLength
      );
      const bindGroup = levelResources?.bindGroup;
      if (!bindGroup) {
        return null;
      }
      const pass = encoder.beginComputePass({
        label: `${options.label || "texture-airbrush-live-display"}-dirty-mipmap-level-${level}-compute-pass`
      });
      pass.setPipeline(resources.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(destinationBounds.width / 8),
        Math.ceil(destinationBounds.height / 8),
        1
      );
      pass.end();
      totalPixels += destinationBounds.width * destinationBounds.height;
    }
    sourceWidth = destinationWidth;
    sourceHeight = destinationHeight;
    sourceRegions = destinationRegions;
  }
  if (options.submit !== false && !providedCommandEncoder) {
    device.queue?.submit?.([encoder.finish()]);
  }
  cache.lastDirtyMipmapStats = {
    dirty: true,
    levels: Math.max(0, mipLevelCount - 1),
    pixels: totalPixels,
    bounds: textureAirbrushUnionDirtyRegions(mipmapRegions, width, height),
    ...(dirtyRegions.length ? { regions: mipmapRegions } : {})
  };
  return true;
}

function textureAirbrushGenerateWebGpuDisplayMipmaps(editor = null, gpuTexture = null, options = {}) {
  const mipLevelCount = textureAirbrushGpuTextureMipLevelCount(gpuTexture, options);
  if (!gpuTexture || mipLevelCount <= 1) {
    return false;
  }
  const dirtyResult = textureAirbrushGenerateDirtyWebGpuDisplayMipmaps(
    editor,
    options.cache || null,
    gpuTexture,
    options
  );
  if (dirtyResult === true) {
    return true;
  }
  if (options.commandEncoder) {
    return false;
  }
  const textureUtils = editor?.renderer?.backend?.textureUtils || null;
  try {
    if (typeof textureUtils?._generateMipmaps === "function") {
      textureUtils._generateMipmaps(gpuTexture);
      if (options.cache) {
        options.cache.lastDirtyMipmapStats = {
          dirty: false,
          levels: Math.max(0, mipLevelCount - 1),
          pixels: Math.max(1, Math.floor(Number(options.width) || 1))
            * Math.max(1, Math.floor(Number(options.height) || 1)),
          bounds: textureAirbrushFullDirtyBounds(options.width, options.height)
        };
      }
      return true;
    }
    const passUtils = typeof textureUtils?._getPassUtils === "function"
      ? textureUtils._getPassUtils()
      : null;
    if (typeof passUtils?.generateMipmaps === "function") {
      passUtils.generateMipmaps(gpuTexture);
      if (options.cache) {
        options.cache.lastDirtyMipmapStats = {
          dirty: false,
          levels: Math.max(0, Math.floor(Number(gpuTexture.mipLevelCount) || 1) - 1),
          pixels: Math.max(1, Math.floor(Number(options.width) || 1))
            * Math.max(1, Math.floor(Number(options.height) || 1)),
          bounds: textureAirbrushFullDirtyBounds(options.width, options.height)
        };
      }
      return true;
    }
  } catch (error) {
    console.warn("Texture airbrush WebGPU live display mipmap generation failed.", error);
  }
  return false;
}

function textureAirbrushLiveDisplayImmediateMipmapPixelBudget(width = 1, height = 1, options = {}) {
  const explicit = Number(options.liveDisplayMipmapImmediatePixels ?? options.liveDisplayImmediateMipmapPixels);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  const texturePixels = Math.max(1, Math.floor(Number(width) || 1))
    * Math.max(1, Math.floor(Number(height) || 1));
  return Math.max(
    TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_MIN_IMMEDIATE_PIXELS,
    Math.min(
      TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_MAX_IMMEDIATE_PIXELS,
      texturePixels * TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_IMMEDIATE_FRACTION
    )
  );
}

function textureAirbrushEstimateDirtyMipmapPixels(dirtyBounds = null, width = 1, height = 1) {
  let sourceWidth = Math.max(1, Math.floor(Number(width) || 1));
  let sourceHeight = Math.max(1, Math.floor(Number(height) || 1));
  let sourceBounds = textureAirbrushUnionDirtyBounds(null, dirtyBounds, sourceWidth, sourceHeight);
  if (!sourceBounds) {
    return 0;
  }
  let totalPixels = 0;
  while (sourceWidth > 1 || sourceHeight > 1) {
    const destinationBounds = textureAirbrushNextMipDirtyBounds(sourceBounds, sourceWidth, sourceHeight);
    totalPixels += destinationBounds.width * destinationBounds.height;
    sourceWidth = Math.max(1, Math.ceil(sourceWidth / 2));
    sourceHeight = Math.max(1, Math.ceil(sourceHeight / 2));
    sourceBounds = destinationBounds;
  }
  return totalPixels;
}

function textureAirbrushEstimateDirtyRegionsMipmapPixels(regions = [], width = 1, height = 1) {
  return textureAirbrushNormalizeDirtyRegions(regions, width, height).reduce(
    (total, region) => total + textureAirbrushEstimateDirtyMipmapPixels(region, width, height),
    0
  );
}

function textureAirbrushShouldGenerateLiveDisplayMipmapsNow(dirtyBounds = null, width = 1, height = 1, options = {}) {
  const bounds = textureAirbrushUnionDirtyBounds(null, dirtyBounds, width, height);
  const regions = textureAirbrushNormalizeDirtyRegions(options.dirtyRegions || [], width, height);
  if (!bounds && !regions.length) {
    return false;
  }
  const explicitImmediateBudget = Number(options.liveDisplayMipmapImmediatePixels ?? options.liveDisplayImmediateMipmapPixels);
  if (Number.isFinite(explicitImmediateBudget) && explicitImmediateBudget <= 0) {
    return false;
  }
  const dirtyMipmapPixels = regions.length
    ? textureAirbrushEstimateDirtyRegionsMipmapPixels(regions, width, height)
    : textureAirbrushEstimateDirtyMipmapPixels(bounds, width, height);
  return dirtyMipmapPixels <= textureAirbrushLiveDisplayImmediateMipmapPixelBudget(width, height, options);
}

function textureAirbrushScheduleDeferredDisplayMipmaps(editor = null, cache = null, gpuTexture = null, options = {}) {
  if (!editor || !cache || !gpuTexture) {
    return false;
  }
  const width = Math.max(1, Math.floor(Number(options.width) || 1));
  const height = Math.max(1, Math.floor(Number(options.height) || 1));
  const bounds = textureAirbrushUnionDirtyBounds(null, options.dirtyBounds || null, width, height)
    || textureAirbrushFullDirtyBounds(width, height);
  const incomingRegions = textureAirbrushNormalizeDirtyRegions(options.dirtyRegions || [], width, height);
  let pendingRegions = textureAirbrushNormalizeDirtyRegions(
    cache.deferredLiveDisplayMipmapRegions || (
      cache.deferredLiveDisplayMipmapBounds ? [cache.deferredLiveDisplayMipmapBounds] : []
    ),
    width,
    height
  );
  if (incomingRegions.length) {
    for (const region of incomingRegions) {
      pendingRegions = textureAirbrushAppendDirtyRegion(pendingRegions, region, width, height);
    }
  } else {
    pendingRegions = textureAirbrushAppendDirtyRegion(pendingRegions, bounds, width, height);
  }
  const pendingBounds = textureAirbrushUnionDirtyRegions(pendingRegions, width, height) || bounds;
  const forcePendingRegions = options.forceLiveDisplayDirtyRegions === true
    && pendingRegions.length > 1;
  const usePendingRegions = forcePendingRegions
    || textureAirbrushUseDirtyRegions(pendingRegions, pendingBounds, width, height);
  cache.deferredLiveDisplayMipmapRegions = pendingRegions.length ? pendingRegions : null;
  cache.deferredLiveDisplayMipmapBounds = pendingBounds;
  cache.deferredLiveDisplayMipmapTexture = gpuTexture;
  const {
    commandEncoder: _deferredCommandEncoder,
    submit: _deferredSubmit,
    ...deferredOptions
  } = options || {};
  cache.deferredLiveDisplayMipmapOptions = {
    ...deferredOptions,
    width,
    height,
    deferLiveDisplayMipmaps: false,
    dirtyBounds: cache.deferredLiveDisplayMipmapBounds,
    submit: true,
    ...(usePendingRegions ? { dirtyRegions: pendingRegions } : { dirtyRegions: null })
  };
  cache.lastDirtyMipmapStats = {
    dirty: true,
    deferred: true,
    levels: Math.max(0, Math.floor(Number(gpuTexture.mipLevelCount) || 1) - 1),
    pixels: 0,
    bounds: cache.deferredLiveDisplayMipmapBounds,
    ...(usePendingRegions ? { regions: pendingRegions } : {})
  };
  if (cache.deferredLiveDisplayMipmapScheduled === true) {
    return true;
  }
  cache.deferredLiveDisplayMipmapScheduled = true;
  const host = typeof window !== "undefined" ? window : globalThis;
  const delayMs = Math.max(0, Math.floor(Number(options.liveDisplayMipmapDelayMs) || 0));
  const schedule = delayMs <= 0 && typeof host?.requestAnimationFrame === "function"
    ? (callback) => host.requestAnimationFrame(callback)
    : typeof host?.setTimeout === "function"
      ? (callback) => host.setTimeout(callback, delayMs)
      : typeof host?.requestAnimationFrame === "function"
        ? (callback) => host.requestAnimationFrame(callback)
        : null;
  const run = () => {
    cache.deferredLiveDisplayMipmapScheduled = false;
    if (!textureAirbrushLiveDisplayMipmapIdle(editor)) {
      const retryDelayMs = Math.max(
        16,
        Math.floor(
          Number(options.liveDisplayMipmapIdleRetryMs)
          || Number(editor?.textureAirbrushLiveDisplayMipmapIdleRetryMs)
          || TEXTURE_AIRBRUSH_LIVE_DISPLAY_MIPMAP_IDLE_RETRY_MS
        )
      );
      textureAirbrushScheduleDeferredDisplayMipmaps(editor, cache, cache.deferredLiveDisplayMipmapTexture || gpuTexture, {
        ...(cache.deferredLiveDisplayMipmapOptions || options),
        liveDisplayMipmapDelayMs: retryDelayMs
      });
      return;
    }
    const pendingTexture = cache.deferredLiveDisplayMipmapTexture;
    const pendingOptions = cache.deferredLiveDisplayMipmapOptions || null;
    cache.deferredLiveDisplayMipmapTexture = null;
    cache.deferredLiveDisplayMipmapOptions = null;
    cache.deferredLiveDisplayMipmapBounds = null;
    cache.deferredLiveDisplayMipmapRegions = null;
    if (!pendingTexture || !pendingOptions) {
      return;
    }
    const mipmapsGenerated = textureAirbrushGenerateWebGpuDisplayMipmaps(editor, pendingTexture, {
      ...pendingOptions,
      cache
    });
    if (mipmapsGenerated === true) {
      textureAirbrushRestoreDeferredDisplayMipmapFiltering(cache, pendingTexture, pendingOptions);
    }
    if (cache.deferredLiveDisplayMipmapBounds) {
      textureAirbrushScheduleDeferredDisplayMipmaps(editor, cache, pendingTexture, pendingOptions);
    }
  };
  if (!schedule) {
    run();
    return true;
  }
  schedule(run);
  return true;
}

function textureAirbrushRestoreDeferredDisplayMipmapFiltering(cache = null, gpuTexture = null, options = {}) {
  const texture = cache?.externalDisplayGpuTexture === gpuTexture
    ? cache.externalDisplayTexture
    : null;
  if (!texture) {
    return false;
  }
  const material = options.material || null;
  const referenceTexture = texture.userData?.textureAirbrushWebGpuCanvasMap
    || (material ? textureAirbrushLiveDisplayReferenceTexture(material, options.editable || null) : null);
  if (!referenceTexture) {
    return false;
  }
  textureAirbrushRefreshReusableExternalTexture(texture, referenceTexture, {
    width: options.width,
    height: options.height,
    flipY: texture.flipY,
    colorSpace: texture.colorSpace,
    mipmapped: true
  });
  if (material) {
    material.userData ||= {};
    material.userData.textureAirbrushWebGpuExternalMap = texture;
    material.userData.textureAirbrushWebGpuCanvasMap = referenceTexture;
    if (material.map !== texture) {
      material.map = texture;
      material.needsUpdate = true;
    }
    if (texture.userData?.textureAirbrushExternalDisplayMetadataChanged === true) {
      material.needsUpdate = true;
    }
  }
  return true;
}

function textureAirbrushWebGpuLayerCompositeShaderSource() {
  return `
struct TextureAirbrushLayerCompositeParams {
  width: f32,
  height: f32,
  opacity: f32,
  flipY: f32,
  linearizeSrgb: f32,
  copyX: f32,
  copyY: f32,
  copyWidth: f32,
  copyHeight: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var baseTexture: texture_2d<f32>;
@group(0) @binding(1) var layerTexture: texture_2d<f32>;
@group(0) @binding(2) var displayTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: TextureAirbrushLayerCompositeParams;

fn textureAirbrushSrgbChannelToLinear(value: f32) -> f32 {
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return pow((value + 0.055) / 1.055, 2.4);
}

fn textureAirbrushSrgbToLinear(color: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    textureAirbrushSrgbChannelToLinear(color.r),
    textureAirbrushSrgbChannelToLinear(color.g),
    textureAirbrushSrgbChannelToLinear(color.b)
  );
}

fn textureAirbrushLiveDisplayColor(color: vec3<f32>) -> vec3<f32> {
  if (params.linearizeSrgb > 0.5) {
    return textureAirbrushSrgbToLinear(color);
  }
  return color;
}

@compute @workgroup_size(8, 8, 1)
fn textureAirbrushCompositeLayer(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = u32(max(params.width, 1.0));
  let height = u32(max(params.height, 1.0));
  let copyWidth = u32(max(params.copyWidth, 1.0));
  let copyHeight = u32(max(params.copyHeight, 1.0));
  if (id.x >= copyWidth || id.y >= copyHeight) {
    return;
  }
  let displayX = u32(max(params.copyX, 0.0)) + id.x;
  let displayY = u32(max(params.copyY, 0.0)) + id.y;
  if (displayX >= width || displayY >= height) {
    return;
  }
  let sourceY = select(displayY, height - 1u - displayY, params.flipY > 0.5);
  let sourcePixel = vec2<i32>(i32(displayX), i32(sourceY));
  let displayPixel = vec2<i32>(i32(displayX), i32(displayY));
  let base = textureLoad(baseTexture, sourcePixel, 0);
  let layer = textureLoad(layerTexture, sourcePixel, 0);
  let alpha = clamp(layer.a * params.opacity, 0.0, 1.0);
  let color = mix(base.rgb, layer.rgb, alpha);
  textureStore(displayTexture, displayPixel, vec4<f32>(textureAirbrushLiveDisplayColor(color), max(base.a, alpha)));
}`;
}

function textureAirbrushWebGpuDisplayCopyShaderSource() {
  return `
struct TextureAirbrushDisplayCopyParams {
  width: f32,
  height: f32,
  flipY: f32,
  linearizeSrgb: f32,
  copyX: f32,
  copyY: f32,
  copyWidth: f32,
  copyHeight: f32,
};

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var displayTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: TextureAirbrushDisplayCopyParams;

fn textureAirbrushSrgbChannelToLinear(value: f32) -> f32 {
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return pow((value + 0.055) / 1.055, 2.4);
}

fn textureAirbrushSrgbToLinear(color: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    textureAirbrushSrgbChannelToLinear(color.r),
    textureAirbrushSrgbChannelToLinear(color.g),
    textureAirbrushSrgbChannelToLinear(color.b)
  );
}

fn textureAirbrushLiveDisplayColor(color: vec3<f32>) -> vec3<f32> {
  if (params.linearizeSrgb > 0.5) {
    return textureAirbrushSrgbToLinear(color);
  }
  return color;
}

@compute @workgroup_size(8, 8, 1)
fn textureAirbrushCopyLiveDisplay(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = u32(max(params.width, 1.0));
  let height = u32(max(params.height, 1.0));
  let copyWidth = u32(max(params.copyWidth, 1.0));
  let copyHeight = u32(max(params.copyHeight, 1.0));
  if (id.x >= copyWidth || id.y >= copyHeight) {
    return;
  }
  let displayX = u32(max(params.copyX, 0.0)) + id.x;
  let displayY = u32(max(params.copyY, 0.0)) + id.y;
  if (displayX >= width || displayY >= height) {
    return;
  }
  let sourceY = select(displayY, height - 1u - displayY, params.flipY > 0.5);
  let sourcePixel = vec2<i32>(i32(displayX), i32(sourceY));
  let displayPixel = vec2<i32>(i32(displayX), i32(displayY));
  let source = textureLoad(sourceTexture, sourcePixel, 0);
  textureStore(displayTexture, displayPixel, vec4<f32>(textureAirbrushLiveDisplayColor(source.rgb), source.a));
}`;
}

function textureAirbrushCopyExternalCanvasToTexture(device = null, canvas = null, texture = null, width = 1, height = 1) {
  if (!device?.queue?.copyExternalImageToTexture || !canvas || !texture) {
    return false;
  }
  try {
    device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture },
      {
        width: Math.max(1, Math.floor(Number(width) || 1)),
        height: Math.max(1, Math.floor(Number(height) || 1)),
        depthOrArrayLayers: 1
      }
    );
    return true;
  } catch {
    return false;
  }
}

function textureAirbrushEnsureWebGpuLayerCompositeResources(device = null, cache = null, source = null, layerTexture = null, options = {}) {
  if (!device || !cache || !source?.canvas || !source.context || !layerTexture) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(source.width) || 1));
  const height = Math.max(1, Math.floor(Number(source.height) || 1));
  const usage = textureAirbrushWebGpuUsageConstants(globalThis).texture;
  const bufferUsage = textureAirbrushWebGpuUsageConstants(globalThis).buffer;
  const computeStage = textureAirbrushWebGpuUsageConstants(globalThis).shaderStage.compute;
  const mipLevelCount = options.displayMipmaps === true
    ? textureAirbrushLiveDisplayMipLevelCount(width, height)
    : 1;
  const textureDescriptor = {
    size: { width, height, depthOrArrayLayers: 1 },
    format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
    mipLevelCount
  };
  let composite = cache.layerDisplayComposite || null;
  if (
    !composite
    || composite.width !== width
    || composite.height !== height
    || composite.mipLevelCount !== mipLevelCount
    || composite.device !== device
    || !composite.baseTexture
    || !composite.displayTexture
    || !composite.pipeline
    || !composite.bindGroupLayout
    || !composite.uniformBuffer
  ) {
    composite = {
      device,
      width,
      height,
      mipLevelCount,
      baseTexture: device.createTexture({
        label: `${options.label || "texture-airbrush-layer-display"}-base-texture`,
        ...textureDescriptor,
        usage: usage.textureBinding | usage.copyDst | usage.renderAttachment
      }),
      displayTexture: device.createTexture({
        label: `${options.label || "texture-airbrush-layer-display"}-display-texture`,
        ...textureDescriptor,
        usage: usage.storageBinding | usage.textureBinding | usage.copySrc | usage.copyDst | usage.renderAttachment
      }),
      uniformBuffer: device.createBuffer({
        label: `${options.label || "texture-airbrush-layer-display"}-uniform-buffer`,
        size: 48,
        usage: bufferUsage.uniform | bufferUsage.copyDst
      }),
      bindGroupLayout: null,
      pipelineLayout: null,
      pipeline: null,
      bindGroup: null,
      baseKey: ""
    };
    const shaderModule = device.createShaderModule({
      label: `${options.label || "texture-airbrush-layer-display"}-shader`,
      code: textureAirbrushWebGpuLayerCompositeShaderSource()
    });
    composite.bindGroupLayout = device.createBindGroupLayout({
      label: `${options.label || "texture-airbrush-layer-display"}-bind-group-layout`,
      entries: [
        {
          binding: 0,
          visibility: computeStage,
          texture: { sampleType: "float", viewDimension: "2d" }
        },
        {
          binding: 1,
          visibility: computeStage,
          texture: { sampleType: "float", viewDimension: "2d" }
        },
        {
          binding: 2,
          visibility: computeStage,
          storageTexture: {
            access: "write-only",
            format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
            viewDimension: "2d"
          }
        },
        {
          binding: 3,
          visibility: computeStage,
          buffer: { type: "uniform" }
        }
      ]
    });
    composite.pipelineLayout = device.createPipelineLayout({
      label: `${options.label || "texture-airbrush-layer-display"}-pipeline-layout`,
      bindGroupLayouts: [composite.bindGroupLayout]
    });
    composite.pipeline = device.createComputePipeline({
      label: `${options.label || "texture-airbrush-layer-display"}-pipeline`,
      layout: composite.pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "textureAirbrushCompositeLayer"
      }
    });
    cache.layerDisplayComposite = composite;
  }
  const baseChanged = composite.baseKey !== source.key;
  if (baseChanged) {
    const externalUploaded = textureAirbrushCopyExternalCanvasToTexture(
      device,
      source.canvas,
      composite.baseTexture,
      width,
      height
    );
    if (!externalUploaded) {
      const baseSource = textureAirbrushSourcePixelsFromCanvas(source.canvas, source.context);
      if (!baseSource?.sourcePixels) {
        return null;
      }
      device.queue?.writeTexture?.(
        { texture: composite.baseTexture },
        baseSource.sourcePixels,
        {
          bytesPerRow: width * 4,
          rowsPerImage: height
        },
        {
          width,
          height,
          depthOrArrayLayers: 1
        }
      );
    }
    composite.baseUploadExternal = externalUploaded === true;
    composite.baseKey = source.key;
  }
  const sourceDirtyBounds = textureAirbrushUnionDirtyBounds(
    null,
    options.displayDirtyBounds || null,
    width,
    height
  );
  const sourceDirtyRegions = textureAirbrushNormalizeDirtyRegions(options.displayDirtyRegions || [], width, height);
  const forceSourceDirtyRegions = options.forceDisplayDirtyRegions === true
    && sourceDirtyRegions.length > 1;
  const useSourceDirtyRegions = forceSourceDirtyRegions || textureAirbrushUseDirtyRegions(
    sourceDirtyRegions,
    sourceDirtyBounds,
    width,
    height
  );
  const layerTextureChanged = composite.bindGroupLayerTexture !== layerTexture;
  const useFullDisplayUpdate = composite.initialized !== true
    || baseChanged
    || (layerTextureChanged && options.preserveDisplayOnSourceTextureChange !== true)
    || (!useSourceDirtyRegions && textureAirbrushDirtyBoundsIsFull(sourceDirtyBounds, width, height));
  const displayDirtyRegions = !useFullDisplayUpdate && useSourceDirtyRegions
    ? textureAirbrushDisplayRegionsFromSourceRegions(sourceDirtyRegions, width, height, options.displayFlipY === true)
    : null;
  const displayDirtyBounds = useFullDisplayUpdate
    ? textureAirbrushFullDirtyBounds(width, height)
    : displayDirtyRegions
      ? textureAirbrushUnionDirtyRegions(displayDirtyRegions, width, height)
      : textureAirbrushDisplayBoundsFromSourceBounds(sourceDirtyBounds, width, height, options.displayFlipY === true);
  const uniformDataForRegion = (region = displayDirtyBounds) => new Float32Array([
    width,
    height,
    Math.max(0, Math.min(1, Number(source.opacity) || 0)),
    options.displayFlipY === true ? 1 : 0,
    options.displayLinearizeSrgb === true ? 1 : 0,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    0
  ]);
  const writeUniform = (buffer, region = displayDirtyBounds) => {
    const uniformData = uniformDataForRegion(region);
    device.queue?.writeBuffer?.(
      buffer,
      0,
      uniformData.buffer,
      uniformData.byteOffset || 0,
      uniformData.byteLength
    );
  };
  writeUniform(composite.uniformBuffer, displayDirtyRegions?.[0] || displayDirtyBounds);
  if (layerTextureChanged) {
    composite.regionBindGroups = [];
  }
  composite.regionUniformBuffers ||= [];
  composite.regionBindGroups ||= [];
  composite.baseTextureView ||= composite.baseTexture.createView({
    baseMipLevel: 0,
    mipLevelCount: 1
  });
  composite.displayTextureView ||= composite.displayTexture.createView({
    baseMipLevel: 0,
    mipLevelCount: 1
  });
  if (!composite.layerTextureView || layerTextureChanged) {
    composite.bindGroupLayerTexture = layerTexture;
    composite.layerTextureView = layerTexture.createView({
      baseMipLevel: 0,
      mipLevelCount: 1
    });
  }
  const bindGroupForUniform = (uniformBuffer) => device.createBindGroup({
      label: `${options.label || "texture-airbrush-layer-display"}-bind-group`,
      layout: composite.bindGroupLayout,
      entries: [
        { binding: 0, resource: composite.baseTextureView },
        { binding: 1, resource: composite.layerTextureView },
        { binding: 2, resource: composite.displayTextureView },
        { binding: 3, resource: { buffer: uniformBuffer } }
      ]
    });
  if (!composite.bindGroup || layerTextureChanged) {
    composite.bindGroup = bindGroupForUniform(composite.uniformBuffer);
  }
  composite.bindGroupForRegion = (index = 0, region = displayDirtyBounds) => {
    const regionIndex = Math.max(0, Math.floor(Number(index) || 0));
    if (!composite.regionUniformBuffers[regionIndex]) {
      composite.regionUniformBuffers[regionIndex] = device.createBuffer({
        label: `${options.label || "texture-airbrush-layer-display"}-region-${regionIndex}-uniform-buffer`,
        size: 48,
        usage: bufferUsage.uniform | bufferUsage.copyDst
      });
    }
    const uniformBuffer = composite.regionUniformBuffers[regionIndex];
    writeUniform(uniformBuffer, region);
    if (!composite.regionBindGroups[regionIndex]) {
      composite.regionBindGroups[regionIndex] = bindGroupForUniform(uniformBuffer);
    }
    return composite.regionBindGroups[regionIndex];
  };
  if (displayDirtyRegions?.length) {
    composite.updatedDisplayRegionBindGroups = displayDirtyRegions.map((region, index) => (
      composite.bindGroupForRegion(index, region)
    ));
  } else {
    composite.updatedDisplayRegionBindGroups = null;
  }
  composite.updatedDisplayBounds = displayDirtyBounds;
  composite.updatedDisplayRegions = displayDirtyRegions || null;
  composite.fullDisplayUpdate = useFullDisplayUpdate;
  composite.displayWorkPixels = displayDirtyRegions?.length
    ? textureAirbrushDirtyRegionsArea(displayDirtyRegions)
    : displayDirtyBounds.width * displayDirtyBounds.height;
  return composite;
}

function textureAirbrushEnsureWebGpuDisplayCopyResources(device = null, cache = null, sourceTexture = null, options = {}) {
  if (!device || !cache || !sourceTexture) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(options.width) || cache.width || 1));
  const height = Math.max(1, Math.floor(Number(options.height) || cache.height || 1));
  const usage = textureAirbrushWebGpuUsageConstants(globalThis).texture;
  const bufferUsage = textureAirbrushWebGpuUsageConstants(globalThis).buffer;
  const computeStage = textureAirbrushWebGpuUsageConstants(globalThis).shaderStage.compute;
  const mipLevelCount = options.displayMipmaps === true
    ? textureAirbrushLiveDisplayMipLevelCount(width, height)
    : 1;
  const textureDescriptor = {
    size: { width, height, depthOrArrayLayers: 1 },
    format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
    mipLevelCount
  };
  let copy = cache.liveDisplayCopy || null;
  if (
    !copy
    || copy.width !== width
    || copy.height !== height
    || copy.mipLevelCount !== mipLevelCount
    || copy.device !== device
    || !copy.displayTexture
    || !copy.pipeline
    || !copy.bindGroupLayout
    || !copy.uniformBuffer
  ) {
    copy = {
      device,
      width,
      height,
      mipLevelCount,
      displayTexture: device.createTexture({
        label: `${options.label || "texture-airbrush-live-display"}-copy-texture`,
        ...textureDescriptor,
        usage: usage.storageBinding | usage.textureBinding | usage.copySrc | usage.copyDst | usage.renderAttachment
      }),
      uniformBuffer: device.createBuffer({
        label: `${options.label || "texture-airbrush-live-display"}-copy-uniform-buffer`,
        size: 32,
        usage: bufferUsage.uniform | bufferUsage.copyDst
      }),
      bindGroupLayout: null,
      pipelineLayout: null,
      pipeline: null,
      bindGroup: null
    };
    const shaderModule = device.createShaderModule({
      label: `${options.label || "texture-airbrush-live-display"}-copy-shader`,
      code: textureAirbrushWebGpuDisplayCopyShaderSource()
    });
    copy.bindGroupLayout = device.createBindGroupLayout({
      label: `${options.label || "texture-airbrush-live-display"}-copy-bind-group-layout`,
      entries: [
        {
          binding: 0,
          visibility: computeStage,
          texture: { sampleType: "float", viewDimension: "2d" }
        },
        {
          binding: 1,
          visibility: computeStage,
          storageTexture: {
            access: "write-only",
            format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
            viewDimension: "2d"
          }
        },
        {
          binding: 2,
          visibility: computeStage,
          buffer: { type: "uniform" }
        }
      ]
    });
    copy.pipelineLayout = device.createPipelineLayout({
      label: `${options.label || "texture-airbrush-live-display"}-copy-pipeline-layout`,
      bindGroupLayouts: [copy.bindGroupLayout]
    });
    copy.pipeline = device.createComputePipeline({
      label: `${options.label || "texture-airbrush-live-display"}-copy-pipeline`,
      layout: copy.pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "textureAirbrushCopyLiveDisplay"
      }
    });
    cache.liveDisplayCopy = copy;
  }
  const sourceDirtyBounds = textureAirbrushUnionDirtyBounds(
    null,
    options.displayDirtyBounds || null,
    width,
    height
  );
  const sourceDirtyRegions = textureAirbrushNormalizeDirtyRegions(options.displayDirtyRegions || [], width, height);
  const forceSourceDirtyRegions = options.forceDisplayDirtyRegions === true
    && sourceDirtyRegions.length > 1;
  const useSourceDirtyRegions = forceSourceDirtyRegions || textureAirbrushUseDirtyRegions(
    sourceDirtyRegions,
    sourceDirtyBounds,
    width,
    height
  );
  const sourceTextureChanged = copy.bindGroupSourceTexture !== sourceTexture;
  const useFullDisplayUpdate = copy.initialized !== true
    || (sourceTextureChanged && options.preserveDisplayOnSourceTextureChange !== true)
    || (!useSourceDirtyRegions && textureAirbrushDirtyBoundsIsFull(sourceDirtyBounds, width, height));
  const displayDirtyRegions = !useFullDisplayUpdate && useSourceDirtyRegions
    ? textureAirbrushDisplayRegionsFromSourceRegions(sourceDirtyRegions, width, height, options.displayFlipY === true)
    : null;
  const displayDirtyBounds = useFullDisplayUpdate
    ? textureAirbrushFullDirtyBounds(width, height)
    : displayDirtyRegions
      ? textureAirbrushUnionDirtyRegions(displayDirtyRegions, width, height)
      : textureAirbrushDisplayBoundsFromSourceBounds(sourceDirtyBounds, width, height, options.displayFlipY === true);
  const uniformDataForRegion = (region = displayDirtyBounds) => new Float32Array([
    width,
    height,
    options.displayFlipY === true ? 1 : 0,
    options.displayLinearizeSrgb === true ? 1 : 0,
    region.x,
    region.y,
    region.width,
    region.height
  ]);
  const writeUniform = (buffer, region = displayDirtyBounds) => {
    const uniformData = uniformDataForRegion(region);
    device.queue?.writeBuffer?.(
      buffer,
      0,
      uniformData.buffer,
      uniformData.byteOffset || 0,
      uniformData.byteLength
    );
  };
  writeUniform(copy.uniformBuffer, displayDirtyRegions?.[0] || displayDirtyBounds);
  if (sourceTextureChanged) {
    copy.regionBindGroups = [];
  }
  copy.regionUniformBuffers ||= [];
  copy.regionBindGroups ||= [];
  copy.bindGroupForRegion = (index = 0, region = displayDirtyBounds) => {
    const regionIndex = Math.max(0, Math.floor(Number(index) || 0));
    if (!copy.regionUniformBuffers[regionIndex]) {
      copy.regionUniformBuffers[regionIndex] = device.createBuffer({
        label: `${options.label || "texture-airbrush-live-display"}-copy-region-${regionIndex}-uniform-buffer`,
        size: 32,
        usage: bufferUsage.uniform | bufferUsage.copyDst
      });
    }
    const uniformBuffer = copy.regionUniformBuffers[regionIndex];
    writeUniform(uniformBuffer, region);
    if (!copy.regionBindGroups[regionIndex] || sourceTextureChanged) {
      copy.regionBindGroups[regionIndex] = device.createBindGroup({
        label: `${options.label || "texture-airbrush-live-display"}-copy-region-${regionIndex}-bind-group`,
        layout: copy.bindGroupLayout,
        entries: [
          { binding: 0, resource: copy.sourceTextureView },
          { binding: 1, resource: copy.displayTextureView },
          { binding: 2, resource: { buffer: uniformBuffer } }
        ]
      });
    }
    return copy.regionBindGroups[regionIndex];
  };
  if (!copy.bindGroup || copy.bindGroupSourceTexture !== sourceTexture) {
    copy.displayTextureView ||= copy.displayTexture.createView({
      baseMipLevel: 0,
      mipLevelCount: 1
    });
    copy.bindGroupSourceTexture = sourceTexture;
    copy.sourceTextureView = sourceTexture.createView({
      baseMipLevel: 0,
      mipLevelCount: 1
    });
    copy.bindGroup = device.createBindGroup({
      label: `${options.label || "texture-airbrush-live-display"}-copy-bind-group`,
      layout: copy.bindGroupLayout,
      entries: [
        { binding: 0, resource: copy.sourceTextureView },
        { binding: 1, resource: copy.displayTextureView },
        { binding: 2, resource: { buffer: copy.uniformBuffer } }
      ]
    });
  }
  if (displayDirtyRegions?.length) {
    copy.updatedDisplayRegionBindGroups = displayDirtyRegions.map((region, index) => (
      copy.bindGroupForRegion(index, region)
    ));
  } else {
    copy.updatedDisplayRegionBindGroups = null;
  }
  copy.updatedDisplayBounds = displayDirtyBounds;
  copy.updatedDisplayRegions = displayDirtyRegions || null;
  copy.fullDisplayUpdate = useFullDisplayUpdate;
  copy.displayWorkPixels = displayDirtyRegions?.length
    ? textureAirbrushDirtyRegionsArea(displayDirtyRegions)
    : displayDirtyBounds.width * displayDirtyBounds.height;
  return copy;
}

function textureAirbrushRunWebGpuDisplayCopy(device = null, copy = null, options = {}) {
  if (!device || !copy?.pipeline || !copy.bindGroup) {
    return false;
  }
  const providedCommandEncoder = options.commandEncoder || null;
  const encoder = providedCommandEncoder || device.createCommandEncoder({
    label: `${options.label || "texture-airbrush-live-display"}-copy-command-encoder`
  });
  const regions = Array.isArray(copy.updatedDisplayRegions) && copy.updatedDisplayRegions.length
    ? copy.updatedDisplayRegions
    : [copy.updatedDisplayBounds || textureAirbrushFullDirtyBounds(copy.width, copy.height)];
  const bindGroups = Array.isArray(copy.updatedDisplayRegionBindGroups) && copy.updatedDisplayRegionBindGroups.length
    ? copy.updatedDisplayRegionBindGroups
    : [copy.bindGroup];
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index] || copy.updatedDisplayBounds || textureAirbrushFullDirtyBounds(copy.width, copy.height);
    const pass = encoder.beginComputePass({
      label: `${options.label || "texture-airbrush-live-display"}-copy-compute-pass`
    });
    pass.setPipeline(copy.pipeline);
    pass.setBindGroup(0, bindGroups[index] || copy.bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(Math.max(1, region.width || copy.width) / 8),
      Math.ceil(Math.max(1, region.height || copy.height) / 8),
      1
    );
    pass.end();
  }
  if (options.submit !== false && !providedCommandEncoder) {
    device.queue?.submit?.([encoder.finish()]);
  }
  copy.initialized = true;
  return true;
}

function textureAirbrushRunWebGpuLayerDisplayComposite(device = null, composite = null, options = {}) {
  if (!device || !composite?.pipeline || !composite.bindGroup) {
    return false;
  }
  const providedCommandEncoder = options.commandEncoder || null;
  const encoder = providedCommandEncoder || device.createCommandEncoder({
    label: `${options.label || "texture-airbrush-layer-display"}-command-encoder`
  });
  const regions = Array.isArray(composite.updatedDisplayRegions) && composite.updatedDisplayRegions.length
    ? composite.updatedDisplayRegions
    : [composite.updatedDisplayBounds || textureAirbrushFullDirtyBounds(composite.width, composite.height)];
  const bindGroups = Array.isArray(composite.updatedDisplayRegionBindGroups) && composite.updatedDisplayRegionBindGroups.length
    ? composite.updatedDisplayRegionBindGroups
    : [composite.bindGroup];
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index] || composite.updatedDisplayBounds || textureAirbrushFullDirtyBounds(composite.width, composite.height);
    const pass = encoder.beginComputePass({
      label: `${options.label || "texture-airbrush-layer-display"}-compute-pass`
    });
    pass.setPipeline(composite.pipeline);
    pass.setBindGroup(0, bindGroups[index] || composite.bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(Math.max(1, region.width || composite.width) / 8),
      Math.ceil(Math.max(1, region.height || composite.height) / 8),
      1
    );
    pass.end();
  }
  if (options.submit !== false && !providedCommandEncoder) {
    device.queue?.submit?.([encoder.finish()]);
  }
  composite.initialized = true;
  return true;
}

function textureAirbrushUpdateImageDataBounds(imageData = null, pixels = null, layout = null) {
  const imageWidth = Math.max(0, Math.floor(Number(imageData?.width) || 0));
  const imageHeight = Math.max(0, Math.floor(Number(imageData?.height) || 0));
  if (
    !textureAirbrushImageDataMatchesSize(imageData, imageWidth, imageHeight)
    || !pixels
    || !layout
  ) {
    return null;
  }
  const x = Math.max(0, Math.floor(Number(layout.x) || 0));
  const y = Math.max(0, Math.floor(Number(layout.y) || 0));
  const width = Math.max(0, Math.floor(Number(layout.width) || 0));
  const height = Math.max(0, Math.floor(Number(layout.height) || 0));
  const byteLength = width * height * 4;
  if (
    !width
    || !height
    || x + width > imageWidth
    || y + height > imageHeight
    || pixels.byteLength !== byteLength
  ) {
    return null;
  }
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * width * 4;
    const targetOffset = ((y + row) * imageData.width + x) * 4;
    imageData.data.set(pixels.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }
  return imageData;
}

function textureAirbrushCachedStrokeSourceCurrent(cache = null, width = 0, height = 0) {
  return textureAirbrushImageDataMatchesSize(cache?.strokeSourceImageData, width, height);
}

function textureAirbrushEnsureStrokeSourceImageData(cache = null, editable = null) {
  if (!cache || textureAirbrushImageDataMatchesSize(cache.strokeSourceImageData, cache.width, cache.height)) {
    return cache?.strokeSourceImageData || null;
  }
  const source = textureAirbrushSourcePixelsFromEditable(editable);
  if (
    !source?.imageData
    || source.imageData.width !== cache.width
    || source.imageData.height !== cache.height
  ) {
    return null;
  }
  cache.strokeSourceImageData = source.imageData;
  cache.gpuStrokeSourceImageData = source.imageData;
  cache.strokeSourceMatchesSource = true;
  return source.imageData;
}

function textureAirbrushRecordEditableWebGpuPaintStats(editor = null, stats = null) {
  if (!editor || !stats) {
    return stats;
  }
  editor.textureAirbrushLastWebGpuPaintStats = stats;
  if (!Array.isArray(editor.textureAirbrushWebGpuPaintStats)) {
    editor.textureAirbrushWebGpuPaintStats = [];
  }
  editor.textureAirbrushWebGpuPaintStats.push(stats);
  while (editor.textureAirbrushWebGpuPaintStats.length > TEXTURE_AIRBRUSH_WEBGPU_PAINT_STATS_LIMIT) {
    editor.textureAirbrushWebGpuPaintStats.shift();
  }
  return stats;
}

function textureAirbrushWebGpuCacheKeyForEditable(editable = null) {
  if (editable?.layerMode === true && editable?.canvas) {
    return editable.canvas;
  }
  const texture = editable?.texture || null;
  const displayReferenceTexture = texture?.userData?.textureAirbrushExternalWebGpuDisplay === true
    ? texture.userData.textureAirbrushWebGpuCanvasMap || null
    : null;
  return displayReferenceTexture || texture || editable?.canvas || editable || null;
}

function textureAirbrushDeferredReadbackStartGate(editor = null) {
  if (!editor) {
    return null;
  }
  let release = null;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const entry = {
    released: false,
    release() {
      if (entry.released) {
        return false;
      }
      entry.released = true;
      editor.textureAirbrushDeferredWebGpuReadbackStarts?.delete?.(entry);
      release();
      return true;
    }
  };
  editor.textureAirbrushDeferredWebGpuReadbackStarts ||= new Set();
  editor.textureAirbrushDeferredWebGpuReadbackStarts.add(entry);
  return {
    promise,
    release: entry.release
  };
}

export function textureAirbrushReleaseDeferredWebGpuReadbackStarts(editor = null) {
  const entries = [...(editor?.textureAirbrushDeferredWebGpuReadbackStarts || [])];
  let released = 0;
  for (const entry of entries) {
    if (entry?.release?.()) {
      released += 1;
    }
  }
  return released;
}

export function textureAirbrushCancelDeferredWebGpuCanvasSync(editor = null) {
  const caches = [...(editor?.textureAirbrushDeferredWebGpuCanvasSyncCaches || [])];
  let cancelled = 0;
  for (const cache of caches) {
    if (!cache) {
      continue;
    }
    cache.deferredCanvasSyncGeneration = Math.max(
      0,
      Math.floor(Number(cache.deferredCanvasSyncGeneration) || 0)
    ) + 1;
    const sync = cache.deferredCanvasSync || null;
    if (sync) {
      sync.cancelled = true;
      for (const copy of sync.readbackCopies || []) {
        copy?.readbackBuffer?.destroy?.();
      }
      cancelled += 1;
    }
    delete cache.deferredCanvasSync;
    cache.deferredReadbackApplyPending = false;
    cache.deferredReadbackApplyToken = null;
  }
  if (editor) {
    editor.textureAirbrushDeferredWebGpuCanvasSyncCaches = new Set();
  }
  return cancelled;
}

function textureAirbrushQueueDeferredWebGpuCanvasSync(editor = null, editable = null, cache = null, prepared = null, run = null, options = {}) {
  const layout = run?.result?.readbackLayout || prepared?.payload?.plan?.buffers?.readback?.layout || null;
  const bounds = textureAirbrushDirtyBoundsFromLayout(layout);
  if (!editor || !cache || !editable || !bounds || !run?.resources?.sourceTexture) {
    debugCanvasWebGpuAirbrush("canvas-sync-skip", {
      hasEditor: Boolean(editor),
      hasCache: Boolean(cache),
      hasEditable: Boolean(editable),
      hasBounds: Boolean(bounds),
      hasSourceTexture: Boolean(run?.resources?.sourceTexture)
    });
    return null;
  }
  const existing = cache.deferredCanvasSync || null;
  cache.deferredCanvasSyncGeneration = Math.max(
    0,
    Math.floor(Number(cache.deferredCanvasSyncGeneration) || 0)
  );
  const sync = existing || {
    editable,
    width: prepared.width,
    height: prepared.height,
    materials: new Set(),
    bounds: null,
    priorityBounds: null,
    priorityPoints: [],
    regions: [],
    visibilitySampleCount: 0,
    visibilityTriangleCount: 0,
    screenProjectedCoverageActive: false,
    screenProjectedStrokeSegmentCount: 0,
    visibilityMaskBytes: 0,
    liveDisplayExternalTexture: false,
    liveDisplayFullUpdate: null,
    liveDisplayWorkPixels: 0,
    liveDisplayBounds: null,
    liveDisplayMipmapDirty: null,
    liveDisplayMipmapDeferred: false,
    liveDisplayMipmapPixels: 0,
    liveDisplayMipmapDowngraded: false,
    reusedResources: false,
    strokeSourceUploaded: false,
    sourceUploaded: false
  };
  sync.cancelled = false;
  sync.generation = cache.deferredCanvasSyncGeneration;
  const requestedSyncRegions = textureAirbrushNormalizeDirtyRegions(
    options.deferredCanvasSyncRegions || [],
    prepared.width,
    prepared.height
  );
  const requestedPriorityBounds = textureAirbrushUnionDirtyBounds(
    null,
    options.deferredCanvasSyncPriorityBounds || options.paintBounds || null,
    prepared.width,
    prepared.height
  );
  const requestedPriorityPoints = textureAirbrushNormalizePriorityPoints(
    options.deferredCanvasSyncPriorityPoints || [],
    prepared.width,
    prepared.height
  );
  const syncRegions = requestedSyncRegions.length ? requestedSyncRegions : [bounds];
  const syncBounds = textureAirbrushUnionDirtyRegions(syncRegions, prepared.width, prepared.height) || bounds;
  const liveDisplayStats = options.liveDisplayStats || null;
  const liveMipmapStats = liveDisplayStats?.mipmapStats || null;
  const previousSourceRevision = Math.max(0, Math.floor(Number(sync.sourceRevision) || 0));
  const currentSourceRevision = Math.max(0, Math.floor(Number(cache.gpuSourceRevision) || 0));
  if (
    currentSourceRevision > previousSourceRevision
    && Array.isArray(sync.readbackCopies)
    && sync.readbackCopies.length
  ) {
    for (const copy of sync.readbackCopies) {
      copy?.readbackBuffer?.destroy?.();
    }
    sync.readbackCopies = [];
  }
  sync.editable = editable;
  sync.width = prepared.width;
  sync.height = prepared.height;
  sync.bounds = textureAirbrushUnionDirtyBounds(sync.bounds, syncBounds, prepared.width, prepared.height);
  sync.priorityBounds = textureAirbrushUnionDirtyBounds(
    sync.priorityBounds,
    requestedPriorityBounds,
    prepared.width,
    prepared.height
  );
  if (requestedPriorityPoints.length) {
    sync.priorityPoints = [
      ...(Array.isArray(sync.priorityPoints) ? sync.priorityPoints : []),
      ...requestedPriorityPoints
    ].slice(-128);
  }
  for (const region of syncRegions) {
    sync.regions = textureAirbrushMergeDeferredSyncRegions(sync.regions, region, prepared.width, prepared.height);
  }
  sync.visibilitySampleCount = Math.max(sync.visibilitySampleCount, prepared.payload?.params?.visibilitySampleCount || 0);
  sync.visibilityTriangleCount = Math.max(sync.visibilityTriangleCount, prepared.payload?.params?.visibilityTriangleCount || 0);
  sync.screenProjectedCoverageActive = sync.screenProjectedCoverageActive
    || prepared.payload?.plan?.screenProjectedCoverageActive === true;
  sync.screenProjectedStrokeSegmentCount = Math.max(
    sync.screenProjectedStrokeSegmentCount || 0,
    prepared.payload?.plan?.screenProjectedStrokeSegmentCount || 0
  );
  sync.visibilityMaskBytes = Math.max(
    sync.visibilityMaskBytes,
    textureAirbrushPixelPayloadByteLength(options.visibilityMaskPixels)
  );
  sync.sourceRevision = Math.max(
    previousSourceRevision,
    currentSourceRevision
  );
  sync.liveDisplayExternalTexture = sync.liveDisplayExternalTexture || options.liveDisplayExternalTexture === true;
  if (liveDisplayStats) {
    sync.liveDisplayFullUpdate = liveDisplayStats.displayFullUpdate === true
      ? true
      : liveDisplayStats.displayFullUpdate === false
        ? false
        : sync.liveDisplayFullUpdate;
    sync.liveDisplayWorkPixels = Math.max(0, Math.floor(Number(liveDisplayStats.displayWorkPixels) || 0));
    sync.liveDisplayBounds = textureAirbrushUnionDirtyBounds(
      null,
      liveDisplayStats.displayBounds || null,
      prepared.width,
      prepared.height
    ) || sync.liveDisplayBounds;
  }
  if (liveMipmapStats) {
    sync.liveDisplayMipmapDirty = sync.liveDisplayMipmapDirty === true || liveMipmapStats.dirty === true
      ? true
      : sync.liveDisplayMipmapDirty === false || liveMipmapStats.dirty === false
        ? false
        : null;
    sync.liveDisplayMipmapPixels = Math.max(
      sync.liveDisplayMipmapPixels || 0,
      Number(liveMipmapStats.pixels) || 0
    );
    sync.liveDisplayMipmapDeferred = sync.liveDisplayMipmapDeferred || liveMipmapStats.deferred === true;
    sync.liveDisplayMipmapDowngraded = sync.liveDisplayMipmapDowngraded || liveDisplayStats?.mipmapDowngraded === true;
  }
  sync.reusedResources = sync.reusedResources || options.reusedResources === true;
  sync.strokeSourceUploaded = sync.strokeSourceUploaded || options.refreshStrokeSource === true;
  sync.sourceUploaded = sync.sourceUploaded || options.refreshSource === true;
  if (options.material) {
    sync.materials.add(options.material);
  }
  // Keep the live stroke path GPU-only. The source texture already contains
  // the accumulated paint, so the CPU canvas catch-up can copy final dirty
  // regions when idle instead of creating a readback buffer for every packet.
  if (options.deferReadbackPrecopy === true) {
    const precopyRegions = textureAirbrushTileDeferredSyncRegions(
      syncRegions,
      prepared.width,
      prepared.height,
      options
    );
    const precopyBytes = precopyRegions.reduce((total, region) => (
      total + textureAirbrushReadbackDescriptorSize(prepared.width, prepared.height, region)
    ), 0);
    if (precopyBytes <= textureAirbrushDeferredCanvasSyncPrecopyMaxBytes(options)) {
      for (let regionIndex = 0; regionIndex < precopyRegions.length; regionIndex += 1) {
        const copy = textureAirbrushCopySourceTextureToReadback(cache.device, cache.resources, {
          width: prepared.width,
          height: prepared.height,
          bounds: precopyRegions[regionIndex]
        }, {
          label: `${options.label || "texture-airbrush-deferred-sync"}-precopy-${regionIndex}`,
          sourceRevision: sync.sourceRevision
        });
        if (copy) {
          copy.deferredPrecopy = true;
          copy.destroyAfterRead = true;
          sync.readbackCopies ||= [];
          sync.readbackCopies.push(copy);
        }
      }
    }
  }
  cache.deferredCanvasSync = sync;
  cache.deferredReadbackApplyPending = true;
  editor.textureAirbrushDeferredWebGpuCanvasSyncCaches ||= new Set();
  editor.textureAirbrushDeferredWebGpuCanvasSyncCaches.add(cache);
  debugCanvasWebGpuAirbrush("canvas-sync-queued", {
    width: prepared.width,
    height: prepared.height,
    bounds: sync.bounds,
    priorityBounds: sync.priorityBounds,
    priorityPointCount: sync.priorityPoints?.length || 0,
    firstPriorityPoint: sync.priorityPoints?.[0] || null,
    lastPriorityPoint: sync.priorityPoints?.at?.(-1) || null,
    regionCount: sync.regions.length,
    readbackCopyCount: sync.readbackCopies?.length || 0,
    sourceRevision: sync.sourceRevision ?? null,
    liveDisplayExternalTexture: sync.liveDisplayExternalTexture === true,
    liveDisplayWorkPixels: sync.liveDisplayWorkPixels || 0
  });
  return sync;
}

function textureAirbrushWebGpuBufferMatchesDescriptor(buffer = null, descriptor = null) {
  if (!buffer || !descriptor) {
    return false;
  }
  const size = Number(buffer.desc?.size ?? buffer.size ?? 0);
  const usage = Number(buffer.desc?.usage ?? buffer.usage ?? 0);
  return size === descriptor.size && usage === descriptor.usage;
}

function textureAirbrushCopySourceTextureToReadback(device = null, resources = null, sync = null, options = {}) {
  if (!device || !resources?.sourceTexture || !sync?.bounds) {
    return null;
  }
  const descriptor = textureAirbrushWebGpuReadbackBufferDescriptor(sync.width, sync.height, globalThis, sync.bounds);
  const reusedReadbackBuffer = textureAirbrushWebGpuBufferMatchesDescriptor(sync.readbackBuffer, descriptor);
  const buffer = reusedReadbackBuffer
    ? sync.readbackBuffer
    : device.createBuffer({
        label: `${options.label || "texture-airbrush-deferred-sync"}-readback-buffer`,
        size: descriptor.size,
        usage: descriptor.usage
      });
  sync.readbackBuffer = buffer;
  const layout = descriptor.layout;
  const commandEncoder = options.commandEncoder || device.createCommandEncoder({
    label: `${options.label || "texture-airbrush-deferred-sync"}-command-encoder`
  });
  commandEncoder.copyTextureToBuffer(
    {
      texture: resources.sourceTexture,
      origin: {
        x: layout.x || 0,
        y: layout.y || 0,
        z: 0
      }
    },
    {
      buffer,
      bytesPerRow: layout.bytesPerRow,
      rowsPerImage: layout.rowsPerImage
    },
    {
      width: layout.width,
      height: layout.height,
      depthOrArrayLayers: 1
    }
  );
  if (options.submit !== false) {
    device.queue?.submit?.([commandEncoder.finish()]);
  }
  return {
    readbackBuffer: buffer,
    readbackLayout: layout,
    reusedReadbackBuffer,
    sourceRevision: Math.max(0, Math.floor(Number(options.sourceRevision) || 0))
  };
}

function textureAirbrushCreateDeferredReadbackWork(cache = null, sync = null, regions = [], options = {}) {
  const device = cache?.device || null;
  if (!device || !cache?.resources || !Array.isArray(regions) || !regions.length) {
    return [];
  }
  if (regions.length === 1 || options.batchDeferredCanvasReadbacks === false) {
    return regions.map((region, regionIndex) => {
      const regionSync = {
        ...sync,
        bounds: region,
        readbackBuffer: sync.readbackBuffer || cache.deferredReadbackBuffer || null
      };
      const startMs = textureAirbrushNow(options);
      const result = textureAirbrushCopySourceTextureToReadback(device, cache.resources, regionSync, {
        label: `${options.label || "texture-airbrush-deferred-sync"}-${regionIndex}`,
        sourceRevision: Math.max(
          Math.max(0, Math.floor(Number(cache.gpuSourceRevision) || 0)),
          Math.max(0, Math.floor(Number(sync.sourceRevision) || 0))
        )
      });
      if (result) {
        sync.readbackBuffer = regionSync.readbackBuffer || sync.readbackBuffer || null;
        cache.deferredReadbackBuffer = regionSync.readbackBuffer || cache.deferredReadbackBuffer || null;
      }
      return {
        region,
        result,
        preCopied: true,
        copyStartMs: startMs,
        copyEndMs: textureAirbrushNow(options)
      };
    }).filter((work) => work.result?.readbackBuffer && work.result?.readbackLayout);
  }

  const commandEncoder = device.createCommandEncoder({
    label: `${options.label || "texture-airbrush-deferred-sync"}-batch-command-encoder`
  });
  const copyStartMs = textureAirbrushNow(options);
  const work = regions.map((region, regionIndex) => {
    const regionSync = {
      ...sync,
      bounds: region,
      readbackBuffer: null
    };
    const result = textureAirbrushCopySourceTextureToReadback(device, cache.resources, regionSync, {
      commandEncoder,
      submit: false,
      label: `${options.label || "texture-airbrush-deferred-sync"}-${regionIndex}`,
      sourceRevision: Math.max(
        Math.max(0, Math.floor(Number(cache.gpuSourceRevision) || 0)),
        Math.max(0, Math.floor(Number(sync.sourceRevision) || 0))
      )
    });
    if (result) {
      result.destroyAfterRead = true;
      result.deferredBatchCopy = true;
    }
    return {
      region,
      result,
      preCopied: true,
      copyStartMs,
      copyEndMs: copyStartMs
    };
  }).filter((entry) => entry.result?.readbackBuffer && entry.result?.readbackLayout);
  if (work.length) {
    device.queue?.submit?.([commandEncoder.finish()]);
    const copyEndMs = textureAirbrushNow(options);
    for (const entry of work) {
      entry.copyEndMs = copyEndMs;
    }
  }
  return work;
}

export async function textureAirbrushSyncDeferredWebGpuCanvasReadbacks(editor = null, options = {}) {
  const caches = [...(editor?.textureAirbrushDeferredWebGpuCanvasSyncCaches || [])];
  if (!editor || !caches.length) {
    return [];
  }
  debugCanvasWebGpuAirbrush("canvas-sync-start", {
    cacheCount: caches.length,
    deferCanvasSyncUntilIdle: options.deferCanvasSyncUntilIdle === true,
    canvasSyncApplyBudgetMs: Number.isFinite(Number(options.canvasSyncApplyBudgetMs))
      ? Number(options.canvasSyncApplyBudgetMs)
      : null
  });
  editor.textureAirbrushDeferredWebGpuCanvasSyncCaches = new Set();
  const results = [];
  for (const cache of caches) {
    const sync = cache?.deferredCanvasSync || null;
    delete cache.deferredCanvasSync;
    if (!sync?.editable || !sync.bounds || !cache?.resources?.sourceTexture) {
      if (cache) {
        cache.deferredReadbackApplyPending = false;
      }
      continue;
    }
    const syncIsCancelled = () => Boolean(
      sync.cancelled === true
      || (
        cache
        && Math.max(0, Math.floor(Number(sync.generation) || 0))
          !== Math.max(0, Math.floor(Number(cache.deferredCanvasSyncGeneration) || 0))
      )
    );
    if (syncIsCancelled()) {
      if (cache) {
        cache.deferredReadbackApplyPending = false;
        cache.deferredReadbackApplyToken = null;
      }
      continue;
    }
    const regions = (Array.isArray(sync.regions) && sync.regions.length ? sync.regions : [sync.bounds])
      .map((bounds) => textureAirbrushUnionDirtyBounds(null, bounds, sync.width, sync.height))
      .filter(Boolean);
    const readbackCopies = Array.isArray(sync.readbackCopies)
      ? sync.readbackCopies.filter((copy) => copy?.readbackBuffer && copy?.readbackLayout)
      : [];
    const preCopiedWork = readbackCopies.map((copy) => ({
      result: copy,
      region: textureAirbrushDirtyBoundsFromLayout(copy.readbackLayout),
      preCopied: true,
      copyStartMs: null,
      copyEndMs: null
    })).filter((work) => work.region);
    const preCopiedRegions = preCopiedWork.map((work) => work.region).filter(Boolean);
    const regionsNeedingReadback = regions.filter((region) => !textureAirbrushBoundsCoveredByRegions(
      region,
      preCopiedRegions
    ));
    const syncTileOptions = sync.liveDisplayExternalTexture === true
      ? { ...options, liveDisplayExternalTexture: true }
      : options;
    const tiledRegionsNeedingReadback = textureAirbrushTileDeferredSyncRegions(
      regionsNeedingReadback,
      sync.width,
      sync.height,
      {
        ...syncTileOptions,
        returnAllDeferredCanvasSyncTiles: true
      }
    );
    const prioritizedTiledRegionsNeedingReadback = textureAirbrushPrioritizeReadbackRegions(
      tiledRegionsNeedingReadback,
      sync.priorityBounds || sync.liveDisplayBounds || sync.bounds,
      sync.width,
      sync.height,
      sync.priorityPoints || []
    );
    const explicitMaxReadbackRegions = Object.prototype.hasOwnProperty.call(
      syncTileOptions,
      "deferredCanvasSyncMaxTiles"
    ) && syncTileOptions.deferredCanvasSyncMaxTiles !== false;
    const shouldCapReadbackRegions = syncTileOptions.deferCanvasSyncUntilIdle === true
      || explicitMaxReadbackRegions;
    const maxReadbackRegions = shouldCapReadbackRegions
      ? textureAirbrushDeferredCanvasSyncMaxTiles(syncTileOptions)
      : Infinity;
    const countLimitedReadbackRegions = Number.isFinite(maxReadbackRegions)
      ? prioritizedTiledRegionsNeedingReadback.slice(0, maxReadbackRegions)
      : prioritizedTiledRegionsNeedingReadback;
    const debugFullSnapshotSync = textureAirbrushDebugSnapshotFullSyncRequested();
    const activeLiveReadbackBudgetBytes = syncTileOptions.liveDisplayExternalTexture === true
      && syncTileOptions.deferCanvasSyncUntilIdle !== true
      && !explicitMaxReadbackRegions
      && !debugFullSnapshotSync
      ? textureAirbrushDeferredCanvasSyncTileBytes(syncTileOptions)
      : Infinity;
    const generatedReadbackRegions = textureAirbrushTakeReadbackRegionsWithinBudget(
      countLimitedReadbackRegions,
      sync.width,
      sync.height,
      activeLiveReadbackBudgetBytes
    );
    const deferredReadbackRegions = prioritizedTiledRegionsNeedingReadback.length > generatedReadbackRegions.length
      ? prioritizedTiledRegionsNeedingReadback.slice(generatedReadbackRegions.length)
      : [];
    const generatedWork = textureAirbrushCreateDeferredReadbackWork(
      cache,
      sync,
      generatedReadbackRegions,
      options
    );
    const readbackWork = [
      ...generatedWork,
      ...preCopiedWork.filter((work) => !textureAirbrushBoundsCoveredByRegions(
        work.region,
        generatedWork.map((generated) => generated.region).filter(Boolean)
      ))
    ];
    debugCanvasWebGpuAirbrush("canvas-sync-cache", {
      width: sync.width,
      height: sync.height,
      bounds: sync.bounds,
      priorityBounds: sync.priorityBounds || null,
      priorityPointCount: sync.priorityPoints?.length || 0,
      firstPriorityPoint: sync.priorityPoints?.[0] || null,
      lastPriorityPoint: sync.priorityPoints?.at?.(-1) || null,
      regionCount: regions.length,
      tiledReadbackRegionCount: tiledRegionsNeedingReadback.length,
      prioritizedReadbackRegionCount: prioritizedTiledRegionsNeedingReadback.length,
      generatedReadbackRegionCount: generatedReadbackRegions.length,
      deferredReadbackRegionCount: deferredReadbackRegions.length,
      readbackWorkCount: readbackWork.length,
      preCopiedCount: readbackCopies.length,
      liveDisplayExternalTexture: sync.liveDisplayExternalTexture === true
    });
    let imageData = textureAirbrushImageDataMatchesSize(cache.strokeSourceImageData, sync.width, sync.height)
      ? cache.strokeSourceImageData
      : null;
    let anyApplied = false;
    for (const material of sync.materials || []) {
      if (material) {
        material.needsUpdate = true;
      }
    }
    const explicitApplyBudgetMs = Number(options.canvasSyncApplyBudgetMs);
    const applyBudgetMs = Number.isFinite(explicitApplyBudgetMs)
      ? Math.max(0, explicitApplyBudgetMs)
      : sync.liveDisplayExternalTexture === true
        ? TEXTURE_AIRBRUSH_DEFERRED_LIVE_CANVAS_SYNC_APPLY_BUDGET_MS
        : 0;
    let syncSliceStartMs = textureAirbrushNow(options);
    let debugSnapshotBounds = null;
    let debugSnapshotBytes = 0;
    for (let mappedIndex = 0; mappedIndex < readbackWork.length; mappedIndex += 1) {
      const work = readbackWork[mappedIndex];
      const region = work.region || textureAirbrushDirtyBoundsFromLayout(work.result?.readbackLayout);
      const startMs = work.copyStartMs || textureAirbrushNow(options);
      const dispatchMs = work.copyEndMs || startMs;
      const result = work.result || null;
      if (syncIsCancelled()) {
        result?.readbackBuffer?.destroy?.();
        continue;
      }
      const pixels = await textureAirbrushReadWebGpuPaintResult(result, options);
      if (syncIsCancelled()) {
        if (result?.destroyAfterRead === true) {
          result.readbackBuffer?.destroy?.();
        }
        continue;
      }
      if (result?.destroyAfterRead === true) {
        result.readbackBuffer?.destroy?.();
      }
      const readbackMs = textureAirbrushNow(options);
      const updatedStrokeSourceImageData = textureAirbrushUpdateImageDataBounds(
        imageData,
        pixels,
        result?.readbackLayout
      );
      const applied = textureAirbrushApplyPixelsToEditable(sync.editable, pixels, {
        imageData,
        material: null,
        bounds: result?.readbackLayout,
        reusableImageData: cache.applyImageData || null
      });
      if (cache && applied?.putImageData) {
        cache.applyImageData = applied.putImageData;
      }
      if (applied) {
        anyApplied = true;
        debugSnapshotBounds = textureAirbrushUnionDirtyBounds(
          debugSnapshotBounds,
          {
            x: applied.x,
            y: applied.y,
            width: applied.width,
            height: applied.height
          },
          sync.width,
          sync.height
        );
        debugSnapshotBytes += Math.max(0, Number(applied.byteLength) || 0);
        if (textureAirbrushImageDataMatchesSize(applied.imageData, sync.width, sync.height)) {
          imageData = applied.imageData;
        } else if (updatedStrokeSourceImageData) {
          imageData = updatedStrokeSourceImageData;
        }
      }
      const applyMs = textureAirbrushNow(options);
      const stats = textureAirbrushRecordEditableWebGpuPaintStats(editor, {
        width: sync.width,
        height: sync.height,
        dirtyBounds: textureAirbrushDirtyBoundsFromLayout(result?.readbackLayout),
        dispatch: null,
        sourceUploaded: sync.sourceUploaded,
        strokeSourceUploaded: sync.strokeSourceUploaded,
        visibilitySampleCount: sync.visibilitySampleCount,
        visibilityTriangleCount: sync.visibilityTriangleCount,
        screenProjectedCoverageActive: sync.screenProjectedCoverageActive === true,
        screenProjectedStrokeSegmentCount: sync.screenProjectedStrokeSegmentCount || 0,
        visibilityMaskBytes: sync.visibilityMaskBytes,
        liveDisplayExternalTexture: sync.liveDisplayExternalTexture,
        liveDisplayFullUpdate: sync.liveDisplayFullUpdate,
        liveDisplayWorkPixels: sync.liveDisplayWorkPixels || 0,
        liveDisplayBounds: sync.liveDisplayBounds || null,
        liveDisplayMipmapDirty: sync.liveDisplayMipmapDirty,
        liveDisplayMipmapDeferred: sync.liveDisplayMipmapDeferred === true,
        liveDisplayMipmapPixels: sync.liveDisplayMipmapPixels || 0,
        liveDisplayMipmapDowngraded: sync.liveDisplayMipmapDowngraded === true,
        sourceBytes: 0,
        strokeSourceBytes: 0,
        readbackBytes: pixels?.byteLength || 0,
        appliedBytes: applied?.byteLength || pixels?.byteLength || 0,
        reusedResources: sync.reusedResources,
        reusedReadbackBuffer: result?.reusedReadbackBuffer === true,
        reusedApplyImageData: applied?.reusedImageData === true,
        deferredReadback: true,
        deferredReadbackCopy: true,
        deferredCanvasSync: true,
        timings: {
          prepareMs: 0,
          dispatchMs: Math.max(0, dispatchMs - startMs),
          readbackMs: Math.max(0, readbackMs - dispatchMs),
          applyMs: Math.max(0, applyMs - readbackMs),
          totalMs: Math.max(0, applyMs - startMs)
        }
      });
      results.push({
        pixels,
        applied,
        stats
      });
      debugCanvasWebGpuAirbrush("canvas-sync-region", {
        region,
        readbackBytes: pixels?.byteLength || 0,
        applied: Boolean(applied),
        appliedBytes: applied?.byteLength || pixels?.byteLength || 0,
        reusedApplyImageData: applied?.reusedImageData === true
      });
      if (applyBudgetMs > 0 && mappedIndex < readbackWork.length - 1) {
        const syncSliceNowMs = textureAirbrushNow(options);
        if (syncSliceNowMs - syncSliceStartMs >= applyBudgetMs) {
          await textureAirbrushYieldDeferredCanvasSync(options);
          syncSliceStartMs = textureAirbrushNow(options);
        }
      }
    }
    if (cache) {
      if (syncIsCancelled()) {
        cache.deferredReadbackApplyPending = false;
        cache.deferredReadbackApplyToken = null;
      } else if (deferredReadbackRegions.length) {
        const followupBounds = textureAirbrushUnionDirtyRegions(deferredReadbackRegions, sync.width, sync.height);
        cache.deferredCanvasSync = {
          ...sync,
          bounds: followupBounds || sync.bounds,
          regions: deferredReadbackRegions,
          readbackCopies: []
        };
        editor.textureAirbrushDeferredWebGpuCanvasSyncCaches ||= new Set();
        editor.textureAirbrushDeferredWebGpuCanvasSyncCaches.add(cache);
      }
      if (anyApplied && textureAirbrushImageDataMatchesSize(imageData, sync.width, sync.height)) {
        cache.strokeSourceImageData = imageData;
        cache.strokeSourceMatchesSource = true;
      } else {
        cache.strokeSourceMatchesSource = false;
      }
      const hasFollowupSync = Boolean(cache.deferredCanvasSync);
      cache.deferredReadbackApplyPending = hasFollowupSync;
      if (!hasFollowupSync) {
        cache.deferredReadbackApplyToken = null;
      }
    }
    if (anyApplied && sync.editable?.layerMode === true && typeof editor.texturePaintCommitEditable === "function") {
      sync.editable.dirtyBounds = sync.bounds;
      try {
        for (const material of sync.materials || []) {
          editor.texturePaintCommitEditable(sync.editable, material, null, {
            refreshSpotlight: false,
            renderPanel: false,
            skipGpuTargetUpload: true,
            preserveWebGpuDisplay: sync.liveDisplayExternalTexture === true
          });
        }
      } finally {
        delete sync.editable.dirtyBounds;
      }
    }
    const debugPrioritySnapshotBounds = textureAirbrushPriorityPointSnapshotBounds(
      sync.priorityPoints || [],
      debugSnapshotBounds,
      sync.width,
      sync.height
    );
    textureAirbrushExposeDebugCanvasSnapshot(sync.editable, debugPrioritySnapshotBounds || debugSnapshotBounds || sync.bounds, {
      applied: anyApplied,
      deferredCanvasSync: true,
      byteLength: debugSnapshotBytes
    });
    debugCanvasWebGpuAirbrush("canvas-sync-applied", {
      anyApplied,
      resultCount: results.length,
      strokeSourceMatchesSource: cache?.strokeSourceMatchesSource === true,
      deferredReadbackApplyPending: cache?.deferredReadbackApplyPending === true
    });
  }
  return results;
}

function textureAirbrushAttachExternalWebGpuDisplay(editor = null, editable = null, cache = null, resources = null, prepared = null, options = {}) {
  const material = options.material || null;
  if (cache) {
    cache.lastLiveDisplayStats = null;
    cache.lastDirtyMipmapStats = null;
  }
  if (
    options.liveDisplayExternalTexture !== true
    || editor?.textureAirbrushExternalWebGpuDisplayEnabled === false
    || !material
    || !resources?.sourceTexture
  ) {
    debugCanvasWebGpuAirbrush("live-display-skip", {
      requested: options.liveDisplayExternalTexture === true,
      externalDisplayEnabled: editor?.textureAirbrushExternalWebGpuDisplayEnabled !== false,
      hasMaterial: Boolean(material),
      hasSourceTexture: Boolean(resources?.sourceTexture)
    });
    return null;
  }
  const referenceTexture = textureAirbrushLiveDisplayReferenceTexture(material, editable);
  const displayFlipY = referenceTexture?.flipY === true;
  const displayLinearizeSrgb = textureAirbrushTextureNeedsLiveLinearDisplay(referenceTexture);
  const displayMipmaps = options.liveDisplayMipmaps !== false;
  const requestedSourceDirtyBounds = textureAirbrushDirtyBoundsFromLayout(
    options.displayDirtyBounds || prepared?.payload?.plan?.paintBounds || null
  );
  const displayWidth = Math.max(1, Math.floor(Number(prepared?.width) || cache?.width || 1));
  const displayHeight = Math.max(1, Math.floor(Number(prepared?.height) || cache?.height || 1));
  const requestedSourceDirtyRegions = textureAirbrushNormalizeDirtyRegions(
    options.displayDirtyRegions || [],
    displayWidth,
    displayHeight
  );
  const includeDeferredDirtyRegions = options.liveDisplayIncludeDeferredDirtyRegions !== false;
  const deferredSourceDirtyRegions = includeDeferredDirtyRegions
    ? textureAirbrushNormalizeDirtyRegions(
        cache?.deferredLiveDisplayDirtyRegions || (
          cache?.deferredLiveDisplayDirtyBounds ? [cache.deferredLiveDisplayDirtyBounds] : []
        ),
        displayWidth,
        displayHeight
      )
    : [];
  let sourceDirtyRegions = deferredSourceDirtyRegions;
  if (requestedSourceDirtyRegions.length) {
    for (const region of requestedSourceDirtyRegions) {
      sourceDirtyRegions = textureAirbrushAppendDirtyRegion(sourceDirtyRegions, region, displayWidth, displayHeight);
    }
  } else if (requestedSourceDirtyBounds) {
    sourceDirtyRegions = textureAirbrushAppendDirtyRegion(sourceDirtyRegions, requestedSourceDirtyBounds, displayWidth, displayHeight);
  }
  if (options.liveDisplayIncludeDeferredDirtyRegions === false && requestedSourceDirtyRegions.length) {
    const nonFullDirtyRegions = sourceDirtyRegions.filter((region) => (
      !textureAirbrushDirtyBoundsIsFull(region, displayWidth, displayHeight)
    ));
    if (nonFullDirtyRegions.length) {
      sourceDirtyRegions = nonFullDirtyRegions;
    }
  }
  const sourceDirtyBounds = textureAirbrushUnionDirtyRegions(sourceDirtyRegions, displayWidth, displayHeight)
    || textureAirbrushUnionDirtyBounds(
      cache?.deferredLiveDisplayDirtyBounds || null,
      requestedSourceDirtyBounds,
      displayWidth,
      displayHeight
    );
  const hasLiveDisplayDirtyWork = Boolean(sourceDirtyBounds) || sourceDirtyRegions.length > 0;
  if (
    !hasLiveDisplayDirtyWork
    && cache?.externalDisplayTexture
    && cache.externalDisplayGpuTexture
  ) {
    cache.lastLiveDisplayStats = {
      displayWorkPixels: 0,
      displayFullUpdate: false,
      displayBounds: null,
      displayRegions: null,
      mipmapStats: null
    };
    debugCanvasWebGpuAirbrush("live-display", {
      mode: "reuse",
      operationLabel: options.label || "",
      displaySourceKind: "no-dirty-work",
      materialName: material.name || "",
      referenceName: textureAirbrushLiveDisplayReferenceTexture(material, editable)?.name || "",
      width: displayWidth,
      height: displayHeight,
      displayFlipY: null,
      displayLinearizeSrgb: null,
      displayMipmaps: options.liveDisplayMipmaps !== false,
      sourceMipLevelCount: null,
      sourceTextureCanCarryDisplayTransform: null,
      needsDisplayCopy: null,
      displayMipmapsGenerated: false,
      displayMipmapsUsable: true,
      displayMipmapsDeferred: false,
      materialMapAlreadyReusable: material.map === cache.externalDisplayTexture,
      materialNeedsUpdate: material.needsUpdate === true,
      liveDisplayWorkPixels: 0,
      liveDisplayBounds: null,
      liveDisplayRegions: null,
      liveDisplayRegionCount: 0,
      displayFullUpdate: false,
      liveDisplayMipmapPixels: 0
    });
    return cache.externalDisplayTexture;
  }
  const useSourceDirtyRegions = textureAirbrushUseDirtyRegions(
    sourceDirtyRegions,
    sourceDirtyBounds,
    displayWidth,
    displayHeight
  );
  const forceSourceDirtyRegions = sourceDirtyRegions.length > 1
    && (
      options.forceLiveDisplayDirtyRegions === true
      || deferredSourceDirtyRegions.length > 0
    );
  const activeSourceDirtyRegions = (useSourceDirtyRegions || forceSourceDirtyRegions) ? sourceDirtyRegions : null;
  let displayMipmapsGenerated = false;
  let gpuTexture = resources.sourceTexture;
  let liveDisplayStats = null;
  const device = cache?.device || options.device || editor?.textureAirbrushWebGpuDevice?.();
  const sourceMipLevelCount = Math.max(
    1,
    Math.floor(Number(
      resources.sourceTextureMipLevelCount
      ?? resources.sourceTexture?.mipLevelCount
      ?? 1
    ) || 1)
  );
  const displayMipLevelCountForTexture = (texture = null, fallback = null) => {
    if (texture === resources.sourceTexture) {
      return sourceMipLevelCount;
    }
    return textureAirbrushGpuTextureMipLevelCount(texture, fallback ? { mipLevelCount: fallback } : {});
  };
  const copyDirectSourceForMipmappedDisplay = displayMipmaps
    && sourceMipLevelCount <= 1
    && editable?.layerMode !== true
    && !displayFlipY
    && !displayLinearizeSrgb;
  const sourceTextureCanCarryDisplayTransform = sourceMipLevelCount > 1
    && editable?.layerMode !== true
    && !displayFlipY
    && !displayLinearizeSrgb
    && options.directSourceDisplayTransform !== false;
  const needsDisplayCopy = !sourceTextureCanCarryDisplayTransform
    && (displayFlipY || displayLinearizeSrgb || copyDirectSourceForMipmappedDisplay);
  let displaySourceKind = "source";
  const refreshDisplayMipmaps = (
    dirtyBounds = null,
    mipLevelCount = displayMipLevelCountForTexture(gpuTexture),
    dirtyRegions = null
  ) => {
    if (!displayMipmaps) {
      return false;
    }
    const normalizedDirtyRegions = textureAirbrushNormalizeDirtyRegions(dirtyRegions || [], displayWidth, displayHeight);
    const forceDirtyRegions = (
      options.forceLiveDisplayDirtyRegions === true
      || forceSourceDirtyRegions
    )
      && normalizedDirtyRegions.length > 1;
    const activeDirtyRegions = (forceDirtyRegions || textureAirbrushUseDirtyRegions(
      normalizedDirtyRegions,
      dirtyBounds,
      displayWidth,
      displayHeight
    ))
      ? normalizedDirtyRegions
      : null;
    const mipmapOptions = {
      ...options,
      cache,
      width: displayWidth,
      height: displayHeight,
      mipLevelCount,
      dirtyBounds,
      ...(activeDirtyRegions ? { dirtyRegions: activeDirtyRegions } : { dirtyRegions: null })
    };
    const reusableDisplay = cache?.externalDisplayGpuTexture === gpuTexture
      ? cache.externalDisplayTexture
      : null;
    const reusableDisplayHasValidMipmaps = reusableDisplay?.userData?.textureAirbrushDisplayMipmapped === true
      && reusableDisplay.generateMipmaps === true;
    const reusableDisplayCanDeferMipmaps = Boolean(reusableDisplay)
      && (
        reusableDisplayHasValidMipmaps
        || reusableDisplay?.userData?.textureAirbrushExternalWebGpuDisplay === true
      );
    const fullMipmapRefresh = Boolean(dirtyBounds)
      && textureAirbrushDirtyBoundsIsFull(dirtyBounds, displayWidth, displayHeight)
      && !activeDirtyRegions;
    const explicitImmediateBudget = Number(
      options.liveDisplayMipmapImmediatePixels ?? options.liveDisplayImmediateMipmapPixels
    );
    const explicitFullMipmapDeferral = Number.isFinite(explicitImmediateBudget)
      && explicitImmediateBudget <= 0
      && options.forceLiveDisplayDirtyRegions !== true;
    if (
      options.deferLiveDisplayMipmaps === true
      && (reusableDisplayCanDeferMipmaps || Boolean(cache?.externalDisplayTexture))
      && (!fullMipmapRefresh || explicitFullMipmapDeferral)
    ) {
      if (textureAirbrushShouldGenerateLiveDisplayMipmapsNow(
        dirtyBounds,
        displayWidth,
        displayHeight,
        mipmapOptions
      )) {
        const immediateDirtyMipmaps = textureAirbrushGenerateWebGpuDisplayMipmaps(editor, gpuTexture, {
          ...mipmapOptions
        });
        if (immediateDirtyMipmaps === true) {
          return true;
        }
      }
      textureAirbrushScheduleDeferredDisplayMipmaps(editor, cache, gpuTexture, {
        ...mipmapOptions,
        editable,
      });
      return false;
    }
    return textureAirbrushGenerateWebGpuDisplayMipmaps(editor, gpuTexture, {
      ...mipmapOptions
    });
  };
  if (editable?.layerMode === true) {
    const layerCompositeSource = textureAirbrushWebGpuLayerCompositeSource(editable);
    if (!layerCompositeSource) {
      return null;
    }
    const composite = textureAirbrushEnsureWebGpuLayerCompositeResources(
      device,
      cache,
      layerCompositeSource,
      resources.sourceTexture,
      {
        ...options,
        displayFlipY,
        displayLinearizeSrgb,
        displayMipmaps,
        displayDirtyBounds: sourceDirtyBounds,
        ...(activeSourceDirtyRegions ? { displayDirtyRegions: activeSourceDirtyRegions } : {}),
        preserveDisplayOnSourceTextureChange: deferredSourceDirtyRegions.length > 0
          || options.liveDisplayIncludeDeferredDirtyRegions === false,
        ...(forceSourceDirtyRegions ? { forceDisplayDirtyRegions: true } : {})
      }
    );
    if (
      cache?.externalDisplayTexture
      && Number.isFinite(Number(options.maxLiveDisplayWorkPixels))
      && composite?.displayWorkPixels > Math.max(1, Number(options.maxLiveDisplayWorkPixels))
    ) {
      cache.lastLiveDisplayStats = {
        displayWorkPixels: 0,
        displayFullUpdate: false,
        displayBounds: composite.updatedDisplayBounds || null,
        displayRegions: composite.updatedDisplayRegions || null,
        displayRefreshDeferred: true,
        mipmapStats: null
      };
      debugCanvasWebGpuAirbrush("live-display", {
        mode: "reuse",
        operationLabel: options.label || "",
        displaySourceKind: "layer-composite-budget-deferred",
        materialName: material.name || "",
        referenceName: textureAirbrushLiveDisplayReferenceTexture(material, editable)?.name || "",
        width: displayWidth,
        height: displayHeight,
        displayFlipY,
        displayLinearizeSrgb,
        displayMipmaps,
        sourceMipLevelCount,
        sourceTextureCanCarryDisplayTransform,
        needsDisplayCopy: true,
        displayMipmapsGenerated: false,
        displayMipmapsUsable: true,
        displayMipmapsDeferred: true,
        materialMapAlreadyReusable: material.map === cache.externalDisplayTexture,
        materialNeedsUpdate: material.needsUpdate === true,
        liveDisplayWorkPixels: 0,
        liveDisplayBounds: composite.updatedDisplayBounds || null,
        liveDisplayRegions: composite.updatedDisplayRegions || null,
        liveDisplayRegionCount: composite.updatedDisplayRegions?.length ?? 0,
        displayFullUpdate: false,
        liveDisplayMipmapPixels: 0
      });
      return cache.externalDisplayTexture;
    }
    if (!textureAirbrushRunWebGpuLayerDisplayComposite(
      device,
      composite,
      options
    )) {
      return null;
    }
    gpuTexture = composite.displayTexture;
    liveDisplayStats = {
      displayWorkPixels: composite.displayWorkPixels || 0,
      displayFullUpdate: composite.fullDisplayUpdate === true,
      displayBounds: composite.updatedDisplayBounds || null,
      displayRegions: composite.updatedDisplayRegions || null
    };
    displaySourceKind = "layer-composite";
    displayMipmapsGenerated = refreshDisplayMipmaps(
      composite.updatedDisplayBounds || null,
      composite.mipLevelCount,
      composite.updatedDisplayRegions || null
    );
  } else if (needsDisplayCopy) {
    const displayCopy = textureAirbrushEnsureWebGpuDisplayCopyResources(device, cache, resources.sourceTexture, {
      ...options,
      width: prepared?.width,
      height: prepared?.height,
      displayFlipY,
      displayLinearizeSrgb,
      displayMipmaps,
      displayDirtyBounds: sourceDirtyBounds,
      ...(activeSourceDirtyRegions ? { displayDirtyRegions: activeSourceDirtyRegions } : {}),
      preserveDisplayOnSourceTextureChange: deferredSourceDirtyRegions.length > 0
        || options.liveDisplayIncludeDeferredDirtyRegions === false,
      ...(forceSourceDirtyRegions ? { forceDisplayDirtyRegions: true } : {})
    });
    if (
      cache?.externalDisplayTexture
      && Number.isFinite(Number(options.maxLiveDisplayWorkPixels))
      && displayCopy?.displayWorkPixels > Math.max(1, Number(options.maxLiveDisplayWorkPixels))
    ) {
      cache.lastLiveDisplayStats = {
        displayWorkPixels: 0,
        displayFullUpdate: false,
        displayBounds: displayCopy.updatedDisplayBounds || null,
        displayRegions: displayCopy.updatedDisplayRegions || null,
        displayRefreshDeferred: true,
        mipmapStats: null
      };
      debugCanvasWebGpuAirbrush("live-display", {
        mode: "reuse",
        operationLabel: options.label || "",
        displaySourceKind: "display-copy-budget-deferred",
        materialName: material.name || "",
        referenceName: referenceTexture?.name || "",
        width: displayWidth,
        height: displayHeight,
        displayFlipY,
        displayLinearizeSrgb,
        displayMipmaps,
        sourceMipLevelCount,
        sourceTextureCanCarryDisplayTransform,
        needsDisplayCopy,
        displayMipmapsGenerated: false,
        displayMipmapsUsable: true,
        displayMipmapsDeferred: true,
        materialMapAlreadyReusable: material.map === cache.externalDisplayTexture,
        materialNeedsUpdate: material.needsUpdate === true,
        liveDisplayWorkPixels: 0,
        liveDisplayBounds: displayCopy.updatedDisplayBounds || null,
        liveDisplayRegions: displayCopy.updatedDisplayRegions || null,
        liveDisplayRegionCount: displayCopy.updatedDisplayRegions?.length ?? 0,
        displayFullUpdate: false,
        liveDisplayMipmapPixels: 0
      });
      return cache.externalDisplayTexture;
    }
    if (!textureAirbrushRunWebGpuDisplayCopy(device, displayCopy, options)) {
      return null;
    }
    gpuTexture = displayCopy.displayTexture;
    liveDisplayStats = {
      displayWorkPixels: displayCopy.displayWorkPixels || 0,
      displayFullUpdate: displayCopy.fullDisplayUpdate === true,
      displayBounds: displayCopy.updatedDisplayBounds || null,
      displayRegions: displayCopy.updatedDisplayRegions || null
    };
    displaySourceKind = "display-copy";
    displayMipmapsGenerated = refreshDisplayMipmaps(
      displayCopy.updatedDisplayBounds || null,
      displayCopy.mipLevelCount,
      displayCopy.updatedDisplayRegions || null
    );
  } else {
    displayMipmapsGenerated = refreshDisplayMipmaps(sourceDirtyBounds, undefined, activeSourceDirtyRegions);
  }
  if (cache && (liveDisplayStats || cache.lastDirtyMipmapStats)) {
    const displayBounds = liveDisplayStats?.displayBounds || sourceDirtyBounds || null;
    const activeDisplayWorkPixels = activeSourceDirtyRegions?.length
      ? textureAirbrushDirtyRegionsArea(activeSourceDirtyRegions)
      : Math.max(0, Number(displayBounds?.width) || 0) * Math.max(0, Number(displayBounds?.height) || 0);
    cache.lastLiveDisplayStats = {
      displayWorkPixels: liveDisplayStats?.displayWorkPixels
        ?? activeDisplayWorkPixels,
      displayFullUpdate: liveDisplayStats?.displayFullUpdate
        ?? textureAirbrushDirtyBoundsIsFull(displayBounds, prepared?.width, prepared?.height),
      displayBounds,
      displayRegions: liveDisplayStats?.displayRegions || activeSourceDirtyRegions || null,
      mipmapStats: cache.lastDirtyMipmapStats || null
    };
  }
  const externalFlipY = needsDisplayCopy && displayFlipY ? false : referenceTexture?.flipY;
  const externalColorSpace = needsDisplayCopy && displayLinearizeSrgb ? "srgb-linear" : referenceTexture?.colorSpace;
  const reusableTexture = cache?.externalDisplayGpuTexture === gpuTexture
    ? cache.externalDisplayTexture
    : null;
  const displayMipmapsDeferred = cache?.lastDirtyMipmapStats?.deferred === true;
  const reusableTextureHasValidMipmaps = displayMipmaps
    && !displayMipmapsDeferred
    && reusableTexture?.userData?.textureAirbrushDisplayMipmapped === true
    && reusableTexture.generateMipmaps === true;
  const displayMipmapsUsable = displayMipmapsGenerated === true
    || (reusableTextureHasValidMipmaps && !displayMipmapsDeferred);
  const referenceUsesMipmappedFiltering = displayMipmaps
    && textureAirbrushTexturePrefersMipmappedDisplay(referenceTexture);
  if (
    cache?.lastLiveDisplayStats
    && displayMipmapsDeferred
    && referenceUsesMipmappedFiltering
  ) {
    cache.lastLiveDisplayStats.mipmapDowngraded = true;
  }
  if (!displayMipmapsUsable && referenceUsesMipmappedFiltering && !displayMipmapsDeferred) {
    if (cache) {
      cache.lastLiveDisplayStats = {
        ...(liveDisplayStats || {}),
        mipmapStats: cache.lastDirtyMipmapStats || null,
        mipmapDowngradeBlocked: true
      };
    }
    return null;
  }
  if (reusableTexture) {
    let displayTexture = reusableTexture;
    textureAirbrushRefreshReusableExternalTexture(reusableTexture, referenceTexture, {
      width: prepared?.width,
      height: prepared?.height,
      flipY: externalFlipY,
      colorSpace: externalColorSpace,
      mipmapped: displayMipmapsUsable
    });
    const initializedReusableTexture = (
      reusableTexture.isExternalTexture === true
      || reusableTexture.userData?.textureAirbrushExternalWebGpuDisplay === true
    ) && Number(reusableTexture.version) > 0;
    if (
      reusableTexture.userData?.textureAirbrushExternalDisplayMetadataChanged === true
      && (
        initializedReusableTexture
        || (
          displayMipmapsDeferred
          && referenceUsesMipmappedFiltering
          && !displayMipmapsUsable
        )
      )
      && typeof editor?.textureAirbrushCreateExternalWebGpuTexture === "function"
    ) {
      const replacementTexture = editor.textureAirbrushCreateExternalWebGpuTexture(gpuTexture, referenceTexture, {
        width: prepared?.width,
        height: prepared?.height,
        name: reusableTexture.name || `${referenceTexture?.name || material.name || "texture"} WebGPU live airbrush`,
        flipY: externalFlipY,
        colorSpace: externalColorSpace,
        mipmapped: displayMipmapsUsable
      });
      if (replacementTexture) {
        displayTexture = replacementTexture;
        if (cache) {
          cache.externalDisplayTexture = replacementTexture;
          cache.externalDisplayGpuTexture = gpuTexture;
        }
      }
    }
    const materialMapAlreadyReusable = material.map === displayTexture;
    material.userData ||= {};
    material.userData.textureAirbrushWebGpuExternalMap = displayTexture;
    material.userData.textureAirbrushWebGpuCanvasMap = referenceTexture;
    textureAirbrushMarkExternalDisplayTexture(displayTexture, referenceTexture, {
      mipmapped: displayMipmapsUsable
    });
    if (displayTexture.userData?.textureAirbrushExternalDisplayMetadataChanged === true) {
      material.needsUpdate = true;
    }
    if (material.map !== displayTexture) {
      material.map = displayTexture;
      material.needsUpdate = true;
    }
    if (cache && includeDeferredDirtyRegions) {
      cache.deferredLiveDisplayDirtyBounds = null;
      cache.deferredLiveDisplayDirtyRegions = null;
    }
    debugCanvasWebGpuAirbrush("live-display", {
      mode: "reuse",
      operationLabel: options.label || "",
      displaySourceKind,
      materialName: material.name || "",
      referenceName: referenceTexture?.name || "",
      width: prepared?.width || 0,
      height: prepared?.height || 0,
      displayFlipY,
      displayLinearizeSrgb,
      displayMipmaps,
      sourceMipLevelCount,
      sourceTextureCanCarryDisplayTransform,
      needsDisplayCopy,
      displayMipmapsGenerated,
      displayMipmapsUsable,
      displayMipmapsDeferred,
      materialMapAlreadyReusable,
      materialNeedsUpdate: material.needsUpdate === true,
      liveDisplayWorkPixels: cache?.lastLiveDisplayStats?.displayWorkPixels ?? null,
      liveDisplayBounds: cache?.lastLiveDisplayStats?.displayBounds || null,
      liveDisplayRegions: cache?.lastLiveDisplayStats?.displayRegions || null,
      liveDisplayRegionCount: cache?.lastLiveDisplayStats?.displayRegions?.length ?? 0,
      displayFullUpdate: cache?.lastLiveDisplayStats?.displayFullUpdate ?? null,
      liveDisplayMipmapPixels: cache?.lastLiveDisplayStats?.mipmapStats?.pixels ?? null
    });
    return displayTexture;
  }
  if (typeof editor?.textureAirbrushCreateExternalWebGpuTexture !== "function") {
    return null;
  }
  const externalTexture = editor.textureAirbrushCreateExternalWebGpuTexture(gpuTexture, referenceTexture, {
    width: prepared?.width,
    height: prepared?.height,
    name: `${referenceTexture?.name || material.name || "texture"} WebGPU live airbrush`,
    flipY: externalFlipY,
    colorSpace: externalColorSpace,
    mipmapped: displayMipmapsUsable
  });
  if (!externalTexture) {
    return null;
  }
  if (cache) {
    cache.externalDisplayGpuTexture = gpuTexture;
    cache.externalDisplayTexture = externalTexture;
    if (includeDeferredDirtyRegions) {
      cache.deferredLiveDisplayDirtyBounds = null;
      cache.deferredLiveDisplayDirtyRegions = null;
    }
  }
  material.userData ||= {};
  material.userData.textureAirbrushWebGpuExternalMap = externalTexture;
  material.userData.textureAirbrushWebGpuCanvasMap = referenceTexture;
  textureAirbrushMarkExternalDisplayTexture(externalTexture, referenceTexture, {
    mipmapped: displayMipmapsUsable
  });
  if (material.map !== externalTexture) {
    material.map = externalTexture;
    material.needsUpdate = true;
  }
  debugCanvasWebGpuAirbrush("live-display", {
    mode: "new",
    operationLabel: options.label || "",
    displaySourceKind,
    materialName: material.name || "",
    referenceName: referenceTexture?.name || "",
    width: prepared?.width || 0,
    height: prepared?.height || 0,
    displayFlipY,
    displayLinearizeSrgb,
    displayMipmaps,
    sourceMipLevelCount,
    sourceTextureCanCarryDisplayTransform,
    needsDisplayCopy,
    displayMipmapsGenerated,
    displayMipmapsUsable,
    displayMipmapsDeferred,
    materialNeedsUpdate: material.needsUpdate === true,
    liveDisplayWorkPixels: cache?.lastLiveDisplayStats?.displayWorkPixels ?? null,
    liveDisplayBounds: cache?.lastLiveDisplayStats?.displayBounds || null,
    liveDisplayRegions: cache?.lastLiveDisplayStats?.displayRegions || null,
    liveDisplayRegionCount: cache?.lastLiveDisplayStats?.displayRegions?.length ?? 0,
    displayFullUpdate: cache?.lastLiveDisplayStats?.displayFullUpdate ?? null,
    liveDisplayMipmapPixels: cache?.lastLiveDisplayStats?.mipmapStats?.pixels ?? null
  });
  return externalTexture;
}

function textureAirbrushCanDeferLiveDisplayRefresh(cache = null, resources = null, material = null) {
  const externalTexture = cache?.externalDisplayTexture || null;
  const externalGpuTexture = cache?.externalDisplayGpuTexture || null;
  const sourceTexture = resources?.sourceTexture || null;
  const directSourceDisplay = externalGpuTexture === sourceTexture;
  const displayCopy = cache?.liveDisplayCopy || null;
  const displayCopyMatchesSource = Boolean(
    displayCopy
    && externalGpuTexture === displayCopy.displayTexture
  );
  const layerComposite = cache?.layerDisplayComposite || null;
  const layerCompositeMatchesSource = Boolean(
    layerComposite
    && externalGpuTexture === layerComposite.displayTexture
  );
  return Boolean(
    cache
    && sourceTexture
    && externalTexture
    && material?.map === externalTexture
    && externalTexture.userData?.textureAirbrushExternalWebGpuDisplay === true
    && (directSourceDisplay || displayCopyMatchesSource || layerCompositeMatchesSource)
  );
}

export function textureAirbrushEditableWebGpuPayload(editor = null, editable = null, options = {}) {
  const source = options.readSource === false
    ? textureAirbrushEditableCanvasSize(editable)
    : textureAirbrushSourcePixelsFromEditable(editable);
  if (!source || typeof editor?.textureAirbrushWebGpuKernelPayload !== "function") {
    return null;
  }
  const payload = editor.textureAirbrushWebGpuKernelPayload({
    ...options,
    width: source.width,
    height: source.height,
    textureWidth: source.width,
    textureHeight: source.height
  });
  return {
    ...source,
    imageData: source.imageData || null,
    sourcePixels: source.sourcePixels || null,
    payload
  };
}

export function textureAirbrushWebGpuCacheForEditable(editor = null, editable = null, device = null, options = {}) {
  const key = textureAirbrushWebGpuCacheKeyForEditable(editable);
  const size = textureAirbrushEditableCanvasSize(editable);
  if (!editor || !key || !device || !size) {
    return null;
  }
  editor.textureAirbrushWebGpuPaintCaches ||= new WeakMap();
  const existing = editor.textureAirbrushWebGpuPaintCaches.get(key);
  const refreshSource = options.refreshSource === true
    && !textureAirbrushShouldPreserveWarmGpuSource(existing, options);
  if (
    existing
    && existing.device === device
    && existing.width === size.width
    && existing.height === size.height
    && !refreshSource
  ) {
    return existing;
  }
  const cache = {
    device,
    width: size.width,
    height: size.height,
    initialized: false,
    resources: null
  };
  editor.textureAirbrushWebGpuPaintCaches.set(key, cache);
  return cache;
}

export function textureAirbrushInvalidateWebGpuCache(editor = null, editableOrTexture = null) {
  const invalidatedTslSurface = editableOrTexture
    ? editor?.texturePaintTslSurfaceAirbrushInvalidate?.(editableOrTexture) === true
    : false;
  const caches = editor?.textureAirbrushWebGpuPaintCaches;
  if (!caches || !editableOrTexture) {
    return invalidatedTslSurface;
  }
  const key = textureAirbrushWebGpuCacheKeyForEditable(editableOrTexture);
  return caches.delete(key) || invalidatedTslSurface;
}

export function textureAirbrushCachedWebGpuStrokeSourceImage(editor = null, editable = null, options = {}) {
  const device = options.device || editor?.textureAirbrushWebGpuDevice?.();
  const cache = textureAirbrushWebGpuCacheForEditable(editor, editable, device, options);
  const canvas = editable?.canvas || null;
  let imageData = cache?.strokeSourceImageData || null;
  const requestedBounds = textureAirbrushUnionDirtyBounds(
    null,
    options.bounds || options.paintBounds || null,
    canvas?.width || 1,
    canvas?.height || 1
  );
  const requestedRegions = textureAirbrushNormalizeDirtyRegions(
    options.boundsRegions || options.paintRegions || options.regions || [],
    canvas?.width || 1,
    canvas?.height || 1
  );
  const pendingSync = cache?.deferredCanvasSync || null;
  const pendingRegions = textureAirbrushNormalizeDirtyRegions(
    Array.isArray(pendingSync?.regions) && pendingSync.regions.length
      ? pendingSync.regions
      : pendingSync?.bounds
        ? [pendingSync.bounds]
        : [],
    canvas?.width || 1,
    canvas?.height || 1
  );
  const pendingOverlapsRequestedBounds = cache?.deferredReadbackApplyPending === true
    && (
      requestedRegions.length
        ? pendingRegions.some((pendingRegion) => (
            requestedRegions.some((requestedRegion) => textureAirbrushBoundsOverlap(pendingRegion, requestedRegion))
          ))
        : (
            !requestedBounds
            || pendingRegions.some((region) => textureAirbrushBoundsOverlap(region, requestedBounds))
          )
    );
  const imageDataReady = (source = imageData) => (
    source?.width === canvas?.width
    && source?.height === canvas?.height
    && source?.data?.byteLength === (canvas?.width || 0) * (canvas?.height || 0) * 4
  );
  if (
    options.ensureSourceImageData === true
    && cache?.initialized
    && !pendingOverlapsRequestedBounds
    && canvas?.width
    && canvas?.height
    && !imageDataReady()
    && cache.deferredReadbackApplyPending !== true
  ) {
    imageData = textureAirbrushEnsureStrokeSourceImageData(cache, editable) || imageData;
  }
  if (
    !cache?.initialized
    || cache.strokeSourceMatchesSource !== true
    || pendingOverlapsRequestedBounds
    || !canvas?.width
    || !canvas?.height
    || !imageDataReady()
  ) {
    return null;
  }
  return imageData;
}

function textureAirbrushPixelPayloadByteLength(payload = null) {
  if (!payload) {
    return 0;
  }
  const direct = Number(payload.byteLength);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const nested = Number(payload.pixels?.byteLength);
  return Number.isFinite(nested) && nested > 0 ? nested : 0;
}

function textureAirbrushLiveDisplayPrewarmRequested(options = {}) {
  return Boolean(options.material)
    && options.liveDisplayExternalTexture === true
    && options.allowPrewarmLiveDisplayMaterialSwap === true;
}

function textureAirbrushCanUploadEditableAsExternal(device = null, editable = null, options = {}) {
  return options.externalSourceUpload === true
    && Boolean(editable?.canvas)
    && typeof device?.queue?.copyExternalImageToTexture === "function";
}

function textureAirbrushLiveDisplayPrewarmReady(cache = null, editable = null) {
  if (!cache?.externalDisplayTexture || !cache.externalDisplayGpuTexture) {
    return false;
  }
  if (editable?.layerMode === true) {
    return cache.layerDisplayComposite?.initialized === true;
  }
  return cache.liveDisplayCopy?.initialized === true
    || cache.externalDisplayGpuTexture === cache.resources?.sourceTexture;
}

function textureAirbrushGpuSourceRevision(cache = null) {
  return Math.max(0, Math.floor(Number(cache?.gpuSourceRevision) || 0));
}

function textureAirbrushGpuStrokeSourceRevision(cache = null) {
  return Math.max(0, Math.floor(Number(cache?.gpuStrokeSourceRevision) || 0));
}

function textureAirbrushGpuStrokeSourceMatchesSource(cache = null) {
  return Boolean(
    cache?.resources?.sourceTexture
    && cache.resources.strokeSourceTexture
    && textureAirbrushGpuStrokeSourceRevision(cache) === textureAirbrushGpuSourceRevision(cache)
  );
}

function textureAirbrushShouldPreserveWarmGpuSource(cache = null, options = {}) {
  return Boolean(
    cache?.initialized
    && cache.gpuSourceMatchesEditable === true
    && (
      cache.deferredReadbackApplyPending === true
      || cache.externalDisplayTexture
      || cache.externalDisplayGpuTexture
      || options.preserveLiveGpuSource === true
    )
  );
}

export function textureAirbrushEditableWebGpuStrokeSourceCurrent(editor = null, editable = null, options = {}) {
  const device = options.device || editor?.textureAirbrushWebGpuDevice?.();
  const cache = options.cache || textureAirbrushWebGpuCacheForEditable(editor, editable, device, options);
  return Boolean(
    cache?.initialized
    && cache.gpuSourceMatchesEditable === true
    && textureAirbrushGpuStrokeSourceMatchesSource(cache)
  );
}

function textureAirbrushRefreshGpuStrokeSourceFromSource(cache = null) {
  if (!cache?.device || !cache.resources || textureAirbrushGpuStrokeSourceMatchesSource(cache)) {
    return false;
  }
  const copied = textureAirbrushCopyWebGpuSourceToStrokeTexture(
    cache.device,
    cache.resources.sourceTexture,
    cache.resources.strokeSourceTexture,
    cache.resources.plan
  );
  if (copied) {
    cache.gpuStrokeSourceRevision = textureAirbrushGpuSourceRevision(cache);
    cache.gpuStrokeSourceImageData = null;
    cache.gpuStrokeSourceOwner = null;
  }
  return copied;
}

function textureAirbrushPrewarmExternalWebGpuDisplay(editor = null, editable = null, cache = null, resources = null, prepared = null, options = {}) {
  if (!textureAirbrushLiveDisplayPrewarmRequested(options) || !prepared?.payload || !resources?.sourceTexture) {
    return null;
  }
  return textureAirbrushAttachExternalWebGpuDisplay(editor, editable, cache, resources, prepared, {
    ...options,
    liveDisplayExternalTexture: true,
    displayDirtyBounds: textureAirbrushFullDirtyBounds(prepared.width, prepared.height),
    label: `${options.label || "texture-airbrush-prewarm"}-display`
  });
}

function textureAirbrushRefreshReusableExternalTexture(texture = null, referenceTexture = null, options = {}) {
  if (!texture) {
    return null;
  }
  const previousState = {
    width: texture.image?.width,
    height: texture.image?.height,
    colorSpace: texture.colorSpace,
    flipY: texture.flipY,
    channel: texture.channel,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    magFilter: texture.magFilter,
    minFilter: texture.minFilter,
    anisotropy: texture.anisotropy,
    generateMipmaps: texture.generateMipmaps,
    displayMipmapped: texture.userData?.textureAirbrushDisplayMipmapped,
    referenceMinFilter: texture.userData?.textureAirbrushReferenceMinFilter
  };
  texture.image = {
    width: Math.max(1, Math.floor(Number(options.width || referenceTexture?.image?.width) || 1)),
    height: Math.max(1, Math.floor(Number(options.height || referenceTexture?.image?.height) || 1))
  };
  texture.colorSpace = options.colorSpace ?? referenceTexture?.colorSpace ?? texture.colorSpace;
  texture.flipY = options.flipY ?? referenceTexture?.flipY ?? texture.flipY;
  if (referenceTexture && "channel" in referenceTexture) {
    texture.channel = referenceTexture.channel;
  }
  texture.wrapS = referenceTexture?.wrapS || texture.wrapS;
  texture.wrapT = referenceTexture?.wrapT || texture.wrapT;
  const nonMipmapMinFilter = texture.userData?.textureAirbrushNonMipmapMinFilter;
  const nonMipmapMagFilter = texture.userData?.textureAirbrushNonMipmapMagFilter ?? nonMipmapMinFilter;
  texture.magFilter = options.mipmapped === true
    ? referenceTexture?.magFilter || texture.magFilter
    : nonMipmapMagFilter ?? texture.magFilter;
  if (options.mipmapped === true && referenceTexture?.minFilter !== undefined) {
    texture.minFilter = referenceTexture.minFilter;
  } else if (options.mipmapped !== true && nonMipmapMinFilter !== undefined) {
    texture.minFilter = nonMipmapMinFilter;
  }
  texture.anisotropy = options.mipmapped === true
    ? referenceTexture?.anisotropy || texture.anisotropy
    : 1;
  texture.generateMipmaps = options.mipmapped === true;
  if (referenceTexture?.offset && texture.offset) {
    texture.offset.copy(referenceTexture.offset);
  }
  if (referenceTexture?.repeat && texture.repeat) {
    texture.repeat.copy(referenceTexture.repeat);
  }
  if (referenceTexture?.center && texture.center) {
    texture.center.copy(referenceTexture.center);
  }
  texture.rotation = referenceTexture?.rotation || 0;
  texture.matrixAutoUpdate = referenceTexture?.matrixAutoUpdate ?? true;
  if (referenceTexture?.matrix && texture.matrix) {
    texture.matrix.copy(referenceTexture.matrix);
  }
  texture.userData = {
    ...(texture.userData || {}),
    textureAirbrushExternalWebGpuDisplay: true,
    textureAirbrushDisplayMipmapped: options.mipmapped === true,
    textureAirbrushReferenceMinFilter: referenceTexture?.minFilter,
    textureAirbrushWebGpuCanvasMap: referenceTexture || null
  };
  const changed = previousState.width !== texture.image.width
    || previousState.height !== texture.image.height
    || previousState.colorSpace !== texture.colorSpace
    || previousState.flipY !== texture.flipY
    || previousState.channel !== texture.channel
    || previousState.wrapS !== texture.wrapS
    || previousState.wrapT !== texture.wrapT
    || previousState.magFilter !== texture.magFilter
    || previousState.minFilter !== texture.minFilter
    || previousState.anisotropy !== texture.anisotropy
    || previousState.generateMipmaps !== texture.generateMipmaps
    || previousState.displayMipmapped !== texture.userData.textureAirbrushDisplayMipmapped
    || previousState.referenceMinFilter !== texture.userData.textureAirbrushReferenceMinFilter;
  texture.userData.textureAirbrushExternalDisplayMetadataChanged = changed;
  if (changed) {
    const initializedExternalTexture = (
      texture.isExternalTexture === true
      || texture.userData?.textureAirbrushExternalWebGpuDisplay === true
    ) && Number(texture.version) > 0;
    if (!initializedExternalTexture) {
      texture.needsUpdate = true;
    }
  }
  return texture;
}

function textureAirbrushMarkExternalDisplayTexture(texture = null, referenceTexture = null, options = {}) {
  if (!texture) {
    return null;
  }
  const referenceMinFilter = referenceTexture?.minFilter;
  const referenceMinFilterName = String(referenceMinFilter ?? "").toLowerCase();
  const fallbackNonMipmapMinFilter = referenceMinFilterName.includes("mipmap")
    ? "linear-filter"
    : referenceMinFilter;
  texture.userData = {
    ...(texture.userData || {}),
    textureAirbrushExternalWebGpuDisplay: true,
    textureAirbrushDisplayMipmapped: options.mipmapped === true,
    textureAirbrushReferenceMinFilter: referenceMinFilter,
    textureAirbrushNonMipmapMinFilter: texture.userData?.textureAirbrushNonMipmapMinFilter
      ?? fallbackNonMipmapMinFilter,
    textureAirbrushNonMipmapMagFilter: texture.userData?.textureAirbrushNonMipmapMagFilter
      ?? referenceTexture?.magFilter,
    textureAirbrushWebGpuCanvasMap: referenceTexture || null
  };
  return texture;
}

export function textureAirbrushPrewarmEditableWebGpuPaint(editor = null, editable = null, options = {}) {
  const startMs = textureAirbrushNow(options);
  const device = options.device || editor?.textureAirbrushWebGpuDevice?.();
  const cache = textureAirbrushWebGpuCacheForEditable(editor, editable, device, options);
  const ensureStrokeSourceImageData = options.ensureStrokeSourceImageData === true;
  const preserveWarmGpuSource = textureAirbrushShouldPreserveWarmGpuSource(cache, options);
  const refreshSource = options.refreshSource === true && !preserveWarmGpuSource;
  const sourceAlreadyWarm = cache?.initialized
    && refreshSource !== true
    && cache.gpuSourceMatchesEditable === true;
  if (!device || !cache || (cache.deferredReadbackApplyPending === true && !sourceAlreadyWarm)) {
    return null;
  }
  if (sourceAlreadyWarm) {
    const strokeSourceCopiedFromSource = textureAirbrushRefreshGpuStrokeSourceFromSource(cache);
    const ensuredStrokeSourceImageData = ensureStrokeSourceImageData
      ? textureAirbrushEnsureStrokeSourceImageData(cache, editable)
      : null;
    if (
      !textureAirbrushLiveDisplayPrewarmRequested(options)
      || textureAirbrushLiveDisplayPrewarmReady(cache, editable)
      || !cache.resources
    ) {
      if (!strokeSourceCopiedFromSource) {
        if (!ensuredStrokeSourceImageData) {
          return null;
        }
      }
      const warmedMs = textureAirbrushNow(options);
      const stats = {
        width: cache.width,
        height: cache.height,
        sourceBytes: 0,
        sourceImageDataReady: textureAirbrushImageDataMatchesSize(cache.strokeSourceImageData, cache.width, cache.height),
        reusedResources: true,
        strokeSourceCopiedFromSource,
        liveDisplayExternalTexture: false,
        liveDisplayFullUpdate: null,
        liveDisplayWorkPixels: 0,
        liveDisplayBounds: null,
        liveDisplayMipmapDirty: null,
        liveDisplayMipmapDeferred: false,
        liveDisplayMipmapPixels: 0,
        timings: {
          prepareMs: 0,
          uploadMs: Math.max(0, warmedMs - startMs),
          displayMs: 0,
          totalMs: Math.max(0, warmedMs - startMs)
        }
      };
      editor.textureAirbrushLastWebGpuPrewarmStats = stats;
      return {
        resources: cache.resources,
        payload: null,
        sourcePixels: null,
        sourceImageData: cache.strokeSourceImageData || null,
        liveDisplayTexture: null,
        stats
      };
    }
    const preparedDisplay = textureAirbrushEditableWebGpuPayload(editor, editable, {
      ...options,
      readSource: false,
      strokeSegments: options.strokeSegments || [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
    });
    if (!preparedDisplay?.payload) {
      return null;
    }
    const liveDisplayTexture = textureAirbrushPrewarmExternalWebGpuDisplay(
      editor,
      editable,
      cache,
      cache.resources,
      preparedDisplay,
      options
    );
    const displayStats = cache.lastLiveDisplayStats || null;
    if (!liveDisplayTexture && !displayStats) {
      return null;
    }
    const displayMs = textureAirbrushNow(options);
    const stats = {
      width: preparedDisplay.width,
      height: preparedDisplay.height,
      sourceBytes: 0,
      sourceImageDataReady: textureAirbrushImageDataMatchesSize(cache.strokeSourceImageData, cache.width, cache.height),
      reusedResources: true,
      strokeSourceCopiedFromSource,
      liveDisplayExternalTexture: Boolean(liveDisplayTexture),
      liveDisplayFullUpdate: displayStats?.displayFullUpdate ?? null,
      liveDisplayWorkPixels: displayStats?.displayWorkPixels ?? 0,
      liveDisplayBounds: displayStats?.displayBounds || null,
      liveDisplayMipmapDirty: displayStats?.mipmapStats?.dirty ?? null,
      liveDisplayMipmapDeferred: displayStats?.mipmapStats?.deferred === true,
      liveDisplayMipmapPixels: displayStats?.mipmapStats?.pixels ?? 0,
      timings: {
        prepareMs: 0,
        uploadMs: 0,
        displayMs: Math.max(0, displayMs - startMs),
        totalMs: Math.max(0, displayMs - startMs)
      }
    };
    editor.textureAirbrushLastWebGpuPrewarmStats = stats;
    return {
      resources: cache.resources,
      payload: preparedDisplay.payload,
      sourcePixels: null,
      sourceImageData: cache.strokeSourceImageData || null,
      liveDisplayTexture,
      stats
    };
  }
  const reuseResources = refreshSource === true ? null : cache.resources || null;
  const sourceExternalImage = !ensureStrokeSourceImageData && textureAirbrushCanUploadEditableAsExternal(device, editable, options)
    ? editable.canvas
    : null;
  const prepared = textureAirbrushEditableWebGpuPayload(editor, editable, {
    ...options,
    readSource: sourceExternalImage ? false : true,
    strokeSegments: options.strokeSegments || [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  const preparedMs = textureAirbrushNow(options);
  if (!prepared?.payload || (!prepared.sourcePixels && !sourceExternalImage)) {
    return null;
  }
  const resources = textureAirbrushCreateWebGpuPaintResources(device, prepared.payload, {
    sourcePixels: prepared.sourcePixels,
    sourceExternalImage,
    visibilityMaskPixels: options.visibilityMaskPixels || null,
    readback: false,
    reuseResources,
    uploadSource: true,
    label: options.label || "texture-airbrush-prewarm"
  });
  const applyMs = textureAirbrushNow(options);
  if (!resources) {
    return null;
  }
  cache.resources = resources;
  cache.initialized = true;
  cache.strokeSourceImageData = prepared.imageData || null;
  cache.gpuStrokeSourceImageData = prepared.imageData || null;
  cache.gpuSourceRevision = textureAirbrushGpuSourceRevision(cache);
  if (resources.strokeSourceCopiedFromSource === true || prepared.imageData) {
    cache.gpuStrokeSourceRevision = cache.gpuSourceRevision;
  }
  cache.strokeSourceMatchesSource = Boolean(prepared.imageData);
  cache.gpuSourceMatchesEditable = resources.sourceUploaded === true;
  cache.deferredReadbackApplyPending = false;
  const liveDisplayTexture = textureAirbrushPrewarmExternalWebGpuDisplay(
    editor,
    editable,
    cache,
    resources,
    prepared,
    options
  );
  const displayMs = textureAirbrushNow(options);
  const displayStats = cache.lastLiveDisplayStats || null;
  const stats = {
    width: prepared.width,
    height: prepared.height,
    sourceBytes: prepared.sourcePixels?.byteLength || 0,
    sourceImageDataReady: textureAirbrushImageDataMatchesSize(cache.strokeSourceImageData, prepared.width, prepared.height),
    sourceExternalUploaded: resources.sourceExternalUploaded === true,
    strokeSourceCopiedFromSource: resources.strokeSourceCopiedFromSource === true,
    reusedResources: Boolean(reuseResources),
    liveDisplayExternalTexture: Boolean(liveDisplayTexture),
    liveDisplayFullUpdate: displayStats?.displayFullUpdate ?? null,
    liveDisplayWorkPixels: displayStats?.displayWorkPixels ?? 0,
    liveDisplayBounds: displayStats?.displayBounds || null,
    liveDisplayMipmapDirty: displayStats?.mipmapStats?.dirty ?? null,
    liveDisplayMipmapDeferred: displayStats?.mipmapStats?.deferred === true,
    liveDisplayMipmapPixels: displayStats?.mipmapStats?.pixels ?? 0,
    timings: {
      prepareMs: Math.max(0, preparedMs - startMs),
      uploadMs: Math.max(0, applyMs - preparedMs),
      displayMs: Math.max(0, displayMs - applyMs),
      totalMs: Math.max(0, displayMs - startMs)
    }
  };
  editor.textureAirbrushLastWebGpuPrewarmStats = stats;
  return {
    resources,
    payload: prepared.payload,
    sourcePixels: prepared.sourcePixels,
    sourceImageData: prepared.imageData || null,
    liveDisplayTexture,
    stats
  };
}

export async function textureAirbrushRunEditableWebGpuPaint(editor = null, editable = null, options = {}) {
  const startMs = textureAirbrushNow(options);
  const device = options.device || editor?.textureAirbrushWebGpuDevice?.();
  const cache = textureAirbrushWebGpuCacheForEditable(editor, editable, device, options);
  const needsSource = options.refreshSource === true
    || !cache?.initialized
    || cache?.gpuSourceMatchesEditable !== true;
  const reuseResources = cache?.resources || null;
  const sourceExternalImage = needsSource && textureAirbrushCanUploadEditableAsExternal(device, editable, options)
    ? editable.canvas
    : null;
  const deferReadbackApply = options.deferReadbackApply === true;
  const deferReadbackCopy = deferReadbackApply
    && Boolean(cache)
    && (
      options.deferReadbackCopy === true
      || (
        options.deferReadbackCopy !== false
        && options.liveDisplayExternalTexture === true
      )
    );
  const strokeSourceImageData = options.strokeSourceImageData || null;
  const strokeSourceOwner = options.strokeSourceOwner || null;
  const sourceRevisionBeforePaint = textureAirbrushGpuSourceRevision(cache);
  const strokeSourceOwnerChanged = Boolean(
    strokeSourceOwner
    && cache?.gpuStrokeSourceOwner !== strokeSourceOwner
  );
  const currentGpuStrokeSourceReady = Boolean(
    reuseResources
    && textureAirbrushGpuStrokeSourceMatchesSource(cache)
  );
  const needsStrokeSource = Boolean(strokeSourceImageData)
    && (
      options.refreshStrokeSource === true
      || cache?.gpuStrokeSourceImageData !== strokeSourceImageData
      || !reuseResources
    );
  const needsCurrentGpuStrokeSource = !strokeSourceImageData
    && Boolean(
      reuseResources
      && (
        options.refreshStrokeSource === true
        || (strokeSourceOwnerChanged && !currentGpuStrokeSourceReady)
      )
    );
  const acceptsCurrentGpuStrokeSourceOwner = !strokeSourceImageData
    && strokeSourceOwnerChanged
    && currentGpuStrokeSourceReady
    && options.refreshStrokeSource !== true;
  const prepared = textureAirbrushEditableWebGpuPayload(editor, editable, {
    ...options,
    readSource: needsSource && !sourceExternalImage
  });
  const preparedMs = textureAirbrushNow(options);
  if (!device || !prepared?.payload) {
    return null;
  }
  if (needsSource && !prepared.sourcePixels && !sourceExternalImage) {
    return null;
  }
  if (!needsSource && !cache?.initialized) {
    return null;
  }
  const strokeSourcePixels = needsStrokeSource
    ? textureAirbrushPixelsFromImageData(strokeSourceImageData, prepared.width, prepared.height)
    : null;
  if (needsStrokeSource && !strokeSourcePixels) {
    return null;
  }
  const uploadsSourceAsStrokeSource = !reuseResources && needsSource && !strokeSourcePixels;
  const uploadsExternalSourceAsStrokeSource = uploadsSourceAsStrokeSource && Boolean(sourceExternalImage);
  const strokeSourceUploaded = needsStrokeSource || uploadsSourceAsStrokeSource || needsCurrentGpuStrokeSource;
  const providedLiveCommandEncoder = options.commandEncoder || null;
  const coalesceLiveGpuWork = options.coalesceLiveGpuWork !== false
    && deferReadbackCopy
    && Boolean(options.material)
    && (
      options.liveDisplayExternalTexture === true
      || Boolean(providedLiveCommandEncoder)
    );
  const liveCommandEncoder = coalesceLiveGpuWork
    ? providedLiveCommandEncoder || device.createCommandEncoder({
      label: `${options.label || "texture-airbrush-editable"}-live-command-encoder`
    })
    : null;
  const ownsLiveCommandEncoder = Boolean(liveCommandEncoder && !providedLiveCommandEncoder);
  const dispatchStartMs = textureAirbrushNow(options);
  const run = textureAirbrushRunWebGpuPaint(device, prepared.payload, {
    sourcePixels: needsSource ? prepared.sourcePixels : null,
    sourceExternalImage,
    strokeSourcePixels,
    visibilityMaskPixels: options.visibilityMaskPixels || null,
    readback: !deferReadbackCopy,
    reuseResources,
    reuseReadbackBuffer: deferReadbackApply ? false : options.reuseReadbackBuffer !== false,
    uploadSource: needsSource,
    uploadStrokeSource: strokeSourceUploaded,
    copySourceToStrokeSource: needsCurrentGpuStrokeSource,
    deferSourceToStrokeCopy: true,
    dedicatedBrushBuffers: options.dedicatedBrushBuffers === true,
    persistOutputToSource: true,
    ...(liveCommandEncoder ? { commandEncoder: liveCommandEncoder, submit: false } : {}),
    label: options.label || "texture-airbrush-editable"
  });
  const dispatchMs = textureAirbrushNow(options);
  if (!run?.result) {
    return null;
  }
  const plannedReadbackLayout = run.result.readbackLayout
    || prepared.payload?.plan?.buffers?.readback?.layout
    || null;
  const plannedPaintBounds = textureAirbrushDirtyBoundsFromLayout(
    prepared.payload?.plan?.paintBounds || null
  );
  const liveDisplayDirtyBounds = options.displayDirtyBounds
    || plannedPaintBounds
    || plannedReadbackLayout
    || null;
  const liveDisplayDirtyRegions = textureAirbrushNormalizeDirtyRegions(
    options.displayDirtyRegions || options.paintRegions || [],
    prepared.width,
    prepared.height
  );
  if (cache) {
    cache.resources = run.resources;
    cache.initialized = true;
    cache.gpuSourceRevision = sourceRevisionBeforePaint + 1;
    if (strokeSourceImageData) {
      cache.gpuStrokeSourceImageData = strokeSourceImageData;
      cache.gpuStrokeSourceOwner = strokeSourceOwner || strokeSourceImageData;
      cache.gpuStrokeSourceRevision = sourceRevisionBeforePaint;
    } else if (needsCurrentGpuStrokeSource || uploadsSourceAsStrokeSource) {
      cache.gpuStrokeSourceImageData = null;
      cache.gpuStrokeSourceOwner = strokeSourceOwner || null;
      cache.gpuStrokeSourceRevision = sourceRevisionBeforePaint;
    } else if (acceptsCurrentGpuStrokeSourceOwner) {
      cache.gpuStrokeSourceImageData = null;
      cache.gpuStrokeSourceOwner = strokeSourceOwner;
    } else if (needsSource) {
      cache.gpuStrokeSourceImageData = prepared.imageData || null;
      cache.gpuStrokeSourceOwner = strokeSourceOwner || prepared.imageData || null;
      cache.gpuStrokeSourceRevision = sourceRevisionBeforePaint;
      cache.strokeSourceImageData = null;
    }
    cache.strokeSourceMatchesSource = false;
    cache.gpuSourceMatchesEditable = needsSource
      ? run.resources?.sourceUploaded === true
      : true;
  }
  const deferLiveDisplayRefresh = options.deferLiveDisplayRefresh === true
    && textureAirbrushCanDeferLiveDisplayRefresh(cache, run.resources, options.material || null);
  const liveDisplayTexture = deferLiveDisplayRefresh
    ? cache.externalDisplayTexture
    : textureAirbrushAttachExternalWebGpuDisplay(editor, editable, cache, run.resources, prepared, {
        ...options,
        displayDirtyBounds: liveDisplayDirtyBounds,
        ...(liveDisplayDirtyRegions.length ? { displayDirtyRegions: liveDisplayDirtyRegions } : {}),
        ...(liveCommandEncoder ? { commandEncoder: liveCommandEncoder, submit: false } : {})
      });
  if (options.requireLiveDisplayTexture === true && !liveDisplayTexture) {
    editor?.textureAirbrushReportWebGpuFallback?.({
      backend: "webgpu",
      webGpuStatus: "live-display-unavailable"
    });
    return null;
  }
  textureAirbrushMarkEditableLayerWebGpuPainted(editor, editable);
  if (deferLiveDisplayRefresh && cache) {
    const deferredDisplayBounds = textureAirbrushDirtyBoundsFromLayout(
      liveDisplayDirtyBounds
    );
    const requestedDeferredDisplayRegions = textureAirbrushNormalizeDirtyRegions(
      liveDisplayDirtyRegions,
      prepared.width,
      prepared.height
    );
    let deferredDisplayRegions = textureAirbrushNormalizeDirtyRegions(
      cache.deferredLiveDisplayDirtyRegions || (
        cache.deferredLiveDisplayDirtyBounds ? [cache.deferredLiveDisplayDirtyBounds] : []
      ),
      prepared.width,
      prepared.height
    );
    if (requestedDeferredDisplayRegions.length) {
      for (const region of requestedDeferredDisplayRegions) {
        deferredDisplayRegions = textureAirbrushAppendDirtyRegion(
          deferredDisplayRegions,
          region,
          prepared.width,
          prepared.height
        );
      }
    } else if (deferredDisplayBounds) {
      deferredDisplayRegions = textureAirbrushAppendDirtyRegion(
        deferredDisplayRegions,
        deferredDisplayBounds,
        prepared.width,
        prepared.height
      );
    }
    const deferredUnionBounds = textureAirbrushUnionDirtyRegions(
      deferredDisplayRegions,
      prepared.width,
      prepared.height
    );
    const useDeferredRegions = textureAirbrushUseDirtyRegions(
      deferredDisplayRegions,
      deferredUnionBounds,
      prepared.width,
      prepared.height
    );
    cache.deferredLiveDisplayDirtyBounds = deferredUnionBounds;
    cache.deferredLiveDisplayDirtyRegions = deferredDisplayRegions.length ? deferredDisplayRegions : null;
    cache.lastDirtyMipmapStats = null;
    cache.lastLiveDisplayStats = {
      displayWorkPixels: 0,
      displayFullUpdate: false,
      displayBounds: cache.deferredLiveDisplayDirtyBounds,
      displayRegions: cache.deferredLiveDisplayDirtyRegions,
      displayRefreshDeferred: true,
      mipmapStats: null
    };
  }
  if (ownsLiveCommandEncoder && options.submit !== false) {
    device.queue?.submit?.([liveCommandEncoder.finish()]);
  }
  const liveDisplayStats = cache?.lastLiveDisplayStats || null;
  const baseStats = ({
    pixels = null,
    applied = null,
    readbackStartMs = dispatchMs,
    readbackMs = readbackStartMs,
    applyMs = readbackMs,
    deferredReadback = false,
    deferredReadbackCopy: statsDeferredReadbackCopy = false
  } = {}) => ({
    width: prepared.width,
    height: prepared.height,
    dirtyBounds: textureAirbrushDirtyBoundsFromLayout(plannedReadbackLayout),
    dispatch: run.result.dispatch || null,
    sourceUploaded: needsSource,
    strokeSourceUploaded,
    visibilitySampleCount: prepared.payload?.params?.visibilitySampleCount || 0,
    visibilityTriangleCount: prepared.payload?.params?.visibilityTriangleCount || 0,
    projectedRenderTriangleCount: prepared.payload?.plan?.projectedRenderTriangleCount || 0,
    screenProjectedCoverageActive: prepared.payload?.plan?.screenProjectedCoverageActive === true,
    screenProjectedStrokeSegmentCount: prepared.payload?.plan?.screenProjectedStrokeSegmentCount || 0,
    visibilityMaskBytes: textureAirbrushPixelPayloadByteLength(options.visibilityMaskPixels),
    liveDisplayExternalTexture: Boolean(liveDisplayTexture),
    liveDisplayFullUpdate: liveDisplayStats?.displayFullUpdate ?? null,
    liveDisplayWorkPixels: liveDisplayStats?.displayWorkPixels ?? 0,
    liveDisplayBounds: liveDisplayStats?.displayBounds || null,
    liveDisplayMipmapDirty: liveDisplayStats?.mipmapStats?.dirty ?? null,
    liveDisplayMipmapDeferred: liveDisplayStats?.mipmapStats?.deferred === true,
    liveDisplayMipmapPixels: liveDisplayStats?.mipmapStats?.pixels ?? 0,
    liveDisplayMipmapDowngraded: liveDisplayStats?.mipmapDowngraded === true,
    liveDisplayMipmapDowngradeBlocked: liveDisplayStats?.mipmapDowngradeBlocked === true,
    sourceBytes: needsSource ? prepared.sourcePixels?.byteLength || 0 : 0,
    sourceExternalUploaded: run.resources?.sourceExternalUploaded === true,
    strokeSourceBytes: strokeSourcePixels?.byteLength || (uploadsSourceAsStrokeSource ? prepared.sourcePixels?.byteLength || 0 : 0),
    strokeSourceCopiedFromSource: run.resources?.strokeSourceCopiedFromSource === true || uploadsExternalSourceAsStrokeSource,
    readbackBytes: pixels?.byteLength || 0,
    appliedBytes: applied?.byteLength || 0,
    reusedResources: Boolean(reuseResources),
    reusedReadbackBuffer: run.resources?.readbackBufferReused === true,
    reusedApplyImageData: applied?.reusedImageData === true,
    deferredReadback,
    deferredReadbackCopy: statsDeferredReadbackCopy,
    deferredCanvasSync: false,
    timings: {
      prepareMs: Math.max(0, preparedMs - startMs),
      dispatchMs: Math.max(0, dispatchMs - dispatchStartMs),
      readbackMs: Math.max(0, readbackMs - readbackStartMs),
      applyMs: Math.max(0, applyMs - readbackMs),
      totalMs: Math.max(0, applyMs - startMs)
    }
  });

  let deferredReadbackToken = null;
  const deferredReadbackCancelled = () => Boolean(
    deferReadbackApply
    && deferredReadbackToken
    && cache
    && cache.deferredReadbackApplyToken !== deferredReadbackToken
  );
  const finalizeReadbackApply = async () => {
    if (deferredReadbackCancelled()) {
      return {
        ...run,
        payload: prepared.payload,
        sourcePixels: prepared.sourcePixels,
        pixels: null,
        applied: null,
        stats: baseStats({
          deferredReadback: deferReadbackApply,
          deferredReadbackCopy: deferReadbackCopy
        })
      };
    }
    const readbackStartMs = textureAirbrushNow(options);
    const pixels = await textureAirbrushReadWebGpuPaintResult(run.result, options);
    if (deferredReadbackCancelled()) {
      return {
        ...run,
        payload: prepared.payload,
        sourcePixels: prepared.sourcePixels,
        pixels: null,
        applied: null,
        stats: baseStats({
          readbackStartMs,
          readbackMs: textureAirbrushNow(options),
          deferredReadback: deferReadbackApply,
          deferredReadbackCopy: deferReadbackCopy
        })
      };
    }
    const readbackMs = textureAirbrushNow(options);
    if (textureAirbrushDebugSnapshotRequested()) {
      const root = window?.document?.documentElement || null;
      const layout = plannedReadbackLayout || null;
      if (root?.dataset && pixels && layout?.width && layout?.height) {
        root.dataset.textureAirbrushDebugImmediateReadbackBounds = JSON.stringify({
          x: layout.x || 0,
          y: layout.y || 0,
          width: layout.width || 0,
          height: layout.height || 0
        });
        root.dataset.textureAirbrushDebugImmediateReadbackPixelStats = JSON.stringify(
          textureAirbrushDebugPixelStats(pixels, layout.width, layout.height)
        );
      }
    }
    const updatedStrokeSourceImageData = textureAirbrushUpdateImageDataBounds(
      cache?.strokeSourceImageData,
      pixels,
      plannedReadbackLayout
    );
    const applied = textureAirbrushApplyPixelsToEditable(editable, pixels, {
      imageData: prepared.imageData,
      material: options.material || null,
      bounds: plannedReadbackLayout,
      reusableImageData: cache?.applyImageData || null
    });
    if (cache && applied?.putImageData) {
      cache.applyImageData = applied.putImageData;
    }
    if (applied) {
      textureAirbrushExposeDebugCanvasSnapshot(editable, {
        x: applied.x,
        y: applied.y,
        width: applied.width,
        height: applied.height
      }, {
        applied: true,
        deferredCanvasSync: false,
        materialName: options.material?.name || "",
        byteLength: applied.byteLength
      });
    }
    if (cache) {
      if (!applied) {
        cache.strokeSourceMatchesSource = false;
      } else if (textureAirbrushImageDataMatchesSize(applied.imageData, prepared.width, prepared.height)) {
        cache.strokeSourceImageData = applied.imageData;
        cache.strokeSourceMatchesSource = true;
      } else if (updatedStrokeSourceImageData) {
        cache.strokeSourceImageData = updatedStrokeSourceImageData;
        cache.strokeSourceMatchesSource = true;
      } else {
        cache.strokeSourceMatchesSource = false;
      }
      if (applied) {
        cache.gpuSourceMatchesEditable = Boolean(
          cache.gpuSourceMatchesEditable === true
          || run.resources?.sourceUploaded === true
          || needsSource !== true
        );
      }
    }
    const applyMs = textureAirbrushNow(options);
    const stats = textureAirbrushRecordEditableWebGpuPaintStats(editor, baseStats({
      pixels,
      applied,
      readbackStartMs,
      readbackMs,
      applyMs,
      deferredReadback: deferReadbackApply,
      deferredReadbackCopy: deferReadbackCopy
    }));
    return {
      ...run,
      payload: prepared.payload,
      sourcePixels: prepared.sourcePixels,
      pixels,
      applied,
      stats
    };
  };

  if (deferReadbackApply) {
    if (deferReadbackCopy) {
      textureAirbrushQueueDeferredWebGpuCanvasSync(editor, editable, cache, prepared, run, {
        ...options,
        refreshSource: needsSource,
        refreshStrokeSource: strokeSourceUploaded,
        liveDisplayExternalTexture: Boolean(liveDisplayTexture),
        liveDisplayStats,
        reusedResources: Boolean(reuseResources)
      });
      const immediateMs = textureAirbrushNow(options);
      const stats = textureAirbrushRecordEditableWebGpuPaintStats(editor, baseStats({
        applyMs: immediateMs,
        deferredReadback: true,
        deferredReadbackCopy: true
      }));
      return {
        ...run,
        payload: prepared.payload,
        sourcePixels: prepared.sourcePixels,
        pixels: null,
        applied: {
          deferred: true,
          byteLength: 0,
          bounds: textureAirbrushDirtyBoundsFromLayout(plannedReadbackLayout)
        },
        stats,
        readbackPromise: null
      };
    }
    const previousReadback = cache?.deferredReadbackApplyChain || Promise.resolve();
    const readbackStartGate = options.deferReadbackStart === true
      ? textureAirbrushDeferredReadbackStartGate(editor)
      : null;
    if (cache) {
      cache.deferredReadbackApplyPending = true;
    }
    deferredReadbackToken = {};
    if (cache) {
      cache.deferredReadbackApplyToken = deferredReadbackToken;
    }
    const readbackPromise = previousReadback
      .then(() => readbackStartGate?.promise || null)
      .then(finalizeReadbackApply)
      .finally(() => {
        readbackStartGate?.release?.();
        if (cache?.deferredReadbackApplyToken === deferredReadbackToken) {
          cache.deferredReadbackApplyPending = false;
          cache.deferredReadbackApplyToken = null;
        }
      });
    if (cache) {
      cache.deferredReadbackApplyChain = readbackPromise.catch(() => null);
    }
    const immediateMs = textureAirbrushNow(options);
    return {
      ...run,
      payload: prepared.payload,
      sourcePixels: prepared.sourcePixels,
      pixels: null,
      applied: {
        deferred: true,
        byteLength: 0,
        bounds: textureAirbrushDirtyBoundsFromLayout(plannedReadbackLayout)
      },
      stats: baseStats({
        applyMs: immediateMs,
        deferredReadback: true
      }),
      readbackPromise
    };
  }

  return finalizeReadbackApply();
}
