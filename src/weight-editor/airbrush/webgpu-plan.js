import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import { airbrushHaloRadius } from "./math.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_BRUSH_UNIFORM_BYTES,
  TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS,
  textureAirbrushWebGpuBindGroupLayoutEntries,
  textureAirbrushWebGpuBufferDescriptors,
  textureAirbrushWebGpuReadbackBufferDescriptor,
  textureAirbrushWebGpuTextureDescriptors
} from "./webgpu-descriptors.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE,
  textureAirbrushWebGpuDispatchSize,
  textureAirbrushWebGpuKernelParams
} from "./webgpu-kernel.js?v=stroke-opacity-photoshop-cap-20260620a";
export {
  TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
  TEXTURE_AIRBRUSH_WEBGPU_BRUSH_UNIFORM_BYTES,
  TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS,
  TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_PIXEL,
  TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_ROW_ALIGNMENT,
  textureAirbrushWebGpuAlignedBytesPerRow,
  textureAirbrushWebGpuBindGroupLayoutEntries,
  textureAirbrushWebGpuBufferDescriptors,
  textureAirbrushWebGpuReadbackBufferDescriptor,
  textureAirbrushWebGpuReadbackLayout,
  textureAirbrushWebGpuTextureDescriptors,
  textureAirbrushWebGpuUsageConstants
} from "./webgpu-descriptors.js";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback = 1) {
  return Math.max(1, Math.floor(finiteNumber(value, fallback)));
}

