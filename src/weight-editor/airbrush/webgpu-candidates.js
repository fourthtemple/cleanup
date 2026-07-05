import {
  textureAirbrushFrontIntersections,
  textureAirbrushPointInRect,
  textureAirbrushProbePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent
} from "./projection.js";
import { textureAirbrushWebGpuAssignVisibilityMasks } from "./webgpu-projection.js";
import {
  textureAirbrushWebGpuStrokeCandidateFromHit,
  textureAirbrushWebGpuStrokeEstimate
} from "./webgpu-stroke.js";
import { textureAirbrushRecordIdentity } from "./record-identity.js";

const TEXTURE_AIRBRUSH_WEBGPU_HIT_SAMPLE_CACHE_LIMIT = 2048;

function screenPointDistance(left = null, right = null) {
  if (
    !Number.isFinite(left?.x)
    || !Number.isFinite(left?.y)
    || !Number.isFinite(right?.x)
    || !Number.isFinite(right?.y)
  ) {
    return 0;
  }
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function hitProjectedDepth(editor = null, hit = null) {
  if (!editor?.camera || !hit?.point || typeof hit.point.clone !== "function") {
    const fallback = Number(hit?.distance);
    return Number.isFinite(fallback) ? fallback : null;
  }
  try {
    const projected = hit.point.clone().project(editor.camera);
    const depth = Number(projected?.z);
    return Number.isFinite(depth) ? depth : null;
  } catch {
    const fallback = Number(hit?.distance);
    return Number.isFinite(fallback) ? fallback : null;
  }
}

function hitViewPoint(editor = null, hit = null) {
  if (!editor?.camera?.matrixWorldInverse || !hit?.point || typeof hit.point.clone !== "function") {
    return null;
  }
  try {
    const point = hit.point.clone().applyMatrix4(editor.camera.matrixWorldInverse);
    return (
      Number.isFinite(point?.x)
      && Number.isFinite(point?.y)
      && Number.isFinite(point?.z)
    )
      ? { x: point.x, y: point.y, z: point.z }
      : null;
  } catch {
    return null;
  }
}

function viewRadiusForScreenRadius(editor = null, rect = null, viewZ = null, radiusPixels = 1) {
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const height = Math.max(1, Number(rect?.height) || 1);
  if (editor?.camera?.isOrthographicCamera) {
    const top = Number(editor.camera.top);
    const bottom = Number(editor.camera.bottom);
    const zoom = Math.max(0.0001, Number(editor.camera.zoom) || 1);
    if (Number.isFinite(top) && Number.isFinite(bottom)) {
      return Math.abs(top - bottom) * radius / (height * zoom);
    }
  }
  const fov = Number(editor?.camera?.fov);
  const depth = Math.max(0.0001, Math.abs(Number(viewZ) || 1));
  if (Number.isFinite(fov) && fov > 0) {
    return 2 * Math.tan((fov * Math.PI / 180) * 0.5) * depth * radius / height;
  }
  return radius * 0.03;
}

function viewPointDistance(left = null, right = null) {
  if (
    !Number.isFinite(left?.x)
    || !Number.isFinite(left?.y)
    || !Number.isFinite(left?.z)
    || !Number.isFinite(right?.x)
    || !Number.isFinite(right?.y)
    || !Number.isFinite(right?.z)
  ) {
    return Infinity;
  }
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function nearestDepthSample(samples = [], point = null, maxDistance = Infinity) {
  if (!Array.isArray(samples) || !samples.length || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  let best = null;
  let bestDistance = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : Infinity;
  for (const sample of samples) {
    if (!Number.isFinite(sample?.depth) || !Number.isFinite(sample?.x) || !Number.isFinite(sample?.y)) {
      continue;
    }
    const distance = screenPointDistance(point, sample);
    if (distance <= bestDistance) {
      best = sample;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestViewSample(samples = [], viewPoint = null) {
  if (!Array.isArray(samples) || !samples.length || !viewPoint) {
    return null;
  }
  let best = null;
  let bestDistance = Infinity;
  for (const sample of samples) {
    const distance = viewPointDistance(viewPoint, sample?.view);
    if (distance < bestDistance) {
      best = sample;
      bestDistance = distance;
    }
  }
  return best ? { sample: best, distance: bestDistance } : null;
}

function cachedHitResultKey(point = null) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return "";
  }
  return [
    "hit",
    Math.round(point.clientX * 2),
    Math.round(point.clientY * 2)
  ].join(":");
}

function cachedHitResult(cache = null, key = "") {
  if (!(cache instanceof Map) || !key || !cache.has(key)) {
    return undefined;
  }
  const entry = cache.get(key);
  return entry?.__textureAirbrushHitResult === true
    ? entry.hit || null
    : undefined;
}

function rememberHitResult(cache = null, key = "", hit = null) {
  if (!(cache instanceof Map) || !key) {
    return hit || null;
  }
  cache.set(key, {
    __textureAirbrushHitResult: true,
    hit: hit || null
  });
  while (cache.size > TEXTURE_AIRBRUSH_WEBGPU_HIT_SAMPLE_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return hit || null;
}

function cachedScreenHitsKey(point = null, options = {}) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return "";
  }
  return [
    "hits",
    options.firstOnly === true ? "first" : "all",
    Math.round(point.clientX * 2),
    Math.round(point.clientY * 2)
  ].join(":");
}

function cachedScreenHits(cache = null, key = "") {
  if (!(cache instanceof Map) || !key || !cache.has(key)) {
    return undefined;
  }
  const entry = cache.get(key);
  return entry?.__textureAirbrushScreenHits === true
    ? Array.isArray(entry.hits) ? entry.hits : []
    : undefined;
}

function rememberScreenHits(cache = null, key = "", hits = []) {
  const normalized = Array.isArray(hits) ? hits : [];
  if (!(cache instanceof Map) || !key) {
    return normalized;
  }
  cache.set(key, {
    __textureAirbrushScreenHits: true,
    hits: normalized
  });
  while (cache.size > TEXTURE_AIRBRUSH_WEBGPU_HIT_SAMPLE_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return normalized;
}

function texturePointDistance(left = null, right = null) {
  if (
    !Number.isFinite(left?.x)
    || !Number.isFinite(left?.y)
    || !Number.isFinite(right?.x)
    || !Number.isFinite(right?.y)
  ) {
    return Infinity;
  }
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function orderedStrokeProbePoints(stroke = null, radiusPixels = 1, options = {}) {
  if (!stroke?.center) {
    return [];
  }
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const stepScale = Number.isFinite(Number(options.visibilityProbeStepScale))
    ? Number(options.visibilityProbeStepScale)
    : 0.75;
  const step = Math.max(4, Math.min(24, radius * Math.max(0.5, stepScale)));
  const defaultMaxPoints = radius <= 16 ? 96 : 72;
  const maxPoints = Math.max(
    2,
    Math.min(defaultMaxPoints, Math.floor(Number(options.maxVisibilityProbePoints) || defaultMaxPoints))
  );
  const points = [];
  const seen = new Set();
  const addPoint = (point = null, segment = null) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || points.length >= maxPoints) {
      return;
    }
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const orderedStrokeSegment = Number.isFinite(segment?.start?.x)
      && Number.isFinite(segment?.start?.y)
      && Number.isFinite(segment?.end?.x)
      && Number.isFinite(segment?.end?.y)
      ? {
          start: { x: segment.start.x, y: segment.start.y },
          end: { x: segment.end.x, y: segment.end.y },
          ...(Number.isFinite(Number(segment.radiusPixels)) && Number(segment.radiusPixels) > 0
            ? { radiusPixels: Number(segment.radiusPixels) }
            : {})
        }
      : null;
    points.push({
      x: point.x,
      y: point.y,
      ...(orderedStrokeSegment ? { orderedStrokeSegment } : {})
    });
  };
  const segments = Array.isArray(stroke.strokeSegments) && stroke.strokeSegments.length
    ? stroke.strokeSegments
    : [{ start: stroke.start || stroke.center, end: stroke.center }];
  for (const segment of segments) {
    const start = segment?.start;
    const end = segment?.end;
    if (
      !Number.isFinite(start?.x)
      || !Number.isFinite(start?.y)
      || !Number.isFinite(end?.x)
      || !Number.isFinite(end?.y)
    ) {
      continue;
    }
    addPoint(start, {
      start,
      end: start,
      radiusPixels: segment.radiusPixels
    });
    const distance = screenPointDistance(start, end);
    const sampleCount = Math.max(1, Math.ceil(distance / step));
    let previousPoint = start;
    for (let index = 1; index <= sampleCount; index += 1) {
      if (points.length >= maxPoints) {
        break;
      }
      const ratio = index / sampleCount;
      const point = {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio
      };
      addPoint(point, {
        start: previousPoint,
        end: point,
        radiusPixels: segment.radiusPixels
      });
      previousPoint = point;
    }
  }
  if (!points.length) {
    addPoint(stroke.center);
  }
  return points;
}

function visibilityFootprintProbeBudget(radiusPixels = 1, options = {}) {
  const explicit = Number(options.maxVisibilityFootprintProbePoints);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(4, Math.floor(explicit));
  }
  const radius = Math.max(1, Number(radiusPixels) || 1);
  if (options.cachedStrokeSamplesOnly === true || options.liveProjectedPaint === true) {
    if (radius <= 16) {
      return 48;
    }
    if (radius <= 48) {
      return 96;
    }
    return 96;
  }
  return 144;
}

function evenlySelectedProbePoints(points = [], maxPoints = 0) {
  const probes = Array.isArray(points) ? points.filter((point) => (
    Number.isFinite(point?.x) && Number.isFinite(point?.y)
  )) : [];
  const count = Math.max(0, Math.floor(Number(maxPoints) || 0));
  if (!count || probes.length <= count) {
    return probes;
  }
  if (count === 1) {
    return [probes[0]];
  }
  const selected = [];
  const seen = new Set();
  const addIndex = (index) => {
    const clamped = Math.max(0, Math.min(probes.length - 1, Math.round(index)));
    const point = probes[clamped];
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    selected.push(point);
    return true;
  };
  addIndex(0);
  addIndex(probes.length - 1);
  for (let index = 1; selected.length < count && index < count - 1; index += 1) {
    addIndex((index / Math.max(1, count - 1)) * (probes.length - 1));
  }
  for (let index = 0; selected.length < count && index < probes.length; index += 1) {
    addIndex(index);
  }
  return selected;
}

function denseVisibilityFootprintProbePoints(stroke = null, radiusPixels = 1, options = {}) {
  if (options.skipVisibilityFootprintProbes === true) {
    return [];
  }
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const footprintRadiusScale = Number.isFinite(Number(options.visibilityFootprintProbeRadiusScale))
    ? Math.max(0.1, Math.min(1, Number(options.visibilityFootprintProbeRadiusScale)))
    : 1;
  const probeRadius = Math.max(1, radius * footprintRadiusScale);
  const probes = textureAirbrushProbePointsFromStroke(stroke, probeRadius);
  const maxPoints = Math.max(4, Math.min(
    192,
    visibilityFootprintProbeBudget(radius, options)
  ));
  if (!stroke?.center || probeRadius <= 16 || options.denseVisibilityFootprintProbes === false) {
    return evenlySelectedProbePoints(probes, maxPoints);
  }
  const seen = new Set(probes.map((point) => `${Math.round(point.x)}:${Math.round(point.y)}`));
  const addProbe = (point = null) => {
    if (
      !Number.isFinite(point?.x)
      || !Number.isFinite(point?.y)
    ) {
      return;
    }
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    probes.push({ x: point.x, y: point.y });
  };
  const centers = [];
  const addCenter = (point = null) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      return;
    }
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    if (!centers.some((entry) => entry.key === key)) {
      centers.push({ key, x: point.x, y: point.y });
    }
  };
  addCenter(stroke.center);
  addCenter(stroke.start);
  for (const segment of Array.isArray(stroke.strokeSegments) ? stroke.strokeSegments : []) {
    addCenter(segment?.start);
    addCenter(segment?.end);
    if (
      Number.isFinite(segment?.start?.x)
      && Number.isFinite(segment?.start?.y)
      && Number.isFinite(segment?.end?.x)
      && Number.isFinite(segment?.end?.y)
    ) {
      addCenter({
        x: (segment.start.x + segment.end.x) * 0.5,
        y: (segment.start.y + segment.end.y) * 0.5
      });
    }
  }
  const extraRadii = [probeRadius * 0.25, probeRadius * 0.75];
  const angleOffset = Math.PI * 0.125;
  for (const center of centers) {
    for (const radiusOffset of extraRadii) {
      for (let index = 0; index < 8; index += 1) {
        const angle = angleOffset + index * Math.PI * 0.25;
        addProbe({
          x: center.x + Math.cos(angle) * radiusOffset,
          y: center.y + Math.sin(angle) * radiusOffset
        });
      }
    }
  }
  return evenlySelectedProbePoints(probes, maxPoints);
}

