import {
  TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS,
  TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE
} from "./constants.js";
import { airbrushHaloRadius } from "./math.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_BRUSH_UNIFORM_BYTES,
  TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS,
  TEXTURE_AIRBRUSH_WEBGPU_PAINT_REGION_UINTS,
  TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS,
  textureAirbrushWebGpuBindGroupLayoutEntries,
  textureAirbrushWebGpuBufferDescriptors,
  textureAirbrushWebGpuReadbackBufferDescriptor,
  textureAirbrushWebGpuTextureDescriptors,
  textureAirbrushWebGpuUsageConstants
} from "./webgpu-descriptors.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE,
  textureAirbrushWebGpuDispatchSize,
  textureAirbrushWebGpuKernelParams
} from "./webgpu-kernel.js";
export {
  TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
  TEXTURE_AIRBRUSH_WEBGPU_BRUSH_UNIFORM_BYTES,
  TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS,
  TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS,
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

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.floor(finiteNumber(value, fallback)));
}

function evenlySelectedItems(items = [], limit = 0) {
  const source = Array.isArray(items) ? items : [];
  const count = nonNegativeInteger(limit, 0);
  if (!count || !source.length) {
    return [];
  }
  if (source.length <= count) {
    return source.slice();
  }
  if (count === 1) {
    return [source[0]];
  }
  const selected = [];
  const used = new Set();
  for (let index = 0; index < count; index += 1) {
    let sourceIndex = Math.round((index * (source.length - 1)) / (count - 1));
    while (used.has(sourceIndex) && sourceIndex + 1 < source.length) {
      sourceIndex += 1;
    }
    while (used.has(sourceIndex) && sourceIndex > 0) {
      sourceIndex -= 1;
    }
    used.add(sourceIndex);
    selected.push(source[sourceIndex]);
  }
  return selected;
}

function visibilityTriangleSlotStride(triangles = []) {
  void triangles;
  return 4;
}

function bufferWriteBytes(slotCount = 0, floatsPerSlot = 1, fallbackSlots = 1) {
  const slots = Math.max(
    Math.floor(Number(fallbackSlots) || 1),
    Math.floor(Number(slotCount) || 0)
  );
  return Math.max(16, slots * Math.max(1, Math.floor(Number(floatsPerSlot) || 1)) * 4);
}

function triangleHasScreenProjection(triangle = null) {
  return Boolean(
    triangle
    && Number.isFinite(triangle.screenA?.x)
    && Number.isFinite(triangle.screenA?.y)
    && Number.isFinite(triangle.screenB?.x)
    && Number.isFinite(triangle.screenB?.y)
    && Number.isFinite(triangle.screenC?.x)
    && Number.isFinite(triangle.screenC?.y)
  );
}

