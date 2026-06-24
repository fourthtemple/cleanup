import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import { clampByte } from "./math.js";
import {
  textureAirbrushEventPressureValue,
  textureAirbrushPressurePointerType
} from "./pressure.js?v=pressure-cleanup-20260623a";
import { installTextureAirbrushScreenOverlayMethods } from "./screen-overlay.js";

const TEXTURE_AIRBRUSH_PRESSURE_STYLE_DELTA = 0.12;
const TEXTURE_AIRBRUSH_PRESSURE_REVERSAL_JITTER_DELTA = 0.22;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCHES = 4;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_MS = 8;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS = 24;
const TEXTURE_AIRBRUSH_LIVE_MAX_SEGMENTS = 48;
const TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_BATCHES = 1;
const TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS = 8;
const TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_FIRST_FRAME_SEGMENTS = 12;
const TEXTURE_AIRBRUSH_LIVE_BUDGET_REFERENCE_RADIUS = 16;
const TEXTURE_AIRBRUSH_LIVE_MAX_ADAPTIVE_BATCH_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const TEXTURE_AIRBRUSH_LIVE_MAX_ADAPTIVE_SEGMENTS = 256;

function finiteClientPoint(point = null) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return null;
  }
  return {
    clientX: point.clientX,
    clientY: point.clientY
  };
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

function activeTexturePaintLayerMode(editor = null) {
  return editor?.texturePaintLayerModeActive?.() === true
    && editor?.texturePaintHasActivePaintLayer?.() === true;
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
    && (previous.strokeUndo || null) === (next.strokeUndo || null)
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

function splitLiveStrokeBatches(batches = [], maxSegments = TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS) {
  const segmentLimit = Math.max(1, Math.min(
    TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
    Math.floor(Number(maxSegments) || TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS)
  ));
  const split = [];
  for (const batch of batches) {
    const segments = batch?.strokeSegments || [];
    if (segments.length <= segmentLimit) {
      split.push(batch);
      continue;
    }
    for (let index = 0; index < segments.length; index += segmentLimit) {
      split.push({
        ...batch,
        strokeReset: batch.strokeReset === true && index === 0,
        strokeSegments: segments.slice(index, index + segmentLimit)
      });
    }
  }
  return split;
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

function variableRadiusLayerPayload(payload = null) {
  return payload?.layerMode === true
    && payload.erase !== true
    && payload.pressureRadius === true
    && payload.pressurePointer !== false
    && continuousPayloadSpacing(payload);
}

function payloadRadiusStyleKey(payload = null, radiusPixels = 1) {
  return variableRadiusLayerPayload(payload)
    ? "variable-radius"
    : Math.round(quantizedBrushRadiusPixels(radiusPixels) * 100);
}

function pressureRadiusStyleChanged(previous = null, next = null) {
  if (!variableRadiusLayerPayload(previous) && !variableRadiusLayerPayload(next)) {
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
    payload.layerMode === true ? "layer" : "texture",
    payload.layerMode === true ? layerMutationSerial(payload.layerMutationSerial) : 0,
    payload.neighborPaintKey || "all"
  ].join(":");
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
      payload?.layerMode === true ? "layer" : "texture",
      payload?.layerMode === true ? layerMutationSerial(payload?.layerMutationSerial) : 0,
      payload?.neighborPaintKey || "all"
    ].join(":"),
    radiusPixels,
    color: colorBytes,
    opacity,
    hardness,
    scatter,
    strength
  };
}

function layerStrokeWorkIsCurrent(work = null, currentSerial = 0) {
  return work?.layerMode !== true || layerMutationSerial(work.layerMutationSerial) === layerMutationSerial(currentSerial);
}

