import {
  TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS,
  TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE
} from "./constants.js";
import { installTextureAirbrushWebGpuCandidateMethods } from "./webgpu-candidates.js";
import {
  textureAirbrushCachedWebGpuStrokeSourceImage,
  textureAirbrushEditableWebGpuStrokeSourceCurrent,
  textureAirbrushWebGpuCacheForEditable
} from "./webgpu-canvas.js";
import {
  texturePaintCanUseTslSurfaceAirbrush,
  texturePaintRunTslSurfaceAirbrush
} from "../../texture-paint/surface-airbrush-tsl.js";
import { textureAirbrushWebGpuAssignVisibilityMasks } from "./webgpu-projection.js";
import { textureAirbrushWebGpuStrokeEstimate } from "./webgpu-stroke.js";
import { textureAirbrushRecordIdentity } from "./record-identity.js";
import { airbrushHaloRadius } from "./math.js";

const TEXTURE_AIRBRUSH_WEBGPU_VISIBLE_MAX_BATCH_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_TSL_SURFACE_MAX_STROKE_SEGMENTS = Math.min(48, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
const TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_SLOT_STRIDE = 4;
const TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES = Math.max(
  1,
  Math.floor(
    (TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS - TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE)
      / TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_SLOT_STRIDE
  )
);
const TEXTURE_AIRBRUSH_WEBGPU_IMMEDIATE_FLUSH_MAX_BATCHES = 32;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_IMMEDIATE_FLUSH_MAX_BATCHES = 2;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_DIRECT_LIVE_IMMEDIATE_FLUSH_MAX_BATCHES = TEXTURE_AIRBRUSH_WEBGPU_IMMEDIATE_FLUSH_MAX_BATCHES;
const TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_SCHEDULED_FLUSH_MAX_BATCHES = 8;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_BATCH_AREA_PIXELS = 4_000_000;
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISJOINT_BATCH_AREA_PIXELS = 1_600_000;
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_NEIGHBOR_BATCH_AREA_PIXELS = 150_000;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MIN_RADIUS_PIXELS = 18;
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_SCREEN_VISIBILITY_TRIANGLES = 128;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_SCREEN_VISIBILITY_TRIANGLES = Math.min(
  TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
);
const TEXTURE_AIRBRUSH_WEBGPU_NEIGHBOR_SCREEN_VISIBILITY_TRIANGLES = TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES;
const TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_LIVE_DISPLAY_MAX_PIXELS = 64 * 1024 * 1024;
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_MIN_REFRESH_MS = 16;
const TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_MIPMAP_IMMEDIATE_PIXELS = 32 * 1024;
const TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_LARGE_MIPMAP_IMMEDIATE_PIXELS = 2 * 1024 * 1024;
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_MAX_DIRTY_REGIONS = 16;
const TEXTURE_AIRBRUSH_WEBGPU_PROJECTED_LIVE_DISPLAY_MAX_DIRTY_REGIONS = 96;
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_COALESCE_AREA_RATIO = 1.75;
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_COALESCE_MAX_WASTE_PIXELS = 256 * 1024;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MAX_QUEUED_BATCHES = 64;
const TEXTURE_AIRBRUSH_WEBGPU_CANVAS_SYNC_POINTER_QUIET_MS = 2200;
const TEXTURE_AIRBRUSH_LIVE_DEBUG_VERBOSE_LABELS = new Set([
  "candidate-result"
]);
const webGpuCandidateVisibilityIdentityKeys = new WeakMap();

function debugImmediateWebGpuReadbackRequested() {
  return typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushImmediateReadback");
}

function textureAirbrushWebGpuPaintResultHasVisibleEffect(result = null) {
  if (!result) {
    return false;
  }
  if (result.readbackPromise) {
    return true;
  }
  if (result.pixels?.byteLength || result.applied?.byteLength) {
    return true;
  }
  const stats = result.stats || null;
  if (stats?.liveDisplayExternalTexture && Math.max(0, Number(stats.liveDisplayWorkPixels) || 0) > 0) {
    return true;
  }
  if (stats?.liveDisplayExternalTexture && stats.liveDisplayFullUpdate === true) {
    return true;
  }
  if (stats?.liveDisplayTslRenderTarget === true) {
    return true;
  }
  if (result.applied?.deferred === true) {
    return Boolean(
      stats?.liveDisplayExternalTexture
      || stats?.liveDisplayTslRenderTarget
      || result.stats?.deferredReadbackCopy
      || result.deferredReadbackCopy
    );
  }
  return false;
}

function textureAirbrushWebGpuPaintResultIsIntentionalNoop(result = null) {
  const stats = result?.stats || null;
  return Boolean(
    stats?.tslSurfaceSkippedDuplicateSegments === true
    || stats?.tslSurfaceSkippedStaleFullSurfaceRender === true
  );
}

function textureAirbrushWebGpuPaintResultWorkPixels(result = null, fallback = 0) {
  const stats = result?.stats || null;
  if (Number.isFinite(Number(stats?.liveDisplayWorkPixels))) {
    return Math.max(0, Math.floor(Number(stats.liveDisplayWorkPixels)));
  }
  if (stats?.liveDisplayTslRenderTarget === true) {
    return 0;
  }
  return Math.max(0, Math.floor(Number(fallback) || 0));
}

function exposeLiveWebGpuDebugEntry(entry = null) {
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
    queued: detail.queued ?? null,
    flushing: detail.flushing ?? null,
    remaining: detail.remaining ?? null,
    force: detail.force ?? null,
    maxBatches: detail.maxBatches ?? null,
    estimate: detail.estimate ?? null
  });
  if (entry.label === "flush-start") {
    root.dataset.textureAirbrushDebugFlushStartCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugFlushStartCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugFlushMaxBatches = String(detail.maxBatches ?? "");
    root.dataset.textureAirbrushDebugFlushQueued = String(detail.queued ?? "");
    root.dataset.textureAirbrushDebugFlushFlushing = String(detail.flushing ?? "");
    root.dataset.textureAirbrushDebugFlushForce = String(detail.force === true);
  } else if (entry.label === "flush-finished") {
    root.dataset.textureAirbrushDebugFlushQueued = String(detail.remaining ?? 0);
    root.dataset.textureAirbrushDebugFlushFlushing = "0";
  } else if (entry.label === "candidate-result") {
    const estimate = Math.max(0, Math.floor(Number(detail.estimate) || 0));
    const timings = detail.timings || {};
    root.dataset.textureAirbrushDebugCandidateResultCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugCandidateResultCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugCandidateEstimateTotal = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugCandidateEstimateTotal) || 0)) + estimate
    );
    const candidate = detail.candidate || null;
    root.dataset.textureAirbrushDebugCandidateEstimate = String(detail.estimate ?? "");
    root.dataset.textureAirbrushDebugCandidateMaterial = String(candidate?.materialName || "");
    root.dataset.textureAirbrushDebugCandidateMaterialIndex = String(candidate?.materialIndex ?? "");
    root.dataset.textureAirbrushDebugCandidateLayerMode = String(candidate?.layerMode === true);
    root.dataset.textureAirbrushDebugCandidateEditableSize = JSON.stringify({
      width: candidate?.editableWidth ?? null,
      height: candidate?.editableHeight ?? null
    });
    root.dataset.textureAirbrushDebugCandidateRadius = String(candidate?.radiusPixels ?? "");
    root.dataset.textureAirbrushDebugCandidateSegments = String(candidate?.segmentCount ?? "");
    root.dataset.textureAirbrushDebugCandidateNonZeroSegments = String(candidate?.nonZeroSegmentCount ?? "");
    root.dataset.textureAirbrushDebugCandidateFirstSegment = candidate?.firstSegment
      ? JSON.stringify(candidate.firstSegment)
      : "";
    root.dataset.textureAirbrushDebugCandidateStrokeSegments = Array.isArray(candidate?.strokeSegments)
      ? JSON.stringify(candidate.strokeSegments)
      : "";
    root.dataset.textureAirbrushDebugCandidateVisibilityTriangles = String(
      detail.visibilityTriangleCount ?? candidate?.visibilityTriangleCount ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateVisibilitySamples = String(
      detail.visibilitySampleCount ?? candidate?.visibilitySampleCount ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateScreenProjectedSegments = String(
      candidate?.screenProjectedSegmentCount ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateDebugCounts = candidate?.candidateDebugCounts
      ? JSON.stringify(candidate.candidateDebugCounts)
      : "";
    root.dataset.textureAirbrushDebugCandidateInternalTiming = candidate?.candidateTimingMs
      ? JSON.stringify(candidate.candidateTimingMs)
      : "";
    root.dataset.textureAirbrushDebugCandidateFirstScreenProjectedSegment = candidate?.firstScreenProjectedSegment
      ? JSON.stringify(candidate.firstScreenProjectedSegment)
      : "";
    root.dataset.textureAirbrushDebugCandidateScreenProjectedStrokeSegments = Array.isArray(candidate?.screenProjectedStrokeSegments)
      ? JSON.stringify(candidate.screenProjectedStrokeSegments)
      : "";
    root.dataset.textureAirbrushDebugCandidateBounds = JSON.stringify(candidate?.bounds || null);
    root.dataset.textureAirbrushDebugCandidateRegionCount = String(candidate?.regionCount ?? "");
    root.dataset.textureAirbrushDebugCandidateRegions = Array.isArray(candidate?.paintRegions)
      ? JSON.stringify(candidate.paintRegions)
      : "";
    root.dataset.textureAirbrushDebugCandidateCenter = candidate?.center
      ? JSON.stringify(candidate.center)
      : "";
    root.dataset.textureAirbrushDebugCandidateStart = candidate?.start
      ? JSON.stringify(candidate.start)
      : "";
    root.dataset.textureAirbrushDebugCandidateFirstTriangle = candidate?.firstTriangle
      ? JSON.stringify(candidate.firstTriangle)
      : "";
    root.dataset.textureAirbrushDebugCandidateCenterInsideAnyTriangle = String(
      candidate?.centerInsideAnyTriangle ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateFirstSegmentNearAnyTriangle = String(
      candidate?.firstSegmentNearAnyTriangle ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateVisibleEdgeMode = String(
      candidate?.options?.visibleEdgeMode ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateVisibilityFeatherRadius = String(
      candidate?.options?.visibilityFeatherRadius ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateVisibilityMaskThreshold = String(
      candidate?.options?.visibilityMaskThreshold ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateVisibilityBleedRadius = String(
      candidate?.options?.visibilityBleedRadius ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateLiveDisplayPixels = String(detail.liveDisplayWorkPixels ?? "");
    root.dataset.textureAirbrushDebugCandidateLiveDisplayMipmapPixels = String(detail.liveDisplayMipmapPixels ?? "");
    root.dataset.textureAirbrushDebugCandidateLiveDisplayMipmapDeferred = String(
      detail.liveDisplayMipmapDeferred ?? ""
    );
    root.dataset.textureAirbrushDebugCandidateTimingPrepareMs = String(timings.prepareMs ?? "");
    root.dataset.textureAirbrushDebugCandidateTimingDispatchMs = String(timings.dispatchMs ?? "");
    root.dataset.textureAirbrushDebugCandidateTimingReadbackMs = String(timings.readbackMs ?? "");
    root.dataset.textureAirbrushDebugCandidateTimingApplyMs = String(timings.applyMs ?? "");
    root.dataset.textureAirbrushDebugCandidateTimingTotalMs = String(timings.totalMs ?? "");
  } else if (entry.label === "live-candidate-queue") {
    root.dataset.textureAirbrushDebugLiveCandidateQueueCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveCandidateQueueCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugLiveCandidateSourceCount = String(detail.sourceCandidates ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateBatchCount = String(detail.batches ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateVisibilityOnly = String(detail.visibilityOnly ?? "");
    root.dataset.textureAirbrushDebugLiveCandidatePaint = String(detail.paintCandidates ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateQueuedBefore = String(detail.queuedBefore ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateQueuedAfter = String(detail.queuedAfter ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateQueuedDelta = String(detail.queuedDelta ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateEstimate = String(detail.estimate ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateLargeNeighbor = String(detail.largeNeighbor === true);
    root.dataset.textureAirbrushDebugLiveCandidateLargeBrush = String(detail.largeBrush === true);
    root.dataset.textureAirbrushDebugLiveCandidateOverflow = String(detail.visibilityOverflow === true);
    root.dataset.textureAirbrushDebugLiveCandidateRadius = String(detail.radiusPixels ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateOpacity = String(detail.opacity ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateHardness = String(detail.hardness ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateScatter = String(detail.scatter ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateVisibleEdgeMode = String(detail.visibleEdgeMode ?? "");
    root.dataset.textureAirbrushDebugLiveCandidateVisibilityFeatherRadius = String(
      detail.visibilityFeatherRadius ?? ""
    );
    root.dataset.textureAirbrushDebugLiveCandidateVisibilityMaskThreshold = String(
      detail.visibilityMaskThreshold ?? ""
    );
    root.dataset.textureAirbrushDebugLiveCandidateVisibilityBleedRadius = String(
      detail.visibilityBleedRadius ?? ""
    );
    root.dataset.textureAirbrushDebugLiveCandidateColor = detail.color
      ? JSON.stringify(detail.color)
      : "";
    if (detail.largeNeighbor === true) {
      root.dataset.textureAirbrushDebugLiveCandidateLargeNeighborTrueCount = String(
        Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveCandidateLargeNeighborTrueCount) || 0)) + 1
      );
    } else if (detail.largeBrush === true) {
      root.dataset.textureAirbrushDebugLiveCandidateLargeBrushNonNeighborCount = String(
        Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLiveCandidateLargeBrushNonNeighborCount) || 0)) + 1
      );
      root.dataset.textureAirbrushDebugLiveCandidateLargeBrushNonNeighborDetail = JSON.stringify({
        hasNeighborSeed: detail.hasNeighborSeed === true,
        largeLiveNeighborPaint: detail.largeLiveNeighborPaint === true,
        neighborPaintKey: detail.neighborPaintKey || "",
        layerMode: detail.layerMode === true,
        screenStrokePaint: detail.screenStrokePaint === true,
        strokeReset: detail.strokeReset === true,
        strokeStartedWithReset: detail.strokeStartedWithReset === true,
        radiusPixels: detail.radiusPixels ?? null,
        sourceCandidates: detail.sourceCandidates ?? null,
        batches: detail.batches ?? null,
        queuedDelta: detail.queuedDelta ?? null
      });
    }
  }
}

function debugLiveWebGpuAirbrush(label = "", detail = {}) {
  if (
    typeof window === "undefined"
    || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")
  ) {
    return;
  }
  const params = new URLSearchParams(window.location?.search || "");
  if (
    TEXTURE_AIRBRUSH_LIVE_DEBUG_VERBOSE_LABELS.has(label)
    && !params.has("debugAirbrushVerbose")
  ) {
    return;
  }
  const entry = {
    time: Date.now(),
    source: "webgpu-live",
    label,
    detail
  };
  exposeLiveWebGpuDebugEntry(entry);
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

function clampByte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(number)));
}

function styleNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function liveStatusNow(editor = null) {
  const explicit = Number(editor?.textureAirbrushStatusNow?.());
  if (Number.isFinite(explicit)) {
    return explicit;
  }
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function setThrottledWebGpuLiveStatus(editor = null, message = "", intervalMs = 120) {
  if (!editor || typeof editor.setStatus !== "function") {
    return false;
  }
  const now = liveStatusNow(editor);
  const previous = Number(editor.textureAirbrushLastWebGpuLiveStatusMs) || 0;
  if (now - previous < Math.max(0, Number(intervalMs) || 0)) {
    return false;
  }
  editor.textureAirbrushLastWebGpuLiveStatusMs = now;
  editor.setStatus(message);
  return true;
}

function webGpuCanvasSyncIdle(editor = null, options = {}) {
  const now = liveStatusNow(editor);
  const lastPointerMs = Number(editor?.texturePaintLastPointerEventAt) || 0;
  const pointerQuietMs = Math.max(
    0,
    styleNumber(
      options.canvasSyncPointerQuietMs ?? editor?.textureAirbrushDeferredCanvasSyncPointerQuietMs,
      TEXTURE_AIRBRUSH_WEBGPU_CANVAS_SYNC_POINTER_QUIET_MS
    )
  );
  const controls = editor?.controls || null;
  const controlsTrackingPointers = Array.isArray(controls?._pointers)
    && controls._pointers.length > 0;
  const controlsInteracting = controlsTrackingPointers
    || (controls && "state" in controls && Number(controls.state) !== -1);
  return Boolean(
    editor
    && editor.painting !== true
    && (!lastPointerMs || now - lastPointerMs >= pointerQuietMs)
    && editor.textureAirbrushFlushingScreenStroke !== true
    && editor.textureAirbrushCameraMotionSettling !== true
    && !controlsInteracting
    && !(editor.textureAirbrushQueuedWebGpuStrokes || []).length
    && !(editor.textureAirbrushScreenStrokeQueue || []).length
    && !(editor.textureAirbrushPendingScreenStrokeBatches || []).length
    && !editor.textureAirbrushWebGpuFlushInFlight
  );
}

function trimLargeLiveQueue(queue = [], maxBatches = TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MAX_QUEUED_BATCHES) {
  if (!Array.isArray(queue)) {
    return 0;
  }
  const limit = Math.max(1, Math.floor(Number(maxBatches) || 1));
  let trimmed = 0;
  const largeLiveCount = () => queue.reduce((total, batch) => (
    total + (largeLiveWebGpuBatch(batch) ? 1 : 0)
  ), 0);
  while (largeLiveCount() >= limit) {
    const index = queue.findIndex((batch) => largeLiveWebGpuBatch(batch));
    if (index < 0) {
      break;
    }
    queue.splice(index, 1);
    trimmed += 1;
  }
  return trimmed;
}

function webGpuLiveStrokeActive(editor = null) {
  return Boolean(
    editor
    && (
      editor.painting === true
      || editor.textureAirbrushFlushingScreenStroke === true
      || (editor.textureAirbrushScreenStrokeQueue || []).length
      || (editor.textureAirbrushPendingScreenStrokeBatches || []).length
    )
  );
}

function queuedWebGpuScreenStrokePaintActive(editor = null) {
  return (editor?.textureAirbrushQueuedWebGpuStrokes || []).some((batch) => (
    batch?.options?.screenStrokePaint === true
    || batch?.screenStrokePaint === true
  ));
}

function largeLiveWebGpuBatch(batch = null) {
  return Boolean(
    batch?.options?.largeLiveBrushPaint === true
    || batch?.options?.largeLiveNeighborPaint === true
    || (Number(batch?.radiusPixels) || 0) >= 24
    || (Number(batch?.options?.radiusPixels) || 0) >= 24
  );
}

function heavyLargeLiveWebGpuBatch(batch = null) {
  return Boolean(
    batch?.options?.largeLiveNeighborPaint === true
    || batch?.options?.liveVisibilityOverflowBatch === true
    || batch?.liveVisibilityOverflowBatch === true
  );
}

function largeLiveWebGpuFlushBatchLimit(queue = []) {
  const batches = Array.isArray(queue) ? queue : [];
  if (!batches.some(largeLiveWebGpuBatch)) {
    return null;
  }
  return batches.some(heavyLargeLiveWebGpuBatch)
    ? TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_IMMEDIATE_FLUSH_MAX_BATCHES
    : TEXTURE_AIRBRUSH_WEBGPU_LARGE_DIRECT_LIVE_IMMEDIATE_FLUSH_MAX_BATCHES;
}

function waitForWebGpuCanvasSyncIdle(editor = null, options = {}) {
  if (!editor || options.deferCanvasSyncUntilIdle !== true) {
    return Promise.resolve(false);
  }
  const delayMs = Math.max(0, styleNumber(options.canvasSyncIdleDelayMs, 1200));
  const pollMs = Math.max(16, styleNumber(options.canvasSyncIdlePollMs, 50));
  const maxDelayMs = Math.max(delayMs, styleNumber(options.canvasSyncMaxDelayMs, 5000));
  const startedAt = liveStatusNow(editor);
  let idleSince = null;
  return new Promise((resolve) => {
    const schedule = typeof globalThis.setTimeout === "function"
      ? globalThis.setTimeout.bind(globalThis)
      : null;
    const check = () => {
      const now = liveStatusNow(editor);
      const elapsed = now - startedAt;
      const idle = webGpuCanvasSyncIdle(editor, options);
      idleSince = idle
        ? idleSince ?? now
        : null;
      if (idle && now - idleSince >= delayMs) {
        resolve(true);
        return;
      }
      if (elapsed >= maxDelayMs && editor.painting !== true) {
        resolve(true);
        return;
      }
      if (!schedule) {
        resolve(true);
        return;
      }
      schedule(check, pollMs);
    };
    check();
  });
}

function scheduleWebGpuQueuedPaintDrainStep(callback = null) {
  if (typeof callback !== "function") {
    return false;
  }
  const host = typeof window !== "undefined" ? window : globalThis;
  if (typeof host?.requestAnimationFrame === "function") {
    host.requestAnimationFrame(() => callback());
    return true;
  }
  if (typeof host?.setTimeout === "function") {
    host.setTimeout(callback, 0);
    return true;
  }
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return true;
  }
  callback();
  return true;
}

function waitForWebGpuQueuedPaintDrain(editor = null, options = {}) {
  if (!editor) {
    return Promise.resolve(false);
  }
  const budget = Number.isFinite(Number(options.maxQueuedWebGpuFlushBatches))
    ? Math.max(1, Math.floor(Number(options.maxQueuedWebGpuFlushBatches)))
    : TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_SCHEDULED_FLUSH_MAX_BATCHES;
  const flushOptions = {
    ...options,
    force: false,
    autoSchedule: false,
    maxBatches: budget,
    deferReadbackStart: options.deferReadbackStart !== false
      && options.deferCanvasSyncUntilIdle === true,
    liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false
  };
  return new Promise((resolve, reject) => {
    const step = () => {
      const inFlight = editor.textureAirbrushWebGpuFlushInFlight || null;
      if (inFlight) {
        Promise.resolve(inFlight).then(() => {
          scheduleWebGpuQueuedPaintDrainStep(step);
        }, reject);
        return;
      }
      if (!(editor.textureAirbrushQueuedWebGpuStrokes || []).length) {
        resolve(true);
        return;
      }
      let flushed = null;
      try {
        flushed = editor.flushTextureAirbrushQueuedWebGpuStrokes?.(flushOptions) || 0;
      } catch (error) {
        reject(error);
        return;
      }
      Promise.resolve(flushed).then(() => {
        if (
          editor.textureAirbrushWebGpuFlushInFlight
          || (editor.textureAirbrushQueuedWebGpuStrokes || []).length
        ) {
          scheduleWebGpuQueuedPaintDrainStep(step);
          return;
        }
        resolve(true);
      }, reject);
    };
    step();
  });
}

function finitePoint(point = null) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  const output = {
    x: Number(point.x),
    y: Number(point.y)
  };
  for (const key of ["z", "viewX", "viewY", "viewZ", "clipW"]) {
    const value = Number(point?.[key]);
    if (Number.isFinite(value)) {
      output[key] = value;
    }
  }
  return output;
}

function finiteViewPoint(point = null) {
  const x = Number.isFinite(Number(point?.viewX)) ? Number(point.viewX) : Number(point?.x);
  const y = Number.isFinite(Number(point?.viewY)) ? Number(point.viewY) : Number(point?.y);
  const z = Number.isFinite(Number(point?.viewZ)) ? Number(point.viewZ) : Number(point?.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    ? { x, y, z }
    : null;
}

function screenPointClipW(point = null) {
  const explicit = Number(point?.clipW ?? point?.w);
  if (Number.isFinite(explicit) && Math.abs(explicit) > 0.000001) {
    return Math.abs(explicit);
  }
  const viewZ = Number(point?.viewZ);
  if (Number.isFinite(viewZ) && Math.abs(viewZ) > 0.000001) {
    return Math.abs(viewZ);
  }
  return null;
}

function screenPerspectiveScale(base = null, point = null) {
  const baseW = screenPointClipW(base);
  const pointW = screenPointClipW(point);
  if (!Number.isFinite(baseW) || !Number.isFinite(pointW) || baseW <= 0.000001) {
    return null;
  }
  return Math.max(0.000001, Math.min(1000000, pointW / baseW));
}

function projectedSurfaceBrushDomainRadius(radiusPixels = 1, scatter = 0, hardness = 0.35) {
  const haloRadius = airbrushHaloRadius(Math.max(0.75, Number(radiusPixels) || 0.75), scatter, hardness);
  return Math.max(haloRadius + 12, haloRadius * 1.45 + 8);
}

function finiteClientPoint(point = null) {
  if (Number.isFinite(point?.clientX) && Number.isFinite(point?.clientY)) {
    return {
      clientX: Number(point.clientX),
      clientY: Number(point.clientY)
    };
  }
  if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
    return {
      clientX: Number(point.x),
      clientY: Number(point.y)
    };
  }
  return null;
}

function clientPointDistance(left = null, right = null) {
  const start = finiteClientPoint(left);
  const end = finiteClientPoint(right);
  if (!start || !end) {
    return 0;
  }
  const dx = end.clientX - start.clientX;
  const dy = end.clientY - start.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function liveStrokeScreenDistance(event = null, options = {}) {
  const segments = Array.isArray(options.strokeSegments) ? options.strokeSegments : [];
  let distance = 0;
  for (const segment of segments) {
    distance += clientPointDistance(segment?.start, segment?.end);
  }
  if (distance > 0.0001) {
    return distance;
  }
  return clientPointDistance(options.strokeStart, event);
}

function liveNeighborVisibilityProbeBudget(editor = null, event = null, options = {}) {
  const explicit = Number(options.maxVisibilityProbePoints);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(2, Math.floor(explicit));
  }
  const radius = Math.max(
    1,
    Number(options.radiusPixels) || Number(editor?.textureBrushRadiusScreenPixels?.()) || 8
  );
  const distance = liveStrokeScreenDistance(event, options);
  const step = Math.max(8, Math.min(18, radius * 1.15));
  return Math.max(2, Math.min(6, Math.ceil(distance / step) + 1));
}

function liveVisibilityProbeBudget(editor = null, event = null, options = {}) {
  const explicit = Number(options.maxVisibilityProbePoints);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(2, Math.floor(explicit));
  }
  const radius = Math.max(
    1,
    Number(options.radiusPixels) || Number(editor?.textureBrushRadiusScreenPixels?.()) || 8
  );
  const distance = liveStrokeScreenDistance(event, options);
  const step = Math.max(6, Math.min(18, radius * 0.45));
  return Math.max(4, Math.min(18, Math.ceil(distance / step) + 2));
}

function liveFootprintVisibilityProbeBudget(editor = null, event = null, options = {}) {
  const explicit = Number(options.maxVisibilityFootprintProbePoints);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(4, Math.floor(explicit));
  }
  const radius = Math.max(
    1,
    Number(options.radiusPixels) || Number(editor?.textureBrushRadiusScreenPixels?.()) || 8
  );
  const orderedBudget = liveVisibilityProbeBudget(editor, event, options);
  const radiusCap = radius >= 72 ? 48 : radius >= 48 ? 36 : 24;
  return Math.max(10, Math.min(radiusCap, orderedBudget * 2));
}

function compactVisibilitySample(sample = null) {
  if (sample?.segment) {
    const start = finitePoint(sample.segment.start);
    const end = finitePoint(sample.segment.end);
    return start && end ? { segment: { start, end } } : null;
  }
  const point = finitePoint(sample);
  return point ? { x: point.x, y: point.y } : null;
}

function visibilitySampleKey(sample = null) {
  if (sample?.segment) {
    const start = finitePoint(sample.segment.start);
    const end = finitePoint(sample.segment.end);
    return start && end
      ? `s:${Math.round(start.x * 10)},${Math.round(start.y * 10)}>${Math.round(end.x * 10)},${Math.round(end.y * 10)}`
      : "";
  }
  const point = finitePoint(sample);
  return point ? `p:${Math.round(point.x * 10)},${Math.round(point.y * 10)}` : "";
}

function candidateVisibilitySamples(candidate = null) {
  return (Array.isArray(candidate?.options?.visibilityMaskSamples)
    ? candidate.options.visibilityMaskSamples
    : [])
    .map(compactVisibilitySample)
    .filter(Boolean);
}

function compactVisibilityTriangle(triangle = null) {
  const a = finitePoint(triangle?.a || triangle?.[0]);
  const b = finitePoint(triangle?.b || triangle?.[1]);
  const c = finitePoint(triangle?.c || triangle?.[2]);
  if (!a || !b || !c) {
    return null;
  }
  const screenA = finitePoint(triangle?.screenA || triangle?.screen?.a);
  const screenB = finitePoint(triangle?.screenB || triangle?.screen?.b);
  const screenC = finitePoint(triangle?.screenC || triangle?.screen?.c);
  const hasScreenTriangle = Boolean(screenA && screenB && screenC);
  const screenBScale = Number.isFinite(Number(triangle?.screenBScale))
    ? Math.max(0.000001, Math.min(1000000, Number(triangle.screenBScale)))
    : hasScreenTriangle
      ? screenPerspectiveScale(screenA, screenB)
      : null;
  const screenCScale = Number.isFinite(Number(triangle?.screenCScale))
    ? Math.max(0.000001, Math.min(1000000, Number(triangle.screenCScale)))
    : hasScreenTriangle
      ? screenPerspectiveScale(screenA, screenC)
      : null;
  const coverage = Number(triangle?.coverage);
  const componentId = Math.floor(Number(triangle?.componentId));
  return {
    a,
    b,
    c,
    ...(hasScreenTriangle
      ? {
          screenA,
          screenB,
          screenC,
          ...(Number.isFinite(screenBScale) && Number.isFinite(screenCScale)
            ? { screenBScale, screenCScale }
            : {})
        }
      : {}),
    ...(Number.isInteger(componentId) && componentId >= 0 ? { componentId } : {}),
    ...(Number.isFinite(coverage) && coverage < 0.999999
      ? { coverage: Math.max(0, Math.min(1, coverage)) }
      : {})
  };
}

function visibilityTriangleKey(triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  return compact
    ? [
        Math.round(compact.a.x * 10),
        Math.round(compact.a.y * 10),
        Math.round(compact.b.x * 10),
        Math.round(compact.b.y * 10),
        Math.round(compact.c.x * 10),
        Math.round(compact.c.y * 10),
        Math.round((compact.screenA?.x ?? 0) * 10),
        Math.round((compact.screenA?.y ?? 0) * 10),
        Math.round((compact.screenB?.x ?? 0) * 10),
        Math.round((compact.screenB?.y ?? 0) * 10),
        Math.round((compact.screenC?.x ?? 0) * 10),
        Math.round((compact.screenC?.y ?? 0) * 10),
        Math.round((Number.isFinite(compact.screenBScale) ? compact.screenBScale : 1) * 100000),
        Math.round((Number.isFinite(compact.screenCScale) ? compact.screenCScale : 1) * 100000),
        Number.isInteger(compact.componentId) ? compact.componentId : -1,
        Math.round((Number.isFinite(compact.coverage) ? compact.coverage : 1) * 1000)
      ].join(":")
    : "";
}

function candidateVisibilityTriangles(candidate = null) {
  return (Array.isArray(candidate?.options?.visibilityMaskTriangles)
    ? candidate.options.visibilityMaskTriangles
    : [])
    .map(compactVisibilityTriangle)
    .filter(Boolean);
}

function appendVisibilitySamples(targetOptions = {}, samples = []) {
  if (!Array.isArray(samples) || !samples.length) {
    return targetOptions;
  }
  const existing = Array.isArray(targetOptions.visibilityMaskSamples)
    ? targetOptions.visibilityMaskSamples
    : [];
  const merged = [];
  const seen = new Set();
  const addSample = (sample) => {
    if (merged.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
      return;
    }
    const compact = compactVisibilitySample(sample);
    const key = visibilitySampleKey(compact);
    if (!compact || !key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(compact);
  };
  existing.forEach(addSample);
  samples.forEach(addSample);
  targetOptions.visibilityMaskSamples = merged;
  if (merged.length) {
    targetOptions.visibilityMaskKey = [
      "samples",
      Math.round(styleNumber(targetOptions.visibilityMaskStampRadiusPixels, 0.5) * 100),
      merged.length
    ].join(":");
  }
  return targetOptions;
}

function visibilitySampleSlotCount(targetOptions = {}) {
  const screenProjectedSegments = Array.isArray(targetOptions.screenProjectedStrokeSegments)
    ? targetOptions.screenProjectedStrokeSegments
    : [];
  if (screenProjectedSegments.length) {
    return Math.min(TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS, screenProjectedSegments.length);
  }
  const samples = Array.isArray(targetOptions.visibilityMaskSamples)
    ? targetOptions.visibilityMaskSamples
    : [];
  return Math.min(TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS, samples.length);
}

function maxVisibilityTrianglesForOptions(targetOptions = {}) {
  const liveScreenProjected = targetOptions.liveProjectedPaint === true
    || targetOptions.screenStrokePaint === true
    || (
      Array.isArray(targetOptions.screenProjectedStrokeSegments)
      && targetOptions.screenProjectedStrokeSegments.length > 0
    );
  const neighborVisibility = targetOptions.largeLiveNeighborPaint === true
    || targetOptions.neighborPaintSeed?.enabled === true;
  const largeScreenVisibility = targetOptions.largeLiveBrushPaint === true
    || Math.max(0, Number(targetOptions.radiusPixels) || 0) >= TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MIN_RADIUS_PIXELS;
  const liveScreenCap = neighborVisibility
    ? Math.min(
        TEXTURE_AIRBRUSH_WEBGPU_NEIGHBOR_SCREEN_VISIBILITY_TRIANGLES,
        TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
      )
    : largeScreenVisibility
      ? Math.min(
          TEXTURE_AIRBRUSH_WEBGPU_LARGE_SCREEN_VISIBILITY_TRIANGLES,
          TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
        )
      : Math.min(
          TEXTURE_AIRBRUSH_WEBGPU_LIVE_SCREEN_VISIBILITY_TRIANGLES,
          TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
        );
  const configuredMax = Number.isFinite(Number(targetOptions.maxMergedVisibilityTriangles))
    ? Math.max(0, Math.floor(Number(targetOptions.maxMergedVisibilityTriangles)))
    : liveScreenProjected
      ? liveScreenCap
      : TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES;
  const cappedMax = liveScreenProjected
    ? Math.min(configuredMax, liveScreenCap)
    : configuredMax;
  const remainingSlots = Math.max(
    0,
    TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS - visibilitySampleSlotCount(targetOptions)
  );
  const slotTriangleCapacity = Math.floor(
    remainingSlots / TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_SLOT_STRIDE
  );
  return Math.max(0, Math.min(cappedMax, slotTriangleCapacity));
}

function appendVisibilityTriangles(targetOptions = {}, triangles = []) {
  if (!Array.isArray(triangles) || !triangles.length) {
    return targetOptions;
  }
  const maxMergedTriangles = maxVisibilityTrianglesForOptions(targetOptions);
  if (maxMergedTriangles <= 0) {
    return targetOptions;
  }
  const existing = Array.isArray(targetOptions.visibilityMaskTriangles)
    ? targetOptions.visibilityMaskTriangles
    : [];
  const merged = [];
  const seen = new Set();
  const addTriangle = (triangle) => {
    if (merged.length >= maxMergedTriangles) {
      return;
    }
    const compact = compactVisibilityTriangle(triangle);
    const key = visibilityTriangleKey(compact);
    if (!compact || !key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(compact);
  };
  existing.forEach(addTriangle);
  triangles.forEach(addTriangle);
  targetOptions.visibilityMaskTriangles = merged;
  return targetOptions;
}

function visibilityTrianglesWouldOverflow(targetOptions = {}, triangles = []) {
  if (!Array.isArray(triangles) || !triangles.length) {
    return false;
  }
  const maxMergedTriangles = maxVisibilityTrianglesForOptions(targetOptions);
  const seen = new Set();
  let count = 0;
  const addTriangle = (triangle) => {
    const compact = compactVisibilityTriangle(triangle);
    const key = visibilityTriangleKey(compact);
    if (!compact || !key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    count += 1;
    return count > maxMergedTriangles;
  };
  for (const triangle of Array.isArray(targetOptions.visibilityMaskTriangles) ? targetOptions.visibilityMaskTriangles : []) {
    if (addTriangle(triangle)) {
      return true;
    }
  }
  for (const triangle of triangles) {
    if (addTriangle(triangle)) {
      return true;
    }
  }
  return false;
}

function visibilityOverflowBatchesAllowed(candidate = null, batch = null) {
  return candidate?.options?.allowVisibilityOverflowBatches === true
    || batch?.options?.allowVisibilityOverflowBatches === true;
}

function compactScreenProjectedStrokeSegment(segment = null) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!start || !end) {
    return null;
  }
  const radiusPixels = Number(segment?.radiusPixels);
  const viewStart = finiteViewPoint(segment?.viewStart);
  const viewEnd = finiteViewPoint(segment?.viewEnd);
  const viewNormalStart = finiteViewPoint(segment?.viewNormalStart || segment?.normalStart);
  const viewNormalEnd = finiteViewPoint(segment?.viewNormalEnd || segment?.normalEnd);
  const viewRadiusPixels = Number(segment?.viewRadiusPixels);
  const componentStart = Math.floor(Number(segment?.componentStart));
  const componentEnd = Math.floor(Number(segment?.componentEnd));
  return {
    start,
    end,
    ...(viewStart && viewEnd ? { viewStart, viewEnd } : {}),
    ...(viewNormalStart ? { viewNormalStart } : {}),
    ...(viewNormalEnd ? { viewNormalEnd } : {}),
    ...(Number.isInteger(componentStart) && componentStart >= 0 ? { componentStart } : {}),
    ...(Number.isInteger(componentEnd) && componentEnd >= 0 ? { componentEnd } : {}),
    ...(Number.isFinite(viewRadiusPixels) && viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
    ...(Number.isFinite(radiusPixels) && radiusPixels > 0 ? { radiusPixels } : {})
  };
}

function screenProjectedStrokeSegmentKey(segment = null) {
  const compact = compactScreenProjectedStrokeSegment(segment);
  return compact
    ? [
        Math.round(compact.start.x * 10),
        Math.round(compact.start.y * 10),
        Math.round(compact.end.x * 10),
        Math.round(compact.end.y * 10),
        Math.round(styleNumber(compact.radiusPixels, 0) * 10)
      ].join(":")
    : "";
}

function appendScreenProjectedStrokeSegments(targetOptions = {}, segments = []) {
  if (!Array.isArray(segments) || !segments.length) {
    return targetOptions;
  }
  const existing = Array.isArray(targetOptions.screenProjectedStrokeSegments)
    ? targetOptions.screenProjectedStrokeSegments
    : [];
  const merged = [];
  const seen = new Set();
  const addSegment = (segment) => {
    if (merged.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
      return;
    }
    const compact = compactScreenProjectedStrokeSegment(segment);
    const key = screenProjectedStrokeSegmentKey(compact);
    if (!compact || !key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(compact);
  };
  existing.forEach(addSegment);
  segments.forEach(addSegment);
  targetOptions.screenProjectedStrokeSegments = merged;
  return targetOptions;
}

function webGpuCandidateVisibilityStyleKey(options = {}) {
  if (options.visibilityMaskPixels && options.visibilityMaskKey) {
    return options.visibilityMaskKey;
  }
  if (Array.isArray(options.visibilityMaskSamples) && options.visibilityMaskSamples.length) {
    return [
      "samples",
      Math.round(styleNumber(options.visibilityMaskStampRadiusPixels, 0.5) * 100)
    ].join(":");
  }
  return options.visibilityMaskKey || "";
}

function webGpuCandidateVisibilityIdentityKey(candidate = null) {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }
  const sourceTriangles = candidate?.options?.visibilityMaskTriangles || null;
  const cached = webGpuCandidateVisibilityIdentityKeys.get(candidate);
  if (
    cached
    && cached.sourceTriangles === sourceTriangles
    && cached.sourceLength === (Array.isArray(sourceTriangles) ? sourceTriangles.length : 0)
  ) {
    return cached.key;
  }
  const triangles = candidateVisibilityTriangles(candidate);
  const key = triangles.length
    ? `triangles:${triangles.map(visibilityTriangleKey).sort().join("|")}`
    : "";
  webGpuCandidateVisibilityIdentityKeys.set(candidate, {
    sourceTriangles,
    sourceLength: Array.isArray(sourceTriangles) ? sourceTriangles.length : 0,
    key
  });
  return key;
}

function webGpuCandidateNeighborKey(candidate = null) {
  const options = candidate?.options || {};
  const seed = options.neighborPaintSeed || candidate?.neighborPaintSeed || null;
  if (!seed?.enabled) {
    return options.neighborPaintKey || "all";
  }
  if (options.neighborPaintKey || seed.key) {
    return options.neighborPaintKey || seed.key;
  }
  const component = seed.component instanceof Set
    ? [...seed.component].sort((left, right) => left - right)
    : [];
  return [
    textureAirbrushRecordIdentity(seed.record || candidate?.record, "neighbor-record"),
    seed.materialIndex ?? candidate?.materialIndex ?? 0,
    seed.material?.uuid || seed.material?.id || candidate?.material?.uuid || candidate?.material?.id || "material",
    seed.seedVertexIndex ?? "surface",
    component.length,
    component.slice(0, 16).join(","),
    component.at(-1) ?? ""
  ].join(":");
}

function webGpuCandidateStyleKey(candidate = null) {
  const options = candidate?.options || {};
  const color = options.color || {};
  return [
    Math.round(styleNumber(options.radiusPixels, candidate?.radiusPixels || 1) * 100),
    Math.round(styleNumber(options.opacity, 0.42) * 1000),
    Math.round(styleNumber(options.hardness, 0.35) * 1000),
    Math.round(styleNumber(options.scatter, 0.35) * 1000),
    Math.round(styleNumber(options.strength, 1) * 1000),
    Math.round(styleNumber(options.visibilityFeatherRadius, 0) * 100),
    Math.round(styleNumber(options.visibilityMaskThreshold, 0.5) * 1000),
    Math.round(styleNumber(options.visibilityBleedRadius, 0) * 100),
    clampByte(color.r),
    clampByte(color.g),
    clampByte(color.b),
    webGpuCandidateVisibilityStyleKey(options),
    webGpuCandidateVisibilityIdentityKey(candidate),
    webGpuCandidateNeighborKey(candidate)
  ].join(":");
}

function webGpuQueuedCandidateStyleKey(candidate = null) {
  const options = candidate?.options || {};
  return options.liveProjectedPaint === true && options.visibilityMaskMode === "samples"
    ? webGpuDirectLiveCandidateStyleKey(candidate)
    : webGpuCandidateStyleKey(candidate);
}

function webGpuDirectLiveCandidateVisibilityStyleKey(options = {}) {
  if (
    Array.isArray(options.visibilityMaskTriangles)
    && options.visibilityMaskTriangles.length
    && !options.visibilityMaskPixels
  ) {
    const visibilityBleedKey = options.allowVariableStrokeSegmentRadius === true
      ? "var-bleed"
      : Math.round(styleNumber(options.visibilityBleedRadius, 0) * 100);
    return [
      "triangles",
      Math.round(styleNumber(options.visibilityMaskStampRadiusPixels, 0.5) * 100),
      visibilityBleedKey
    ].join(":");
  }
  return webGpuCandidateVisibilityStyleKey(options);
}

function webGpuDirectLiveCandidateStyleKey(candidate = null) {
  const options = candidate?.options || {};
  const color = options.color || {};
  const radiusKey = options.allowVariableStrokeSegmentRadius === true
    ? "var-radius"
    : Math.round(styleNumber(options.radiusPixels, candidate?.radiusPixels || 1) * 100);
  const visibilityBleedKey = options.allowVariableStrokeSegmentRadius === true
    ? "var-bleed"
    : Math.round(styleNumber(options.visibilityBleedRadius, 0) * 100);
  return [
    radiusKey,
    Math.round(styleNumber(options.opacity, 0.42) * 1000),
    Math.round(styleNumber(options.hardness, 0.35) * 1000),
    Math.round(styleNumber(options.scatter, 0.35) * 1000),
    Math.round(styleNumber(options.strength, 1) * 1000),
    Math.round(styleNumber(options.visibilityFeatherRadius, 0) * 100),
    Math.round(styleNumber(options.visibilityMaskThreshold, 0.5) * 1000),
    visibilityBleedKey,
    clampByte(color.r),
    clampByte(color.g),
    clampByte(color.b),
    webGpuDirectLiveCandidateVisibilityStyleKey(options),
    webGpuCandidateNeighborKey(candidate)
  ].join(":");
}

function webGpuDirectLiveVisibilityMergeStyleKey(candidate = null) {
  const options = candidate?.options || {};
  const color = options.color || {};
  const radiusKey = options.allowVariableStrokeSegmentRadius === true
    ? "var-radius"
    : Math.round(styleNumber(options.radiusPixels, candidate?.radiusPixels || 1) * 100);
  const visibilityBleedKey = options.allowVariableStrokeSegmentRadius === true
    ? "var-bleed"
    : Math.round(styleNumber(options.visibilityBleedRadius, 0) * 100);
  return [
    radiusKey,
    Math.round(styleNumber(options.opacity, 0.42) * 1000),
    Math.round(styleNumber(options.hardness, 0.35) * 1000),
    Math.round(styleNumber(options.scatter, 0.35) * 1000),
    Math.round(styleNumber(options.strength, 1) * 1000),
    clampByte(color.r),
    clampByte(color.g),
    clampByte(color.b),
    visibilityBleedKey,
    webGpuCandidateNeighborKey(candidate)
  ].join(":");
}

function webGpuCandidateLocalityKey(candidate = null) {
  const center = finitePoint(candidate?.center) || finitePoint(candidate?.start);
  const canvas = candidate?.editable?.canvas || null;
  if (!center || !canvas?.width || !canvas?.height) {
    return "locality:any";
  }
  const maxSize = Math.max(1, Number(canvas.width) || 1, Number(canvas.height) || 1);
  const radius = Math.max(1, styleNumber(candidate?.radiusPixels, 1));
  const tileSize = Math.max(128, Math.min(1024, radius * 12, maxSize));
  return [
    "locality",
    Math.floor(center.x / tileSize),
    Math.floor(center.y / tileSize),
    Math.round(tileSize)
  ].join(":");
}

function candidateStrokeSegments(candidate = null) {
  return Array.isArray(candidate?.strokeSegments) ? candidate.strokeSegments : [];
}

function candidatePaintBounds(candidate = null) {
  const canvas = candidate?.editable?.canvas || null;
  const explicitBounds = normalizePaintBounds(candidate?.paintBounds, canvas);
  if (explicitBounds) {
    return explicitBounds;
  }
  const segments = candidateStrokeSegments(candidate);
  const center = finitePoint(candidate?.center) || finitePoint(candidate?.start);
  const radius = Math.max(1, styleNumber(candidate?.radiusPixels, candidate?.options?.radiusPixels || 1));
  const scatter = Math.max(0, Math.min(1, styleNumber(candidate?.options?.scatter, 0.35)));
  const hardness = Math.max(0, Math.min(1, styleNumber(candidate?.options?.hardness, 0.35)));
  const halo = Math.ceil(airbrushHaloRadius(radius, scatter, hardness) + 2);
  const points = [];
  for (const segment of segments) {
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    if (start) {
      points.push(start);
    }
    if (end) {
      points.push(end);
    }
  }
  if (!points.length && center) {
    points.push(center);
  }
  if (!points.length) {
    return null;
  }
  const width = Math.max(1, Number(canvas?.width) || 1);
  const height = Math.max(1, Number(canvas?.height) || 1);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const x = Math.max(0, Math.min(width - 1, Math.floor(minX - halo)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(minY - halo)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil(maxX + halo + 1)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil(maxY + halo + 1)));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function unionPaintBounds(left = null, right = null) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: Math.max(1, rightEdge - x),
    height: Math.max(1, bottomEdge - y)
  };
}

function paintBoundsOverlap(left = null, right = null, padding = 0) {
  if (!left || !right) {
    return false;
  }
  const grow = Math.max(0, Number(padding) || 0);
  return left.x <= right.x + right.width + grow
    && left.x + left.width + grow >= right.x
    && left.y <= right.y + right.height + grow
    && left.y + left.height + grow >= right.y;
}

function unionPaintRegionList(regions = []) {
  return (Array.isArray(regions) ? regions : [])
    .filter(Boolean)
    .reduce((bounds, region) => unionPaintBounds(bounds, region), null);
}

function normalizePaintBounds(bounds = null, canvas = null) {
  if (!bounds) {
    return null;
  }
  const canvasWidth = Math.max(1, Math.floor(Number(canvas?.width) || Number(bounds.width) || 1));
  const canvasHeight = Math.max(1, Math.floor(Number(canvas?.height) || Number(bounds.height) || 1));
  const x = Math.max(0, Math.min(canvasWidth - 1, Math.floor(Number(bounds.x) || 0)));
  const y = Math.max(0, Math.min(canvasHeight - 1, Math.floor(Number(bounds.y) || 0)));
  const right = Math.max(x + 1, Math.min(canvasWidth, Math.ceil((Number(bounds.x) || 0) + Math.max(1, Number(bounds.width) || 1))));
  const bottom = Math.max(y + 1, Math.min(canvasHeight, Math.ceil((Number(bounds.y) || 0) + Math.max(1, Number(bounds.height) || 1))));
  const normalized = {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
  if (bounds.visibilityTriangle) {
    Object.defineProperty(normalized, "visibilityTriangle", {
      value: compactVisibilityTriangle(bounds.visibilityTriangle),
      enumerable: false
    });
  }
  return normalized;
}

function paintRegionWithVisibilityTriangle(region = null, triangle = null) {
  if (!region || !triangle) {
    return region;
  }
  const next = { ...region };
  Object.defineProperty(next, "visibilityTriangle", {
    value: triangle,
    enumerable: false
  });
  return next;
}

function inflatePaintBounds(bounds = null, padding = 0, canvas = null) {
  const normalized = normalizePaintBounds(bounds, canvas);
  if (!normalized) {
    return null;
  }
  const pad = Math.max(0, Math.ceil(Number(padding) || 0));
  if (pad <= 0) {
    return normalized;
  }
  return normalizePaintBounds({
    x: normalized.x - pad,
    y: normalized.y - pad,
    width: normalized.width + pad * 2,
    height: normalized.height + pad * 2
  }, canvas);
}

function paintBoundsArea(bounds = null) {
  return Math.max(0, Number(bounds?.width) || 0) * Math.max(0, Number(bounds?.height) || 0);
}

function paintRegionListArea(regions = []) {
  return (Array.isArray(regions) ? regions : []).reduce((total, region) => (
    total + paintBoundsArea(region)
  ), 0);
}

function paintBoundsGrowthArea(existing = null, next = null) {
  const union = unionPaintBounds(existing, next);
  if (!union) {
    return 0;
  }
  return Math.max(
    0,
    paintBoundsArea(union) - Math.max(paintBoundsArea(existing), paintBoundsArea(next))
  );
}

function paintBoundsMergeAddsLittleWork(existing = null, next = null, maxGrowthRatio = 0.04) {
  const union = unionPaintBounds(existing, next);
  if (!union) {
    return false;
  }
  const largestInputArea = Math.max(1, paintBoundsArea(existing), paintBoundsArea(next));
  return paintBoundsGrowthArea(existing, next) <= largestInputArea * Math.max(0, Number(maxGrowthRatio) || 0);
}

function paintBoundsMergeSavesWork(existing = null, next = null, maxUnionToSeparateRatio = 0.85) {
  const union = unionPaintBounds(existing, next);
  if (!union) {
    return false;
  }
  const separateArea = Math.max(1, paintBoundsArea(existing) + paintBoundsArea(next));
  return paintBoundsArea(union) <= separateArea * Math.max(0, Number(maxUnionToSeparateRatio) || 0);
}

function paintRegionsShouldCoalesce(left = null, right = null) {
  if (!left || !right) {
    return false;
  }
  const union = unionPaintBounds(left, right);
  const separateArea = Math.max(1, paintBoundsArea(left) + paintBoundsArea(right));
  const unionArea = paintBoundsArea(union);
  return unionArea <= separateArea * 1.12;
}

function coalescePaintRegions(regions = []) {
  const merged = (Array.isArray(regions) ? regions : []).filter(Boolean);
  for (let changed = true; changed;) {
    changed = false;
    outer:
    for (let leftIndex = 0; leftIndex < merged.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
        if (!paintRegionsShouldCoalesce(merged[leftIndex], merged[rightIndex])) {
          continue;
        }
        const union = unionPaintBounds(merged[leftIndex], merged[rightIndex]);
        merged.splice(rightIndex, 1);
        merged.splice(leftIndex, 1, union);
        changed = true;
        break outer;
      }
    }
  }
  return merged;
}

function limitPaintRegions(regions = [], maxRegions = TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS) {
  const merged = (Array.isArray(regions) ? regions : []).filter(Boolean);
  const limit = Math.max(1, Math.floor(Number(maxRegions) || TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS));
  while (merged.length > limit) {
    let bestLeftIndex = 0;
    let bestRightIndex = 1;
    let bestCost = Infinity;
    for (let leftIndex = 0; leftIndex < merged.length - 1; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
        const union = unionPaintBounds(merged[leftIndex], merged[rightIndex]);
        const cost = paintBoundsArea(union) - paintBoundsArea(merged[leftIndex]) - paintBoundsArea(merged[rightIndex]);
        if (cost < bestCost) {
          bestCost = cost;
          bestLeftIndex = leftIndex;
          bestRightIndex = rightIndex;
        }
      }
    }
    const union = unionPaintBounds(merged[bestLeftIndex], merged[bestRightIndex]);
    merged.splice(bestRightIndex, 1);
    merged.splice(bestLeftIndex, 1, union);
  }
  return merged;
}

function displayPaintRegionsShouldCoalesce(left = null, right = null, options = {}) {
  if (!left || !right) {
    return false;
  }
  const union = unionPaintBounds(left, right);
  const separateArea = Math.max(1, paintBoundsArea(left) + paintBoundsArea(right));
  const unionArea = paintBoundsArea(union);
  const wastePixels = Math.max(0, unionArea - separateArea);
  const areaRatio = Math.max(
    1,
    Number(options.areaRatio) || TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_COALESCE_AREA_RATIO
  );
  const maxWastePixels = Math.max(
    0,
    Number(options.maxWastePixels) || TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_COALESCE_MAX_WASTE_PIXELS
  );
  return unionArea <= separateArea * areaRatio && wastePixels <= maxWastePixels;
}

function coalesceDisplayPaintRegions(regions = [], canvas = null, options = {}) {
  const padding = Math.max(0, Math.ceil(Number(options.padding) || 0));
  const preserveDisjoint = options.preserveDisjoint === true;
  const maxRegions = Math.max(
    1,
    Math.floor(Number(options.maxRegions) || (
      preserveDisjoint
        ? TEXTURE_AIRBRUSH_WEBGPU_PROJECTED_LIVE_DISPLAY_MAX_DIRTY_REGIONS
        : TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_MAX_DIRTY_REGIONS
    ))
  );
  const coalesceOptions = preserveDisjoint
    ? { areaRatio: 1.04, maxWastePixels: 8 * 1024 }
    : {};
  const merged = (Array.isArray(regions) ? regions : [])
    .map((region) => inflatePaintBounds(region, padding, canvas))
    .filter(Boolean);
  for (let changed = true; changed;) {
    changed = false;
    outer:
    for (let leftIndex = 0; leftIndex < merged.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
        if (!displayPaintRegionsShouldCoalesce(merged[leftIndex], merged[rightIndex], coalesceOptions)) {
          continue;
        }
        const union = unionPaintBounds(merged[leftIndex], merged[rightIndex]);
        merged.splice(rightIndex, 1);
        merged.splice(leftIndex, 1, union);
        changed = true;
        break outer;
      }
    }
  }
  if (preserveDisjoint) {
    return limitPaintRegions(merged, maxRegions);
  }
  if (!preserveDisjoint && merged.length > 1) {
    const union = unionPaintRegionList(merged);
    const unionArea = paintBoundsArea(union);
    const regionArea = paintRegionListArea(merged);
    const canvasWidth = Math.max(1, Math.floor(Number(canvas?.width) || Number(union?.width) || 1));
    const canvasHeight = Math.max(1, Math.floor(Number(canvas?.height) || Number(union?.height) || 1));
    const canvasArea = canvasWidth * canvasHeight;
    if (
      union
      && regionArea > 0
      && (
        regionArea >= canvasArea
        || regionArea > unionArea * 1.18
        || unionArea >= canvasArea * 0.92
      )
    ) {
      return [normalizePaintBounds(
        unionArea >= canvasArea * 0.92
          ? { x: 0, y: 0, width: canvasWidth, height: canvasHeight }
          : union,
        canvas
      )].filter(Boolean);
    }
  }
  return merged;
}

function projectedLiveDisplayRegionPadding(candidate = null, options = {}) {
  const projectedLivePaint = candidate?.options?.liveProjectedPaint === true
    || options.liveProjectedPaint === true
    || options.screenStrokePaint === true;
  if (!projectedLivePaint) {
    return 0;
  }
  const radius = Math.max(
    0.75,
    Number(candidate?.radiusPixels)
      || Number(candidate?.options?.radiusPixels)
      || Number(options.radiusPixels)
      || 0.75
  );
  const scatter = Math.max(0, Math.min(1, styleNumber(candidate?.options?.scatter ?? options.scatter, 0.35)));
  const hardness = Math.max(0, Math.min(1, styleNumber(candidate?.options?.hardness ?? options.hardness, 0.35)));
  return Math.ceil(Math.min(192, Math.max(12, airbrushHaloRadius(radius, scatter, hardness) * 0.75 + 8)));
}

function splitLargeProjectedPaintRegions(regions = [], canvas = null, options = {}) {
  const normalized = (Array.isArray(regions) ? regions : [])
    .map((region) => normalizePaintBounds(region, canvas))
    .filter(Boolean);
  if (!normalized.length) {
    return normalized;
  }
  const maxRegionArea = Math.max(
    64 * 1024,
    Math.floor(Number(options.maxProjectedPaintRegionAreaPixels) || 512 * 512)
  );
  const maxTiles = Math.max(
    1,
    Math.min(96, Math.floor(Number(options.maxProjectedPaintRegionTiles) || 48))
  );
  const preferredTileSize = Math.max(
    128,
    Math.floor(Number(options.projectedPaintRegionTilePixels) || 512)
  );
  const output = [];
  for (const region of normalized) {
    const visibilityTriangle = region.visibilityTriangle || null;
    const area = paintBoundsArea(region);
    if (area <= maxRegionArea) {
      output.push(region);
      continue;
    }
    const tileSize = Math.max(
      128,
      Math.ceil(Math.max(preferredTileSize, Math.sqrt(area / maxTiles)))
    );
    for (let y = region.y; y < region.y + region.height; y += tileSize) {
      for (let x = region.x; x < region.x + region.width; x += tileSize) {
        const tile = normalizePaintBounds({
          x,
          y,
          width: Math.min(tileSize, region.x + region.width - x),
          height: Math.min(tileSize, region.y + region.height - y)
        }, canvas);
        output.push(paintRegionWithVisibilityTriangle(tile, visibilityTriangle));
      }
    }
  }
  return output.filter(Boolean);
}

function mergePaintRegions(regions = [], bounds = null, canvas = null) {
  const next = normalizePaintBounds(bounds, canvas);
  let merged = (Array.isArray(regions) ? regions : [])
    .map((region) => normalizePaintBounds(region, canvas))
    .filter(Boolean);
  if (next) {
    merged.push(next);
  }
  merged = coalescePaintRegions(merged);
  return limitPaintRegions(merged);
}

function mergePaintRegionLists(left = [], right = [], canvas = null) {
  let merged = (Array.isArray(left) ? left : [])
    .map((region) => normalizePaintBounds(region, canvas))
    .filter(Boolean);
  for (const region of Array.isArray(right) ? right : []) {
    merged = mergePaintRegions(merged, region, canvas);
  }
  return merged;
}

function paintRegionKey(region = null) {
  return region
    ? [
        Math.round(Number(region.x) || 0),
        Math.round(Number(region.y) || 0),
        Math.round(Number(region.width) || 0),
        Math.round(Number(region.height) || 0),
        visibilityTriangleKey(region.visibilityTriangle)
      ].join(":")
    : "";
}

function mergeProjectedPaintRegionLists(left = [], right = [], canvas = null) {
  const merged = [];
  const seen = new Set();
  const addRegion = (region = null) => {
    const normalized = normalizePaintBounds(region, canvas);
    const key = paintRegionKey(normalized);
    if (!normalized || !key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(normalized);
  };
  (Array.isArray(left) ? left : []).forEach(addRegion);
  (Array.isArray(right) ? right : []).forEach(addRegion);
  return limitPaintRegions(merged);
}

function segmentPaintBounds(candidate = null, segment = null) {
  const canvas = candidate?.editable?.canvas || null;
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!start || !end) {
    return null;
  }
  const radius = Math.max(
    0.75,
    Number(segment?.radiusPixels) || Number(candidate?.radiusPixels) || Number(candidate?.options?.radiusPixels) || 0.75
  );
  const scatter = Math.max(0, Math.min(1, styleNumber(candidate?.options?.scatter, 0.35)));
  const hardness = Math.max(0, Math.min(1, styleNumber(candidate?.options?.hardness, 0.35)));
  const halo = Math.ceil(airbrushHaloRadius(radius, scatter, hardness) + 2);
  const x = Math.floor(Math.min(start.x, end.x) - halo);
  const y = Math.floor(Math.min(start.y, end.y) - halo);
  const right = Math.ceil(Math.max(start.x, end.x) + halo + 1);
  const bottom = Math.ceil(Math.max(start.y, end.y) + halo + 1);
  return normalizePaintBounds({
    x,
    y,
    width: right - x,
    height: bottom - y
  }, canvas);
}

function strokeSegmentsForPaintBounds(candidate = null, segments = [], paintBounds = null) {
  const canvas = candidate?.editable?.canvas || null;
  const bounds = normalizePaintBounds(paintBounds, canvas);
  const sourceSegments = Array.isArray(segments) ? segments : [];
  if (!bounds || !sourceSegments.length) {
    return sourceSegments;
  }
  const radius = Math.max(1, Number(candidate?.radiusPixels) || Number(candidate?.options?.radiusPixels) || 1);
  const overlapPadding = Math.max(2, Math.min(16, Math.ceil(radius * 0.25)));
  const scoped = sourceSegments.filter((segment) => (
    paintBoundsOverlap(bounds, segmentPaintBounds(candidate, segment), overlapPadding)
  ));
  return scoped.length ? scoped : sourceSegments;
}

function strokeSegmentPriorityPoints(segments = []) {
  const points = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    if (start) {
      points.push(start);
    }
    if (end) {
      points.push(end);
    }
  }
  return points;
}

function candidatePaintRegions(candidate = null) {
  const canvas = candidate?.editable?.canvas || null;
  if (Array.isArray(candidate?.paintRegions) && candidate.paintRegions.length) {
    const explicitRegions = candidate.paintRegions
      .map((region) => normalizePaintBounds(region, canvas))
      .filter(Boolean);
    if (candidateUsesProjectedPaintRegions(candidate)) {
      return limitPaintRegions(explicitRegions);
    }
    return limitPaintRegions(coalescePaintRegions(explicitRegions));
  }
  let regions = [];
  for (const segment of candidateStrokeSegments(candidate)) {
    regions = mergePaintRegions(regions, segmentPaintBounds(candidate, segment), canvas);
  }
  if (!regions.length) {
    const bounds = candidatePaintBounds(candidate);
    regions = mergePaintRegions(regions, bounds, canvas);
  }
  return regions;
}

function candidateDisplayPaintRegions(candidate = null) {
  const canvas = candidate?.editable?.canvas || null;
  if (Array.isArray(candidate?.displayPaintRegions) && candidate.displayPaintRegions.length) {
    return limitPaintRegions(coalescePaintRegions(
      candidate.displayPaintRegions
        .map((region) => normalizePaintBounds(region, canvas))
        .filter(Boolean)
    ));
  }
  return candidatePaintRegions(candidate);
}

function visibilityTrianglePaintBounds(triangle = null, canvas = null, padding = 0) {
  const points = [
    finitePoint(triangle?.a || triangle?.[0]),
    finitePoint(triangle?.b || triangle?.[1]),
    finitePoint(triangle?.c || triangle?.[2])
  ].filter(Boolean);
  if (points.length !== 3) {
    return null;
  }
  const pad = Math.max(0, Number(padding) || 0);
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return normalizePaintBounds({
    x: Math.floor(minX - pad),
    y: Math.floor(minY - pad),
    width: Math.max(1, Math.ceil(maxX + pad + 1) - Math.floor(minX - pad)),
    height: Math.max(1, Math.ceil(maxY + pad + 1) - Math.floor(minY - pad))
  }, canvas);
}

function visibilityTrianglesForPaintBounds(triangles = [], paintBounds = null, canvas = null, padding = 2) {
  const bounds = normalizePaintBounds(paintBounds, canvas);
  if (!bounds || !Array.isArray(triangles) || !triangles.length) {
    return [];
  }
  return triangles.filter((triangle) => {
    const triangleBounds = visibilityTrianglePaintBounds(triangle, canvas, padding);
    return paintBoundsOverlap(bounds, triangleBounds, padding);
  });
}

function projectedPaintRegionsForVisibilityTriangles(triangles = [], canvas = null, padding = 2) {
  return (Array.isArray(triangles) ? triangles : [])
    .map((triangle) => {
      const compact = compactVisibilityTriangle(triangle);
      const bounds = visibilityTrianglePaintBounds(compact, canvas, padding);
      return bounds && compact ? paintRegionWithVisibilityTriangle(bounds, compact) : null;
    })
    .filter(Boolean);
}

function completeProjectedPaintRegionsForTriangles(regions = [], triangles = [], canvas = null, padding = 2) {
  const merged = [];
  const seen = new Set();
  const addRegion = (region = null) => {
    const normalized = normalizePaintBounds(region, canvas);
    const key = paintRegionKey(normalized);
    if (!normalized || !key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(normalized);
  };
  (Array.isArray(regions) ? regions : []).forEach(addRegion);
  projectedPaintRegionsForVisibilityTriangles(triangles, canvas, padding).forEach(addRegion);
  return limitPaintRegions(merged);
}

function candidateWithoutExplicitPaintScope(candidate = null) {
  if (!candidate) {
    return candidate;
  }
  const {
    paintBounds: _paintBounds,
    paintRegions: _paintRegions,
    ...scopedCandidate
  } = candidate;
  return scopedCandidate;
}

function candidateUsesProjectedPaintRegions(candidate = null) {
  return Array.isArray(candidate?.paintRegions)
    && candidate.paintRegions.length
    && Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
    && candidate.options.screenProjectedStrokeSegments.length;
}

function candidateUsesProjectedSurfaceField(candidate = null) {
  return Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
    && candidate.options.screenProjectedStrokeSegments.length
    && (
      candidate?.options?.liveProjectedPaint === true
      || candidate?.options?.screenStrokePaint === true
    );
}

function candidateUsesTslSurfaceDescriptor(candidate = null) {
  const options = candidate?.options || {};
  return candidateUsesProjectedSurfaceField(candidate)
    && options.useTslSurfaceAirbrush !== false
    && (
      options.fullProjectedSurfaceRenderTriangles === true
      || (
        Array.isArray(options.visibilityMaskTriangles)
        && options.visibilityMaskTriangles.length > 0
      )
    );
}

function screenPathPointClose(left = null, right = null, tolerance = 1.25) {
  const a = finitePoint(left);
  const b = finitePoint(right);
  if (!a || !b) {
    return false;
  }
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= tolerance * tolerance;
}

function screenProjectedPathContainsQueuedPath(nextSegments = [], queuedSegments = []) {
  const next = Array.isArray(nextSegments) ? nextSegments : [];
  const queued = Array.isArray(queuedSegments) ? queuedSegments : [];
  if (!next.length || !queued.length || next.length < queued.length) {
    return false;
  }
  const queuedFirst = queued[0] || null;
  const queuedLast = queued.at(-1) || null;
  const nextFirst = next[0] || null;
  if (!screenPathPointClose(nextFirst?.start, queuedFirst?.start)) {
    return false;
  }
  const queuedLastEnd = queuedLast?.end || queuedLast?.start;
  return next.some((segment) => screenPathPointClose(segment?.end || segment?.start, queuedLastEnd));
}

function sameLiveSurfaceQueueTarget(batch = null, candidate = null, context = {}) {
  if (!batch || !candidate) {
    return false;
  }
  const candidateLayerMode = candidate.layerMode === true || candidate.options?.layerMode === true;
  const candidateErase = candidate.erase === true || candidate.options?.erase === true;
  const batchLayerMode = batch.layerMode === true || batch.options?.layerMode === true;
  const batchErase = batch.erase === true || batch.options?.erase === true;
  return Boolean(
    batch.record === candidate.record
    && batch.material === candidate.material
    && batch.editable === candidate.editable
    && batch.materialIndex === candidate.materialIndex
    && batch.styleKey === context.styleKey
    && (batch.strokeUndo || null) === (context.strokeUndo || null)
    && (batch.webGpuStrokeSourceOwner || null) === (context.strokeSourceOwner || null)
    && batchLayerMode === candidateLayerMode
    && batchErase === candidateErase
  );
}

function staleQueuedTslSurfaceBatch(batch = null, candidate = null, context = {}) {
  if (!candidateUsesTslSurfaceDescriptor(candidate) || !candidateUsesTslSurfaceDescriptor(batch)) {
    return false;
  }
  if (!sameLiveSurfaceQueueTarget(batch, candidate, context)) {
    return false;
  }
  const nextScreenSegments = Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
    ? candidate.options.screenProjectedStrokeSegments
    : [];
  const queuedScreenSegments = Array.isArray(batch?.options?.screenProjectedStrokeSegments)
    ? batch.options.screenProjectedStrokeSegments
    : [];
  return screenProjectedPathContainsQueuedPath(nextScreenSegments, queuedScreenSegments);
}

function pruneStaleQueuedTslSurfaceBatches(editor = null, candidate = null, context = {}) {
  const queue = editor?.textureAirbrushQueuedWebGpuStrokes || [];
  if (!queue.length || !candidateUsesTslSurfaceDescriptor(candidate)) {
    return 0;
  }
  const kept = [];
  let removed = 0;
  for (const batch of queue) {
    if (staleQueuedTslSurfaceBatch(batch, candidate, context)) {
      removed += 1;
    } else {
      kept.push(batch);
    }
  }
  if (removed > 0) {
    editor.textureAirbrushQueuedWebGpuStrokes = kept;
    debugLiveWebGpuAirbrush("queue-pruned-stale-tsl-surface", {
      removed,
      remaining: kept.length,
      screenProjectedStrokeSegments: candidate.options?.screenProjectedStrokeSegments?.length || 0
    });
  }
  return removed;
}

function scopedProjectedPaintRegionsForSegment(candidate = null, segment = null) {
  if (!candidateUsesProjectedPaintRegions(candidate)) {
    return null;
  }
  const canvas = candidate?.editable?.canvas || null;
  const sourceRegions = candidate.paintRegions
    .map((region) => normalizePaintBounds(region, canvas))
    .filter(Boolean);
  if (!sourceRegions.length) {
    return null;
  }
  if (candidateUsesProjectedSurfaceField(candidate)) {
    if (candidate.__textureAirbrushProjectedSurfaceRegionScope) {
      return candidate.__textureAirbrushProjectedSurfaceRegionScope;
    }
    const regions = limitPaintRegions(sourceRegions);
    const bounds = unionPaintRegionList(regions);
    const scope = bounds ? { bounds, regions } : null;
    candidate.__textureAirbrushProjectedSurfaceRegionScope = scope;
    return scope;
  }
  const screenProjectedSegments = Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
    ? candidate.options.screenProjectedStrokeSegments
    : [];
  const segmentStart = finitePoint(segment?.start);
  const segmentEnd = finitePoint(segment?.end);
  const segmentHasScreenPath = finitePoint(segment?.screenStart) && finitePoint(segment?.screenEnd);
  const segmentIsProjectedAnchor = screenProjectedSegments.length
    && !segmentHasScreenPath
    && segmentStart
    && segmentEnd
    && Math.hypot(segmentEnd.x - segmentStart.x, segmentEnd.y - segmentStart.y) <= 0.001;
  if (segmentIsProjectedAnchor) {
    const bounds = unionPaintRegionList(sourceRegions);
    return bounds ? { bounds, regions: sourceRegions } : null;
  }
  const segmentBounds = segmentPaintBounds(candidate, segment);
  if (!segmentBounds || sourceRegions.length === 1) {
    const bounds = unionPaintRegionList(sourceRegions);
    return bounds ? { bounds, regions: sourceRegions } : null;
  }
  const overlapPadding = Math.max(
    1,
    Math.min(8, Math.ceil((Number(segment?.radiusPixels) || Number(candidate?.radiusPixels) || 1) * 0.1))
  );
  const localRegions = sourceRegions.filter((region) => (
    paintBoundsOverlap(region, segmentBounds, overlapPadding)
  ));
  if (!localRegions.length) {
    return {
      bounds: segmentBounds,
      regions: [segmentBounds]
    };
  }
  return {
    bounds: unionPaintRegionList(localRegions),
    regions: localRegions
  };
}

function maxLiveBatchAreaPixels(candidate = null, batch = null) {
  const explicit = Number(candidate?.options?.maxLiveBatchAreaPixels ?? batch?.options?.maxLiveBatchAreaPixels);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const canvas = candidate?.editable?.canvas || batch?.editable?.canvas || null;
  const canvasArea = Math.max(1, Number(canvas?.width) || 1) * Math.max(1, Number(canvas?.height) || 1);
  if (
    candidate?.options?.allowDisjointLiveBatchBounds === true
    || batch?.options?.allowDisjointLiveBatchBounds === true
  ) {
    const disjointLimit = largeLiveWebGpuBatch(candidate) || largeLiveWebGpuBatch(batch)
      ? TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_BATCH_AREA_PIXELS
      : TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISJOINT_BATCH_AREA_PIXELS;
    return Math.max(128 * 128, Math.min(canvasArea, disjointLimit));
  }
  return Math.max(128 * 128, Math.min(canvasArea * 0.04, 700_000));
}

function maxLiveBatchRegionAreaPixels(candidate = null, batch = null) {
  const explicit = Number(candidate?.options?.maxLiveBatchRegionAreaPixels ?? batch?.options?.maxLiveBatchRegionAreaPixels);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const areaExplicit = Number(candidate?.options?.maxLiveBatchAreaPixels ?? batch?.options?.maxLiveBatchAreaPixels);
  if (Number.isFinite(areaExplicit) && areaExplicit > 0) {
    return areaExplicit;
  }
  const canvas = candidate?.editable?.canvas || batch?.editable?.canvas || null;
  const canvasArea = Math.max(1, Number(canvas?.width) || 1) * Math.max(1, Number(canvas?.height) || 1);
  if (
    candidate?.options?.allowDisjointLiveBatchBounds === true
    || batch?.options?.allowDisjointLiveBatchBounds === true
  ) {
    const disjointLimit = largeLiveWebGpuBatch(candidate) || largeLiveWebGpuBatch(batch)
      ? TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_BATCH_AREA_PIXELS
      : TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISJOINT_BATCH_AREA_PIXELS;
    return Math.max(128 * 128, Math.min(canvasArea, disjointLimit));
  }
  return maxLiveBatchAreaPixels(candidate, batch);
}

function webGpuCandidateBatchCanAccept(batch = null, candidate = null, segmentCount = 1) {
  if (!batch || !candidate) {
    return false;
  }
  if (batch.strokeSegments.length + segmentCount > TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
    return false;
  }
  if (
    visibilityOverflowBatchesAllowed(candidate, batch)
    && visibilityTrianglesWouldOverflow(batch.options, candidateVisibilityTriangles(candidate))
  ) {
    return false;
  }
  if (candidateUsesTslSurfaceDescriptor(candidate) || candidateUsesTslSurfaceDescriptor(batch)) {
    return true;
  }
  const existingBounds = batch.paintBounds || candidatePaintBounds(batch);
  const nextBounds = candidatePaintBounds(candidate);
  const mergedBounds = unionPaintBounds(existingBounds, nextBounds);
  const allowDisjointLiveBounds = candidate?.options?.allowDisjointLiveBatchBounds === true
    || batch?.options?.allowDisjointLiveBatchBounds === true;
  const canvas = candidate?.editable?.canvas || batch?.editable?.canvas || null;
  const existingRegions = candidatePaintRegions(batch);
  const nextRegions = candidatePaintRegions(candidate);
  const mergedRegions = mergePaintRegionLists(
    existingRegions,
    nextRegions,
    canvas
  );
  if (allowDisjointLiveBounds) {
    return paintRegionListArea(mergedRegions) <= maxLiveBatchRegionAreaPixels(candidate, batch);
  }
  if (!allowDisjointLiveBounds) {
    if (mergedRegions.length > Math.max(existingRegions.length, nextRegions.length, 1)) {
      return false;
    }
  }
  return paintBoundsArea(mergedBounds) <= maxLiveBatchAreaPixels(candidate, batch);
}

function webGpuCandidateBatchRejectReason(batch = null, candidate = null, segmentCount = 1) {
  if (!batch || !candidate) {
    return "missing";
  }
  if (batch.strokeSegments.length + segmentCount > TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
    return "segment-capacity";
  }
  if (
    visibilityOverflowBatchesAllowed(candidate, batch)
    && visibilityTrianglesWouldOverflow(batch.options, candidateVisibilityTriangles(candidate))
  ) {
    return "visibility-overflow";
  }
  if (candidateUsesTslSurfaceDescriptor(candidate) || candidateUsesTslSurfaceDescriptor(batch)) {
    return "accepted";
  }
  const existingBounds = batch.paintBounds || candidatePaintBounds(batch);
  const nextBounds = candidatePaintBounds(candidate);
  const mergedBounds = unionPaintBounds(existingBounds, nextBounds);
  const allowDisjointLiveBounds = candidate?.options?.allowDisjointLiveBatchBounds === true
    || batch?.options?.allowDisjointLiveBatchBounds === true;
  const canvas = candidate?.editable?.canvas || batch?.editable?.canvas || null;
  const existingRegions = candidatePaintRegions(batch);
  const nextRegions = candidatePaintRegions(candidate);
  const mergedRegions = mergePaintRegionLists(existingRegions, nextRegions, canvas);
  if (allowDisjointLiveBounds) {
    const regionArea = paintRegionListArea(mergedRegions);
    const maxRegionArea = maxLiveBatchRegionAreaPixels(candidate, batch);
    return regionArea <= maxRegionArea
      ? "accepted"
      : `region-area:${Math.round(regionArea)}>${Math.round(maxRegionArea)}`;
  }
  if (mergedRegions.length > Math.max(existingRegions.length, nextRegions.length, 1)) {
    return `disjoint-regions:${mergedRegions.length}`;
  }
  const boundsArea = paintBoundsArea(mergedBounds);
  const maxBoundsArea = maxLiveBatchAreaPixels(candidate, batch);
  return boundsArea <= maxBoundsArea
    ? "accepted"
    : `bounds-area:${Math.round(boundsArea)}>${Math.round(maxBoundsArea)}`;
}

function webGpuCandidateCanCrossLocalityMerge(batch = null, candidate = null) {
  if (!batch || !candidate) {
    return false;
  }
  const allowDisjointLiveBounds = candidate?.options?.allowDisjointLiveBatchBounds === true
    || batch?.options?.allowDisjointLiveBatchBounds === true
    || candidate?.options?.largeLiveBrushPaint === true
    || batch?.options?.largeLiveBrushPaint === true
    || candidate?.options?.largeLiveNeighborPaint === true
    || batch?.options?.largeLiveNeighborPaint === true;
  if (!allowDisjointLiveBounds) {
    return false;
  }
  const largeBatch = largeLiveWebGpuBatch(batch) || largeLiveWebGpuBatch(candidate);
  const activeScreenStrokeBatch = candidate?.options?.screenStrokePaint === true
    || batch?.options?.screenStrokePaint === true;
  if (!largeBatch && !activeScreenStrokeBatch) {
    return false;
  }
  const existingBounds = batch.paintBounds || candidatePaintBounds(batch);
  const nextBounds = candidatePaintBounds(candidate);
  if (!existingBounds || !nextBounds) {
    return false;
  }
  const canvas = candidate?.editable?.canvas || batch?.editable?.canvas || null;
  const mergedRegions = mergePaintRegionLists(
    candidatePaintRegions(batch),
    candidatePaintRegions(candidate),
    canvas
  );
  if (paintRegionListArea(mergedRegions) <= maxLiveBatchRegionAreaPixels(candidate, batch)) {
    const radius = Math.max(
      1,
      Number(candidate?.radiusPixels) || 0,
      Number(candidate?.options?.radiusPixels) || 0,
      Number(batch?.radiusPixels) || 0,
      Number(batch?.options?.radiusPixels) || 0
    );
    const localityPadding = Math.max(4, Math.min(256, Math.ceil(radius)));
    return (
      paintBoundsOverlap(existingBounds, nextBounds, localityPadding)
      || paintBoundsMergeAddsLittleWork(existingBounds, nextBounds)
      || (
        paintBoundsOverlap(existingBounds, nextBounds, 0)
        && paintBoundsMergeSavesWork(existingBounds, nextBounds)
      )
    );
  }
  return (
    paintBoundsMergeAddsLittleWork(existingBounds, nextBounds)
    || (
      paintBoundsOverlap(existingBounds, nextBounds, 0)
      && paintBoundsMergeSavesWork(existingBounds, nextBounds)
    )
  );
}

function interpolateStrokePoint(start = null, end = null, t = 0) {
  const a = finitePoint(start);
  const b = finitePoint(end);
  if (!a || !b) {
    return null;
  }
  const amount = Math.max(0, Math.min(1, Number(t) || 0));
  return {
    ...start,
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount
  };
}

function splitLargeBoundsSegment(candidate = null, segment = null, maxArea = 1) {
  const scopedCandidate = candidateWithoutExplicitPaintScope(candidate);
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!start || !end) {
    return [];
  }
  const areaLimit = Math.max(1, Number(maxArea) || 1);
  const pieces = [segment];
  const canSplit = (piece = null) => {
    const pieceStart = finitePoint(piece?.start);
    const pieceEnd = finitePoint(piece?.end);
    if (!pieceStart || !pieceEnd) {
      return false;
    }
    const dx = pieceEnd.x - pieceStart.x;
    const dy = pieceEnd.y - pieceStart.y;
    return dx * dx + dy * dy > 0.000001;
  };
  for (let pass = 0; pass < TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS; pass += 1) {
    let splitIndex = -1;
    let splitArea = 0;
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      const bounds = candidatePaintBounds({ ...scopedCandidate, strokeSegments: [piece] });
      const area = paintBoundsArea(bounds);
      if (area > areaLimit && area > splitArea && canSplit(piece)) {
        splitIndex = index;
        splitArea = area;
      }
    }
    if (splitIndex < 0 || pieces.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
      break;
    }
    const piece = pieces[splitIndex];
    const midpoint = interpolateStrokePoint(piece.start, piece.end, 0.5);
    if (!midpoint) {
      break;
    }
    pieces.splice(
      splitIndex,
      1,
      { ...piece, end: midpoint },
      { ...piece, start: midpoint }
    );
  }
  return pieces.length ? pieces : [segment];
}

function webGpuCandidateSegmentChunks(candidate = null, segments = []) {
  if (!Array.isArray(segments) || !segments.length) {
    return [[]];
  }
  if (candidateUsesTslSurfaceDescriptor(candidate)) {
    const chunks = [];
    for (let index = 0; index < segments.length; index += TEXTURE_AIRBRUSH_TSL_SURFACE_MAX_STROKE_SEGMENTS) {
      chunks.push(segments.slice(index, index + TEXTURE_AIRBRUSH_TSL_SURFACE_MAX_STROKE_SEGMENTS));
    }
    return chunks.length ? chunks : [[]];
  }
  const scopedCandidate = candidateWithoutExplicitPaintScope(candidate);
  const maxArea = maxLiveBatchAreaPixels(candidate);
  const allowDisjointLiveBounds = candidate?.options?.allowDisjointLiveBatchBounds === true;
  const maxRegionArea = allowDisjointLiveBounds
    ? maxLiveBatchRegionAreaPixels(candidate)
    : maxArea;
  const splitSegments = segments.flatMap((segment) => splitLargeBoundsSegment(scopedCandidate, segment, maxArea));
  const chunks = [];
  let chunk = [];
  for (const segment of splitSegments) {
    const nextChunk = [...chunk, segment];
    const nextCandidate = { ...scopedCandidate, strokeSegments: nextChunk };
    const nextArea = allowDisjointLiveBounds
      ? paintRegionListArea(candidatePaintRegions(nextCandidate))
      : paintBoundsArea(candidatePaintBounds(nextCandidate));
    if (
      chunk.length
      && (
        chunk.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
        || nextArea > maxRegionArea
      )
    ) {
      chunks.push(chunk);
      chunk = [segment];
    } else {
      chunk = nextChunk;
    }
  }
  if (chunk.length) {
    chunks.push(chunk);
  }
  return chunks.length ? chunks : [[]];
}

function directCandidateStrokeSegments(candidate = null) {
  const segments = candidateStrokeSegments(candidate)
    .map((segment) => {
      const start = finitePoint(segment?.start);
      const end = finitePoint(segment?.end);
      const radiusPixels = Number(segment?.radiusPixels);
      const screenStart = finitePoint(segment?.screenStart);
      const screenEnd = finitePoint(segment?.screenEnd);
      const screenRadiusPixels = Number(segment?.screenRadiusPixels);
      return start && end
        ? {
            start,
            end,
            ...(screenStart && screenEnd ? { screenStart, screenEnd } : {}),
            ...(Number.isFinite(screenRadiusPixels) && screenRadiusPixels > 0 ? { screenRadiusPixels } : {}),
            ...(Number.isFinite(radiusPixels) && radiusPixels > 0 ? { radiusPixels } : {})
          }
        : null;
    })
    .filter(Boolean);
  if (segments.length) {
    return segments;
  }
  const center = finitePoint(candidate?.center) || finitePoint(candidate?.start);
  return center ? [{ start: center, end: center }] : [];
}

function directLiveSegmentRadiusPixels(candidate = null, segment = null) {
  return Math.max(
    0.75,
    styleNumber(
      segment?.radiusPixels,
      styleNumber(candidate?.radiusPixels, styleNumber(candidate?.options?.radiusPixels, 1))
    )
  );
}

function directLiveSegmentWithRadius(candidate = null, segment = null) {
  const radiusPixels = directLiveSegmentRadiusPixels(candidate, segment);
  return {
    ...segment,
    radiusPixels
  };
}

function pointToSegmentDistance(point = null, start = null, end = null) {
  const p = finitePoint(point);
  const a = finitePoint(start);
  const b = finitePoint(end);
  if (!p || !a || !b) {
    return Infinity;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.0001) {
    return Math.sqrt((p.x - b.x) * (p.x - b.x) + (p.y - b.y) * (p.y - b.y));
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  const closest = {
    x: a.x + dx * t,
    y: a.y + dy * t
  };
  return Math.sqrt((p.x - closest.x) * (p.x - closest.x) + (p.y - closest.y) * (p.y - closest.y));
}

function cross2d(a = null, b = null, c = null) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInVisibilityTriangle(point = null, triangle = null) {
  const p = finitePoint(point);
  const compact = compactVisibilityTriangle(triangle);
  if (!p || !compact) {
    return false;
  }
  const ab = cross2d(compact.a, compact.b, p);
  const bc = cross2d(compact.b, compact.c, p);
  const ca = cross2d(compact.c, compact.a, p);
  const hasNegative = ab < -0.0001 || bc < -0.0001 || ca < -0.0001;
  const hasPositive = ab > 0.0001 || bc > 0.0001 || ca > 0.0001;
  return !(hasNegative && hasPositive);
}

function rangesOverlap(aMin = 0, aMax = 0, bMin = 0, bMax = 0) {
  return Math.max(Math.min(aMin, aMax), Math.min(bMin, bMax))
    <= Math.min(Math.max(aMin, aMax), Math.max(bMin, bMax)) + 0.0001;
}

function segmentsIntersect(leftStart = null, leftEnd = null, rightStart = null, rightEnd = null) {
  const a = finitePoint(leftStart);
  const b = finitePoint(leftEnd);
  const c = finitePoint(rightStart);
  const d = finitePoint(rightEnd);
  if (!a || !b || !c || !d) {
    return false;
  }
  if (!rangesOverlap(a.x, b.x, c.x, d.x) || !rangesOverlap(a.y, b.y, c.y, d.y)) {
    return false;
  }
  const abC = cross2d(a, b, c);
  const abD = cross2d(a, b, d);
  const cdA = cross2d(c, d, a);
  const cdB = cross2d(c, d, b);
  return (
    Math.min(abC, abD) <= 0.0001
    && Math.max(abC, abD) >= -0.0001
    && Math.min(cdA, cdB) <= 0.0001
    && Math.max(cdA, cdB) >= -0.0001
  );
}

function segmentToVisibilityTriangleDistance(segment = null, triangle = null) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  const compact = compactVisibilityTriangle(triangle);
  if (!start || !end || !compact) {
    return Infinity;
  }
  if (pointInVisibilityTriangle(start, compact) || pointInVisibilityTriangle(end, compact)) {
    return 0;
  }
  const edges = [
    [compact.a, compact.b],
    [compact.b, compact.c],
    [compact.c, compact.a]
  ];
  let distance = Infinity;
  for (const [edgeStart, edgeEnd] of edges) {
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) {
      return 0;
    }
    distance = Math.min(
      distance,
      pointToSegmentDistance(start, edgeStart, edgeEnd),
      pointToSegmentDistance(end, edgeStart, edgeEnd),
      pointToSegmentDistance(edgeStart, start, end),
      pointToSegmentDistance(edgeEnd, start, end)
    );
  }
  return distance;
}

function visibilityTriangleScreenProjection(triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  const a = finitePoint(compact?.screenA);
  const b = finitePoint(compact?.screenB);
  const c = finitePoint(compact?.screenC);
  return a && b && c ? { a, b, c } : null;
}

function directLiveSegmentVisibilityTriangles(candidate = null, segment = null) {
  const triangles = candidateVisibilityTriangles(candidate);
  if (!triangles.length) {
    return [];
  }
  const projectedStrokeSegments = Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
    ? candidate.options.screenProjectedStrokeSegments
    : [];
	  if (projectedStrokeSegments.length) {
	    const projectedFiltered = visibilityTrianglesForScreenStrokeSegments(
	      triangles,
      projectedStrokeSegments,
      candidate?.options || {}
    );
    if (projectedFiltered.length) {
      return projectedFiltered;
    }
  }
  const screenStart = finitePoint(segment?.screenStart);
  const screenEnd = finitePoint(segment?.screenEnd);
	  if (screenStart && screenEnd) {
	    const screenRadius = Math.max(
      0.75,
      Number(segment?.screenRadiusPixels)
        || Number(candidate?.screenRadiusPixels)
        || Number(candidate?.options?.screenRadiusPixels)
        || Number(candidate?.options?.screenBrushRadiusPixels)
        || Number(candidate?.options?.radiusPixels)
        || 0.75
    );
	    const screenThreshold = projectedSurfaceBrushDomainRadius(
        screenRadius,
        candidate?.options?.scatter,
        candidate?.options?.hardness
      );
    const screenSegment = { start: screenStart, end: screenEnd };
    const screenFiltered = triangles.filter((triangle) => {
      const screenTriangle = visibilityTriangleScreenProjection(triangle);
      return screenTriangle
        ? segmentToVisibilityTriangleDistance(screenSegment, screenTriangle) <= screenThreshold
        : false;
    });
    if (screenFiltered.length) {
      return screenFiltered;
    }
  }
  const radius = directLiveSegmentRadiusPixels(candidate, segment);
  const bleed = Math.max(0, styleNumber(candidate?.options?.visibilityBleedRadius, 0));
  const threshold = Math.max(1, radius * 1.4 + bleed + 2);
  return triangles.filter((triangle) => (
    segmentToVisibilityTriangleDistance(segment, triangle) <= threshold
  ));
}

function visibilityTrianglesForScreenStrokeSegments(triangles = [], screenSegments = [], options = {}) {
  const compactSegments = (Array.isArray(screenSegments) ? screenSegments : [])
    .map(compactScreenProjectedStrokeSegment)
    .filter(Boolean);
  if (!compactSegments.length || !Array.isArray(triangles) || !triangles.length) {
    return Array.isArray(triangles) ? triangles : [];
  }
  let projectedTriangleCount = 0;
  const filtered = [];
  for (const triangle of triangles) {
    const screenTriangle = visibilityTriangleScreenProjection(triangle);
    if (!screenTriangle) {
      continue;
    }
    projectedTriangleCount += 1;
	    const nearStroke = compactSegments.some((segment) => {
	      const radius = Math.max(0.75, Number(segment.radiusPixels) || 0.75);
	      const scatter = Math.max(0, Math.min(1, Number(options.scatter) || 0));
	      const threshold = projectedSurfaceBrushDomainRadius(radius, scatter, options.hardness);
	      return segmentToVisibilityTriangleDistance(segment, screenTriangle) <= threshold;
	    });
    if (nearStroke) {
      filtered.push(triangle);
    }
  }
  return projectedTriangleCount ? filtered : triangles;
}

function visibilityOnlyScreenStrokeSegments(candidate = null, batch = null) {
  const candidateSegments = screenProjectedSegmentsForTextureSegments(
    candidate,
    directCandidateStrokeSegments(candidate)
  );
  if (candidateSegments.length) {
    return candidateSegments;
  }
  return Array.isArray(batch?.options?.screenProjectedStrokeSegments)
    ? batch.options.screenProjectedStrokeSegments
    : [];
}

function webGpuCandidateUndoKey(candidate = null) {
  return candidate?.editable?.texture
    || candidate?.editable?.canvas
    || candidate?.editable
    || [
      textureAirbrushRecordIdentity(candidate?.record),
      candidate?.materialIndex ?? 0,
      candidate?.material?.uuid || candidate?.material?.id || "material"
    ].join(":");
}

function webGpuActiveStrokeUndo(editor = null) {
  return editor?.texturePaintActiveStrokeUndo?.()
    || editor?.texturePaintStrokeUndoContext
    || editor?.texturePaintStrokeUndo
    || null;
}

function webGpuStrokeUndoKeys(stroke = null) {
  if (!stroke) {
    return null;
  }
  stroke.textureAirbrushWebGpuUndoKeys ||= new Set();
  return stroke.textureAirbrushWebGpuUndoKeys;
}

function activeStrokeWebGpuUndoKeys(editor = null) {
  return webGpuStrokeUndoKeys(webGpuActiveStrokeUndo(editor));
}

function webGpuStrokeSourceOwner(stroke = null, undoKey = "") {
  if (!stroke || !undoKey) {
    return null;
  }
  stroke.textureAirbrushWebGpuStrokeSourceOwners ||= new Map();
  if (!stroke.textureAirbrushWebGpuStrokeSourceOwners.has(undoKey)) {
    stroke.textureAirbrushWebGpuStrokeSourceOwners.set(undoKey, {});
  }
  return stroke.textureAirbrushWebGpuStrokeSourceOwners.get(undoKey);
}

function webGpuFallbackStrokeSourceRoot(editor = null, candidate = null) {
  if (!editor) {
    return null;
  }
  const explicitRoot = candidate?.webGpuStrokeSourceRoot || candidate?.options?.webGpuStrokeSourceRoot || null;
  if (explicitRoot) {
    return explicitRoot;
  }
  if (
    candidate?.strokeReset === true
    || candidate?.options?.strokeReset === true
    || !editor.textureAirbrushWebGpuFallbackStrokeSourceRoot
  ) {
    editor.textureAirbrushWebGpuFallbackStrokeSourceRoot = {};
  }
  return editor.textureAirbrushWebGpuFallbackStrokeSourceRoot;
}

function webGpuCandidateStrokeSourceOwner(editor = null, candidate = null, strokeUndo = null, undoKey = "") {
  return candidate?.webGpuStrokeSourceOwner
    || candidate?.options?.webGpuStrokeSourceOwner
    || webGpuStrokeSourceOwner(strokeUndo, undoKey)
    || webGpuStrokeSourceOwner(webGpuFallbackStrokeSourceRoot(editor, candidate), undoKey)
    || null;
}

function activeStrokeWebGpuSourceOwner(editor = null, undoKey = "") {
  return webGpuStrokeSourceOwner(webGpuActiveStrokeUndo(editor), undoKey);
}

function withWebGpuStrokeUndoContext(editor = null, strokeUndo = null, callback = null) {
  if (typeof callback !== "function") {
    return undefined;
  }
  if (!editor || !strokeUndo) {
    return callback();
  }
  const previousStrokeUndoContext = editor.texturePaintStrokeUndoContext;
  editor.texturePaintStrokeUndoContext = strokeUndo;
  try {
    return callback();
  } finally {
    if (previousStrokeUndoContext === undefined) {
      delete editor.texturePaintStrokeUndoContext;
    } else {
      editor.texturePaintStrokeUndoContext = previousStrokeUndoContext;
    }
  }
}

function directLiveCandidateBatchKey(candidate = null, segment = null) {
  return [
    textureAirbrushRecordIdentity(candidate?.record),
    candidate?.materialIndex ?? 0,
    candidate?.material?.uuid || candidate?.material?.id || "material",
    candidate?.editable?.texture?.uuid || candidate?.editable?.texture?.id || "",
    candidate?.editable?.canvas?.width || 0,
    candidate?.editable?.canvas?.height || 0,
    webGpuDirectLiveCandidateStyleKey(candidate)
  ].join(":");
}

function directLiveVisibilityMergeKey(candidate = null) {
  return [
    textureAirbrushRecordIdentity(candidate?.record),
    candidate?.materialIndex ?? 0,
    candidate?.material?.uuid || candidate?.material?.id || "material",
    candidate?.editable?.texture?.uuid || candidate?.editable?.texture?.id || "",
    candidate?.editable?.canvas?.width || 0,
    candidate?.editable?.canvas?.height || 0,
    webGpuDirectLiveVisibilityMergeStyleKey(candidate)
  ].join(":");
}

function webGpuLiveDisplayRefreshKey(candidate = null) {
  if (!candidate?.material || !candidate?.editable) {
    return "";
  }
  return [
    textureAirbrushRecordIdentity(candidate?.record),
    candidate?.materialIndex ?? 0,
    candidate.material.uuid || candidate.material.id || "material",
    candidate.editable.texture?.uuid || candidate.editable.texture?.id || "",
    candidate.editable.canvas?.width || 0,
    candidate.editable.canvas?.height || 0
  ].join(":");
}

function paintBoundsDistanceToPoint(bounds = null, point = null) {
  if (
    !bounds
    || !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
  ) {
    return Infinity;
  }
  const minX = Number(bounds.x) || 0;
  const minY = Number(bounds.y) || 0;
  const maxX = minX + Math.max(0, Number(bounds.width) || 0);
  const maxY = minY + Math.max(0, Number(bounds.height) || 0);
  const dx = point.x < minX ? minX - point.x : point.x > maxX ? point.x - maxX : 0;
  const dy = point.y < minY ? minY - point.y : point.y > maxY ? point.y - maxY : 0;
  return dx * dx + dy * dy;
}

function directLiveSegmentVisibilitySamples(candidate = null, segment = null, segmentCount = 1) {
  const segmentSample = segment ? [{ segment }] : [];
  if (
    candidateVisibilityTriangles(candidate).length
    && candidate?.options?.keepVisibilitySamplesWithTriangles !== true
  ) {
    const samples = candidateVisibilitySamples(candidate);
    return samples.length ? samples : segmentSample;
  }
  if (segmentCount > 1) {
    return segmentSample;
  }
  const samples = candidateVisibilitySamples(candidate);
  return samples.length ? samples : segmentSample;
}

function directLiveSegmentVisibilityPayload(candidate = null, segment = null, segmentCount = 1) {
  const sourceTriangles = candidateVisibilityTriangles(candidate);
  const reuseFullProjectedSurface = sourceTriangles.length
    && candidateUsesProjectedSurfaceField(candidate);
  const triangles = sourceTriangles.length
    && (
      reuseFullProjectedSurface
      || (
        candidate?.options?.reuseCandidateVisibilityTrianglesForSegments === true
        && Math.max(1, Math.floor(Number(segmentCount) || 1)) <= 1
      )
    )
    ? sourceTriangles
    : sourceTriangles.length
    ? directLiveSegmentVisibilityTriangles(candidate, segment)
    : [];
  const samples = sourceTriangles.length && !triangles.length
    ? (segment ? [{ segment }] : [])
    : directLiveSegmentVisibilitySamples(candidate, segment, segmentCount);
  return { samples, triangles };
}

function compactStrokeSegment(segment = null) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!start || !end) {
    return null;
  }
  const radiusPixels = Number(segment?.radiusPixels);
  const screenStart = finitePoint(segment?.screenStart);
  const screenEnd = finitePoint(segment?.screenEnd);
  const screenRadiusPixels = Number(segment?.screenRadiusPixels);
  const viewStart = finiteViewPoint(segment?.viewStart);
  const viewEnd = finiteViewPoint(segment?.viewEnd);
  const viewNormalStart = finiteViewPoint(segment?.viewNormalStart || segment?.normalStart);
  const viewNormalEnd = finiteViewPoint(segment?.viewNormalEnd || segment?.normalEnd);
  const viewRadiusPixels = Number(segment?.viewRadiusPixels);
  const componentStart = Math.floor(Number(segment?.componentStart));
  const componentEnd = Math.floor(Number(segment?.componentEnd));
  return {
    start,
    end,
    ...(screenStart && screenEnd ? { screenStart, screenEnd } : {}),
    ...(viewStart && viewEnd ? { viewStart, viewEnd } : {}),
    ...(viewNormalStart ? { viewNormalStart } : {}),
    ...(viewNormalEnd ? { viewNormalEnd } : {}),
    ...(Number.isInteger(componentStart) && componentStart >= 0 ? { componentStart } : {}),
    ...(Number.isInteger(componentEnd) && componentEnd >= 0 ? { componentEnd } : {}),
    ...(Number.isFinite(viewRadiusPixels) && viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
    ...(Number.isFinite(screenRadiusPixels) && screenRadiusPixels > 0 ? { screenRadiusPixels } : {}),
    ...(Number.isFinite(radiusPixels) && radiusPixels > 0 ? { radiusPixels } : {})
  };
}

function screenProjectedSegmentsForTextureSegments(candidate = null, segments = []) {
  const candidateScreenSegments = Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
    ? candidate.options.screenProjectedStrokeSegments
    : [];
  if (
    candidateScreenSegments.length
    && (
      candidate?.options?.screenStrokePaint === true
      || candidate?.options?.liveProjectedPaint === true
    )
  ) {
    // A live screen stroke is one continuous screen-space brush field. Texture
    // segments only scope UV work and visibility; rebuilding the screen path
    // from material-specific hits reintroduces center-hit gaps as detached dots.
    return candidateScreenSegments;
  }
  const localSegments = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const screenStart = finitePoint(segment?.screenStart);
    const screenEnd = finitePoint(segment?.screenEnd);
    if (!screenStart || !screenEnd) {
      continue;
    }
    const textureRadiusPixels = Number(segment?.radiusPixels)
      || Number(candidate?.radiusPixels)
      || Number(candidate?.options?.radiusPixels);
    const screenRadiusPixels = Number(segment?.screenRadiusPixels)
      || Number(candidate?.screenRadiusPixels)
      || Number(candidate?.options?.screenRadiusPixels)
      || Number(candidate?.options?.screenBrushRadiusPixels)
      || textureRadiusPixels;
    localSegments.push({
      start: screenStart,
      end: screenEnd,
      ...(Number.isFinite(screenRadiusPixels) && screenRadiusPixels > 0 ? { radiusPixels: screenRadiusPixels } : {})
    });
  }
  if (localSegments.length) {
    return localSegments;
  }
  return candidateScreenSegments;
}

function compactCandidateDebug(candidate = null) {
  if (!candidate) {
    return null;
  }
  const center = finitePoint(candidate.center);
  const start = finitePoint(candidate.start);
  const segments = candidateStrokeSegments(candidate).map(compactStrokeSegment).filter(Boolean);
  const triangles = candidateVisibilityTriangles(candidate);
  const samples = candidateVisibilitySamples(candidate);
  const paintRegions = candidatePaintRegions(candidate);
	  const candidateDebugCounts = candidate.options?.candidateDebugCounts || null;
	  const candidateTimingMs = candidate.options?.candidateTimingMs || null;
  const compactDebugCounts = candidateDebugCounts && typeof candidateDebugCounts === "object"
    ? Object.fromEntries(
        Object.entries(candidateDebugCounts)
          .filter(([, value]) => Number.isFinite(Number(value)))
          .map(([key, value]) => [key, Math.max(0, Math.floor(Number(value) || 0))])
      )
    : null;
  const screenProjectedSegments = Array.isArray(candidate.options?.screenProjectedStrokeSegments)
    ? candidate.options.screenProjectedStrokeSegments.map(compactStrokeSegment).filter(Boolean)
    : [];
  const color = candidate.options?.color || {};
  const firstTriangle = triangles[0] || null;
  const firstSegment = segments[0] || null;
  const nonZeroSegmentCount = segments.filter((segment) => {
    const segmentStart = finitePoint(segment?.start);
    const segmentEnd = finitePoint(segment?.end);
    return segmentStart
      && segmentEnd
      && Math.hypot(segmentEnd.x - segmentStart.x, segmentEnd.y - segmentStart.y) > 0.001;
  }).length;
  const compactSegmentsForDebug = (list = []) => list.slice(0, 16).map((segment) => ({
    start: finitePoint(segment?.start),
    end: finitePoint(segment?.end),
    radiusPixels: Number.isFinite(Number(segment?.radiusPixels))
      ? Math.round(Number(segment.radiusPixels) * 10) / 10
      : null,
    screenStart: finitePoint(segment?.screenStart),
    screenEnd: finitePoint(segment?.screenEnd),
    screenRadiusPixels: Number.isFinite(Number(segment?.screenRadiusPixels))
      ? Math.round(Number(segment.screenRadiusPixels) * 10) / 10
      : null,
    viewStart: finiteViewPoint(segment?.viewStart),
    viewEnd: finiteViewPoint(segment?.viewEnd),
    viewRadiusPixels: Number.isFinite(Number(segment?.viewRadiusPixels))
      ? Math.round(Number(segment.viewRadiusPixels) * 1000) / 1000
      : null
  })).filter((segment) => segment.start && segment.end);
  return {
    materialName: candidate.material?.name || "",
    materialIndex: candidate.materialIndex ?? null,
    layerMode: candidate.layerMode === true,
    editableWidth: Math.max(0, Number(candidate.editable?.canvas?.width) || 0),
    editableHeight: Math.max(0, Number(candidate.editable?.canvas?.height) || 0),
    center,
    start,
    radiusPixels: Number.isFinite(Number(candidate.radiusPixels)) ? Number(candidate.radiusPixels) : null,
    bounds: candidate.paintBounds || candidatePaintBounds(candidate),
    regionCount: paintRegions.length,
    paintRegions: paintRegions.slice(0, 16).map((region) => ({ ...region })),
    segmentCount: segments.length,
    nonZeroSegmentCount,
    firstSegment,
    strokeSegments: compactSegmentsForDebug(segments),
    visibilitySampleCount: samples.length,
    screenProjectedSegmentCount: screenProjectedSegments.length,
    firstScreenProjectedSegment: screenProjectedSegments[0] || null,
    screenProjectedStrokeSegments: compactSegmentsForDebug(screenProjectedSegments),
    visibilityTriangleCount: triangles.length,
	    candidateDebugCounts: compactDebugCounts,
    candidateTimingMs: candidateTimingMs && typeof candidateTimingMs === "object"
      ? {
          visibility: Math.max(0, Number(candidateTimingMs.visibility) || 0),
          strokeSegments: Math.max(0, Number(candidateTimingMs.strokeSegments) || 0),
          paintRegions: Math.max(0, Number(candidateTimingMs.paintRegions) || 0),
          total: Math.max(0, Number(candidateTimingMs.total) || 0)
        }
      : null,
    firstTriangle,
    centerInsideFirstTriangle: center && firstTriangle ? pointInVisibilityTriangle(center, firstTriangle) : null,
    centerInsideAnyTriangle: center ? triangles.some((triangle) => pointInVisibilityTriangle(center, triangle)) : null,
    firstSegmentNearAnyTriangle: firstSegment
      ? triangles.some((triangle) => segmentToVisibilityTriangleDistance(firstSegment, triangle) <= Math.max(1, Number(candidate.radiusPixels) || 1))
      : null,
    options: {
      color: {
        r: Number.isFinite(Number(color.r)) ? Number(color.r) : null,
        g: Number.isFinite(Number(color.g)) ? Number(color.g) : null,
        b: Number.isFinite(Number(color.b)) ? Number(color.b) : null
      },
      opacity: Number.isFinite(Number(candidate.options?.opacity)) ? Number(candidate.options.opacity) : null,
      hardness: Number.isFinite(Number(candidate.options?.hardness)) ? Number(candidate.options.hardness) : null,
      scatter: Number.isFinite(Number(candidate.options?.scatter)) ? Number(candidate.options.scatter) : null,
      visibleEdgeMode: candidate.options?.visibleEdgeMode || "",
      visibilityFeatherRadius: Number.isFinite(Number(candidate.options?.visibilityFeatherRadius))
        ? Number(candidate.options.visibilityFeatherRadius)
        : null,
      visibilityMaskThreshold: Number.isFinite(Number(candidate.options?.visibilityMaskThreshold))
        ? Number(candidate.options.visibilityMaskThreshold)
        : null,
      visibilityBleedRadius: Number.isFinite(Number(candidate.options?.visibilityBleedRadius))
        ? Number(candidate.options.visibilityBleedRadius)
        : null,
      visibilityMaskKey: candidate.options?.visibilityMaskKey || ""
    }
  };
}

function directLiveCandidateBatches(candidates = []) {
  const batches = [];
  const activeBatchByKey = new Map();
  const activeBatchesByKey = new Map();
  const activeBatchesByVisibilityKey = new Map();
  const rememberActiveBatch = (key, batch) => {
    activeBatchByKey.set(key, batch);
    const list = activeBatchesByKey.get(key) || [];
    list.push(batch);
    activeBatchesByKey.set(key, list);
  };
  const rememberVisibilityBatch = (batch, candidate) => {
    const key = directLiveVisibilityMergeKey(candidate);
    const list = activeBatchesByVisibilityKey.get(key) || [];
    list.push(batch);
    activeBatchesByVisibilityKey.set(key, list);
  };
  const visibilityBatchForCandidate = (candidate) => {
    const exact = activeBatchByKey.get(directLiveCandidateBatchKey(candidate));
    if (exact) {
      return exact;
    }
    const list = activeBatchesByVisibilityKey.get(directLiveVisibilityMergeKey(candidate)) || [];
    if (list.length <= 1) {
      return list[0] || null;
    }
    const center = finitePoint(candidate?.center) || finitePoint(candidate?.start);
    return [...list].sort((left, right) => (
      paintBoundsDistanceToPoint(left.paintBounds || candidatePaintBounds(left), center)
      - paintBoundsDistanceToPoint(right.paintBounds || candidatePaintBounds(right), center)
    ))[0] || null;
  };
  const startBatch = (candidate, key, segment = null) => {
    const segmentCenter = finitePoint(segment?.end) || finitePoint(segment?.start) || finitePoint(candidate?.center);
    const batch = {
      ...candidate,
      ...(segmentCenter ? { center: segmentCenter } : {}),
      ...(segment?.start ? { start: segment.start } : {}),
      strokeSegments: [],
      paintRegions: [],
      displayPaintRegions: [],
      options: {
        ...candidate.options,
        strokeSegments: [],
        screenProjectedStrokeSegments: [],
        visibilityMaskPixels: null,
        visibilityMaskSamples: [],
        visibilityMaskTriangles: []
      },
      estimate: 0
    };
    rememberActiveBatch(key, batch);
    rememberVisibilityBatch(batch, candidate);
    batches.push(batch);
    return batch;
  };
  const startVisibilityExpansionBatch = (sourceBatch = null, candidate = null) => {
    if (!sourceBatch?.strokeSegments?.length) {
      return sourceBatch || null;
    }
    const key = directLiveCandidateBatchKey(candidate || sourceBatch);
    const strokeSegments = sourceBatch.strokeSegments.map((segment) => ({ ...segment }));
    const screenProjectedStrokeSegments = Array.isArray(sourceBatch.options?.screenProjectedStrokeSegments)
      ? sourceBatch.options.screenProjectedStrokeSegments.map((segment) => ({ ...segment }))
      : [];
    const batch = {
      ...sourceBatch,
      center: finitePoint(candidate?.center) || sourceBatch.center,
      start: sourceBatch.start,
      strokeSegments,
      paintRegions: Array.isArray(sourceBatch.paintRegions) ? [...sourceBatch.paintRegions] : [],
      displayPaintRegions: Array.isArray(sourceBatch.displayPaintRegions) ? [...sourceBatch.displayPaintRegions] : [],
      options: {
        ...sourceBatch.options,
        strokeSegments,
        screenProjectedStrokeSegments,
        liveVisibilityOverflowBatch: true,
        visibilityMaskPixels: null,
        visibilityMaskSamples: [],
        visibilityMaskTriangles: []
      },
      liveVisibilityOverflowBatch: true,
      estimate: sourceBatch.estimate || textureAirbrushWebGpuStrokeEstimate(sourceBatch)
    };
    rememberActiveBatch(key, batch);
    rememberVisibilityBatch(batch, candidate || sourceBatch);
    batches.push(batch);
    return batch;
  };
  const mergeProjectedPaintRegionsIntoBatch = (batch = null, candidate = null, fallbackCandidate = null) => {
    if (!batch || !candidate) {
      return;
    }
    const projectedPaintRegions = candidateUsesProjectedPaintRegions(candidate)
      ? candidate.paintRegions
      : null;
    if (projectedPaintRegions) {
      batch.paintRegions = mergeProjectedPaintRegionLists(
        batch.paintRegions,
        projectedPaintRegions,
        candidate.editable?.canvas || null
      );
      batch.paintBounds = unionPaintBounds(
        batch.paintBounds,
        candidate.paintBounds || candidatePaintBounds(candidate)
      );
      if (Array.isArray(candidate.displayPaintRegions) && candidate.displayPaintRegions.length) {
        batch.displayPaintRegions = mergeProjectedPaintRegionLists(
          batch.displayPaintRegions,
          candidate.displayPaintRegions,
          candidate.editable?.canvas || null
        );
      }
      return;
    }
    const segmentBounds = candidatePaintBounds(fallbackCandidate || candidate);
    batch.paintBounds = unionPaintBounds(batch.paintBounds, segmentBounds);
    batch.paintRegions = mergePaintRegions(batch.paintRegions, segmentBounds, candidate.editable?.canvas || null);
    batch.displayPaintRegions = mergePaintRegions(batch.displayPaintRegions, segmentBounds, candidate.editable?.canvas || null);
  };
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate?.editable || !candidate.material) {
      continue;
    }
    if (candidate.visibilityOnly === true || candidate.options?.visibilityOnly === true) {
      let batch = visibilityBatchForCandidate(candidate);
      if (batch) {
        const samples = candidateVisibilitySamples(candidate);
        const triangles = candidateVisibilityTriangles(candidate);
        const screenSegments = visibilityOnlyScreenStrokeSegments(candidate, batch);
        const filteredTriangles = visibilityTrianglesForScreenStrokeSegments(
          triangles,
          screenSegments,
          candidate?.options || batch?.options || {}
        );
        const overflowOptions = {
          ...batch.options,
          screenProjectedStrokeSegments: Array.isArray(batch.options?.screenProjectedStrokeSegments)
            ? [...batch.options.screenProjectedStrokeSegments]
            : []
        };
        appendScreenProjectedStrokeSegments(overflowOptions, screenSegments);
        if (
          visibilityOverflowBatchesAllowed(candidate, batch)
          && visibilityTrianglesWouldOverflow(overflowOptions, filteredTriangles)
        ) {
          batch = startVisibilityExpansionBatch(batch, candidate);
        }
        appendScreenProjectedStrokeSegments(batch.options, screenSegments);
        const fallbackSamples = directCandidateStrokeSegments(candidate)
          .map((segment) => ({ segment }));
        appendVisibilitySamples(batch.options, samples.length ? samples : fallbackSamples);
        appendVisibilityTriangles(batch.options, filteredTriangles);
        // Visibility-only footprint probes authorize camera-facing texels for
        // the live projected stroke. They carry screen segments for the soft
        // normal-observability mask, but paint dispatch bounds stay anchored to
        // the actual unwrapped-UV brush path.
      }
      continue;
    }
    const segments = directCandidateStrokeSegments(candidate);
    if (!segments.length) {
      continue;
    }
    const candidateEstimate = Math.max(0, candidate.estimate || textureAirbrushWebGpuStrokeEstimate(candidate));
    if (candidateUsesTslSurfaceDescriptor(candidate)) {
      const surfaceSegments = segments.map((segment) => directLiveSegmentWithRadius(candidate, segment));
      const surfaceScreenSegments = Array.isArray(candidate.options?.screenProjectedStrokeSegments)
        && candidate.options.screenProjectedStrokeSegments.length
        ? candidate.options.screenProjectedStrokeSegments
        : screenProjectedSegmentsForTextureSegments(candidate, surfaceSegments);
      const surfaceCandidate = {
        ...candidate,
        strokeSegments: surfaceSegments,
        options: {
          ...candidate.options,
          strokeSegments: surfaceSegments,
          screenProjectedStrokeSegments: []
        }
      };
      const key = directLiveCandidateBatchKey(surfaceCandidate);
      let batch = (activeBatchesByKey.get(key) || [])
        .filter((candidateBatch) => (
          candidateBatch.strokeSegments.length + surfaceSegments.length <= TEXTURE_AIRBRUSH_WEBGPU_VISIBLE_MAX_BATCH_SEGMENTS
          && webGpuCandidateBatchCanAccept(candidateBatch, surfaceCandidate, surfaceSegments.length)
        ))[0] || null;
      if (!batch) {
        batch = startBatch(surfaceCandidate, key, surfaceSegments[0]);
      }
      batch.strokeSegments.push(...surfaceSegments);
      batch.options.strokeSegments = batch.strokeSegments;
      appendScreenProjectedStrokeSegments(batch.options, surfaceScreenSegments);
      appendVisibilitySamples(
        batch.options,
        candidateVisibilitySamples(candidate).length
          ? candidateVisibilitySamples(candidate)
          : surfaceSegments.map((segment) => ({ segment }))
      );
      appendVisibilityTriangles(batch.options, candidateVisibilityTriangles(candidate));
      batch.radiusPixels = Math.max(
        0.75,
        styleNumber(batch.radiusPixels, 0.75),
        ...surfaceSegments.map((segment) => directLiveSegmentRadiusPixels(candidate, segment))
      );
      batch.options.radiusPixels = batch.radiusPixels;
      mergeProjectedPaintRegionsIntoBatch(batch, surfaceCandidate, surfaceCandidate);
      batch.estimate += candidateEstimate;
      continue;
    }
    const estimatePerSegment = candidateEstimate / Math.max(1, segments.length);
    for (const sourceSegment of segments) {
      const segment = directLiveSegmentWithRadius(candidate, sourceSegment);
      const projectedRegionScope = scopedProjectedPaintRegionsForSegment(candidate, segment);
      const {
        paintBounds: _candidatePaintBounds,
        paintRegions: _candidatePaintRegions,
        ...candidateWithoutPaintRegions
      } = candidate;
      const segmentCandidate = {
        ...candidateWithoutPaintRegions,
        radiusPixels: segment.radiusPixels,
        strokeSegments: [segment],
        ...(projectedRegionScope?.bounds ? { paintBounds: projectedRegionScope.bounds } : {}),
        ...(projectedRegionScope?.regions?.length ? { paintRegions: projectedRegionScope.regions } : {}),
        options: {
          ...candidate.options,
          radiusPixels: segment.radiusPixels,
          strokeSegments: [segment],
          screenProjectedStrokeSegments: screenProjectedSegmentsForTextureSegments(candidate, [segment])
        }
      };
      const key = directLiveCandidateBatchKey(segmentCandidate, segment);
      const payload = directLiveSegmentVisibilityPayload(segmentCandidate, segment, segments.length);
      const mergeCandidate = {
        ...segmentCandidate,
        options: {
          ...segmentCandidate.options,
          visibilityMaskSamples: payload.samples,
          visibilityMaskTriangles: payload.triangles
        }
      };
      const compatibleBatches = (activeBatchesByKey.get(key) || [])
        .filter((candidateBatch) => (
          candidateBatch.strokeSegments.length < TEXTURE_AIRBRUSH_WEBGPU_VISIBLE_MAX_BATCH_SEGMENTS
          && !(
            visibilityOverflowBatchesAllowed(segmentCandidate, candidateBatch)
            && visibilityTrianglesWouldOverflow(candidateBatch.options, payload.triangles)
          )
          && webGpuCandidateBatchCanAccept(candidateBatch, mergeCandidate, 1)
        ));
      const segmentCenter = finitePoint(segment?.end) || finitePoint(segment?.start) || finitePoint(segmentCandidate.center);
      let batch = compatibleBatches.sort((left, right) => (
        paintBoundsDistanceToPoint(left.paintBounds || candidatePaintBounds(left), segmentCenter)
        - paintBoundsDistanceToPoint(right.paintBounds || candidatePaintBounds(right), segmentCenter)
      ))[0] || null;
      if (!batch) {
        const splitReasons = (activeBatchesByKey.get(key) || [])
          .map((candidateBatch) => webGpuCandidateBatchRejectReason(candidateBatch, mergeCandidate, 1))
          .filter((reason) => reason && reason !== "accepted");
        if (splitReasons.length) {
          segmentCandidate.options = {
            ...segmentCandidate.options,
            liveBatchSplitReasons: splitReasons.slice(0, 4)
          };
        }
        batch = startBatch(segmentCandidate, key, segment);
      }
      batch.strokeSegments.push(segment);
      batch.options.strokeSegments = batch.strokeSegments;
      appendScreenProjectedStrokeSegments(
        batch.options,
        segmentCandidate.options?.screenProjectedStrokeSegments || []
      );
      batch.radiusPixels = Math.max(
        0.75,
        styleNumber(batch.radiusPixels, 0.75),
        segment.radiusPixels
      );
      batch.options.radiusPixels = batch.radiusPixels;
      const batchBleedRadius = Number(batch.options.visibilityBleedRadius);
      const segmentBleedRadius = Number(segmentCandidate.options?.visibilityBleedRadius);
      const hasBatchBleedRadius = Number.isFinite(batchBleedRadius) && batchBleedRadius > 0;
      const hasSegmentBleedRadius = Number.isFinite(segmentBleedRadius) && segmentBleedRadius > 0;
      if (hasBatchBleedRadius || hasSegmentBleedRadius) {
        batch.options.visibilityBleedRadius = Math.max(
          hasBatchBleedRadius ? batchBleedRadius : 0,
          hasSegmentBleedRadius ? segmentBleedRadius : 0
        );
      }
      if (!batch.options.visibilityMaskPixels) {
        appendVisibilitySamples(batch.options, payload.samples);
        appendVisibilityTriangles(batch.options, payload.triangles);
      }
      mergeProjectedPaintRegionsIntoBatch(batch, segmentCandidate, segmentCandidate);
      batch.estimate += estimatePerSegment;
    }
  }
  return batches;
}

