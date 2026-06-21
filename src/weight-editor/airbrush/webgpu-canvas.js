import { textureAirbrushRunWebGpuPaint } from "./webgpu-dispatch.js";
import {
  textureAirbrushApplyPixelsToEditable,
  textureAirbrushEditableCanvasSize,
  textureAirbrushSourcePixelsFromEditable
} from "./webgpu-editable.js";
import { textureAirbrushReadWebGpuPaintResult } from "./webgpu-readback.js";
import { textureAirbrushCreateWebGpuPaintResources } from "./webgpu-resources.js";

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

function textureAirbrushRecordEditableWebGpuPaintStats(editor = null, stats = null) {
  if (!editor || !stats) {
    return stats;
  }
  editor.textureAirbrushLastWebGpuPaintStats = stats;
  if (!Array.isArray(editor.textureAirbrushWebGpuPaintStats)) {
    editor.textureAirbrushWebGpuPaintStats = [];
  }
  editor.textureAirbrushWebGpuPaintStats.push(stats);
  while (editor.textureAirbrushWebGpuPaintStats.length > 30) {
    editor.textureAirbrushWebGpuPaintStats.shift();
  }
  return stats;
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
  const key = editable?.texture || editable?.canvas || editable || null;
  const size = textureAirbrushEditableCanvasSize(editable);
  if (!editor || !key || !device || !size) {
    return null;
  }
  editor.textureAirbrushWebGpuPaintCaches ||= new WeakMap();
  const existing = editor.textureAirbrushWebGpuPaintCaches.get(key);
  if (
    existing
    && existing.device === device
    && existing.width === size.width
    && existing.height === size.height
    && options.refreshSource !== true
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
  const caches = editor?.textureAirbrushWebGpuPaintCaches;
  if (!caches || !editableOrTexture) {
    return false;
  }
  const key = editableOrTexture?.texture || editableOrTexture?.canvas || editableOrTexture;
  return caches.delete(key);
}

export function textureAirbrushPrewarmEditableWebGpuPaint(editor = null, editable = null, options = {}) {
  const startMs = textureAirbrushNow(options);
  const device = options.device || editor?.textureAirbrushWebGpuDevice?.();
  const cache = textureAirbrushWebGpuCacheForEditable(editor, editable, device, options);
  if (!device || !cache || (cache.initialized && options.refreshSource !== true)) {
    return null;
  }
  const reuseResources = options.refreshSource === true ? null : cache.resources || null;
  const prepared = textureAirbrushEditableWebGpuPayload(editor, editable, {
    ...options,
    readSource: true,
    strokeSegments: options.strokeSegments || [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  const preparedMs = textureAirbrushNow(options);
  if (!prepared?.payload || !prepared.sourcePixels) {
    return null;
  }
  const resources = textureAirbrushCreateWebGpuPaintResources(device, prepared.payload, {
    sourcePixels: prepared.sourcePixels,
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
  const stats = {
    width: prepared.width,
    height: prepared.height,
    sourceBytes: prepared.sourcePixels.byteLength || 0,
    reusedResources: Boolean(reuseResources),
    timings: {
      prepareMs: Math.max(0, preparedMs - startMs),
      uploadMs: Math.max(0, applyMs - preparedMs),
      totalMs: Math.max(0, applyMs - startMs)
    }
  };
  editor.textureAirbrushLastWebGpuPrewarmStats = stats;
  return {
    resources,
    payload: prepared.payload,
    sourcePixels: prepared.sourcePixels,
    stats
  };
}

export async function textureAirbrushRunEditableWebGpuPaint(editor = null, editable = null, options = {}) {
  const startMs = textureAirbrushNow(options);
  const device = options.device || editor?.textureAirbrushWebGpuDevice?.();
  const cache = textureAirbrushWebGpuCacheForEditable(editor, editable, device, options);
  const needsSource = options.refreshSource === true || !cache?.initialized;
  const reuseResources = cache?.resources || null;
  const strokeSourceImageData = options.strokeSourceImageData || null;
  const needsStrokeSource = Boolean(strokeSourceImageData)
    && (
      options.refreshStrokeSource === true
      || cache?.strokeSourceImageData !== strokeSourceImageData
      || !reuseResources
    );
  const prepared = textureAirbrushEditableWebGpuPayload(editor, editable, {
    ...options,
    readSource: needsSource
  });
  const preparedMs = textureAirbrushNow(options);
  if (!device || !prepared?.payload) {
    return null;
  }
  if (needsSource && !prepared.sourcePixels) {
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
  const strokeSourceUploaded = needsStrokeSource || uploadsSourceAsStrokeSource;
  const dispatchStartMs = textureAirbrushNow(options);
  const run = textureAirbrushRunWebGpuPaint(device, prepared.payload, {
    sourcePixels: needsSource ? prepared.sourcePixels : null,
    strokeSourcePixels,
    readback: true,
    reuseResources,
    uploadSource: needsSource,
    uploadStrokeSource: strokeSourceUploaded,
    persistOutputToSource: true,
    label: options.label || "texture-airbrush-editable"
  });
  const dispatchMs = textureAirbrushNow(options);
  if (!run?.result) {
    return null;
  }
  if (cache) {
    cache.resources = run.resources;
    cache.initialized = true;
    if (strokeSourceImageData) {
      cache.strokeSourceImageData = strokeSourceImageData;
    } else if (needsSource) {
      cache.strokeSourceImageData = null;
    }
  }
  const readbackStartMs = textureAirbrushNow(options);
  const pixels = await textureAirbrushReadWebGpuPaintResult(run.result, options);
  const readbackMs = textureAirbrushNow(options);
  const applied = textureAirbrushApplyPixelsToEditable(editable, pixels, {
    imageData: prepared.imageData,
    material: options.material || null,
    bounds: run.result.readbackLayout,
    reusableImageData: cache?.applyImageData || null
  });
  if (cache && applied?.putImageData) {
    cache.applyImageData = applied.putImageData;
  }
  const applyMs = textureAirbrushNow(options);
  const stats = textureAirbrushRecordEditableWebGpuPaintStats(editor, {
    width: prepared.width,
    height: prepared.height,
    dirtyBounds: textureAirbrushDirtyBoundsFromLayout(run.result.readbackLayout),
    dispatch: run.result.dispatch || null,
    sourceUploaded: needsSource,
    strokeSourceUploaded,
    sourceBytes: needsSource ? prepared.sourcePixels?.byteLength || 0 : 0,
    strokeSourceBytes: strokeSourcePixels?.byteLength || (uploadsSourceAsStrokeSource ? prepared.sourcePixels?.byteLength || 0 : 0),
    readbackBytes: pixels?.byteLength || 0,
    appliedBytes: applied?.byteLength || 0,
    reusedResources: Boolean(reuseResources),
    reusedReadbackBuffer: run.resources?.readbackBufferReused === true,
    reusedApplyImageData: applied?.reusedImageData === true,
    timings: {
      prepareMs: Math.max(0, preparedMs - startMs),
      dispatchMs: Math.max(0, dispatchMs - dispatchStartMs),
      readbackMs: Math.max(0, readbackMs - readbackStartMs),
      applyMs: Math.max(0, applyMs - readbackMs),
      totalMs: Math.max(0, applyMs - startMs)
    }
  });
  return {
    ...run,
    payload: prepared.payload,
    sourcePixels: prepared.sourcePixels,
    pixels,
    applied,
    stats
  };
}
