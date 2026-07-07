function clamp01(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

const TEXTURE_PAINT_LAYER_BLEND_MODES = Object.freeze([
  Object.freeze({ value: "normal", label: "Normal", canvasOperation: "source-over", shaderCode: 0 }),
  Object.freeze({ value: "multiply", label: "Multiply", canvasOperation: "multiply", shaderCode: 1 }),
  Object.freeze({ value: "screen", label: "Screen", canvasOperation: "screen", shaderCode: 2 }),
  Object.freeze({ value: "overlay", label: "Overlay", canvasOperation: "overlay", shaderCode: 3 }),
  Object.freeze({ value: "darken", label: "Darken", canvasOperation: "darken", shaderCode: 4 }),
  Object.freeze({ value: "lighten", label: "Lighten", canvasOperation: "lighten", shaderCode: 5 }),
  Object.freeze({ value: "color-dodge", label: "Color Dodge", canvasOperation: "color-dodge", shaderCode: 6 }),
  Object.freeze({ value: "color-burn", label: "Color Burn", canvasOperation: "color-burn", shaderCode: 7 }),
  Object.freeze({ value: "hard-light", label: "Hard Light", canvasOperation: "hard-light", shaderCode: 8 }),
  Object.freeze({ value: "soft-light", label: "Soft Light", canvasOperation: "soft-light", shaderCode: 9 }),
  Object.freeze({ value: "difference", label: "Difference", canvasOperation: "difference", shaderCode: 10 }),
  Object.freeze({ value: "exclusion", label: "Exclusion", canvasOperation: "exclusion", shaderCode: 11 }),
  Object.freeze({ value: "hue", label: "Hue", canvasOperation: "hue", shaderCode: 12 }),
  Object.freeze({ value: "saturation", label: "Saturation", canvasOperation: "saturation", shaderCode: 13 }),
  Object.freeze({ value: "color", label: "Color", canvasOperation: "color", shaderCode: 14 }),
  Object.freeze({ value: "luminosity", label: "Luminosity", canvasOperation: "luminosity", shaderCode: 15 })
]);

const TEXTURE_PAINT_LAYER_BLEND_MODE_BY_VALUE = new Map(
  TEXTURE_PAINT_LAYER_BLEND_MODES.map((mode) => [mode.value, mode])
);

function normalizeLayerBlendMode(value) {
  const key = String(value || "normal").toLowerCase();
  return TEXTURE_PAINT_LAYER_BLEND_MODE_BY_VALUE.has(key) ? key : "normal";
}

function layerBlendModeInfo(value) {
  return TEXTURE_PAINT_LAYER_BLEND_MODE_BY_VALUE.get(normalizeLayerBlendMode(value))
    || TEXTURE_PAINT_LAYER_BLEND_MODE_BY_VALUE.get("normal");
}

function canvasContext2d(canvas) {
  return canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
}

function layerCanvasIsEmpty(canvas = null) {
  const context = canvasContext2d(canvas);
  if (!canvas || !context) {
    return true;
  }
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] !== 0) {
      return false;
    }
  }
  return true;
}

function layerHasGpuPaint(layer = null, targetEntry = layer?.gpuTarget || null) {
  if (!targetEntry?.target) {
    return false;
  }
  if (targetEntry.emptyTransparent === true) {
    return false;
  }
  if (
    layer?.isEmpty === true
    && layer?.texturePaintGpuPainted !== true
    && layer?.texturePaintHasPaint !== true
  ) {
    targetEntry.emptyTransparent = true;
    targetEntry.texturePaintLayerHasPaint = false;
    return false;
  }
  if (
    layer?.texturePaintGpuPainted === true
    || targetEntry.texturePaintLayerHasPaint === true
  ) {
    return true;
  }
  if (
    layer?.isEmpty === true
    && (
      layer.texturePaintGpuPainted === false
      || layer.texturePaintHasPaint === false
      || targetEntry.texturePaintLayerHasPaint === false
    )
  ) {
    return false;
  }
  if (targetEntry.emptyTransparent === false) {
    return true;
  }
  return Math.max(0, Math.floor(Number(targetEntry.paintRevision) || 0)) > 0
    && layer?.isEmpty !== true;
}

function layerEffectivelyEmpty(layer = null) {
  if (!layer) {
    return true;
  }
  if (
    layer.texturePaintGpuPainted === true
    || layer.texturePaintCpuPainted === true
    || layer.texturePaintHasPaint === true
    || layerHasGpuPaint(layer)
  ) {
    return false;
  }
  if (layer.isEmpty === true && layer.gpuTarget?.emptyTransparent !== false) {
    return true;
  }
  return layer.gpuTarget?.emptyTransparent === true && layer.isEmpty !== false;
}

function layerAirbrushPrewarmOptions(options = {}) {
  return {
    liveDisplayExternalTexture: false,
    allowPrewarmLiveDisplayMaterialSwap: false,
    preserveLayerDisplay: true,
    ...options
  };
}

function layerContributesVisiblePaint(layer = null) {
  return Boolean(
    layer
    && layer.visible !== false
    && clamp01(layer.opacity, 1) > 0
    && !layerEffectivelyEmpty(layer)
  );
}

function texturePaintRawLayerTargetTexture(material = null, texture = null) {
  if (!texture) {
    return false;
  }
  const stack = material?.userData?.texturePaintLayerStack || null;
  return (stack?.layers || []).some((layer) => layer?.gpuTarget?.target?.texture === texture);
}

function texturePaintLayerStableReferenceTexture(material = null, texture = null) {
  if (!texture) {
    return null;
  }
  const userData = texture.userData || {};
  const isLiveDisplay = userData.texturePaintTslSurfaceAirbrushDisplayTexture === true
    || userData.texturePaintTslSurfaceAirbrushTargetTexture === true
    || userData.textureAirbrushExternalWebGpuDisplay === true;
  const candidate = isLiveDisplay
    ? (
        userData.textureAirbrushWebGpuCanvasMap
        || userData.texturePaintTslSurfaceDisplayOriginalMap
        || userData.clonePaintOriginalMap
        || null
      )
    : texture;
  if (
    !candidate
    || candidate.userData?.texturePaintTslSurfaceAirbrushDisplayTexture === true
    || candidate.userData?.texturePaintTslSurfaceAirbrushTargetTexture === true
    || candidate.userData?.textureAirbrushExternalWebGpuDisplay === true
    || texturePaintRawLayerTargetTexture(material, candidate)
  ) {
    return null;
  }
  return candidate;
}

function texturePaintCompositeDisplayTexture(material = null, targetEntry = null) {
  const displayTexture = targetEntry?.displayTarget?.texture
    || targetEntry?.liveCompositeTarget?.texture
    || null;
  if (
    displayTexture
    && displayTexture !== targetEntry?.target?.texture
    && !texturePaintRawLayerTargetTexture(material, displayTexture)
  ) {
    return displayTexture;
  }
  return null;
}

function displayLayerGpuTarget(material = null, stack = null, layer = null) {
  const targetEntry = layer?.gpuTarget || null;
  if (!targetEntry?.target?.texture) {
    return null;
  }
  targetEntry.material = material;
  targetEntry.layer = layer;
  targetEntry.layerStack = stack;
  targetEntry.layerMode = true;
  targetEntry.emptyTransparent = layerEffectivelyEmpty(layer);
  return targetEntry;
}

