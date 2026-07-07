import { Vector3 } from "../../../node_modules/three/build/three.webgpu.js";
import {
  TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE
} from "./constants.js";
import { airbrushHaloRadius } from "./math.js";
import { textureAirbrushRecordIdentity } from "./record-identity.js";

const TEXTURE_AIRBRUSH_WEBGPU_TRIANGLE_CACHE_LIMIT = 4096;
const TEXTURE_AIRBRUSH_WEBGPU_TRIANGLE_LIST_CACHE_LIMIT = 4096;
const TEXTURE_AIRBRUSH_WEBGPU_LOCAL_RADIUS_CACHE_LIMIT = 4096;
const TEXTURE_AIRBRUSH_WEBGPU_VERTEX_SCREEN_CACHE_LIMIT = 8192;
const TEXTURE_AIRBRUSH_WEBGPU_HIT_SAMPLE_CACHE_LIMIT = 2048;
const TEXTURE_AIRBRUSH_WEBGPU_FACING_COVERAGE_CACHE_LIMIT = 8192;
const TEXTURE_AIRBRUSH_WEBGPU_PROJECTED_SURFACE_CACHE_LIMIT = 128;
const TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_CAPACITY = Math.max(
  1,
  Math.floor(
    (TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS - TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE)
      / 4
  )
);
const _textureAirbrushGeometryComponentStates = new WeakMap();

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finitePoint(point = null) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  const output = {
    x: point.x,
    y: point.y
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

function projectedSurfaceBrushDomainRadius(radiusPixels = 1, scatter = 0, hardness = 0.35) {
  const haloRadius = airbrushHaloRadius(Math.max(0.75, Number(radiusPixels) || 0.75), scatter, hardness);
  return Math.max(haloRadius + 12, haloRadius * 1.45 + 8);
}

function boundedCacheSet(map = null, key = "", value = null, limit = 1024) {
  if (!(map instanceof Map) || !key) {
    return false;
  }
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
  return true;
}

function stableCacheId(value = null, fallback = "") {
  return value?.uuid || value?.id || value?.name || fallback;
}

function roundedCacheNumber(value = null, scale = 100000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * scale) : "n";
}

function matrixCacheSample(matrix = null) {
  const elements = matrix?.elements || matrix || null;
  if (!elements?.length) {
    return "";
  }
  return Array.from(elements)
    .map((value) => roundedCacheNumber(value, 1000000))
    .join(",");
}

function webGpuStrokeFrameCacheKey(editor = null) {
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  const depthKey = typeof editor?.textureAirbrushDepthCacheKey === "function"
    ? editor.textureAirbrushDepthCacheKey(rect)
    : "";
  if (depthKey) {
    const frameKey = `depth:${depthKey}`;
    const cached = editor?.textureAirbrushWebGpuStrokeFrameKeyCache || null;
    if (cached?.stamp === frameKey && cached.frameKey === frameKey) {
      return cached.frameKey;
    }
    if (editor) {
      editor.textureAirbrushWebGpuStrokeFrameKeyCache = {
        stamp: frameKey,
        frameKey
      };
    }
    return frameKey;
  }
  const camera = editor?.camera || null;
  const stamp = [
    "camera",
    Number(editor?.textureAirbrushCameraPrewarmSerial) || 0,
    rect?.left ?? 0,
    rect?.top ?? 0,
    rect?.width ?? 0,
    rect?.height ?? 0,
    roundedCacheNumber(editor?.progress, 1000000),
    roundedCacheNumber(editor?.mixer?.time, 1000000),
    roundedCacheNumber(editor?.activeClipAction?.time, 1000000),
    matrixCacheSample(camera?.matrixWorldInverse),
    matrixCacheSample(camera?.projectionMatrix)
  ].join(":");
  const cached = editor?.textureAirbrushWebGpuStrokeFrameKeyCache || null;
  if (cached?.stamp === stamp && typeof cached.frameKey === "string") {
    return cached.frameKey;
  }
  const frameKey = stamp;
  if (editor) {
    editor.textureAirbrushWebGpuStrokeFrameKeyCache = {
      stamp,
      frameKey
    };
  }
  return frameKey;
}

function webGpuStrokePoseCacheKey(editor = null, object = null) {
  const skinned = object?.isSkinnedMesh === true
    || typeof object?.applyBoneTransform === "function"
    || typeof object?.boneTransform === "function";
  const progress = Number(editor?.progress);
  const mixerTime = Number(editor?.mixer?.time);
  const actionTime = Number(editor?.activeClipAction?.time);
  const poseKey = [
    Number.isFinite(progress) ? roundedCacheNumber(progress, 1000000) : "",
    Number.isFinite(mixerTime) ? roundedCacheNumber(mixerTime, 1000000) : "",
    Number.isFinite(actionTime) ? roundedCacheNumber(actionTime, 1000000) : ""
  ].filter((value) => value !== "").join(":");
  if (skinned && !poseKey) {
    return "";
  }
  return skinned ? poseKey : "static";
}

function frameScopedEditorCache(editor = null, property = "", frameKey = "", limit = 1024) {
  if (!editor || !property || !frameKey) {
    return null;
  }
  let cache = editor[property] || null;
  if (!cache || cache.frameKey !== frameKey || !(cache.entries instanceof Map)) {
    cache = {
      frameKey,
      entries: new Map(),
      limit
    };
    editor[property] = cache;
  }
  return cache.entries;
}

function pointDistance(left = null, right = null) {
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

function clientPointDistance(left = null, right = null) {
  if (
    !Number.isFinite(left?.clientX)
    || !Number.isFinite(left?.clientY)
    || !Number.isFinite(right?.clientX)
    || !Number.isFinite(right?.clientY)
  ) {
    return 0;
  }
  const dx = right.clientX - left.clientX;
  const dy = right.clientY - left.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function viewPointFromScreenVertex(point = null) {
  return Number.isFinite(point?.viewX)
    && Number.isFinite(point?.viewY)
    && Number.isFinite(point?.viewZ)
    ? {
        x: point.viewX,
        y: point.viewY,
        z: point.viewZ
      }
    : null;
}

function viewNormalFromScreenTriangle(screen = null) {
  if (!Array.isArray(screen) || screen.length < 3) {
    return null;
  }
  const points = screen.slice(0, 3).map(viewPointFromScreenVertex);
  if (!points.every(Boolean)) {
    return null;
  }
  const edgeAx = points[1].x - points[0].x;
  const edgeAy = points[1].y - points[0].y;
  const edgeAz = points[1].z - points[0].z;
  const edgeBx = points[2].x - points[0].x;
  const edgeBy = points[2].y - points[0].y;
  const edgeBz = points[2].z - points[0].z;
  const normalX = edgeAy * edgeBz - edgeAz * edgeBy;
  const normalY = edgeAz * edgeBx - edgeAx * edgeBz;
  const normalZ = edgeAx * edgeBy - edgeAy * edgeBx;
  const length = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
  return length > 0.000001
    ? { x: normalX / length, y: normalY / length, z: normalZ / length }
    : null;
}

function viewNormalFromHit(editor = null, hit = null) {
  const screenNormal = viewNormalFromScreenTriangle(Array.isArray(hit?.screen) ? hit.screen : null);
  if (screenNormal) {
    return screenNormal;
  }
  const faceNormal = hit?.face?.normal || null;
  const object = hit?.object || null;
  const camera = editor?.camera || null;
  if (
    !Number.isFinite(faceNormal?.x)
    || !Number.isFinite(faceNormal?.y)
    || !Number.isFinite(faceNormal?.z)
    || !object?.matrixWorld
    || !camera?.matrixWorldInverse
  ) {
    return null;
  }
  const normal = new Vector3(faceNormal.x, faceNormal.y, faceNormal.z);
  normal.transformDirection(object.matrixWorld);
  normal.transformDirection(camera.matrixWorldInverse);
  return Number.isFinite(normal.x) && Number.isFinite(normal.y) && Number.isFinite(normal.z)
    ? { x: normal.x, y: normal.y, z: normal.z }
    : null;
}

function viewPointFromHit(editor = null, hit = null, clientPoint = null) {
  const point = hit?.point || null;
  const camera = editor?.camera || null;
  if (
    point
    && camera?.matrixWorldInverse
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && Number.isFinite(point.z)
  ) {
    const view = new Vector3(point.x, point.y, point.z);
    view.applyMatrix4(camera.matrixWorldInverse);
    return Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.z)
      ? { x: view.x, y: view.y, z: view.z }
      : null;
  }
  const screen = Array.isArray(hit?.screen) ? hit.screen : [];
  const screenPoint = screenPointFromClientPoint(editor, clientPoint);
  if (!screenPoint || screen.length < 3) {
    return null;
  }
  const screenTriangle = {
    a: screen[0],
    b: screen[1],
    c: screen[2]
  };
  const barycentric = barycentricPoint(screenPoint, screenTriangle)
    || barycentricPoint(closestPointOnTriangle(screenPoint, screenTriangle), screenTriangle);
  const views = screen.slice(0, 3).map(viewPointFromScreenVertex);
  if (!barycentric || !views.every(Boolean)) {
    return null;
  }
  const view = {
    x: views[0].x * barycentric.u + views[1].x * barycentric.v + views[2].x * barycentric.w,
    y: views[0].y * barycentric.u + views[1].y * barycentric.v + views[2].y * barycentric.w,
    z: views[0].z * barycentric.u + views[1].z * barycentric.v + views[2].z * barycentric.w
  };
  return Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.z)
    ? view
    : null;
}

function viewRadiusForScreenRadius(camera = null, rect = null, viewZ = null, radiusPixels = 1) {
  const elements = camera?.projectionMatrix?.elements || null;
  const radius = Math.max(0.5, Number(radiusPixels) || 0.5);
  const depth = Math.max(0.0001, Math.abs(Number(viewZ) || 0));
  if (!elements || !rect?.width || !rect?.height) {
    return radius * 0.01;
  }
  const xScale = Math.abs(Number(elements[0]) || 0);
  const yScale = Math.abs(Number(elements[5]) || 0);
  const xUnits = xScale > 0.000001
    ? (2 * depth * radius) / (xScale * rect.width)
    : Infinity;
  const yUnits = yScale > 0.000001
    ? (2 * depth * radius) / (yScale * rect.height)
    : Infinity;
  const finite = [xUnits, yUnits].filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : radius * 0.01;
}

function clientPointsMatch(left = null, right = null, tolerance = 0.25) {
  if (
    !Number.isFinite(left?.clientX)
    || !Number.isFinite(left?.clientY)
    || !Number.isFinite(right?.clientX)
    || !Number.isFinite(right?.clientY)
  ) {
    return false;
  }
  return Math.abs(left.clientX - right.clientX) <= tolerance
    && Math.abs(left.clientY - right.clientY) <= tolerance;
}

function hitSampleCacheKey(point = null, record = null, material = null, materialIndex = 0, neighborKey = "") {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return "";
  }
  const parts = [
    textureAirbrushRecordIdentity(record),
    materialIndex ?? 0,
    material?.uuid || material?.id || "material"
  ];
  if (neighborKey) {
    parts.push(neighborKey);
  }
  parts.push(
    Math.round(point.clientX * 2),
    Math.round(point.clientY * 2)
  );
  return parts.join(":");
}

function hitResultCacheKey(point = null) {
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

function screenIndexedHitResultForClientPoint(editor = null, pointEvent = null, event = null, options = {}) {
  if (
    !editor
    || !pointEvent
    || options.useScreenHitIndex === false
    || typeof editor.textureAirbrushScreenHitsForEvent !== "function"
    || !(
      options.liveProjectedPaint === true
      || options.visibleSurfaceMaskRequired === true
      || options.requireVisibilityMask === true
    )
  ) {
    return undefined;
  }
  const rect = options.screenHitRect || editor.canvas?.getBoundingClientRect?.() || null;
  const allowAnimationProgressMismatch = options.allowAnimationProgressMismatch === true
    || editor.painting === true
    || editor.textureAirbrushScreenStrokeHasPendingWork?.() === true;
  const hitSampleCache = options.hitSampleCache instanceof Map ? options.hitSampleCache : null;
  const screenHitsKey = cachedScreenHitsKey(pointEvent, { firstOnly: true });
  const cachedHits = cachedScreenHits(hitSampleCache, screenHitsKey);
  const hits = cachedHits !== undefined
    ? cachedHits
    : rememberScreenHits(
        hitSampleCache,
        screenHitsKey,
        editor.textureAirbrushScreenHitsForEvent(pointEvent, "airbrush", {
          ...(rect ? { rect } : {}),
          allowAnimationProgressMismatch,
          firstOnly: true
        }) || []
      );
  const indexedHit = hits[0] || null;
  if (indexedHit?.record && indexedHit?.hit) {
    return indexedHit;
  }
  const screenIndexReady = typeof editor.textureAirbrushScreenHitIndexCurrent === "function"
    ? editor.textureAirbrushScreenHitIndexCurrent(editor.textureAirbrushScreenHitIndex, rect, {
        allowAnimationProgressMismatch
      }) === true
    : false;
  if (screenIndexReady && options.raycastFallbackOnScreenMiss !== true) {
    return null;
  }
  return undefined;
}

function compactHitSample(sample = null) {
  if (
    !Number.isFinite(sample?.client?.clientX)
    || !Number.isFinite(sample?.client?.clientY)
    || !Number.isFinite(sample?.pixel?.x)
    || !Number.isFinite(sample?.pixel?.y)
  ) {
    return null;
  }
  const triangle = compactVisibilityTriangle(sample.triangle);
  const view = Number.isFinite(sample?.view?.x)
    && Number.isFinite(sample?.view?.y)
    && Number.isFinite(sample?.view?.z)
    ? {
        x: sample.view.x,
        y: sample.view.y,
        z: sample.view.z
      }
    : null;
  const normal = Number.isFinite(sample?.normal?.x)
    && Number.isFinite(sample?.normal?.y)
    && Number.isFinite(sample?.normal?.z)
    ? {
        x: sample.normal.x,
        y: sample.normal.y,
        z: sample.normal.z
      }
    : null;
  const component = Math.floor(Number(sample?.component));
  return {
    client: {
      clientX: sample.client.clientX,
      clientY: sample.client.clientY
    },
    pixel: {
      x: sample.pixel.x,
      y: sample.pixel.y
    },
    ...(view ? { view } : {}),
    ...(normal ? { normal } : {}),
    ...(Number.isInteger(component) && component >= 0 ? { component } : {}),
    ...(triangle ? { triangle } : {})
  };
}

function cachedHitSample(cache = null, key = "") {
  return cache instanceof Map && key && cache.has(key)
    ? compactHitSample(cache.get(key))
    : null;
}

function rememberHitSample(cache = null, key = "", sample = null) {
  const compact = compactHitSample(sample);
  if (!(cache instanceof Map) || !key || !compact) {
    return compact;
  }
  cache.set(key, compact);
  while (cache.size > TEXTURE_AIRBRUSH_WEBGPU_HIT_SAMPLE_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return compact;
}

function clientPointAtRatio(start = null, end = null, ratio = 0) {
  const safeRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (
    !Number.isFinite(start?.clientX)
    || !Number.isFinite(start?.clientY)
    || !Number.isFinite(end?.clientX)
    || !Number.isFinite(end?.clientY)
  ) {
    return null;
  }
  return {
    clientX: start.clientX + (end.clientX - start.clientX) * safeRatio,
    clientY: start.clientY + (end.clientY - start.clientY) * safeRatio
  };
}

function textureSegmentCanConnect(start = null, end = null, clientStart = null, clientEnd = null, radiusPixels = 1, canvas = null) {
  const textureDistance = pointDistance(start, end);
  if (!Number.isFinite(textureDistance) || textureDistance <= 0.0001) {
    return false;
  }
  const maxTextureSize = Math.max(1, canvas?.width || 1, canvas?.height || 1);
  const radius = Math.max(0.75, Number(radiusPixels) || 0.75);
  const screenDistance = clientPointDistance(clientStart, clientEnd);
  const proportionalLimit = Math.max(
    radius * 3,
    screenDistance * radius * 0.2
  );
  const textureLimit = Math.max(
    96,
    Math.min(maxTextureSize * 0.08, proportionalLimit)
  );
  return textureDistance <= textureLimit;
}

function textureStrokeSegmentLength(segment = null) {
  return pointDistance(segment?.start, segment?.end);
}

function textureProjectedSeamSegmentIsLocal(segment = null, radiusPixels = 1, canvas = null) {
  const length = textureStrokeSegmentLength(segment);
  if (!Number.isFinite(length) || length <= 0.0001) {
    return false;
  }
  const radius = Math.max(0.75, Number(segment?.radiusPixels) || Number(radiusPixels) || 0.75);
  const maxTextureSize = Math.max(1, Number(canvas?.width) || 1, Number(canvas?.height) || 1);
  const limit = Math.max(
    12,
    Math.min(
      maxTextureSize * 0.08,
      Math.max(radius * 3, 96)
    )
  );
  return length <= limit;
}

function appendLinkedSeamProjectedStrokeSegments(strokeSegments = [], seamSegments = [], radiusPixels = 1, canvas = null) {
  if (!Array.isArray(strokeSegments) || !Array.isArray(seamSegments) || !seamSegments.length) {
    return 0;
  }
  let added = 0;
  const seamLinkLimit = Math.max(24, Math.min(Math.max(1, Number(canvas?.width) || 1, Number(canvas?.height) || 1) * 0.025, Math.max(1, Number(radiusPixels) || 1) * 2.5));
  const segmentNearExistingStroke = (segment = null) => {
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    if (!start || !end) {
      return false;
    }
    const midpoint = {
      x: (start.x + end.x) * 0.5,
      y: (start.y + end.y) * 0.5
    };
    return strokeSegments.some((existing) => (
      pointToTextureSegmentDistance(start, existing) <= seamLinkLimit
      || pointToTextureSegmentDistance(end, existing) <= seamLinkLimit
      || pointToTextureSegmentDistance(midpoint, existing) <= seamLinkLimit
    ));
  };
  const seen = new Set(strokeSegments.map((segment) => [
    Math.round((Number(segment?.start?.x) || 0) * 10),
    Math.round((Number(segment?.start?.y) || 0) * 10),
    Math.round((Number(segment?.end?.x) || 0) * 10),
    Math.round((Number(segment?.end?.y) || 0) * 10),
    Math.round((Number(segment?.radiusPixels) || 0) * 10)
  ].join(":")));
  for (const segment of seamSegments) {
    if (strokeSegments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
      break;
    }
    if (!textureProjectedSeamSegmentIsLocal(segment, radiusPixels, canvas)) {
      continue;
    }
    if (!segmentNearExistingStroke(segment)) {
      continue;
    }
    const key = [
      Math.round((Number(segment?.start?.x) || 0) * 10),
      Math.round((Number(segment?.start?.y) || 0) * 10),
      Math.round((Number(segment?.end?.x) || 0) * 10),
      Math.round((Number(segment?.end?.y) || 0) * 10),
      Math.round((Number(segment?.radiusPixels) || 0) * 10)
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    if (pushTextureSegment(strokeSegments, segment.start, segment.end, {
      radiusPixels: segment.radiusPixels,
      screenStart: segment.screenStart,
      screenEnd: segment.screenEnd,
      screenRadiusPixels: segment.screenRadiusPixels,
      componentStart: segment.componentStart,
      componentEnd: segment.componentEnd
    })) {
      seen.add(key);
      added += 1;
    }
  }
  return added;
}

function pointToTextureSegmentDistance(point = null, segment = null) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!finitePoint(point) || !start || !end) {
    return Infinity;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.0001) {
    return pointDistance(point, end);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSq));
  return pointDistance(point, {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t
  });
}

function pruneCoveredTexturePointStamps(strokeSegments = [], radiusPixels = 1) {
  if (!Array.isArray(strokeSegments) || strokeSegments.length <= 1) {
    return strokeSegments;
  }
  const radius = Math.max(0.75, Number(radiusPixels) || 0.75);
  const pointCoverageDistance = Math.max(1.5, radius * 0.3);
  const nonZeroSegments = strokeSegments.filter((segment) => textureStrokeSegmentLength(segment) > 0.001);
  if (!nonZeroSegments.length) {
    return strokeSegments;
  }
  return strokeSegments.filter((segment) => {
    if (textureStrokeSegmentLength(segment) > 0.001) {
      return true;
    }
    const point = finitePoint(segment?.start);
    if (!point) {
      return false;
    }
    return !nonZeroSegments.some((nonZeroSegment) => (
      pointToTextureSegmentDistance(point, nonZeroSegment) <= pointCoverageDistance
    ));
  });
}

function pushTextureSegment(segments = [], start = null, end = null, options = {}) {
  if (
    !Number.isFinite(start?.x)
    || !Number.isFinite(start?.y)
    || !Number.isFinite(end?.x)
    || !Number.isFinite(end?.y)
    || segments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
  ) {
    return false;
  }
  segments.push({
    start: {
      x: start.x,
      y: start.y
    },
    end: {
      x: end.x,
      y: end.y
    },
    ...(Number.isFinite(options.screenStart?.x) && Number.isFinite(options.screenStart?.y)
      ? { screenStart: { x: options.screenStart.x, y: options.screenStart.y } }
      : {}),
    ...(Number.isFinite(options.screenEnd?.x) && Number.isFinite(options.screenEnd?.y)
      ? { screenEnd: { x: options.screenEnd.x, y: options.screenEnd.y } }
      : {}),
    ...(Number.isFinite(options.viewStart?.x) && Number.isFinite(options.viewStart?.y) && Number.isFinite(options.viewStart?.z)
      ? { viewStart: { x: options.viewStart.x, y: options.viewStart.y, z: options.viewStart.z } }
      : {}),
    ...(Number.isFinite(options.viewEnd?.x) && Number.isFinite(options.viewEnd?.y) && Number.isFinite(options.viewEnd?.z)
      ? { viewEnd: { x: options.viewEnd.x, y: options.viewEnd.y, z: options.viewEnd.z } }
      : {}),
    ...(Number.isFinite(options.viewNormalStart?.x) && Number.isFinite(options.viewNormalStart?.y) && Number.isFinite(options.viewNormalStart?.z)
      ? { viewNormalStart: { x: options.viewNormalStart.x, y: options.viewNormalStart.y, z: options.viewNormalStart.z } }
      : {}),
    ...(Number.isFinite(options.viewNormalEnd?.x) && Number.isFinite(options.viewNormalEnd?.y) && Number.isFinite(options.viewNormalEnd?.z)
      ? { viewNormalEnd: { x: options.viewNormalEnd.x, y: options.viewNormalEnd.y, z: options.viewNormalEnd.z } }
      : {}),
    ...(Number.isFinite(Number(options.viewRadiusPixels)) && Number(options.viewRadiusPixels) > 0
      ? { viewRadiusPixels: Number(options.viewRadiusPixels) }
      : {}),
    ...(Number.isFinite(Number(options.screenRadiusPixels)) && Number(options.screenRadiusPixels) > 0
      ? { screenRadiusPixels: Number(options.screenRadiusPixels) }
      : {}),
    ...(Number.isFinite(Number(options.componentStart)) && Number(options.componentStart) >= 0
      ? { componentStart: Math.floor(Number(options.componentStart)) }
      : {}),
    ...(Number.isFinite(Number(options.componentEnd)) && Number(options.componentEnd) >= 0
      ? { componentEnd: Math.floor(Number(options.componentEnd)) }
      : {}),
    ...(Number.isFinite(Number(options.radiusPixels)) && Number(options.radiusPixels) > 0
      ? { radiusPixels: Number(options.radiusPixels) }
      : {})
  });
  return true;
}

function clientEventFromPoint(point = null, sourceEvent = null) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return null;
  }
  return {
    clientX: point.clientX,
    clientY: point.clientY,
    pointerType: sourceEvent?.pointerType || "",
    pressure: sourceEvent?.pressure,
    button: sourceEvent?.button ?? 0,
    buttons: sourceEvent?.buttons ?? 1,
    altKey: Boolean(sourceEvent?.altKey),
    ctrlKey: Boolean(sourceEvent?.ctrlKey),
    metaKey: Boolean(sourceEvent?.metaKey),
    shiftKey: Boolean(sourceEvent?.shiftKey),
    preventDefault: () => {},
    stopPropagation: () => {}
  };
}

function materialEditableDebug(material = null, editable = null) {
  const userData = material?.userData || {};
  const gpuEntry = userData.textureAirbrushGpuTarget || null;
  const map = material?.map || null;
  return {
    hasMaterial: Boolean(material),
    hasMap: Boolean(map),
    mapName: map?.name || "",
    mapImageType: map?.image?.constructor?.name || "",
    mapImageWidth: map?.image?.width || map?.image?.naturalWidth || 0,
    mapImageHeight: map?.image?.height || map?.image?.naturalHeight || 0,
    hasCloneCanvas: Boolean(userData.clonePaintCanvas),
    hasCloneContext: Boolean(userData.clonePaintContext),
    cloneTextureMatchesMap: Boolean(userData.clonePaintTexture && userData.clonePaintTexture === map),
    hasGpuEntry: Boolean(gpuEntry),
    gpuEntryMatchesMap: Boolean(gpuEntry?.target?.texture && map === gpuEntry.target.texture),
    gpuSourceName: gpuEntry?.sourceTexture?.name || "",
    gpuSourceImageType: gpuEntry?.sourceTexture?.image?.constructor?.name || "",
    gpuSourceImageWidth: gpuEntry?.sourceTexture?.image?.width || gpuEntry?.sourceTexture?.image?.naturalWidth || 0,
    gpuSourceImageHeight: gpuEntry?.sourceTexture?.image?.height || gpuEntry?.sourceTexture?.image?.naturalHeight || 0,
    hasEditable: Boolean(editable),
    hasEditableCanvas: Boolean(editable?.canvas),
    hasEditableContext: Boolean(editable?.context),
    hasEditableTexture: Boolean(editable?.texture)
  };
}

function hitDebug(record = null, hit = null) {
  const uv = hit?.uv || null;
  return {
    hasRecord: Boolean(record),
    objectName: record?.object?.name || hit?.object?.name || "",
    hasHit: Boolean(hit),
    hasUv: Boolean(uv),
    uvX: Number.isFinite(uv?.x) ? uv.x : null,
    uvY: Number.isFinite(uv?.y) ? uv.y : null,
    distance: Number.isFinite(hit?.distance) ? hit.distance : null,
    faceIndex: Number.isInteger(hit?.faceIndex) ? hit.faceIndex : null,
    materialIndex: Number.isInteger(hit?.face?.materialIndex) ? hit.face.materialIndex : null
  };
}

function materialIndexForHit(hit = null, fallback = 0) {
  return hit?.face?.materialIndex ?? fallback;
}

function materialForRecordIndex(record = null, materialIndex = 0) {
  const materials = Array.isArray(record?.object?.material)
    ? record.object.material
    : [record?.object?.material].filter(Boolean);
  if (!materials.length) {
    return null;
  }
  return materials[Math.max(0, Math.floor(Number(materialIndex) || 0))]
    || materials.find((material) => material?.map)
    || materials[0]
    || null;
}

function editablePaintTargetsMatch(left = null, right = null) {
  return Boolean(
    left
    && right
    && (
      left === right
      || (left.canvas && left.canvas === right.canvas)
      || (left.texture && left.texture === right.texture)
      || (left.layer && left.layer === right.layer)
    )
  );
}