function candidatePassKey(candidate = null) {
  if (!candidate) {
    return "";
  }
  return [
    textureAirbrushRecordIdentity(candidate.record),
    candidate.materialIndex ?? 0,
    candidate.material?.uuid || candidate.material?.id || "material",
    candidate.editable?.texture?.uuid || candidate.editable?.texture?.id || "",
    candidate.editable?.canvas?.width || 0,
    candidate.editable?.canvas?.height || 0
  ].join(":");
}

function candidateDedupKey(candidate = null) {
  return [
    candidatePassKey(candidate),
    Math.round(candidate?.center?.x || 0),
    Math.round(candidate?.center?.y || 0)
  ].join(":");
}

function candidateProjectedSurfacePaintKey(candidate = null) {
  return [
    "projected-surface-paint",
    candidatePassKey(candidate)
  ].join(":");
}

function candidateProjectedSurfacePaintScore(candidate = null) {
  if (!candidate) {
    return 0;
  }
  const regions = Array.isArray(candidate.paintRegions) ? candidate.paintRegions : [];
  const regionArea = regions.reduce((total, region) => (
    total
    + Math.max(0, Math.ceil(Number(region?.width) || 0))
      * Math.max(0, Math.ceil(Number(region?.height) || 0))
  ), 0);
  const triangleCount = Array.isArray(candidate.options?.visibilityMaskTriangles)
    ? candidate.options.visibilityMaskTriangles.length
    : 0;
  return regionArea + triangleCount * 4096 + candidateStrokeLength(candidate);
}

