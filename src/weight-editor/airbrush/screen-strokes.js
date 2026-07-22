import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import { clampByte } from "./math.js";
import {
  textureAirbrushEventPressureValue,
  textureAirbrushPressurePointerType
} from "./pressure.js";
import { installTextureAirbrushScreenOverlayMethods } from "./screen-overlay.js";
import {
  textureAirbrushPointWithSurfaceAnchor,
  textureAirbrushSurfaceAnchorFromPoint,
  textureAirbrushSurfaceSegmentMetadata
} from "./surface-path.js";

const TEXTURE_AIRBRUSH_PRESSURE_STYLE_DELTA = 0.12;
const TEXTURE_AIRBRUSH_PRESSURE_REVERSAL_JITTER_DELTA = 0.22;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCHES = 4;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_MS = 8;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS = 24;
const TEXTURE_AIRBRUSH_LIVE_MAX_SEGMENTS = 48;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCHES = 32;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCH_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_SCREEN_SEGMENT_PIXELS = 96;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCH_MS = 12;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCHES = 8;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_FIRST_PAINT_BATCHES = 32;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_MS = 12;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MIN_MS = 16;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_NEIGHBOR_IMMEDIATE_MIN_MS = 24;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_CONTINUATION_COALESCE_MS = 16;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_CONTINUATION_COALESCE_MS = 40;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_SCREEN_FLUSH_MIN_MS = 16;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_BRUSH_MIN_RADIUS_PIXELS = 18;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_RESET_FOOTPRINT_MIN_RADIUS_PIXELS = 24;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_RESET_FOOTPRINT_HOLD_MS = 48;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_RESET_FOOTPRINT_MAX_AGE_MS = 1200;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCHES = 32;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCH_SEGMENTS = 64;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCH_MS = 8;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCHES = 4;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCH_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCH_MS = 12;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_QUEUED_PAYLOADS = 10;
const TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MIN_SAMPLE_PIXELS = 10;
const TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_BATCHES = 1;
const TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS = 8;
const TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_FIRST_FRAME_SEGMENTS = 12;
const TEXTURE_AIRBRUSH_LIVE_BUDGET_REFERENCE_RADIUS = 16;
const TEXTURE_AIRBRUSH_LIVE_MAX_ADAPTIVE_BATCH_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_MAX_ADAPTIVE_SEGMENTS = 256;

function exposeScreenWebGpuDebugEntry(entry = null) {
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
    inFlight: detail.inFlight ?? null
  });
  if (entry.label === "screen-flush-queued-drain") {
    root.dataset.textureAirbrushDebugScreenQueuedDrainCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugScreenQueuedDrainCount) || 0)) + 1
    );
  } else if (entry.label === "large-neighbor-fast-queue") {
    root.dataset.textureAirbrushDebugLargeNeighborQueueCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugLargeNeighborQueueCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugLargeNeighborSourceEvents = String(detail.sourceEvents ?? "");
    root.dataset.textureAirbrushDebugLargeNeighborQueuedPayloads = String(detail.queuedPayloads ?? "");
    root.dataset.textureAirbrushDebugLargeNeighborSkippedPayloads = String(detail.skippedPayloads ?? "");
    root.dataset.textureAirbrushDebugLargeNeighborRadiusPixels = String(detail.radiusPixels ?? "");
    root.dataset.textureAirbrushDebugLargeNeighborMinSamplePixels = String(detail.minSamplePixels ?? "");
    root.dataset.textureAirbrushDebugLargeNeighborQueueLength = String(detail.queueLength ?? "");
  }
}

function debugScreenWebGpuAirbrush(label = "", detail = {}) {
  if (
    typeof window === "undefined"
    || !new URLSearchParams(window.location.search || "").has("debugAirbrush")
  ) {
    return;
  }
  const params = new URLSearchParams(window.location.search || "");
  const entry = {
    time: Date.now(),
    source: "screen-strokes",
    label,
    detail
  };
  exposeScreenWebGpuDebugEntry(entry);
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

function finiteClientPoint(point = null) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return null;
  }
  return textureAirbrushPointWithSurfaceAnchor(
    point,
    textureAirbrushSurfaceAnchorFromPoint(point)
  );
}

function clientEventAtPoint(editor, sourceEvent = null, point = null) {
  const clientPoint = finiteClientPoint(point);
  if (!clientPoint) {
    return null;
  }
  return editor.textureAirbrushInputEventAtPoint?.(sourceEvent, clientPoint)
    || editor.texturePaintEventAtPoint?.(sourceEvent, clientPoint)
    || {
    ...sourceEvent,
    clientX: clientPoint.clientX,
    clientY: clientPoint.clientY,
    preventDefault: () => sourceEvent?.preventDefault?.(),
    stopPropagation: () => sourceEvent?.stopPropagation?.()
  };
}

function clientDistanceSqValues(leftX = 0, leftY = 0, rightX = 0, rightY = 0) {
  const dx = rightX - leftX;
  const dy = rightY - leftY;
  return dx * dx + dy * dy;
}

function finiteClientPointLike(point = null) {
  return Number.isFinite(point?.clientX) && Number.isFinite(point?.clientY);
}

function cloneClientPoint(point = null) {
  return finiteClientPoint(point);
}

function applyClientPointSurfaceAnchor(target = null, source = null) {
  if (!target) {
    return false;
  }
  const anchor = textureAirbrushSurfaceAnchorFromPoint(source);
  if (anchor) {
    target.textureAirbrushSurfaceAnchor = anchor;
    return true;
  }
  delete target.textureAirbrushSurfaceAnchor;
  return false;
}

function sameClientPoint(left = null, right = null, epsilonSq = 0.000001) {
  return Boolean(
    finiteClientPointLike(left)
    && finiteClientPointLike(right)
    && clientDistanceSqValues(left.clientX, left.clientY, right.clientX, right.clientY) <= epsilonSq
  );
}

function appendUniqueClientPoint(points = [], point = null) {
  const clone = cloneClientPoint(point);
  if (!clone) {
    return false;
  }
  if (!points.length || !sameClientPoint(points.at(-1), clone)) {
    points.push(clone);
  } else if (textureAirbrushSurfaceAnchorFromPoint(clone)) {
    applyClientPointSurfaceAnchor(points.at(-1), clone);
  }
  return true;
}

function appendContinuousClientPoint(points = [], point = null) {
  const clone = cloneClientPoint(point);
  if (!clone) {
    return false;
  }
  if (!points.length) {
    points.push(clone);
    return true;
  }
  if (sameClientPoint(points.at(-1), clone)) {
    if (textureAirbrushSurfaceAnchorFromPoint(clone)) {
      applyClientPointSurfaceAnchor(points.at(-1), clone);
    }
    return true;
  }
  if (points.length >= 2 && sameClientPoint(points.at(-2), clone)) {
    points.pop();
    return true;
  }
  points.push(clone);
  return true;
}

function appendContinuousClientPoints(points = [], incoming = []) {
  let appended = false;
  for (const point of Array.isArray(incoming) ? incoming : []) {
    appended = appendContinuousClientPoint(points, point) || appended;
  }
  return appended;
}

function mergeContinuousStrokePoints(existing = [], incoming = []) {
  const points = normalizedContinuousStrokePoints(existing);
  const incomingPoints = normalizedContinuousStrokePoints(incoming);
  if (!incomingPoints.length) {
    return points;
  }
  if (!points.length) {
    appendContinuousClientPoints(points, incomingPoints);
    return points;
  }
  const last = points.at(-1);
  let resumeIndex = -1;
  for (let index = incomingPoints.length - 1; index >= 0; index -= 1) {
    if (sameClientPoint(incomingPoints[index], last)) {
      resumeIndex = index;
      break;
    }
  }
  if (resumeIndex >= 0) {
    appendContinuousClientPoints(points, incomingPoints.slice(resumeIndex + 1));
    return points;
  }
  appendContinuousClientPoints(points, incomingPoints);
  return points;
}

function payloadCurvePoints(payload = null, extraPoints = []) {
  const points = [];
  appendUniqueClientPoint(points, payload?.strokeStart);
  for (const point of Array.isArray(payload?.curvePoints) ? payload.curvePoints : []) {
    appendUniqueClientPoint(points, point);
  }
  appendUniqueClientPoint(points, payload);
  for (const point of Array.isArray(extraPoints) ? extraPoints : []) {
    appendUniqueClientPoint(points, point);
  }
  return points;
}

function rememberPayloadCurvePoints(payload = null, extraPoints = []) {
  if (!payload) {
    return false;
  }
  const points = payloadCurvePoints(payload, extraPoints);
  if (points.length <= 2) {
    delete payload.curvePoints;
    return false;
  }
  payload.curvePoints = points.slice(1, -1).slice(
    -Math.max(1, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS - 1)
  );
  return true;
}

function normalizedContinuousStrokePoints(points = []) {
  const output = [];
  for (const point of Array.isArray(points) ? points : []) {
    appendContinuousClientPoint(output, point);
  }
  return output;
}

function continuousStrokePointsForPayload(payload = null) {
  const points = normalizedContinuousStrokePoints(payload?.continuousStrokePoints);
  return points.length >= 2 ? points : [];
}

function incrementalContinuousStrokePoints(payload = null, cursor = null) {
  const points = continuousStrokePointsForPayload(payload);
  const serial = Math.floor(Number(payload?.continuousStrokePathSerial));
  const revision = Math.floor(Number(payload?.continuousStrokePathRevision));
  if (!points.length || !Number.isFinite(serial) || !Number.isFinite(revision)) {
    return { points, cursor };
  }
  const nextCursor = {
    serial,
    revision,
    point: cloneClientPoint(points.at(-1))
  };
  if (!cursor || cursor.serial !== serial) {
    return { points, cursor: nextCursor };
  }
  if (revision <= cursor.revision) {
    return { points: [], cursor };
  }
  let resumeIndex = -1;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (sameClientPoint(points[index], cursor.point)) {
      resumeIndex = index;
      break;
    }
  }
  return {
    points: resumeIndex >= 0 ? points.slice(resumeIndex) : points,
    cursor: nextCursor
  };
}

function applyContinuousStrokePointsToPayload(payload = null, points = []) {
  if (!payload) {
    return false;
  }
  const normalized = normalizedContinuousStrokePoints(points);
  if (normalized.length < 2) {
    delete payload.continuousStrokePoints;
    return false;
  }
  payload.continuousStrokePoints = normalized;
  return true;
}

function clientPointToSegmentDistanceSqValues(pointX = 0, pointY = 0, startX = 0, startY = 0, endX = 0, endY = 0) {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.000001) {
    return clientDistanceSqValues(pointX, pointY, startX, startY);
  }
  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSq
    )
  );
  return clientDistanceSqValues(
    pointX,
    pointY,
    startX + dx * ratio,
    startY + dy * ratio
  );
}

function quantizedBrushRadiusPixels(radiusPixels = 1) {
  return Math.max(1, Math.round(Math.max(1, Number(radiusPixels) || 1)));
}

function quantizedBrushOpacity(opacity = 1) {
  return Math.max(0.001, Math.min(1, Math.round(Math.max(0.001, Math.min(1, Number(opacity) || 1)) * 64) / 64));
}

function pressurePointerType(event = null) {
  return textureAirbrushPressurePointerType(event);
}

function eventPressureValue(event = null) {
  return textureAirbrushEventPressureValue(event);
}

function pressureRadiusThreshold(baseRadiusPixels = 1, pressureDelta = TEXTURE_AIRBRUSH_PRESSURE_STYLE_DELTA) {
  return Math.max(0.75, Math.max(1, Number(baseRadiusPixels) || 1) * pressureDelta);
}

function pressureStatePointDistanceSq(state = null, event = null) {
  if (
    !Number.isFinite(state?.clientX)
    || !Number.isFinite(state?.clientY)
    || !Number.isFinite(event?.clientX)
    || !Number.isFinite(event?.clientY)
  ) {
    return Infinity;
  }
  return clientDistanceSqValues(state.clientX, state.clientY, event.clientX, event.clientY);
}

function pressureStateSnapshot(pressure = 1, radiusPixels = 1, event = null, pressureTrend = 0) {
  return {
    pressure,
    radiusPixels,
    pressureTrend,
    ...(Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
      ? { clientX: event.clientX, clientY: event.clientY }
      : {})
  };
}

function pressureStateStableForRadius(state = null, pressure = 1, radiusPixels = 1, baseRadiusPixels = 1, event = null) {
  if (!state) {
    return null;
  }
  const pressureDelta = pressure - state.pressure;
  const pressureDeltaAbs = Math.abs(pressureDelta);
  const radiusDelta = Math.abs(radiusPixels - state.radiusPixels);
  if (
    pressureDeltaAbs < TEXTURE_AIRBRUSH_PRESSURE_STYLE_DELTA
    && radiusDelta < pressureRadiusThreshold(baseRadiusPixels)
  ) {
    return true;
  }
  const previousTrend = Math.sign(Number(state.pressureTrend) || 0);
  const nextTrend = Math.sign(pressureDelta);
  const reversalDistance = Math.max(6, Math.min(18, Math.max(1, Number(baseRadiusPixels) || 1) * 0.5));
  return previousTrend !== 0
    && nextTrend !== 0
    && nextTrend !== previousTrend
    && (
      (
        pressureDeltaAbs < TEXTURE_AIRBRUSH_PRESSURE_REVERSAL_JITTER_DELTA
        && radiusDelta < pressureRadiusThreshold(baseRadiusPixels, TEXTURE_AIRBRUSH_PRESSURE_REVERSAL_JITTER_DELTA)
      )
      || pressureStatePointDistanceSq(state, event) < reversalDistance * reversalDistance
    );
}

function currentTimeMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function scheduleMicrotask(callback = null) {
  if (typeof callback !== "function") {
    return false;
  }
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return true;
  }
  if (typeof Promise !== "undefined") {
    Promise.resolve().then(callback);
    return true;
  }
  if (typeof globalThis.setTimeout === "function") {
    globalThis.setTimeout(callback, 0);
    return true;
  }
  return false;
}

function setScreenStrokeStatus(editor = null, message = "", options = {}) {
  if (!editor || typeof editor.setStatus !== "function") {
    return false;
  }
  if (options.throttle === true) {
    const intervalMs = Math.max(0, Number(options.intervalMs) || 120);
    const now = currentTimeMs();
    const previous = Number(editor.textureAirbrushLastLiveScreenStrokeStatusMs) || 0;
    if (previous && now - previous < intervalMs) {
      return false;
    }
    editor.textureAirbrushLastLiveScreenStrokeStatusMs = now;
  }
  editor.setStatus(message);
  return true;
}

function liveProjectionFrameNeedsVisibleRewarm(editor = null) {
  const frame = editor?.textureAirbrushLiveProjectionFrameState || null;
  if (!frame) {
    return true;
  }
  if (typeof editor.textureAirbrushLiveProjectionFrameCurrent !== "function") {
    return false;
  }
  return editor.textureAirbrushLiveProjectionFrameCurrent(frame) !== true;
}

function activeTexturePaintLayerMode(editor = null, material = null) {
  if (editor?.texturePaintLayerModeActive?.() !== true) {
    return false;
  }
  return true;
}

function probePointForClientEvent(event = null, rect = null) {
  if (
    !Number.isFinite(event?.clientX)
    || !Number.isFinite(event?.clientY)
    || !rect
  ) {
    return null;
  }
  return {
    x: Math.round(event.clientX - (rect.left || 0)),
    y: Math.round(event.clientY - (rect.top || 0))
  };
}

function probePointForLayerResetWork(work = null, rect = null) {
  return probePointForClientEvent(work?.strokeStart, rect)
    || probePointForClientEvent(work?.strokeSegments?.[0]?.start, rect)
    || probePointForClientEvent(work, rect);
}