function materialPaintTargetMatches(editor = null, material = null, editable = null, sourceMaterial = null) {
  if (!material) {
    return false;
  }
  if (sourceMaterial && material === sourceMaterial) {
    return true;
  }
  const materialEditable = editor?.editableClonePaintTexture?.(material) || null;
  return editablePaintTargetsMatch(materialEditable, editable);
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
  const screenBScale = hasScreenTriangle ? screenPerspectiveScale(screenA, screenB) : null;
  const screenCScale = hasScreenTriangle ? screenPerspectiveScale(screenA, screenC) : null;
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

function uvAttributePoint(uvAttribute = null, index = -1) {
  if (!uvAttribute || !Number.isInteger(index) || index < 0) {
    return null;
  }
  const x = typeof uvAttribute.getX === "function"
    ? uvAttribute.getX(index)
    : uvAttribute.array?.[index * 2];
  const y = typeof uvAttribute.getY === "function"
    ? uvAttribute.getY(index)
    : uvAttribute.array?.[index * 2 + 1];
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function mappedTextureUvFromUv(editor = null, uv = null, texture = null) {
  if (!Number.isFinite(uv?.x) || !Number.isFinite(uv?.y)) {
    return null;
  }
  const mapped = { x: uv.x, y: uv.y };
  const elements = texture?.matrix?.elements || null;
  if (elements && elements.length >= 9) {
    const x = mapped.x;
    const y = mapped.y;
    mapped.x = elements[0] * x + elements[3] * y + elements[6];
    mapped.y = elements[1] * x + elements[4] * y + elements[7];
  } else if (typeof editor?.clonePaintTextureUv === "function") {
    const cloneableUv = {
      x: uv.x,
      y: uv.y,
      clone() {
        return {
          x: uv.x,
          y: uv.y,
          applyMatrix3(matrix) {
            const matrixElements = matrix?.elements || null;
            if (matrixElements && matrixElements.length >= 9) {
              const currentX = this.x;
              const currentY = this.y;
              this.x = matrixElements[0] * currentX + matrixElements[3] * currentY + matrixElements[6];
              this.y = matrixElements[1] * currentX + matrixElements[4] * currentY + matrixElements[7];
            }
            return this;
          }
        };
      }
    };
    const cloneMapped = editor.clonePaintTextureUv(cloneableUv, texture);
    if (Number.isFinite(cloneMapped?.x) && Number.isFinite(cloneMapped?.y)) {
      mapped.x = cloneMapped.x;
      mapped.y = cloneMapped.y;
    }
  }
  return mapped;
}

function texturePixelFromUvRelative(editor = null, uv = null, editable = null, referenceUv = null) {
  const canvas = editable?.canvas || null;
  const texture = editable?.texture || null;
  if (!canvas || !texture || !Number.isFinite(uv?.x) || !Number.isFinite(uv?.y)) {
    return null;
  }
  if (texture.matrixAutoUpdate !== false && typeof texture.updateMatrix === "function") {
    texture.updateMatrix();
  }
  const mapped = mappedTextureUvFromUv(editor, uv, texture);
  if (!mapped) {
    return null;
  }
  const referenceMapped = mappedTextureUvFromUv(editor, referenceUv, texture);
  if (referenceMapped) {
    mapped.x = editor?.clonePaintUnwrapTextureCoordinate?.(mapped.x, referenceMapped.x, texture?.wrapS) ?? mapped.x;
    mapped.y = editor?.clonePaintUnwrapTextureCoordinate?.(mapped.y, referenceMapped.y, texture?.wrapT) ?? mapped.y;
    const pixel = editor?.clonePaintPixelFromMappedTextureUv?.(mapped, canvas, texture, { wrap: false }) || null;
    const seamMarginPixels = Math.max(
      4,
      Math.min(128, Math.max(canvas.width, canvas.height) * 0.03)
    );
    return (
      Number.isFinite(pixel?.x)
      && Number.isFinite(pixel?.y)
      && pixel.x >= -seamMarginPixels
      && pixel.y >= -seamMarginPixels
      && pixel.x <= canvas.width - 1 + seamMarginPixels
      && pixel.y <= canvas.height - 1 + seamMarginPixels
    )
      ? pixel
      : null;
  }
  return editor?.clonePaintPixelFromMappedTextureUv?.(mapped, canvas, texture, { wrap: true }) || null;
}

function texturePixelsFromUvTriangle(editor = null, uvs = [], editable = null) {
  const canvas = editable?.canvas || null;
  const texture = editable?.texture || null;
  if (!canvas || !texture || !Array.isArray(uvs) || uvs.length !== 3) {
    return null;
  }
  if (texture.matrixAutoUpdate !== false && typeof texture.updateMatrix === "function") {
    texture.updateMatrix();
  }
  const mappedPoints = uvs.map((uv) => mappedTextureUvFromUv(editor, uv, texture));
  if (!mappedPoints.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    return null;
  }
  const base = mappedPoints[0];
  return mappedPoints.map((point) => {
    const mapped = {
      x: editor?.clonePaintUnwrapTextureCoordinate?.(point.x, base.x, texture?.wrapS) ?? point.x,
      y: editor?.clonePaintUnwrapTextureCoordinate?.(point.y, base.y, texture?.wrapT) ?? point.y
    };
    return editor?.clonePaintPixelFromMappedTextureUv?.(mapped, canvas, texture, { wrap: false }) || null;
  });
}

function smoothstep(edge0, edge1, value) {
  const range = edge1 - edge0;
  if (!Number.isFinite(range) || Math.abs(range) <= 0.000001) {
    return value < edge0 ? 0 : 1;
  }
  const t = Math.max(0, Math.min(1, (value - edge0) / range));
  return t * t * (3 - 2 * t);
}

function normalFacingCoverage(normalZ = null) {
  if (!Number.isFinite(normalZ)) {
    return 0;
  }
  return smoothstep(0, 0.18, normalZ);
}

function vertexViewPoint(editor = null, record = null, object = null, vertexIndex = -1) {
  const position = record?.geometry?.attributes?.position || object?.geometry?.attributes?.position || null;
  const camera = editor?.camera || null;
  if (!position || !object || !camera?.matrixWorldInverse || !Number.isInteger(vertexIndex) || vertexIndex < 0) {
    return null;
  }
  const point = new Vector3();
  if (typeof object.getVertexPosition === "function") {
    object.getVertexPosition(vertexIndex, point);
  } else if (typeof object.applyBoneTransform === "function") {
    if (typeof point.fromBufferAttribute === "function") {
      point.fromBufferAttribute(position, vertexIndex);
    }
    object.applyBoneTransform(vertexIndex, point);
  } else if (typeof object.boneTransform === "function") {
    object.boneTransform(vertexIndex, point);
  } else if (typeof point.fromBufferAttribute === "function") {
    point.fromBufferAttribute(position, vertexIndex);
  } else {
    point.x = typeof position.getX === "function" ? position.getX(vertexIndex) : position.array?.[vertexIndex * 3];
    point.y = typeof position.getY === "function" ? position.getY(vertexIndex) : position.array?.[vertexIndex * 3 + 1];
    point.z = typeof position.getZ === "function" ? position.getZ(vertexIndex) : position.array?.[vertexIndex * 3 + 2];
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    return null;
  }
  object.localToWorld?.(point);
  if (typeof point.applyMatrix4 === "function") {
    point.applyMatrix4(camera.matrixWorldInverse);
  }
  return point;
}

function cameraFacingNormalZForVertices(editor = null, record = null, object = null, vertices = []) {
  if (!Array.isArray(vertices) || vertices.length !== 3) {
    return null;
  }
  const points = vertices.map((vertexIndex) => vertexViewPoint(editor, record, object, vertexIndex));
  if (!points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z))) {
    return null;
  }
  const edgeAx = points[1].x - points[0].x;
  const edgeAy = points[1].y - points[0].y;
  const edgeAz = points[1].z - points[0].z;
  const edgeBx = points[2].x - points[0].x;
  const edgeBy = points[2].y - points[0].y;
  const edgeBz = points[2].z - points[0].z;
  const normalX = edgeAy * edgeBz - edgeAz * edgeBy;
  const normalY = edgeAz * edgeBx - edgeAx * edgeBz;
  const normalZ = edgeAx * edgeBy - edgeAy * edgeBx;
  const length = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
  return length > 0.000001 ? normalZ / length : null;
}

function cameraFacingCoverageForHit(editor = null, record = null, hit = null, vertices = null) {
  const object = record?.object || hit?.object || null;
  const faceVertices = Array.isArray(vertices) && vertices.length === 3
    ? vertices
    : [hit?.face?.a, hit?.face?.b, hit?.face?.c]
      .map((index) => Math.floor(Number(index)))
      .filter((index) => Number.isInteger(index) && index >= 0);
  const viewNormalZ = cameraFacingNormalZForVertices(editor, record, object, faceVertices);
  if (Number.isFinite(viewNormalZ)) {
    return normalFacingCoverage(viewNormalZ);
  }
  const faceNormalZ = Number(hit?.face?.normal?.z);
  return normalFacingCoverage(Number.isFinite(faceNormalZ) ? faceNormalZ : null);
}

function cameraFacingCoverageForTriangle(editor = null, record = null, hit = null, triangle = null) {
  const vertices = Array.isArray(triangle?.vertices) && triangle.vertices.length === 3
    ? triangle.vertices
    : null;
  if (!vertices) {
    return cameraFacingCoverageForHit(editor, record, hit, null);
  }
  const object = record?.object || hit?.object || null;
  const poseKey = webGpuStrokePoseCacheKey(editor, object);
  if (!poseKey) {
    return cameraFacingCoverageForHit(editor, record, hit, vertices);
  }
  const frameKey = webGpuStrokeFrameCacheKey(editor);
  const cache = frameScopedEditorCache(
    editor,
    "textureAirbrushWebGpuFacingCoverageCache",
    frameKey,
    TEXTURE_AIRBRUSH_WEBGPU_FACING_COVERAGE_CACHE_LIMIT
  );
  const key = cache
    ? [
        stableCacheId(record, "record"),
        stableCacheId(object, "object"),
        stableCacheId(record?.geometry || hit?.object?.geometry, "geometry"),
        poseKey,
        triangle.index ?? "triangle",
        vertices[0],
        vertices[1],
        vertices[2],
        Number.isFinite(Number(hit?.face?.normal?.z)) ? Number(hit.face.normal.z) : "n"
      ].join(":")
    : "";
  if (key && cache.has(key)) {
    return cache.get(key);
  }
  const coverage = cameraFacingCoverageForHit(editor, record, hit, vertices);
  if (key) {
    boundedCacheSet(
      cache,
      key,
      coverage,
      TEXTURE_AIRBRUSH_WEBGPU_FACING_COVERAGE_CACHE_LIMIT
    );
  }
  return coverage;
}

function visibilityTriangleFromHit(editor = null, record = null, hit = null, editable = null, referenceUv = null) {
  const face = hit?.face || null;
  const uvAttribute = record?.geometry?.attributes?.uv || hit?.object?.geometry?.attributes?.uv || null;
  if (!face || !uvAttribute) {
    return null;
  }
  const indexes = [face.a, face.b, face.c].map((index) => Math.floor(Number(index)));
  if (!indexes.every((index) => Number.isInteger(index) && index >= 0)) {
    return null;
  }
  const uvs = indexes.map((index) => uvAttributePoint(uvAttribute, index));
  const points = texturePixelsFromUvTriangle(editor, uvs, editable)
    || uvs.map((uv) => texturePixelFromUvRelative(editor, uv, editable, referenceUv));
  if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    return null;
  }
  const coverage = cameraFacingCoverageForHit(editor, record, hit, indexes);
  if (coverage <= 0) {
    return null;
  }
  return compactVisibilityTriangle({
    a: points[0],
    b: points[1],
    c: points[2],
    coverage,
    componentId: textureAirbrushComponentIdForHit(editor, record, hit)
  });
}

const visibilityTriangleGeometryCache = new WeakMap();

function attributeCount(attribute = null) {
  if (Number.isInteger(attribute?.count)) {
    return attribute.count;
  }
  if (attribute?.array?.length) {
    return Math.floor(attribute.array.length / (attribute.itemSize || 2));
  }
  return 0;
}

function indexAttributeValue(indexAttribute = null, index = -1) {
  if (!indexAttribute || !Number.isInteger(index) || index < 0) {
    return null;
  }
  const value = typeof indexAttribute.getX === "function"
    ? indexAttribute.getX(index)
    : indexAttribute.array?.[index];
  return Number.isInteger(value) ? value : Math.floor(Number(value));
}

function triangleEdgeKey(left = -1, right = -1) {
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 0 || right < 0 || left === right) {
    return "";
  }
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function triangleEdgeKeys(vertices = []) {
  if (!Array.isArray(vertices) || vertices.length !== 3) {
    return [];
  }
  return [
    triangleEdgeKey(vertices[0], vertices[1]),
    triangleEdgeKey(vertices[1], vertices[2]),
    triangleEdgeKey(vertices[2], vertices[0])
  ].filter(Boolean);
}

function uvEdgePointKey(point = null) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
    ? `${Math.round(point.x * 100000)}:${Math.round(point.y * 100000)}`
    : "";
}

function uvEdgeKey(left = null, right = null) {
  const leftKey = uvEdgePointKey(left);
  const rightKey = uvEdgePointKey(right);
  if (!leftKey || !rightKey || leftKey === rightKey) {
    return "";
  }
  return leftKey < rightKey ? `${leftKey}|${rightKey}` : `${rightKey}|${leftKey}`;
}

function triangleUvEdgeKeys(points = []) {
  if (!Array.isArray(points) || points.length !== 3) {
    return [];
  }
  return [
    uvEdgeKey(points[0], points[1]),
    uvEdgeKey(points[1], points[2]),
    uvEdgeKey(points[2], points[0])
  ].filter(Boolean);
}

function materialIndexForGeometryTriangle(geometry = null, triangleIndex = -1) {
  const groups = Array.isArray(geometry?.groups) ? geometry.groups : [];
  if (!groups.length || !Number.isInteger(triangleIndex) || triangleIndex < 0) {
    return 0;
  }
  const elementStart = triangleIndex * 3;
  const group = groups.find((entry) => (
    Number.isFinite(entry?.start)
    && Number.isFinite(entry?.count)
    && elementStart >= entry.start
    && elementStart < entry.start + entry.count
  ));
  return Math.max(0, Math.floor(Number(group?.materialIndex) || 0));
}

function visibilityTriangleCacheForGeometry(geometry = null) {
  if (!geometry?.attributes?.uv) {
    return null;
  }
  const cached = visibilityTriangleGeometryCache.get(geometry);
  const uvAttribute = geometry.attributes.uv;
  const indexAttribute = geometry.index || null;
  const uvVersion = Number(uvAttribute.version) || 0;
  const indexVersion = Number(indexAttribute?.version) || 0;
  if (
    cached
    && cached.uvAttribute === uvAttribute
    && cached.indexAttribute === indexAttribute
    && cached.uvVersion === uvVersion
    && cached.indexVersion === indexVersion
  ) {
    return cached;
  }
  const vertexCount = attributeCount(uvAttribute);
  const triangleCount = indexAttribute
    ? Math.floor(attributeCount(indexAttribute) / 3)
    : Math.floor(vertexCount / 3);
  if (triangleCount <= 0) {
    return null;
  }
  const triangles = [];
  const vertexTriangles = new Map();
  const edgeTriangles = new Map();
  const uvEdgeTriangles = new Map();
  const addVertexTriangle = (vertexIndex, triangleIndex) => {
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0) {
      return;
    }
    const entries = vertexTriangles.get(vertexIndex) || [];
    entries.push(triangleIndex);
    vertexTriangles.set(vertexIndex, entries);
  };
  const addEdgeTriangle = (key, triangleIndex) => {
    if (!key) {
      return;
    }
    const entries = edgeTriangles.get(key) || [];
    entries.push(triangleIndex);
    edgeTriangles.set(key, entries);
  };
  const addUvEdgeTriangle = (key, triangleIndex) => {
    if (!key) {
      return;
    }
    const entries = uvEdgeTriangles.get(key) || [];
    entries.push(triangleIndex);
    uvEdgeTriangles.set(key, entries);
  };
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const vertices = indexAttribute
      ? [
          indexAttributeValue(indexAttribute, triangleIndex * 3),
          indexAttributeValue(indexAttribute, triangleIndex * 3 + 1),
          indexAttributeValue(indexAttribute, triangleIndex * 3 + 2)
        ]
      : [
          triangleIndex * 3,
          triangleIndex * 3 + 1,
          triangleIndex * 3 + 2
        ];
    if (!vertices.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount)) {
      continue;
    }
    const uvPoints = vertices.map((index) => uvAttributePoint(uvAttribute, index));
    const uvEdges = uvPoints.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      ? triangleUvEdgeKeys(uvPoints)
      : [];
    const entry = {
      index: triangleIndex,
      vertices,
      materialIndex: materialIndexForGeometryTriangle(geometry, triangleIndex),
      uvEdges
    };
    triangles[triangleIndex] = entry;
    vertices.forEach((vertexIndex) => addVertexTriangle(vertexIndex, triangleIndex));
    triangleEdgeKeys(vertices).forEach((key) => addEdgeTriangle(key, triangleIndex));
    uvEdges.forEach((key) => addUvEdgeTriangle(key, triangleIndex));
  }
  const next = {
    uvAttribute,
    indexAttribute,
    uvVersion,
    indexVersion,
    hasMaterialGroups: Array.isArray(geometry.groups) && geometry.groups.length > 0,
    triangles,
    vertexTriangles,
    edgeTriangles,
    uvEdgeTriangles
  };
  visibilityTriangleGeometryCache.set(geometry, next);
  return next;
}

export function textureAirbrushPrewarmWebGpuStrokeGeometry(editor = null, options = {}) {
  if (!editor || options.warmWebGpuStrokeGeometry === false) {
    return 0;
  }
  const records = Array.isArray(options.records)
    ? options.records
    : editor.textureAirbrushRecords?.() || editor.paintRecords || [];
  let warmed = 0;
  for (const record of records) {
    const geometry = record?.geometry || record?.object?.geometry || null;
    if (visibilityTriangleCacheForGeometry(geometry)) {
      warmed += 1;
    }
  }
  return warmed;
}

function sameTriangleVertices(left = [], right = []) {
  if (left.length !== 3 || right.length !== 3) {
    return false;
  }
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function hitTriangleIndex(cache = null, hit = null) {
  if (!cache || !hit?.face) {
    return -1;
  }
  const faceIndex = Math.floor(Number(hit.faceIndex));
  if (Number.isInteger(faceIndex) && cache.triangles[faceIndex]) {
    return faceIndex;
  }
  const faceVertices = [hit.face.a, hit.face.b, hit.face.c]
    .map((index) => Math.floor(Number(index)))
    .filter((index) => Number.isInteger(index) && index >= 0);
  if (faceVertices.length !== 3) {
    return -1;
  }
  const candidates = cache.vertexTriangles.get(faceVertices[0]) || [];
  return candidates.find((triangleIndex) => (
    sameTriangleVertices(cache.triangles[triangleIndex]?.vertices || [], faceVertices)
  )) ?? -1;
}

function linkedVerticesForRecord(editor = null, record = null, vertexIndex = -1) {
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0) {
    return [];
  }
  const linked = editor?.textureAirbrushNeighborLinkedVertices?.(record, vertexIndex)
    || record?.seamVertexMap?.get?.(vertexIndex)
    || null;
  return Array.isArray(linked)
    ? linked
      .map((index) => Math.floor(Number(index)))
      .filter((index) => Number.isInteger(index) && index >= 0)
    : [vertexIndex];
}

function triangleCanUseScreenBrushUvSegments(editor = null, record = null, startTriangle = null, triangle = null) {
  if (!startTriangle || !triangle) {
    return false;
  }
  if (triangle.index === startTriangle.index) {
    return true;
  }
  const sourceVertices = Array.isArray(startTriangle.vertices) ? startTriangle.vertices : [];
  const targetVertices = new Set(Array.isArray(triangle.vertices) ? triangle.vertices : []);
  if (sourceVertices.length !== 3 || targetVertices.size !== 3) {
    return false;
  }
  let linkedMatches = 0;
  for (const vertexIndex of sourceVertices) {
    const linked = linkedVerticesForRecord(editor, record, vertexIndex);
    if (linked.some((linkedIndex) => linkedIndex !== vertexIndex && targetVertices.has(linkedIndex))) {
      linkedMatches += 1;
    }
  }
  return linkedMatches >= 2;
}

function neighborSeedCacheKey(editor = null, seed = null) {
  if (!seed?.enabled) {
    return "";
  }
  const explicitKey = seed.key || editor?.textureAirbrushNeighborSeedKey?.(seed) || "";
  if (explicitKey) {
    return explicitKey;
  }
  const component = seed.component instanceof Set ? seed.component : null;
  const componentValues = component
    ? [...component].sort((left, right) => left - right)
    : [];
  return [
    textureAirbrushRecordIdentity(seed.record || seed, "neighbor-record"),
    seed.materialIndex ?? 0,
    seed.material?.uuid || seed.material?.id || "material",
    seed.seedVertexIndex ?? "surface",
    componentValues.length,
    componentValues.slice(0, 16).join(","),
    componentValues.at(-1) ?? ""
  ].join(":");
}

function neighborSeedRecordMatches(editor = null, seed = null, record = null) {
  if (!seed?.enabled) {
    return true;
  }
  if (typeof editor?.textureAirbrushNeighborRecordMatches === "function") {
    return editor.textureAirbrushNeighborRecordMatches(seed, record) !== false;
  }
  const seedRecord = seed.record || null;
  return Boolean(
    seedRecord
    && record
    && (
      seedRecord === record
      || (seedRecord.object && seedRecord.object === record.object)
      || (seedRecord.geometry && seedRecord.geometry === record.geometry)
      || textureAirbrushRecordIdentity(seedRecord, "") === textureAirbrushRecordIdentity(record, "record")
    )
  );
}

function neighborSeedIncludesVertex(editor = null, seed = null, record = null, vertexIndex = null) {
  if (!seed?.component?.size || !Number.isInteger(vertexIndex)) {
    return false;
  }
  if (seed.component.has(vertexIndex)) {
    return true;
  }
  for (const linkedIndex of editor?.textureAirbrushNeighborLinkedVertices?.(record, vertexIndex) || []) {
    if (seed.component.has(linkedIndex)) {
      return true;
    }
  }
  return false;
}

function neighborSeedAllowsTriangle(editor = null, seed = null, record = null, triangle = null) {
  if (!seed?.enabled || !seed.component?.size) {
    return true;
  }
  if (!neighborSeedRecordMatches(editor, seed, record)) {
    return false;
  }
  const vertices = (triangle?.vertices || [triangle?.a, triangle?.b, triangle?.c])
    .map((vertexIndex) => Math.floor(Number(vertexIndex)))
    .filter((vertexIndex) => Number.isInteger(vertexIndex) && vertexIndex >= 0);
  if (!vertices.length) {
    return false;
  }
  return vertices.every((vertexIndex) => neighborSeedIncludesVertex(editor, seed, record, vertexIndex));
}

function neighborSeedAllowsHit(editor = null, seed = null, record = null, hit = null, material = null, materialIndex = null) {
  if (!seed?.enabled) {
    return true;
  }
  if (typeof editor?.textureAirbrushNeighborHitAllowed === "function") {
    return editor.textureAirbrushNeighborHitAllowed(seed, record, hit, material, materialIndex) !== false;
  }
  return neighborSeedRecordMatches(editor, seed, record)
    && neighborSeedAllowsTriangle(editor, seed, record, hit?.face || null);
}

function relaxNeighborComponentGate(options = {}) {
  return options.relaxNeighborComponentGate === true
    && options.liveProjectedPaint === true
    && options.useTslSurfaceAirbrush !== false;
}

function neighborSeedAllowsStrokeHit(editor = null, seed = null, record = null, hit = null, material = null, materialIndex = null, options = {}) {
  if (!seed?.enabled) {
    return true;
  }
  if (relaxNeighborComponentGate(options)) {
    return neighborSeedRecordMatches(editor, seed, record);
  }
  return neighborSeedAllowsHit(editor, seed, record, hit, material, materialIndex);
}

function textureAirbrushHitVertexIndices(record = null, hit = null) {
  const face = hit?.face || null;
  const faceVertices = [face?.a, face?.b, face?.c]
    .map((vertexIndex) => Math.floor(Number(vertexIndex)))
    .filter((vertexIndex) => Number.isInteger(vertexIndex) && vertexIndex >= 0);
  if (faceVertices.length === 3) {
    return faceVertices;
  }
  const geometry = record?.geometry || record?.object?.geometry || hit?.object?.geometry || null;
  const position = geometry?.attributes?.position || null;
  const faceIndex = Math.floor(Number(hit?.faceIndex));
  if (!geometry || !position || !Number.isInteger(faceIndex) || faceIndex < 0) {
    return [];
  }
  const elementStart = faceIndex * 3;
  const elementCount = geometry.index?.count || position.count || 0;
  if (elementStart + 2 >= elementCount) {
    return [];
  }
  return [elementStart, elementStart + 1, elementStart + 2].map((elementIndex) => {
    if (geometry.index && typeof geometry.index.getX === "function") {
      return Math.floor(Number(geometry.index.getX(elementIndex)));
    }
    return elementIndex;
  }).filter((vertexIndex) => Number.isInteger(vertexIndex) && vertexIndex >= 0);
}

function textureAirbrushGeometryComponentState(geometry = null) {
  const position = geometry?.attributes?.position || null;
  const vertexCount = Math.max(0, Math.floor(Number(position?.count) || 0));
  if (!geometry || !position || !vertexCount) {
    return null;
  }
  const key = [
    vertexCount,
    Math.max(0, Math.floor(Number(position.version) || 0)),
    geometry.index?.count || 0,
    Math.max(0, Math.floor(Number(geometry.index?.version) || 0))
  ].join(":");
  const cached = _textureAirbrushGeometryComponentStates.get(geometry);
  if (cached?.key === key) {
    return cached;
  }
  const parent = new Int32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) {
    parent[index] = index;
  }
  const find = (vertexIndex) => {
    let root = vertexIndex;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let current = vertexIndex;
    while (parent[current] !== current) {
      const next = parent[current];
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left, right) => {
    if (left < 0 || right < 0 || left >= vertexCount || right >= vertexCount) {
      return;
    }
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    }
  };
  const elementCount = geometry.index?.count || vertexCount;
  for (let elementStart = 0; elementStart + 2 < elementCount; elementStart += 3) {
    const ia = geometry.index?.getX ? Math.floor(Number(geometry.index.getX(elementStart))) : elementStart;
    const ib = geometry.index?.getX ? Math.floor(Number(geometry.index.getX(elementStart + 1))) : elementStart + 1;
    const ic = geometry.index?.getX ? Math.floor(Number(geometry.index.getX(elementStart + 2))) : elementStart + 2;
    union(ia, ib);
    union(ib, ic);
    union(ic, ia);
  }
  const positionGroups = new Map();
  const coordinate = (vertexIndex, component) => {
    if (typeof position.getComponent === "function") {
      return Number(position.getComponent(vertexIndex, component)) || 0;
    }
    return Number(position.array?.[vertexIndex * position.itemSize + component]) || 0;
  };
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const positionKey = [
      Math.round(coordinate(vertexIndex, 0) * 100000),
      Math.round(coordinate(vertexIndex, 1) * 100000),
      Math.round(coordinate(vertexIndex, 2) * 100000)
    ].join(":");
    const previous = positionGroups.get(positionKey);
    if (Number.isInteger(previous)) {
      union(previous, vertexIndex);
    } else {
      positionGroups.set(positionKey, vertexIndex);
    }
  }
  const rootToComponent = new Map();
  const componentIds = new Int32Array(vertexCount);
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const root = find(vertexIndex);
    if (!rootToComponent.has(root)) {
      rootToComponent.set(root, rootToComponent.size);
    }
    componentIds[vertexIndex] = rootToComponent.get(root);
  }
  const state = {
    key,
    componentIds,
    componentCount: rootToComponent.size
  };
  _textureAirbrushGeometryComponentStates.set(geometry, state);
  return state;
}

function textureAirbrushComponentIdForVertices(editor = null, record = null, geometryOwner = null, vertices = []) {
  const geometry = record?.geometry || record?.object?.geometry || geometryOwner?.object?.geometry || geometryOwner?.geometry || null;
  const componentIds = editor?.textureAirbrushNeighborComponentState?.(record)?.componentIds
    || textureAirbrushGeometryComponentState(geometry)?.componentIds
    || null;
  if (!componentIds) {
    return -1;
  }
  const counts = new Map();
  for (const vertexIndex of Array.isArray(vertices) ? vertices : []) {
    const index = Math.floor(Number(vertexIndex));
    const componentId = Number.isInteger(index) && index >= 0
      ? Math.floor(Number(componentIds[index]))
      : -1;
    if (componentId < 0) {
      continue;
    }
    counts.set(componentId, (counts.get(componentId) || 0) + 1);
  }
  let bestComponentId = -1;
  let bestCount = 0;
  for (const [componentId, count] of counts) {
    if (count > bestCount) {
      bestComponentId = componentId;
      bestCount = count;
    }
  }
  return bestComponentId;
}