function liveHitSampleCacheForEditor(editor = null, event = null) {
  if (!editor) {
    return null;
  }
  const activeStroke = webGpuActiveStrokeUndo(editor);
  const owner = activeStroke || (event?.buttons ? "active-pointer" : null);
  const cameraSerial = Number(editor.textureAirbrushCameraPrewarmSerial) || 0;
  if (!owner) {
    editor.textureAirbrushWebGpuLiveHitSampleCache = null;
    editor.textureAirbrushWebGpuLiveHitSampleCacheOwner = null;
    editor.textureAirbrushWebGpuLiveHitSampleCacheCameraSerial = null;
    return null;
  }
  if (
    !(editor.textureAirbrushWebGpuLiveHitSampleCache instanceof Map)
    || editor.textureAirbrushWebGpuLiveHitSampleCacheOwner !== owner
    || editor.textureAirbrushWebGpuLiveHitSampleCacheCameraSerial !== cameraSerial
  ) {
    editor.textureAirbrushWebGpuLiveHitSampleCache = new Map();
    editor.textureAirbrushWebGpuLiveHitSampleCacheOwner = owner;
    editor.textureAirbrushWebGpuLiveHitSampleCacheCameraSerial = cameraSerial;
  }
  return editor.textureAirbrushWebGpuLiveHitSampleCache;
}

