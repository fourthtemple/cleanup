export {
  TEXTURE_AIRBRUSH_PROJECTION_DEPTH_WINDOW as TEXTURE_AIRBRUSH_WEBGPU_PROJECTION_DEPTH_WINDOW,
  textureAirbrushProbePointsFromStroke as textureAirbrushWebGpuProbePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent as textureAirbrushWebGpuScreenStrokeFromEvent
} from "./projection.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE
} from "./constants.js";
import { airbrushHaloRadius } from "./math.js";
import { textureAirbrushRecordIdentity } from "./record-identity.js";

const TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_SLOT_STRIDE = 4;
const TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES = Math.max(
  1,
  Math.floor(
    (TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS - TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE)
      / TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_SLOT_STRIDE
  )
);
const TEXTURE_AIRBRUSH_WEBGPU_LIVE_SCREEN_VISIBILITY_TRIANGLES = TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_SCREEN_VISIBILITY_TRIANGLES = TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES;
const TEXTURE_AIRBRUSH_WEBGPU_NEIGHBOR_SCREEN_VISIBILITY_TRIANGLES = TEXTURE_AIRBRUSH_WEBGPU_MAX_SCREEN_PROJECTED_TRIANGLES;
const TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MIN_RADIUS_PIXELS = 18;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback = 1) {
  return Math.max(1, Math.floor(finiteNumber(value, fallback)));
}

function finitePoint(point = null) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  const output = {
    x: Number(point.x),
    y: Number(point.y)
  };
  for (const key of ["z", "viewX", "viewY", "viewZ", "clipW"]) {
    const value = Number(point?.[key]);
    if (Number.isFinite(value)) {
      output[key] = value;
    }
  }
  return output;
}

function screenPointClipW(point = null) {
  const explicit = Number(point?.clipW ?? point?.w);
  if (Number.isFinite(explicit) && Math.abs(explicit) > 0.000001) {
    return Math.abs(explicit);
  }
  const viewZ = Number(point?.viewZ);
  if (Number.isFinite(viewZ) && Math.abs(viewZ) > 0.000001) {
    return Math.abs(viewZ);
  }
  return null;
}

function screenPerspectiveScale(base = null, point = null) {
  const baseW = screenPointClipW(base);
  const pointW = screenPointClipW(point);
  if (!Number.isFinite(baseW) || !Number.isFinite(pointW) || baseW <= 0.000001) {
    return null;
  }
  return Math.max(0.000001, Math.min(1000000, pointW / baseW));
}

function clampPixel(value, max) {
  return Math.max(0, Math.min(max, Math.round(finiteNumber(value, 0))));
}

function alignedBytesPerRow(width, bytesPerPixel = 4, alignment = 256) {
  const rawBytes = positiveInteger(width, 1) * positiveInteger(bytesPerPixel, 4);
  const alignTo = positiveInteger(alignment, 256);
  return Math.ceil(rawBytes / alignTo) * alignTo;
}

