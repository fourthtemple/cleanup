import { textureFixupClamp as clamp } from "./core.js";
import { textureFixupCanvasContext } from "./canvas.js";

export const TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS = Object.freeze({
  tint: "#c58b57",
  tintAmount: 0,
  hue: 0,
  saturation: 0,
  brightness: 0,
  range: "highlights"
});

const TEXTURE_FIXUP_COLOR_RANGES = new Set(["all", "shadows", "midtones", "highlights"]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  return clamp(finiteNumber(value), 0, 1);
}

function normalizeHexColor(value, fallback = TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS.tint) {
  const text = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

export function textureFixupNormalizeColorGrade(options = {}) {
  const range = String(options.range || TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS.range).toLowerCase();
  return {
    tint: normalizeHexColor(options.tint),
    tintAmount: clamp(finiteNumber(options.tintAmount), 0, 100),
    hue: clamp(finiteNumber(options.hue), -180, 180),
    saturation: clamp(finiteNumber(options.saturation), -100, 100),
    brightness: clamp(finiteNumber(options.brightness), -100, 100),
    range: TEXTURE_FIXUP_COLOR_RANGES.has(range)
      ? range
      : TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS.range
  };
}

export function textureFixupColorGradeIsNeutral(options = {}) {
  const grade = textureFixupNormalizeColorGrade(options);
  return grade.tintAmount === 0
    && grade.hue === 0
    && grade.saturation === 0
    && grade.brightness === 0;
}

function hexRgb(value) {
  const color = normalizeHexColor(value);
  return {
    r: Number.parseInt(color.slice(1, 3), 16) / 255,
    g: Number.parseInt(color.slice(3, 5), 16) / 255,
    b: Number.parseInt(color.slice(5, 7), 16) / 255
  };
}

function rgbToHsv(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (maximum === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }
    hue = ((hue / 6) % 1 + 1) % 1;
  }
  return {
    h: hue,
    s: maximum > 0 ? delta / maximum : 0,
    v: maximum
  };
}

function hsvToRgb(hue, saturation, value) {
  const wrappedHue = ((hue % 1) + 1) % 1;
  const sector = Math.floor(wrappedHue * 6);
  const fraction = wrappedHue * 6 - sector;
  const p = value * (1 - saturation);
  const q = value * (1 - fraction * saturation);
  const t = value * (1 - (1 - fraction) * saturation);
  switch (sector % 6) {
    case 0: return { r: value, g: t, b: p };
    case 1: return { r: q, g: value, b: p };
    case 2: return { r: p, g: value, b: t };
    case 3: return { r: p, g: q, b: value };
    case 4: return { r: t, g: p, b: value };
    default: return { r: value, g: p, b: q };
  }
}

function mixHue(from, to, amount) {
  const delta = ((to - from + 1.5) % 1) - 0.5;
  return ((from + delta * amount) % 1 + 1) % 1;
}

function smoothStep(minimum, maximum, value) {
  const normalized = clamp01((value - minimum) / Math.max(0.000001, maximum - minimum));
  return normalized * normalized * (3 - 2 * normalized);
}

function colorRangeWeight(range, luma) {
  if (range === "shadows") {
    return 1 - smoothStep(0.16, 0.58, luma);
  }
  if (range === "midtones") {
    return smoothStep(0.08, 0.44, luma) * (1 - smoothStep(0.58, 0.94, luma));
  }
  if (range === "highlights") {
    return smoothStep(0.26, 0.76, luma);
  }
  return 1;
}

function adjustUnit(value, percentage) {
  const amount = clamp(finiteNumber(percentage) / 100, -1, 1);
  return amount >= 0
    ? value + (1 - value) * amount
    : value * (1 + amount);
}