function resetLayerGpuDisplayCache(targetEntry = null) {
  if (!targetEntry) {
    return false;
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
  return true;
}

function texturePaintIsTslSurfaceDisplayTexture(texture = null) {
  return texture?.userData?.texturePaintTslSurfaceAirbrushDisplayTexture === true;
}

function layerGpuTargetHasTslSurfaceDisplayCache(layer = null) {
  const targetEntry = layer?.gpuTarget || null;
  if (!targetEntry) {
    return false;
  }
  return [
    targetEntry.displayTarget?.texture,
    targetEntry.liveCompositeTarget?.texture,
    targetEntry.liveCompositeTarget?.target?.texture,
    targetEntry.liveCompositeBaseTexture
  ].some(texturePaintIsTslSurfaceDisplayTexture);
}

function collectTexturePaintMaterialGpuCacheTargets(material = null) {
  const targets = [];
  const add = (target = null) => {
    if (target && !targets.includes(target)) {
      targets.push(target);
    }
  };
  const addEntry = (entry = null) => {
    if (!entry) {
      return;
    }
    add(entry);
    add(entry.target);
    add(entry.target?.texture);
    add(entry.displayTarget);
    add(entry.displayTarget?.texture);
    add(entry.liveCompositeTarget);
    add(entry.liveCompositeTarget?.texture);
    add(entry.liveCompositeBaseTexture);
    add(entry.editable);
    add(entry.editable?.canvas);
    add(entry.editable?.texture);
  };
  const userData = material?.userData || {};
  add(material);
  add(material?.map);
  add(userData.clonePaintCanvas);
  add(userData.clonePaintTexture);
  add(userData.clonePaintOriginalMap);
  add(userData.textureAirbrushWebGpuCanvasMap);
  add(userData.textureAirbrushWebGpuExternalMap);
  addEntry(userData.textureAirbrushGpuTarget);
  addEntry(userData.texturePaintCompositeGpuTarget);
  addEntry(userData.texturePaintTslSurfaceAirbrushTarget);
  const stack = userData.texturePaintLayerStack || null;
  add(stack);
  add(stack?.baseCanvas);
  for (const layer of stack?.layers || []) {
    for (const target of collectTexturePaintLayerGpuCacheTargets(layer)) {
      add(target);
    }
  }
  return targets;
}

function collectTexturePaintLayerGpuCacheTargets(layer = null) {
  const targets = [];
  const add = (target = null) => {
    if (target && !targets.includes(target)) {
      targets.push(target);
    }
  };
  const targetEntry = layer?.gpuTarget || null;
  add(layer);
  add(layer?.canvas);
  add(layer?.texture);
  add(layer?.gpuLayerTexture);
  add(targetEntry);
  add(targetEntry?.target);
  add(targetEntry?.target?.texture);
  add(targetEntry?.displayTarget);
  add(targetEntry?.displayTarget?.texture);
  add(targetEntry?.liveCompositeTarget);
  add(targetEntry?.liveCompositeTarget?.texture);
  add(targetEntry?.liveCompositeBaseTexture);
  add(targetEntry?.editable);
  add(targetEntry?.editable?.canvas);
  add(targetEntry?.editable?.texture);
  return targets;
}

function layerGpuReadbackBytes(readback = null) {
  if (!readback) {
    return null;
  }
  if (readback instanceof Uint8Array || readback instanceof Uint8ClampedArray) {
    return new Uint8Array(readback.buffer, readback.byteOffset || 0, readback.byteLength);
  }
  if (readback.buffer) {
    return new Uint8Array(readback.buffer, readback.byteOffset || 0, readback.byteLength);
  }
  return null;
}

function copyLayerGpuBytesToCanvas(bytes = null, canvas = null, width = 1, height = 1, options = {}) {
  const context = canvasContext2d(canvas);
  const targetWidth = Math.max(1, Math.floor(Number(width) || 1));
  const targetHeight = Math.max(1, Math.floor(Number(height) || 1));
  if (!bytes || !canvas || !context || !targetWidth || !targetHeight) {
    return false;
  }
  if (canvas.width !== targetWidth) {
    canvas.width = targetWidth;
  }
  if (canvas.height !== targetHeight) {
    canvas.height = targetHeight;
  }
  const image = context.createImageData(targetWidth, targetHeight);
  const source = bytes instanceof Uint8ClampedArray ? bytes : new Uint8ClampedArray(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
  const premultiplied = options.premultiplied !== false;
  let hasAlpha = false;
  for (let index = 0; index + 3 < image.data.length && index + 3 < source.length; index += 4) {
    const alpha = source[index + 3] || 0;
    if (alpha > 0) {
      hasAlpha = true;
    }
    if (premultiplied && alpha > 0 && alpha < 255) {
      const scale = 255 / alpha;
      image.data[index] = clampByte(source[index] * scale);
      image.data[index + 1] = clampByte(source[index + 1] * scale);
      image.data[index + 2] = clampByte(source[index + 2] * scale);
    } else {
      image.data[index] = source[index] || 0;
      image.data[index + 1] = source[index + 1] || 0;
      image.data[index + 2] = source[index + 2] || 0;
    }
    image.data[index + 3] = alpha;
  }
  context.putImageData(image, 0, 0);
  return { hasAlpha };
}

function scheduleLater(callback, delayMs = 0) {
  const host = typeof window !== "undefined" ? window : globalThis;
  const scheduler = typeof host?.setTimeout === "function" ? host.setTimeout.bind(host) : null;
  return scheduler ? scheduler(callback, delayMs) : null;
}

function cancelScheduled(handle) {
  if (handle === null || handle === undefined) {
    return;
  }
  const host = typeof window !== "undefined" ? window : globalThis;
  if (typeof host?.clearTimeout === "function") {
    host.clearTimeout(handle);
  }
}

function normalizedLayerDirtyBounds(bounds = null, canvas = null) {
  if (
    !bounds
    || !canvas
    || !Number.isFinite(Number(bounds.minX))
    || !Number.isFinite(Number(bounds.minY))
    || !Number.isFinite(Number(bounds.maxX))
    || !Number.isFinite(Number(bounds.maxY))
  ) {
    return null;
  }
  const minX = Math.max(0, Math.floor(Number(bounds.minX)));
  const minY = Math.max(0, Math.floor(Number(bounds.minY)));
  const maxX = Math.min(canvas.width - 1, Math.ceil(Number(bounds.maxX)));
  const maxY = Math.min(canvas.height - 1, Math.ceil(Number(bounds.maxY)));
  if (maxX < minX || maxY < minY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function drawCanvasRegion(context, sourceCanvas = null, bounds = null, targetCanvas = null) {
  if (!context || !sourceCanvas || !bounds || !targetCanvas) {
    return false;
  }
  const scaleX = sourceCanvas.width / targetCanvas.width;
  const scaleY = sourceCanvas.height / targetCanvas.height;
  context.drawImage(
    sourceCanvas,
    bounds.x * scaleX,
    bounds.y * scaleY,
    bounds.width * scaleX,
    bounds.height * scaleY,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height
  );
  return true;
}

export function installTexturePaintLayerMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    texturePaintLayerBlendModes() {
      return TEXTURE_PAINT_LAYER_BLEND_MODES;
    },

    texturePaintNormalizeLayerBlendMode(value) {
      return normalizeLayerBlendMode(value);
    },

    texturePaintLayerBlendMode(layer = null) {
      return normalizeLayerBlendMode(layer?.blendMode);
    },

    texturePaintCanvasCompositeOperation(value) {
      return layerBlendModeInfo(value).canvasOperation;
    },

    texturePaintLayerBlendShaderCode(value) {
      return layerBlendModeInfo(value).shaderCode;
    },

    texturePaintLayerModeActive() {
      return this.texturePaintLayersEnabled !== false
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
    },

    texturePaintLayerMutationSerialValue() {
      return Math.max(0, Math.floor(Number(this.texturePaintLayerMutationSerial) || 0));
    },

    texturePaintLiveLayerUnderlayKey(targetEntry = null) {
      const stack = targetEntry?.layerStack || null;
      const activeLayer = targetEntry?.layer || null;
      const layers = Array.isArray(stack?.layers) ? stack.layers : [];
      const activeIndex = activeLayer ? layers.indexOf(activeLayer) : -1;
      if (activeIndex < 0) {
        return "";
      }
      const parts = [
        `serial:${this.texturePaintLayerMutationSerialValue?.() ?? 0}`,
        `active:${activeLayer.id || activeIndex}`,
        `index:${activeIndex}`,
        `count:${layers.length}`
      ];
      for (let index = 0; index < activeIndex; index += 1) {
        const layer = layers[index] || null;
        const gpuTarget = layer?.gpuTarget || null;
        const texture = gpuTarget?.target?.texture || null;
        parts.push([
          index,
          layer?.id || "",
          layer?.visible === false ? 0 : 1,
          clamp01(layer?.opacity, 1),
          normalizeLayerBlendMode(layer?.blendMode),
          layerEffectivelyEmpty(layer) ? 1 : 0,
          Math.max(0, Math.floor(Number(gpuTarget?.paintRevision) || 0)),
          gpuTarget?.emptyTransparent === true ? 1 : 0,
          gpuTarget?.texturePaintLayerHasPaint === true ? 1 : 0,
          texture?.uuid || texture?.id || texture?.name || "",
          layer?.canvas?.width || 0,
          layer?.canvas?.height || 0,
          layer?.texturePaintCpuPainted === true ? 1 : 0,
          layer?.texturePaintGpuPainted === true ? 1 : 0,
          layer?.texturePaintHasPaint === true ? 1 : 0
        ].join(":"));
      }
      return parts.join("|");
    },

    bumpTexturePaintLayerMutationSerial() {
      this.texturePaintLayerMutationSerial = this.texturePaintLayerMutationSerialValue() + 1;
      return this.texturePaintLayerMutationSerial;
    },

    invalidateTexturePaintMaterialGpuCaches(material = null, options = {}) {
      const targets = collectTexturePaintMaterialGpuCacheTargets(material);
      let invalidated = false;
      for (const target of targets) {
        invalidated = this.textureAirbrushInvalidateWebGpuCache?.(target) === true || invalidated;
      }
      if (options.resetSurfaceStroke === true) {
        this.textureAirbrushResetSurfaceStroke?.();
      }
      return invalidated;
    },

    invalidateTexturePaintLayerGpuCaches(layer = null) {
      let invalidated = false;
      for (const target of collectTexturePaintLayerGpuCacheTargets(layer)) {
        invalidated = this.textureAirbrushInvalidateWebGpuCache?.(target) === true || invalidated;
      }
      return invalidated;
    },

    clearPendingTexturePaintLayerBrushWork() {
      const isLayerWork = (entry) => entry?.layerMode === true;
      const queue = this.textureAirbrushScreenStrokeQueue || [];
      const pending = this.textureAirbrushPendingScreenStrokeBatches || [];
      const nextQueue = queue.filter((entry) => !isLayerWork(entry));
      const nextPending = pending.filter((entry) => !isLayerWork(entry));
      const cleared = nextQueue.length !== queue.length || nextPending.length !== pending.length;
      if (cleared) {
        this.textureAirbrushScreenStrokeQueue = nextQueue;
        this.textureAirbrushPendingScreenStrokeBatches = nextPending;
        if (!nextQueue.length && !nextPending.length) {
          this.clearTextureAirbrushScreenLayer?.();
          this.resolveTextureAirbrushScreenStrokeFlushWaiters?.();
        }
      }
      return cleared;
    },

    flushTexturePaintPendingBrushWorkBeforeLayerMutation(options = {}) {
      const activeStrokeUndo = this.texturePaintStrokeUndo || null;
      if (activeStrokeUndo && this.texturePaintEndingStrokeForLayerMutation !== true) {
        this.texturePaintEndingStrokeForLayerMutation = true;
        try {
          this.endTexturePaintStrokeUndo?.();
        } finally {
          this.texturePaintEndingStrokeForLayerMutation = false;
        }
      }
      this.textureAirbrushAttachStrokeUndoToPendingScreenWork?.(this.texturePaintStrokeUndo || activeStrokeUndo);
      this.flushTextureAirbrushScreenStroke?.();
      this.prepareTexturePaintPendingGpuUndoEntriesForCanvas?.();
      this.flushTextureAirbrushGpuTargetsToCanvases?.({
        mutatedOnly: options.mutatedOnlyBackgroundTargets === true
      });
      this.prepareTexturePaintUndoStackGpuEntriesForCanvas?.({
        material: options.material || null
      });
      return true;
    },

    prepareTexturePaintLayerMutation(options = {}) {
      this.cancelTextureAirbrushDeferredBroadLayerPrewarm?.();
      if (options.flushPendingBrushWork !== false) {
        this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.(options);
      }
      this.bumpTexturePaintLayerMutationSerial();
      this.clearPendingTexturePaintLayerBrushWork();
      this.texturePaintTslSurfaceAirbrushInvalidate?.();
      this.textureAirbrushResetLiveProjectionFrame?.();
      this.redoStack = [];
      this.updateUndoButton?.();
      if (options.flushGpuTargets !== false) {
        this.flushTexturePaintLayerGpuTargetsToCanvases?.();
      }
      return true;
    },

    prepareTexturePaintLayerTargetChange(options = {}) {
      this.cancelTextureAirbrushDeferredBroadLayerPrewarm?.();
      this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.(options);
      this.bumpTexturePaintLayerMutationSerial();
      this.clearPendingTexturePaintLayerBrushWork();
      this.texturePaintTslSurfaceAirbrushInvalidate?.();
      this.textureAirbrushResetLiveProjectionFrame?.();
      return true;
    },

    prepareTexturePaintLayerDisplayMutation() {
      this.cancelTextureAirbrushDeferredBroadLayerPrewarm?.();
      this.texturePaintLayerDisplaySerial = Math.max(
        0,
        Math.floor(Number(this.texturePaintLayerDisplaySerial) || 0)
      ) + 1;
      return true;
    },

    texturePaintDisplayLayerForStack(stack = null) {
      if (!stack?.layers?.length) {
        return null;
      }
      for (let index = stack.layers.length - 1; index >= 0; index -= 1) {
        const layer = stack.layers[index];
        if (layerContributesVisiblePaint(layer)) {
          return layer;
        }
      }
      return null;
    },

    texturePaintMaterialRequiresExactLayerDisplay(material = null) {
      if (!Object.prototype.hasOwnProperty.call(
        material?.userData || {},
        "texturePaintForceExactLayerDisplaySerial"
      )) {
        return false;
      }
      const serial = this.texturePaintLayerMutationSerialValue?.() ?? 0;
      return Boolean(
        material?.userData
        && Math.max(0, Math.floor(Number(material.userData.texturePaintForceExactLayerDisplaySerial) || 0)) === serial
      );
    },

    forceTexturePaintExactLayerDisplay(material = null) {
      const serial = this.texturePaintLayerMutationSerialValue?.() ?? 0;
      const materials = [];
      if (material) {
        materials.push(material);
      } else {
        for (const paintable of this.textureAirbrushPaintableMaterials?.() || []) {
          if (paintable.material && !materials.includes(paintable.material)) {
            materials.push(paintable.material);
          }
        }
      }
      let forced = 0;
      for (const candidate of materials) {
        if (!candidate?.userData?.texturePaintLayerStack) {
          continue;
        }
        candidate.userData.texturePaintForceExactLayerDisplaySerial = serial;
        forced += 1;
      }
      return forced;
    },

    texturePaintFastHiddenTopLayerDisplay(material = null, stack = null, layer = null) {
      if (!material?.userData || !stack?.layers?.length || !layer) {
        return false;
      }
      const layerIndex = stack.layers.indexOf(layer);
      if (layerIndex < 0) {
        return false;
      }
      for (let index = layerIndex + 1; index < stack.layers.length; index += 1) {
        if (layerContributesVisiblePaint(stack.layers[index])) {
          return false;
        }
      }
      const targetEntry = displayLayerGpuTarget(material, stack, layer);
      const underlayTexture = targetEntry?.liveCompositeBaseTexture || null;
      if (
        !targetEntry?.target?.texture
        || !underlayTexture
        || targetEntry.liveCompositeLayer !== layer
        || targetEntry.liveCompositeLayerIndex !== layerIndex
        || targetEntry.liveCompositeLayerCount !== stack.layers.length
        || targetEntry.liveCompositeLayerMutationSerial !== (this.texturePaintLayerMutationSerialValue?.() ?? 0)
      ) {
        return false;
      }
      const expectedUnderlayKey = this.texturePaintLiveLayerUnderlayKey?.(targetEntry) || "";
      if ((targetEntry.liveCompositeUnderlayKey || "") !== expectedUnderlayKey) {
        return false;
      }
      const liveComposite = targetEntry.liveCompositeTarget || null;
      const displayTexture = texturePaintCompositeDisplayTexture(material, targetEntry);
      if (displayTexture) {
        if (material.map !== displayTexture) {
          material.map = displayTexture;
          material.needsUpdate = true;
        }
        return true;
      }
      if (
        liveComposite?.shaderComposite === true
        && material.map === underlayTexture
        && this.texturePaintRestoreLiveLayerShaderDisplayState?.(material, targetEntry, liveComposite)
      ) {
        return true;
      }
      const liveShader = material.userData.texturePaintLiveLayerShaderComposite || null;
      if (liveShader && this.texturePaintMuteLiveLayerShaderComposite?.(material) === false) {
        return false;
      }
      if (material.map !== underlayTexture && !texturePaintRawLayerTargetTexture(material, underlayTexture)) {
        material.map = underlayTexture;
        material.needsUpdate = true;
      }
      return material.map === underlayTexture;
    },

    texturePaintFastMaterialLayerDisplay(material = null, options = {}) {
      if (this.texturePaintMaterialRequiresExactLayerDisplay?.(material)) {
        return false;
      }
      const stack = material?.userData?.texturePaintLayerStack || null;
      if (!stack?.baseCanvas) {
        return false;
      }
      const changedLayer = options.changedLayer || null;
      if (
        changedLayer
        && (changedLayer.visible === false || clamp01(changedLayer.opacity, 1) <= 0)
        && this.texturePaintFastHiddenTopLayerDisplay?.(material, stack, changedLayer)
      ) {
        return true;
      }
      const displayLayer = this.texturePaintDisplayLayerForStack?.(stack);
      if (!displayLayer) {
        return this.texturePaintBaseOnlyMaterialLayerDisplay?.(material, stack) === true;
      }
      const displayIndex = stack.layers.indexOf(displayLayer);
      const changedIndex = changedLayer ? stack.layers.indexOf(changedLayer) : -1;
      if (
        changedLayer
        && changedLayer !== displayLayer
        && changedIndex >= 0
        && displayIndex >= 0
        && changedIndex < displayIndex
        && options.forceLiveUnderlay !== true
      ) {
        return false;
      }
      const targetEntry = displayLayerGpuTarget(material, stack, displayLayer);
      const liveComposite = targetEntry?.target?.texture
        ? (
            typeof this.texturePaintCachedLiveCompositeTargetForLayerGpuPaint === "function"
              ? this.texturePaintCachedLiveCompositeTargetForLayerGpuPaint(material, targetEntry)
              : this.texturePaintLiveCompositeTargetForLayerGpuPaint?.(material, targetEntry)
          )
        : null;
      if (!liveComposite?.shaderComposite) {
        const displayTexture = texturePaintCompositeDisplayTexture(material, targetEntry);
        if (!displayTexture) {
          return false;
        }
        if (material.map !== displayTexture) {
          material.map = displayTexture;
          material.needsUpdate = true;
        }
        return true;
      }
      this.texturePaintRestoreLiveLayerShaderDisplayState?.(material, targetEntry, liveComposite);
      return true;
    },

    scheduleTexturePaintLayerDisplayComposite(material = null, options = {}) {
      if (!material?.userData?.texturePaintLayerStack) {
        return false;
      }
      if (!this.pendingTexturePaintLayerDisplayComposites) {
        this.pendingTexturePaintLayerDisplayComposites = new Map();
      }
      this.pendingTexturePaintLayerDisplayComposites.set(material, {
        ...(this.pendingTexturePaintLayerDisplayComposites.get(material) || {}),
        ...options,
        forceLiveUnderlay: true
      });
      if (this.texturePaintLayerDisplayCompositeTimer) {
        cancelScheduled(this.texturePaintLayerDisplayCompositeTimer);
        this.texturePaintLayerDisplayCompositeTimer = null;
      }
      const delayMs = Math.max(16, Math.floor(Number(options.delayMs) || 96));
      this.texturePaintLayerDisplayCompositeTimer = scheduleLater(() => {
        this.texturePaintLayerDisplayCompositeTimer = null;
        const pending = this.pendingTexturePaintLayerDisplayComposites || new Map();
        this.pendingTexturePaintLayerDisplayComposites = new Map();
        for (const [candidateMaterial, candidateOptions] of pending.entries()) {
          this.texturePaintCompositeMaterialLayerDisplay?.(candidateMaterial, candidateOptions);
        }
      }, delayMs);
      return true;
    },

    cancelTexturePaintLayerDisplayComposite(material = null) {
      const pending = this.pendingTexturePaintLayerDisplayComposites || null;
      if (!pending?.size) {
        return false;
      }
      const cancelled = material ? pending.delete(material) : pending.clear();
      if (!pending.size && this.texturePaintLayerDisplayCompositeTimer) {
        cancelScheduled(this.texturePaintLayerDisplayCompositeTimer);
        this.texturePaintLayerDisplayCompositeTimer = null;
      }
      return Boolean(cancelled);
    },

    texturePaintApplyLayerDisplayChange(material = null, options = {}) {
      if (this.texturePaintFastMaterialLayerDisplay?.(material, options)) {
        return true;
      }
      if (options.deferFallback !== false && this.scheduleTexturePaintLayerDisplayComposite?.(material, options)) {
        return true;
      }
      return this.texturePaintCompositeMaterialLayerDisplay?.(material, options) === true;
    },

    createTexturePaintCanvas(width, height) {
      if (typeof document === "undefined") {
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(Number(width) || 1));
      canvas.height = Math.max(1, Math.round(Number(height) || 1));
      return canvas;
    },

    copyTexturePaintCanvas(sourceCanvas = null) {
      const canvas = this.createTexturePaintCanvas(sourceCanvas?.width, sourceCanvas?.height);
      const context = canvasContext2d(canvas);
      if (!canvas || !context) {
        return null;
      }
      if (sourceCanvas) {
        context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
      }
      return canvas;
    },

    captureTexturePaintLayerHistorySnapshot(material = null) {
      const stack = material?.userData?.texturePaintLayerStack || null;
      if (!material || !stack?.baseCanvas || !stack.baseContext) {
        return null;
      }
      const baseCanvas = this.copyTexturePaintCanvas(stack.baseCanvas);
      if (!baseCanvas) {
        return null;
      }
      const layers = [];
      for (const layer of stack.layers || []) {
        const canvas = this.copyTexturePaintCanvas(layer?.canvas);
        if (!canvas) {
          return null;
        }
        layers.push({
          id: layer.id,
          name: layer.name,
          visible: layer.visible !== false,
          opacity: clamp01(layer.opacity, 1),
          blendMode: this.texturePaintLayerBlendMode?.(layer) || "normal",
          isEmpty: layerEffectivelyEmpty(layer),
          autoCreated: layer.autoCreated === true,
          canvas
        });
      }
      return {
        material,
        activeLayerId: stack.activeLayerId || "",
        selectedLayerIds: Array.isArray(stack.selectedLayerIds) ? [...stack.selectedLayerIds] : [],
        selectionAnchorLayerId: stack.selectionAnchorLayerId || "",
        width: stack.width || baseCanvas.width,
        height: stack.height || baseCanvas.height,
        baseCanvas,
        layers
      };
    },

    restoreTexturePaintLayerHistorySnapshot(snapshot = null) {
      const material = snapshot?.material || null;
      if (!material?.userData || !snapshot?.baseCanvas) {
        return false;
      }
      this.cancelTexturePaintLayerDisplayComposite?.(material);
      this.invalidateTexturePaintMaterialGpuCaches?.(material, {
        resetSurfaceStroke: true
      });
      this.discardTexturePaintMaterialAirbrushGpuTarget?.(material);
      this.discardTexturePaintMaterialGpuComposite?.(material);
      this.texturePaintDisableLiveLayerShaderComposite?.(material);
      const stack = material.userData.texturePaintLayerStack || {
        activeLayerId: "",
        selectedLayerIds: [],
        selectionAnchorLayerId: "",
        layers: []
      };
      for (const layer of stack.layers || []) {
        this.disposeTexturePaintLayerGpuState?.(layer);
      }
      const baseCanvas = this.copyTexturePaintCanvas(snapshot.baseCanvas);
      const baseContext = canvasContext2d(baseCanvas);
      if (!baseCanvas || !baseContext) {
        return false;
      }
      stack.baseCanvas = baseCanvas;
      stack.baseContext = baseContext;
      stack.width = snapshot.width || baseCanvas.width;
      stack.height = snapshot.height || baseCanvas.height;
      stack.layers = [];
      material.userData.texturePaintLayerStack = stack;
      for (const layerSnapshot of snapshot.layers || []) {
        const layer = this.texturePaintNewLayer(stack, {
          id: layerSnapshot.id,
          name: layerSnapshot.name || this.texturePaintLayerName(stack),
          visible: layerSnapshot.visible !== false,
          opacity: layerSnapshot.opacity,
          blendMode: layerSnapshot.blendMode,
          autoCreated: layerSnapshot.autoCreated === true,
          isEmpty: layerSnapshot.isEmpty === true
        });
        if (!layer) {
          continue;
        }
        layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.context.drawImage(layerSnapshot.canvas, 0, 0, layer.canvas.width, layer.canvas.height);
        layer.isEmpty = layerSnapshot.isEmpty === true || layerCanvasIsEmpty(layer.canvas);
        layer.texturePaintHasPaint = layer.isEmpty !== true;
        layer.texturePaintCpuPainted = layer.isEmpty !== true;
        layer.texturePaintGpuPainted = false;
        stack.layers.push(layer);
      }
      const activeLayerId = snapshot.activeLayerId || "";
      if (activeLayerId && stack.layers.some((layer) => layer.id === activeLayerId)) {
        stack.activeLayerId = activeLayerId;
        const validIds = new Set(stack.layers.map((layer) => layer.id));
        stack.selectedLayerIds = (snapshot.selectedLayerIds || []).filter((id) => validIds.has(id));
        if (!stack.selectedLayerIds.length) {
          stack.selectedLayerIds = [activeLayerId];
        }
        stack.selectionAnchorLayerId = validIds.has(snapshot.selectionAnchorLayerId)
          ? snapshot.selectionAnchorLayerId
          : activeLayerId;
        const activeLayer = stack.layers.find((layer) => layer.id === activeLayerId) || null;
        this.rememberTexturePaintLayerSelection?.(stack, activeLayer);
      } else {
        this.texturePaintSetBackgroundSelection?.(stack);
        this.rememberTexturePaintBackgroundSelection?.();
      }
      this.texturePaintActiveMaterial = material;
      this.texturePaintCompositeMaterialLayers?.(material, {
        skipGpuFlush: true,
        preferCpuDisplay: true
      });
      this.invalidateTexturePaintMaterialGpuCaches?.(material, {
        resetSurfaceStroke: true
      });
      this.bumpTexturePaintLayerMutationSerial?.();
      this.textureAirbrushResetLiveProjectionFrame?.();
      this.renderTexturePaintLayerPanel?.();
      return true;
    },

    pushTexturePaintLayerUndoState(label = "Layer edit", before = null, after = null, options = {}) {
      if (!Array.isArray(this.undoStack) || !before || !after) {
        return false;
      }
      this.undoStack.push({
        kind: "texture-layer",
        label,
        before,
        after
      });
      if (this.undoStack.length > this.maxUndoSteps) {
        this.disposeFastHistoryState?.(this.undoStack.shift());
      }
      if (!options.preserveRedo) {
        for (const redoState of this.redoStack || []) {
          this.disposeFastHistoryState?.(redoState);
        }
        this.redoStack = [];
      }
      this.updateUndoButton?.();
      return true;
    },

    texturePaintLayerName(stack = null) {
      const nextNumber = (stack?.layers?.length || 0) + 1;
      return `Paint ${nextNumber}`;
    },

    normalizeTexturePaintLayerName(name = "", fallback = "Paint") {
      const normalized = String(name || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64);
      return normalized || fallback;
    },

    texturePaintBackgroundLayerName() {
      return "Background";
    },

    texturePaintNewLayer(stack = null, options = {}) {
      if (!stack?.width || !stack?.height) {
        return null;
      }
      const canvas = this.createTexturePaintCanvas(stack.width, stack.height);
      const context = canvasContext2d(canvas);
      if (!canvas || !context) {
        return null;
      }
      this.texturePaintLayerSerial = (this.texturePaintLayerSerial || 0) + 1;
      return {
        id: options.id || `paint-layer-${Date.now().toString(36)}-${this.texturePaintLayerSerial}`,
        name: options.name || this.texturePaintLayerName(stack),
        visible: options.visible !== false,
        opacity: clamp01(options.opacity, 1),
        blendMode: normalizeLayerBlendMode(options.blendMode),
        canvas,
        context,
        isEmpty: options.isEmpty !== false,
        texturePaintHasPaint: options.isEmpty === false,
        texturePaintCpuPainted: options.isEmpty === false,
        texturePaintGpuPainted: false,
        autoCreated: options.autoCreated === true
      };
    },

    texturePaintReusableAutoLayer(stack = null) {
      if (!stack?.layers || stack.layers.length !== 1) {
        return null;
      }
      const layer = stack.layers[0];
      if (
        layer?.autoCreated !== true
        || !layerEffectivelyEmpty(layer)
      ) {
        return null;
      }
      return layer;
    },

    texturePaintUpdateLayerEmptyState(layer = null) {
      if (!layer?.canvas) {
        return false;
      }
      const empty = layerCanvasIsEmpty(layer.canvas);
      layer.isEmpty = empty;
      layer.texturePaintHasPaint = !empty;
      layer.texturePaintCpuPainted = !empty;
      if (layer.gpuTarget) {
        layer.gpuTarget.emptyTransparent = empty;
        layer.gpuTarget.texturePaintLayerHasPaint = !empty;
        if (empty) {
          layer.gpuTarget.paintRevision = 0;
        }
      }
      return empty;
    },

    texturePaintLayerHiddenInPanel(layer = null) {
      return Boolean(layer?.autoCreated === true && layerEffectivelyEmpty(layer));
    },

    texturePaintPanelLayers(stack = null) {
      if (!Array.isArray(stack?.layers)) {
        return [];
      }
      return stack.layers.filter((layer) => !this.texturePaintLayerHiddenInPanel?.(layer));
    },

    texturePaintBackgroundSelected(stack = null) {
      return Boolean(stack && !stack.activeLayerId);
    },

    texturePaintSetBackgroundSelection(stack = null) {
      if (!stack) {
        return false;
      }
      stack.activeLayerId = "";
      stack.selectedLayerIds = [];
      stack.selectionAnchorLayerId = "";
      return true;
    },

    texturePaintLayerSelectionTemplateFrom(stack = null, layer = null) {
      if (!stack || !layer?.id) {
        return null;
      }
      return {
        id: layer.id,
        index: Math.max(0, stack.layers?.indexOf(layer) ?? 0),
        name: layer.name || this.texturePaintLayerName?.(stack) || "Paint 1",
        visible: layer.visible !== false,
        opacity: layer.opacity,
        blendMode: layer.blendMode
      };
    },

    rememberTexturePaintLayerSelection(stack = null, layer = null) {
      const template = this.texturePaintLayerSelectionTemplateFrom?.(stack, layer);
      if (!template?.id) {
        return false;
      }
      this.texturePaintActiveLayerSelectionTemplate = template;
      this.texturePaintBackgroundSelectionActive = false;
      return true;
    },

    rememberTexturePaintBackgroundSelection() {
      this.texturePaintActiveLayerSelectionTemplate = null;
      this.texturePaintBackgroundSelectionActive = true;
      return true;
    },

    texturePaintSelectedLayerIds(stack = null) {
      if (!stack?.layers?.length) {
        this.texturePaintSetBackgroundSelection?.(stack);
        return [];
      }
      if (this.texturePaintBackgroundSelected?.(stack)) {
        stack.selectedLayerIds = [];
        stack.selectionAnchorLayerId = "";
        return [];
      }
      const validIds = new Set(stack.layers.map((layer) => layer.id));
      let selectedLayerIds = Array.isArray(stack.selectedLayerIds)
        ? stack.selectedLayerIds.filter((id) => validIds.has(id))
        : [];
      if (!selectedLayerIds.length) {
        const activeId = validIds.has(stack.activeLayerId)
          ? stack.activeLayerId
          : stack.layers[stack.layers.length - 1]?.id;
        selectedLayerIds = activeId ? [activeId] : [];
      }
      stack.selectedLayerIds = selectedLayerIds;
      if (!validIds.has(stack.activeLayerId)) {
        stack.activeLayerId = selectedLayerIds[selectedLayerIds.length - 1] || stack.layers[stack.layers.length - 1]?.id || "";
      }
      if (!validIds.has(stack.selectionAnchorLayerId)) {
        stack.selectionAnchorLayerId = stack.activeLayerId;
      }
      return selectedLayerIds;
    },

    texturePaintActivePaintLayerForStack(stack = null, options = {}) {
      if (!stack?.layers?.length || this.texturePaintBackgroundSelected?.(stack)) {
        return null;
      }
      let layer = stack.layers.find((item) => item.id === stack.activeLayerId) || null;
      if (!layer && options.fallback !== false) {
        layer = stack.layers[stack.layers.length - 1] || null;
        if (layer) {
          this.texturePaintSetSingleLayerSelection(stack, layer.id);
        }
      } else if (layer) {
        this.texturePaintSelectedLayerIds(stack);
      }
      if (layer && this.texturePaintLayerHiddenInPanel?.(layer)) {
        this.texturePaintSetBackgroundSelection?.(stack);
        return null;
      }
      return layer ? { stack, layer } : null;
    },

    texturePaintHasActivePaintLayer(material = null) {
      const activeMaterial = material || this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = activeMaterial?.userData?.texturePaintLayerStack || null;
      return Boolean(this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false })?.layer);
    },

    texturePaintActiveLayerTemplate() {
      if (this.texturePaintBackgroundSelectionActive === true) {
        return null;
      }
      if (this.texturePaintActiveLayerSelectionTemplate?.id) {
        return { ...this.texturePaintActiveLayerSelectionTemplate };
      }
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack || null;
      const active = this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false }) || null;
      const layer = active?.layer || null;
      if (!layer) {
        return null;
      }
      return this.texturePaintLayerSelectionTemplateFrom?.(stack, layer);
    },

    texturePaintEnsureActiveLayerForStack(stack = null) {
      if (!stack) {
        return null;
      }
      const template = this.texturePaintActiveLayerTemplate?.();
      if (!template?.id) {
        if (this.texturePaintBackgroundSelectionActive === true) {
          return null;
        }
        const existing = this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false });
        if (existing?.layer) {
          return existing;
        }
        return null;
      }
      const matchingLayer = stack.layers?.find((layer) => layer.id === template.id) || null;
      if (matchingLayer) {
        this.texturePaintSetSingleLayerSelection(stack, matchingLayer.id);
        return { stack, layer: matchingLayer };
      }
      const existing = this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false });
      if (existing?.layer && existing.layer.id === template.id) {
        return existing;
      }
      const layer = this.texturePaintNewLayer(stack, template);
      if (!layer) {
        return null;
      }
      stack.layers ||= [];
      stack.layers.splice(Math.min(template.index, stack.layers.length), 0, layer);
      this.texturePaintSetSingleLayerSelection(stack, layer.id);
      return { stack, layer };
    },

    texturePaintSetSingleLayerSelection(stack = null, layerId = "") {
      if (!stack?.layers?.some((layer) => layer.id === layerId)) {
        return false;
      }
      const previousLayerId = stack.activeLayerId || "";
      stack.activeLayerId = layerId;
      stack.selectedLayerIds = [layerId];
      stack.selectionAnchorLayerId = layerId;
      if (previousLayerId && previousLayerId !== layerId) {
        this.texturePaintTslSurfaceAirbrushInvalidate?.();
      }
      return true;
    },

    texturePaintLayerEntriesForId(layerId = "") {
      const entries = [];
      const seenMaterials = new Set();
      const addMaterial = (material = null) => {
        if (!material || seenMaterials.has(material)) {
          return;
        }
        seenMaterials.add(material);
        const stack = material.userData?.texturePaintLayerStack || null;
        const layer = stack?.layers?.find((item) => item.id === layerId) || null;
        if (layer) {
          entries.push({ material, stack, layer });
        }
      };
      addMaterial(this.texturePaintActiveMaterial || null);
      addMaterial(this.texturePaintFirstLayerMaterial?.() || null);
      for (const paintable of this.textureAirbrushPaintableMaterials?.() || []) {
        addMaterial(paintable.material);
      }
      for (const record of this.paintRecords || []) {
        for (const material of this.texturePaintMaterialsForRecord?.(record) || []) {
          addMaterial(material);
        }
      }
      return entries;
    },

    texturePaintLayerStackForMaterial(material, editable = null, options = {}) {
      if (!material) {
        return null;
      }
      material.userData ||= {};
      const userData = material.userData;
      const compositeCanvas = editable?.compositeCanvas || editable?.canvas || userData.clonePaintCanvas || null;
      let stack = userData.texturePaintLayerStack || null;
      const create = options.create === true;
      if (stack && Array.isArray(stack.layers)) {
        if (options.setActiveMaterial !== false) {
          this.texturePaintActiveMaterial = material;
        }
        return stack;
      }
      if (!create || !compositeCanvas) {
        return stack;
      }

      const baseCanvas = this.copyTexturePaintCanvas(compositeCanvas);
      const baseContext = canvasContext2d(baseCanvas);
      if (!baseCanvas || !baseContext) {
        return null;
      }
      stack = {
        baseCanvas,
        baseContext,
        width: baseCanvas.width,
        height: baseCanvas.height,
        activeLayerId: "",
        selectedLayerIds: [],
        selectionAnchorLayerId: "",
        layers: []
      };
      userData.texturePaintLayerStack = stack;
      if (options.setActiveMaterial !== false) {
        this.texturePaintActiveMaterial = material;
      }
      return stack;
    },

    texturePaintActiveLayerForMaterial(material, editable = null, options = {}) {
      const stack = this.texturePaintLayerStackForMaterial(material, editable, {
        create: options.create !== false,
        setActiveMaterial: options.setActiveMaterial
      });
      if (!stack) {
        return null;
      }
      if (!stack.layers?.length) {
        if (options.create === false) {
          return null;
        }
        const layer = this.texturePaintNewLayer(stack, { name: "Paint 1", autoCreated: true });
        if (!layer) {
          return null;
        }
        stack.layers.push(layer);
        this.texturePaintSetSingleLayerSelection(stack, layer.id);
        if (options.renderPanel !== false) {
          this.renderTexturePaintLayerPanel?.();
        }
        return { stack, layer };
      }
      let layer = stack.layers.find((item) => item.id === stack.activeLayerId);
      if (!layer) {
        layer = stack.layers[stack.layers.length - 1];
        this.texturePaintSetSingleLayerSelection(stack, layer.id);
      } else {
        this.texturePaintSelectedLayerIds(stack);
      }
      return { stack, layer };
    },

    texturePaintEditableLayerTarget(material, editable = null) {
      if (!this.texturePaintLayerModeActive?.() || !editable?.canvas || !editable?.context) {
        return editable;
      }
      const stack = this.texturePaintLayerStackForMaterial(material, editable, {
        create: true,
        setActiveMaterial: false
      });
      const active = this.texturePaintEnsureActiveLayerForStack?.(stack)
        || (
          this.texturePaintBackgroundSelectionActive === true
            ? null
            : this.texturePaintActivePaintLayerForStack(stack, { fallback: false })
        )
        || this.texturePaintActiveLayerForMaterial?.(material, editable, {
          create: true,
          renderPanel: false,
          setActiveMaterial: false
        });
      if (!active?.layer) {
        this.texturePaintActiveMaterial = material;
        return editable;
      }
      this.rememberTexturePaintLayerSelection?.(active.stack, active.layer);
      this.texturePaintActiveMaterial = material;
      return {
        ...editable,
        canvas: active.layer.canvas,
        context: active.layer.context,
        texture: editable.texture,
        compositeCanvas: editable.canvas,
        compositeContext: editable.context,
        layer: active.layer,
        layerStack: active.stack,
        layerMode: true
      };
    },

    texturePaintSyncBackgroundFromEditable(material = null, editable = null, options = {}) {
      const stack = material?.userData?.texturePaintLayerStack || null;
      const sourceCanvas = editable?.canvas || material?.userData?.clonePaintCanvas || null;
      if (!stack?.baseCanvas || !sourceCanvas) {
        return false;
      }
      stack.baseContext ||= canvasContext2d(stack.baseCanvas);
      if (!stack.baseContext) {
        return false;
      }
      const dirtyBounds = normalizedLayerDirtyBounds(options.dirtyBounds || editable?.dirtyBounds, stack.baseCanvas);
      if (dirtyBounds) {
        drawCanvasRegion(stack.baseContext, sourceCanvas, dirtyBounds, stack.baseCanvas);
      } else {
        stack.baseContext.clearRect(0, 0, stack.baseCanvas.width, stack.baseCanvas.height);
        stack.baseContext.drawImage(sourceCanvas, 0, 0, stack.baseCanvas.width, stack.baseCanvas.height);
      }
      if (options.renderPanel !== false) {
        this.scheduleTexturePaintLayerPanelRender?.();
      }
      return true;
    },

    texturePaintCompositeMaterialLayers(material, options = {}) {
      const userData = material?.userData || {};
      const stack = userData.texturePaintLayerStack;
      const canvas = userData.clonePaintCanvas;
      const context = userData.clonePaintContext;
      if (!stack?.baseCanvas || !canvas || !context) {
        return false;
      }
      if (options.skipGpuFlush !== true) {
        this.flushTexturePaintLayerGpuTargetsToCanvases?.({
          material,
          composite: false
        });
      }
      const dirtyBounds = normalizedLayerDirtyBounds(options.dirtyBounds, canvas);
      this.texturePaintDisableLiveLayerShaderComposite?.(material);
      const clearBounds = dirtyBounds || {
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height
      };
      context.clearRect(clearBounds.x, clearBounds.y, clearBounds.width, clearBounds.height);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      if (dirtyBounds) {
        drawCanvasRegion(context, stack.baseCanvas, dirtyBounds, canvas);
      } else {
        context.drawImage(stack.baseCanvas, 0, 0, canvas.width, canvas.height);
      }
      for (const layer of stack.layers || []) {
        if (!layer?.visible || !layer.canvas) {
          continue;
        }
        context.globalAlpha = clamp01(layer.opacity, 1);
        context.globalCompositeOperation = this.texturePaintCanvasCompositeOperation?.(layer.blendMode) || "source-over";
        if (dirtyBounds) {
          drawCanvasRegion(context, layer.canvas, dirtyBounds, canvas);
        } else {
          context.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height);
        }
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      const webGpuExternalMap = userData.textureAirbrushWebGpuExternalMap || null;
      const preserveWebGpuDisplay = options.preserveWebGpuDisplay === true
        && webGpuExternalMap
        && material.map === webGpuExternalMap;
      if (userData.clonePaintTexture) {
        userData.clonePaintTexture.needsUpdate = true;
        if (!preserveWebGpuDisplay) {
          this.textureAirbrushInvalidateWebGpuCache?.(userData.clonePaintTexture);
        }
      }
      if (preserveWebGpuDisplay) {
        // The CPU canvas has caught up for undo/export; keep the accumulated
        // WebGPU texture bound so consecutive live strokes do not disappear.
      } else if (options.preferCpuDisplay === true && userData.clonePaintTexture) {
        material.map = userData.clonePaintTexture;
      } else if (
        userData.texturePaintCompositeGpuTarget
        && !texturePaintRawLayerTargetTexture(material, userData.texturePaintCompositeGpuTarget?.target?.texture)
      ) {
        this.texturePaintCompositeMaterialLayerGpuTargets?.(material);
      } else if (userData.clonePaintTexture) {
        material.map = userData.clonePaintTexture;
      }
      if (!preserveWebGpuDisplay) {
        material.needsUpdate = true;
      }
      this.updateClonePaintPreviews?.();
      return true;
    },

    texturePaintLiveCompositeMaterialLayerDisplay(material = null) {
      const stack = material?.userData?.texturePaintLayerStack || null;
      if (!stack?.layers?.length) {
        return false;
      }
      const displayLayer = this.texturePaintDisplayLayerForStack?.(stack);
      const targetEntry = displayLayerGpuTarget(material, stack, displayLayer);
      const liveComposite = targetEntry?.target?.texture
        ? this.texturePaintLiveCompositeTargetForLayerGpuPaint?.(material, targetEntry)
        : null;
      if (!liveComposite?.shaderComposite) {
        return false;
      }
      this.texturePaintRestoreLiveLayerShaderDisplayState?.(material, targetEntry, liveComposite);
      return true;
    },

    texturePaintRestoreLiveLayerShaderDisplayState(material = null, targetEntry = null, liveComposite = null) {
      if (!liveComposite?.shaderComposite || !material?.userData || !targetEntry?.target?.texture) {
        return false;
      }
      const state = material.userData.texturePaintLiveLayerShaderComposite || null;
      if (!state) {
        return false;
      }
      const layerOpacity = targetEntry.layer?.visible === false ? 0 : clamp01(targetEntry.layer?.opacity, 1);
      state.layerTexture = targetEntry.target.texture;
      state.layerOpacity = layerOpacity;
      let restoredUniform = false;
      if (state.shader?.uniforms?.texturePaintLiveLayerMap) {
        state.shader.uniforms.texturePaintLiveLayerMap.value = targetEntry.target.texture;
        restoredUniform = true;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerOpacity) {
        state.shader.uniforms.texturePaintLiveLayerOpacity.value = layerOpacity;
        restoredUniform = true;
      }
      if (!restoredUniform) {
        material.needsUpdate = true;
      }
      targetEntry.liveCompositeLayerOpacity = layerOpacity;
      return true;
    },

    async flushTexturePaintLayerGpuTargetsToCanvases(options = {}) {
      const renderer = this.renderer || null;
      if (
        !renderer?.isWebGPURenderer
        || !renderer?.backend?.isWebGPUBackend
        || typeof renderer.readRenderTargetPixelsAsync !== "function"
      ) {
        return 0;
      }
      const materialFilter = options.material || null;
      const materials = materialFilter
        ? [materialFilter]
        : (this.textureAirbrushPaintableMaterials?.() || [])
          .map((entry) => entry?.material || entry)
          .filter(Boolean);
      const uniqueMaterials = [...new Set(materials)];
      let flushed = 0;
      const compositedMaterials = new Set();
      for (const material of uniqueMaterials) {
        const stack = material?.userData?.texturePaintLayerStack || null;
        if (!stack?.layers?.length) {
          continue;
        }
        let materialFlushed = 0;
        for (const layer of stack.layers) {
          const targetEntry = layer?.gpuTarget || null;
          const target = targetEntry?.target || null;
          const canvas = layer?.canvas || null;
          if (!target?.texture || !canvas) {
            continue;
          }
          const paintRevision = Math.max(0, Math.floor(Number(targetEntry.paintRevision) || 0));
          if (options.force !== true && targetEntry.canvasSyncedRevision === paintRevision) {
            continue;
          }
          const width = Math.max(1, Math.floor(Number(targetEntry.width || target.width || canvas.width) || 1));
          const height = Math.max(1, Math.floor(Number(targetEntry.height || target.height || canvas.height) || 1));
          let readback = null;
          try {
            readback = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
          } catch (error) {
            targetEntry.lastCanvasSyncError = String(error?.message || error || "readback failed");
            continue;
          }
          const bytes = layerGpuReadbackBytes(readback);
          const copied = copyLayerGpuBytesToCanvas(bytes, canvas, width, height, {
            premultiplied: targetEntry.premultipliedAlpha !== false
          });
          if (!copied) {
            targetEntry.lastCanvasSyncError = "copy failed";
            continue;
          }
          targetEntry.lastCanvasSyncError = "";
          targetEntry.canvasSyncedRevision = paintRevision;
          targetEntry.canvasSyncedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
          layer.isEmpty = copied.hasAlpha !== true;
          layer.texturePaintHasPaint = copied.hasAlpha === true;
          layer.texturePaintGpuPainted = copied.hasAlpha === true;
          targetEntry.texturePaintLayerHasPaint = copied.hasAlpha === true;
          targetEntry.emptyTransparent = copied.hasAlpha !== true;
          if (layer.texture) {
            layer.texture.needsUpdate = true;
          }
          flushed += 1;
          materialFlushed += 1;
        }
        if (materialFlushed > 0 && options.composite !== false && !compositedMaterials.has(material)) {
          compositedMaterials.add(material);
          this.texturePaintCompositeMaterialLayers?.(material, {
            skipGpuFlush: true,
            preserveWebGpuDisplay: options.preserveWebGpuDisplay === true,
            preferCpuDisplay: options.preferCpuDisplay === true
          });
        }
      }
      if (flushed > 0 && options.renderPanel !== false) {
        this.scheduleTexturePaintLayerPanelRender?.();
      }
      return flushed;
    },

    texturePaintBaseOnlyMaterialLayerDisplay(material = null, stack = material?.userData?.texturePaintLayerStack || null) {
      if (!material?.userData || !stack?.baseCanvas) {
        return false;
      }
      if ((stack.layers || []).some((layer) => layerContributesVisiblePaint(layer))) {
        return false;
      }
      const sourceTexture = [
        material.userData.clonePaintTexture,
        material.userData.textureAirbrushWebGpuCanvasMap,
        material.userData.clonePaintOriginalMap,
        material.map
      ].map((texture) => texturePaintLayerStableReferenceTexture(material, texture))
        .find(Boolean)
        || null;
      const baseTexture = this.textureAirbrushCanvasTextureForLayerCanvas?.(
        stack,
        "base",
        stack.baseCanvas,
        sourceTexture
      ) || sourceTexture;
      if (!baseTexture) {
        return false;
      }
      if (!this.texturePaintMuteLiveLayerShaderComposite?.(material)) {
        this.texturePaintDisableLiveLayerShaderComposite?.(material);
      }
      if (material.map !== baseTexture) {
        material.map = baseTexture;
        material.needsUpdate = true;
      }
      return true;
    },

    texturePaintCompositeMaterialLayerDisplay(material, options = {}) {
      const stack = material?.userData?.texturePaintLayerStack || null;
      if (!stack?.baseCanvas) {
        return false;
      }
      if (this.texturePaintBaseOnlyMaterialLayerDisplay?.(material, stack)) {
        return true;
      }
      if (options.live !== false && this.texturePaintFastMaterialLayerDisplay?.(material, options)) {
        return true;
      }
      const canCompositeOnGpu = Boolean(
        this.renderer
        && typeof this.texturePaintCompositeMaterialLayerGpuTargets === "function"
        && (
          material.userData?.texturePaintCompositeGpuTarget?.target?.texture
          || (stack.layers || []).some((layer) => layer?.gpuTarget?.target?.texture)
        )
      );
      if (canCompositeOnGpu && this.texturePaintCompositeMaterialLayerGpuTargets(material)) {
        return true;
      }
      return this.texturePaintCompositeMaterialLayers(material, {
        ...options,
        skipGpuFlush: true
      });
    },

    texturePaintRestoreMaterialLayerDisplay(material = null) {
      if (!material?.userData?.texturePaintLayerStack) {
        return false;
      }
      this.flushTexturePaintLayerGpuTargetsToCanvases?.({
        material,
        composite: false
      });
      return this.texturePaintCompositeMaterialLayers(material, {
        skipGpuFlush: true
      });
    },

    scheduleTexturePaintLayerDisplayPrewarm(material = null, delayMs = 32) {
      const activeMaterial = material || this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.() || null;
      if (!activeMaterial) {
        return false;
      }
      cancelScheduled(this.texturePaintLayerDisplayPrewarmTimer);
      this.texturePaintLayerDisplayPrewarmTimer = scheduleLater(() => {
        this.texturePaintLayerDisplayPrewarmTimer = null;
        if (this.activeTool === "airbrush" && this.texturePaintLayerModeActive?.() === true) {
          this.prewarmTexturePaintActiveLayerMaterialGpu?.(activeMaterial, {
            preserveLayerDisplay: true
          });
          this.prewarmTexturePaintActiveLayerProjectionGpu?.(activeMaterial);
          this.prewarmTexturePaintActiveLayerCursorProbe?.(activeMaterial);
          return;
        }
        this.prewarmTexturePaintActiveLayerGpu?.(activeMaterial, { all: false });
      }, delayMs);
      return true;
    },

    prewarmTexturePaintActiveLayerForAction(material = null, options = {}) {
      const activeMaterial = material || this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.() || null;
      if (!activeMaterial) {
        return false;
      }
      if (this.activeTool !== "airbrush" || this.texturePaintLayerModeActive?.() !== true) {
        return this.prewarmTexturePaintActiveLayerGpu?.(activeMaterial, { all: false }) === true;
      }
      const prewarmOptions = layerAirbrushPrewarmOptions(options);
      let warmed = false;
      warmed = this.prewarmTexturePaintActiveLayerMaterialGpu?.(activeMaterial, prewarmOptions) === true || warmed;
      warmed = this.prewarmTexturePaintActiveLayerProjectionGpu?.(activeMaterial) === true || warmed;
      warmed = this.prewarmTexturePaintActiveLayerCursorProbe?.(activeMaterial) === true || warmed;
      if (typeof this.textureAirbrushPrewarmWebGpuEditable === "function") {
        const editable = this.editableClonePaintTexture?.(activeMaterial);
        const webGpuWarmed = this.textureAirbrushPrewarmWebGpuEditable?.(editable, activeMaterial, {
          ...prewarmOptions,
          material: activeMaterial,
          liveDisplayExternalTexture: prewarmOptions.liveDisplayExternalTexture === true,
          allowPrewarmLiveDisplayMaterialSwap: prewarmOptions.allowPrewarmLiveDisplayMaterialSwap === true,
          label: prewarmOptions.label || "texture-airbrush-layer-webgpu-prewarm"
        });
        warmed = Boolean(webGpuWarmed) || warmed;
      }
      const airbrushOptions = {
        all: false,
        force: true,
        immediateLayer: false,
        preserveLayerDisplay: prewarmOptions.preserveLayerDisplay === true,
        liveDisplayExternalTexture: prewarmOptions.liveDisplayExternalTexture === true,
        allowPrewarmLiveDisplayMaterialSwap: prewarmOptions.allowPrewarmLiveDisplayMaterialSwap === true,
        limit: 1,
        prewarmPaintablesWithoutHit: true,
        warmScreenHitIndex: true,
        warmNeighborTopology: false,
        tslSurfacePrewarmAll: true,
        tslSurfacePrewarmLimit: 1,
        renderCompilePass: true,
        delay: 0,
        material: activeMaterial,
        label: prewarmOptions.label || "texture-airbrush-layer-action-prewarm"
      };
      const immediateAirbrushWarm = this.textureAirbrushPrewarm?.(null, null, airbrushOptions) === true;
      warmed = immediateAirbrushWarm || warmed;
      if (!immediateAirbrushWarm) {
        this.scheduleTextureAirbrushPrewarm?.(null, null, airbrushOptions);
      }
      if (!warmed) {
        const fallbackPrewarmOptions = { all: false };
        if (prewarmOptions.preserveLayerDisplay === true) {
          fallbackPrewarmOptions.preserveLayerDisplay = true;
        }
        warmed = this.prewarmTexturePaintActiveLayerGpu?.(activeMaterial, fallbackPrewarmOptions) === true;
      }
      this.scheduleTextureAirbrushDeferredBroadLayerPrewarm?.();
      return warmed;
    },

    updateTexturePaintLayerOpacityReadout(layer = null) {
      if (!layer) {
        return false;
      }
      if (this.texturePaintLayerOpacity) {
        this.texturePaintLayerOpacity.value = String(clamp01(layer.opacity, 1));
      }
      if (this.texturePaintLayerOpacityOutput) {
        this.texturePaintLayerOpacityOutput.textContent = this.texturePaintLayerOpacityPercent(layer);
      }
      return true;
    },

    syncTexturePaintLayerPanelControls(stack = null) {
      if (!stack) {
        return false;
      }
      const panelLayers = this.texturePaintPanelLayers?.(stack) || [];
      const activeLayer = panelLayers.find((layer) => layer.id === stack.activeLayerId) || null;
      const activeIndex = activeLayer ? panelLayers.indexOf(activeLayer) : -1;
      const selectedLayerIds = this.texturePaintSelectedLayerIds(stack)
        .filter((id) => panelLayers.some((layer) => layer.id === id));
      if (this.texturePaintLayerDuplicateButton) {
        this.texturePaintLayerDuplicateButton.disabled = !activeLayer;
      }
      if (this.texturePaintLayerMergeButton) {
        this.texturePaintLayerMergeButton.disabled = selectedLayerIds.length < 2;
      }
      if (this.texturePaintLayerMoveUpButton) {
        this.texturePaintLayerMoveUpButton.disabled = !activeLayer || activeIndex >= panelLayers.length - 1;
      }
      if (this.texturePaintLayerMoveDownButton) {
        this.texturePaintLayerMoveDownButton.disabled = !activeLayer || activeIndex <= 0;
      }
      if (this.texturePaintLayerDeleteButton) {
        this.texturePaintLayerDeleteButton.disabled = !activeLayer;
      }
      if (this.texturePaintLayerBlendSelect) {
        this.texturePaintLayerBlendSelect.disabled = !activeLayer;
        this.texturePaintLayerBlendSelect.value = activeLayer
          ? this.texturePaintLayerBlendMode(activeLayer)
          : "normal";
      }
      if (this.texturePaintLayerOpacity) {
        this.texturePaintLayerOpacity.disabled = !activeLayer;
        this.texturePaintLayerOpacity.value = String(clamp01(activeLayer?.opacity, 1));
      }
      if (this.texturePaintLayerOpacityOutput) {
        this.texturePaintLayerOpacityOutput.textContent = activeLayer
          ? this.texturePaintLayerOpacityPercent(activeLayer)
          : "100%";
      }
      return true;
    },

    syncTexturePaintLayerPanelSelectionState(stack = null) {
      const list = this.texturePaintLayerList;
      if (!list || !stack) {
        return false;
      }
      this.syncTexturePaintLayerPanelControls?.(stack);
      for (const layer of this.texturePaintPanelLayers?.(stack) || []) {
        this.updateTexturePaintLayerPanelRowState?.(layer, stack);
      }
      const backgroundRow = list.querySelector?.("[data-layer-background]");
      if (backgroundRow) {
        const backgroundActive = this.texturePaintBackgroundSelected?.(stack) === true;
        backgroundRow.classList?.toggle?.("is-active", backgroundActive);
        backgroundRow.classList?.toggle?.("is-selected", backgroundActive);
      }
      return true;
    },

    updateTexturePaintLayerPanelRowState(layer = null, stack = null) {
      const list = this.texturePaintLayerList;
      if (!list || !layer?.id) {
        return false;
      }
      const selectedLayerIds = stack ? this.texturePaintSelectedLayerIds(stack) : [];
      const selectedLayerIdSet = new Set(selectedLayerIds);
      const rows = Array.from(list.children || []);
      const row = rows.find((candidate) => candidate?.dataset?.layerId === layer.id);
      if (!row) {
        return false;
      }
      row.classList?.toggle?.("is-active", layer.id === stack?.activeLayerId);
      row.classList?.toggle?.("is-selected", selectedLayerIdSet.has(layer.id));
      const eye = row.querySelector?.("[data-layer-visibility]");
      if (eye) {
        eye.title = layer.visible ? "Hide layer" : "Show layer";
        eye.setAttribute?.("aria-label", eye.title);
        eye.classList?.toggle?.("is-hidden", layer.visible === false);
      }
      const opacity = row.querySelector?.(".texture-layer-opacity-label");
      if (opacity) {
        opacity.textContent = this.texturePaintLayerOpacityPercent(layer);
      }
      return true;
    },

    texturePaintCommitEditable(editable = null, material = null, record = null, options = {}) {
      if (!editable?.layerMode) {
        return this.texturePaintSyncBackgroundFromEditable?.(material, editable, options) === true;
      }
      const skipGpuTargetUpload = options.skipGpuTargetUpload === true;
      if (editable.layer?.gpuLayerTexture && !skipGpuTargetUpload) {
        editable.layer.gpuLayerTexture.needsUpdate = true;
        if (editable.layer.gpuTarget?.target) {
          this.textureAirbrushCopyTextureToTarget?.(editable.layer.gpuLayerTexture, editable.layer.gpuTarget.target);
          this.markTexturePaintGpuTargetMutated?.(editable.layer.gpuTarget);
        }
      }
      if (editable.layer) {
        const hasCpuPaintMarker = Object.prototype.hasOwnProperty.call(editable.layer, "texturePaintCpuPainted");
        const hasGpuPaintMarker = Object.prototype.hasOwnProperty.call(editable.layer, "texturePaintGpuPainted");
        const hasAnyPaintMarker = hasCpuPaintMarker
          || hasGpuPaintMarker
          || Object.prototype.hasOwnProperty.call(editable.layer, "texturePaintHasPaint");
        const gpuHasPaint = layerHasGpuPaint(editable.layer);
        const explicitCanvasHasPaint = editable.layer.texturePaintCpuPainted === true;
        let canvasHasPaint = false;
        if (explicitCanvasHasPaint) {
          canvasHasPaint = true;
        } else if (!hasAnyPaintMarker && !skipGpuTargetUpload) {
          canvasHasPaint = true;
        } else if (editable.layer.isEmpty !== true || editable.layer.texturePaintHasPaint === true) {
          canvasHasPaint = !layerCanvasIsEmpty(editable.layer.canvas);
        } else {
          canvasHasPaint = !layerCanvasIsEmpty(editable.layer.canvas);
        }
        const layerHasPaint = gpuHasPaint || canvasHasPaint;
        editable.layer.isEmpty = !layerHasPaint;
        editable.layer.texturePaintHasPaint = layerHasPaint;
        if (gpuHasPaint) {
          editable.layer.texturePaintGpuPainted = true;
        } else if (canvasHasPaint) {
          editable.layer.texturePaintCpuPainted = true;
        }
        if (editable.layer.gpuTarget) {
          editable.layer.gpuTarget.emptyTransparent = !layerHasPaint;
          editable.layer.gpuTarget.texturePaintLayerHasPaint = layerHasPaint;
        }
      }
      const composited = this.texturePaintCompositeMaterialLayers(material, {
        dirtyBounds: editable.dirtyBounds,
        preferCpuDisplay: true,
        skipGpuFlush: options.skipGpuFlush === true || skipGpuTargetUpload,
        preserveWebGpuDisplay: options.preserveWebGpuDisplay === true
      });
      if (composited) {
        if (options.preserveWebGpuDisplay !== true) {
          this.textureAirbrushInvalidateWebGpuCache?.(editable);
        }
        if (options.refreshSpotlight !== false) {
          this.refreshCloneSpotlightTextures?.(record);
        }
        if (options.renderPanel !== false) {
          this.scheduleTexturePaintLayerPanelRender?.();
        }
      }
      return composited;
    },

    scheduleTexturePaintLayerPanelRender(delayMs = 180) {
      if (!this.texturePaintLayerList) {
        return false;
      }
      cancelScheduled(this.texturePaintLayerPanelRenderTimer);
      this.texturePaintLayerPanelRenderTimer = scheduleLater(() => {
        this.texturePaintLayerPanelRenderTimer = null;
        this.renderTexturePaintLayerPanel?.();
      }, delayMs);
      return true;
    },

    texturePaintApplyLayerPixel(image, offset, color, alpha, options = {}) {
      const amount = clamp01(alpha, 0);
      if (amount <= 0) {
        return false;
      }
      const previousA = image.data[offset + 3] / 255;
      if (options.erase) {
        const nextA = clampByte(previousA * (1 - amount) * 255);
        if (image.data[offset + 3] === nextA) {
          return false;
        }
        image.data[offset + 3] = nextA;
        if (nextA === 0) {
          image.data[offset] = 0;
          image.data[offset + 1] = 0;
          image.data[offset + 2] = 0;
        }
        return true;
      }
      const nextAFloat = amount + previousA * (1 - amount);
      if (nextAFloat <= 0) {
        return false;
      }
      const previousWeight = previousA * (1 - amount);
      const nextR = clampByte((color.r * amount + image.data[offset] * previousWeight) / nextAFloat);
      const nextG = clampByte((color.g * amount + image.data[offset + 1] * previousWeight) / nextAFloat);
      const nextB = clampByte((color.b * amount + image.data[offset + 2] * previousWeight) / nextAFloat);
      const nextA = clampByte(nextAFloat * 255);
      if (
        image.data[offset] === nextR
        && image.data[offset + 1] === nextG
        && image.data[offset + 2] === nextB
        && image.data[offset + 3] === nextA
      ) {
        return false;
      }
      image.data[offset] = nextR;
      image.data[offset + 1] = nextG;
      image.data[offset + 2] = nextB;
      image.data[offset + 3] = nextA;
      return true;
    },

    disposeTexturePaintLayerGpuState(layer = null) {
      if (!layer) {
        return false;
      }
      this.invalidateTexturePaintLayerGpuCaches?.(layer);
      this.disposeTexturePaintGpuPrewarmSnapshot?.(layer.gpuTarget);
      layer.gpuTarget?.target?.dispose?.();
      layer.gpuLayerTexture?.dispose?.();
      delete layer.gpuTarget;
      delete layer.gpuLayerTexture;
      return true;
    },

    discardTexturePaintMaterialGpuComposite(material = null) {
      const userData = material?.userData || {};
      const composite = userData.texturePaintCompositeGpuTarget || null;
      const cloneTexture = userData.clonePaintTexture || null;
      this.texturePaintDisableLiveLayerShaderComposite?.(material);
      if (!composite) {
        return false;
      }
      if (cloneTexture && material.map === composite.target?.texture) {
        material.map = cloneTexture;
      }
      composite.target?.dispose?.();
      composite.scratchTarget?.dispose?.();
      composite.stagingTarget?.dispose?.();
      delete userData.texturePaintCompositeGpuTarget;
      if (material) {
        material.needsUpdate = true;
      }
      return true;
    },

    discardTexturePaintMaterialAirbrushGpuTarget(material = null) {
      const userData = material?.userData || {};
      const targetEntry = userData.textureAirbrushGpuTarget || null;
      this.texturePaintDisableLiveLayerShaderComposite?.(material);
      if (!targetEntry?.target) {
        return false;
      }
      const cloneTexture = userData.clonePaintTexture || null;
      if (cloneTexture && material.map === targetEntry.target.texture) {
        material.map = cloneTexture;
      }
      this.disposeTexturePaintGpuPrewarmSnapshot?.(targetEntry);
      targetEntry.target.dispose?.();
      delete userData.textureAirbrushGpuTarget;
      if (material) {
        material.needsUpdate = true;
      }
      return true;
    },

    resetTexturePaintMaterialLayerDisplayCache(material = null) {
      const stack = material?.userData?.texturePaintLayerStack || null;
      if (!material?.userData || !stack?.layers?.length) {
        return false;
      }
      this.invalidateTexturePaintMaterialGpuCaches?.(material, {
        resetSurfaceStroke: true
      });
      this.texturePaintDisableLiveLayerShaderComposite?.(material);
      this.discardTexturePaintMaterialGpuComposite?.(material);
      for (const layer of stack.layers) {
        resetLayerGpuDisplayCache(layer?.gpuTarget);
      }
      material.needsUpdate = true;
      return true;
    },

    resetTexturePaintLayerDisplayCaches(material = null) {
      const materials = [];
      if (material) {
        materials.push(material);
      } else {
        for (const paintable of this.textureAirbrushPaintableMaterials?.() || []) {
          if (paintable.material && !materials.includes(paintable.material)) {
            materials.push(paintable.material);
          }
        }
      }
      let reset = 0;
      for (const candidate of materials) {
        if (this.resetTexturePaintMaterialLayerDisplayCache?.(candidate)) {
          reset += 1;
        }
      }
      return reset;
    },

    texturePaintFirstLayerMaterial() {
      for (const record of this.paintRecords || []) {
        const materials = this.texturePaintMaterialsForRecord?.(record) || [];
        const material = materials.find((candidate) => candidate && (candidate.map || candidate.color));
        if (material) {
          return material;
        }
      }
      return null;
    },

    activeTexturePaintLayerStack() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      if (!material) {
        return null;
      }
      const editable = material.userData?.clonePaintCanvas && material.userData?.clonePaintContext
        ? {
            canvas: material.userData.clonePaintCanvas,
            context: material.userData.clonePaintContext,
            texture: material.userData.clonePaintTexture || material.map
          }
        : this.editableClonePaintTexture?.(material);
      return this.texturePaintLayerStackForMaterial(material, editable, { create: true });
    },

    addTexturePaintLayer() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      if (!material) {
        this.setStatus?.("Load a textured model before adding paint layers");
        return false;
      }
      this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.();
      this.flushTextureAirbrushGpuTargetsToCanvases?.();
      const editable = material.userData?.clonePaintCanvas && material.userData?.clonePaintContext
        ? {
            canvas: material.userData.clonePaintCanvas,
            context: material.userData.clonePaintContext,
            texture: material.userData.clonePaintTexture || material.map
          }
        : this.editableClonePaintTexture?.(material);
      const stack = this.texturePaintLayerStackForMaterial(material, editable, { create: true });
      const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(material);
      const reusableLayer = this.texturePaintReusableAutoLayer?.(stack);
      if (reusableLayer) {
        this.prepareTexturePaintLayerTargetChange?.();
        reusableLayer.autoCreated = false;
        if (reusableLayer.gpuTarget) {
          this.invalidateTexturePaintLayerGpuCaches?.(reusableLayer);
          resetLayerGpuDisplayCache(reusableLayer.gpuTarget);
          reusableLayer.gpuTarget.forceDisplayCompositeOnce = true;
        }
        this.texturePaintSetSingleLayerSelection(stack, reusableLayer.id);
        this.rememberTexturePaintLayerSelection?.(stack, reusableLayer);
        this.texturePaintActiveMaterial = material;
        this.invalidateTexturePaintMaterialGpuCaches?.(material, {
          resetSurfaceStroke: true
        });
        this.redoStack = [];
        this.updateUndoButton?.();
        this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
          label: "texture-airbrush-reused-layer-prewarm"
        }));
        this.renderTexturePaintLayerPanel?.();
        this.setStatus?.(`Added ${reusableLayer.name || "Paint 1"}`);
        this.pushTexturePaintLayerUndoState?.(
          `Add ${reusableLayer.name || "Paint 1"}`,
          undoBefore,
          this.captureTexturePaintLayerHistorySnapshot?.(material)
        );
        return true;
      }

      const previousLayerCount = stack.layers?.length || 0;
      this.prepareTexturePaintLayerMutation?.();
      const layer = this.texturePaintNewLayer(stack);
      if (!layer) {
        return false;
      }
      this.discardTexturePaintMaterialAirbrushGpuTarget?.(material);
      stack.layers.push(layer);
      this.texturePaintSetSingleLayerSelection(stack, layer.id);
      this.rememberTexturePaintLayerSelection?.(stack, layer);
      this.texturePaintActiveMaterial = material;
      this.invalidateTexturePaintMaterialGpuCaches?.(material, {
        resetSurfaceStroke: true
      });
      const firstLayerIsTransparent = previousLayerCount === 0 && layerEffectivelyEmpty(layer);
      if (previousLayerCount === 0 && !firstLayerIsTransparent) {
        this.texturePaintFastMaterialLayerDisplay?.(material, {
          changedLayer: layer
        });
      }
      this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
        label: "texture-airbrush-new-layer-prewarm"
      }));
      this.renderTexturePaintLayerPanel?.();
      this.setStatus?.(`Added ${layer.name}`);
      this.pushTexturePaintLayerUndoState?.(
        `Add ${layer.name}`,
        undoBefore,
        this.captureTexturePaintLayerHistorySnapshot?.(material)
      );
      return true;
    },

    deleteActiveTexturePaintLayer() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack;
      if (!material || !stack?.layers?.length) {
        return false;
      }
      if (!this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false })?.layer) {
        return false;
      }
      this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.();
      const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(material);
      this.prepareTexturePaintLayerMutation?.();
      const selectedIds = this.texturePaintSelectedLayerIds(stack);
      const deleteIds = selectedIds.length > 1 ? new Set(selectedIds) : new Set([stack.activeLayerId]);
      const deleteIndex = stack.layers.findIndex((layer) => deleteIds.has(layer.id));
      const removedLayers = stack.layers.filter((layer) => deleteIds.has(layer.id));
      this.invalidateTexturePaintMaterialGpuCaches?.(material, {
        resetSurfaceStroke: true
      });
      for (const layer of removedLayers) {
        this.disposeTexturePaintLayerGpuState?.(layer);
      }
      this.discardTexturePaintMaterialAirbrushGpuTarget?.(material);
      stack.layers = stack.layers.filter((layer) => !deleteIds.has(layer.id));
      if (stack.layers.length) {
        this.texturePaintSetSingleLayerSelection(
          stack,
          stack.layers[Math.min(Math.max(deleteIndex, 0), stack.layers.length - 1)]?.id || ""
        );
        const activeLayer = stack.layers.find((layer) => layer.id === stack.activeLayerId) || null;
        this.rememberTexturePaintLayerSelection?.(stack, activeLayer);
      } else {
        stack.activeLayerId = "";
        stack.selectedLayerIds = [];
        stack.selectionAnchorLayerId = "";
        this.rememberTexturePaintBackgroundSelection?.();
      }
      this.discardTexturePaintMaterialGpuComposite?.(material);
      this.texturePaintCompositeMaterialLayers(material);
      if (stack.layers.length) {
        this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
          label: "texture-airbrush-delete-layer-prewarm"
        }));
      }
      this.renderTexturePaintLayerPanel?.();
      this.setStatus?.(removedLayers.length > 1
        ? `Deleted ${removedLayers.length} layers`
        : `Deleted ${removedLayers[0]?.name || "layer"}`);
      this.pushTexturePaintLayerUndoState?.(
        removedLayers.length > 1 ? `Delete ${removedLayers.length} layers` : `Delete ${removedLayers[0]?.name || "layer"}`,
        undoBefore,
        this.captureTexturePaintLayerHistorySnapshot?.(material)
      );
      return true;
    },

    duplicateActiveTexturePaintLayer() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack;
      if (!material || !stack?.layers?.length) {
        return false;
      }
      if (!this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false })?.layer) {
        return false;
      }
      const index = stack.layers.findIndex((layer) => layer.id === stack.activeLayerId);
      const source = stack.layers[index >= 0 ? index : stack.layers.length - 1];
      if (!source?.canvas) {
        return false;
      }
      this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.();
      const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(material);
      this.prepareTexturePaintLayerMutation?.();
      const layer = this.texturePaintNewLayer(stack, {
        name: `${source.name || "Layer"} copy`,
        visible: source.visible !== false,
        opacity: source.opacity,
        blendMode: source.blendMode
      });
      if (!layer) {
        return false;
      }
      layer.context.drawImage(source.canvas, 0, 0, layer.canvas.width, layer.canvas.height);
      layer.isEmpty = layerCanvasIsEmpty(layer.canvas);
      layer.texturePaintHasPaint = layer.isEmpty !== true;
      layer.texturePaintCpuPainted = layer.isEmpty !== true;
      layer.texturePaintGpuPainted = false;
      stack.layers.splice((index >= 0 ? index : stack.layers.length - 1) + 1, 0, layer);
      this.texturePaintSetSingleLayerSelection(stack, layer.id);
      this.rememberTexturePaintLayerSelection?.(stack, layer);
      this.texturePaintCompositeMaterialLayers(material);
      this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
        label: "texture-airbrush-duplicate-layer-prewarm"
      }));
      this.renderTexturePaintLayerPanel?.();
      this.setStatus?.(`Duplicated ${source.name || "layer"}`);
      this.pushTexturePaintLayerUndoState?.(
        `Duplicate ${source.name || "layer"}`,
        undoBefore,
        this.captureTexturePaintLayerHistorySnapshot?.(material)
      );
      return true;
    },

    moveActiveTexturePaintLayer(direction = 0) {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack;
      const delta = Math.sign(Number(direction) || 0);
      if (!material || !stack?.layers?.length || !delta) {
        return false;
      }
      if (!this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false })?.layer) {
        return false;
      }
      const index = stack.layers.findIndex((layer) => layer.id === stack.activeLayerId);
      if (index < 0) {
        return false;
      }
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= stack.layers.length) {
        return false;
      }
      this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.();
      const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(material);
      this.prepareTexturePaintLayerMutation?.();
      const [layer] = stack.layers.splice(index, 1);
      stack.layers.splice(nextIndex, 0, layer);
      stack.activeLayerId = layer.id;
      this.texturePaintSelectedLayerIds(stack);
      this.rememberTexturePaintLayerSelection?.(stack, layer);
      this.texturePaintCompositeMaterialLayers(material);
      this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
        label: "texture-airbrush-select-layer-prewarm"
      }));
      this.renderTexturePaintLayerPanel?.();
      this.pushTexturePaintLayerUndoState?.(
        "Move paint layer",
        undoBefore,
        this.captureTexturePaintLayerHistorySnapshot?.(material)
      );
      return true;
    },

    mergeSelectedTexturePaintLayers() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack;
      if (!material || !stack?.layers?.length) {
        return false;
      }
      const selectedIds = new Set(this.texturePaintSelectedLayerIds(stack));
      const selectedEntries = stack.layers
        .map((layer, index) => ({ layer, index }))
        .filter((entry) => selectedIds.has(entry.layer.id));
      if (selectedEntries.length < 2) {
        this.setStatus?.("Select two or more paint layers to merge");
        return false;
      }
      this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.();
      const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(material);
      this.prepareTexturePaintLayerMutation?.();
      const mergedLayer = this.texturePaintNewLayer(stack, {
        name: "Merged Paint",
        visible: selectedEntries.some((entry) => entry.layer.visible !== false),
        opacity: 1
      });
      if (!mergedLayer) {
        return false;
      }
      mergedLayer.context.clearRect(0, 0, mergedLayer.canvas.width, mergedLayer.canvas.height);
      for (const { layer } of selectedEntries) {
        if (layer.visible === false || !layer.canvas) {
          continue;
        }
        mergedLayer.context.globalAlpha = clamp01(layer.opacity, 1);
        mergedLayer.context.globalCompositeOperation = this.texturePaintCanvasCompositeOperation?.(layer.blendMode) || "source-over";
        mergedLayer.context.drawImage(layer.canvas, 0, 0, mergedLayer.canvas.width, mergedLayer.canvas.height);
      }
      mergedLayer.context.globalAlpha = 1;
      mergedLayer.context.globalCompositeOperation = "source-over";
      mergedLayer.isEmpty = layerCanvasIsEmpty(mergedLayer.canvas);
      mergedLayer.texturePaintHasPaint = mergedLayer.isEmpty !== true;
      mergedLayer.texturePaintCpuPainted = mergedLayer.isEmpty !== true;
      mergedLayer.texturePaintGpuPainted = false;
      const insertIndex = selectedEntries[selectedEntries.length - 1].index;
      stack.layers = stack.layers.filter((layer) => !selectedIds.has(layer.id));
      stack.layers.splice(Math.min(insertIndex, stack.layers.length), 0, mergedLayer);
      this.texturePaintSetSingleLayerSelection(stack, mergedLayer.id);
      this.rememberTexturePaintLayerSelection?.(stack, mergedLayer);
      this.texturePaintCompositeMaterialLayers(material);
      this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
        label: "texture-airbrush-merge-layer-prewarm"
      }));
      this.renderTexturePaintLayerPanel?.();
      this.setStatus?.(`Merged ${selectedEntries.length} layers`);
      this.pushTexturePaintLayerUndoState?.(
        `Merge ${selectedEntries.length} layers`,
        undoBefore,
        this.captureTexturePaintLayerHistorySnapshot?.(material)
      );
      return true;
    },

    selectTexturePaintLayer(layerId, options = {}) {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack;
      const targetIndex = stack?.layers?.findIndex((layer) => layer.id === layerId) ?? -1;
      if (targetIndex < 0) {
        return false;
      }
      this.prepareTexturePaintLayerTargetChange?.({
        mutatedOnlyBackgroundTargets: true
      });
      const currentSelected = this.texturePaintSelectedLayerIds(stack);
      if (options.range) {
        const anchorIndex = stack.layers.findIndex((layer) => layer.id === stack.selectionAnchorLayerId);
        const start = Math.min(anchorIndex >= 0 ? anchorIndex : targetIndex, targetIndex);
        const end = Math.max(anchorIndex >= 0 ? anchorIndex : targetIndex, targetIndex);
        stack.selectedLayerIds = stack.layers.slice(start, end + 1).map((layer) => layer.id);
      } else if (options.additive) {
        if (currentSelected.includes(layerId) && currentSelected.length > 1) {
          stack.selectedLayerIds = currentSelected.filter((id) => id !== layerId);
        } else if (!currentSelected.includes(layerId)) {
          stack.selectedLayerIds = [...currentSelected, layerId];
        } else {
          stack.selectedLayerIds = currentSelected;
        }
        stack.selectionAnchorLayerId = layerId;
      } else {
        stack.selectedLayerIds = [layerId];
        stack.selectionAnchorLayerId = layerId;
      }
      stack.activeLayerId = layerId;
      this.texturePaintSelectedLayerIds(stack);
      if (!stack.selectedLayerIds.includes(stack.activeLayerId)) {
        stack.activeLayerId = stack.selectedLayerIds[stack.selectedLayerIds.length - 1] || layerId;
      }
      const activeLayer = stack.layers.find((layer) => layer.id === stack.activeLayerId) || null;
      this.rememberTexturePaintLayerSelection?.(stack, activeLayer);
      this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
        label: "texture-airbrush-select-layer-prewarm"
      }));
      if (!this.syncTexturePaintLayerPanelSelectionState?.(stack)) {
        this.renderTexturePaintLayerPanel?.();
      }
      return true;
    },

    selectTexturePaintBackground() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      let stack = material?.userData?.texturePaintLayerStack || null;
      if (!stack && material) {
        const editable = material.userData?.clonePaintCanvas && material.userData?.clonePaintContext
          ? {
              canvas: material.userData.clonePaintCanvas,
              context: material.userData.clonePaintContext,
              texture: material.userData.clonePaintTexture || material.map
            }
          : this.editableClonePaintTexture?.(material);
        stack = this.texturePaintLayerStackForMaterial(material, editable, { create: true });
      }
      if (!stack) {
        return false;
      }
      this.prepareTexturePaintLayerTargetChange?.();
      this.texturePaintSetBackgroundSelection(stack);
      this.rememberTexturePaintBackgroundSelection?.();
      this.texturePaintActiveMaterial = material;
      this.renderTexturePaintLayerPanel?.();
      return true;
    },

    toggleTexturePaintLayerVisibility(layerId) {
      const entries = this.texturePaintLayerEntriesForId?.(layerId) || [];
      const activeEntry = entries.find((entry) => entry.material === this.texturePaintActiveMaterial) || entries[0] || null;
      if (!activeEntry?.layer) {
        return false;
      }
      this.prepareTexturePaintLayerDisplayMutation?.();
      const nextVisible = activeEntry.layer.visible === false;
      for (const { material, layer } of entries) {
        layer.visible = nextVisible;
        if (layerGpuTargetHasTslSurfaceDisplayCache(layer)) {
          resetLayerGpuDisplayCache(layer.gpuTarget);
          this.texturePaintDisableLiveLayerShaderComposite?.(material);
          this.cancelTexturePaintLayerDisplayComposite?.(material);
        }
        this.texturePaintApplyLayerDisplayChange(material, {
          changedLayer: layer
        });
      }
      const rowUpdated = this.updateTexturePaintLayerPanelRowState?.(activeEntry.layer, activeEntry.stack) === true;
      if (!rowUpdated) {
        this.scheduleTexturePaintLayerPanelRender?.(120) || this.renderTexturePaintLayerPanel?.();
      }
      return true;
    },

    setTexturePaintLayerOpacity(layerId, opacity) {
      const entries = this.texturePaintLayerEntriesForId?.(layerId) || [];
      const activeEntry = entries.find((entry) => entry.material === this.texturePaintActiveMaterial) || entries[0] || null;
      if (!activeEntry?.layer) {
        return false;
      }
      const nextOpacity = clamp01(opacity, 1);
      const changedEntries = entries.filter(({ layer }) => (
        Math.abs(clamp01(layer.opacity, 1) - nextOpacity) >= 0.0001
      ));
      if (!changedEntries.length) {
        this.updateTexturePaintLayerOpacityReadout?.(activeEntry.layer);
        return false;
      }
      this.prepareTexturePaintLayerDisplayMutation?.();
      for (const { material, layer } of changedEntries) {
        layer.opacity = nextOpacity;
        this.texturePaintApplyLayerDisplayChange(material, {
          changedLayer: layer
        });
      }
      this.scheduleTexturePaintLayerDisplayPrewarm?.(activeEntry.material);
      this.updateTexturePaintLayerOpacityReadout?.(activeEntry.layer);
      if (activeEntry.stack.activeLayerId === activeEntry.layer.id) {
        this.rememberTexturePaintLayerSelection?.(activeEntry.stack, activeEntry.layer);
      }
      this.updateTexturePaintLayerPanelRowState?.(activeEntry.layer, activeEntry.stack);
      this.scheduleTexturePaintLayerPanelRender?.(80) || this.renderTexturePaintLayerPanel?.();
      return true;
    },

    setTexturePaintLayerBlendMode(layerId, blendMode) {
      const entries = this.texturePaintLayerEntriesForId?.(layerId) || [];
      const activeEntry = entries.find((entry) => entry.material === this.texturePaintActiveMaterial) || entries[0] || null;
      if (!activeEntry?.layer) {
        return false;
      }
      const nextMode = normalizeLayerBlendMode(blendMode);
      const changedEntries = entries
        .map((entry) => ({
          ...entry,
          previousMode: this.texturePaintLayerBlendMode(entry.layer)
        }))
        .filter((entry) => entry.previousMode !== nextMode);
      if (!changedEntries.length) {
        if (this.texturePaintLayerBlendSelect) {
          this.texturePaintLayerBlendSelect.value = nextMode;
        }
        return false;
      }
      this.prepareTexturePaintLayerDisplayMutation?.();
      for (const { material, layer, previousMode } of changedEntries) {
        layer.blendMode = nextMode;
        const needsExactBlendDisplay = nextMode !== "normal" || previousMode !== "normal";
        if (needsExactBlendDisplay) {
          this.cancelTexturePaintLayerDisplayComposite?.(material);
          this.texturePaintCompositeMaterialLayerDisplay?.(material, {
            changedLayer: layer,
            live: false
          });
        } else {
          this.texturePaintApplyLayerDisplayChange(material, {
            changedLayer: layer
          });
        }
      }
      if (activeEntry.stack.activeLayerId === activeEntry.layer.id) {
        this.rememberTexturePaintLayerSelection?.(activeEntry.stack, activeEntry.layer);
      }
      this.scheduleTexturePaintLayerDisplayPrewarm?.(activeEntry.material);
      this.scheduleTexturePaintLayerPanelRender?.(80) || this.renderTexturePaintLayerPanel?.();
      return true;
    },

    renameTexturePaintLayer(layerId, name) {
      const entries = this.texturePaintLayerEntriesForId?.(layerId) || [];
      const activeEntry = entries.find((entry) => entry.material === this.texturePaintActiveMaterial) || entries[0] || null;
      if (!activeEntry?.layer) {
        return false;
      }
      const previousName = activeEntry.layer.name || this.texturePaintLayerName(activeEntry.stack);
      const nextName = this.normalizeTexturePaintLayerName?.(name, previousName) || previousName;
      const changedEntries = entries.filter(({ layer }) => layer.name !== nextName);
      if (!changedEntries.length) {
        this.renderTexturePaintLayerPanel?.();
        return false;
      }
      for (const { layer } of changedEntries) {
        layer.name = nextName;
      }
      if (activeEntry.stack?.activeLayerId === activeEntry.layer.id) {
        this.rememberTexturePaintLayerSelection?.(activeEntry.stack, activeEntry.layer);
      }
      this.renderTexturePaintLayerPanel?.();
      return true;
    },

    texturePaintLayerOpacityPercent(layer = null) {
      return `${Math.round(clamp01(layer?.opacity, 1) * 100)}%`;
    },

    texturePaintDrawLayerThumbnail(thumbnail, sourceCanvas = null) {
      const context = thumbnail?.getContext?.("2d");
      if (!thumbnail || !context) {
        return false;
      }
      context.clearRect(0, 0, thumbnail.width, thumbnail.height);
      if (sourceCanvas) {
        context.drawImage(sourceCanvas, 0, 0, thumbnail.width, thumbnail.height);
      }
      return true;
    },

    serializeTexturePaintLayers() {
      const entries = [];
      const serializableStacks = [];
      for (const record of this.paintRecords || []) {
        const materials = this.texturePaintMaterialsForRecord?.(record) || [];
        for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
          const material = materials[materialIndex];
          const stack = material?.userData?.texturePaintLayerStack;
          if (!stack?.layers?.length || !stack.baseCanvas?.toDataURL) {
            continue;
          }
          if (!stack.layers.some((layer) => !layerEffectivelyEmpty(layer))) {
            continue;
          }
          serializableStacks.push({ record, materialIndex, material, stack });
        }
      }
      if (!serializableStacks.length) {
        return entries;
      }
      this.flushTexturePaintLayerGpuTargetsToCanvases?.();
      for (const { record, materialIndex, material, stack } of serializableStacks) {
        const paintedLayers = stack.layers.filter((layer) => !layerCanvasIsEmpty(layer.canvas));
        if (!paintedLayers.length) {
          continue;
        }
        entries.push({
          mesh: record.object.name || "SkinnedMesh",
          materialIndex,
          materialName: material.name || "",
          width: stack.width,
          height: stack.height,
          activeLayerId: stack.activeLayerId || "",
          baseImage: stack.baseCanvas.toDataURL("image/png"),
          layers: stack.layers.map((layer) => ({
            id: layer.id,
            name: layer.name,
            visible: layer.visible !== false,
            opacity: clamp01(layer.opacity, 1),
            blendMode: this.texturePaintLayerBlendMode(layer),
            image: layer.canvas?.toDataURL?.("image/png") || ""
          }))
        });
      }
      return entries;
    },

    texturePaintApplyLayerStackImages(material, editable, entry, images = {}) {
      const stack = this.texturePaintLayerStackForMaterial(material, editable, { create: true });
      if (!stack?.baseCanvas || !stack.baseContext) {
        return false;
      }
      stack.baseContext.clearRect(0, 0, stack.baseCanvas.width, stack.baseCanvas.height);
      if (images.base) {
        stack.baseContext.drawImage(images.base, 0, 0, stack.baseCanvas.width, stack.baseCanvas.height);
      }
      stack.layers = [];
      for (const layerEntry of entry.layers || []) {
        const layer = this.texturePaintNewLayer(stack, {
          id: layerEntry.id,
          name: layerEntry.name || this.texturePaintLayerName(stack),
          visible: layerEntry.visible !== false,
          opacity: layerEntry.opacity,
          blendMode: layerEntry.blendMode
        });
        if (!layer) {
          continue;
        }
        const image = images.layers?.get(layerEntry.id);
        if (image) {
          layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
          layer.context.drawImage(image, 0, 0, layer.canvas.width, layer.canvas.height);
          layer.isEmpty = layerCanvasIsEmpty(layer.canvas);
          layer.texturePaintHasPaint = layer.isEmpty !== true;
          layer.texturePaintCpuPainted = layer.isEmpty !== true;
          layer.texturePaintGpuPainted = false;
        }
        stack.layers.push(layer);
      }
      if (!stack.layers.length) {
        const layer = this.texturePaintNewLayer(stack, { name: "Paint 1", autoCreated: true });
        if (layer) {
          stack.layers.push(layer);
        }
      }
      stack.activeLayerId = entry.activeLayerId && stack.layers.some((layer) => layer.id === entry.activeLayerId)
        ? entry.activeLayerId
        : stack.layers[stack.layers.length - 1]?.id || "";
      this.texturePaintSetSingleLayerSelection(stack, stack.activeLayerId);
      this.texturePaintActiveMaterial = material;
      this.texturePaintCompositeMaterialLayers(material);
      this.prewarmTexturePaintActiveLayerForAction?.(material, layerAirbrushPrewarmOptions({
        label: "texture-airbrush-load-layer-stack-prewarm"
      }));
      this.renderTexturePaintLayerPanel?.();
      return true;
    },

    renderTexturePaintLayerPanel() {
      const list = this.texturePaintLayerList;
      if (!list) {
        return false;
      }
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      let stack = material?.userData?.texturePaintLayerStack || null;
      if (!stack && material && this.model) {
        stack = this.activeTexturePaintLayerStack?.() || null;
      }
      const panelLayers = stack ? this.texturePaintPanelLayers?.(stack) || [] : [];
      const activeLayer = panelLayers.find((layer) => layer.id === stack?.activeLayerId) || null;
      const activeIndex = activeLayer ? panelLayers.indexOf(activeLayer) : -1;
      const backgroundActive = Boolean(stack) && !activeLayer;
      if (backgroundActive && stack) {
        this.texturePaintSetBackgroundSelection?.(stack);
      }
      const panelLayerIdSet = new Set(panelLayers.map((layer) => layer.id));
      const selectedLayerIds = stack
        ? this.texturePaintSelectedLayerIds(stack).filter((id) => panelLayerIdSet.has(id))
        : [];
      const selectedLayerIdSet = new Set(selectedLayerIds);
      if (this.texturePaintLayerAddButton) {
        this.texturePaintLayerAddButton.disabled = !this.model;
      }
      if (this.texturePaintLayerDuplicateButton) {
        this.texturePaintLayerDuplicateButton.disabled = !activeLayer;
      }
      if (this.texturePaintLayerMergeButton) {
        this.texturePaintLayerMergeButton.disabled = selectedLayerIds.length < 2;
      }
      if (this.texturePaintLayerMoveUpButton) {
        this.texturePaintLayerMoveUpButton.disabled = !activeLayer || activeIndex >= panelLayers.length - 1;
      }
      if (this.texturePaintLayerMoveDownButton) {
        this.texturePaintLayerMoveDownButton.disabled = !activeLayer || activeIndex <= 0;
      }
      if (this.texturePaintLayerDeleteButton) {
        this.texturePaintLayerDeleteButton.disabled = !activeLayer;
      }
      if (this.texturePaintLayerBlendSelect) {
        this.texturePaintLayerBlendSelect.disabled = !activeLayer;
        this.texturePaintLayerBlendSelect.value = activeLayer
          ? this.texturePaintLayerBlendMode(activeLayer)
          : "normal";
      }
      if (this.texturePaintLayerOpacity) {
        this.texturePaintLayerOpacity.disabled = !activeLayer;
        this.texturePaintLayerOpacity.value = String(clamp01(activeLayer?.opacity, 1));
      }
      if (this.texturePaintLayerOpacityOutput) {
        this.texturePaintLayerOpacityOutput.textContent = activeLayer
          ? this.texturePaintLayerOpacityPercent(activeLayer)
          : "100%";
      }
      list.replaceChildren?.();
      const appendThumbnail = (parent, sourceCanvas) => {
        const thumbnail = document.createElement("canvas");
        thumbnail.className = "texture-layer-thumbnail";
        thumbnail.width = 68;
        thumbnail.height = 44;
        thumbnail.setAttribute("aria-hidden", "true");
        this.texturePaintDrawLayerThumbnail(thumbnail, sourceCanvas);
        parent.append(thumbnail);
      };
      const appendBackgroundRow = (sourceCanvas = null) => {
        const baseRow = document.createElement("div");
        baseRow.className = "texture-layer-row is-locked";
        baseRow.classList.toggle("is-active", backgroundActive || !stack);
        baseRow.classList.toggle("is-selected", backgroundActive || !stack);
        baseRow.dataset.layerBackground = "true";
        baseRow.title = "Background texture";

        const baseEye = document.createElement("button");
        baseEye.type = "button";
        baseEye.className = "texture-layer-visibility";
        baseEye.disabled = true;
        baseEye.title = "Base texture is always visible";
        baseEye.setAttribute("aria-label", baseEye.title);

        const baseThumbnail = document.createElement("button");
        baseThumbnail.type = "button";
        baseThumbnail.className = "texture-layer-thumbnail-button";
        baseThumbnail.dataset.layerBackground = "true";
        baseThumbnail.title = "Select Background";
        baseThumbnail.setAttribute("aria-label", baseThumbnail.title);
        appendThumbnail(baseThumbnail, sourceCanvas);

        const baseName = document.createElement("button");
        baseName.type = "button";
        baseName.className = "texture-layer-name";
        baseName.dataset.layerBackground = "true";
        baseName.textContent = this.texturePaintBackgroundLayerName?.() || "Background";

        const baseOpacity = document.createElement("span");
        baseOpacity.className = "texture-layer-opacity-label";
        baseOpacity.textContent = "100%";

        baseRow.append(baseEye, baseThumbnail, baseName, baseOpacity);
        list.append(baseRow);
      };
      if (!stack) {
        if (this.model) {
          appendBackgroundRow();
        } else {
          const empty = document.createElement("div");
          empty.className = "texture-layer-empty";
          empty.textContent = "Load a model";
          list.append(empty);
        }
        return true;
      }
      for (const layer of [...panelLayers].reverse()) {
        const row = document.createElement("div");
        row.className = "texture-layer-row";
        row.classList.toggle("is-active", layer.id === stack.activeLayerId);
        row.classList.toggle("is-selected", selectedLayerIdSet.has(layer.id));
        row.dataset.layerId = layer.id;

        const eye = document.createElement("button");
        eye.type = "button";
        eye.className = "texture-layer-visibility";
        eye.dataset.layerVisibility = layer.id;
        eye.title = layer.visible ? "Hide layer" : "Show layer";
        eye.setAttribute("aria-label", eye.title);
        eye.classList.toggle("is-hidden", layer.visible === false);

        const thumbnailButton = document.createElement("button");
        thumbnailButton.type = "button";
        thumbnailButton.className = "texture-layer-thumbnail-button";
        thumbnailButton.dataset.layerSelect = layer.id;
        thumbnailButton.title = `Select ${layer.name || "layer"}`;
        thumbnailButton.setAttribute("aria-label", thumbnailButton.title);
        appendThumbnail(thumbnailButton, layer.canvas);

        const name = document.createElement("input");
        name.type = "text";
        name.className = "texture-layer-name";
        name.dataset.layerRename = layer.id;
        name.value = layer.name || "Layer";
        name.maxLength = 64;
        name.spellcheck = false;
        name.autocomplete = "off";
        name.title = "Rename layer";
        name.setAttribute("aria-label", `Rename ${layer.name || "layer"}`);

        const opacity = document.createElement("span");
        opacity.className = "texture-layer-opacity-label";
        opacity.textContent = this.texturePaintLayerOpacityPercent(layer);

        row.append(eye, thumbnailButton, name, opacity);
        list.append(row);
      }
      appendBackgroundRow(stack.baseCanvas);
      return true;
    }
  });
}
