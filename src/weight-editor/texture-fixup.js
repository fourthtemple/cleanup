import {
  TEXTURE_FIXUP_DEFAULT_PADDING,
  textureFixupExportDimensions,
  textureFixupFiniteInteger as finiteInteger,
  textureFixupPaddedBounds
} from "./texture-fixup/core.js";
import {
  createTextureFixupCanvas,
  textureFixupCanvasBlob,
  textureFixupCanvasContext,
  textureFixupDecodeImage,
  textureFixupDownloadName,
  textureFixupForceOpaque,
  textureFixupMaskedCropCanvas,
  textureFixupReadOnlyTextureSource
} from "./texture-fixup/canvas.js";
import {
  textureFixupComponentsBounds,
  textureFixupDominantComponents,
  textureFixupImportedLayerCanvas,
  textureFixupLayoutOutputBounds,
  textureFixupMaskComponents,
  textureFixupPackComponents,
  textureFixupPackedCropCanvas
} from "./texture-fixup/layout.js";
import {
  installTextureFixupColorGradeMethods,
  TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS,
  textureFixupColorGradeImageData,
  textureFixupColorGradeIsNeutral,
  textureFixupColorHistogram,
  textureFixupDrawColorHistogram,
  textureFixupImageOpaqueBounds,
  textureFixupNormalizeColorGrade
} from "./texture-fixup/color-grade.js";
import { textureFixupClipMaskToMaterialUvOccupancy } from "./texture-fixup/uv-occupancy.js";
export {
  TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS,
  textureFixupCanvasBlob,
  textureFixupColorGradeImageData,
  textureFixupColorGradeIsNeutral,
  textureFixupColorHistogram,
  textureFixupComponentsBounds,
  textureFixupDominantComponents,
  textureFixupDrawColorHistogram,
  textureFixupExportDimensions,
  textureFixupForceOpaque,
  textureFixupImageOpaqueBounds,
  textureFixupImportedLayerCanvas,
  textureFixupLayoutOutputBounds,
  textureFixupMaskedCropCanvas,
  textureFixupMaskComponents,
  textureFixupNormalizeColorGrade,
  textureFixupPackComponents,
  textureFixupPackedCropCanvas,
  textureFixupPaddedBounds
};

function clamp01(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function textureFixupSelectionCanImport(selection = null) {
  return Boolean(selection?.material && selection?.maskCanvas && selection?.bounds);
}

function textureFixupNormalizedBounds(bounds = null, width = 1, height = 1) {
  if (!bounds) {
    return null;
  }
  const canvasWidth = Math.max(1, finiteInteger(width, 1));
  const canvasHeight = Math.max(1, finiteInteger(height, 1));
  const rawX = Number(bounds.x ?? bounds.minX);
  const rawY = Number(bounds.y ?? bounds.minY);
  const rawWidth = Number(bounds.width ?? (Number(bounds.maxX) - rawX + 1));
  const rawHeight = Number(bounds.height ?? (Number(bounds.maxY) - rawY + 1));
  if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite) || rawWidth <= 0 || rawHeight <= 0) {
    return null;
  }
  const x = Math.max(0, Math.min(canvasWidth - 1, Math.floor(rawX)));
  const y = Math.max(0, Math.min(canvasHeight - 1, Math.floor(rawY)));
  const right = Math.max(x + 1, Math.min(canvasWidth, Math.ceil(rawX + rawWidth)));
  const bottom = Math.max(y + 1, Math.min(canvasHeight, Math.ceil(rawY + rawHeight)));
  return { x, y, width: right - x, height: bottom - y };
}

function textureFixupUnionBounds(first = null, second = null) {
  if (!first) {
    return second ? { ...second } : null;
  }
  if (!second) {
    return { ...first };
  }
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return { x, y, width: right - x, height: bottom - y };
}

function textureFixupReadbackBytes(readback = null) {
  if (!readback) {
    return null;
  }
  if (readback instanceof Uint8Array || readback instanceof Uint8ClampedArray) {
    return new Uint8Array(readback.buffer, readback.byteOffset || 0, readback.byteLength);
  }
  return readback.buffer
    ? new Uint8Array(readback.buffer, readback.byteOffset || 0, readback.byteLength)
    : null;
}

function textureFixupWeightedEdge(values, target, reverse = false) {
  let accumulated = 0;
  for (let offset = 0; offset < values.length; offset += 1) {
    const index = reverse ? values.length - 1 - offset : offset;
    accumulated += values[index];
    if (accumulated > target) {
      return index;
    }
  }
  return reverse ? values.length - 1 : 0;
}