function probeHitCandidateKey(record = null, hit = null, materialIndex = 0) {
  if (!record || !hit?.uv) {
    return "";
  }
  const face = hit.face || {};
  return [
    textureAirbrushRecordIdentity(record),
    hit?.object?.uuid || hit?.object?.id || "",
    Math.floor(Number(materialIndex) || 0),
    hit.faceIndex ?? "face",
    face.a ?? "a",
    face.b ?? "b",
    face.c ?? "c",
    Math.round(Number(hit.uv.x) * 4096),
    Math.round(Number(hit.uv.y) * 4096)
  ].join(":");
}

function candidateStrokeLength(candidate = null) {
  return (candidate?.strokeSegments || []).reduce((total, segment) => {
    const distance = texturePointDistance(segment?.start, segment?.end);
    return Number.isFinite(distance) ? total + distance : total;
  }, 0);
}

function unionCandidateTextureBounds(left = null, right = null) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: Math.max(1, maxX - x),
    height: Math.max(1, maxY - y)
  };
}

function projectedRegionKey(region = null) {
  if (!region) {
    return "";
  }
  return [
    Math.round(Number(region.x) || 0),
    Math.round(Number(region.y) || 0),
    Math.round(Number(region.width) || 0),
    Math.round(Number(region.height) || 0)
  ].join(":");
}

function projectedTriangleKey(triangle = null) {
  if (!triangle) {
    return "";
  }
  const points = [triangle.a, triangle.b, triangle.c, triangle.screenA, triangle.screenB, triangle.screenC];
  return points.map((point) => (
    Number.isFinite(point?.x) && Number.isFinite(point?.y)
      ? `${Math.round(point.x * 10)}:${Math.round(point.y * 10)}`
      : "missing"
  )).join("|");
}

function mergeProjectedSurfacePaintCandidate(target = null, source = null) {
  if (!target || !source) {
    return target || source || null;
  }
  const regions = [];
  const regionKeys = new Set();
  const addRegion = (region = null) => {
    const key = projectedRegionKey(region);
    if (!region || !key || regionKeys.has(key)) {
      return;
    }
    regionKeys.add(key);
    regions.push(region);
  };
  (Array.isArray(target.paintRegions) ? target.paintRegions : []).forEach(addRegion);
  (Array.isArray(source.paintRegions) ? source.paintRegions : []).forEach(addRegion);
  if (regions.length) {
    target.paintRegions = regions;
    target.paintBounds = regions.reduce(
      (bounds, region) => unionCandidateTextureBounds(bounds, region),
      target.paintBounds || source.paintBounds || null
    );
  } else {
    target.paintBounds = unionCandidateTextureBounds(target.paintBounds, source.paintBounds);
  }
  const triangles = [];
  const triangleKeys = new Set();
  const addTriangle = (triangle = null) => {
    const key = projectedTriangleKey(triangle);
    if (!triangle || !key || triangleKeys.has(key)) {
      return;
    }
    triangleKeys.add(key);
    triangles.push(triangle);
  };
  (Array.isArray(target.options?.visibilityMaskTriangles) ? target.options.visibilityMaskTriangles : []).forEach(addTriangle);
  (Array.isArray(source.options?.visibilityMaskTriangles) ? source.options.visibilityMaskTriangles : []).forEach(addTriangle);
  if (triangles.length) {
    target.options = {
      ...target.options,
      visibilityMaskTriangles: triangles
    };
  }
  target.estimate = textureAirbrushWebGpuStrokeEstimate(target);
  return target;
}

function candidateStrokeSegmentPaintRegion(segment = null, canvas = null, radiusPixels = 1) {
  const start = segment?.start || null;
  const end = segment?.end || start;
  if (
    !Number.isFinite(start?.x)
    || !Number.isFinite(start?.y)
    || !Number.isFinite(end?.x)
    || !Number.isFinite(end?.y)
  ) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(canvas?.width) || 1));
  const height = Math.max(1, Math.floor(Number(canvas?.height) || 1));
  const radius = Math.max(0.75, Number(segment?.radiusPixels) || Number(radiusPixels) || 0.75);
  const pad = Math.ceil(radius + 2);
  const minX = Math.min(start.x, end.x) - pad;
  const minY = Math.min(start.y, end.y) - pad;
  const maxX = Math.max(start.x, end.x) + pad;
  const maxY = Math.max(start.y, end.y) + pad;
  const x = Math.max(0, Math.min(width - 1, Math.floor(minX)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(minY)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil(maxX + 1)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil(maxY + 1)));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function candidateStrokePaintRegions(strokeSegments = [], candidate = null) {
  const canvas = candidate?.editable?.canvas || null;
  const radiusPixels = candidate?.radiusPixels || candidate?.options?.radiusPixels || 1;
  const regions = [];
  for (const segment of Array.isArray(strokeSegments) ? strokeSegments : []) {
    const region = candidateStrokeSegmentPaintRegion(segment, canvas, radiusPixels);
    if (region) {
      regions.push(region);
    }
  }
  return regions;
}

function candidateVisibilityOnly(candidate = null) {
  return candidate?.visibilityOnly === true || candidate?.options?.visibilityOnly === true;
}

function connectableTextureCandidates(previous = null, next = null, screenDistance = 0) {
  if (
    !previous
    || !next
    || candidatePassKey(previous) !== candidatePassKey(next)
  ) {
    return false;
  }
  const textureDistance = texturePointDistance(previous.center, next.center);
  if (!Number.isFinite(textureDistance) || textureDistance <= 0.0001) {
    return false;
  }
  const canvas = next.editable?.canvas || previous.editable?.canvas || null;
  const maxTextureSize = Math.max(1, canvas?.width || 1, canvas?.height || 1);
  const radius = Math.max(1, Number(previous.radiusPixels) || 1, Number(next.radiusPixels) || 1);
  const proportionalLimit = Math.max(
    radius * 3,
    Math.max(0, Number(screenDistance) || 0) * radius * 0.2
  );
  const maxTextureDistance = Math.max(
    96,
    Math.min(maxTextureSize * 0.08, proportionalLimit)
  );
  return textureDistance <= maxTextureDistance;
}