function layerTargetEffectivelyEmpty(layer = null) {
  if (!layer) {
    return true;
  }
  if (Math.max(0, Math.floor(Number(layer.gpuTarget?.paintRevision) || 0)) > 0) {
    return false;
  }
  if (layer.isEmpty === true && layer.gpuTarget?.emptyTransparent !== false) {
    return true;
  }
  return layer.gpuTarget?.emptyTransparent === true && layer.isEmpty !== false;
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
    || !frame.paintPassCache?.size
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
  const bendTolerance = Math.max(0.35, Math.min(1.25, radius * 0.08));
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
    const maxCoalescedLength = Math.max(28, Math.min(96, radius * 4));
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
  const bendTolerance = Math.max(0.35, Math.min(1.25, radius * 0.08));
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
    const maxRetargetLength = Math.max(28, Math.min(96, radius * 4));
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

export function installTextureAirbrushScreenStrokeMethods(BirdWeightEditor) {
  installTextureAirbrushScreenOverlayMethods(BirdWeightEditor);
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushCanUseScreenStroke() {
      const isPaintBrush = this.activeTool === "airbrush" || this.activeTool === "texture-eraser";
      const layerMode = this.texturePaintLayerModeActive?.() === true
        && this.texturePaintHasActivePaintLayer?.() === true;
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
      const current = {
        clientX: event.clientX,
        clientY: event.clientY
      };
      const start = strokeStart && Number.isFinite(strokeStart.clientX) && Number.isFinite(strokeStart.clientY)
        ? {
            clientX: strokeStart.clientX,
            clientY: strokeStart.clientY
          }
        : current;
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
        clientX: current.clientX,
        clientY: current.clientY,
        strokeStart: start,
        radiusPixels,
        color: { r: color.r, g: color.g, b: color.b },
        opacity: stabilizedOptions.opacity ?? baseOpacity,
        hardness: stabilizedOptions.hardness ?? baseHardness,
        scatter: stabilizedOptions.scatter ?? baseScatter,
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
        layerMode: this.texturePaintLayerModeActive?.() === true
          && this.texturePaintHasActivePaintLayer?.() === true,
        layerMutationSerial: this.texturePaintLayerMutationSerialValue?.() ?? 0,
        strokeReset: false
      };
      const neighborPaintSeed = this.textureAirbrushActiveNeighborPaintSeed || null;
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
      return this.textureAirbrushQueueScreenStrokePayload?.(payload) || false;
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
      this.textureAirbrushApplyWarmLayerStartContinuation?.(payload);
      if (!this.textureAirbrushCoalesceQueuedScreenStrokePayload?.(payload)) {
        this.textureAirbrushScreenStrokeQueue.push(payload);
      }
      if (payload.layerMode === true && payload.erase !== true && payload.strokeReset === true) {
        this.textureAirbrushSeedWarmLayerResetProbe?.(payload);
      }
      if (!this.textureAirbrushScreenFlushScheduled && !this.textureAirbrushFlushingScreenStroke) {
        const scheduled = this.scheduleTextureAirbrushScreenStrokeFlush?.();
        if (scheduled) {
          this.textureAirbrushScreenFlushScheduled = true;
        }
      }
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
      if (!canCoalesceContinuousPayload(previous, payload)) {
        return false;
      }
      previous.clientX = payload.clientX;
      previous.clientY = payload.clientY;
      return true;
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
      if (!previous || !finiteClientPointLike(current) || !finiteClientPointLike(start)) {
        return false;
      }
      if (
        this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser")
        && !previous.neighborPaintSeed?.enabled
      ) {
        const neighborPaintSeed = this.textureAirbrushActiveNeighborPaintSeed?.enabled
          ? this.textureAirbrushActiveNeighborPaintSeed
          : this.textureAirbrushBeginNeighborPaintStroke?.(event, this.activeTool) || null;
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
      previous.clientX = current.clientX;
      previous.clientY = current.clientY;
      return true;
    },

    textureAirbrushResetStrokeSpacing() {
      this.textureAirbrushStrokeSpacingState = null;
    },

    textureAirbrushEndPostCameraProjectionStroke() {
      this.textureAirbrushPostCameraProjectionStrokeRewarmedActive = false;
      this.textureAirbrushNeighborProjectionStrokeRewarmedActive = false;
      this.textureAirbrushPostCameraProjectionStrokeAccumulateActive = false;
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
      const neighborPaintActive = this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
      const postCameraStrokeRewarmActive = this.textureAirbrushPostCameraProjectionStrokeRewarmedActive === true;
      const neighborStrokeRewarmActive = neighborPaintActive
        && this.textureAirbrushNeighborProjectionStrokeRewarmedActive === true;
      const postCameraStrokeAccumulateActive = this.textureAirbrushPostCameraProjectionStrokeAccumulateActive === true;
      const forcePostCameraStrokeReset = options.reset !== true
        && this.textureAirbrushForceNextScreenStrokeResetAfterCameraChange === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
      const strokeReset = options.reset === true || forcePostCameraStrokeReset;
      let neighborProjectionRewarmed = neighborStrokeRewarmActive;
      let postCameraProjectionRewarmed = postCameraStrokeRewarmActive;
      let postCameraProjectionAccumulates = postCameraStrokeAccumulateActive;
      if (strokeReset) {
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
        this.textureAirbrushBeginNeighborPaintStroke?.(event, this.activeTool);
        if (neighborPaintActive) {
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
        } else if (this.textureAirbrushRewarmLayerResetProjection?.(event) === true) {
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
        this.textureAirbrushBeginNeighborPaintStroke?.(event, this.activeTool);
      }
      const baseOptions = this.textureAirbrushScreenStrokeBaseOptions?.() || {};
      if (
        !strokeReset
        && this.textureAirbrushRetargetQueuedContinuousStroke?.(event, options.strokeStart, baseOptions)
      ) {
        return true;
      }
      const current = finiteClientPoint(event);
      if (!current) {
        return false;
      }
      const strokeStart = finiteClientPoint(options.strokeStart) || current;
      const samplePayload = this.textureAirbrushScreenStrokePayload?.(event, strokeStart);
      const radiusPixels = Math.max(1, Number(samplePayload?.radiusPixels) || this.textureBrushRadiusScreenPixels?.() || 8);
      const spacingPercent = Math.max(0.1, Math.min(200, Number(samplePayload?.spacing ?? this.textureAirbrushSpacingPercent?.() ?? 1)));
      if (spacingPercent <= 100) {
        this.textureAirbrushStrokeSpacingState = null;
        if (samplePayload) {
          samplePayload.strokeReset = strokeReset;
          if (postCameraProjectionRewarmed) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // First post-camera layer paint gets complete visible-surface warm
            // state immediately; it still paints only the shader-visible side.
            samplePayload.postCameraProjectionRewarmed = true;
          }
          if (neighborProjectionRewarmed) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Carry the post-orbit warm state to the first live flush only so it
            // can use complete visible-surface caches on the first stroke pass.
            samplePayload.neighborProjectionRewarmed = true;
          }
          if (postCameraProjectionAccumulates) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Accumulation here is visible-only and post-camera specific. Do
            // not replace this with hidden-side paint or a looser culling rule.
            samplePayload.postCameraProjectionAccumulates = true;
          }
        }
        return this.textureAirbrushQueueScreenStrokePayload?.(samplePayload) || false;
      }
      const spacingPixels = Math.max(
        0.1,
        Number(options.spacingPixels) || this.textureAirbrushSpacingPixels?.(radiusPixels) || radiusPixels * 0.5
      );
      const queueStamp = (point) => {
        const stampEvent = clientEventAtPoint(this, event, point);
        return Boolean(stampEvent && this.textureAirbrushQueueScreenStroke?.(stampEvent, {
          strokeStart: point,
          preview: options.preview,
          postCameraProjectionRewarmed,
          neighborProjectionRewarmed,
          postCameraProjectionAccumulates
        }));
      };

      if (strokeReset || !this.textureAirbrushStrokeSpacingState) {
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
      if (this.textureAirbrushScreenFlushScheduled || this.textureAirbrushFlushingScreenStroke) {
        return false;
      }
      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : typeof globalThis.setTimeout === "function"
          ? (callback) => globalThis.setTimeout(callback, 16)
          : null;
      if (!requestFrame) {
        return false;
      }
      this.textureAirbrushScreenFlushScheduled = true;
      requestFrame(() => {
        this.textureAirbrushPrepareScheduledLayerCameraPrewarm?.();
        this.textureAirbrushScreenFlushScheduled = false;
        if (this.textureAirbrushScreenStrokeQueue?.length || this.textureAirbrushPendingScreenStrokeBatches?.length) {
          this.flushTextureAirbrushScreenStroke?.({ live: true });
        } else {
          this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
        }
      });
      return true;
    },

    textureAirbrushScreenStrokeHasPendingWork() {
      return Boolean(
        this.textureAirbrushScreenStrokeQueue?.length
        || this.textureAirbrushPendingScreenStrokeBatches?.length
        || this.textureAirbrushFlushingScreenStroke
        || this.textureAirbrushScreenFlushScheduled
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
        this.flushTextureAirbrushScreenStroke?.({ live: true });
      }
      return promise;
    },

    textureAirbrushScreenStrokeBatches(queue = []) {
      const batches = [];
      let activeBatch = null;
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
        if (
          !activeBatch
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
            spacing: Math.max(0.1, Math.min(200, Number(segment.spacing ?? this.textureAirbrushSpacingPercent?.() ?? 1))),
            strength,
            pressureApplied: true,
            erase: segment.erase === true,
            layerMode: segment.layerMode === true,
            layerMutationSerial: mutationSerial,
            neighborPaintSeed,
            neighborPaintKey,
            neighborProjectionRewarmed,
            postCameraProjectionRewarmed,
            postCameraProjectionAccumulates,
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
        const strokeSegment = {
          start: {
            clientX: segment.strokeStart.clientX,
            clientY: segment.strokeStart.clientY
          },
          end: {
            clientX: segment.clientX,
            clientY: segment.clientY
          },
          ...(variableRadiusLayerPayload(segment) ? { radiusPixels } : {})
        };
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
        activeBatch.radiusPixels = Math.max(activeBatch.radiusPixels, radiusPixels);
        activeBatch.strokeSegments.push(strokeSegment);
      }
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
      try {
        const queuedBatches = this.textureAirbrushScreenStrokeBatches(queue);
        const mergedBatches = mergeCompatibleStrokeBatches([
          ...pendingBatches,
          ...queuedBatches
        ]);
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
        let layerResetWarmProjection = Boolean(
          (hasLayerResetBatch && layerResetStrokeHasWarmProjection(this, resetLayerBatch))
          || (cachedStartContinuationBatch && layerResetStrokeHasWarmProjection(this, cachedStartContinuationBatch))
        );
        let layerResetTargetReady = hasLayerResetBatch
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
        const defaultLiveBatchSegmentLimit = adaptiveLiveBatchSegmentBudget(mergedBatches);
        const liveBatchSegmentLimit = liveFlush
          ? useLayerResetSafetyCap
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
                Math.floor(Number(options.maxBatchSegments) || defaultLiveBatchSegmentLimit)
              )
          : TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
        const batches = liveFlush
          ? splitLiveStrokeBatches(mergedBatches, liveBatchSegmentLimit)
          : mergedBatches;
        if (activeStrokeUndo) {
          for (const batch of batches) {
            batch.strokeUndo ||= activeStrokeUndo;
          }
        }
        const requestedLiveBatchLimit = liveFlush
          ? useLayerResetSafetyCap
            ? Math.max(1, Math.min(
                TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_BATCHES,
                Math.floor(Number(options.maxBatches) || TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_BATCHES)
              ))
            : useLayerResetFirstFrameBatchLimit
              ? Math.max(1, Math.floor(Number(options.maxBatches) || 1))
              : Math.max(1, Math.floor(Number(options.maxBatches) || TEXTURE_AIRBRUSH_LIVE_MAX_BATCHES))
          : batches.length;
        const defaultLiveSegmentLimit = adaptiveLiveSegmentBudget(batches);
        const requestedLiveSegmentLimit = liveFlush
          ? useLayerResetSafetyCap
            ? Math.max(1, Math.min(
                TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS,
                Math.floor(Number(options.maxSegments) || TEXTURE_AIRBRUSH_LIVE_LAYER_RESET_MAX_SEGMENTS)
              ))
            : Math.max(1, Math.floor(Number(options.maxSegments) || defaultLiveSegmentLimit))
          : Infinity;
        const liveBatchBudgetMs = liveFlush
          ? Math.max(
              0,
              Number.isFinite(Number(options.maxBatchMs))
                ? Number(options.maxBatchMs)
                : TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_MS
            )
          : Infinity;
        const startedAt = liveFlush ? currentTimeMs() : 0;
        const anyCpuOnlyLayerBatch = batches.some((batch) => batch.layerMode === true && batch.erase === true);
        anyLayerGpuPaintBatch = batches.some((batch) => batch.layerMode === true && batch.erase !== true);
        shouldRefreshLayerPaintDisplay = anyLayerGpuPaintBatch;
        layerPaintDisplayRefresh = anyLayerGpuPaintBatch
          ? (() => {
              const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.() || null;
              const stack = material?.userData?.texturePaintLayerStack || null;
              const layer = stack?.layers?.find((item) => item?.id === stack.activeLayerId)
                || stack?.layers?.at?.(-1)
                || null;
              const layerRevision = Math.max(0, Math.floor(Number(layer?.gpuTarget?.paintRevision) || 0));
              const wasEmpty = Boolean(
                layer
                && (
                  layer.isEmpty === true
                  || (
                    layer.gpuTarget?.emptyTransparent === true
                    && layerRevision <= 0
                  )
                )
              );
              return material && layer ? { material, layer, wasEmpty } : null;
            })()
          : null;
        const shouldUseSharedBackend = !anyCpuOnlyLayerBatch && (liveFlush || batches.length > 1 || anyLayerGpuPaintBatch);
        const backend = shouldUseSharedBackend
          ? this.textureAirbrushResolveBackend?.({ gpu: true })
          : null;
        const useFullLayerSeededFrame = anyLayerGpuPaintBatch
          && (
            layerSeededFrameReady
            || canUseSeededFrameAfterPostOrbitRewarm
          )
          && (
            !hasLayerResetOriginBatch
            || hasPostCameraLayerRewarmBatch
          );
        const projectionFrameOptions = anyLayerGpuPaintBatch && !useFullLayerSeededFrame
          ? { seedLayerProxies: false, seedPaintPasses: false }
          : {};
        const projectionFrame = backend?.backend === "webgl"
          ? seededLayerResetProjectionFrame
            || this.textureAirbrushLiveProjectionFrame?.(projectionFrameOptions)
            || this.textureAirbrushGpuProjectionFrame?.(projectionFrameOptions)
          : null;
        let processedBatches = 0;
        let processedSegments = 0;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex];
          const layerMode = batch.layerMode === true;
          const lastSegment = batch.strokeSegments.at(-1);
          const event = {
            clientX: lastSegment?.end.clientX ?? 0,
            clientY: lastSegment?.end.clientY ?? 0,
            button: 0,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            preventDefault: () => {},
            stopPropagation: () => {}
          };
          const layerGpuBatch = layerMode
            && batch.erase !== true
            && backend?.backend === "webgl"
            && typeof this.textureAirbrushGpuLayerTargetForMaterial === "function";
          const renderAllCachedLayerPasses = layerGpuBatch
            && layerCachedContinuousPassesReady(this, projectionFrame, batch);
          const reusePartialLayerPasses = layerGpuBatch
            && batch.strokeStartedWithReset === true
            && layerResetWarmProjection === true
            && lowSpacingCachedPassStroke(batch);
          const discoverPartialLayerPasses = reusePartialLayerPasses
            && renderAllCachedLayerPasses
            && partialLayerFrameNeedsPaintPassDiscovery(projectionFrame);
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
          const previousStrokeUndoContext = this.texturePaintStrokeUndoContext;
          if (batch.strokeUndo) {
            this.texturePaintStrokeUndoContext = batch.strokeUndo;
          }
          let batchChanged = 0;
          try {
            batchChanged = this.textureAirbrushProjectedMeshFromEvent?.(event, {
              gpu: !layerMode || layerGpuBatch,
              strokeSegments: batch.strokeSegments,
              radiusPixels: batch.radiusPixels,
              color: batch.color,
              opacity: batch.opacity,
              hardness: batch.hardness,
              scatter: batch.scatter,
              spacing: batch.spacing,
              strength: batch.strength,
              erase: batch.erase === true,
              cpuStrokeSamples: layerMode && !layerGpuBatch,
              ...(layerMode && !layerGpuBatch ? { resolvedBackend: { backend: "cpu", webGpuStatus: "layer-paint" } } : {}),
              ...((!layerMode || layerGpuBatch) && backend?.backend === "webgl" ? { resolvedBackend: backend } : {}),
              ...((!layerMode || layerGpuBatch) && projectionFrame ? { projectionFrame } : {}),
              ...(layerGpuBatch && !forceLayerDisplayComposite ? { deferLayerComposite: true } : {}),
              ...(forceLayerDisplayComposite ? { forceLayerDisplayComposite: true } : {}),
              ...(renderAllCachedLayerPasses ? { renderAllCachedPasses: true } : {}),
              ...(reusePartialLayerPasses ? { reusePartialLayerPasses: true } : {}),
              ...(discoverPartialLayerPasses ? { discoverPartialLayerPasses: true } : {}),
              ...(batchPostCameraProjectionRewarmed ? { postCameraProjectionRewarmed: true } : {}),
              ...(batchNeighborProjectionRewarmed ? { neighborProjectionRewarmed: true } : {}),
              ...(batchPostCameraProjectionAccumulates ? { strokeOpacityCap: false } : {}),
              ...(batch.neighborPaintSeed ? { neighborPaintSeed: batch.neighborPaintSeed } : {}),
              pressureApplied: true
            }) || 0;
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
        this.clearTextureAirbrushScreenLayer?.();
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
        if (layerPaintDisplayRefresh?.wasEmpty === true) {
          this.texturePaintNeedsExactFirstPaintDisplayRefresh = true;
        }
        if (
          forceExactPostOrbitLayerDisplay
          && layerPaintDisplayRefresh?.material
          && layerPaintDisplayRefresh?.layer
        ) {
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // The delayed exact refresh is a display-cache repair only. Use it to
          // show the already visible-surface-gated paint immediately, not to
          // expand what the brush can hit.
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
        this.textureAirbrushScreenStrokeChanged = true;
        this.setStatus?.(`${erasedBatchChanged ? "Erased" : "Airbrushed"} ${changed} projected pixels`);
      } else if (!this.textureAirbrushScreenStrokeChanged && !hasPendingWork) {
        this.setStatus?.("Airbrush needs the cursor over textured mesh");
      }
      if (options.live && (this.textureAirbrushScreenStrokeQueue?.length || this.textureAirbrushPendingScreenStrokeBatches?.length)) {
        if (!this.scheduleTextureAirbrushScreenStrokeFlush?.()) {
          this.flushTextureAirbrushScreenStroke?.();
        }
      } else {
        this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
      }
      return changed;
    }
  });
}