function normalizedMaskBounds(width, height, bounds = null) {
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  if (!bounds) {
    return {
      x: 0,
      y: 0,
      width: safeWidth,
      height: safeHeight
    };
  }
  const x = Math.max(0, Math.min(safeWidth - 1, Math.floor(finiteNumber(bounds.x, 0))));
  const y = Math.max(0, Math.min(safeHeight - 1, Math.floor(finiteNumber(bounds.y, 0))));
  const right = Math.max(x + 1, Math.min(safeWidth, Math.ceil(finiteNumber(bounds.x, 0) + finiteNumber(bounds.width, safeWidth))));
  const bottom = Math.max(y + 1, Math.min(safeHeight, Math.ceil(finiteNumber(bounds.y, 0) + finiteNumber(bounds.height, safeHeight))));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function maskGroupKey(candidate = null) {
  return [
    textureAirbrushRecordIdentity(candidate?.record),
    candidate?.materialIndex ?? 0,
    candidate?.material?.uuid || candidate?.material?.id || "material",
    candidate?.editable?.texture?.uuid || candidate?.editable?.texture?.id || "",
    candidate?.editable?.canvas?.width || 0,
    candidate?.editable?.canvas?.height || 0
  ].join(":");
}

function setMaskPixel(pixels, width, height, x, y, value = 255, layout = {}) {
  const originX = Math.floor(finiteNumber(layout.x, 0));
  const originY = Math.floor(finiteNumber(layout.y, 0));
  const px = Math.round(finiteNumber(x, 0)) - originX;
  const py = Math.round(finiteNumber(y, 0)) - originY;
  if (px < 0 || py < 0 || px >= width || py >= height) {
    return false;
  }
  const bytesPerRow = Math.max(width * 4, Math.floor(finiteNumber(layout.bytesPerRow, width * 4)));
  const offset = py * bytesPerRow + px * 4;
  const next = Math.max(pixels[offset], value);
  pixels[offset] = next;
  pixels[offset + 1] = next;
  pixels[offset + 2] = next;
  pixels[offset + 3] = next;
  return true;
}

function smoothstep(edge0, edge1, value) {
  const range = edge1 - edge0;
  if (!Number.isFinite(range) || Math.abs(range) <= 0.000001) {
    return value < edge0 ? 0 : 1;
  }
  const t = Math.max(0, Math.min(1, (value - edge0) / range));
  return t * t * (3 - 2 * t);
}

function visibleMaskSoftValue(distancePixels, radiusPixels) {
  const radius = Math.max(0.5, finiteNumber(radiusPixels, 0.5));
  const distance = Math.max(0, finiteNumber(distancePixels, 0));
  if (distance <= 0.0001) {
    return 255;
  }
  if (distance > radius) {
    return 0;
  }
  const normalized = distance / radius;
  const gaussian = Math.exp(-0.5 * Math.pow(normalized * 2.4, 2));
  return Math.max(1, Math.min(255, Math.round(gaussian * 255)));
}

function triangleVisibilitySoftCutoffRadius(radiusPixels = 1) {
  return Math.min(48, Math.max(0.75, finiteNumber(radiusPixels, 1) * 0.22));
}

function visibilityEdgeModeForCandidate(candidate = null, options = {}) {
  return (candidate?.options?.visibleEdgeMode || options.visibleEdgeMode) === "hard" ? "hard" : "soft";
}

function pointInTriangle(point = null, triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!finitePoint(point) || !compact) {
    return false;
  }
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const ab = cross(compact.a, compact.b, point);
  const bc = cross(compact.b, compact.c, point);
  const ca = cross(compact.c, compact.a, point);
  const hasNegative = ab < -0.0001 || bc < -0.0001 || ca < -0.0001;
  const hasPositive = ab > 0.0001 || bc > 0.0001 || ca > 0.0001;
  return !(hasNegative && hasPositive);
}

function pointToSegmentDistance(point = null, start = null, end = null) {
  const p = finitePoint(point);
  const a = finitePoint(start);
  const b = finitePoint(end);
  if (!p || !a || !b) {
    return Infinity;
  }
  const segmentX = b.x - a.x;
  const segmentY = b.y - a.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.0001) {
    return Math.sqrt((p.x - b.x) ** 2 + (p.y - b.y) ** 2);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * segmentX + (p.y - a.y) * segmentY) / lengthSq));
  const x = a.x + segmentX * t;
  const y = a.y + segmentY * t;
  return Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2);
}

function triangleEdgeDistance(point = null, triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!finitePoint(point) || !compact) {
    return Infinity;
  }
  return Math.min(
    pointToSegmentDistance(point, compact.a, compact.b),
    pointToSegmentDistance(point, compact.b, compact.c),
    pointToSegmentDistance(point, compact.c, compact.a)
  );
}

function compactVisibilitySample(sample = null) {
  if (sample?.segment) {
    const start = finitePoint(sample.segment.start);
    const end = finitePoint(sample.segment.end);
    return start && end
      ? {
          segment: { start, end }
        }
      : null;
  }
  return finitePoint(sample);
}

