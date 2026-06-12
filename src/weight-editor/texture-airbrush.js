export function installTextureAirbrushMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;
  const TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS = 64;
  const SELECTION_BRUSH_TOOLS = new Set(["paint", "deselect", "erase", "push", "pull"]);
  const MIPMAP_FILTERS = new Set([
    THREE.NearestMipmapNearestFilter,
    THREE.NearestMipmapLinearFilter,
    THREE.LinearMipmapNearestFilter,
    THREE.LinearMipmapLinearFilter
  ].filter((value) => value !== undefined));

  // Painting module note:
  // The current airbrush is a WebGL live-bake brush: each stroke projects screen-space
  // brush segments into UV texture render targets. A Photoshop-like brush feel likely
  // needs a larger WebGPU brush-engine pass instead of another UI preview layer. The
  // future direction is a shared stroke buffer, one GPU brush kernel for both preview
  // and bake, tiled texture updates, and identical brush math for the screen preview
  // and final UV texture result. We tried a separate 2D overlay preview, but it did not
  // agree visually with the bake because screen pixels, UV texels, seams, filtering,
  // depth, and falloff all diverged.

  function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  function byteHex(value) {
    return clampByte(value).toString(16).padStart(2, "0");
  }

  function hexColorBytes(value, fallback = "#c06f4f") {
    const text = String(value || fallback).trim();
    const match = /^#?([0-9a-f]{6})$/i.exec(text) || /^#?([0-9a-f]{6})$/i.exec(fallback);
    const hex = match?.[1] || "c06f4f";
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  function linearByteToSrgbByte(value) {
    const linear = Math.max(0, Math.min(1, Number(value) / 255));
    const srgb = linear <= 0.0031308
      ? linear * 12.92
      : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    return clampByte(srgb * 255);
  }

  function isBrightArtifactPixel(imageData, offset) {
    const red = imageData[offset];
    const green = imageData[offset + 1];
    const blue = imageData[offset + 2];
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    return luma > 112 && spread < 96;
  }

  function artifactTintAlpha(imageData, offset, baseAlpha, softFalloff) {
    if (!isBrightArtifactPixel(imageData, offset)) {
      return baseAlpha;
    }
    return Math.max(baseAlpha, Math.min(0.96, 0.34 + softFalloff * 0.62));
  }

  function distanceToSegmentPixels(x, y, startX, startY, endX, endY) {
    const segmentX = endX - startX;
    const segmentY = endY - startY;
    const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
    const t = segmentLengthSq > 0.0001
      ? Math.max(0, Math.min(1, ((x - startX) * segmentX + (y - startY) * segmentY) / segmentLengthSq))
      : 1;
    const closestX = startX + segmentX * t;
    const closestY = startY + segmentY * t;
    const dx = x - closestX;
    const dy = y - closestY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function airbrushCoverageForDistance(distancePixels, radiusPixels, scatter, hardness) {
    const radius = Math.max(1, radiusPixels);
    const safeScatter = Math.max(0, Math.min(1, scatter));
    const safeHardness = Math.max(0, Math.min(1, hardness));
    const haloRadius = radius * (1 + safeScatter * 0.72);
    if (distancePixels > haloRadius) {
      return 0;
    }
    const hardRadius = radius * safeHardness;
    if (distancePixels <= hardRadius) {
      return 1;
    }
    const fadeRadius = Math.max(1, haloRadius - hardRadius);
    const edge = Math.max(0, 1 - (distancePixels - hardRadius) / fadeRadius);
    const exponent = 3.6 - safeHardness * 2.55 + safeScatter * 0.25;
    return Math.min(1, Math.pow(edge, exponent));
  }

  function airbrushAlphaForDistance(distancePixels, radiusPixels, opacity, scatter, hardness, strength = 1) {
    return Math.min(
      1,
      opacity * strength * airbrushCoverageForDistance(distancePixels, radiusPixels, scatter, hardness)
    );
  }

  Object.assign(BirdWeightEditor.prototype, {
    texturePaintToolUsesRegion(tool = this.activeTool) {
      return tool === "clone";
    },

    textureAirbrushRecords() {
      const records = [...(this.paintRecords || [])].filter((record) => (
        record?.object
        && record.geometry?.attributes?.position
        && record.geometry?.attributes?.uv
      ));
      const knownObjects = new Set(records.map((record) => record.object));
      this.model?.traverse?.((object) => {
        if (
          knownObjects.has(object)
          || (!object.isMesh && !object.isSkinnedMesh)
          || !object.visible
          || !object.geometry?.attributes?.position
          || !object.geometry?.attributes?.uv
        ) {
          return;
        }
        knownObjects.add(object);
        records.push({
          object,
          geometry: object.geometry,
          selected: new Set(),
          modified: new Set(),
          deleted: new Set(),
          texturePaintOnly: true
        });
      });
      return records;
    },

    texturePaintFrontRegionHitAtCanvasPoint(point, targetEntries = null) {
      if (!point || !this.canvas || !this.camera) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      if (
        point.x < 0
        || point.y < 0
        || point.x > rect.width
        || point.y > rect.height
      ) {
        return null;
      }
      const entries = targetEntries || [...(this.clonePaintTargets?.entries?.() || [])]
        .filter(([record, target]) => record?.object && target?.vertices?.size);
      if (!entries.length) {
        return null;
      }
      const recordByObject = new Map(entries.map(([record]) => [record.object, record]));
      const targetByRecord = new Map(entries);
      this.pointer.x = (point.x / rect.width) * 2 - 1;
      this.pointer.y = -(point.y / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const intersections = this.raycaster.intersectObjects(entries.map(([record]) => record.object), false);
      const hit = intersections[0];
      const record = hit ? recordByObject.get(hit.object) : null;
      const target = record ? targetByRecord.get(record) : null;
      if (!record || !target?.vertices?.size || !hit?.uv) {
        return null;
      }
      if (!this.clonePaintHitInsideRegion?.(hit, target)) {
        return null;
      }
      return { record, target, hit };
    },

    texturePaintHitForEvent(event, tool = this.activeTool) {
      if (!event || !this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();

      const regionOverlays = this.texturePaintToolUsesRegion(tool)
        ? (this.cloneSpotlightOverlays || []).filter((overlay) => (
          overlay.visible
          && overlay.userData?.cloneSpotlightKind === "target"
        ))
        : [];
      const hasCapturedRegion = Boolean(this.clonePaintTargets?.size && regionOverlays.length);
      if (hasCapturedRegion) {
        const targetEntries = [...(this.clonePaintTargets?.entries?.() || [])]
          .filter(([record, target]) => record?.object && target?.vertices?.size);
        const frontRegionHit = this.texturePaintFrontRegionHitAtCanvasPoint?.({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        }, targetEntries);
        if (frontRegionHit) {
          return {
            record: frontRegionHit.record,
            hit: this.clonePaintProxySpotlightHit?.(
              frontRegionHit.hit,
              frontRegionHit.record,
              frontRegionHit.target
            ) || frontRegionHit.hit
          };
        }
        const screenRegionHit = this.texturePaintScreenSpotlightHit?.(event);
        const screenPoint = screenRegionHit?.hit?.screenPoint;
        const edgeRegionHit = screenPoint
          ? this.texturePaintFrontRegionHitAtCanvasPoint?.(screenPoint, targetEntries)
          : null;
        if (edgeRegionHit) {
          return {
            record: edgeRegionHit.record,
            hit: this.clonePaintProxySpotlightHit?.(
              edgeRegionHit.hit,
              edgeRegionHit.record,
              edgeRegionHit.target
            ) || edgeRegionHit.hit
          };
        }
        return null;
      }

      const textureRecords = tool === "airbrush" || tool === "eyedropper"
        ? this.textureAirbrushRecords?.() || this.paintRecords || []
        : this.paintRecords || [];
      const raycastObjects = hasCapturedRegion
        ? regionOverlays
        : [
          ...regionOverlays,
          ...textureRecords.map((record) => record.object)
        ];
      const intersections = this.raycaster.intersectObjects(raycastObjects, false);
      if (tool === "clone") {
        return this.clonePaintHitFromIntersections?.(intersections) || null;
      }
      return this.texturePaintHitFromIntersections?.(intersections) || null;
    },

    textureBrushRadiusValue() {
      return Math.max(0.004, Number(this.textureBrushRadius?.value || this.brushRadius?.value || 0.035));
    },

    textureBrushRadiusScreenPixels() {
      return Math.max(
        0.75,
        Math.min(40, this.textureBrushRadiusValue() * 220)
      );
    },

    selectionBrushRadiusValue() {
      return Math.max(0.004, Number(this.brushRadius?.value || 0.035));
    },

    usesSelectionBrushCursor(tool = this.activeTool) {
      return SELECTION_BRUSH_TOOLS.has(tool);
    },

    selectionBrushScreenRadiusPixels() {
      const radius = this.selectionBrushRadiusValue();
      return Math.max(18, Math.min(160, radius * 720));
    },

    textureAirbrushCanUseScreenStroke() {
      return this.activeTool === "airbrush"
        && Boolean(this.model)
        && Boolean(this.canvas)
        && !this.textureAirbrushGpuDisabled;
    },

    resizeTextureAirbrushScreenLayer() {
      const layer = this.textureAirbrushScreenLayer;
      if (!layer || !this.canvas) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.round(rect.width * scale));
      const height = Math.max(1, Math.round(rect.height * scale));
      if (layer.width !== width || layer.height !== height) {
        layer.width = width;
        layer.height = height;
      }
      return {
        layer,
        context: layer.getContext("2d"),
        rect,
        scale
      };
    },

    captureTextureAirbrushScreenBase(layerState = null) {
      const state = layerState || this.resizeTextureAirbrushScreenLayer?.();
      if (!state?.layer || !this.canvas) {
        this.textureAirbrushScreenBaseImage = null;
        return null;
      }
      const { layer } = state;
      const baseCanvas = this.textureAirbrushScreenBaseCanvas || document.createElement("canvas");
      if (baseCanvas.width !== layer.width || baseCanvas.height !== layer.height) {
        baseCanvas.width = layer.width;
        baseCanvas.height = layer.height;
      }
      const context = baseCanvas.getContext("2d");
      if (!context) {
        this.textureAirbrushScreenBaseImage = null;
        return null;
      }
      try {
        context.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        context.drawImage(this.canvas, 0, 0, baseCanvas.width, baseCanvas.height);
        this.textureAirbrushScreenBaseCanvas = baseCanvas;
        this.textureAirbrushScreenBaseContext = context;
        this.textureAirbrushScreenBaseImage = context.getImageData(0, 0, baseCanvas.width, baseCanvas.height);
      } catch {
        this.textureAirbrushScreenBaseImage = null;
      }
      return this.textureAirbrushScreenBaseImage;
    },

    clearTextureAirbrushScreenLayer(options = {}) {
      const layer = this.textureAirbrushScreenLayer;
      if (!layer) {
        return;
      }
      if (options.defer) {
        const token = {};
        this.textureAirbrushScreenClearToken = token;
        const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame.bind(window)
          : (callback) => window.setTimeout(callback, 16);
        requestFrame(() => {
          requestFrame(() => {
            if (this.textureAirbrushScreenClearToken === token) {
              this.textureAirbrushScreenClearToken = null;
              this.clearTextureAirbrushScreenLayer?.();
            }
          });
        });
        return;
      }
      const context = layer.getContext("2d");
      context?.clearRect(0, 0, layer.width || 0, layer.height || 0);
      layer.hidden = true;
      this.textureAirbrushScreenBaseImage = null;
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
      const radiusPixels = Math.max(1, this.textureBrushRadiusScreenPixels?.() || 8);
      const dx = current.clientX - start.clientX;
      const dy = current.clientY - start.clientY;
      const maxSegmentPixels = Math.max(80, radiusPixels * 18);
      const safeStart = Math.sqrt(dx * dx + dy * dy) > maxSegmentPixels
        ? current
        : start;
      const color = this.textureAirbrushColor();
      return {
        clientX: current.clientX,
        clientY: current.clientY,
        strokeStart: safeStart,
        radiusPixels,
        color: { r: color.r, g: color.g, b: color.b },
        opacity: this.textureAirbrushOpacity?.() ?? 0.42,
        hardness: this.textureAirbrushHardness?.() ?? 0.35,
        scatter: this.textureAirbrushScatter?.() ?? 0.35,
        strength: 1
      };
    },

    drawTextureAirbrushScreenStroke(payload) {
      const layerState = this.resizeTextureAirbrushScreenLayer?.();
      const context = layerState?.context;
      if (!payload || !context || !layerState?.rect) {
        return false;
      }
      const { layer, rect, scale } = layerState;
      const startX = payload.strokeStart.clientX - rect.left;
      const startY = payload.strokeStart.clientY - rect.top;
      const endX = payload.clientX - rect.left;
      const endY = payload.clientY - rect.top;
      const color = payload.color || this.textureAirbrushColor();
      const red = clampByte(color.r);
      const green = clampByte(color.g);
      const blue = clampByte(color.b);
      const paintLuma = Math.max(1, 0.2126 * red + 0.7152 * green + 0.0722 * blue);
      const opacity = Math.max(0.04, Math.min(1, Number(payload.opacity ?? 0.42)));
      const hardness = Math.max(0, Math.min(1, Number(payload.hardness ?? 0.35)));
      const scatter = Math.max(0, Math.min(1, Number(payload.scatter ?? 0.35)));
      const strength = Math.max(0.08, Math.min(1, Number(payload.strength ?? 1)));
      const radius = Math.max(1, payload.radiusPixels);
      const haloRadius = radius * (1 + scatter * 0.72);
      const minX = Math.max(0, Math.floor((Math.min(startX, endX) - haloRadius - 2) * scale));
      const maxX = Math.min(layer.width, Math.ceil((Math.max(startX, endX) + haloRadius + 2) * scale));
      const minY = Math.max(0, Math.floor((Math.min(startY, endY) - haloRadius - 2) * scale));
      const maxY = Math.min(layer.height, Math.ceil((Math.max(startY, endY) + haloRadius + 2) * scale));
      const width = maxX - minX;
      const height = maxY - minY;
      if (width <= 0 || height <= 0) {
        return false;
      }
      this.textureAirbrushScreenClearToken = null;
      layer.hidden = false;

      const image = context.getImageData(minX, minY, width, height);
      const data = image.data;
      const baseImage = this.textureAirbrushScreenBaseImage?.width === layer.width
        && this.textureAirbrushScreenBaseImage?.height === layer.height
        ? this.textureAirbrushScreenBaseImage
        : this.captureTextureAirbrushScreenBase?.(layerState);
      const baseData = baseImage?.data || null;
      for (let y = 0; y < height; y += 1) {
        const screenY = (minY + y + 0.5) / scale;
        for (let x = 0; x < width; x += 1) {
          const screenX = (minX + x + 0.5) / scale;
          const distance = distanceToSegmentPixels(screenX, screenY, startX, startY, endX, endY);
          const alpha = airbrushAlphaForDistance(distance, radius, opacity, scatter, hardness, strength);
          if (alpha <= 0.004) {
            continue;
          }
          const offset = (y * width + x) * 4;
          const alphaByte = clampByte(alpha * 255);
          if (alphaByte <= data[offset + 3]) {
            continue;
          }
          let shadedRed = red;
          let shadedGreen = green;
          let shadedBlue = blue;
          if (baseData) {
            const baseOffset = ((minY + y) * layer.width + (minX + x)) * 4;
            const baseRed = baseData[baseOffset];
            const baseGreen = baseData[baseOffset + 1];
            const baseBlue = baseData[baseOffset + 2];
            const baseLuma = 0.2126 * baseRed + 0.7152 * baseGreen + 0.0722 * baseBlue;
            const shade = Math.max(
              0.08,
              Math.min(1.15, (baseLuma / paintLuma) * (0.92 + hardness * 0.28) + 0.04)
            );
            shadedRed = clampByte(red * shade);
            shadedGreen = clampByte(green * shade);
            shadedBlue = clampByte(blue * shade);
          }
          data[offset] = shadedRed;
          data[offset + 1] = shadedGreen;
          data[offset + 2] = shadedBlue;
          data[offset + 3] = alphaByte;
        }
      }
      context.putImageData(image, minX, minY);
      return true;
    },

    textureAirbrushQueueScreenStroke(event, options = {}) {
      if (!this.textureAirbrushCanUseScreenStroke?.()) {
        return false;
      }
      const payload = this.textureAirbrushScreenStrokePayload(event, options.strokeStart);
      if (!payload) {
        return false;
      }
      this.clearTextureAirbrushScreenLayer?.();
      const changed = this.textureAirbrushProjectedMeshFromEvent?.(event, {
        gpu: true,
        strokeStart: payload.strokeStart,
        radiusPixels: payload.radiusPixels,
        color: payload.color,
        opacity: payload.opacity,
        hardness: payload.hardness,
        scatter: payload.scatter,
        strength: payload.strength
      }) || 0;
      if (!changed) {
        this.setStatus("Airbrush needs the cursor over textured mesh");
      }
      return true;
    },

    scheduleTextureAirbrushScreenStrokeFlush() {
      if (this.textureAirbrushScreenFlushScheduled || this.textureAirbrushFlushingScreenStroke) {
        return false;
      }
      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback) => window.setTimeout(callback, 16);
      this.textureAirbrushScreenFlushScheduled = true;
      requestFrame(() => {
        this.textureAirbrushScreenFlushScheduled = false;
        if (this.textureAirbrushScreenStrokeQueue?.length) {
          this.flushTextureAirbrushScreenStroke?.({ live: true });
        }
      });
      return true;
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
        const radiusPixels = Math.max(1, Number(segment.radiusPixels) || this.textureBrushRadiusScreenPixels?.() || 8);
        const color = segment.color || this.textureAirbrushColor();
        const opacity = Math.max(0.04, Math.min(1, Number(segment.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42)));
        const hardness = Math.max(0, Math.min(1, Number(segment.hardness ?? this.textureAirbrushHardness?.() ?? 0.35)));
        const scatter = Math.max(0, Math.min(1, Number(segment.scatter ?? this.textureAirbrushScatter?.() ?? 0.35)));
        const strength = Math.max(0.08, Math.min(1, Number(segment.strength ?? 1)));
        const styleKey = [
          Math.round(radiusPixels * 100),
          clampByte(color.r),
          clampByte(color.g),
          clampByte(color.b),
          Math.round(opacity * 1000),
          Math.round(hardness * 1000),
          Math.round(scatter * 1000),
          Math.round(strength * 1000)
        ].join(":");
        if (
          !activeBatch
          || activeBatch.styleKey !== styleKey
          || activeBatch.strokeSegments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
        ) {
          activeBatch = {
            styleKey,
            radiusPixels,
            color: { r: clampByte(color.r), g: clampByte(color.g), b: clampByte(color.b) },
            opacity,
            hardness,
            scatter,
            strength,
            strokeSegments: []
          };
          batches.push(activeBatch);
        }
        activeBatch.strokeSegments.push({
          start: {
            clientX: segment.strokeStart.clientX,
            clientY: segment.strokeStart.clientY
          },
          end: {
            clientX: segment.clientX,
            clientY: segment.clientY
          }
        });
      }
      return batches;
    },

    flushTextureAirbrushScreenStroke(options = {}) {
      if (this.textureAirbrushFlushingScreenStroke) {
        return 0;
      }
      this.textureAirbrushScreenFlushScheduled = false;
      const queue = this.textureAirbrushScreenStrokeQueue || [];
      if (!queue.length) {
        this.clearTextureAirbrushScreenLayer?.();
        return 0;
      }
      this.textureAirbrushScreenStrokeQueue = [];
      this.textureAirbrushFlushingScreenStroke = true;
      let changed = 0;
      try {
        const batches = this.textureAirbrushScreenStrokeBatches(queue);
        for (const batch of batches) {
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
            strength: batch.strength
          }) || 0;
        }
      } finally {
        this.textureAirbrushFlushingScreenStroke = false;
        this.clearTextureAirbrushScreenLayer?.();
      }
      if (changed > 0) {
        this.setStatus(`Airbrushed ${changed} projected pixels`);
      } else {
        this.setStatus("Airbrush needs the cursor over textured mesh");
      }
      if (options.live && this.textureAirbrushScreenStrokeQueue?.length) {
        this.scheduleTextureAirbrushScreenStrokeFlush?.();
      }
      return changed;
    },

    hideTextureBrushCursor() {
      if (this.textureBrushCursor) {
        this.textureBrushCursor.hidden = true;
        this.textureBrushCursor.classList.remove("is-clone", "is-selection", "is-deselect");
      }
    },

    rememberBrushCursorEvent(event) {
      if (!event || !this.canvas) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      if (
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom
      ) {
        this.lastBrushCursorEvent = null;
        return null;
      }
      this.lastBrushCursorEvent = {
        clientX: event.clientX,
        clientY: event.clientY
      };
      return this.lastBrushCursorEvent;
    },

    brushCursorStageRect() {
      return this.canvas?.parentElement?.getBoundingClientRect?.()
        || this.canvas?.getBoundingClientRect?.()
        || { left: 0, top: 0 };
    },

    positionBrushCursor(event, radius) {
      const stageRect = this.brushCursorStageRect();
      this.textureBrushCursor.style.width = `${radius * 2}px`;
      this.textureBrushCursor.style.height = `${radius * 2}px`;
      this.textureBrushCursor.style.left = `${event.clientX - stageRect.left - radius}px`;
      this.textureBrushCursor.style.top = `${event.clientY - stageRect.top - radius}px`;
    },

    updateBrushCursorForLastPointer() {
      if (!this.lastBrushCursorEvent) {
        return false;
      }
      if (this.activeTool === "airbrush" || this.activeTool === "clone") {
        return this.updateTextureBrushCursor(this.lastBrushCursorEvent);
      }
      if (this.usesSelectionBrushCursor?.(this.activeTool)) {
        return this.updateSelectionBrushCursor(this.lastBrushCursorEvent);
      }
      return false;
    },

    updateTextureBrushCursor(event) {
      if (!this.textureBrushCursor || !this.canvas || !event) {
        return false;
      }
      const remembered = this.rememberBrushCursorEvent(event);
      const isTextureBrush = this.activeTool === "airbrush" || this.activeTool === "clone";
      if (!isTextureBrush || this.cleanPreview || !remembered) {
        this.hideTextureBrushCursor();
        return false;
      }
      const hit = this.texturePaintHitForEvent(event, this.activeTool);
      if (this.activeTool === "clone" && (!hit || !this.clonePaintSource?.records?.get(hit.record))) {
        this.hideTextureBrushCursor();
        return false;
      }
      if (this.activeTool === "airbrush") {
        this.scheduleTextureAirbrushPrewarm?.(event, hit);
      }
      const radius = this.textureBrushRadiusScreenPixels();
      this.textureBrushCursor.hidden = false;
      this.textureBrushCursor.classList.remove("is-selection", "is-deselect");
      this.textureBrushCursor.classList.toggle("is-clone", this.activeTool === "clone");
      this.positionBrushCursor(event, radius);
      return true;
    },

    updateSelectionBrushCursor(event) {
      if (!this.textureBrushCursor || !this.canvas || !event) {
        return false;
      }
      this.rememberBrushCursorEvent(event);
      if (!this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.hideTextureBrushCursor();
        return false;
      }
      const radius = this.selectionBrushScreenRadiusPixels();
      this.textureBrushCursor.hidden = false;
      this.textureBrushCursor.classList.remove("is-clone");
      this.textureBrushCursor.classList.add("is-selection");
      this.textureBrushCursor.classList.toggle("is-deselect", this.activeTool === "deselect" || this.activeTool === "erase");
      this.positionBrushCursor(event, radius);
      return true;
    },

    cloneReplayProbeEventFromRegion() {
      this.updateCloneSpotlight?.();
      const targetOverlays = (this.cloneSpotlightOverlays || []).filter((item) => (
        item.userData?.cloneSpotlightKind === "target"
      ));
      const overlay = targetOverlays.find((item) => (
        item.visible
        && item.geometry?.attributes?.position?.count >= 3
      ));
      this.cloneReplayProbeDebug = {
        overlays: this.cloneSpotlightOverlays?.length || 0,
        targetOverlays: targetOverlays.length,
        targetVertices: [...(this.clonePaintTargets?.values?.() || [])]
          .reduce((sum, target) => sum + (target?.vertices?.size || 0), 0),
        targetOverlayVertices: targetOverlays.reduce((sum, item) => (
          sum + (item.geometry?.attributes?.position?.count || 0)
        ), 0)
      };
      if (!overlay || !this.canvas || !this.camera) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const position = overlay.geometry.attributes.position;
      const center = new THREE.Vector3();
      overlay.updateMatrixWorld(true);
      for (let index = 0; index < 3; index += 1) {
        const local = new THREE.Vector3().fromBufferAttribute(position, index);
        this.applyBoneTransform?.(overlay, index, local);
        overlay.localToWorld(local);
        center.add(local);
      }
      center.multiplyScalar(1 / 3).project(this.camera);
      return {
        button: 0,
        clientX: rect.left + (center.x * 0.5 + 0.5) * rect.width,
        clientY: rect.top + (-center.y * 0.5 + 0.5) * rect.height
      };
    },

    cloneReplayRegionTextureSamples(record, hit) {
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      const target = this.clonePaintTargets?.get(record);
      if (!editable || !target?.vertices?.size) {
        return null;
      }
      const { canvas, context, texture } = editable;
      const materialIndex = hit?.face?.materialIndex
        ?? target.originMaterialIndex
        ?? target.materialIndex
        ?? 0;
      const triangles = this.clonePaintRegionTextureTriangles?.(
        record,
        target,
        materialIndex,
        canvas,
        texture,
        { referenceUv: hit?.uv || target.originUv || target.uvCenter }
      );
      if (!triangles?.length) {
        return null;
      }
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const samples = new Map();
      let checksum = 2166136261;
      const addPixel = (point) => {
        const actual = this.clonePaintActualPixelFromTexturePoint?.(point, canvas, texture);
        if (!actual) {
          return;
        }
        const key = `${actual.x}:${actual.y}`;
        if (samples.has(key)) {
          return;
        }
        const offset = (actual.y * canvas.width + actual.x) * 4;
        const packed = (
          (image.data[offset] << 24)
          | (image.data[offset + 1] << 16)
          | (image.data[offset + 2] << 8)
          | image.data[offset + 3]
        ) >>> 0;
        samples.set(key, packed);
        checksum ^= packed;
        checksum = Math.imul(checksum, 16777619) >>> 0;
      };

      for (const triangle of triangles) {
        const pixels = triangle.pixels || [];
        if (pixels.length !== 3) {
          continue;
        }
        const minX = Math.floor(Math.min(...pixels.map((point) => point.x)));
        const maxX = Math.ceil(Math.max(...pixels.map((point) => point.x)));
        const minY = Math.floor(Math.min(...pixels.map((point) => point.y)));
        const maxY = Math.ceil(Math.max(...pixels.map((point) => point.y)));
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const point = { x, y };
            const barycentric = this.clonePaintBarycentric(point, pixels);
            if (this.clonePaintBarycentricInside(barycentric, 0.015)) {
              addPixel(point);
            }
          }
        }
      }
      return { checksum, count: samples.size, samples };
    },

    cloneReplayCompareTextureSamples(before, after) {
      if (!before || !after) {
        return null;
      }
      let changed = 0;
      for (const [key, value] of after.samples) {
        if (before.samples.get(key) !== value) {
          changed += 1;
        }
      }
      return {
        changed,
        beforeCount: before.count,
        afterCount: after.count,
        beforeChecksum: before.checksum,
        afterChecksum: after.checksum
      };
    },

    probeCloneReplayPaint(tool = "airbrush") {
      const paintTool = tool === "clone" ? "clone" : "airbrush";
      const event = this.cloneReplayProbeEventFromRegion?.();
      if (!event) {
        const debug = this.cloneReplayProbeDebug || {};
        this.setStatus(`Clone replay probe found ${debug.targetOverlayVertices || 0} Region overlay vertices from ${debug.targetVertices || 0} region vertices`);
        return { changed: 0, hit: false };
      }
      if (paintTool === "clone") {
        this.activateClonePaintTool?.();
      } else {
        this.setTool?.("airbrush");
      }
      const hit = this.texturePaintHitForEvent?.(event, paintTool);
      if (!hit) {
        this.setStatus(`Clone replay ${paintTool} probe missed Region`);
        return { changed: 0, hit: false };
      }
      const before = this.cloneReplayRegionTextureSamples?.(hit.record, hit.hit);
      this.paintFromEvent?.(event);
      const after = this.cloneReplayRegionTextureSamples?.(hit.record, hit.hit);
      const diff = this.cloneReplayCompareTextureSamples?.(before, after);
      if (!diff) {
        this.setStatus(`Clone replay ${paintTool} probe could not sample Region texture`);
        return { changed: 0, hit: true };
      }
      this.setStatus(`Clone replay ${paintTool} event changed ${diff.changed} Region ${diff.changed === 1 ? "pixel" : "pixels"}`);
      return { ...diff, hit: true, tool: paintTool };
    },

    probeCloneReplayAirbrush() {
      return this.probeCloneReplayPaint?.("airbrush");
    },

    textureAirbrushColor() {
      return hexColorBytes(this.texturePaintColor?.value || "#c06f4f");
    },

    textureAirbrushShaderColor(color = null) {
      const hex = color
        ? `#${byteHex(color.r)}${byteHex(color.g)}${byteHex(color.b)}`
        : this.texturePaintColor?.value || "#c06f4f";
      const shaderColor = new THREE.Color(hex);
      return {
        r: shaderColor.r,
        g: shaderColor.g,
        b: shaderColor.b
      };
    },

    textureAirbrushStrength() {
      return Math.max(0.08, this.textureAirbrushOpacity?.() ?? 0.42);
    },

    textureAirbrushOpacity() {
      return Math.max(0.04, Math.min(1, Number(this.textureBrushOpacity?.value || 0.42)));
    },

    textureAirbrushHardness() {
      return Math.max(0, Math.min(1, Number(this.textureBrushHardness?.value || 0.35)));
    },

    textureAirbrushScatter() {
      return Math.max(0, Math.min(1, Number(this.textureBrushScatter?.value || 0.35)));
    },

    textureAirbrushOptionsFromMacroBrush(settings = null) {
      if (!settings || typeof settings !== "object") {
        return null;
      }
      const colorBytes = settings.colorBytes && typeof settings.colorBytes === "object"
        ? settings.colorBytes
        : null;
      let color = colorBytes
        ? {
            r: clampByte(colorBytes.r),
            g: clampByte(colorBytes.g),
            b: clampByte(colorBytes.b)
          }
        : null;
      if (!color && /^#[0-9a-f]{6}$/i.test(String(settings.color || ""))) {
        const value = Number.parseInt(String(settings.color).slice(1), 16);
        color = {
          r: (value >> 16) & 255,
          g: (value >> 8) & 255,
          b: value & 255
        };
      }
      return {
        ...(color ? { color } : {}),
        ...(Number.isFinite(Number(settings.radiusPixels)) ? { radiusPixels: Math.max(1, Number(settings.radiusPixels)) } : {}),
        ...(Number.isFinite(Number(settings.opacity)) ? { opacity: Math.max(0.04, Math.min(1, Number(settings.opacity))) } : {}),
        ...(Number.isFinite(Number(settings.hardness)) ? { hardness: Math.max(0, Math.min(1, Number(settings.hardness))) } : {}),
        ...(Number.isFinite(Number(settings.scatter)) ? { scatter: Math.max(0, Math.min(1, Number(settings.scatter))) } : {})
      };
    },

    texturePaintVisibleRegionTriangles(record, materialIndex, canvas, texture, options = {}) {
      const referenceMapped = options.referenceUv
        ? this.clonePaintTextureUv(options.referenceUv, texture)
        : null;
      const triangles = [];
      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (
          !overlay?.visible
          || overlay.userData?.cloneSpotlightKind !== "target"
          || overlay.userData?.cloneSpotlightRecord !== record
        ) {
          continue;
        }
        const geometry = overlay.geometry;
        const uv = geometry?.attributes?.uv;
        const position = geometry?.attributes?.position;
        if (!uv || !position) {
          continue;
        }
        const triangleCount = Math.floor(position.count / 3);
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          const start = triangle * 3;
          const faceMaterialIndex = this.texturePaintOverlayMaterialIndex?.(geometry, start) ?? 0;
          if (Number.isInteger(materialIndex) && faceMaterialIndex !== materialIndex) {
            continue;
          }
          const pixels = [0, 1, 2].map((offset) => {
            const mapped = this.clonePaintTextureUv(
              new THREE.Vector2(uv.getX(start + offset), uv.getY(start + offset)),
              texture
            );
            if (referenceMapped) {
              mapped.x = this.clonePaintUnwrapTextureCoordinate(mapped.x, referenceMapped.x, texture?.wrapS);
              mapped.y = this.clonePaintUnwrapTextureCoordinate(mapped.y, referenceMapped.y, texture?.wrapT);
            }
            return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, {
              wrap: !referenceMapped
            });
          });
          if (pixels.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
            triangles.push({
              face: { a: start, b: start + 1, c: start + 2, materialIndex: faceMaterialIndex },
              pixels
            });
          }
        }
      }
      return triangles;
    },

    texturePaintVisibleRegionMaterialIndexes(record) {
      const materialIndexes = new Set();
      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (
          !overlay?.visible
          || overlay.userData?.cloneSpotlightKind !== "target"
          || overlay.userData?.cloneSpotlightRecord !== record
        ) {
          continue;
        }
        const geometry = overlay.geometry;
        const position = geometry?.attributes?.position;
        if (!position) {
          continue;
        }
        const triangleCount = Math.floor(position.count / 3);
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          materialIndexes.add(this.texturePaintOverlayMaterialIndex?.(geometry, triangle * 3) ?? 0);
        }
      }
      return [...materialIndexes].sort((left, right) => left - right);
    },

    applyPickedTextureColor(sample) {
      if (!sample) {
        return false;
      }
      if (Number.isFinite(sample.a) && sample.a <= 8) {
        return false;
      }
      const hex = `#${byteHex(sample.r)}${byteHex(sample.g)}${byteHex(sample.b)}`;
      if (this.texturePaintColor) {
        this.texturePaintColor.value = hex;
      }
      this.setStatus(`Picked ${hex}`);
      return true;
    },

    pickTextureColorNear(record, hit) {
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const hitUv = hit?.uv;
      if (!material || !hitUv) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return false;
      }

      const renderedSample = this.pickTextureGpuSampleColor?.(material.map, hitUv);
      if (this.applyPickedTextureColor?.(renderedSample)) {
        return true;
      }

      const gpuSample = this.pickTextureGpuTargetColorNear?.(material, hitUv);
      if (this.applyPickedTextureColor?.(gpuSample)) {
        return true;
      }

      const editable = this.editableClonePaintTexture?.(material);
      if (!editable) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return false;
      }
      const { canvas, context, texture } = editable;
      const pixel = this.clonePaintPixelFromUv(hitUv, canvas, texture);
      const data = context.getImageData(pixel.x, pixel.y, 1, 1).data;
      return this.applyPickedTextureColor?.({ r: data[0], g: data[1], b: data[2], a: data[3] }) || false;
    },

    textureAirbrushRenderTargetPixelFromUv(uv, targetEntry) {
      const texture = targetEntry?.target?.texture;
      const width = Math.max(1, targetEntry?.width || targetEntry?.target?.width || texture?.image?.width || 1);
      const height = Math.max(1, targetEntry?.height || targetEntry?.target?.height || texture?.image?.height || 1);
      const mapped = this.clonePaintTextureUv?.(uv, texture) || uv?.clone?.();
      if (!mapped) {
        return null;
      }
      const u = this.clonePaintWrapUvCoordinate
        ? this.clonePaintWrapUvCoordinate(mapped.x, texture?.wrapS)
        : Math.max(0, Math.min(1, mapped.x));
      const v = this.clonePaintWrapUvCoordinate
        ? this.clonePaintWrapUvCoordinate(mapped.y, texture?.wrapT)
        : Math.max(0, Math.min(1, mapped.y));
      return {
        x: Math.max(0, Math.min(width - 1, Math.round(u * (width - 1)))),
        // WebGL readPixels uses the render target's lower-left origin. Do not apply canvas/image flipY here.
        y: Math.max(0, Math.min(height - 1, Math.round(v * (height - 1)))),
        width,
        height
      };
    },

    pickTextureGpuSampleMaterial() {
      if (!this.texturePickerGpuSampleMaterial) {
        this.texturePickerGpuSampleMaterial = new THREE.ShaderMaterial({
          depthTest: false,
          depthWrite: false,
          uniforms: {
            sourceTexture: { value: null },
            sampleUv: { value: new THREE.Vector2() }
          },
          vertexShader: `
            varying vec2 vUv;

            void main() {
              vUv = uv;
              gl_Position = vec4(position.xy, 0.0, 1.0);
            }
          `,
          fragmentShader: `
            uniform sampler2D sourceTexture;
            uniform vec2 sampleUv;

            void main() {
              gl_FragColor = texture2D(sourceTexture, sampleUv);
            }
          `
        });
      }
      return this.texturePickerGpuSampleMaterial;
    },

    pickTextureGpuSampleTarget() {
      if (this.texturePickerGpuSampleTarget) {
        return this.texturePickerGpuSampleTarget;
      }
      this.texturePickerGpuSampleTarget = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false
      });
      this.texturePickerGpuSampleTarget.texture.name = "texture picker sample";
      return this.texturePickerGpuSampleTarget;
    },

    pickTextureGpuSampleColor(texture, uv) {
      if (!this.renderer || !texture || !uv) {
        return null;
      }
      this.textureAirbrushEnsureCopyScene?.();
      const target = this.pickTextureGpuSampleTarget?.();
      const material = this.pickTextureGpuSampleMaterial?.();
      if (!target || !material || !this.textureAirbrushGpuCopyMesh || !this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera) {
        return null;
      }
      const mapped = this.clonePaintTextureUv?.(uv, texture) || uv.clone?.() || uv;
      const sampleUv = new THREE.Vector2(
        this.clonePaintWrapUvCoordinate
          ? this.clonePaintWrapUvCoordinate(mapped.x, texture.wrapS)
          : Math.max(0, Math.min(1, mapped.x)),
        this.clonePaintWrapUvCoordinate
          ? this.clonePaintWrapUvCoordinate(mapped.y, texture.wrapT)
          : Math.max(0, Math.min(1, mapped.y))
      );
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const previousMaterial = this.textureAirbrushGpuCopyMesh.material;
      const buffer = new Uint8Array(4);
      material.uniforms.sourceTexture.value = texture;
      material.uniforms.sampleUv.value.copy(sampleUv);
      this.textureAirbrushGpuCopyMesh.material = material;
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
      this.renderer.readRenderTargetPixels(target, 0, 0, 1, 1, buffer);
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.textureAirbrushGpuCopyMesh.material = previousMaterial;
      if (texture.colorSpace === THREE.SRGBColorSpace) {
        return {
          r: linearByteToSrgbByte(buffer[0]),
          g: linearByteToSrgbByte(buffer[1]),
          b: linearByteToSrgbByte(buffer[2]),
          a: buffer[3]
        };
      }
      return { r: buffer[0], g: buffer[1], b: buffer[2], a: buffer[3] };
    },

    pickTextureGpuTargetColorNear(material, uv) {
      const entry = material?.userData?.textureAirbrushGpuTarget;
      const target = entry?.target;
      if (!entry || !target || !this.renderer || !uv) {
        return null;
      }
      const directSample = this.pickTextureGpuSampleColor?.(target.texture, uv);
      if (directSample) {
        return directSample;
      }
      const pixel = this.textureAirbrushRenderTargetPixelFromUv?.(uv, entry);
      if (!pixel) {
        return null;
      }
      const width = pixel.width;
      const height = pixel.height;
      const centerX = pixel.x;
      const centerY = pixel.y;
      const buffer = new Uint8Array(4);
      const samples = [];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = Math.max(0, Math.min(width - 1, centerX + dx));
          const y = Math.max(0, Math.min(height - 1, centerY + dy));
          this.renderer.readRenderTargetPixels(target, x, y, 1, 1, buffer);
          samples.push([buffer[0], buffer[1], buffer[2], buffer[3]]);
        }
      }
      const opaqueSamples = samples.filter((sample) => sample[3] > 8);
      const source = opaqueSamples.length ? opaqueSamples : samples;
      if (!source.length) {
        return null;
      }
      const average = source.reduce((sum, sample) => {
        sum.r += sample[0];
        sum.g += sample[1];
        sum.b += sample[2];
        return sum;
      }, { r: 0, g: 0, b: 0 });
      return {
        r: average.r / source.length,
        g: average.g / source.length,
        b: average.b / source.length
      };
    },

    textureAirbrushVisibleRegionFromEvent(record, event, hit, options = {}) {
      const target = this.clonePaintTargets?.get(record);
      if (!record || !target?.vertices?.size || !event || !this.canvas || !this.camera) {
        return null;
      }
      if (!options.materialPass) {
        const materialIndexes = this.texturePaintVisibleRegionMaterialIndexes?.(record) || [];
        if (materialIndexes.length > 1) {
          const hitMaterialIndex = hit?.face?.materialIndex;
          let totalChanged = 0;
          for (const materialIndex of materialIndexes) {
            const passHit = {
              ...hit,
              face: {
                ...(hit?.face || {}),
                materialIndex
              }
            };
            const changed = this.textureAirbrushVisibleRegionFromEvent?.(record, event, passHit, {
              ...options,
              materialPass: true,
              referenceUv: materialIndex === hitMaterialIndex ? hit?.uv || null : null
            }) || 0;
            totalChanged += changed;
          }
          if (totalChanged > 0) {
            this.setStatus(`Soft airbrushed ${totalChanged} ${totalChanged === 1 ? "pixel" : "pixels"}`);
          }
          return totalChanged || null;
        }
      }
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      if (!editable) {
        return null;
      }

      const rect = this.canvas.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const scatter = this.textureAirbrushScatter?.() ?? 0.35;
      const haloRadius = brushRadius * (1 + scatter * 0.72);
      const radiusSq = haloRadius * haloRadius;
      const color = this.textureAirbrushColor();
      const alpha = options.strength ?? this.textureAirbrushStrength?.() ?? 0.26;
      const { canvas, context, texture } = editable;
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const writtenPixels = new Set();
      const referenceUv = Object.prototype.hasOwnProperty.call(options, "referenceUv")
        ? options.referenceUv
        : hit?.uv || target.originUv || target.uvCenter || null;
      const referenceMapped = referenceUv
        ? this.clonePaintTextureUv(referenceUv, texture)
        : null;
      const targetMaterialIndex = hit?.face?.materialIndex
        ?? target.originMaterialIndex
        ?? target.materialIndex
        ?? 0;
      const allowedRegionTriangles = this.texturePaintVisibleRegionTriangles?.(
        record,
        targetMaterialIndex,
        canvas,
        texture,
        { referenceUv }
      ) || [];
      const textureKernelRadius = Math.max(
        2,
        Math.min(
          4,
          Math.round(this.textureBrushRadiusValue() * Math.max(canvas.width, canvas.height) * 0.018)
        )
      );
      const artifactScreenRadius = brushRadius * 2.85;
      const artifactRadiusSq = artifactScreenRadius * artifactScreenRadius;
      let changed = 0;

      const paintTexturePoint = (texturePoint, paintOptions = {}) => {
        if (!texturePoint) {
          return;
        }
        for (let dy = -textureKernelRadius; dy <= textureKernelRadius; dy += 1) {
          for (let dx = -textureKernelRadius; dx <= textureKernelRadius; dx += 1) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > textureKernelRadius) {
              continue;
            }
            const candidate = {
              x: texturePoint.x + dx,
              y: texturePoint.y + dy
            };
            if (
              allowedRegionTriangles.length
              && !this.clonePaintPointInsideTextureTriangles?.(candidate, allowedRegionTriangles, 0.025)
            ) {
              continue;
            }
            const actualPixel = this.clonePaintActualPixelFromTexturePoint?.(candidate, canvas, texture);
            if (!actualPixel) {
              continue;
            }
            const key = `${actualPixel.x}:${actualPixel.y}`;
            if (writtenPixels.has(key) && !paintOptions.allowRepaint) {
              continue;
            }
            const falloff = 1 - distance / Math.max(1, textureKernelRadius);
            const softFalloff = Math.pow(Math.max(0, falloff), 1.85);
            const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
            if (paintOptions.brightOnly && !isBrightArtifactPixel(image.data, offset)) {
              continue;
            }
            writtenPixels.add(key);
            const baseAlpha = paintOptions.forceAlpha
              ?? Math.min(0.42, alpha * (0.06 + softFalloff * 0.72));
            const pixelAlpha = paintOptions.forceAlpha
              ?? artifactTintAlpha(image.data, offset, baseAlpha, softFalloff);
            if (pixelAlpha <= 0.012) {
              continue;
            }
            const nextR = clampByte(image.data[offset] * (1 - pixelAlpha) + color.r * pixelAlpha);
            const nextG = clampByte(image.data[offset + 1] * (1 - pixelAlpha) + color.g * pixelAlpha);
            const nextB = clampByte(image.data[offset + 2] * (1 - pixelAlpha) + color.b * pixelAlpha);
            const nextA = Math.max(image.data[offset + 3], 255);
            if (
              image.data[offset] === nextR
              && image.data[offset + 1] === nextG
              && image.data[offset + 2] === nextB
              && image.data[offset + 3] === nextA
            ) {
              continue;
            }
            image.data[offset] = nextR;
            image.data[offset + 1] = nextG;
            image.data[offset + 2] = nextB;
            image.data[offset + 3] = nextA;
            changed += 1;
          }
        }
      };

      const texturePixelForUv = (uvPoint) => {
        const mapped = this.clonePaintTextureUv(uvPoint, texture);
        if (referenceMapped) {
          mapped.x = this.clonePaintUnwrapTextureCoordinate(mapped.x, referenceMapped.x, texture?.wrapS);
          mapped.y = this.clonePaintUnwrapTextureCoordinate(mapped.y, referenceMapped.y, texture?.wrapT);
        }
        return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, {
          wrap: !referenceMapped
        });
      };

      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (
          !overlay?.visible
          || overlay.userData?.cloneSpotlightKind !== "target"
          || overlay.userData?.cloneSpotlightRecord !== record
        ) {
          continue;
        }
        const geometry = overlay.geometry;
        const position = geometry?.attributes?.position;
        const uv = geometry?.attributes?.uv;
        if (!position || !uv) {
          continue;
        }
        overlay.updateMatrixWorld(true);
        const triangleCount = Math.floor(position.count / 3);
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          const start = triangle * 3;
          const screenPoints = [];
          const uvPoints = [];
          let clipped = false;
          for (let offset = 0; offset < 3; offset += 1) {
            const vertexIndex = start + offset;
            const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
            this.applyBoneTransform?.(overlay, vertexIndex, local);
            overlay.localToWorld(local);
            const projected = local.project(this.camera);
            if (projected.z < -1 || projected.z > 1) {
              clipped = true;
              break;
            }
            screenPoints.push({
              x: (projected.x * 0.5 + 0.5) * rect.width,
              y: (-projected.y * 0.5 + 0.5) * rect.height
            });
            uvPoints.push(new THREE.Vector2(
              uv.getX(vertexIndex),
              uv.getY(vertexIndex)
            ));
          }
          if (clipped) {
            continue;
          }
          const closest = this.texturePaintClosestTrianglePoint?.(pointer, screenPoints);
          if (!closest || closest.distanceSq > radiusSq) {
            continue;
          }
          const triangleMinX = Math.min(...screenPoints.map((point) => point.x));
          const triangleMaxX = Math.max(...screenPoints.map((point) => point.x));
          const triangleMinY = Math.min(...screenPoints.map((point) => point.y));
          const triangleMaxY = Math.max(...screenPoints.map((point) => point.y));
          const minX = Math.max(0, Math.floor(Math.max(pointer.x - brushRadius, triangleMinX)));
          const maxX = Math.min(rect.width - 1, Math.ceil(Math.min(pointer.x + brushRadius, triangleMaxX)));
          const minY = Math.max(0, Math.floor(Math.max(pointer.y - brushRadius, triangleMinY)));
          const maxY = Math.min(rect.height - 1, Math.ceil(Math.min(pointer.y + brushRadius, triangleMaxY)));
          for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
              const dx = x - pointer.x;
              const dy = y - pointer.y;
              if (dx * dx + dy * dy > radiusSq) {
                continue;
              }
              const screenPoint = { x, y };
              const barycentric = this.clonePaintBarycentric(screenPoint, screenPoints);
              if (!this.clonePaintBarycentricInside(barycentric, 0.02)) {
                continue;
              }
              const paintUv = new THREE.Vector2(
                uvPoints[0].x * barycentric.u + uvPoints[1].x * barycentric.v + uvPoints[2].x * barycentric.w,
                uvPoints[0].y * barycentric.u + uvPoints[1].y * barycentric.v + uvPoints[2].y * barycentric.w
              );
              paintTexturePoint(texturePixelForUv(paintUv));
            }
          }

          const artifactMinX = Math.max(0, Math.floor(Math.max(pointer.x - artifactScreenRadius, triangleMinX)));
          const artifactMaxX = Math.min(rect.width - 1, Math.ceil(Math.min(pointer.x + artifactScreenRadius, triangleMaxX)));
          const artifactMinY = Math.max(0, Math.floor(Math.max(pointer.y - artifactScreenRadius, triangleMinY)));
          const artifactMaxY = Math.min(rect.height - 1, Math.ceil(Math.min(pointer.y + artifactScreenRadius, triangleMaxY)));
          for (let y = artifactMinY; y <= artifactMaxY; y += 4) {
            for (let x = artifactMinX; x <= artifactMaxX; x += 4) {
              const dx = x - pointer.x;
              const dy = y - pointer.y;
              if (dx * dx + dy * dy > artifactRadiusSq) {
                continue;
              }
              const screenPoint = { x, y };
              const barycentric = this.clonePaintBarycentric(screenPoint, screenPoints);
              if (!this.clonePaintBarycentricInside(barycentric, 0.015)) {
                continue;
              }
              const paintUv = new THREE.Vector2(
                uvPoints[0].x * barycentric.u + uvPoints[1].x * barycentric.v + uvPoints[2].x * barycentric.w,
                uvPoints[0].y * barycentric.u + uvPoints[1].y * barycentric.v + uvPoints[2].y * barycentric.w
              );
              paintTexturePoint(texturePixelForUv(paintUv), {
                allowRepaint: true,
                brightOnly: true,
                forceAlpha: 0.96
              });
            }
          }

          const texturePoints = uvPoints.map(texturePixelForUv);
          if (texturePoints.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
            const minTx = Math.floor(Math.min(...texturePoints.map((point) => point.x)));
            const maxTx = Math.ceil(Math.max(...texturePoints.map((point) => point.x)));
            const minTy = Math.floor(Math.min(...texturePoints.map((point) => point.y)));
            const maxTy = Math.ceil(Math.max(...texturePoints.map((point) => point.y)));
            const textureArea = Math.max(0, maxTx - minTx + 1) * Math.max(0, maxTy - minTy + 1);
            const maxTextureSamples = 2200;
            const textureStep = Math.max(2, Math.ceil(Math.sqrt(textureArea / maxTextureSamples)));
            for (let ty = minTy; ty <= maxTy; ty += textureStep) {
              for (let tx = minTx; tx <= maxTx; tx += textureStep) {
                const texturePoint = { x: tx, y: ty };
                const barycentric = this.clonePaintBarycentric(texturePoint, texturePoints);
                if (!this.clonePaintBarycentricInside(barycentric, 0.015)) {
                  continue;
                }
                const sx = (
                  screenPoints[0].x * barycentric.u
                  + screenPoints[1].x * barycentric.v
                  + screenPoints[2].x * barycentric.w
                );
                const sy = (
                  screenPoints[0].y * barycentric.u
                  + screenPoints[1].y * barycentric.v
                  + screenPoints[2].y * barycentric.w
                );
                const dx = sx - pointer.x;
                const dy = sy - pointer.y;
                if (dx * dx + dy * dy > radiusSq) {
                  continue;
                }
                paintTexturePoint(texturePoint);
              }
            }
          }
        }
      }

      if (!changed) {
        return null;
      }
      context.putImageData(image, 0, 0);
      texture.needsUpdate = true;
      material.needsUpdate = true;
      this.markTexturePaintStrokeChanged?.();
      this.refreshCloneSpotlightTextures?.(record);
      this.updateClonePaintPreviews?.();
      this.setStatus(`Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      return changed;
    },

    textureAirbrushMeshUnderPointer(event, options = {}) {
      if (!event || !this.canvas || !this.camera) {
        return 0;
      }
      if (this.clonePaintTargets?.size) {
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds?.();
      const paintObjects = (this.paintRecords || []).map((record) => record.object);
      const intersections = this.raycaster.intersectObjects(paintObjects, false);
      let changed = 0;
      let paintedHits = 0;
      const paintedFaces = new Set();
      for (const hit of intersections) {
        const record = this.paintRecords.find((item) => item.object === hit.object);
        if (!record) {
          continue;
        }
        const recordIndex = this.paintRecords.indexOf(record);
        const face = hit.face || {};
        const faceKey = `${recordIndex}:${face.a ?? "a"}:${face.b ?? "b"}:${face.c ?? "c"}:${face.materialIndex ?? 0}`;
        if (paintedFaces.has(faceKey)) {
          continue;
        }
        paintedFaces.add(faceKey);
        changed += this.textureAirbrushNear(record, hit, {
          ...options,
          event: null,
          meshFallback: true
        }) || 0;
        paintedHits += 1;
        if (paintedHits >= 12) {
          break;
        }
      }
      return changed;
    },

    textureAirbrushRegionPixelFromUv(uv, canvas, texture, referenceUv = null) {
      if (!uv) {
        return null;
      }
      const mapped = this.clonePaintTextureUv(uv, texture);
      if (referenceUv) {
        const referenceMapped = this.clonePaintTextureUv(referenceUv, texture);
        mapped.x = this.clonePaintUnwrapTextureCoordinate(mapped.x, referenceMapped.x, texture?.wrapS);
        mapped.y = this.clonePaintUnwrapTextureCoordinate(mapped.y, referenceMapped.y, texture?.wrapT);
        return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, { wrap: false });
      }
      return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture);
    },

    textureAirbrushUvBrushOnFace(record, hit, event, options = {}) {
      const face = hit?.face;
      if (!record || !face || !event || !this.canvas || !this.camera) {
        return 0;
      }
      const position = record.geometry.attributes.position;
      const uvAttribute = record.geometry.attributes.uv;
      if (!position || !uvAttribute) {
        return 0;
      }
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      if (!material || !editable) {
        return 0;
      }

      const rect = this.canvas.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const radiusSq = brushRadius * brushRadius;
      const target = options.target || null;
      const referenceUv = options.referenceUv || target?.originUv || target?.uvCenter || hit.uv || face.centerUv || null;
      const { canvas, context, texture } = editable;
      const materialIndex = face.materialIndex ?? target?.originMaterialIndex ?? target?.materialIndex ?? 0;

      const vertexIndices = face.vertices || [face.a, face.b, face.c];
      if (vertexIndices.length !== 3) {
        return 0;
      }

      this.model?.updateMatrixWorld?.(true);
      record.object.updateMatrixWorld(true);

      const screenPoints = [];
      const texturePoints = [];
      for (const vertexIndex of vertexIndices) {
        if (!Number.isInteger(vertexIndex) || record.deleted?.has(vertexIndex)) {
          return 0;
        }
        const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform?.(record.object, vertexIndex, local);
        record.object.localToWorld(local);
        const projected = local.project(this.camera);
        if (projected.z < -1 || projected.z > 1) {
          return 0;
        }
        screenPoints.push({
          x: (projected.x * 0.5 + 0.5) * rect.width,
          y: (-projected.y * 0.5 + 0.5) * rect.height
        });
        const uv = new THREE.Vector2(
          uvAttribute.getX(vertexIndex),
          uvAttribute.getY(vertexIndex)
        );
        texturePoints.push(this.textureAirbrushRegionPixelFromUv(
          uv,
          canvas,
          texture,
          referenceUv
        ));
      }
      if (texturePoints.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        return 0;
      }

      const closest = this.texturePaintClosestTrianglePoint?.(pointer, screenPoints);
      if (!closest || closest.distanceSq > radiusSq) {
        return 0;
      }

      const textureToScreen = this.clonePaintTriangleTransform?.(texturePoints, screenPoints);
      if (!textureToScreen) {
        return 0;
      }
      const screenToTexture = this.clonePaintTriangleTransform?.(screenPoints, texturePoints);
      const center = hit.uv
        ? this.textureAirbrushRegionPixelFromUv(hit.uv, canvas, texture, referenceUv)
        : this.clonePaintTransformPoint?.(
          screenToTexture,
          pointer
        );
      if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
        return 0;
      }

      const regionTriangles = options.regionTriangles || (
        target?.vertices?.size
          ? this.clonePaintRegionTextureTriangles?.(
            record,
            target,
            materialIndex,
            canvas,
            texture,
            { referenceUv }
          ) || []
          : null
      );
      if (target?.vertices?.size && !regionTriangles?.length) {
        return 0;
      }

      const textureBoundsSamples = screenToTexture
        ? [
          pointer,
          { x: pointer.x - brushRadius, y: pointer.y },
          { x: pointer.x + brushRadius, y: pointer.y },
          { x: pointer.x, y: pointer.y - brushRadius },
          { x: pointer.x, y: pointer.y + brushRadius },
          { x: pointer.x - brushRadius * 0.707, y: pointer.y - brushRadius * 0.707 },
          { x: pointer.x + brushRadius * 0.707, y: pointer.y - brushRadius * 0.707 },
          { x: pointer.x - brushRadius * 0.707, y: pointer.y + brushRadius * 0.707 },
          { x: pointer.x + brushRadius * 0.707, y: pointer.y + brushRadius * 0.707 }
        ]
          .map((point) => this.clonePaintTransformPoint?.(screenToTexture, point))
          .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        : [center];
      if (!textureBoundsSamples.length) {
        return 0;
      }
      const maxTextureRadius = Math.max(24, Math.min(768, Math.max(canvas.width, canvas.height) * 0.5));
      const rawMinX = Math.min(...textureBoundsSamples.map((point) => point.x));
      const rawMaxX = Math.max(...textureBoundsSamples.map((point) => point.x));
      const rawMinY = Math.min(...textureBoundsSamples.map((point) => point.y));
      const rawMaxY = Math.max(...textureBoundsSamples.map((point) => point.y));
      const minX = Math.floor(Math.max(center.x - maxTextureRadius, rawMinX - 3));
      const maxX = Math.ceil(Math.min(center.x + maxTextureRadius, rawMaxX + 3));
      const minY = Math.floor(Math.max(center.y - maxTextureRadius, rawMinY - 3));
      const maxY = Math.ceil(Math.min(center.y + maxTextureRadius, rawMaxY + 3));
      const color = this.textureAirbrushColor();
      const strength = options.strength ?? 1;
      const opacity = options.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42;
      const hardness = options.hardness ?? this.textureAirbrushHardness?.() ?? 0.35;
      const image = options.paintState?.image || context.getImageData(0, 0, canvas.width, canvas.height);
      const written = options.paintState?.written || new Set();
      let changed = 0;

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const texturePoint = { x, y };
          const screenPoint = this.clonePaintTransformPoint?.(textureToScreen, texturePoint);
          if (!screenPoint) {
            continue;
          }
          const dx = screenPoint.x - pointer.x;
          const dy = screenPoint.y - pointer.y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > radiusSq) {
            continue;
          }
          const faceBarycentric = this.clonePaintBarycentric(texturePoint, texturePoints);
          if (!this.clonePaintBarycentricInside(faceBarycentric, 0.025)) {
            continue;
          }
          if (
            regionTriangles
            && !this.clonePaintPointInsideTextureTriangles?.(texturePoint, regionTriangles, 0.035)
          ) {
            continue;
          }
          const actualPixel = this.clonePaintActualPixelFromTexturePoint?.(texturePoint, canvas, texture);
          if (!actualPixel) {
            continue;
          }
          const key = `${actualPixel.x}:${actualPixel.y}`;
          if (written.has(key)) {
            continue;
          }
          written.add(key);
          const distance = Math.sqrt(distanceSq);
          const coverage = airbrushCoverageForDistance(distance, brushRadius, scatter, hardness);
          const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
          const brightArtifact = isBrightArtifactPixel(image.data, offset);
          const alpha = brightArtifact
            ? Math.min(1, Math.max(0.32, opacity * strength * Math.min(1, coverage + 0.28)))
            : Math.min(1, opacity * strength * coverage);
          if (alpha <= 0.008) {
            continue;
          }
          const nextR = clampByte(image.data[offset] * (1 - alpha) + color.r * alpha);
          const nextG = clampByte(image.data[offset + 1] * (1 - alpha) + color.g * alpha);
          const nextB = clampByte(image.data[offset + 2] * (1 - alpha) + color.b * alpha);
          const nextA = Math.max(image.data[offset + 3], 255);
          if (
            image.data[offset] === nextR
            && image.data[offset + 1] === nextG
            && image.data[offset + 2] === nextB
            && image.data[offset + 3] === nextA
          ) {
            continue;
          }
          image.data[offset] = nextR;
          image.data[offset + 1] = nextG;
          image.data[offset + 2] = nextB;
          image.data[offset + 3] = nextA;
          changed += 1;
        }
      }

      if (!changed) {
        return 0;
      }
      if (options.paintState) {
        options.paintState.changed = (options.paintState.changed || 0) + changed;
      }
      if (!options.deferCommit) {
        context.putImageData(image, 0, 0);
        texture.needsUpdate = true;
        material.needsUpdate = true;
        this.refreshCloneSpotlightTextures?.(record);
        this.updateClonePaintPreviews?.();
        if (options.status !== false) {
          this.setStatus(`Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
        }
      }
      return changed;
    },

    textureAirbrushProjectedRegionFromEvent(record, event, hit, options = {}) {
      const target = record ? this.clonePaintTargets?.get(record) : null;
      if (!record || !target?.vertices?.size || !event || !this.canvas || !this.camera) {
        return 0;
      }
      const changed = this.textureAirbrushBrightMeshUnderRegionPointer?.(event, options) || 0;
      if (changed > 0) {
        this.setStatus(`Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
        return changed;
      }
      this.setStatus("Airbrush needs a visible Region surface");
      return 0;
    },

    textureAirbrushBrushShaderMaterial() {
      if (this.textureAirbrushGpuMaterial) {
        return this.textureAirbrushGpuMaterial;
      }
      this.textureAirbrushGpuMaterial = new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NormalBlending,
        uniforms: {
          paintViewMatrix: { value: new THREE.Matrix4() },
          paintProjectionMatrix: { value: new THREE.Matrix4() },
          depthTexture: { value: null },
          brushCenter: { value: new THREE.Vector2() },
          brushStart: { value: new THREE.Vector2() },
          strokeStarts: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => new THREE.Vector2()) },
          strokeEnds: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => new THREE.Vector2()) },
          strokeSegmentCount: { value: 1 },
          viewportSize: { value: new THREE.Vector2(1, 1) },
          uvOffset: { value: new THREE.Vector2() },
          paintColor: { value: new THREE.Color(1, 1, 1) },
          radiusPixels: { value: 8 },
          strength: { value: 0.35 },
          brushOpacity: { value: 0.42 },
          brushHardness: { value: 0.35 },
          scatterAmount: { value: 0.35 },
          depthEpsilon: { value: 0.006 }
        },
        vertexShader: `
          #include <common>
          #include <uv_pars_vertex>
          #include <skinning_pars_vertex>
          uniform mat4 paintViewMatrix;
          uniform mat4 paintProjectionMatrix;
          uniform vec2 uvOffset;
          varying vec2 vPaintUv;
          varying vec4 vPaintClip;

          void main() {
            vPaintUv = uv;
            vec3 transformed = position;
            #include <skinbase_vertex>
            #include <skinning_vertex>
            vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
            vPaintClip = paintProjectionMatrix * paintViewMatrix * worldPosition;
            vec2 targetUv = uv + uvOffset;
            gl_Position = vec4(targetUv.x * 2.0 - 1.0, targetUv.y * 2.0 - 1.0, 0.0, 1.0);
          }
        `,
        fragmentShader: `
          #include <common>
          #define MAX_STROKE_SEGMENTS ${TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS}
          uniform sampler2D depthTexture;
          uniform vec2 brushCenter;
          uniform vec2 brushStart;
          uniform vec2 strokeStarts[MAX_STROKE_SEGMENTS];
          uniform vec2 strokeEnds[MAX_STROKE_SEGMENTS];
          uniform int strokeSegmentCount;
          uniform vec2 viewportSize;
          uniform vec3 paintColor;
          uniform float radiusPixels;
          uniform float strength;
          uniform float brushOpacity;
          uniform float brushHardness;
          uniform float scatterAmount;
          uniform float depthEpsilon;
          varying vec2 vPaintUv;
          varying vec4 vPaintClip;

          void main() {
            if (vPaintClip.w <= 0.0) {
              discard;
            }
            vec3 ndc = vPaintClip.xyz / vPaintClip.w;
            if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
              discard;
            }
            vec2 depthUv = ndc.xy * 0.5 + 0.5;
            float sceneDepth = texture2D(depthTexture, depthUv).r;
            float fragmentDepth = ndc.z * 0.5 + 0.5;
            if (sceneDepth < 0.9999 && fragmentDepth > sceneDepth + depthEpsilon) {
              discard;
            }
            vec2 screenPoint = vec2(
              (ndc.x * 0.5 + 0.5) * viewportSize.x,
              (-ndc.y * 0.5 + 0.5) * viewportSize.y
            );
            float scatter = clamp(scatterAmount, 0.0, 1.0);
            float haloRadius = radiusPixels * (1.0 + scatter * 0.72);
            float distancePixels = 100000.0;
            for (int strokeIndex = 0; strokeIndex < MAX_STROKE_SEGMENTS; strokeIndex++) {
              if (strokeIndex >= strokeSegmentCount) {
                break;
              }
              vec2 segmentStart = strokeStarts[strokeIndex];
              vec2 segmentEnd = strokeEnds[strokeIndex];
              vec2 brushSegment = segmentEnd - segmentStart;
              float segmentLengthSq = dot(brushSegment, brushSegment);
              float segmentAlpha = segmentLengthSq > 0.0001
                ? clamp(dot(screenPoint - segmentStart, brushSegment) / segmentLengthSq, 0.0, 1.0)
                : 1.0;
              vec2 closestPoint = segmentStart + brushSegment * segmentAlpha;
              distancePixels = min(distancePixels, distance(screenPoint, closestPoint));
            }
            if (distancePixels > haloRadius) {
              discard;
            }
            float hardness = clamp(brushHardness, 0.0, 1.0);
            float hardRadius = radiusPixels * hardness;
            float coverage = 1.0;
            if (distancePixels > hardRadius) {
              float fadeRadius = max(1.0, haloRadius - hardRadius);
              float edge = max(0.0, 1.0 - (distancePixels - hardRadius) / fadeRadius);
              float exponent = 3.6 - hardness * 2.55 + scatter * 0.25;
              coverage = min(1.0, pow(edge, exponent));
            }
            float alpha = min(1.0, brushOpacity * strength * coverage);
            if (alpha <= 0.004) {
              discard;
            }
            gl_FragColor = vec4(paintColor, alpha);
          }
        `
      });
      return this.textureAirbrushGpuMaterial;
    },

    textureAirbrushNoopMaterial() {
      if (!this.textureAirbrushGpuNoopMaterial) {
        this.textureAirbrushGpuNoopMaterial = new THREE.ShaderMaterial({
          transparent: true,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          vertexShader: `
            void main() {
              gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
            }
          `,
          fragmentShader: `
            void main() {
              discard;
            }
          `
        });
      }
      return this.textureAirbrushGpuNoopMaterial;
    },

    textureAirbrushCopyMaterial(sourceTexture) {
      if (!this.textureAirbrushGpuCopyMaterial) {
        this.textureAirbrushGpuCopyMaterial = new THREE.MeshBasicMaterial({
          depthTest: false,
          depthWrite: false
        });
      }
      this.textureAirbrushGpuCopyMaterial.map = sourceTexture;
      this.textureAirbrushGpuCopyMaterial.needsUpdate = true;
      return this.textureAirbrushGpuCopyMaterial;
    },

    textureAirbrushRenderTextureSettings(sourceTexture) {
      const minFilter = sourceTexture?.minFilter || THREE.LinearFilter;
      const usesMipmaps = MIPMAP_FILTERS.has(minFilter);
      return {
        minFilter,
        magFilter: sourceTexture?.magFilter || THREE.LinearFilter,
        wrapS: sourceTexture?.wrapS || THREE.ClampToEdgeWrapping,
        wrapT: sourceTexture?.wrapT || THREE.ClampToEdgeWrapping,
        generateMipmaps: sourceTexture?.generateMipmaps !== false && usesMipmaps
      };
    },

    textureAirbrushCopyTextureRenderSettings(destinationTexture, sourceTexture) {
      if (!destinationTexture || !sourceTexture) {
        return false;
      }
      const settings = this.textureAirbrushRenderTextureSettings(sourceTexture);
      destinationTexture.colorSpace = sourceTexture.colorSpace;
      destinationTexture.flipY = sourceTexture.flipY;
      destinationTexture.minFilter = settings.minFilter;
      destinationTexture.magFilter = settings.magFilter;
      destinationTexture.wrapS = settings.wrapS;
      destinationTexture.wrapT = settings.wrapT;
      destinationTexture.generateMipmaps = settings.generateMipmaps;
      destinationTexture.anisotropy = sourceTexture.anisotropy || 1;
      destinationTexture.offset?.copy?.(sourceTexture.offset);
      destinationTexture.repeat?.copy?.(sourceTexture.repeat);
      destinationTexture.center?.copy?.(sourceTexture.center);
      destinationTexture.rotation = sourceTexture.rotation || 0;
      destinationTexture.matrixAutoUpdate = sourceTexture.matrixAutoUpdate !== false;
      if (destinationTexture.matrix && sourceTexture.matrix) {
        destinationTexture.matrix.copy(sourceTexture.matrix);
      }
      if (!destinationTexture.isRenderTargetTexture) {
        destinationTexture.needsUpdate = true;
      }
      return true;
    },

    textureAirbrushWithRawTextureMatrix(sourceTexture, callback) {
      if (!sourceTexture?.matrix || typeof callback !== "function") {
        return callback?.();
      }
      const previousMatrixAutoUpdate = sourceTexture.matrixAutoUpdate;
      const previousMatrix = sourceTexture.matrix.clone();
      sourceTexture.matrixAutoUpdate = false;
      sourceTexture.matrix.identity();
      try {
        return callback();
      } finally {
        sourceTexture.matrix.copy(previousMatrix);
        sourceTexture.matrixAutoUpdate = previousMatrixAutoUpdate;
      }
    },

    textureAirbrushCopyTextureToTarget(sourceTexture, destinationTarget) {
      if (!this.renderer || !sourceTexture || !destinationTarget) {
        return false;
      }
      this.textureAirbrushEnsureCopyScene?.();
      if (!this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera || !this.textureAirbrushGpuCopyMesh) {
        return false;
      }
      this.textureAirbrushCopyTextureRenderSettings?.(destinationTarget.texture, sourceTexture);
      if (sourceTexture.isRenderTargetTexture && typeof this.renderer.copyTextureToTexture === "function") {
        try {
          this.renderer.initRenderTarget?.(destinationTarget);
          this.renderer.copyTextureToTexture(sourceTexture, destinationTarget.texture);
          return true;
        } catch (error) {
          console.warn("Texture airbrush direct render-target copy failed; using shader copy", error);
        }
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      this.textureAirbrushGpuCopyMesh.material = this.textureAirbrushCopyMaterial(sourceTexture);
      this.textureAirbrushWithRawTextureMatrix(sourceTexture, () => {
        this.renderer.setRenderTarget(destinationTarget);
        this.renderer.autoClear = true;
        this.renderer.clear(true, true, true);
        this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
      });
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      return true;
    },

    textureAirbrushRenderTargetSizeForTexture(texture) {
      const image = texture?.image;
      const width = image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width || 0;
      const height = image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height || 0;
      return {
        width: Math.max(1, Math.min(4096, Math.round(width || 1024))),
        height: Math.max(1, Math.min(4096, Math.round(height || 1024)))
      };
    },

    textureAirbrushGpuUvBleedOffsets(targetEntry, radiusPixels = this.textureBrushRadiusScreenPixels?.() || 8) {
      const width = Math.max(1, targetEntry?.width || targetEntry?.target?.width || 1);
      const height = Math.max(1, targetEntry?.height || targetEntry?.target?.height || 1);
      const stepX = 1 / width;
      const stepY = 1 / height;
      const radius = Math.max(1, Number(radiusPixels) || 1);
      let offsets = [[0, 0]];
      if (radius > 16) {
        offsets = [
          [0, 0],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
          [-2, 0],
          [2, 0],
          [0, -2],
          [0, 2]
        ];
      } else if (radius > 9) {
        offsets = [
          [0, 0],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ];
      }
      return offsets.map(([x, y]) => new THREE.Vector2(x * stepX, y * stepY));
    },

    scheduleTextureAirbrushPrewarm(event = null, hit = null) {
      if (this.textureAirbrushPrewarmPending || this.activeTool !== "airbrush") {
        return false;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (this.textureAirbrushLastPrewarmAt && now - this.textureAirbrushLastPrewarmAt < 180) {
        return false;
      }
      this.textureAirbrushPendingPrewarmEvent = event
        ? { clientX: event.clientX, clientY: event.clientY }
        : this.textureAirbrushPendingPrewarmEvent || null;
      this.textureAirbrushPendingPrewarmHit = hit || this.textureAirbrushPendingPrewarmHit || null;
      this.textureAirbrushPrewarmPending = true;
      const run = () => {
        this.textureAirbrushPrewarmPending = false;
        this.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const pendingEvent = this.textureAirbrushPendingPrewarmEvent;
        const pendingHit = this.textureAirbrushPendingPrewarmHit;
        this.textureAirbrushPendingPrewarmEvent = null;
        this.textureAirbrushPendingPrewarmHit = null;
        this.textureAirbrushPrewarm?.(pendingEvent, pendingHit);
      };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 450 });
      } else {
        window.setTimeout(run, 80);
      }
      return true;
    },

    textureAirbrushPrewarm(event = null, hit = null) {
      if (!this.renderer || !this.model || this.activeTool !== "airbrush") {
        return false;
      }
      this.textureAirbrushBrushShaderMaterial?.();
      this.textureAirbrushEnsureCopyScene?.();
      this.textureAirbrushRenderDepthTarget?.();
      const paintHit = hit || (event ? this.texturePaintHitForEvent?.(event, "airbrush") : null);
      const record = paintHit?.record;
      const materialIndex = paintHit?.hit?.face?.materialIndex ?? 0;
      const material = record ? this.clonePaintMaterialForHit?.(record, paintHit.hit) : null;
      if (record && material) {
        const targetEntry = this.textureAirbrushGpuTargetForMaterial?.(material);
        if (targetEntry) {
          this.textureAirbrushGpuProxyForRecord?.(record, materialIndex, material);
        }
      }
      return true;
    },

    textureAirbrushEnsureCopyScene() {
      if (this.textureAirbrushGpuCopyScene) {
        return;
      }
      this.textureAirbrushGpuCopyScene = new THREE.Scene();
      this.textureAirbrushGpuCopyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.textureAirbrushGpuCopyCamera.position.z = 1;
      this.textureAirbrushGpuCopyMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial()
      );
      this.textureAirbrushGpuCopyMesh.frustumCulled = false;
      this.textureAirbrushGpuCopyScene.add(this.textureAirbrushGpuCopyMesh);
    },

    textureAirbrushEnsureDepthTarget() {
      if (!this.renderer || !this.canvas) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const pixelRatio = this.renderer.getPixelRatio?.() || 1;
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));
      const existing = this.textureAirbrushGpuDepthTarget;
      if (existing?.width === width && existing?.height === height) {
        return existing;
      }
      existing?.dispose?.();
      this.textureAirbrushDepthTargetKey = "";
      const target = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false
      });
      target.texture.name = "texture airbrush screen color";
      target.depthTexture = new THREE.DepthTexture(width, height);
      target.depthTexture.name = "texture airbrush screen depth";
      target.depthTexture.format = THREE.DepthFormat;
      target.depthTexture.type = THREE.UnsignedShortType;
      this.textureAirbrushGpuDepthTarget = target;
      return target;
    },

    textureAirbrushDepthCacheKey(rect = this.canvas?.getBoundingClientRect?.()) {
      if (!rect || !this.camera || !this.renderer) {
        return "";
      }
      const pixelRatio = this.renderer.getPixelRatio?.() || 1;
      const matrixKey = [
        ...this.camera.matrixWorldInverse.elements,
        ...this.camera.projectionMatrix.elements
      ].map((value) => Number(value).toFixed(4)).join(",");
      return [
        Math.round(rect.width * pixelRatio),
        Math.round(rect.height * pixelRatio),
        Number(this.progress || 0).toFixed(5),
        matrixKey
      ].join(":");
    },

    textureAirbrushRenderDepthTarget(options = {}) {
      const depthTarget = this.textureAirbrushEnsureDepthTarget();
      if (!depthTarget || !this.renderer || !this.scene || !this.camera) {
        return null;
      }
      const key = this.textureAirbrushDepthCacheKey();
      if (options.reuse !== false && key && this.textureAirbrushDepthTargetKey === key) {
        return depthTarget;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      this.renderer.setRenderTarget(depthTarget);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.textureAirbrushDepthTargetKey = key;
      return depthTarget;
    },

    textureAirbrushGpuTargetForMaterial(material) {
      if (!material) {
        return null;
      }
      const existing = material.userData?.textureAirbrushGpuTarget;
      if (existing?.target?.texture && material.map === existing.target.texture) {
        return existing;
      }
      const editable = this.editableClonePaintTexture?.(material);
      const sourceTexture = editable?.texture || material.map;
      if (!sourceTexture) {
        return null;
      }
      if (existing?.texture === sourceTexture || existing?.target?.texture === sourceTexture) {
        return existing;
      }
      const baseTexture = existing?.target?.texture === sourceTexture
        ? existing.sourceTexture
        : sourceTexture;
      const size = this.textureAirbrushRenderTargetSizeForTexture(baseTexture);
      const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
      const target = new THREE.WebGLRenderTarget(size.width, size.height, {
        minFilter: settings.minFilter,
        magFilter: settings.magFilter,
        wrapS: settings.wrapS,
        wrapT: settings.wrapT,
        depthBuffer: false,
        stencilBuffer: false
      });
      target.texture.name = `${baseTexture.name || "texture"} airbrush paint`;
      this.textureAirbrushCopyTextureRenderSettings(target.texture, baseTexture);

      if (!this.textureAirbrushCopyTextureToTarget(baseTexture, target)) {
        target.dispose?.();
        return null;
      }

      const entry = {
        sourceTexture: baseTexture,
        target,
        width: size.width,
        height: size.height
      };
      material.map = target.texture;
      material.needsUpdate = true;
      material.userData.textureAirbrushGpuTarget = entry;
      return entry;
    },

    textureAirbrushGpuProxyForRecord(record, materialIndex, material) {
      const key = `${record.geometry?.uuid || "geometry"}:${materialIndex}`;
      this.textureAirbrushGpuProxies ||= new Map();
      let entry = this.textureAirbrushGpuProxies.get(key);
      const shaderMaterial = this.textureAirbrushBrushShaderMaterial();
      const sourceMaterials = Array.isArray(record.object.material)
        ? record.object.material
        : [record.object.material];
      const paintMaterials = sourceMaterials.map((_, index) => (
        index === materialIndex ? shaderMaterial : this.textureAirbrushNoopMaterial()
      ));
      if (!entry) {
        const proxy = record.object.isSkinnedMesh
          ? new THREE.SkinnedMesh(record.geometry, paintMaterials)
          : new THREE.Mesh(record.geometry, paintMaterials);
        proxy.frustumCulled = false;
        proxy.matrixAutoUpdate = false;
        if (proxy.isSkinnedMesh && record.object.skeleton) {
          proxy.bind(record.object.skeleton, record.object.bindMatrix);
          proxy.bindMatrixInverse.copy(record.object.bindMatrixInverse);
        }
        const scene = new THREE.Scene();
        scene.add(proxy);
        entry = { proxy, scene };
        this.textureAirbrushGpuProxies.set(key, entry);
      } else {
        entry.proxy.material = paintMaterials;
      }
      entry.proxy.matrixWorld.copy(record.object.matrixWorld);
      entry.proxy.matrix.copy(record.object.matrix);
      entry.proxy.visible = true;
      return entry;
    },

    textureAirbrushGpuProjectFromEvent(event, options = {}) {
      if (!this.renderer || !event || !this.canvas || !this.camera || !this.model) {
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!paintRecords.length) {
        return 0;
      }
      this.model.updateMatrixWorld?.(true);
      this.refreshSkinnedRaycastBounds?.();
      const paintObjects = paintRecords.map((record) => record.object);
      const recordByObject = new Map(paintRecords.map((record) => [record.object, record]));
      const screenCenter = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const strokeStart = options.strokeStart
        && Number.isFinite(options.strokeStart.clientX)
        && Number.isFinite(options.strokeStart.clientY)
        ? options.strokeStart
        : null;
      const screenStart = strokeStart
        ? {
            x: strokeStart.clientX - rect.left,
            y: strokeStart.clientY - rect.top
          }
        : screenCenter;
      const screenSegments = (Array.isArray(options.strokeSegments) ? options.strokeSegments : [])
        .map((segment) => {
          const start = segment?.start;
          const end = segment?.end;
          if (
            !Number.isFinite(start?.clientX)
            || !Number.isFinite(start?.clientY)
            || !Number.isFinite(end?.clientX)
            || !Number.isFinite(end?.clientY)
          ) {
            return null;
          }
          return {
            start: {
              x: start.clientX - rect.left,
              y: start.clientY - rect.top
            },
            end: {
              x: end.clientX - rect.left,
              y: end.clientY - rect.top
            }
          };
        })
        .filter(Boolean)
        .slice(0, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
      if (!screenSegments.length) {
        screenSegments.push({
          start: screenStart,
          end: screenCenter
        });
      }
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const depthTarget = this.textureAirbrushRenderDepthTarget({ reuse: true });
      if (!depthTarget) {
        return 0;
      }
      const probeCenters = [];
      const addProbeCenter = (point) => {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          return;
        }
        const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
        if (!probeCenters.some((entry) => entry.key === key)) {
          probeCenters.push({ key, x: point.x, y: point.y });
        }
      };
      addProbeCenter(screenCenter);
      addProbeCenter(screenStart);
      for (const segment of screenSegments.slice(-3)) {
        addProbeCenter(segment.start);
        addProbeCenter(segment.end);
      }
      const probeRadii = brushRadius <= 16
        ? [0]
        : [0, brushRadius * 0.5, brushRadius];
      const probeAngles = [0, Math.PI * 0.25, Math.PI * 0.5, Math.PI * 0.75, Math.PI, Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75];
      const probes = [];
      for (const center of probeCenters) {
        probes.push({ x: center.x, y: center.y });
        for (const radius of probeRadii.slice(1)) {
          for (const angle of probeAngles) {
            probes.push({
              x: center.x + Math.cos(angle) * radius,
              y: center.y + Math.sin(angle) * radius
            });
          }
        }
      }

      const paintPasses = new Map();
      const addPaintPass = (record, materialIndex, material) => {
        if (!record?.geometry?.attributes?.uv || !material) {
          return;
        }
        const targetEntry = this.textureAirbrushGpuTargetForMaterial(material);
        if (!targetEntry) {
          return;
        }
        this.captureTexturePaintGpuUndoTarget?.(record, material, targetEntry, materialIndex);
        const key = [
          paintRecords.indexOf(record),
          materialIndex,
          material.uuid || material.id || "material"
        ].join(":");
        if (!paintPasses.has(key)) {
          paintPasses.set(key, { record, materialIndex, material, targetEntry });
        }
      };

      for (const probe of probes) {
        if (probe.x < 0 || probe.y < 0 || probe.x > rect.width || probe.y > rect.height) {
          continue;
        }
        this.pointer.x = (probe.x / rect.width) * 2 - 1;
        this.pointer.y = -(probe.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        const nearest = intersections[0]?.distance ?? null;
        for (const hit of intersections.slice(0, 4)) {
          if (!hit || (Number.isFinite(nearest) && hit.distance > nearest + 0.025)) {
            break;
          }
          const record = recordByObject.get(hit.object);
          const materialIndex = hit.face?.materialIndex ?? 0;
          const material = record ? this.clonePaintMaterialForHit?.(record, hit) : null;
          addPaintPass(record, materialIndex, material);
        }
      }
      if (!paintPasses.size) {
        return 0;
      }

      const shaderMaterial = this.textureAirbrushBrushShaderMaterial();
      shaderMaterial.uniforms.paintViewMatrix.value.copy(this.camera.matrixWorldInverse);
      shaderMaterial.uniforms.paintProjectionMatrix.value.copy(this.camera.projectionMatrix);
      shaderMaterial.uniforms.depthTexture.value = depthTarget.depthTexture;
      shaderMaterial.uniforms.brushCenter.value.set(screenCenter.x, screenCenter.y);
      shaderMaterial.uniforms.brushStart.value.set(screenStart.x, screenStart.y);
      shaderMaterial.uniforms.strokeSegmentCount.value = screenSegments.length;
      for (let index = 0; index < TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS; index += 1) {
        const segment = screenSegments[index] || screenSegments[screenSegments.length - 1];
        shaderMaterial.uniforms.strokeStarts.value[index].set(segment.start.x, segment.start.y);
        shaderMaterial.uniforms.strokeEnds.value[index].set(segment.end.x, segment.end.y);
      }
      shaderMaterial.uniforms.viewportSize.value.set(rect.width, rect.height);
      const color = this.textureAirbrushShaderColor(options.color || null);
      shaderMaterial.uniforms.paintColor.value.setRGB(color.r, color.g, color.b);
      shaderMaterial.uniforms.radiusPixels.value = brushRadius;
      shaderMaterial.uniforms.strength.value = options.strength ?? 1;
      shaderMaterial.uniforms.brushOpacity.value = options.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42;
      shaderMaterial.uniforms.brushHardness.value = options.hardness ?? this.textureAirbrushHardness?.() ?? 0.35;
      shaderMaterial.uniforms.scatterAmount.value = options.scatter ?? this.textureAirbrushScatter?.() ?? 0.35;
      shaderMaterial.uniforms.depthEpsilon.value = options.depthEpsilon
        ?? Math.max(0.01, Math.min(0.035, this.textureBrushRadiusValue() * 0.55));
      shaderMaterial.needsUpdate = false;

      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      for (const pass of paintPasses.values()) {
        const { proxy, scene } = this.textureAirbrushGpuProxyForRecord(pass.record, pass.materialIndex, pass.material);
        proxy.skeleton?.update?.();
        this.renderer.setRenderTarget(pass.targetEntry.target);
        const bleedOffsets = this.textureAirbrushGpuUvBleedOffsets?.(pass.targetEntry, brushRadius) || [new THREE.Vector2()];
        for (const offset of bleedOffsets) {
          shaderMaterial.uniforms.uvOffset.value.copy(offset);
          this.renderer.render(scene, this.textureAirbrushGpuCopyCamera);
        }
        pass.material.needsUpdate = true;
      }
      shaderMaterial.uniforms.uvOffset.value.set(0, 0);
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;

      const segmentLength = screenSegments.reduce((total, segment) => {
        const dx = segment.end.x - segment.start.x;
        const dy = segment.end.y - segment.start.y;
        return total + Math.sqrt(dx * dx + dy * dy);
      }, 0);
      const radiusPixels = shaderMaterial.uniforms.radiusPixels.value;
      const estimate = Math.max(
        1,
        Math.round((Math.PI * radiusPixels * radiusPixels + segmentLength * radiusPixels * 2) * paintPasses.size)
      );
      this.markTexturePaintStrokeChanged?.();
      this.setStatus(`Airbrushed ${estimate} projected pixels`);
      return estimate;
    },

    textureAirbrushProjectedMeshFromEvent(event, options = {}) {
      if (!event || !this.canvas || !this.camera || !this.model) {
        return 0;
      }
      if (options.gpu === true && !this.textureAirbrushGpuDisabled) {
        try {
          const gpuChanged = this.textureAirbrushGpuProjectFromEvent?.(event, options) || 0;
          if (gpuChanged > 0) {
            return gpuChanged;
          }
        } catch (error) {
          this.textureAirbrushGpuDisabled = true;
          console.warn("Texture airbrush shader path failed; using CPU fallback", error);
        }
      }
      const rect = this.canvas.getBoundingClientRect();
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!paintRecords.length) {
        return 0;
      }

      this.model.updateMatrixWorld?.(true);
      for (const record of paintRecords) {
        record.object.updateMatrixWorld(true);
      }
      this.refreshSkinnedRaycastBounds?.();

      const recordByObject = new Map(paintRecords.map((record) => [record.object, record]));
      const paintObjects = paintRecords.map((record) => record.object);
      const screenCenter = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = this.textureBrushRadiusScreenPixels?.() || 24;
      const probeRadii = [0, brushRadius * 0.45, brushRadius * 0.78];
      const probeAngles = [0, Math.PI * 0.25, Math.PI * 0.5, Math.PI * 0.75, Math.PI, Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75];
      const probes = [{ x: screenCenter.x, y: screenCenter.y }];
      for (const radius of probeRadii.slice(1)) {
        for (const angle of probeAngles) {
          probes.push({
            x: screenCenter.x + Math.cos(angle) * radius,
            y: screenCenter.y + Math.sin(angle) * radius
          });
        }
      }

      const states = new Map();
      const stateForHit = (record, hit) => {
        const material = this.clonePaintMaterialForHit?.(record, hit);
        const editable = this.editableClonePaintTexture?.(material);
        if (!material || !editable) {
          return null;
        }
        const materialIndex = hit?.face?.materialIndex ?? 0;
        const key = [
          paintRecords.indexOf(record),
          materialIndex,
          material.uuid || material.id || "material"
        ].join(":");
        const existing = states.get(key);
        if (existing) {
          return existing;
        }
        const { canvas, context, texture } = editable;
        const state = {
          record,
          material,
          canvas,
          context,
          texture,
          image: context.getImageData(0, 0, canvas.width, canvas.height),
          written: new Set(),
          faceFrames: new Map(),
          changed: 0
        };
        states.set(key, state);
        return state;
      };

      const acceptedFaces = new Set();
      const hits = [];
      const acceptHit = (hit) => {
        const record = recordByObject.get(hit?.object);
        if (!record || !hit?.face || !hit?.uv) {
          return;
        }
        const recordIndex = paintRecords.indexOf(record);
        const faceKey = `${recordIndex}:${hit.face.a}:${hit.face.b}:${hit.face.c}:${hit.face.materialIndex ?? 0}`;
        if (acceptedFaces.has(faceKey)) {
          return;
        }
        acceptedFaces.add(faceKey);
        hits.push({ record, hit });
      };

      this.pointer.x = (screenCenter.x / rect.width) * 2 - 1;
      this.pointer.y = -(screenCenter.y / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const centerIntersections = this.raycaster.intersectObjects(paintObjects, false);
      const depthWindow = Math.max(0.018, this.textureBrushRadiusValue() * 1.15);
      const frontDistance = centerIntersections[0]?.distance ?? null;
      const acceptFrontHits = (intersections, referenceDistance = null) => {
        const nearest = referenceDistance ?? intersections[0]?.distance ?? null;
        if (!Number.isFinite(nearest)) {
          return;
        }
        for (const hit of intersections.slice(0, 4)) {
          if (!hit || hit.distance > nearest + depthWindow) {
            break;
          }
          acceptHit(hit);
        }
      };
      if (centerIntersections[0]) {
        acceptFrontHits(centerIntersections);
      }

      for (const probe of probes.slice(1)) {
        if (probe.x < 0 || probe.y < 0 || probe.x > rect.width || probe.y > rect.height) {
          continue;
        }
        this.pointer.x = (probe.x / rect.width) * 2 - 1;
        this.pointer.y = -(probe.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        acceptFrontHits(intersections, frontDistance);
      }

      let changed = 0;
      for (const { record, hit } of hits) {
        const state = stateForHit(record, hit);
        if (!state) {
          continue;
        }
        changed += this.textureAirbrushUvBrushOnFace?.(record, hit, event, {
          ...options,
          paintState: state,
          deferCommit: true,
          status: false
        }) || 0;
      }

      for (const state of states.values()) {
        if (!state.changed) {
          continue;
        }
        state.context.putImageData(state.image, 0, 0);
        state.texture.needsUpdate = true;
        state.material.needsUpdate = true;
        this.refreshCloneSpotlightTextures?.(state.record);
      }
      if (changed) {
        this.updateClonePaintPreviews?.();
        this.setStatus(`Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      }
      return changed;
    },

    textureAirbrushBrightMeshUnderRegionPointer(event, options = {}) {
      if (!event || !this.canvas || !this.camera) {
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      const targetEntries = [...(this.clonePaintTargets?.entries?.() || [])]
        .filter(([record, target]) => record?.object && target?.vertices?.size);
      if (!targetEntries.length) {
        return 0;
      }
      this.refreshSkinnedRaycastBounds?.();
      const paintObjects = targetEntries.map(([record]) => record.object);
      const targetByRecord = new Map(targetEntries);
      const recordByObject = new Map(targetEntries.map(([record]) => [record.object, record]));
      const color = this.textureAirbrushColor();
      const screenCenter = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = this.textureBrushRadiusScreenPixels?.() || 24;
      const screenRadius = Math.max(brushRadius * 1.65, 12);
      const screenRadiusSq = screenRadius * screenRadius;
      const step = Math.max(4, Math.min(9, brushRadius * 0.48));
      const samples = [{ x: screenCenter.x, y: screenCenter.y, distanceSq: 0 }];
      for (let dy = -screenRadius; dy <= screenRadius; dy += step) {
        for (let dx = -screenRadius; dx <= screenRadius; dx += step) {
          if (!dx && !dy) {
            continue;
          }
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > screenRadiusSq) {
            continue;
          }
          samples.push({
            x: screenCenter.x + dx,
            y: screenCenter.y + dy,
            distanceSq
          });
        }
      }
      samples.sort((left, right) => left.distanceSq - right.distanceSq);

      const states = new Map();
      const stateForHit = (record, target, hit) => {
        const material = this.clonePaintMaterialForHit?.(record, hit);
        const editable = this.editableClonePaintTexture?.(material);
        if (!material || !editable) {
          return null;
        }
        const { canvas, context, texture } = editable;
        const materialIndex = hit?.face?.materialIndex
          ?? target.originMaterialIndex
          ?? target.materialIndex
          ?? 0;
        this.captureTexturePaintCanvasUndoTarget?.(record, material, editable, materialIndex);
        const referenceUv = target.originUv || target.uvCenter || hit.uv || null;
        const key = [
          this.paintRecords.indexOf(record),
          materialIndex,
          material.uuid || material.id || "material"
        ].join(":");
        const existing = states.get(key);
        if (existing) {
          return existing;
        }
        const regionTriangles = this.clonePaintRegionTextureTriangles?.(
          record,
          target,
          materialIndex,
          canvas,
          texture,
          { referenceUv }
        ) || [];
        if (!regionTriangles.length) {
          return null;
        }
        const state = {
          record,
          target,
          material,
          materialIndex,
          canvas,
          context,
          texture,
          image: context.getImageData(0, 0, canvas.width, canvas.height),
          referenceUv,
          regionTriangles,
          written: new Set(),
          changed: 0
        };
        states.set(key, state);
        return state;
      };

      let changed = 0;
      let paintedHits = 0;

      const paintHit = (hit, sample) => {
        const record = recordByObject.get(hit.object);
        const target = record ? targetByRecord.get(record) : null;
        if (!record || !target?.vertices?.size || !hit?.uv) {
          return 0;
        }
        if (!this.clonePaintHitInsideRegion?.(hit, target)) {
          return 0;
        }
        const state = stateForHit(record, target, hit);
        if (!state) {
          return 0;
        }
        const center = this.textureAirbrushRegionPixelFromUv(
          hit.uv,
          state.canvas,
          state.texture,
          state.referenceUv
        );
        if (!center) {
          return 0;
        }
        const radiusPixels = Math.max(
          3,
          Math.min(
            12,
            Math.round(this.textureBrushRadiusValue() * Math.max(state.canvas.width, state.canvas.height) * 0.024)
          )
        );
        let localChanged = 0;
        for (let dy = -radiusPixels; dy <= radiusPixels; dy += 1) {
          for (let dx = -radiusPixels; dx <= radiusPixels; dx += 1) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > radiusPixels) {
              continue;
            }
            const texturePoint = {
              x: center.x + dx,
              y: center.y + dy
            };
            if (!this.clonePaintPointInsideTextureTriangles?.(texturePoint, state.regionTriangles, 0.045)) {
              continue;
            }
            const actualPixel = this.clonePaintActualPixelFromTexturePoint?.({
              x: center.x + dx,
              y: center.y + dy
            }, state.canvas, state.texture);
            if (!actualPixel) {
              continue;
            }
            const key = `${actualPixel.x}:${actualPixel.y}`;
            if (state.written.has(key)) {
              continue;
            }
            state.written.add(key);
            const offset = (actualPixel.y * state.canvas.width + actualPixel.x) * 4;
            const brightArtifact = isBrightArtifactPixel(state.image.data, offset);
            const falloff = 1 - distance / Math.max(1, radiusPixels);
            const screenFalloff = 1 - Math.sqrt(sample.distanceSq) / Math.max(1, screenRadius);
            const alpha = brightArtifact
              ? Math.min(
                0.98,
                0.36
                  + Math.pow(Math.max(0, falloff), 1.45) * 0.48
                  + Math.pow(Math.max(0, screenFalloff), 1.2) * 0.16
              )
              : Math.min(
                0.36,
                0.045
                  + Math.pow(Math.max(0, falloff), 1.7) * 0.23
                  + Math.pow(Math.max(0, screenFalloff), 1.35) * 0.085
              );
            const nextR = clampByte(state.image.data[offset] * (1 - alpha) + color.r * alpha);
            const nextG = clampByte(state.image.data[offset + 1] * (1 - alpha) + color.g * alpha);
            const nextB = clampByte(state.image.data[offset + 2] * (1 - alpha) + color.b * alpha);
            const nextA = Math.max(state.image.data[offset + 3], 255);
            if (
              state.image.data[offset] === nextR
              && state.image.data[offset + 1] === nextG
              && state.image.data[offset + 2] === nextB
              && state.image.data[offset + 3] === nextA
            ) {
              continue;
            }
            state.image.data[offset] = nextR;
            state.image.data[offset + 1] = nextG;
            state.image.data[offset + 2] = nextB;
            state.image.data[offset + 3] = nextA;
            localChanged += 1;
          }
        }
        if (localChanged) {
          state.changed += localChanged;
          changed += localChanged;
        }
        return localChanged;
      };

      for (const sample of samples.slice(0, 72)) {
        if (sample.x < 0 || sample.y < 0 || sample.x > rect.width || sample.y > rect.height) {
          continue;
        }
        this.pointer.x = (sample.x / rect.width) * 2 - 1;
        this.pointer.y = -(sample.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        const hitChanged = intersections[0] ? paintHit(intersections[0], sample) : 0;
        if (hitChanged > 0) {
          paintedHits += 1;
        }
        if (paintedHits >= 72) {
          break;
        }
      }

      for (const state of states.values()) {
        if (!state.changed) {
          continue;
        }
        state.context.putImageData(state.image, 0, 0);
        state.texture.needsUpdate = true;
        state.material.needsUpdate = true;
        this.refreshCloneSpotlightTextures?.(state.record);
      }
      if (changed) {
        this.markTexturePaintStrokeChanged?.();
        this.updateClonePaintPreviews?.();
      }
      return changed;
    },

    paintTextureRegion(options = {}) {
      const entry = [...(this.clonePaintTargets?.entries?.() || [])]
        .find(([, target]) => target?.vertices?.size);
      if (!entry) {
        this.setStatus("Capture a Region first");
        return 0;
      }
      const [record, target] = entry;
      const changed = this.textureAirbrushNear(record, {
        cloneRegionHit: true,
        uv: target.originUv || target.uvCenter,
        face: {
          a: target.originFace?.a || 0,
          b: target.originFace?.b || 0,
          c: target.originFace?.c || 0,
          materialIndex: target.originMaterialIndex ?? target.materialIndex ?? 0
        }
      }, {
        ...options,
        fullRegion: true
      });
      return changed;
    },

    textureAirbrushNear(record, hit, options = {}) {
      if (hit?.cloneRegionHit && options.event) {
        return this.textureAirbrushProjectedRegionFromEvent?.(record, options.event, hit, options) || 0;
      }
      if (options.event && !options.fullRegion && !options.meshFallback) {
        const changed = this.textureAirbrushProjectedMeshFromEvent?.(options.event, options) || 0;
        return changed || this.textureAirbrushUvBrushOnFace?.(record, hit, options.event, options) || 0;
      }
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      const hitUv = hit?.uv;
      if (!editable || !hitUv) {
        this.setStatus("Airbrush needs an editable texture under the cursor");
        return 0;
      }

      const target = hit?.cloneRegionHit ? this.clonePaintTargets?.get(record) : null;
      const { canvas, context, texture } = editable;
      const targetMaterialIndex = hit?.face?.materialIndex
        ?? target?.originMaterialIndex
        ?? target?.materialIndex
        ?? 0;
      this.captureTexturePaintCanvasUndoTarget?.(record, material, editable, targetMaterialIndex);
      const center = this.clonePaintPixelFromUv(hitUv, canvas, texture, { wrap: !target?.vertices?.size });
      const radiusScale = options.radiusScale ?? (target?.vertices?.size ? 1.55 : 0.72);
      const radiusPixels = Math.max(3, Math.round(this.textureBrushRadiusValue() * Math.max(canvas.width, canvas.height) * radiusScale));
      const color = this.textureAirbrushColor();
      const strength = options.fullRegion
        ? (options.strength ?? 1)
        : options.strength ?? this.textureAirbrushStrength();
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const visibleRegionTriangles = target?.vertices?.size && hit?.cloneRegionHit
        ? this.texturePaintVisibleRegionTriangles?.(record, targetMaterialIndex, canvas, texture, { referenceUv: hitUv })
        : null;
      const regionTriangles = target?.vertices?.size
        ? visibleRegionTriangles?.length
          ? visibleRegionTriangles
          : this.clonePaintRegionTextureTriangles?.(record, target, targetMaterialIndex, canvas, texture, { referenceUv: hitUv })
        : null;
      if (target?.vertices?.size && !regionTriangles?.length) {
        this.setStatus("Airbrush needs complete Region texture faces");
        return 0;
      }
      let changed = 0;
      const writtenPixels = new Set();

      const paintPixel = (pixelPoint, dx = 0, dy = 0, alphaOverride = null) => {
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (!options.fullRegion && distance > radiusPixels) {
          return;
        }
        if (regionTriangles && !this.clonePaintPointInsideTextureTriangles?.(pixelPoint, regionTriangles, 0.03)) {
          return;
        }
        const actualPixel = regionTriangles
          ? this.clonePaintActualPixelFromTexturePoint?.(pixelPoint, canvas, texture)
          : pixelPoint;
        if (!actualPixel) {
          return;
        }
        const key = `${actualPixel.x}:${actualPixel.y}`;
        if (writtenPixels.has(key)) {
          return;
        }
        writtenPixels.add(key);
        const falloff = options.fullRegion ? 1 : 1 - distance / radiusPixels;
        const softFalloff = Math.pow(Math.max(0, falloff), 1.75);
        const alpha = alphaOverride ?? (
          target?.vertices?.size
            ? Math.min(0.45, strength * (0.08 + softFalloff * 0.74))
            : strength * falloff * falloff
        );
        const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
        const pixelAlpha = target?.vertices?.size && !alphaOverride
          ? artifactTintAlpha(image.data, offset, alpha, softFalloff)
          : alpha;
        if (pixelAlpha <= 0.012) {
          return;
        }
        const nextR = clampByte(image.data[offset] * (1 - pixelAlpha) + color.r * pixelAlpha);
        const nextG = clampByte(image.data[offset + 1] * (1 - pixelAlpha) + color.g * pixelAlpha);
        const nextB = clampByte(image.data[offset + 2] * (1 - pixelAlpha) + color.b * pixelAlpha);
        const nextA = Math.max(image.data[offset + 3], 255);
        if (
          image.data[offset] === nextR
          && image.data[offset + 1] === nextG
          && image.data[offset + 2] === nextB
          && image.data[offset + 3] === nextA
        ) {
          return;
        }
        image.data[offset] = nextR;
        image.data[offset + 1] = nextG;
        image.data[offset + 2] = nextB;
        image.data[offset + 3] = nextA;
        changed += 1;
      };

      if (options.fullRegion && regionTriangles) {
        for (const { pixels } of regionTriangles) {
          if (pixels.length !== 3) {
            continue;
          }
          const minX = Math.floor(Math.min(...pixels.map((point) => point.x)));
          const maxX = Math.ceil(Math.max(...pixels.map((point) => point.x)));
          const minY = Math.floor(Math.min(...pixels.map((point) => point.y)));
          const maxY = Math.ceil(Math.max(...pixels.map((point) => point.y)));
          for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
              const pixelPoint = { x, y };
              const barycentric = this.clonePaintBarycentric(pixelPoint, pixels);
              if (this.clonePaintBarycentricInside(barycentric, 0.015)) {
                paintPixel(pixelPoint, 0, 0, strength);
              }
            }
          }
        }
      } else if (regionTriangles) {
        for (let dy = -radiusPixels; dy <= radiusPixels; dy += 1) {
          for (let dx = -radiusPixels; dx <= radiusPixels; dx += 1) {
            paintPixel({ x: center.x + dx, y: center.y + dy }, dx, dy);
          }
        }
      } else {
        for (let y = Math.max(0, center.y - radiusPixels); y <= Math.min(canvas.height - 1, center.y + radiusPixels); y += 1) {
          for (let x = Math.max(0, center.x - radiusPixels); x <= Math.min(canvas.width - 1, center.x + radiusPixels); x += 1) {
            const dx = x - center.x;
            const dy = y - center.y;
            paintPixel({ x, y }, dx, dy);
          }
        }
      }

      if (!changed) {
        this.setStatus("Airbrush found no texture pixels");
        return 0;
      }
      context.putImageData(image, 0, 0);
      texture.needsUpdate = true;
      material.needsUpdate = true;
      this.refreshCloneSpotlightTextures?.(record);
      this.setStatus(options.fullRegion
        ? `Painted Region ${changed} ${changed === 1 ? "pixel" : "pixels"}`
        : `Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      this.updateClonePaintPreviews?.();
      return changed;
    }
  });
}