export function textureFixupMaskAlphaInfo(maskCanvas = null, options = {}) {
  const context = textureFixupCanvasContext(maskCanvas, { willReadFrequently: true });
  if (!maskCanvas || !context) {
    return null;
  }
  const image = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  let minimumX = maskCanvas.width;
  let minimumY = maskCanvas.height;
  let maximumX = -1;
  let maximumY = -1;
  let count = 0;
  let alphaSum = 0;
  const alphaThreshold = Math.max(1, Math.min(255, finiteInteger(options.alphaThreshold, 1)));
  const columnAlpha = new Float64Array(maskCanvas.width);
  const rowAlpha = new Float64Array(maskCanvas.height);
  for (let pixelIndex = 0; pixelIndex < maskCanvas.width * maskCanvas.height; pixelIndex += 1) {
    const alpha = image.data[pixelIndex * 4 + 3];
    if (alpha < alphaThreshold) {
      continue;
    }
    const x = pixelIndex % maskCanvas.width;
    const y = Math.floor(pixelIndex / maskCanvas.width);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
    count += 1;
    alphaSum += alpha;
    columnAlpha[x] += alpha;
    rowAlpha[y] += alpha;
  }
  const trimFraction = Math.max(0, Math.min(0.05, Number(options.trimFraction) || 0));
  const trimTarget = alphaSum * trimFraction;
  const trimmedMinimumX = count > 0 && trimTarget > 0
    ? textureFixupWeightedEdge(columnAlpha, trimTarget)
    : minimumX;
  const trimmedMaximumX = count > 0 && trimTarget > 0
    ? textureFixupWeightedEdge(columnAlpha, trimTarget, true)
    : maximumX;
  const trimmedMinimumY = count > 0 && trimTarget > 0
    ? textureFixupWeightedEdge(rowAlpha, trimTarget)
    : minimumY;
  const trimmedMaximumY = count > 0 && trimTarget > 0
    ? textureFixupWeightedEdge(rowAlpha, trimTarget, true)
    : maximumY;
  const boundsPadding = Math.max(0, finiteInteger(options.boundsPadding, 0));
  const boundedMinimumX = Math.max(minimumX, Math.min(trimmedMinimumX, trimmedMaximumX) - boundsPadding);
  const boundedMaximumX = Math.min(maximumX, Math.max(trimmedMinimumX, trimmedMaximumX) + boundsPadding);
  const boundedMinimumY = Math.max(minimumY, Math.min(trimmedMinimumY, trimmedMaximumY) - boundsPadding);
  const boundedMaximumY = Math.min(maximumY, Math.max(trimmedMinimumY, trimmedMaximumY) + boundsPadding);
  return {
    count,
    alphaSum,
    bounds: count > 0
      ? {
          x: boundedMinimumX,
          y: boundedMinimumY,
          width: boundedMaximumX - boundedMinimumX + 1,
          height: boundedMaximumY - boundedMinimumY + 1
        }
      : null
  };
}

export function textureFixupCompositeLayerSource(editor, stack = null) {
  const width = stack?.baseCanvas?.width || stack?.width || 0;
  const height = stack?.baseCanvas?.height || stack?.height || 0;
  const canvas = createTextureFixupCanvas(editor, width, height);
  const context = textureFixupCanvasContext(canvas, { willReadFrequently: true });
  if (!canvas || !context || !stack?.baseCanvas) {
    return null;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(stack.baseCanvas, 0, 0, canvas.width, canvas.height);
  context.save();
  for (const layer of stack.layers || []) {
    const kind = editor?.texturePaintLayerKind?.(layer) || String(layer?.kind || "paint");
    if (!layer?.canvas || layer.visible === false || kind === "fixup-mask") {
      continue;
    }
    context.globalAlpha = clamp01(layer.opacity, 1);
    context.globalCompositeOperation = editor?.texturePaintCanvasCompositeOperation?.(layer.blendMode) || "source-over";
    context.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height);
  }
  context.restore();
  return { canvas, context };
}