function visibilitySamplesKey(samples = []) {
  return (Array.isArray(samples) ? samples : [])
    .map((sample) => {
      if (sample?.segment) {
        const start = finitePoint(sample.segment.start);
        const end = finitePoint(sample.segment.end);
        return start && end
          ? `s:${Math.round(start.x * 10)},${Math.round(start.y * 10)}>${Math.round(end.x * 10)},${Math.round(end.y * 10)}`
          : "";
      }
      const point = finitePoint(sample);
      return point ? `p:${Math.round(point.x * 10)},${Math.round(point.y * 10)}` : "";
    })
    .filter(Boolean)
    .join("|");
}

function compactVisibilityTriangle(triangle = null) {
  const a = finitePoint(triangle?.a || triangle?.[0]);
  const b = finitePoint(triangle?.b || triangle?.[1]);
  const c = finitePoint(triangle?.c || triangle?.[2]);
  if (!a || !b || !c) {
    return null;
  }
  const screenA = finitePoint(triangle?.screenA || triangle?.screen?.a);
  const screenB = finitePoint(triangle?.screenB || triangle?.screen?.b);
  const screenC = finitePoint(triangle?.screenC || triangle?.screen?.c);
  const hasScreenTriangle = Boolean(screenA && screenB && screenC);
  const screenBScale = Number.isFinite(Number(triangle?.screenBScale))
    ? Math.max(0.000001, Math.min(1000000, Number(triangle.screenBScale)))
    : hasScreenTriangle
      ? screenPerspectiveScale(screenA, screenB)
      : null;
  const screenCScale = Number.isFinite(Number(triangle?.screenCScale))
    ? Math.max(0.000001, Math.min(1000000, Number(triangle.screenCScale)))
    : hasScreenTriangle
      ? screenPerspectiveScale(screenA, screenC)
      : null;
  const coverage = Number(triangle?.coverage);
  const componentId = Math.floor(Number(triangle?.componentId));
  return {
    a,
    b,
    c,
    ...(hasScreenTriangle
      ? {
          screenA,
          screenB,
          screenC,
          ...(Number.isFinite(screenBScale) && Number.isFinite(screenCScale)
            ? { screenBScale, screenCScale }
            : {})
        }
      : {}),
    ...(Number.isInteger(componentId) && componentId >= 0 ? { componentId } : {}),
    ...(Number.isFinite(coverage) && coverage < 0.999999
      ? { coverage: Math.max(0, Math.min(1, coverage)) }
      : {})
  };
}

function visibilityTrianglesKey(triangles = []) {
  return (Array.isArray(triangles) ? triangles : [])
    .map(compactVisibilityTriangle)
    .filter(Boolean)
    .map((triangle) => [
      Math.round(triangle.a.x * 10),
      Math.round(triangle.a.y * 10),
      Math.round(triangle.b.x * 10),
      Math.round(triangle.b.y * 10),
      Math.round(triangle.c.x * 10),
      Math.round(triangle.c.y * 10),
      Math.round((triangle.screenA?.x ?? 0) * 10),
      Math.round((triangle.screenA?.y ?? 0) * 10),
      Math.round((triangle.screenB?.x ?? 0) * 10),
      Math.round((triangle.screenB?.y ?? 0) * 10),
      Math.round((triangle.screenC?.x ?? 0) * 10),
      Math.round((triangle.screenC?.y ?? 0) * 10),
      Math.round((Number.isFinite(triangle.screenBScale) ? triangle.screenBScale : 1) * 100000),
      Math.round((Number.isFinite(triangle.screenCScale) ? triangle.screenCScale : 1) * 100000),
      Number.isInteger(triangle.componentId) ? triangle.componentId : -1,
      Math.round((Number.isFinite(triangle.coverage) ? triangle.coverage : 1) * 1000)
    ].join(","))
    .join("|");
}