function textureAirbrushComponentIdForHit(editor = null, record = null, hit = null) {
  return textureAirbrushComponentIdForVertices(
    editor,
    record,
    hit,
    textureAirbrushHitVertexIndices(record, hit)
  );
}

function trianglePixelCacheKey(editor = null, cache = null, triangle = null, editable = null, referenceUv = null, options = {}) {
  if (!editor || !cache || !triangle) {
    return "";
  }
  const object = options.record?.object || options.hit?.object || null;
  return [
    webGpuStrokeFrameCacheKey(editor),
    stableCacheId(options.record, "record"),
    stableCacheId(object, "object"),
    stableCacheId(editable?.texture, "texture"),
    editable?.canvas?.width || 0,
    editable?.canvas?.height || 0,
    cache.uvVersion || 0,
    cache.indexVersion || 0,
    webGpuStrokePoseCacheKey(editor, object),
    triangle.index ?? -1,
    triangle.materialIndex ?? 0,
    Number.isFinite(Number(options.coverageOverride))
      ? roundedCacheNumber(options.coverageOverride)
      : "coverage:auto"
  ].join(":");
}

function quantizedTexturePixelKey(point = null, gridPixels = 4) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return "n:n";
  }
  const grid = Math.max(1, Number(gridPixels) || 4);
  return `${Math.round(point.x / grid)}:${Math.round(point.y / grid)}`;
}

function quantizedStrokeSegmentsKey(segments = [], gridPixels = 4) {
  return (Array.isArray(segments) ? segments : [])
    .slice(0, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS)
    .map((segment) => [
      quantizedTexturePixelKey(segment?.start, gridPixels),
      quantizedTexturePixelKey(segment?.end, gridPixels)
    ].join(">"))
    .join("|");
}

function screenPointFromClientPoint(editor = null, point = null) {
  if (Number.isFinite(point?.clientX) && Number.isFinite(point?.clientY)) {
    const rect = editor?.canvas?.getBoundingClientRect?.() || null;
    return {
      x: point.clientX - (Number(rect?.left) || 0),
      y: point.clientY - (Number(rect?.top) || 0)
    };
  }
  return finitePoint(point);
}

function screenStrokeSegmentsForVisibility(editor = null, segments = [], center = null) {
  const output = [];
  const append = (start = null, end = null, source = null) => {
    const a = screenPointFromClientPoint(editor, start);
    const b = screenPointFromClientPoint(editor, end);
    if (a && b) {
      const radiusPixels = Number(source?.radiusPixels);
      const viewStart = Number.isFinite(source?.viewStart?.x) && Number.isFinite(source?.viewStart?.y) && Number.isFinite(source?.viewStart?.z)
        ? { x: source.viewStart.x, y: source.viewStart.y, z: source.viewStart.z }
        : null;
      const viewEnd = Number.isFinite(source?.viewEnd?.x) && Number.isFinite(source?.viewEnd?.y) && Number.isFinite(source?.viewEnd?.z)
        ? { x: source.viewEnd.x, y: source.viewEnd.y, z: source.viewEnd.z }
        : null;
      const viewNormalStart = Number.isFinite(source?.viewNormalStart?.x) && Number.isFinite(source?.viewNormalStart?.y) && Number.isFinite(source?.viewNormalStart?.z)
        ? { x: source.viewNormalStart.x, y: source.viewNormalStart.y, z: source.viewNormalStart.z }
        : null;
      const viewNormalEnd = Number.isFinite(source?.viewNormalEnd?.x) && Number.isFinite(source?.viewNormalEnd?.y) && Number.isFinite(source?.viewNormalEnd?.z)
        ? { x: source.viewNormalEnd.x, y: source.viewNormalEnd.y, z: source.viewNormalEnd.z }
        : null;
      const viewRadiusPixels = Number(source?.viewRadiusPixels);
      const componentStart = Math.floor(Number(source?.componentStart));
      const componentEnd = Math.floor(Number(source?.componentEnd));
      output.push({
        start: a,
        end: b,
        ...(viewStart ? { viewStart } : {}),
        ...(viewEnd ? { viewEnd } : {}),
        ...(viewNormalStart ? { viewNormalStart } : {}),
        ...(viewNormalEnd ? { viewNormalEnd } : {}),
        ...(Number.isInteger(componentStart) && componentStart >= 0 ? { componentStart } : {}),
        ...(Number.isInteger(componentEnd) && componentEnd >= 0 ? { componentEnd } : {}),
        ...(Number.isFinite(viewRadiusPixels) && viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
        ...(Number.isFinite(radiusPixels) && radiusPixels > 0 ? { radiusPixels } : {})
      });
    }
  };
  for (const segment of Array.isArray(segments) ? segments : []) {
    append(segment?.start, segment?.end, segment);
  }
  if (!output.length) {
    append(center, center);
  }
  return output;
}

function connectScreenStrokeSegmentGaps(segments = [], radiusPixels = 1) {
  const source = (Array.isArray(segments) ? segments : [])
    .map((segment) => {
      const start = finitePoint(segment?.start);
      const end = finitePoint(segment?.end);
      if (!start || !end) {
        return null;
      }
      const segmentRadius = Math.max(0.75, Number(segment?.radiusPixels) || Number(radiusPixels) || 0.75);
      return {
        start,
        end,
        radiusPixels: segmentRadius
      };
    })
    .filter(Boolean);
  if (source.length <= 1) {
    return source;
  }
  const output = [];
  const maxGap = Math.max(6, Math.min(192, Math.max(0.75, Number(radiusPixels) || 1) * 4));
  for (const segment of source) {
    const previous = output[output.length - 1] || null;
    const gap = previous ? pointDistance(previous.end, segment.start) : 0;
    if (previous && Number.isFinite(gap) && gap > 0.5 && gap <= maxGap) {
      output.push({
        start: previous.end,
        end: segment.start,
        radiusPixels: Math.max(previous.radiusPixels || 0, segment.radiusPixels || 0, Number(radiusPixels) || 0.75),
        ...(previous.viewEnd && segment.viewStart ? { viewStart: previous.viewEnd, viewEnd: segment.viewStart } : {}),
        ...(previous.viewNormalEnd || previous.viewNormalStart ? { viewNormalStart: previous.viewNormalEnd || previous.viewNormalStart } : {}),
        ...(segment.viewNormalStart || segment.viewNormalEnd ? { viewNormalEnd: segment.viewNormalStart || segment.viewNormalEnd } : {}),
        ...(Number.isFinite(Number(previous.viewRadiusPixels)) || Number.isFinite(Number(segment.viewRadiusPixels))
          ? { viewRadiusPixels: Math.max(0.0001, Number(previous.viewRadiusPixels) || 0, Number(segment.viewRadiusPixels) || 0) }
          : {}),
        ...(Number.isInteger(Math.floor(Number(previous.componentEnd ?? previous.componentStart))) && Number(previous.componentEnd ?? previous.componentStart) >= 0
          ? { componentStart: Math.floor(Number(previous.componentEnd ?? previous.componentStart)) }
          : {}),
        ...(Number.isInteger(Math.floor(Number(segment.componentStart ?? segment.componentEnd))) && Number(segment.componentStart ?? segment.componentEnd) >= 0
          ? { componentEnd: Math.floor(Number(segment.componentStart ?? segment.componentEnd)) }
          : {})
      });
    }
    output.push(segment);
  }
  return output;
}

function visibilityTriangleListCacheKey(
  editor = null,
  cache = null,
  hit = null,
  editable = null,
  referenceUv = null,
  options = {}
) {
  if (!editor || !cache || !hit?.face || options.cacheVisibilityTriangleLists === false) {
    return "";
  }
  const hitFace = hit.face || {};
  const radius = Math.max(1, Number(options.radiusPixels) || 1);
  const gridPixels = Math.max(
    2,
    Math.min(12, Number(options.visibilityTriangleCacheGridPixels) || radius * 0.06 || 4)
  );
  return [
    webGpuStrokeFrameCacheKey(editor),
    stableCacheId(options.record, "record"),
    stableCacheId(hit?.object, "object"),
    stableCacheId(editable?.texture, "texture"),
    stableCacheId(editable?.layer, "layer"),
    editable?.canvas?.width || 0,
    editable?.canvas?.height || 0,
    cache.uvVersion || 0,
    cache.indexVersion || 0,
    options.startIndex ?? "start",
    options.materialIndex ?? 0,
    Math.floor(Number(options.maxTriangles) || 1),
    Math.round(radius),
    roundedCacheNumber(referenceUv?.x),
    roundedCacheNumber(referenceUv?.y),
    hit?.faceIndex ?? "face",
    hitFace.a ?? "a",
    hitFace.b ?? "b",
    hitFace.c ?? "c",
    neighborSeedCacheKey(editor, options.neighborPaintSeed || null),
    (options.visibleEdgeMode || "soft") === "hard" ? "hard-edge" : "soft-edge",
    options.screenSurfaceContinuityFilter !== false && (
      options.screenSurfaceContinuityFilter === true || options.screenStrokePaint === true
    )
      ? "surface-continuity"
      : "screen-only",
    roundedCacheNumber(options.surfaceContinuityRadiusScale),
    roundedCacheNumber(options.surfaceContinuityDepthWindow),
    quantizedTexturePixelKey(options.center, gridPixels),
    quantizedStrokeSegmentsKey(options.strokeSegments, gridPixels),
    Math.round(Math.max(0, Number(options.screenRadiusPixels) || 0)),
    roundedCacheNumber(options.scatter),
    quantizedStrokeSegmentsKey(options.screenStrokeSegments, gridPixels)
  ].join(":");
}

function geometryTriangleToPixels(editor = null, cache = null, triangle = null, editable = null, referenceUv = null, options = {}) {
  if (!cache?.uvAttribute || !triangle?.vertices) {
    return null;
  }
  const cacheKey = options.cacheVisibilityTrianglePixels === false
    ? ""
    : trianglePixelCacheKey(editor, cache, triangle, editable, referenceUv, options);
  const triangleCache = cacheKey
    ? frameScopedEditorCache(
      editor,
      "textureAirbrushWebGpuVisibilityTrianglePixelCache",
      webGpuStrokeFrameCacheKey(editor),
      TEXTURE_AIRBRUSH_WEBGPU_TRIANGLE_CACHE_LIMIT
    )
    : null;
  const cached = triangleCache?.get(cacheKey);
  if (cached) {
    return compactVisibilityTriangle(cached);
  }
  const uvs = triangle.vertices.map((index) => uvAttributePoint(cache.uvAttribute, index));
  const points = texturePixelsFromUvTriangle(editor, uvs, editable)
    || uvs.map((uv) => texturePixelFromUvRelative(editor, uv, editable, referenceUv));
  if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    return null;
  }
  const coverageOverride = Number(options.coverageOverride);
  const coverage = Number.isFinite(coverageOverride)
    ? Math.max(0, Math.min(1, coverageOverride))
    : cameraFacingCoverageForTriangle(editor, options.record || null, options.hit || null, triangle);
  if (coverage <= 0) {
    return null;
  }
  const mapped = compactVisibilityTriangle({
    a: points[0],
    b: points[1],
    c: points[2],
    coverage,
    componentId: textureAirbrushComponentIdForVertices(
      editor,
      options.record || null,
      options.hit || null,
      triangle.vertices
    )
  });
  boundedCacheSet(
    triangleCache,
    cacheKey,
    mapped,
    TEXTURE_AIRBRUSH_WEBGPU_TRIANGLE_CACHE_LIMIT
  );
  return mapped;
}

function indexedScreenTriangleToPixels(editor = null, entry = null, editable = null, referenceUv = null, options = {}) {
  const uvs = Array.isArray(entry?.uvs) ? entry.uvs.slice(0, 3) : [];
  if (uvs.length !== 3) {
    return null;
  }
  const points = texturePixelsFromUvTriangle(editor, uvs, editable)
    || uvs.map((uv) => texturePixelFromUvRelative(editor, uv, editable, referenceUv));
  if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    return null;
  }
  const coverageOverride = Number(options.coverageOverride);
  const coverage = Number.isFinite(coverageOverride)
    ? Math.max(0, Math.min(1, coverageOverride))
    : Number.isFinite(Number(entry?.coverage))
      ? Math.max(0, Math.min(1, Number(entry.coverage)))
      : 1;
  if (coverage <= 0) {
    return null;
  }
  return compactVisibilityTriangle({
    a: points[0],
    b: points[1],
    c: points[2],
    coverage,
    componentId: Math.floor(Number(options.componentId ?? entry?.componentId ?? entry?.component))
  });
}

function pointToSegmentDistance(point = null, start = null, end = null) {
  if (!finitePoint(point) || !finitePoint(start) || !finitePoint(end)) {
    return Infinity;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.0001) {
    return pointDistance(point, end);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSq));
  return pointDistance(point, {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t
  });
}

function triangleEdges(triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  return compact
    ? [
        [compact.a, compact.b],
        [compact.b, compact.c],
        [compact.c, compact.a]
      ]
    : [];
}

function cross2d(a = null, b = null, c = null) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle(point = null, triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!finitePoint(point) || !compact) {
    return false;
  }
  const ab = cross2d(compact.a, compact.b, point);
  const bc = cross2d(compact.b, compact.c, point);
  const ca = cross2d(compact.c, compact.a, point);
  const hasNegative = ab < -0.0001 || bc < -0.0001 || ca < -0.0001;
  const hasPositive = ab > 0.0001 || bc > 0.0001 || ca > 0.0001;
  return !(hasNegative && hasPositive);
}

function segmentsIntersect(a = null, b = null, c = null, d = null) {
  if (!finitePoint(a) || !finitePoint(b) || !finitePoint(c) || !finitePoint(d)) {
    return false;
  }
  const rangesOverlap = (aMin, aMax, bMin, bMax) => (
    Math.max(Math.min(aMin, aMax), Math.min(bMin, bMax))
    <= Math.min(Math.max(aMin, aMax), Math.max(bMin, bMax)) + 0.0001
  );
  if (
    !rangesOverlap(a.x, b.x, c.x, d.x)
    || !rangesOverlap(a.y, b.y, c.y, d.y)
  ) {
    return false;
  }
  const abC = cross2d(a, b, c);
  const abD = cross2d(a, b, d);
  const cdA = cross2d(c, d, a);
  const cdB = cross2d(c, d, b);
  return (
    Math.min(abC, abD) <= 0.0001
    && Math.max(abC, abD) >= -0.0001
    && Math.min(cdA, cdB) <= 0.0001
    && Math.max(cdA, cdB) >= -0.0001
  );
}

function segmentToTriangleDistance(segment = null, triangle = null) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  const compact = compactVisibilityTriangle(triangle);
  if (!start || !end || !compact) {
    return Infinity;
  }
  if (pointInTriangle(start, compact) || pointInTriangle(end, compact)) {
    return 0;
  }
  let distance = Infinity;
  for (const [edgeStart, edgeEnd] of triangleEdges(compact)) {
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) {
      return 0;
    }
    distance = Math.min(
      distance,
      pointToSegmentDistance(start, edgeStart, edgeEnd),
      pointToSegmentDistance(end, edgeStart, edgeEnd),
      pointToSegmentDistance(edgeStart, start, end),
      pointToSegmentDistance(edgeEnd, start, end)
    );
  }
  return distance;
}

function visibilityTriangleNearSegments(triangle = null, segments = [], radiusPixels = 1) {
  const radius = Math.max(0.5, Number(radiusPixels) || 0.5);
  const compact = compactVisibilityTriangle(triangle);
  if (!compact) {
    return false;
  }
  return (Array.isArray(segments) ? segments : []).some((segment) => (
    segmentToTriangleDistance(segment, compact) <= radius
  ));
}

function visibilityTriangleDistanceToSegments(triangle = null, segments = []) {
  const compact = compactVisibilityTriangle(triangle);
  if (!compact) {
    return Infinity;
  }
  return (Array.isArray(segments) ? segments : [])
    .reduce((distance, segment) => Math.min(distance, segmentToTriangleDistance(segment, compact)), Infinity);
}

function pointToSegmentProgress(point = null, segment = null) {
  const p = finitePoint(point);
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!p || !start || !end) {
    return null;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.0001) {
    return {
      distance: pointDistance(p, end),
      ratio: 0,
      length: 0
    };
  }
  const ratio = Math.max(0, Math.min(1, ((p.x - start.x) * segmentX + (p.y - start.y) * segmentY) / lengthSq));
  const closest = {
    x: start.x + segmentX * ratio,
    y: start.y + segmentY * ratio
  };
  return {
    distance: pointDistance(p, closest),
    ratio,
    length: Math.sqrt(lengthSq)
  };
}

function triangleCenterPoint(triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!compact) {
    return null;
  }
  return {
    x: (compact.a.x + compact.b.x + compact.c.x) / 3,
    y: (compact.a.y + compact.b.y + compact.c.y) / 3
  };
}

function screenTriangleStrokeProgress(screenTriangle = null, screenSegments = []) {
  return screenTriangleStrokePlacement(screenTriangle, screenSegments).progress;
}

function screenTriangleStrokePlacement(screenTriangle = null, screenSegments = []) {
  const compact = compactVisibilityTriangle(screenTriangle);
  if (!compact) {
    return { distance: Infinity, progress: 0, signedOffset: 0 };
  }
  const center = triangleCenterPoint(compact);
  if (!center) {
    return { distance: Infinity, progress: 0, signedOffset: 0 };
  }
  let accumulated = 0;
  let best = {
    distance: Infinity,
    progress: 0,
    signedOffset: 0
  };
  for (const segment of Array.isArray(screenSegments) ? screenSegments : []) {
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    const length = pointDistance(start, end);
    const projected = pointToSegmentProgress(center, segment);
    if (projected && projected.distance < best.distance) {
      let signedOffset = 0;
      if (Number.isFinite(length) && length > 0.0001 && start && end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        signedOffset = ((center.x - start.x) * dy - (center.y - start.y) * dx) / length;
      }
      best = {
        distance: projected.distance,
        progress: accumulated + projected.ratio * Math.max(0, projected.length),
        signedOffset
      };
    }
    accumulated += Number.isFinite(length) ? Math.max(0, length) : 0;
  }
  return best;
}

function compactTriangleKey(triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!compact) {
    return "";
  }
  const parts = [
    Math.round(compact.a.x * 10),
    Math.round(compact.a.y * 10),
    Math.round(compact.b.x * 10),
    Math.round(compact.b.y * 10),
    Math.round(compact.c.x * 10),
    Math.round(compact.c.y * 10)
  ];
  if (compact.screenA && compact.screenB && compact.screenC) {
    parts.push(
      "screen",
      Math.round(compact.screenA.x * 10),
      Math.round(compact.screenA.y * 10),
      Math.round(compact.screenB.x * 10),
      Math.round(compact.screenB.y * 10),
      Math.round(compact.screenC.x * 10),
      Math.round(compact.screenC.y * 10)
    );
    if (Number.isFinite(compact.screenBScale) && Number.isFinite(compact.screenCScale)) {
      parts.push(
        "perspective",
        Math.round(compact.screenBScale * 100000),
        Math.round(compact.screenCScale * 100000)
      );
    }
  }
  parts.push("component", Number.isInteger(compact.componentId) ? compact.componentId : -1);
  return parts.join(":");
}

function selectScreenBrushVisibilityCandidates(candidates = [], screenSegments = [], maxTriangles = 1, screenRadius = 1) {
  const limit = Math.max(1, Math.floor(Number(maxTriangles) || 1));
  const unique = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const projected = visibilityTriangleWithScreenTriangle(candidate?.mapped, candidate?.screenTriangle);
    const compact = compactVisibilityTriangle(projected);
    const key = compactTriangleKey(compact);
    if (!compact || !key || seen.has(key)) {
      continue;
    }
    const distance = Number.isFinite(Number(candidate.distance))
      ? Number(candidate.distance)
      : Infinity;
    const progress = Number(candidate.progress);
    const signedOffset = Number(candidate.signedOffset);
    seen.add(key);
    unique.push({
      ...candidate,
      projected: {
        ...compact,
        ...(Number.isFinite(distance) ? { screenStrokeDistance: distance } : {})
      },
      distance,
      ...(Number.isFinite(progress) ? { progress } : {}),
      ...(Number.isFinite(signedOffset) ? { signedOffset } : {})
    });
  }
  if (unique.length <= limit) {
    return unique;
  }
  for (const candidate of unique) {
    const hasStrokePlacement = Number.isFinite(Number(candidate.progress))
      && Number.isFinite(Number(candidate.signedOffset));
    const placement = hasStrokePlacement
      ? {
          progress: Number(candidate.progress),
          signedOffset: Number(candidate.signedOffset),
          distance: Number.isFinite(Number(candidate.distance)) ? Number(candidate.distance) : Infinity
        }
      : screenTriangleStrokePlacement(candidate.screenTriangle, screenSegments);
    candidate.progress = placement.progress;
    candidate.signedOffset = placement.signedOffset;
    if (!Number.isFinite(candidate.distance)) {
      candidate.distance = placement.distance;
      if (Number.isFinite(candidate.distance)) {
        candidate.projected = {
          ...candidate.projected,
          screenStrokeDistance: candidate.distance
        };
      }
    }
  }
  const minProgress = Math.min(...unique.map((candidate) => candidate.progress));
  const maxProgress = Math.max(...unique.map((candidate) => candidate.progress));
  const span = Math.max(1, maxProgress - minProgress);
  const radius = Math.max(1, Number(screenRadius) || 1);
  const selected = [];
  const selectedIndexes = new Set();
  const selectIndex = (index = -1) => {
    if (index < 0 || selectedIndexes.has(index)) {
      return false;
    }
    selectedIndexes.add(index);
    selected.push(unique[index]);
    return true;
  };
  const chooseNearestToProgress = (targetProgress = 0) => {
    let bestIndex = -1;
    let bestScore = Infinity;
    for (let index = 0; index < unique.length; index += 1) {
      if (selectedIndexes.has(index)) {
        continue;
      }
      const candidate = unique[index];
      const progressScore = Math.abs(candidate.progress - targetProgress) / span;
      const distanceScore = Math.max(0, Number(candidate.distance) || 0) / radius;
      const score = progressScore + distanceScore * 0.25;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return selectIndex(bestIndex);
  };
  chooseNearestToProgress(minProgress);
  chooseNearestToProgress(maxProgress);
  const bucketCount = Math.max(4, Math.min(18, Math.ceil(Math.sqrt(limit))));
  const distanceBandCount = 4;
  const buckets = new Map();
  for (let index = 0; index < unique.length; index += 1) {
    if (selectedIndexes.has(index)) {
      continue;
    }
    const candidate = unique[index];
    const progressBucket = Math.max(0, Math.min(
      bucketCount - 1,
      Math.floor(((candidate.progress - minProgress) / span) * bucketCount)
    ));
    const normalizedDistance = Math.max(0, Math.min(0.999, (Number(candidate.distance) || 0) / radius));
    const distanceBucket = Math.max(0, Math.min(
      distanceBandCount - 1,
      Math.floor(normalizedDistance * distanceBandCount)
    ));
    const sideBucket = candidate.signedOffset < -1 ? 0 : candidate.signedOffset > 1 ? 2 : 1;
    const bucketKey = `${progressBucket}:${sideBucket}:${distanceBucket}`;
    const bucket = buckets.get(bucketKey) || [];
    bucket.push(index);
    buckets.set(bucketKey, bucket);
  }
  const orderedBuckets = [...buckets.values()];
  for (const bucket of orderedBuckets) {
    bucket.sort((leftIndex, rightIndex) => (
      unique[leftIndex].distance - unique[rightIndex].distance
      || unique[leftIndex].progress - unique[rightIndex].progress
    ));
  }
  let advanced = true;
  while (selected.length < limit && advanced) {
    advanced = false;
    for (const bucket of orderedBuckets) {
      while (bucket.length && selectedIndexes.has(bucket[0])) {
        bucket.shift();
      }
      if (!bucket.length) {
        continue;
      }
      if (selectIndex(bucket.shift())) {
        advanced = true;
      }
      if (selected.length >= limit) {
        break;
      }
    }
  }
  for (let index = 0; selected.length < limit && index < unique.length; index += 1) {
    selectIndex(index);
  }
  return selected.sort((left, right) => (
    left.progress - right.progress
    || left.distance - right.distance
  ));
}

function screenTriangleFromGeometryTriangle(editor = null, record = null, hit = null, triangle = null) {
  const vertices = triangle?.vertices || null;
  if (!Array.isArray(vertices) || vertices.length !== 3) {
    return null;
  }
  const points = vertices.map((vertexIndex) => screenPointFromVertex(editor, record, hit, vertexIndex));
  return compactVisibilityTriangle({
    a: points[0],
    b: points[1],
    c: points[2],
    screenA: points[0],
    screenB: points[1],
    screenC: points[2],
    componentId: textureAirbrushComponentIdForVertices(editor, record, hit, vertices)
  });
}

function screenTriangleFromIndexedTriangle(entry = null) {
  const screen = Array.isArray(entry?.screen) ? entry.screen : [];
  if (screen.length < 3) {
    return null;
  }
  return compactVisibilityTriangle({
    a: screen[0],
    b: screen[1],
    c: screen[2],
    screenA: screen[0],
    screenB: screen[1],
    screenC: screen[2]
  });
}

function visibilityTriangleWithScreenTriangle(textureTriangle = null, screenTriangle = null) {
  const compact = compactVisibilityTriangle(textureTriangle);
  const screen = compactVisibilityTriangle(screenTriangle);
  if (!compact || !screen) {
    return compact;
  }
  return {
    ...compact,
    screenA: screen.a,
    screenB: screen.b,
    screenC: screen.c,
    ...(Number.isFinite(screen.screenBScale) && Number.isFinite(screen.screenCScale)
      ? {
          screenBScale: screen.screenBScale,
          screenCScale: screen.screenCScale
        }
      : {})
  };
}