function viewPoint(point = null) {
  const x = Number.isFinite(Number(point?.viewX)) ? Number(point.viewX) : Number(point?.x);
  const y = Number.isFinite(Number(point?.viewY)) ? Number(point.viewY) : Number(point?.y);
  const z = Number.isFinite(Number(point?.viewZ)) ? Number(point.viewZ) : Number(point?.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    ? { x, y, z }
    : null;
}

function writeViewPoint(data, offset, point = null, w = 0) {
  const view = viewPoint(point);
  if (!view) {
    return false;
  }
  data[offset] = view.x;
  data[offset + 1] = view.y;
  data[offset + 2] = view.z;
  data[offset + 3] = Number.isFinite(Number(w)) ? Number(w) : 0;
  return true;
}

function screenProjectedVisibilitySampleCapacity(maxVisibilitySlots = 1, triangleSlotStride = 4) {
  const slots = positiveInteger(maxVisibilitySlots, TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS);
  const stride = positiveInteger(triangleSlotStride, 4);
  return Math.max(
    1,
    Math.min(
      TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE,
      Math.max(1, slots - stride)
    )
  );
}

function screenProjectedCoverageEnabled(options = {}) {
  const triangles = Array.isArray(options.projectedRenderTriangles) && options.projectedRenderTriangles.length
    ? options.projectedRenderTriangles
    : Array.isArray(options.visibilityMaskTriangles)
      ? options.visibilityMaskTriangles
      : [];
  return Array.isArray(options.screenProjectedStrokeSegments)
    && options.screenProjectedStrokeSegments.length > 0
    && triangles.some(triangleHasScreenProjection);
}

function screenProjectedRenderTriangles(options = {}) {
  const projected = Array.isArray(options.projectedRenderTriangles)
    ? options.projectedRenderTriangles
    : [];
  if (projected.some(triangleHasScreenProjection)) {
    return projected;
  }
  return Array.isArray(options.visibilityMaskTriangles)
    ? options.visibilityMaskTriangles
    : [];
}

function normalizePaintRegion(region = null, width = 1, height = 1) {
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  if (!region) {
    return null;
  }
  const x = Math.max(0, Math.min(safeWidth - 1, Math.floor(finiteNumber(region.x, 0))));
  const y = Math.max(0, Math.min(safeHeight - 1, Math.floor(finiteNumber(region.y, 0))));
  const right = Math.max(
    x + 1,
    Math.min(safeWidth, Math.ceil(finiteNumber(region.x, 0) + finiteNumber(region.width, 0)))
  );
  const bottom = Math.max(
    y + 1,
    Math.min(safeHeight, Math.ceil(finiteNumber(region.y, 0) + finiteNumber(region.height, 0)))
  );
  const normalized = {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
  if (region.visibilityTriangle) {
    Object.defineProperty(normalized, "visibilityTriangle", {
      value: region.visibilityTriangle,
      enumerable: false
    });
  }
  return normalized;
}

function normalizedPaintRegions(width = 1, height = 1, options = {}) {
  return (Array.isArray(options.paintRegions) ? options.paintRegions : [])
    .map((region) => normalizePaintRegion(region, width, height))
    .filter(Boolean);
}

function compactPaintRegionWorkBounds(regions = []) {
  let totalPixels = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  for (const region of regions) {
    const width = positiveInteger(region.width, 1);
    const height = positiveInteger(region.height, 1);
    totalPixels += width * height;
    maxWidth = Math.max(maxWidth, width);
    maxHeight = Math.max(maxHeight, height);
  }
  if (!totalPixels) {
    return null;
  }
  return {
    x: 0,
    y: 0,
    width: Math.max(1, maxWidth),
    height: Math.max(1, maxHeight),
    pixelCount: totalPixels,
    regionCount: Math.max(1, regions.length)
  };
}

export function textureAirbrushWebGpuPaintBounds(width, height, options = {}, params = {}) {
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  if (
    typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushForceOrigin")
  ) {
    return {
      x: 0,
      y: 0,
      width: Math.min(safeWidth, 512),
      height: Math.min(safeHeight, 512)
    };
  }
  const compactRegions = options.compactPaintRegions === true
    ? normalizedPaintRegions(safeWidth, safeHeight, options)
    : [];
  if (
    compactRegions.length > 1
    && compactRegions.length <= TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS
  ) {
    const workBounds = compactPaintRegionWorkBounds(compactRegions);
    if (workBounds) {
      return {
        x: 0,
        y: 0,
        width: workBounds.width,
        height: workBounds.height
      };
    }
  }
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
  const fallbackRadius = Math.max(0.75, finiteNumber(params.radiusPixels, finiteNumber(options.radiusPixels, 24)));
  const radius = Math.max(
    fallbackRadius,
    ...segments.map((segment) => Math.max(0.75, finiteNumber(segment?.radiusPixels, fallbackRadius)))
  );
  const scatter = Math.max(0, Math.min(1, finiteNumber(params.scatter, finiteNumber(options.scatter, 0.35))));
  const hardness = Math.max(0, Math.min(1, finiteNumber(params.hardness, finiteNumber(options.hardness, 0.35))));
  const halo = Math.ceil(airbrushHaloRadius(radius, scatter, hardness) + 2);
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
  maxStrokeSegments = TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  radiusPixels = 24
} = {}) {
  const count = positiveInteger(maxStrokeSegments, TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS);
  const data = new Float32Array(count * TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS);
  const fallbackRadius = Math.max(0.75, finiteNumber(radiusPixels, 24));
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
    data[offset + 4] = Math.max(0.75, finiteNumber(segment.radiusPixels, fallbackRadius));
    data[offset + 5] = 0;
  }
  return data;
}