function imageDataMatchesEditableSize(imageData = null, editable = null) {
  const width = Math.max(0, Math.floor(Number(editable?.canvas?.width) || 0));
  const height = Math.max(0, Math.floor(Number(editable?.canvas?.height) || 0));
  return Boolean(
    width
    && height
    && imageData?.width === width
    && imageData?.height === height
    && imageData?.data?.byteLength === width * height * 4
  );
}

function aggregatePaintRunStats(results = []) {
  const statsList = (Array.isArray(results) ? results : [])
    .map((result) => result?.stats || null)
    .filter(Boolean);
  if (!statsList.length) {
    return {};
  }
  const lastStats = statsList.at(-1) || {};
  const sum = (key) => statsList.reduce((total, stats) => (
    total + (Number.isFinite(Number(stats?.[key])) ? Number(stats[key]) : 0)
  ), 0);
  const timingSum = (key) => statsList.reduce((total, stats) => (
    total + (Number.isFinite(Number(stats?.timings?.[key])) ? Number(stats.timings[key]) : 0)
  ), 0);
  const any = (key) => statsList.some((stats) => stats?.[key] === true);
  return {
    ...lastStats,
    splitPaintRuns: statsList.length,
    timings: {
      ...(lastStats.timings || {}),
      prepareMs: timingSum("prepareMs"),
      dispatchMs: timingSum("dispatchMs"),
      readbackMs: timingSum("readbackMs"),
      applyMs: timingSum("applyMs"),
      totalMs: timingSum("totalMs")
    },
    liveDisplayExternalTexture: any("liveDisplayExternalTexture"),
    liveDisplayFullUpdate: any("liveDisplayFullUpdate"),
    liveDisplayWorkPixels: sum("liveDisplayWorkPixels"),
    liveDisplayMipmapPixels: sum("liveDisplayMipmapPixels"),
    sourceBytes: sum("sourceBytes"),
    strokeSourceBytes: sum("strokeSourceBytes"),
    readbackBytes: sum("readbackBytes"),
    appliedBytes: sum("appliedBytes"),
    visibilityMaskBytes: sum("visibilityMaskBytes"),
    visibilitySampleCount: Math.max(0, ...statsList.map((stats) => Number(stats?.visibilitySampleCount) || 0)),
    visibilityTriangleCount: Math.max(0, ...statsList.map((stats) => Number(stats?.visibilityTriangleCount) || 0)),
    screenProjectedCoverageActive: any("screenProjectedCoverageActive"),
    screenProjectedStrokeSegmentCount: Math.max(0, ...statsList.map((stats) => Number(stats?.screenProjectedStrokeSegmentCount) || 0)),
    sourceExternalUploaded: any("sourceExternalUploaded"),
    strokeSourceUploaded: any("strokeSourceUploaded"),
    strokeSourceCopiedFromSource: any("strokeSourceCopiedFromSource"),
    deferredReadback: any("deferredReadback"),
    deferredReadbackCopy: any("deferredReadbackCopy"),
    liveDisplayMipmapDeferred: any("liveDisplayMipmapDeferred"),
    liveDisplayMipmapDowngraded: any("liveDisplayMipmapDowngraded"),
    liveDisplayMipmapDowngradeBlocked: any("liveDisplayMipmapDowngradeBlocked")
  };
}