function collectScreenBrushVisibilityTriangles(
  editor = null,
  record = null,
  hit = null,
  editable = null,
  referenceUv = null,
  options = {}
) {
  const cache = options.cache || null;
  const screenSegments = Array.isArray(options.screenSegments) ? options.screenSegments : [];
  const screenRadius = Math.max(0.5, Number(options.screenRadiusPixels) || 0);
  const screenDomainRadius = projectedSurfaceBrushDomainRadius(screenRadius, options.scatter, options.hardness);
  const maxTriangles = Math.max(1, Math.floor(Number(options.maxTriangles) || 1));
  const debugCounts = options.projectedDebugCounts && typeof options.projectedDebugCounts === "object"
    ? options.projectedDebugCounts
    : null;
  const addDebugCount = (key, amount = 1) => {
    if (!debugCounts) {
      return;
    }
    debugCounts[key] = Math.max(0, Math.floor(Number(debugCounts[key]) || 0)) + amount;
  };
  const timingNow = () => (
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now()
  );
  if (!cache?.triangles?.length || !screenSegments.length || screenRadius <= 0 || maxTriangles <= 0) {
    addDebugCount("screenCollectorUnavailable");
    return [];
  }
  const materialIndex = Math.max(0, Math.floor(Number(options.materialIndex) || 0));
  const sourceMaterial = options.material || null;
  const neighborPaintSeed = options.neighborPaintSeed || null;
  const softProjectedVisibility = (
    options.screenStrokePaint === true
    || options.liveProjectedPaint === true
  ) && (options.visibleEdgeMode || "soft") !== "hard";
  const brushHardness = Math.max(0, Math.min(1, Number(options.hardness ?? 0.35)));
  const screenTriangleSearchRadius = softProjectedVisibility
    ? Math.max(screenRadius + 2, airbrushHaloRadius(screenRadius, options.scatter, brushHardness) + 2)
    : screenDomainRadius;
  const materialMatchCache = new Map();
  const triangleMatchesPaintTarget = (triangle = null) => {
    if (!cache.hasMaterialGroups) {
      return true;
    }
    const triangleMaterialIndex = Math.max(0, Math.floor(Number(triangle?.materialIndex) || 0));
    if (triangleMaterialIndex === materialIndex) {
      return true;
    }
    if (materialMatchCache.has(triangleMaterialIndex)) {
      return materialMatchCache.get(triangleMaterialIndex);
    }
    const triangleMaterial = materialForRecordIndex(record, triangleMaterialIndex);
    const matches = materialPaintTargetMatches(editor, triangleMaterial, editable, sourceMaterial);
    materialMatchCache.set(triangleMaterialIndex, matches);
    return matches;
  };
  const candidates = [];
  const maxFallbackScreenBrushCandidates = options.screenStrokePaint === true
    ? Math.max(maxTriangles + 4, Math.ceil(maxTriangles * 1.5))
    : Infinity;
  const maxIndexedScreenTriangles = options.screenStrokePaint === true
    ? maxTriangles
    : Infinity;
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  const screenIndexStartMs = timingNow();
  const indexedScreenTriangles = typeof editor?.textureAirbrushScreenTrianglesNearSegments === "function"
	      ? editor.textureAirbrushScreenTrianglesNearSegments(screenSegments, screenTriangleSearchRadius, {
	        record,
	        materialIndex,
	        material: sourceMaterial,
	        editable,
	        rect,
	        allowAnimationProgressMismatch: true,
        surfaceContinuityFilter: options.screenSurfaceContinuityFilter !== false && (
          options.screenSurfaceContinuityFilter === true
          || options.screenStrokePaint === true
        ),
        surfaceContinuitySamplesIgnoreMaterial: options.surfaceContinuitySamplesIgnoreMaterial === true,
        surfaceContinuityRadiusScale: options.surfaceContinuityRadiusScale,
        surfaceContinuityDepthWindow: options.surfaceContinuityDepthWindow,
        surfaceContinuityComponentDepthWindow: softProjectedVisibility
          ? Math.max(0.018, Number(options.surfaceContinuityComponentDepthWindow) || 0.032)
          : options.surfaceContinuityComponentDepthWindow,
        surfaceContinuityComponentNormalDot: softProjectedVisibility
          ? Math.max(0.28, Math.min(0.7, Number(options.surfaceContinuityComponentNormalDot) || 0.42))
          : options.surfaceContinuityComponentNormalDot,
        surfaceContinuityKeepDisconnected: options.surfaceContinuityKeepDisconnected === true,
        maxSurfaceContinuitySamples: options.maxSurfaceContinuitySamples,
	        frontSurfaceFilter: options.screenSurfaceFrontFilter,
	        skipTransparentTextureTriangles: options.skipTransparentScreenTextureTriangles,
	        debugCounts,
	        ...(Number.isFinite(maxIndexedScreenTriangles) ? { maxTriangles: maxIndexedScreenTriangles } : {})
	      })
	    : null;
  addDebugCount("screenIndexQueryMs", Math.round(timingNow() - screenIndexStartMs));
  const screenIndexMapStartMs = timingNow();
	  const indexedEntries = Array.isArray(indexedScreenTriangles)
    ? indexedScreenTriangles
      .map((entry) => {
        const faceIndex = Math.floor(Number(entry?.faceIndex));
        const triangle = Number.isInteger(faceIndex) ? cache.triangles[faceIndex] || null : null;
        const screenTriangle = screenTriangleFromIndexedTriangle(entry);
        const coverage = softProjectedVisibility && entry?.matchesMaterialSide !== false
          ? 1
          : Number(entry?.coverage);
        const distance = Number(entry?.screenStrokeDistance);
        const progress = Number(entry?.screenStrokeProgress);
        const signedOffset = Number(entry?.screenStrokeSignedOffset);
        const componentId = triangle?.vertices
          ? textureAirbrushComponentIdForVertices(editor, record, hit, triangle.vertices)
          : Math.floor(Number(entry?.componentId ?? entry?.component));
        const mapped = indexedScreenTriangleToPixels(editor, entry, editable, referenceUv, {
          coverageOverride: coverage,
          componentId
        });
        return (triangle || mapped) && screenTriangle
          ? {
              ...(triangle ? { triangle } : {}),
              ...(mapped ? { mapped } : {}),
              screenTriangle,
              ...(Number.isFinite(coverage) ? { coverage } : {}),
	              ...(Number.isFinite(distance) ? { distance } : {}),
	              ...(Number.isFinite(progress) ? { progress } : {}),
	              ...(Number.isFinite(signedOffset) ? { signedOffset } : {})
	            }
	          : null;
	      })
	      .filter(Boolean)
	    : [];
  addDebugCount("screenIndexMapMs", Math.round(timingNow() - screenIndexMapStartMs));
  addDebugCount("indexedScreenTriangles", Array.isArray(indexedScreenTriangles) ? indexedScreenTriangles.length : 0);
  addDebugCount("indexedScreenTriangleMappings", indexedEntries.length);
	  const sourceEntries = Array.isArray(indexedScreenTriangles) && indexedEntries.length
	    ? indexedEntries
	    : cache.triangles.map((triangle) => triangle ? { triangle, screenTriangle: null } : null).filter(Boolean);
  const maxScreenBrushCandidates = indexedEntries.length
    ? maxTriangles
    : maxFallbackScreenBrushCandidates;
  const screenCandidateFilterStartMs = timingNow();
  for (const entry of sourceEntries) {
	    const triangle = entry?.triangle || null;
	    if (triangle) {
	      if (!triangleMatchesPaintTarget(triangle)) {
	        addDebugCount("screenCandidateRejectMaterial");
	        continue;
	      }
	      if (!neighborSeedAllowsTriangle(editor, neighborPaintSeed, record, triangle)) {
	        addDebugCount("screenCandidateRejectNeighbor");
	        continue;
	      }
	    }
    const screenTriangle = entry.screenTriangle || (
      triangle
        ? screenTriangleFromGeometryTriangle(editor, record, hit, triangle)
        : null
    );
	    const distance = Number.isFinite(Number(entry.distance))
	      ? Number(entry.distance)
	      : visibilityTriangleDistanceToSegments(screenTriangle, screenSegments);
	    if (!Number.isFinite(distance) || distance > screenDomainRadius) {
	      addDebugCount("screenCandidateRejectDistance");
	      continue;
	    }
    const mapped = entry.mapped || (
      triangle
        ? geometryTriangleToPixels(editor, cache, triangle, editable, referenceUv, {
            record,
            hit,
            coverageOverride: entry.coverage,
            cacheVisibilityTrianglePixels: options.cacheVisibilityTrianglePixels
          })
        : null
    );
	    if (!mapped) {
	      addDebugCount("screenCandidateRejectMapping");
	      continue;
	    }
	    addDebugCount("screenCandidates");
	    candidates.push({
      distance,
      triangle,
      mapped,
      screenTriangle,
      ...(Number.isFinite(Number(entry.progress)) ? { progress: Number(entry.progress) } : {}),
      ...(Number.isFinite(Number(entry.signedOffset)) ? { signedOffset: Number(entry.signedOffset) } : {})
    });
    if (candidates.length >= maxScreenBrushCandidates) {
      break;
    }
	  }
  addDebugCount("screenCandidateFilterMs", Math.round(timingNow() - screenCandidateFilterStartMs));
  const screenCandidateSelectStartMs = timingNow();
	  const selected = selectScreenBrushVisibilityCandidates(candidates, screenSegments, maxTriangles, screenDomainRadius);
  addDebugCount("screenCandidateSelectMs", Math.round(timingNow() - screenCandidateSelectStartMs));
  addDebugCount("screenSelectedTriangles", selected.length);
	  const output = [];
  const screenCandidateProjectStartMs = timingNow();
  for (const candidate of selected) {
    output.push(candidate.projected);
    if (Array.isArray(options.screenProjectedSegments)) {
      appendScreenProjectedTextureSegments(
        options.screenProjectedSegments,
        candidate.screenTriangle,
        candidate.mapped,
        screenSegments,
        screenRadius,
        editable?.canvas || null,
        {
          maxTextureRadiusPixels: options.maxTextureRadiusPixels ?? options.radiusPixels,
          maxScreenProjectedSegments: options.maxScreenProjectedSegments
        }
      );
    }
  }
  addDebugCount("screenCandidateProjectMs", Math.round(timingNow() - screenCandidateProjectStartMs));
  return output;
}

function textureTriangleBounds(triangle = null, canvas = null, padding = 1) {
  const compact = compactVisibilityTriangle(triangle);
  if (!compact) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(canvas?.width) || 1));
  const height = Math.max(1, Math.floor(Number(canvas?.height) || 1));
  const points = [compact.a, compact.b, compact.c];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return null;
  }
  const pad = Math.max(0, Number(padding) || 0);
  const x = Math.max(0, Math.min(width - 1, Math.floor(minX - pad)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(minY - pad)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil(maxX + pad + 1)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil(maxY + pad + 1)));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function textureTriangleHasDiscontinuousSpan(triangle = null, canvas = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!compact) {
    return false;
  }
  const width = Math.max(1, Math.floor(Number(canvas?.width) || 1));
  const height = Math.max(1, Math.floor(Number(canvas?.height) || 1));
  const points = [compact.a, compact.b, compact.c];
  const xs = points.map((point) => point.x).filter(Number.isFinite);
  const ys = points.map((point) => point.y).filter(Number.isFinite);
  if (xs.length !== 3 || ys.length !== 3) {
    return false;
  }
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return spanX > width * 0.45 || spanY > height * 0.45;
}

function unionTextureBounds(left = null, right = null) {
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
  return {
    x,
    y,
    width: Math.max(1, rightEdge - x),
    height: Math.max(1, bottomEdge - y)
  };
}

function visibilityTrianglePaintRegions(triangles = [], canvas = null, padding = 2) {
  const regions = [];
  const pad = Math.max(0, Number(padding) || 0);
  for (const triangle of Array.isArray(triangles) ? triangles : []) {
    if (textureTriangleHasDiscontinuousSpan(triangle, canvas)) {
      continue;
    }
    const bounds = textureTriangleBounds(triangle, canvas, pad);
    if (bounds) {
      regions.push(bounds);
    }
  }
  return regions;
}

function screenTriangleForVisibilityTriangle(triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  const a = finitePoint(compact?.screenA);
  const b = finitePoint(compact?.screenB);
  const c = finitePoint(compact?.screenC);
  return compact && a && b && c
    ? {
        texture: compact,
        screen: { a, b, c }
      }
    : null;
}

function texturePaintRegionFromPoints(points = [], canvas = null, padding = 1) {
  const compactPoints = (Array.isArray(points) ? points : [])
    .map(finitePoint)
    .filter(Boolean);
  if (!compactPoints.length) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(canvas?.width) || 1));
  const height = Math.max(1, Math.floor(Number(canvas?.height) || 1));
  const pad = Math.max(0, Number(padding) || 0);
  const minX = Math.min(...compactPoints.map((point) => point.x));
  const minY = Math.min(...compactPoints.map((point) => point.y));
  const maxX = Math.max(...compactPoints.map((point) => point.x));
  const maxY = Math.max(...compactPoints.map((point) => point.y));
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return null;
  }
  const x = Math.max(0, Math.min(width - 1, Math.floor(minX - pad)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(minY - pad)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil(maxX + pad + 1)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil(maxY + pad + 1)));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function projectedSoftVisibilityGutterPadding(textureRadius = null, options = {}) {
  const explicit = Number(options.visibilityBleedRadius);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const scatter = Math.max(0, Math.min(1, Number(options.scatter) || 0));
  const hardness = Math.max(0, Math.min(1, Number(options.hardness ?? 0.35)));
  const radius = Math.max(
    0.75,
    Number(textureRadius) || 0.75,
    Number(options.maxTextureRadiusPixels) || 0
  );
  return Math.min(48, Math.max(0.75, airbrushHaloRadius(radius, scatter, hardness) * 0.22));
}

function projectedTextureTileMayTouchScreenSegment(tile = null, mapped = null, start = null, end = null, screenRadius = 1) {
  if (!tile || !mapped?.texture || !mapped?.screen || !finitePoint(start) || !finitePoint(end)) {
    return false;
  }
  const ratios = [0, 0.5, 1];
  const center = {
    x: tile.x + tile.width * 0.5,
    y: tile.y + tile.height * 0.5
  };
  const centerScreen = screenPointFromTextureTrianglePoint(center, mapped.texture, mapped.screen);
  let projectedMargin = 1;
  for (const yRatio of ratios) {
    for (const xRatio of ratios) {
      const point = {
        x: tile.x + tile.width * xRatio,
        y: tile.y + tile.height * yRatio
      };
      const screenPoint = screenPointFromTextureTrianglePoint(point, mapped.texture, mapped.screen);
      if (!screenPoint) {
        continue;
      }
      if (centerScreen) {
        projectedMargin = Math.max(projectedMargin, pointDistance(centerScreen, screenPoint));
      }
      if (pointToSegmentDistance(screenPoint, start, end) <= screenRadius + 1) {
        return true;
      }
    }
  }
  return Boolean(
    centerScreen
    && pointToSegmentDistance(centerScreen, start, end) <= screenRadius + Math.min(8, projectedMargin * 0.25)
  );
}

function normalizeTexturePaintRegion(region = null, canvas = null) {
  if (!region) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(canvas?.width) || 1));
  const height = Math.max(1, Math.floor(Number(canvas?.height) || 1));
  const x = Math.max(0, Math.min(width - 1, Math.floor(Number(region.x) || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(Number(region.y) || 0)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil((Number(region.x) || 0) + Math.max(1, Number(region.width) || 1))));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil((Number(region.y) || 0) + Math.max(1, Number(region.height) || 1))));
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

function texturePaintRegionWithVisibilityTriangle(region = null, triangle = null) {
  if (!region || !triangle) {
    return region;
  }
  const next = { ...region };
  Object.defineProperty(next, "visibilityTriangle", {
    value: triangle,
    enumerable: false
  });
  return next;
}

function tiledProjectedFootprintRegions(
  footprintRegion = null,
  mapped = null,
  segment = null,
  screenRadius = 1,
  canvas = null,
  options = {}
) {
  const region = normalizeTexturePaintRegion(footprintRegion, canvas);
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!region || !start || !end || options.tileProjectedPaintRegions !== true) {
    return region ? [region] : [];
  }
  const area = texturePaintRegionArea(region);
  const threshold = Math.max(
    96 * 96,
    Math.floor(Number(options.projectedPaintRegionTileThresholdPixels) || 128 * 128)
  );
  if (area <= threshold) {
    return [region];
  }
  const maxTiles = Math.max(
    4,
    Math.min(160, Math.floor(Number(options.maxProjectedFootprintTiles) || 48))
  );
  const requestedTileSize = Number(options.projectedFootprintTilePixels);
  const tileSize = Math.max(
    32,
    Math.min(
      256,
      Math.ceil(Number.isFinite(requestedTileSize) && requestedTileSize > 0
        ? requestedTileSize
        : Math.sqrt(area / maxTiles))
    )
  );
  const output = [];
  for (let y = region.y; y < region.y + region.height; y += tileSize) {
    for (let x = region.x; x < region.x + region.width; x += tileSize) {
      const tile = normalizeTexturePaintRegion({
        x,
        y,
        width: Math.min(tileSize, region.x + region.width - x),
        height: Math.min(tileSize, region.y + region.height - y)
      }, canvas);
      if (!tile || !projectedTextureTileMayTouchScreenSegment(tile, mapped, start, end, screenRadius)) {
        continue;
      }
      output.push(tile);
    }
  }
  return output.length ? output : [region];
}

function screenProjectedBrushPaintRegions(triangles = [], screenSegments = [], canvas = null, options = {}) {
  let regions = [];
  const debugCounts = options.projectedDebugCounts && typeof options.projectedDebugCounts === "object"
    ? options.projectedDebugCounts
    : null;
  const addDebugCount = (key, amount = 1) => {
    if (!debugCounts) {
      return;
    }
    debugCounts[key] = Math.max(0, Math.floor(Number(debugCounts[key]) || 0)) + amount;
  };
  addDebugCount("regionInputTriangles", Array.isArray(triangles) ? triangles.length : 0);
  const segmentList = Array.isArray(screenSegments) ? screenSegments : [];
  const fallbackScreenCoreRadius = Math.max(
    0.5,
    Number(options.radiusPixels)
      || Number(options.screenRadiusPixels)
      || 0.5
  );
  const maxScreenCoreRadius = segmentList.reduce((maxRadius, segment) => Math.max(
    maxRadius,
    Number(segment?.radiusPixels) || 0
  ), fallbackScreenCoreRadius);
  const canvasArea = Math.max(1, (Number(canvas?.width) || 1) * (Number(canvas?.height) || 1));
  const canUseIndexedFullTriangleRegions = options.fullProjectedTrianglePaintRegions === true
    && options.tileProjectedPaintRegions !== true
    && (Array.isArray(triangles) ? triangles : []).every((triangle) => (
      Number.isFinite(Number(triangle?.screenStrokeDistance))
    ));
  if (canUseIndexedFullTriangleRegions) {
    const screenDomainRadius = projectedSurfaceBrushDomainRadius(maxScreenCoreRadius, options.scatter, options.hardness);
    const padding = Math.max(
      32,
      Math.ceil(projectedSoftVisibilityGutterPadding(
        Number(options.maxTextureRadiusPixels) || Number(options.radiusPixels) || Number(options.screenRadiusPixels) || maxScreenCoreRadius,
        options
      ) + 6)
    );
    const sourceTriangles = Array.isArray(triangles) ? triangles : [];
    const useCoarseTiles = options.coarseProjectedTrianglePaintTiles !== false
      && sourceTriangles.length > 128;
    if (useCoarseTiles) {
      const width = Math.max(1, Math.floor(Number(canvas?.width) || 1));
      const height = Math.max(1, Math.floor(Number(canvas?.height) || 1));
      const tileSize = Math.max(
        128,
        Math.min(512, Math.floor(Number(options.projectedTrianglePaintTilePixels) || 256))
      );
      const tiles = new Map();
      for (const triangle of sourceTriangles) {
        if (Number(triangle?.screenStrokeDistance) > screenDomainRadius + 1) {
          addDebugCount("regionSkipDistance");
          continue;
        }
        if (textureTriangleHasDiscontinuousSpan(triangle, canvas)) {
          addDebugCount("regionSkipDiscontinuous");
          continue;
        }
        const bounds = textureTriangleBounds(triangle, canvas, padding);
        if (!bounds) {
          addDebugCount("regionMissingBounds");
          continue;
        }
        const startX = Math.max(0, Math.floor(bounds.x / tileSize) * tileSize);
        const startY = Math.max(0, Math.floor(bounds.y / tileSize) * tileSize);
        const endX = Math.min(width, Math.ceil((bounds.x + bounds.width) / tileSize) * tileSize);
        const endY = Math.min(height, Math.ceil((bounds.y + bounds.height) / tileSize) * tileSize);
        for (let y = startY; y < endY; y += tileSize) {
          for (let x = startX; x < endX; x += tileSize) {
            const region = normalizeTexturePaintRegion({
              x,
              y,
              width: Math.min(tileSize, width - x),
              height: Math.min(tileSize, height - y)
            }, canvas);
            if (!region) {
              continue;
            }
            tiles.set(`${region.x}:${region.y}:${region.width}:${region.height}`, region);
          }
        }
      }
      regions = [...tiles.values()];
      addDebugCount("regionCoarseTriangleTiles", regions.length);
      return regions;
    }
	    for (const triangle of Array.isArray(triangles) ? triangles : []) {
	      if (Number(triangle?.screenStrokeDistance) > screenDomainRadius + 1) {
	        addDebugCount("regionSkipDistance");
	        continue;
	      }
	      if (textureTriangleHasDiscontinuousSpan(triangle, canvas)) {
	        addDebugCount("regionSkipDiscontinuous");
	        continue;
	      }
	      const region = textureTriangleBounds(triangle, canvas, padding);
	      if (region) {
	        addDebugCount("regionFullTriangleBounds");
	        regions.push(texturePaintRegionWithVisibilityTriangle(region, triangle));
	      } else {
	        addDebugCount("regionMissingBounds");
	      }
	    }
	    return regions;
	  }
	  for (const triangle of Array.isArray(triangles) ? triangles : []) {
	    if (textureTriangleHasDiscontinuousSpan(triangle, canvas)) {
	      addDebugCount("regionSkipDiscontinuous");
	      continue;
	    }
	    const mapped = screenTriangleForVisibilityTriangle(triangle);
	    if (!mapped) {
	      addDebugCount("regionMissingScreenTriangle");
	      continue;
	    }
    const indexedScreenDistance = Number(triangle?.screenStrokeDistance);
    if (options.fullProjectedTrianglePaintRegions === true && Number.isFinite(indexedScreenDistance)) {
      const screenRadius = airbrushHaloRadius(maxScreenCoreRadius, options.scatter, options.hardness);
      const screenDomainRadius = projectedSurfaceBrushDomainRadius(maxScreenCoreRadius, options.scatter, options.hardness);
	      if (indexedScreenDistance <= screenDomainRadius + 1) {
        const textureRadius = clampProjectedTextureRadius(
          projectedTriangleTextureRadius(mapped.screen, mapped.texture, screenRadius),
          canvas,
          options
        );
        const padding = Math.max(32, Number(textureRadius) || 2);
        const fullTriangleRegion = textureTriangleBounds(mapped.texture, canvas, padding + 2);
        const fullTriangleArea = texturePaintRegionArea(fullTriangleRegion);
        const defaultFullProjectedTriangleArea = canvasArea;
        const maxFullProjectedTriangleArea = Math.max(
          128 * 128,
          Math.min(
            canvasArea,
            Math.floor(Number(options.maxFullProjectedTriangleRegionAreaPixels) || defaultFullProjectedTriangleArea)
          )
        );
	        if (fullTriangleRegion && fullTriangleArea > 0 && fullTriangleArea <= maxFullProjectedTriangleArea) {
	          addDebugCount("regionFullTriangleBounds");
	          regions.push(texturePaintRegionWithVisibilityTriangle(fullTriangleRegion, triangle));
	          continue;
	        }
	        addDebugCount("regionFullTriangleRejectedArea");
	      }
	    }
    for (const segment of segmentList) {
      const start = finitePoint(segment?.start);
      const end = finitePoint(segment?.end);
      if (!start || !end) {
        continue;
      }
      const screenCoreRadius = Math.max(
        0.5,
        Number(segment?.radiusPixels)
          || Number(options.radiusPixels)
          || Number(options.screenRadiusPixels)
          || 0.5
      );
	      const screenRadius = airbrushHaloRadius(screenCoreRadius, options.scatter, options.hardness);
	      const screenDomainRadius = projectedSurfaceBrushDomainRadius(screenCoreRadius, options.scatter, options.hardness);
		      if (segmentToTriangleDistance({ start, end }, mapped.screen) > screenDomainRadius + 1) {
		        addDebugCount("regionSkipSegmentDistance");
		        continue;
		      }
	      const textureRadius = clampProjectedTextureRadius(
	        projectedTriangleTextureRadius(mapped.screen, mapped.texture, screenRadius),
	        canvas,
	        options
	      );
      const padding = Math.max(2, Number(textureRadius) || 2);
      const fullTriangleRegion = textureTriangleBounds(mapped.texture, canvas, padding + 2);
      const fullTriangleArea = texturePaintRegionArea(fullTriangleRegion);
      const defaultFullProjectedTriangleArea = options.fullProjectedTrianglePaintRegions === true
        ? canvasArea
        : canvasArea * 0.08;
      const maxFullProjectedTriangleArea = Math.max(
        128 * 128,
        Math.min(
          canvasArea,
          Math.floor(Number(options.maxFullProjectedTriangleRegionAreaPixels) || defaultFullProjectedTriangleArea)
        )
      );
      const useFullProjectedTriangleRegion = options.fullProjectedTrianglePaintRegions === true
        && fullTriangleRegion
        && fullTriangleArea > 0
        && fullTriangleArea <= maxFullProjectedTriangleArea;
	      // Large projected strokes use the full UV triangle dispatch bound,
	      // MonkeyPaint-style. The shader evaluates the continuous screen brush
	      // field and writes zero outside the brush, so we do not need the costly
	      // sampled-footprint approximation for this path.
			      if (useFullProjectedTriangleRegion) {
			        addDebugCount("regionFullTriangleBounds");
			        regions.push(texturePaintRegionWithVisibilityTriangle(fullTriangleRegion, triangle));
			        break;
			      }
      const projectedHaloPadding = Math.ceil(Math.min(
        96,
        airbrushHaloRadius(
          Math.max(0.75, Number(textureRadius) || 0.75),
          options.scatter,
          options.hardness
        ) * 0.08 + 4
      ));
      const footprintPadding = Math.min(
        96,
        Math.max(
          6,
          projectedHaloPadding,
          Math.ceil(projectedSoftVisibilityGutterPadding(textureRadius, options) + 6)
        )
      );
      const segmentLength = pointDistance(start, end);
      const pieces = Number.isFinite(segmentLength) && segmentLength > 0.001
        ? Math.max(1, Math.min(24, Math.ceil(segmentLength / Math.max(4, screenRadius * 0.5))))
        : 1;
      const tangent = segmentLength > 0.001
        ? {
            x: (end.x - start.x) / segmentLength,
            y: (end.y - start.y) / segmentLength
          }
        : { x: 1, y: 0 };
      const normal = { x: -tangent.y, y: tangent.x };
      const diagonalScale = screenRadius * 0.70710678118;
      const offsets = [
        { x: 0, y: 0 },
        { x: normal.x * screenRadius, y: normal.y * screenRadius },
        { x: -normal.x * screenRadius, y: -normal.y * screenRadius },
        { x: tangent.x * screenRadius, y: tangent.y * screenRadius },
        { x: -tangent.x * screenRadius, y: -tangent.y * screenRadius },
        { x: (normal.x + tangent.x) * diagonalScale, y: (normal.y + tangent.y) * diagonalScale },
        { x: (normal.x - tangent.x) * diagonalScale, y: (normal.y - tangent.y) * diagonalScale },
        { x: (-normal.x + tangent.x) * diagonalScale, y: (-normal.y + tangent.y) * diagonalScale },
        { x: (-normal.x - tangent.x) * diagonalScale, y: (-normal.y - tangent.y) * diagonalScale }
      ];
      const texturePoints = [];
      const appendScreenPoint = (point = null) => {
        const screenPoint = finitePoint(point);
        if (!screenPoint) {
          return;
        }
        const closest = closestPointOnTriangle(screenPoint, mapped.screen);
        if (!closest || pointDistance(screenPoint, closest) > screenRadius + 0.5) {
          return;
        }
        const texturePoint = texturePointFromScreenTrianglePoint(closest, mapped.screen, mapped.texture);
        if (texturePoint) {
          texturePoints.push(texturePoint);
        }
      };
      for (let index = 0; index <= pieces; index += 1) {
        const ratio = pieces <= 0 ? 0 : index / pieces;
        const center = {
          x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio
        };
        for (const offset of offsets) {
          appendScreenPoint({
            x: center.x + offset.x,
            y: center.y + offset.y
          });
        }
      }
      const textureVertices = [mapped.texture.a, mapped.texture.b, mapped.texture.c];
      const screenVertices = [mapped.screen.a, mapped.screen.b, mapped.screen.c];
      for (let index = 0; index < screenVertices.length; index += 1) {
        if (pointToSegmentDistance(screenVertices[index], start, end) <= screenRadius + 0.5) {
          texturePoints.push(textureVertices[index]);
        }
      }
      const footprintRegion = texturePaintRegionFromPoints(texturePoints, canvas, footprintPadding);
      const maxTriangleFallbackArea = Math.max(128 * 128, Math.min(canvasArea * 0.015, 96 * 1024));
      const safeFullTriangleFallback = !footprintRegion
        && fullTriangleRegion
        && fullTriangleArea > 0
        && fullTriangleArea <= maxTriangleFallbackArea;
      // Paint regions are dispatch bounds only. In projected mode they must
      // never become the visible brush edge. Large live strokes use the whole
      // projected triangle bound, MonkeyPaint-style: the shader evaluates the
      // continuous screen field and writes zero outside the brush, so UV
      // rectangles and sampled footprint boxes cannot print through.
	      const nextRegions = useFullProjectedTriangleRegion
	        ? [texturePaintRegionWithVisibilityTriangle(fullTriangleRegion, triangle)]
	        : footprintRegion
	        ? tiledProjectedFootprintRegions(footprintRegion, mapped, { start, end }, screenRadius, canvas, options)
	        : (safeFullTriangleFallback
	          ? [texturePaintRegionWithVisibilityTriangle(fullTriangleRegion, triangle)]
	          : []);
	      const preserveProjectedTiles = options.tileProjectedPaintRegions === true && nextRegions.length > 1;
	      addDebugCount(
	        useFullProjectedTriangleRegion ? "regionFullTriangleBounds" : "regionFootprintBounds",
	        nextRegions.length
	      );
	      for (const nextRegion of nextRegions) {
        if (preserveProjectedTiles) {
          regions.push(nextRegion);
        } else {
          regions = mergeProjectedTexturePaintRegion(
            regions,
            nextRegion,
            canvas
          );
        }
      }
    }
  }
  return regions;
}