function maxUploadedVisibilityTriangles(options = {}) {
  const liveScreenProjected = options.liveProjectedPaint === true
    || options.screenStrokePaint === true
    || (
      Array.isArray(options.screenProjectedStrokeSegments)
      && options.screenProjectedStrokeSegments.length > 0
    );
  const neighborVisibility = options.largeLiveNeighborPaint === true
    || options.neighborPaintSeed?.enabled === true;
  const liveScreenCap = neighborVisibility
    ? TEXTURE_AIRBRUSH_WEBGPU_NEIGHBOR_SCREEN_VISIBILITY_TRIANGLES
    : Math.max(0, Number(options.radiusPixels) || 0) >= TEXTURE_AIRBRUSH_WEBGPU_LARGE_LIVE_MIN_RADIUS_PIXELS
      || options.largeLiveBrushPaint === true
      ? TEXTURE_AIRBRUSH_WEBGPU_LARGE_SCREEN_VISIBILITY_TRIANGLES
      : TEXTURE_AIRBRUSH_WEBGPU_LIVE_SCREEN_VISIBILITY_TRIANGLES;
  const explicit = Number(options.maxMergedVisibilityTriangles ?? options.maxVisibilityTriangles);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(liveScreenProjected ? Math.min(explicit, liveScreenCap) : explicit));
  }
  return liveScreenProjected ? liveScreenCap : Infinity;
}

function stampMaskDisk(pixels, width, height, point, radiusPixels, layout = {}) {
  const center = finitePoint(point);
  if (!center) {
    return 0;
  }
  const radius = Math.max(0.5, finiteNumber(radiusPixels, 0.5));
  const originX = Math.floor(finiteNumber(layout.x, 0));
  const originY = Math.floor(finiteNumber(layout.y, 0));
  const canvasWidth = positiveInteger(layout.canvasWidth, originX + width);
  const canvasHeight = positiveInteger(layout.canvasHeight, originY + height);
  const minX = Math.max(originX, 0, Math.floor(center.x - radius));
  const minY = Math.max(originY, 0, Math.floor(center.y - radius));
  const maxX = Math.min(originX + width - 1, canvasWidth - 1, Math.ceil(center.x + radius));
  const maxY = Math.min(originY + height - 1, canvasHeight - 1, Math.ceil(center.y + radius));
  const radiusSq = radius * radius;
  let changed = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radiusSq) {
        continue;
      }
      // DO NOT PAINT ON NON CAMERA-FACING NORMALS.
      // This is a soft permission value only inside a sampled camera-facing
      // observable disk. Pixels outside the observable stamp remain exactly 0
      // and cannot paint.
      if (setMaskPixel(pixels, width, height, x, y, visibleMaskSoftValue(Math.sqrt(distanceSq), radius), layout)) {
        changed += 1;
      }
    }
  }
  return changed;
}

function stampMaskSegment(pixels, width, height, segment = null, radiusPixels = 0.5, layout = {}) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!start || !end) {
    return 0;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const spacing = Math.max(1, Math.min(8, finiteNumber(radiusPixels, 1) * 0.5));
  const steps = Math.max(1, Math.ceil(length / spacing));
  let changed = 0;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    changed += stampMaskDisk(pixels, width, height, {
      x: start.x + dx * t,
      y: start.y + dy * t
    }, radiusPixels, layout);
  }
  return changed;
}

function stampMaskTriangle(pixels, width, height, triangle = null, bleedRadiusPixels = 0, layout = {}) {
  const compact = compactVisibilityTriangle(triangle);
  if (!compact) {
    return 0;
  }
  const bleed = Math.max(0, finiteNumber(bleedRadiusPixels, 0));
  const originX = Math.floor(finiteNumber(layout.x, 0));
  const originY = Math.floor(finiteNumber(layout.y, 0));
  const canvasWidth = positiveInteger(layout.canvasWidth, originX + width);
  const canvasHeight = positiveInteger(layout.canvasHeight, originY + height);
  const minX = Math.max(originX, 0, Math.floor(Math.min(compact.a.x, compact.b.x, compact.c.x) - bleed));
  const minY = Math.max(originY, 0, Math.floor(Math.min(compact.a.y, compact.b.y, compact.c.y) - bleed));
  const maxX = Math.min(originX + width - 1, canvasWidth - 1, Math.ceil(Math.max(compact.a.x, compact.b.x, compact.c.x) + bleed));
  const maxY = Math.min(originY + height - 1, canvasHeight - 1, Math.ceil(Math.max(compact.a.y, compact.b.y, compact.c.y) + bleed));
  let changed = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const point = { x, y };
      if (pointInTriangle(point, compact)) {
        if (setMaskPixel(pixels, width, height, x, y, 255, layout)) {
          changed += 1;
        }
        continue;
      }
      if (bleed <= 0.5) {
        continue;
      }
      const distance = triangleEdgeDistance(point, compact);
      if (distance > bleed) {
        continue;
      }
      const value = Math.round((1 - smoothstep(0, bleed, distance)) * 224);
      if (value > 0) {
        if (setMaskPixel(pixels, width, height, x, y, value, layout)) {
          changed += 1;
        }
      }
    }
  }
  return changed;
}