export function textureFixupColorGradeImageData(sourceImage = null, options = {}) {
  if (!sourceImage?.data || !sourceImage.width || !sourceImage.height) {
    return null;
  }
  const grade = textureFixupNormalizeColorGrade(options);
  const output = {
    width: sourceImage.width,
    height: sourceImage.height,
    data: new Uint8ClampedArray(sourceImage.data)
  };
  if (textureFixupColorGradeIsNeutral(grade)) {
    return output;
  }
  const tintRgb = hexRgb(grade.tint);
  const tintHsv = rgbToHsv(tintRgb.r, tintRgb.g, tintRgb.b);
  const tintAmount = grade.tintAmount / 100;
  const hueShift = grade.hue / 360;
  for (let offset = 0; offset < output.data.length; offset += 4) {
    const alpha = sourceImage.data[offset + 3];
    if (alpha === 0) {
      continue;
    }
    const red = sourceImage.data[offset] / 255;
    const green = sourceImage.data[offset + 1] / 255;
    const blue = sourceImage.data[offset + 2] / 255;
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const rangeWeight = colorRangeWeight(grade.range, luma);
    const tintWeight = tintAmount * rangeWeight;
    const hsv = rgbToHsv(red, green, blue);
    hsv.h = mixHue(hsv.h, tintHsv.h, tintWeight);
    hsv.s += (Math.max(hsv.s, tintHsv.s * 0.9) - hsv.s) * tintWeight;
    hsv.h = ((hsv.h + hueShift * rangeWeight) % 1 + 1) % 1;
    hsv.s = adjustUnit(hsv.s, grade.saturation * rangeWeight);
    hsv.v = adjustUnit(hsv.v, grade.brightness * rangeWeight);
    const graded = hsvToRgb(hsv.h, clamp01(hsv.s), clamp01(hsv.v));
    output.data[offset] = Math.round(graded.r * 255);
    output.data[offset + 1] = Math.round(graded.g * 255);
    output.data[offset + 2] = Math.round(graded.b * 255);
    output.data[offset + 3] = alpha;
  }
  return output;
}

export function textureFixupColorHistogram(image = null, options = {}) {
  const binCount = Math.max(16, Math.min(256, Math.round(finiteNumber(options.bins, 64))));
  const channels = {
    red: new Float64Array(binCount),
    green: new Float64Array(binCount),
    blue: new Float64Array(binCount),
    luma: new Float64Array(binCount)
  };
  if (!image?.data?.length) {
    return { ...channels, bins: binCount, count: 0, maximum: 0 };
  }
  const pixelCount = Math.floor(image.data.length / 4);
  const maximumSamples = Math.max(1024, Math.round(finiteNumber(options.maximumSamples, 262144)));
  const stride = Math.max(1, Math.ceil(pixelCount / maximumSamples));
  let count = 0;
  let maximum = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += stride) {
    const offset = pixelIndex * 4;
    const alpha = image.data[offset + 3] / 255;
    if (alpha <= 0) {
      continue;
    }
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    const luma = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    const redBin = Math.min(binCount - 1, Math.floor(red * binCount / 256));
    const greenBin = Math.min(binCount - 1, Math.floor(green * binCount / 256));
    const blueBin = Math.min(binCount - 1, Math.floor(blue * binCount / 256));
    const lumaBin = Math.min(binCount - 1, Math.floor(luma * binCount / 256));
    channels.red[redBin] += alpha;
    channels.green[greenBin] += alpha;
    channels.blue[blueBin] += alpha;
    channels.luma[lumaBin] += alpha;
    maximum = Math.max(
      maximum,
      channels.red[redBin],
      channels.green[greenBin],
      channels.blue[blueBin]
    );
    count += 1;
  }
  return { ...channels, bins: binCount, count, maximum };
}

export function textureFixupImageOpaqueBounds(image = null, alphaThreshold = 1) {
  if (!image?.data || !image.width || !image.height) {
    return null;
  }
  const threshold = clamp(Math.round(finiteNumber(alphaThreshold, 1)), 1, 255);
  let minimumX = image.width;
  let minimumY = image.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let pixelIndex = 0; pixelIndex < image.width * image.height; pixelIndex += 1) {
    if (image.data[pixelIndex * 4 + 3] < threshold) {
      continue;
    }
    const x = pixelIndex % image.width;
    const y = Math.floor(pixelIndex / image.width);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
  }
  return maximumX >= minimumX && maximumY >= minimumY
    ? {
        x: minimumX,
        y: minimumY,
        width: maximumX - minimumX + 1,
        height: maximumY - minimumY + 1
      }
    : null;
}