export const textureAirbrushWebGpuScreenProjectedBrushPaintRegionsForTest = screenProjectedBrushPaintRegions;

function textureStrokeSegmentPaintRegion(segment = null, canvas = null, options = {}) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!start || !end) {
    return null;
  }
  const width = Math.max(1, Math.floor(Number(canvas?.width) || 1));
  const height = Math.max(1, Math.floor(Number(canvas?.height) || 1));
  const radius = Math.max(0.75, Number(segment?.radiusPixels) || Number(options.radiusPixels) || 0.75);
  const scatter = Math.max(0, Math.min(1, Number(options.scatter) || 0));
  const hardness = Math.max(0, Math.min(1, Number(options.hardness ?? 0.35)));
  const padding = Math.ceil(airbrushHaloRadius(radius, scatter, hardness) + 2);
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxX = Math.max(start.x, end.x);
  const maxY = Math.max(start.y, end.y);
  const x = Math.max(0, Math.min(width - 1, Math.floor(minX - padding)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(minY - padding)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil(maxX + padding + 1)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil(maxY + padding + 1)));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function texturePaintRegionsOverlap(left = null, right = null, padding = 0) {
  if (!left || !right) {
    return false;
  }
  const pad = Math.max(0, Number(padding) || 0);
  return !(
    left.x + left.width + pad < right.x
    || right.x + right.width + pad < left.x
    || left.y + left.height + pad < right.y
    || right.y + right.height + pad < left.y
  );
}

function mergeTexturePaintRegion(regions = [], region = null) {
  if (!region) {
    return regions;
  }
  let merged = region;
  const next = [];
  for (const existing of regions) {
    if (texturePaintRegionsOverlap(existing, merged, 1)) {
      merged = unionTextureBounds(existing, merged);
    } else {
      next.push(existing);
    }
  }
  next.push(merged);
  return next;
}

function projectedTexturePaintRegionsShouldMerge(left = null, right = null, canvas = null) {
  if (!texturePaintRegionsOverlap(left, right, 1)) {
    return false;
  }
  const union = unionTextureBounds(left, right);
  const leftArea = texturePaintRegionArea(left);
  const rightArea = texturePaintRegionArea(right);
  const separateArea = Math.max(1, leftArea + rightArea);
  const unionArea = texturePaintRegionArea(union);
  const wastePixels = Math.max(0, unionArea - separateArea);
  const canvasArea = Math.max(1, (Number(canvas?.width) || 1) * (Number(canvas?.height) || 1));
  const canvasWidth = Math.max(1, Number(canvas?.width) || 1);
  const canvasHeight = Math.max(1, Number(canvas?.height) || 1);
  if (
    unionArea > separateArea * 1.05
    && (
      (union.width > canvasWidth * 0.45 && Math.max(left.width, right.width) < canvasWidth * 0.25)
      || (union.height > canvasHeight * 0.45 && Math.max(left.height, right.height) < canvasHeight * 0.25)
    )
  ) {
    return false;
  }
  return unionArea <= separateArea * 1.2
    || wastePixels <= Math.max(16 * 1024, Math.min(canvasArea * 0.0025, 192 * 1024));
}

function mergeProjectedTexturePaintRegion(regions = [], region = null, canvas = null) {
  if (!region) {
    return regions;
  }
  let merged = region;
  const next = [];
  for (const existing of regions) {
    if (projectedTexturePaintRegionsShouldMerge(existing, merged, canvas)) {
      merged = unionTextureBounds(existing, merged);
    } else {
      next.push(existing);
    }
  }
  next.push(merged);
  return next;
}

function projectedStrokePaintRegions(segments = [], canvas = null, options = {}) {
  let regions = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (
      options.localOnly === true
      && textureStrokeSegmentLength(segment) > 0.001
      && !textureProjectedSeamSegmentIsLocal(segment, segment?.radiusPixels || options.radiusPixels, canvas)
    ) {
      continue;
    }
    regions = mergeTexturePaintRegion(regions, textureStrokeSegmentPaintRegion(segment, canvas, options));
  }
  return regions;
}

function texturePaintRegionArea(region = null) {
  return Math.max(0, Number(region?.width) || 0) * Math.max(0, Number(region?.height) || 0);
}

function texturePaintRegionTotalArea(regions = []) {
  return (Array.isArray(regions) ? regions : [])
    .reduce((total, region) => total + texturePaintRegionArea(region), 0);
}

function smallerTexturePaintRegions(left = [], right = []) {
  const leftRegions = Array.isArray(left) ? left.filter(Boolean) : [];
  const rightRegions = Array.isArray(right) ? right.filter(Boolean) : [];
  if (!leftRegions.length) {
    return rightRegions;
  }
  if (!rightRegions.length) {
    return leftRegions;
  }
  return texturePaintRegionTotalArea(rightRegions) < texturePaintRegionTotalArea(leftRegions)
    ? rightRegions
    : leftRegions;
}

function pointToSegmentClosestPoint(point = null, start = null, end = null) {
  if (!finitePoint(point) || !finitePoint(start) || !finitePoint(end)) {
    return null;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.0001) {
    return { x: end.x, y: end.y };
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSq));
  return {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t
  };
}

function closestPointOnTriangle(point = null, triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!finitePoint(point) || !compact) {
    return null;
  }
  if (pointInTriangle(point, compact)) {
    return { x: point.x, y: point.y };
  }
  const candidates = triangleEdges(compact)
    .map(([start, end]) => pointToSegmentClosestPoint(point, start, end))
    .filter(Boolean);
  if (!candidates.length) {
    return null;
  }
  return candidates.reduce((best, candidate) => (
    pointDistance(point, candidate) < pointDistance(point, best) ? candidate : best
  ), candidates[0]);
}

function barycentricPoint(point = null, triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!finitePoint(point) || !compact) {
    return null;
  }
  const v0x = compact.b.x - compact.a.x;
  const v0y = compact.b.y - compact.a.y;
  const v1x = compact.c.x - compact.a.x;
  const v1y = compact.c.y - compact.a.y;
  const v2x = point.x - compact.a.x;
  const v2y = point.y - compact.a.y;
  const d00 = v0x * v0x + v0y * v0y;
  const d01 = v0x * v1x + v0y * v1y;
  const d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y;
  const d21 = v2x * v1x + v2y * v1y;
  const denom = d00 * d11 - d01 * d01;
  if (!Number.isFinite(denom) || Math.abs(denom) <= 0.000001) {
    return null;
  }
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  return { u, v, w };
}

function pointFromBarycentric(barycentric = null, triangle = null) {
  const compact = compactVisibilityTriangle(triangle);
  if (!compact || !Number.isFinite(barycentric?.u) || !Number.isFinite(barycentric?.v) || !Number.isFinite(barycentric?.w)) {
    return null;
  }
  return {
    x: compact.a.x * barycentric.u + compact.b.x * barycentric.v + compact.c.x * barycentric.w,
    y: compact.a.y * barycentric.u + compact.b.y * barycentric.v + compact.c.y * barycentric.w
  };
}

function texturePointFromScreenTrianglePoint(point = null, screenTriangle = null, textureTriangle = null) {
  const closest = closestPointOnTriangle(point, screenTriangle);
  const barycentric = barycentricPoint(closest, screenTriangle);
  return pointFromBarycentric(barycentric, textureTriangle);
}

function screenPointFromTextureTrianglePoint(point = null, textureTriangle = null, screenTriangle = null) {
  const closest = closestPointOnTriangle(point, textureTriangle);
  const barycentric = barycentricPoint(closest, textureTriangle);
  return pointFromBarycentric(barycentric, screenTriangle);
}

function projectedTriangleTextureRadius(screenTriangle = null, textureTriangle = null, screenRadiusPixels = 1) {
  const screen = compactVisibilityTriangle(screenTriangle);
  const texture = compactVisibilityTriangle(textureTriangle);
  if (!screen || !texture) {
    return null;
  }
  const edgePairs = [
    [screen.a, screen.b, texture.a, texture.b],
    [screen.b, screen.c, texture.b, texture.c],
    [screen.c, screen.a, texture.c, texture.a]
  ];
  const ratios = edgePairs.map(([screenStart, screenEnd, textureStart, textureEnd]) => {
    const screenLength = pointDistance(screenStart, screenEnd);
    const textureLength = pointDistance(textureStart, textureEnd);
    return screenLength > 0.5 && Number.isFinite(textureLength) && textureLength > 0
      ? textureLength / screenLength
      : null;
  }).filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  const ratio = medianNumber(ratios);
  return Number.isFinite(ratio) && ratio > 0
    ? Math.max(0.75, ratio * Math.max(0.5, Number(screenRadiusPixels) || 0.5) * 1.08)
    : null;
}

function clampProjectedTextureRadius(textureRadius = null, canvas = null, options = {}) {
  const radius = Number(textureRadius);
  if (!Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  const maxTextureSize = Math.max(1, Number(canvas?.width) || 1, Number(canvas?.height) || 1);
  const explicitMax = Number(options.maxTextureRadiusPixels);
  const maxRadius = Number.isFinite(explicitMax) && explicitMax > 0
    ? Math.max(0.75, explicitMax)
    : maxTextureSize * 0.5;
  return Math.max(0.75, Math.min(radius, maxRadius));
}

function appendScreenProjectedTextureSegments(output = null, screenTriangle = null, textureTriangle = null, screenSegments = [], radiusPixels = 1, canvas = null, options = {}) {
  if (!Array.isArray(output) || !screenTriangle || !textureTriangle || !Array.isArray(screenSegments)) {
    return 0;
  }
  const maxOutputSegments = Number.isFinite(Number(options.maxScreenProjectedSegments))
    ? Math.max(1, Math.floor(Number(options.maxScreenProjectedSegments)))
    : TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
  if (output.length >= maxOutputSegments) {
    return 0;
  }
  if (textureTriangleHasDiscontinuousSpan(textureTriangle, canvas)) {
    return 0;
  }
  const radius = Math.max(0.5, Number(radiusPixels) || 0.5);
  const textureRadius = clampProjectedTextureRadius(
    projectedTriangleTextureRadius(screenTriangle, textureTriangle, radius),
    canvas,
    options
  );
  let changed = 0;
  const projectedPointAtRatio = (segment = null, ratio = 0) => {
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    if (!start || !end) {
      return null;
    }
    const safeRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
    const point = {
      x: start.x + (end.x - start.x) * safeRatio,
      y: start.y + (end.y - start.y) * safeRatio
    };
    if (pointDistance(point, closestPointOnTriangle(point, screenTriangle)) > radius) {
      return null;
    }
    const texturePoint = texturePointFromScreenTrianglePoint(point, screenTriangle, textureTriangle);
    return texturePoint ? { screen: point, texture: texturePoint } : null;
  };
  const pointsDiffer = (left = null, right = null) => (
    Number.isFinite(left?.texture?.x)
    && Number.isFinite(left?.texture?.y)
    && Number.isFinite(right?.texture?.x)
    && Number.isFinite(right?.texture?.y)
    && pointDistance(left.texture, right.texture) > 0.001
  );
  for (const segment of screenSegments) {
    if (output.length >= maxOutputSegments || output.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
      break;
    }
    if (segmentToTriangleDistance(segment, screenTriangle) > radius) {
      continue;
    }
    const segmentStart = finitePoint(segment?.start);
    const segmentEnd = finitePoint(segment?.end);
    const segmentLength = pointDistance(segmentStart, segmentEnd);
    const stepPixels = Math.max(2, Math.min(12, radius * 0.35));
    const pieces = Number.isFinite(segmentLength) && segmentLength > 0.001
      ? Math.max(2, Math.min(10, Math.ceil(segmentLength / stepPixels)))
      : 1;
    const ratios = Array.from({ length: pieces + 1 }, (_, index) => (
      pieces <= 0 ? 0 : index / pieces
    ));
    const texturePoints = ratios
      .map((ratio) => projectedPointAtRatio(segment, ratio))
      .filter(Boolean)
      .reduce((points, point) => {
        if (!points.some((entry) => !pointsDiffer(entry, point))) {
          points.push(point);
        }
        return points;
      }, []);
    if (texturePoints.length === 1 && pointDistance(segment?.start, segment?.end) <= 0.001) {
      if (pushTextureSegment(output, texturePoints[0].texture, texturePoints[0].texture, {
        radiusPixels: textureRadius,
        screenStart: texturePoints[0].screen,
        screenEnd: texturePoints[0].screen,
        screenRadiusPixels: radius
      })) {
        changed += 1;
      }
      continue;
    }
    for (
      let index = 1;
      index < texturePoints.length
        && output.length < TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
        && output.length < maxOutputSegments;
      index += 1
    ) {
      const start = texturePoints[index - 1];
      const end = texturePoints[index];
      if (!pointsDiffer(start, end)) {
        continue;
      }
      if (textureSegmentCanConnect(start.texture, end.texture, start.screen, end.screen, textureRadius, canvas)) {
        if (pushTextureSegment(output, start.texture, end.texture, {
          radiusPixels: textureRadius,
          screenStart: start.screen,
          screenEnd: end.screen,
          screenRadiusPixels: radius
        })) {
          changed += 1;
        }
      } else {
        if (pushTextureSegment(output, start.texture, start.texture, {
          radiusPixels: textureRadius,
          screenStart: start.screen,
          screenEnd: start.screen,
          screenRadiusPixels: radius
        })) {
          changed += 1;
        }
        if (output.length < TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
          && output.length < maxOutputSegments
          && pushTextureSegment(output, end.texture, end.texture, {
            radiusPixels: textureRadius,
            screenStart: end.screen,
            screenEnd: end.screen,
            screenRadiusPixels: radius
          })) {
          changed += 1;
        }
      }
    }
  }
  return changed;
}

function projectedSurfaceRenderTriangles(
  editor = null,
  record = null,
  hit = null,
  editable = null,
  referenceUv = null,
  screenSegments = [],
  screenRadiusPixels = 1,
  options = {}
) {
  const geometry = record?.geometry || hit?.object?.geometry || null;
  const cache = visibilityTriangleCacheForGeometry(geometry);
  const segments = Array.isArray(screenSegments) ? screenSegments : [];
  const screenRadius = Math.max(0.5, Number(screenRadiusPixels) || 0);
  const debugCounts = options.projectedDebugCounts && typeof options.projectedDebugCounts === "object"
    ? options.projectedDebugCounts
    : null;
  const addDebugCount = (key, amount = 1) => {
    if (!debugCounts) {
      return;
    }
    debugCounts[key] = Math.max(0, Math.floor(Number(debugCounts[key]) || 0)) + amount;
  };
  if (!cache?.triangles?.length || !segments.length || screenRadius <= 0) {
    addDebugCount("projectedSurfaceRenderUnavailable");
    return [];
  }
  const fullSurfaceRender = options.fullProjectedSurfaceRenderTriangles === true
    && (options.visibleEdgeMode || "soft") !== "hard";
  const materialIndex = Math.max(0, Math.floor(Number(options.materialIndex) || 0));
  const sourceMaterial = options.material || null;
  const neighborPaintSeed = options.neighborPaintSeed || null;
  const domainRadius = projectedSurfaceBrushDomainRadius(screenRadius, options.scatter, options.hardness);
  const maxTriangles = Math.max(
    1,
    Math.min(
      65535,
      Math.floor(Number(options.maxProjectedRenderTriangles) || (fullSurfaceRender ? 65535 : 4096))
    )
  );
  const object = record?.object || hit?.object || null;
  const frameKey = webGpuStrokeFrameCacheKey(editor);
  const surfaceCache = frameScopedEditorCache(
    editor,
    "textureAirbrushWebGpuProjectedSurfaceTriangleCache",
    frameKey,
    TEXTURE_AIRBRUSH_WEBGPU_PROJECTED_SURFACE_CACHE_LIMIT
  );
  const surfaceKey = [
    stableCacheId(record, "record"),
    stableCacheId(object, "object"),
    stableCacheId(geometry, "geometry"),
    stableCacheId(editable?.texture, "texture"),
    stableCacheId(editable?.layer, "layer"),
    editable?.canvas?.width || 0,
    editable?.canvas?.height || 0,
    cache.uvVersion || 0,
    cache.indexVersion || 0,
    webGpuStrokePoseCacheKey(editor, object),
    materialIndex,
    sourceMaterial?.uuid || sourceMaterial?.id || sourceMaterial?.name || "material",
    neighborSeedCacheKey(editor, neighborPaintSeed),
    options.cacheVisibilityTrianglePixels === false ? "uncached-pixels" : "cached-pixels"
  ].join(":");
  let projectedSurface = surfaceCache?.get(surfaceKey) || null;
  if (!Array.isArray(projectedSurface)) {
    const materialMatchCache = new Map();
    const triangleMatchesPaintTarget = (triangle = null) => {
      if (!cache.hasMaterialGroups) {
        return true;
      }
      const triangleMaterialIndex = Math.max(0, Math.floor(Number(triangle?.materialIndex) || 0));
      if (triangleMaterialIndex === materialIndex) {
        return true;
      }
      if (materialMatchCache.has(triangleMaterialIndex)) {
        return materialMatchCache.get(triangleMaterialIndex);
      }
      const triangleMaterial = materialForRecordIndex(record, triangleMaterialIndex);
      const matches = materialPaintTargetMatches(editor, triangleMaterial, editable, sourceMaterial);
      materialMatchCache.set(triangleMaterialIndex, matches);
      return matches;
    };
    projectedSurface = [];
    const seen = new Set();
    for (const triangle of cache.triangles) {
      if (!triangle) {
        continue;
      }
      if (!triangleMatchesPaintTarget(triangle)) {
        addDebugCount("projectedSurfaceRenderRejectMaterial");
        continue;
      }
      if (!neighborSeedAllowsTriangle(editor, neighborPaintSeed, record, triangle)) {
        addDebugCount("projectedSurfaceRenderRejectNeighbor");
        continue;
      }
      const screenTriangle = screenTriangleFromGeometryTriangle(editor, record, hit, triangle);
      const mapped = geometryTriangleToPixels(editor, cache, triangle, editable, referenceUv, {
        record,
        hit,
        ...(fullSurfaceRender ? { coverageOverride: 1 } : {}),
        cacheVisibilityTrianglePixels: options.cacheVisibilityTrianglePixels
      });
      if (!mapped || !screenTriangle) {
        addDebugCount("projectedSurfaceRenderRejectMapping");
        continue;
      }
      const projected = visibilityTriangleWithScreenTriangle(mapped, screenTriangle);
      const compact = compactVisibilityTriangle(projected);
      const key = compactTriangleKey(compact);
      if (!compact || !key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      projectedSurface.push(compact);
    }
    boundedCacheSet(
      surfaceCache,
      surfaceKey,
      projectedSurface,
      TEXTURE_AIRBRUSH_WEBGPU_PROJECTED_SURFACE_CACHE_LIMIT
    );
    addDebugCount("projectedSurfaceRenderCacheMisses");
    addDebugCount("projectedSurfaceRenderCacheTriangles", projectedSurface.length);
  } else {
    addDebugCount("projectedSurfaceRenderCacheHits");
  }
  if (fullSurfaceRender) {
    const output = projectedSurface.map((triangle) => ({
      ...triangle,
      screenStrokeDistance: 0
    }));
    if (output.length > maxTriangles) {
      output.length = maxTriangles;
      addDebugCount("projectedSurfaceRenderLimit");
    }
    addDebugCount("projectedSurfaceRenderFullSurface");
    addDebugCount("projectedSurfaceRenderTriangles", output.length);
    return output;
  }
  const output = [];
  for (const triangle of projectedSurface) {
    const screenTriangle = screenTriangleForVisibilityTriangle(triangle)?.screen || null;
    const distance = visibilityTriangleDistanceToSegments(screenTriangle, segments);
    if (!Number.isFinite(distance) || distance > domainRadius + 1) {
      addDebugCount("projectedSurfaceRenderRejectDistance");
      continue;
    }
    output.push({
      ...triangle,
      screenStrokeDistance: distance
    });
  }
  if (output.length > maxTriangles) {
    output.sort((left, right) => (
      (Number(left.screenStrokeDistance) || 0) - (Number(right.screenStrokeDistance) || 0)
    ));
    output.length = maxTriangles;
    addDebugCount("projectedSurfaceRenderLimit");
  }
  addDebugCount("projectedSurfaceRenderTriangles", output.length);
  return output;
}

function visibilityTrianglesFromHit(editor = null, record = null, hit = null, editable = null, referenceUv = null, options = {}) {
  const geometry = record?.geometry || hit?.object?.geometry || null;
  const cache = visibilityTriangleCacheForGeometry(geometry);
  const startIndex = hitTriangleIndex(cache, hit);
  const startTriangle = cache && startIndex >= 0 ? cache.triangles[startIndex] || null : null;
  const neighborPaintSeed = options.neighborPaintSeed || null;
  if (
    cache
    && startIndex >= 0
    && !neighborSeedAllowsTriangle(editor, neighborPaintSeed, record, cache.triangles[startIndex] || null)
  ) {
    return [];
  }
  const directTriangle = cache && startIndex >= 0
    ? geometryTriangleToPixels(editor, cache, cache.triangles[startIndex], editable, referenceUv, {
        record,
        hit,
        cacheVisibilityTrianglePixels: options.cacheVisibilityTrianglePixels
      })
    : visibilityTriangleFromHit(editor, record, hit, editable, referenceUv);
  if (!directTriangle) {
    return [];
  }
  if (!cache || startIndex < 0) {
    return [directTriangle];
  }
  const projectedScreenBrushVisibility = options.screenBrushVisibilityTriangles === true
    && (
      options.liveProjectedPaint === true
      || options.screenStrokePaint === true
    );
  const requestedMaxVisibilityTriangles = Number(options.maxVisibilityTriangles);
  const defaultMaxVisibilityTriangles = projectedScreenBrushVisibility
    ? TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_CAPACITY
    : 48;
  const maxTriangles = Math.max(
    1,
    Math.min(
      TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_TRIANGLE_CAPACITY,
      Math.floor(
        Number.isFinite(requestedMaxVisibilityTriangles) && requestedMaxVisibilityTriangles > 0
          ? requestedMaxVisibilityTriangles
          : defaultMaxVisibilityTriangles
      )
    )
  );
  const center = finitePoint(options.center)
    || texturePixelFromUvRelative(editor, hit?.uv, editable, referenceUv)
    || directTriangle.a;
  const radius = Math.max(1, Number(options.radiusPixels) || 1) * 1.35 + 2;
  const segments = Array.isArray(options.strokeSegments) && options.strokeSegments.length
    ? options.strokeSegments
    : [{ start: center, end: center }];
	  const rawScreenSegments = screenStrokeSegmentsForVisibility(
	    editor,
	    options.screenStrokeSegments,
	    options.clientCenter
	  );
	  const screenRadius = Math.max(0.5, Number(options.screenRadiusPixels) || 0);
	  const screenSegments = (
	    options.liveProjectedPaint === true
	    || options.screenStrokePaint === true
	  )
	    ? connectScreenStrokeSegmentGaps(rawScreenSegments, screenRadius)
	    : rawScreenSegments;
	  const screenHaloRadius = airbrushHaloRadius(screenRadius, options.scatter, options.hardness);
  const screenProjectedSegments = Array.isArray(options.screenBrushTextureSegments)
    ? options.screenBrushTextureSegments
    : null;
  const materialIndex = materialIndexForHit(hit, options.materialIndex ?? 0);
  const sourceMaterial = options.material || null;
  const materialMatchCache = new Map();
  const triangleMatchesPaintTarget = (triangle = null) => {
    if (!cache.hasMaterialGroups) {
      return true;
    }
    const triangleMaterialIndex = Math.max(0, Math.floor(Number(triangle?.materialIndex) || 0));
    if (triangleMaterialIndex === materialIndex) {
      return true;
    }
    if (materialMatchCache.has(triangleMaterialIndex)) {
      return materialMatchCache.get(triangleMaterialIndex);
    }
    const triangleMaterial = materialForRecordIndex(record, triangleMaterialIndex);
    const matches = materialPaintTargetMatches(editor, triangleMaterial, editable, sourceMaterial);
    materialMatchCache.set(triangleMaterialIndex, matches);
    return matches;
  };
  const listCacheKey = visibilityTriangleListCacheKey(editor, cache, hit, editable, referenceUv, {
    ...options,
      record,
      startIndex,
      center,
      radius,
      screenRadiusPixels: screenRadius,
      maxTriangles,
      materialIndex,
      strokeSegments: segments,
    screenStrokeSegments: screenSegments
  });
  const listCache = listCacheKey
    ? frameScopedEditorCache(
      editor,
      "textureAirbrushWebGpuVisibilityTriangleListCache",
      webGpuStrokeFrameCacheKey(editor),
      TEXTURE_AIRBRUSH_WEBGPU_TRIANGLE_LIST_CACHE_LIMIT
    )
    : null;
  const cachedList = listCache?.get(listCacheKey);
  if (Array.isArray(cachedList) && cachedList.length) {
    const cachedTriangles = cachedList.map(compactVisibilityTriangle).filter(Boolean);
    if (options.projectedDebugCounts && typeof options.projectedDebugCounts === "object") {
      const addCachedDebugCount = (key, amount = 1) => {
        options.projectedDebugCounts[key] = Math.max(
          0,
          Math.floor(Number(options.projectedDebugCounts[key]) || 0)
        ) + amount;
      };
      addCachedDebugCount("visibilityTriangleListCacheHits");
      addCachedDebugCount("visibilityTriangleListCacheTriangles", cachedTriangles.length);
      addCachedDebugCount("screenSelectedTriangles", cachedTriangles.length);
    }
    if (screenProjectedSegments && screenSegments.length && screenRadius > 0) {
      for (const triangle of cachedTriangles) {
        const mapped = screenTriangleForVisibilityTriangle(triangle);
        if (!mapped) {
          continue;
        }
        appendScreenProjectedTextureSegments(
          screenProjectedSegments,
          mapped.screen,
          mapped.texture,
          screenSegments,
          screenRadius,
          editable?.canvas || null,
          {
            maxTextureRadiusPixels: options.maxTextureRadiusPixels ?? options.radiusPixels,
            maxScreenProjectedSegments: options.maxScreenProjectedSegments
          }
        );
      }
    }
    return cachedTriangles;
  }
  const preferScreenBrushTriangles = screenSegments.length
    && screenRadius > 0
    && options.screenBrushVisibilityTriangles === true;
  if (preferScreenBrushTriangles) {
    const screenBrushTriangles = collectScreenBrushVisibilityTriangles(
      editor,
      record,
      hit,
      editable,
      referenceUv,
      {
        cache,
        screenSegments,
        screenRadiusPixels: screenRadius,
        maxTriangles,
        materialIndex,
        neighborPaintSeed,
        screenProjectedSegments,
        startTriangle,
        liveProjectedPaint: options.liveProjectedPaint,
        screenStrokePaint: options.screenStrokePaint,
        screenSurfaceContinuityFilter: options.screenSurfaceContinuityFilter,
        surfaceContinuitySamplesIgnoreMaterial: options.surfaceContinuitySamplesIgnoreMaterial,
        surfaceContinuityRadiusScale: options.surfaceContinuityRadiusScale,
        surfaceContinuityDepthWindow: options.surfaceContinuityDepthWindow,
        surfaceContinuityComponentDepthWindow: options.surfaceContinuityComponentDepthWindow,
        surfaceContinuityComponentNormalDot: options.surfaceContinuityComponentNormalDot,
        surfaceContinuityKeepDisconnected: options.surfaceContinuityKeepDisconnected,
        maxSurfaceContinuitySamples: options.maxSurfaceContinuitySamples,
        visibleEdgeMode: options.visibleEdgeMode,
        radiusPixels: options.radiusPixels,
        maxTextureRadiusPixels: options.maxTextureRadiusPixels ?? options.radiusPixels,
        maxScreenProjectedSegments: options.maxScreenProjectedSegments,
        scatter: options.scatter,
        cacheVisibilityTrianglePixels: options.cacheVisibilityTrianglePixels,
        projectedDebugCounts: options.projectedDebugCounts
      }
    );
    if (screenBrushTriangles.length) {
      boundedCacheSet(
        listCache,
        listCacheKey,
        screenBrushTriangles.map(compactVisibilityTriangle).filter(Boolean),
        TEXTURE_AIRBRUSH_WEBGPU_TRIANGLE_LIST_CACHE_LIMIT
      );
      return screenBrushTriangles;
    }
  }
  const output = [];
  const seen = new Set();
  const queue = [startIndex];
  const enqueueTriangleIndex = (triangleIndex) => {
    if (!seen.has(triangleIndex)) {
      queue.push(triangleIndex);
    }
  };
  const enqueueNeighbors = (triangle = null) => {
    for (const key of triangleEdgeKeys(triangle?.vertices || [])) {
      for (const neighborIndex of cache.edgeTriangles.get(key) || []) {
        enqueueTriangleIndex(neighborIndex);
      }
    }
    for (const key of triangle?.uvEdges || []) {
      for (const neighborIndex of cache.uvEdgeTriangles.get(key) || []) {
        enqueueTriangleIndex(neighborIndex);
      }
    }
    for (const vertexIndex of triangle?.vertices || []) {
      const linkedVertices = editor?.textureAirbrushNeighborLinkedVertices?.(record, vertexIndex)
        || record?.seamVertexMap?.get?.(vertexIndex)
        || null;
      if (!Array.isArray(linkedVertices) || linkedVertices.length <= 1) {
        continue;
      }
      for (const linkedVertexIndex of linkedVertices) {
        if (linkedVertexIndex === vertexIndex) {
          continue;
        }
        for (const neighborIndex of cache.vertexTriangles.get(linkedVertexIndex) || []) {
          enqueueTriangleIndex(neighborIndex);
        }
      }
    }
  };
  while (queue.length && output.length < maxTriangles) {
    const triangleIndex = queue.shift();
    if (seen.has(triangleIndex)) {
      continue;
    }
    seen.add(triangleIndex);
    const triangle = cache.triangles[triangleIndex] || null;
    if (!triangle) {
      continue;
    }
    if (!triangleMatchesPaintTarget(triangle)) {
      continue;
    }
    if (!neighborSeedAllowsTriangle(editor, neighborPaintSeed, record, triangle)) {
      continue;
    }
    const mapped = geometryTriangleToPixels(editor, cache, triangle, editable, referenceUv, {
      record,
      hit,
      cacheVisibilityTrianglePixels: options.cacheVisibilityTrianglePixels
    });
    if (!mapped) {
      continue;
    }
    const screenTriangle = screenSegments.length
      ? screenTriangleFromGeometryTriangle(editor, record, hit, triangle)
      : null;
    const nearTextureBrush = visibilityTriangleNearSegments(mapped, segments, radius);
    const nearScreenBrush = Boolean(
      screenTriangle
      && screenRadius > 0
      && visibilityTriangleNearSegments(screenTriangle, screenSegments, screenHaloRadius)
    );
    const nearBrush = triangleIndex === startIndex || nearTextureBrush || nearScreenBrush;
    if (!nearBrush) {
      continue;
    }
    if (nearScreenBrush && screenProjectedSegments) {
      appendScreenProjectedTextureSegments(
        screenProjectedSegments,
        screenTriangle,
        mapped,
        screenSegments,
        screenRadius,
        editable?.canvas || null,
        {
          maxTextureRadiusPixels: options.maxTextureRadiusPixels ?? options.radiusPixels,
          maxScreenProjectedSegments: options.maxScreenProjectedSegments
        }
      );
    }
    output.push(visibilityTriangleWithScreenTriangle(mapped, screenTriangle));
    enqueueNeighbors(triangle);
  }
  const result = output.length ? output : [directTriangle];
  boundedCacheSet(
    listCache,
    listCacheKey,
    result.map(compactVisibilityTriangle).filter(Boolean),
    TEXTURE_AIRBRUSH_WEBGPU_TRIANGLE_LIST_CACHE_LIMIT
  );
  return result;
}

function screenPointFromVertex(editor = null, record = null, hit = null, vertexIndex = -1) {
  const Vector3Ctor = globalThis.THREE?.Vector3 || Vector3;
  const object = record?.object || hit?.object || null;
  const geometry = record?.geometry || object?.geometry || null;
  const position = geometry?.attributes?.position || null;
  const camera = editor?.camera || null;
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  if (!Vector3Ctor || !object || !position || !camera || !rect?.width || !rect?.height || !Number.isInteger(vertexIndex) || vertexIndex < 0) {
    return null;
  }
  const frameKey = webGpuStrokeFrameCacheKey(editor);
  const cacheKey = [
    frameKey,
    stableCacheId(record, "record"),
    stableCacheId(object, "object"),
    stableCacheId(geometry, "geometry"),
    Number(position.version) || 0,
    vertexIndex
  ].join(":");
  const screenPointCache = frameScopedEditorCache(
    editor,
    "textureAirbrushWebGpuVertexScreenPointCache",
    frameKey,
    TEXTURE_AIRBRUSH_WEBGPU_VERTEX_SCREEN_CACHE_LIMIT
  );
  const cached = screenPointCache?.get(cacheKey);
  if (cached) {
    return { ...cached };
  }
  const point = new Vector3Ctor();
  if (typeof object.getVertexPosition === "function") {
    object.getVertexPosition(vertexIndex, point);
  } else if (typeof object.applyBoneTransform === "function") {
    if (typeof point.fromBufferAttribute === "function") {
      point.fromBufferAttribute(position, vertexIndex);
    }
    object.applyBoneTransform(vertexIndex, point);
  } else if (typeof object.boneTransform === "function") {
    object.boneTransform(vertexIndex, point);
  } else if (typeof point.fromBufferAttribute === "function") {
    point.fromBufferAttribute(position, vertexIndex);
  } else {
    point.x = typeof position.getX === "function" ? position.getX(vertexIndex) : position.array?.[vertexIndex * 3];
    point.y = typeof position.getY === "function" ? position.getY(vertexIndex) : position.array?.[vertexIndex * 3 + 1];
    point.z = typeof position.getZ === "function" ? position.getZ(vertexIndex) : position.array?.[vertexIndex * 3 + 2];
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    return null;
  }
  object.localToWorld?.(point);
  let viewZ = null;
  let viewX = null;
  let viewY = null;
  let clipW = null;
  if (typeof point.applyMatrix4 === "function" && camera.matrixWorldInverse && camera.projectionMatrix) {
    point.applyMatrix4(camera.matrixWorldInverse);
    viewX = point.x;
    viewY = point.y;
    viewZ = point.z;
    clipW = camera.isPerspectiveCamera ? Math.abs(viewZ) : 1;
    point.applyMatrix4(camera.projectionMatrix);
  } else if (typeof point.project === "function") {
    try {
      point.project(camera);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }
  const projected = {
    x: (point.x * 0.5 + 0.5) * rect.width,
    y: (-point.y * 0.5 + 0.5) * rect.height,
    ...(Number.isFinite(viewX) ? { viewX } : {}),
    ...(Number.isFinite(viewY) ? { viewY } : {}),
    ...(Number.isFinite(viewZ) ? { viewZ } : {}),
    ...(Number.isFinite(clipW) ? { clipW } : {})
  };
  boundedCacheSet(
    screenPointCache,
    cacheKey,
    projected,
    TEXTURE_AIRBRUSH_WEBGPU_VERTEX_SCREEN_CACHE_LIMIT
  );
  return projected;
}

function medianNumber(values = []) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }
  return sorted[Math.floor(sorted.length / 2)];
}

function textureAirbrushLocalTextureRadiusPixels(editor = null, editable = null, options = {}) {
  const hit = options.hit || null;
  const record = options.record || null;
  const face = hit?.face || null;
  const geometry = record?.geometry || hit?.object?.geometry || null;
  const uvAttribute = geometry?.attributes?.uv || null;
  if (!face || !uvAttribute) {
    return null;
  }
  const indexes = [face.a, face.b, face.c].map((index) => Math.floor(Number(index)));
  if (!indexes.every((index) => Number.isInteger(index) && index >= 0)) {
    return null;
  }
  const referenceUv = options.referenceUv || options.target?.originUv || options.target?.uvCenter || hit?.uv || null;
  const screenRadius = Math.max(0.75, finiteNumber(options.radiusPixels, finiteNumber(editor?.textureBrushRadiusScreenPixels?.(), 24)));
  const frameKey = webGpuStrokeFrameCacheKey(editor);
  const cacheKey = frameKey
    ? [
        stableCacheId(record, "record"),
        stableCacheId(hit?.object, "object"),
        stableCacheId(editable?.texture, "texture"),
        stableCacheId(editable?.layer, "layer"),
        editable?.canvas?.width || 0,
        editable?.canvas?.height || 0,
        Number(uvAttribute.version) || 0,
        Number(geometry?.attributes?.position?.version) || 0,
        hit.faceIndex ?? "face",
        indexes.join(":"),
        roundedCacheNumber(referenceUv?.x),
        roundedCacheNumber(referenceUv?.y),
        Math.round(screenRadius * 100)
      ].join("|")
    : "";
  const radiusCache = cacheKey
    ? frameScopedEditorCache(
      editor,
      "textureAirbrushWebGpuLocalTextureRadiusCache",
      frameKey,
      TEXTURE_AIRBRUSH_WEBGPU_LOCAL_RADIUS_CACHE_LIMIT
    )
    : null;
  const cachedRadius = radiusCache?.get(cacheKey);
  if (Number.isFinite(cachedRadius) && cachedRadius > 0) {
    return cachedRadius;
  }
  const texturePoints = indexes
    .map((index) => uvAttributePoint(uvAttribute, index))
    .map((uv) => texturePixelFromUvRelative(editor, uv, editable, referenceUv));
  const indexedScreenPoints = Array.isArray(hit?.screen) && hit.screen.length >= 3
    ? hit.screen.slice(0, 3).map((point) => (
        Number.isFinite(point?.x) && Number.isFinite(point?.y)
          ? { x: point.x, y: point.y }
          : null
      ))
    : null;
  const screenPoints = indexedScreenPoints?.every(Boolean)
    ? indexedScreenPoints
    : indexes.map((index) => screenPointFromVertex(editor, record, hit, index));
  if (
    !texturePoints.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      || !screenPoints.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
  ) {
    return null;
  }
  const edgeIndexes = [[0, 1], [1, 2], [2, 0]];
  const ratios = edgeIndexes.map(([startIndex, endIndex]) => {
    const textureLength = pointDistance(texturePoints[startIndex], texturePoints[endIndex]);
    const screenLength = pointDistance(screenPoints[startIndex], screenPoints[endIndex]);
    return screenLength > 0.5 && Number.isFinite(textureLength)
      ? textureLength / screenLength
      : null;
  }).filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  const ratio = medianNumber(ratios);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }
  const radius = Math.max(0.75, screenRadius * ratio * 1.08);
  boundedCacheSet(
    radiusCache,
    cacheKey,
    radius,
    TEXTURE_AIRBRUSH_WEBGPU_LOCAL_RADIUS_CACHE_LIMIT
  );
  return radius;
}