function aggregatePaintRunResult(results = []) {
  const runResults = (Array.isArray(results) ? results : []).filter(Boolean);
  if (runResults.length <= 1) {
    return runResults[0] || null;
  }
  const appliedResult = runResults.find((result) => result?.applied) || null;
  const readbackPromises = runResults
    .map((result) => result?.readbackPromise || null)
    .filter(Boolean);
  const aggregate = {
    ...(runResults.at(-1) || {}),
    splitPaintRuns: runResults.length,
    paintRunResults: runResults,
    applied: appliedResult?.applied || false,
    stats: aggregatePaintRunStats(runResults)
  };
  aggregate.readbackPromise = readbackPromises.length
    ? Promise.allSettled(readbackPromises)
    : null;
  return aggregate;
}

export function installTextureAirbrushWebGpuLiveMethods(BirdWeightEditor) {
  installTextureAirbrushWebGpuCandidateMethods(BirdWeightEditor);
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushTrackWebGpuPaint(promise) {
      if (!promise || typeof promise.finally !== "function") {
        return promise;
      }
      this.textureAirbrushPendingWebGpuPaints ||= new Set();
      this.textureAirbrushPendingWebGpuPaints.add(promise);
      promise.finally(() => {
        this.textureAirbrushPendingWebGpuPaints?.delete?.(promise);
        this.textureAirbrushClearWebGpuScreenPreviewWhenIdle?.();
      }).catch(() => {});
      return promise;
    },

    textureAirbrushQueueWebGpuApplyRefresh(candidate = null) {
      this.textureAirbrushDeferredWebGpuRefreshRecords ||= new Set();
      this.textureAirbrushDeferredWebGpuRefreshRecords.add(candidate?.record || null);
      if (candidate?.material) {
        this.textureAirbrushDeferredWebGpuDisplayMaterials ||= new Set();
        this.textureAirbrushDeferredWebGpuDisplayMaterials.add(candidate.material);
      }
      this.textureAirbrushDeferredWebGpuPreviewRefresh = true;
      return true;
    },

    flushTextureAirbrushDeferredWebGpuApplyRefresh() {
      const records = [...(this.textureAirbrushDeferredWebGpuRefreshRecords || [])];
      const displayMaterials = [...(this.textureAirbrushDeferredWebGpuDisplayMaterials || [])];
      const needsPreviewRefresh = this.textureAirbrushDeferredWebGpuPreviewRefresh === true || records.length > 0;
      if (!needsPreviewRefresh && !displayMaterials.length) {
        return false;
      }
      this.textureAirbrushDeferredWebGpuRefreshRecords = new Set();
      this.textureAirbrushDeferredWebGpuDisplayMaterials = new Set();
      this.textureAirbrushDeferredWebGpuPreviewRefresh = false;
      for (const material of displayMaterials) {
        const userData = material?.userData || {};
        const externalMap = userData.textureAirbrushWebGpuExternalMap || null;
        const canvasMap = userData.textureAirbrushWebGpuCanvasMap || null;
        if (externalMap && canvasMap && material.map === externalMap) {
          // Keep the live WebGPU texture bound for viewer quality. The canvas map
          // is still synchronized for undo/export, but swapping back here can
          // force a lower-quality canvas upload immediately after a stroke.
          // Do not mark THREE.ExternalTexture itself as needing update here:
          // Three's WebGPU backend treats an already-initialized ExternalTexture
          // as immutable and throws "Texture already initialized" if a later
          // render sees its version bumped. The GPUTexture content was updated
          // by the paint dispatch; no Three texture upload is required.
          // Do not mark the material either. Rebuilding the material while the
          // same ExternalTexture remains bound can flicker through the fallback
          // canvas/mipmap state and makes the stroke feel delayed.
        } else {
          delete userData.textureAirbrushWebGpuExternalMap;
          delete userData.textureAirbrushWebGpuCanvasMap;
        }
      }
      const refreshAll = records.some((record) => !record);
      if (refreshAll) {
        this.refreshCloneSpotlightTextures?.();
      } else {
        for (const record of records) {
          this.refreshCloneSpotlightTextures?.(record);
        }
      }
      this.updateClonePaintPreviews?.();
      return true;
    },

    flushTextureAirbrushPendingWebGpuPaints(options = {}) {
      let canvasSyncIdleWaited = false;
      const finishPendingFlush = (results = []) => {
        const waitForCanvasSync = canvasSyncIdleWaited
          ? Promise.resolve(true)
          : waitForWebGpuCanvasSyncIdle(this, options);
        const canvasSyncApplyBudget = Number(options.canvasSyncApplyBudgetMs);
        const syncOptions = {
          ...options,
          canvasSyncApplyBudgetMs: Number.isFinite(canvasSyncApplyBudget)
            ? Math.max(0, canvasSyncApplyBudget)
            : options.deferCanvasSyncUntilIdle === true
              ? 4
              : 0
        };
        return waitForCanvasSync.then(() => (
          this.textureAirbrushSyncDeferredWebGpuCanvases?.(syncOptions) || []
        )).then(() => {
          this.flushTextureAirbrushDeferredWebGpuApplyRefresh?.();
          return results;
        });
      };
      const budgetQueuedDrain = options.deferCanvasSyncUntilIdle === true
        && options.forceQueuedDrain !== true;
      const drainQueued = budgetQueuedDrain
        ? () => waitForWebGpuQueuedPaintDrain(this, options)
        : () => Promise.resolve(
          this.flushTextureAirbrushQueuedWebGpuStrokes?.({
            ...options,
            force: true,
            deferReadbackStart: options.deferReadbackStart !== false
              && options.deferCanvasSyncUntilIdle === true,
            liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false
          }) || 0
        ).then(() => {
          if (this.textureAirbrushWebGpuFlushInFlight || (this.textureAirbrushQueuedWebGpuStrokes || []).length) {
            return drainQueued();
          }
          return null;
        });
      return drainQueued().then(() => {
        const waitForReadbackIdle = options.deferCanvasSyncUntilIdle === true
          ? waitForWebGpuCanvasSyncIdle(this, options)
          : Promise.resolve(false);
        return waitForReadbackIdle.then((waited) => {
          canvasSyncIdleWaited = waited === true;
          this.textureAirbrushReleaseDeferredWebGpuReadbacks?.();
        });
      }).then(() => {
        const pending = [...(this.textureAirbrushPendingWebGpuPaints || [])];
        if (!pending.length) {
          return finishPendingFlush([]);
        }
        return Promise.allSettled(pending).then((results) => {
          return finishPendingFlush(results);
        });
      });
    },

    textureAirbrushWebGpuCandidateBatch(candidate = null, segmentCount = candidateStrokeSegments(candidate).length) {
      if (!candidate?.editable || !candidate.material) {
        return null;
      }
      const strokeUndo = candidate.strokeUndo || webGpuActiveStrokeUndo(this) || null;
      const undoKey = webGpuCandidateUndoKey(candidate);
      const strokeSourceOwner = webGpuCandidateStrokeSourceOwner(this, candidate, strokeUndo, undoKey);
      const styleKey = webGpuQueuedCandidateStyleKey(candidate);
      const localityKey = webGpuCandidateLocalityKey(candidate);
      const queue = this.textureAirbrushQueuedWebGpuStrokes || [];
      const sameTarget = (batch = null) => (
        batch.record === candidate.record
        && batch.material === candidate.material
        && batch.editable === candidate.editable
        && batch.materialIndex === candidate.materialIndex
        && batch.styleKey === styleKey
        && (batch.strokeUndo || null) === strokeUndo
        && (batch.webGpuStrokeSourceOwner || null) === (strokeSourceOwner || null)
        && webGpuCandidateBatchCanAccept(batch, candidate, segmentCount)
      );
      const exactLocalityBatch = queue.find((batch) => (
        sameTarget(batch)
        && batch.localityKey === localityKey
      ));
      if (exactLocalityBatch) {
        return exactLocalityBatch;
      }
      return queue
        .filter((batch) => (
          sameTarget(batch)
          && batch.localityKey !== localityKey
          && webGpuCandidateCanCrossLocalityMerge(batch, candidate)
        ))
        .sort((left, right) => (
          paintBoundsDistanceToPoint(left.paintBounds || candidatePaintBounds(left), candidate.center || candidate.start)
          - paintBoundsDistanceToPoint(right.paintBounds || candidatePaintBounds(right), candidate.center || candidate.start)
        ))[0] || null;
    },

    textureAirbrushQueueWebGpuStrokeCandidate(candidate = null, options = {}) {
      if (!candidate?.editable || !candidate.material) {
        return 0;
      }
      this.textureAirbrushQueuedWebGpuStrokes ||= [];
      this.textureAirbrushQueuedWebGpuUndoKeys ||= new Set();
      const undoKey = webGpuCandidateUndoKey(candidate);
      const strokeUndo = candidate.strokeUndo || webGpuActiveStrokeUndo(this) || null;
      const strokeSourceOwner = webGpuCandidateStrokeSourceOwner(this, candidate, strokeUndo, undoKey);
      const strokeUndoKeys = webGpuStrokeUndoKeys(strokeUndo) || activeStrokeWebGpuUndoKeys(this);
      const styleKey = webGpuQueuedCandidateStyleKey(candidate);
      const queuedSegments = candidateStrokeSegments(candidate);
      const chunks = webGpuCandidateSegmentChunks(candidate, queuedSegments);
      pruneStaleQueuedTslSurfaceBatches(this, candidate, {
        styleKey,
        strokeUndo,
        strokeSourceOwner
      });
      let totalEstimate = 0;
      const {
        paintBounds: _candidatePaintBounds,
        paintRegions: _candidatePaintRegions,
        displayPaintRegions: _candidateDisplayPaintRegions,
        ...candidateWithoutPaintScope
      } = candidate;
      const explicitPaintRegions = Array.isArray(candidate.paintRegions) && candidate.paintRegions.length
        ? candidate.paintRegions
          .map((region) => normalizePaintBounds(region, candidate.editable?.canvas || null))
          .filter(Boolean)
        : [];
      const explicitPaintBounds = candidate.paintBounds
        || (explicitPaintRegions.length ? unionPaintRegionList(explicitPaintRegions) : null);
      const explicitDisplayRegions = Array.isArray(candidate.displayPaintRegions) && candidate.displayPaintRegions.length
        ? candidate.displayPaintRegions
          .map((region) => normalizePaintBounds(region, candidate.editable?.canvas || null))
          .filter(Boolean)
        : [];
      const preserveExplicitPaintScope = explicitPaintRegions.length > 0 && chunks.length === 1;
      for (const chunk of chunks) {
        const chunkStart = finitePoint(chunk[0]?.start) || finitePoint(candidate.start);
        const chunkEnd = finitePoint(chunk.at(-1)?.end) || finitePoint(candidate.center) || chunkStart;
        const chunkCandidate = {
          ...candidateWithoutPaintScope,
          ...(strokeUndo ? { strokeUndo } : {}),
          ...(strokeSourceOwner ? { webGpuStrokeSourceOwner: strokeSourceOwner } : {}),
          ...(chunkStart ? { start: chunkStart } : {}),
          ...(chunkEnd ? { center: chunkEnd } : {}),
          strokeSegments: chunk,
          options: {
            ...candidateWithoutPaintScope.options,
            strokeSegments: chunk,
            screenProjectedStrokeSegments: screenProjectedSegmentsForTextureSegments(candidate, chunk)
          }
		        };
		        const chunkBounds = preserveExplicitPaintScope
		          ? explicitPaintBounds
		          : candidatePaintBounds(chunkCandidate) || candidatePaintBounds(candidate);
		        const chunkRegions = preserveExplicitPaintScope
		          ? explicitPaintRegions
		          : candidatePaintRegions({
		              ...chunkCandidate,
		              paintBounds: chunkBounds
		            });
        const chunkDisplayRegions = preserveExplicitPaintScope && explicitDisplayRegions.length
          ? explicitDisplayRegions
          : candidateDisplayPaintRegions({
              ...chunkCandidate,
              paintBounds: chunkBounds,
              paintRegions: chunkRegions,
              ...(explicitDisplayRegions.length ? { displayPaintRegions: explicitDisplayRegions } : {})
            });
	        const segmentCount = Math.max(1, chunk.length);
	        let batch = this.textureAirbrushWebGpuCandidateBatch?.(chunkCandidate, segmentCount);
        const createdBatch = !batch;
        if (!batch) {
          if (
            largeLiveWebGpuBatch(chunkCandidate)
            || options.largeLiveNeighborPaint === true
            || options.largeLiveBrushPaint === true
          ) {
            trimLargeLiveQueue(this.textureAirbrushQueuedWebGpuStrokes);
          }
          const undoAlreadyQueued = strokeUndo
            ? strokeUndoKeys?.has?.(undoKey) === true
            : this.textureAirbrushQueuedWebGpuUndoKeys.has(undoKey);
          batch = {
            ...candidate,
            ...(strokeUndo ? { strokeUndo } : {}),
            ...(strokeSourceOwner ? { webGpuStrokeSourceOwner: strokeSourceOwner } : {}),
            styleKey: webGpuQueuedCandidateStyleKey(candidate),
            localityKey: webGpuCandidateLocalityKey(candidate),
            strokeSegments: [],
            paintBounds: chunkBounds,
            paintRegions: chunkRegions,
            displayPaintRegions: chunkDisplayRegions,
            undoCaptured: candidate.undoCaptured === true || undoAlreadyQueued,
            options: {
              ...candidate.options,
              strokeSegments: [],
              screenProjectedStrokeSegments: []
            },
            estimate: 0
          };
          this.textureAirbrushQueuedWebGpuStrokes.push(batch);
        }
        this.textureAirbrushQueuedWebGpuUndoKeys.add(undoKey);
        strokeUndoKeys?.add?.(undoKey);
        batch.strokeSegments.push(...chunk);
        batch.options.strokeSegments = batch.strokeSegments;
        appendScreenProjectedStrokeSegments(
          batch.options,
          chunkCandidate.options?.screenProjectedStrokeSegments || []
        );
        appendVisibilitySamples(batch.options, candidateVisibilitySamples(candidate));
        appendVisibilityTriangles(batch.options, candidateVisibilityTriangles(candidate));
        if (!createdBatch) {
          batch.paintBounds = unionPaintBounds(batch.paintBounds, chunkBounds);
          batch.paintRegions = mergePaintRegionLists(batch.paintRegions, chunkRegions, candidate.editable?.canvas || null);
          batch.displayPaintRegions = mergePaintRegionLists(batch.displayPaintRegions, chunkDisplayRegions, candidate.editable?.canvas || null);
        }
        batch.estimate = textureAirbrushWebGpuStrokeEstimate(batch);
        totalEstimate += textureAirbrushWebGpuStrokeEstimate(chunkCandidate);
      }
      if (options.scheduleFlush !== false) {
        this.scheduleTextureAirbrushQueuedWebGpuFlush?.();
      }
      setThrottledWebGpuLiveStatus(this, `WebGPU airbrush queued ${totalEstimate || candidate.estimate} texture pixels`);
      return totalEstimate || candidate.estimate;
    },

    scheduleTextureAirbrushQueuedWebGpuFlush() {
      if (this.textureAirbrushWebGpuFlushScheduled) {
        return false;
      }
      this.textureAirbrushWebGpuFlushScheduled = true;
      const activeLiveScreenStroke = webGpuLiveStrokeActive(this)
        && queuedWebGpuScreenStrokePaintActive(this);
      const schedule = activeLiveScreenStroke && typeof globalThis.requestAnimationFrame === "function"
        ? (callback) => globalThis.requestAnimationFrame(() => callback())
        : typeof globalThis.queueMicrotask === "function"
          ? globalThis.queueMicrotask.bind(globalThis)
          : typeof Promise !== "undefined"
            ? (callback) => Promise.resolve().then(callback)
            : typeof globalThis.setTimeout === "function"
              ? (callback) => globalThis.setTimeout(callback, 0)
              : null;
      if (!schedule) {
        this.textureAirbrushWebGpuFlushScheduled = false;
        return false;
      }
      const runFlush = () => {
        this.textureAirbrushWebGpuFlushScheduled = false;
        this.flushTextureAirbrushQueuedWebGpuStrokes?.(webGpuLiveStrokeActive(this)
          ? { maxBatches: TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_SCHEDULED_FLUSH_MAX_BATCHES }
          : {});
      };
      if (this.textureAirbrushWebGpuFlushInFlight) {
        this.textureAirbrushWebGpuFlushInFlight.finally(() => {
          if ((this.textureAirbrushQueuedWebGpuStrokes || []).length) {
            schedule(runFlush);
          } else {
            this.textureAirbrushWebGpuFlushScheduled = false;
          }
        });
        return true;
      }
      schedule(runFlush);
      return true;
    },

    flushTextureAirbrushQueuedWebGpuStrokes(options = {}) {
      if (this.textureAirbrushWebGpuFlushInFlight) {
        const queued = (this.textureAirbrushQueuedWebGpuStrokes || []).length;
        debugLiveWebGpuAirbrush("flush-skipped-in-flight", {
          queued,
          force: options.force === true
        });
        if (options.force === true) {
          return this.textureAirbrushWebGpuFlushInFlight.then(() => (
            this.flushTextureAirbrushQueuedWebGpuStrokes?.({ ...options, force: true }) || 0
          ));
        }
        if (queued > 0 && options.autoSchedule !== false) {
          this.scheduleTextureAirbrushQueuedWebGpuFlush?.();
        }
        return this.textureAirbrushWebGpuFlushInFlight;
      }
      this.textureAirbrushWebGpuFlushScheduled = false;
      const queue = this.textureAirbrushQueuedWebGpuStrokes || [];
      if (!queue.length) {
        return Promise.resolve(0);
      }
      const explicitMaxBatches = Math.floor(Number(options.maxBatches));
      const largeLiveBatchLimit = options.force !== true
        && !(Number.isFinite(explicitMaxBatches) && explicitMaxBatches > 0)
        ? largeLiveWebGpuFlushBatchLimit(queue)
        : null;
      const maxBatches = options.force === true
        ? queue.length
        : explicitMaxBatches;
      const batchLimit = Number.isFinite(maxBatches) && maxBatches > 0
        ? Math.min(queue.length, maxBatches)
        : queue.length;
      const effectiveBatchLimit = Number.isFinite(largeLiveBatchLimit)
        ? Math.max(
            1,
            Math.min(
              batchLimit,
              largeLiveBatchLimit
            )
          )
        : batchLimit;
      const flushingQueue = queue.slice(0, effectiveBatchLimit);
      this.textureAirbrushQueuedWebGpuStrokes = queue.slice(effectiveBatchLimit);
      debugLiveWebGpuAirbrush("flush-start", {
        queued: queue.length,
        flushing: flushingQueue.length,
        remaining: this.textureAirbrushQueuedWebGpuStrokes.length,
        force: options.force === true,
        maxBatches: options.maxBatches ?? null
      });
      if (!this.textureAirbrushQueuedWebGpuStrokes.length) {
        this.textureAirbrushQueuedWebGpuUndoKeys = new Set();
      }
      const paintPromises = [];
      let estimate = 0;
      const liveDisplayExternalTexture = options.liveDisplayExternalTexture !== false;
      const displayRefreshKeys = flushingQueue.map((batch) => webGpuLiveDisplayRefreshKey(batch));
      const lastDisplayRefreshIndexByKey = new Map();
      displayRefreshKeys.forEach((key, index) => {
        if (key) {
          lastDisplayRefreshIndexByKey.set(key, index);
        }
      });
      const deferReadbackStart = options.deferReadbackStart === true
        || (options.force !== true && options.deferReadbackStart !== false);
      const activeLiveStroke = webGpuLiveStrokeActive(this);
      const hasLiveProjectedFlush = flushingQueue.some((batch) => (
        batch?.options?.liveProjectedPaint === true
        || batch?.options?.visibilityMaskMode === "samples"
        || batch?.options?.visibleSurfaceMaskRequired === true
      ));
      const hasScreenProjectedStrokeFlush = flushingQueue.some((batch) => (
        batch?.screenStrokePaint === true
        || batch?.options?.screenStrokePaint === true
      ));
      const pointerTimeLiveDisplay = activeLiveStroke || (options.force !== true && hasLiveProjectedFlush);
      const deferReadbackPrecopy = options.deferReadbackPrecopy === true
        || (
          options.deferReadbackPrecopy !== false
          && options.deferReadbackCopy !== false
          && !pointerTimeLiveDisplay
        );
      const deferLiveDisplayMipmaps = options.deferLiveDisplayMipmaps !== false;
      const explicitLiveDisplayMipmapImmediatePixels = options.liveDisplayMipmapImmediatePixels
        ?? options.liveDisplayImmediateMipmapPixels;
      const activeLiveDisplayMipmapImmediatePixels = pointerTimeLiveDisplay
        && flushingQueue.some(largeLiveWebGpuBatch)
        ? TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_LARGE_MIPMAP_IMMEDIATE_PIXELS
        : TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_MIPMAP_IMMEDIATE_PIXELS;
      const liveDisplayMipmapImmediatePixels = Number.isFinite(Number(explicitLiveDisplayMipmapImmediatePixels))
        ? Math.max(0, Math.floor(Number(explicitLiveDisplayMipmapImmediatePixels)))
        : pointerTimeLiveDisplay
          ? activeLiveDisplayMipmapImmediatePixels
          : null;
      const canBatchLiveCommandEncoder = pointerTimeLiveDisplay
        && liveDisplayExternalTexture
        && !options.commandEncoder
        && flushingQueue.length > 1
        && !flushingQueue.some((candidate) => (
          candidate?.screenStrokePaint === true
          || candidate?.options?.screenStrokePaint === true
        ));
      const batchedLiveCommandEncoder = canBatchLiveCommandEncoder
        ? this.textureAirbrushWebGpuDevice?.()?.createCommandEncoder?.({
          label: `${options.label || "texture-airbrush-queued-live"}-batched-live-command-encoder`
        }) || null
        : null;
      const remainingDisplayRefreshKeyCounts = new Map();
      for (const queuedBatch of this.textureAirbrushQueuedWebGpuStrokes || []) {
        const key = webGpuLiveDisplayRefreshKey(queuedBatch);
        if (key) {
          remainingDisplayRefreshKeyCounts.set(key, (remainingDisplayRefreshKeyCounts.get(key) || 0) + 1);
        }
      }
      const displayRefreshMinMs = Number.isFinite(Number(options.liveDisplayRefreshMinMs))
        ? Math.max(0, Number(options.liveDisplayRefreshMinMs))
        : pointerTimeLiveDisplay
          ? TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISPLAY_MIN_REFRESH_MS
          : 0;
      this.textureAirbrushWebGpuLastDisplayRefreshMsByKey ||= new Map();
      for (let batchIndex = 0; batchIndex < flushingQueue.length; batchIndex += 1) {
        const batch = flushingQueue[batchIndex];
        estimate += Math.max(0, batch.estimate || 0);
        const displayRefreshKey = displayRefreshKeys[batchIndex] || "";
        const displayRefreshNow = liveStatusNow(this);
        const displayRefreshLastMs = displayRefreshKey
          ? Number(this.textureAirbrushWebGpuLastDisplayRefreshMsByKey.get(displayRefreshKey)) || 0
          : 0;
        const displayRefreshTooSoon = displayRefreshKey
          && displayRefreshMinMs > 0
          && displayRefreshLastMs > 0
          && displayRefreshNow - displayRefreshLastMs < displayRefreshMinMs
          && remainingDisplayRefreshKeyCounts.has(displayRefreshKey);
        const deferLiveDisplayRefresh = liveDisplayExternalTexture
          && displayRefreshKey
          && !pointerTimeLiveDisplay
          && (
            lastDisplayRefreshIndexByKey.get(displayRefreshKey) !== batchIndex
            || displayRefreshTooSoon
          );
        if (displayRefreshKey && !deferLiveDisplayRefresh) {
          this.textureAirbrushWebGpuLastDisplayRefreshMsByKey.set(displayRefreshKey, displayRefreshNow);
          while (this.textureAirbrushWebGpuLastDisplayRefreshMsByKey.size > 64) {
            this.textureAirbrushWebGpuLastDisplayRefreshMsByKey.delete(
              this.textureAirbrushWebGpuLastDisplayRefreshMsByKey.keys().next().value
            );
          }
        }
        const batchLiveDisplayMipmapImmediatePixels = liveDisplayMipmapImmediatePixels !== null
          ? liveDisplayMipmapImmediatePixels
          : null;
        const paintOptions = {
	          ...options,
	          deferApplyRefresh: true,
	          liveDisplayExternalTexture,
	          requireLiveDisplayTexture: liveDisplayExternalTexture && hasLiveProjectedFlush,
          ...(deferLiveDisplayRefresh ? { deferLiveDisplayRefresh: true } : {}),
          ...(pointerTimeLiveDisplay ? { liveDisplayIncludeDeferredDirtyRegions: false } : {}),
          ...(pointerTimeLiveDisplay ? { maxLiveDisplayWorkPixels: TEXTURE_AIRBRUSH_WEBGPU_ACTIVE_LIVE_DISPLAY_MAX_PIXELS } : {}),
          deferLiveDisplayMipmaps,
          liveDisplayMipmapDelayMs: Number.isFinite(Number(options.liveDisplayMipmapDelayMs))
            ? Math.max(0, Math.floor(Number(options.liveDisplayMipmapDelayMs)))
            : 0,
          ...(batchLiveDisplayMipmapImmediatePixels !== null
            ? { liveDisplayMipmapImmediatePixels: batchLiveDisplayMipmapImmediatePixels }
            : {}),
          deferReadbackApply: true,
          deferReadbackStart,
          deferReadbackCopy: debugImmediateWebGpuReadbackRequested()
            ? false
            : options.deferReadbackCopy !== false,
          deferReadbackPrecopy,
          ...(batchedLiveCommandEncoder ? { commandEncoder: batchedLiveCommandEncoder, submit: false } : {}),
        };
        try {
          paintPromises.push(Promise.resolve(
            this.textureAirbrushStartWebGpuPaintCandidate?.(batch, paintOptions)
          ));
        } catch (error) {
          paintPromises.push(Promise.reject(error));
        }
      }
      if (batchedLiveCommandEncoder) {
        try {
          const commandBuffer = batchedLiveCommandEncoder.finish();
          if (commandBuffer) {
            this.textureAirbrushWebGpuDevice?.()?.queue?.submit?.([commandBuffer]);
          }
        } catch (error) {
          debugLiveWebGpuAirbrush("flush-batched-command-submit-failed", {
            message: error?.message || String(error)
          });
          throw error;
        }
      }
      setThrottledWebGpuLiveStatus(this, `WebGPU airbrush flushing ${estimate} texture pixels`);
      let flushedWorkPixels = 0;
      let visiblePaintResultCount = 0;
      let intentionalNoopResultCount = 0;
      const flushPromise = Promise.allSettled(paintPromises).then((results) => {
        const paintedEstimate = results.reduce((total, result, index) => {
          if (
            result.status !== "fulfilled"
            || !textureAirbrushWebGpuPaintResultHasVisibleEffect(result.value)
          ) {
            if (
              result.status === "fulfilled"
              && textureAirbrushWebGpuPaintResultIsIntentionalNoop(result.value)
            ) {
              intentionalNoopResultCount += 1;
            }
            return total;
          }
          visiblePaintResultCount += 1;
          flushedWorkPixels += textureAirbrushWebGpuPaintResultWorkPixels(
            result.value,
            flushingQueue[index]?.estimate || 0
          );
          return total + Math.max(0, flushingQueue[index]?.estimate || 0);
        }, 0);
        if (
          estimate > 0
          && visiblePaintResultCount <= 0
          && intentionalNoopResultCount < results.length
        ) {
          this.textureAirbrushReportWebGpuFallback?.({
            backend: "webgpu",
            webGpuStatus: "dispatch-failed"
          });
        }
        return paintedEstimate;
      }).finally(() => {
        if (this.textureAirbrushWebGpuFlushInFlight === flushPromise) {
          this.textureAirbrushWebGpuFlushInFlight = null;
        }
        debugLiveWebGpuAirbrush("flush-finished", {
          estimate: flushedWorkPixels,
          candidateEstimate: estimate,
          visiblePaintResultCount,
          intentionalNoopResultCount,
          remaining: (this.textureAirbrushQueuedWebGpuStrokes || []).length
        });
        this.textureAirbrushExposeRenderedSnapshot?.({
          label: "flush-finished",
          estimate: flushedWorkPixels,
          candidateEstimate: estimate
        })?.catch?.(() => {});
        if (
          options.force !== true
          && options.autoSchedule !== false
          && (this.textureAirbrushQueuedWebGpuStrokes || []).length
        ) {
          this.scheduleTextureAirbrushQueuedWebGpuFlush?.();
        }
      });
      this.textureAirbrushWebGpuFlushInFlight = flushPromise;
      return flushPromise;
    },

    textureAirbrushStartWebGpuPaintCandidate(candidate = null, options = {}) {
      if (!candidate?.editable || !candidate.material) {
        return Promise.resolve(null);
      }
      const debugStartCandidateTimings = typeof window !== "undefined"
        && new URLSearchParams(window.location?.search || "").has("debugAirbrush");
      const startCandidateTiming = debugStartCandidateTimings ? {
        labels: [],
        totalMs: 0,
        route: "",
        strokeSegments: Array.isArray(candidate.strokeSegments) ? candidate.strokeSegments.length : 0,
        screenProjectedStrokeSegments: Array.isArray(candidate.options?.screenProjectedStrokeSegments)
          ? candidate.options.screenProjectedStrokeSegments.length
          : 0,
        paintRegions: Array.isArray(candidate.paintRegions) ? candidate.paintRegions.length : 0
      } : null;
      const startCandidateStartedAt = debugStartCandidateTimings
        ? (typeof performance !== "undefined" ? performance.now() : Date.now())
        : 0;
      let startCandidateLastMark = startCandidateStartedAt;
      const markStartCandidateTiming = (label = "") => {
        if (!startCandidateTiming || !label) {
          return;
        }
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        startCandidateTiming.labels.push({
          label,
          elapsedMs: Math.max(0, now - startCandidateLastMark),
          totalMs: Math.max(0, now - startCandidateStartedAt)
        });
        startCandidateLastMark = now;
      };
      const publishStartCandidateTiming = () => {
        if (!startCandidateTiming) {
          return;
        }
        const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        startCandidateTiming.totalMs = Math.max(0, endedAt - startCandidateStartedAt);
        this.textureAirbrushDebugStartCandidateTimings ||= [];
        this.textureAirbrushDebugStartCandidateTimings.push(startCandidateTiming);
        this.textureAirbrushDebugStartCandidateTimings = this.textureAirbrushDebugStartCandidateTimings.slice(-64);
        this.textureAirbrushDebugSlowStartCandidateTimings ||= [];
        this.textureAirbrushDebugSlowStartCandidateTimings.push(startCandidateTiming);
        this.textureAirbrushDebugSlowStartCandidateTimings = this.textureAirbrushDebugSlowStartCandidateTimings
          .sort((left, right) => (right?.totalMs || 0) - (left?.totalMs || 0))
          .slice(0, 16);
        const dataset = typeof window !== "undefined" ? window.document?.documentElement?.dataset || null : null;
        if (dataset) {
          dataset.textureAirbrushDebugStartCandidateTimings = JSON.stringify(
            this.textureAirbrushDebugStartCandidateTimings.slice(-24)
          );
          dataset.textureAirbrushDebugSlowStartCandidateTimings = JSON.stringify(
            this.textureAirbrushDebugSlowStartCandidateTimings
          );
        }
      };
      const strokeUndo = candidate.strokeUndo || webGpuActiveStrokeUndo(this) || null;
      const undoKey = webGpuCandidateUndoKey(candidate);
      const strokeSourceOwner = webGpuCandidateStrokeSourceOwner(this, candidate, strokeUndo, undoKey)
        || activeStrokeWebGpuSourceOwner(this, undoKey);
      const device = options.device || this.textureAirbrushWebGpuDevice?.();
      const cache = textureAirbrushWebGpuCacheForEditable(this, candidate.editable, device, options);
      const candidateStartsNewStroke = Boolean(
        candidate.strokeReset === true
        || candidate.strokeStartedWithReset === true
        || candidate.options?.strokeReset === true
        || candidate.options?.strokeStartedWithReset === true
      );
      const candidateResetsStrokeSource = Boolean(
        candidate.strokeReset === true
        || candidate.options?.strokeReset === true
      );
      const strokeSourceOwnerChanged = Boolean(
        strokeSourceOwner
        && cache?.gpuStrokeSourceOwner !== strokeSourceOwner
      );
      const preferCurrentGpuStrokeSource = Boolean(
        cache?.initialized
        && cache.gpuSourceMatchesEditable === true
        && (
          cache.deferredReadbackApplyPending === true
          || candidateStartsNewStroke
          || strokeSourceOwnerChanged
        )
      );
      const currentGpuStrokeSourceReady = preferCurrentGpuStrokeSource
        && textureAirbrushEditableWebGpuStrokeSourceCurrent(this, candidate.editable, {
          ...options,
          cache,
          device
        });
      markStartCandidateTiming("source-cache");
      const candidateSegments = Array.isArray(candidate.strokeSegments) && candidate.strokeSegments.length
        ? candidate.strokeSegments
        : null;
      const optionSegments = Array.isArray(candidate.options?.strokeSegments) && candidate.options.strokeSegments.length
        ? candidate.options.strokeSegments
        : null;
      const centerSegment = finitePoint(candidate.center) || finitePoint(candidate.start);
      const strokeSegments = candidateSegments
        || optionSegments
        || (centerSegment ? [{ start: centerSegment, end: centerSegment }] : null);
      const projectedLivePaint = Boolean(
        candidate.options?.liveProjectedPaint === true
        || options.liveProjectedPaint === true
        || options.screenStrokePaint === true
      );
      const fullProjectedSurfacePaint = projectedLivePaint
        && (
          candidate.fullProjectedSurfacePaint === true
          || candidate.options?.fullProjectedSurfaceRenderTriangles === true
        );
      let paintBounds = candidate.paintBounds || candidatePaintBounds({
        ...candidate,
        ...(strokeSegments ? { strokeSegments } : {})
      });
      let paintRegions = candidatePaintRegions({
        ...candidate,
        ...(strokeSegments ? { strokeSegments } : {}),
        ...(paintBounds ? { paintBounds } : {})
      });
      if (projectedLivePaint) {
        paintRegions = splitLargeProjectedPaintRegions(
          paintRegions,
          candidate.editable?.canvas || null,
          {
            ...candidate.options,
            ...options
          }
        );
        paintBounds = unionPaintRegionList(paintRegions) || paintBounds;
      }
      markStartCandidateTiming("paint-scope");
      const undoScreenProjectedSegments = Array.isArray(candidate.options?.screenProjectedStrokeSegments)
        ? candidate.options.screenProjectedStrokeSegments
        : [];
      const useTslSurfaceUndoScope = projectedLivePaint === true
        && candidate.options?.useTslSurfaceAirbrush !== false
        && undoScreenProjectedSegments.length > 0
        && texturePaintCanUseTslSurfaceAirbrush(this, candidate, {
          ...candidate.options,
          ...options,
          ...(strokeSegments ? { strokeSegments } : {}),
          screenProjectedStrokeSegments: undoScreenProjectedSegments,
          paintBounds: null,
          paintRegions: []
        });
      const undoStrokeScopeCandidate = candidateWithoutExplicitPaintScope({
        ...candidate,
        ...(strokeSegments ? { strokeSegments } : {}),
        options: {
          ...candidate.options,
          ...(strokeSegments ? { strokeSegments } : {})
        }
      });
      const undoStrokeBounds = candidatePaintBounds(undoStrokeScopeCandidate);
      const undoPaintBounds = useTslSurfaceUndoScope
        ? undoStrokeBounds
        : unionPaintBounds(paintBounds, undoStrokeBounds);
      const undoStrokeRegions = candidatePaintRegions(undoStrokeScopeCandidate);
      const undoPaintRegions = useTslSurfaceUndoScope
        ? (
            undoStrokeRegions.length
              ? undoStrokeRegions
              : [undoStrokeBounds].filter(Boolean)
          )
        : mergePaintRegionLists(
            paintRegions,
            undoStrokeRegions,
            candidate.editable?.canvas || null
          );
      markStartCandidateTiming("undo-scope");
      if (candidate.undoCaptured !== true) {
        const tslSurfaceUndoTarget = useTslSurfaceUndoScope
          ? (
              candidate.material?.userData?.texturePaintTslSurfaceAirbrushTarget
              || candidate.editable?.layer?.gpuTarget
              || null
            )
          : null;
        const capturedGpuUndo = tslSurfaceUndoTarget?.target?.texture
          ? withWebGpuStrokeUndoContext(this, strokeUndo, () => this.captureTexturePaintGpuUndoTarget?.(
              candidate.record,
              candidate.material,
              tslSurfaceUndoTarget,
              candidate.materialIndex
            )) === true
          : false;
        if (!capturedGpuUndo) {
          const undoLayer = candidate.editable?.layer || null;
          const undoLayerTarget = undoLayer?.gpuTarget || null;
          const undoLayerHasKnownPaint = Boolean(
            undoLayer?.texturePaintCpuPainted === true
            || undoLayer?.texturePaintGpuPainted === true
            || undoLayerTarget?.texturePaintLayerHasPaint === true
            || undoLayerTarget?.emptyTransparent === false
            || (undoLayer?.isEmpty === false && undoLayer?.texturePaintHasPaint === true)
          );
          const undoBeforeIsTransparent = Boolean(
            candidate.editable?.layerMode === true
            && undoLayer
            && undoLayerHasKnownPaint !== true
          );
          const beforeImageData = undoBeforeIsTransparent
            ? null
            : textureAirbrushCachedWebGpuStrokeSourceImage(this, candidate.editable, {
                ...options,
                bounds: undoPaintBounds || paintBounds,
                boundsRegions: undoPaintRegions.length ? undoPaintRegions : paintRegions,
                ensureSourceImageData: useTslSurfaceUndoScope !== true
              });
          withWebGpuStrokeUndoContext(this, strokeUndo, () => this.captureTexturePaintCanvasUndoTarget?.(
            candidate.record,
            candidate.material,
            candidate.editable,
            candidate.materialIndex,
            {
              ...(beforeImageData ? { beforeImageData } : {}),
              ...(undoBeforeIsTransparent ? { emptyBefore: true } : {}),
              bounds: undoPaintBounds || paintBounds,
              boundsRegions: undoPaintRegions.length ? undoPaintRegions : paintRegions
            }
          ));
        }
        candidate.undoCaptured = true;
      }
      markStartCandidateTiming("undo-capture");
      const strokeSourceCandidate = preferCurrentGpuStrokeSource
        ? null
        : withWebGpuStrokeUndoContext(this, strokeUndo, () => this.texturePaintCanvasStrokeSourceImage?.(
            candidate.record,
            candidate.material,
            candidate.editable,
            candidate.materialIndex
          )) || null;
      const strokeSourceImageData = !preferCurrentGpuStrokeSource && imageDataMatchesEditableSize(strokeSourceCandidate, candidate.editable)
        ? strokeSourceCandidate
        : null;
      markStartCandidateTiming("stroke-source");
      const displaySourcePaintRegions = candidateDisplayPaintRegions({
        ...candidate,
        ...(strokeSegments ? { strokeSegments } : {}),
        ...(paintBounds ? { paintBounds } : {})
      });
      const displayPaintRegions = coalesceDisplayPaintRegions(
        displaySourcePaintRegions,
        candidate.editable?.canvas || null,
        {
          padding: projectedLiveDisplayRegionPadding(candidate, options),
          preserveDisjoint: projectedLivePaint === true,
          ...(projectedLivePaint === true
            ? { maxRegions: TEXTURE_AIRBRUSH_WEBGPU_PROJECTED_LIVE_DISPLAY_MAX_DIRTY_REGIONS }
            : {})
        }
      );
      markStartCandidateTiming("display-regions");
      const projectedCompositePaintRegions = projectedLivePaint === true
        && displayPaintRegions.length > 1
        ? displayPaintRegions
          .map((region) => normalizePaintBounds(region, candidate.editable?.canvas || null))
          .filter(Boolean)
        : [];
      const fullProjectedScreenSegments = Array.isArray(candidate.options?.screenProjectedStrokeSegments)
        ? candidate.options.screenProjectedStrokeSegments
        : [];
      const keepFullProjectedStrokePath = projectedLivePaint
        && fullProjectedScreenSegments.length > 0
        && (
          candidate.options?.fullProjectedTrianglePaintRegions === true
          || candidate.options?.largeLiveBrushPaint === true
          || candidate.options?.largeLiveNeighborPaint === true
        );
      const descriptorScreenProjectedSegments = keepFullProjectedStrokePath
        ? fullProjectedScreenSegments
        : screenProjectedSegmentsForTextureSegments(candidate, strokeSegments || []);
      const hasScopedProjectedPrimaryTriangles = projectedLivePaint
        && Array.isArray(candidate.options?.visibilityMaskTriangles)
        && candidate.options.visibilityMaskTriangles.length > 0
        && descriptorScreenProjectedSegments.length > 0;
      const preferTslSurfaceAirbrushDescriptor = projectedLivePaint === true
        && options.useTslSurfaceAirbrush !== false
        && (fullProjectedSurfacePaint === true || hasScopedProjectedPrimaryTriangles)
        && texturePaintCanUseTslSurfaceAirbrush(this, candidate, {
          ...candidate.options,
          ...options,
          ...(strokeSegments ? { strokeSegments } : {}),
          screenProjectedStrokeSegments: descriptorScreenProjectedSegments,
          ...(fullProjectedSurfacePaint === true ? { fullProjectedSurfaceRenderTriangles: true } : {}),
          paintBounds: null,
          paintRegions: []
        });
      const hasExplicitCandidatePaintRegions = Array.isArray(candidate.paintRegions)
        && candidate.paintRegions.length > 1;
      const paintRegionUnion = unionPaintRegionList(paintRegions);
      const paintRegionArea = paintRegionListArea(paintRegions);
      const paintRegionUnionArea = paintBoundsArea(paintRegionUnion);
      const paintRegionUnionWasteful = paintRegions.length > 1
        && paintRegionArea > 0
        && paintRegionUnionArea > paintRegionArea * 1.25
        && paintRegionUnionArea - paintRegionArea > 128 * 1024;
      const projectedTriangleRegionsArePaired = projectedLivePaint
        && paintRegions.length > 1
        && paintRegions.length <= TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS
        && paintRegions.every((region) => region?.visibilityTriangle);
      const forceCompactScreenStrokeRegions = !preferTslSurfaceAirbrushDescriptor
        && projectedLivePaint
        && paintRegions.length > 1
        && (!paintRegionUnionWasteful || projectedTriangleRegionsArePaired)
        && (
          options.screenStrokePaint === true
          || candidate.options?.screenStrokePaint === true
          || projectedTriangleRegionsArePaired
        )
        && options.liveDisplayExternalTexture !== false;
      const compactDisjointPaintRegions = !preferTslSurfaceAirbrushDescriptor
        && (forceCompactScreenStrokeRegions
        || (
          projectedLivePaint
          && paintRegions.length > 1
          && hasExplicitCandidatePaintRegions
          && options.allowCompactDisjointPaintRegions !== false
          && (
            !paintRegionUnionWasteful
            && (
              options.deferReadbackCopy !== false
              && options.liveDisplayExternalTexture === true
            )
          )
        ));
	      const splitDisjointPaintRegions = !preferTslSurfaceAirbrushDescriptor
	        && paintRegions.length > 1
	        && !compactDisjointPaintRegions
	        && options.allowDisjointPaintBounds !== true
	        && candidate.options?.allowDisjointPaintBounds !== true;
	      const refreshEachDisjointPaintRegion = splitDisjointPaintRegions
	        && (
	          projectedLivePaint === true
	          || options.refreshEachDisjointPaintRegion === true
	          || candidate.options?.refreshEachDisjointPaintRegion === true
	        );
	      const projectedTriangleScopeActive = splitDisjointPaintRegions
	        && projectedLivePaint
	        && keepFullProjectedStrokePath !== true
	        && Array.isArray(candidate.options?.visibilityMaskTriangles)
	        && candidate.options.visibilityMaskTriangles.length > 0;
      markStartCandidateTiming("route-selection");
      const descriptorForPaintRegion = (region = null, index = 0) => {
        const descriptorStrokeSegments = keepFullProjectedStrokePath
          ? strokeSegments
          : strokeSegmentsForPaintBounds(candidate, strokeSegments, region);
        const descriptorScreenSegments = keepFullProjectedStrokePath
          ? fullProjectedScreenSegments
          : screenProjectedSegmentsForTextureSegments(candidate, descriptorStrokeSegments);
        const descriptorVisibilitySamples = descriptorStrokeSegments.map((segment) => ({ segment }));
        const descriptor = refreshEachDisjointPaintRegion ? {
          paintBounds: region,
          strokeSegments: descriptorStrokeSegments,
          screenProjectedStrokeSegments: descriptorScreenSegments,
          visibilityMaskSamples: descriptorVisibilitySamples,
          displayDirtyRegions: [region],
          refreshLiveDisplay: true
        } : {
          paintBounds: region,
          strokeSegments: descriptorStrokeSegments,
          screenProjectedStrokeSegments: descriptorScreenSegments,
          visibilityMaskSamples: descriptorVisibilitySamples,
          displayDirtyRegions: index === paintRegions.length - 1 ? displayPaintRegions : [],
          refreshLiveDisplay: index === paintRegions.length - 1
        };
        if (!projectedTriangleScopeActive) {
          return descriptor;
        }
        const scopedTriangles = visibilityTrianglesForPaintBounds(
          candidate.options.visibilityMaskTriangles,
          region,
          candidate.editable?.canvas || null,
          2
        );
        return {
          ...descriptor,
          visibilityMaskTriangles: scopedTriangles,
          skipPaint: scopedTriangles.length <= 0
        };
      };
      const paintRunDescriptors = (preferTslSurfaceAirbrushDescriptor
        ? [{
            strokeSegments,
            screenProjectedStrokeSegments: descriptorScreenProjectedSegments,
            visibilityMaskSamples: (strokeSegments || []).map((segment) => ({ segment })),
            displayDirtyRegions: [],
            refreshLiveDisplay: true,
            useTslSurfaceDescriptor: true
          }]
        : (splitDisjointPaintRegions
        ? paintRegions.map(descriptorForPaintRegion).filter((descriptor) => descriptor.skipPaint !== true)
        : [{
	          paintBounds,
	          ...(projectedCompositePaintRegions.length > 1
              ? {
                  paintRegions: projectedCompositePaintRegions,
                  compactPaintRegions: true,
                  skipProjectedRegionCompletion: true
                }
              : (compactDisjointPaintRegions ? {
                  paintRegions,
                  compactPaintRegions: true,
                  ...(fullProjectedSurfacePaint ? { skipProjectedRegionCompletion: true } : {})
                } : {})),
	          strokeSegments,
	          screenProjectedStrokeSegments: descriptorScreenProjectedSegments,
	          visibilityMaskSamples: (strokeSegments || []).map((segment) => ({ segment })),
            displayDirtyRegions: displayPaintRegions,
            refreshLiveDisplay: true
          }]));
      if (!paintRunDescriptors.length) {
        publishStartCandidateTiming();
        return Promise.resolve(null);
      }
      markStartCandidateTiming("descriptors");
      const runPaintDescriptor = (descriptor = {}, runOptions = {}) => {
        const activeLiveDisplayRefresh = descriptor.refreshLiveDisplay !== false
          && (
            candidate.options?.liveProjectedPaint === true
            || options.liveProjectedPaint === true
            || options.screenStrokePaint === true
          );
        const descriptorStrokeSegments = Array.isArray(descriptor.strokeSegments) && descriptor.strokeSegments.length
          ? descriptor.strokeSegments
          : strokeSegments;
        const descriptorScreenSegments = Array.isArray(descriptor.screenProjectedStrokeSegments) && descriptor.screenProjectedStrokeSegments.length
          ? descriptor.screenProjectedStrokeSegments
          : screenProjectedSegmentsForTextureSegments(candidate, descriptorStrokeSegments || []);
        const descriptorVisibilitySamples = Array.isArray(descriptor.visibilityMaskSamples) && descriptor.visibilityMaskSamples.length
          ? descriptor.visibilityMaskSamples
          : (descriptorStrokeSegments || []).map((segment) => ({ segment }));
        const rawDescriptorPaintRegions = Array.isArray(descriptor.paintRegions) && descriptor.paintRegions.length
          ? descriptor.paintRegions
          : [];
        const rawDescriptorVisibilityTriangles = Array.isArray(descriptor.visibilityMaskTriangles)
          ? descriptor.visibilityMaskTriangles
          : Array.isArray(candidate.options?.visibilityMaskTriangles)
            ? candidate.options.visibilityMaskTriangles
            : [];
        const projectedRegionPadding = Math.max(
          32,
          Math.min(
            64,
            Math.ceil((Number(candidate.options?.visibilityBleedRadius) || 0) + 16)
          )
        );
        const completeProjectedRegionScope = projectedLivePaint
          && descriptorScreenSegments?.length
          && rawDescriptorVisibilityTriangles.length
          && rawDescriptorPaintRegions.length > 0
          && descriptor.skipProjectedRegionCompletion !== true;
        const descriptorPaintRegions = completeProjectedRegionScope
          ? completeProjectedPaintRegionsForTriangles(
              rawDescriptorPaintRegions,
              rawDescriptorVisibilityTriangles,
              candidate.editable?.canvas || null,
              projectedRegionPadding
            )
          : rawDescriptorPaintRegions;
        const compactPaintRegionTriangles = descriptor.compactPaintRegions === true
          && descriptorPaintRegions.length > 0
          && descriptorPaintRegions.every((region) => region?.visibilityTriangle);
        const descriptorVisibilityTriangles = compactPaintRegionTriangles
          ? descriptorPaintRegions.map((region) => region.visibilityTriangle)
          : rawDescriptorVisibilityTriangles.length
            ? rawDescriptorVisibilityTriangles
            : null;
        const descriptorPriorityPoints = strokeSegmentPriorityPoints(descriptorStrokeSegments || []);
        const paintOptions = {
          ...candidate.options,
          ...options,
          ...(descriptor.refreshLiveDisplay === false ? { liveDisplayExternalTexture: false } : {}),
          ...(activeLiveDisplayRefresh ? { deferLiveDisplayRefresh: false } : {}),
          ...(descriptorStrokeSegments ? { strokeSegments: descriptorStrokeSegments } : {}),
          ...(descriptorScreenSegments?.length ? { screenProjectedStrokeSegments: descriptorScreenSegments } : {}),
          ...(descriptorVisibilitySamples.length ? { visibilityMaskSamples: descriptorVisibilitySamples } : {}),
          ...(descriptor.paintBounds ? { paintBounds: descriptor.paintBounds } : {}),
          ...(descriptorPaintRegions.length
            ? { paintRegions: descriptorPaintRegions }
            : {}),
          ...(descriptor.compactPaintRegions === true || completeProjectedRegionScope ? { compactPaintRegions: true } : {}),
          ...(compactPaintRegionTriangles ? { compactPaintRegionTriangles: true } : {}),
          ...(Array.isArray(descriptorVisibilityTriangles)
            ? { visibilityMaskTriangles: descriptorVisibilityTriangles }
            : {}),
          ...(descriptor.displayDirtyRegions?.length ? { displayDirtyRegions: descriptor.displayDirtyRegions } : {}),
          ...(descriptor.displayDirtyRegions?.length ? { deferredCanvasSyncRegions: descriptor.displayDirtyRegions } : {}),
          ...(descriptor.paintBounds ? { deferredCanvasSyncPriorityBounds: descriptor.paintBounds } : {}),
          ...(descriptorPriorityPoints.length ? { deferredCanvasSyncPriorityPoints: descriptorPriorityPoints } : {}),
          ...(descriptor.displayDirtyRegions?.length > 1 ? { forceLiveDisplayDirtyRegions: true } : {}),
          ...(descriptor.useTslSurfaceDescriptor === true
            ? {
                paintBounds: null,
                paintRegions: [],
                displayDirtyRegions: [],
                deferredCanvasSyncRegions: []
              }
            : {}),
          material: candidate.material,
          externalSourceUpload: options.externalSourceUpload !== false,
          ...(preferCurrentGpuStrokeSource && candidateResetsStrokeSource && !currentGpuStrokeSourceReady ? { refreshStrokeSource: true } : {}),
          ...(strokeSourceOwner ? { strokeSourceOwner } : {}),
          ...(strokeSourceImageData ? { strokeSourceImageData } : {}),
          ...runOptions
        };
        const visibleEdgeMode = paintOptions.visibleEdgeMode || candidate.options?.visibleEdgeMode || "soft";
        const hasFullProjectedSurfaceData = fullProjectedSurfacePaint === true
          || candidate.fullProjectedSurfacePaint === true
          || candidate.options?.fullProjectedSurfaceRenderTriangles === true
          || paintOptions.fullProjectedSurfaceRenderTriangles === true;
        const canUseTslSurfaceAirbrush = texturePaintCanUseTslSurfaceAirbrush(this, candidate, paintOptions);
        const useTslSurfaceAirbrush = projectedLivePaint === true
          && paintOptions.useTslSurfaceAirbrush !== false
          && canUseTslSurfaceAirbrush;
        markStartCandidateTiming("descriptor-route");
        const debugRoot = typeof window !== "undefined" ? window.document?.documentElement || null : null;
        const debugTslSurfaceRoute = {
          projectedLivePaint,
          visibleEdgeMode,
          hasFullProjectedSurfaceData,
          canUseTslSurfaceAirbrush,
          useTslSurfaceAirbrush,
          strokeSegments: Array.isArray(paintOptions.strokeSegments) ? paintOptions.strokeSegments.length : 0,
          strokeReset: paintOptions.strokeReset === true,
          strokeStartedWithReset: paintOptions.strokeStartedWithReset === true,
          hasStrokeSourceOwner: Boolean(strokeSourceOwner),
          hasStrokeUndo: Boolean(strokeUndo),
          paintRegions: Array.isArray(paintOptions.paintRegions) ? paintOptions.paintRegions.length : 0,
          hasPaintBounds: Boolean(paintOptions.paintBounds),
          projectedRenderTriangles: Array.isArray(paintOptions.projectedRenderTriangles)
            ? paintOptions.projectedRenderTriangles.length
            : Array.isArray(candidate.options?.projectedRenderTriangles)
              ? candidate.options.projectedRenderTriangles.length
              : 0,
          screenProjectedStrokeSegments: Array.isArray(paintOptions.screenProjectedStrokeSegments)
            ? paintOptions.screenProjectedStrokeSegments.length
            : Array.isArray(candidate.options?.screenProjectedStrokeSegments)
              ? candidate.options.screenProjectedStrokeSegments.length
              : 0
        };
        const writeDebugTslSurfaceRoute = (result = "pending", error = null) => {
          if (!debugRoot?.dataset || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
            return;
          }
          const errorText = error
            ? String(error?.stack || error?.message || error || "unknown TSL surface airbrush error").slice(0, 2000)
            : "";
          const entry = {
            ...debugTslSurfaceRoute,
            result,
            ...(errorText ? { error: errorText } : {})
          };
          debugRoot.dataset.textureAirbrushDebugTslSurfaceRoute = JSON.stringify(entry);
          let history = [];
          try {
            history = JSON.parse(debugRoot.dataset.textureAirbrushDebugTslSurfaceRouteHistory || "[]");
          } catch {
            history = [];
          }
          if (!Array.isArray(history)) {
            history = [];
          }
          history.push(entry);
          debugRoot.dataset.textureAirbrushDebugTslSurfaceRouteHistory = JSON.stringify(history.slice(-24));
          if (errorText) {
            debugRoot.dataset.textureAirbrushDebugTslSurfaceError = errorText;
            debugRoot.dataset.textureAirbrushDebugTslSurfaceLastError = errorText;
          }
        };
        writeDebugTslSurfaceRoute("pending");
        if (useTslSurfaceAirbrush) {
          try {
            startCandidateTiming && (startCandidateTiming.route = "tsl-surface");
            const tslResult = texturePaintRunTslSurfaceAirbrush(this, candidate, paintOptions);
            markStartCandidateTiming("tsl-run");
            if (tslResult) {
              writeDebugTslSurfaceRoute("used");
              return tslResult;
            }
            writeDebugTslSurfaceRoute("null");
          } catch (error) {
            markStartCandidateTiming("tsl-error");
            writeDebugTslSurfaceRoute("error", error);
          }
        }
        writeDebugTslSurfaceRoute("legacy");
        startCandidateTiming && (startCandidateTiming.route = "legacy-webgpu");
        return this.textureAirbrushRunEditableWebGpuPaint(candidate.editable, paintOptions);
      };
      const runSplitPaintDescriptors = () => {
        const deferRemainingScreenSplitDescriptors = options.immediateWebGpuFlush === true
          && paintRunDescriptors.length > 1
          && !useTslSurfaceAirbrush;
        if (deferRemainingScreenSplitDescriptors) {
          const firstRun = Promise.resolve(runPaintDescriptor(paintRunDescriptors[0]));
          const scheduleDeferredRuns = () => {
            const runRemaining = () => Promise.allSettled(
              paintRunDescriptors.slice(1).map((descriptor) => {
                try {
                  return Promise.resolve(runPaintDescriptor(descriptor, {
                    deferLiveDisplayRefresh: true
                  }));
                } catch (error) {
                  return Promise.reject(error);
                }
              })
            );
            const host = typeof window !== "undefined" ? window : globalThis;
            const deferred = new Promise((resolve) => {
              if (typeof host?.requestAnimationFrame === "function") {
                host.requestAnimationFrame(() => resolve());
              } else if (typeof host?.setTimeout === "function") {
                host.setTimeout(resolve, 0);
              } else {
                resolve();
              }
            }).then(runRemaining);
            this.textureAirbrushTrackWebGpuPaint?.(deferred);
          };
          firstRun.then(scheduleDeferredRuns, scheduleDeferredRuns);
          return firstRun;
        }
        // A shared encoder is safe only when each split run owns immutable
        // brush/visibility buffers; otherwise queue.writeBuffer would make
        // earlier encoded dispatches read the final region's uniforms.
        const canUseSharedCommandEncoder = options.allowSharedSplitCommandEncoder === true
          && paintRunDescriptors.length > 1
          && options.commandEncoder == null
          && options.coalesceSplitPaintRuns !== false
          && options.deferReadbackCopy !== false
          && options.liveDisplayExternalTexture !== false
          && (
            candidate.options?.liveProjectedPaint === true
            || options.liveProjectedPaint === true
            || options.screenStrokePaint === true
          );
        const sharedDevice = canUseSharedCommandEncoder
          ? options.device || this.textureAirbrushWebGpuDevice?.()
          : null;
        const sharedCommandEncoder = sharedDevice?.createCommandEncoder?.({
          label: `${options.label || "texture-airbrush-split"}-split-live-command-encoder`
        }) || null;
        const sharedRunOptions = sharedCommandEncoder
          ? {
              commandEncoder: sharedCommandEncoder,
              submit: false,
              dedicatedBrushBuffers: true
            }
          : {};
        const runs = paintRunDescriptors.map((descriptor) => {
          try {
            return Promise.resolve(runPaintDescriptor(descriptor, sharedRunOptions));
          } catch (error) {
            return Promise.reject(error);
          }
        });
        if (sharedCommandEncoder) {
          try {
            const commandBuffer = sharedCommandEncoder.finish?.();
            if (commandBuffer) {
              sharedDevice.queue?.submit?.([commandBuffer]);
            }
          } catch (error) {
            return Promise.reject(error);
          }
        }
        return Promise.all(runs).then((results) => aggregatePaintRunResult(results));
      };
      const run = paintRunDescriptors.length === 1
        ? runPaintDescriptor(paintRunDescriptors[0])
        : runSplitPaintDescriptors();
      markStartCandidateTiming("run-created");
      const tracked = Promise.resolve(run).then((result) => {
        const resultStats = result?.stats || null;
        const resultEstimate = textureAirbrushWebGpuPaintResultWorkPixels(result, candidate.estimate || 0);
        debugLiveWebGpuAirbrush("candidate-result", {
          applied: Boolean(result?.applied),
          appliedDeferred: result?.applied?.deferred === true,
          estimate: resultEstimate,
          splitPaintRuns: result?.splitPaintRuns || 1,
          liveDisplayExternalTexture: resultStats?.liveDisplayExternalTexture === true,
          liveDisplayWorkPixels: resultStats?.liveDisplayWorkPixels ?? null,
          liveDisplayMipmapPixels: resultStats?.liveDisplayMipmapPixels ?? null,
          liveDisplayMipmapDeferred: resultStats?.liveDisplayMipmapDeferred === true,
          liveDisplayMipmapDowngradeBlocked: resultStats?.liveDisplayMipmapDowngradeBlocked === true,
          deferredReadbackCopy: resultStats?.deferredReadbackCopy === true,
          visibilityTriangleCount: resultStats?.visibilityTriangleCount ?? null,
          timings: resultStats?.timings || null,
          candidate: compactCandidateDebug(candidate)
        });
        if (result?.applied) {
          if (result?.readbackPromise) {
            this.textureAirbrushTrackWebGpuPaint?.(result.readbackPromise);
          }
          withWebGpuStrokeUndoContext(this, strokeUndo, () => this.markTexturePaintStrokeChanged?.());
          if (options.deferApplyRefresh === true) {
            this.textureAirbrushQueueWebGpuApplyRefresh?.(candidate);
          } else {
            this.refreshCloneSpotlightTextures?.(candidate.record);
            this.updateClonePaintPreviews?.();
          }
          setThrottledWebGpuLiveStatus(this, `WebGPU airbrushed ${resultStats ? resultEstimate : candidate.estimate} texture pixels`);
        }
        return result;
      }).catch((error) => {
        this.textureAirbrushLastWebGpuPaintError = error;
        console.warn("Texture airbrush WebGPU editable paint failed; paint was not applied", error);
        return null;
      });
      this.textureAirbrushTrackWebGpuPaint?.(tracked);
      markStartCandidateTiming("tracked");
      publishStartCandidateTiming();
      return tracked;
    },

    textureAirbrushWebGpuPaintCandidate(candidate = null, options = {}) {
      if (!candidate?.editable || !candidate.material) {
        return 0;
      }
      this.textureAirbrushStartWebGpuPaintCandidate?.(candidate, {
        deferApplyRefresh: false,
        liveDisplayExternalTexture: false,
        ...options
      });
      setThrottledWebGpuLiveStatus(this, `WebGPU airbrush started ${candidate.estimate} texture pixels`);
      return candidate.estimate;
    },

    textureAirbrushWebGpuPaintFromEvent(event = null, options = {}) {
      if (!event || !this.model || !this.texturePaintHitForEvent) {
        return 0;
      }
      const liveVisibleGpuPaint = options.deferredWebGpuReadback !== true
        && (
          options.liveProjectedPaint === true
          || options.requireVisibilityMask === true
          || options.visibleSurfaceMaskRequired === true
        );
      const immediateScreenStrokePaint = options.screenStrokePaint === true
        && options.immediateWebGpuFlush === true;
      const liveHitSampleCache = liveVisibleGpuPaint
        ? liveHitSampleCacheForEditor(this, event)
        : null;
      const liveRadiusPixels = Math.max(
        1,
        Number(options.radiusPixels) || Number(this.textureBrushRadiusScreenPixels?.()) || 8
      );
      const liveVisibleEdgeMode = (
        options.visibleEdgeMode
        || this.textureAirbrushVisibleEdgeMode?.()
        || "soft"
      ) === "hard" ? "hard" : "soft";
      const liveHardVisibleEdge = liveVisibleEdgeMode === "hard";
      const explicitLiveVisibilityFeatherRadius = Number(options.visibilityFeatherRadius);
      const explicitLiveVisibilityBleedRadius = Number(options.visibilityBleedRadius);
      const explicitLiveVisibilityMaskThreshold = Number(options.visibilityMaskThreshold);
      const hasExplicitLiveVisibilityFeatherRadius = Number.isFinite(explicitLiveVisibilityFeatherRadius);
      const hasExplicitLiveVisibilityBleedRadius = Number.isFinite(explicitLiveVisibilityBleedRadius);
      const liveVisibilityFeatherRadius = liveHardVisibleEdge
        ? 0
        : hasExplicitLiveVisibilityFeatherRadius
          ? Math.max(0, explicitLiveVisibilityFeatherRadius)
          : null;
      const liveVisibilityBleedRadius = liveHardVisibleEdge
        ? 0
        : hasExplicitLiveVisibilityBleedRadius
          ? Math.max(0, explicitLiveVisibilityBleedRadius)
          : null;
      const liveVisibilityMaskThreshold = Math.max(
        0,
        Math.min(
          1,
          Number.isFinite(explicitLiveVisibilityMaskThreshold)
            ? explicitLiveVisibilityMaskThreshold
            : 0.02
        )
      );
      const liveStrokeDistance = liveStrokeScreenDistance(event, options);
      const liveScreenStrokeSegmentCount = Array.isArray(options.strokeSegments)
        ? options.strokeSegments.length
        : 0;
      const liveNeighborPaint = liveVisibleGpuPaint
        && (
          options.neighborPaintSeed?.enabled === true
          || options.largeLiveNeighborPaint === true
        );
      const liveResetBrushFootprint = options.strokeReset === true && liveRadiusPixels >= 16;
      const liveStartedWithResetFootprint = options.strokeStartedWithReset === true
        && liveRadiusPixels >= TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MIN_RADIUS_PIXELS;
      const largeLiveBrush = liveRadiusPixels >= TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MIN_RADIUS_PIXELS
        && (
          liveStrokeDistance > 0.5
          || liveResetBrushFootprint
          || liveStartedWithResetFootprint
          || liveVisibleGpuPaint
        );
      const liveScreenSurfaceStroke = liveVisibleGpuPaint
        && (
          options.screenStrokePaint === true
          || options.liveProjectedPaint === true
        );
      const fullSurfaceTslPaint = largeLiveBrush || liveScreenSurfaceStroke;
      const sourceMeshTslNeighborPaint = fullSurfaceTslPaint
        && liveNeighborPaint
        && options.useTslSurfaceAirbrush !== false;
      const projectedSurfacePaintCandidates = fullSurfaceTslPaint
        && liveNeighborPaint;
      const boundedDisjointLiveBatch = liveVisibleGpuPaint
        && (
          !liveNeighborPaint
          || options.screenStrokePaint === true
        );
      const forceLiveFootprintVisibility = options.fullBrushVisibilityProbes === true;
      const largeLiveFootprintVisibility = fullSurfaceTslPaint && !liveNeighborPaint;
      const requireFullBrushVisibilityProbes = forceLiveFootprintVisibility;
      const useFootprintVisibilityProbes = liveVisibleGpuPaint
        && (
          options.directVisibilityOnly === false
          || (liveNeighborPaint && projectedSurfacePaintCandidates)
          || requireFullBrushVisibilityProbes
        );
      const liveNeighborProbeBudget = liveNeighborPaint
        ? liveNeighborVisibilityProbeBudget(this, event, options)
        : 0;
      const liveOrderedProbeBudget = liveNeighborPaint
        ? liveNeighborProbeBudget || 2
        : liveVisibilityProbeBudget(this, event, options);
      const liveNeighborFootprintProbeBudget = liveNeighborPaint
        ? Math.max(4, Math.min(12, liveNeighborProbeBudget * 2))
        : 0;
      const liveFootprintProbeBudget = liveNeighborPaint
        ? liveNeighborFootprintProbeBudget
        : liveFootprintVisibilityProbeBudget(this, event, options);
      const largeLiveFootprintProbeBudget = fullSurfaceTslPaint && !liveNeighborPaint
        ? Math.max(
            liveFootprintProbeBudget,
            Math.min(
              64,
              Math.max(36, Math.ceil(liveRadiusPixels * 1.1), liveOrderedProbeBudget * 4)
            )
          )
        : liveFootprintProbeBudget;
      const liveVisibilityTriangleLimit = liveNeighborPaint
        ? Math.min(
            TEXTURE_AIRBRUSH_WEBGPU_NEIGHBOR_SCREEN_VISIBILITY_TRIANGLES,
            TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
          )
        : largeLiveBrush
          ? Math.min(
              TEXTURE_AIRBRUSH_WEBGPU_LARGE_SCREEN_VISIBILITY_TRIANGLES,
              TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
            )
          : Math.min(
              TEXTURE_AIRBRUSH_WEBGPU_LIVE_SCREEN_VISIBILITY_TRIANGLES,
              TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
            );
      const liveProjectedPrimaryTriangleLimit = liveNeighborPaint
        ? Math.min(liveVisibilityTriangleLimit, TEXTURE_AIRBRUSH_WEBGPU_NEIGHBOR_SCREEN_VISIBILITY_TRIANGLES)
        : largeLiveBrush
          ? Math.min(liveVisibilityTriangleLimit, 768)
          : Math.min(liveVisibilityTriangleLimit, 256);
      const requestedLiveVisibilityTriangleLimit = Number.isFinite(Number(options.maxVisibilityTriangles))
        ? Math.max(1, Math.floor(Number(options.maxVisibilityTriangles)))
        : liveProjectedPrimaryTriangleLimit;
      const resolvedLiveVisibilityTriangleLimit = Math.min(
        requestedLiveVisibilityTriangleLimit,
        liveProjectedPrimaryTriangleLimit
      );
      const liveProbeVisibilityTriangleLimit = liveProjectedPrimaryTriangleLimit;
      const liveMergedVisibilityTriangleLimit = liveNeighborPaint
        ? Math.min(
            TEXTURE_AIRBRUSH_WEBGPU_NEIGHBOR_SCREEN_VISIBILITY_TRIANGLES,
            TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES
          )
        : liveProjectedPrimaryTriangleLimit;
      const immediateScreenTriangleLimit = Math.max(
        1,
        Math.floor(resolvedLiveVisibilityTriangleLimit || liveProjectedPrimaryTriangleLimit)
      );
      const immediateScreenVisibilityTriangles = immediateScreenStrokePaint
        ? Math.max(
            8,
            Math.min(
              liveVisibilityTriangleLimit,
              largeLiveBrush && !liveNeighborPaint
                ? immediateScreenTriangleLimit
                : Math.floor(Number(options.maxVisibilityTriangles) || immediateScreenTriangleLimit)
            )
          )
        : null;
      const immediateScreenVisibilityProbePoints = immediateScreenStrokePaint
        ? Math.max(
            4,
            Math.min(
              largeLiveBrush ? 48 : 6,
              Math.floor(Number(options.maxVisibilityProbePoints) || (largeLiveBrush
                ? Math.max(24, liveOrderedProbeBudget, Math.ceil(liveRadiusPixels * 0.75))
                : 4))
            )
          )
        : null;
      const liveCandidateOptions = liveVisibleGpuPaint
        ? {
            ...options,
            ...(options.strokeReset === true && !options.webGpuStrokeSourceRoot
              ? { webGpuStrokeSourceRoot: {} }
              : {}),
            directVisibilityOnly: !useFootprintVisibilityProbes,
            requireVisibilityTriangles: !fullSurfaceTslPaint
              || (liveNeighborPaint && !sourceMeshTslNeighborPaint),
            useVisibilityTrianglePaintRegions: true,
            screenBrushVisibilityTriangles: true,
            // Large projected strokes need one paint pass per visible surface
            // target touched by the brush footprint. The candidates are deduped
            // by material/editable pass; the shader still evaluates one
            // continuous screen-space brush field inside each UV-rasterized
            // triangle, so probe rectangles do not become visible stroke shape.
            paintProjectedSurfaceCandidates: projectedSurfacePaintCandidates,
            dedupProjectedSurfacePaintCandidates: projectedSurfacePaintCandidates,
            paintOrderedProbeCandidates: projectedSurfacePaintCandidates,
            // The brush stroke is evaluated in unwrapped UV space.
            // Camera-facing triangles authorize texels, but soft visibility
            // still needs the sampled UV stroke footprint so triangle/UV edges
            // do not become the painted shape.
            keepVisibilitySamplesWithTriangles: true,
            maxVisibilityTriangles: Math.max(
              1,
              Math.floor(resolvedLiveVisibilityTriangleLimit || liveProjectedPrimaryTriangleLimit)
            ),
            maxProbeVisibilityTriangles: Math.max(
              1,
              Math.floor(Number(
                options.maxProbeVisibilityTriangles
                ?? liveProbeVisibilityTriangleLimit
              ) || liveProbeVisibilityTriangleLimit)
            ),
            ...(useFootprintVisibilityProbes
              ? {
                  ...(requireFullBrushVisibilityProbes ? { fullBrushVisibilityProbes: true } : {}),
                  maxVisibilityProbePoints: Math.max(
                    2,
                    Math.floor(Number(options.maxVisibilityProbePoints) || liveOrderedProbeBudget)
                  ),
                  ...(liveNeighborPaint
                    ? {
                        // DO NOT PAINT ON NON CAMERA-FACING NORMALS.
                        // Neighbor keeps the connected front-surface segment
                        // samples as a soft visibility mask even when triangle
                        // masks exist; this fills only between sampled
                        // camera-facing hits, not unseen back-side UVs.
                        maxNeighborVisibilityIntersections: Math.max(
                          2,
                          Math.floor(Number(options.maxNeighborVisibilityIntersections) || 3)
                        )
                      }
                    : largeLiveBrush
                      ? {}
                      : {}),
                  maxVisibilityFootprintProbePoints: Math.max(
                    4,
                    Math.floor(Number(options.maxVisibilityFootprintProbePoints) || largeLiveFootprintProbeBudget || 12)
                  ),
                  denseVisibilityFootprintProbes: largeLiveBrush && !liveNeighborPaint ? true : false
                }
              : {}),
            ...(largeLiveBrush && liveNeighborPaint
              ? {
                  largeLiveNeighborPaint: true,
                  visibilityFootprintViewRadiusScale: 1.35,
                  allowDisjointLiveBatchBounds: true
                }
              : {}),
            ...(boundedDisjointLiveBatch
              ? {
                  allowDisjointLiveBatchBounds: true,
                  ...(!largeLiveBrush && !Number.isFinite(Number(options.maxLiveBatchAreaPixels))
                    ? { maxLiveBatchAreaPixels: TEXTURE_AIRBRUSH_WEBGPU_LIVE_DISJOINT_BATCH_AREA_PIXELS }
                    : {})
                }
              : {}),
            ...(liveNeighborPaint && !Number.isFinite(Number(options.maxLiveBatchAreaPixels))
              ? (() => {
                  const neighborAreaLimit = largeLiveBrush
                    ? TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_BATCH_AREA_PIXELS
                    : TEXTURE_AIRBRUSH_WEBGPU_LIVE_NEIGHBOR_BATCH_AREA_PIXELS;
                  return {
                    maxLiveBatchAreaPixels: neighborAreaLimit,
                    maxLiveBatchRegionAreaPixels: neighborAreaLimit
                  };
                })()
              : {}),
            ...(fullSurfaceTslPaint
	              ? {
	                  ...(largeLiveBrush ? { largeLiveBrushPaint: true } : {}),
	                  fullProjectedSurfaceRenderTriangles: true,
	                  screenSurfaceContinuityFilter: false,
	                  surfaceContinuitySamplesIgnoreMaterial: true,
	                  surfaceContinuityKeepDisconnected: true,
	                  screenSurfaceFrontFilter: false,
	                  skipTransparentScreenTextureTriangles: false,
	                  maxProjectedSurfaceScreenTriangles: liveProjectedPrimaryTriangleLimit,
	                  maxProjectedRenderTriangles: liveProjectedPrimaryTriangleLimit,
	                  ...(!liveNeighborPaint ? {
	                    allowVisibilityOverflowBatches: false
                  } : {}),
                  allowDisjointLiveBatchBounds: true,
                }
              : {}),
            // Match the live WebGPU fast path shape: keep per-pointer work to
            // small stroke/triangle payloads and let the GPU evaluate visibility.
            // Do not build a CPU raster visibility texture for live paint.
            visibilityMaskMode: "samples",
            visibilityMaskBoundsMode: "paint",
            deferVisibilityMaskAssignment: true,
            allowVariableStrokeSegmentRadius: true,
            visibilityTriangleCacheGridPixels: Math.max(
              4,
              Math.min(
                12,
                Math.floor(Number(options.visibilityTriangleCacheGridPixels) || (liveNeighborPaint ? 8 : 12))
              )
            ),
            maxScreenProjectedSegments: Math.max(
              fullSurfaceTslPaint ? 1 : 8,
              Math.min(
                fullSurfaceTslPaint ? TEXTURE_AIRBRUSH_TSL_SURFACE_MAX_STROKE_SEGMENTS : 24,
                Math.floor(
                  Number(options.maxScreenProjectedSegments)
                  || Math.max(fullSurfaceTslPaint ? 1 : 8, liveScreenStrokeSegmentCount * (fullSurfaceTslPaint ? 1 : 1))
                )
              )
            ),
            maxMergedVisibilityTriangles: Math.max(
              1,
              Math.floor(Number(options.maxMergedVisibilityTriangles) || liveMergedVisibilityTriangleLimit)
            ),
            ...(immediateScreenStrokePaint
              ? {
                  maxVisibilityTriangles: immediateScreenVisibilityTriangles,
                  maxProbeVisibilityTriangles: immediateScreenVisibilityTriangles,
                  maxMergedVisibilityTriangles: immediateScreenVisibilityTriangles,
                  maxVisibilityProbePoints: immediateScreenVisibilityProbePoints,
                  maxVisibilityFootprintProbePoints: immediateScreenVisibilityProbePoints
                }
              : {}),
            ...(options.screenStrokePaint === true
              ? { reuseCandidateVisibilityTrianglesForSegments: true }
              : {}),
            ...(largeLiveBrush && !liveNeighborPaint && !Number.isFinite(Number(options.maxLiveBatchAreaPixels))
              ? { maxLiveBatchAreaPixels: TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_BATCH_AREA_PIXELS }
              : {}),
            visibleEdgeMode: liveVisibleEdgeMode,
            visibilityMaskThreshold: liveVisibilityMaskThreshold,
            ...(liveHardVisibleEdge || hasExplicitLiveVisibilityFeatherRadius
              ? { visibilityFeatherRadius: liveVisibilityFeatherRadius }
              : {}),
            ...(liveHardVisibleEdge || hasExplicitLiveVisibilityBleedRadius
              ? { visibilityBleedRadius: liveVisibilityBleedRadius }
              : {}),
            ...(liveHitSampleCache ? { hitSampleCache: liveHitSampleCache } : {})
          }
        : options;
      const liveCandidateStartMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      debugLiveWebGpuAirbrush("live-candidate-start", {
        liveVisibleGpuPaint,
        liveProjectedPaint: options.liveProjectedPaint === true,
        screenStrokePaint: options.screenStrokePaint === true,
        directVisibilityOnly: liveCandidateOptions.directVisibilityOnly === true,
        paintProjectedSurfaceCandidates: liveCandidateOptions.paintProjectedSurfaceCandidates === true,
        maxVisibilityTriangles: liveCandidateOptions.maxVisibilityTriangles ?? null,
        maxScreenProjectedSegments: liveCandidateOptions.maxScreenProjectedSegments ?? null,
        fullProjectedSurfaceRenderTriangles: liveCandidateOptions.fullProjectedSurfaceRenderTriangles === true,
        radiusPixels: liveRadiusPixels,
        strokeSegments: Array.isArray(options.strokeSegments) ? options.strokeSegments.length : 0
      });
      const candidates = this.textureAirbrushWebGpuCandidatesFromEvent?.(event, liveCandidateOptions) || [];
      const liveCandidateEndMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      debugLiveWebGpuAirbrush("live-candidate-finished", {
        candidates: candidates.length,
        durationMs: Math.max(0, liveCandidateEndMs - liveCandidateStartMs),
        visibilityTriangles: Math.max(
          0,
          ...candidates.map((candidate) => (
            Array.isArray(candidate?.options?.visibilityMaskTriangles)
              ? candidate.options.visibilityMaskTriangles.length
              : 0
          ))
        ),
        screenProjectedSegments: Math.max(
          0,
          ...candidates.map((candidate) => (
            Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
              ? candidate.options.screenProjectedStrokeSegments.length
              : 0
          ))
        )
      });
      if (!candidates.length) {
        return 0;
      }
      if (liveVisibleGpuPaint) {
        const batches = directLiveCandidateBatches(candidates);
        const hasVisibilityOverflowBatch = batches.some((batch) => (
          batch?.liveVisibilityOverflowBatch === true
          || batch?.options?.liveVisibilityOverflowBatch === true
        ));
        const assignStartMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (!(fullSurfaceTslPaint && !liveNeighborPaint)) {
          textureAirbrushWebGpuAssignVisibilityMasks(batches, {
            ...liveCandidateOptions,
            visibilityMaskMode: "samples",
            keepCandidateVisibilityMasksSeparate: true,
            compactVisibilityMaskKey: true,
            skipVisibilitySamplesWhenTriangles: false
          });
        }
        debugLiveWebGpuAirbrush("live-visibility-assigned", {
          batches: batches.length,
          durationMs: Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - assignStartMs),
          visibilityTriangles: Math.max(
            0,
            ...batches.map((batch) => (
              Array.isArray(batch?.options?.visibilityMaskTriangles)
                ? batch.options.visibilityMaskTriangles.length
                : 0
            ))
          )
        });
        const queueOptions = {
          ...options,
          visibilityMaskMode: "samples",
          scheduleFlush: false
        };
        const queuedBefore = this.textureAirbrushQueuedWebGpuStrokes?.length || 0;
        const queueStartMs = typeof performance !== "undefined" ? performance.now() : Date.now();
        const estimate = batches.reduce((total, candidate) => (
          total + (this.textureAirbrushQueueWebGpuStrokeCandidate?.(candidate, queueOptions) || 0)
        ), 0);
        debugLiveWebGpuAirbrush("live-candidate-queued", {
          batches: batches.length,
          estimate,
          durationMs: Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - queueStartMs),
          queuedBefore,
          queuedAfter: this.textureAirbrushQueuedWebGpuStrokes?.length || 0
        });
        debugLiveWebGpuAirbrush("live-candidate-queue", {
          sourceCandidates: candidates.length,
          batches: batches.length,
          visibilityOnly: candidates.filter((candidate) => (
            candidate?.visibilityOnly === true || candidate?.options?.visibilityOnly === true
          )).length,
          paintCandidates: candidates.filter((candidate) => (
            candidate?.visibilityOnly !== true && candidate?.options?.visibilityOnly !== true
          )).length,
          queuedBefore,
          queuedAfter: this.textureAirbrushQueuedWebGpuStrokes?.length || 0,
          queuedDelta: (this.textureAirbrushQueuedWebGpuStrokes?.length || 0) - queuedBefore,
          estimate,
          largeNeighbor: largeLiveBrush && liveNeighborPaint,
          largeBrush: largeLiveBrush,
          hasNeighborSeed: options.neighborPaintSeed?.enabled === true,
          largeLiveNeighborPaint: options.largeLiveNeighborPaint === true,
          neighborPaintKey: options.neighborPaintKey || "",
          layerMode: options.layerMode === true,
          screenStrokePaint: options.screenStrokePaint === true,
          strokeReset: options.strokeReset === true,
          strokeStartedWithReset: options.strokeStartedWithReset === true,
          radiusPixels: liveRadiusPixels,
          opacity: options.opacity ?? null,
          hardness: options.hardness ?? null,
          scatter: options.scatter ?? null,
          color: options.color || null,
          visibleEdgeMode: liveVisibleEdgeMode,
          visibilityFeatherRadius: liveVisibilityFeatherRadius,
          visibilityMaskThreshold: liveVisibilityMaskThreshold,
          visibilityBleedRadius: liveVisibilityBleedRadius,
          visibilityOverflow: hasVisibilityOverflowBatch
        });
        if (estimate > 0) {
          if (options.immediateWebGpuFlush === true) {
            const maxBatches = Math.floor(Number(options.maxImmediateWebGpuFlushBatches));
            const screenStrokeImmediatePaint = options.screenStrokePaint === true
              || batches.some((batch) => batch?.options?.screenStrokePaint === true);
            const liveBatchLimit = screenStrokeImmediatePaint
              ? null
              : largeLiveWebGpuFlushBatchLimit(batches);
            const immediateMaxBatches = screenStrokeImmediatePaint
              ? Number.isFinite(maxBatches) && maxBatches > 0
                ? maxBatches
                : largeLiveBrush || hasVisibilityOverflowBatch
                  ? TEXTURE_AIRBRUSH_WEBGPU_IMMEDIATE_FLUSH_MAX_BATCHES
                  : TEXTURE_AIRBRUSH_WEBGPU_IMMEDIATE_FLUSH_MAX_BATCHES
              : Number.isFinite(liveBatchLimit)
              ? liveBatchLimit
              : Number.isFinite(maxBatches) && maxBatches > 0
                ? maxBatches
                : largeLiveBrush || hasVisibilityOverflowBatch
                  ? TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_IMMEDIATE_FLUSH_MAX_BATCHES
                  : TEXTURE_AIRBRUSH_WEBGPU_IMMEDIATE_FLUSH_MAX_BATCHES;
            this.flushTextureAirbrushQueuedWebGpuStrokes?.({
              ...options,
              force: false,
              maxBatches: immediateMaxBatches
            });
          } else if (options.deferQueuedWebGpuFlush !== true) {
            this.scheduleTextureAirbrushQueuedWebGpuFlush?.();
          }
          setThrottledWebGpuLiveStatus(this, `WebGPU airbrush queued ${estimate} visible texture pixels`);
        }
        return estimate;
      }
      return candidates.reduce((total, candidate) => (
        total + (this.textureAirbrushQueueWebGpuStrokeCandidate?.(candidate, options) || 0)
      ), 0);
    }
  });
}