function imageRegion(image, bounds) {
  const data = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    const sourceStart = ((bounds.y + y) * image.width + bounds.x) * 4;
    const targetStart = y * bounds.width * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + bounds.width * 4), targetStart);
  }
  return { width: bounds.width, height: bounds.height, data };
}

export function textureFixupDrawColorHistogram(canvas = null, histogram = null) {
  const context = textureFixupCanvasContext(canvas);
  if (!canvas || !context) {
    return false;
  }
  const width = canvas.width;
  const height = canvas.height;
  context.save();
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0b1014";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(190, 205, 215, 0.10)";
  for (let line = 1; line < 4; line += 1) {
    context.fillRect(Math.round(width * line / 4), 0, 1, height);
    context.fillRect(0, Math.round(height * line / 4), width, 1);
  }
  if (!histogram?.count || !histogram.maximum) {
    context.restore();
    return true;
  }
  const channels = [
    [histogram.red, "rgba(255, 88, 76, 0.52)"],
    [histogram.green, "rgba(79, 221, 139, 0.48)"],
    [histogram.blue, "rgba(82, 151, 255, 0.54)"]
  ];
  const logarithmicMaximum = Math.log1p(histogram.maximum);
  context.globalCompositeOperation = "lighter";
  for (const [values, color] of channels) {
    context.fillStyle = color;
    for (let bin = 0; bin < histogram.bins; bin += 1) {
      const left = Math.floor(bin * width / histogram.bins);
      const right = Math.max(left + 1, Math.ceil((bin + 1) * width / histogram.bins));
      const normalized = Math.log1p(values[bin]) / logarithmicMaximum;
      const barHeight = Math.max(0, Math.round(normalized * (height - 3)));
      if (barHeight > 0) {
        context.fillRect(left, height - barHeight, right - left, barHeight);
      }
    }
  }
  context.restore();
  return true;
}

function animationHost() {
  return typeof window !== "undefined" ? window : globalThis;
}

function setValue(control, value) {
  if (control) {
    control.value = String(value);
  }
}

function setDisabled(control, disabled) {
  if (control) {
    control.disabled = disabled;
  }
}

export function installTextureFixupColorGradeMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureFixupColorGradeEntry() {
      const material = this.texturePaintActiveMaterial || this.texturePaintFirstLayerMaterial?.();
      const stack = material?.userData?.texturePaintLayerStack || null;
      const active = this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false }) || null;
      if (
        !material
        || !active?.layer?.canvas
        || this.texturePaintLayerKind?.(active.layer) === "fixup-mask"
      ) {
        return null;
      }
      return { material, stack: active.stack, layer: active.layer };
    },

    textureFixupColorGradeValues() {
      return textureFixupNormalizeColorGrade({
        tint: this.textureFixupTintColor?.value,
        tintAmount: this.textureFixupTintAmount?.value,
        hue: this.textureFixupHue?.value,
        saturation: this.textureFixupSaturation?.value,
        brightness: this.textureFixupBrightness?.value,
        range: this.textureFixupToneRange?.value
      });
    },

    updateTextureFixupColorGradeOutputs() {
      const grade = this.textureFixupColorGradeValues?.() || TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS;
      if (this.textureFixupTintAmountOutput) {
        this.textureFixupTintAmountOutput.textContent = `${Math.round(grade.tintAmount)}%`;
      }
      if (this.textureFixupHueOutput) {
        this.textureFixupHueOutput.textContent = `${grade.hue > 0 ? "+" : ""}${Math.round(grade.hue)}deg`;
      }
      if (this.textureFixupSaturationOutput) {
        this.textureFixupSaturationOutput.textContent = `${grade.saturation > 0 ? "+" : ""}${Math.round(grade.saturation)}%`;
      }
      if (this.textureFixupBrightnessOutput) {
        this.textureFixupBrightnessOutput.textContent = `${grade.brightness > 0 ? "+" : ""}${Math.round(grade.brightness)}%`;
      }
      return grade;
    },

    resetTextureFixupColorGradeInputs(options = {}) {
      setValue(this.textureFixupTintAmount, 0);
      setValue(this.textureFixupHue, 0);
      setValue(this.textureFixupSaturation, 0);
      setValue(this.textureFixupBrightness, 0);
      if (options.full === true) {
        setValue(this.textureFixupTintColor, TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS.tint);
        setValue(this.textureFixupToneRange, TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS.range);
      }
      this.updateTextureFixupColorGradeOutputs?.();
      return true;
    },

    invalidateTextureFixupColorHistogram() {
      this.textureFixupColorHistogramLayer = null;
      return true;
    },

    renderTextureFixupColorHistogram(sourceCanvas = null, options = {}) {
      const histogramCanvas = this.textureFixupHistogram;
      if (!histogramCanvas) {
        return false;
      }
      if (!sourceCanvas && !options.image) {
        this.textureFixupColorHistogramLayer = null;
        return textureFixupDrawColorHistogram(histogramCanvas, null);
      }
      let image = options.image || null;
      if (!image) {
        const context = textureFixupCanvasContext(sourceCanvas, { willReadFrequently: true });
        if (!context) {
          return false;
        }
        image = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      }
      const histogram = textureFixupColorHistogram(image);
      textureFixupDrawColorHistogram(histogramCanvas, histogram);
      this.textureFixupColorHistogramLayer = options.layer || sourceCanvas;
      return true;
    },

    syncTextureFixupColorGradeControls(entry = null) {
      const active = entry || this.textureFixupColorGradeEntry?.();
      const session = this.textureFixupColorGradeSession || null;
      if (session && session.layer !== active?.layer) {
        this.cancelTextureFixupColorGrade?.({ render: false, status: false, sync: false });
      }
      const currentSession = this.textureFixupColorGradeSession || null;
      const disabled = this.textureFixupBusy === true || !active?.layer?.canvas;
      for (const control of [
        this.textureFixupTintColor,
        this.textureFixupTintAmount,
        this.textureFixupToneRange,
        this.textureFixupHue,
        this.textureFixupSaturation,
        this.textureFixupBrightness
      ]) {
        setDisabled(control, disabled);
      }
      const neutral = textureFixupColorGradeIsNeutral(this.textureFixupColorGradeValues?.());
      setDisabled(this.textureFixupGradeApplyButton, disabled || !currentSession || neutral);
      setDisabled(this.textureFixupGradeCancelButton, !currentSession);
      if (!active?.layer?.canvas) {
        this.renderTextureFixupColorHistogram?.();
      } else if (this.textureFixupColorHistogramLayer !== active.layer) {
        this.renderTextureFixupColorHistogram?.(active.layer.canvas, { layer: active.layer });
      }
      this.updateTextureFixupColorGradeOutputs?.();
      return Boolean(active);
    },

    async beginTextureFixupColorGrade() {
      if (this.textureFixupColorGradeSession) {
        return this.textureFixupColorGradeSession;
      }
      if (this.textureFixupColorGradeStarting) {
        return this.textureFixupColorGradeStarting;
      }
      const initialEntry = this.textureFixupColorGradeEntry?.();
      if (!initialEntry?.layer?.canvas) {
        this.setStatus?.("Select a paint layer to color grade");
        return null;
      }
      const starting = (async () => {
        this.flushTexturePaintPendingBrushWorkBeforeLayerMutation?.({ material: initialEntry.material });
        await this.textureAirbrushSyncDeferredWebGpuCanvases?.({
          deferCanvasSyncUntilIdle: false,
          deferredCanvasSyncMaxTiles: false
        });
        await this.flushTexturePaintLayerGpuTargetsToCanvases?.({
          material: initialEntry.material,
          composite: false,
          force: true,
          renderPanel: false
        });
        const entry = this.textureFixupColorGradeEntry?.();
        if (!entry || entry.layer !== initialEntry.layer) {
          return null;
        }
        const context = textureFixupCanvasContext(entry.layer.canvas, { willReadFrequently: true });
        if (!context) {
          return null;
        }
        const fullImage = context.getImageData(0, 0, entry.layer.canvas.width, entry.layer.canvas.height);
        const bounds = textureFixupImageOpaqueBounds(fullImage);
        if (!bounds) {
          this.setStatus?.("The selected paint layer is empty");
          return null;
        }
        const undoBefore = this.captureTexturePaintLayerHistorySnapshot?.(entry.material) || null;
        this.prepareTexturePaintLayerTargetChange?.({ material: entry.material });
        this.disposeTexturePaintLayerGpuState?.(entry.layer);
        const session = {
          ...entry,
          context,
          bounds,
          sourceImage: imageRegion(fullImage, bounds),
          undoBefore,
          lastKey: ""
        };
        this.textureFixupColorGradeSession = session;
        return session;
      })();
      this.textureFixupColorGradeStarting = starting;
      try {
        return await starting;
      } finally {
        if (this.textureFixupColorGradeStarting === starting) {
          this.textureFixupColorGradeStarting = null;
        }
      }
    },

    async previewTextureFixupColorGrade(serial = null) {
      const requestSerial = serial ?? ((this.textureFixupColorGradeSerial || 0) + 1);
      this.textureFixupColorGradeSerial = Math.max(this.textureFixupColorGradeSerial || 0, requestSerial);
      const session = await this.beginTextureFixupColorGrade?.();
      if (!session || requestSerial !== this.textureFixupColorGradeSerial) {
        return false;
      }
      const grade = this.textureFixupColorGradeValues?.() || TEXTURE_FIXUP_COLOR_GRADE_DEFAULTS;
      const key = JSON.stringify(grade);
      if (key === session.lastKey) {
        this.syncTextureFixupColorGradeControls?.(session);
        return true;
      }
      const graded = textureFixupColorGradeImageData(session.sourceImage, grade);
      if (!graded) {
        return false;
      }
      const output = session.context.createImageData(graded.width, graded.height);
      output.data.set(graded.data);
      session.context.putImageData(output, session.bounds.x, session.bounds.y);
      session.lastKey = key;
      session.layer.texturePaintHasPaint = true;
      session.layer.texturePaintCpuPainted = true;
      session.layer.texturePaintGpuPainted = false;
      this.texturePaintUpdateLayerEmptyState?.(session.layer);
      this.discardTexturePaintMaterialAirbrushGpuTarget?.(session.material);
      this.invalidateTexturePaintMaterialGpuCaches?.(session.material, { resetSurfaceStroke: true });
      this.texturePaintCompositeMaterialLayers?.(session.material, {
        skipGpuFlush: true,
        preferCpuDisplay: true
      });
      this.renderTextureFixupColorHistogram?.(null, { image: graded, layer: session.layer });
      this.syncTextureFixupColorGradeControls?.(session);
      return true;
    },

    scheduleTextureFixupColorGradePreview() {
      const grade = this.updateTextureFixupColorGradeOutputs?.();
      if (textureFixupColorGradeIsNeutral(grade) && !this.textureFixupColorGradeSession) {
        return true;
      }
      const host = animationHost();
      const serial = (this.textureFixupColorGradeSerial || 0) + 1;
      this.textureFixupColorGradeSerial = serial;
      if (this.textureFixupColorGradeFrame != null) {
        if (typeof host.cancelAnimationFrame === "function") {
          host.cancelAnimationFrame(this.textureFixupColorGradeFrame);
        } else {
          host.clearTimeout?.(this.textureFixupColorGradeFrame);
        }
      }
      const run = () => {
        this.textureFixupColorGradeFrame = null;
        void this.previewTextureFixupColorGrade?.(serial);
      };
      this.textureFixupColorGradeFrame = typeof host.requestAnimationFrame === "function"
        ? host.requestAnimationFrame(run)
        : host.setTimeout?.(run, 0);
      return true;
    },

    async applyTextureFixupColorGrade() {
      const host = animationHost();
      if (this.textureFixupColorGradeFrame != null) {
        if (typeof host.cancelAnimationFrame === "function") {
          host.cancelAnimationFrame(this.textureFixupColorGradeFrame);
        } else {
          host.clearTimeout?.(this.textureFixupColorGradeFrame);
        }
        this.textureFixupColorGradeFrame = null;
      }
      const serial = (this.textureFixupColorGradeSerial || 0) + 1;
      this.textureFixupColorGradeSerial = serial;
      if (!await this.previewTextureFixupColorGrade?.(serial)) {
        return false;
      }
      const session = this.textureFixupColorGradeSession || null;
      if (!session) {
        return false;
      }
      const layerName = session.layer.name || "paint layer";
      const undoBefore = session.undoBefore;
      this.textureFixupColorGradeSession = null;
      this.invalidateTextureFixupColorHistogram?.();
      this.resetTextureFixupColorGradeInputs?.();
      this.renderTexturePaintLayerPanel?.();
      if (undoBefore) {
        this.pushTexturePaintLayerUndoState?.(
          `Color grade ${layerName}`,
          undoBefore,
          this.captureTexturePaintLayerHistorySnapshot?.(session.material)
        );
      }
      this.setStatus?.(`Applied color grade to ${layerName}`);
      this.syncTextureFixupColorGradeControls?.();
      return true;
    },

    cancelTextureFixupColorGrade(options = {}) {
      const session = this.textureFixupColorGradeSession || null;
      const host = animationHost();
      if (this.textureFixupColorGradeFrame != null) {
        if (typeof host.cancelAnimationFrame === "function") {
          host.cancelAnimationFrame(this.textureFixupColorGradeFrame);
        } else {
          host.clearTimeout?.(this.textureFixupColorGradeFrame);
        }
        this.textureFixupColorGradeFrame = null;
      }
      this.textureFixupColorGradeSerial = (this.textureFixupColorGradeSerial || 0) + 1;
      if (!session) {
        return false;
      }
      const restored = session.context.createImageData(session.sourceImage.width, session.sourceImage.height);
      restored.data.set(session.sourceImage.data);
      session.context.putImageData(restored, session.bounds.x, session.bounds.y);
      session.layer.texturePaintHasPaint = true;
      session.layer.texturePaintCpuPainted = true;
      session.layer.texturePaintGpuPainted = false;
      this.texturePaintUpdateLayerEmptyState?.(session.layer);
      this.discardTexturePaintMaterialAirbrushGpuTarget?.(session.material);
      this.invalidateTexturePaintMaterialGpuCaches?.(session.material, { resetSurfaceStroke: true });
      this.texturePaintCompositeMaterialLayers?.(session.material, {
        skipGpuFlush: true,
        preferCpuDisplay: true
      });
      this.textureFixupColorGradeSession = null;
      this.invalidateTextureFixupColorHistogram?.();
      this.resetTextureFixupColorGradeInputs?.();
      if (options.render !== false) {
        this.renderTexturePaintLayerPanel?.();
      }
      if (options.status !== false) {
        this.setStatus?.(`Canceled color grade for ${session.layer.name || "paint layer"}`);
      }
      if (options.sync !== false) {
        this.syncTextureFixupColorGradeControls?.();
      }
      return true;
    },

    bindTextureFixupColorGradeControls() {
      for (const control of [
        this.textureFixupTintColor,
        this.textureFixupTintAmount,
        this.textureFixupHue,
        this.textureFixupSaturation,
        this.textureFixupBrightness
      ]) {
        control?.addEventListener("input", () => {
          this.scheduleTextureFixupColorGradePreview?.();
        });
      }
      this.textureFixupToneRange?.addEventListener("change", () => {
        this.scheduleTextureFixupColorGradePreview?.();
      });
      this.textureFixupGradeApplyButton?.addEventListener("click", () => {
        void this.applyTextureFixupColorGrade?.();
      });
      this.textureFixupGradeCancelButton?.addEventListener("click", () => {
        this.cancelTextureFixupColorGrade?.();
      });
      this.resetTextureFixupColorGradeInputs?.({ full: true });
      this.syncTextureFixupColorGradeControls?.();
      return true;
    }
  });
}