function hitMatchesPaintTarget(editor = null, hitResult = null, record = null, material = null, materialIndex = 0, editable = null) {
  const hit = hitResult?.hit || null;
  if (!hitResult?.record || hitResult.record !== record || !hit?.uv) {
    return false;
  }
  const hitMaterial = editor?.clonePaintMaterialForHit?.(hitResult.record, hit);
  if (hitMaterial === material && materialIndexForHit(hit, materialIndex) === materialIndex) {
    return true;
  }
  return materialPaintTargetMatches(editor, hitMaterial, editable, material);
}

export function textureAirbrushWebGpuTextureRadiusPixels(editor = null, editable = null, options = {}) {
  const canvas = editable?.canvas || null;
  const maxTextureSize = Math.max(1, canvas?.width || 1, canvas?.height || 1);
  const radiusScale = Number.isFinite(Number(options.textureRadiusScale))
    ? Number(options.textureRadiusScale)
    : options.target?.vertices?.size
      ? 1.55
      : 0.72;
  const baseTextureRadius = Math.max(
    0.75,
    finiteNumber(editor?.textureBrushRadiusValue?.(), 0.035) * maxTextureSize * radiusScale
  );
  if (Number.isFinite(Number(options.textureRadiusPixels))) {
    return Math.max(0.75, Number(options.textureRadiusPixels));
  }
  const localRadius = textureAirbrushLocalTextureRadiusPixels(editor, editable, options);
  if (Number.isFinite(localRadius) && localRadius > 0) {
    return Math.max(0.75, Math.min(baseTextureRadius, localRadius));
  }
  if (!Number.isFinite(Number(options.radiusPixels))) {
    return baseTextureRadius;
  }
  const baseScreenRadius = Math.max(0.75, finiteNumber(editor?.textureBrushRadiusScreenPixels?.(), 24));
  return Math.max(0.75, baseTextureRadius * Math.max(0.02, Number(options.radiusPixels) / baseScreenRadius));
}