export function textureAirbrushWebGpuVisibilitySampleBufferData(samples = [], {
  triangles = [],
  maxVisibilitySamples = TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS
} = {}) {
  const count = positiveInteger(maxVisibilitySamples, TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS);
  const data = new Float32Array(count * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS);
  let slot = 0;
  const compactSamples = Array.isArray(samples) && samples.length ? samples : [];
  for (let index = 0; index < compactSamples.length && slot < count; index += 1) {
    const sample = compactSamples[index] || {};
    const start = strokePoint(sample.segment?.start || sample.start || sample);
    const end = strokePoint(sample.segment?.end || sample.end || sample);
    const viewStart = sample.segment?.viewStart || sample.viewStart || null;
    const viewEnd = sample.segment?.viewEnd || sample.viewEnd || null;
    const viewRadius = finiteNumber(sample.segment?.viewRadiusPixels ?? sample.viewRadiusPixels, 0);
    const offset = slot * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
    data[offset] = start.x;
    data[offset + 1] = start.y;
    data[offset + 2] = end.x;
    data[offset + 3] = end.y;
    if (viewRadius > 0 && viewPoint(viewStart) && viewPoint(viewEnd)) {
      writeViewPoint(data, offset + 4, viewStart, 1);
      writeViewPoint(data, offset + 8, viewEnd, viewRadius);
    }
    slot += 1;
  }
  const compactTriangles = Array.isArray(triangles) && triangles.length
    ? triangles
    : [];
  if (compactTriangles.length) {
    const triangleSlotStride = visibilityTriangleSlotStride(compactTriangles);
    for (let index = 0; index < compactTriangles.length && slot + triangleSlotStride - 1 < count; index += 1) {
      const triangle = compactTriangles[index] || {};
      const a = strokePoint(triangle.a || triangle[0]);
      const b = strokePoint(triangle.b || triangle[1]);
      const c = strokePoint(triangle.c || triangle[2]);
      const hasScreenProjection = triangleHasScreenProjection(triangle);
      const screenA = hasScreenProjection ? strokePoint(triangle.screenA) : { x: 0, y: 0 };
      const screenB = hasScreenProjection ? strokePoint(triangle.screenB) : { x: 0, y: 0 };
      const screenC = hasScreenProjection ? strokePoint(triangle.screenC) : { x: 0, y: 0 };
      const viewA = hasScreenProjection ? viewPoint(triangle.screenA) : null;
      const viewB = hasScreenProjection ? viewPoint(triangle.screenB) : null;
      const viewC = hasScreenProjection ? viewPoint(triangle.screenC) : null;
      const screenBScale = Math.max(0, finiteNumber(triangle.screenBScale, 0));
      const screenCScale = Math.max(0, finiteNumber(triangle.screenCScale, 0));
      let offset = slot * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
      data[offset] = a.x;
      data[offset + 1] = a.y;
      data[offset + 2] = b.x;
      data[offset + 3] = b.y;
      if (viewA && viewB && viewC) {
        writeViewPoint(data, offset + 4, viewA, 1);
        writeViewPoint(data, offset + 8, viewB, 1);
      }
      slot += 1;
      offset = slot * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
      data[offset] = c.x;
      data[offset + 1] = c.y;
      data[offset + 2] = Math.max(0, Math.min(1, finiteNumber(triangle.coverage, 1)));
      data[offset + 3] = hasScreenProjection ? 1 : 0;
      if (viewA && viewB && viewC) {
        writeViewPoint(data, offset + 4, viewC, 1);
      }
      slot += 1;
      offset = slot * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
      data[offset] = screenA.x;
      data[offset + 1] = screenA.y;
      data[offset + 2] = screenB.x;
      data[offset + 3] = screenB.y;
      slot += 1;
      offset = slot * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
      data[offset] = screenC.x;
      data[offset + 1] = screenC.y;
      data[offset + 2] = hasScreenProjection ? screenBScale : 0;
      data[offset + 3] = hasScreenProjection ? screenCScale : 0;
      slot += 1;
    }
    return data;
  }
  return data;
}