export function textureAirbrushWebGpuVisibilityMaskPixels(width, height, samples = [], options = {}) {
  const canvasWidth = positiveInteger(width, 1);
  const canvasHeight = positiveInteger(height, 1);
  const bounds = normalizedMaskBounds(canvasWidth, canvasHeight, options.bounds || null);
  const safeWidth = bounds.width;
  const safeHeight = bounds.height;
  const bytesPerRow = options.alignRows === true
    ? alignedBytesPerRow(safeWidth)
    : safeWidth * 4;
  const pixels = new Uint8Array(bytesPerRow * safeHeight);
  const layout = {
    x: bounds.x,
    y: bounds.y,
    width: safeWidth,
    height: safeHeight,
    canvasWidth,
    canvasHeight,
    bytesPerRow
  };
  const radiusPixels = Math.max(0.5, finiteNumber(options.stampRadiusPixels, 0.5));
  const triangleBleedRadiusPixels = Math.max(0, finiteNumber(
    options.triangleBleedRadiusPixels,
    triangleVisibilitySoftCutoffRadius(radiusPixels)
  ));
  let markedPixels = 0;
  for (const triangle of Array.isArray(options.triangles) ? options.triangles : []) {
    markedPixels += stampMaskTriangle(pixels, safeWidth, safeHeight, triangle, triangleBleedRadiusPixels, layout);
  }
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (sample?.segment) {
      markedPixels += stampMaskSegment(pixels, safeWidth, safeHeight, sample.segment, radiusPixels, layout);
      continue;
    }
    markedPixels += stampMaskDisk(pixels, safeWidth, safeHeight, sample, radiusPixels, layout);
  }
  return {
    width: safeWidth,
    height: safeHeight,
    x: bounds.x,
    y: bounds.y,
    bytesPerRow,
    byteLength: pixels.byteLength,
    pixels,
    markedPixels
  };
}

function boundsForPoints(width, height, points = [], radiusPixels = 0) {
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  const finitePoints = points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (!finitePoints.length) {
    return null;
  }
  const radius = Math.max(0, finiteNumber(radiusPixels, 0));
  let minX = safeWidth;
  let minY = safeHeight;
  let maxX = 0;
  let maxY = 0;
  for (const point of finitePoints) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return normalizedMaskBounds(safeWidth, safeHeight, {
    x: Math.floor(minX - radius),
    y: Math.floor(minY - radius),
    width: Math.ceil(maxX - minX + radius * 2 + 1),
    height: Math.ceil(maxY - minY + radius * 2 + 1)
  });
}

function unionBounds(left = null, right = null, width = 1, height = 1) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return normalizedMaskBounds(width, height, {
    x,
    y,
    width: rightEdge - x,
    height: bottomEdge - y
  });
}