export function textureAirbrushWebGpuPaintBounds(width, height, options = {}, params = {}) {
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  const explicit = options.paintBounds || options.dirtyBounds || null;
  if (explicit) {
    const x = Math.max(0, Math.min(safeWidth - 1, Math.floor(finiteNumber(explicit.x, 0))));
    const y = Math.max(0, Math.min(safeHeight - 1, Math.floor(finiteNumber(explicit.y, 0))));
    const right = Math.max(x + 1, Math.min(safeWidth, Math.ceil(finiteNumber(explicit.x, 0) + finiteNumber(explicit.width, safeWidth))));
    const bottom = Math.max(y + 1, Math.min(safeHeight, Math.ceil(finiteNumber(explicit.y, 0) + finiteNumber(explicit.height, safeHeight))));
    return {
      x,
      y,
      width: right - x,
      height: bottom - y
    };
  }
  const segments = Array.isArray(options.strokeSegments) ? options.strokeSegments : [];
  if (!segments.length) {
    return {
      x: 0,
      y: 0,
      width: safeWidth,
      height: safeHeight
    };
  }
  const radius = Math.max(0.75, finiteNumber(params.radiusPixels, finiteNumber(options.radiusPixels, 24)));
  const scatter = Math.max(0, Math.min(1, finiteNumber(params.scatter, finiteNumber(options.scatter, 0.35))));
  const halo = Math.ceil(airbrushHaloRadius(radius, scatter) + 2);
  let minX = safeWidth;
  let minY = safeHeight;
  let maxX = 0;
  let maxY = 0;
  for (const segment of segments) {
    const start = strokePoint(segment?.start);
    const end = strokePoint(segment?.end);
    minX = Math.min(minX, start.x, end.x);
    minY = Math.min(minY, start.y, end.y);
    maxX = Math.max(maxX, start.x, end.x);
    maxY = Math.max(maxY, start.y, end.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return {
      x: 0,
      y: 0,
      width: safeWidth,
      height: safeHeight
    };
  }
  const x = Math.max(0, Math.min(safeWidth - 1, Math.floor(minX - halo)));
  const y = Math.max(0, Math.min(safeHeight - 1, Math.floor(minY - halo)));
  const right = Math.max(x + 1, Math.min(safeWidth, Math.ceil(maxX + halo + 1)));
  const bottom = Math.max(y + 1, Math.min(safeHeight, Math.ceil(maxY + halo + 1)));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function strokePoint(point = null) {
  return {
    x: finiteNumber(point?.x ?? point?.clientX, 0),
    y: finiteNumber(point?.y ?? point?.clientY, 0)
  };
}

export function textureAirbrushWebGpuStrokeBufferData(strokeSegments = [], {
  maxStrokeSegments = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
} = {}) {
  const count = positiveInteger(maxStrokeSegments, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
  const data = new Float32Array(count * TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS);
  const segments = Array.isArray(strokeSegments) && strokeSegments.length
    ? strokeSegments
    : [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }];
  for (let index = 0; index < Math.min(count, segments.length); index += 1) {
    const segment = segments[index] || {};
    const start = strokePoint(segment.start);
    const end = strokePoint(segment.end);
    const offset = index * TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS;
    data[offset] = start.x;
    data[offset + 1] = start.y;
    data[offset + 2] = end.x;
    data[offset + 3] = end.y;
  }
  return data;
}

export function textureAirbrushWebGpuBrushUniformData(params = {}, width = 1, height = 1, paintBounds = null) {
  const buffer = new ArrayBuffer(TEXTURE_AIRBRUSH_WEBGPU_BRUSH_UNIFORM_BYTES);
  const view = new DataView(buffer);
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  const bounds = paintBounds || {
    x: 0,
    y: 0,
    width: safeWidth,
    height: safeHeight
  };
  view.setUint32(0, safeWidth, true);
  view.setUint32(4, safeHeight, true);
  view.setFloat32(8, finiteNumber(params.radiusPixels, 24), true);
  view.setFloat32(12, finiteNumber(params.opacity, 0.42), true);
  view.setFloat32(16, finiteNumber(params.hardness, 0.35), true);
  view.setFloat32(20, finiteNumber(params.scatter, 0.35), true);
  view.setFloat32(24, finiteNumber(params.strength, 1), true);
  view.setUint32(28, positiveInteger(params.strokeSegmentCount, 1), true);
  view.setFloat32(32, finiteNumber(params.color?.r, 1), true);
  view.setFloat32(36, finiteNumber(params.color?.g, 1), true);
  view.setFloat32(40, finiteNumber(params.color?.b, 1), true);
  view.setUint32(48, Math.max(0, Math.floor(finiteNumber(bounds.x, 0))), true);
  view.setUint32(52, Math.max(0, Math.floor(finiteNumber(bounds.y, 0))), true);
  view.setUint32(56, positiveInteger(bounds.width, safeWidth), true);
  view.setUint32(60, positiveInteger(bounds.height, safeHeight), true);
  return new Uint8Array(buffer);
}

export function textureAirbrushWebGpuPaintPlan({
  width = 1,
  height = 1,
  options = {},
  defaults = {},
  maxStrokeSegments = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
  workgroupSize = TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE,
  scope = globalThis
} = {}) {
  const params = textureAirbrushWebGpuKernelParams(options, defaults);
  params.strokeSegmentCount = Math.min(params.strokeSegmentCount, positiveInteger(maxStrokeSegments, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS));
  const strokeData = textureAirbrushWebGpuStrokeBufferData(options.strokeSegments, { maxStrokeSegments });
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  const paintBounds = textureAirbrushWebGpuPaintBounds(safeWidth, safeHeight, options, params);
  const uniformData = textureAirbrushWebGpuBrushUniformData(params, safeWidth, safeHeight, paintBounds);
  const buffers = textureAirbrushWebGpuBufferDescriptors(uniformData, strokeData, scope);
  return {
    width: safeWidth,
    height: safeHeight,
    paintBounds,
    params,
    dispatch: textureAirbrushWebGpuDispatchSize(paintBounds.width, paintBounds.height, workgroupSize),
    textures: textureAirbrushWebGpuTextureDescriptors(safeWidth, safeHeight, scope),
    buffers: {
      ...buffers,
      readback: textureAirbrushWebGpuReadbackBufferDescriptor(safeWidth, safeHeight, scope, paintBounds)
    },
    bindGroupLayoutEntries: textureAirbrushWebGpuBindGroupLayoutEntries(scope)
  };
}