function setCandidateStrokeSegments(candidate = null, strokeSegments = []) {
  if (!candidate) {
    return null;
  }
  const nextStrokeSegments = Array.isArray(strokeSegments) ? strokeSegments : [];
  candidate.strokeSegments = nextStrokeSegments;
  const paintRegions = candidateStrokePaintRegions(nextStrokeSegments, candidate);
  if (paintRegions.length) {
    candidate.paintRegions = paintRegions;
    candidate.paintBounds = paintRegions.reduce(
      (bounds, region) => unionCandidateTextureBounds(bounds, region),
      null
    );
  }
  candidate.options = {
    ...candidate.options,
    strokeSegments: nextStrokeSegments
  };
  candidate.estimate = textureAirbrushWebGpuStrokeEstimate(candidate);
  return candidate;
}

function clientStrokeSegmentsFromOrderedProbe(probe = null, rect = null) {
  const segment = probe?.orderedStrokeSegment || null;
  if (
    !rect
    || !Number.isFinite(segment?.start?.x)
    || !Number.isFinite(segment?.start?.y)
    || !Number.isFinite(segment?.end?.x)
    || !Number.isFinite(segment?.end?.y)
  ) {
    return null;
  }
  const radiusPixels = Number(segment.radiusPixels);
  return [{
    start: {
      clientX: (rect.left || 0) + segment.start.x,
      clientY: (rect.top || 0) + segment.start.y
    },
    end: {
      clientX: (rect.left || 0) + segment.end.x,
      clientY: (rect.top || 0) + segment.end.y
    },
    ...(Number.isFinite(radiusPixels) && radiusPixels > 0 ? { radiusPixels } : {})
  }];
}

function hitMaterialIndex(hit = null, options = {}) {
  return hit?.face?.materialIndex
    ?? options.target?.originMaterialIndex
    ?? options.target?.materialIndex
    ?? 0;
}

function averageUv(points = []) {
  const compact = (Array.isArray(points) ? points : [])
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (!compact.length) {
    return null;
  }
  return {
    x: compact.reduce((total, point) => total + point.x, 0) / compact.length,
    y: compact.reduce((total, point) => total + point.y, 0) / compact.length
  };
}

function averageScreenPoint(points = []) {
  const compact = (Array.isArray(points) ? points : [])
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (!compact.length) {
    return null;
  }
  return {
    x: compact.reduce((total, point) => total + point.x, 0) / compact.length,
    y: compact.reduce((total, point) => total + point.y, 0) / compact.length
  };
}

function syntheticHitFromScreenTriangle(entry = null) {
  const face = entry?.face || null;
  const uv = averageUv(entry?.uvs);
  if (!entry?.record || !entry?.object || !face || !uv) {
    return null;
  }
  const screen = Array.isArray(entry.screen) ? entry.screen.slice(0, 3) : null;
  return {
    object: entry.object,
    face,
    faceIndex: entry.faceIndex,
    uv,
    ...(Array.isArray(screen) && screen.length >= 3 ? { screen } : {}),
    ...(Number.isFinite(entry.screenStrokeDistance) ? { distance: entry.screenStrokeDistance } : {})
  };
}

export function installTextureAirbrushWebGpuCandidateMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushWebGpuStrokeCandidateFromHit(record, hit, event, options = {}) {
      return textureAirbrushWebGpuStrokeCandidateFromHit(this, record, hit, event, options);
    },

    textureAirbrushWebGpuCandidatesFromEvent(event = null, options = {}) {
      if (!event || !this.model) {
        return [];
      }
      const hitSampleCache = options.hitSampleCache instanceof Map
        ? options.hitSampleCache
        : (
            options.liveProjectedPaint === true
            || options.visibleSurfaceMaskRequired === true
            || options.requireVisibilityMask === true
          )
            ? new Map()
            : null;
      const hitForEvent = (hitEvent = null, hitOptions = {}) => {
        const key = cachedHitResultKey(hitEvent);
        const cached = cachedHitResult(hitSampleCache, key);
        if (cached !== undefined) {
          return cached;
        }
        return rememberHitResult(
          hitSampleCache,
          key,
          this.texturePaintHitForEvent?.(hitEvent, "airbrush", hitOptions)
        );
      };
      const screenHitsForEvent = (hitEvent = null, hitOptions = {}) => {
        const key = cachedScreenHitsKey(hitEvent, hitOptions);
        const cached = cachedScreenHits(hitSampleCache, key);
        if (cached !== undefined) {
          return cached;
        }
        return rememberScreenHits(
          hitSampleCache,
          key,
          this.textureAirbrushScreenHitsForEvent?.(hitEvent, "airbrush", hitOptions) || []
        );
      };
      const captureDebug = options.captureCandidateDebug === true || this.textureAirbrushCaptureCandidateDebug === true;
      const debug = captureDebug
        ? {
            directHit: false,
            directCandidate: false,
            probeCount: 0,
            intersectionCount: 0,
            frontHitCount: 0,
            candidates: 0,
            rejects: new Map(),
            rejectSamples: []
          }
        : null;
      const debugReject = debug
        ? (reason, detail = null) => {
            debug.rejects.set(reason, (debug.rejects.get(reason) || 0) + 1);
            if (debug.rejectSamples.length < 6) {
              debug.rejectSamples.push({ reason, detail });
            }
          }
        : null;
      const finish = () => {
        if (debug) {
          debug.candidates = candidates.length;
          this.textureAirbrushLastWebGpuCandidateDebug = {
            ...debug,
            rejects: Object.fromEntries(debug.rejects)
          };
        }
        return candidates;
      };
      const requiresVisibilityMask = options.visibleSurfaceMaskRequired === true
        || options.liveProjectedPaint === true
        || options.requireVisibilityMask === true;
      const directVisibilityOnly = requiresVisibilityMask && options.directVisibilityOnly !== false;
      const candidates = [];
      const candidateIndexes = new Map();
      const addCandidate = (candidate) => {
        if (!candidate) {
          return;
        }
        const projectedSurfacePaintCandidate = options.dedupProjectedSurfacePaintCandidates === true
          && candidateVisibilityOnly(candidate) !== true
          && candidate?.options?.liveProjectedPaint === true
          && Array.isArray(candidate?.options?.screenProjectedStrokeSegments)
          && candidate.options.screenProjectedStrokeSegments.length > 0;
        const key = projectedSurfacePaintCandidate
          ? candidateProjectedSurfacePaintKey(candidate)
          : candidateDedupKey(candidate);
        const existingIndex = candidateIndexes.get(key);
        if (existingIndex != null) {
          const existing = candidates[existingIndex];
          const existingVisibilityOnly = candidateVisibilityOnly(existing);
          const candidateIsVisibilityOnly = candidateVisibilityOnly(candidate);
          if (existingVisibilityOnly && !candidateIsVisibilityOnly) {
            candidates[existingIndex] = candidate;
            return;
          }
          if (
            projectedSurfacePaintCandidate
            && existingVisibilityOnly === candidateIsVisibilityOnly
            && candidateProjectedSurfacePaintScore(candidate) > candidateProjectedSurfacePaintScore(existing)
          ) {
            if (
              existing.projectedSurfacePrimaryCandidate === true
              && candidate.projectedSurfacePrimaryCandidate !== true
            ) {
              mergeProjectedSurfacePaintCandidate(existing, candidate);
            } else {
              candidates[existingIndex] = candidate;
            }
            return;
          }
          if (
            projectedSurfacePaintCandidate
            && existingVisibilityOnly === candidateIsVisibilityOnly
            && candidate.projectedSurfacePrimaryCandidate === true
            && existing.projectedSurfacePrimaryCandidate !== true
          ) {
            mergeProjectedSurfacePaintCandidate(candidate, existing);
            candidates[existingIndex] = candidate;
            return;
          }
          if (
            projectedSurfacePaintCandidate
            && existingVisibilityOnly === candidateIsVisibilityOnly
            && existing.projectedSurfacePrimaryCandidate === true
            && candidate.projectedSurfacePrimaryCandidate !== true
          ) {
            return;
          }
          if (
            existingVisibilityOnly === candidateIsVisibilityOnly
            && candidateStrokeLength(candidate) > candidateStrokeLength(existing)
          ) {
            candidates[existingIndex] = candidate;
          }
          return;
        }
        candidateIndexes.set(key, candidates.length);
        candidates.push(candidate);
      };
      const editableByMaterial = new Map();
      const editableForMaterial = (material = null) => {
        if (!material) {
          return null;
        }
        if (editableByMaterial.has(material)) {
          return editableByMaterial.get(material);
        }
        const baseEditable = this.editableClonePaintTexture?.(material) || null;
        let editable = baseEditable;
        const layerModeRequested = options.layerMode === true
          || (
            this.texturePaintLayerModeActive?.() === true
            && (
              typeof this.texturePaintHasActivePaintLayer !== "function"
              || this.texturePaintHasActivePaintLayer(material) === true
            )
          );
        if (layerModeRequested && typeof this.texturePaintEditableLayerTarget === "function") {
          const layerEditable = this.texturePaintEditableLayerTarget(material, baseEditable);
          if (layerEditable?.layerMode === true && layerEditable?.canvas && layerEditable?.context) {
            editable = layerEditable;
          }
        }
        editableByMaterial.set(material, editable || null);
        return editable || null;
      };

      let directHit = null;
      let directHitComputed = false;
      const indexedDirectHitForEvent = (hitEvent = null) => {
        if (
          !requiresVisibilityMask
          || options.useScreenHitIndex === false
          || typeof this.textureAirbrushScreenHitsForEvent !== "function"
        ) {
          return undefined;
        }
        const rect = options.screenHitRect || this.canvas?.getBoundingClientRect?.() || null;
        if (!rect?.width || !rect?.height) {
          return undefined;
        }
        const allowAnimationProgressMismatch = options.allowAnimationProgressMismatch === true
          || this.painting === true
          || this.textureAirbrushScreenStrokeHasPendingWork?.() === true;
        const indexedHits = screenHitsForEvent(hitEvent, {
          rect,
          allowAnimationProgressMismatch,
          firstOnly: true
        }).slice(0, 1);
        const indexedHit = indexedHits[0] || null;
        if (indexedHit?.record && indexedHit?.hit) {
          return indexedHit;
        }
        const screenIndexReady = this.textureAirbrushScreenHitIndexCurrent?.(
          this.textureAirbrushScreenHitIndex,
          rect,
          { allowAnimationProgressMismatch }
        ) === true;
        return screenIndexReady && directVisibilityOnly && options.raycastFallbackOnScreenMiss !== true
          ? null
          : undefined;
      };
      const getDirectHit = () => {
        if (directHitComputed) {
          return directHit;
        }
        directHitComputed = true;
        const indexedHit = indexedDirectHitForEvent(event);
        directHit = indexedHit !== undefined
          ? rememberHitResult(hitSampleCache, cachedHitResultKey(event), indexedHit)
          : hitForEvent(
            event,
            options.cachedStrokeSamplesOnly === true ? { refreshSkinnedBounds: false } : {}
          );
        if (debug) {
          debug.directHit = Boolean(directHit?.record && directHit?.hit);
        }
        return directHit;
      };
      let directCandidate = null;
      let directCandidateComputed = false;
      const getDirectCandidate = () => {
        if (directCandidateComputed) {
          return directCandidate;
        }
        const hitResult = getDirectHit();
        directCandidateComputed = true;
        const directHitRecord = hitResult?.record || null;
        const directHit = hitResult?.hit || null;
        const directMaterialIndex = hitMaterialIndex(directHit, options);
        const directMaterial = directHit?.uv
          ? this.clonePaintMaterialForHit?.(directHitRecord, directHit)
          : undefined;
        if (
          options.neighborPaintSeed?.enabled === true
          && directHitRecord
          && directHit
          && this.textureAirbrushNeighborHitAllowed?.(
            options.neighborPaintSeed,
            directHitRecord,
            directHit,
            directMaterial,
            directMaterialIndex
          ) === false
        ) {
          debugReject?.("neighbor-rejected", {
            recordId: textureAirbrushRecordIdentity(directHitRecord, ""),
            objectId: directHit?.object?.uuid || directHit?.object?.id || "",
            faceIndex: directHit?.faceIndex ?? null,
            materialName: directMaterial?.name || "",
            materialIndex: directMaterialIndex
          });
          if (debug) {
            debug.directCandidate = false;
          }
          return null;
        }
        const directEditable = directMaterial ? editableForMaterial(directMaterial) : null;
        const candidateOptions = debugReject
          ? { ...options, debugReject }
          : options;
        directCandidate = this.textureAirbrushWebGpuStrokeCandidateFromHit?.(
          directHitRecord,
          directHit,
          event,
          {
            ...candidateOptions,
            ...(directMaterial ? { resolvedMaterial: directMaterial, resolvedMaterialIndex: directMaterialIndex } : {}),
            ...(directEditable ? { resolvedEditable: directEditable } : {})
          }
        ) || null;
        if (debug) {
          debug.directCandidate = Boolean(directCandidate);
        }
        return directCandidate;
      };
      if (!requiresVisibilityMask) {
        addCandidate(getDirectCandidate());
      }
      if (directVisibilityOnly) {
        addCandidate(getDirectCandidate());
        if (options.deferVisibilityMaskAssignment !== true) {
          textureAirbrushWebGpuAssignVisibilityMasks(candidates, options);
        }
        return finish();
      }

      if (!this.canvas || !this.camera || !this.raycaster) {
        addCandidate(getDirectCandidate());
        if (requiresVisibilityMask) {
          textureAirbrushWebGpuAssignVisibilityMasks(candidates, options);
        }
        return finish();
      }
      if (this.clonePaintTargets?.size && !requiresVisibilityMask) {
        return finish();
      }
      const rect = this.canvas.getBoundingClientRect?.();
      const stroke = textureAirbrushScreenStrokeFromEvent(event, rect, options);
      if (!rect || !stroke) {
        return finish();
      }
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!paintRecords.length) {
        return finish();
      }
      const useScreenHitProbeIndex = typeof this.texturePaintHitForEvent === "function"
        && options.useScreenHitIndex !== false;
      const allowNeighborUnderIntersections = options.neighborPaintSeed?.enabled === true;
      const neighborPaintSeed = options.neighborPaintSeed || null;
      const maxNeighborVisibilityIntersections = Math.max(
        1,
        Math.floor(Number(options.maxNeighborVisibilityIntersections) || 16)
      );
      let raycastBoundsRefreshed = false;
      const ensureRaycastBounds = () => {
        if (raycastBoundsRefreshed) {
          return;
        }
        this.refreshSkinnedRaycastBounds?.();
        raycastBoundsRefreshed = true;
      };
      this.model.updateMatrixWorld?.(options.forceMatrixWorldUpdate === true);
      const paintObjects = paintRecords.map((record) => record.object);
      const recordByObject = new Map(paintRecords.map((record) => [record.object, record]));
      const convertedProbeHitKeys = new Set();
      const projectedSurfaceDepthSamples = [];
      const projectedSurfaceViewSamples = [];

      const projectProbe = (probe, projectOptions = {}) => {
        if (!textureAirbrushPointInRect(probe, rect)) {
          return false;
        }
        let probeConvertedCandidate = false;
        const probeAllowsNeighborUnderIntersections = allowNeighborUnderIntersections
          && projectOptions.allowNeighborUnderIntersections !== false;
        const probeEvent = {
          clientX: (rect.left || 0) + probe.x,
          clientY: (rect.top || 0) + probe.y,
          pointerType: event.pointerType || "",
          pressure: event.pressure,
          button: event.button ?? 0,
          buttons: event.buttons ?? 1
        };
        const addProbeCandidate = (record, hit) => {
          if (!record || !hit) {
            return false;
          }
          const hitDepth = hitProjectedDepth(this, hit);
          if (projectOptions.collectDepthSample === true && Number.isFinite(hitDepth)) {
            const view = hitViewPoint(this, hit);
            const radiusWorld = view
              ? viewRadiusForScreenRadius(this, rect, view.z, probe.orderedStrokeSegment?.radiusPixels || brushRadius)
              : null;
            projectedSurfaceDepthSamples.push({
              x: probe.x,
              y: probe.y,
              depth: hitDepth
            });
            if (view && Number.isFinite(radiusWorld)) {
              projectedSurfaceViewSamples.push({
                x: probe.x,
                y: probe.y,
                view,
                radiusWorld
              });
            }
          }
          if (Array.isArray(projectOptions.depthContinuitySamples)) {
            const nearestDepth = nearestDepthSample(
              projectOptions.depthContinuitySamples,
              probe,
              Math.max(8, Number(projectOptions.depthContinuityRadiusPixels) || brushRadius * 1.25)
            );
            const depthWindow = Math.max(
              0.004,
              Number(projectOptions.depthContinuityWindow) || Number(options.visibilityFootprintDepthWindow) || 0.035
            );
            if (
              nearestDepth
              && Number.isFinite(hitDepth)
              && Math.abs(hitDepth - nearestDepth.depth) > depthWindow
            ) {
              debugReject?.("depth-discontinuous-footprint-probe", {
                depth: hitDepth,
                nearestDepth: nearestDepth.depth,
                delta: Math.abs(hitDepth - nearestDepth.depth),
                depthWindow
              });
              return false;
            }
          }
          if (Array.isArray(projectOptions.viewContinuitySamples)) {
            const view = hitViewPoint(this, hit);
            const nearestView = nearestViewSample(projectOptions.viewContinuitySamples, view);
            const multiplier = Math.max(
              0.5,
              Number(projectOptions.viewContinuityRadiusScale)
              || Number(options.visibilityFootprintViewRadiusScale)
              || 1.35
            );
            if (
              view
              && nearestView
              && nearestView.distance > Math.max(0.25, nearestView.sample.radiusWorld * multiplier)
            ) {
              debugReject?.("view-discontinuous-footprint-probe", {
                distance: nearestView.distance,
                radiusWorld: nearestView.sample.radiusWorld,
                multiplier
              });
              return false;
            }
          }
          const materialIndex = hitMaterialIndex(hit, options);
          const material = hit?.uv
            ? this.clonePaintMaterialForHit?.(record, hit)
            : undefined;
          if (
            neighborPaintSeed?.enabled === true
            && this.textureAirbrushNeighborHitAllowed?.(
              neighborPaintSeed,
              record,
              hit,
              material,
              materialIndex
            ) === false
          ) {
            debugReject?.("neighbor-rejected", {
              recordId: textureAirbrushRecordIdentity(record, ""),
              objectId: hit?.object?.uuid || hit?.object?.id || "",
              faceIndex: hit?.faceIndex ?? null,
              materialName: material?.name || "",
              materialIndex
            });
            return false;
          }
          const duplicateProbeHitKey = probeHitCandidateKey(record, hit, materialIndex);
          if (
            duplicateProbeHitKey
            && projectOptions.connectPath !== true
            && options.skipDuplicateProbeHitCandidates !== false
            && convertedProbeHitKeys.has(duplicateProbeHitKey)
          ) {
            return false;
          }
          const maxProbeVisibilityTriangles = Number(options.maxProbeVisibilityTriangles);
          const probeVisibilityTriangleLimit = Number.isFinite(maxProbeVisibilityTriangles) && maxProbeVisibilityTriangles > 0
            ? Math.floor(maxProbeVisibilityTriangles)
            : options.maxVisibilityTriangles;
          const resolvedEditable = hit?.uv && material ? editableForMaterial(material) : null;
          const candidateStrokeSegments = projectOptions.connectPath === true
            ? clientStrokeSegmentsFromOrderedProbe(probe, rect)
            : null;
          const candidate = this.textureAirbrushWebGpuStrokeCandidateFromHit?.(
            record,
            hit,
            probeEvent,
            debugReject
              ? {
                  ...options,
	                  debugReject,
	                  strokeStart: null,
	                  strokeSegments: candidateStrokeSegments,
	                  ...(projectOptions.connectPath === true ? { skipStrokePathResampling: true } : {}),
	                  maxVisibilityTriangles: probeVisibilityTriangleLimit,
	                  ...(resolvedEditable ? { resolvedEditable } : {}),
	                  ...(hit?.uv ? { resolvedMaterial: material, resolvedMaterialIndex: materialIndex } : {})
	                }
	              : {
	                  ...options,
	                  strokeStart: null,
	                  strokeSegments: candidateStrokeSegments,
	                  ...(projectOptions.connectPath === true ? { skipStrokePathResampling: true } : {}),
	                  maxVisibilityTriangles: probeVisibilityTriangleLimit,
	                  ...(resolvedEditable ? { resolvedEditable } : {}),
	                  ...(hit?.uv ? { resolvedMaterial: material, resolvedMaterialIndex: materialIndex } : {})
	                }
          );
          if (duplicateProbeHitKey && candidate) {
            convertedProbeHitKeys.add(duplicateProbeHitKey);
          }
          if (candidate) {
            probeConvertedCandidate = true;
          }
          if (projectOptions.connectPath === true && candidate) {
            const key = candidatePassKey(candidate);
            const previous = projectOptions.previousByKey?.get(key) || null;
            if (
              candidate.visibilityOnly !== true
              && candidate.options?.visibilityOnly !== true
              &&
              previous?.candidate
              && connectableTextureCandidates(
                previous.candidate,
                candidate,
                screenPointDistance(previous.probe, probe)
              )
            ) {
              // Keep live WebGPU strokes continuous only across consecutive
              // front-surface samples from the same material pass.
              setCandidateStrokeSegments(candidate, [{
                start: { x: previous.candidate.center.x, y: previous.candidate.center.y },
                end: { x: candidate.center.x, y: candidate.center.y }
              }]);
            }
            projectOptions.previousByKey?.set(key, {
              candidate,
              probe: { x: probe.x, y: probe.y }
            });
          }
          if (projectOptions.visibilityOnly === true && candidate) {
            candidate.visibilityOnly = true;
            candidate.options = {
              ...candidate.options,
              visibilityOnly: true
            };
          }
          addCandidate(candidate);
          return Boolean(candidate);
        };
        if (useScreenHitProbeIndex) {
          const allowAnimationProgressMismatch = options.allowAnimationProgressMismatch === true
            || this.painting === true
            || this.textureAirbrushScreenStrokeHasPendingWork?.() === true;
          let screenIndexReady = this.textureAirbrushScreenHitIndexCurrent?.(
            this.textureAirbrushScreenHitIndex,
            rect,
            { allowAnimationProgressMismatch }
          ) === true;
          const indexedHits = typeof this.textureAirbrushScreenHitsForEvent === "function"
            ? (
                probeAllowsNeighborUnderIntersections
                  ? screenHitsForEvent(probeEvent, { rect, maxHits: maxNeighborVisibilityIntersections })
                  : screenHitsForEvent(probeEvent, { rect, firstOnly: true })
                    .slice(0, 1)
              )
            : [];
          if (indexedHits.length) {
            if (debug) {
              debug.intersectionCount += indexedHits.length;
              debug.frontHitCount += indexedHits.length;
            }
            let indexedCandidates = 0;
            for (const indexedHit of indexedHits) {
              if (addProbeCandidate(indexedHit.record, indexedHit.hit)) {
                indexedCandidates += 1;
              }
              if (
                probeAllowsNeighborUnderIntersections
                && indexedCandidates >= maxNeighborVisibilityIntersections
              ) {
                break;
              }
            }
            if (indexedCandidates > 0) {
              return true;
            }
          }
          if (!screenIndexReady) {
            screenIndexReady = this.textureAirbrushScreenHitIndexCurrent?.(
              this.textureAirbrushScreenHitIndex,
              rect,
              { allowAnimationProgressMismatch }
            ) === true;
          }
          if (screenIndexReady && options.raycastFallbackOnScreenMiss !== true) {
            return probeConvertedCandidate;
          }
          const indexedHit = hitForEvent(probeEvent, {
            refreshSkinnedBounds: false
          });
          if (indexedHit?.record && indexedHit?.hit) {
            if (debug) {
              debug.intersectionCount += 1;
              debug.frontHitCount += 1;
            }
            addProbeCandidate(indexedHit.record, indexedHit.hit);
            if (!probeAllowsNeighborUnderIntersections) {
              return probeConvertedCandidate;
            }
          }
          if (screenIndexReady && options.raycastFallbackOnScreenMiss !== true) {
            return probeConvertedCandidate;
          }
        }
        ensureRaycastBounds();
        this.pointer.x = (probe.x / rect.width) * 2 - 1;
        this.pointer.y = -(probe.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        if (debug) {
          debug.intersectionCount += intersections.length;
        }
        if (probeAllowsNeighborUnderIntersections) {
          let raycastCandidates = 0;
          for (const hit of intersections) {
            if (debug) {
              debug.frontHitCount += 1;
            }
            const record = recordByObject.get(hit.object);
            if (!record) {
              continue;
            }
            if (addProbeCandidate(record, hit)) {
              raycastCandidates += 1;
            }
            if (raycastCandidates >= maxNeighborVisibilityIntersections) {
              break;
            }
          }
        } else {
          for (const hit of textureAirbrushFrontIntersections(intersections)) {
            if (debug) {
              debug.frontHitCount += 1;
            }
            const record = recordByObject.get(hit.object);
            if (!record) {
              continue;
            }
            addProbeCandidate(record, hit);
          }
        }
        return probeConvertedCandidate;
      };

      const paintProjectedSurfaceCandidates = options.paintProjectedSurfaceCandidates === true;
      const primaryProjectedPaintCandidate = (
        requiresVisibilityMask
        && options.liveProjectedPaint === true
      )
        ? getDirectCandidate()
        : null;
      if (primaryProjectedPaintCandidate) {
        primaryProjectedPaintCandidate.projectedSurfacePrimaryCandidate = true;
        addCandidate(primaryProjectedPaintCandidate);
      }
      if (
        paintProjectedSurfaceCandidates
        && options.projectedSurfaceScreenCandidateGroups === true
        && primaryProjectedPaintCandidate?.material
        && primaryProjectedPaintCandidate?.editable
        && typeof this.textureAirbrushScreenTrianglesNearSegments === "function"
      ) {
        const screenStrokeSegments = Array.isArray(stroke.strokeSegments) && stroke.strokeSegments.length
          ? stroke.strokeSegments
          : [{ start: stroke.start || stroke.center, end: stroke.center }];
        const groupedScreenTriangles = this.textureAirbrushScreenTrianglesNearSegments(
          screenStrokeSegments,
          Math.max(brushRadius, brushRadius * (1.18 + Math.max(0, Math.min(1, Number(options.scatter) || 0)) * 0.42) + 4),
          {
            rect,
            materialIndex: primaryProjectedPaintCandidate.materialIndex,
            material: primaryProjectedPaintCandidate.material,
            editable: primaryProjectedPaintCandidate.editable,
            allowAnimationProgressMismatch: true,
            surfaceContinuityFilter: options.screenSurfaceContinuityFilter !== false,
            surfaceContinuitySamplesIgnoreMaterial: true,
            surfaceContinuityRadiusScale: options.surfaceContinuityRadiusScale,
            surfaceContinuityDepthWindow: options.surfaceContinuityDepthWindow,
            surfaceContinuityKeepDisconnected: options.surfaceContinuityKeepDisconnected === true,
            maxSurfaceContinuitySamples: options.maxSurfaceContinuitySamples,
            frontSurfaceFilter: options.screenSurfaceFrontFilter,
            skipTransparentTextureTriangles: options.skipTransparentScreenTextureTriangles,
            maxTriangles: Math.max(
              64,
              Math.min(
                4096,
                Math.floor(Number(options.maxProjectedSurfaceScreenTriangles) || Number(options.maxVisibilityTriangles) || 2048)
              )
            )
          }
        );
        const groupedByPass = new Map();
        for (const entry of groupedScreenTriangles) {
          const hit = syntheticHitFromScreenTriangle(entry);
          if (!hit) {
            continue;
          }
          const materialIndex = hitMaterialIndex(hit, options);
          const material = this.clonePaintMaterialForHit?.(entry.record, hit);
          const editable = material ? editableForMaterial(material) : null;
          if (!material || !editable) {
            continue;
          }
          const key = [
            textureAirbrushRecordIdentity(entry.record, ""),
            materialIndex,
            material.uuid || material.id || "material",
            editable.texture?.uuid || editable.texture?.id || "",
            editable.canvas?.width || 0,
            editable.canvas?.height || 0
          ].join("|");
          if (!groupedByPass.has(key)) {
            groupedByPass.set(key, { entry, hit, material, editable, materialIndex });
          }
        }
        if (debug) {
          debug.projectedScreenTriangleEntries = groupedScreenTriangles.length;
          debug.projectedScreenTriangleGroups = groupedByPass.size;
        }
        const groupedClientStrokeSegments = screenStrokeSegments
          .map((segment) => {
            const start = segment?.start;
            const end = segment?.end;
            if (
              !Number.isFinite(start?.x)
              || !Number.isFinite(start?.y)
              || !Number.isFinite(end?.x)
              || !Number.isFinite(end?.y)
            ) {
              return null;
            }
            const radiusPixels = Number(segment.radiusPixels);
            return {
              start: {
                clientX: (rect.left || 0) + start.x,
                clientY: (rect.top || 0) + start.y
              },
              end: {
                clientX: (rect.left || 0) + end.x,
                clientY: (rect.top || 0) + end.y
              },
              ...(Number.isFinite(radiusPixels) && radiusPixels > 0 ? { radiusPixels } : {})
            };
          })
          .filter(Boolean);
        const groupedStrokeStart = groupedClientStrokeSegments[0]?.start || null;
        for (const group of groupedByPass.values()) {
          const center = averageScreenPoint(group.entry.screen);
          const syntheticEvent = {
            clientX: (rect.left || 0) + (center?.x ?? stroke.center.x),
            clientY: (rect.top || 0) + (center?.y ?? stroke.center.y),
            pointerType: event.pointerType || "",
            pressure: event.pressure,
            button: event.button ?? 0,
            buttons: event.buttons ?? 1
          };
          const candidate = this.textureAirbrushWebGpuStrokeCandidateFromHit?.(
            group.entry.record,
            group.hit,
            syntheticEvent,
            {
              ...options,
              debugReject,
              ...(groupedStrokeStart ? { strokeStart: groupedStrokeStart } : { strokeStart: null }),
              ...(groupedClientStrokeSegments.length ? { strokeSegments: groupedClientStrokeSegments } : {}),
              resolvedEditable: group.editable,
              resolvedMaterial: group.material,
              resolvedMaterialIndex: group.materialIndex,
              maxVisibilityTriangles: Math.floor(Number(options.maxVisibilityTriangles) || 2048)
            }
          );
          if (candidate) {
            addCandidate(candidate);
          }
        }
      }
      let orderedCandidateCount = 0;
      let orderedConvertedProbeCount = 0;
      if (requiresVisibilityMask) {
        const previousByKey = new Map();
        const candidateCountBeforeOrderedProbes = candidates.length;
        for (const probe of orderedStrokeProbePoints(stroke, brushRadius, options)) {
          if (projectProbe(probe, {
            allowNeighborUnderIntersections,
            connectPath: true,
            collectDepthSample: paintProjectedSurfaceCandidates,
            previousByKey,
            visibilityOnly: !paintProjectedSurfaceCandidates
              && Boolean(primaryProjectedPaintCandidate)
              && options.paintOrderedProbeCandidates !== true
          })) {
            orderedConvertedProbeCount += 1;
          }
        }
        orderedCandidateCount = Math.max(0, candidates.length - candidateCountBeforeOrderedProbes);
        if (!candidates.length) {
          addCandidate(getDirectCandidate());
        }
      }
      const orderedNeighborSamplesResolved = allowNeighborUnderIntersections
        && orderedConvertedProbeCount > 0;
      const shouldProjectFootprintProbes = !requiresVisibilityMask
        || options.liveProjectedPaint !== true
        || options.fullBrushVisibilityProbes === true
        || (orderedCandidateCount <= 0 && !orderedNeighborSamplesResolved);
      if (shouldProjectFootprintProbes) {
        const probes = denseVisibilityFootprintProbePoints(stroke, brushRadius, options);
        if (debug) {
          debug.probeCount = probes.length;
        }
        const footprintAllowsNeighborUnderIntersections = options.liveProjectedPaint === true
          ? (
              !paintProjectedSurfaceCandidates
              && (
                options.neighborPaintSeed?.enabled === true
                || options.largeLiveNeighborPaint === true
              )
            )
          : true;
        for (const probe of probes) {
          projectProbe(probe, {
            allowNeighborUnderIntersections: footprintAllowsNeighborUnderIntersections,
            ...(paintProjectedSurfaceCandidates
              ? {
                  viewContinuitySamples: projectedSurfaceViewSamples,
                  viewContinuityRadiusScale: options.visibilityFootprintViewRadiusScale
                }
              : {}),
            visibilityOnly: !paintProjectedSurfaceCandidates
              && options.liveProjectedPaint === true
              && requiresVisibilityMask
              && Boolean(primaryProjectedPaintCandidate)
          });
        }
      } else if (debug) {
        debug.probeCount = 0;
      }
      if (requiresVisibilityMask && options.deferVisibilityMaskAssignment !== true) {
        textureAirbrushWebGpuAssignVisibilityMasks(candidates, options);
      }
      return finish();
    }
  });
}