function probePointFromKey(key = "") {
  const [x, y] = String(key).split(":").map((part) => Number(part));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function probePassesHaveLayerTarget(passes = []) {
  return passes.some((pass) => pass?.targetEntry?.layerMode === true);
}

function splitStrokeBatch(batch = null) {
  const segments = batch?.strokeSegments || [];
  if (!segments.length) {
    return [];
  }
  const batches = [];
  for (let index = 0; index < segments.length; index += TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
    batches.push({
      ...batch,
      strokeReset: batch.strokeReset === true && index === 0,
      strokeSegments: segments.slice(index, index + TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS)
    });
  }
  return batches;
}

function compatibleStrokeBatches(previous = null, next = null) {
  return Boolean(
    previous
    && next
    && previous.styleKey
    && previous.styleKey === next.styleKey
    && previous.pressureApplied === next.pressureApplied
    && (previous.erase === true) === (next.erase === true)
    && (previous.layerMode === true) === (next.layerMode === true)
    && (previous.neighborPaintKey || "") === (next.neighborPaintKey || "")
    && (previous.neighborPaintSeed || null) === (next.neighborPaintSeed || null)
    && (previous.strokeUndo || null) === (next.strokeUndo || null)
    && next.strokeReset !== true
    && layerMutationSerial(previous.layerMutationSerial) === layerMutationSerial(next.layerMutationSerial)
    && Math.max(0.1, Math.min(200, Number(previous.spacing ?? 1)))
      === Math.max(0.1, Math.min(200, Number(next.spacing ?? 1)))
  );
}

function appendMergedStrokeBatch(merged = [], batch = null) {
  if (!batch?.strokeSegments?.length) {
    return;
  }
  let remainingSegments = batch.strokeSegments;
  const previous = merged.at(-1);
  if (compatibleStrokeBatches(previous, batch) && previous.strokeSegments.length < TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
    const appendCount = Math.min(
      TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS - previous.strokeSegments.length,
      remainingSegments.length
    );
    previous.radiusPixels = Math.max(
      Math.max(1, Number(previous.radiusPixels) || 1),
      Math.max(1, Number(batch.radiusPixels) || 1)
    );
    previous.neighborProjectionRewarmed = previous.neighborProjectionRewarmed === true
      || batch.neighborProjectionRewarmed === true;
    previous.postCameraProjectionRewarmed = previous.postCameraProjectionRewarmed === true
      || batch.postCameraProjectionRewarmed === true;
    previous.postCameraProjectionAccumulates = previous.postCameraProjectionAccumulates === true
      || batch.postCameraProjectionAccumulates === true;
    previous.deferredNeighborProjectionRewarm = previous.deferredNeighborProjectionRewarm === true
      || batch.deferredNeighborProjectionRewarm === true;
    previous.deferredNeighborPaintSeed = previous.deferredNeighborPaintSeed === true
      || batch.deferredNeighborPaintSeed === true;
    previous.deferredPostCameraProjectionAccumulates = previous.deferredPostCameraProjectionAccumulates === true
      || batch.deferredPostCameraProjectionAccumulates === true;
    previous.continuousStrokePath = previous.continuousStrokePath === true
      || batch.continuousStrokePath === true;
    previous.preSmoothedStrokePath = previous.preSmoothedStrokePath === true
      || batch.preSmoothedStrokePath === true;
    previous.strokeStartedWithReset = previous.strokeStartedWithReset === true
      || batch.strokeStartedWithReset === true
      || previous.strokeReset === true
      || batch.strokeReset === true;
    previous.layerCachedStartContinuation = previous.layerCachedStartContinuation === true
      || batch.layerCachedStartContinuation === true;
    previous.strokeSegments.push(...remainingSegments.slice(0, appendCount));
    remainingSegments = remainingSegments.slice(appendCount);
  }
  for (let index = 0; index < remainingSegments.length; index += TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
    merged.push({
      ...batch,
      strokeSegments: remainingSegments.slice(index, index + TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS)
    });
  }
}

function mergeCompatibleStrokeBatches(batches = []) {
  const merged = [];
  for (const batch of batches) {
    appendMergedStrokeBatch(merged, batch);
  }
  return merged;
}

function screenStrokeBatchEvent(batch = null, options = {}) {
  const lastSegment = batch?.strokeSegments?.at?.(-1) || null;
  const batchPoint = Number.isFinite(batch?.clientX) && Number.isFinite(batch?.clientY)
    ? { clientX: batch.clientX, clientY: batch.clientY }
    : null;
  const segmentPoint = Number.isFinite(lastSegment?.end?.clientX) && Number.isFinite(lastSegment?.end?.clientY)
    ? { clientX: lastSegment.end.clientX, clientY: lastSegment.end.clientY }
    : null;
  const point = options.preferBatchPoint === true
    ? batchPoint || segmentPoint || { clientX: 0, clientY: 0 }
    : segmentPoint || batchPoint || { clientX: 0, clientY: 0 };
  return {
    clientX: point.clientX,
    clientY: point.clientY,
    button: 0,
    buttons: 1,
    pointerType: "pen",
    pressure: 1,
    preventDefault: () => {},
    stopPropagation: () => {}
  };
}

function screenStrokeEventForClientPoint(point = null) {
  return {
    clientX: Number(point?.clientX) || 0,
    clientY: Number(point?.clientY) || 0,
    button: 0,
    buttons: 1,
    pointerType: "pen",
    pressure: 1,
    preventDefault: () => {},
    stopPropagation: () => {}
  };
}

function screenStrokeBatchSeedEvents(batch = null) {
  const points = [];
  const seen = new Set();
  const addPoint = (point = null) => {
    if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
      return;
    }
    const key = `${Math.round(point.clientX * 2) / 2}:${Math.round(point.clientY * 2) / 2}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    points.push({ clientX: point.clientX, clientY: point.clientY });
  };
  if (Number.isFinite(batch?.clientX) && Number.isFinite(batch?.clientY)) {
    addPoint(batch);
  }
  const segments = Array.isArray(batch?.strokeSegments) ? batch.strokeSegments : [];
  const first = segments[0] || null;
  const last = segments.at?.(-1) || null;
  addPoint(first?.start);
  addPoint(first?.end);
  addPoint(last?.end);
  const stride = Math.max(1, Math.floor(Math.max(1, segments.length) / 8));
  for (let index = 0; index < segments.length; index += stride) {
    const segment = segments[index];
    addPoint(segment?.start);
    addPoint(segment?.end);
    if (
      Number.isFinite(segment?.start?.clientX)
      && Number.isFinite(segment?.start?.clientY)
      && Number.isFinite(segment?.end?.clientX)
      && Number.isFinite(segment?.end?.clientY)
    ) {
      addPoint({
        clientX: (segment.start.clientX + segment.end.clientX) * 0.5,
        clientY: (segment.start.clientY + segment.end.clientY) * 0.5
      });
    }
    if (points.length >= 16) {
      break;
    }
  }
  return points.map((point) => screenStrokeEventForClientPoint(point));
}

function resolveDeferredNeighborProjectionRewarm(editor = null, batches = []) {
  if (!editor || !Array.isArray(batches) || !batches.length) {
    return false;
  }
  let rewarmed = false;
  for (const batch of batches) {
    if (batch?.deferredNeighborProjectionRewarm !== true) {
      continue;
    }
    const rewarmSucceeded = editor.textureAirbrushRewarmNeighborResetProjection?.(
      screenStrokeBatchEvent(batch)
    ) === true;
    batch.deferredNeighborProjectionRewarm = false;
    if (!rewarmSucceeded || editor.textureAirbrushNeighborProjectionDirty === true) {
      continue;
    }
    batch.neighborProjectionRewarmed = true;
    batch.postCameraProjectionRewarmed = true;
    if (batch.deferredPostCameraProjectionAccumulates === true) {
      batch.postCameraProjectionAccumulates = true;
      editor.textureAirbrushPostCameraProjectionStrokeAccumulateActive = true;
    }
    editor.textureAirbrushNeighborProjectionStrokeRewarmedActive = true;
    editor.textureAirbrushPostCameraProjectionStrokeRewarmedActive = true;
    rewarmed = true;
  }
  return rewarmed;
}

function resolveDeferredNeighborPaintSeeds(editor = null, batches = []) {
  if (!editor || !Array.isArray(batches) || !batches.length) {
    return false;
  }
  let resolved = false;
  for (const batch of batches) {
    if (batch?.deferredNeighborPaintSeed !== true) {
      continue;
    }
    const currentSeed = editor.textureAirbrushActiveNeighborPaintSeed || null;
    let seed = batch.strokeReset === true || !currentSeed?.enabled
      ? null
      : currentSeed;
    if (!seed?.enabled) {
      for (const event of screenStrokeBatchSeedEvents(batch)) {
        seed = editor.textureAirbrushBeginNeighborPaintStroke?.(
          event,
          batch.erase === true ? "texture-eraser" : "airbrush"
        ) || null;
        if (seed?.enabled) {
          break;
        }
      }
    }
    batch.deferredNeighborPaintSeed = false;
    if (!seed?.enabled) {
      continue;
    }
    batch.neighborPaintSeed = seed;
    batch.neighborPaintKey = editor.textureAirbrushNeighborSeedKey?.(seed)
      || seed.key
      || "neighbor";
    resolved = true;
  }
  return resolved;
}

function splitLiveStrokeBatches(batches = [], maxSegments = TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS, options = {}) {
  const split = [];
  for (const batch of batches) {
    const segments = batch?.strokeSegments || [];
    const screenProjectedSegments = Array.isArray(batch?.options?.screenProjectedStrokeSegments)
      ? batch.options.screenProjectedStrokeSegments
      : [];
    const segmentLimit = batch?.continuousStrokePath === true && options.splitContinuousPath !== true
      ? TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
      : Math.max(1, Math.min(
          TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
          Math.floor(Number(maxSegments) || TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS)
        ));
    if (segments.length <= segmentLimit) {
      split.push(screenProjectedSegments.length > segmentLimit && options.splitContinuousPath === true
        ? {
            ...batch,
            options: {
              ...(batch.options || {}),
              screenProjectedStrokeSegments: screenProjectedSegments.slice(-segmentLimit)
            }
          }
        : batch);
      continue;
    }
    for (let index = 0; index < segments.length; index += segmentLimit) {
      const segmentSlice = segments.slice(index, index + segmentLimit);
      const screenStart = screenProjectedSegments.length
        ? Math.floor((index / Math.max(1, segments.length)) * screenProjectedSegments.length)
        : 0;
      const screenEnd = screenProjectedSegments.length
        ? Math.max(
            screenStart + 1,
            Math.ceil(((index + segmentSlice.length) / Math.max(1, segments.length)) * screenProjectedSegments.length)
          )
        : 0;
      split.push({
        ...batch,
        strokeReset: batch.strokeReset === true && index === 0,
        strokeSegments: segmentSlice,
        options: {
          ...(batch.options || {}),
          strokeSegments: segmentSlice,
          ...(screenProjectedSegments.length
            ? { screenProjectedStrokeSegments: screenProjectedSegments.slice(screenStart, screenEnd) }
            : {})
        }
      });
    }
  }
  return split;
}

function splitLongScreenStrokeSegment(segment = null, maxLengthPixels = TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_SCREEN_SEGMENT_PIXELS) {
  const start = finiteClientPoint(segment?.start);
  const end = finiteClientPoint(segment?.end);
  if (!start || !end) {
    return [];
  }
  const maxLength = Math.max(2, Number(maxLengthPixels) || TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_SCREEN_SEGMENT_PIXELS);
  const distance = Math.sqrt(clientDistanceSqValues(start.clientX, start.clientY, end.clientX, end.clientY));
  const pieces = Math.max(1, Math.min(TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS, Math.ceil(distance / maxLength)));
  if (pieces <= 1) {
    return [segment];
  }
  const output = [];
  for (let index = 0; index < pieces; index += 1) {
    const startRatio = index / pieces;
    const endRatio = (index + 1) / pieces;
    output.push({
      ...segment,
      start: {
        clientX: start.clientX + (end.clientX - start.clientX) * startRatio,
        clientY: start.clientY + (end.clientY - start.clientY) * startRatio
      },
      end: {
        clientX: start.clientX + (end.clientX - start.clientX) * endRatio,
        clientY: start.clientY + (end.clientY - start.clientY) * endRatio
      }
    });
  }
  return output;
}

function splitLongScreenStrokeBatches(batches = [], maxLengthPixels = TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_SCREEN_SEGMENT_PIXELS) {
  return (Array.isArray(batches) ? batches : []).flatMap((batch) => {
    const segments = (batch?.strokeSegments || [])
      .flatMap((segment) => splitLongScreenStrokeSegment(segment, maxLengthPixels));
    if (!segments.length) {
      return [];
    }
    return splitStrokeBatch({
      ...batch,
      strokeSegments: segments
    });
  });
}

function quadraticClientPoint(start = null, control = null, end = null, t = 0) {
  const amount = Math.max(0, Math.min(1, Number(t) || 0));
  const inverse = 1 - amount;
  return {
    clientX: inverse * inverse * start.clientX
      + 2 * inverse * amount * control.clientX
      + amount * amount * end.clientX,
    clientY: inverse * inverse * start.clientY
      + 2 * inverse * amount * control.clientY
      + amount * amount * end.clientY
  };
}

function midpointClientPoint(left = null, right = null) {
  return {
    clientX: (left.clientX + right.clientX) * 0.5,
    clientY: (left.clientY + right.clientY) * 0.5
  };
}

function clientSegmentDistance(left = null, right = null) {
  return Math.sqrt(clientDistanceSqValues(
    left?.clientX || 0,
    left?.clientY || 0,
    right?.clientX || 0,
    right?.clientY || 0
  ));
}

function continuousStrokeSmoothStepPixels(batch = null) {
  const radius = Math.max(1, Number(batch?.radiusPixels) || 1);
  const spacingPercent = Math.max(0.1, Math.min(200, Number(batch?.spacing ?? 1)));
  if (spacingPercent <= 10) {
    return radius <= 10
      ? Math.max(6, Math.min(8, radius))
      : Math.max(4, Math.min(6, radius * 0.28));
  }
  return Math.max(2, Math.min(8, radius * 0.22));
}

function connectedStrokeSegmentRuns(segments = [], radiusPixels = 1) {
  const runs = [];
  let active = null;
  const tolerance = Math.max(1.5, Math.min(8, Math.max(1, Number(radiusPixels) || 1) * 0.2));
  const toleranceSq = tolerance * tolerance;
  for (const segment of segments) {
    const start = finiteClientPoint(segment?.start);
    const end = finiteClientPoint(segment?.end);
    if (!start || !end) {
      continue;
    }
    if (
      !active
      || clientDistanceSqValues(
        active.points.at(-1).clientX,
        active.points.at(-1).clientY,
        start.clientX,
        start.clientY
      ) > toleranceSq
    ) {
      active = {
        points: [start, end],
        segments: [segment]
      };
      runs.push(active);
      continue;
    }
    active.points.push(end);
    active.segments.push(segment);
  }
  return runs;
}

function clientPointKey(point = null) {
  const clientPoint = finiteClientPoint(point);
  if (!clientPoint) {
    return "";
  }
  return `${Math.round(clientPoint.clientX * 1000)}:${Math.round(clientPoint.clientY * 1000)}`;
}

function collapseCumulativeContinuousStrokeSegments(segments = []) {
  if (!Array.isArray(segments) || segments.length < 2) {
    return Array.isArray(segments) ? segments : [];
  }
  const output = [];
  const seen = new Set();
  for (const segment of segments) {
    const start = finiteClientPoint(segment?.start);
    const end = finiteClientPoint(segment?.end);
    if (!start || !end) {
      continue;
    }
    const key = `${clientPointKey(start)}>${clientPointKey(end)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({
      ...segment,
      start,
      end
    });
  }
  return output;
}

function strokeRunNeedsQuadraticSmoothing(points = [], radiusPixels = 1) {
  if (!Array.isArray(points) || points.length < 3) {
    return false;
  }
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const bendTolerance = Math.max(0.4, Math.min(2.5, radius * 0.08));
  const bendToleranceSq = bendTolerance * bendTolerance;
  for (let index = 1; index < points.length - 1; index += 1) {
    if (
      clientPointToSegmentDistanceSqValues(
        points[index].clientX,
        points[index].clientY,
        points[index - 1].clientX,
        points[index - 1].clientY,
        points[index + 1].clientX,
        points[index + 1].clientY
      ) > bendToleranceSq
    ) {
      return true;
    }
  }
  return false;
}

function pushSmoothedStrokeSegment(output = [], start = null, end = null, sourceSegment = null) {
  if (!finiteClientPointLike(start) || !finiteClientPointLike(end)) {
    return false;
  }
  if (clientDistanceSqValues(start.clientX, start.clientY, end.clientX, end.clientY) <= 0.000001) {
    return false;
  }
  const radiusPixels = Number(sourceSegment?.radiusPixels);
  output.push({
    start: { clientX: start.clientX, clientY: start.clientY },
    end: { clientX: end.clientX, clientY: end.clientY },
    ...(Number.isFinite(radiusPixels) && radiusPixels > 0 ? { radiusPixels } : {})
  });
  return true;
}

function smoothQuadraticStrokeRun(run = null, batch = null, remainingBudget = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
  const points = Array.isArray(run?.points) ? run.points : [];
  const sourceSegments = Array.isArray(run?.segments) ? run.segments : [];
  const radiusPixels = Math.max(1, Number(batch?.radiusPixels) || 1);
  if (
    points.length < 3
    || remainingBudget <= sourceSegments.length
    || !strokeRunNeedsQuadraticSmoothing(points, radiusPixels)
  ) {
    return sourceSegments.slice(0, Math.max(0, remainingBudget));
  }
  const stepPixels = continuousStrokeSmoothStepPixels(batch);
  const output = [];
  let cursor = points[0];
  for (let index = 1; index < points.length && output.length < remainingBudget; index += 1) {
    const control = points[index];
    const end = index < points.length - 1
      ? midpointClientPoint(points[index], points[index + 1])
      : points[index];
    const curveDistance = Math.max(
      clientSegmentDistance(cursor, control) + clientSegmentDistance(control, end),
      clientSegmentDistance(cursor, end)
    );
    const pieces = Math.max(
      1,
      Math.min(
        Math.max(1, remainingBudget - output.length),
        Math.ceil(curveDistance / stepPixels)
      )
    );
    let previous = cursor;
    for (let piece = 1; piece <= pieces && output.length < remainingBudget; piece += 1) {
      const point = quadraticClientPoint(cursor, control, end, piece / pieces);
      const sourceSegment = sourceSegments[Math.min(index - 1, sourceSegments.length - 1)] || null;
      pushSmoothedStrokeSegment(output, previous, point, sourceSegment);
      previous = point;
    }
    cursor = end;
  }
  return output.length >= sourceSegments.length
    ? output
    : sourceSegments.slice(0, Math.max(0, remainingBudget));
}

function smoothContinuousScreenStrokeBatch(batch = null) {
  if (
    !batch
    || batch.erase === true
    || batch.preSmoothedStrokePath === true
    || Math.max(0.1, Math.min(200, Number(batch.spacing ?? 1))) > 100
    || !Array.isArray(batch.strokeSegments)
    || batch.strokeSegments.length < 2
  ) {
    return batch;
  }
  const strokeSegments = collapseCumulativeContinuousStrokeSegments(batch.strokeSegments);
  const collapsedBatch = strokeSegments.length !== batch.strokeSegments.length
    ? {
        ...batch,
        strokeSegments
      }
    : batch;
  const runs = connectedStrokeSegmentRuns(strokeSegments, collapsedBatch.radiusPixels);
  if (!runs.some((run) => strokeRunNeedsQuadraticSmoothing(run.points, batch.radiusPixels))) {
    return collapsedBatch;
  }
  const smoothed = [];
  for (const run of runs) {
    if (smoothed.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
      break;
    }
    smoothed.push(...smoothQuadraticStrokeRun(
      run,
      batch,
      TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS - smoothed.length
    ));
  }
  return smoothed.length > strokeSegments.length
    ? {
        ...collapsedBatch,
        strokeSegments: smoothed
      }
    : collapsedBatch;
}

function smoothContinuousScreenStrokeBatches(batches = []) {
  return (Array.isArray(batches) ? batches : []).map(smoothContinuousScreenStrokeBatch);
}

function maxBatchRadiusPixels(batches = []) {
  let radius = 1;
  for (const batch of batches) {
    const batchRadius = Math.max(1, Number(batch?.radiusPixels) || 1);
    radius = Math.max(radius, batchRadius);
  }
  return radius;
}

function adaptiveLiveSegmentBudget(batches = [], baseBudget = TEXTURE_AIRBRUSH_LIVE_MAX_SEGMENTS) {
  const radius = maxBatchRadiusPixels(batches);
  const scale = Math.max(1, TEXTURE_AIRBRUSH_LIVE_BUDGET_REFERENCE_RADIUS / Math.max(1, radius));
  return Math.max(
    baseBudget,
    Math.min(
      TEXTURE_AIRBRUSH_LIVE_MAX_ADAPTIVE_SEGMENTS,
      Math.round(baseBudget * scale * scale)
    )
  );
}

function adaptiveLiveBatchSegmentBudget(batches = []) {
  const radius = maxBatchRadiusPixels(batches);
  const scale = Math.max(1, TEXTURE_AIRBRUSH_LIVE_BUDGET_REFERENCE_RADIUS / Math.max(1, radius));
  return Math.max(
    TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS,
    Math.min(
      TEXTURE_AIRBRUSH_LIVE_MAX_ADAPTIVE_BATCH_SEGMENTS,
      Math.round(TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS * scale * scale)
    )
  );
}

function continuousPayloadSpacing(payload = null) {
  return Math.max(0.1, Math.min(200, Number(payload?.spacing ?? 1))) <= 100;
}

function variableRadiusPayload(payload = null) {
  return payload?.erase !== true
    && payload.pressureRadius === true
    && payload.pressurePointer !== false
    && continuousPayloadSpacing(payload);
}

function payloadRadiusStyleKey(payload = null, radiusPixels = 1) {
  return variableRadiusPayload(payload)
    ? "variable-radius"
    : Math.round(quantizedBrushRadiusPixels(radiusPixels) * 100);
}

function pressureRadiusStyleChanged(previous = null, next = null) {
  if (!variableRadiusPayload(previous) && !variableRadiusPayload(next)) {
    return false;
  }
  const previousRadius = Math.max(1, Number(previous?.radiusPixels) || 1);
  const nextRadius = Math.max(1, Number(next?.radiusPixels) || 1);
  const baseRadius = Math.max(previousRadius, nextRadius);
  return Math.abs(nextRadius - previousRadius) >= pressureRadiusThreshold(baseRadius);
}

function layerMutationSerial(value = 0) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function payloadStyleKey(payload = null) {
  if (!payload) {
    return "";
  }
  if (payload.styleKey) {
    return payload.styleKey;
  }
  const color = payload.color || {};
  const radiusPixels = quantizedBrushRadiusPixels(payload.radiusPixels);
  const visibleEdgeMode = payload.visibleEdgeMode === "hard" ? "hard" : "soft";
  return [
    payloadRadiusStyleKey(payload, radiusPixels),
    clampByte(color.r),
    clampByte(color.g),
    clampByte(color.b),
    Math.round(quantizedBrushOpacity(payload.opacity ?? 1) * 1000),
    Math.round(Math.max(0, Math.min(1, Number(payload.hardness ?? 0))) * 1000),
    Math.round(Math.max(0, Math.min(1, Number(payload.scatter ?? 0))) * 1000),
    Math.round(Math.max(0.08, Math.min(1, Number(payload.strength ?? 1))) * 1000),
    payload.erase === true ? "erase" : "paint",
    visibleEdgeMode,
    payload.layerMode === true ? "layer" : "texture",
    payload.layerMode === true ? layerMutationSerial(payload.layerMutationSerial) : 0,
    payload.neighborPaintKey || "all"
  ].join(":");
}

function payloadContinuousPathKey(payload = null) {
  return [
    payloadStyleKey(payload),
    payload?.neighborPaintKey || "all",
    payload?.neighborPaintSeed?.enabled === true ? "neighbor" : "no-neighbor",
    payload?.deferredNeighborPaintSeed === true ? "deferred-neighbor" : "resolved-neighbor"
  ].join("|");
}

function payloadBrushStyle(payload = null, fallbacks = {}) {
  const color = payload?.color || fallbacks.color || {};
  const radiusPixels = quantizedBrushRadiusPixels(
    Math.max(1, Number(payload?.radiusPixels ?? fallbacks.radiusPixels) || 1)
  );
  const colorBytes = {
    r: clampByte(color.r),
    g: clampByte(color.g),
    b: clampByte(color.b)
  };
  const opacity = quantizedBrushOpacity(payload?.opacity ?? fallbacks.opacity ?? 1);
  const hardness = Math.max(0, Math.min(1, Number(payload?.hardness ?? fallbacks.hardness ?? 0)));
  const scatter = Math.max(0, Math.min(1, Number(payload?.scatter ?? fallbacks.scatter ?? 0)));
  const strength = Math.max(0.08, Math.min(1, Number(payload?.strength ?? fallbacks.strength ?? 1)));
  const visibleEdgeMode = (payload?.visibleEdgeMode || fallbacks.visibleEdgeMode) === "hard" ? "hard" : "soft";
  return {
    styleKey: [
      payloadRadiusStyleKey(payload, radiusPixels),
      colorBytes.r,
      colorBytes.g,
      colorBytes.b,
      Math.round(opacity * 1000),
      Math.round(hardness * 1000),
      Math.round(scatter * 1000),
      Math.round(strength * 1000),
      payload?.erase === true ? "erase" : "paint",
      visibleEdgeMode,
      payload?.layerMode === true ? "layer" : "texture",
      payload?.layerMode === true ? layerMutationSerial(payload?.layerMutationSerial) : 0,
      payload?.neighborPaintKey || "all"
    ].join(":"),
    radiusPixels,
    color: colorBytes,
    opacity,
    hardness,
    scatter,
    visibleEdgeMode,
    strength
  };
}

function layerStrokeWorkIsCurrent(work = null, currentSerial = 0) {
  return work?.layerMode !== true || layerMutationSerial(work.layerMutationSerial) === layerMutationSerial(currentSerial);
}

function webGpuLiveScreenPreviewEnabled(editor = null, payload = null) {
  return payload?.erase !== true
    && payload?.layerMode !== true
    && editor?.textureAirbrushWebGpuScreenPreviewEnabled === true
    && typeof editor?.drawTextureAirbrushScreenStrokePreview === "function"
    && typeof editor?.textureAirbrushWebGpuPaintFromEvent === "function"
    && Boolean(editor?.textureAirbrushWebGpuDevice?.());
}

function webGpuLiveScreenPreviewHasPendingPaint(editor = null) {
  return Boolean(
    editor?.textureAirbrushQueuedWebGpuStrokes?.length
    || editor?.textureAirbrushWebGpuFlushInFlight
    || editor?.textureAirbrushPendingWebGpuPaints?.size
  );
}

function webGpuLiveScreenStrokePending(editor = null) {
  if (
    !editor
    || typeof editor.textureAirbrushWebGpuPaintFromEvent !== "function"
    || !editor.textureAirbrushWebGpuDevice?.()
  ) {
    return false;
  }
  const hasPaintPayload = (payload = null) => payload?.erase !== true;
  return (editor.textureAirbrushScreenStrokeQueue || []).some(hasPaintPayload)
    || (editor.textureAirbrushPendingScreenStrokeBatches || []).some(hasPaintPayload);
}

function webGpuLiveScreenStrokeActive(editor = null) {
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

function webGpuLivePayloadRadiusPixels(payload = null) {
  const radius = Number(payload?.radiusPixels);
  return Number.isFinite(radius) ? Math.max(1, radius) : 0;
}

function webGpuLivePendingRadiusPixels(editor = null) {
  if (!editor) {
    return 0;
  }
  let radiusPixels = 0;
  const collect = (payload = null) => {
    if (!payload || payload.erase === true) {
      return;
    }
    radiusPixels = Math.max(radiusPixels, webGpuLivePayloadRadiusPixels(payload));
  };
  (editor.textureAirbrushScreenStrokeQueue || []).forEach(collect);
  (editor.textureAirbrushPendingScreenStrokeBatches || []).forEach(collect);
  return radiusPixels;
}

function webGpuLiveFlushIntervalMs(baseMs = 0, radiusPixels = 0) {
  const base = Math.max(0, Number(baseMs) || 0);
  void radiusPixels;
  // Large WebGPU brushes already paint bounded dirty UV regions with conservative
  // batch sizes. Do not add the old radius-scaled 80-120ms delay here; it makes
  // the brush visibly trail the pointer even when the GPU work is ready.
  return base;
}

function largeLiveWebGpuPayload(payload = null) {
  return webGpuLivePayloadRadiusPixels(payload) >= TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_BRUSH_MIN_RADIUS_PIXELS;
}

function largeDirectWebGpuResetFootprintPayload(payload = null) {
  return Boolean(
    payload?.strokeReset === true
    && payload.erase !== true
    && payload.layerMode !== true
    && continuousPayloadSpacing(payload)
    && largeLiveWebGpuPayload(payload)
  );
}

function largeLiveWebGpuNeighborPayload(payload = null) {
  return Boolean(
    payload
    && payload.erase !== true
    && largeLiveWebGpuPayload(payload)
    && (
      payload.neighborPaintSeed?.enabled === true
      || payload.deferredNeighborPaintSeed === true
      || payload.neighborPaintKey
    )
  );
}

function largeLiveWebGpuNeighborPending(editor = null) {
  if (!editor) {
    return false;
  }
  const hasLargeNeighbor = (entry = null) => largeLiveWebGpuNeighborPayload(entry);
  return (editor.textureAirbrushScreenStrokeQueue || []).some(hasLargeNeighbor)
    || (editor.textureAirbrushPendingScreenStrokeBatches || []).some(hasLargeNeighbor);
}

function largeLiveWebGpuPending(editor = null) {
  if (!editor) {
    return false;
  }
  const hasLarge = (entry = null) => largeLiveWebGpuPayload(entry);
  return (editor.textureAirbrushScreenStrokeQueue || []).some(hasLarge)
    || (editor.textureAirbrushPendingScreenStrokeBatches || []).some(hasLarge);
}

function compactLargeLiveWebGpuScreenQueue(queue = [], maxPayloads = TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_QUEUED_PAYLOADS) {
  if (!Array.isArray(queue) || queue.length <= maxPayloads) {
    return 0;
  }
  let startIndex = queue.length;
  while (startIndex > 0 && largeLiveWebGpuPayload(queue[startIndex - 1])) {
    startIndex -= 1;
  }
  const prefix = queue.slice(0, startIndex);
  const suffix = queue.slice(startIndex);
  const limit = Math.max(2, Math.floor(Number(maxPayloads) || 2));
  if (suffix.length <= limit) {
    return 0;
  }
  const kept = [];
  const seen = new Set();
  const addIndex = (index) => {
    const clamped = Math.max(0, Math.min(suffix.length - 1, Math.round(index)));
    if (seen.has(clamped)) {
      return;
    }
    seen.add(clamped);
    kept.push(suffix[clamped]);
  };
  addIndex(0);
  addIndex(suffix.length - 1);
  for (let index = 1; kept.length < limit && index < limit - 1; index += 1) {
    addIndex((index / Math.max(1, limit - 1)) * (suffix.length - 1));
  }
  for (let index = 0; kept.length < limit && index < suffix.length; index += 1) {
    addIndex(index);
  }
  kept.sort((left, right) => suffix.indexOf(left) - suffix.indexOf(right));
  queue.splice(0, queue.length, ...prefix, ...kept);
  return suffix.length - kept.length;
}

function screenPayloadDistanceSq(payload = null) {
  if (
    !Number.isFinite(payload?.clientX)
    || !Number.isFinite(payload?.clientY)
    || !Number.isFinite(payload?.strokeStart?.clientX)
    || !Number.isFinite(payload?.strokeStart?.clientY)
  ) {
    return Infinity;
  }
  return clientDistanceSqValues(
    payload.strokeStart.clientX,
    payload.strokeStart.clientY,
    payload.clientX,
    payload.clientY
  );
}

function webGpuLiveImmediateScreenFlushEnabled(editor = null, payload = null) {
  const resetFlush = payload?.strokeReset === true
    && editor?.textureAirbrushImmediateWebGpuScreenFlush !== false;
  const continuationFlush = payload?.strokeReset !== true
    && editor?.textureAirbrushImmediateWebGpuScreenFlush !== false;
  if (
    !payload
    || payload.erase === true
    || (!resetFlush && !continuationFlush)
    || editor?.textureAirbrushFlushingScreenStroke
    || typeof editor?.flushTextureAirbrushScreenStroke !== "function"
    || typeof editor?.textureAirbrushWebGpuPaintFromEvent !== "function"
    || (payload.strokeReset === true && largeDirectWebGpuResetFootprintPayload(payload))
    || !editor?.textureAirbrushWebGpuDevice?.()
  ) {
    return false;
  }
  if (editor?.textureAirbrushScreenFlushScheduled && payload.strokeReset !== true) {
    return false;
  }
  const configuredMinIntervalMs = Number(editor?.textureAirbrushImmediateWebGpuScreenFlushMinMs);
  const minIntervalMs = Number.isFinite(configuredMinIntervalMs)
    ? Math.max(0, configuredMinIntervalMs)
    : payload.strokeReset !== true && largeLiveWebGpuPayload(payload)
      ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_CONTINUATION_COALESCE_MS
      : webGpuLiveFlushIntervalMs(
          payload.neighborPaintSeed?.enabled === true
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_NEIGHBOR_IMMEDIATE_MIN_MS
            : TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MIN_MS,
          webGpuLivePayloadRadiusPixels(payload)
        );
  const previousFlushMs = Number(editor?.textureAirbrushLastImmediateWebGpuScreenFlushMs) || 0;
  if (payload.strokeReset !== true && previousFlushMs && currentTimeMs() - previousFlushMs < minIntervalMs) {
    return false;
  }
  return true;
}

function webGpuLiveDirectScreenFlushReady(editor = null, payload = null) {
  if (!editor || !payload) {
    return false;
  }
  if (payload.strokeReset === true) {
    return editor.textureAirbrushImmediateWebGpuScreenFlushUsed !== true;
  }
  const configured = Number(editor.textureAirbrushLiveWebGpuDirectFlushMinPayloads);
  const queuedPayloads = (editor.textureAirbrushScreenStrokeQueue || []).length
    + (editor.textureAirbrushPendingScreenStrokeBatches || []).length;
  if (!Number.isFinite(configured)) {
    return payload.layerMode !== true && queuedPayloads > 0;
  }
  const minPayloads = Math.max(1, Math.floor(configured));
  return queuedPayloads >= minPayloads;
}

function layerTargetEffectivelyEmpty(layer = null) {
  if (!layer) {
    return true;
  }
  if (
    layer.texturePaintGpuPainted === true
    || layer.texturePaintHasPaint === true
    || layer.gpuTarget?.texturePaintLayerHasPaint === true
  ) {
    return false;
  }
  if (layer.isEmpty === true && layer.gpuTarget?.emptyTransparent !== false) {
    return true;
  }
  if (layer.gpuTarget?.emptyTransparent === true) {
    return true;
  }
  if (layer.gpuTarget?.emptyTransparent === false) {
    return false;
  }
  return Math.max(0, Math.floor(Number(layer.gpuTarget?.paintRevision) || 0)) <= 0
    && layer.isEmpty !== false;
}

function layerResetPaintWorkIsCurrent(work = null, currentSerial = 0) {
  return work?.layerMode === true
    && work.erase !== true
    && work.strokeReset === true
    && layerStrokeWorkIsCurrent(work, currentSerial);
}

function currentLayerResetPaintWork(editor = null) {
  const currentSerial = editor?.texturePaintLayerMutationSerialValue?.() ?? 0;
  return (editor?.textureAirbrushScreenStrokeQueue || []).find((segment) => layerResetPaintWorkIsCurrent(segment, currentSerial))
    || (editor?.textureAirbrushPendingScreenStrokeBatches || []).find((batch) => layerResetPaintWorkIsCurrent(batch, currentSerial))
    || null;
}

function layerProjectionPassIsWarm(editor = null, frame = null, pass = null) {
  const targetEntry = pass?.targetEntry || null;
  if (targetEntry?.layerMode !== true || !targetEntry.target?.texture) {
    return false;
  }
  const sourceWarm = layerTargetEffectivelyEmpty(targetEntry.layer)
    || editor?.texturePaintGpuPrewarmSnapshotCurrent?.(targetEntry) === true;
  const proxyWarm = frame?.proxySceneCache?.has(pass.key) === true;
  return sourceWarm && proxyWarm;
}

function layerResetStrokeHasWarmProjection(editor = null, resetWork = null) {
  const frame = editor?.textureAirbrushLiveProjectionFrameState || null;
  if (!frame || editor?.textureAirbrushLiveProjectionFrameCurrent?.(frame) !== true) {
    return false;
  }
  const passCache = frame.paintPassCache;
  if (!passCache?.size) {
    return false;
  }
  const layerPasses = [...passCache.values()].filter((pass) => (
    pass?.targetEntry?.layerMode === true && pass.targetEntry.target?.texture
  ));
  if (!layerPasses.length) {
    return false;
  }
  if (frame.paintPassCacheSeeded === true && frame.seedPaintPasses !== false) {
    return layerPasses.every((pass) => layerProjectionPassIsWarm(editor, frame, pass));
  }
  const resetPaintWork = resetWork || currentLayerResetPaintWork(editor);
  const resetPoint = probePointForLayerResetWork(resetPaintWork, frame.rect);
  if (!resetPoint || !frame.probePaintPassCache) {
    return false;
  }
  if (editor?.textureAirbrushCachedLayerStartProbeReady?.(resetPaintWork, { allowFlushing: true }) !== true) {
    return false;
  }
  const probePasses = (frame.probePaintPassCache.get(`${resetPoint.x}:${resetPoint.y}`) || [])
    .filter((pass) => pass?.targetEntry?.layerMode === true);
  if (!probePasses.length) {
    return false;
  }
  return probePasses.every((pass) => layerProjectionPassIsWarm(editor, frame, pass));
}

function warmLayerProjectionPasses(editor = null, frame = null) {
  const passCache = frame?.paintPassCache;
  if (!passCache?.size) {
    return [];
  }
  return [...passCache.values()].filter((pass) => layerProjectionPassIsWarm(editor, frame, pass));
}

function lowSpacingCachedPassStroke(batch = null) {
  const spacingPercent = Math.max(0.1, Math.min(200, Number(batch?.spacing ?? 1)));
  return spacingPercent <= 10;
}

function layerCachedContinuousPassesReady(editor = null, frame = null, batch = null) {
  if (
    !lowSpacingCachedPassStroke(batch)
    || !frame?.paintPassCache?.size
  ) {
    return false;
  }
  const layerPasses = [...frame.paintPassCache.values()].filter((pass) => (
    pass?.targetEntry?.layerMode === true && pass.targetEntry.target?.texture
  ));
  if (!layerPasses.length) {
    return false;
  }
  const warmPasses = warmLayerProjectionPasses(editor, frame);
  if (!layerPasses.every((pass) => warmPasses.includes(pass))) {
    return false;
  }
  if (frame.paintPassCacheSeeded === true && frame.seedPaintPasses !== false) {
    return true;
  }
  return frame.seedPaintPasses === false && warmPasses.length === layerPasses.length;
}

function paintMaterialSlotCount(record = null) {
  const material = record?.object?.material;
  if (Array.isArray(material)) {
    return material.filter(Boolean).length;
  }
  return material ? 1 : 0;
}

function partialLayerFrameNeedsPaintPassDiscovery(frame = null) {
  if (
    !frame?.paintPassCache?.size
    || frame.paintPassCacheSeeded === true
    || frame.seedPaintPasses !== false
  ) {
    return false;
  }
  const layerPassCount = [...frame.paintPassCache.values()]
    .filter((pass) => pass?.targetEntry?.layerMode === true).length;
  if (!layerPassCount) {
    return false;
  }
  const paintableSlots = (frame.paintRecords || [])
    .reduce((total, record) => total + paintMaterialSlotCount(record), 0);
  return paintableSlots > layerPassCount;
}

function layerBatchesCanUseSeededProjectionFrame(editor = null, batches = []) {
  if (
    !batches.some((batch) => batch?.layerMode === true && batch.erase !== true && lowSpacingCachedPassStroke(batch))
    || typeof editor?.textureAirbrushLayerPrewarmNeeded !== "function"
  ) {
    return false;
  }
  return editor.textureAirbrushLayerPrewarmNeeded(null, { all: true }) !== true;
}

function layerResetTargetReadyForBackgroundBudget(editor = null, batch = null) {
  const material = preferredLayerResetMaterial(editor);
  const targetReady = typeof editor?.textureAirbrushLayerTargetReadyForLiveReset === "function"
    ? editor.textureAirbrushLayerTargetReadyForLiveReset(material)
    : editor?.textureAirbrushLayerPaintTargetReadyForLiveReset?.(material);
  return Boolean(
    batch?.layerMode === true
    && batch.erase !== true
    && batch.strokeReset === true
    && lowSpacingCachedPassStroke(batch)
    && targetReady === true
  );
}

function layerResetPaintTargetReadyForDisplayPrewarm(editor = null, batch = null) {
  const material = preferredLayerResetMaterial(editor);
  const targetReady = typeof editor?.textureAirbrushLayerPaintTargetReadyForLiveReset === "function"
    ? editor.textureAirbrushLayerPaintTargetReadyForLiveReset(material)
    : false;
  return Boolean(
    batch?.layerMode === true
    && batch.erase !== true
    && batch.strokeReset === true
    && lowSpacingCachedPassStroke(batch)
    && targetReady === true
  );
}

function preferredLayerResetMaterial(editor = null, material = null) {
  return editor?.textureAirbrushPreferredLayerMaterial?.(material)
    || material
    || editor?.texturePaintActiveMaterial
    || editor?.textureAirbrushFirstPaintableMaterial?.()?.material
    || null;
}

function layerResetEventForBatch(editor = null, batch = null, rect = null) {
  const resetPoint = probePointForLayerResetWork(batch, rect);
  if (resetPoint && rect) {
    return {
      clientX: (rect.left || 0) + resetPoint.x,
      clientY: (rect.top || 0) + resetPoint.y
    };
  }
  return batch?.strokeSegments?.[0]?.start || batch || null;
}

function seedReadyActiveLayerResetProjection(editor = null, batch = null) {
  if (
    !editor
    || batch?.layerMode !== true
    || batch.erase === true
    || batch.strokeReset !== true
    || !lowSpacingCachedPassStroke(batch)
    || !activeTexturePaintLayerMode(editor)
    || typeof editor.textureAirbrushLiveProjectionFrame !== "function"
    || typeof editor.textureAirbrushSeedProjectionFramePaintPass !== "function"
  ) {
    return false;
  }
  const activeMaterial = preferredLayerResetMaterial(editor);
  const targetReady = editor.textureAirbrushLayerTargetReadyForLiveReset?.(activeMaterial);
  if (!activeMaterial || targetReady !== true) {
    return null;
  }
  const paintable = (editor.textureAirbrushPaintableMaterials?.() || [])
    .find((candidate) => candidate?.material === activeMaterial);
  if (!paintable?.record) {
    return null;
  }
  const frame = editor.textureAirbrushLiveProjectionFrame({
    seedLayerProxies: false,
    seedPaintPasses: false
  });
  if (!frame?.paintPassCache || !frame.proxySceneCache) {
    return null;
  }
  const rect = frame.rect || editor.canvas?.getBoundingClientRect?.() || null;
  const resetPoint = probePointForLayerResetWork(batch, rect);
  const resetEvent = layerResetEventForBatch(editor, batch, rect);
  const pass = editor.textureAirbrushSeedProjectionFramePaintPass(
    frame,
    paintable.record,
    paintable.materialIndex || 0,
    activeMaterial,
    {
      event: resetEvent,
      seedLayerProxy: true,
      seedProbe: Boolean(resetPoint)
    }
  );
  return layerProjectionPassIsWarm(editor, frame, pass) ? frame : null;
}

function prewarmColdActiveLayerResetProjection(editor = null, batch = null) {
  if (
    !editor
    || batch?.layerMode !== true
    || batch.erase === true
    || batch.strokeReset !== true
    || !lowSpacingCachedPassStroke(batch)
    || !activeTexturePaintLayerMode(editor)
    || typeof editor.prewarmTextureAirbrushLayerResetStroke !== "function"
  ) {
    return null;
  }
  const activeMaterial = preferredLayerResetMaterial(editor);
  if (!activeMaterial) {
    return null;
  }
  const rect = editor.textureAirbrushLiveProjectionFrameState?.rect
    || editor.canvas?.getBoundingClientRect?.()
    || null;
  const resetEvent = layerResetEventForBatch(editor, batch, rect);
  if (editor.prewarmTextureAirbrushLayerResetStroke(resetEvent, activeMaterial) !== true) {
    return null;
  }
  const frame = editor.textureAirbrushLiveProjectionFrameState || null;
  if (
    frame
    && editor.textureAirbrushLiveProjectionFrameCurrent?.(frame) === true
    && layerResetStrokeHasWarmProjection(editor, batch)
  ) {
    return frame;
  }
  return seedReadyActiveLayerResetProjection(editor, batch);
}

function canCoalesceContinuousPayload(previous = null, next = null) {
  if (
    !finiteClientPointLike(previous?.strokeStart)
    || !finiteClientPointLike(previous)
    || !finiteClientPointLike(next?.strokeStart)
    || !finiteClientPointLike(next)
  ) {
    return false;
  }
  if (!continuousPayloadSpacing(previous) || !continuousPayloadSpacing(next)) {
    return false;
  }
  if (previous.preserveCurveSample === true || next.preserveCurveSample === true) {
    return false;
  }
  if (payloadStyleKey(previous) !== payloadStyleKey(next)) {
    return false;
  }
  if ((previous.strokeUndo || null) !== (next.strokeUndo || null)) {
    return false;
  }
  if (pressureRadiusStyleChanged(previous, next)) {
    return false;
  }
  const previousLengthSq = clientDistanceSqValues(
    previous.strokeStart.clientX,
    previous.strokeStart.clientY,
    previous.clientX,
    previous.clientY
  );
  const nextLengthSq = clientDistanceSqValues(
    next.strokeStart.clientX,
    next.strokeStart.clientY,
    next.clientX,
    next.clientY
  );
  if (previousLengthSq <= 0.000001 || nextLengthSq <= 0.000001) {
    return false;
  }
  const radius = Math.max(
    1,
    Number(previous.radiusPixels) || 1,
    Number(next.radiusPixels) || 1
  );
  const connectionTolerance = Math.max(1, Math.min(6, radius * 0.3));
  const connectionDistanceSq = clientDistanceSqValues(
    previous.clientX,
    previous.clientY,
    next.strokeStart.clientX,
    next.strokeStart.clientY
  );
  if (connectionDistanceSq > connectionTolerance * connectionTolerance) {
    return false;
  }
  const bendTolerance = Math.max(0.35, Math.min(4, radius * 0.12));
  const bendDistanceSq = clientPointToSegmentDistanceSqValues(
    previous.clientX,
    previous.clientY,
    previous.strokeStart.clientX,
    previous.strokeStart.clientY,
    next.clientX,
    next.clientY
  );
  const shouldLimitCoalescedLength = previous.pressureRadius !== true || radius <= 10;
  if (shouldLimitCoalescedLength && bendDistanceSq > 0.000001) {
    const maxCoalescedLength = Math.max(28, Math.min(160, radius * 6));
    const coalescedLengthSq = clientDistanceSqValues(
      previous.strokeStart.clientX,
      previous.strokeStart.clientY,
      next.clientX,
      next.clientY
    );
    if (coalescedLengthSq > maxCoalescedLength * maxCoalescedLength) {
      return false;
    }
  }
  return bendDistanceSq <= bendTolerance * bendTolerance;
}

function canCoalesceLargeLiveResetPayload(previous = null, next = null) {
  if (
    !largeDirectWebGpuResetFootprintPayload(previous)
    || !largeLiveWebGpuPayload(next)
    || next?.strokeReset === true
    || previous?.preserveCurveSample === true
    || next?.preserveCurveSample === true
    || !finiteClientPointLike(previous?.strokeStart)
    || !finiteClientPointLike(previous)
    || !finiteClientPointLike(next?.strokeStart)
    || !finiteClientPointLike(next)
  ) {
    return false;
  }
  if (!continuousPayloadSpacing(previous) || !continuousPayloadSpacing(next)) {
    return false;
  }
  if (payloadStyleKey(previous) !== payloadStyleKey(next)) {
    return false;
  }
  if ((previous.strokeUndo || null) !== (next.strokeUndo || null)) {
    return false;
  }
  if (pressureRadiusStyleChanged(previous, next)) {
    return false;
  }
  const radius = Math.max(
    1,
    Number(previous.radiusPixels) || 1,
    Number(next.radiusPixels) || 1
  );
  const resetDistanceSq = screenPayloadDistanceSq(previous);
  const resetTolerance = Math.max(1, Math.min(4, radius * 0.08));
  if (resetDistanceSq > resetTolerance * resetTolerance) {
    return false;
  }
  const connectionTolerance = Math.max(2, Math.min(12, radius * 0.3));
  if (
    clientDistanceSqValues(
      previous.clientX,
      previous.clientY,
      next.strokeStart.clientX,
      next.strokeStart.clientY
    ) > connectionTolerance * connectionTolerance
  ) {
    return false;
  }
  const coalescedDistanceSq = clientDistanceSqValues(
    previous.strokeStart.clientX,
    previous.strokeStart.clientY,
    next.clientX,
    next.clientY
  );
  const maxCoalescedLength = Math.max(24, Math.min(192, radius * 4));
  return coalescedDistanceSq <= maxCoalescedLength * maxCoalescedLength;
}

function mergeCoalescedScreenStrokePayload(previous = null, next = null) {
  if (!previous || !next) {
    return false;
  }
  const nextContinuousPoints = continuousStrokePointsForPayload(next);
  if (nextContinuousPoints.length >= 2) {
    applyContinuousStrokePointsToPayload(previous, nextContinuousPoints);
  } else {
    rememberPayloadCurvePoints(previous, payloadCurvePoints(next));
  }
  previous.clientX = next.clientX;
  previous.clientY = next.clientY;
  applyClientPointSurfaceAnchor(previous, next);
  previous.preSmoothedStrokePath = previous.preSmoothedStrokePath === true
    || next.preSmoothedStrokePath === true;
  if (Number.isFinite(Number(next.continuousStrokePathSerial))) {
    previous.continuousStrokePathSerial = Math.floor(Number(next.continuousStrokePathSerial));
  }
  if (Number.isFinite(Number(next.continuousStrokePathRevision))) {
    previous.continuousStrokePathRevision = Math.max(
      Math.floor(Number(previous.continuousStrokePathRevision)) || 0,
      Math.floor(Number(next.continuousStrokePathRevision))
    );
  }
  previous.strokeStartedWithReset = previous.strokeStartedWithReset === true
    || next.strokeStartedWithReset === true
    || previous.strokeReset === true
    || next.strokeReset === true;
  previous.layerCachedStartContinuation = previous.layerCachedStartContinuation === true
    || next.layerCachedStartContinuation === true;
  previous.resetFootprintContinuation = previous.resetFootprintContinuation === true
    || next.resetFootprintContinuation === true;
  previous.neighborProjectionRewarmed = previous.neighborProjectionRewarmed === true
    || next.neighborProjectionRewarmed === true;
  previous.postCameraProjectionRewarmed = previous.postCameraProjectionRewarmed === true
    || next.postCameraProjectionRewarmed === true
    || previous.neighborProjectionRewarmed === true;
  previous.postCameraProjectionAccumulates = previous.postCameraProjectionAccumulates === true
    || next.postCameraProjectionAccumulates === true;
  previous.deferredNeighborProjectionRewarm = previous.deferredNeighborProjectionRewarm === true
    || next.deferredNeighborProjectionRewarm === true;
  previous.deferredNeighborPaintSeed = previous.deferredNeighborPaintSeed === true
    || next.deferredNeighborPaintSeed === true;
  previous.deferredPostCameraProjectionAccumulates = previous.deferredPostCameraProjectionAccumulates === true
    || next.deferredPostCameraProjectionAccumulates === true;
  previous.webGpuLiveNeighborProjectionCurrent = previous.webGpuLiveNeighborProjectionCurrent === true
    || next.webGpuLiveNeighborProjectionCurrent === true;
  if (!previous.neighborPaintSeed?.enabled && next.neighborPaintSeed?.enabled) {
    previous.neighborPaintSeed = next.neighborPaintSeed;
  }
  if (!previous.neighborPaintKey && next.neighborPaintKey) {
    previous.neighborPaintKey = next.neighborPaintKey;
  }
  return true;
}

function canRetargetContinuousPayload(previous = null, current = null, start = null) {
  if (
    !finiteClientPointLike(previous?.strokeStart)
    || !finiteClientPointLike(previous)
    || !finiteClientPointLike(current)
    || !finiteClientPointLike(start)
  ) {
    return false;
  }
  if (!continuousPayloadSpacing(previous)) {
    return false;
  }
  const previousLengthSq = clientDistanceSqValues(
    previous.strokeStart.clientX,
    previous.strokeStart.clientY,
    previous.clientX,
    previous.clientY
  );
  const nextLengthSq = clientDistanceSqValues(
    start.clientX,
    start.clientY,
    current.clientX,
    current.clientY
  );
  if (previousLengthSq <= 0.000001 || nextLengthSq <= 0.000001) {
    return false;
  }
  const radius = Math.max(1, Number(previous.radiusPixels) || 1);
  const connectionTolerance = Math.max(1, Math.min(6, radius * 0.3));
  const connectionDistanceSq = clientDistanceSqValues(
    previous.clientX,
    previous.clientY,
    start.clientX,
    start.clientY
  );
  if (connectionDistanceSq > connectionTolerance * connectionTolerance) {
    return false;
  }
  const bendTolerance = Math.max(0.35, Math.min(4, radius * 0.12));
  const bendDistanceSq = clientPointToSegmentDistanceSqValues(
    previous.clientX,
    previous.clientY,
    previous.strokeStart.clientX,
    previous.strokeStart.clientY,
    current.clientX,
    current.clientY
  );
  const shouldLimitRetargetLength = previous.pressureRadius !== true || radius <= 10;
  if (shouldLimitRetargetLength && bendDistanceSq > 0.000001) {
    const maxRetargetLength = Math.max(28, Math.min(160, radius * 6));
    const retargetedLengthSq = clientDistanceSqValues(
      previous.strokeStart.clientX,
      previous.strokeStart.clientY,
      current.clientX,
      current.clientY
    );
    if (retargetedLengthSq > maxRetargetLength * maxRetargetLength) {
      return false;
    }
  }
  return bendDistanceSq <= bendTolerance * bendTolerance;
}

function strokeSegmentsForPayload(payload = null, radiusPixels = 1, options = {}) {
  const hasContinuousPointOverride = Array.isArray(options.continuousStrokePoints);
  const continuousPoints = hasContinuousPointOverride
    ? normalizedContinuousStrokePoints(options.continuousStrokePoints)
    : continuousStrokePointsForPayload(payload);
  const points = hasContinuousPointOverride
    ? continuousPoints
    : continuousPoints.length
      ? continuousPoints
      : payloadCurvePoints(payload);
  const resetPointOnly = payload?.strokeReset === true && points.length <= 1;
  if (resetPointOnly) {
    return [];
  }
  const pointStampSpacing = !continuousPayloadSpacing(payload);
  if (pointStampSpacing && points.length === 1) {
      const point = points[0];
      return [{
        start: point,
        end: point,
        ...textureAirbrushSurfaceSegmentMetadata(point, point),
        ...(variableRadiusPayload(payload) ? { radiusPixels } : {})
      }];
  }
  if (points.length < 2) {
    return [];
  }
  const segments = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (sameClientPoint(start, end)) {
      if (pointStampSpacing && payload?.strokeReset !== true) {
        segments.push({
          start,
          end,
          ...textureAirbrushSurfaceSegmentMetadata(start, end),
          ...(variableRadiusPayload(payload) ? { radiusPixels } : {})
        });
      }
      continue;
    }
    segments.push({
      start,
      end,
      ...textureAirbrushSurfaceSegmentMetadata(start, end),
      ...(variableRadiusPayload(payload) ? { radiusPixels } : {})
    });
  }
  return segments;
}

export function installTextureAirbrushScreenStrokeMethods(BirdWeightEditor) {
  installTextureAirbrushScreenOverlayMethods(BirdWeightEditor);
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushCanUseScreenStroke() {
      const isPaintBrush = this.activeTool === "airbrush" || this.activeTool === "texture-eraser";
      const layerMode = activeTexturePaintLayerMode(this);
      return isPaintBrush
        && Boolean(this.model)
        && Boolean(this.canvas)
        && (layerMode || !this.textureAirbrushGpuDisabled);
    },

    textureAirbrushResetStrokePressureState() {
      this.textureAirbrushStrokePressureState = null;
    },

    textureAirbrushResetStrokeBrushState() {
      this.textureAirbrushStrokeBrushState = null;
      this.textureAirbrushResetFootprintContinuation = null;
      this.textureAirbrushContinuousScreenStrokePath = null;
      this.textureAirbrushImmediateWebGpuScreenFlushUsed = false;
      this.textureAirbrushLastImmediateWebGpuScreenFlushMs = 0;
      this.textureAirbrushScreenFlushScheduled = false;
      this.textureAirbrushImmediateWebGpuScreenFlushScheduled = false;
    },

    textureAirbrushScreenStrokeBaseOptions() {
      if (this.textureAirbrushStrokeBrushState) {
        return this.textureAirbrushStrokeBrushState;
      }
      const radiusPixels = Math.max(1, this.textureBrushRadiusScreenPixels?.() || 8);
      const opacity = this.textureAirbrushOpacity?.() ?? 0.42;
      const hardness = this.textureAirbrushHardness?.() ?? 0.35;
      const scatter = this.textureAirbrushScatter?.() ?? 0.35;
      const visibleEdgeMode = this.textureAirbrushVisibleEdgeMode?.() || "soft";
      const spacing = this.textureAirbrushSpacingPercent?.() ?? 1;
      const color = this.textureAirbrushColor();
      const pressureSettings = this.textureAirbrushPressureSettings?.({}) || {};
      const options = {
        radiusPixels,
        opacity,
        hardness,
        scatter,
        visibleEdgeMode,
        spacing,
        color: { r: color.r, g: color.g, b: color.b },
        pressureRadius: pressureSettings.radius === true,
        pressureOpacity: pressureSettings.opacity === true,
        pressureHardness: pressureSettings.hardness === true,
        pressureScatter: pressureSettings.scatter === true
      };
      this.textureAirbrushStrokeBrushState = options;
      return options;
    },

    textureAirbrushStabilizedPressureOptions(event, options = {}, baseOptions = {}) {
      if (
        !pressurePointerType(event)
        || options.pressureRadius !== true
        || !Number.isFinite(Number(options.pressure))
        || !Number.isFinite(Number(options.radiusPixels))
      ) {
        return options;
      }
      const pressure = Math.max(0.02, Math.min(1, Number(options.pressure)));
      const radiusPixels = Math.max(1, Number(options.radiusPixels));
      const baseRadiusPixels = Math.max(1, Number(baseOptions.radiusPixels) || this.textureBrushRadiusScreenPixels?.() || 8);
      const state = this.textureAirbrushStrokePressureState;
      if (!state) {
        this.textureAirbrushStrokePressureState = pressureStateSnapshot(pressure, radiusPixels, event);
        return options;
      }
      if (pressureStateStableForRadius(state, pressure, radiusPixels, baseRadiusPixels, event)) {
        return {
          ...options,
          pressure: state.pressure,
          radiusPixels: state.radiusPixels
        };
      }
      const pressureTrend = Math.sign(pressure - state.pressure) || state.pressureTrend || 0;
      this.textureAirbrushStrokePressureState = pressureStateSnapshot(pressure, radiusPixels, event, pressureTrend);
      return options;
    },

    textureAirbrushScreenStrokePayload(event, strokeStart) {
      if (!event) {
        return null;
      }
      const current = finiteClientPoint(event);
      if (!current) {
        return null;
      }
      const start = finiteClientPoint(strokeStart) || current;
      const baseOptions = this.textureAirbrushScreenStrokeBaseOptions?.() || {};
      const baseRadiusPixels = Math.max(1, Number(baseOptions.radiusPixels) || this.textureBrushRadiusScreenPixels?.() || 8);
      const baseOpacity = baseOptions.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42;
      const baseHardness = baseOptions.hardness ?? this.textureAirbrushHardness?.() ?? 0.35;
      const baseScatter = baseOptions.scatter ?? this.textureAirbrushScatter?.() ?? 0.35;
      const brushOptions = this.textureAirbrushOptionsWithPressure?.(event, {
        radiusPixels: baseRadiusPixels,
        opacity: baseOpacity,
        hardness: baseHardness,
        scatter: baseScatter,
        strength: 1,
        pressureRadius: baseOptions.pressureRadius,
        pressureOpacity: baseOptions.pressureOpacity,
        pressureHardness: baseOptions.pressureHardness,
        pressureScatter: baseOptions.pressureScatter
      }) || {};
      const stabilizedOptions = this.textureAirbrushStabilizedPressureOptions?.(event, brushOptions, {
        radiusPixels: baseRadiusPixels,
        opacity: baseOpacity,
        hardness: baseHardness,
        scatter: baseScatter
      }) || brushOptions;
      const radiusPixels = Math.max(1, stabilizedOptions.radiusPixels ?? baseRadiusPixels);
      const color = baseOptions.color || this.textureAirbrushColor();
      const pressureInputActive = this.textureAirbrushPressureInputActive?.(event, stabilizedOptions)
        ?? pressurePointerType(event);
      const payload = {
        ...current,
        strokeStart: start,
        radiusPixels,
        color: { r: color.r, g: color.g, b: color.b },
        opacity: stabilizedOptions.opacity ?? baseOpacity,
        hardness: stabilizedOptions.hardness ?? baseHardness,
        scatter: stabilizedOptions.scatter ?? baseScatter,
        visibleEdgeMode: baseOptions.visibleEdgeMode || this.textureAirbrushVisibleEdgeMode?.() || "soft",
        spacing: baseOptions.spacing ?? this.textureAirbrushSpacingPercent?.() ?? 1,
        strength: stabilizedOptions.strength ?? 1,
        pressure: stabilizedOptions.pressure ?? 1,
        pressureSource: stabilizedOptions.pressureSource || "default",
        pressureRadius: stabilizedOptions.pressureRadius === true,
        pressurePointer: pressureInputActive === true,
        pressureOpacity: stabilizedOptions.pressureOpacity === true,
        pressureHardness: stabilizedOptions.pressureHardness === true,
        pressureScatter: stabilizedOptions.pressureScatter === true,
        pressureApplied: true,
        erase: this.activeTool === "texture-eraser",
        layerMode: activeTexturePaintLayerMode(this),
        layerMutationSerial: this.texturePaintLayerMutationSerialValue?.() ?? 0,
        strokeReset: false
      };
      const neighborPaintActive = this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
      const neighborPaintSeed = neighborPaintActive
        ? this.textureAirbrushActiveNeighborPaintSeed || null
        : null;
      if (!neighborPaintActive) {
        this.textureAirbrushActiveNeighborPaintSeed = null;
      }
      if (neighborPaintSeed?.enabled) {
        payload.neighborPaintSeed = neighborPaintSeed;
        payload.neighborPaintKey = this.textureAirbrushNeighborSeedKey?.(neighborPaintSeed)
          || neighborPaintSeed.key
          || "neighbor";
      }
      const strokeUndo = this.texturePaintActiveStrokeUndo?.()
        || this.texturePaintStrokeUndoContext
        || this.texturePaintStrokeUndo
        || null;
      if (strokeUndo) {
        payload.strokeUndo = strokeUndo;
      }
      const style = payloadBrushStyle(payload);
      const result = {
        ...payload,
        styleKey: style.styleKey,
        styleRadiusPixels: style.radiusPixels,
        styleColor: style.color,
        styleOpacity: style.opacity,
        styleHardness: style.hardness,
        styleScatter: style.scatter,
        styleStrength: style.strength
      };
      return result;
    },

    textureAirbrushQueueScreenStroke(event, options = {}) {
      if (!this.textureAirbrushCanUseScreenStroke?.()) {
        return false;
      }
      const payload = this.textureAirbrushScreenStrokePayload(event, options.strokeStart);
      if (payload && options.postCameraProjectionRewarmed === true) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // This marks a visible-surface cache refresh for the first reset after
        // camera/orbit movement. It must never relax the paint shader gates.
        payload.postCameraProjectionRewarmed = true;
      }
      if (payload && options.neighborProjectionRewarmed === true) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // This flag only says the current visible-surface projection caches were
        // rewarmed after an orbit; it must never loosen depth or facing tests.
        payload.neighborProjectionRewarmed = true;
      }
      if (payload && options.postCameraProjectionAccumulates === true) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // Carry visible-only post-camera accumulation through spaced stamp
        // strokes; this does not authorize hidden/back-side fragments.
        payload.postCameraProjectionAccumulates = true;
      }
      if (payload && options.deferredNeighborProjectionRewarm === true) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // The current camera/Neighbor projection rewarm is deferred only until
        // the scheduled flush; it still must run before visible-surface paint.
        payload.deferredNeighborProjectionRewarm = true;
      }
      if (payload && options.deferredNeighborPaintSeed === true) {
        payload.deferredNeighborPaintSeed = true;
      }
      if (payload && options.deferredPostCameraProjectionAccumulates === true) {
        payload.deferredPostCameraProjectionAccumulates = true;
      }
      if (payload && options.strokeReset === true) {
        payload.strokeReset = true;
      }
      return this.textureAirbrushQueueScreenStrokePayload?.(payload) || false;
    },

    textureAirbrushShouldUseLargeWebGpuNeighborFastQueue(event = null) {
      if (
        !event
        || this.texturePaintNeighborModeEnabled?.() !== true
        || (this.activeTool !== "airbrush" && this.activeTool !== "texture-eraser")
        || typeof this.textureAirbrushWebGpuPaintFromEvent !== "function"
        || !this.textureAirbrushWebGpuDevice?.()
      ) {
        return false;
      }
      const radiusPixels = Math.max(
        1,
        Number(this.textureAirbrushCachedStrokeRadiusPixels?.()) || 0,
        Number(this.textureBrushRadiusScreenPixels?.()) || 0,
        8
      );
      return radiusPixels >= TEXTURE_AIRBRUSH_LIVE_WEBGPU_RESET_FOOTPRINT_MIN_RADIUS_PIXELS;
    },

    textureAirbrushQueueLargeWebGpuNeighborStrokeEvents(events = [], options = {}) {
      if (!this.textureAirbrushCanUseScreenStroke?.()) {
        return false;
      }
      const sourceEvents = (Array.isArray(events) && events.length ? events : [events])
        .filter((event) => Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY));
      if (!sourceEvents.length) {
        return false;
      }
      const explicitStrokeStart = Number.isFinite(Number(options.strokeStart?.clientX))
        && Number.isFinite(Number(options.strokeStart?.clientY))
        ? {
            clientX: Number(options.strokeStart.clientX),
            clientY: Number(options.strokeStart.clientY)
          }
        : null;
      let previous = options.reset === true ? explicitStrokeStart : this.texturePaintStrokePoint;
      let reset = options.reset === true || !previous;
      let queued = false;
      const radiusPixels = Math.max(
        1,
        Number(this.textureAirbrushCachedStrokeRadiusPixels?.()) || 0,
        Number(this.textureBrushRadiusScreenPixels?.()) || 0,
        8
      );
      const minSamplePixels = Math.max(
        TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MIN_SAMPLE_PIXELS,
        Math.min(32, radiusPixels * 0.45)
      );
      const minSampleDistanceSq = minSamplePixels * minSamplePixels;
      const previousDeferScreenStrokeFlush = this.textureAirbrushDeferScreenStrokeFlush;
      let queuedPayloadCount = 0;
      let skippedPayloadCount = 0;
      this.textureAirbrushDeferScreenStrokeFlush = true;
      try {
        for (const sourceEvent of sourceEvents) {
          const current = {
            clientX: sourceEvent.clientX,
            clientY: sourceEvent.clientY
          };
          if (
            !reset
            && previous
            && clientDistanceSqValues(
              previous.clientX,
              previous.clientY,
              current.clientX,
              current.clientY
            ) < minSampleDistanceSq
          ) {
            skippedPayloadCount += 1;
            continue;
          }
          const strokeStart = previous || current;
          const payload = this.textureAirbrushScreenStrokePayload?.(sourceEvent, strokeStart);
	          if (!payload) {
	            previous = current;
	            reset = false;
	            continue;
	          }
	          payload.strokeReset = reset;
	          if (reset || !this.textureAirbrushActiveNeighborPaintSeed?.enabled) {
	            payload.deferredNeighborPaintSeed = true;
	          } else {
	            payload.neighborPaintSeed = this.textureAirbrushActiveNeighborPaintSeed;
	            payload.neighborPaintKey = this.textureAirbrushNeighborSeedKey?.(payload.neighborPaintSeed)
	              || payload.neighborPaintSeed.key
	              || "neighbor";
	          }
	          if (reset) {
	            // DO NOT PAINT ON NON CAMERA FACING SIDES.
	            // Large WebGPU Neighbor strokes stay entirely on the current
            // camera-facing WebGPU/screen-hit path. Do not trigger the legacy
            // projection rewarm here; it can monopolize the renderer before the
            // first paint and is not needed to reject back-facing normals.
            payload.webGpuLiveNeighborProjectionCurrent = true;
          }
          const payloadQueued = this.textureAirbrushQueueScreenStrokePayload?.(payload) === true;
          if (payloadQueued) {
            queuedPayloadCount += 1;
          }
          queued = payloadQueued || queued;
          previous = current;
          reset = false;
        }
      } finally {
        if (previousDeferScreenStrokeFlush === undefined) {
          delete this.textureAirbrushDeferScreenStrokeFlush;
        } else {
          this.textureAirbrushDeferScreenStrokeFlush = previousDeferScreenStrokeFlush;
        }
      }
      debugScreenWebGpuAirbrush("large-neighbor-fast-queue", {
        sourceEvents: sourceEvents.length,
        queuedPayloads: queuedPayloadCount,
        skippedPayloads: skippedPayloadCount,
        radiusPixels,
        minSamplePixels,
        queueLength: this.textureAirbrushScreenStrokeQueue?.length || 0
      });
      if (previous) {
        this.texturePaintStrokePoint = previous;
      }
      if (queued && this.textureAirbrushFlushingScreenStroke) {
        this.textureAirbrushScreenFlushRescheduleRequested = true;
      } else if (
        queued
        && !this.textureAirbrushScreenFlushScheduled
      ) {
        this.scheduleTextureAirbrushScreenStrokeFlush?.();
      }
      return queued;
    },

    textureAirbrushShouldHoldLargeResetFootprintFlush() {
      const queue = this.textureAirbrushScreenStrokeQueue || [];
      if (
        queue.length !== 1
        || (this.textureAirbrushPendingScreenStrokeBatches || []).length
      ) {
        return false;
      }
      const payload = queue[0];
      if (
        !largeDirectWebGpuResetFootprintPayload(payload)
        || screenPayloadDistanceSq(payload) > 0.000001
      ) {
        return false;
      }
      const queuedAt = Number(payload.resetFootprintQueuedAt);
      const ageMs = Number.isFinite(queuedAt) ? currentTimeMs() - queuedAt : Infinity;
      return ageMs < TEXTURE_AIRBRUSH_LIVE_WEBGPU_RESET_FOOTPRINT_HOLD_MS;
    },

    textureAirbrushResetFootprintContinuationKey(payload = null) {
      if (!payload) {
        return "";
      }
      return [
        payload.styleKey || payloadStyleKey(payload),
        payload.layerMode === true ? "layer" : "texture",
        payload.erase === true ? "erase" : "paint",
        layerMutationSerial(payload.layerMutationSerial),
        payload.neighborPaintKey || ""
      ].join("|");
    },

    textureAirbrushRecordResetFootprintContinuation(payload = null) {
      if (payload?.strokeReset === true) {
        this.textureAirbrushResetFootprintContinuation = null;
      }
      if (
        payload?.strokeReset !== true
        || payload.erase === true
        || payload.layerMode === true
        || !largeDirectWebGpuResetFootprintPayload(payload)
        || typeof this.textureAirbrushWebGpuPaintFromEvent !== "function"
        || !this.textureAirbrushWebGpuDevice?.()
      ) {
        return false;
      }
      this.textureAirbrushResetFootprintContinuation = {
        key: this.textureAirbrushResetFootprintContinuationKey(payload),
        strokeUndo: payload.strokeUndo || null,
        radiusPixels: webGpuLivePayloadRadiusPixels(payload),
        createdAt: currentTimeMs()
      };
      return true;
    },

    textureAirbrushApplyResetFootprintContinuation(payload = null) {
      const continuation = this.textureAirbrushResetFootprintContinuation || null;
      if (
        !continuation
        || payload?.strokeReset === true
        || payload?.erase === true
        || payload?.layerMode === true
        || payload?.neighborPaintSeed?.enabled === true
      ) {
        return false;
      }
      const ageMs = currentTimeMs() - (Number(continuation.createdAt) || 0);
      if (
        ageMs > TEXTURE_AIRBRUSH_LIVE_WEBGPU_RESET_FOOTPRINT_MAX_AGE_MS
        || continuation.key !== this.textureAirbrushResetFootprintContinuationKey(payload)
        || (continuation.strokeUndo || null) !== (payload.strokeUndo || null)
      ) {
        this.textureAirbrushResetFootprintContinuation = null;
        return false;
      }
      payload.strokeStartedWithReset = true;
      payload.resetFootprintContinuation = true;
      this.textureAirbrushResetFootprintContinuation = null;
      return true;
    },

    textureAirbrushRecordWarmLayerStartContinuation(payload = null) {
      if (payload?.layerMode !== true || payload.erase === true || payload.strokeReset !== true) {
        return false;
      }
      this.textureAirbrushWarmLayerStartContinuation = {
        layerMutationSerial: layerMutationSerial(payload.layerMutationSerial),
        strokeUndo: payload.strokeUndo || null,
        createdAt: currentTimeMs()
      };
      return true;
    },

    textureAirbrushApplyWarmLayerStartContinuation(payload = null) {
      const continuation = this.textureAirbrushWarmLayerStartContinuation || null;
      if (
        !continuation
        || payload?.layerMode !== true
        || payload.erase === true
        || payload.strokeReset === true
      ) {
        return false;
      }
      const ageMs = currentTimeMs() - (Number(continuation.createdAt) || 0);
      const strokeUndo = payload.strokeUndo
        || this.texturePaintActiveStrokeUndo?.()
        || this.texturePaintStrokeUndoContext
        || this.texturePaintStrokeUndo
        || null;
      if (
        ageMs > 1500
        || layerMutationSerial(payload.layerMutationSerial) !== layerMutationSerial(continuation.layerMutationSerial)
        || (strokeUndo || null) !== (continuation.strokeUndo || null)
      ) {
        this.textureAirbrushWarmLayerStartContinuation = null;
        return false;
      }
      payload.strokeStartedWithReset = true;
      payload.layerCachedStartContinuation = true;
      this.textureAirbrushWarmLayerStartContinuation = null;
      return true;
    },

    textureAirbrushQueueScreenStrokePayload(payload = null) {
      if (!payload) {
        return false;
      }
      if (
        !Number.isFinite(payload.clientX)
        || !Number.isFinite(payload.clientY)
        || !Number.isFinite(payload.strokeStart?.clientX)
        || !Number.isFinite(payload.strokeStart?.clientY)
      ) {
        return false;
      }
      this.textureAirbrushScreenStrokeQueue ||= [];
      this.textureAirbrushApplyResetFootprintContinuation?.(payload);
      this.textureAirbrushApplyWarmLayerStartContinuation?.(payload);
      this.textureAirbrushAttachContinuousScreenStrokePath?.(payload);
      if (
        largeDirectWebGpuResetFootprintPayload(payload)
        && !Number.isFinite(Number(payload.resetFootprintQueuedAt))
      ) {
        payload.resetFootprintQueuedAt = currentTimeMs();
      }
      if (!this.textureAirbrushCoalesceQueuedScreenStrokePayload?.(payload)) {
        this.textureAirbrushScreenStrokeQueue.push(payload);
      }
      if (largeLiveWebGpuPayload(payload)) {
        compactLargeLiveWebGpuScreenQueue(this.textureAirbrushScreenStrokeQueue);
      }
      if (payload.strokeReset === true) {
        this.textureAirbrushRecordResetFootprintContinuation?.(payload);
      }
      if (webGpuLiveScreenPreviewEnabled(this, payload)) {
        const previewDrawn = this.drawTextureAirbrushScreenStrokePreview?.(payload) === true;
        if (previewDrawn) {
          this.textureAirbrushWebGpuScreenPreviewActive = true;
        }
      }
      if (payload.layerMode === true && payload.erase !== true && payload.strokeReset === true) {
        this.textureAirbrushSeedWarmLayerResetProbe?.(payload);
      }
      const deferImmediateWebGpuFlush = this.textureAirbrushDeferImmediateWebGpuScreenFlush === true;
      const immediateWebGpuFlush = !deferImmediateWebGpuFlush
        && webGpuLiveImmediateScreenFlushEnabled(this, payload);
      if (immediateWebGpuFlush) {
        const largeLivePayload = largeLiveWebGpuPayload(payload);
        const continuationCoalesceMs = payload.strokeReset !== true
          ? largeLivePayload
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_CONTINUATION_COALESCE_MS
            : this.textureAirbrushImmediateWebGpuScreenFlushUsed === true
              ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_CONTINUATION_COALESCE_MS
              : 0
          : 0;
        const flushOptions = {
          live: true,
          maxBatches: largeLivePayload
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCHES
            : TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCHES,
          maxBatchSegments: largeLivePayload
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCH_SEGMENTS
            : TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_SEGMENTS,
          maxSegments: largeLivePayload
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_SEGMENTS
            : TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_SEGMENTS,
          maxBatchMs: largeLivePayload
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCH_MS
            : TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_MS,
          immediateWebGpuFlush: true,
          maxImmediateWebGpuFlushBatches: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_FIRST_PAINT_BATCHES,
          continuationCoalesceMs,
          frameScheduled: largeLivePayload
        };
        const firstResetCanFlushSynchronously = payload.strokeReset === true
          && this.textureAirbrushImmediateWebGpuScreenFlushUsed !== true
          && this.textureAirbrushAllowSynchronousImmediateWebGpuScreenFlush !== false
          && !largeLivePayload;
        if (
          (this.textureAirbrushAllowSynchronousImmediateWebGpuScreenFlush === true || firstResetCanFlushSynchronously)
          && webGpuLiveDirectScreenFlushReady(this, payload)
        ) {
          const flushedImmediately = (this.flushTextureAirbrushScreenStroke?.(flushOptions) || 0) > 0;
          if (flushedImmediately) {
            this.textureAirbrushLastImmediateWebGpuScreenFlushMs = currentTimeMs();
            this.textureAirbrushImmediateWebGpuScreenFlushUsed = true;
            return true;
          }
        }
        if (this.textureAirbrushImmediateWebGpuScreenFlushScheduled) {
          return true;
        }
        const scheduledImmediateFlush = this.scheduleTextureAirbrushImmediateWebGpuScreenFlush?.(flushOptions) === true;
        if (scheduledImmediateFlush) {
          return true;
        }
      }
      if (this.textureAirbrushImmediateWebGpuScreenFlushScheduled) {
        return true;
      }
      if (deferImmediateWebGpuFlush) {
        return true;
      }
      if (this.textureAirbrushDeferScreenStrokeFlush === true) {
        return true;
      }
      if (
        (this.textureAirbrushScreenStrokeQueue?.length || this.textureAirbrushPendingScreenStrokeBatches?.length)
        && !this.textureAirbrushScreenFlushScheduled
        && !this.textureAirbrushFlushingScreenStroke
      ) {
        const scheduled = this.scheduleTextureAirbrushScreenStrokeFlush?.();
        if (scheduled) {
          this.textureAirbrushScreenFlushScheduled = true;
        }
      }
      return true;
    },

    textureAirbrushClearWebGpuScreenPreviewWhenIdle(options = {}) {
      if (this.textureAirbrushWebGpuScreenPreviewActive !== true) {
        return false;
      }
      if (webGpuLiveScreenPreviewHasPendingPaint(this)) {
        return false;
      }
      this.textureAirbrushWebGpuScreenPreviewActive = false;
      this.clearTextureAirbrushScreenLayer?.({ defer: options.defer !== false });
      return true;
    },

    textureAirbrushSeedWarmLayerResetProbe(payload = null) {
      if (
        payload?.layerMode !== true
        || payload.erase === true
        || payload.strokeReset !== true
        || !activeTexturePaintLayerMode(this)
      ) {
        return false;
      }
      const frame = this.textureAirbrushLiveProjectionFrameState || null;
      if (
        !frame?.probePaintPassCache
        || (typeof this.textureAirbrushLiveProjectionFrameCurrent === "function"
          && !this.textureAirbrushLiveProjectionFrameCurrent(frame))
      ) {
        return false;
      }
      const targetPoint = probePointForLayerResetWork(payload, frame.rect);
      if (!targetPoint) {
        return false;
      }
      const warmPasses = warmLayerProjectionPasses(this, frame);
      if (!warmPasses.length) {
        return false;
      }
      const targetKey = `${targetPoint.x}:${targetPoint.y}`;
      const existingPasses = frame.probePaintPassCache.get(targetKey) || [];
      const mergedPasses = [...existingPasses];
      for (const pass of warmPasses) {
        if (!mergedPasses.some((candidate) => candidate?.key === pass?.key)) {
          mergedPasses.push(pass);
        }
      }
      frame.probePaintPassCache.set(targetKey, mergedPasses);
      return true;
    },

    textureAirbrushCachedLayerStartProbeReady(event = null, options = {}) {
      if (
        !activeTexturePaintLayerMode(this)
        || (this.textureAirbrushFlushingScreenStroke && options.allowFlushing !== true)
      ) {
        return false;
      }
      const frame = this.textureAirbrushLiveProjectionFrameState || null;
      if (
        !frame?.probePaintPassCache
        || (typeof this.textureAirbrushLiveProjectionFrameCurrent === "function"
          && !this.textureAirbrushLiveProjectionFrameCurrent(frame))
      ) {
        return false;
      }
      const queue = this.textureAirbrushScreenStrokeQueue || [];
      const startPayload = queue.find((payload) => payload?.layerMode === true && payload.erase !== true)
        || (options.allowFlushing === true && event?.layerMode === true && event.erase !== true ? event : null);
      if (!startPayload) {
        return false;
      }
      const targetPoint = probePointForLayerResetWork(event, frame.rect);
      if (!targetPoint) {
        return false;
      }
      const targetKey = `${targetPoint.x}:${targetPoint.y}`;
      const exactPasses = frame.probePaintPassCache.get(targetKey) || [];
      if (probePassesHaveLayerTarget(exactPasses)) {
        return true;
      }
      const radius = Math.max(1, Number(startPayload.radiusPixels) || 1);
      if (layerCachedContinuousPassesReady(this, frame, startPayload)) {
        const warmPasses = warmLayerProjectionPasses(this, frame);
        if (warmPasses.length) {
          frame.probePaintPassCache.set(targetKey, warmPasses);
          return true;
        }
      }
      const seededPasses = this.textureAirbrushCachedLayerHitPassesForProbe?.(
        frame,
        targetPoint,
        { radiusPixels: radius }
      ) || [];
      if (probePassesHaveLayerTarget(seededPasses)) {
        return true;
      }
      const tolerance = Math.max(2, Math.min(8, radius * 0.25));
      const toleranceSq = tolerance * tolerance;
      let bestPasses = null;
      let bestDistanceSq = Infinity;
      for (const [probeKey, probePasses] of frame.probePaintPassCache.entries()) {
        if (!probePassesHaveLayerTarget(probePasses)) {
          continue;
        }
        const probePoint = probePointFromKey(probeKey);
        if (!probePoint) {
          continue;
        }
        const distanceSq = clientDistanceSqValues(targetPoint.x, targetPoint.y, probePoint.x, probePoint.y);
        if (distanceSq <= toleranceSq && distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestPasses = probePasses;
        }
      }
      if (!bestPasses) {
        return false;
      }
      const mergedPasses = [...exactPasses];
      for (const pass of bestPasses) {
        if (!mergedPasses.some((candidate) => candidate?.key === pass?.key)) {
          mergedPasses.push(pass);
        }
      }
      frame.probePaintPassCache.set(targetKey, mergedPasses);
      return true;
    },

    textureAirbrushFlushCachedLayerStart(event = null, options = {}) {
      if (!this.textureAirbrushCachedLayerStartProbeReady?.(event)) {
        if (options.seedReadyLayer === true) {
          seedReadyActiveLayerResetProjection(this, event);
        }
        if (!this.textureAirbrushCachedLayerStartProbeReady?.(event)) {
          return false;
        }
      }
      return (this.flushTextureAirbrushScreenStroke?.({
        live: true,
        maxBatches: 1,
        maxBatchSegments: 1,
        maxSegments: 1,
        maxBatchMs: 1
      }) || 0) > 0;
    },

    textureAirbrushFlushLayerStartImmediately(event = null) {
      if (
        event?.layerMode !== true
        || event.erase === true
        || event.strokeReset !== true
        || this.textureAirbrushFlushingScreenStroke
      ) {
        return false;
      }
      const queuedBefore = [...(this.textureAirbrushScreenStrokeQueue || [])];
      const pendingBefore = [...(this.textureAirbrushPendingScreenStrokeBatches || [])];
      const changed = this.flushTextureAirbrushScreenStroke?.({
        live: true,
        maxBatches: 1,
        maxBatchSegments: 1,
        maxSegments: 1,
        maxBatchMs: 1
      }) || 0;
      if (changed > 0) {
        return true;
      }
      if (!this.textureAirbrushScreenStrokeQueue?.length) {
        this.textureAirbrushScreenStrokeQueue = queuedBefore;
      }
      if (!this.textureAirbrushPendingScreenStrokeBatches?.length) {
        this.textureAirbrushPendingScreenStrokeBatches = pendingBefore;
      }
      return false;
    },

    textureAirbrushPrepareScheduledLayerCameraPrewarm() {
      if (
        this.textureAirbrushCameraPrewarmScheduled !== true
        || !currentLayerResetPaintWork(this)
      ) {
        return false;
      }
      this.textureAirbrushCameraPrewarmScheduled = false;
      this.textureAirbrushCameraPrewarmStableFrames = 0;
      return true;
    },

    textureAirbrushCoalesceQueuedScreenStrokePayload(payload = null) {
      const queue = this.textureAirbrushScreenStrokeQueue || [];
      const previous = queue.at(-1);
      if (
        !canCoalesceContinuousPayload(previous, payload)
        && !canCoalesceLargeLiveResetPayload(previous, payload)
      ) {
        return false;
      }
      return mergeCoalescedScreenStrokePayload(previous, payload);
    },

    textureAirbrushRetargetPressureIsStable(event = null, baseOptions = {}, previousPayload = null) {
      const pressureRadius = baseOptions.pressureRadius === true || previousPayload?.pressureRadius === true;
      const pressureOpacity = baseOptions.pressureOpacity === true || previousPayload?.pressureOpacity === true;
      const pressureHardness = baseOptions.pressureHardness === true || previousPayload?.pressureHardness === true;
      const pressureScatter = baseOptions.pressureScatter === true || previousPayload?.pressureScatter === true;
      if (pressureOpacity || pressureHardness || pressureScatter) {
        return false;
      }
      if (!pressureRadius || !pressurePointerType(event)) {
        return true;
      }
      const state = this.textureAirbrushStrokePressureState;
      if (!state) {
        return false;
      }
      const pressure = eventPressureValue(event);
      if (pressure === null) {
        return false;
      }
      const baseRadiusPixels = Math.max(1, Number(baseOptions.radiusPixels) || this.textureBrushRadiusScreenPixels?.() || 8);
      const radiusPixels = Math.max(0.75, baseRadiusPixels * pressure);
      return pressureStateStableForRadius(state, pressure, radiusPixels, baseRadiusPixels, event);
    },

    textureAirbrushRetargetQueuedContinuousStroke(event = null, strokeStart = null, baseOptions = {}) {
      const queue = this.textureAirbrushScreenStrokeQueue || [];
      const previous = queue.at(-1);
      const current = event;
      const start = finiteClientPointLike(strokeStart) ? strokeStart : current;
      this.textureAirbrushNeighborSeedSwitchedForCurrentStrokeSample = false;
      if (!previous || !finiteClientPointLike(current) || !finiteClientPointLike(start)) {
        return false;
      }
      const neighborPaintActive = this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
      if (neighborPaintActive) {
        const previousNeighborPaintSeed = previous.neighborPaintSeed || null;
        if (previousNeighborPaintSeed?.enabled) {
          if (!this.textureAirbrushActiveNeighborPaintSeed?.enabled) {
            this.textureAirbrushActiveNeighborPaintSeed = previousNeighborPaintSeed;
          }
        } else {
          const neighborPaintSeed = this.textureAirbrushActiveNeighborPaintSeed || null;
          if (neighborPaintSeed?.enabled) {
            previous.neighborPaintSeed = neighborPaintSeed;
            previous.neighborPaintKey = this.textureAirbrushNeighborSeedKey?.(neighborPaintSeed)
              || neighborPaintSeed.key
              || "neighbor";
            const style = payloadBrushStyle(previous);
            previous.styleKey = style.styleKey;
            previous.styleRadiusPixels = style.radiusPixels;
            previous.styleColor = style.color;
            previous.styleOpacity = style.opacity;
            previous.styleHardness = style.hardness;
            previous.styleScatter = style.scatter;
            previous.styleStrength = style.strength;
          }
        }
      }
      if (this.textureAirbrushPostCameraProjectionStrokeRewarmedActive === true) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // Retargeting edits the pending visible-only stroke payload in place.
        // Preserve the post-orbit warm marker on that same payload; do not make
        // the first stroke depend on a later flush or hidden-side paint.
        previous.postCameraProjectionRewarmed = true;
      }
      if (this.textureAirbrushPostCameraProjectionStrokeAccumulateActive === true) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // Preserve the post-camera visible-only accumulation marker when a
        // queued payload is retargeted in place.
        previous.postCameraProjectionAccumulates = true;
      }
      if (
        this.textureAirbrushNeighborProjectionStrokeRewarmedActive === true
        && this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser")
      ) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // Neighbor retargets must keep using the refreshed current-camera
        // visible projection for the whole first stroke after orbit.
        previous.neighborProjectionRewarmed = true;
      }
      const spacingPercent = Math.max(0.1, Math.min(200, Number(baseOptions.spacing ?? previous.spacing ?? 1)));
      if (spacingPercent > 100 || !this.textureAirbrushRetargetPressureIsStable?.(event, baseOptions, previous)) {
        return false;
      }
      const strokeUndo = this.texturePaintActiveStrokeUndo?.()
        || this.texturePaintStrokeUndoContext
        || this.texturePaintStrokeUndo
        || null;
      if ((previous.strokeUndo || null) !== strokeUndo) {
        return false;
      }
      if (!canRetargetContinuousPayload(previous, current, start)) {
        return false;
      }
      if (previous.strokeReset === true) {
        previous.strokeReset = false;
        previous.strokeStartedWithReset = true;
      }
      rememberPayloadCurvePoints(previous, [start, current]);
      previous.clientX = current.clientX;
      previous.clientY = current.clientY;
      applyClientPointSurfaceAnchor(previous, current);
      this.textureAirbrushAttachContinuousScreenStrokePath?.(previous);
      const root = typeof window !== "undefined" ? window.document?.documentElement : null;
      if (root?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
        root.dataset.textureAirbrushDebugRetargetCount = String(
          Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugRetargetCount) || 0)) + 1
        );
        root.dataset.textureAirbrushDebugRetargetRadius = String(previous.radiusPixels ?? "");
        root.dataset.textureAirbrushDebugRetargetLarge = String(largeLiveWebGpuPayload(previous));
        root.dataset.textureAirbrushDebugRetargetQueueLength = String(this.textureAirbrushScreenStrokeQueue?.length || 0);
      }
      if (
        previous.erase !== true
        && largeLiveWebGpuPayload(previous)
        && typeof this.textureAirbrushWebGpuPaintFromEvent === "function"
        && this.textureAirbrushWebGpuDevice?.()
      ) {
        const scheduled = this.scheduleTextureAirbrushImmediateWebGpuScreenFlush?.({
          live: true,
          maxBatches: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCHES,
          maxBatchSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_SEGMENTS,
          maxSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_SEGMENTS,
          maxBatchMs: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_MS,
          immediateWebGpuFlush: true
        }) === true;
        if (root?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
          root.dataset.textureAirbrushDebugRetargetImmediateScheduled = String(scheduled);
        }
        debugScreenWebGpuAirbrush("retarget-immediate-flush", {
          scheduled,
          queueLength: this.textureAirbrushScreenStrokeQueue?.length || 0,
          radiusPixels: previous.radiusPixels ?? null
        });
      }
      return true;
    },

    textureAirbrushAttachContinuousScreenStrokePath(payload = null) {
      if (
        !payload
        || !continuousPayloadSpacing(payload)
        || !finiteClientPointLike(payload.strokeStart)
        || !finiteClientPointLike(payload)
        || typeof this.textureAirbrushWebGpuPaintFromEvent !== "function"
        || !this.textureAirbrushWebGpuDevice?.()
      ) {
        return false;
      }
      const key = [
        payloadContinuousPathKey(payload),
        payload.strokeUndo ? "undo" : "no-undo",
        payload.layerMode === true ? layerMutationSerial(payload.layerMutationSerial) : 0,
        payload.erase === true ? "erase" : "paint"
      ].join("|");
      const existing = this.textureAirbrushContinuousScreenStrokePath || null;
      const startsNewPath = Boolean(
        payload.strokeReset === true
        || !existing
        || existing.key !== key
        || (existing.strokeUndo || null) !== (payload.strokeUndo || null)
      );
      const points = startsNewPath
        ? []
        : normalizedContinuousStrokePoints(existing.points);
      const incomingContinuousPoints = continuousStrokePointsForPayload(payload);
      const mergedPoints = incomingContinuousPoints.length >= 2
        ? mergeContinuousStrokePoints(points, incomingContinuousPoints)
        : mergeContinuousStrokePoints(points, payloadCurvePoints(payload));
      const maxPoints = Math.max(2, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS + 1);
      if (mergedPoints.length > maxPoints) {
        mergedPoints.splice(0, mergedPoints.length - maxPoints);
      }
      const previousSerial = Math.max(
        0,
        Math.floor(Number(this.textureAirbrushContinuousScreenStrokeSerial)) || 0
      );
      const serial = startsNewPath
        ? previousSerial + 1
        : Math.max(1, Math.floor(Number(existing?.serial)) || previousSerial || 1);
      const revision = startsNewPath
        ? 1
        : Math.max(1, Math.floor(Number(existing?.revision)) + 1 || 1);
      this.textureAirbrushContinuousScreenStrokeSerial = Math.max(previousSerial, serial);
      this.textureAirbrushContinuousScreenStrokePath = {
        key,
        serial,
        revision,
        strokeUndo: payload.strokeUndo || null,
        points: mergedPoints
      };
      payload.continuousStrokePathSerial = serial;
      payload.continuousStrokePathRevision = revision;
      return applyContinuousStrokePointsToPayload(payload, mergedPoints);
    },

    textureAirbrushResetStrokeSpacing() {
      this.textureAirbrushStrokeSpacingState = null;
      this.textureAirbrushContinuousScreenStrokePath = null;
      this.textureAirbrushResetStrokeCurveState?.();
    },

    textureAirbrushEndPostCameraProjectionStroke() {
      this.textureAirbrushPostCameraProjectionStrokeRewarmedActive = false;
      this.textureAirbrushNeighborProjectionStrokeRewarmedActive = false;
      this.textureAirbrushPostCameraProjectionStrokeAccumulateActive = false;
      this.textureAirbrushImmediateWebGpuScreenFlushUsed = false;
      this.textureAirbrushContinuousScreenStrokePath = null;
    },

    textureAirbrushResetNeighborSeedSwitchStroke(event = null) {
      if (
        this.texturePaintNeighborModeEnabled?.() !== true
        || (this.activeTool !== "airbrush" && this.activeTool !== "texture-eraser")
      ) {
        return false;
      }
      // A mid-drag Neighbor island switch is a real stroke boundary for the
      // visible projection caches. The next sample must not reuse paint-pass or
      // screen-hit state from the previous connected surface.
      this.textureAirbrushResetLiveProjectionFrame?.({ keepCurrent: false });
      this.textureAirbrushResetStrokePressureState?.();
      this.textureAirbrushResetStrokeBrushState?.();
      this.textureAirbrushResetStrokeSpacing?.();
      this.textureAirbrushBeginNeighborPaintStroke?.(event, this.activeTool);
      return this.textureAirbrushActiveNeighborPaintSeed?.enabled === true;
    },

    textureAirbrushRewarmNeighborResetProjection(event = null) {
      if (
        this.activeTool !== "airbrush"
        || this.texturePaintNeighborModeEnabled?.() !== true
      ) {
        return false;
      }
      // This rewarm is a buffer/cache refresh only. Neighbor airbrushing must
      // remain visible-surface only; do not compensate for stale buffers by
      // widening projection to hidden or back-side fragments.
      const needsLayerCameraRewarm = activeTexturePaintLayerMode(this)
        && this.textureAirbrushLayerProjectionFirstStrokeRewarm === true;
      const needsLiveProjectionRewarm = liveProjectionFrameNeedsVisibleRewarm(this);
      const needsBroadCameraRewarm = this.textureAirbrushNeighborProjectionDirty === true
        || this.textureAirbrushNeighborProjectionFirstStrokeRewarm === true
        || needsLayerCameraRewarm
        || needsLiveProjectionRewarm;
      const prewarmOptions = {
        ...(needsBroadCameraRewarm ? { all: true } : {}),
        force: true,
        skipHitLookup: true,
        preserveLayerDisplay: true
      };
      let warmed = false;
      let broadWarmed = false;
      if (
        activeTexturePaintLayerMode(this)
        && this.prewarmTextureAirbrushLayerResetStroke?.(event) === true
      ) {
        warmed = true;
        if (!needsBroadCameraRewarm) {
          return true;
        }
      }
      if (this.textureAirbrushPrewarm?.(event, null, prewarmOptions) === true) {
        warmed = true;
        broadWarmed = true;
        this.textureAirbrushNeighborProjectionDirty = false;
      }
      if (broadWarmed && needsBroadCameraRewarm) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // This consumes only the "first stroke after camera motion needs warm
        // buffers" marker. The paint shader still rejects hidden/back-facing
        // fragments; this flag is not permission to broaden visible coverage.
        this.textureAirbrushNeighborProjectionFirstStrokeRewarm = false;
        if (needsLayerCameraRewarm) {
          this.textureAirbrushLayerProjectionFirstStrokeRewarm = false;
        }
      }
      if (needsBroadCameraRewarm && !broadWarmed) {
        return false;
      }
      return warmed;
    },

    textureAirbrushRewarmLayerResetProjection(event = null) {
      const layerRewarmNeeded = this.textureAirbrushLayerProjectionFirstStrokeRewarm === true
        || liveProjectionFrameNeedsVisibleRewarm(this);
      if (
        this.activeTool !== "airbrush"
        || !activeTexturePaintLayerMode(this)
        || !layerRewarmNeeded
      ) {
        return false;
      }
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // This is the non-Neighbor version of the post-orbit warm repair: rebuild
      // broad visible-surface layer projection/display caches before the first
      // reset stroke paints. Do not use it to authorize hidden/back-side paint.
      const warmed = this.textureAirbrushPrewarm?.(event, null, {
        all: true,
        force: true,
        preserveLayerDisplay: true
      }) === true;
      if (warmed) {
        this.textureAirbrushLayerProjectionFirstStrokeRewarm = false;
      }
      return warmed;
    },

    textureAirbrushQueueSpacedScreenStroke(event, options = {}) {
      if (!this.textureAirbrushCanUseScreenStroke?.()) {
        return false;
      }
      this.textureAirbrushNeighborSeedSwitchedForCurrentStrokeSample = false;
      const neighborPaintActive = this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
      const neighborBreakPendingBeforeReset = neighborPaintActive
        && this.textureAirbrushNeighborScreenStrokeBreakPending === true;
      const postCameraStrokeRewarmActive = this.textureAirbrushPostCameraProjectionStrokeRewarmedActive === true;
      const neighborStrokeRewarmActive = neighborPaintActive
        && this.textureAirbrushNeighborProjectionStrokeRewarmedActive === true;
      const postCameraStrokeAccumulateActive = this.textureAirbrushPostCameraProjectionStrokeAccumulateActive === true;
      const forceStrokeReset = options.forceStrokeReset === true;
      const forcePostCameraStrokeReset = options.reset !== true
        && this.textureAirbrushForceNextScreenStrokeResetAfterCameraChange === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
      const requestedStrokeReset = options.reset === true || forceStrokeReset || forcePostCameraStrokeReset;
      const duplicateActiveStrokeReset = !forceStrokeReset
        && options.reset === true
        && forcePostCameraStrokeReset !== true
        && this.painting === true
        && finiteClientPointLike(this.texturePaintStrokePoint);
      const strokeReset = requestedStrokeReset && !duplicateActiveStrokeReset;
      const liveQueueRadiusPixels = Math.max(
        1,
        Number(this.textureAirbrushCachedStrokeRadiusPixels?.()) || 0,
        Number(this.textureBrushRadiusScreenPixels?.()) || 0,
        8
      );
      const largeLiveNeighborBrush = neighborPaintActive
        && liveQueueRadiusPixels >= TEXTURE_AIRBRUSH_LIVE_WEBGPU_RESET_FOOTPRINT_MIN_RADIUS_PIXELS
        && typeof this.textureAirbrushWebGpuPaintFromEvent === "function"
        && Boolean(this.textureAirbrushWebGpuDevice?.());
      let neighborProjectionRewarmed = neighborStrokeRewarmActive;
      let postCameraProjectionRewarmed = postCameraStrokeRewarmActive;
      let postCameraProjectionAccumulates = postCameraStrokeAccumulateActive;
      let deferredNeighborPaintSeed = false;
      let deferredNeighborProjectionRewarm = false;
      let deferredPostCameraProjectionAccumulates = false;
      if (strokeReset) {
        this.textureAirbrushImmediateWebGpuScreenFlushUsed = false;
        this.textureAirbrushEndPostCameraProjectionStroke?.();
        neighborProjectionRewarmed = false;
        postCameraProjectionRewarmed = false;
        postCameraProjectionAccumulates = false;
        if (forcePostCameraStrokeReset) {
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // A camera change happened mid-stroke. Treat this sample like a fresh
          // visible-only reset so it cannot reuse a projection frame from the
          // previous camera.
          this.textureAirbrushForceNextScreenStrokeResetAfterCameraChange = false;
        }
        const liveProjectionRewarmNeeded = liveProjectionFrameNeedsVisibleRewarm(this);
        const postCameraCoverageRepairBeforeReset = neighborPaintActive
          && (
            this.textureAirbrushNeighborProjectionDirty === true
            || this.textureAirbrushNeighborProjectionFirstStrokeRewarm === true
            || (
              activeTexturePaintLayerMode(this)
              && this.textureAirbrushLayerProjectionFirstStrokeRewarm === true
            )
          );
        const layerPostCameraCoverageRepairBeforeReset = !neighborPaintActive
          && activeTexturePaintLayerMode(this)
          && this.textureAirbrushLayerProjectionFirstStrokeRewarm === true;
        const neighborProjectionDirtyBeforeReset = neighborPaintActive
          && (
            this.textureAirbrushNeighborProjectionDirty === true
            || this.textureAirbrushNeighborProjectionFirstStrokeRewarm === true
            || liveProjectionRewarmNeeded
            || (
              activeTexturePaintLayerMode(this)
              && this.textureAirbrushLayerProjectionFirstStrokeRewarm === true
            )
          );
        this.textureAirbrushResetLiveProjectionFrame?.({ keepCurrent: !neighborPaintActive });
        this.textureAirbrushResetStrokePressureState?.();
        this.textureAirbrushResetStrokeBrushState?.();
        if (
          neighborPaintActive
          && neighborBreakPendingBeforeReset
          && this.textureAirbrushActiveNeighborPaintSeed?.enabled
        ) {
          deferredNeighborPaintSeed = false;
        } else if (neighborPaintActive) {
          const deferNeighborResetWork = options.deferResetRewarm === true
            || largeLiveNeighborBrush;
          if (deferNeighborResetWork) {
            deferredNeighborPaintSeed = true;
          } else {
            this.textureAirbrushBeginNeighborPaintStroke?.(event, this.activeTool);
          }
          if (deferNeighborResetWork && neighborProjectionDirtyBeforeReset && !largeLiveNeighborBrush) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Coalesced WebGPU input must not rebuild broad visible-surface
            // buffers inside the pointer event. Defer only until the scheduled
            // flush; the flush resolver still runs before any paint dispatch.
            deferredNeighborProjectionRewarm = true;
            deferredPostCameraProjectionAccumulates = postCameraCoverageRepairBeforeReset;
          } else if (deferNeighborResetWork && neighborProjectionDirtyBeforeReset) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Large WebGPU Neighbor uses current camera-facing screen hit and
            // visibility-triangle sampling directly. Avoid the old projection
            // rewarm path; it is not part of the WebGPU-only paint contract.
          } else {
            const rewarmSucceeded = this.textureAirbrushRewarmNeighborResetProjection?.(event) === true;
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // A dirty camera projection must be fixed by rebuilding visible-surface
            // buffers, not by letting the brush reach hidden/back-side fragments.
            neighborProjectionRewarmed = neighborProjectionDirtyBeforeReset
              && rewarmSucceeded
              && this.textureAirbrushNeighborProjectionDirty !== true;
            postCameraProjectionRewarmed = neighborProjectionRewarmed;
            if (neighborProjectionRewarmed) {
              // DO NOT PAINT ON NON CAMERA FACING SIDES.
              // Keep the post-orbit warm marker alive for the entire active
              // visible-only stroke. Live painting can flush in many tiny batches;
              // every batch in this first stroke must use the same current-camera
              // warm projection state instead of waiting for a second released
              // stroke to become solid.
              this.textureAirbrushNeighborProjectionStrokeRewarmedActive = true;
              this.textureAirbrushPostCameraProjectionStrokeRewarmedActive = true;
            }
            if (neighborProjectionRewarmed && postCameraCoverageRepairBeforeReset) {
              // DO NOT PAINT ON NON CAMERA FACING SIDES.
              // This mirrors the user's release-and-paint-again workaround only
              // for a real post-camera/orbit repair stroke. It accumulates
              // repeated visible fragments inside the already strict depth/facing
              // gates; it is not a hidden-side or through-object paint bypass.
              postCameraProjectionAccumulates = true;
              this.textureAirbrushPostCameraProjectionStrokeAccumulateActive = true;
            }
          }
        } else if (
          layerPostCameraCoverageRepairBeforeReset
          && this.textureAirbrushRewarmLayerResetProjection?.(event) === true
        ) {
          postCameraProjectionRewarmed = true;
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // Non-Neighbor layer painting has the same post-camera batch split:
          // carry the visible-only warm marker across the active stroke so the
          // first pass after orbit does not depend on releasing and painting
          // again.
          this.textureAirbrushPostCameraProjectionStrokeRewarmedActive = true;
          if (layerPostCameraCoverageRepairBeforeReset) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Non-Neighbor layer orbit repair gets the same visible-only
            // accumulation treatment as Neighbor. Cold cache warming alone
            // stays opacity-capped.
            postCameraProjectionAccumulates = true;
            this.textureAirbrushPostCameraProjectionStrokeAccumulateActive = true;
          }
        }
        if (forcePostCameraStrokeReset && !postCameraProjectionRewarmed) {
          this.textureAirbrushForceNextScreenStrokeResetAfterCameraChange = true;
        }
      } else if (neighborPaintActive && !this.textureAirbrushActiveNeighborPaintSeed?.enabled) {
        if (largeLiveNeighborBrush) {
          deferredNeighborPaintSeed = true;
        } else {
          this.textureAirbrushBeginNeighborPaintStroke?.(event, this.activeTool);
        }
      }
      const baseOptions = this.textureAirbrushScreenStrokeBaseOptions?.() || {};
      if (
        !strokeReset
        && !largeLiveNeighborBrush
        && !neighborPaintActive
        && options.preserveCurveSamples !== true
        && this.textureAirbrushRetargetQueuedContinuousStroke?.(event, options.strokeStart, baseOptions)
      ) {
        return true;
      }
      const neighborSeedSwitched = this.textureAirbrushNeighborSeedSwitchedForCurrentStrokeSample === true;
      this.textureAirbrushNeighborSeedSwitchedForCurrentStrokeSample = false;
      if (neighborSeedSwitched) {
        const neighborSeedReady = this.textureAirbrushResetNeighborSeedSwitchStroke?.(event) === true;
        if (!neighborSeedReady) {
          this.textureAirbrushResetStrokeSpacing?.();
          return false;
        }
      }
      const current = finiteClientPoint(event);
      if (!current) {
        return false;
      }
      const strokeStart = neighborSeedSwitched
        ? current
        : finiteClientPoint(options.strokeStart) || current;
      const samplePayload = this.textureAirbrushScreenStrokePayload?.(event, strokeStart);
      const radiusPixels = Math.max(1, Number(samplePayload?.radiusPixels) || this.textureBrushRadiusScreenPixels?.() || 8);
      const spacingPercent = Math.max(0.1, Math.min(200, Number(samplePayload?.spacing ?? this.textureAirbrushSpacingPercent?.() ?? 1)));
      const applyStrokePayloadFlags = (payload) => {
        if (!payload) {
          return null;
        }
        payload.strokeReset = strokeReset || neighborSeedSwitched;
        if (options.preserveCurveSamples === true) {
          payload.preserveCurveSample = true;
        }
        if (options.preSmoothedStrokePath === true) {
          payload.preSmoothedStrokePath = true;
        }
        if (postCameraProjectionRewarmed) {
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // First post-camera layer paint gets complete visible-surface warm
          // state immediately; it still paints only the shader-visible side.
          payload.postCameraProjectionRewarmed = true;
        }
        if (neighborProjectionRewarmed) {
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // Carry the post-orbit warm state to the first live flush only so it
          // can use complete visible-surface caches on the first stroke pass.
          payload.neighborProjectionRewarmed = true;
        }
        if (postCameraProjectionAccumulates) {
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // Accumulation here is visible-only and post-camera specific. Do
          // not replace this with hidden-side paint or a looser culling rule.
          payload.postCameraProjectionAccumulates = true;
        }
        if (deferredNeighborProjectionRewarm) {
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // The scheduled flush must resolve this marker before dispatching
          // WebGPU paint, preserving the camera-facing visible-surface gate.
          payload.deferredNeighborProjectionRewarm = true;
        }
        if (deferredNeighborPaintSeed) {
          payload.deferredNeighborPaintSeed = true;
        }
        if (deferredPostCameraProjectionAccumulates) {
          payload.deferredPostCameraProjectionAccumulates = true;
        }
        return payload;
      };
      if (spacingPercent <= 100) {
        this.textureAirbrushStrokeSpacingState = null;
        return this.textureAirbrushQueueScreenStrokePayload?.(applyStrokePayloadFlags(samplePayload)) || false;
      }
      const spacingPixels = Math.max(
        0.1,
        Number(options.spacingPixels)
          || radiusPixels * 2 * spacingPercent / 100
          || this.textureAirbrushSpacingPixels?.(radiusPixels)
          || radiusPixels * 0.5
      );
      const queueStamp = (point) => {
        const stampEvent = clientEventAtPoint(this, event, point);
        const stampPayload = stampEvent
          ? this.textureAirbrushScreenStrokePayload?.(stampEvent, point)
          : null;
        if (!stampPayload) {
          return false;
        }
        applyStrokePayloadFlags(stampPayload);
        stampPayload.spacing = spacingPercent;
        stampPayload.spacingPixels = spacingPixels;
        stampPayload.spacedStamp = true;
        return this.textureAirbrushQueueScreenStrokePayload?.(stampPayload) || false;
      };

      if (strokeReset || neighborSeedSwitched || !this.textureAirbrushStrokeSpacingState) {
        this.textureAirbrushStrokeSpacingState = {
          distanceUntilNext: spacingPixels,
          lastPoint: current,
          spacingPixels
        };
        return queueStamp(current);
      }

      const state = this.textureAirbrushStrokeSpacingState;
      let segmentStart = strokeStart;
      let dx = current.clientX - segmentStart.clientX;
      let dy = current.clientY - segmentStart.clientY;
      let distance = Math.sqrt(dx * dx + dy * dy);
      let distanceUntilNext = Math.min(
        Math.max(0, Number(state.distanceUntilNext) || spacingPixels),
        spacingPixels
      );
      let queued = false;
      let stampCount = 0;
      const maxStampCount = Math.max(16, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS * 4);
      while (distance > 0.001 && distance + 0.0001 >= distanceUntilNext && stampCount < maxStampCount) {
        const ratio = distanceUntilNext <= 0 ? 0 : distanceUntilNext / distance;
        const stampPoint = {
          clientX: segmentStart.clientX + dx * ratio,
          clientY: segmentStart.clientY + dy * ratio
        };
        queued = queueStamp(stampPoint) || queued;
        stampCount += 1;
        segmentStart = stampPoint;
        dx = current.clientX - segmentStart.clientX;
        dy = current.clientY - segmentStart.clientY;
        distance = Math.sqrt(dx * dx + dy * dy);
        distanceUntilNext = spacingPixels;
      }
      state.distanceUntilNext = Math.max(0, distanceUntilNext - distance);
      state.lastPoint = current;
      state.spacingPixels = spacingPixels;
      return queued;
    },

    scheduleTextureAirbrushScreenStrokeFlush() {
      if (this.textureAirbrushScreenFlushScheduled) {
        return false;
      }
      if (this.textureAirbrushFlushingScreenStroke) {
        if (this.textureAirbrushScreenStrokeQueue?.length || this.textureAirbrushPendingScreenStrokeBatches?.length) {
          this.textureAirbrushScreenFlushRescheduleRequested = true;
          return true;
        }
        return false;
      }
      const webGpuPending = webGpuLiveScreenStrokePending(this);
      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : typeof globalThis.setTimeout === "function"
          ? (callback) => globalThis.setTimeout(callback, 16)
          : null;
      if (!requestFrame && !webGpuPending) {
        return false;
      }
      const host = typeof window !== "undefined" ? window : globalThis;
      const scheduleTimeout = typeof host?.setTimeout === "function"
        ? host.setTimeout.bind(host)
        : typeof globalThis.setTimeout === "function"
          ? globalThis.setTimeout.bind(globalThis)
          : null;
      const configuredMinIntervalMs = Number(this.textureAirbrushLiveWebGpuScreenFlushMinMs);
      const minIntervalMs = webGpuPending
        ? Number.isFinite(configuredMinIntervalMs)
          ? Math.max(0, configuredMinIntervalMs)
          : webGpuLiveFlushIntervalMs(
              TEXTURE_AIRBRUSH_LIVE_WEBGPU_SCREEN_FLUSH_MIN_MS,
              webGpuLivePendingRadiusPixels(this)
            )
        : 0;
      const previousFlushMs = Number(this.textureAirbrushLastLiveWebGpuScreenFlushMs) || 0;
      const delayMs = previousFlushMs && minIntervalMs > 0
        ? Math.max(0, minIntervalMs - (currentTimeMs() - previousFlushMs))
        : 0;
      this.textureAirbrushScreenFlushScheduled = true;
      const flushScheduledWork = () => {
        const root = typeof window !== "undefined" ? window.document?.documentElement : null;
        if (root?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
          root.dataset.textureAirbrushDebugScheduledFlushRunCount = String(
            Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugScheduledFlushRunCount) || 0)) + 1
          );
          root.dataset.textureAirbrushDebugScheduledFlushRunQueueLength = String(this.textureAirbrushScreenStrokeQueue?.length || 0);
          root.dataset.textureAirbrushDebugScheduledFlushRunPendingBatches = String(this.textureAirbrushPendingScreenStrokeBatches?.length || 0);
          root.dataset.textureAirbrushDebugScheduledFlushRunFlushing = String(this.textureAirbrushFlushingScreenStroke === true);
          root.dataset.textureAirbrushDebugScheduledFlushRunLarge = String(largeLiveWebGpuPending(this));
        }
        this.textureAirbrushPrepareScheduledLayerCameraPrewarm?.();
        this.textureAirbrushScreenFlushScheduled = false;
        if (this.textureAirbrushShouldHoldLargeResetFootprintFlush?.()) {
          if (root?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
            root.dataset.textureAirbrushDebugScheduledFlushHeld = "true";
          }
          this.scheduleTextureAirbrushScreenStrokeFlush?.();
          return;
        }
        if (this.textureAirbrushScreenStrokeQueue?.length || this.textureAirbrushPendingScreenStrokeBatches?.length) {
          const largeNeighborFlush = largeLiveWebGpuNeighborPending(this);
          const largeLiveFlush = !largeNeighborFlush && largeLiveWebGpuPending(this);
          if (root?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
            root.dataset.textureAirbrushDebugScheduledFlushCalled = "true";
            root.dataset.textureAirbrushDebugScheduledFlushLargeNeighbor = String(largeNeighborFlush);
            root.dataset.textureAirbrushDebugScheduledFlushLargeLive = String(largeLiveFlush);
          }
          this.flushTextureAirbrushScreenStroke?.(largeNeighborFlush
            ? {
                live: true,
                largeLiveNeighborFlush: true,
                maxBatches: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCHES,
                maxBatchSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCH_SEGMENTS,
                maxSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_SEGMENTS,
                maxBatchMs: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCH_MS
              }
            : largeLiveFlush
              ? {
                  live: true,
                  maxBatches: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCHES,
                  maxBatchSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCH_SEGMENTS,
                  maxSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_SEGMENTS,
                  maxBatchMs: TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_MAX_BATCH_MS
                }
              : { live: true });
        } else {
          this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
        }
      };
      const run = () => {
        if (webGpuPending && scheduleMicrotask(flushScheduledWork)) {
          return;
        }
        if (!requestFrame) {
          this.textureAirbrushScreenFlushScheduled = false;
          return;
        }
        requestFrame(flushScheduledWork);
      };
      if (delayMs > 1 && scheduleTimeout) {
        scheduleTimeout(run, delayMs);
      } else {
        run();
      }
      return true;
    },

    scheduleTextureAirbrushImmediateWebGpuScreenFlush(options = {}) {
      if (this.textureAirbrushImmediateWebGpuScreenFlushScheduled) {
        return true;
      }
      this.textureAirbrushImmediateWebGpuScreenFlushScheduled = true;
      const delayMs = Math.max(0, Number(options.continuationCoalesceMs) || 0);
      const run = () => {
        this.textureAirbrushImmediateWebGpuScreenFlushScheduled = false;
        if (
          !(this.textureAirbrushScreenStrokeQueue?.length)
          && !(this.textureAirbrushPendingScreenStrokeBatches?.length)
        ) {
          return;
        }
        const flushed = this.flushTextureAirbrushScreenStroke?.({
          live: true,
          maxBatches: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCHES,
          maxBatchSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_SEGMENTS,
          maxSegments: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_SEGMENTS,
          maxBatchMs: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_MAX_BATCH_MS,
          maxImmediateWebGpuFlushBatches: TEXTURE_AIRBRUSH_LIVE_WEBGPU_IMMEDIATE_FIRST_PAINT_BATCHES,
          immediateWebGpuFlush: true,
          ...options
        }) || 0;
        if (flushed > 0) {
          this.textureAirbrushLastImmediateWebGpuScreenFlushMs = currentTimeMs();
          this.textureAirbrushImmediateWebGpuScreenFlushUsed = true;
        }
      };
      const host = typeof window !== "undefined" ? window : globalThis;
      const scheduleTimeout = delayMs > 0 && typeof host?.setTimeout === "function"
        ? host.setTimeout.bind(host)
        : null;
      const scheduleFrame = delayMs <= 0
        && options.frameScheduled === true
        && typeof host?.requestAnimationFrame === "function"
        ? host.requestAnimationFrame.bind(host)
        : null;
      const scheduled = scheduleTimeout
        ? (scheduleTimeout(run, delayMs), true)
        : scheduleFrame
          ? (scheduleFrame(run), true)
        : scheduleMicrotask(run);
      if (!scheduled) {
        this.textureAirbrushImmediateWebGpuScreenFlushScheduled = false;
      }
      return scheduled;
    },

    textureAirbrushScreenStrokeHasPendingWork() {
      return Boolean(
        this.textureAirbrushScreenStrokeQueue?.length
        || this.textureAirbrushPendingScreenStrokeBatches?.length
        || this.textureAirbrushFlushingScreenStroke
        || this.textureAirbrushScreenFlushScheduled
        || this.textureAirbrushImmediateWebGpuScreenFlushScheduled
      );
    },

    flushTexturePaintDeferredLayerCompositesWhenIdle() {
      if (this.painting || this.textureAirbrushScreenStrokeHasPendingWork?.()) {
        return false;
      }
      return (this.flushTexturePaintDeferredLayerComposites?.() || 0) > 0;
    },

    resolveTextureAirbrushScreenStrokeFlushWaiters() {
      if (this.textureAirbrushScreenStrokeHasPendingWork?.()) {
        return false;
      }
      const waiters = this.textureAirbrushScreenStrokeFlushWaiters || [];
      if (waiters.length) {
        this.flushTexturePaintDeferredLayerCompositesWhenIdle?.();
      }
      this.textureAirbrushScreenStrokeFlushWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
      return Boolean(waiters.length);
    },

    flushTexturePaintExactFirstPaintDisplayRefresh() {
      if (this.texturePaintNeedsExactFirstPaintDisplayRefresh !== true) {
        return false;
      }
      if (this.painting || this.textureAirbrushFlushingScreenStroke) {
        return false;
      }
      if (this.textureAirbrushScreenStrokeHasPendingWork?.()) {
        this.flushTextureAirbrushScreenStroke?.({ live: true });
        return false;
      }
      this.resetTexturePaintLayerDisplayCaches?.();
      this.bumpTexturePaintLayerMutationSerial?.();
      this.forceTexturePaintExactLayerDisplay?.();
      this.textureAirbrushResetLiveProjectionFrame?.();
      const flushed = this.flushTexturePaintLayerGpuTargetsToCanvases?.() || 0;
      if (flushed > 0) {
        this.texturePaintNeedsExactFirstPaintDisplayRefresh = false;
        return true;
      }
      return false;
    },

    scheduleTexturePaintExactFirstPaintDisplayRefresh(delayMs = 320) {
      this.texturePaintNeedsExactFirstPaintDisplayRefresh = true;
      if (this.texturePaintExactFirstPaintDisplayTimer) {
        return true;
      }
      const host = typeof window !== "undefined" ? window : globalThis;
      const schedule = typeof host?.setTimeout === "function" ? host.setTimeout.bind(host) : null;
      if (!schedule) {
        return false;
      }
      const run = () => {
        this.texturePaintExactFirstPaintDisplayTimer = null;
        if (this.flushTexturePaintExactFirstPaintDisplayRefresh?.()) {
          return;
        }
        if (this.texturePaintNeedsExactFirstPaintDisplayRefresh === true) {
          this.texturePaintExactFirstPaintDisplayTimer = schedule(run, Math.max(32, delayMs));
        }
      };
      this.texturePaintExactFirstPaintDisplayTimer = schedule(run, Math.max(32, delayMs));
      return true;
    },

    finishTextureAirbrushScreenStrokeFlush() {
      const activeStrokeUndo = this.texturePaintActiveStrokeUndo?.()
        || this.texturePaintStrokeUndo
        || null;
      if (activeStrokeUndo) {
        this.textureAirbrushAttachStrokeUndoToPendingScreenWork?.(activeStrokeUndo);
      }
      if (!this.textureAirbrushScreenStrokeHasPendingWork?.()) {
        this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
        this.flushTexturePaintDeferredLayerCompositesWhenIdle?.();
        if (this.texturePaintNeedsExactFirstPaintDisplayRefresh === true) {
          this.scheduleTexturePaintExactFirstPaintDisplayRefresh?.();
        }
        return null;
      }
      this.textureAirbrushScreenStrokeFlushWaiters ||= [];
      const promise = new Promise((resolve) => {
        this.textureAirbrushScreenStrokeFlushWaiters.push(resolve);
      });
      if (!this.textureAirbrushFlushingScreenStroke && !this.textureAirbrushScreenFlushScheduled) {
        if (largeLiveWebGpuPending(this)) {
          this.scheduleTextureAirbrushScreenStrokeFlush?.();
        } else {
          this.flushTextureAirbrushScreenStroke?.({ live: true });
        }
      }
      return promise;
    },

    textureAirbrushScreenStrokeBatches(queue = []) {
      const batches = [];
      let activeBatch = null;
      let continuousBatchCursor = this.textureAirbrushContinuousScreenStrokeBatchCursor || null;
      for (const segment of queue) {
        if (
          !segment
          || !Number.isFinite(segment.clientX)
          || !Number.isFinite(segment.clientY)
          || !Number.isFinite(segment.strokeStart?.clientX)
          || !Number.isFinite(segment.strokeStart?.clientY)
        ) {
          continue;
        }
        const style = segment.styleKey
          ? {
              styleKey: segment.styleKey,
              radiusPixels: segment.styleRadiusPixels,
              color: segment.styleColor,
              opacity: segment.styleOpacity,
              hardness: segment.styleHardness,
              scatter: segment.styleScatter,
              strength: segment.styleStrength,
              erase: segment.erase === true,
              layerMode: segment.layerMode === true
            }
          : payloadBrushStyle(segment, {
              radiusPixels: this.textureBrushRadiusScreenPixels?.() || 8,
              color: this.textureAirbrushColor(),
              opacity: this.textureAirbrushOpacity?.() ?? 0.42,
              hardness: this.textureAirbrushHardness?.() ?? 0.35,
              scatter: this.textureAirbrushScatter?.() ?? 0.35,
              strength: 1
            });
        const radiusPixels = Math.max(1, Number(style.radiusPixels) || 1);
        const color = style.color || { r: 0, g: 0, b: 0 };
        const opacity = style.opacity;
        const hardness = style.hardness;
        const scatter = style.scatter;
        const strength = style.strength;
        const styleKey = style.styleKey;
        const mutationSerial = layerMutationSerial(segment.layerMutationSerial);
        const strokeUndo = segment.strokeUndo || null;
        const neighborPaintSeed = segment.neighborPaintSeed || null;
        const neighborPaintKey = segment.neighborPaintKey || "";
        const neighborProjectionRewarmed = segment.neighborProjectionRewarmed === true;
        const postCameraProjectionRewarmed = segment.postCameraProjectionRewarmed === true
          || neighborProjectionRewarmed;
        const postCameraProjectionAccumulates = segment.postCameraProjectionAccumulates === true;
        const deferredNeighborPaintSeed = segment.deferredNeighborPaintSeed === true;
        const deferredNeighborProjectionRewarm = segment.deferredNeighborProjectionRewarm === true;
        const deferredPostCameraProjectionAccumulates = segment.deferredPostCameraProjectionAccumulates === true;
        const continuousStrokePath = continuousStrokePointsForPayload(segment).length >= 2;
        const incrementalPath = continuousStrokePath
          ? incrementalContinuousStrokePoints(segment, continuousBatchCursor)
          : null;
        if (incrementalPath) {
          continuousBatchCursor = incrementalPath.cursor;
        }
        if (
          !activeBatch
          || (segment.strokeReset === true && activeBatch.strokeSegments.length > 0)
          || activeBatch.styleKey !== styleKey
          || (activeBatch.strokeUndo || null) !== strokeUndo
          || (activeBatch.neighborPaintKey || "") !== neighborPaintKey
        ) {
          const strokeStartedWithReset = segment.strokeReset === true
            || segment.strokeStartedWithReset === true
            || segment.layerCachedStartContinuation === true;
          activeBatch = {
            styleKey,
            radiusPixels,
            color: { r: clampByte(color.r), g: clampByte(color.g), b: clampByte(color.b) },
            opacity,
            hardness,
            scatter,
            visibleEdgeMode: segment.visibleEdgeMode || this.textureAirbrushVisibleEdgeMode?.() || "soft",
            spacing: Math.max(0.1, Math.min(200, Number(segment.spacing ?? this.textureAirbrushSpacingPercent?.() ?? 1))),
            strength,
            pressureApplied: true,
            pressureRadius: segment.pressureRadius === true,
            pressurePointer: segment.pressurePointer === true,
            pressureOpacity: segment.pressureOpacity === true,
            pressureHardness: segment.pressureHardness === true,
            pressureScatter: segment.pressureScatter === true,
            erase: segment.erase === true,
            layerMode: segment.layerMode === true,
            layerMutationSerial: mutationSerial,
            neighborPaintSeed,
            neighborPaintKey,
            neighborProjectionRewarmed,
            postCameraProjectionRewarmed,
            postCameraProjectionAccumulates,
            deferredNeighborPaintSeed,
            deferredNeighborProjectionRewarm,
            deferredPostCameraProjectionAccumulates,
            continuousStrokePath,
            preSmoothedStrokePath: segment.preSmoothedStrokePath === true,
            strokeReset: segment.strokeReset === true,
            strokeStartedWithReset,
            layerCachedStartContinuation: segment.layerCachedStartContinuation === true,
            strokeSegments: []
          };
          if (strokeUndo) {
            activeBatch.strokeUndo = strokeUndo;
          }
          batches.push(activeBatch);
        }
        const strokeSegments = strokeSegmentsForPayload(
          segment,
          radiusPixels,
          incrementalPath ? { continuousStrokePoints: incrementalPath.points } : {}
        );
        activeBatch.strokeReset = activeBatch.strokeReset || segment.strokeReset === true;
        activeBatch.strokeStartedWithReset = activeBatch.strokeStartedWithReset
          || segment.strokeReset === true
          || segment.strokeStartedWithReset === true
          || segment.layerCachedStartContinuation === true;
        activeBatch.layerCachedStartContinuation = activeBatch.layerCachedStartContinuation
          || segment.layerCachedStartContinuation === true;
        activeBatch.neighborProjectionRewarmed = activeBatch.neighborProjectionRewarmed
          || segment.neighborProjectionRewarmed === true;
        activeBatch.postCameraProjectionRewarmed = activeBatch.postCameraProjectionRewarmed
          || segment.postCameraProjectionRewarmed === true
          || segment.neighborProjectionRewarmed === true;
        activeBatch.postCameraProjectionAccumulates = activeBatch.postCameraProjectionAccumulates
          || segment.postCameraProjectionAccumulates === true;
        activeBatch.deferredNeighborProjectionRewarm = activeBatch.deferredNeighborProjectionRewarm
          || segment.deferredNeighborProjectionRewarm === true;
        activeBatch.deferredNeighborPaintSeed = activeBatch.deferredNeighborPaintSeed
          || segment.deferredNeighborPaintSeed === true;
        activeBatch.deferredPostCameraProjectionAccumulates = activeBatch.deferredPostCameraProjectionAccumulates
          || segment.deferredPostCameraProjectionAccumulates === true;
        activeBatch.continuousStrokePath = activeBatch.continuousStrokePath === true
          || continuousStrokePath;
        activeBatch.preSmoothedStrokePath = activeBatch.preSmoothedStrokePath === true
          || segment.preSmoothedStrokePath === true;
        activeBatch.pressureRadius = activeBatch.pressureRadius === true || segment.pressureRadius === true;
        activeBatch.pressurePointer = activeBatch.pressurePointer === true || segment.pressurePointer === true;
        activeBatch.pressureOpacity = activeBatch.pressureOpacity === true || segment.pressureOpacity === true;
        activeBatch.pressureHardness = activeBatch.pressureHardness === true || segment.pressureHardness === true;
        activeBatch.pressureScatter = activeBatch.pressureScatter === true || segment.pressureScatter === true;
        activeBatch.radiusPixels = Math.max(activeBatch.radiusPixels, radiusPixels);
        activeBatch.strokeSegments.push(...strokeSegments);
      }
      this.textureAirbrushContinuousScreenStrokeBatchCursor = continuousBatchCursor;
      return batches.flatMap((batch) => splitStrokeBatch(batch));
    },

    textureAirbrushAttachStrokeUndoToPendingScreenWork(strokeUndo = null) {
      if (!strokeUndo) {
        return false;
      }
      let attached = false;
      const attach = (entry) => {
        if (!entry || entry.strokeUndo) {
          return;
        }
        entry.strokeUndo = strokeUndo;
        attached = true;
      };
      for (const segment of this.textureAirbrushScreenStrokeQueue || []) {
        attach(segment);
      }
      for (const batch of this.textureAirbrushPendingScreenStrokeBatches || []) {
        attach(batch);
      }
      return attached;
    },

    flushTextureAirbrushScreenStroke(options = {}) {
      if (this.textureAirbrushFlushingScreenStroke) {
        return 0;
      }
      this.textureAirbrushScreenFlushScheduled = false;
      const liveFlush = options.live === true;
      const currentLayerMutationSerial = this.texturePaintLayerMutationSerialValue?.() ?? 0;
      const activeStrokeUndo = this.texturePaintActiveStrokeUndo?.()
        || this.texturePaintStrokeUndo
        || null;
      if (activeStrokeUndo) {
        this.textureAirbrushAttachStrokeUndoToPendingScreenWork?.(activeStrokeUndo);
      }
      const queue = (this.textureAirbrushScreenStrokeQueue || [])
        .filter((segment) => layerStrokeWorkIsCurrent(segment, currentLayerMutationSerial));
      const pendingBatches = (this.textureAirbrushPendingScreenStrokeBatches || [])
        .filter((batch) => layerStrokeWorkIsCurrent(batch, currentLayerMutationSerial));
      const debugRoot = typeof window !== "undefined" ? window.document?.documentElement : null;
      if (debugRoot?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
        debugRoot.dataset.textureAirbrushDebugScreenFlushEntryCount = String(
          Math.max(0, Math.floor(Number(debugRoot.dataset.textureAirbrushDebugScreenFlushEntryCount) || 0)) + 1
        );
        debugRoot.dataset.textureAirbrushDebugScreenFlushQueueBefore = String(this.textureAirbrushScreenStrokeQueue?.length || 0);
        debugRoot.dataset.textureAirbrushDebugScreenFlushQueueAfterFilter = String(queue.length);
        debugRoot.dataset.textureAirbrushDebugScreenFlushPendingBefore = String(this.textureAirbrushPendingScreenStrokeBatches?.length || 0);
        debugRoot.dataset.textureAirbrushDebugScreenFlushPendingAfterFilter = String(pendingBatches.length);
        debugRoot.dataset.textureAirbrushDebugScreenFlushLayerSerial = String(currentLayerMutationSerial ?? "");
        debugRoot.dataset.textureAirbrushDebugScreenFlushFirstQueue = queue[0]
          ? JSON.stringify({
              radiusPixels: queue[0].radiusPixels ?? null,
              layerMode: queue[0].layerMode === true,
              layerMutationSerial: queue[0].layerMutationSerial ?? null,
              strokeReset: queue[0].strokeReset === true,
              color: queue[0].color || null
            })
          : "";
      }
      if (!queue.length && !pendingBatches.length) {
        this.textureAirbrushScreenStrokeQueue = [];
        this.textureAirbrushPendingScreenStrokeBatches = [];
        this.clearTextureAirbrushScreenLayer?.();
        this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
        return 0;
      }
      this.textureAirbrushScreenStrokeQueue = [];
      this.textureAirbrushPendingScreenStrokeBatches = [];
      this.textureAirbrushFlushingScreenStroke = true;
      let changed = 0;
      let hasPendingWork = false;
      let erasedBatchChanged = false;
      let layerPaintDisplayRefresh = null;
      let shouldRefreshLayerPaintDisplay = false;
      let anyLayerGpuPaintBatch = false;
      let forceExactPostOrbitLayerDisplay = false;
      let liveWebGpuVisiblePaintForStatus = false;
      let layerWebGpuPaintChanged = false;
      let hasLargeLiveNeighborBatch = false;
      try {
        const queuedBatches = this.textureAirbrushScreenStrokeBatches(queue);
        const preMergeBatches = [
          ...pendingBatches,
          ...queuedBatches
        ];
        if (debugRoot?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
          debugRoot.dataset.textureAirbrushDebugScreenFlushQueuedBatches = String(queuedBatches.length);
          debugRoot.dataset.textureAirbrushDebugScreenFlushPreMergeBatches = String(preMergeBatches.length);
	          debugRoot.dataset.textureAirbrushDebugScreenFlushFirstBatch = preMergeBatches[0]
	            ? JSON.stringify({
	                radiusPixels: preMergeBatches[0].radiusPixels ?? null,
	                segments: preMergeBatches[0].strokeSegments?.length || 0,
	                layerMode: preMergeBatches[0].layerMode === true,
	                strokeReset: preMergeBatches[0].strokeReset === true,
	                deferredNeighborPaintSeed: preMergeBatches[0].deferredNeighborPaintSeed === true,
	                neighborPaintSeed: preMergeBatches[0].neighborPaintSeed?.enabled === true,
	                color: preMergeBatches[0].color || null
	              })
	            : "";
	        }
        const resolveLargeNeighborBatches = liveFlush
          && this.texturePaintNeighborModeEnabled?.() === true;
        if (
          resolveLargeNeighborBatches
          || (liveFlush && options.largeLiveNeighborFlush === true)
        ) {
          for (const batch of preMergeBatches) {
            if (
              largeLiveWebGpuPayload(batch)
              && batch?.erase !== true
              && batch.neighborPaintSeed?.enabled !== true
              && !batch.neighborPaintKey
            ) {
              batch.deferredNeighborPaintSeed = true;
            }
          }
        }
        if (liveFlush) {
          resolveDeferredNeighborPaintSeeds(this, preMergeBatches);
        }
        if (resolveLargeNeighborBatches || (liveFlush && options.largeLiveNeighborFlush === true)) {
          const flushNeighborPaintSeed = preMergeBatches.find((batch) => (
            batch?.neighborPaintSeed?.enabled === true
          ))?.neighborPaintSeed || this.textureAirbrushActiveNeighborPaintSeed || null;
          if (flushNeighborPaintSeed?.enabled) {
            const flushNeighborPaintKey = this.textureAirbrushNeighborSeedKey?.(flushNeighborPaintSeed)
              || flushNeighborPaintSeed.key
              || "neighbor";
            for (const batch of preMergeBatches) {
              if (
                largeLiveWebGpuPayload(batch)
                && batch?.erase !== true
                && batch.neighborPaintSeed?.enabled !== true
              ) {
                batch.neighborPaintSeed = flushNeighborPaintSeed;
                batch.neighborPaintKey = flushNeighborPaintKey;
              }
            }
          }
        }
        const mergedBatches = mergeCompatibleStrokeBatches(preMergeBatches);
        if (liveFlush) {
          resolveDeferredNeighborProjectionRewarm(this, mergedBatches);
        }
        const resetLayerBatch = liveFlush
          ? mergedBatches.find((batch) => batch.layerMode === true && batch.erase !== true && batch.strokeReset === true) || null
          : null;
        const cachedStartContinuationBatch = liveFlush
          ? mergedBatches.find((batch) => batch.layerMode === true && batch.erase !== true && batch.layerCachedStartContinuation === true) || null
          : null;
        const hasLayerResetBatch = Boolean(resetLayerBatch);
        const hasLayerResetOriginBatch = liveFlush
          && mergedBatches.some((batch) => batch.layerMode === true && batch.erase !== true && batch.strokeStartedWithReset === true);
        const hasPostCameraLayerRewarmBatch = liveFlush
          && mergedBatches.some((batch) => (
            batch.layerMode === true
            && batch.erase !== true
            && batch.strokeStartedWithReset === true
            && (
              batch.postCameraProjectionRewarmed === true
              || batch.neighborProjectionRewarmed === true
            )
          ));
        const liveWebGpuVisiblePaint = typeof this.textureAirbrushWebGpuPaintFromEvent === "function"
          && Boolean(this.textureAirbrushWebGpuDevice?.());
        hasLargeLiveNeighborBatch = liveFlush
          && liveWebGpuVisiblePaint
          && mergedBatches.some(largeLiveWebGpuNeighborPayload);
        let layerResetWarmProjection = liveWebGpuVisiblePaint && hasLayerResetBatch;
        let layerResetTargetReady = liveWebGpuVisiblePaint && hasLayerResetBatch;
        if (!liveWebGpuVisiblePaint) {
          layerResetWarmProjection = Boolean(
            (hasLayerResetBatch && layerResetStrokeHasWarmProjection(this, resetLayerBatch))
            || (cachedStartContinuationBatch && layerResetStrokeHasWarmProjection(this, cachedStartContinuationBatch))
          );
          layerResetTargetReady = hasLayerResetBatch
            && layerResetTargetReadyForBackgroundBudget(this, resetLayerBatch);
          const layerResetPaintTargetReady = hasLayerResetBatch
            && layerResetPaintTargetReadyForDisplayPrewarm(this, resetLayerBatch);
          let seededLayerResetProjectionFrame = null;
          if (
            !layerResetWarmProjection
            && !layerResetTargetReady
            && layerResetPaintTargetReady
            && hasLayerResetBatch
          ) {
            seededLayerResetProjectionFrame = prewarmColdActiveLayerResetProjection(this, resetLayerBatch);
            if (seededLayerResetProjectionFrame) {
              layerResetWarmProjection = true;
              layerResetTargetReady = true;
            }
          }
          if (!layerResetWarmProjection && layerResetTargetReady) {
            seededLayerResetProjectionFrame = seedReadyActiveLayerResetProjection(this, resetLayerBatch);
            layerResetWarmProjection = Boolean(seededLayerResetProjectionFrame);
          }
        }
        if (
          !layerResetTargetReady
          && layerResetWarmProjection
          && hasLayerResetBatch
          && lowSpacingCachedPassStroke(resetLayerBatch)
        ) {
          layerResetTargetReady = true;
        }
        const layerSeededFrameReady = liveFlush
          && !hasLayerResetOriginBatch
          && layerBatchesCanUseSeededProjectionFrame(this, mergedBatches);
        let canUseSeededFrameAfterPostOrbitRewarm = false;
        if (hasPostCameraLayerRewarmBatch) {
          canUseSeededFrameAfterPostOrbitRewarm = layerBatchesCanUseSeededProjectionFrame(this, mergedBatches);
          if (canUseSeededFrameAfterPostOrbitRewarm) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // The broad rewarm has rebuilt the visible depth/facing caches for
            // the new camera. Treat the reset as warm so the first drag pass gets
            // the same coverage as releasing and starting a second stroke.
            layerResetWarmProjection = true;
            layerResetTargetReady = true;
          }
        }
        const useLayerResetSafetyCap = hasLayerResetBatch
          && !layerResetWarmProjection
          && !layerResetTargetReady;
        const useLayerResetFirstFrameBatchLimit = hasLayerResetBatch
          && !useLayerResetSafetyCap
          && !(layerResetWarmProjection && layerResetTargetReady);
        liveWebGpuVisiblePaintForStatus = liveWebGpuVisiblePaint;
        if (liveWebGpuVisiblePaint) {
          this.textureAirbrushLastLiveWebGpuScreenFlushMs = currentTimeMs();
        }
        const livePlanningBatches = liveWebGpuVisiblePaint
          ? splitLongScreenStrokeBatches(smoothContinuousScreenStrokeBatches(mergedBatches))
          : mergedBatches;
        const defaultLiveBatchSegmentLimit = adaptiveLiveBatchSegmentBudget(livePlanningBatches);
        const requestedMaxBatchSegments = Math.floor(Number(options.maxBatchSegments));
        const liveBatchSegmentLimit = liveFlush
          ? hasLargeLiveNeighborBatch
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCH_SEGMENTS
            : useLayerResetSafetyCap
            ? Math.max(1, Math.min(
                TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS,
                Math.floor(Number(options.maxBatchSegments) || TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS)
              ))
            : useLayerResetFirstFrameBatchLimit
              ? Math.max(1, Math.min(
                  TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_FIRST_FRAME_SEGMENTS,
                  Math.floor(Number(options.maxBatchSegments) || TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_FIRST_FRAME_SEGMENTS)
                ))
            : Math.max(
                1,
                liveWebGpuVisiblePaint
                  ? Math.min(
                      TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCH_SEGMENTS,
                      Number.isFinite(requestedMaxBatchSegments) && requestedMaxBatchSegments > 0
                        ? requestedMaxBatchSegments
                        : TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCH_SEGMENTS
                    )
                  : Math.floor(Number(options.maxBatchSegments) || defaultLiveBatchSegmentLimit)
                )
          : TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
        const batches = liveFlush
          ? splitLiveStrokeBatches(livePlanningBatches, liveBatchSegmentLimit, {
              splitContinuousPath: liveWebGpuVisiblePaint
            })
          : livePlanningBatches;
        if (activeStrokeUndo) {
          for (const batch of batches) {
            batch.strokeUndo ||= activeStrokeUndo;
          }
        }
        const requestedMaxBatches = Math.floor(Number(options.maxBatches));
        const requestedLiveBatchLimit = liveFlush
          ? hasLargeLiveNeighborBatch
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCHES
            : useLayerResetSafetyCap
            ? Math.max(1, Math.min(
                TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_BATCHES,
                Math.floor(Number(options.maxBatches) || TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_BATCHES)
              ))
            : useLayerResetFirstFrameBatchLimit
              ? Math.max(1, Math.floor(Number(options.maxBatches) || 1))
              : Math.max(
                  1,
                  liveWebGpuVisiblePaint
                    ? Math.min(
                        TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCHES,
                        Number.isFinite(requestedMaxBatches) && requestedMaxBatches > 0
                          ? requestedMaxBatches
                          : TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCHES
                      )
                    : Math.floor(Number(options.maxBatches) || TEXTURE_AIRBRUSH_LIVE_MAX_BATCHES)
                  )
          : batches.length;
        const defaultLiveSegmentLimit = adaptiveLiveSegmentBudget(batches);
        const requestedMaxSegments = Math.floor(Number(options.maxSegments));
        const requestedLiveSegmentLimit = liveFlush
          ? hasLargeLiveNeighborBatch
            ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_SEGMENTS
            : useLayerResetSafetyCap
            ? Math.max(1, Math.min(
                TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS,
                Math.floor(Number(options.maxSegments) || TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS)
              ))
            : Math.max(
                1,
                liveWebGpuVisiblePaint
                  ? Math.min(
                      TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_SEGMENTS,
                      Number.isFinite(requestedMaxSegments) && requestedMaxSegments > 0
                        ? requestedMaxSegments
                        : TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_SEGMENTS
                    )
                  : Math.floor(Number(options.maxSegments) || defaultLiveSegmentLimit)
                )
          : Infinity;
        const liveBatchBudgetMs = liveFlush
          ? Math.max(
              0,
              hasLargeLiveNeighborBatch
                ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_LARGE_NEIGHBOR_MAX_BATCH_MS
                : Number.isFinite(Number(options.maxBatchMs))
                ? Number(options.maxBatchMs)
                : liveWebGpuVisiblePaint
                  ? TEXTURE_AIRBRUSH_LIVE_WEBGPU_MAX_BATCH_MS
                  : TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_MS
            )
          : Infinity;
        const startedAt = liveFlush ? currentTimeMs() : 0;
        anyLayerGpuPaintBatch = batches.some((batch) => batch.layerMode === true);
        shouldRefreshLayerPaintDisplay = anyLayerGpuPaintBatch;
        layerPaintDisplayRefresh = anyLayerGpuPaintBatch
          ? (() => {
              const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.() || null;
              const stack = material?.userData?.texturePaintLayerStack || null;
              const layer = stack?.layers?.find((item) => item?.id === stack.activeLayerId)
                || stack?.layers?.at?.(-1)
                || null;
              const wasEmpty = layerTargetEffectivelyEmpty(layer);
              return material && layer ? { material, layer, wasEmpty } : null;
            })()
          : null;
        const webGpuVisibleMaskReady = typeof this.textureAirbrushWebGpuPaintFromEvent === "function"
          && Boolean(this.textureAirbrushWebGpuDevice?.());
        const backend = this.textureAirbrushResolveBackend?.({
          gpu: true,
          liveProjectedPaint: true,
          visibleSurfaceMaskRequired: true,
          visibleSurfaceMaskReady: webGpuVisibleMaskReady
        });
        if (debugRoot?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
          debugRoot.dataset.textureAirbrushDebugScreenFlushWebGpuReady = String(webGpuVisibleMaskReady);
          debugRoot.dataset.textureAirbrushDebugScreenFlushBackend = String(backend?.backend || "");
          debugRoot.dataset.textureAirbrushDebugScreenFlushBackendStatus = String(backend?.webGpuStatus || "");
          debugRoot.dataset.textureAirbrushDebugScreenFlushMergedBatches = String(mergedBatches.length);
          debugRoot.dataset.textureAirbrushDebugScreenFlushPlanningBatches = String(batches.length);
        }
        let processedBatches = 0;
        let processedSegments = 0;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex];
          const layerMode = batch.layerMode === true;
	          const batchRequiresNeighborPaintSeed = resolveLargeNeighborBatches
		            && batch.erase !== true
		            && largeLiveWebGpuPayload(batch)
		            && (
		              batch.deferredNeighborPaintSeed === true
		              || Boolean(batch.neighborPaintKey)
		              || batch.neighborPaintSeed?.enabled === true
		            );
		          if (batchRequiresNeighborPaintSeed && batch.neighborPaintSeed?.enabled !== true) {
		            batch.deferredNeighborPaintSeed = false;
		            batch.neighborPaintKey = "";
		            if (debugRoot?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
		              debugRoot.dataset.textureAirbrushDebugScreenFlushUnseededNeighborFallbackCount = String(
		                Math.max(0, Math.floor(Number(debugRoot.dataset.textureAirbrushDebugScreenFlushUnseededNeighborFallbackCount) || 0)) + 1
		              );
		              debugRoot.dataset.textureAirbrushDebugScreenFlushUnseededNeighborFallback = JSON.stringify({
		                radiusPixels: batch.radiusPixels ?? null,
		                segments: batch.strokeSegments?.length || 0,
		                strokeReset: batch.strokeReset === true,
		                deferredNeighborPaintSeed: batch.deferredNeighborPaintSeed === true,
		                hasActiveSeed: this.textureAirbrushActiveNeighborPaintSeed?.enabled === true
		              });
		            }
		          }
          const firstSegment = batch.strokeSegments[0] || null;
          const lastSegment = batch.strokeSegments.at(-1);
          const paintEventPoint = (
            batch.strokeReset === true
            || batch.neighborPaintSeed?.enabled === true
            || batch.deferredNeighborPaintSeed === true
          )
            ? finiteClientPointLike(firstSegment?.start)
              ? firstSegment.start
              : finiteClientPointLike(firstSegment?.end)
                ? firstSegment.end
                : lastSegment?.end
            : lastSegment?.end;
          const event = {
            clientX: paintEventPoint?.clientX ?? 0,
            clientY: paintEventPoint?.clientY ?? 0,
            button: 0,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            preventDefault: () => {},
            stopPropagation: () => {}
          };
          const layerGpuBatch = false;
          const layerWebGpuBatch = layerMode
            && webGpuVisibleMaskReady
            && backend?.backend === "webgpu";
          const renderAllCachedLayerPasses = layerGpuBatch
            && layerCachedContinuousPassesReady(this, null, batch);
          const reusePartialLayerPasses = layerGpuBatch
            && batch.strokeStartedWithReset === true
            && layerResetWarmProjection === true
            && lowSpacingCachedPassStroke(batch);
          const discoverPartialLayerPasses = reusePartialLayerPasses
            && renderAllCachedLayerPasses
            && partialLayerFrameNeedsPaintPassDiscovery(null);
          const forceLayerDisplayComposite = layerGpuBatch
            && batch.strokeStartedWithReset === true
            && (
              batch.postCameraProjectionRewarmed === true
              || batch.neighborProjectionRewarmed === true
            );
          const batchNeighborProjectionRewarmed = batch.neighborProjectionRewarmed === true;
          const batchPostCameraProjectionRewarmed = batch.postCameraProjectionRewarmed === true
            || batchNeighborProjectionRewarmed;
          const batchPostCameraProjectionAccumulates = batch.postCameraProjectionAccumulates === true;
          const batchLargeLiveNeighborPaint = liveFlush
            && liveWebGpuVisiblePaint
            && largeLiveWebGpuNeighborPayload(batch);
          const previousStrokeUndoContext = this.texturePaintStrokeUndoContext;
	          if (batch.strokeUndo) {
	            this.texturePaintStrokeUndoContext = batch.strokeUndo;
	          }
	          const captureCandidateTimingsForDebug = options.captureCandidateTimings === true
	            || (
	              debugRoot?.dataset
	              && typeof window !== "undefined"
	              && new URLSearchParams(window.location?.search || "").has("debugAirbrush")
	            );
	          const paintOptions = {
            gpu: !layerMode || layerGpuBatch || layerWebGpuBatch,
            strokeSegments: batch.strokeSegments,
            radiusPixels: batch.radiusPixels,
            color: batch.color,
            opacity: batch.opacity,
            hardness: batch.hardness,
            scatter: batch.scatter,
            visibleEdgeMode: batch.visibleEdgeMode || this.textureAirbrushVisibleEdgeMode?.() || "soft",
            spacing: batch.spacing,
            strength: batch.strength,
            strokeReset: batch.strokeReset === true,
            strokeStartedWithReset: batch.strokeStartedWithReset === true,
            erase: batch.erase === true,
            layerMode,
            screenStrokePaint: true,
            cpuStrokeSamples: false,
            ...(layerMode && !layerGpuBatch && !layerWebGpuBatch ? {
              resolvedBackend: { backend: "none", webGpuStatus: "layer-paint-gpu-required" }
            } : {}),
            ...((!layerMode || layerWebGpuBatch) && backend?.backend === "webgpu" ? { resolvedBackend: backend } : {}),
            ...(batchPostCameraProjectionRewarmed ? { postCameraProjectionRewarmed: true } : {}),
            ...(batchNeighborProjectionRewarmed ? { neighborProjectionRewarmed: true } : {}),
            ...(batchPostCameraProjectionAccumulates ? { strokeOpacityCap: false } : {}),
            ...(reusePartialLayerPasses ? { reusePartialLayerPasses: true } : {}),
            ...(layerGpuBatch ? { deferLayerComposite: true } : {}),
            ...(renderAllCachedLayerPasses ? { renderAllCachedLayerPasses: true } : {}),
            ...(discoverPartialLayerPasses ? { discoverPartialLayerPasses: true } : {}),
            ...(forceLayerDisplayComposite ? { forceLayerDisplayComposite: true } : {}),
            ...(batch.neighborPaintSeed ? { neighborPaintSeed: batch.neighborPaintSeed } : {}),
            ...(batch.neighborPaintKey ? { neighborPaintKey: batch.neighborPaintKey } : {}),
            ...(batchLargeLiveNeighborPaint ? { largeLiveNeighborPaint: true } : {}),
	            pressureRadius: batch.pressureRadius === true,
	            pressurePointer: batch.pressurePointer === true,
	            pressureOpacity: batch.pressureOpacity === true,
	            pressureHardness: batch.pressureHardness === true,
	            pressureScatter: batch.pressureScatter === true,
	            ...(captureCandidateTimingsForDebug ? { captureCandidateTimings: true } : {}),
            ...(liveWebGpuVisiblePaint ? {
              cachedStrokeSamplesOnly: false,
              indexedStrokeSamplesOnly: true,
              deferQueuedWebGpuFlush: true,
              immediateWebGpuFlush: options.immediateWebGpuFlush === true
                || options.flushQueuedWebGpuPerScreenBatch === true,
              ...(Number.isFinite(Number(options.maxImmediateWebGpuFlushBatches))
                ? { maxImmediateWebGpuFlushBatches: Math.max(1, Math.floor(Number(options.maxImmediateWebGpuFlushBatches))) }
                : {})
            } : {}),
            pressureApplied: true
          };
          const directLiveWebGpuBatch = liveWebGpuVisiblePaint
            && backend?.backend === "webgpu"
            && (!layerMode || layerWebGpuBatch);
          if (debugRoot?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchDirect = String(directLiveWebGpuBatch);
            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchLayerMode = String(layerMode);
	            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchSegments = String(batch.strokeSegments?.length || 0);
	            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchRadius = String(batch.radiusPixels ?? "");
	            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchColor = batch.color ? JSON.stringify(batch.color) : "";
	            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchFirstSegment = batch.strokeSegments?.[0]
	              ? JSON.stringify(batch.strokeSegments[0])
	              : "";
	            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchLastSegment = batch.strokeSegments?.at?.(-1)
	              ? JSON.stringify(batch.strokeSegments.at(-1))
	              : "";
	            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchEventPoint = paintEventPoint
	              ? JSON.stringify({ clientX: paintEventPoint.clientX, clientY: paintEventPoint.clientY })
	              : "";
	          }
          let batchChanged = 0;
          try {
            if (directLiveWebGpuBatch) {
              batchChanged = this.textureAirbrushWebGpuPaintFromEvent?.(event, {
                  ...paintOptions,
                  visibleSurfaceMaskRequired: true,
                  liveProjectedPaint: true,
                  requireVisibilityMask: true
                }) || 0;
            } else {
              this.textureAirbrushReportWebGpuFallback?.(backend || {
                backend: "none",
                webGpuStatus: "backend-uninitialized"
              });
            }
          } finally {
            if (previousStrokeUndoContext === undefined) {
              delete this.texturePaintStrokeUndoContext;
            } else {
              this.texturePaintStrokeUndoContext = previousStrokeUndoContext;
            }
          }
          if (batchChanged > 0 && batch.erase === true) {
            erasedBatchChanged = true;
          }
          if (debugRoot?.dataset && new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
            debugRoot.dataset.textureAirbrushDebugScreenFlushBatchChanged = String(batchChanged);
            debugRoot.dataset.textureAirbrushDebugScreenFlushProcessedBatches = String(processedBatches + 1);
            debugRoot.dataset.textureAirbrushDebugScreenFlushProcessedSegments = String(
              processedSegments + (batch.strokeSegments?.length || 0)
            );
          }
          if (batchChanged > 0 && layerWebGpuBatch) {
            layerWebGpuPaintChanged = true;
          }
          if (
            batchChanged > 0
            && layerGpuBatch
            && batch.strokeStartedWithReset === true
            && (
              batch.postCameraProjectionRewarmed === true
              || batch.neighborProjectionRewarmed === true
            )
          ) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // This only makes the visible layer display catch up immediately
            // after an orbit rewarm; it does not change projection visibility.
            forceExactPostOrbitLayerDisplay = true;
          }
          changed += batchChanged;
          processedBatches += 1;
          processedSegments += batch.strokeSegments.length;
          if (!liveFlush || batchIndex >= batches.length - 1) {
            continue;
          }
          const elapsedMs = currentTimeMs() - startedAt;
          if (
            processedBatches >= requestedLiveBatchLimit
            || processedSegments >= requestedLiveSegmentLimit
            || elapsedMs >= liveBatchBudgetMs
          ) {
            const pendingBatches = batches.slice(batchIndex + 1);
            if (batch.strokeUndo) {
              for (const pendingBatch of pendingBatches) {
                pendingBatch.strokeUndo ||= batch.strokeUndo;
              }
            }
            this.textureAirbrushPendingScreenStrokeBatches = pendingBatches;
            hasPendingWork = true;
            break;
          }
        }
      } finally {
        if (!liveFlush || !anyLayerGpuPaintBatch) {
          this.flushTexturePaintDeferredLayerComposites?.();
        }
        this.textureAirbrushFlushingScreenStroke = false;
        if (
          this.textureAirbrushWebGpuScreenPreviewActive === true
          && webGpuLiveScreenPreviewHasPendingPaint(this)
        ) {
          this.textureAirbrushClearWebGpuScreenPreviewWhenIdle?.();
        } else if (this.textureAirbrushWebGpuScreenPreviewActive === true) {
          this.textureAirbrushWebGpuScreenPreviewActive = false;
          this.clearTextureAirbrushScreenLayer?.();
        }
      }
      if (
        liveFlush
        && liveWebGpuVisiblePaintForStatus
        && (this.textureAirbrushQueuedWebGpuStrokes || []).length
      ) {
        debugScreenWebGpuAirbrush("screen-flush-queued-drain", {
          queued: (this.textureAirbrushQueuedWebGpuStrokes || []).length,
          inFlight: Boolean(this.textureAirbrushWebGpuFlushInFlight)
        });
        this.scheduleTextureAirbrushQueuedWebGpuFlush?.();
      }
      if (changed > 0) {
        const refreshedMaterials = new Set();
        const refreshLayerPaintDisplay = (material = null, layer = null, options = {}) => {
          if (!material || !layer || refreshedMaterials.has(material)) {
            return false;
          }
          const refreshed = options.forceExact === true
            ? (this.flushTexturePaintLayerGpuTargetsToCanvases?.({ material }) || 0) > 0
            : this.texturePaintCompositeMaterialLayerDisplay?.(material, {
                changedLayer: layer
              }) === true;
          if (refreshed) {
            refreshedMaterials.add(material);
          }
          return refreshed;
        };
        let exactPostOrbitDisplayRefreshed = false;
        // Live WebGPU layer paint has already updated the external GPU display
        // texture. Running the old CPU layer composite here invalidates that
        // cache before the deferred canvas sync catches up, so the next
        // downstroke can upload stale canvas pixels and make the previous
        // stroke disappear.
        if (!layerWebGpuPaintChanged) {
          if (layerPaintDisplayRefresh?.wasEmpty === true) {
            this.texturePaintNeedsExactFirstPaintDisplayRefresh = true;
          }
          if (
            forceExactPostOrbitLayerDisplay
            && layerPaintDisplayRefresh?.material
            && layerPaintDisplayRefresh?.layer
          ) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // The delayed exact refresh is a display-cache repair only. Use it
            // to show the already visible-surface-gated paint immediately, not
            // to expand what the brush can hit.
            exactPostOrbitDisplayRefreshed = refreshLayerPaintDisplay(
              layerPaintDisplayRefresh.material,
              layerPaintDisplayRefresh.layer,
              { forceExact: true }
            );
            if (exactPostOrbitDisplayRefreshed) {
              this.texturePaintNeedsExactFirstPaintDisplayRefresh = false;
            }
          }
          if (!exactPostOrbitDisplayRefreshed) {
            refreshLayerPaintDisplay(
              layerPaintDisplayRefresh?.material,
              layerPaintDisplayRefresh?.layer
            );
          }
          if (this.texturePaintNeedsExactFirstPaintDisplayRefresh === true) {
            this.scheduleTexturePaintExactFirstPaintDisplayRefresh?.();
          }
          if (shouldRefreshLayerPaintDisplay) {
            const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.() || null;
            const stack = material?.userData?.texturePaintLayerStack || null;
            const layer = stack?.layers?.find((item) => item?.id === stack.activeLayerId)
              || stack?.layers?.at?.(-1)
              || null;
            refreshLayerPaintDisplay(material, layer);
          }
        }
        this.textureAirbrushScreenStrokeChanged = true;
        setScreenStrokeStatus(
          this,
          `${erasedBatchChanged ? "Erased" : "Airbrushed"} ${changed} projected pixels`,
          liveWebGpuVisiblePaintForStatus ? { throttle: true } : {}
        );
      } else if (!this.textureAirbrushScreenStrokeChanged && !hasPendingWork) {
        setScreenStrokeStatus(
          this,
          "Airbrush needs the cursor over textured mesh",
          liveWebGpuVisiblePaintForStatus ? { throttle: true } : {}
        );
      }
      const rescheduleRequested = this.textureAirbrushScreenFlushRescheduleRequested === true;
      this.textureAirbrushScreenFlushRescheduleRequested = false;
      if (
        (options.live || rescheduleRequested)
        && (this.textureAirbrushScreenStrokeQueue?.length || this.textureAirbrushPendingScreenStrokeBatches?.length)
      ) {
        if (!this.scheduleTextureAirbrushScreenStrokeFlush?.()) {
          this.flushTextureAirbrushScreenStroke?.(rescheduleRequested ? { live: true } : {});
        }
      } else {
        this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
      }
      return changed;
    }
  });
}