export function installTextureFixupMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureFixupPaddingValue() {
      return Math.max(0, finiteInteger(this.textureFixupPadding?.value, TEXTURE_FIXUP_DEFAULT_PADDING));
    },

    updateTextureFixupOutputs() {
      if (this.textureFixupPaddingOutput) {
        this.textureFixupPaddingOutput.textContent = `${this.textureFixupPaddingValue()}px`;
      }
      this.updateTextureFixupColorGradeOutputs?.();
    },

    textureFixupActiveMaskEntry() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack || null;
      const active = this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false }) || null;
      if (!material || !active?.layer || this.texturePaintLayerKind?.(active.layer) !== "fixup-mask") {
        return null;
      }
      return { material, stack: active.stack, layer: active.layer };
    },

    syncTextureFixupControls() {
      const maskEntry = this.textureFixupActiveMaskEntry?.() || null;
      const hasMask = Boolean(maskEntry?.layer?.canvas);
      const hasSelection = textureFixupSelectionCanImport(this.textureFixupSelection);
      const disabled = this.textureFixupBusy === true;
      if (this.textureFixupNewMaskButton) {
        this.textureFixupNewMaskButton.disabled = disabled || !this.model;
      }
      if (this.textureFixupExportButton) {
        this.textureFixupExportButton.disabled = disabled || !hasMask;
      }
      if (this.textureFixupImportButton) {
        this.textureFixupImportButton.disabled = disabled || (!hasSelection && !hasMask);
      }
      if (this.textureFixupClearButton) {
        this.textureFixupClearButton.disabled = disabled || !hasMask;
      }
      this.syncTextureFixupColorGradeControls?.();
      if (!disabled) {
        this.syncTextureFixupPanelStatus?.(maskEntry);
      }
      return hasMask;
    },

    openTextureFixupFilePicker() {
      const input = this.textureFixupFileInput || null;
      if (!input || this.textureFixupBusy === true || this.textureFixupImportButton?.disabled === true) {
        return false;
      }
      input.value = "";
      if (typeof input.showPicker === "function") {
        try {
          input.showPicker();
          return true;
        } catch (error) {
          console.warn("Texture fixup native file picker failed; falling back to input click", error);
        }
      }
      if (typeof input.click === "function") {
        input.click();
        return true;
      }
      this.setStatus?.("Could not open the texture import picker");
      return false;
    },

    syncTextureFixupPanelStatus(maskEntry = null) {
      const selection = this.textureFixupSelection || null;
      if (maskEntry?.layer) {
        if (selection?.maskLayerId === maskEntry.layer.id && selection.cropCanvas) {
          const layout = selection.exportLayout || selection.layout || null;
          const regionCount = layout?.items?.length || 1;
          const pixelText = selection.pixelCount > 0
            ? `${selection.pixelCount.toLocaleString()} pixels - `
            : "";
          this.setTextureFixupPanelStatus?.(
            `${maskEntry.layer.name || "Fixup Mask"} - ${pixelText}${regionCount} region${regionCount === 1 ? "" : "s"} - export ${selection.cropCanvas.width} x ${selection.cropCanvas.height}px`
          );
        } else {
          this.setTextureFixupPanelStatus?.(
            `${maskEntry.layer.name || "Fixup Mask"} - paint the area to repair`
          );
        }
        return true;
      }
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack || null;
      const active = this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false }) || null;
      if (/^AI Fixup\b/i.test(active?.layer?.name || "") && selection) {
        const layout = selection.exportLayout || selection.layout || null;
        const regionCount = layout?.items?.length || 1;
        this.setTextureFixupPanelStatus?.(
          `${active.layer.name} - ${regionCount} imported region${regionCount === 1 ? "" : "s"}`
        );
        return true;
      }
      this.setTextureFixupPanelStatus?.(
        this.model ? "Select a Fixup Mask layer" : "Create or select a Fixup Mask layer"
      );
      return false;
    },

    setTextureFixupPanelStatus(message = "Create or select a Fixup Mask layer") {
      if (this.textureFixupStatus) {
        this.textureFixupStatus.textContent = message;
      }
    },

    clearTextureFixupPreview() {
      const context = textureFixupCanvasContext(this.textureFixupPreview);
      if (context && this.textureFixupPreview) {
        context.clearRect(0, 0, this.textureFixupPreview.width, this.textureFixupPreview.height);
      }
    },

    textureFixupMaskStrokeBounds(stroke = null, layer = null) {
      if (!layer?.canvas) {
        return null;
      }
      const width = layer.canvas.width;
      const height = layer.canvas.height;
      let touched = !stroke;
      let bounds = null;
      for (const entry of stroke?.before || []) {
        const entryLayer = entry?.layer || entry?.targetEntry?.layer || null;
        if (entryLayer !== layer && (!entryLayer?.id || entryLayer.id !== layer.id)) {
          continue;
        }
        touched = true;
        bounds = textureFixupUnionBounds(
          bounds,
          textureFixupNormalizedBounds(entry.bounds, width, height)
        );
        for (const region of entry.regions || []) {
          bounds = textureFixupUnionBounds(
            bounds,
            textureFixupNormalizedBounds(region?.bounds, width, height)
          );
        }
      }
      if (!touched) {
        return null;
      }
      const stats = this.textureAirbrushLastWebGpuPaintStats || null;
      if (!stats?.tslSurfaceLayerName || stats.tslSurfaceLayerName === layer.name) {
        bounds = textureFixupUnionBounds(
          bounds,
          textureFixupNormalizedBounds(stats?.dirtyBounds, width, height)
        );
      }
      bounds = textureFixupUnionBounds(layer.textureFixupPreviewBounds, bounds);
      if (bounds) {
        layer.textureFixupPreviewBounds = bounds;
      }
      return bounds;
    },

    async textureFixupMaskPreviewCanvas(entry = null, bounds = null) {
      const layer = entry?.layer || null;
      const normalized = textureFixupNormalizedBounds(bounds, layer?.canvas?.width, layer?.canvas?.height);
      if (!layer?.canvas || !normalized) {
        return null;
      }
      const targetEntry = layer.gpuTarget || null;
      const target = targetEntry?.target || null;
      const renderer = this.renderer || null;
      if (
        target?.texture
        && renderer?.isWebGPURenderer
        && typeof renderer.readRenderTargetPixelsAsync === "function"
      ) {
        const readback = await renderer.readRenderTargetPixelsAsync(
          target,
          normalized.x,
          normalized.y,
          normalized.width,
          normalized.height
        );
        const bytes = textureFixupReadbackBytes(readback);
        if (bytes?.length >= normalized.width * normalized.height * 4) {
          const canvas = createTextureFixupCanvas(this, normalized.width, normalized.height);
          const context = textureFixupCanvasContext(canvas);
          if (canvas && context) {
            const image = context.createImageData(canvas.width, canvas.height);
            for (let pixelIndex = 0; pixelIndex < canvas.width * canvas.height; pixelIndex += 1) {
              const offset = pixelIndex * 4;
              image.data[offset] = 255;
              image.data[offset + 1] = 255;
              image.data[offset + 2] = 255;
              image.data[offset + 3] = bytes[offset + 3] || 0;
            }
            context.putImageData(image, 0, 0);
            return { canvas, bounds: normalized };
          }
        }
      }
      return this.textureFixupMaskCanvasPreviewSource?.(layer.canvas, normalized);
    },

    textureFixupMaskCanvasPreviewSource(maskCanvas = null, bounds = null) {
      const normalized = textureFixupNormalizedBounds(bounds, maskCanvas?.width, maskCanvas?.height);
      if (!maskCanvas || !normalized) {
        return null;
      }
      const canvas = createTextureFixupCanvas(this, normalized.width, normalized.height);
      const context = textureFixupCanvasContext(canvas);
      if (!canvas || !context) {
        return null;
      }
      context.drawImage(
        maskCanvas,
        normalized.x,
        normalized.y,
        normalized.width,
        normalized.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
      return { canvas, bounds: normalized };
    },

    renderTextureFixupMaskLayerPreview(previewSource = null, layer = null) {
      const preview = this.textureFixupPreview;
      const maskCanvas = previewSource?.canvas || null;
      const sourceBounds = previewSource?.bounds || null;
      const context = textureFixupCanvasContext(preview);
      if (!preview || !context || !maskCanvas || !sourceBounds) {
        return false;
      }
      const maskInfo = textureFixupMaskAlphaInfo(maskCanvas, {
        alphaThreshold: 8,
        trimFraction: 0.01,
        boundsPadding: 8
      });
      context.clearRect(0, 0, preview.width, preview.height);
      if (!maskInfo?.bounds) {
        this.setTextureFixupPanelStatus?.(`${layer?.name || "Fixup Mask"} is empty`);
        return false;
      }
      const localComponents = textureFixupMaskComponents(this, maskCanvas, {
        alphaThreshold: 8,
        maximumAnalysisSide: 384,
        maximumComponents: 48,
        minimumRelativeAlpha: 0.0005
      });
      const dominantComponents = textureFixupDominantComponents(localComponents);
      const components = (dominantComponents.length ? dominantComponents : [{ bounds: maskInfo.bounds }])
        .map((component) => ({
          ...component,
          bounds: {
            x: sourceBounds.x + component.bounds.x,
            y: sourceBounds.y + component.bounds.y,
            width: component.bounds.width,
            height: component.bounds.height
          }
        }));
      const refinedBounds = textureFixupComponentsBounds(components);
      const layout = textureFixupPackComponents(components, {
        textureWidth: layer.canvas.width,
        textureHeight: layer.canvas.height,
        padding: this.textureFixupPaddingValue(),
        gutter: 16
      });
      if (!refinedBounds || !layout) {
        this.setTextureFixupPanelStatus?.(`${layer?.name || "Fixup Mask"} is empty`);
        return false;
      }
      layer.textureFixupPreviewBounds = refinedBounds;
      const packedScale = Math.min(1, 512 / Math.max(layout.width, layout.height));
      const packedMask = textureFixupPackedCropCanvas(this, null, maskCanvas, layout, {
        rotate180: true,
        outputWidth: Math.max(1, Math.round(layout.width * packedScale)),
        outputHeight: Math.max(1, Math.round(layout.height * packedScale)),
        maskOriginX: sourceBounds.x,
        maskOriginY: sourceBounds.y
      });
      if (!packedMask) {
        return false;
      }
      const inset = 8;
      const scale = Math.min(
        (preview.width - inset * 2) / packedMask.width,
        (preview.height - inset * 2) / packedMask.height
      );
      const width = Math.max(1, packedMask.width * scale);
      const height = Math.max(1, packedMask.height * scale);
      const x = (preview.width - width) * 0.5;
      const y = (preview.height - height) * 0.5;
      context.drawImage(packedMask, x, y, width, height);
      context.globalCompositeOperation = "source-in";
      context.fillStyle = "#f0b85a";
      context.fillRect(x, y, width, height);
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = "rgba(240, 184, 90, 0.9)";
      context.lineWidth = 1;
      context.strokeRect(
        Math.round(x) + 0.5,
        Math.round(y) + 0.5,
        Math.max(0, Math.round(width) - 1),
        Math.max(0, Math.round(height) - 1)
      );
      const output = textureFixupExportDimensions(layout);
      this.setTextureFixupPanelStatus?.(
        `${layer.name || "Fixup Mask"} - ${layout.items.length} region${layout.items.length === 1 ? "" : "s"} - export ${output.width} x ${output.height}px`
      );
      return true;
    },

    scheduleTextureFixupMaskPreviewRefresh(stroke = null, delayMs = 100) {
      const entry = this.textureFixupActiveMaskEntry?.();
      const bounds = this.textureFixupMaskStrokeBounds?.(stroke, entry?.layer);
      if (!entry?.layer || !bounds) {
        return false;
      }
      const host = typeof window !== "undefined" ? window : globalThis;
      host.clearTimeout?.(this.textureFixupPreviewTimer);
      const serial = (this.textureFixupPreviewSerial || 0) + 1;
      this.textureFixupPreviewSerial = serial;
      const refresh = () => {
        if (serial !== this.textureFixupPreviewSerial) {
          return;
        }
        if (this.painting === true || this.textureFixupBusy === true) {
          this.textureFixupPreviewTimer = host.setTimeout?.(refresh, 120);
          return;
        }
        this.textureFixupPreviewTimer = null;
        void this.textureFixupMaskPreviewCanvas?.(entry, bounds).then((previewSource) => {
          if (serial !== this.textureFixupPreviewSerial) {
            return;
          }
          this.renderTextureFixupMaskLayerPreview?.(previewSource, entry.layer);
        }).catch((error) => {
          console.error("Texture fixup mask preview failed", error);
        });
      };
      this.textureFixupPreviewTimer = host.setTimeout?.(refresh, Math.max(0, finiteInteger(delayMs, 100)));
      return true;
    },

    async textureFixupCompositeSource(material = null) {
      if (!material) {
        return null;
      }
      await this.textureAirbrushSyncDeferredWebGpuCanvases?.({
        deferCanvasSyncUntilIdle: false,
        deferredCanvasSyncMaxTiles: false
      });
      await this.flushTexturePaintLayerGpuTargetsToCanvases?.({
        material,
        composite: false,
        force: true,
        renderPanel: false
      });
      const userData = material.userData || {};
      const stack = userData.texturePaintLayerStack || null;
      if (stack?.baseCanvas) {
        const composite = textureFixupCompositeLayerSource(this, stack);
        if (!composite) {
          return null;
        }
        return {
          ...composite,
          texture: userData.clonePaintTexture || material.map || null,
          editable: userData.clonePaintCanvas ? {
            canvas: userData.clonePaintCanvas,
            context: userData.clonePaintContext,
            texture: userData.clonePaintTexture || material.map || null
          } : null
        };
      }
      const existingCanvas = userData.clonePaintCanvas || null;
      if (existingCanvas) {
        const canvas = this.copyTexturePaintCanvas?.(existingCanvas) || existingCanvas;
        const context = textureFixupCanvasContext(canvas, { willReadFrequently: true });
        return context ? {
          canvas,
          context,
          texture: userData.clonePaintTexture || material.map || null,
          editable: null
        } : null;
      }
      return textureFixupReadOnlyTextureSource(this, material);
    },

    refreshTextureFixupCrop(source = null) {
      const selection = this.textureFixupSelection || null;
      const sourceCanvas = source?.canvas || selection?.sourceCanvas || null;
      if (!selection?.tightBounds || !selection?.maskCanvas || !sourceCanvas) {
        return false;
      }
      if (sourceCanvas.width !== selection.width || sourceCanvas.height !== selection.height) {
        this.clearTextureFixupSelection?.({ silent: true });
        this.setTextureFixupPanelStatus?.("Texture size changed; export the mask again");
        return false;
      }
      const components = selection.maskComponents?.length
        ? selection.maskComponents
        : [{ bounds: selection.tightBounds }];
      const layout = textureFixupPackComponents(components, {
        textureWidth: sourceCanvas.width,
        textureHeight: sourceCanvas.height,
        padding: this.textureFixupPaddingValue(),
        gutter: 16
      });
      const bounds = textureFixupPaddedBounds(
        selection.tightBounds,
        this.textureFixupPaddingValue(),
        sourceCanvas.width,
        sourceCanvas.height
      );
      const texture = source?.texture || selection.texture || selection.material?.map || null;
      if (!bounds || !layout) {
        return false;
      }
      const output = textureFixupExportDimensions(bounds);
      const presentationRotate180 = true;
      const cropCanvas = textureFixupMaskedCropCanvas(
        this,
        sourceCanvas,
        selection.maskCanvas,
        bounds,
        {
          outputWidth: output.width,
          outputHeight: output.height,
          rotate180: presentationRotate180,
          alphaThreshold: 8
        }
      );
      if (!cropCanvas) {
        return false;
      }
      selection.sourceCanvas = sourceCanvas;
      selection.texture = texture;
      selection.bounds = bounds;
      selection.layout = layout;
      selection.cropCanvas = cropCanvas;
      selection.exportScale = output.scale;
      selection.presentationRotate180 = presentationRotate180;
      this.syncTextureFixupControls?.();
      return true;
    },

    clearTextureFixupSelection(options = {}) {
      const host = typeof window !== "undefined" ? window : globalThis;
      host.clearTimeout?.(this.textureFixupPreviewTimer);
      this.textureFixupPreviewTimer = null;
      this.textureFixupPreviewSerial = (this.textureFixupPreviewSerial || 0) + 1;
      this.textureFixupSelection = null;
      this.clearTextureFixupPreview?.();
      this.setTextureFixupPanelStatus?.("Create or select a Fixup Mask layer");
      this.syncTextureFixupControls?.();
      if (options.silent !== true) {
        this.setStatus?.("Texture fixup export cleared");
      }
      return true;
    },

    createTextureFixupMaskLayer() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      if (!this.model || !material || this.textureFixupBusy) {
        this.setStatus?.("Load a textured model before creating a fixup mask");
        return false;
      }
      this.texturePaintActiveMaterial = material;
      const currentStack = material.userData?.texturePaintLayerStack || null;
      const maskNumber = (currentStack?.layers || [])
        .filter((layer) => this.texturePaintLayerKind?.(layer) === "fixup-mask")
        .length + 1;
      const layerName = `Fixup Mask ${maskNumber}`;
      if (this.addTexturePaintLayer?.({
        name: layerName,
        kind: "fixup-mask",
        opacity: 0.75
      }) !== true) {
        return false;
      }
      const maskEntry = this.textureFixupActiveMaskEntry?.();
      if (!maskEntry?.layer) {
        this.setStatus?.("Could not activate the new fixup mask");
        return false;
      }
      maskEntry.layer.visible = true;
      this.clearTextureFixupSelection?.({ silent: true });
      this.setTexturePaintNeighborMode?.(true, { status: false });
      this.setTool?.("airbrush");
      this.renderTexturePaintLayerPanel?.();
      this.setTextureFixupPanelStatus?.(`${layerName} - paint the area to repair`);
      this.setStatus?.("Fixup Mask: paint the repair area with Airbrush Neighbor mode");
      return true;
    },

    async refreshTextureFixupSelection() {
      const maskEntry = this.textureFixupActiveMaskEntry?.();
      if (!maskEntry?.material || !maskEntry.layer?.canvas) {
        this.setTextureFixupPanelStatus?.("Select a Fixup Mask layer before exporting");
        this.setStatus?.("Texture fixup needs an active Fixup Mask layer");
        return null;
      }
      const source = await this.textureFixupCompositeSource?.(maskEntry.material);
      const maskCanvas = this.copyTexturePaintCanvas?.(maskEntry.layer.canvas) || null;
      if (!source?.canvas || !maskCanvas) {
        this.setTextureFixupPanelStatus?.("The mask texture is unavailable");
        return null;
      }
      if (source.canvas.width !== maskCanvas.width || source.canvas.height !== maskCanvas.height) {
        this.setTextureFixupPanelStatus?.("The mask and source texture sizes do not match");
        return null;
      }
      const occupancyClip = textureFixupClipMaskToMaterialUvOccupancy(
        this,
        maskCanvas,
        maskEntry.material,
        source.texture || maskEntry.material?.map || null
      );
      const maskInfo = textureFixupMaskAlphaInfo(maskCanvas, {
        alphaThreshold: 8,
        trimFraction: 0.01,
        boundsPadding: 8
      });
      if (!maskInfo?.bounds || maskInfo.count === 0) {
        this.setTextureFixupPanelStatus?.("Paint the Fixup Mask before exporting");
        this.setStatus?.("The active Fixup Mask is empty");
        return null;
      }
      const maskComponents = textureFixupMaskComponents(this, maskCanvas, {
        alphaThreshold: 8,
        maximumAnalysisSide: 512,
        maximumComponents: 48,
        minimumRelativeAlpha: 0.0005
      });
      const dominantComponents = textureFixupDominantComponents(maskComponents);
      const components = dominantComponents.length
        ? dominantComponents
        : [{
            bounds: maskInfo.bounds,
            alphaSum: maskInfo.alphaSum,
            pixelCount: maskInfo.count
          }];
      const tightBounds = textureFixupComponentsBounds(components) || maskInfo.bounds;
      this.textureFixupSelection = {
        material: maskEntry.material,
        maskLayerId: maskEntry.layer.id,
        maskCanvas,
        tightBounds,
        maskComponents: components,
        bounds: null,
        layout: null,
        cropCanvas: null,
        sourceCanvas: source.canvas,
        texture: source.texture,
        width: source.canvas.width,
        height: source.canvas.height,
        pixelCount: maskInfo.count,
        alphaSum: maskInfo.alphaSum,
        uvOccupancyTriangleCount: occupancyClip?.triangleCount || 0,
        uvGutterPixelsRemoved: occupancyClip?.removedPixelCount || 0,
        presentationRotate180: true,
        exportBounds: null,
        exportLayout: null,
        exportRotate180: null,
        exportCropCanvas: null
      };
      maskEntry.layer.textureFixupPreviewBounds = tightBounds;
      if (!this.refreshTextureFixupCrop?.(source)) {
        return null;
      }
      const host = typeof window !== "undefined" ? window : globalThis;
      host.clearTimeout?.(this.textureFixupPreviewTimer);
      this.textureFixupPreviewTimer = null;
      this.textureFixupPreviewSerial = (this.textureFixupPreviewSerial || 0) + 1;
      const previewSource = this.textureFixupMaskCanvasPreviewSource?.(maskCanvas, tightBounds);
      this.renderTextureFixupMaskLayerPreview?.(previewSource, maskEntry.layer);
      const crop = this.textureFixupSelection.cropCanvas;
      const regionCount = this.textureFixupSelection.layout?.items?.length || 1;
      this.setTextureFixupPanelStatus?.(
        `${maskEntry.layer.name || "Fixup Mask"} - ${maskInfo.count.toLocaleString()} pixels - ${regionCount} region${regionCount === 1 ? "" : "s"} - export ${crop.width} x ${crop.height}px`
      );
      return this.textureFixupSelection;
    },

    async exportTextureFixupPng() {
      if (this.textureFixupBusy || !this.textureFixupActiveMaskEntry?.()) {
        return false;
      }
      this.textureFixupBusy = true;
      this.syncTextureFixupControls?.();
      this.setTextureFixupPanelStatus?.("Preparing texture export...");
      try {
        const selection = await this.refreshTextureFixupSelection?.();
        if (!selection?.cropCanvas) {
          return false;
        }
        const blob = await textureFixupCanvasBlob(selection.cropCanvas);
        selection.exportBounds = { ...selection.bounds };
        selection.exportLayout = selection.layout ? {
          width: selection.layout.width,
          height: selection.layout.height,
          items: selection.layout.items.map((item) => ({
            ...item,
            sourceBounds: { ...item.sourceBounds },
            destinationBounds: { ...item.destinationBounds }
          }))
        } : null;
        selection.exportRotate180 = selection.presentationRotate180 === true;
        selection.exportCropCanvas = this.copyTexturePaintCanvas?.(selection.cropCanvas) || selection.cropCanvas;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = textureFixupDownloadName(selection);
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.setStatus?.(`Exported ${link.download}`);
        return true;
      } catch (error) {
        console.error("Texture fixup export failed", error);
        this.setTextureFixupPanelStatus?.("Export failed");
        this.setStatus?.(`Texture export failed: ${error?.message || error}`);
        return false;
      } finally {
        this.textureFixupBusy = false;
        this.syncTextureFixupControls?.();
      }
    },

    async importTextureFixupFile(file = null) {
      if (!file || this.textureFixupBusy) {
        return false;
      }
      if (!String(file.type || "image/png").startsWith("image/")) {
        this.setStatus?.("Texture fixup import needs an image file");
        return false;
      }
      let selection = this.textureFixupSelection || null;
      if (!textureFixupSelectionCanImport(selection)) {
        if (!this.textureFixupActiveMaskEntry?.()?.layer?.canvas) {
          this.setStatus?.("Select the Fixup Mask used for this texture before importing");
          return false;
        }
        this.setTextureFixupPanelStatus?.("Preparing Fixup Mask for import...");
        selection = await this.refreshTextureFixupSelection?.() || null;
      }
      if (!textureFixupSelectionCanImport(selection)) {
        return false;
      }
      this.textureFixupBusy = true;
      this.syncTextureFixupControls?.();
      this.setTextureFixupPanelStatus?.("Importing texture...");
      let image = null;
      try {
        image = await textureFixupDecodeImage(file);
        const source = await this.textureFixupCompositeSource?.(selection.material);
        if (!source?.canvas || source.canvas.width !== selection.width || source.canvas.height !== selection.height) {
          throw new Error("The source texture size changed; export the mask again");
        }
        const material = selection.material;
        const editable = this.editableClonePaintTexture?.(material);
        const writableCanvas = material.userData?.clonePaintCanvas || editable?.compositeCanvas || editable?.canvas || null;
        if (!editable?.canvas || !editable?.context || !writableCanvas) {
          throw new Error("Could not prepare the selected texture for editing");
        }
        if (writableCanvas.width !== selection.width || writableCanvas.height !== selection.height) {
          throw new Error("The editable texture size changed; export the mask again");
        }
        const stack = this.texturePaintLayerStackForMaterial?.(material, editable, {
          create: true,
          setActiveMaterial: true
        });
        if (!stack) {
          throw new Error("Could not create a texture layer for the import");
        }
        const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(material);
        this.prepareTexturePaintLayerMutation?.({ material });

        const existingFixups = (stack.layers || []).filter((layer) => /^AI Fixup\b/i.test(layer?.name || "")).length;
        const layerName = `AI Fixup ${existingFixups + 1}`;
        let layer = this.texturePaintReusableAutoLayer?.(stack) || null;
        if (layer) {
          layer.name = layerName;
          layer.kind = "paint";
          layer.autoCreated = false;
          layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        } else {
          layer = this.texturePaintNewLayer?.(stack, { name: layerName, kind: "paint" });
          if (!layer) {
            throw new Error("Could not allocate the imported texture layer");
          }
          stack.layers.push(layer);
        }

        const bounds = selection.exportBounds || selection.bounds;
        const layout = selection.exportLayout || selection.layout || {
          width: bounds.width,
          height: bounds.height,
          items: [{
            sourceBounds: bounds,
            destinationBounds: { x: 0, y: 0, width: bounds.width, height: bounds.height }
          }]
        };
        const importedRotate180 = selection.exportRotate180 ?? (selection.presentationRotate180 === true);
        const importedLayer = textureFixupImportedLayerCanvas(
          this,
          image,
          selection.maskCanvas,
          layout,
          {
            rotate180: importedRotate180,
            referenceCanvas: selection.sourceCanvas
          }
        );
        if (!importedLayer) {
          throw new Error("Could not map the imported image through the frozen mask");
        }
        layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.context.drawImage(importedLayer, 0, 0);
        this.texturePaintUpdateLayerEmptyState?.(layer);

        const maskLayer = stack.layers.find((candidate) => candidate.id === selection.maskLayerId) || null;
        if (maskLayer) {
          maskLayer.visible = false;
        }
        this.texturePaintSetSingleLayerSelection?.(stack, layer.id);
        this.rememberTexturePaintLayerSelection?.(stack, layer);
        this.texturePaintActiveMaterial = material;
        this.discardTexturePaintMaterialAirbrushGpuTarget?.(material);
        this.invalidateTexturePaintMaterialGpuCaches?.(material, { resetSurfaceStroke: true });
        this.texturePaintCompositeMaterialLayers?.(material, {
          skipGpuFlush: true,
          preferCpuDisplay: true
        });
        this.renderTexturePaintLayerPanel?.();
        this.pushTexturePaintLayerUndoState?.(
          `Import ${layerName}`,
          undoBefore,
          this.captureTexturePaintLayerHistorySnapshot?.(material)
        );
        const regionCount = layout?.items?.length || 1;
        this.setTextureFixupPanelStatus?.(
          `${layerName} - ${regionCount} imported region${regionCount === 1 ? "" : "s"}`
        );
        this.setStatus?.(`Imported ${file.name || "texture fixup"} as ${layerName}`);
        return true;
      } catch (error) {
        console.error("Texture fixup import failed", error);
        this.setTextureFixupPanelStatus?.("Import failed");
        this.setStatus?.(`Texture import failed: ${error?.message || error}`);
        return false;
      } finally {
        image?.close?.();
        this.textureFixupBusy = false;
        this.syncTextureFixupControls?.();
      }
    },

    async clearTextureFixupMask() {
      const entry = this.textureFixupActiveMaskEntry?.();
      if (!entry?.layer?.canvas || this.textureFixupBusy) {
        return false;
      }
      this.textureFixupBusy = true;
      this.syncTextureFixupControls?.();
      try {
        this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.();
        await this.textureAirbrushSyncDeferredWebGpuCanvases?.({
          deferCanvasSyncUntilIdle: false,
          deferredCanvasSyncMaxTiles: false
        });
        await this.flushTexturePaintLayerGpuTargetsToCanvases?.({
          material: entry.material,
          composite: false,
          force: true,
          renderPanel: false
        });
        const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(entry.material);
        this.prepareTexturePaintLayerMutation?.({ material: entry.material });
        this.disposeTexturePaintLayerGpuState?.(entry.layer);
        entry.layer.context.clearRect(0, 0, entry.layer.canvas.width, entry.layer.canvas.height);
        entry.layer.isEmpty = true;
        entry.layer.texturePaintHasPaint = false;
        entry.layer.texturePaintCpuPainted = false;
        entry.layer.texturePaintGpuPainted = false;
        entry.layer.visible = true;
        delete entry.layer.textureFixupPreviewBounds;
        this.discardTexturePaintMaterialAirbrushGpuTarget?.(entry.material);
        this.invalidateTexturePaintMaterialGpuCaches?.(entry.material, { resetSurfaceStroke: true });
        this.texturePaintCompositeMaterialLayers?.(entry.material, {
          skipGpuFlush: true,
          preferCpuDisplay: true
        });
        if (this.textureFixupSelection?.maskLayerId === entry.layer.id) {
          this.textureFixupSelection = null;
          this.clearTextureFixupPreview?.();
        }
        this.renderTexturePaintLayerPanel?.();
        this.pushTexturePaintLayerUndoState?.(
          `Clear ${entry.layer.name || "Fixup Mask"}`,
          undoBefore,
          this.captureTexturePaintLayerHistorySnapshot?.(entry.material)
        );
        this.setTextureFixupPanelStatus?.(`${entry.layer.name || "Fixup Mask"} cleared`);
        this.setStatus?.("Fixup Mask cleared");
        return true;
      } catch (error) {
        console.error("Texture fixup mask clear failed", error);
        this.setStatus?.(`Could not clear the Fixup Mask: ${error?.message || error}`);
        return false;
      } finally {
        this.textureFixupBusy = false;
        this.syncTextureFixupControls?.();
      }
    },

    bindTextureFixupControls() {
      this.textureFixupNewMaskButton?.addEventListener("click", () => {
        this.createTextureFixupMaskLayer?.();
      });
      this.textureFixupPadding?.addEventListener("input", () => {
        this.updateTextureFixupOutputs?.();
        this.refreshTextureFixupCrop?.();
      });
      this.textureFixupPadding?.addEventListener("change", () => {
        this.refreshTextureFixupCrop?.();
      });
      this.textureFixupExportButton?.addEventListener("click", () => {
        void this.exportTextureFixupPng?.();
      });
      this.textureFixupImportButton?.addEventListener("click", () => {
        this.openTextureFixupFilePicker?.();
      });
      this.textureFixupFileInput?.addEventListener("change", () => {
        const file = this.textureFixupFileInput.files?.[0] || null;
        this.textureFixupFileInput.value = "";
        if (file) {
          void this.importTextureFixupFile?.(file);
        }
      });
      this.textureFixupClearButton?.addEventListener("click", () => {
        void this.clearTextureFixupMask?.();
      });
      this.bindTextureFixupColorGradeControls?.();
      this.updateTextureFixupOutputs?.();
      this.syncTextureFixupControls?.();
    }
  });
  installTextureFixupColorGradeMethods(BirdWeightEditor);
}
