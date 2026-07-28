import {
  textureAirbrushInterpolateSurfaceAnchors,
  textureAirbrushPointWithSurfaceAnchor,
  textureAirbrushSurfaceAnchorFromPoint
} from "./airbrush/surface-path.js";

const TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MIN_PIXELS = 6;
const TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MAX_PIXELS = 18;
const TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_RADIUS_SCALE = 0.75;
const TEXTURE_AIRBRUSH_CONTINUOUS_MAX_SAMPLES = 64;
const TEXTURE_AIRBRUSH_QUADRATIC_SAMPLE_MAX_PIXELS = 8;
const TEXTURE_AIRBRUSH_LOW_SPACING_QUADRATIC_SAMPLE_MAX_PIXELS = 3;
const TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_BATCHES = 1;
const TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_BATCH_SEGMENTS = 16;
const TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_SEGMENTS = 32;
const TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_BATCH_MS = 2;

function texturePaintFiniteClientPoint(event = null) {
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return null;
  }
  return textureAirbrushPointWithSurfaceAnchor(
    { clientX, clientY },
    textureAirbrushSurfaceAnchorFromPoint(event)
  );
}

function texturePaintSurfaceAnchorForConvertedPoint(sourceEvent = null, point = null, fallbackEvent = null) {
  const pointAnchor = textureAirbrushSurfaceAnchorFromPoint(point);
  if (pointAnchor) {
    return pointAnchor;
  }
  const sameSourcePoint = Number.isFinite(sourceEvent?.clientX)
    && Number.isFinite(sourceEvent?.clientY)
    && Math.abs(sourceEvent.clientX - point?.clientX) <= 0.000001
    && Math.abs(sourceEvent.clientY - point?.clientY) <= 0.000001;
  if (sameSourcePoint) {
    return textureAirbrushSurfaceAnchorFromPoint(sourceEvent);
  }
  const sameFallbackPoint = Number.isFinite(fallbackEvent?.clientX)
    && Number.isFinite(fallbackEvent?.clientY)
    && Math.abs(fallbackEvent.clientX - point?.clientX) <= 0.000001
    && Math.abs(fallbackEvent.clientY - point?.clientY) <= 0.000001;
  return sameFallbackPoint ? textureAirbrushSurfaceAnchorFromPoint(fallbackEvent) : null;
}

function texturePaintClientDistanceSqValues(ax = 0, ay = 0, bx = 0, by = 0) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function texturePaintPointToSegmentDistanceSqValues(px = 0, py = 0, ax = 0, ay = 0, bx = 0, by = 0) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.000001) {
    return texturePaintClientDistanceSqValues(px, py, ax, ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const projectedX = ax + dx * t;
  const projectedY = ay + dy * t;
  return texturePaintClientDistanceSqValues(px, py, projectedX, projectedY);
}

function texturePaintCloneImageData(imageData = null) {
  if (
    !imageData
    || !Number.isFinite(Number(imageData.width))
    || !Number.isFinite(Number(imageData.height))
    || !imageData.data
  ) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(imageData.width)));
  const height = Math.max(1, Math.floor(Number(imageData.height)));
  const data = new Uint8ClampedArray(imageData.data);
  if (typeof ImageData === "function") {
    try {
      return new ImageData(data, width, height);
    } catch {
      // Some non-browser test shims only support plain ImageData-like objects.
    }
  }
  return { width, height, data };
}

function texturePaintDebugAirbrushActive() {
  if (typeof window === "undefined") {
    return false;
  }
  return new URLSearchParams(window.location?.search || "").has("debugAirbrush");
}

function texturePaintDebugImageDataStats(imageData = null) {
  if (!imageData?.data?.length) {
    return null;
  }
  let alpha = 0;
  let magenta = 0;
  for (let index = 0; index < imageData.data.length; index += 4) {
    const a = imageData.data[index + 3] || 0;
    if (a <= 0) {
      continue;
    }
    alpha += 1;
    if ((imageData.data[index] || 0) > 180 && (imageData.data[index + 2] || 0) > 180) {
      magenta += 1;
    }
  }
  return {
    width: imageData.width || 0,
    height: imageData.height || 0,
    alpha,
    magenta
  };
}

function texturePaintTslSurfaceTexture(texture = null) {
  return Boolean(
    texture?.userData?.texturePaintTslSurfaceAirbrushDisplayTexture === true
    || texture?.userData?.texturePaintTslSurfaceAirbrushTargetTexture === true
  );
}

function texturePaintStableReferenceTexture(texture = null) {
  if (!texturePaintTslSurfaceTexture(texture)) {
    return texture || null;
  }
  return texture?.userData?.textureAirbrushWebGpuCanvasMap
    || texture?.userData?.texturePaintTslSurfaceDisplayOriginalMap
    || texture?.userData?.clonePaintOriginalMap
    || null;
}

function texturePaintCopyRenderTargetTextureSettings(targetTexture = null, sourceTexture = null, THREE = null) {
  if (!targetTexture || !sourceTexture) {
    return false;
  }
  targetTexture.colorSpace = sourceTexture.colorSpace || THREE?.SRGBColorSpace || targetTexture.colorSpace;
  targetTexture.flipY = sourceTexture.flipY ?? false;
  if ("channel" in targetTexture && "channel" in sourceTexture) {
    targetTexture.channel = sourceTexture.channel;
  }
  targetTexture.wrapS = sourceTexture.wrapS || THREE?.ClampToEdgeWrapping || targetTexture.wrapS;
  targetTexture.wrapT = sourceTexture.wrapT || THREE?.ClampToEdgeWrapping || targetTexture.wrapT;
  targetTexture.magFilter = sourceTexture.magFilter || THREE?.LinearFilter || targetTexture.magFilter;
  const mipmapMinFilters = new Set([
    THREE?.NearestMipmapNearestFilter,
    THREE?.NearestMipmapLinearFilter,
    THREE?.LinearMipmapNearestFilter,
    THREE?.LinearMipmapLinearFilter
  ].filter((value) => value != null));
  const wantsMipmaps = sourceTexture.generateMipmaps === true || mipmapMinFilters.has(sourceTexture.minFilter);
  targetTexture.minFilter = wantsMipmaps
    ? mipmapMinFilters.has(sourceTexture.minFilter)
      ? sourceTexture.minFilter
      : THREE?.LinearMipmapLinearFilter || THREE?.LinearFilter || targetTexture.minFilter
    : mipmapMinFilters.has(sourceTexture.minFilter)
      ? THREE?.LinearFilter || targetTexture.minFilter
      : sourceTexture.minFilter || THREE?.LinearFilter || targetTexture.minFilter;
  targetTexture.generateMipmaps = wantsMipmaps;
  if (Number.isFinite(Number(sourceTexture.anisotropy))) {
    targetTexture.anisotropy = sourceTexture.anisotropy;
  }
  return true;
}

function texturePaintSetDebugData(key, value) {
  if (!texturePaintDebugAirbrushActive()) {
    return false;
  }
  const root = window.document?.documentElement || null;
  if (!root?.dataset) {
    return false;
  }
  root.dataset[key] = typeof value === "string" ? value : JSON.stringify(value);
  return true;
}

function textureAirbrushCoalescedPathCanCollapse(events = [], startPoint = null, radiusPixels = 1) {
  if (!Array.isArray(events) || events.length <= 2) {
    return true;
  }
  const first = startPoint || events[0];
  const last = events.at(-1);
  if (
    !Number.isFinite(first?.clientX)
    || !Number.isFinite(first?.clientY)
    || !Number.isFinite(last?.clientX)
    || !Number.isFinite(last?.clientY)
  ) {
    return false;
  }
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const tolerance = Math.max(0.75, Math.min(4, radius * 0.12));
  const toleranceSq = tolerance * tolerance;
  for (const event of events.slice(0, -1)) {
    if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
      return false;
    }
    if (
      texturePaintPointToSegmentDistanceSqValues(
        event.clientX,
        event.clientY,
        first.clientX,
        first.clientY,
        last.clientX,
        last.clientY
      ) > toleranceSq
    ) {
      return false;
    }
  }
  return true;
}

function textureAirbrushHighRateEventsNeedCurveSampling(events = [], startPoint = null, sampleStepPixels = 1) {
  if (!Array.isArray(events) || events.length < 1) {
    return false;
  }
  if (events.length > 3) {
    return false;
  }
  const step = Math.max(0.75, Number(sampleStepPixels) || 1);
  let previous = startPoint || null;
  for (const event of events) {
    if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
      continue;
    }
    if (
      previous
      && Number.isFinite(previous.clientX)
      && Number.isFinite(previous.clientY)
      && Math.sqrt(texturePaintClientDistanceSqValues(
        previous.clientX,
        previous.clientY,
        event.clientX,
        event.clientY
      )) > step * 1.5
    ) {
      return true;
    }
    previous = event;
  }
  return false;
}

function textureAirbrushQuadraticPoint(startPoint = null, controlPoint = null, endPoint = null, t = 0) {
  const inverse = 1 - t;
  return {
    clientX: inverse * inverse * startPoint.clientX
      + 2 * inverse * t * controlPoint.clientX
      + t * t * endPoint.clientX,
    clientY: inverse * inverse * startPoint.clientY
      + 2 * inverse * t * controlPoint.clientY
      + t * t * endPoint.clientY
  };
}

function texturePaintPointerIsHighRateBrushInput(event = null) {
  const pointerType = String(event?.pointerType || "").toLowerCase();
  if (pointerType === "pen" || pointerType === "touch") {
    return true;
  }
  const webkitForce = Number(event?.webkitForce ?? event?.force);
  return !pointerType && Number.isFinite(webkitForce) && webkitForce > 0;
}

function texturePaintInitialStrokeDragThresholdSq(editor = null) {
  const radius = Math.max(
    1,
    Number(editor?.textureAirbrushCachedStrokeRadiusPixels?.()) || 0,
    Number(editor?.textureBrushRadiusScreenPixels?.()) || 0,
    8
  );
  const threshold = Math.max(1.5, Math.min(8, radius * 0.04));
  return threshold * threshold;
}

function texturePaintPrimaryTouch(event = null) {
  const changedTouches = event?.changedTouches;
  if (changedTouches?.length) {
    return changedTouches[0];
  }
  const targetTouches = event?.targetTouches;
  if (targetTouches?.length) {
    return targetTouches[0];
  }
  const touches = event?.touches;
  return touches?.length ? touches[0] : null;
}