export function textureAirbrushWebGpuPaintRegionBufferData(regions = [], {
  maxPaintRegions = TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS,
  width = 1,
  height = 1
} = {}) {
  const count = positiveInteger(maxPaintRegions, 64);
  const data = new Uint32Array(count * TEXTURE_AIRBRUSH_WEBGPU_PAINT_REGION_UINTS);
  const normalized = (Array.isArray(regions) ? regions : [])
    .map((region) => normalizePaintRegion(region, width, height))
    .filter(Boolean)
    .slice(0, count);
  for (let index = 0; index < normalized.length; index += 1) {
    const region = normalized[index];
    const offset = index * TEXTURE_AIRBRUSH_WEBGPU_PAINT_REGION_UINTS;
    data[offset] = Math.max(0, Math.floor(region.x));
    data[offset + 1] = Math.max(0, Math.floor(region.y));
    data[offset + 2] = positiveInteger(region.width, 1);
    data[offset + 3] = positiveInteger(region.height, 1);
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
  view.setFloat32(44, params.layerMode ? 1 : 0, true);
  view.setUint32(48, Math.max(0, Math.floor(finiteNumber(bounds.x, 0))), true);
  view.setUint32(52, Math.max(0, Math.floor(finiteNumber(bounds.y, 0))), true);
  view.setUint32(56, positiveInteger(bounds.width, safeWidth), true);
  view.setUint32(60, positiveInteger(bounds.height, safeHeight), true);
  view.setUint32(64, params.useVisibilityMask ? 1 : 0, true);
  view.setFloat32(68, Math.max(0, finiteNumber(params.visibilityFeatherRadius, 0)), true);
  view.setFloat32(72, Math.max(0, Math.min(1, finiteNumber(params.visibilityMaskThreshold, 0.5))), true);
  view.setFloat32(76, Math.max(0, finiteNumber(params.visibilityBleedRadius, 0)), true);
  view.setUint32(80, nonNegativeInteger(params.visibilitySampleCount, 0), true);
  view.setFloat32(84, Math.max(0.5, finiteNumber(params.visibilityMaskStampRadiusPixels, 0.5)), true);
  view.setUint32(88, params.useVisibilitySamples ? 1 : 0, true);
  view.setUint32(92, nonNegativeInteger(params.visibilityTriangleCount, 0), true);
  view.setUint32(96, nonNegativeInteger(params.paintRegionCount, 0), true);
  view.setUint32(100, nonNegativeInteger(params.paintRegionPixelCount, 0), true);
  view.setUint32(104, params.compactPaintRegions ? 1 : 0, true);
  view.setUint32(108, params.compactPaintRegionTriangles ? 1 : 0, true);
  view.setUint32(112, params.projectedSurfaceMode ? 1 : 0, true);
  view.setUint32(116, 0, true);
  view.setUint32(120, 0, true);
  view.setUint32(124, 0, true);
  return new Uint8Array(buffer);
}

export function textureAirbrushWebGpuPaintPlan({
  width = 1,
  height = 1,
  options = {},
  defaults = {},
  maxStrokeSegments = TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  workgroupSize = TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE,
  scope = globalThis
} = {}) {
  const params = textureAirbrushWebGpuKernelParams(options, defaults);
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  const paintRegions = normalizedPaintRegions(safeWidth, safeHeight, options);
  const compactRegionLimit = TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS;
  const activePaintRegions = (
    options.compactPaintRegions === true
    && paintRegions.length > 1
    && paintRegions.length <= compactRegionLimit
  )
    ? paintRegions
    : [];
  const compactWorkBounds = activePaintRegions.length > 1
    ? compactPaintRegionWorkBounds(activePaintRegions)
    : null;
  const maxVisibilitySlots = positiveInteger(maxStrokeSegments, TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS);
  const triangleSlotStride = visibilityTriangleSlotStride(options.visibilityMaskTriangles);
  const useScreenProjectedCoverage = screenProjectedCoverageEnabled(options);
  const visibilitySamples = useScreenProjectedCoverage
    ? options.screenProjectedStrokeSegments
    : options.visibilityMaskSamples;
  const projectedRenderTriangles = useScreenProjectedCoverage
    ? screenProjectedRenderTriangles(options).filter(triangleHasScreenProjection)
    : [];
  params.strokeSegmentCount = Math.min(params.strokeSegmentCount, maxVisibilitySlots);
  const requestedVisibilitySamples = Math.min(
    useScreenProjectedCoverage
      ? (Array.isArray(visibilitySamples) ? visibilitySamples.length : 0)
      : params.visibilitySampleCount || 0,
    maxVisibilitySlots
  );
  const requestedVisibilityTriangles = Math.min(
    params.visibilityTriangleCount || 0,
    Math.floor(maxVisibilitySlots / triangleSlotStride)
  );
  params.visibilitySampleCount = requestedVisibilitySamples;
  params.visibilityTriangleCount = requestedVisibilityTriangles;
  if (useScreenProjectedCoverage) {
    params.visibilityMaskStampRadiusPixels = Math.max(
      0.5,
      ...visibilitySamples
        .map((segment) => finiteNumber(segment?.radiusPixels, 0))
        .filter((radius) => radius > 0)
    );
  }
  if (requestedVisibilitySamples > 0 && requestedVisibilityTriangles > 0) {
    // The airbrush curve itself is a UV-space stroke. Keep those continuous
    // sampled UV segments first; then fit as many camera-facing triangle
    // permissions as remain, always reserving room for at least one triangle.
    const sampleSlots = useScreenProjectedCoverage
      ? screenProjectedVisibilitySampleCapacity(maxVisibilitySlots, triangleSlotStride)
      : Math.max(0, maxVisibilitySlots - triangleSlotStride);
    params.visibilitySampleCount = Math.min(requestedVisibilitySamples, sampleSlots);
    const remainingTriangleSlots = Math.max(0, maxVisibilitySlots - params.visibilitySampleCount);
    params.visibilityTriangleCount = Math.min(
      requestedVisibilityTriangles,
      Math.floor(remainingTriangleSlots / triangleSlotStride)
    );
  }
  params.useVisibilitySamples = params.visibilitySampleCount > 0 ? 1 : 0;
  params.paintRegionCount = compactWorkBounds ? activePaintRegions.length : 0;
  params.paintRegionPixelCount = compactWorkBounds?.pixelCount || 0;
  params.compactPaintRegions = compactWorkBounds ? 1 : 0;
  params.compactPaintRegionTriangles = compactWorkBounds && options.compactPaintRegionTriangles === true ? 1 : 0;
  const strokeData = textureAirbrushWebGpuStrokeBufferData(options.strokeSegments, {
    maxStrokeSegments,
    radiusPixels: params.radiusPixels
  });
  const visibilitySampleData = textureAirbrushWebGpuVisibilitySampleBufferData(
    evenlySelectedItems(visibilitySamples, params.visibilitySampleCount),
    {
      triangles: evenlySelectedItems(options.visibilityMaskTriangles, params.visibilityTriangleCount),
      maxVisibilitySamples: maxStrokeSegments
    }
  );
  const projectedRenderTriangleSlotCount = projectedRenderTriangles.length * triangleSlotStride;
  const projectedRenderTriangleData = textureAirbrushWebGpuVisibilitySampleBufferData(
    [],
    {
      triangles: projectedRenderTriangles,
      maxVisibilitySamples: Math.max(1, projectedRenderTriangleSlotCount)
    }
  );
  const paintRegionData = textureAirbrushWebGpuPaintRegionBufferData(activePaintRegions, {
    maxPaintRegions: compactRegionLimit,
    width: safeWidth,
    height: safeHeight
  });
  const paintBounds = textureAirbrushWebGpuPaintBounds(safeWidth, safeHeight, options, params);
  const uniformData = textureAirbrushWebGpuBrushUniformData(params, safeWidth, safeHeight, paintBounds);
  const visibilitySlotCount = params.visibilitySampleCount + params.visibilityTriangleCount * triangleSlotStride;
  const projectedRenderTriangleWriteByteLength = bufferWriteBytes(
    projectedRenderTriangleSlotCount,
    TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS,
    1
  );
  const paintRegionSlotCount = Math.max(1, params.paintRegionCount || 0);
  const buffers = textureAirbrushWebGpuBufferDescriptors(
    uniformData,
    strokeData,
    visibilitySampleData,
    paintRegionData,
    scope,
    {
      strokeWriteByteLength: bufferWriteBytes(
        params.strokeSegmentCount,
        TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS
      ),
      visibilitySampleWriteByteLength: bufferWriteBytes(
        visibilitySlotCount,
        TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS
      ),
      paintRegionWriteByteLength: bufferWriteBytes(
        paintRegionSlotCount,
        TEXTURE_AIRBRUSH_WEBGPU_PAINT_REGION_UINTS
      )
    }
  );
  const bufferUsage = textureAirbrushWebGpuUsageConstants(scope).buffer;
  buffers.projectedTriangles = {
    size: Math.max(16, projectedRenderTriangleData.byteLength),
    usage: bufferUsage.storage | bufferUsage.copyDst,
    data: projectedRenderTriangleData,
    writeByteLength: projectedRenderTriangleWriteByteLength
  };
  return {
    width: safeWidth,
    height: safeHeight,
    paintBounds,
    paintRegions: activePaintRegions,
    compactPaintRegions: params.compactPaintRegions === 1,
    params,
    screenProjectedCoverageActive: useScreenProjectedCoverage,
    screenProjectedStrokeSegmentCount: useScreenProjectedCoverage
      ? params.visibilitySampleCount
      : 0,
    projectedRenderTriangleCount: projectedRenderTriangles.length,
    dispatch: textureAirbrushWebGpuDispatchSize(
      paintBounds.width,
      paintBounds.height,
      workgroupSize,
      compactWorkBounds?.regionCount || 1
    ),
    textures: textureAirbrushWebGpuTextureDescriptors(safeWidth, safeHeight, scope),
    buffers: {
      ...buffers,
      readback: textureAirbrushWebGpuReadbackBufferDescriptor(safeWidth, safeHeight, scope, paintBounds)
    },
    bindGroupLayoutEntries: textureAirbrushWebGpuBindGroupLayoutEntries(scope)
  };
}