function candidateVisibilityMaskBounds(candidate = null, width = 1, height = 1, stampRadiusPixels = 0) {
  const points = [];
  const addPoint = (point = null) => {
    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
      points.push(point);
    }
  };
  addPoint(candidate?.center);
  addPoint(candidate?.start);
  for (const segment of Array.isArray(candidate?.strokeSegments) ? candidate.strokeSegments : []) {
    addPoint(segment?.start);
    addPoint(segment?.end);
  }
  const radiusPixels = Math.max(
    0.5,
    finiteNumber(candidate?.radiusPixels, 0),
    finiteNumber(candidate?.options?.radiusPixels, 0),
    finiteNumber(stampRadiusPixels, 0)
  );
  const scatter = Math.max(0, Math.min(1, finiteNumber(candidate?.options?.scatter, 0.35)));
  const hardness = Math.max(0, Math.min(1, finiteNumber(candidate?.options?.hardness, 0.35)));
  const haloRadius = Math.ceil(Math.max(
    airbrushHaloRadius(radiusPixels, scatter, hardness),
    finiteNumber(stampRadiusPixels, 0)
  ) + 2);
  return boundsForPoints(width, height, points, haloRadius);
}

export function textureAirbrushWebGpuAssignVisibilityMasks(candidates = [], options = {}) {
  const groups = new Map();
  const sampleMaskMode = options.visibilityMaskMode === "samples";
  const skipSamplesWhenTriangles = options.skipVisibilitySamplesWhenTriangles === true;
  for (const [candidateIndex, candidate] of (Array.isArray(candidates) ? candidates : []).entries()) {
    const canvas = candidate?.editable?.canvas || null;
    if (!canvas?.width || !canvas?.height) {
      continue;
    }
    const key = options.keepCandidateVisibilityMasksSeparate === true
      ? `${maskGroupKey(candidate)}:${candidateIndex}`
      : maskGroupKey(candidate);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        width: positiveInteger(canvas.width, 1),
        height: positiveInteger(canvas.height, 1),
        candidates: [],
        samples: [],
        triangles: []
      };
      groups.set(key, group);
    }
    group.candidates.push(candidate);
    if (candidate.center) {
      group.samples.push(candidate.center);
    }
    for (const segment of Array.isArray(candidate.strokeSegments) ? candidate.strokeSegments : []) {
      group.samples.push({ segment });
    }
    for (const sample of Array.isArray(candidate.options?.visibilityMaskSamples) ? candidate.options.visibilityMaskSamples : []) {
      group.samples.push(sample);
    }
    for (const triangle of Array.isArray(candidate.options?.visibilityMaskTriangles) ? candidate.options.visibilityMaskTriangles : []) {
      group.triangles.push(triangle);
    }
  }

  let maskIndex = 0;
  for (const group of groups.values()) {
    const radius = group.candidates.reduce((maxRadius, candidate) => (
      Math.max(maxRadius, finiteNumber(candidate.radiusPixels, 0))
    ), 0);
    const scatter = group.candidates.reduce((maxScatter, candidate) => (
      Math.max(maxScatter, Math.max(0, Math.min(1, finiteNumber(candidate.options?.scatter, 0.35))))
    ), 0);
    const hardness = group.candidates.reduce((minHardness, candidate) => (
      Math.min(minHardness, Math.max(0, Math.min(1, finiteNumber(candidate.options?.hardness, 0.35))))
    ), 1);
    const stampRadiusPixels = Math.max(
      0.75,
      finiteNumber(
        options.visibilityMaskStampRadiusPixels,
        Math.max(airbrushHaloRadius(radius, scatter, hardness) + 1, 1)
      )
    );
    const maskBounds = options.visibilityMaskBoundsMode === "paint"
      ? group.candidates.reduce((bounds, candidate) => unionBounds(
          bounds,
          candidateVisibilityMaskBounds(candidate, group.width, group.height, stampRadiusPixels),
          group.width,
          group.height
        ), null)
      : null;
    const triangles = group.triangles.map(compactVisibilityTriangle).filter(Boolean);
    const triangleLimit = maxUploadedVisibilityTriangles(options);
    const uploadedTriangles = triangles;
    if (Number.isFinite(triangleLimit) && uploadedTriangles.length > triangleLimit) {
      uploadedTriangles.length = triangleLimit;
    }
    const hasTriangleMask = uploadedTriangles.length > 0;
    const visibleEdgeMode = group.candidates.some((candidate) => (
      visibilityEdgeModeForCandidate(candidate, options) === "hard"
    ))
      ? "hard"
      : "soft";
    const hardVisibleEdge = visibleEdgeMode === "hard";
    const triangleBleedRadiusPixels = hardVisibleEdge
      ? 0
      : triangleVisibilitySoftCutoffRadius(stampRadiusPixels);
    const samples = (
      sampleMaskMode
      && skipSamplesWhenTriangles
      && hasTriangleMask
        ? []
        : group.samples
    ).map(compactVisibilitySample).filter(Boolean);
    const mask = sampleMaskMode
      ? null
      : textureAirbrushWebGpuVisibilityMaskPixels(group.width, group.height, group.samples, {
          stampRadiusPixels,
          alignRows: options.visibilityMaskBoundsMode === "paint",
          ...(maskBounds ? { bounds: maskBounds } : {}),
          triangles: uploadedTriangles,
          triangleBleedRadiusPixels: finiteNumber(
            options.visibilityBleedRadius,
            triangleBleedRadiusPixels
          )
        });
    const visibilityPayloadKey = sampleMaskMode
      ? (
          options.compactVisibilityMaskKey === true
            ? `samples:${samples.length}:triangles:${uploadedTriangles.length}`
            : `samples:${samples.length}:${visibilitySamplesKey(samples)}:triangles:${uploadedTriangles.length}:${visibilityTrianglesKey(uploadedTriangles)}`
        )
      : (
          options.compactVisibilityMaskKey === true
            ? `pixels:${mask?.markedPixels || 0}:triangles:${uploadedTriangles.length}`
            : `pixels:${mask.markedPixels}:triangles:${uploadedTriangles.length}:${visibilityTrianglesKey(uploadedTriangles)}`
        );
    const visibilityMaskKey = [
      group.key,
      maskIndex,
      Math.round(stampRadiusPixels * 100),
      `edge:${visibleEdgeMode}`,
      visibilityPayloadKey
    ].join(":");
    maskIndex += 1;
    for (const candidate of group.candidates) {
      // The mask is a camera-facing normal observability permission for WebGPU
      // live paint. A texel can paint when it belongs to a currently observable
      // camera-facing surface sample/triangle. This is not a depth-only rule:
      // do not use depth proximity to authorize normals pointing away from the
      // camera, and do not let unsampled/unobservable UV texels paint.
      candidate.options = {
        ...candidate.options,
        visibilityMaskKey,
        ...(sampleMaskMode
          ? {
              visibilityMaskSamples: samples,
              visibilityMaskTriangles: uploadedTriangles,
              visibilityMaskStampRadiusPixels: stampRadiusPixels
            }
          : {
              visibilityMaskSamples: [],
              visibilityMaskTriangles: [],
              visibilityMaskPixels: (
                mask.x === 0
                && mask.y === 0
                && mask.width === group.width
                && mask.height === group.height
                && mask.bytesPerRow === group.width * 4
              )
                ? mask.pixels
                : mask
            }),
        visibleSurfaceMaskReady: true,
        useVisibilityMask: true,
        visibilityFeatherRadius: hardVisibleEdge
          ? 0
          : Math.max(
              0,
              finiteNumber(
                candidate.options?.visibilityFeatherRadius,
                finiteNumber(options.visibilityFeatherRadius, Math.max(1, stampRadiusPixels * 0.75))
              )
            ),
        visibilityMaskThreshold: Math.max(
          0,
          Math.min(1, finiteNumber(
            candidate.options?.visibilityMaskThreshold,
            finiteNumber(options.visibilityMaskThreshold, 0.02)
          ))
        ),
        visibilityBleedRadius: hardVisibleEdge
          ? 0
          : Math.max(
              0,
              finiteNumber(
                candidate.options?.visibilityBleedRadius,
                finiteNumber(
                  options.visibilityBleedRadius,
                  hasTriangleMask
                    ? triangleBleedRadiusPixels
                    : Math.min(2, Math.max(0.75, stampRadiusPixels * 0.35))
                )
              )
            )
      };
    }
  }
  return candidates;
}