function texturePaintTouchFromList(list = null, identifier = null) {
  if (!list?.length) {
    return null;
  }
  if (identifier === null || identifier === undefined) {
    return list[0];
  }
  for (const touch of list) {
    if (touch?.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

function texturePaintActiveTouch(event = null, identifier = null) {
  return texturePaintTouchFromList(event?.touches, identifier)
    || texturePaintTouchFromList(event?.targetTouches, identifier)
    || texturePaintTouchFromList(event?.changedTouches, identifier)
    || texturePaintPrimaryTouch(event);
}

function texturePaintGpuTargetEffectivelyEmpty(targetEntry = null) {
  const layer = targetEntry?.layer || null;
  if (!targetEntry) {
    return false;
  }
  if (
    layer?.isEmpty === true
    && layer?.texturePaintGpuPainted !== true
    && layer?.texturePaintHasPaint !== true
  ) {
    targetEntry.emptyTransparent = true;
    targetEntry.texturePaintLayerHasPaint = false;
    return true;
  }
  if (
    layer?.texturePaintGpuPainted === true
    || layer?.texturePaintHasPaint === true
    || targetEntry.texturePaintLayerHasPaint === true
  ) {
    return false;
  }
  if (layer?.isEmpty === true && targetEntry.emptyTransparent !== false) {
    return true;
  }
  if (targetEntry.emptyTransparent === true) {
    return true;
  }
  if (targetEntry.emptyTransparent === false) {
    return false;
  }
  return Math.max(0, Math.floor(Number(targetEntry.paintRevision) || 0)) <= 0
    && layer?.isEmpty !== false;
}

function texturePaintActiveLayerMode(editor = null, material = null) {
  if (editor?.texturePaintLayerModeActive?.() !== true) {
    return false;
  }
  return true;
}

function texturePaintLiveProjectionFrameNeedsVisibleRewarm(editor = null) {
  const frame = editor?.textureAirbrushLiveProjectionFrameState || null;
  if (!frame) {
    return true;
  }
  if (typeof editor.textureAirbrushLiveProjectionFrameCurrent !== "function") {
    return false;
  }
  return editor.textureAirbrushLiveProjectionFrameCurrent(frame) !== true;
}

function texturePaintPressureNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function texturePaintEventCarriesNativePressure(event = null) {
  if (!event) {
    return false;
  }
  const pointerType = String(event.pointerType || "").toLowerCase();
  const pressure = texturePaintPressureNumber(event.pressure);
  const vendorPressure = texturePaintPressureNumber(event.webkitPressure)
    ?? texturePaintPressureNumber(event.mozPressure);
  if (vendorPressure !== null && vendorPressure > 0) {
    return true;
  }
  const force = texturePaintPressureNumber(event.webkitForce ?? event.force);
  if (force !== null && force > 0) {
    return true;
  }
  if (pressure === null || pressure <= 0) {
    return false;
  }
  return pointerType === "pen" || pointerType === "touch" || pressure !== 0.5;
}

function texturePaintEventNeedsPressureField(event = null) {
  const pointerType = String(event?.pointerType || "").toLowerCase();
  const pressure = texturePaintPressureNumber(event?.pressure);
  return pressure === null
    || pressure <= 0
    || ((pointerType === "" || pointerType === "mouse") && pressure === 0.5);
}

function webKitForceEventsAvailable() {
  const documentRef = globalThis.document || null;
  return Boolean(documentRef && "onwebkitmouseforcechanged" in documentRef);
}

function texturePaintReleasePointerCapture(canvas = null, pointerId = null) {
  if (!canvas || pointerId === null || pointerId === undefined || typeof canvas.releasePointerCapture !== "function") {
    return false;
  }
  try {
    if (typeof canvas.hasPointerCapture === "function" && !canvas.hasPointerCapture(pointerId)) {
      return false;
    }
    canvas.releasePointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

function texturePaintSetPointerCapture(canvas = null, pointerId = null) {
  if (!canvas || pointerId === null || pointerId === undefined || typeof canvas.setPointerCapture !== "function") {
    return false;
  }
  try {
    canvas.setPointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

function texturePaintPointerReleaseEvent(sourceEvent = null, pointerId = null) {
  const clientX = Number(sourceEvent?.clientX ?? sourceEvent?.pageX ?? 0) || 0;
  const clientY = Number(sourceEvent?.clientY ?? sourceEvent?.pageY ?? 0) || 0;
  return {
    pointerId,
    pointerType: sourceEvent?.pointerType || "mouse",
    button: sourceEvent?.button ?? 0,
    buttons: 0,
    clientX,
    clientY,
    pageX: Number(sourceEvent?.pageX ?? clientX) || clientX,
    pageY: Number(sourceEvent?.pageY ?? clientY) || clientY,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {}
  };
}

function texturePaintClearOrbitPointerState(editor = null, sourceEvent = null, pointerId = null) {
  const controls = editor?.controls;
  if (!controls) {
    return false;
  }
  let changed = false;
  const hasPaintPointerId = pointerId !== null && pointerId !== undefined;
  const isPaintPointer = (id) => !hasPaintPointerId || id == pointerId;
  let trackedPointers = Array.isArray(controls._pointers)
    ? controls._pointers.filter((id) => id !== null && id !== undefined)
    : [];
  const trackedPaintPointers = trackedPointers.filter(isPaintPointer);
  if (trackedPaintPointers.length > 0 && typeof controls._onPointerUp === "function") {
    for (const trackedPointer of trackedPaintPointers) {
      try {
        controls._onPointerUp(texturePaintPointerReleaseEvent(sourceEvent, trackedPointer));
        changed = true;
      } catch {
        // OrbitControls can throw if browser capture was already released; the
        // direct cleanup below still restores the idle state for paint-owned pointers.
      }
    }
  }
  trackedPointers = Array.isArray(controls._pointers)
    ? controls._pointers.filter((id) => id !== null && id !== undefined)
    : [];
  const hasUnrelatedOrbitPointer = hasPaintPointerId
    && trackedPointers.some((id) => !isPaintPointer(id));
  if (hasUnrelatedOrbitPointer) {
    return changed;
  }
  const element = controls.domElement || editor?.canvas || null;
  const documentRef = element?.ownerDocument || globalThis.document || null;
  if (documentRef && typeof controls._onPointerMove === "function") {
    documentRef.removeEventListener?.("pointermove", controls._onPointerMove);
    changed = true;
  }
  if (documentRef && typeof controls._onPointerUp === "function") {
    documentRef.removeEventListener?.("pointerup", controls._onPointerUp);
    changed = true;
  }
  const releaseTarget = element || editor?.canvas || null;
  const releaseIds = new Set(trackedPaintPointers.length ? trackedPaintPointers : trackedPointers);
  if (pointerId !== null && pointerId !== undefined) {
    releaseIds.add(pointerId);
  }
  for (const id of releaseIds) {
    if (releaseTarget === editor?.canvas && id === pointerId) {
      continue;
    }
    texturePaintReleasePointerCapture(releaseTarget, id);
  }
  if (Array.isArray(controls._pointers) && controls._pointers.length > 0) {
    controls._pointers.length = 0;
    changed = true;
  }
  if (controls._pointerPositions && typeof controls._pointerPositions === "object") {
    for (const key of Object.keys(controls._pointerPositions)) {
      delete controls._pointerPositions[key];
      changed = true;
    }
  }
  if ("state" in controls && controls.state !== -1) {
    controls.state = -1;
    changed = true;
  }
  if (controls._cursorStyle === "grab" && element?.style) {
    element.style.cursor = "grab";
  }
  return changed;
}

function texturePaintClearFallbackInputState(editor = null) {
  if (!editor) {
    return false;
  }
  editor.texturePaintMouseFallbackActive = false;
  editor.texturePaintMouseFallbackLastEvent = null;
  editor.texturePaintTouchFallbackActive = false;
  editor.texturePaintTouchFallbackIdentifier = null;
  return true;
}

function texturePaintInputDebugEnabled() {
  return typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrush");
}

function exposeTexturePaintInputDebug(editor = null, label = "", event = null, detail = {}) {
  if (!texturePaintInputDebugEnabled()) {
    return;
  }
  const root = window?.document?.documentElement || null;
  if (!root?.dataset) {
    return;
  }
  root.dataset.textureAirbrushDebugInputCount = String(
    Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugInputCount) || 0)) + 1
  );
  root.dataset.textureAirbrushDebugInputLabel = label || "";
  root.dataset.textureAirbrushDebugInputEventType = String(event?.type || "");
  root.dataset.textureAirbrushDebugInputButton = String(event?.button ?? "");
  root.dataset.textureAirbrushDebugInputButtons = String(event?.buttons ?? "");
  root.dataset.textureAirbrushDebugInputActiveTool = String(editor?.activeTool || "");
  root.dataset.textureAirbrushDebugInputPainting = String(editor?.painting === true);
  root.dataset.textureAirbrushDebugInputDetail = JSON.stringify(detail || {});
}

function exposeTexturePaintStrokeDebug(editor = null, label = "", event = null, detail = {}) {
  if (!texturePaintInputDebugEnabled()) {
    return;
  }
  const root = window?.document?.documentElement || null;
  if (!root?.dataset) {
    return;
  }
  root.dataset.textureAirbrushDebugStrokePathCount = String(
    Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugStrokePathCount) || 0)) + 1
  );
  root.dataset.textureAirbrushDebugStrokePathLabel = label || "";
  root.dataset.textureAirbrushDebugStrokePathEventType = String(event?.type || "");
  root.dataset.textureAirbrushDebugStrokePathTool = String(editor?.activeTool || "");
  root.dataset.textureAirbrushDebugStrokePathPainting = String(editor?.painting === true);
  root.dataset.textureAirbrushDebugStrokePathDetail = JSON.stringify(detail || {});
}

export function installPaintToolMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    OrbitControls,
    TransformControls,
    cloneClipWithStartOffsetApplied,
    configuredClipStartOffsetSeconds,
    remainingClipStartOffsetSeconds,
    loadBirdFlapProfile,
    ACTOR_TARGETS,
    PREVIEW_PARAMS,
    BASE_COLOR,
    SELECTED_COLOR,
    MODIFIED_COLOR,
    SELECTED_MODIFIED_COLOR,
    CURVE_CHANNELS,
    CURVE_CHANNEL_KEYS,
    ADDITIVE_POSE_EASE_FRAMES,
    RIG_BONE_GROUPS,
    EDIT_ONLY_TOOLS,
    finitePoseValue,
    writeJsonFile
  } = deps;
  Object.assign(BirdWeightEditor.prototype, {
    onPointerDown(event) {
      this.texturePaintLastPointerEventAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      this.textureAirbrushPendingInitialStroke = null;
      if (event.button !== 0 || this.activeTool === "orbit" || this.activeTool === "move") {
        exposeTexturePaintInputDebug(this, "pointerdown-ignored", event, {
          reason: event.button !== 0 ? "non-primary-button" : "tool",
          button: event.button ?? null,
          activeTool: this.activeTool || ""
        });
        return;
      }
      exposeTexturePaintInputDebug(this, "pointerdown", event, {
        activeTool: this.activeTool || "",
        pointerId: event.pointerId ?? null
      });
      this.lastCanvasPointerPaintAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (this.activeTool === "bone") {
        if (this.transformControls?.enabled && this.transformControls.object && (this.transformControls.axis || this.transformControls.dragging)) {
          event.preventDefault();
          event.stopPropagation?.();
          return;
        }
        event.preventDefault();
        event.stopPropagation?.();
        this.pickBoneFromEvent(event);
        return;
      }
      const keepWebKitForceEvents = this.textureAirbrushShouldKeepWebKitForceEvents?.(event) === true;
      if (!keepWebKitForceEvents) {
        event.preventDefault();
      }
      if (this.activeTool === "eyedropper") {
        this.painting = true;
        this.controls.enabled = false;
        this.texturePaintActivePointerId = event.pointerId ?? null;
        texturePaintSetPointerCapture(this.canvas, event.pointerId);
        this.pickTextureColorFromEvent(event);
        return;
      }
      if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser") {
        this.cancelTextureAirbrushScheduledPrewarm?.();
        this.cancelTextureAirbrushDeferredBroadLayerPrewarm?.();
        // Pen contact must not run camera or GPU initialization. The queued
        // stroke rebuilds its current visible patch from the captured point.
        this.texturePaintStrokePoint = null;
        this.textureAirbrushResetStrokeSpacing?.();
        this.textureAirbrushResetStrokeBrushState?.();
        this.textureAirbrushResetStrokePressureState?.();
        this.textureAirbrushResetInputSamplingState?.();
        this.showTextureStrokeCursor?.(event, { prewarm: false });
        const startPoint = texturePaintFiniteClientPoint(event);
        this.textureAirbrushPendingInitialStroke = startPoint
          ? {
              point: startPoint,
              event: this.textureAirbrushInputEventAtPoint?.(event, startPoint) || event,
              tool: this.activeTool
            }
          : null;
      } else if (this.activeTool === "clone") {
        this.settleTextureAirbrushCameraMotion?.();
        this.updateTextureBrushCursor?.(event);
        this.textureAirbrushPendingInitialStroke = null;
      } else if (this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.updateSelectionBrushCursor?.(event);
        this.textureAirbrushPendingInitialStroke = null;
      }
      const undoLabel = this.activeTool === "neighbor"
        ? "Neighbor pen"
        : this.activeTool === "clone"
          ? "Clone paint"
          : this.activeTool === "airbrush"
            ? "Texture airbrush"
            : this.activeTool === "texture-eraser"
              ? "Texture layer erase"
            : this.activeTool === "lasso"
              ? "Lasso selection"
          : "Paint stroke";
      if (this.usesSelectionStrokeUndo?.(this.activeTool)) {
        this.beginSelectionStrokeUndo?.(undoLabel);
      } else if (this.usesTextureStrokeUndo?.(this.activeTool)) {
        this.beginTexturePaintStrokeUndo?.(undoLabel);
      } else {
        this.pushUndoState?.(undoLabel);
      }
      if (this.activeTool === "lasso") {
        this.controls.enabled = false;
        this.painting = true;
        this.texturePaintActivePointerId = event.pointerId ?? null;
        texturePaintSetPointerCapture(this.canvas, event.pointerId);
        this.beginLassoStroke(event);
        return;
      }
      if (this.activeTool === "neighbor") {
        this.controls.enabled = false;
        this.painting = true;
        this.texturePaintActivePointerId = event.pointerId ?? null;
        texturePaintSetPointerCapture(this.canvas, event.pointerId);
        const changed = this.beginNeighborStroke(event);
        if (changed > 0) {
          this.queueSelectionPaintChange?.(changed, "neighbor");
        }
        return;
      }
      this.painting = true;
      this.controls.enabled = false;
      this.texturePaintActivePointerId = event.pointerId ?? null;
      if (!keepWebKitForceEvents) {
        texturePaintSetPointerCapture(this.canvas, event.pointerId);
      }
      if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser") {
        const pendingInitialStroke = this.textureAirbrushPendingInitialStroke || null;
        this.textureAirbrushPendingInitialStroke = null;
        if (pendingInitialStroke?.tool === this.activeTool) {
          this.paintTextureStrokeFromEvent?.(pendingInitialStroke.event, {
            reset: true,
            strokeStart: pendingInitialStroke.point
          });
        }
        return;
      }
      if (this.activeTool === "clone") {
        this.paintTextureStrokeFromEvent?.(event, { reset: true });
      } else {
        this.paintFromEvent(event);
      }
    },

    onCanvasClick(event) {
      if (this.activeTool !== "airbrush" && this.activeTool !== "texture-eraser" && this.activeTool !== "clone") {
        return;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (this.texturePaintSuppressClickUntil && now < this.texturePaintSuppressClickUntil) {
        event.preventDefault();
        return;
      }
      if (this.lastCanvasPointerPaintAt && now - this.lastCanvasPointerPaintAt < 180) {
        return;
      }
      event.preventDefault();
      this.lastCanvasPointerPaintAt = now;
      const undoLabel = this.activeTool === "clone" ? "Clone paint" : "Texture airbrush";
      if (this.usesTextureStrokeUndo?.(this.activeTool)) {
        this.beginTexturePaintStrokeUndo?.(undoLabel);
      } else {
        this.pushUndoState?.(undoLabel);
      }
      this.settleTextureAirbrushCameraMotion?.();
      this.prewarmTextureAirbrushAfterCameraChange?.();
      this.updateTextureBrushCursor?.(event);
      this.paintTextureStrokeFromEvent?.(event, { reset: true });
      this.textureAirbrushEndNeighborPaintStroke?.();
      this.endTexturePaintStrokeUndo?.();
    },

    onPointerMove(event) {
      this.texturePaintLastPointerEventAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (!this.painting && this.activeTool === "neighbor") {
        this.updateNeighborHover(event);
        return;
      }
      if (!this.painting && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone")) {
        this.updateTextureBrushCursor?.(event);
        return;
      }
      if (!this.painting && this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.updateSelectionBrushCursor?.(event);
        return;
      }
      if (this.activeTool === "eyedropper") {
        if (!this.painting) {
          return;
        }
        event.preventDefault();
        this.pickTextureColorFromEvent(event);
        return;
      }
      if (!this.painting || this.activeTool === "orbit" || this.activeTool === "move" || this.activeTool === "bone") {
        return;
      }
      const buttons = Number(event?.buttons);
      const inferReleaseFromButtons = !texturePaintPointerIsHighRateBrushInput(event);
      if (inferReleaseFromButtons && Number.isFinite(buttons) && (buttons & 1) !== 1) {
        this.onPointerUp(event);
        return;
      }
      if (this.activeTool === "neighbor") {
        event.preventDefault();
        const changed = this.continueNeighborStroke(event);
        if (changed > 0) {
          this.queueSelectionPaintChange?.(changed, "neighbor");
        }
        return;
      }
      if (this.activeTool === "lasso") {
        event.preventDefault();
        this.continueLassoStroke(event);
        return;
      }
      const keepWebKitForceEvents = this.textureAirbrushShouldKeepWebKitForceEvents?.(event) === true;
      if (!keepWebKitForceEvents) {
        event.preventDefault();
      }
      if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone") {
        if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser") {
          this.showTextureStrokeCursor?.(event);
          const pendingInitialStroke = this.textureAirbrushPendingInitialStroke || null;
          if (pendingInitialStroke?.tool === this.activeTool) {
            const currentPoint = texturePaintFiniteClientPoint(event);
            if (!currentPoint) {
              return;
            }
            if (
              texturePaintClientDistanceSqValues(
                pendingInitialStroke.point.clientX,
                pendingInitialStroke.point.clientY,
                currentPoint.clientX,
                currentPoint.clientY
              ) < texturePaintInitialStrokeDragThresholdSq(this)
            ) {
              return;
            }
            this.textureAirbrushPendingInitialStroke = null;
            this.paintTextureStrokeFromEvent?.(event, {
              reset: true,
              strokeStart: pendingInitialStroke.point
            });
            return;
          }
        } else {
          this.updateTextureBrushCursor?.(event);
        }
        this.paintTextureStrokeFromEvent?.(event);
        return;
      } else if (this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.updateSelectionBrushCursor?.(event);
      }
      this.paintFromEvent(event);
    },

    onCanvasPointerRawUpdate(event) {
      if (!this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      if (!this.painting) {
        return false;
      }
      // pointermove delivers these samples together through getCoalescedEvents.
      // Painting pointerrawupdate as well submits the same tablet path twice and
      // forces a WebGPU flush for every hardware-rate sample.
      this.textureAirbrushRememberNativePressureEvent?.(event);
      return true;
    },

    texturePaintMouseFallbackEvent(sourceEvent, fallback = {}) {
      if (!sourceEvent) {
        return sourceEvent;
      }
      const converted = {
        type: sourceEvent.type || fallback.type,
        clientX: sourceEvent.clientX,
        clientY: sourceEvent.clientY,
        button: sourceEvent.button ?? fallback.button ?? 0,
        buttons: fallback.forceButtons === true
          ? fallback.buttons ?? sourceEvent.buttons ?? 1
          : sourceEvent.buttons ?? fallback.buttons ?? 1,
        pointerId: fallback.pointerId,
        pointerType: sourceEvent.pointerType || fallback.pointerType || "",
        pressure: sourceEvent.pressure ?? fallback.pressure,
        webkitPressure: sourceEvent.webkitPressure ?? fallback.webkitPressure,
        mozPressure: sourceEvent.mozPressure ?? fallback.mozPressure,
        tangentialPressure: sourceEvent.tangentialPressure ?? fallback.tangentialPressure,
        webkitForce: sourceEvent.webkitForce ?? fallback.webkitForce,
        force: sourceEvent.force ?? fallback.force,
        tiltX: sourceEvent.tiltX ?? fallback.tiltX,
        tiltY: sourceEvent.tiltY ?? fallback.tiltY,
        twist: sourceEvent.twist ?? fallback.twist,
        width: sourceEvent.width ?? fallback.width,
        height: sourceEvent.height ?? fallback.height,
        altKey: Boolean(sourceEvent.altKey ?? fallback.altKey),
        ctrlKey: Boolean(sourceEvent.ctrlKey ?? fallback.ctrlKey),
        metaKey: Boolean(sourceEvent.metaKey ?? fallback.metaKey),
        shiftKey: Boolean(sourceEvent.shiftKey ?? fallback.shiftKey),
        timeStamp: sourceEvent.timeStamp ?? fallback.timeStamp,
        preventDefault: () => sourceEvent.preventDefault?.(),
        stopPropagation: () => sourceEvent.stopPropagation?.()
      };
      return this.textureAirbrushEventWithRetainedNativePressure?.(converted, sourceEvent) || converted;
    },

    texturePaintTouchFallbackEvent(sourceEvent, touch = null, fallback = {}) {
      if (!sourceEvent || !touch) {
        return null;
      }
      const force = Number(touch.force);
      const hasTouchForce = Number.isFinite(force) && force > 0;
      const pressure = hasTouchForce
        ? force
        : fallback.pressure;
      const touchType = String(touch.touchType || "").toLowerCase();
      const converted = {
        type: sourceEvent.type || fallback.type,
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0,
        buttons: 1,
        pointerId: touch.identifier,
        pointerType: touchType === "stylus" ? "pen" : "touch",
        pressure,
        webkitPressure: hasTouchForce ? pressure : fallback.webkitPressure,
        force: hasTouchForce ? pressure : (fallback.force ?? pressure),
        width: Number.isFinite(Number(touch.radiusX)) ? Math.max(1, Number(touch.radiusX) * 2) : fallback.width,
        height: Number.isFinite(Number(touch.radiusY)) ? Math.max(1, Number(touch.radiusY) * 2) : fallback.height,
        altitudeAngle: touch.altitudeAngle ?? fallback.altitudeAngle,
        azimuthAngle: touch.azimuthAngle ?? fallback.azimuthAngle,
        altKey: Boolean(sourceEvent.altKey ?? fallback.altKey),
        ctrlKey: Boolean(sourceEvent.ctrlKey ?? fallback.ctrlKey),
        metaKey: Boolean(sourceEvent.metaKey ?? fallback.metaKey),
        shiftKey: Boolean(sourceEvent.shiftKey ?? fallback.shiftKey),
        timeStamp: sourceEvent.timeStamp ?? fallback.timeStamp,
        preventDefault: () => sourceEvent.preventDefault?.(),
        stopPropagation: () => sourceEvent.stopPropagation?.()
      };
      if (hasTouchForce) {
        converted.__cleanupPressureSource = "native";
      }
      return this.textureAirbrushEventWithRetainedNativePressure?.(converted, sourceEvent) || converted;
    },

    shouldIgnoreMouseFallbackForRecentPointer() {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const lastPointer = Number(this.texturePaintLastPointerEventAt);
      return Number.isFinite(lastPointer) && now - lastPointer <= 160;
    },

    texturePaintMouseFallbackToolActive() {
      return this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone";
    },

    textureAirbrushShouldKeepWebKitForceEvents(event = null) {
      if (!this.texturePaintMouseFallbackToolActive?.() || !webKitForceEventsAvailable()) {
        return false;
      }
      const pointerType = String(event?.pointerType || "").toLowerCase();
      return pointerType === "" || pointerType === "mouse" || pointerType === "pen";
    },

    textureAirbrushRememberNativePressureEvent(event = null) {
      if (!event || texturePaintEventCarriesNativePressure(event) !== true) {
        return false;
      }
      const details = this.textureAirbrushPressureDetails?.(event, {}) || {};
      if (details.source !== "native" || !Number.isFinite(Number(details.pressure))) {
        return false;
      }
      const pressure = Math.max(0.02, Math.min(1, Number(details.pressure)));
      this.textureAirbrushNativePressureSample = {
        pressure,
        pointerType: String(event.pointerType || ""),
        pressureSource: "native",
        webkitPressure: texturePaintPressureNumber(event.webkitPressure),
        mozPressure: texturePaintPressureNumber(event.mozPressure),
        webkitForce: texturePaintPressureNumber(event.webkitForce),
        force: texturePaintPressureNumber(event.force),
        clientX: texturePaintPressureNumber(event.clientX),
        clientY: texturePaintPressureNumber(event.clientY),
        time: typeof performance !== "undefined" ? performance.now() : Date.now()
      };
      return true;
    },

    textureAirbrushRetainedNativePressureSample() {
      const sample = this.textureAirbrushNativePressureSample || null;
      if (!sample || !Number.isFinite(Number(sample.pressure))) {
        return null;
      }
      if (!this.painting && !this.texturePaintMouseFallbackActive) {
        return null;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const ageMs = now - (Number(sample.time) || 0);
      return ageMs <= 600 ? sample : null;
    },

    textureAirbrushCacheNativePressureForStroke(event = null) {
      if (this.textureAirbrushRememberNativePressureEvent?.(event) !== true) {
        return false;
      }
      const sample = this.textureAirbrushNativePressureSample || null;
      if (!sample || !Number.isFinite(Number(sample.pressure))) {
        return false;
      }
      return true;
    },

    textureAirbrushEventWithRetainedNativePressure(event = null, fallbackEvent = null) {
      if (!event) {
        return event;
      }
      if (this.textureAirbrushRememberNativePressureEvent?.(event) === true) {
        const sample = this.textureAirbrushNativePressureSample || null;
        if (!sample || texturePaintEventNeedsPressureField(event) !== true) {
          return event;
        }
        return {
          ...event,
          pressure: sample.pressure,
          webkitPressure: texturePaintPressureNumber(event.webkitPressure) ?? sample.webkitPressure ?? sample.pressure,
          mozPressure: texturePaintPressureNumber(event.mozPressure) ?? sample.mozPressure,
          webkitForce: texturePaintPressureNumber(event.webkitForce) ?? sample.webkitForce,
          force: texturePaintPressureNumber(event.force) ?? sample.force ?? sample.pressure,
          pointerType: event.pointerType || sample.pointerType || "",
          __cleanupRetainedNativePressure: true,
          __cleanupPressureSource: sample.pressureSource || "native"
        };
      }
      if (fallbackEvent && fallbackEvent !== event) {
        this.textureAirbrushRememberNativePressureEvent?.(fallbackEvent);
      }
      const sample = this.textureAirbrushRetainedNativePressureSample?.();
      if (!sample || texturePaintEventCarriesNativePressure(event) === true) {
        return event;
      }
      return {
        ...event,
        pressure: sample.pressure,
        webkitPressure: texturePaintPressureNumber(event.webkitPressure) ?? sample.webkitPressure ?? sample.pressure,
        mozPressure: texturePaintPressureNumber(event.mozPressure) ?? sample.mozPressure,
        webkitForce: texturePaintPressureNumber(event.webkitForce) ?? sample.webkitForce,
        force: texturePaintPressureNumber(event.force) ?? sample.force ?? sample.pressure,
        pointerType: event.pointerType || sample.pointerType || "",
        __cleanupRetainedNativePressure: true,
        __cleanupPressureSource: sample.pressureSource || "native"
      };
    },

    onCanvasMouseDownFallback(event, options = {}) {
      const hasButton = event?.button !== undefined && event?.button !== null;
      if (this.painting || this.texturePaintMouseFallbackActive) {
        this.textureAirbrushCacheNativePressureForStroke?.(event);
        exposeTexturePaintInputDebug(this, "mousedown-fallback-ignored", event, {
          reason: "active-pointer",
          hasButton,
          allowMissingButton: options.allowMissingButton === true,
          activePointerId: this.texturePaintActivePointerId ?? null,
          mouseFallbackActive: this.texturePaintMouseFallbackActive === true
        });
        return false;
      }
      if (
        !this.texturePaintMouseFallbackToolActive?.()
        || (hasButton ? event.button !== 0 : options.allowMissingButton !== true)
        || this.shouldIgnoreMouseFallbackForRecentPointer?.(event)
      ) {
        exposeTexturePaintInputDebug(this, "mousedown-fallback-ignored", event, {
          reason: !this.texturePaintMouseFallbackToolActive?.()
            ? "tool"
            : (hasButton ? event.button !== 0 : options.allowMissingButton !== true)
              ? "non-primary-button"
              : "recent-pointer",
          hasButton,
          allowMissingButton: options.allowMissingButton === true
        });
        return false;
      }
      exposeTexturePaintInputDebug(this, "mousedown-fallback", event, {
        hasButton,
        allowMissingButton: options.allowMissingButton === true
      });
      this.texturePaintMouseFallbackActive = true;
      this.texturePaintMouseFallbackLastEvent = event;
      this.textureAirbrushRememberNativePressureEvent?.(event);
      return this.onPointerDown(this.texturePaintMouseFallbackEvent?.(event, {
        button: 0,
        buttons: 1
      }) || event) !== false;
    },

    onCanvasMouseMoveFallback(event) {
      if (!this.texturePaintMouseFallbackActive || !this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      if (event?.buttons !== undefined && (event.buttons & 1) !== 1) {
        this.onCanvasMouseUpFallback?.(event);
        return false;
      }
      this.texturePaintMouseFallbackLastEvent = event;
      this.textureAirbrushRememberNativePressureEvent?.(event);
      this.onPointerMove(this.texturePaintMouseFallbackEvent?.(event, {
        button: 0,
        buttons: 1
      }) || event);
      return true;
    },

    onCanvasPressureMouseMoveFallback(event) {
      if (!this.texturePaintMouseFallbackToolActive?.() || texturePaintEventCarriesNativePressure(event) !== true) {
        return false;
      }
      this.textureAirbrushCacheNativePressureForStroke?.(event);
      if (
        !this.painting
        || this.texturePaintMouseFallbackActive
        || (this.texturePaintActivePointerId !== null && this.texturePaintActivePointerId !== undefined)
      ) {
        return false;
      }
      this.onPointerMove(this.texturePaintMouseFallbackEvent?.(event, {
        button: 0,
        buttons: 1
      }) || event);
      return true;
    },

    onCanvasMouseUpFallback(event) {
      if (!this.texturePaintMouseFallbackActive) {
        if (this.painting === true && this.texturePaintMouseFallbackToolActive?.()) {
          exposeTexturePaintInputDebug(this, "mouseup-safety-pointerup", event, {
            activePointerId: this.texturePaintActivePointerId ?? null,
            activeTool: this.activeTool || ""
          });
          this.onPointerUp(event);
          return true;
        }
        return false;
      }
      this.texturePaintMouseFallbackActive = false;
      this.texturePaintMouseFallbackLastEvent = null;
      this.onPointerUp();
      return true;
    },

    onCanvasTouchStartFallback(event) {
      if (!this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      const touch = texturePaintPrimaryTouch(event);
      const converted = this.texturePaintTouchFallbackEvent?.(event, touch);
      if (!converted) {
        return false;
      }
      if (
        this.painting
        && this.texturePaintActivePointerId !== null
        && this.texturePaintActivePointerId !== undefined
      ) {
        this.textureAirbrushCacheNativePressureForStroke?.(converted);
        return false;
      }
      this.texturePaintTouchFallbackActive = true;
      this.texturePaintTouchFallbackIdentifier = touch.identifier;
      this.textureAirbrushCacheNativePressureForStroke?.(converted);
      event?.preventDefault?.();
      this.onPointerDown(converted);
      return true;
    },

    onCanvasTouchMoveFallback(event) {
      if (!this.texturePaintTouchFallbackActive || !this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      const touch = texturePaintActiveTouch(event, this.texturePaintTouchFallbackIdentifier);
      const converted = this.texturePaintTouchFallbackEvent?.(event, touch);
      if (!converted) {
        return false;
      }
      this.textureAirbrushCacheNativePressureForStroke?.(converted);
      event?.preventDefault?.();
      this.onPointerMove(converted);
      return true;
    },

    onCanvasTouchEndFallback(event) {
      if (!this.texturePaintTouchFallbackActive) {
        return false;
      }
      this.texturePaintTouchFallbackActive = false;
      this.texturePaintTouchFallbackIdentifier = null;
      event?.preventDefault?.();
      this.onPointerUp();
      return true;
    },

    onCanvasTouchForceChangeFallback(event) {
      if (!this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      if (!this.painting) {
        return this.onCanvasTouchStartFallback?.(event) === true;
      }
      return this.onCanvasTouchMoveFallback?.(event) === true;
    },

    onCanvasWebKitMouseForceWillBegin(event) {
      if (!this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      this.textureAirbrushCacheNativePressureForStroke?.(event);
      return true;
    },

    onCanvasWebKitMouseForceDown(event) {
      if (!this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      return true;
    },

    onCanvasWebKitMouseForceUp(event) {
      if (!this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      return true;
    },

    onCanvasWebKitMouseForceChanged(event) {
      if (!this.texturePaintMouseFallbackToolActive?.()) {
        return false;
      }
      this.textureAirbrushCacheNativePressureForStroke?.(event);
      const buttons = Number(event?.buttons);
      const primaryButtonDown = !Number.isFinite(buttons) || (buttons & 1) === 1;
      if (!this.painting && !this.texturePaintMouseFallbackActive) {
        if (!primaryButtonDown) {
          return false;
        }
        this.onCanvasMouseDownFallback?.(event, { allowMissingButton: true });
        return true;
      }
      this.texturePaintMouseFallbackLastEvent = event;
      if (
        !this.texturePaintMouseFallbackActive
        && this.texturePaintActivePointerId !== null
        && this.texturePaintActivePointerId !== undefined
      ) {
        return false;
      }
      this.onPointerMove(this.texturePaintMouseFallbackEvent?.(event, {
        button: 0,
        buttons: 1,
        forceButtons: true
      }) || event);
      return true;
    },

    onPointerUp(event = null) {
      this.texturePaintLastPointerEventAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      const pointerId = event?.pointerId ?? this.texturePaintActivePointerId;
      const releasePaintPointer = this.painting === true
        || this.texturePaintMouseFallbackActive === true
        || this.texturePaintTouchFallbackActive === true
        || (this.texturePaintActivePointerId !== null && this.texturePaintActivePointerId !== undefined);
      exposeTexturePaintInputDebug(this, "pointerup", event, {
        pointerId: pointerId ?? null,
        releasePaintPointer,
        activePointerId: this.texturePaintActivePointerId ?? null,
        mouseFallbackActive: this.texturePaintMouseFallbackActive === true,
        touchFallbackActive: this.texturePaintTouchFallbackActive === true
      });
      texturePaintReleasePointerCapture(this.canvas, pointerId);
      if (releasePaintPointer) {
        texturePaintClearOrbitPointerState(this, event, pointerId);
      }
      texturePaintClearFallbackInputState(this);
      this.texturePaintActivePointerId = null;
      const idleControlsEnabled = this.texturePaintIdleControlsEnabledForTool?.(this.activeTool)
        ?? (this.activeTool === "orbit" || this.activeTool === "bone");
      if (!this.painting) {
        if (this.controls && idleControlsEnabled === true) {
          this.controls.enabled = true;
        }
        return;
      }
      if (this.activeTool === "eyedropper") {
        this.painting = false;
        this.controls.enabled = idleControlsEnabled;
        return;
      }
      if (this.activeTool === "lasso") {
        const changed = this.finishLassoStroke();
        if (changed > 0) {
          this.finishPaintChange(changed, "lasso");
        } else {
          this.endSelectionStrokeUndo?.();
        }
        this.painting = false;
        this.controls.enabled = idleControlsEnabled;
        return;
      }
      this.painting = false;
      this.neighborStroke = null;
      if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone") {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.texturePaintSuppressClickUntil = now + 700;
        this.textureAirbrushPendingInitialStroke = null;
        this.textureAirbrushNativePressureSample = null;
        this.texturePaintStrokePoint = null;
        this.textureAirbrushEndNeighborPaintStroke?.();
        this.textureAirbrushEndPostCameraProjectionStroke?.();
        this.textureAirbrushResetStrokeSpacing?.();
        this.textureAirbrushResetStrokePressureState?.();
        this.textureAirbrushResetStrokeBrushState?.();
        this.textureAirbrushResetInputSamplingState?.();
        this.textureAirbrushLastPaintCameraSplitSnapshot = null;
        this.hideTextureBrushCursor?.();
      }
      try {
        this.flushSelectionStrokeFinalChange?.();
        this.endSelectionStrokeUndo?.();
        this.endTexturePaintStrokeUndo?.();
      } finally {
        if (this.controls) {
          this.controls.enabled = idleControlsEnabled;
        }
      }
    },

    usesSelectionStrokeUndo(action) {
      return action === "paint" || action === "deselect" || action === "neighbor" || action === "lasso";
    },

    usesTextureStrokeUndo(action) {
      return action === "airbrush" || action === "texture-eraser" || action === "clone";
    },

    texturePaintEventAtPoint(sourceEvent, point, fallbackEvent = null) {
      const eventValue = (name) => (
        sourceEvent?.[name] !== undefined && sourceEvent?.[name] !== null
          ? sourceEvent[name]
          : fallbackEvent?.[name]
      );
      const pointerType = eventValue("pointerType");
      const pressure = eventValue("pressure");
      const webkitPressure = eventValue("webkitPressure");
      const mozPressure = eventValue("mozPressure");
      const tangentialPressure = eventValue("tangentialPressure");
      const webkitForce = eventValue("webkitForce");
      const force = eventValue("force");
      const tiltX = eventValue("tiltX");
      const tiltY = eventValue("tiltY");
      const twist = eventValue("twist");
      const width = eventValue("width");
      const height = eventValue("height");
      const surfaceAnchor = texturePaintSurfaceAnchorForConvertedPoint(sourceEvent, point, fallbackEvent);
      const converted = {
        type: eventValue("type"),
        clientX: point.clientX,
        clientY: point.clientY,
        button: eventValue("button") ?? 0,
        buttons: eventValue("buttons") ?? 1,
        pointerId: eventValue("pointerId"),
        pointerType: pointerType || "",
        pressure,
        webkitPressure,
        mozPressure,
        tangentialPressure,
        webkitForce,
        force,
        tiltX,
        tiltY,
        twist,
        width,
        height,
        altKey: Boolean(eventValue("altKey")),
        ctrlKey: Boolean(eventValue("ctrlKey")),
        metaKey: Boolean(eventValue("metaKey")),
        shiftKey: Boolean(eventValue("shiftKey")),
        timeStamp: eventValue("timeStamp"),
        ...(surfaceAnchor ? { textureAirbrushSurfaceAnchor: surfaceAnchor } : {}),
        preventDefault: () => {
          sourceEvent?.preventDefault?.();
          if (fallbackEvent && fallbackEvent !== sourceEvent) {
            fallbackEvent.preventDefault?.();
          }
        },
        stopPropagation: () => {
          sourceEvent?.stopPropagation?.();
          if (fallbackEvent && fallbackEvent !== sourceEvent) {
            fallbackEvent.stopPropagation?.();
          }
        }
      };
      return this.textureAirbrushEventWithRetainedNativePressure?.(converted, sourceEvent) || converted;
    },

    textureAirbrushInputEventAtPoint(sourceEvent, point, fallbackEvent = null) {
      const eventValue = (name) => (
        sourceEvent?.[name] !== undefined && sourceEvent?.[name] !== null
          ? sourceEvent[name]
          : fallbackEvent?.[name]
      );
      const pointerType = eventValue("pointerType");
      const surfaceAnchor = texturePaintSurfaceAnchorForConvertedPoint(sourceEvent, point, fallbackEvent);
      const converted = {
        type: eventValue("type"),
        clientX: point.clientX,
        clientY: point.clientY,
        button: eventValue("button") ?? 0,
        buttons: eventValue("buttons") ?? 1,
        pointerId: eventValue("pointerId"),
        pointerType: pointerType || "",
        pressure: eventValue("pressure"),
        webkitPressure: eventValue("webkitPressure"),
        mozPressure: eventValue("mozPressure"),
        tangentialPressure: eventValue("tangentialPressure"),
        webkitForce: eventValue("webkitForce"),
        force: eventValue("force"),
        tiltX: eventValue("tiltX"),
        tiltY: eventValue("tiltY"),
        twist: eventValue("twist"),
        width: eventValue("width"),
        height: eventValue("height"),
        altKey: Boolean(eventValue("altKey")),
        ctrlKey: Boolean(eventValue("ctrlKey")),
        metaKey: Boolean(eventValue("metaKey")),
        shiftKey: Boolean(eventValue("shiftKey")),
        timeStamp: eventValue("timeStamp"),
        ...(surfaceAnchor ? { textureAirbrushSurfaceAnchor: surfaceAnchor } : {})
      };
      return this.textureAirbrushEventWithRetainedNativePressure?.(converted, sourceEvent) || converted;
    },

    texturePaintCoalescedEvents(event) {
      const coalesced = typeof event?.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [];
      const events = Array.isArray(coalesced) && coalesced.length ? coalesced : [event];
      const normalized = [];
      for (const pointEvent of events) {
        if (!Number.isFinite(pointEvent?.clientX) || !Number.isFinite(pointEvent?.clientY)) {
          continue;
        }
        normalized.push(this.textureAirbrushInputEventAtPoint?.(pointEvent, {
          clientX: pointEvent.clientX,
          clientY: pointEvent.clientY
        }, event) || pointEvent);
      }
      return normalized.length ? normalized : [event];
    },

    textureAirbrushRawInputEvents(event) {
      this.textureAirbrushRememberNativePressureEvent?.(event);
      const coalesced = typeof event?.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [];
      const events = Array.isArray(coalesced) && coalesced.length ? coalesced : [event];
      const finiteEvents = [];
      for (const pointEvent of events) {
        if (!Number.isFinite(pointEvent?.clientX) || !Number.isFinite(pointEvent?.clientY)) {
          continue;
        }
        finiteEvents.push(this.textureAirbrushEventWithRetainedNativePressure?.(pointEvent, event) || pointEvent);
      }
      return finiteEvents.length ? finiteEvents : [event];
    },

    textureAirbrushNormalizeInputEvents(events = [], fallbackEvent = null) {
      const normalized = [];
      for (const pointEvent of events) {
        if (!Number.isFinite(pointEvent?.clientX) || !Number.isFinite(pointEvent?.clientY)) {
          continue;
        }
        normalized.push(this.textureAirbrushInputEventAtPoint?.(pointEvent, {
          clientX: pointEvent.clientX,
          clientY: pointEvent.clientY
        }, fallbackEvent) || pointEvent);
      }
      return normalized.length ? normalized : [fallbackEvent || events[0]];
    },

    textureAirbrushStrokeSourceEvents(event, { reset = false } = {}) {
      return this.textureAirbrushRawInputEvents?.(event) || [event];
    },

    textureAirbrushStrokeInputEvents(event, { reset = false } = {}) {
      const events = this.textureAirbrushStrokeSourceEvents?.(event, { reset })
        || this.textureAirbrushRawInputEvents?.(event)
        || [event];
      return this.textureAirbrushNormalizeInputEvents?.(events, event) || events;
    },

    textureAirbrushResetInputSamplingState() {
      this.textureAirbrushInputSamplingCache = null;
    },

    textureAirbrushResetStrokeCurveState() {
      this.textureAirbrushStrokeCurveState = null;
    },

    textureAirbrushInvalidateBrushSettings(options = {}) {
      this.textureAirbrushResetInputSamplingState?.();
      this.textureAirbrushResetStrokeCurveState?.();
      this.textureAirbrushResetStrokeSpacing?.();
      this.textureAirbrushResetStrokePressureState?.();
      this.textureAirbrushResetStrokeBrushState?.();
      if (!this.painting && options.resetLiveProjection !== false) {
        this.textureAirbrushResetLiveProjectionFrame?.({ keepCurrent: true });
      }
      if (
        !this.painting
        && options.prewarm !== false
        && this.activeTool === "airbrush"
      ) {
        const event = options.event || this.lastBrushCursorEvent || null;
        const color = this.textureAirbrushColor?.() || null;
        this.scheduleTextureAirbrushPrewarm?.(event, null, {
          force: options.forcePrewarm !== false,
          radiusPixels: Math.max(1, Number(this.textureBrushRadiusScreenPixels?.()) || 8),
          opacity: this.textureAirbrushOpacity?.() ?? 0.42,
          hardness: this.textureAirbrushHardness?.() ?? 0.35,
          scatter: this.textureAirbrushScatter?.() ?? 0.35,
          visibleEdgeMode: this.textureAirbrushVisibleEdgeMode?.() || "soft",
          ...(color ? { color: { r: color.r, g: color.g, b: color.b } } : {}),
          preserveLayerDisplay: this.texturePaintLayerModeActive?.() === true,
          prewarmPaintablesWithoutHit: true,
          warmUvOccupancy: this.texturePaintLayerModeActive?.() === true,
          warmScreenHitIndex: true,
          warmNeighborTopology: true,
          tslSurfacePrewarmAll: true,
          tslSurfacePrewarmLimit: 1,
          renderCompilePass: true,
          compileOnly: true,
          idle: true
        });
      }
      return true;
    },

    textureAirbrushCachedStrokeRadiusPixels() {
      const brushRadius = Number(this.textureAirbrushStrokeBrushState?.radiusPixels);
      if (Number.isFinite(brushRadius) && brushRadius > 0) {
        return brushRadius;
      }
      const inputRadius = Number(this.textureAirbrushInputSamplingCache?.radiusPixels);
      if (Number.isFinite(inputRadius) && inputRadius > 0) {
        return inputRadius;
      }
      return null;
    },

    textureAirbrushInputSamplingState() {
      if (this.textureAirbrushInputSamplingCache) {
        return this.textureAirbrushInputSamplingCache;
      }
      const radius = Math.max(1, this.textureBrushRadiusScreenPixels?.() || 8);
      const spacingPercent = Math.max(0.1, Math.min(200, Number(this.textureAirbrushSpacingPercent?.() ?? 1)));
      const sampleStep = Math.max(
        TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MIN_PIXELS,
        Math.min(
          TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MAX_PIXELS,
          radius * TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_RADIUS_SCALE
        )
      );
      const state = {
        continuous: spacingPercent <= 100,
        radiusPixels: radius,
        sampleStep
      };
      this.textureAirbrushInputSamplingCache = state;
      return state;
    },

    textureAirbrushContinuousSampleStepPixels() {
      return this.textureAirbrushInputSamplingState?.().sampleStep
        ?? TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MAX_PIXELS;
    },

    textureAirbrushCurveSampleStepPixels(radiusPixels = null) {
      const radius = Math.max(1, Number(radiusPixels) || this.textureAirbrushCachedStrokeRadiusPixels?.() || 8);
      const spacingPercent = Math.max(0.1, Math.min(200, Number(this.textureAirbrushSpacingPercent?.() ?? 1)));
      const webGpuScreenStroke = this.textureAirbrushCanUseScreenStroke?.() === true
        && typeof this.textureAirbrushWebGpuPaintFromEvent === "function"
        && Boolean(this.textureAirbrushWebGpuDevice?.());
      if (webGpuScreenStroke) {
        return Math.max(
          TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MIN_PIXELS,
          Math.min(TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MAX_PIXELS, radius * 0.5)
        );
      }
      const spacingPixels = Math.max(
        0.1,
        Number(this.textureAirbrushSpacingPixels?.(radius)) || radius * 0.25
      );
      const continuousStep = this.textureAirbrushContinuousSampleStepPixels?.()
        || TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MAX_PIXELS;
      const lowSpacing = spacingPercent <= 10;
      const lowSpacingCurveStep = Math.max(
        lowSpacing ? 2 : 1.5,
        Math.min(
          lowSpacing
            ? TEXTURE_AIRBRUSH_LOW_SPACING_QUADRATIC_SAMPLE_MAX_PIXELS
            : TEXTURE_AIRBRUSH_QUADRATIC_SAMPLE_MAX_PIXELS,
          radius * (lowSpacing ? 0.08 : 0.22)
        )
      );
      return Math.max(
        lowSpacing ? 2 : 1.5,
        Math.min(
          continuousStep,
          Math.max(
            lowSpacing ? Math.min(spacingPixels, lowSpacingCurveStep) : spacingPixels,
            lowSpacingCurveStep
          )
        )
      );
    },

    textureAirbrushShouldInterpolateContinuousStroke() {
      return this.textureAirbrushInputSamplingState?.().continuous === true;
    },

    textureAirbrushInterpolatedStrokeEvents(sourceEvent, startPoint, endPoint) {
      if (!this.textureAirbrushShouldInterpolateContinuousStroke?.()) {
        return [sourceEvent];
      }
      if (
        !Number.isFinite(startPoint?.clientX)
        || !Number.isFinite(startPoint?.clientY)
        || !Number.isFinite(endPoint?.clientX)
        || !Number.isFinite(endPoint?.clientY)
      ) {
        return [sourceEvent];
      }
      const dx = endPoint.clientX - startPoint.clientX;
      const dy = endPoint.clientY - startPoint.clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const sampleStep = this.textureAirbrushCurveSampleStepPixels?.()
        || TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MAX_PIXELS;
      if (distance <= sampleStep + 0.001) {
        this.textureAirbrushStrokeCurveState = {
          previousInputPoint: { clientX: startPoint.clientX, clientY: startPoint.clientY },
          lastInputPoint: { clientX: endPoint.clientX, clientY: endPoint.clientY }
        };
        return [sourceEvent];
      }
      const previousInputPoint = this.textureAirbrushStrokeCurveState?.previousInputPoint || null;
      let controlPoint = {
        clientX: (startPoint.clientX + endPoint.clientX) * 0.5,
        clientY: (startPoint.clientY + endPoint.clientY) * 0.5
      };
      if (
        Number.isFinite(previousInputPoint?.clientX)
        && Number.isFinite(previousInputPoint?.clientY)
        && texturePaintClientDistanceSqValues(
          previousInputPoint.clientX,
          previousInputPoint.clientY,
          startPoint.clientX,
          startPoint.clientY
        ) > 0.000001
      ) {
        const tangentX = startPoint.clientX - previousInputPoint.clientX;
        const tangentY = startPoint.clientY - previousInputPoint.clientY;
        const nextX = endPoint.clientX - startPoint.clientX;
        const nextY = endPoint.clientY - startPoint.clientY;
        const tangentLength = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
        const nextLength = Math.sqrt(nextX * nextX + nextY * nextY);
        const directionDot = tangentLength > 0.000001 && nextLength > 0.000001
          ? (tangentX * nextX + tangentY * nextY) / (tangentLength * nextLength)
          : 1;
        if (directionDot > 0.35) {
          const controlDistance = Math.min(distance * 0.55, tangentLength * 0.5);
          const scale = tangentLength > 0.000001 ? controlDistance / tangentLength : 0;
          controlPoint = {
            clientX: startPoint.clientX + tangentX * scale,
            clientY: startPoint.clientY + tangentY * scale
          };
        }
      }
      const usesQuadraticCurve = texturePaintPointToSegmentDistanceSqValues(
        controlPoint.clientX,
        controlPoint.clientY,
        startPoint.clientX,
        startPoint.clientY,
        endPoint.clientX,
        endPoint.clientY
      ) > 0.25;
      const sampleCount = Math.max(
        1,
        Math.min(TEXTURE_AIRBRUSH_CONTINUOUS_MAX_SAMPLES, Math.ceil(distance / sampleStep))
      );
      const startSurfaceAnchor = textureAirbrushSurfaceAnchorFromPoint(startPoint);
      const endSurfaceAnchor = textureAirbrushSurfaceAnchorFromPoint(endPoint)
        || textureAirbrushSurfaceAnchorFromPoint(sourceEvent);
      const samples = [];
      for (let index = 1; index <= sampleCount; index += 1) {
        const ratio = index / sampleCount;
        const samplePoint = textureAirbrushQuadraticPoint(startPoint, controlPoint, endPoint, ratio);
        const surfaceAnchor = textureAirbrushInterpolateSurfaceAnchors(
          startSurfaceAnchor,
          endSurfaceAnchor,
          ratio
        );
        if (surfaceAnchor) {
          samplePoint.textureAirbrushSurfaceAnchor = surfaceAnchor;
        }
        const sample = this.textureAirbrushInputEventAtPoint?.(
          sourceEvent,
          samplePoint
        ) || sourceEvent;
        if (
          sourceEvent?.__cleanupRetainedNativePressure === true
          && sample
          && typeof sample === "object"
        ) {
          sample.__cleanupRetainedNativePressure = true;
          sample.__cleanupPressureSource = sourceEvent.__cleanupPressureSource || "native";
        }
        if (usesQuadraticCurve && sample && typeof sample === "object") {
          sample.textureAirbrushCurveSample = true;
        }
        samples.push(sample);
      }
      this.textureAirbrushStrokeCurveState = {
        previousInputPoint: { clientX: startPoint.clientX, clientY: startPoint.clientY },
        lastInputPoint: { clientX: endPoint.clientX, clientY: endPoint.clientY }
      };
      return samples;
    },

    showTextureStrokeCursor(event, options = {}) {
      if (!this.textureBrushCursor || !this.canvas || !event) {
        return false;
      }
      const remembered = this.rememberBrushCursorEvent?.(event);
      if (!remembered) {
        this.hideTextureBrushCursor?.();
        return false;
      }
      const radius = this.textureAirbrushCachedStrokeRadiusPixels?.()
        || this.textureBrushRadiusScreenPixels?.()
        || 8;
      if (this.showTextureBrushCursorElement) {
        this.showTextureBrushCursorElement();
      } else {
        this.textureBrushCursor.hidden = false;
      }
      if (this.setTextureBrushCursorMode) {
        this.setTextureBrushCursorMode("airbrush");
      } else {
        this.textureBrushCursor.classList.remove("is-selection", "is-deselect", "is-clone");
      }
      if (
        options.prewarm !== false
        && !this.painting
        && this.activeTool === "airbrush"
      ) {
        const color = this.textureAirbrushColor?.() || null;
        this.scheduleTextureAirbrushPrewarm?.(event, null, {
          radiusPixels: Math.max(1, Number(this.textureBrushRadiusScreenPixels?.()) || radius),
          opacity: this.textureAirbrushOpacity?.() ?? 0.42,
          hardness: this.textureAirbrushHardness?.() ?? 0.35,
          scatter: this.textureAirbrushScatter?.() ?? 0.35,
          visibleEdgeMode: this.textureAirbrushVisibleEdgeMode?.() || "soft",
          ...(color ? { color: { r: color.r, g: color.g, b: color.b } } : {}),
          preserveLayerDisplay: this.texturePaintLayerModeActive?.() === true,
          prewarmPaintablesWithoutHit: true,
          warmUvOccupancy: this.texturePaintLayerModeActive?.() === true,
          warmScreenHitIndex: true,
          warmNeighborTopology: true,
          tslSurfacePrewarmAll: true,
          tslSurfacePrewarmLimit: 1,
          renderCompilePass: true,
          compileOnly: true,
          idle: true
        });
      }
      if (
        this.painting
        && texturePaintPointerIsHighRateBrushInput(event)
        && this.scheduleBrushCursorPosition?.(event, radius)
      ) {
        return true;
      }
      this.positionBrushCursor?.(event, radius);
      return true;
    },

    queueAirbrushTextureStrokeEvent(event, { reset = false, strokeStart = null } = {}) {
      const events = this.textureAirbrushStrokeSourceEvents?.(event, { reset })
        || this.texturePaintCoalescedEvents?.(event)
        || [event];
      const explicitStrokeStart = texturePaintFiniteClientPoint(strokeStart);
      const skipInterpolatedSamples = texturePaintPointerIsHighRateBrushInput(events[0])
        || texturePaintPointerIsHighRateBrushInput(event);
      const deferImmediateWebGpuFlush = events.length > 1
        && this.textureAirbrushCanUseScreenStroke?.() === true
        && typeof this.flushTextureAirbrushScreenStroke === "function";
      // Keep coalesced samples as real screen segments. Collapsing them into one
      // segment keeps dispatch counts low but makes broad/curved airbrush strokes
      // blotchy because the GPU no longer receives the path shape to smooth.
      const collapseCoalescedWebGpuScreenStroke = false;
      const neighborScreenSamplingActive = this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser")
        && typeof this.textureAirbrushNeighborScreenSampleState === "function";
      const previousDeferImmediateWebGpuFlush = this.textureAirbrushDeferImmediateWebGpuScreenFlush;
      let queued = false;
      let previous = reset ? explicitStrokeStart : this.texturePaintStrokePoint;
      let resetSpacing = reset;
      const sampleHighRatePath = skipInterpolatedSamples
        && !collapseCoalescedWebGpuScreenStroke
        && textureAirbrushHighRateEventsNeedCurveSampling(
          events,
          previous || events[0],
          this.textureAirbrushCurveSampleStepPixels?.()
            || TEXTURE_AIRBRUSH_CONTINUOUS_SAMPLE_MAX_PIXELS
        );
      if (reset) {
        this.textureAirbrushScreenStrokeChanged = false;
        this.textureAirbrushResetInputSamplingState?.();
        this.textureAirbrushResetStrokeCurveState?.();
        this.textureAirbrushResetStrokeBrushState?.();
        this.textureAirbrushResetStrokePressureState?.();
      }
      if (this.textureAirbrushShouldUseLargeWebGpuNeighborFastQueue?.(event) === true) {
        const queuedLarge = this.textureAirbrushQueueLargeWebGpuNeighborStrokeEvents?.(events, {
          reset,
          strokeStart: explicitStrokeStart
        }) === true;
        exposeTexturePaintStrokeDebug(this, "queue-large-neighbor-result", event, {
          reset,
          queued: queuedLarge,
          sourceEvents: events.length,
          queueLength: this.textureAirbrushScreenStrokeQueue?.length || 0,
          pendingBatches: this.textureAirbrushPendingScreenStrokeBatches?.length || 0
        });
        return queuedLarge;
      }
      exposeTexturePaintStrokeDebug(this, "queue-screen-start", event, {
        reset,
        sourceEvents: events.length,
        skipInterpolatedSamples,
        sampleHighRatePath,
        deferImmediateWebGpuFlush,
        previous: previous ? { clientX: previous.clientX, clientY: previous.clientY } : null,
        explicitStrokeStart: explicitStrokeStart
          ? { clientX: explicitStrokeStart.clientX, clientY: explicitStrokeStart.clientY }
          : null,
        queueLength: this.textureAirbrushScreenStrokeQueue?.length || 0
      });
      if (deferImmediateWebGpuFlush) {
        this.textureAirbrushDeferImmediateWebGpuScreenFlush = true;
      }
      try {
        const preSmoothedEndpoint = events.at(-1) || null;
        // Reconstructed points must not grow the Neighbor frontier toward a
        // remote endpoint. Hold the screen path until it rejoins the surface.
        const preSmoothedNeighborEndpointState = neighborScreenSamplingActive
          && events.length > 1
          && (
            event?.textureAirbrushPreSmoothedSample === true
            || events.some((sample) => sample?.textureAirbrushPreSmoothedSample === true)
          )
          ? this.textureAirbrushNeighborPreSmoothedBatchEndpointState?.(
              preSmoothedEndpoint,
              this.activeTool
            ) || null
          : null;
        const rejectPreSmoothedNeighborBatch = preSmoothedNeighborEndpointState?.decisive === true
          && preSmoothedNeighborEndpointState.allowed !== true;
        const heldPreSmoothedNeighborBatch = rejectPreSmoothedNeighborBatch
          && this.textureAirbrushHoldPreSmoothedNeighborBatch?.(events) === true;
        const queueEvents = heldPreSmoothedNeighborBatch
          ? []
          : collapseCoalescedWebGpuScreenStroke || rejectPreSmoothedNeighborBatch
          ? [preSmoothedEndpoint]
          : events;
        const collapsedStrokeStart = collapseCoalescedWebGpuScreenStroke
          ? (previous || events[0])
          : null;
        for (const pointEvent of queueEvents) {
          if (!Number.isFinite(pointEvent?.clientX) || !Number.isFinite(pointEvent?.clientY)) {
            continue;
          }
          const neighborSampleState = neighborScreenSamplingActive
            ? this.textureAirbrushNeighborScreenSampleState(pointEvent, {
                reset: resetSpacing || !previous,
                radiusPixels: this.textureBrushRadiusScreenPixels?.() || 8
              })
            : null;
          if (neighborSampleState?.active === true && neighborSampleState.allowed !== true) {
            if (neighborSampleState.preservePath !== true) {
              resetSpacing = true;
              previous = null;
            }
            continue;
          }
          if (neighborSampleState?.resetAfterBreak === true) {
            resetSpacing = true;
            previous = null;
          }
          const acceptedPoint = neighborSampleState?.surfaceAnchor
            ? textureAirbrushPointWithSurfaceAnchor(pointEvent, neighborSampleState.surfaceAnchor)
            : null;
          const acceptedEvent = acceptedPoint
            ? this.textureAirbrushInputEventAtPoint?.(pointEvent, acceptedPoint) || {
                ...pointEvent,
                ...acceptedPoint
              }
            : pointEvent;
          const bridgeEvents = (Array.isArray(neighborSampleState?.bridgePoints)
            ? neighborSampleState.bridgePoints
            : [])
            .map((point) => {
              const bridgeEvent = this.textureAirbrushInputEventAtPoint?.(pointEvent, point) || {
                clientX: point.clientX,
                clientY: point.clientY,
                button: pointEvent.button,
                buttons: pointEvent.buttons,
                pointerType: pointEvent.pointerType,
                pressure: pointEvent.pressure
              };
              if (bridgeEvent && typeof bridgeEvent === "object") {
                bridgeEvent.textureAirbrushPreSmoothedSample = true;
                bridgeEvent.textureAirbrushNeighborBridgeSample = true;
                if (point.textureAirbrushNeighborBridgeReset === true) {
                  bridgeEvent.textureAirbrushNeighborBridgeReset = true;
                }
              }
              return bridgeEvent;
            })
            .filter((bridgeEvent) => (
              Number.isFinite(bridgeEvent?.clientX)
              && Number.isFinite(bridgeEvent?.clientY)
            ));
          for (const pathEvent of [...bridgeEvents, acceptedEvent]) {
            const forceSurfaceGapReset = pathEvent.textureAirbrushNeighborBridgeReset === true
              || (
                neighborSampleState?.resetBeforeAccepted === true
                && pathEvent === acceptedEvent
              );
            if (forceSurfaceGapReset) {
              resetSpacing = true;
              previous = null;
            }
            const forceNeighborStrokeReset = forceSurfaceGapReset
              || (
                neighborSampleState?.resetAfterBreak === true
                && pathEvent === acceptedEvent
              );
            if (skipInterpolatedSamples && !sampleHighRatePath) {
              const sampleCurrent = texturePaintFiniteClientPoint(pathEvent);
              const strokeStart = forceNeighborStrokeReset
                ? sampleCurrent
                : collapsedStrokeStart || previous || sampleCurrent;
              const queueStroke = this.textureAirbrushQueueSpacedScreenStroke || this.textureAirbrushQueueScreenStroke;
              const sampleQueued = queueStroke?.call(this, pathEvent, {
                strokeStart,
                reset: resetSpacing || !previous,
                ...(forceNeighborStrokeReset
                  ? { forceStrokeReset: true, preserveStrokeOpacity: true }
                  : {}),
                preSmoothedStrokePath: true,
                ...(pathEvent.textureAirbrushCurveSample === true ? { preserveCurveSamples: true } : {}),
                ...(collapseCoalescedWebGpuScreenStroke ? { deferResetRewarm: true } : {})
              }) === true;
              queued = sampleQueued || queued;
              if (this.textureAirbrushNeighborScreenStrokeBreakPending === true) {
                resetSpacing = true;
                previous = null;
                continue;
              }
              resetSpacing = false;
              previous = sampleCurrent;
              continue;
            }
            const current = texturePaintFiniteClientPoint(pathEvent);
            const strokeEvents = previous
              ? this.textureAirbrushInterpolatedStrokeEvents?.(pathEvent, previous, current) || [pathEvent]
              : [pathEvent];
            for (const strokeEvent of strokeEvents) {
              if (!Number.isFinite(strokeEvent?.clientX) || !Number.isFinite(strokeEvent?.clientY)) {
                continue;
              }
              const sampleCurrent = texturePaintFiniteClientPoint(strokeEvent);
              const strokeStart = previous || sampleCurrent;
              const queueStroke = this.textureAirbrushQueueSpacedScreenStroke || this.textureAirbrushQueueScreenStroke;
              const sampleQueued = queueStroke?.call(this, strokeEvent, {
                strokeStart,
                reset: resetSpacing || !previous,
                ...(forceNeighborStrokeReset
                  ? { forceStrokeReset: true, preserveStrokeOpacity: true }
                  : {}),
                ...(
                  skipInterpolatedSamples
                  || strokeEvent.textureAirbrushCurveSample === true
                  || strokeEvent.textureAirbrushPreSmoothedSample === true
                    ? { preSmoothedStrokePath: true }
                    : {}
                ),
                ...(strokeEvent.textureAirbrushCurveSample === true ? { preserveCurveSamples: true } : {})
              }) === true;
              queued = sampleQueued || queued;
              if (this.textureAirbrushNeighborScreenStrokeBreakPending === true) {
                resetSpacing = true;
                previous = null;
                continue;
              }
              resetSpacing = false;
              previous = sampleCurrent;
            }
          }
        }
      } finally {
        if (deferImmediateWebGpuFlush) {
          if (previousDeferImmediateWebGpuFlush === undefined) {
            delete this.textureAirbrushDeferImmediateWebGpuScreenFlush;
          } else {
            this.textureAirbrushDeferImmediateWebGpuScreenFlush = previousDeferImmediateWebGpuFlush;
          }
        }
      }
      if (previous) {
        this.texturePaintStrokePoint = previous;
      }
      if (queued && deferImmediateWebGpuFlush && previousDeferImmediateWebGpuFlush !== true) {
        const scheduled = this.scheduleTextureAirbrushImmediateWebGpuScreenFlush?.({
          live: true,
          maxBatches: TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_BATCHES,
          maxBatchSegments: TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_BATCH_SEGMENTS,
          maxSegments: TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_SEGMENTS,
          maxBatchMs: TEXTURE_AIRBRUSH_COALESCED_WEBGPU_IMMEDIATE_MAX_BATCH_MS,
          immediateWebGpuFlush: true
        }) === true;
        if (!scheduled) {
          this.scheduleTextureAirbrushScreenStrokeFlush?.();
        }
      }
      exposeTexturePaintStrokeDebug(this, "queue-screen-result", event, {
        reset,
        queued,
        sourceEvents: events.length,
        queueLength: this.textureAirbrushScreenStrokeQueue?.length || 0,
        lastQueueRadius: this.textureAirbrushScreenStrokeQueue?.at?.(-1)?.radiusPixels ?? null,
        lastQueueColor: this.textureAirbrushScreenStrokeQueue?.at?.(-1)?.color || null,
        pendingBatches: this.textureAirbrushPendingScreenStrokeBatches?.length || 0,
        screenFlushScheduled: this.textureAirbrushScreenFlushScheduled === true,
        immediateFlushScheduled: this.textureAirbrushImmediateWebGpuScreenFlushScheduled === true,
        flushing: this.textureAirbrushFlushingScreenStroke === true,
        lastPoint: previous ? { clientX: previous.clientX, clientY: previous.clientY } : null
      });
      return queued;
    },

    paintTextureStrokeFromEvent(event, { reset = false, strokeStart = null } = {}) {
      if (!event || (this.activeTool !== "airbrush" && this.activeTool !== "texture-eraser" && this.activeTool !== "clone")) {
        exposeTexturePaintStrokeDebug(this, "stroke-ignored", event, {
          reason: !event ? "missing-event" : "tool",
          activeTool: this.activeTool || ""
        });
        return false;
      }
      const useScreenStroke = this.textureAirbrushCanUseScreenStroke?.() === true;
      const current = {
        clientX: event.clientX,
        clientY: event.clientY
      };
      exposeTexturePaintStrokeDebug(this, "stroke-entry", event, {
        reset,
        useScreenStroke,
        current,
        strokeStart: texturePaintFiniteClientPoint(strokeStart),
        hasWebGpuDevice: Boolean(this.textureAirbrushWebGpuDevice?.()),
        queueLength: this.textureAirbrushScreenStrokeQueue?.length || 0,
        pendingBatches: this.textureAirbrushPendingScreenStrokeBatches?.length || 0
      });
      if (this.activeTool === "clone") {
        this.paintFromEvent(event);
        this.texturePaintStrokePoint = current;
        exposeTexturePaintStrokeDebug(this, "stroke-clone", event, { reset, current });
        return true;
      }
      if (useScreenStroke) {
        const queued = this.queueAirbrushTextureStrokeEvent(event, { reset, strokeStart });
        exposeTexturePaintStrokeDebug(this, "stroke-screen-result", event, {
          reset,
          queued,
          queueLength: this.textureAirbrushScreenStrokeQueue?.length || 0,
          pendingBatches: this.textureAirbrushPendingScreenStrokeBatches?.length || 0,
          screenFlushScheduled: this.textureAirbrushScreenFlushScheduled === true,
          immediateFlushScheduled: this.textureAirbrushImmediateWebGpuScreenFlushScheduled === true,
          flushing: this.textureAirbrushFlushingScreenStroke === true
        });
        return queued;
      }
      this.textureAirbrushReportWebGpuFallback?.({
        backend: "none",
        webGpuStatus: this.textureAirbrushWebGpuDevice?.()
          ? "visible-surface-mask-unavailable"
          : "backend-uninitialized"
      });
      exposeTexturePaintStrokeDebug(this, "stroke-no-screen-path", event, {
        reset,
        hasWebGpuDevice: Boolean(this.textureAirbrushWebGpuDevice?.()),
        canUseScreenStroke: useScreenStroke
      });
      this.setStatus?.(this.activeTool === "texture-eraser"
        ? "WebGPU eraser needs the live screen stroke path"
        : "WebGPU airbrush needs the live screen stroke path");
      return false;
    },

    captureSelectionSnapshot() {
      return (this.paintRecords || []).map((record) => [...record.selected]);
    },

    selectionSnapshotsMatch(before = [], after = []) {
      if (before.length !== after.length) {
        return false;
      }
      for (let index = 0; index < before.length; index += 1) {
        const left = before[index] || [];
        const right = after[index] || [];
        if (left.length !== right.length) {
          return false;
        }
        const rightSet = new Set(right);
        for (const value of left) {
          if (!rightSet.has(value)) {
            return false;
          }
        }
      }
      return true;
    },

    pushSelectionUndoState(label, before, after) {
      if (this.selectionSnapshotsMatch(before, after)) {
        return false;
      }
      this.undoStack.push({
        kind: "selection",
        label,
        before,
        after
      });
      if (this.undoStack.length > this.maxUndoSteps) {
        this.disposeFastHistoryState?.(this.undoStack.shift());
      }
      this.redoStack = [];
      this.updateUndoButton?.();
      this.flushTexturePaintLayerGpuTargetsToCanvases?.();
      return true;
    },

    beginSelectionStrokeUndo(label = "Paint stroke") {
      this.cancelPendingSelectionPaintVisualFlush?.();
      this.pendingSelectionPaintChange = null;
      this.selectionStrokePendingChangeSummary = null;
      this.selectionStrokeUndo = {
        label,
        before: this.captureSelectionSnapshot(),
        changed: false
      };
      return true;
    },

    markSelectionStrokeChanged(action) {
      if (!this.selectionStrokeUndo || !this.usesSelectionStrokeUndo(action)) {
        return false;
      }
      this.selectionStrokeUndo.changed = true;
      return true;
    },

    endSelectionStrokeUndo() {
      this.flushSelectionStrokeFinalChange?.();
      const stroke = this.selectionStrokeUndo;
      this.selectionStrokeUndo = null;
      if (!stroke?.changed) {
        return false;
      }
      return this.pushSelectionUndoState(stroke.label, stroke.before, this.captureSelectionSnapshot());
    },

    selectionPaintChangeScheduler() {
      const host = typeof window !== "undefined" ? window : globalThis;
      if (typeof host?.requestAnimationFrame === "function") {
        return {
          schedule: (callback) => host.requestAnimationFrame(callback),
          cancel: (handle) => host.cancelAnimationFrame?.(handle)
        };
      }
      if (typeof host?.setTimeout === "function") {
        return {
          schedule: (callback) => host.setTimeout(callback, 16),
          cancel: (handle) => host.clearTimeout?.(handle)
        };
      }
      return {
        schedule: (callback) => {
          callback();
          return null;
        },
        cancel: () => {}
      };
    },

    cancelPendingSelectionPaintVisualFlush() {
      if (this.selectionPaintChangeFlushTimer === null || this.selectionPaintChangeFlushTimer === undefined) {
        return false;
      }
      this.selectionPaintChangeScheduler?.().cancel?.(this.selectionPaintChangeFlushTimer);
      this.selectionPaintChangeFlushTimer = null;
      return true;
    },

    scheduleSelectionPaintVisualFlush() {
      if (this.selectionPaintChangeFlushTimer !== null && this.selectionPaintChangeFlushTimer !== undefined) {
        return true;
      }
      const scheduler = this.selectionPaintChangeScheduler?.();
      this.selectionPaintChangeFlushTimer = scheduler?.schedule?.(() => {
        this.selectionPaintChangeFlushTimer = null;
        this.flushPendingSelectionPaintVisualChange?.();
      });
      return true;
    },

    queueSelectionPaintChange(changed, action) {
      const amount = Math.max(0, Math.floor(Number(changed) || 0));
      if (!amount) {
        return false;
      }
      this.markSelectionStrokeChanged?.(action);
      const pending = this.pendingSelectionPaintChange || {
        changed: 0,
        action
      };
      pending.changed += amount;
      pending.action = action;
      this.pendingSelectionPaintChange = pending;

      const summary = this.selectionStrokePendingChangeSummary || {
        changed: 0,
        action
      };
      summary.changed += amount;
      summary.action = action;
      this.selectionStrokePendingChangeSummary = summary;
      this.scheduleSelectionPaintVisualFlush?.();
      return true;
    },

    flushPendingSelectionPaintVisualChange() {
      const pending = this.pendingSelectionPaintChange;
      this.pendingSelectionPaintChange = null;
      if (!pending?.changed) {
        return false;
      }
      this.finishPaintChange(pending.changed, pending.action, {
        syncPatch: false,
        updateCounts: false,
        updateMoveGizmo: false,
        updateCloneRegion: false,
        updateAllVertexMarkers: false,
        updateStatus: false
      });
      return true;
    },

    flushSelectionStrokeFinalChange() {
      this.cancelPendingSelectionPaintVisualFlush?.();
      this.flushPendingSelectionPaintVisualChange?.();
      const summary = this.selectionStrokePendingChangeSummary;
      this.selectionStrokePendingChangeSummary = null;
      if (!summary?.changed) {
        return false;
      }
      this.finishPaintChange(summary.changed, summary.action, {
        updateColors: false,
        updateMarkers: false
      });
      return true;
    },

    restoreSelectionSnapshot(snapshot = []) {
      snapshot.forEach((selected, index) => {
        const record = this.paintRecords?.[index];
        if (!record) {
          return;
        }
        record.selected = new Set((selected || []).filter((vertexIndex) => (
          Number.isInteger(vertexIndex)
          && vertexIndex < record.geometry.attributes.position.count
          && !record.deleted?.has(vertexIndex)
        )));
        this.updateRecordColors(record);
      });
      this.updateSelectionMarkers();
      if (this.viewMode === "edit") {
        this.updateAllVertexMarkers();
      }
      this.updateMoveGizmo();
      this.updateCounts();
      this.syncClonePaintControls?.();
      return true;
    },

    withSelectionUndo(label, callback) {
      const before = this.captureSelectionSnapshot();
      const result = callback?.();
      this.pushSelectionUndoState(label, before, this.captureSelectionSnapshot());
      return result;
    },

    texturePaintUndoEntryKey(type, record, materialIndex, material, targetEntry = null, layerId = "") {
      const targetLayerId = type === "gpu" && targetEntry?.layerMode === true
        ? targetEntry?.layer?.id || layerId || ""
        : layerId || "";
      const targetKey = targetLayerId
        ? ""
        : targetEntry?.target?.uuid || targetEntry?.target?.texture?.uuid || "";
      return [
        type,
        this.paintRecords?.indexOf?.(record) ?? -1,
        materialIndex ?? 0,
        material?.uuid || material?.id || "material",
        targetKey,
        targetLayerId
      ].join(":");
    },

    copyTextureToRenderTarget(sourceTexture, destinationTarget) {
      const renderer = this.renderer || null;
      if (
        !renderer?.isWebGPURenderer
        || !sourceTexture
        || !destinationTarget?.texture
        || typeof THREE?.Scene !== "function"
        || typeof THREE?.OrthographicCamera !== "function"
        || typeof THREE?.PlaneGeometry !== "function"
        || typeof THREE?.MeshBasicMaterial !== "function"
        || typeof THREE?.Mesh !== "function"
      ) {
        return false;
      }
      if (sourceTexture === destinationTarget.texture) {
        return true;
      }
      const state = this.texturePaintGpuRenderTargetCopyState ||= {};
      if (!state.scene) {
        state.scene = new THREE.Scene();
        state.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
        state.material = new THREE.MeshBasicMaterial({
          map: sourceTexture,
          transparent: false,
          depthTest: false,
          depthWrite: false,
          blending: THREE.NoBlending,
          toneMapped: false
        });
        state.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), state.material);
        state.mesh.frustumCulled = false;
        state.scene.add(state.mesh);
      }
      if (!state.material || !state.mesh || !state.scene || !state.camera) {
        return false;
      }
      if (state.material.map !== sourceTexture) {
        state.material.map = sourceTexture;
        state.material.needsUpdate = true;
      }
      const previousTarget = typeof renderer.getRenderTarget === "function"
        ? renderer.getRenderTarget()
        : null;
      const previousAutoClear = renderer.autoClear;
      try {
        renderer.setRenderTarget(destinationTarget);
        renderer.autoClear = true;
        renderer.clear?.();
        renderer.render(state.scene, state.camera);
      } catch {
        return false;
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
      }
      return true;
    },

    cloneTextureRenderTargetSnapshot(targetEntry) {
      const renderer = this.renderer || null;
      const sourceTarget = targetEntry?.target || null;
      const sourceTexture = sourceTarget?.texture || null;
      if (
        !renderer?.isWebGPURenderer
        || !sourceTexture
        || typeof THREE?.RenderTarget !== "function"
      ) {
        return null;
      }
      const width = Math.max(1, Math.floor(Number(targetEntry?.width || sourceTarget.width) || 1));
      const height = Math.max(1, Math.floor(Number(targetEntry?.height || sourceTarget.height) || 1));
      const snapshot = new THREE.RenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        format: sourceTexture.format || THREE.RGBAFormat,
        generateMipmaps: false
      });
      snapshot.texture.name = `${sourceTexture.name || "texture-paint-gpu-target"} undo snapshot`;
      texturePaintCopyRenderTargetTextureSettings(snapshot.texture, sourceTexture, THREE);
      if (!this.copyTextureToRenderTarget(sourceTexture, snapshot)) {
        snapshot.dispose?.();
        return null;
      }
      const displayTarget = targetEntry?.displayTarget || null;
      const displayTexture = displayTarget?.texture || null;
      if (displayTexture) {
        const displayWidth = Math.max(1, Math.floor(Number(displayTarget.width || width) || width));
        const displayHeight = Math.max(1, Math.floor(Number(displayTarget.height || height) || height));
        const displaySnapshot = new THREE.RenderTarget(displayWidth, displayHeight, {
          depthBuffer: false,
          stencilBuffer: false,
          format: displayTexture.format || THREE.RGBAFormat,
          generateMipmaps: false
        });
        displaySnapshot.texture.name = `${displayTexture.name || "texture-paint-gpu-display"} undo snapshot`;
        texturePaintCopyRenderTargetTextureSettings(displaySnapshot.texture, displayTexture, THREE);
        if (this.copyTextureToRenderTarget(displayTexture, displaySnapshot)) {
          snapshot.texturePaintDisplaySnapshot = displaySnapshot;
        } else {
          displaySnapshot.dispose?.();
        }
      }
      return snapshot;
    },

    texturePaintGpuTargetRevision(targetEntry = null) {
      return Math.max(0, Math.floor(Number(targetEntry?.paintRevision) || 0));
    },

    retainTexturePaintSnapshot(snapshot = null) {
      if (!snapshot) {
        return null;
      }
      snapshot.texturePaintSnapshotRefs = Math.max(1, Math.floor(Number(snapshot.texturePaintSnapshotRefs) || 1)) + 1;
      return snapshot;
    },

    releaseTexturePaintSnapshot(snapshot = null) {
      if (!snapshot) {
        return false;
      }
      const refs = Math.max(1, Math.floor(Number(snapshot.texturePaintSnapshotRefs) || 1));
      if (refs > 1) {
        snapshot.texturePaintSnapshotRefs = refs - 1;
        return false;
      }
      delete snapshot.texturePaintSnapshotRefs;
      snapshot.texturePaintDisplaySnapshot?.dispose?.();
      delete snapshot.texturePaintDisplaySnapshot;
      snapshot.dispose?.();
      return true;
    },

    disposeTexturePaintGpuPrewarmSnapshot(targetEntry = null) {
      const prewarmed = targetEntry?.prewarmedStrokeSourceSnapshot || null;
      if (!prewarmed) {
        return false;
      }
      this.releaseTexturePaintSnapshot?.(prewarmed.snapshot);
      delete targetEntry.prewarmedStrokeSourceSnapshot;
      return true;
    },

    texturePaintGpuPrewarmSnapshotCurrent(targetEntry = null, prewarmed = targetEntry?.prewarmedStrokeSourceSnapshot) {
      if (!targetEntry?.target?.texture || !prewarmed?.snapshot) {
        return false;
      }
      return prewarmed.revision === this.texturePaintGpuTargetRevision(targetEntry)
        && prewarmed.width === (targetEntry.width || targetEntry.target?.width || 0)
        && prewarmed.height === (targetEntry.height || targetEntry.target?.height || 0);
    },

    texturePaintGpuBeforeSnapshot(targetEntry = null, options = {}) {
      if (!targetEntry?.target?.texture) {
        return null;
      }
      const prewarmed = targetEntry.prewarmedStrokeSourceSnapshot || null;
      if (options.usePrewarm !== false && this.texturePaintGpuPrewarmSnapshotCurrent?.(targetEntry, prewarmed)) {
        delete targetEntry.prewarmedStrokeSourceSnapshot;
        return prewarmed.snapshot;
      }
      if (prewarmed) {
        this.disposeTexturePaintGpuPrewarmSnapshot?.(targetEntry);
      }
      const canUseClearBefore = targetEntry.layerMode === true
        && texturePaintGpuTargetEffectivelyEmpty(targetEntry);
      if (canUseClearBefore) {
        return {
          clear: true,
          width: targetEntry.width || targetEntry.target?.width || 0,
          height: targetEntry.height || targetEntry.target?.height || 0
        };
      }
      return this.cloneTextureRenderTargetSnapshot(targetEntry);
    },

    setTexturePaintGpuPrewarmSnapshot(targetEntry = null, snapshot = null, options = {}) {
      if (!targetEntry?.target?.texture || !snapshot) {
        return false;
      }
      const existing = targetEntry.prewarmedStrokeSourceSnapshot?.snapshot || null;
      if (existing && existing !== snapshot) {
        this.disposeTexturePaintGpuPrewarmSnapshot?.(targetEntry);
      } else if (existing === snapshot) {
        delete targetEntry.prewarmedStrokeSourceSnapshot;
      }
      if (options.retain === true) {
        this.retainTexturePaintSnapshot?.(snapshot);
      }
      targetEntry.prewarmedStrokeSourceSnapshot = {
        snapshot,
        revision: this.texturePaintGpuTargetRevision(targetEntry),
        width: targetEntry.width || targetEntry.target?.width || 0,
        height: targetEntry.height || targetEntry.target?.height || 0
      };
      return true;
    },

    prewarmTexturePaintGpuStrokeSourceSnapshot(targetEntry = null, options = {}) {
      if (!targetEntry?.target?.texture) {
        return false;
      }
      const stroke = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo || null;
      if (stroke) {
        if (options.allowDuringStroke !== true) {
          return false;
        }
        const alreadyTouched = [...(stroke.touched?.values?.() || [])]
          .some((entry) => entry?.targetEntry === targetEntry);
        if (alreadyTouched) {
          return false;
        }
      }
      if (this.texturePaintGpuPrewarmSnapshotCurrent?.(targetEntry)) {
        return true;
      }
      this.disposeTexturePaintGpuPrewarmSnapshot?.(targetEntry);
      const snapshot = this.texturePaintGpuBeforeSnapshot?.(targetEntry, { usePrewarm: false });
      if (!snapshot) {
        return false;
      }
      return this.setTexturePaintGpuPrewarmSnapshot?.(targetEntry, snapshot) === true;
    },

    markTexturePaintGpuTargetMutated(targetEntry = null) {
      if (!targetEntry) {
        return false;
      }
      this.disposeTexturePaintGpuPrewarmSnapshot?.(targetEntry);
      targetEntry.paintRevision = this.texturePaintGpuTargetRevision(targetEntry) + 1;
      return true;
    },

    clearTexturePaintGpuTarget(targetEntry = null, options = {}) {
      const renderer = this.renderer || null;
      const target = targetEntry?.target || null;
      if (!renderer?.isWebGPURenderer || !target?.texture) {
        return false;
      }
      const previousTarget = typeof renderer.getRenderTarget === "function"
        ? renderer.getRenderTarget()
        : null;
      const previousAutoClear = renderer.autoClear;
      const previousClearAlpha = typeof renderer.getClearAlpha === "function"
        ? renderer.getClearAlpha()
        : 1;
      const previousClearColor = typeof THREE?.Color === "function" && typeof renderer.getClearColor === "function"
        ? renderer.getClearColor(new THREE.Color())
        : null;
      try {
        renderer.setRenderTarget(target);
        renderer.autoClear = true;
        renderer.setClearColor?.(0x000000, 0);
        renderer.clear?.();
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
        if (previousClearColor) {
          renderer.setClearColor?.(previousClearColor, previousClearAlpha);
        }
      }
      targetEntry.emptyTransparent = true;
      targetEntry.texturePaintLayerHasPaint = false;
      if (options.markMutated !== false) {
        this.markTexturePaintGpuTargetMutated?.(targetEntry);
      }
      return true;
    },

    beginTexturePaintStrokeUndo(label = "Texture paint") {
      this.texturePaintStrokeUndo = {
        label,
        undoStackInsertIndex: Array.isArray(this.undoStack) ? this.undoStack.length : null,
        before: [],
        touched: new Map(),
        changed: false
      };
      return true;
    },

    texturePaintActiveStrokeUndo() {
      return this.texturePaintStrokeUndoContext || this.texturePaintStrokeUndo || null;
    },

    markTexturePaintStrokeChanged() {
      const stroke = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo;
      if (!stroke) {
        return false;
      }
      stroke.changed = true;
      return true;
    },

    texturePaintNormalizeCanvasUndoBounds(canvas = null, bounds = null) {
      if (!canvas?.width || !canvas.height || !bounds) {
        return null;
      }
      const canvasWidth = Math.max(1, Math.floor(Number(canvas.width) || 1));
      const canvasHeight = Math.max(1, Math.floor(Number(canvas.height) || 1));
      const x = Math.max(0, Math.min(canvasWidth - 1, Math.floor(Number(bounds.x) || 0)));
      const y = Math.max(0, Math.min(canvasHeight - 1, Math.floor(Number(bounds.y) || 0)));
      const right = Math.max(x + 1, Math.min(canvasWidth, Math.ceil(x + Math.max(1, Number(bounds.width) || 1))));
      const bottom = Math.max(y + 1, Math.min(canvasHeight, Math.ceil(y + Math.max(1, Number(bounds.height) || 1))));
      return {
        x,
        y,
        width: right - x,
        height: bottom - y
      };
    },

    texturePaintUnionCanvasUndoBounds(canvas = null, first = null, second = null) {
      const left = this.texturePaintNormalizeCanvasUndoBounds?.(canvas, first);
      const right = this.texturePaintNormalizeCanvasUndoBounds?.(canvas, second);
      if (!left) {
        return right;
      }
      if (!right) {
        return left;
      }
      const x = Math.min(left.x, right.x);
      const y = Math.min(left.y, right.y);
      const x2 = Math.max(left.x + left.width, right.x + right.width);
      const y2 = Math.max(left.y + left.height, right.y + right.height);
      return this.texturePaintNormalizeCanvasUndoBounds?.(canvas, {
        x,
        y,
        width: x2 - x,
        height: y2 - y
      });
    },

    texturePaintNormalizeCanvasUndoRegions(canvas = null, regions = []) {
      if (!canvas?.width || !canvas.height || !Array.isArray(regions)) {
        return [];
      }
      const normalized = [];
      for (const region of regions) {
        const bounds = this.texturePaintNormalizeCanvasUndoBounds?.(canvas, region);
        if (!bounds) {
          continue;
        }
        if (normalized.some((existing) => (
          bounds.x >= existing.x
          && bounds.y >= existing.y
          && bounds.x + bounds.width <= existing.x + existing.width
          && bounds.y + bounds.height <= existing.y + existing.height
        ))) {
          continue;
        }
        normalized.push(bounds);
      }
      return normalized;
    },

    texturePaintCanvasUndoRegionSnapshot(context = null, canvas = null, bounds = null, source = null) {
      if (source) {
        return this.texturePaintImageDataFromSourceForUndoBounds?.(source, canvas, bounds);
      }
      return this.texturePaintImageDataForCanvasUndoBounds?.(context, canvas, bounds);
    },

    texturePaintImageDataForCanvasUndoBounds(context = null, canvas = null, bounds = null) {
      if (!context || !canvas?.width || !canvas.height) {
        return null;
      }
      const normalized = this.texturePaintNormalizeCanvasUndoBounds?.(canvas, bounds);
      if (!normalized) {
        return context.getImageData(0, 0, canvas.width, canvas.height);
      }
      return context.getImageData(normalized.x, normalized.y, normalized.width, normalized.height);
    },

    texturePaintImageDataFromSourceForUndoBounds(source = null, canvas = null, bounds = null) {
      if (
        !source?.data
        || !canvas?.width
        || !canvas.height
        || source.width !== canvas.width
        || source.height !== canvas.height
        || source.data.byteLength !== canvas.width * canvas.height * 4
      ) {
        return null;
      }
      const normalized = this.texturePaintNormalizeCanvasUndoBounds?.(canvas, bounds);
      if (!normalized) {
        return source;
      }
      const data = new Uint8ClampedArray(normalized.width * normalized.height * 4);
      for (let row = 0; row < normalized.height; row += 1) {
        const sourceOffset = ((normalized.y + row) * canvas.width + normalized.x) * 4;
        const targetOffset = row * normalized.width * 4;
        data.set(source.data.subarray(sourceOffset, sourceOffset + normalized.width * 4), targetOffset);
      }
      if (typeof ImageData !== "undefined") {
        return new ImageData(data, normalized.width, normalized.height);
      }
      return {
        width: normalized.width,
        height: normalized.height,
        data
      };
    },

    texturePaintTransparentImageDataForCanvasUndoBounds(canvas = null, bounds = null) {
      if (!canvas?.width || !canvas.height) {
        return null;
      }
      const normalized = this.texturePaintNormalizeCanvasUndoBounds?.(canvas, bounds);
      const width = Math.max(1, Math.floor(Number(normalized?.width || canvas.width) || 1));
      const height = Math.max(1, Math.floor(Number(normalized?.height || canvas.height) || 1));
      const data = new Uint8ClampedArray(width * height * 4);
      if (typeof ImageData !== "undefined") {
        try {
          return new ImageData(data, width, height);
        } catch {
          return { width, height, data };
        }
      }
      return { width, height, data };
    },

    captureTexturePaintCanvasUndoTarget(record, material, editable, materialIndex = 0, options = {}) {
      const stroke = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo;
      const canvas = editable?.canvas;
      const context = editable?.context;
      if (!stroke || !canvas || !context) {
        return false;
      }
      const key = this.texturePaintUndoEntryKey("canvas", record, materialIndex, material, null, editable?.layer?.id || "");
      const boundsRegions = this.texturePaintNormalizeCanvasUndoRegions?.(
        canvas,
        options.boundsRegions || options.paintRegions || options.regions || []
      ) || [];
      if (stroke.touched.has(key)) {
        const entry = stroke.touched.get(key);
        if (boundsRegions.length || entry?.regions?.length) {
          entry.regions ||= [];
          const source = entry.beforeSourceImageData || (
            options.beforeImageData?.width === canvas.width
            && options.beforeImageData?.height === canvas.height
            && options.beforeImageData?.data?.byteLength === canvas.width * canvas.height * 4
              ? texturePaintCloneImageData(options.beforeImageData)
              : null
          );
          if (source && !entry.beforeSourceImageData) {
            entry.beforeSourceImageData = source;
          }
          const nextRegions = boundsRegions.length
            ? boundsRegions
            : [this.texturePaintNormalizeCanvasUndoBounds?.(canvas, options.bounds || null)].filter(Boolean);
          for (const bounds of nextRegions) {
            const alreadyCovered = entry.regions.some((region) => (
              bounds.x >= region.bounds.x
              && bounds.y >= region.bounds.y
              && bounds.x + bounds.width <= region.bounds.x + region.bounds.width
              && bounds.y + bounds.height <= region.bounds.y + region.bounds.height
            ));
            if (alreadyCovered) {
              continue;
            }
            entry.bounds = this.texturePaintUnionCanvasUndoBounds?.(canvas, entry.bounds, bounds) || entry.bounds;
            entry.regions.push({
              bounds,
              before: source
                ? null
                : options.emptyBefore === true
                  ? this.texturePaintTransparentImageDataForCanvasUndoBounds?.(canvas, bounds)
                  : this.texturePaintCanvasUndoRegionSnapshot?.(context, canvas, bounds, null),
              after: null
            });
          }
          return true;
        }
        const nextBounds = this.texturePaintUnionCanvasUndoBounds?.(canvas, entry?.bounds, options.bounds || null);
        if (entry && nextBounds && entry.bounds) {
          const changedBounds = nextBounds.x !== entry.bounds.x
            || nextBounds.y !== entry.bounds.y
            || nextBounds.width !== entry.bounds.width
            || nextBounds.height !== entry.bounds.height;
          if (changedBounds) {
            entry.bounds = nextBounds;
            if (entry.beforeSourceImageData) {
              entry.before = null;
            } else {
              entry.before = this.texturePaintImageDataForCanvasUndoBounds?.(context, canvas, nextBounds) || entry.before;
            }
            entry.after = null;
          }
        }
        return true;
      }
      const bounds = this.texturePaintNormalizeCanvasUndoBounds?.(canvas, options.bounds || null);
      const sourceBeforeImageData = options.beforeImageData?.width === canvas.width
        && options.beforeImageData?.height === canvas.height
        && options.beforeImageData?.data?.byteLength === canvas.width * canvas.height * 4
        ? texturePaintCloneImageData(options.beforeImageData)
        : null;
      const regions = boundsRegions.length
        ? boundsRegions.map((regionBounds) => ({
            bounds: regionBounds,
            before: sourceBeforeImageData
              ? null
              : options.emptyBefore === true
                ? this.texturePaintTransparentImageDataForCanvasUndoBounds?.(canvas, regionBounds)
                : this.texturePaintCanvasUndoRegionSnapshot?.(context, canvas, regionBounds, null),
            after: null
          }))
        : null;
      const beforeImageData = sourceBeforeImageData
        ? null
        : regions?.length
          ? null
        : options.emptyBefore === true
          ? this.texturePaintTransparentImageDataForCanvasUndoBounds?.(canvas, bounds)
          : this.texturePaintImageDataForCanvasUndoBounds?.(context, canvas, bounds);
      const entry = {
        type: "canvas",
        key,
        record,
        material,
        materialIndex,
        canvas,
        context,
        texture: editable.texture,
        layer: editable.layer || null,
        layerStack: editable.layerStack || null,
        bounds,
        regions,
        beforeSourceImageData: sourceBeforeImageData,
        before: beforeImageData,
        after: null
      };
      stroke.touched.set(key, entry);
      stroke.before.push(entry);
      texturePaintSetDebugData("textureAirbrushDebugUndoCaptureEntry", {
        key,
        layer: Boolean(entry.layer),
        bounds,
        regionCount: regions?.length || 0,
        emptyBefore: options.emptyBefore === true,
        beforeSource: texturePaintDebugImageDataStats(sourceBeforeImageData),
        before: texturePaintDebugImageDataStats(beforeImageData)
      });
      return true;
    },

    captureTexturePaintGpuUndoTarget(record, material, targetEntry, materialIndex = 0) {
      const stroke = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo;
      if (!stroke || !targetEntry?.target?.texture) {
        return false;
      }
      const key = this.texturePaintUndoEntryKey("gpu", record, materialIndex, material, targetEntry);
      if (stroke.touched.has(key)) {
        return true;
      }
      const snapshot = this.texturePaintGpuBeforeSnapshot?.(targetEntry);
      if (!snapshot) {
        return false;
      }
      const entry = {
        type: "gpu",
        key,
        record,
        material,
        materialIndex,
        targetEntry,
        before: snapshot,
        after: null
      };
      stroke.touched.set(key, entry);
      stroke.before.push(entry);
      return true;
    },

    texturePaintGpuStrokeSourceSnapshot(record, material, targetEntry, materialIndex = 0) {
      const stroke = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo;
      if (!stroke?.touched || !targetEntry?.target?.texture) {
        return null;
      }
      const key = this.texturePaintUndoEntryKey("gpu", record, materialIndex, material, targetEntry);
      return stroke.touched.get(key)?.before || null;
    },

    texturePaintCanvasStrokeSourceImage(record, material, editable, materialIndex = 0) {
      const stroke = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo;
      if (!stroke?.touched || !editable?.canvas) {
        return null;
      }
      const key = this.texturePaintUndoEntryKey("canvas", record, materialIndex, material, null, editable?.layer?.id || "");
      const entry = stroke.touched.get(key) || null;
      return entry?.beforeSourceImageData || entry?.before || null;
    },

    texturePaintCanvasStrokeOpacityState(record, material, editable, materialIndex = 0) {
      const stroke = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo;
      if (!stroke?.touched || !editable?.canvas) {
        return null;
      }
      const key = this.texturePaintUndoEntryKey("canvas", record, materialIndex, material, null, editable?.layer?.id || "");
      if (!stroke.touched.has(key)) {
        return null;
      }
      stroke.canvasOpacityCaps ||= new Map();
      let state = stroke.canvasOpacityCaps.get(key);
      if (!state) {
        state = {
          alphaByPixel: new Map()
        };
        stroke.canvasOpacityCaps.set(key, state);
      }
      return state;
    },

    finalizeTexturePaintUndoEntry(entry) {
      if (entry.type === "canvas") {
        if (Array.isArray(entry.regions) && entry.regions.length) {
          for (const region of entry.regions) {
            if (entry.beforeSourceImageData && !region.before) {
              region.before = this.texturePaintImageDataFromSourceForUndoBounds?.(
                entry.beforeSourceImageData,
                entry.canvas,
                region.bounds || null
              ) || region.before;
            }
            region.after = this.texturePaintImageDataForCanvasUndoBounds?.(
              entry.context,
              entry.canvas,
              region.bounds || null
            ) || region.after;
          }
          delete entry.beforeSourceImageData;
          texturePaintSetDebugData("textureAirbrushDebugUndoFinalizeEntry", {
            layer: Boolean(entry.layer),
            regionCount: entry.regions.length,
            regions: entry.regions.slice(0, 4).map((region) => ({
              bounds: region.bounds || null,
              before: texturePaintDebugImageDataStats(region.before),
              after: texturePaintDebugImageDataStats(region.after)
            }))
          });
          return entry.regions.some((region) => region.before && region.after);
        }
        if (entry.beforeSourceImageData) {
          entry.before = this.texturePaintImageDataFromSourceForUndoBounds?.(
            entry.beforeSourceImageData,
            entry.canvas,
            entry.bounds || null
          ) || entry.beforeSourceImageData;
        }
        entry.after = this.texturePaintImageDataForCanvasUndoBounds?.(
          entry.context,
          entry.canvas,
          entry.bounds || null
        ) || entry.context.getImageData(0, 0, entry.canvas.width, entry.canvas.height);
        delete entry.beforeSourceImageData;
        texturePaintSetDebugData("textureAirbrushDebugUndoFinalizeEntry", {
          layer: Boolean(entry.layer),
          bounds: entry.bounds || null,
          before: texturePaintDebugImageDataStats(entry.before),
          after: texturePaintDebugImageDataStats(entry.after)
        });
        return true;
      }
      if (entry.type === "gpu") {
        entry.after = this.cloneTextureRenderTargetSnapshot(entry.targetEntry);
        if (!entry.after) {
          return false;
        }
        this.setTexturePaintGpuPrewarmSnapshot?.(entry.targetEntry, entry.after, { retain: true });
        return true;
      }
      return false;
    },

    texturePaintImageDataFromGpuSnapshot(snapshot = null, targetEntry = null) {
      if (!snapshot) {
        return null;
      }
      if (snapshot.clear === true && typeof ImageData !== "undefined") {
        const width = Math.max(1, Math.round(snapshot.width || targetEntry?.width || targetEntry?.target?.width || 1));
        const height = Math.max(1, Math.round(snapshot.height || targetEntry?.height || targetEntry?.target?.height || 1));
        return new ImageData(width, height);
      }
      if (typeof this.textureAirbrushCanvasFromRenderTarget !== "function") {
        return null;
      }
      const editable = this.textureAirbrushCanvasFromRenderTarget({
        target: snapshot,
        width: targetEntry?.width || snapshot?.width,
        height: targetEntry?.height || snapshot?.height
      });
      if (!editable?.canvas || !editable.context) {
        return null;
      }
      return editable.context.getImageData(0, 0, editable.canvas.width, editable.canvas.height);
    },

    texturePaintCanvasUndoTargetFromGpuEntry(entry = null) {
      if (!entry?.material) {
        return null;
      }
      const layer = entry.targetEntry?.layer || null;
      if (entry.targetEntry?.layerMode === true && layer?.canvas && layer.context) {
        return {
          canvas: layer.canvas,
          context: layer.context,
          texture: layer.gpuLayerTexture || entry.material.userData?.clonePaintTexture || entry.material.map || null,
          layer,
          layerStack: entry.targetEntry.layerStack || entry.material.userData?.texturePaintLayerStack || null
        };
      }
      const userData = entry.material.userData || {};
      if (!userData.clonePaintCanvas || !userData.clonePaintContext) {
        return null;
      }
      return {
        canvas: userData.clonePaintCanvas,
        context: userData.clonePaintContext,
        texture: userData.clonePaintTexture || entry.material.map || null,
        layer: null,
        layerStack: userData.texturePaintLayerStack || null
      };
    },

    convertTexturePaintGpuUndoEntryToCanvas(entry = null, options = {}) {
      if (entry?.type !== "gpu") {
        return false;
      }
      const target = this.texturePaintCanvasUndoTargetFromGpuEntry?.(entry);
      if (!target?.canvas || !target.context) {
        return false;
      }
      const before = this.texturePaintImageDataFromGpuSnapshot?.(entry.before, entry.targetEntry);
      if (!before) {
        return false;
      }
      let after = null;
      if (options.includeAfter !== false && entry.after) {
        after = this.texturePaintImageDataFromGpuSnapshot?.(entry.after, entry.targetEntry);
        if (!after) {
          return false;
        }
      }
      if (typeof this.releaseTexturePaintSnapshot === "function") {
        this.releaseTexturePaintSnapshot(entry.before);
      } else {
        entry.before?.dispose?.();
      }
      if (entry.after) {
        if (typeof this.releaseTexturePaintSnapshot === "function") {
          this.releaseTexturePaintSnapshot(entry.after);
        } else {
          entry.after?.dispose?.();
        }
      }
      entry.type = "canvas";
      entry.canvas = target.canvas;
      entry.context = target.context;
      entry.texture = target.texture;
      entry.layer = target.layer;
      entry.layerStack = target.layerStack;
      entry.before = before;
      entry.after = after;
      delete entry.targetEntry;
      return true;
    },

    disposeTexturePaintSnapshotEntry(entry) {
      this.releaseTexturePaintSnapshot?.(entry?.before);
      this.releaseTexturePaintSnapshot?.(entry?.after);
    },

    prepareTexturePaintGpuUndoEntriesForCanvas(stroke = this.texturePaintStrokeUndo) {
      const gpuEntries = (stroke?.before || []).filter((entry) => entry?.type === "gpu");
      if (!gpuEntries.length) {
        return false;
      }
      if (
        typeof this.textureAirbrushCanvasFromRenderTarget !== "function"
        || typeof this.flushTextureAirbrushGpuTargetsToCanvases !== "function"
      ) {
        return false;
      }
      const prepared = [];
      for (const entry of gpuEntries) {
        const before = this.texturePaintImageDataFromGpuSnapshot?.(entry.before, entry.targetEntry);
        if (!before) {
          return false;
        }
        prepared.push({
          entry,
          before
        });
      }

      const flushed = this.flushTextureAirbrushGpuTargetsToCanvases();
      if (!flushed) {
        return false;
      }

      for (const { entry, before } of prepared) {
        const target = this.texturePaintCanvasUndoTargetFromGpuEntry?.(entry);
        if (!target?.canvas || !target.context) {
          continue;
        }
        if (typeof this.releaseTexturePaintSnapshot === "function") {
          this.releaseTexturePaintSnapshot(entry.before);
        } else {
          entry.before?.dispose?.();
        }
        if (entry.after) {
          if (typeof this.releaseTexturePaintSnapshot === "function") {
            this.releaseTexturePaintSnapshot(entry.after);
          } else {
            entry.after?.dispose?.();
          }
        }
        entry.type = "canvas";
        entry.canvas = target.canvas;
        entry.context = target.context;
        entry.texture = target.texture;
        entry.layer = target.layer;
        entry.layerStack = target.layerStack;
        entry.before = before;
        entry.after = null;
        delete entry.targetEntry;
      }
      return true;
    },

    texturePaintPendingStrokeUndoContexts() {
      const strokes = new Set();
      const add = (stroke) => {
        if (stroke) {
          strokes.add(stroke);
        }
      };
      add(this.texturePaintStrokeUndo);
      add(this.texturePaintStrokeUndoContext);
      for (const stroke of this.texturePaintPendingStrokeUndoFinalizations || []) {
        add(stroke);
      }
      for (const segment of this.textureAirbrushScreenStrokeQueue || []) {
        add(segment?.strokeUndo);
      }
      for (const batch of this.textureAirbrushPendingScreenStrokeBatches || []) {
        add(batch?.strokeUndo);
      }
      return [...strokes];
    },

    prepareTexturePaintPendingGpuUndoEntriesForCanvas() {
      let prepared = false;
      for (const stroke of this.texturePaintPendingStrokeUndoContexts?.() || []) {
        if (this.prepareTexturePaintGpuUndoEntriesForCanvas?.(stroke)) {
          prepared = true;
        }
      }
      return prepared;
    },

    texturePaintPendingUndoFinalizationPromise() {
      const promises = [];
      for (const stroke of this.texturePaintPendingStrokeUndoFinalizations || []) {
        const promise = stroke?.finalizationPromise;
        if (promise && typeof promise.then === "function") {
          promises.push(promise);
        }
      }
      return promises.length ? Promise.allSettled(promises) : null;
    },

    texturePaintSettlePendingUndoBeforeHistory() {
      const promises = [];
      if (this.texturePaintStrokeUndo) {
        const result = this.endTexturePaintStrokeUndo?.();
        if (result && typeof result.then === "function") {
          promises.push(result);
        }
      }
      const screenFlush = this.finishTextureAirbrushScreenStrokeFlush?.();
      if (screenFlush && typeof screenFlush.then === "function") {
        promises.push(screenFlush);
      }
      const finalization = this.texturePaintPendingUndoFinalizationPromise?.();
      if (finalization && typeof finalization.then === "function") {
        promises.push(finalization);
      }
      if (!promises.length) {
        return null;
      }
      return Promise.allSettled(promises).then(() => {
        const lateFinalization = this.texturePaintPendingUndoFinalizationPromise?.();
        return lateFinalization && typeof lateFinalization.then === "function"
          ? lateFinalization
          : null;
      });
    },

    prepareTexturePaintHistoryRestore() {
      this.textureAirbrushScreenFlushScheduled = false;
      this.textureAirbrushScreenStrokeQueue = [];
      this.textureAirbrushPendingScreenStrokeBatches = [];
      this.texturePaintNeedsExactFirstPaintDisplayRefresh = false;
      this.textureAirbrushCancelDeferredWebGpuCanvasSync?.();
      this.textureAirbrushReleaseDeferredWebGpuReadbacks?.();
      const host = typeof window !== "undefined" ? window : globalThis;
      if (this.texturePaintExactFirstPaintDisplayTimer && typeof host?.clearTimeout === "function") {
        host.clearTimeout(this.texturePaintExactFirstPaintDisplayTimer);
      }
      this.texturePaintExactFirstPaintDisplayTimer = null;
      this.clearTextureAirbrushScreenLayer?.();
      this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
      this.cancelTextureAirbrushDeferredBroadLayerPrewarm?.();
      this.cancelTextureAirbrushPostStrokePrewarm?.();
      this.textureAirbrushResetLiveProjectionFrame?.();
      return true;
    },

    prepareTexturePaintUndoStackGpuEntriesForCanvas(options = {}) {
      let prepared = false;
      const material = options.material || null;
      for (const state of this.undoStack || []) {
        if (state?.kind !== "texture-paint") {
          continue;
        }
        for (const entry of state.entries || []) {
          if (entry?.type !== "gpu") {
            continue;
          }
          if (material && entry.material !== material) {
            continue;
          }
          if (this.convertTexturePaintGpuUndoEntryToCanvas?.(entry, { includeAfter: true })) {
            prepared = true;
          }
        }
      }
      return prepared;
    },

    rebuildTexturePaintCompositeCanvasTexture(material = null, options = {}) {
      const userData = material?.userData || null;
      const canvas = userData?.clonePaintCanvas || null;
      if (!material || !userData || !canvas || typeof THREE?.CanvasTexture !== "function") {
        return null;
      }
      const previousTexture = userData.clonePaintTexture || null;
      const referenceTexture = texturePaintStableReferenceTexture(options.referenceTexture)
        || texturePaintStableReferenceTexture(previousTexture)
        || userData.clonePaintOriginalMap
        || texturePaintStableReferenceTexture(material.map)
        || material.map
        || null;
      const texture = new THREE.CanvasTexture(canvas);
      texture.name = referenceTexture?.name || previousTexture?.name || "clone paint material color texture";
      texture.colorSpace = referenceTexture?.colorSpace || THREE.SRGBColorSpace;
      texture.flipY = referenceTexture?.flipY ?? false;
      if (referenceTexture && "channel" in referenceTexture) {
        texture.channel = referenceTexture.channel;
      }
      texture.wrapS = referenceTexture?.wrapS || THREE.ClampToEdgeWrapping;
      texture.wrapT = referenceTexture?.wrapT || THREE.ClampToEdgeWrapping;
      texture.magFilter = referenceTexture?.magFilter || THREE.LinearFilter;
      texture.minFilter = referenceTexture?.minFilter || THREE.LinearFilter;
      texture.generateMipmaps = referenceTexture?.generateMipmaps ?? true;
      if (Number.isFinite(Number(referenceTexture?.anisotropy))) {
        texture.anisotropy = referenceTexture.anisotropy;
      }
      if (referenceTexture?.offset && texture.offset?.copy) {
        texture.offset.copy(referenceTexture.offset);
      }
      if (referenceTexture?.repeat && texture.repeat?.copy) {
        texture.repeat.copy(referenceTexture.repeat);
      }
      if (referenceTexture?.center && texture.center?.copy) {
        texture.center.copy(referenceTexture.center);
      }
      texture.rotation = referenceTexture?.rotation || 0;
      texture.matrixAutoUpdate = referenceTexture?.matrixAutoUpdate ?? true;
      if (referenceTexture?.matrix && texture.matrix?.copy) {
        texture.matrix.copy(referenceTexture.matrix);
      }
      texture.needsUpdate = true;
      userData.clonePaintTexture = texture;
      material.map = texture;
      material.needsUpdate = true;
      this.textureAirbrushInvalidateWebGpuCache?.(previousTexture);
      this.textureAirbrushInvalidateWebGpuCache?.(texture);
      if (previousTexture && previousTexture !== texture && previousTexture !== userData.clonePaintOriginalMap) {
        if (!texturePaintTslSurfaceTexture(previousTexture)) {
          previousTexture.dispose?.();
        }
      }
      texturePaintSetDebugData("textureAirbrushDebugRebuiltCompositeTexture", {
        rebuilt: true,
        hadPrevious: Boolean(previousTexture),
        previousWasTslSurface: texturePaintTslSurfaceTexture(previousTexture),
        optionReferenceWasTslSurface: texturePaintTslSurfaceTexture(options.referenceTexture),
        referenceWasPrevious: Boolean(referenceTexture && referenceTexture === previousTexture),
        referenceWasStableFromPrevious: Boolean(previousTexture && referenceTexture === texturePaintStableReferenceTexture(previousTexture)),
        materialMapRebound: material.map === texture,
        textureNeedsUpdate: texture.needsUpdate === true,
        materialNeedsUpdate: material.needsUpdate === true
      });
      return texture;
    },

    restoreTexturePaintCanvasWebGpuDisplay(entry = null) {
      const material = entry?.material || null;
      const userData = material?.userData || null;
      const entryTexture = entry?.texture || null;
      const materialMap = material?.map || null;
      const materialMapIsExternal = materialMap?.userData?.textureAirbrushExternalWebGpuDisplay === true;
      const materialMapIsTslSurfaceDisplay = texturePaintTslSurfaceTexture(materialMap);
      const entryTextureIsTslSurfaceDisplay = texturePaintTslSurfaceTexture(entryTexture);
      const cloneTextureIsTslSurfaceDisplay = texturePaintTslSurfaceTexture(userData?.clonePaintTexture);
      const externalMap = userData?.textureAirbrushWebGpuExternalMap
        || (materialMapIsExternal ? materialMap : null);
      const canvasMap = userData?.textureAirbrushWebGpuCanvasMap
        || materialMap?.userData?.textureAirbrushWebGpuCanvasMap
        || entryTexture?.userData?.textureAirbrushWebGpuCanvasMap
        || (entryTexture?.userData?.textureAirbrushExternalWebGpuDisplay === true
          ? entryTexture.userData.textureAirbrushWebGpuCanvasMap || null
          : null);
      const layerRestore = Boolean(entry?.layer || entry?.layerStack || userData?.texturePaintLayerStack);
      const compositeMap = layerRestore
        ? userData?.clonePaintTexture || canvasMap || null
        : null;
      const restoredMap = compositeMap || (
        entryTexture?.userData?.textureAirbrushExternalWebGpuDisplay === true
        || entryTextureIsTslSurfaceDisplay
        ? canvasMap
        : entryTexture || canvasMap
      );
      let finalRestoredMap = restoredMap || null;
      if (entryTexture) {
        entryTexture.needsUpdate = true;
      }
      if (canvasMap && canvasMap !== entryTexture) {
        canvasMap.needsUpdate = true;
      }
      if (externalMap && externalMap !== entryTexture && externalMap !== canvasMap) {
        this.textureAirbrushInvalidateWebGpuCache?.(externalMap);
      }
      if (materialMapIsTslSurfaceDisplay && materialMap !== entryTexture && materialMap !== canvasMap) {
        this.textureAirbrushInvalidateWebGpuCache?.(materialMap);
      }
      let tslSurfaceCacheInvalidated = false;
      if (typeof this.texturePaintTslSurfaceAirbrushInvalidate === "function") {
        tslSurfaceCacheInvalidated = this.texturePaintTslSurfaceAirbrushInvalidate(
          material || entryTexture || canvasMap || materialMap || null
        ) === true;
        if (!tslSurfaceCacheInvalidated) {
          tslSurfaceCacheInvalidated = this.texturePaintTslSurfaceAirbrushInvalidate() === true;
        }
      }
      this.textureAirbrushInvalidateWebGpuCache?.(entryTexture || entry?.canvas);
      if (canvasMap && canvasMap !== entryTexture) {
        this.textureAirbrushInvalidateWebGpuCache?.(canvasMap);
      }
      if (entry?.canvas && entry.canvas !== entryTexture && entry.canvas !== canvasMap) {
        this.textureAirbrushInvalidateWebGpuCache?.(entry.canvas);
      }
      if (userData) {
        if (layerRestore) {
          this.discardTexturePaintMaterialGpuComposite?.(material);
        }
        this.texturePaintDisableLiveLayerShaderComposite?.(material);
        delete userData.texturePaintLiveLayerShaderComposite;
        delete userData.textureAirbrushWebGpuExternalMap;
        delete userData.textureAirbrushWebGpuCanvasMap;
        if (externalMap?.userData) {
          delete externalMap.userData.textureAirbrushExternalWebGpuDisplay;
          delete externalMap.userData.textureAirbrushWebGpuCanvasMap;
        }
        if (materialMap?.userData?.textureAirbrushExternalWebGpuDisplay === true) {
          delete materialMap.userData.textureAirbrushExternalWebGpuDisplay;
          delete materialMap.userData.textureAirbrushWebGpuCanvasMap;
        }
        const stack = entry?.layerStack || userData.texturePaintLayerStack || null;
        for (const layer of stack?.layers || []) {
          const targetEntry = layer?.gpuTarget || null;
          if (!targetEntry) {
            continue;
          }
          delete targetEntry.liveCompositeTarget;
          delete targetEntry.liveCompositeBaseTexture;
          delete targetEntry.liveCompositeLayer;
          delete targetEntry.liveCompositeLayerCount;
          delete targetEntry.liveCompositeLayerIndex;
          delete targetEntry.liveCompositeLayerOpacity;
          delete targetEntry.liveCompositeLayerBlendMode;
          delete targetEntry.liveCompositeUnderlayKey;
          delete targetEntry.liveCompositeLayerMutationSerial;
          delete targetEntry.liveShaderComposite;
        }
      }
      if (
        !layerRestore
        && material
        && entry?.canvas
        && (
          !finalRestoredMap
          || entryTextureIsTslSurfaceDisplay
          || materialMapIsTslSurfaceDisplay
          || cloneTextureIsTslSurfaceDisplay
        )
      ) {
        finalRestoredMap = this.rebuildTexturePaintCompositeCanvasTexture?.(material, {
          referenceTexture: canvasMap || materialMap || entryTexture || userData?.clonePaintOriginalMap || null
        }) || finalRestoredMap;
      }
      if (userData && !layerRestore && finalRestoredMap && !texturePaintTslSurfaceTexture(finalRestoredMap)) {
        userData.clonePaintCanvas = entry?.canvas || userData.clonePaintCanvas || null;
        userData.clonePaintContext = entry?.context || userData.clonePaintContext || null;
        userData.clonePaintTexture = finalRestoredMap;
        delete userData.texturePaintTslSurfaceAirbrushTarget;
      }
      if (material && restoredMap && layerRestore) {
        material.map = finalRestoredMap;
        material.needsUpdate = true;
        material.dispose?.();
      } else if (
        material
        && finalRestoredMap
        && finalRestoredMap !== material.map
        && (
          (externalMap && material.map === externalMap)
          || materialMapIsExternal
          || materialMapIsTslSurfaceDisplay
          || entryTextureIsTslSurfaceDisplay
          || cloneTextureIsTslSurfaceDisplay
        )
      ) {
        material.map = finalRestoredMap;
        material.needsUpdate = true;
        material.dispose?.();
      }
      texturePaintSetDebugData("textureAirbrushDebugRestoreDisplay", {
        layerRestore,
        materialMapWasExternal: materialMapIsExternal,
        materialMapWasTslSurfaceDisplay: materialMapIsTslSurfaceDisplay,
        entryTextureWasTslSurfaceDisplay: entryTextureIsTslSurfaceDisplay,
        cloneTextureWasTslSurfaceDisplay: cloneTextureIsTslSurfaceDisplay,
        tslSurfaceCacheInvalidated,
        hadExternalMap: Boolean(externalMap),
        hadCanvasMap: Boolean(canvasMap),
        hadCompositeMap: Boolean(compositeMap),
        restoredMapApplied: Boolean(material && finalRestoredMap && material.map === finalRestoredMap),
        materialNeedsUpdate: material?.needsUpdate === true,
        materialDisposedForRebind: Boolean(material?.dispose && finalRestoredMap),
        layerGpuTarget: Boolean(entry?.layer?.gpuTarget),
        layerGpuLayerTexture: Boolean(entry?.layer?.gpuLayerTexture)
      });
      return true;
    },

    finalizeTexturePaintStrokeUndo(stroke = null) {
      if (!stroke?.changed || !stroke.before.length) {
        for (const entry of stroke?.before || []) {
          this.disposeTexturePaintSnapshotEntry(entry);
        }
        return false;
      }
      const entries = stroke.before.filter((entry) => this.finalizeTexturePaintUndoEntry(entry));
      if (!entries.length) {
        for (const entry of stroke.before) {
          this.disposeTexturePaintSnapshotEntry(entry);
        }
        return false;
      }
      const state = {
        kind: "texture-paint",
        label: stroke.label,
        entries
      };
      const pendingUndoWantsPaintOnTop = this.texturePaintHistoryWaitDirection === "undo";
      const insertIndex = pendingUndoWantsPaintOnTop
        ? this.undoStack.length
        : Number.isInteger(stroke.undoStackInsertIndex)
        ? Math.max(0, Math.min(this.undoStack.length, stroke.undoStackInsertIndex))
        : this.undoStack.length;
      this.undoStack.splice(insertIndex, 0, state);
      if (this.undoStack.length > this.maxUndoSteps) {
        this.disposeFastHistoryState?.(this.undoStack.shift());
      }
      for (const state of this.redoStack || []) {
        this.disposeFastHistoryState?.(state);
      }
      this.redoStack = [];
      this.updateUndoButton?.();
      return true;
    },

    endTexturePaintStrokeUndo() {
      const stroke = this.texturePaintStrokeUndo;
      this.textureAirbrushAttachStrokeUndoToPendingScreenWork?.(stroke);
      const screenFlush = this.finishTextureAirbrushScreenStrokeFlush?.() || (
        this.flushTextureAirbrushScreenStroke?.(),
        null
      );
      if (!stroke) {
        return false;
      }
      this.texturePaintStrokeUndo = null;
      this.texturePaintPendingStrokeUndoFinalizations ||= new Set();
      this.texturePaintPendingStrokeUndoFinalizations.add(stroke);
      let resolveFinalization = null;
      stroke.finalizationPromise = new Promise((resolve) => {
        resolveFinalization = resolve;
      });
      const forgetPendingStrokeUndo = () => {
        this.texturePaintPendingStrokeUndoFinalizations?.delete(stroke);
      };
      const settlePendingStrokeUndo = (finalized = false) => {
        forgetPendingStrokeUndo();
        if (finalized) {
          this.scheduleTextureFixupMaskPreviewRefresh?.(stroke);
        }
        resolveFinalization?.(finalized);
        delete stroke.finalizationPromise;
        return finalized;
      };
      const finalizeAfterPendingPaint = () => {
        if (this.texturePaintNeedsExactFirstPaintDisplayRefresh === true) {
          this.flushTexturePaintExactFirstPaintDisplayRefresh?.()
            || this.scheduleTexturePaintExactFirstPaintDisplayRefresh?.();
        }
        if (
          (
            this.textureAirbrushPendingWebGpuPaints?.size
            || this.textureAirbrushQueuedWebGpuStrokes?.length
            || this.textureAirbrushWebGpuFlushInFlight
            || this.textureAirbrushDeferredWebGpuCanvasSyncCaches?.size
            || this.textureAirbrushDeferredWebGpuReadbackStarts?.size
          )
          && typeof this.flushTextureAirbrushPendingWebGpuPaints === "function"
        ) {
          this.flushTextureAirbrushPendingWebGpuPaints({
            deferCanvasSyncUntilIdle: false,
            canvasSyncIdleDelayMs: 0,
            canvasSyncMaxDelayMs: 8000
          }).finally(() => {
            let finalized = false;
            try {
              finalized = this.finalizeTexturePaintStrokeUndo?.(stroke);
              if (finalized) {
                this.scheduleTextureAirbrushPostStrokePrewarm?.(stroke);
              }
            } finally {
              settlePendingStrokeUndo(finalized);
            }
          }).catch((error) => {
            console.error?.("Texture paint undo finalization failed", error);
          });
          return false;
        }
        try {
          const finalized = this.finalizeTexturePaintStrokeUndo(stroke);
          if (finalized) {
            this.scheduleTextureAirbrushPostStrokePrewarm?.(stroke);
          }
          return settlePendingStrokeUndo(finalized);
        } finally {
          if (this.texturePaintPendingStrokeUndoFinalizations?.has(stroke)) {
            settlePendingStrokeUndo(false);
          }
        }
      };
      if (screenFlush && typeof screenFlush.then === "function") {
        screenFlush.finally(() => {
          finalizeAfterPendingPaint();
        }).catch((error) => {
          console.error?.("Texture airbrush screen flush failed", error);
        });
        return false;
      }
      return finalizeAfterPendingPaint();
    },

    restoreTexturePaintSnapshot(entries = [], field = "before") {
      let restoredLayerPanel = false;
      const restoredGpuLayerMaterials = new Map();
      const gpuRestoredLayers = new Set(
        (Array.isArray(entries) ? entries : [])
          .filter((entry) => entry?.type === "gpu" && entry?.targetEntry?.layerMode === true)
          .map((entry) => entry.targetEntry?.layer)
          .filter(Boolean)
      );
      texturePaintSetDebugData("textureAirbrushDebugUndoRestoreStart", {
        field,
        entryCount: Array.isArray(entries) ? entries.length : 0,
        entries: (Array.isArray(entries) ? entries : []).slice(0, 4).map((entry) => ({
          type: entry?.type || "",
          layer: Boolean(entry?.layer),
          regionCount: Array.isArray(entry?.regions) ? entry.regions.length : 0,
          bounds: entry?.bounds || null,
          before: texturePaintDebugImageDataStats(entry?.before),
          after: texturePaintDebugImageDataStats(entry?.after)
        }))
      });
      const rememberRestoredGpuLayerMaterial = (material = null, layer = null, options = {}) => {
        if (!material) {
          return;
        }
        const state = restoredGpuLayerMaterials.get(material) || {
          changedLayer: layer,
          needsCanvasFlush: false,
          needsCpuComposite: false
        };
        if (!state.changedLayer && layer) {
          state.changedLayer = layer;
        }
        state.needsCanvasFlush = state.needsCanvasFlush || options.needsCanvasFlush === true;
        state.needsCpuComposite = state.needsCpuComposite || options.needsCpuComposite === true;
        restoredGpuLayerMaterials.set(material, state);
      };
      const debugCanvasRegionStats = (context = null, boundsList = []) => {
        if (!texturePaintDebugAirbrushActive() || !context || typeof context.getImageData !== "function") {
          return [];
        }
        return boundsList.slice(0, 4).map((bounds) => {
          const normalized = bounds
            ? {
                x: Math.max(0, Math.floor(Number(bounds.x) || 0)),
                y: Math.max(0, Math.floor(Number(bounds.y) || 0)),
                width: Math.max(1, Math.floor(Number(bounds.width) || 1)),
                height: Math.max(1, Math.floor(Number(bounds.height) || 1))
              }
            : null;
          if (!normalized) {
            return null;
          }
          try {
            return {
              bounds: normalized,
              stats: texturePaintDebugImageDataStats(context.getImageData(
                normalized.x,
                normalized.y,
                normalized.width,
                normalized.height
              ))
            };
          } catch {
            return {
              bounds: normalized,
              stats: null
            };
          }
        }).filter(Boolean);
      };
      for (const entry of entries) {
        if (entry.type === "canvas") {
          const regions = Array.isArray(entry.regions) && entry.regions.length
            ? entry.regions
            : null;
          const gpuLayerRestore = Boolean(entry.layer && gpuRestoredLayers.has(entry.layer));
          if (!entry.context || !entry.canvas) {
            continue;
          }
          if (regions) {
            for (const region of regions) {
              const image = region[field];
              if (!image) {
                continue;
              }
              const bounds = this.texturePaintNormalizeCanvasUndoBounds?.(entry.canvas, region.bounds || null);
              entry.context.putImageData(image, bounds?.x || 0, bounds?.y || 0);
            }
            texturePaintSetDebugData("textureAirbrushDebugUndoRestoreCanvasEntry", {
              field,
              layer: Boolean(entry.layer),
              regionCount: regions.length,
              regions: regions.slice(0, 4).map((region) => ({
                bounds: region.bounds || null,
                before: texturePaintDebugImageDataStats(region.before),
                after: texturePaintDebugImageDataStats(region.after)
              }))
            });
          } else {
            const image = entry[field];
            if (!image) {
              continue;
            }
            const bounds = this.texturePaintNormalizeCanvasUndoBounds?.(entry.canvas, entry.bounds || null);
            entry.context.putImageData(image, bounds?.x || 0, bounds?.y || 0);
            texturePaintSetDebugData("textureAirbrushDebugUndoRestoreCanvasEntry", {
              field,
              layer: Boolean(entry.layer),
              bounds,
              before: texturePaintDebugImageDataStats(entry.before),
              after: texturePaintDebugImageDataStats(entry.after)
            });
          }
          if (entry.texture) {
            entry.texture.needsUpdate = true;
          }
          if (entry.material) {
            entry.material.needsUpdate = true;
          }
          if (entry.layer) {
            this.texturePaintUpdateLayerEmptyState?.(entry.layer);
            if (!gpuLayerRestore) {
              this.restoreTexturePaintCanvasWebGpuDisplay?.(entry);
              // A canvas-only history restore makes the layer canvas authoritative.
              // Reusing the old live WebGPU target can re-show the stroke that was
              // just undone, even when the restored canvas pixels are transparent.
              this.disposeTexturePaintLayerGpuState?.(entry.layer);
              this.texturePaintCompositeMaterialLayers?.(entry.material, {
                skipGpuFlush: true,
                preferCpuDisplay: true
              });
              this.rebuildTexturePaintCompositeCanvasTexture?.(entry.material, {
                referenceTexture: entry.texture || entry.material?.userData?.clonePaintTexture || null
              });
              texturePaintSetDebugData("textureAirbrushDebugUndoRestoreCurrentCanvas", {
                layer: true,
                layerRegions: debugCanvasRegionStats(entry.context, (regions || [{ bounds: entry.bounds || null }]).map((region) => region.bounds || region)),
                baseRegions: debugCanvasRegionStats(
                  entry.layerStack?.baseContext || entry.material?.userData?.texturePaintLayerStack?.baseContext || null,
                  (regions || [{ bounds: entry.bounds || null }]).map((region) => region.bounds || region)
                ),
                compositeRegions: debugCanvasRegionStats(
                  entry.material?.userData?.clonePaintContext || null,
                  (regions || [{ bounds: entry.bounds || null }]).map((region) => region.bounds || region)
                )
              });
              rememberRestoredGpuLayerMaterial(entry.material, entry.layer);
            }
            restoredLayerPanel = true;
          } else if (entry.material?.userData?.texturePaintLayerStack) {
            this.restoreTexturePaintCanvasWebGpuDisplay?.(entry);
            this.texturePaintSyncBackgroundFromEditable?.(entry.material, {
              canvas: entry.canvas,
              context: entry.context,
              texture: entry.texture
            }, { renderPanel: false });
            this.texturePaintCompositeMaterialLayers?.(entry.material, {
              skipGpuFlush: true,
              preferCpuDisplay: true
            });
            this.rebuildTexturePaintCompositeCanvasTexture?.(entry.material, {
              referenceTexture: entry.texture || entry.material?.userData?.clonePaintTexture || null
            });
            rememberRestoredGpuLayerMaterial(entry.material, null);
            restoredLayerPanel = true;
          }
          if (!gpuLayerRestore) {
            this.restoreTexturePaintCanvasWebGpuDisplay?.(entry);
          }
          this.refreshCloneSpotlightTextures?.(entry.record);
          continue;
        }
        if (entry.type === "gpu") {
          const snapshot = entry[field];
          if ((!snapshot?.texture && snapshot?.clear !== true) || !entry.targetEntry?.target) {
            continue;
          }
          const targetTexture = entry.targetEntry.target?.texture || null;
          const displayTarget = entry.targetEntry.displayTarget || null;
          const displayTexture = displayTarget?.texture || null;
          const restoresTslSurfaceTarget = texturePaintTslSurfaceTexture(targetTexture)
            || texturePaintTslSurfaceTexture(displayTexture);
          if (snapshot.clear === true) {
            this.clearTexturePaintGpuTarget?.(entry.targetEntry, { markMutated: false });
            entry.targetEntry.emptyTransparent = true;
            entry.targetEntry.paintRevision = 0;
            this.disposeTexturePaintGpuPrewarmSnapshot?.(entry.targetEntry);
            if (entry.targetEntry.layer) {
              entry.targetEntry.layer.isEmpty = true;
              entry.targetEntry.layer.texturePaintHasPaint = false;
              entry.targetEntry.layer.texturePaintCpuPainted = false;
              entry.targetEntry.layer.texturePaintGpuPainted = false;
              entry.targetEntry.layer.context?.clearRect?.(
                0,
                0,
                entry.targetEntry.layer.canvas?.width || 0,
                entry.targetEntry.layer.canvas?.height || 0
              );
              if (entry.targetEntry.layer.gpuLayerTexture) {
                entry.targetEntry.layer.gpuLayerTexture.needsUpdate = true;
              }
            }
          } else {
            this.copyTextureToRenderTarget(snapshot.texture, entry.targetEntry.target);
            if (snapshot.texturePaintDisplaySnapshot?.texture && displayTarget?.texture) {
              this.copyTextureToRenderTarget(snapshot.texturePaintDisplaySnapshot.texture, displayTarget);
            }
            entry.targetEntry.emptyTransparent = false;
            entry.targetEntry.texturePaintLayerHasPaint = true;
            if (entry.targetEntry.layer) {
              entry.targetEntry.layer.isEmpty = false;
              entry.targetEntry.layer.texturePaintHasPaint = true;
              entry.targetEntry.layer.texturePaintGpuPainted = true;
            }
            this.markTexturePaintGpuTargetMutated?.(entry.targetEntry);
          }
          if (entry.targetEntry.layerMode === true) {
            if (entry.targetEntry.layer) {
              entry.targetEntry.layer.gpuTarget = entry.targetEntry;
            }
            rememberRestoredGpuLayerMaterial(entry.material, entry.targetEntry.layer || null, {
              needsCanvasFlush: snapshot.clear !== true,
              needsCpuComposite: snapshot.clear === true
            });
            restoredLayerPanel = true;
          }
          if (entry.material) {
            entry.material.needsUpdate = true;
          }
          if (restoresTslSurfaceTarget && entry.targetEntry.layerMode !== true && entry.material) {
            entry.material.userData ||= {};
            const restoredTargetTexture = entry.targetEntry.target?.texture || null;
            const restoredDisplayTexture = entry.targetEntry.displayTarget?.texture || null;
            if (restoredTargetTexture) {
              entry.material.userData.clonePaintTexture = restoredTargetTexture;
              entry.targetEntry.editable && (entry.targetEntry.editable.texture = restoredTargetTexture);
            }
            if (restoredDisplayTexture || restoredTargetTexture) {
              entry.material.map = restoredDisplayTexture || restoredTargetTexture;
              entry.material.needsUpdate = true;
              entry.material.dispose?.();
            }
            entry.material.userData.texturePaintTslSurfaceAirbrushTarget = entry.targetEntry;
            texturePaintSetDebugData("textureAirbrushDebugUndoRestoreGpuTslSurface", {
              field,
              hasTargetTexture: Boolean(restoredTargetTexture),
              hasDisplayTexture: Boolean(restoredDisplayTexture),
              copiedDisplaySnapshot: Boolean(snapshot.texturePaintDisplaySnapshot?.texture && displayTarget?.texture),
              materialMapIsDisplay: Boolean(restoredDisplayTexture && entry.material.map === restoredDisplayTexture)
            });
            this.refreshCloneSpotlightTextures?.(entry.record);
            continue;
          }
          if (entry.targetEntry.layerMode !== true) {
            this.restoreTexturePaintCanvasWebGpuDisplay?.({
              type: "gpu",
              record: entry.record,
              material: entry.material,
              texture: entry.material?.userData?.clonePaintTexture || entry.material?.map || null,
              canvas: entry.material?.userData?.clonePaintCanvas || null,
              layer: null,
              layerStack: entry.material?.userData?.texturePaintLayerStack || null
            });
          }
        }
      }
      if (restoredLayerPanel) {
        this.cancelTextureAirbrushDeferredBroadLayerPrewarm?.();
        if (restoredGpuLayerMaterials.size) {
          for (const material of restoredGpuLayerMaterials.keys()) {
            this.texturePaintTslSurfaceAirbrushInvalidate?.(material);
          }
        }
        this.bumpTexturePaintLayerMutationSerial?.();
        this.textureAirbrushResetLiveProjectionFrame?.();
        for (const [material, state] of restoredGpuLayerMaterials) {
          if (state.needsCanvasFlush) {
            this.flushTexturePaintLayerGpuTargetsToCanvases?.({
              material,
              composite: false
            });
          }
          if (state.needsCpuComposite) {
            this.texturePaintCompositeMaterialLayers?.(material, {
              skipGpuFlush: true,
              preserveCurrentDisplay: true
            });
          }
          const previousComposite = material?.userData?.texturePaintCompositeGpuTarget || null;
          const displayedByTsl = this.texturePaintRefreshTslSurfaceLayerDisplay?.(material, {
            changedLayer: state.changedLayer || null,
            reason: "history-restore"
          }) === true;
          const displayed = displayedByTsl || this.texturePaintCompositeMaterialLayerDisplay?.(material, {
            changedLayer: state.changedLayer || null,
            live: false
          }) === true;
          if (!displayed) {
            this.texturePaintCompositeMaterialLayerGpuTargets?.(material);
          }
          if (
            previousComposite
            && material?.userData?.texturePaintCompositeGpuTarget === previousComposite
            && material.map !== previousComposite.target?.texture
          ) {
            this.discardTexturePaintMaterialGpuComposite?.(material);
          }
        }
        this.renderTexturePaintLayerPanel?.();
      }
      this.updateClonePaintPreviews?.();
      this.syncPatchJson?.();
      this.updateUndoButton?.();
      return true;
    },

    canvasPointFromEvent(event) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    },

    beginLassoStroke(event) {
      const point = this.canvasPointFromEvent(event);
      this.lassoStroke = {
        points: [point],
        minDistanceSq: 16
      };
      this.updateLassoOverlay();
      this.setStatus("Draw lasso selection");
    },

    continueLassoStroke(event) {
      if (!this.lassoStroke) {
        this.beginLassoStroke(event);
        return;
      }
      const point = this.canvasPointFromEvent(event);
      const previous = this.lassoStroke.points[this.lassoStroke.points.length - 1];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if (dx * dx + dy * dy < this.lassoStroke.minDistanceSq) {
        return;
      }
      this.lassoStroke.points.push(point);
      this.updateLassoOverlay();
    },

    updateLassoOverlay() {
      if (!this.lassoOverlay || !this.lassoOverlayPath || !this.lassoStroke?.points?.length) {
        return;
      }
      const points = this.lassoStroke.points;
      this.lassoOverlay.hidden = false;
      this.lassoOverlayPath.setAttribute("d", points
        .map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
        .join(" "));
    },

    hideLassoOverlay() {
      if (this.lassoOverlay) {
        this.lassoOverlay.hidden = true;
      }
      if (this.lassoOverlayPath) {
        this.lassoOverlayPath.setAttribute("d", "");
      }
    },

    pointInPolygon(point, polygon) {
      let inside = false;
      for (let index = 0, last = polygon.length - 1; index < polygon.length; last = index, index += 1) {
        const a = polygon[index];
        const b = polygon[last];
        const crosses = ((a.y > point.y) !== (b.y > point.y))
          && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 0.000001) + a.x;
        if (crosses) {
          inside = !inside;
        }
      }
      return inside;
    },

    finishLassoStroke() {
      const stroke = this.lassoStroke;
      this.lassoStroke = null;
      this.hideLassoOverlay();
      if (!stroke?.points || stroke.points.length < 3 || !this.model) {
        this.setStatus("Lasso needs a larger area");
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      const includeAllDepth = Boolean(this.throughSelectionToggle?.checked);
      const projected = [];
      this.model.updateMatrixWorld(true);

      for (const record of this.paintRecords || []) {
        const position = record.geometry.attributes.position;
        for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          this.tempWorld.project(this.camera);
          if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
            continue;
          }
          const point = {
            x: (this.tempWorld.x * 0.5 + 0.5) * rect.width,
            y: (-this.tempWorld.y * 0.5 + 0.5) * rect.height,
            z: this.tempWorld.z
          };
          if (!this.pointInPolygon(point, stroke.points)) {
            continue;
          }
          projected.push({ record, vertexIndex, point });
        }
      }

      if (!projected.length) {
        this.setStatus("Lasso found no vertices");
        return 0;
      }
      const nearestZ = Math.min(...projected.map((item) => item.point.z));
      const depthWindow = includeAllDepth ? Infinity : Math.max(0.08, Number(this.brushRadius?.value || 0.035) * 3.4);
      let changed = 0;
      for (const item of projected) {
        if (!includeAllDepth && item.point.z > nearestZ + depthWindow) {
          continue;
        }
        changed += this.applyPaintActionWithMirror(item.record, item.vertexIndex, "paint");
      }
      return changed;
    },

    nearestScreenVertex(event, options = {}) {
      if (!this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const maxDistance = options.maxDistance || Math.max(18, Number(this.brushRadius?.value || 0.035) * 720);
      const maxDistanceSq = maxDistance * maxDistance;
      let nearest = null;
      this.model.updateMatrixWorld(true);
      for (const record of this.paintRecords) {
        if (options.record && record !== options.record) {
          continue;
        }
        if (options.recordFilter && !options.recordFilter(record)) {
          continue;
        }
        const position = record.geometry.attributes.position;
        for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          if (options.vertexFilter && !options.vertexFilter(record, vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          const world = this.tempWorld.clone();
          this.tempWorld.project(this.camera);
          if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
            continue;
          }
          const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
          const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
          const dx = screenX - x;
          const dy = screenY - y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > maxDistanceSq || (nearest && distanceSq >= nearest.distanceSq)) {
            continue;
          }
          nearest = {
            record,
            vertexIndex,
            distanceSq,
            world
          };
        }
      }
      return nearest;
    },

    nearestSurfaceVertex(event, options = {}) {
      if (!this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();

      const records = this.paintRecords.filter((record) => {
        if (options.record && record !== options.record) {
          return false;
        }
        if (options.recordFilter && !options.recordFilter(record)) {
          return false;
        }
        return true;
      });
      const recordByObject = new Map(records.map((record) => [record.object, record]));
      const intersections = this.raycaster.intersectObjects(records.map((record) => record.object), false);
      for (const hit of intersections) {
        const record = recordByObject.get(hit.object);
        const face = hit.face;
        if (!record || !face) {
          continue;
        }
        let nearest = null;
        for (const vertexIndex of [face.a, face.b, face.c]) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          if (options.vertexFilter && !options.vertexFilter(record, vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          const distanceSq = this.tempWorld.distanceToSquared(hit.point);
          if (nearest && distanceSq >= nearest.distanceSq) {
            continue;
          }
          nearest = {
            record,
            vertexIndex,
            distanceSq,
            world: this.tempWorld.clone(),
            hit
          };
        }
        if (nearest) {
          return nearest;
        }
      }
      return null;
    },

    nearestNeighborVertex(event, options = {}) {
      const screenMaxDistance = options.screenMaxDistance
        || options.maxDistance
        || Math.max(24, Number(this.brushRadius?.value || 0.035) * 720);
      const screenNearest = this.nearestScreenVertex(event, {
        ...options,
        maxDistance: screenMaxDistance
      });
      if (screenNearest && options.preferScreen !== false) {
        return screenNearest;
      }
      const surfaceNearest = this.nearestSurfaceVertex(event, options);
      if (surfaceNearest) {
        const snapDistance = options.screenSnapDistance || 14;
        if (screenNearest && screenNearest.distanceSq <= snapDistance * snapDistance) {
          return screenNearest;
        }
        return surfaceNearest;
      }
      return screenNearest;
    },

    neighborLayerSeeds(event, options = {}) {
      if (!this.model) {
        return [];
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();

      const records = this.paintRecords.filter((record) => {
        if (options.record && record !== options.record) {
          return false;
        }
        if (options.recordFilter && !options.recordFilter(record)) {
          return false;
        }
        return true;
      });
      const recordByObject = new Map(records.map((record) => [record.object, record]));
      const intersections = this.raycaster.intersectObjects(records.map((record) => record.object), false);
      if (!intersections.length) {
        return [];
      }

      const brushRadius = Number(this.brushRadius?.value || 0.035);
      const maxDepth = Math.max(0.025, brushRadius * (options.layerDepthMultiplier || 4.5));
      const firstDistance = intersections[0].distance;
      const seeds = [];
      const seen = new Set();

      for (const hit of intersections) {
        if (hit.distance > firstDistance + maxDepth) {
          break;
        }
        const record = recordByObject.get(hit.object);
        const face = hit.face;
        if (!record || !face) {
          continue;
        }
        let nearest = null;
        for (const vertexIndex of [face.a, face.b, face.c]) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          if (options.vertexFilter && !options.vertexFilter(record, vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          const distanceSq = this.tempWorld.distanceToSquared(hit.point);
          if (nearest && distanceSq >= nearest.distanceSq) {
            continue;
          }
          nearest = {
            record,
            vertexIndex,
            distanceSq,
            world: this.tempWorld.clone(),
            hit
          };
        }
        if (!nearest) {
          continue;
        }
        const key = `${this.paintRecords.indexOf(nearest.record)}:${nearest.vertexIndex}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        seeds.push(nearest);
      }
      return seeds;
    },

    updateNeighborHover(event = null) {
      if (!this.neighborHoverMarker || !this.neighborHoverGeometry) {
        return;
      }
      if (!event || this.activeTool !== "neighbor" || this.cleanPreview) {
        this.neighborHoverMarker.visible = false;
        return;
      }
      const stroke = this.neighborStroke;
      const nearest = this.nearestNeighborVertex(event, {
        maxDistance: 26,
        record: stroke?.record,
        vertexFilter: stroke?.component
          ? (record, vertexIndex) => record === stroke.record && stroke.component.has(vertexIndex)
          : null
      });
      if (!nearest) {
        this.neighborHoverMarker.visible = false;
        return;
      }
      this.neighborHoverGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
        nearest.world.x,
        nearest.world.y,
        nearest.world.z
      ], 3));
      this.neighborHoverGeometry.computeBoundingSphere();
      this.neighborHoverMarker.visible = true;
    },

    connectedVertexComponent(record, seedVertexIndex) {
      const component = new Set();
      const queue = [seedVertexIndex];
      while (queue.length) {
        const vertexIndex = queue.shift();
        if (component.has(vertexIndex) || record.deleted?.has(vertexIndex)) {
          continue;
        }
        component.add(vertexIndex);
        for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
          if (!component.has(linkedIndex) && !record.deleted?.has(linkedIndex)) {
            queue.push(linkedIndex);
          }
        }
        for (const neighborIndex of record.vertexNeighbors?.[vertexIndex] || []) {
          if (!component.has(neighborIndex) && !record.deleted?.has(neighborIndex)) {
            queue.push(neighborIndex);
          }
        }
      }
      return component;
    },

    topologyExpandedVertices(record, seeds = [], maxDepth = 2) {
      const expanded = new Set();
      const queue = [];
      for (const seed of seeds) {
        if (!Number.isInteger(seed) || record.deleted?.has(seed)) {
          continue;
        }
        expanded.add(seed);
        queue.push({ vertexIndex: seed, depth: 0 });
      }
      while (queue.length) {
        const { vertexIndex, depth } = queue.shift();
        if (depth >= maxDepth) {
          continue;
        }
        const candidates = [
          ...this.linkedSeamVertices(record, vertexIndex),
          ...(record.vertexNeighbors?.[vertexIndex] || [])
        ];
        for (const candidateIndex of candidates) {
          if (expanded.has(candidateIndex) || record.deleted?.has(candidateIndex)) {
            continue;
          }
          expanded.add(candidateIndex);
          queue.push({ vertexIndex: candidateIndex, depth: depth + 1 });
        }
      }
      return expanded;
    },

    selectedNeighborAnchorMap(maxDepth = 3) {
      const anchorsByRecord = new Map();
      for (const record of this.paintRecords || []) {
        if (!record.selected?.size) {
          continue;
        }
        anchorsByRecord.set(record, this.topologyExpandedVertices(record, record.selected, maxDepth));
      }
      return anchorsByRecord;
    },

    neighborStrokeAnchorVertices(stroke) {
      if (!stroke) {
        return new Set();
      }
      return new Set([
        ...(stroke.anchorVertices || []),
        ...(stroke.vertices || [])
      ]);
    },

    nearestAnchoredNeighborVertex(event, stroke) {
      const anchors = this.neighborStrokeAnchorVertices(stroke);
      if (!stroke?.record || !anchors.size) {
        return null;
      }
      const anchorNeighborhood = this.topologyExpandedVertices(stroke.record, anchors, 3);
      return this.nearestNeighborVertex(event, {
        record: stroke.record,
        maxDistance: Math.max(34, Number(this.brushRadius?.value || 0.035) * 900),
        vertexFilter: (record, vertexIndex) => (
          record === stroke.record
          && (!stroke.component || stroke.component.has(vertexIndex))
          && anchorNeighborhood.has(vertexIndex)
        )
      });
    },

    connectedVerticesWithinBrush(event, record, seedVertexIndex, options = {}) {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radius = Math.max(18, Number(this.brushRadius?.value || 0.035) * 720);
      const radiusSq = radius * radius;
      const worldCenter = options.worldCenter || null;
      const worldRadius = Math.max(0.006, Number(this.brushRadius?.value || 0.035) * (options.worldRadiusMultiplier || 2.25));
      const worldRadiusSq = worldRadius * worldRadius;
      const position = record.geometry.attributes.position;
      const visible = new Set();
      const allowedVertices = options.allowedVertices || null;

      record.object.updateMatrixWorld(true);
      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
        if (record.deleted?.has(vertexIndex)) {
          continue;
        }
        if (allowedVertices && !allowedVertices.has(vertexIndex)) {
          continue;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);
        const insideWorldBrush = Boolean(worldCenter) && this.tempWorld.distanceToSquared(worldCenter) <= worldRadiusSq;
        this.tempWorld.project(this.camera);
        if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
          if (insideWorldBrush) {
            visible.add(vertexIndex);
          }
          continue;
        }
        const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
        const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
        const dx = screenX - x;
        const dy = screenY - y;
        if (dx * dx + dy * dy <= radiusSq || insideWorldBrush) {
          visible.add(vertexIndex);
        }
      }

      if ((!allowedVertices || allowedVertices.has(seedVertexIndex)) && !visible.has(seedVertexIndex)) {
        visible.add(seedVertexIndex);
      }

      const result = new Set();
      const queue = [seedVertexIndex];
      while (queue.length) {
        const vertexIndex = queue.shift();
        if (result.has(vertexIndex) || !visible.has(vertexIndex) || record.deleted?.has(vertexIndex)) {
          continue;
        }
        result.add(vertexIndex);
        const linked = this.linkedSeamVertices(record, vertexIndex);
        for (const linkedIndex of linked) {
          if (!result.has(linkedIndex) && visible.has(linkedIndex) && !record.deleted?.has(linkedIndex)) {
            queue.push(linkedIndex);
          }
        }
        for (const neighborIndex of record.vertexNeighbors?.[vertexIndex] || []) {
          if (!result.has(neighborIndex) && visible.has(neighborIndex) && !record.deleted?.has(neighborIndex)) {
            queue.push(neighborIndex);
          }
        }
      }
      return result;
    },

    expandNeighborHiddenVertices(event, record, vertices, options = {}) {
      if (!vertices?.size) {
        return vertices;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radius = Math.max(18, Number(this.brushRadius?.value || 0.035) * 720);
      const radiusSq = radius * radius;
      const neighborRadiusSq = radiusSq * 1.18;
      const allowedVertices = options.allowedVertices || null;
      const maxDepth = Math.max(1, Math.floor(Number(options.maxDepth) || 1));
      const expanded = new Set(vertices);
      const queue = [...vertices].map((vertexIndex) => ({ vertexIndex, depth: 0 }));
      const queued = new Set(vertices);
      const position = record.geometry.attributes.position;

      const candidateIsLocal = (vertexIndex) => {
        if (record.deleted?.has(vertexIndex)) {
          return false;
        }
        if (allowedVertices && !allowedVertices.has(vertexIndex)) {
          return false;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);
        this.tempWorld.project(this.camera);
        if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
          return false;
        }
        const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
        const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
        const dx = screenX - x;
        const dy = screenY - y;
        return dx * dx + dy * dy <= neighborRadiusSq;
      };

      while (queue.length) {
        const { vertexIndex, depth } = queue.shift();
        if (depth >= maxDepth) {
          continue;
        }
        const candidates = [
          ...this.linkedSeamVertices(record, vertexIndex),
          ...(record.vertexNeighbors?.[vertexIndex] || [])
        ];
        for (const candidateIndex of candidates) {
          if (queued.has(candidateIndex) || !candidateIsLocal(candidateIndex)) {
            continue;
          }
          queued.add(candidateIndex);
          expanded.add(candidateIndex);
          queue.push({ vertexIndex: candidateIndex, depth: depth + 1 });
        }
      }
      return expanded;
    },

    neighborStrokePaintVertices(record, vertices) {
      const expanded = new Set();
      for (const vertexIndex of vertices) {
        for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
          expanded.add(linkedIndex);
        }
        if (!this.mirrorMode) {
          continue;
        }
        const mirrorIndex = this.findMirroredVertex(record, vertexIndex);
        if (mirrorIndex < 0 || mirrorIndex === vertexIndex) {
          continue;
        }
        for (const linkedMirrorIndex of this.linkedSeamVertices(record, mirrorIndex)) {
          expanded.add(linkedMirrorIndex);
        }
      }
      return expanded;
    },

    neighborStrokeTouchesCandidate(record, vertices, stroke) {
      const anchors = this.neighborStrokeAnchorVertices(stroke);
      if (!anchors.size || stroke?.record !== record) {
        return !anchors.size;
      }
      const touches = (vertexIndex) => anchors.has(vertexIndex);
      for (const vertexIndex of vertices) {
        if (touches(vertexIndex)) {
          return true;
        }
        for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
          if (touches(linkedIndex)) {
            return true;
          }
        }
        for (const neighborIndex of record.vertexNeighbors?.[vertexIndex] || []) {
          if (touches(neighborIndex)) {
            return true;
          }
          for (const linkedNeighborIndex of this.linkedSeamVertices(record, neighborIndex)) {
            if (touches(linkedNeighborIndex)) {
              return true;
            }
          }
        }
      }
      return false;
    },

    beginNeighborStroke(event) {
      const nearest = this.nearestNeighborVertex(event, {
        maxDistance: Math.max(30, Number(this.brushRadius?.value || 0.035) * 820),
        preferScreen: true
      });
      if (!nearest) {
        this.neighborStroke = null;
        this.setStatus("Neighbor pen needs a hovered vertex");
        return 0;
      }
      this.neighborStroke = {
        record: nearest.record,
        component: this.connectedVertexComponent(nearest.record, nearest.vertexIndex),
        anchorVertices: new Set(),
        vertices: new Set(),
        changed: 0
      };
      return this.paintConnectedNeighborPatch(event, "paint", {
        nearest,
        stroke: this.neighborStroke,
        layered: true
      });
    },

    continueNeighborStroke(event) {
      if (!this.neighborStroke) {
        return this.beginNeighborStroke(event);
      }
      return this.paintConnectedNeighborPatch(event, "paint", { stroke: this.neighborStroke });
    },

    paintConnectedNeighborPatch(event, action = "paint", options = {}) {
      const stroke = options.stroke || null;
      const anchorCount = this.neighborStrokeAnchorVertices(stroke).size;
      let nearest = options.nearest || this.nearestNeighborVertex(event, {
        record: stroke?.record,
        vertexFilter: stroke?.component
          ? (record, vertexIndex) => record === stroke.record && stroke.component.has(vertexIndex)
          : null
      });
      if (!nearest) {
        this.setStatus("Neighbor pen needs a hovered vertex");
        return 0;
      }
      if (
        anchorCount
        && !this.neighborStrokeTouchesCandidate(nearest.record, new Set([nearest.vertexIndex]), stroke)
      ) {
        nearest = this.nearestAnchoredNeighborVertex(event, stroke);
        if (!nearest) {
          this.setStatus("Neighbor pen stayed on the first connected stroke");
          return 0;
        }
      }
      const layeredSeeds = options.layered && !anchorCount
        ? this.neighborLayerSeeds(event, {
          record: stroke?.record || nearest.record,
          vertexFilter: stroke?.component
            ? (record, vertexIndex) => record === stroke.record && stroke.component.has(vertexIndex)
            : null
        })
        : [];
      const seeds = [nearest];
      const seenSeeds = new Set([`${this.paintRecords.indexOf(nearest.record)}:${nearest.vertexIndex}`]);
      for (const seed of layeredSeeds) {
        const key = `${this.paintRecords.indexOf(seed.record)}:${seed.vertexIndex}`;
        if (seenSeeds.has(key)) {
          continue;
        }
        seenSeeds.add(key);
        seeds.push(seed);
      }
      let changed = 0;
      let touchedStroke = false;

      for (const seed of seeds) {
        const vertices = this.connectedVerticesWithinBrush(event, seed.record, seed.vertexIndex, {
          allowedVertices: stroke?.component || null,
          worldCenter: seed.hit?.point || seed.world || null,
          worldRadiusMultiplier: 2.25
        });
        const expandedVertices = this.expandNeighborHiddenVertices(event, seed.record, vertices, {
          allowedVertices: stroke?.component || null,
          maxDepth: 1
        });
        expandedVertices.add(seed.vertexIndex);
        if (anchorCount && !this.neighborStrokeTouchesCandidate(seed.record, expandedVertices, stroke)) {
          continue;
        }
        touchedStroke = true;
        const strokeVertices = stroke ? this.neighborStrokePaintVertices(seed.record, expandedVertices) : null;
        for (const vertexIndex of expandedVertices) {
          changed += this.applyPaintActionWithMirror(seed.record, vertexIndex, action);
        }
        if (stroke) {
          for (const vertexIndex of strokeVertices) {
            stroke.vertices.add(vertexIndex);
          }
        }
      }
      if (stroke) {
        stroke.changed += changed;
      }
      if (anchorCount && !touchedStroke) {
        this.setStatus("Neighbor pen stayed on the first connected stroke");
        return 0;
      }
      if (changed === 0) {
        this.setStatus("Neighbor pen found no new connected vertices");
      }
      return changed;
    },

    paintFromEvent(event, options = {}) {
      if (!this.model) {
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();

      if (this.activeTool === "deselect" || this.activeTool === "erase") {
        const screenSpaceChanged = this.paintScreenSpaceVertices(event, this.activeTool);
        if (screenSpaceChanged > 0) {
          this.queueSelectionPaintChange?.(screenSpaceChanged, this.activeTool);
          return;
        }
      }
      const shouldPaintThrough = this.activeTool === "paint"
        && this.throughSelectionToggle?.checked;
      if (shouldPaintThrough) {
        const throughChanged = this.paintScreenSpaceVertices(event, this.activeTool, { includeAllVertices: true });
        if (throughChanged > 0) {
          this.queueSelectionPaintChange?.(throughChanged, this.activeTool);
          return;
        }
      }

      const textureHit = this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone"
        ? this.texturePaintHitForEvent?.(event, this.activeTool)
        : null;
      if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser") {
        this.clearTextureAirbrushScreenLayer?.();
        const macroBrush = this.recordTutorialMacroPaintBrushState?.(event) || event.tutorialMacroBrush;
        const macroBrushOptions = this.textureAirbrushOptionsFromMacroBrush?.(macroBrush) || {};
        const textureHitMaterial = textureHit?.record
          ? this.clonePaintMaterialForHit?.(textureHit.record, textureHit.hit) || null
          : null;
        const layerMode = texturePaintActiveLayerMode(this, textureHitMaterial);
        const layerGpuPaint = layerMode
          && typeof this.textureAirbrushGpuLayerTargetForMaterial === "function";
        const neighborPaintActive = this.activeTool === "airbrush"
          && this.texturePaintNeighborModeEnabled?.() === true;
        const liveProjectionRewarmNeeded = neighborPaintActive
          && texturePaintLiveProjectionFrameNeedsVisibleRewarm(this);
        const neighborProjectionDirtyBeforePaint = neighborPaintActive
          && (
            this.textureAirbrushNeighborProjectionDirty === true
            || this.textureAirbrushNeighborProjectionFirstStrokeRewarm === true
            || liveProjectionRewarmNeeded
            || (
              layerMode
              && this.textureAirbrushLayerProjectionFirstStrokeRewarm === true
            )
          );
        const postCameraCoverageRepairBeforePaint = neighborPaintActive
          && (
            this.textureAirbrushNeighborProjectionDirty === true
            || this.textureAirbrushNeighborProjectionFirstStrokeRewarm === true
            || (
              layerMode
              && this.textureAirbrushLayerProjectionFirstStrokeRewarm === true
            )
          );
        let neighborProjectionRewarmed = this.textureAirbrushNeighborProjectionStrokeRewarmedActive === true;
        let postCameraProjectionRewarmed = this.textureAirbrushPostCameraProjectionStrokeRewarmedActive === true;
        let postCameraProjectionAccumulates = this.textureAirbrushPostCameraProjectionStrokeAccumulateActive === true;
        if (neighborProjectionDirtyBeforePaint) {
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // Direct airbrush projection needs the same post-orbit visible-buffer
          // warm-up as the screen-stroke queue. This refreshes camera/depth state;
          // it must not broaden paint to hidden or back-side fragments.
          this.textureAirbrushEndPostCameraProjectionStroke?.();
          this.textureAirbrushResetLiveProjectionFrame?.({ keepCurrent: false });
          this.textureAirbrushBeginNeighborPaintStroke?.(event, this.activeTool);
          const rewarmSucceeded = this.textureAirbrushRewarmNeighborResetProjection?.(event) === true;
          neighborProjectionRewarmed = rewarmSucceeded
            && this.textureAirbrushNeighborProjectionDirty !== true;
          postCameraProjectionRewarmed = neighborProjectionRewarmed;
          postCameraProjectionAccumulates = neighborProjectionRewarmed
            && postCameraCoverageRepairBeforePaint;
          if (neighborProjectionRewarmed) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Direct projected strokes can also arrive as many move events.
            // Keep the visible-only warm state through the whole stroke so
            // post-orbit coverage does not depend on releasing the brush.
            this.textureAirbrushNeighborProjectionStrokeRewarmedActive = true;
            this.textureAirbrushPostCameraProjectionStrokeRewarmedActive = true;
          }
          if (postCameraProjectionAccumulates) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Direct projection gets visible-only accumulation only for the
            // first real post-camera repair stroke, matching the queued path.
            this.textureAirbrushPostCameraProjectionStrokeAccumulateActive = true;
          }
        } else if (neighborPaintActive) {
          this.textureAirbrushSyncNeighborPaintSeedForHit?.(textureHit);
        }
        const visibleSurfaceChanged = this.textureAirbrushVisibleSurfacePaintFromEvent?.(event, {
          gpu: !layerMode || layerGpuPaint,
          ...(layerMode && !layerGpuPaint ? { resolvedBackend: { backend: "none", webGpuStatus: "layer-paint-gpu-required" } } : {}),
          strokeStart: options.strokeStart || null,
          neighborPaintSeed: this.textureAirbrushActiveNeighborPaintSeed || null,
          ...(postCameraProjectionRewarmed ? { postCameraProjectionRewarmed: true } : {}),
          ...(neighborProjectionRewarmed ? { neighborProjectionRewarmed: true } : {}),
          ...(postCameraProjectionAccumulates ? { strokeOpacityCap: false } : {}),
          erase: this.activeTool === "texture-eraser",
          ...macroBrushOptions
        }) || 0;
        if (!visibleSurfaceChanged) {
          this.setStatus(this.activeTool === "texture-eraser"
            ? "Eraser needs paint on the active texture layer"
            : "Airbrush needs the cursor over textured mesh");
        }
        return;
      }

      const paintObjects = this.paintRecords.map((record) => record.object);
      const intersections = textureHit
        ? []
        : this.raycaster.intersectObjects(paintObjects, false);
      if (!intersections.length && !textureHit) {
        return;
      }

      if (this.activeTool === "clone") {
        const cloneHit = textureHit || this.clonePaintHitFromIntersections?.(intersections);
        if (!cloneHit) {
          this.setStatus("Capture a clone sample, then brush over textured mesh");
          return;
        }
        this.clonePaintVerticesNear?.(cloneHit.record, cloneHit.hit, event);
        return;
      }

      const hit = intersections[0];
      const record = this.paintRecords.find((item) => item.object === hit.object);
      if (!record) {
        return;
      }

      if (this.activeTool === "push" || this.activeTool === "pull") {
        const changed = this.sculptVerticesNear(record, hit, this.activeTool === "pull" ? 1 : -1);
        if (changed > 0) {
          record.geometry.attributes.position.needsUpdate = true;
          this.preserveImportedNormals(record);
          this.syncPatchJson();
          this.updateCounts();
          this.updateRecordColors(record);
          this.updateSelectionMarkers();
          this.updateMoveGizmo();
          this.setStatus(`${this.activeTool === "pull" ? "Pulled" : "Pushed"} ${changed} vertices`);
        }
        return;
      }

      const changed = this.paintVerticesNear(record, hit, this.activeTool);
      if (changed > 0) {
        this.queueSelectionPaintChange?.(changed, this.activeTool);
      }
    },

    pickTextureColorFromEvent(event) {
      if (!this.model) {
        return false;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();
      const textureHit = this.texturePaintHitForEvent?.(event, "eyedropper");
      if (!textureHit) {
        this.setStatus("Pick needs the cursor over textured mesh");
        return false;
      }
      return this.pickTextureColorNear?.(textureHit.record, textureHit.hit) || false;
    },

    refreshSkinnedRaycastBounds(options = {}) {
      const now = typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
      const activeTextureStroke = Boolean(this.texturePaintStrokeUndo);
      const minIntervalMs = Math.max(
        0,
        Number(options.minIntervalMs)
        || Number(this.textureAirbrushSkinnedRaycastBoundsMinIntervalMs)
        || (activeTextureStroke ? 250 : 12)
      );
      if (
        options.force !== true
        && Number.isFinite(this.lastSkinnedRaycastBoundsRefreshAt)
        && now - this.lastSkinnedRaycastBoundsRefreshAt < minIntervalMs
      ) {
        return false;
      }
      this.lastSkinnedRaycastBoundsRefreshAt = now;
      for (const record of this.paintRecords) {
        const object = record.object;
        if (!object?.isSkinnedMesh) {
          continue;
        }
        object.computeBoundingSphere?.();
        if (object.boundingBox) {
          object.computeBoundingBox?.();
        }
      }
      return true;
    },

    finishPaintChange(changed, action, options = {}) {
      this.markSelectionStrokeChanged?.(action);
      if (action === "erase" && this.viewMode === "edit") {
        for (const record of this.paintRecords) {
          this.cleanupDeletedVertexSelection?.(record);
          this.applyDeletedVertices?.(record);
        }
      }
      if (options.updateColors !== false) {
        for (const record of this.paintRecords) {
          this.updateRecordColors(record);
        }
      }
      if (options.syncPatch !== false) {
        this.syncPatchJson();
      }
      if (options.updateCounts !== false) {
        this.updateCounts();
      }
      if (options.updateMarkers !== false) {
        this.updateSelectionMarkers();
      }
      if (options.updateAllVertexMarkers !== false && this.viewMode === "edit") {
        this.updateAllVertexMarkers();
      }
      if (options.updateMoveGizmo !== false) {
        this.updateMoveGizmo();
      }
      const refinedRegionCount = options.updateCloneRegion === false
        ? 0
        : this.refreshClonePaintTargetFromSelection?.({ status: false }) || 0;
      if (options.updateStatus === false) {
        return;
      }
      const actionLabels = {
        paint: "Selected",
        neighbor: "Neighbor selected",
        deselect: "Deselected",
        erase: this.viewMode === "edit" ? "Cleaned from mesh" : "Erased edits from"
      };
      const regionSuffix = refinedRegionCount > 0
        ? `; Region now ${refinedRegionCount} ${refinedRegionCount === 1 ? "vertex" : "vertices"}`
        : refinedRegionCount < 0
          ? "; Region cleared"
          : "";
      this.setStatus(`${actionLabels[action] || "Changed"} ${changed} vertices${regionSuffix}`);
    },

    paintScreenSpaceVertices(event, action, options = {}) {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radiusValue = this.selectionBrushRadiusValue?.() ?? Math.max(0.004, Number(this.brushRadius?.value || 0.035));
      const radius = Math.max(18, radiusValue * 720);
      const radiusSq = radius * radius;
      const fallbackRadiusSq = radiusSq * 3.1;
      let changed = 0;
      let nearest = null;

      this.model.updateMatrixWorld(true);
      for (const record of this.paintRecords) {
        const vertexSource = options.includeAllVertices
          ? null
          : action === "erase"
            ? new Set([...record.selected, ...record.modified])
            : record.selected;
        const vertexCount = record.geometry.attributes.position.count;
        const visitVertex = (vertexIndex) => {
          if (record.deleted?.has(vertexIndex)) {
            return;
          }
          this.tempVector.fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          this.tempWorld.project(this.camera);
          if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
            return;
          }

          const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
          const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
          const dx = screenX - x;
          const dy = screenY - y;
          const distanceSq = dx * dx + dy * dy;

          if (distanceSq <= radiusSq) {
            changed += this.applyPaintActionWithMirror(record, vertexIndex, action);
            return;
          }

          if (distanceSq <= fallbackRadiusSq && (!nearest || distanceSq < nearest.distanceSq)) {
            nearest = { record, vertexIndex, distanceSq };
          }
        };

        if (vertexSource === null) {
          for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
            visitVertex(vertexIndex);
          }
          continue;
        }

        for (const vertexIndex of vertexSource) {
          visitVertex(vertexIndex);
        }
      }

      if (changed === 0 && nearest) {
        changed = this.applyPaintActionWithMirror(nearest.record, nearest.vertexIndex, action);
      }

      return changed;
    },

    paintVerticesNear(record, hit, action) {
      const radius = this.selectionBrushRadiusValue?.() ?? Math.max(0.004, Number(this.brushRadius?.value || 0.035));
      const radiusSq = radius * radius;
      const position = record.geometry.attributes.position;
      let changed = 0;

      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
        if (record.deleted?.has(vertexIndex)) {
          continue;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);
        if (this.tempWorld.distanceToSquared(hit.point) > radiusSq) {
          continue;
        }
        changed += this.applyPaintActionWithMirror(record, vertexIndex, action);
      }

      if (changed === 0 && hit.face) {
        for (const vertexIndex of [hit.face.a, hit.face.b, hit.face.c]) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          changed += this.applyPaintActionWithMirror(record, vertexIndex, action);
        }
      }

      return changed;
    },

    applyPaintAction(record, vertexIndex, action) {
      const hadSelected = record.selected.has(vertexIndex);
      const hadModified = record.modified.has(vertexIndex);

      if (action === "paint") {
        if (record.deleted?.has(vertexIndex)) {
          return false;
        }
        record.selected.add(vertexIndex);
        return !hadSelected;
      }
      if (action === "deselect") {
        record.selected.delete(vertexIndex);
        return hadSelected;
      }
      if (action === "erase") {
        if (this.viewMode === "edit") {
          return this.deleteVertex(record, vertexIndex);
        }
        record.selected.delete(vertexIndex);
        if (hadModified) {
          this.eraseVertex(record, vertexIndex);
        }
        return hadSelected || hadModified;
      }
      return false;
    },

    applyPaintActionWithMirror(record, vertexIndex, action) {
      const vertices = new Set(this.linkedSeamVertices(record, vertexIndex));
      if (this.mirrorMode) {
        const mirrorIndex = this.findMirroredVertex(record, vertexIndex);
        if (mirrorIndex >= 0 && mirrorIndex !== vertexIndex) {
          for (const linkedMirrorIndex of this.linkedSeamVertices(record, mirrorIndex)) {
            vertices.add(linkedMirrorIndex);
          }
        }
      }

      let changed = 0;
      for (const linkedIndex of vertices) {
        if (this.applyPaintAction(record, linkedIndex, action)) {
          changed += 1;
        }
      }
      return changed;
    },

    mirrorCurrentSelection() {
      let changed = 0;
      for (const record of this.paintRecords) {
        for (const vertexIndex of [...record.selected]) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          const mirrorIndex = this.findMirroredVertex(record, vertexIndex);
          if (mirrorIndex < 0) {
            continue;
          }
          for (const linkedMirrorIndex of this.linkedSeamVertices(record, mirrorIndex)) {
            if (!record.selected.has(linkedMirrorIndex)) {
              record.selected.add(linkedMirrorIndex);
              changed += 1;
            }
          }
        }
        this.updateRecordColors(record);
      }
      if (changed > 0) {
        this.updateSelectionMarkers();
        this.updateMoveGizmo();
        this.updateCounts();
      }
      return changed;
    },

    sculptVerticesNear(record, hit, direction) {
      const radius = this.selectionBrushRadiusValue?.() ?? Math.max(0.004, Number(this.brushRadius?.value || 0.035));
      const strength = Number(this.sculptStrength.value) * direction;
      const radiusSq = radius * radius;
      const position = record.geometry.attributes.position;
      const normal = record.geometry.attributes.normal;
      this.tempNormalMatrix.getNormalMatrix(record.object.matrixWorld);
      let changed = 0;

      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
        if (record.deleted?.has(vertexIndex)) {
          continue;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);

        const distanceSq = this.tempWorld.distanceToSquared(hit.point);
        if (distanceSq > radiusSq) {
          continue;
        }

        const falloff = 1 - Math.sqrt(distanceSq) / radius;
        this.tempWorldNormal.fromBufferAttribute(normal, vertexIndex).applyMatrix3(this.tempNormalMatrix).normalize();
        this.tempWorldDelta.copy(this.tempWorldNormal).multiplyScalar(strength * falloff);
        this.moveVertexByWorldDelta(record, vertexIndex, this.tempWorldDelta);
        record.modified.add(vertexIndex);
        record.sculpted.add(vertexIndex);
        changed += 1;
      }

      return changed;
    },

    eraseVertex(record, vertexIndex) {
      record.selected.delete(vertexIndex);
      if (record.deleted?.has(vertexIndex)) {
        return;
      }
      if (record.modified.has(vertexIndex)) {
        this.restoreOriginalVertexWeights(record, vertexIndex);
        record.modified.delete(vertexIndex);
        record.sculpted.delete(vertexIndex);
      }
    },

    clearSelection() {
      for (const record of this.paintRecords) {
        record.selected.clear();
        this.updateRecordColors(record);
      }
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.setStatus("Selection cleared");
    },

    invertSelection() {
      for (const record of this.paintRecords) {
        const next = new Set();
        const vertexCount = record.geometry.attributes.position.count;
        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          if (!record.selected.has(vertexIndex)) {
            next.add(vertexIndex);
          }
        }
        record.selected = next;
        this.updateRecordColors(record);
      }
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.setStatus("Selection inverted");
    },

    linkedSeamVertices(record, vertexIndex) {
      return record.seamVertexMap?.get(vertexIndex) || [vertexIndex];
    },

    vertexSideSign(record, vertexIndex) {
      const x = record.originalPosition[vertexIndex * 3] - record.mirrorCenterX;
      if (Math.abs(x) < 0.0001) {
        return 0;
      }
      return Math.sign(x);
    },

    boneSideSignForRecord(record, boneName) {
      const mirrorName = this.mirrorBoneName(boneName);
      const bone = this.bones.get(boneName);
      const mirrorBone = this.bones.get(mirrorName);
      if (!bone || !mirrorBone) {
        return 0;
      }
      bone.getWorldPosition(this.tempWorld);
      record.object.worldToLocal(this.tempLocalA.copy(this.tempWorld));
      mirrorBone.getWorldPosition(this.tempWorld);
      record.object.worldToLocal(this.tempLocalB.copy(this.tempWorld));
      const x = this.tempLocalA.x - this.tempLocalB.x;
      if (Math.abs(x) < 0.0001) {
        return 0;
      }
      return Math.sign(x);
    },

    findMirroredVertex(record, vertexIndex) {
      if (record.mirrorVertexCache.has(vertexIndex)) {
        return record.mirrorVertexCache.get(vertexIndex);
      }

      const sourceOffset = vertexIndex * 3;
      const targetX = record.mirrorCenterX * 2 - record.originalPosition[sourceOffset];
      const targetY = record.originalPosition[sourceOffset + 1];
      const targetZ = record.originalPosition[sourceOffset + 2];
      const sourceSide = this.vertexSideSign(record, vertexIndex);
      const position = record.originalPosition;
      const vertexCount = record.geometry.attributes.position.count;
      let bestIndex = -1;
      let bestDistanceSq = Infinity;

      for (let index = 0; index < vertexCount; index += 1) {
        if (index === vertexIndex) {
          continue;
        }
        const side = this.vertexSideSign(record, index);
        if (sourceSide && side === sourceSide) {
          continue;
        }
        const offset = index * 3;
        const dx = position[offset] - targetX;
        const dy = position[offset + 1] - targetY;
        const dz = position[offset + 2] - targetZ;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestIndex = index;
        }
      }

      record.mirrorVertexCache.set(vertexIndex, bestIndex);
      return bestIndex;
    }
  });
}
