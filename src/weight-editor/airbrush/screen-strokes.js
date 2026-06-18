import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import { clampByte } from "./math.js";
import { installTextureAirbrushScreenOverlayMethods } from "./screen-overlay.js";

const TEXTURE_AIRBRUSH_PRESSURE_STYLE_DELTA = 0.12;
const TEXTURE_AIRBRUSH_PRESSURE_REVERSAL_JITTER_DELTA = 0.22;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCHES = 4;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_MS = 8;
const TEXTURE_AIRBRUSH_LIVE_MAX_BATCH_SEGMENTS = 24;
const TEXTURE_AIRBRUSH_LIVE_MAX_SEGMENTS = 48;
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
  const pointerType = String(event?.pointerType || "").toLowerCase();
  return pointerType === "pen" || pointerType === "touch";
}

function eventPressureValue(event = null) {
  if (!pressurePointerType(event)) {
    return null;
  }
  const pressure = Number(event?.pressure);
  return Number.isFinite(pressure)
    ? Math.max(0.02, Math.min(1, pressure))
    : null;
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
    return false;
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

function payloadStyleKey(payload = null) {
  if (!payload) {
    return "";
  }
  if (payload.styleKey) {
    return payload.styleKey;
  }
  const color = payload.color || {};
  return [
    Math.round(quantizedBrushRadiusPixels(payload.radiusPixels) * 100),
    clampByte(color.r),
    clampByte(color.g),
    clampByte(color.b),
    Math.round(quantizedBrushOpacity(payload.opacity ?? 1) * 1000),
    Math.round(Math.max(0, Math.min(1, Number(payload.hardness ?? 0))) * 1000),
    Math.round(Math.max(0, Math.min(1, Number(payload.scatter ?? 0))) * 1000),
    Math.round(Math.max(0.08, Math.min(1, Number(payload.strength ?? 1))) * 1000)
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
      Math.round(radiusPixels * 100),
      colorBytes.r,
      colorBytes.g,
      colorBytes.b,
      Math.round(opacity * 1000),
      Math.round(hardness * 1000),
      Math.round(scatter * 1000),
      Math.round(strength * 1000)
    ].join(":"),
    radiusPixels,
    color: colorBytes,
    opacity,
    hardness,
    scatter,
    strength
  };
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
      return this.activeTool === "airbrush"
        && Boolean(this.model)
        && Boolean(this.canvas)
        && !this.textureAirbrushGpuDisabled;
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
      const spacing = this.textureAirbrushSpacingPercent?.() ?? 1;
      const color = this.textureAirbrushColor();
      const pressureSettings = this.textureAirbrushPressureSettings?.({}) || {};
      const options = {
        radiusPixels,
        opacity,
        hardness,
        scatter,
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
        pressureRadius: stabilizedOptions.pressureRadius === true,
        pressureOpacity: stabilizedOptions.pressureOpacity === true,
        pressureHardness: stabilizedOptions.pressureHardness === true,
        pressureScatter: stabilizedOptions.pressureScatter === true,
        pressureApplied: true
      };
      const style = payloadBrushStyle(payload);
      return {
        ...payload,
        styleKey: style.styleKey,
        styleRadiusPixels: style.radiusPixels,
        styleColor: style.color,
        styleOpacity: style.opacity,
        styleHardness: style.hardness,
        styleScatter: style.scatter,
        styleStrength: style.strength
      };
    },

    textureAirbrushQueueScreenStroke(event, options = {}) {
      if (!this.textureAirbrushCanUseScreenStroke?.()) {
        return false;
      }
      const payload = this.textureAirbrushScreenStrokePayload(event, options.strokeStart);
      return this.textureAirbrushQueueScreenStrokePayload?.(payload) || false;
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
      if (!this.textureAirbrushCoalesceQueuedScreenStrokePayload?.(payload)) {
        this.textureAirbrushScreenStrokeQueue.push(payload);
      }
      if (!this.textureAirbrushScreenFlushScheduled && !this.textureAirbrushFlushingScreenStroke) {
        const scheduled = this.scheduleTextureAirbrushScreenStrokeFlush?.();
        if (scheduled) {
          this.textureAirbrushScreenFlushScheduled = true;
        }
      }
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
      const spacingPercent = Math.max(0.1, Math.min(200, Number(baseOptions.spacing ?? previous.spacing ?? 1)));
      if (spacingPercent > 100 || !this.textureAirbrushRetargetPressureIsStable?.(event, baseOptions, previous)) {
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

    textureAirbrushQueueSpacedScreenStroke(event, options = {}) {
      if (!this.textureAirbrushCanUseScreenStroke?.()) {
        return false;
      }
      if (options.reset === true) {
        this.textureAirbrushResetLiveProjectionFrame?.();
        this.textureAirbrushResetStrokePressureState?.();
        this.textureAirbrushResetStrokeBrushState?.();
      }
      const baseOptions = this.textureAirbrushScreenStrokeBaseOptions?.() || {};
      if (
        options.reset !== true
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
          preview: options.preview
        }));
      };

      if (options.reset === true || !this.textureAirbrushStrokeSpacingState) {
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

    resolveTextureAirbrushScreenStrokeFlushWaiters() {
      if (this.textureAirbrushScreenStrokeHasPendingWork?.()) {
        return false;
      }
      const waiters = this.textureAirbrushScreenStrokeFlushWaiters || [];
      this.textureAirbrushScreenStrokeFlushWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
      return Boolean(waiters.length);
    },

    finishTextureAirbrushScreenStrokeFlush() {
      if (!this.textureAirbrushScreenStrokeHasPendingWork?.()) {
        this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
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
              strength: segment.styleStrength
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
        if (!activeBatch || activeBatch.styleKey !== styleKey) {
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
            strokeSegments: []
          };
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
          }
        };
        activeBatch.strokeSegments.push(strokeSegment);
      }
      return batches.flatMap((batch) => splitStrokeBatch(batch));
    },

    flushTextureAirbrushScreenStroke(options = {}) {
      if (this.textureAirbrushFlushingScreenStroke) {
        return 0;
      }
      this.textureAirbrushScreenFlushScheduled = false;
      const liveFlush = options.live === true;
      const queue = this.textureAirbrushScreenStrokeQueue || [];
      const pendingBatches = this.textureAirbrushPendingScreenStrokeBatches || [];
      if (!queue.length && !pendingBatches.length) {
        this.clearTextureAirbrushScreenLayer?.();
        this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
        return 0;
      }
      this.textureAirbrushScreenStrokeQueue = [];
      this.textureAirbrushPendingScreenStrokeBatches = [];
      this.textureAirbrushFlushingScreenStroke = true;
      let changed = 0;
      let hasPendingWork = false;
      try {
        const queuedBatches = this.textureAirbrushScreenStrokeBatches(queue);
        const mergedBatches = mergeCompatibleStrokeBatches([
          ...pendingBatches,
          ...queuedBatches
        ]);
        const liveBatchSegmentLimit = liveFlush
          ? Math.max(
              1,
              Math.floor(Number(options.maxBatchSegments) || adaptiveLiveBatchSegmentBudget(mergedBatches))
            )
          : TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
        const batches = liveFlush
          ? splitLiveStrokeBatches(mergedBatches, liveBatchSegmentLimit)
          : mergedBatches;
        const requestedLiveBatchLimit = liveFlush
          ? Math.max(1, Math.floor(Number(options.maxBatches) || TEXTURE_AIRBRUSH_LIVE_MAX_BATCHES))
          : batches.length;
        const requestedLiveSegmentLimit = liveFlush
          ? Math.max(1, Math.floor(Number(options.maxSegments) || adaptiveLiveSegmentBudget(batches)))
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
        const shouldUseSharedBackend = liveFlush || batches.length > 1;
        const backend = shouldUseSharedBackend
          ? this.textureAirbrushResolveBackend?.({ gpu: true })
          : null;
        const projectionFrame = backend?.backend === "webgl"
          ? this.textureAirbrushLiveProjectionFrame?.() || this.textureAirbrushGpuProjectionFrame?.()
          : null;
        let processedBatches = 0;
        let processedSegments = 0;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex];
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
          changed += this.textureAirbrushProjectedMeshFromEvent?.(event, {
            gpu: true,
            strokeSegments: batch.strokeSegments,
            radiusPixels: batch.radiusPixels,
            color: batch.color,
            opacity: batch.opacity,
            hardness: batch.hardness,
            scatter: batch.scatter,
            strength: batch.strength,
            ...(backend?.backend === "webgl" ? { resolvedBackend: backend } : {}),
            ...(projectionFrame ? { projectionFrame } : {}),
            pressureApplied: true
          }) || 0;
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
            this.textureAirbrushPendingScreenStrokeBatches = batches.slice(batchIndex + 1);
            hasPendingWork = true;
            break;
          }
        }
      } finally {
        this.textureAirbrushFlushingScreenStroke = false;
        this.clearTextureAirbrushScreenLayer?.();
      }
      if (changed > 0) {
        this.textureAirbrushScreenStrokeChanged = true;
        this.setStatus?.(`Airbrushed ${changed} projected pixels`);
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