export function textureAirbrushWebGpuStrokeEstimate(candidate = null) {
  const paintRegions = Array.isArray(candidate?.paintRegions)
    ? candidate.paintRegions
    : [];
  const regionArea = paintRegions.reduce((total, region) => (
    total
    + Math.max(0, Math.ceil(Number(region?.width) || 0))
      * Math.max(0, Math.ceil(Number(region?.height) || 0))
  ), 0);
  if (regionArea > 0) {
    return Math.max(1, Math.round(regionArea));
  }
  const radius = Math.max(0.75, finiteNumber(candidate?.radiusPixels, 0.75));
  const segments = Array.isArray(candidate?.strokeSegments) ? candidate.strokeSegments : [];
  const length = segments.reduce((total, segment) => {
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    if (!start || !end) {
      return total;
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return total + Math.sqrt(dx * dx + dy * dy);
  }, 0);
  return Math.max(1, Math.round(Math.PI * radius * radius + length * radius * 2));
}

export function textureAirbrushWebGpuStrokeCandidateFromHit(editor = null, record = null, hit = null, event = null, options = {}) {
  const timingNow = () => (
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now()
  );
  const timingStartMs = timingNow();
  const hitUv = hit?.uv || null;
  if (!record || !hitUv) {
    options.debugReject?.("missing-record-or-uv", hitDebug(record, hit));
    return null;
  }
  const hasResolvedMaterial = Object.prototype.hasOwnProperty.call(options, "resolvedMaterial");
  const material = hasResolvedMaterial
    ? options.resolvedMaterial
    : editor?.clonePaintMaterialForHit?.(record, hit);
  const hasResolvedEditable = Object.prototype.hasOwnProperty.call(options, "resolvedEditable");
  const resolvedEditable = hasResolvedEditable && options.resolvedEditable?.canvas && options.resolvedEditable?.context
    ? options.resolvedEditable
    : null;
  const baseEditable = resolvedEditable || editor?.editableClonePaintTexture?.(material);
  let editable = baseEditable;
  const layerModeRequested = options.layerMode === true
    || editor?.texturePaintLayerModeActive?.() === true;
  if (!resolvedEditable && layerModeRequested && typeof editor?.texturePaintEditableLayerTarget === "function") {
    const layerEditable = editor.texturePaintEditableLayerTarget(material, baseEditable);
    if (layerEditable?.layerMode === true && layerEditable?.canvas && layerEditable?.context) {
      editable = layerEditable;
    }
  }
  if (!material || !editable?.canvas || !editable?.texture) {
    options.debugReject?.("missing-material-or-editable", materialEditableDebug(material, editable));
    return null;
  }

  const target = options.target || (hit?.cloneRegionHit ? editor?.clonePaintTargets?.get?.(record) : null);
  const resolvedMaterialIndex = Number(options.resolvedMaterialIndex);
  const materialIndex = Number.isFinite(resolvedMaterialIndex)
    ? resolvedMaterialIndex
    : hit?.face?.materialIndex
      ?? target?.originMaterialIndex
      ?? target?.materialIndex
      ?? 0;
  const neighborPaintSeed = options.neighborPaintSeed || null;
  const neighborPaintKey = neighborSeedCacheKey(editor, neighborPaintSeed);
  if (neighborSeedAllowsStrokeHit(
    editor,
    neighborPaintSeed,
    record,
    hit,
    material,
    materialIndex,
    options
  ) === false) {
    options.debugReject?.("neighbor-rejected", {
      ...hitDebug(record, hit),
      materialName: material?.name || "",
      materialIndex
    });
    return null;
  }
  const strokeReferenceUv = options.referenceUv || target?.originUv || target?.uvCenter || hitUv;
  const pixelFromUv = (uv = null, referenceUv = strokeReferenceUv) => {
    if (!uv) {
      return null;
    }
    if (target?.vertices?.size && typeof editor?.textureAirbrushRegionPixelFromUv === "function") {
      return editor.textureAirbrushRegionPixelFromUv(
        uv,
        editable.canvas,
        editable.texture,
        referenceUv
      ) || texturePixelFromUvRelative(editor, uv, editable, referenceUv);
    }
    // Author live strokes in one unwrapped UV texture frame. The current view
    // decides which sampled surface is paintable; it must not wrap each sample
    // independently and turn a continuous brush curve into texture jumps.
    return texturePixelFromUvRelative(editor, uv, editable, referenceUv);
  };
  const center = pixelFromUv(hitUv, strokeReferenceUv);
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    options.debugReject?.("missing-texture-center", {
      ...hitDebug(record, hit),
      editable: materialEditableDebug(material, editable)
    });
    return null;
  }

  const radiusPixels = textureAirbrushWebGpuTextureRadiusPixels(editor, editable, {
    ...options,
    record,
    hit,
    event,
    target
  });
  let start = center;
  const hitSampleCache = options.hitSampleCache instanceof Map ? options.hitSampleCache : null;
  const cachedStrokeSamplesOnly = options.cachedStrokeSamplesOnly === true;
  const indexedStrokeSamplesOnly = options.indexedStrokeSamplesOnly === true;
  const currentClientPoint = Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
    ? { clientX: event.clientX, clientY: event.clientY }
    : null;
  const screenStrokeSegments = Array.isArray(options.strokeSegments) ? options.strokeSegments : [];
  const screenRadiusPixels = Math.max(
    0.5,
    Number(options.radiusPixels) || Number(editor?.textureBrushRadiusScreenPixels?.()) || 1
  );
  const screenRect = editor?.canvas?.getBoundingClientRect?.() || null;
  const viewRadiusForSample = (view = null, radius = screenRadiusPixels) => (
    view && Number.isFinite(view.z)
      ? viewRadiusForScreenRadius(editor?.camera, screenRect, view.z, radius)
      : null
  );
  const rawScreenPaintStrokeSegments = screenStrokeSegmentsForVisibility(
    editor,
    screenStrokeSegments,
    currentClientPoint
  ).map((segment) => ({
    ...segment,
    radiusPixels: Math.max(0.5, Number(segment.radiusPixels) || screenRadiusPixels)
  }));
  const screenPaintStrokeSegments = (
    options.liveProjectedPaint === true
    || options.screenStrokePaint === true
  )
    ? connectScreenStrokeSegmentGaps(rawScreenPaintStrokeSegments, screenRadiusPixels)
    : rawScreenPaintStrokeSegments;
  const skipProjectedSeamStrokeSegmentsForTslSurface = options.collectProjectedSeamStrokeSegments !== true
    && options.useTslSurfaceAirbrush !== false
    && options.liveProjectedPaint === true
    && editor?.renderer?.isWebGPURenderer === true
    && editor?.renderer?.backend?.isWebGPUBackend === true;
  const useTslSourceMeshVisibilitySeed = skipProjectedSeamStrokeSegmentsForTslSurface;
  const visibilityTriangleLimitForSurfaceSeed = useTslSourceMeshVisibilitySeed
    ? Math.max(32, Math.min(
        512,
        Math.floor(Number(options.maxVisibilityTriangles) || 128)
      ))
    : options.maxVisibilityTriangles;
  const screenBrushVisibilityTrianglesForSurfaceSeed = options.screenBrushVisibilityTriangles;
  const collectProjectedSeamStrokeSegments = !skipProjectedSeamStrokeSegmentsForTslSurface
    && (
      options.collectProjectedSeamStrokeSegments === true
      || (
        options.collectProjectedSeamStrokeSegments !== false
        && (
          options.screenStrokePaint !== true
          || options.liveProjectedPaint === true
        )
      )
      || (options.requireVisibilityTriangles === true && options.neighborPaintSeed?.enabled === true)
      || (options.requireVisibilityTriangles === true && options.largeLiveNeighborPaint === true)
    );
	  const seamProjectedStrokeSegments = [];
	  const visibilityTriangles = [];
	  const visibilityTriangleKeys = new Set();
	  const projectedDebugCounts = {};
	  const rememberVisibilityTriangle = (triangle = null) => {
    const compact = compactVisibilityTriangle(triangle);
    if (!compact) {
      return null;
    }
    const screenStrokeDistance = Number(triangle?.screenStrokeDistance);
    const retained = Number.isFinite(screenStrokeDistance)
      ? { ...compact, screenStrokeDistance }
      : compact;
    const key = compactTriangleKey(retained);
    if (!visibilityTriangleKeys.has(key)) {
      visibilityTriangleKeys.add(key);
      visibilityTriangles.push(retained);
    }
    return retained;
  };
  const visibilityTriangleCacheOptions = {
    cacheVisibilityTriangleLists: options.cacheVisibilityTriangleLists,
    cacheVisibilityTrianglePixels: options.cacheVisibilityTrianglePixels,
    visibilityTriangleCacheGridPixels: options.visibilityTriangleCacheGridPixels
  };
  const rememberVisibilityTriangles = (triangles = []) => {
    let first = null;
    for (const triangle of Array.isArray(triangles) ? triangles : [triangles]) {
      const compact = rememberVisibilityTriangle(triangle);
      first ||= compact;
    }
    return first;
  };
  const projectedTextureRadiusLimit = options.liveProjectedPaint === true
    ? Math.max(8, Math.min(radiusPixels, screenRadiusPixels * 4))
    : options.maxTextureRadiusPixels;
  const liveTextureRadiusPixels = options.liveProjectedPaint === true
    ? projectedTextureRadiusLimit
    : radiusPixels;
	  const preferTslFullSurfaceUvRaster = options.liveProjectedPaint === true
	    && options.fullProjectedSurfaceRenderTriangles === true
	    && options.useTslSurfaceAirbrush !== false
	    && editor?.renderer?.isWebGPURenderer === true
	    && editor?.renderer?.backend?.isWebGPUBackend === true;
	  const buildSurfaceVisibilityTriangles = !preferTslFullSurfaceUvRaster
	    || options.projectedPrimary === true
	    || options.collectProjectedSeamStrokeSegments === true
	    || (options.requireVisibilityTriangles === true && options.neighborPaintSeed?.enabled === true)
	    || (options.requireVisibilityTriangles === true && options.largeLiveNeighborPaint === true);
	  const currentTriangle = buildSurfaceVisibilityTriangles
	    ? rememberVisibilityTriangles(
	        visibilityTrianglesFromHit(editor, record, hit, editable, hitUv, {
	          center,
	          radiusPixels,
          screenRadiusPixels,
          clientCenter: currentClientPoint,
          screenStrokeSegments,
	          ...(collectProjectedSeamStrokeSegments ? { screenBrushTextureSegments: seamProjectedStrokeSegments } : {}),
	          materialIndex,
          material,
          maxVisibilityTriangles: visibilityTriangleLimitForSurfaceSeed,
          screenBrushVisibilityTriangles: screenBrushVisibilityTrianglesForSurfaceSeed,
          fullBrushVisibilityProbes: useTslSourceMeshVisibilitySeed ? false : options.fullBrushVisibilityProbes,
          denseVisibilityFootprintProbes: useTslSourceMeshVisibilitySeed ? false : options.denseVisibilityFootprintProbes,
          liveProjectedPaint: options.liveProjectedPaint,
          screenStrokePaint: options.screenStrokePaint,
          screenSurfaceContinuityFilter: options.screenSurfaceContinuityFilter,
          surfaceContinuitySamplesIgnoreMaterial: options.surfaceContinuitySamplesIgnoreMaterial,
          surfaceContinuityRadiusScale: options.surfaceContinuityRadiusScale,
          surfaceContinuityDepthWindow: options.surfaceContinuityDepthWindow,
          surfaceContinuityComponentDepthWindow: options.surfaceContinuityComponentDepthWindow,
          surfaceContinuityComponentNormalDot: options.surfaceContinuityComponentNormalDot,
          surfaceContinuityKeepDisconnected: options.surfaceContinuityKeepDisconnected,
          maxSurfaceContinuitySamples: options.maxSurfaceContinuitySamples,
          visibleEdgeMode: options.visibleEdgeMode,
	          maxTextureRadiusPixels: projectedTextureRadiusLimit,
	          maxScreenProjectedSegments: options.maxScreenProjectedSegments,
	          scatter: options.scatter,
	          projectedDebugCounts,
	          neighborPaintSeed,
	          ...visibilityTriangleCacheOptions
	        })
	      )
	    : null;
  const visibilityTimingMs = timingNow();
  const reusePathVisibilityTriangles = options.reuseCandidateVisibilityTrianglesForSegments === true
    && visibilityTriangles.length > 0
    && Array.isArray(screenPaintStrokeSegments)
    && screenPaintStrokeSegments.length > 0;
  if (options.requireVisibilityTriangles === true && !visibilityTriangles.length && !preferTslFullSurfaceUvRaster) {
    options.debugReject?.("missing-visibility-triangle", {
      ...hitDebug(record, hit),
      materialName: material?.name || "",
      materialIndex
    });
    return null;
  }
  const currentSampleKey = hitSampleCacheKey(currentClientPoint, record, material, materialIndex, neighborPaintKey);
  const currentView = viewPointFromHit(editor, hit, currentClientPoint);
  const currentNormal = viewNormalFromHit(editor, hit);
  const currentComponent = textureAirbrushComponentIdForHit(editor, record, hit);
  const currentSample = currentClientPoint
    ? {
        client: currentClientPoint,
        pixel: {
          x: center.x,
          y: center.y
        },
        ...(currentView ? { view: currentView } : {}),
        ...(currentNormal ? { normal: currentNormal } : {}),
        ...(currentComponent >= 0 ? { component: currentComponent } : {}),
        ...(currentTriangle ? { triangle: currentTriangle } : {})
      }
    : null;
  rememberHitSample(hitSampleCache, currentSampleKey, currentSample);
  const hitResultForClientPoint = (point = null) => {
    const cacheKey = hitResultCacheKey(point);
    const cachedHit = cachedHitResult(hitSampleCache, cacheKey);
    if (cachedHit !== undefined) {
      return cachedHit;
    }
    const pointEvent = clientEventFromPoint(point, event);
    if (!pointEvent || typeof editor?.texturePaintHitForEvent !== "function") {
      return rememberHitResult(hitSampleCache, cacheKey, null);
    }
    const indexedHit = screenIndexedHitResultForClientPoint(editor, pointEvent, event, options);
    if (indexedHit !== undefined) {
      return rememberHitResult(hitSampleCache, cacheKey, indexedHit);
    }
    if (indexedStrokeSamplesOnly && options.raycastFallbackOnScreenMiss !== true) {
      return rememberHitResult(hitSampleCache, cacheKey, null);
    }
    return rememberHitResult(hitSampleCache, cacheKey, editor.texturePaintHitForEvent(pointEvent, "airbrush"));
  };
  let strokeStartSample = null;
  const startEvent = clientEventFromPoint(options.strokeStart, event);
  const startSampleKey = hitSampleCacheKey(startEvent, record, material, materialIndex, neighborPaintKey);
  const cachedStartSample = cachedHitSample(hitSampleCache, startSampleKey);
  if (cachedStartSample) {
    start = cachedStartSample.pixel;
    strokeStartSample = cachedStartSample;
  } else if (!cachedStrokeSamplesOnly && startEvent && typeof editor?.texturePaintHitForEvent === "function") {
    const startHit = hitResultForClientPoint(startEvent);
    const startMaterial = startHit?.record
      ? editor.clonePaintMaterialForHit?.(startHit.record, startHit.hit)
      : null;
    const startMaterialIndex = startHit?.hit?.face?.materialIndex ?? materialIndex;
    if (
	      hitMatchesPaintTarget(editor, startHit, record, material, materialIndex, editable)
	      && startHit?.hit?.uv
      && neighborSeedAllowsStrokeHit(
        editor,
        neighborPaintSeed,
        startHit.record,
        startHit.hit,
        startMaterial,
        startMaterialIndex,
        options
      )
    ) {
      const startPixel = pixelFromUv(startHit.hit.uv, strokeReferenceUv);
      if (startPixel && Number.isFinite(startPixel.x) && Number.isFinite(startPixel.y)) {
        start = startPixel;
        // Screen strokes authorize visibility from the whole camera-facing path
        // once above. Rewalking adjacent triangles for every sampled point makes
        // the first live flush lag without changing the paint permission rule.
	        const startTriangle = !buildSurfaceVisibilityTriangles
	          ? null
	          : reusePathVisibilityTriangles
	          ? currentTriangle
	          : rememberVisibilityTriangles(
              visibilityTrianglesFromHit(editor, record, startHit.hit, editable, startHit.hit.uv, {
                center: startPixel,
                radiusPixels,
                screenRadiusPixels,
                clientCenter: startEvent,
                screenStrokeSegments,
	                ...(collectProjectedSeamStrokeSegments ? { screenBrushTextureSegments: seamProjectedStrokeSegments } : {}),
	                materialIndex,
	                material,
                maxVisibilityTriangles: visibilityTriangleLimitForSurfaceSeed,
                screenBrushVisibilityTriangles: screenBrushVisibilityTrianglesForSurfaceSeed,
                fullBrushVisibilityProbes: useTslSourceMeshVisibilitySeed ? false : options.fullBrushVisibilityProbes,
                denseVisibilityFootprintProbes: useTslSourceMeshVisibilitySeed ? false : options.denseVisibilityFootprintProbes,
                liveProjectedPaint: options.liveProjectedPaint,
                screenStrokePaint: options.screenStrokePaint,
                screenSurfaceContinuityFilter: options.screenSurfaceContinuityFilter,
                surfaceContinuitySamplesIgnoreMaterial: options.surfaceContinuitySamplesIgnoreMaterial,
                surfaceContinuityRadiusScale: options.surfaceContinuityRadiusScale,
                surfaceContinuityDepthWindow: options.surfaceContinuityDepthWindow,
                surfaceContinuityComponentDepthWindow: options.surfaceContinuityComponentDepthWindow,
                surfaceContinuityComponentNormalDot: options.surfaceContinuityComponentNormalDot,
                surfaceContinuityKeepDisconnected: options.surfaceContinuityKeepDisconnected,
                maxSurfaceContinuitySamples: options.maxSurfaceContinuitySamples,
                visibleEdgeMode: options.visibleEdgeMode,
	                maxTextureRadiusPixels: projectedTextureRadiusLimit,
	                maxScreenProjectedSegments: options.maxScreenProjectedSegments,
	                scatter: options.scatter,
	                projectedDebugCounts,
	                neighborPaintSeed,
	                ...visibilityTriangleCacheOptions
	              })
            );
        const startView = viewPointFromHit(editor, startHit.hit, startEvent);
        const startNormal = viewNormalFromHit(editor, startHit.hit);
        const startComponent = textureAirbrushComponentIdForHit(editor, startHit.record || record, startHit.hit);
        strokeStartSample = {
          client: {
            clientX: startEvent.clientX,
            clientY: startEvent.clientY
          },
          pixel: {
            x: startPixel.x,
            y: startPixel.y
          },
          ...(startView ? { view: startView } : {}),
          ...(startNormal ? { normal: startNormal } : {}),
          ...(startComponent >= 0 ? { component: startComponent } : {}),
          ...(startTriangle ? { triangle: startTriangle } : {})
        };
        rememberHitSample(hitSampleCache, startSampleKey, strokeStartSample);
      }
    }
  }

  const hitPixelForClientPoint = (point = null) => {
    if (currentSample && clientPointsMatch(point, currentSample.client)) {
      return currentSample;
    }
    if (strokeStartSample && clientPointsMatch(point, strokeStartSample.client)) {
      return strokeStartSample;
    }
    const cacheKey = hitSampleCacheKey(point, record, material, materialIndex, neighborPaintKey);
    const cachedSample = cachedHitSample(hitSampleCache, cacheKey);
    if (cachedSample) {
      rememberVisibilityTriangle(cachedSample.triangle);
      return cachedSample;
    }
    if (cachedStrokeSamplesOnly) {
      return null;
    }
    const hitResult = hitResultForClientPoint(point);
	    if (!hitMatchesPaintTarget(editor, hitResult, record, material, materialIndex, editable)) {
	      return null;
	    }
    if (!neighborSeedAllowsStrokeHit(
      editor,
      neighborPaintSeed,
      hitResult.record,
      hitResult.hit,
      material,
      materialIndex,
      options
    )) {
      return null;
    }
    const pixel = pixelFromUv(hitResult.hit.uv);
    if (!Number.isFinite(pixel?.x) || !Number.isFinite(pixel?.y)) {
      return null;
    }
    // In the TSL source-mesh route, per-sample hit lookup traces the surface
    // curve; the shader owns the smooth camera-facing brush field.
	    const triangle = !buildSurfaceVisibilityTriangles
	      ? null
	      : reusePathVisibilityTriangles
	      ? currentTriangle
	      : rememberVisibilityTriangles(
          visibilityTrianglesFromHit(editor, record, hitResult.hit, editable, hitResult.hit.uv, {
            center: pixel,
            radiusPixels,
            screenRadiusPixels,
            clientCenter: point,
            screenStrokeSegments,
	            ...(collectProjectedSeamStrokeSegments ? { screenBrushTextureSegments: seamProjectedStrokeSegments } : {}),
	            materialIndex,
	            material,
            maxVisibilityTriangles: visibilityTriangleLimitForSurfaceSeed,
            screenBrushVisibilityTriangles: screenBrushVisibilityTrianglesForSurfaceSeed,
            fullBrushVisibilityProbes: useTslSourceMeshVisibilitySeed ? false : options.fullBrushVisibilityProbes,
            denseVisibilityFootprintProbes: useTslSourceMeshVisibilitySeed ? false : options.denseVisibilityFootprintProbes,
            liveProjectedPaint: options.liveProjectedPaint,
            screenStrokePaint: options.screenStrokePaint,
            screenSurfaceContinuityFilter: options.screenSurfaceContinuityFilter,
            surfaceContinuitySamplesIgnoreMaterial: options.surfaceContinuitySamplesIgnoreMaterial,
            surfaceContinuityRadiusScale: options.surfaceContinuityRadiusScale,
            surfaceContinuityDepthWindow: options.surfaceContinuityDepthWindow,
            surfaceContinuityComponentDepthWindow: options.surfaceContinuityComponentDepthWindow,
            surfaceContinuityComponentNormalDot: options.surfaceContinuityComponentNormalDot,
            surfaceContinuityKeepDisconnected: options.surfaceContinuityKeepDisconnected,
            maxSurfaceContinuitySamples: options.maxSurfaceContinuitySamples,
            visibleEdgeMode: options.visibleEdgeMode,
	            maxTextureRadiusPixels: projectedTextureRadiusLimit,
	            maxScreenProjectedSegments: options.maxScreenProjectedSegments,
	            scatter: options.scatter,
	            projectedDebugCounts,
	            neighborPaintSeed,
	            ...visibilityTriangleCacheOptions
	          })
        );
    const view = viewPointFromHit(editor, hitResult.hit, point);
    const normal = viewNormalFromHit(editor, hitResult.hit);
    const component = textureAirbrushComponentIdForHit(editor, hitResult.record || record, hitResult.hit);
    const sample = {
      client: {
        clientX: point.clientX,
        clientY: point.clientY
      },
      pixel: {
        x: pixel.x,
        y: pixel.y
      },
      ...(view ? { view } : {}),
      ...(normal ? { normal } : {}),
      ...(component >= 0 ? { component } : {}),
      ...(triangle ? { triangle } : {})
    };
    rememberHitSample(hitSampleCache, cacheKey, sample);
    return sample;
  };

  let disconnectedUvSampleCount = 0;
  const surfaceProjectedStrokeSegments = [];
  const pushSurfaceProjectedSegment = (startSample = null, endSample = null, radius = screenRadiusPixels) => {
    if (
      surfaceProjectedStrokeSegments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
      || !startSample?.view
      || !endSample?.view
    ) {
      return false;
    }
    const screenStart = screenPointFromClientPoint(editor, startSample.client);
    const screenEnd = screenPointFromClientPoint(editor, endSample.client);
    if (!screenStart || !screenEnd) {
      return false;
    }
    const startRadius = viewRadiusForSample(startSample.view, radius);
    const endRadius = viewRadiusForSample(endSample.view, radius);
    const viewRadius = Math.max(
      0.0001,
      Number.isFinite(startRadius) ? startRadius : 0,
      Number.isFinite(endRadius) ? endRadius : 0
    );
    surfaceProjectedStrokeSegments.push({
      start: screenStart,
      end: screenEnd,
      radiusPixels: Math.max(0.75, Number(radius) || screenRadiusPixels),
      viewStart: startSample.view,
      viewEnd: endSample.view,
      viewRadiusPixels: viewRadius,
      ...(Number.isFinite(Number(startSample.component)) && Number(startSample.component) >= 0
        ? { componentStart: Math.floor(Number(startSample.component)) }
        : {}),
      ...(Number.isFinite(Number(endSample.component)) && Number(endSample.component) >= 0
        ? { componentEnd: Math.floor(Number(endSample.component)) }
        : {}),
      ...(startSample.normal ? { viewNormalStart: startSample.normal } : {}),
      ...(endSample.normal ? { viewNormalEnd: endSample.normal } : {})
    });
    return true;
  };
  const appendSampledClientSegmentPieces = (segments = [], segment = null, radiusPixels = 1) => {
    if (segments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
      return false;
    }
    const startPoint = segment?.start;
    const endPoint = segment?.end;
    const screenDistance = clientPointDistance(startPoint, endPoint);
    const screenRadius = Math.max(1, Number(segment?.radiusPixels) || Number(options.radiusPixels) || editor?.textureBrushRadiusScreenPixels?.() || 10);
    if (!Number.isFinite(screenDistance) || screenDistance <= 0.0001) {
      const sample = hitPixelForClientPoint(endPoint);
      const screenPoint = screenPointFromClientPoint(editor, endPoint);
      if (sample) {
        pushSurfaceProjectedSegment(sample, sample, screenRadius);
      }
      return sample ? pushTextureSegment(segments, sample.pixel, sample.pixel, {
        radiusPixels,
        screenStart: screenPoint,
        screenEnd: screenPoint,
        screenRadiusPixels: screenRadius,
        ...(sample.view ? { viewStart: sample.view, viewEnd: sample.view, viewRadiusPixels: viewRadiusForSample(sample.view, screenRadius) } : {}),
        ...(Number.isFinite(Number(sample.component)) && Number(sample.component) >= 0
          ? { componentStart: Math.floor(Number(sample.component)), componentEnd: Math.floor(Number(sample.component)) }
          : {}),
        ...(sample.normal ? { viewNormalStart: sample.normal, viewNormalEnd: sample.normal } : {})
      }) : false;
    }
    const spacingPercent = Math.max(0.1, Math.min(200, Number(segment?.spacing ?? options.spacing ?? 1)));
    const lowSpacingBlend = spacingPercent <= 10
      ? Math.max(0, Math.min(1, (10 - spacingPercent) / 9.9))
      : 0;
    const defaultBrushShortStroke = screenRadius <= 12 && screenDistance <= 64;
    const lowSpacingStepPixels = defaultBrushShortStroke
      ? Math.max(3, Math.min(4, screenRadius * 0.5))
      : Math.max(8, Math.min(12, screenRadius * (0.35 - lowSpacingBlend * 0.2)));
    const stepPixels = lowSpacingBlend > 0
      ? lowSpacingStepPixels
      : Math.max(10, Math.min(32, screenRadius * 1.1));
    const steps = Math.max(1, Math.min(
      TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
      Math.ceil(screenDistance / stepPixels)
    ));
    let changed = false;
    let previousSample = null;
    for (let index = 0; index <= steps && segments.length < TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS; index += 1) {
      const point = clientPointAtRatio(startPoint, endPoint, index / steps);
      const sample = hitPixelForClientPoint(point);
      if (!sample) {
        previousSample = null;
        continue;
      }
      if (!previousSample) {
        previousSample = sample;
        continue;
      }
      const textureDistance = pointDistance(previousSample.pixel, sample.pixel);
      if (Number.isFinite(textureDistance) && textureDistance <= 0.0001) {
        previousSample = sample;
        continue;
      }
      if (
        textureSegmentCanConnect(
          previousSample.pixel,
          sample.pixel,
          previousSample.client,
          sample.client,
          radiusPixels,
          editable.canvas
        )
      ) {
        pushSurfaceProjectedSegment(previousSample, sample, screenRadius);
        changed = pushTextureSegment(segments, previousSample.pixel, sample.pixel, {
          radiusPixels,
          screenStart: screenPointFromClientPoint(editor, previousSample.client),
          screenEnd: screenPointFromClientPoint(editor, sample.client),
          screenRadiusPixels: screenRadius,
          ...(previousSample.view && sample.view
            ? {
                viewStart: previousSample.view,
                viewEnd: sample.view,
                viewRadiusPixels: Math.max(
                  viewRadiusForSample(previousSample.view, screenRadius) || 0,
                  viewRadiusForSample(sample.view, screenRadius) || 0
                )
              }
            : {}),
          ...(Number.isFinite(Number(previousSample.component)) && Number(previousSample.component) >= 0
            ? { componentStart: Math.floor(Number(previousSample.component)) }
            : {}),
          ...(Number.isFinite(Number(sample.component)) && Number(sample.component) >= 0
            ? { componentEnd: Math.floor(Number(sample.component)) }
            : {}),
          ...(previousSample.normal ? { viewNormalStart: previousSample.normal } : {}),
          ...(sample.normal ? { viewNormalEnd: sample.normal } : {})
        }) || changed;
      } else {
        disconnectedUvSampleCount += 1;
        const previousScreenPoint = screenPointFromClientPoint(editor, previousSample.client);
        const sampleScreenPoint = screenPointFromClientPoint(editor, sample.client);
        pushSurfaceProjectedSegment(previousSample, previousSample, screenRadius);
        changed = pushTextureSegment(segments, previousSample.pixel, previousSample.pixel, {
          radiusPixels,
          screenStart: previousScreenPoint,
          screenEnd: previousScreenPoint,
          screenRadiusPixels: screenRadius,
          ...(previousSample.view
            ? { viewStart: previousSample.view, viewEnd: previousSample.view, viewRadiusPixels: viewRadiusForSample(previousSample.view, screenRadius) }
            : {}),
          ...(Number.isFinite(Number(previousSample.component)) && Number(previousSample.component) >= 0
            ? {
                componentStart: Math.floor(Number(previousSample.component)),
                componentEnd: Math.floor(Number(previousSample.component))
              }
            : {}),
          ...(previousSample.normal ? { viewNormalStart: previousSample.normal, viewNormalEnd: previousSample.normal } : {})
        }) || changed;
        pushSurfaceProjectedSegment(sample, sample, screenRadius);
        changed = pushTextureSegment(segments, sample.pixel, sample.pixel, {
          radiusPixels,
          screenStart: sampleScreenPoint,
          screenEnd: sampleScreenPoint,
          screenRadiusPixels: screenRadius,
          ...(sample.view
            ? { viewStart: sample.view, viewEnd: sample.view, viewRadiusPixels: viewRadiusForSample(sample.view, screenRadius) }
            : {}),
          ...(Number.isFinite(Number(sample.component)) && Number(sample.component) >= 0
            ? {
                componentStart: Math.floor(Number(sample.component)),
                componentEnd: Math.floor(Number(sample.component))
              }
            : {}),
          ...(sample.normal ? { viewNormalStart: sample.normal, viewNormalEnd: sample.normal } : {})
        }) || changed;
      }
      previousSample = sample;
    }
    return changed;
  };

  const strokeSegmentsFromClientSegments = () => {
    if (!Array.isArray(options.strokeSegments) || typeof editor?.texturePaintHitForEvent !== "function") {
      return [];
    }
    if (options.skipStrokePathResampling === true) {
      return [];
    }
    const segments = [];
    for (const segment of options.strokeSegments.slice(0, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS)) {
      const screenDistance = clientPointDistance(segment?.start, segment?.end);
      const screenRadius = Math.max(
        1,
        Number(segment?.radiusPixels) || Number(options.radiusPixels) || editor?.textureBrushRadiusScreenPixels?.() || 10
      );
      const spacingPercent = Math.max(0.1, Math.min(200, Number(segment?.spacing ?? options.spacing ?? 1)));
      const directConnectScreenLimit = spacingPercent <= 10
        ? Math.max(4, Math.min(8, screenRadius * 0.2))
        : Math.max(12, Math.min(24, screenRadius * 1.25));
      const sampleOnlyDirectConnectScreenLimit = cachedStrokeSamplesOnly
        ? Math.max(directConnectScreenLimit, Math.min(16, screenRadius * 1.25))
        : directConnectScreenLimit;
      const startSample = hitPixelForClientPoint(segment?.start);
      const endSample = hitPixelForClientPoint(segment?.end);
      if (
        startSample
        && endSample
        && screenDistance <= sampleOnlyDirectConnectScreenLimit
        && textureSegmentCanConnect(
          startSample.pixel,
          endSample.pixel,
          segment.start,
          segment.end,
          liveTextureRadiusPixels,
          editable.canvas
        )
      ) {
        pushSurfaceProjectedSegment(startSample, endSample, screenRadius);
        pushTextureSegment(segments, startSample.pixel, endSample.pixel, {
          radiusPixels: liveTextureRadiusPixels,
          screenStart: screenPointFromClientPoint(editor, segment.start),
          screenEnd: screenPointFromClientPoint(editor, segment.end),
          screenRadiusPixels: screenRadius,
          ...(startSample.view && endSample.view
            ? {
                viewStart: startSample.view,
                viewEnd: endSample.view,
                viewRadiusPixels: Math.max(
                  viewRadiusForSample(startSample.view, screenRadius) || 0,
                  viewRadiusForSample(endSample.view, screenRadius) || 0
                )
              }
            : {}),
          ...(Number.isFinite(Number(startSample.component)) && Number(startSample.component) >= 0
            ? { componentStart: Math.floor(Number(startSample.component)) }
            : {}),
          ...(Number.isFinite(Number(endSample.component)) && Number(endSample.component) >= 0
            ? { componentEnd: Math.floor(Number(endSample.component)) }
            : {}),
          ...(startSample.normal ? { viewNormalStart: startSample.normal } : {}),
          ...(endSample.normal ? { viewNormalEnd: endSample.normal } : {})
        });
        continue;
      }
      appendSampledClientSegmentPieces(segments, segment, liveTextureRadiusPixels);
    }
    return segments;
  };

  let strokeSegments = strokeSegmentsFromClientSegments();
  const strokeSegmentTimingMs = timingNow();
  // Paint is evaluated as a continuous brush curve on the material's unwrapped
  // UV texture. Screen-brush geometry may only contribute linked-seam UV
  // stamps when real hit samples are unavailable; generic projected triangles
  // must not become brush geometry or broad strokes print as plaid fragments.
  const appendProjectedStrokeSegments = () => {
    let appended = 0;
    for (const segment of seamProjectedStrokeSegments) {
      if (strokeSegments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
        break;
      }
      if (pushTextureSegment(strokeSegments, segment?.start, segment?.end, {
        radiusPixels: segment?.radiusPixels,
        screenStart: segment?.screenStart,
        screenEnd: segment?.screenEnd,
        screenRadiusPixels: segment?.screenRadiusPixels,
        componentStart: segment?.componentStart,
        componentEnd: segment?.componentEnd
      })) {
        appended += 1;
      }
    }
    return appended;
  };
  const allowProjectedSeamPaintGeometry = !(
    options.liveProjectedPaint === true
    && options.largeLiveBrushPaint === true
    && options.neighborPaintSeed?.enabled !== true
    && options.largeLiveNeighborPaint !== true
  );
  const shouldUseScreenProjectedTextureSegments = allowProjectedSeamPaintGeometry && (
    options.preferScreenProjectedTextureSegments === true
    || (!strokeSegments.length && seamProjectedStrokeSegments.length)
  );
  let linkedSeamSegmentCount = 0;
  if (shouldUseScreenProjectedTextureSegments) {
    appendProjectedStrokeSegments();
  } else if (allowProjectedSeamPaintGeometry && disconnectedUvSampleCount > 0 && seamProjectedStrokeSegments.length) {
    // When a visible screen stroke crosses a real UV seam, direct UV hit
    // samples become isolated point stamps. Add only short projected pieces
    // from the camera-facing seam triangles so the airbrush stays continuous
    // without allowing long atlas-interior connectors.
    linkedSeamSegmentCount = appendLinkedSeamProjectedStrokeSegments(
      strokeSegments,
      seamProjectedStrokeSegments,
      liveTextureRadiusPixels,
      editable.canvas
    );
    if (linkedSeamSegmentCount > 0) {
      const prunedStrokeSegments = pruneCoveredTexturePointStamps(strokeSegments, liveTextureRadiusPixels);
      strokeSegments.splice(0, strokeSegments.length, ...prunedStrokeSegments);
    }
  }
  if (!strokeSegments.length) {
    const fallbackStart = textureSegmentCanConnect(
      start,
      center,
      options.strokeStart,
      event,
      liveTextureRadiusPixels,
      editable.canvas
    )
      ? start
      : center;
    strokeSegments.push({
      start: {
        x: fallbackStart.x,
        y: fallbackStart.y
      },
      end: {
        x: center.x,
        y: center.y
      }
    });
  }
  const {
    resolvedMaterial: _resolvedMaterial,
    resolvedMaterialIndex: _resolvedMaterialIndex,
    ...brushOptionSource
  } = options;
  const viewDistanceBetween = (left = null, right = null) => {
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
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const dz = right.z - left.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  const normalDotBetween = (left = null, right = null) => {
    if (
      !Number.isFinite(left?.x)
      || !Number.isFinite(left?.y)
      || !Number.isFinite(left?.z)
      || !Number.isFinite(right?.x)
      || !Number.isFinite(right?.y)
      || !Number.isFinite(right?.z)
    ) {
      return null;
    }
    const leftLength = Math.hypot(left.x, left.y, left.z);
    const rightLength = Math.hypot(right.x, right.y, right.z);
    if (leftLength <= 0.0001 || rightLength <= 0.0001) {
      return null;
    }
    return (
      left.x * right.x
      + left.y * right.y
      + left.z * right.z
    ) / (leftLength * rightLength);
  };
  const sameSurfaceEndpoint = (
    leftView = null,
    rightView = null,
    leftNormal = null,
    rightNormal = null,
    radiusWorld = 0,
    {
      gapScale = 1.75,
      minGap = 0.12,
      normalDotMin = -0.08
    } = {}
  ) => {
    const gap = viewDistanceBetween(leftView, rightView);
    const radius = Math.max(0.0001, Number(radiusWorld) || 0);
    const gapLimit = Math.max(minGap, radius * gapScale);
    if (!Number.isFinite(gap) || gap > gapLimit) {
      return false;
    }
    const normalDot = normalDotBetween(leftNormal, rightNormal);
    return normalDot === null || normalDot >= normalDotMin;
  };
  const neighborSurfacePaintActive = options.neighborPaintSeed?.enabled === true
    || Boolean(options.neighborPaintKey)
    || options.largeLiveNeighborPaint === true;
  const neighborComponentCanConstrainSurfaceField = Boolean(
    options.neighborPaintSeed?.enabled === true
    && options.neighborPaintSeed?.component?.size
    && options.liveProjectedPaint === true
    && options.useTslSurfaceAirbrush !== false
    && preferTslFullSurfaceUvRaster
  );
  const neighborSeedComponentId = (() => {
    if (!neighborComponentCanConstrainSurfaceField) {
      return -1;
    }
    const componentId = Math.floor(Number(options.neighborPaintSeed?.componentId));
    return Number.isFinite(componentId) && componentId >= 0 ? componentId : -1;
  })();
  const neighborSourceRasterComponentIds = neighborSeedComponentId >= 0
    ? [neighborSeedComponentId]
    : null;
  const neighborComponentGateRelaxed = relaxNeighborComponentGate(options);
  // Neighbor is the only mode that may use a connected-component write mask.
  // Ordinary strokes must stay surface-continuous and must not inherit this
  // gate, or they break into mesh-component-shaped holes.
  const neighborComponentCanGateSurfacePermission = neighborComponentCanConstrainSurfaceField;
  const componentIdsCanConstrainSurfaceField = neighborComponentCanConstrainSurfaceField;
  const localComponentCanGateSurfacePermission = neighborComponentCanGateSurfacePermission;
  const hardTextureComponentCanGateSurfacePermission = false;
  const componentIdsCanGateSurfaceField = localComponentCanGateSurfacePermission;
  const componentGateCanRelaxOnFrontmost = false;
  const componentIdsSplitSurfaceSegments = componentIdsCanGateSurfaceField;
  const sameSurfaceComponent = (leftComponent = -1, rightComponent = -1) => {
    if (!componentIdsSplitSurfaceSegments) {
      return true;
    }
    const left = Math.floor(Number(leftComponent));
    const right = Math.floor(Number(rightComponent));
    return !Number.isFinite(left) || left < 0 || !Number.isFinite(right) || right < 0 || left === right;
  };
  const projectedSurfaceBrushSegments = (() => {
    if (!surfaceProjectedStrokeSegments.length) {
      return [];
    }
    const merged = [];
    const bridgeMinGap = Math.max(6, screenRadiusPixels * 0.28);
    const bridgeMaxGap = Math.max(48, screenRadiusPixels * 1.75);
    const bridgePathTolerance = Math.max(6, screenRadiusPixels * 0.35);
    const bridgeOnStrokePath = (startPoint = null, endPoint = null) => {
      if (!screenPaintStrokeSegments.length || !startPoint || !endPoint) {
        return false;
      }
      const midpoint = {
        x: (startPoint.x + endPoint.x) * 0.5,
        y: (startPoint.y + endPoint.y) * 0.5
      };
      return screenPaintStrokeSegments.some((segment) => {
        const startScreen = finitePoint(segment?.start);
        const endScreen = finitePoint(segment?.end);
        if (!startScreen || !endScreen) {
          return false;
        }
        return pointToSegmentDistance(midpoint, startScreen, endScreen) <= bridgePathTolerance
          && pointToSegmentDistance(startPoint, startScreen, endScreen) <= screenRadiusPixels
          && pointToSegmentDistance(endPoint, startScreen, endScreen) <= screenRadiusPixels;
      });
    };
    const bridgeOnSameSurface = (previous = null, segment = null) => {
      if (!previous?.viewEnd || !segment?.viewStart) {
        return false;
      }
      if (!sameSurfaceComponent(
        previous.componentEnd ?? previous.componentStart,
        segment.componentStart ?? segment.componentEnd
      )) {
        return false;
      }
      const radiusWorld = Math.max(
        0.0001,
        Number(previous.viewRadiusPixels) || 0,
        Number(segment.viewRadiusPixels) || 0
      );
      return sameSurfaceEndpoint(
        previous.viewEnd,
        segment.viewStart,
        previous.viewNormalEnd || previous.viewNormalStart,
        segment.viewNormalStart || segment.viewNormalEnd,
        radiusWorld,
        {
          gapScale: 1.35,
          minGap: 0.08,
          normalDotMin: 0.02
        }
      );
    };
    for (const segment of surfaceProjectedStrokeSegments) {
      const segmentComponentStart = Math.floor(Number(segment?.componentStart));
      const segmentComponentEnd = Math.floor(Number(segment?.componentEnd));
      const segmentCrossesComponents = componentIdsSplitSurfaceSegments
        && Number.isFinite(segmentComponentStart)
        && segmentComponentStart >= 0
        && Number.isFinite(segmentComponentEnd)
        && segmentComponentEnd >= 0
        && segmentComponentStart !== segmentComponentEnd;
      const surfaceSegment = segmentCrossesComponents
        ? {
            ...segment,
            end: { ...segment.start },
            ...(segment.viewStart ? { viewEnd: segment.viewStart } : {}),
            ...(segment.viewNormalStart ? { viewNormalEnd: segment.viewNormalStart } : {}),
            componentEnd: segmentComponentStart
          }
        : segment;
      const previous = merged.length ? merged[merged.length - 1] : null;
      const gap = previous ? pointDistance(previous.end, surfaceSegment.start) : 0;
      if (
        previous
        && merged.length + 1 < TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
        && gap >= bridgeMinGap
        && gap <= bridgeMaxGap
        && bridgeOnStrokePath(previous.end, surfaceSegment.start)
        && bridgeOnSameSurface(previous, surfaceSegment)
      ) {
        merged.push({
          start: { x: previous.end.x, y: previous.end.y },
          end: { x: surfaceSegment.start.x, y: surfaceSegment.start.y },
          radiusPixels: Math.max(
            0.75,
            Number(previous.radiusPixels) || screenRadiusPixels,
            Number(surfaceSegment.radiusPixels) || screenRadiusPixels
          ),
          ...(previous.viewEnd && surfaceSegment.viewStart
            ? { viewStart: previous.viewEnd, viewEnd: surfaceSegment.viewStart }
            : {}),
          ...(Number.isFinite(Number(previous.viewRadiusPixels)) || Number.isFinite(Number(surfaceSegment.viewRadiusPixels))
            ? {
                viewRadiusPixels: Math.max(
                  0.0001,
                  Number(previous.viewRadiusPixels) || 0,
                  Number(surfaceSegment.viewRadiusPixels) || 0
                )
              }
            : {}),
          ...(Number.isFinite(Number(previous.componentEnd ?? previous.componentStart)) && Number(previous.componentEnd ?? previous.componentStart) >= 0
            ? { componentStart: Math.floor(Number(previous.componentEnd ?? previous.componentStart)) }
            : {}),
          ...(Number.isFinite(Number(surfaceSegment.componentStart ?? surfaceSegment.componentEnd)) && Number(surfaceSegment.componentStart ?? surfaceSegment.componentEnd) >= 0
            ? { componentEnd: Math.floor(Number(surfaceSegment.componentStart ?? surfaceSegment.componentEnd)) }
            : {}),
          ...(previous.viewNormalEnd || previous.viewNormalStart
            ? { viewNormalStart: previous.viewNormalEnd || previous.viewNormalStart }
            : {}),
          ...(surfaceSegment.viewNormalStart || surfaceSegment.viewNormalEnd
            ? { viewNormalEnd: surfaceSegment.viewNormalStart || surfaceSegment.viewNormalEnd }
            : {})
        });
      }
      if (merged.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
        break;
      }
      merged.push(surfaceSegment);
    }
    return merged;
  })();
  const surfaceEnrichedScreenPaintStrokeSegments = (() => {
    if (!screenPaintStrokeSegments.length) {
      return [];
    }
    const anchors = [];
    const rememberAnchor = (screen = null, view = null, radiusPixelsForAnchor = screenRadiusPixels, radiusWorld = null, normal = null, component = -1) => {
      const screenPoint = finitePoint(screen);
      if (
        !screenPoint
        || !Number.isFinite(view?.x)
        || !Number.isFinite(view?.y)
        || !Number.isFinite(view?.z)
      ) {
        return;
      }
      const resolvedRadiusWorld = Math.max(
        0.0001,
        Number(radiusWorld) || 0,
        viewRadiusForSample(view, radiusPixelsForAnchor) || 0
      );
      anchors.push({
        screen: screenPoint,
        view,
        radiusWorld: resolvedRadiusWorld,
        ...(Number.isFinite(normal?.x) && Number.isFinite(normal?.y) && Number.isFinite(normal?.z)
          ? { normal }
          : {}),
        ...(Number.isFinite(Number(component)) && Number(component) >= 0
          ? { component: Math.floor(Number(component)) }
          : {})
      });
    };
    for (const segment of surfaceProjectedStrokeSegments) {
      const segmentRadius = Math.max(0.75, Number(segment?.radiusPixels) || screenRadiusPixels);
      rememberAnchor(
        segment?.start,
        segment?.viewStart,
        segmentRadius,
        segment?.viewRadiusPixels,
        segment?.viewNormalStart,
        segment?.componentStart
      );
      rememberAnchor(
        segment?.end,
        segment?.viewEnd,
        segmentRadius,
        segment?.viewRadiusPixels,
        segment?.viewNormalEnd,
        segment?.componentEnd
      );
    }
    for (const sample of [strokeStartSample, currentSample]) {
      const screenPoint = sample?.client
        ? screenPointFromClientPoint(editor, sample.client)
        : null;
      rememberAnchor(
        screenPoint,
        sample?.view,
        screenRadiusPixels,
        null,
        sample?.normal,
        sample?.component
      );
    }
    const shouldAddIndexedStrokeAnchors = options.liveProjectedPaint === true
      && options.useTslSurfaceAirbrush !== false
      && preferTslFullSurfaceUvRaster
      && screenPaintStrokeSegments.length > 0;
    const needsIndexedNormalAnchors = !anchors.length
      || !anchors.some((anchor) => anchor?.normal)
      || shouldAddIndexedStrokeAnchors;
    const canBuildIndexedNormalAnchors = Boolean(editor?.camera?.matrixWorldInverse);
    if (
      needsIndexedNormalAnchors
      && canBuildIndexedNormalAnchors
      && typeof editor?.textureAirbrushScreenHitsForEvent === "function"
    ) {
      const rect = editor?.canvas?.getBoundingClientRect?.() || null;
      const clientFromScreenPoint = (point = null) => {
        const screenPoint = finitePoint(point);
        return screenPoint && rect
          ? {
              clientX: (Number(rect.left) || 0) + screenPoint.x,
              clientY: (Number(rect.top) || 0) + screenPoint.y
            }
          : null;
      };
      const indexedAnchorRecordMatches = (entry = null) => {
        if (!entry?.record || !record) {
          return true;
        }
        return entry.record === record
          || textureAirbrushRecordIdentity(entry.record, "") === textureAirbrushRecordIdentity(record, "record");
      };
      const rememberIndexedAnchor = (screen = null, radiusPixelsForAnchor = screenRadiusPixels) => {
        const screenPoint = finitePoint(screen);
        const clientPoint = clientFromScreenPoint(screenPoint);
        const pointEvent = clientEventFromPoint(clientPoint, event);
        if (!screenPoint || !clientPoint || !pointEvent) {
          return;
        }
        let indexed = screenIndexedHitResultForClientPoint(editor, pointEvent, event, {
          ...options,
          screenHitRect: rect,
          liveProjectedPaint: true,
          visibleSurfaceMaskRequired: true,
          requireVisibilityMask: true,
          allowAnimationProgressMismatch: true,
          raycastFallbackOnScreenMiss: true
        });
        if (indexed === undefined && typeof editor.texturePaintHitForEvent === "function") {
          indexed = editor.texturePaintHitForEvent(pointEvent, "airbrush");
        }
        if (!indexed?.hit || !indexedAnchorRecordMatches(indexed)) {
          return;
        }
        const view = viewPointFromHit(editor, indexed.hit, pointEvent);
        const normal = viewNormalFromHit(editor, indexed.hit);
        const component = textureAirbrushComponentIdForHit(editor, indexed.record || record, indexed.hit);
        rememberAnchor(screenPoint, view, radiusPixelsForAnchor, null, normal, component);
      };
      const indexedAnchorSegments = screenPaintStrokeSegments.slice(0, Math.min(screenPaintStrokeSegments.length, 24));
      for (const segment of indexedAnchorSegments) {
        const radius = Math.max(0.75, Number(segment?.radiusPixels) || screenRadiusPixels);
        const startPoint = finitePoint(segment?.start);
        const endPoint = finitePoint(segment?.end);
        rememberIndexedAnchor(startPoint, radius);
        rememberIndexedAnchor(endPoint, radius);
        if (startPoint && endPoint) {
          rememberIndexedAnchor({
            x: (startPoint.x + endPoint.x) * 0.5,
            y: (startPoint.y + endPoint.y) * 0.5
          }, radius);
        }
      }
    }
    if (!anchors.length) {
      return [];
    }
    const nearestAnchor = (point = null, radiusPixelsForSegment = screenRadiusPixels) => {
      const screenPoint = finitePoint(point);
      if (!screenPoint) {
        return null;
      }
      let best = null;
      let bestDistance = Infinity;
      const maxScreenDistance = Math.max(10, (Number(radiusPixelsForSegment) || screenRadiusPixels) * 1.6);
      for (const anchor of anchors) {
        const distance = pointDistance(screenPoint, anchor.screen);
        const sameDistance = Math.abs(distance - bestDistance) <= 0.001;
        if (distance < bestDistance || (sameDistance && !best?.normal && anchor?.normal)) {
          bestDistance = distance;
          best = anchor;
        }
      }
      return bestDistance <= maxScreenDistance ? best : null;
    };
    const anchoredSegments = [];
    const pushAnchoredPointSegment = (segment = null, point = null, anchor = null, radius = screenRadiusPixels, radiusWorld = 0) => {
      const screenPoint = finitePoint(point);
      if (
        !screenPoint
        || !Number.isFinite(anchor?.view?.x)
        || !Number.isFinite(anchor?.view?.y)
        || !Number.isFinite(anchor?.view?.z)
      ) {
        return;
      }
      if (anchoredSegments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
        return;
      }
      const resolvedRadiusWorld = Math.max(
        0.0001,
        Number(radiusWorld) || 0,
        Number(anchor?.radiusWorld) || 0,
        viewRadiusForSample(anchor.view, radius) || 0
      );
      anchoredSegments.push({
        ...segment,
        start: { x: screenPoint.x, y: screenPoint.y },
        end: { x: screenPoint.x, y: screenPoint.y },
        radiusPixels: radius,
        viewStart: anchor.view,
        viewEnd: anchor.view,
        viewRadiusPixels: resolvedRadiusWorld,
        ...(Number.isFinite(Number(anchor.component)) && Number(anchor.component) >= 0
          ? {
              componentStart: Math.floor(Number(anchor.component)),
              componentEnd: Math.floor(Number(anchor.component))
            }
          : {}),
        ...(anchor.normal ? { viewNormalStart: anchor.normal, viewNormalEnd: anchor.normal } : {})
      });
    };
    for (const segment of screenPaintStrokeSegments) {
      const startPoint = finitePoint(segment?.start);
      const endPoint = finitePoint(segment?.end);
      const radius = Math.max(0.75, Number(segment?.radiusPixels) || screenRadiusPixels);
      const startAnchor = nearestAnchor(startPoint, radius);
      const endAnchor = nearestAnchor(endPoint, radius);
      if (!startAnchor || !endAnchor) {
        continue;
      }
      const viewStart = startAnchor.view;
      const viewEnd = endAnchor.view;
      const radiusWorld = Math.max(
        0.0001,
        Number(startAnchor?.radiusWorld) || 0,
        Number(endAnchor?.radiusWorld) || 0,
        viewRadiusForSample(viewStart, radius) || 0,
        viewRadiusForSample(viewEnd, radius) || 0
      );
      if (!viewStart || !viewEnd) {
        continue;
      }
      const screenGap = startPoint && endPoint ? pointDistance(startPoint, endPoint) : 0;
      const viewGap = viewDistanceBetween(viewStart, viewEnd);
      const degenerateViewSegment = screenGap > Math.max(2, radius * 0.08)
        && (
          !Number.isFinite(viewGap)
          || viewGap <= Math.max(0.0001, radiusWorld * 0.015)
        );
      const crossesComponents = componentIdsSplitSurfaceSegments
        && !sameSurfaceComponent(startAnchor.component, endAnchor.component);
      const remoteViewEnd = crossesComponents || !sameSurfaceEndpoint(
        viewStart,
        viewEnd,
        startAnchor.normal,
        endAnchor.normal,
        radiusWorld,
        {
          gapScale: 1.8,
          minGap: 0.1,
          normalDotMin: -0.12
        }
      );
      if (remoteViewEnd) {
        pushAnchoredPointSegment(segment, startPoint, startAnchor, radius, radiusWorld);
        pushAnchoredPointSegment(segment, endPoint, endAnchor, radius, radiusWorld);
        continue;
      }
      const useDirectionalViewSegment = !degenerateViewSegment;
      const safeEndNormal = useDirectionalViewSegment
        ? endAnchor.normal
        : null;
      const safeEndComponent = endAnchor.component;
      if (anchoredSegments.length >= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
        break;
      }
      anchoredSegments.push({
        ...segment,
        viewStart,
        viewEnd,
        viewRadiusPixels: radiusWorld,
        ...(Number.isFinite(Number(startAnchor.component)) && Number(startAnchor.component) >= 0
          ? { componentStart: Math.floor(Number(startAnchor.component)) }
          : {}),
        ...(Number.isFinite(Number(safeEndComponent)) && Number(safeEndComponent) >= 0
          ? { componentEnd: Math.floor(Number(safeEndComponent)) }
          : {}),
        ...(useDirectionalViewSegment && startAnchor.normal ? { viewNormalStart: startAnchor.normal } : {}),
        ...(safeEndNormal ? { viewNormalEnd: safeEndNormal } : {})
      });
    }
    return anchoredSegments;
  })();
  const annotateSurfaceFieldComponents = (segments = []) => {
    if (!componentIdsCanGateSurfaceField || !Array.isArray(segments) || !segments.length) {
      return segments;
    }
    const fallbackComponent = Math.floor(Number(currentComponent));
    const resolvedFallbackComponent = neighborSeedComponentId >= 0
      ? neighborSeedComponentId
      : fallbackComponent;
    if (!Number.isFinite(resolvedFallbackComponent) || resolvedFallbackComponent < 0) {
      return segments;
    }
    return segments.map((segment) => {
      if (!segment) {
        return segment;
      }
      const componentStart = Math.floor(Number(segment.componentStart));
      const componentEnd = Math.floor(Number(segment.componentEnd));
      const hasStart = Number.isFinite(componentStart) && componentStart >= 0;
      const hasEnd = Number.isFinite(componentEnd) && componentEnd >= 0;
      const gatedComponentStart = hasStart
        ? componentStart
        : resolvedFallbackComponent;
      const gatedComponentEnd = hasEnd
        ? componentEnd
        : hasStart
          ? componentStart
          : resolvedFallbackComponent;
      return {
        ...segment,
        componentStart: gatedComponentStart,
        componentEnd: gatedComponentEnd
      };
    });
  };
  // The visible projected brush field must follow the continuous pointer
  // polyline. Hit-resampled UV/surface pieces are allowed to seed visibility
  // and dispatch, but using them as the field makes strokes break at UV seams,
  // missed ray samples, and triangle boundaries.
	  const continuousNeighborScreenFieldSegments = preferTslFullSurfaceUvRaster
	    && neighborSurfacePaintActive
	    && screenPaintStrokeSegments.length
	    ? screenPaintStrokeSegments.slice(0, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS)
	    : [];
	  const projectedFieldStrokeSegments = annotateSurfaceFieldComponents(continuousNeighborScreenFieldSegments.length
	    ? continuousNeighborScreenFieldSegments
	    : surfaceEnrichedScreenPaintStrokeSegments.length
	    ? surfaceEnrichedScreenPaintStrokeSegments
	    : projectedSurfaceBrushSegments.length
	    ? projectedSurfaceBrushSegments
	    : screenPaintStrokeSegments);
	  const cameraFacingSurfaceFieldStrokeSegments = (() => {
	    if (!projectedFieldStrokeSegments.length) {
	      return [];
	    }
	    const visibleEdgeMode = String(options.visibleEdgeMode || "soft").toLowerCase();
	    const rejectZ = visibleEdgeMode === "hard" ? 0 : -0.28;
	    const normalZ = (normal = null) => (
	      Number.isFinite(Number(normal?.z)) ? Number(normal.z) : null
	    );
	    return projectedFieldStrokeSegments.filter((segment) => {
	      const startZ = normalZ(segment?.viewNormalStart);
	      const endZ = normalZ(segment?.viewNormalEnd);
	      if (startZ === null && endZ === null) {
	        return true;
	      }
	      return Math.max(startZ ?? endZ, endZ ?? startZ) >= rejectZ;
	    });
	  })();
	  const usesScreenProjectedVisibility = options.useVisibilityTrianglePaintRegions === true
	    && options.liveProjectedPaint === true
	    && cameraFacingSurfaceFieldStrokeSegments.length
	    && (
	      preferTslFullSurfaceUvRaster
	      || visibilityTriangles.some((triangle) => triangle.screenA && triangle.screenB && triangle.screenC)
	    );
  const preferTslSurfaceProjectedPrimary = options.useTslSurfaceAirbrush !== false
    && options.projectedPrimary === true
    && options.liveProjectedPaint === true
    && editor?.renderer?.isWebGPURenderer === true
    && editor?.renderer?.backend?.isWebGPUBackend === true
    && visibilityTriangles.some((triangle) => triangle.screenA && triangle.screenB && triangle.screenC);
  const projectedRenderTriangles = usesScreenProjectedVisibility
    && !preferTslFullSurfaceUvRaster
    && !preferTslSurfaceProjectedPrimary
    ? projectedSurfaceRenderTriangles(
        editor,
        record,
        hit,
	        editable,
	        hitUv,
	        cameraFacingSurfaceFieldStrokeSegments,
	        screenRadiusPixels,
	        {
          materialIndex,
          material,
          neighborPaintSeed,
          scatter: Number.isFinite(Number(options.scatter))
            ? Math.max(0, Math.min(1, Number(options.scatter)))
            : editor?.textureAirbrushScatter?.() ?? 0.35,
          maxProjectedRenderTriangles: options.maxProjectedRenderTriangles,
          cacheVisibilityTrianglePixels: options.cacheVisibilityTrianglePixels,
          visibleEdgeMode: options.visibleEdgeMode,
          fullProjectedSurfaceRenderTriangles: !preferTslFullSurfaceUvRaster
            && options.fullProjectedSurfaceRenderTriangles === true,
          projectedDebugCounts
        }
      )
    : [];
  const projectedRegionTriangles = projectedRenderTriangles.length
    ? projectedRenderTriangles
    : visibilityTriangles;
  const textureProjectedPaintRegions = usesScreenProjectedVisibility
    && !preferTslFullSurfaceUvRaster
    ? projectedStrokePaintRegions(strokeSegments, editable.canvas, {
        radiusPixels: liveTextureRadiusPixels,
        scatter: Number.isFinite(Number(options.scatter))
          ? Math.max(0, Math.min(1, Number(options.scatter)))
          : editor?.textureAirbrushScatter?.() ?? 0.35,
        localOnly: true
      })
    : [];
  const fullProjectedSurfacePaint = usesScreenProjectedVisibility
    && options.fullProjectedSurfaceRenderTriangles === true
    && (preferTslFullSurfaceUvRaster || projectedRenderTriangles.length > 0);
  const fullTextureProjectedPaintRegion = fullProjectedSurfacePaint
    ? normalizeTexturePaintRegion({
        x: 0,
        y: 0,
        width: editable.canvas?.width || 1,
        height: editable.canvas?.height || 1
      }, editable.canvas)
    : null;
	  const brushProjectedPaintRegions = usesScreenProjectedVisibility
	      ? (fullTextureProjectedPaintRegion
	        ? [fullTextureProjectedPaintRegion]
	        : screenProjectedBrushPaintRegions(projectedRegionTriangles, cameraFacingSurfaceFieldStrokeSegments, editable.canvas, {
	        radiusPixels: screenRadiusPixels,
	        scatter: Number.isFinite(Number(options.scatter))
          ? Math.max(0, Math.min(1, Number(options.scatter)))
          : editor?.textureAirbrushScatter?.() ?? 0.35,
        maxTextureRadiusPixels: projectedTextureRadiusLimit,
        fullProjectedTrianglePaintRegions: options.fullProjectedTrianglePaintRegions === true
          || (
            options.tileProjectedPaintRegions !== true
            && (
              options.largeLiveBrushPaint === true
              || options.largeLiveNeighborPaint === true
            )
          ),
	        maxFullProjectedTriangleRegionAreaPixels: options.maxFullProjectedTriangleRegionAreaPixels,
	        projectedDebugCounts,
	        tileProjectedPaintRegions: options.tileProjectedPaintRegions === true
	          && options.fullProjectedTrianglePaintRegions !== true
	      }))
    : [];
  const visibilityProjectedPaintRegions = usesScreenProjectedVisibility && !fullTextureProjectedPaintRegion
    ? visibilityTrianglePaintRegions(
        projectedRegionTriangles,
        editable.canvas,
        Math.max(
          32,
          Math.ceil(projectedSoftVisibilityGutterPadding(
            projectedTextureRadiusLimit || liveTextureRadiusPixels || radiusPixels,
            options
          ) + 6)
        )
      )
    : [];
	  const preferredProjectedPaintRegions = usesScreenProjectedVisibility
	    ? (brushProjectedPaintRegions.length
	        ? brushProjectedPaintRegions
	        : [
	            ...textureProjectedPaintRegions,
	            ...visibilityProjectedPaintRegions
	          ])
	    : [];
  const screenProjectedPaintRegions = usesScreenProjectedVisibility
    ? (preferredProjectedPaintRegions.length
        ? preferredProjectedPaintRegions
        : visibilityProjectedPaintRegions)
    : [];
  const paintRegionTimingMs = timingNow();
	  let projectedPaintRegions = [];
	  if (usesScreenProjectedVisibility) {
	    // The GPU evaluates the smooth airbrush footprint in screen space, then
	    // maps each camera-facing triangle back into the unwrapped UV texture.
	    // Dirty bounds follow the projected brush footprint. Direct UV stroke
	    // bounds are only a fallback when projection data is missing, because
	    // discontinuous UV jumps can span the atlas and make large brushes slow.
    const preserveProjectedTriangleRegions = fullProjectedSurfacePaint === true
      || options.fullProjectedTrianglePaintRegions === true
      || (
        options.tileProjectedPaintRegions !== true
        && (
          options.largeLiveBrushPaint === true
          || options.largeLiveNeighborPaint === true
        )
      );
	    if (preserveProjectedTriangleRegions) {
	      projectedPaintRegions = screenProjectedPaintRegions
	        .map((region) => normalizeTexturePaintRegion(region, editable.canvas))
	        .filter(Boolean);
	    } else {
	      for (const region of screenProjectedPaintRegions) {
	        projectedPaintRegions = mergeProjectedTexturePaintRegion(
	          projectedPaintRegions,
	          region,
	          editable.canvas
	        );
	      }
	    }
	  }
  const projectedPaintBounds = projectedPaintRegions.reduce(
    (bounds, region) => unionTextureBounds(bounds, region),
    null
  );
  const resolvedScatter = Number.isFinite(Number(options.scatter))
    ? Math.max(0, Math.min(1, Number(options.scatter)))
    : editor?.textureAirbrushScatter?.() ?? 0.35;
  const projectedSoftVisibilityBleedRadius = usesScreenProjectedVisibility
    && (options.visibleEdgeMode || "soft") !== "hard"
    && !Number.isFinite(Number(brushOptionSource.visibilityBleedRadius))
    ? projectedSoftVisibilityGutterPadding(liveTextureRadiusPixels, {
        ...options,
        scatter: resolvedScatter
      })
    : null;
  const exposeSurfaceComponentIds = Boolean(
    componentIdsCanGateSurfaceField
    || neighborSurfacePaintActive
    || (
      options.useTslSurfaceAirbrush !== false
      && options.liveProjectedPaint === true
      && options.fullProjectedSurfaceRenderTriangles === true
    )
  );
  const stripSurfaceComponents = (segments = []) => (
    exposeSurfaceComponentIds
      ? segments
      : (Array.isArray(segments) ? segments : []).map((segment) => {
          const { componentStart: _componentStart, componentEnd: _componentEnd, ...rest } = segment || {};
          return rest;
        })
  );
	  const outputStrokeSegments = stripSurfaceComponents(strokeSegments);
	  const outputProjectedFieldStrokeSegments = stripSurfaceComponents(cameraFacingSurfaceFieldStrokeSegments);
  const brushOptions = {
    ...brushOptionSource,
    layerMode: editable.layerMode === true,
    radiusPixels: liveTextureRadiusPixels,
    opacity: Number.isFinite(Number(options.opacity))
      ? Math.max(0.001, Math.min(1, Number(options.opacity)))
      : editor?.textureAirbrushOpacity?.() ?? 0.42,
    hardness: Number.isFinite(Number(options.hardness))
      ? Math.max(0, Math.min(1, Number(options.hardness)))
      : editor?.textureAirbrushHardness?.() ?? 0.35,
    scatter: resolvedScatter,
    ...(projectedSoftVisibilityBleedRadius != null
      ? { visibilityBleedRadius: projectedSoftVisibilityBleedRadius }
      : {}),
    strength: Number.isFinite(Number(options.strength))
      ? Math.max(0, Number(options.strength))
      : 1,
    color: options.color || editor?.textureAirbrushColor?.() || { r: 255, g: 255, b: 255 },
    screenRadiusPixels,
    keepVisibilitySamplesWithTriangles: usesScreenProjectedVisibility,
    strokeSegments: outputStrokeSegments,
    ...(componentIdsCanGateSurfaceField ? { hardTextureAirbrushComponentGate: true } : {}),
    ...(componentGateCanRelaxOnFrontmost ? { relaxComponentGateOnFrontmost: true } : {}),
    ...(neighborSourceRasterComponentIds ? { sourceRasterAllowedComponentIds: neighborSourceRasterComponentIds } : {}),
    ...(fullProjectedSurfacePaint ? { fullProjectedSurfaceRenderTriangles: true } : {}),
    ...(preferTslSurfaceProjectedPrimary && visibilityTriangles.length ? { projectedPrimary: true } : {}),
    ...(usesScreenProjectedVisibility
      ? { screenProjectedStrokeSegments: outputProjectedFieldStrokeSegments }
      : {}),
    ...(projectedRenderTriangles.length ? { projectedRenderTriangles } : {}),
    ...(visibilityTriangles.length ? { visibilityMaskTriangles: visibilityTriangles } : {})
  };
  if (options.captureCandidateTimings === true) {
    brushOptions.candidateTimingMs = {
      visibility: Math.max(0, visibilityTimingMs - timingStartMs),
      strokeSegments: Math.max(0, strokeSegmentTimingMs - visibilityTimingMs),
      paintRegions: Math.max(0, paintRegionTimingMs - strokeSegmentTimingMs),
      total: Math.max(0, paintRegionTimingMs - timingStartMs)
    };
    brushOptions.candidateDebugCounts = {
      visibilityTriangles: visibilityTriangles.length,
      seamProjectedStrokeSegments: seamProjectedStrokeSegments.length,
      linkedSeamStrokeSegments: linkedSeamSegmentCount,
      disconnectedUvSamples: disconnectedUvSampleCount,
      strokeSegments: strokeSegments.length,
      paintRegions: projectedPaintRegions.length,
      projectedRenderTriangles: projectedRenderTriangles.length,
      fullProjectedSurfacePaint: fullProjectedSurfacePaint === true ? 1 : 0,
      ...projectedDebugCounts
	    };
  }
  const candidate = {
    record,
    hit,
    target,
    material,
    materialIndex,
    editable,
    layerMode: editable.layerMode === true,
    center: {
      x: center.x,
      y: center.y
    },
    start: {
      x: start.x,
      y: start.y
    },
    radiusPixels: liveTextureRadiusPixels,
    strokeSegments: outputStrokeSegments,
    ...(projectedPaintBounds ? { paintBounds: projectedPaintBounds } : {}),
    ...(projectedPaintRegions.length ? { paintRegions: projectedPaintRegions } : {}),
    ...(fullProjectedSurfacePaint ? { fullProjectedSurfacePaint: true } : {}),
    options: brushOptions
  };
  candidate.estimate = textureAirbrushWebGpuStrokeEstimate(candidate);
  return candidate;
}
