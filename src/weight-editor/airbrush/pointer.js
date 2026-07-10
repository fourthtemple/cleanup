import {
  BackSide,
  DoubleSide,
  FrontSide,
  Vector2,
  Vector3
} from "../../../node_modules/three/build/three.webgpu.js";

const SELECTION_BRUSH_TOOLS = new Set(["paint", "deselect", "erase", "push", "pull"]);
const BRUSH_CURSOR_POSITION_QUANTUM = 0.25;
const TEXTURE_BRUSH_MAX_SCREEN_RADIUS_PIXELS = 160;
const TEXTURE_AIRBRUSH_SCREEN_HIT_CELL_SIZE = 16;
const TEXTURE_AIRBRUSH_SCREEN_HIT_CACHE_LIMIT = 1024;
const SCREEN_TRIANGLE_FRONT_FACING_AREA_EPSILON = 0.0001;
const TEXTURE_AIRBRUSH_VISIBLE_TEXEL_ALPHA_THRESHOLD = 8;

function quantizedCursorPosition(value = 0) {
  return Math.round(value / BRUSH_CURSOR_POSITION_QUANTUM) * BRUSH_CURSOR_POSITION_QUANTUM;
}

function attributeCount(attribute = null) {
  return Math.max(0, Math.floor(Number(attribute?.count) || 0));
}

function attributeIndexValue(attribute = null, index = -1) {
  if (!attribute || !Number.isInteger(index) || index < 0 || index >= attributeCount(attribute)) {
    return -1;
  }
  const value = typeof attribute.getX === "function"
    ? attribute.getX(index)
    : attribute.array?.[index];
  return Number.isInteger(value) ? value : Math.floor(Number(value));
}

function attributePoint2(attribute = null, index = -1) {
  if (!attribute || !Number.isInteger(index) || index < 0 || index >= attributeCount(attribute)) {
    return null;
  }
  const x = typeof attribute.getX === "function"
    ? attribute.getX(index)
    : attribute.array?.[index * 2];
  const y = typeof attribute.getY === "function"
    ? attribute.getY(index)
    : attribute.array?.[index * 2 + 1];
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function materialIndexForScreenHitTriangle(geometry = null, triangleIndex = -1) {
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

function materialForScreenHitTriangle(record = null, materialIndex = 0) {
  const materials = Array.isArray(record?.object?.material)
    ? record.object.material
    : [record?.object?.material].filter(Boolean);
  if (!materials.length) {
    return null;
  }
  return materials[materialIndex] || materials.find((material) => material?.map) || materials[0] || null;
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

function materialMatchesEditablePaintTarget(editor = null, material = null, editable = null, sourceMaterial = null) {
  if (!material) {
    return false;
  }
  if (sourceMaterial && material === sourceMaterial) {
    return true;
  }
  const materialEditable = editor?.editableClonePaintTexture?.(material) || null;
  return editablePaintTargetsMatch(materialEditable, editable);
}

function baseEditableForTextureVisibility(editor = null, material = null) {
  if (!editor || !material) {
    return null;
  }
  const userData = material.userData || {};
  if (userData.clonePaintCanvas && userData.clonePaintContext) {
    return {
      canvas: userData.clonePaintCanvas,
      context: userData.clonePaintContext,
      texture: userData.clonePaintTexture || material.map || null
    };
  }
  const editable = editor.editableClonePaintTexture?.(material) || null;
  if (editable?.layerMode === true) {
    return {
      canvas: editable.compositeCanvas || userData.clonePaintCanvas || null,
      context: editable.compositeContext || userData.clonePaintContext || null,
      texture: editable.texture || userData.clonePaintTexture || material.map || null
    };
  }
  return editable;
}

function textureVisibilitySampleKey(material = null, canvas = null, pixel = null) {
  if (!pixel || !canvas) {
    return "";
  }
  return [
    material?.uuid || material?.id || material?.name || "material",
    canvas.width || 0,
    canvas.height || 0,
    Math.max(0, Math.min((canvas.width || 1) - 1, Math.round(pixel.x))),
    Math.max(0, Math.min((canvas.height || 1) - 1, Math.round(pixel.y)))
  ].join(":");
}

function textureAirbrushHitTextureAlpha(editor = null, record = null, hit = null, options = {}) {
  if (!editor || !record || !hit?.uv) {
    return null;
  }
  const material = options.material || editor.clonePaintMaterialForHit?.(record, hit) || null;
  if (!material) {
    return null;
  }
  const editable = options.editable || baseEditableForTextureVisibility(editor, material);
  const canvas = editable?.canvas || null;
  const context = editable?.context || null;
  const texture = editable?.texture || material.map || null;
  if (!canvas || !context || typeof context.getImageData !== "function") {
    return null;
  }
  const pixel = editor.clonePaintPixelFromUv?.(hit.uv, canvas, texture) || null;
  if (!Number.isFinite(pixel?.x) || !Number.isFinite(pixel?.y)) {
    return null;
  }
  const x = Math.max(0, Math.min(canvas.width - 1, Math.round(pixel.x)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.round(pixel.y)));
  const cache = options.cache instanceof Map ? options.cache : null;
  const key = cache ? textureVisibilitySampleKey(material, canvas, { x, y }) : "";
  if (key && cache.has(key)) {
    return cache.get(key);
  }
  let alpha = null;
  try {
    alpha = context.getImageData(x, y, 1, 1).data?.[3] ?? null;
  } catch {
    alpha = null;
  }
  if (key) {
    cache.set(key, alpha);
  }
  return alpha;
}

function textureAirbrushHitHasVisibleTexel(editor = null, record = null, hit = null, options = {}) {
  const alpha = textureAirbrushHitTextureAlpha(editor, record, hit, options);
  if (!Number.isFinite(alpha)) {
    return true;
  }
  const threshold = Math.max(
    0,
    Math.min(255, Number(options.alphaThreshold) || TEXTURE_AIRBRUSH_VISIBLE_TEXEL_ALPHA_THRESHOLD)
  );
  return alpha > threshold;
}

function materialSideForScreenHitTriangle(record = null, geometry = null, triangleIndex = -1) {
  const materialIndex = materialIndexForScreenHitTriangle(geometry, triangleIndex);
  const material = materialForScreenHitTriangle(record, materialIndex);
  return material?.side ?? FrontSide ?? 0;
}

function screenTriangleMatchesMaterialSide(screen = null, side = FrontSide) {
  if (!Array.isArray(screen) || screen.length < 3) {
    return false;
  }
  const area = signedArea2(screen[0], screen[1], screen[2]);
  if (!Number.isFinite(area) || Math.abs(area) <= SCREEN_TRIANGLE_FRONT_FACING_AREA_EPSILON) {
    return false;
  }
  // Screen y is inverted from camera clip space, so normal front-facing
  // triangles wind clockwise in canvas coordinates.
  const frontFacing = area < 0;
  if (side === DoubleSide) {
    return true;
  }
  if (side === BackSide) {
    return !frontFacing;
  }
  return frontFacing;
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

function cameraFacingCoverageForScreenIndexTriangle(screen = null) {
  if (!Array.isArray(screen) || screen.length < 3) {
    return 0;
  }
  const points = screen.slice(0, 3);
  if (!points.every((point) => (
    Number.isFinite(point?.viewX)
    && Number.isFinite(point?.viewY)
    && Number.isFinite(point?.viewZ)
  ))) {
    return 0;
  }
  const edgeAx = points[1].viewX - points[0].viewX;
  const edgeAy = points[1].viewY - points[0].viewY;
  const edgeAz = points[1].viewZ - points[0].viewZ;
  const edgeBx = points[2].viewX - points[0].viewX;
  const edgeBy = points[2].viewY - points[0].viewY;
  const edgeBz = points[2].viewZ - points[0].viewZ;
  const normalX = edgeAy * edgeBz - edgeAz * edgeBy;
  const normalY = edgeAz * edgeBx - edgeAx * edgeBz;
  const normalZ = edgeAx * edgeBy - edgeAy * edgeBx;
  const length = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
  return length > 0.000001 ? normalFacingCoverage(normalZ / length) : 0;
}

function viewNormalForScreenTriangle(screen = null) {
  if (!Array.isArray(screen) || screen.length < 3) {
    return null;
  }
  const points = screen.slice(0, 3).map(finiteViewPoint);
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
  if (length <= 0.000001) {
    return null;
  }
  return {
    x: normalX / length,
    y: normalY / length,
    z: normalZ / length
  };
}

function viewNormalDot(left = null, right = null) {
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
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function projectedVertexPoint(object = null, position = null, vertexIndex = -1, camera = null, rect = null, scratch = null) {
  if (
    !object
    || !position
    || !camera?.matrixWorldInverse
    || !camera?.projectionMatrix
    || !rect?.width
    || !rect?.height
    || !scratch
  ) {
    return null;
  }
  if (typeof object.getVertexPosition === "function") {
    object.getVertexPosition(vertexIndex, scratch);
  } else if (typeof object.applyBoneTransform === "function") {
    if (typeof scratch.fromBufferAttribute === "function") {
      scratch.fromBufferAttribute(position, vertexIndex);
    }
    object.applyBoneTransform(vertexIndex, scratch);
  } else if (typeof object.boneTransform === "function") {
    object.boneTransform(vertexIndex, scratch);
  } else if (typeof scratch.fromBufferAttribute === "function") {
    scratch.fromBufferAttribute(position, vertexIndex);
  } else {
    scratch.x = typeof position.getX === "function" ? position.getX(vertexIndex) : position.array?.[vertexIndex * 3];
    scratch.y = typeof position.getY === "function" ? position.getY(vertexIndex) : position.array?.[vertexIndex * 3 + 1];
    scratch.z = typeof position.getZ === "function" ? position.getZ(vertexIndex) : position.array?.[vertexIndex * 3 + 2];
  }
  if (!Number.isFinite(scratch.x) || !Number.isFinite(scratch.y) || !Number.isFinite(scratch.z)) {
    return null;
  }
  object.localToWorld?.(scratch);
  if (typeof scratch.applyMatrix4 !== "function") {
    return null;
  }
  scratch.applyMatrix4(camera.matrixWorldInverse);
  const viewX = scratch.x;
  const viewY = scratch.y;
  const viewZ = scratch.z;
  const clipW = camera.isPerspectiveCamera ? Math.abs(viewZ) : 1;
  scratch.applyMatrix4(camera.projectionMatrix);
  if (!Number.isFinite(scratch.x) || !Number.isFinite(scratch.y) || !Number.isFinite(scratch.z)) {
    return null;
  }
  return {
    x: (scratch.x * 0.5 + 0.5) * rect.width,
    y: (-scratch.y * 0.5 + 0.5) * rect.height,
    z: scratch.z,
    viewX,
    viewY,
    viewZ,
    clipW
  };
}

function signedArea2(a = null, b = null, c = null) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
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
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function finiteViewPoint(point = null) {
  if (
    Number.isFinite(point?.viewX)
    && Number.isFinite(point?.viewY)
    && Number.isFinite(point?.viewZ)
  ) {
    return {
      x: point.viewX,
      y: point.viewY,
      z: point.viewZ
    };
  }
  if (
    Number.isFinite(point?.x)
    && Number.isFinite(point?.y)
    && Number.isFinite(point?.z)
  ) {
    return {
      x: point.x,
      y: point.y,
      z: point.z
    };
  }
  return null;
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

function interpolateScreenTriangleSurface(screen = null, point = null) {
  if (!Array.isArray(screen) || screen.length < 3) {
    return null;
  }
  const weights = barycentricScreenWeights(point, screen[0], screen[1], screen[2]);
  if (!weights) {
    return null;
  }
  const views = screen.slice(0, 3).map(finiteViewPoint);
  if (!views.every(Boolean)) {
    return null;
  }
  const depth = (
    screen[0].z * weights.w0
    + screen[1].z * weights.w1
    + screen[2].z * weights.w2
  );
  return {
    point: {
      x: point.x,
      y: point.y
    },
    depth,
    view: {
      x: views[0].x * weights.w0 + views[1].x * weights.w1 + views[2].x * weights.w2,
      y: views[0].y * weights.w0 + views[1].y * weights.w1 + views[2].y * weights.w2,
      z: views[0].z * weights.w0 + views[1].z * weights.w1 + views[2].z * weights.w2
    }
  };
}

function screenTriangleSurfaceCentroid(screen = null) {
  if (!Array.isArray(screen) || screen.length < 3) {
    return null;
  }
  const views = screen.slice(0, 3).map(finiteViewPoint);
  if (!views.every(Boolean)) {
    return null;
  }
  return {
    point: {
      x: (screen[0].x + screen[1].x + screen[2].x) / 3,
      y: (screen[0].y + screen[1].y + screen[2].y) / 3
    },
    depth: (screen[0].z + screen[1].z + screen[2].z) / 3,
    view: {
      x: (views[0].x + views[1].x + views[2].x) / 3,
      y: (views[0].y + views[1].y + views[2].y) / 3,
      z: (views[0].z + views[1].z + views[2].z) / 3
    }
  };
}

function pointToSegmentDistance(point = null, start = null, end = null) {
  if (
    !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || !Number.isFinite(start?.x)
    || !Number.isFinite(start?.y)
    || !Number.isFinite(end?.x)
    || !Number.isFinite(end?.y)
  ) {
    return Infinity;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.000001) {
    return pointDistance(point, end);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSq));
  return pointDistance(point, {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t
  });
}

function closestPointOnSegment(point = null, start = null, end = null) {
  if (
    !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || !Number.isFinite(start?.x)
    || !Number.isFinite(start?.y)
    || !Number.isFinite(end?.x)
    || !Number.isFinite(end?.y)
  ) {
    return null;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.000001) {
    return { x: end.x, y: end.y };
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSq));
  return {
    x: start.x + segmentX * t,
    y: start.y + segmentY * t
  };
}

function screenSegmentIntersectionPoint(a = null, b = null, c = null, d = null) {
  if (
    !Number.isFinite(a?.x)
    || !Number.isFinite(a?.y)
    || !Number.isFinite(b?.x)
    || !Number.isFinite(b?.y)
    || !Number.isFinite(c?.x)
    || !Number.isFinite(c?.y)
    || !Number.isFinite(d?.x)
    || !Number.isFinite(d?.y)
  ) {
    return null;
  }
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const cdX = d.x - c.x;
  const cdY = d.y - c.y;
  const denom = abX * cdY - abY * cdX;
  if (Math.abs(denom) <= 0.000001) {
    return null;
  }
  const acX = c.x - a.x;
  const acY = c.y - a.y;
  const t = (acX * cdY - acY * cdX) / denom;
  const u = (acX * abY - acY * abX) / denom;
  if (t < -0.0001 || t > 1.0001 || u < -0.0001 || u > 1.0001) {
    return null;
  }
  return {
    x: a.x + abX * Math.max(0, Math.min(1, t)),
    y: a.y + abY * Math.max(0, Math.min(1, t))
  };
}

function appendUniqueScreenSample(samples = [], point = null, distance = Infinity) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return false;
  }
  const key = `${Math.round(point.x * 4)}:${Math.round(point.y * 4)}`;
  if (samples.some((entry) => entry.key === key)) {
    return false;
  }
  samples.push({
    key,
    point: {
      x: point.x,
      y: point.y
    },
    distance: Number.isFinite(distance) ? distance : Infinity
  });
  return true;
}

function candidateFrontSurfaceSamplePoints(screen = [], segments = [], radiusPixels = 1, limit = 6) {
  if (!Array.isArray(screen) || screen.length < 3) {
    return [];
  }
  const triangle = screen.slice(0, 3);
  const edges = [
    [triangle[0], triangle[1]],
    [triangle[1], triangle[2]],
    [triangle[2], triangle[0]]
  ];
  const radius = Math.max(0.5, Number(radiusPixels) || 0.5);
  const samples = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const start = segment?.start || null;
    const end = segment?.end || null;
    if (!Number.isFinite(start?.x) || !Number.isFinite(start?.y) || !Number.isFinite(end?.x) || !Number.isFinite(end?.y)) {
      continue;
    }
    if (barycentricScreenWeights(start, triangle[0], triangle[1], triangle[2])) {
      appendUniqueScreenSample(samples, start, 0);
    }
    if (barycentricScreenWeights(end, triangle[0], triangle[1], triangle[2])) {
      appendUniqueScreenSample(samples, end, 0);
    }
    for (const [edgeStart, edgeEnd] of edges) {
      const intersection = screenSegmentIntersectionPoint(start, end, edgeStart, edgeEnd);
      if (intersection) {
        appendUniqueScreenSample(samples, intersection, 0);
      }
      const startToEdge = closestPointOnSegment(start, edgeStart, edgeEnd);
      if (startToEdge) {
        appendUniqueScreenSample(samples, startToEdge, pointDistance(start, startToEdge));
      }
      const endToEdge = closestPointOnSegment(end, edgeStart, edgeEnd);
      if (endToEdge) {
        appendUniqueScreenSample(samples, endToEdge, pointDistance(end, endToEdge));
      }
      const edgeStartDistance = pointToSegmentDistance(edgeStart, start, end);
      if (edgeStartDistance <= radius + 1) {
        appendUniqueScreenSample(samples, edgeStart, edgeStartDistance);
      }
      const edgeEndDistance = pointToSegmentDistance(edgeEnd, start, end);
      if (edgeEndDistance <= radius + 1) {
        appendUniqueScreenSample(samples, edgeEnd, edgeEndDistance);
      }
    }
  }
  const centroid = {
    x: (triangle[0].x + triangle[1].x + triangle[2].x) / 3,
    y: (triangle[0].y + triangle[1].y + triangle[2].y) / 3
  };
  const centroidDistance = Math.min(
    ...segments.map((segment) => pointToSegmentDistance(centroid, segment?.start, segment?.end))
  );
  if (centroidDistance <= radius + 1) {
    appendUniqueScreenSample(samples, centroid, centroidDistance);
  }
  return samples
    .filter((entry) => entry.distance <= radius + 1.5)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.max(1, Math.floor(Number(limit) || 1)))
    .map((entry) => entry.point);
}

function pointToSegmentPlacement(point = null, segment = null) {
  const start = segment?.start || null;
  const end = segment?.end || null;
  if (
    !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || !Number.isFinite(start?.x)
    || !Number.isFinite(start?.y)
    || !Number.isFinite(end?.x)
    || !Number.isFinite(end?.y)
  ) {
    return null;
  }
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSq = segmentX * segmentX + segmentY * segmentY;
  if (lengthSq <= 0.000001) {
    return {
      distance: pointDistance(point, end),
      ratio: 1,
      length: 0,
      signedOffset: 0
    };
  }
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSq));
  const length = Math.sqrt(lengthSq);
  const projected = {
    x: start.x + segmentX * ratio,
    y: start.y + segmentY * ratio
  };
  return {
    distance: pointDistance(point, projected),
    ratio,
    length,
    signedOffset: ((point.x - start.x) * segmentY - (point.y - start.y) * segmentX) / length
  };
}

function screenTriangleCenterPoint(triangle = null) {
  const screen = Array.isArray(triangle?.screen) ? triangle.screen : [];
  if (screen.length < 3) {
    return null;
  }
  const points = screen.slice(0, 3);
  if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    return null;
  }
  return {
    x: (points[0].x + points[1].x + points[2].x) / 3,
    y: (points[0].y + points[1].y + points[2].y) / 3
  };
}

function screenTriangleStrokePlacement(triangle = null, segments = []) {
  const center = screenTriangleCenterPoint(triangle);
  if (!center) {
    return { distance: Infinity, progress: 0, signedOffset: 0 };
  }
  let accumulated = 0;
  let best = {
    distance: Infinity,
    progress: 0,
    signedOffset: 0
  };
  for (const segment of Array.isArray(segments) ? segments : []) {
    const placement = pointToSegmentPlacement(center, segment);
    if (placement && placement.distance < best.distance) {
      best = {
        distance: placement.distance,
        progress: accumulated + placement.ratio * Math.max(0, placement.length),
        signedOffset: placement.signedOffset
      };
    }
    accumulated += Number.isFinite(placement?.length) ? Math.max(0, placement.length) : 0;
  }
  return best;
}

function selectScreenTrianglesNearStroke(triangles = [], segments = [], maxTriangles = Infinity, radiusPixels = 1) {
  const limit = Number.isFinite(Number(maxTriangles))
    ? Math.max(1, Math.floor(Number(maxTriangles)))
    : Infinity;
  const source = Array.isArray(triangles) ? triangles : [];
  if (!Number.isFinite(limit) || source.length <= limit) {
    return [...source];
  }
  const annotated = source.map((triangle, index) => {
    const hasStrokePlacement = Number.isFinite(Number(triangle?.screenStrokeProgress))
      && Number.isFinite(Number(triangle?.screenStrokeSignedOffset));
    const placement = hasStrokePlacement
      ? {
          progress: Number(triangle.screenStrokeProgress),
          signedOffset: Number(triangle.screenStrokeSignedOffset),
          distance: Number.isFinite(Number(triangle?.screenStrokeDistance))
            ? Number(triangle.screenStrokeDistance)
            : Infinity
        }
      : screenTriangleStrokePlacement(triangle, segments);
    return {
      index,
      triangle,
      progress: placement.progress,
      signedOffset: placement.signedOffset,
      distance: Number.isFinite(Number(triangle?.screenStrokeDistance))
        ? Number(triangle.screenStrokeDistance)
        : placement.distance,
      depth: Number.isFinite(Number(triangle?.minDepth)) ? Number(triangle.minDepth) : 0
    };
  });
  const minProgress = Math.min(...annotated.map((entry) => entry.progress));
  const maxProgress = Math.max(...annotated.map((entry) => entry.progress));
  const span = Math.max(1, maxProgress - minProgress);
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const selected = [];
  const selectedIndexes = new Set();
  const selectEntry = (entry = null) => {
    if (!entry || selectedIndexes.has(entry.index)) {
      return false;
    }
    selectedIndexes.add(entry.index);
    selected.push(entry);
    return true;
  };
  const chooseNearestToProgress = (targetProgress = 0) => {
    let best = null;
    let bestScore = Infinity;
    for (const entry of annotated) {
      if (selectedIndexes.has(entry.index)) {
        continue;
      }
      const progressScore = Math.abs(entry.progress - targetProgress) / span;
      const distanceScore = Math.max(0, entry.distance || 0) / radius;
      const score = progressScore + distanceScore * 0.25 + Math.max(0, entry.depth) * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return selectEntry(best);
  };
  chooseNearestToProgress(minProgress);
  chooseNearestToProgress(maxProgress);
  const bucketCount = Math.max(4, Math.min(24, Math.ceil(Math.sqrt(limit))));
  const distanceBandCount = 4;
  const buckets = new Map();
  for (const entry of annotated) {
    if (selectedIndexes.has(entry.index)) {
      continue;
    }
    const progressBucket = Math.max(0, Math.min(
      bucketCount - 1,
      Math.floor(((entry.progress - minProgress) / span) * bucketCount)
    ));
    const normalizedDistance = Math.max(0, Math.min(0.999, (entry.distance || 0) / radius));
    const distanceBucket = Math.max(0, Math.min(
      distanceBandCount - 1,
      Math.floor(normalizedDistance * distanceBandCount)
    ));
    const sideBucket = entry.signedOffset < -1 ? 0 : entry.signedOffset > 1 ? 2 : 1;
    const bucketKey = `${progressBucket}:${sideBucket}:${distanceBucket}`;
    const bucket = buckets.get(bucketKey) || [];
    bucket.push(entry);
    buckets.set(bucketKey, bucket);
  }
  const orderedBuckets = [...buckets.values()];
  for (const bucket of orderedBuckets) {
    bucket.sort((left, right) => (
      left.distance - right.distance
      || left.depth - right.depth
      || left.progress - right.progress
    ));
  }
  let advanced = true;
  while (selected.length < limit && advanced) {
    advanced = false;
    for (const bucket of orderedBuckets) {
      while (bucket.length && selectedIndexes.has(bucket[0].index)) {
        bucket.shift();
      }
      if (!bucket.length) {
        continue;
      }
      if (selectEntry(bucket.shift())) {
        advanced = true;
      }
      if (selected.length >= limit) {
        break;
      }
    }
  }
  annotated.sort((left, right) => (
    left.distance - right.distance
    || left.depth - right.depth
    || left.progress - right.progress
  ));
  for (const entry of annotated) {
    if (selected.length >= limit) {
      break;
    }
    selectEntry(entry);
  }
  return selected
    .sort((left, right) => (
      left.progress - right.progress
      || left.distance - right.distance
      || left.depth - right.depth
    ))
    .map((entry) => entry.triangle);
}

function barycentricScreenWeights(point = null, a = null, b = null, c = null) {
  if (!point || !a || !b || !c) {
    return null;
  }
  const area = signedArea2(a, b, c);
  if (Math.abs(area) <= 0.0001) {
    return null;
  }
  const w0 = signedArea2(point, b, c) / area;
  const w1 = signedArea2(point, c, a) / area;
  const w2 = 1 - w0 - w1;
  const tolerance = -0.0015;
  return w0 >= tolerance && w1 >= tolerance && w2 >= tolerance
    ? { w0, w1, w2 }
    : null;
}

function pointToTriangleDistance(point = null, triangle = []) {
  if (!point || !Array.isArray(triangle) || triangle.length < 3) {
    return Infinity;
  }
  const weights = barycentricScreenWeights(point, triangle[0], triangle[1], triangle[2]);
  if (weights) {
    return 0;
  }
  return Math.min(
    pointToSegmentDistance(point, triangle[0], triangle[1]),
    pointToSegmentDistance(point, triangle[1], triangle[2]),
    pointToSegmentDistance(point, triangle[2], triangle[0])
  );
}

function screenTriangleDistanceToSegment(screen = [], segment = null) {
  if (!Array.isArray(screen) || screen.length < 3 || !segment?.start || !segment?.end) {
    return Infinity;
  }
  return Math.min(
    pointToTriangleDistance(segment.start, screen),
    pointToTriangleDistance(segment.end, screen),
    pointToSegmentDistance(screen[0], segment.start, segment.end),
    pointToSegmentDistance(screen[1], segment.start, segment.end),
    pointToSegmentDistance(screen[2], segment.start, segment.end)
  );
}

function rangeDistance(minLeft = 0, maxLeft = 0, minRight = 0, maxRight = 0) {
  if (maxLeft < minRight) {
    return minRight - maxLeft;
  }
  if (maxRight < minLeft) {
    return minLeft - maxRight;
  }
  return 0;
}

function screenBoxDistanceToSegment(bounds = null, segment = null) {
  if (
    !Number.isFinite(bounds?.minX)
    || !Number.isFinite(bounds?.minY)
    || !Number.isFinite(bounds?.maxX)
    || !Number.isFinite(bounds?.maxY)
    || !Number.isFinite(segment?.start?.x)
    || !Number.isFinite(segment?.start?.y)
    || !Number.isFinite(segment?.end?.x)
    || !Number.isFinite(segment?.end?.y)
  ) {
    return Infinity;
  }
  const segmentMinX = Math.min(segment.start.x, segment.end.x);
  const segmentMaxX = Math.max(segment.start.x, segment.end.x);
  const segmentMinY = Math.min(segment.start.y, segment.end.y);
  const segmentMaxY = Math.max(segment.start.y, segment.end.y);
  const dx = rangeDistance(bounds.minX, bounds.maxX, segmentMinX, segmentMaxX);
  const dy = rangeDistance(bounds.minY, bounds.maxY, segmentMinY, segmentMaxY);
  return Math.sqrt(dx * dx + dy * dy);
}

function projectionFrameKey(editor = null, rect = null) {
  if (typeof editor?.textureAirbrushDepthCacheKey === "function") {
    return editor.textureAirbrushDepthCacheKey(rect);
  }
  return [
    Math.round(rect?.width || 0),
    Math.round(rect?.height || 0),
    Number(editor?.textureAirbrushCameraPrewarmSerial) || 0,
    Number(editor?.progress) || 0
  ].join(":");
}

function stableScreenHitKeyNumber(value = 0, digits = 7) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "0";
}

function screenHitPointCacheKey(point = null, tool = "airbrush", options = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return "";
  }
  return [
    options.firstOnly === true ? "first" : "all",
    options.firstOnly === true ? "" : Math.max(0, Math.floor(Number(options.maxHits) || 0)),
    options.skipTransparentTextureHits === false ? "all-texels" : "visible-texels",
    options.includeBackFacingTriangles === true ? "two-sided" : "front-facing",
    tool || "airbrush",
    Math.round(point.x * 4),
    Math.round(point.y * 4)
  ].join(":");
}

function screenTriangleIndexKey(triangle = null) {
  if (!triangle) {
    return "";
  }
  return [
    triangle.object?.uuid || triangle.object?.id || "object",
    triangle.faceIndex ?? "face",
    triangle.face?.a ?? "a",
    triangle.face?.b ?? "b",
    triangle.face?.c ?? "c",
    triangle.face?.materialIndex ?? 0
  ].join(":");
}

function rememberScreenHitCacheEntry(index = null, key = "", hits = []) {
  if (!index || !key) {
    return hits;
  }
  index.hitCache ||= new Map();
  index.hitCache.set(key, hits);
  if (index.hitCache.size > TEXTURE_AIRBRUSH_SCREEN_HIT_CACHE_LIMIT) {
    index.hitCache.delete(index.hitCache.keys().next().value);
  }
  return hits;
}

function screenHitIndexViewKey(editor = null, rect = null) {
  if (!rect || !editor?.camera) {
    return "";
  }
  editor.camera.updateMatrixWorld?.(true);
  const inverseElements = editor.camera.matrixWorldInverse?.elements;
  const projectionElements = editor.camera.projectionMatrix?.elements;
  if (
    !inverseElements
    || !projectionElements
    || typeof inverseElements[Symbol.iterator] !== "function"
    || typeof projectionElements[Symbol.iterator] !== "function"
  ) {
    return [
      Math.round(rect.width || 0),
      Math.round(rect.height || 0),
      Number(editor?.textureAirbrushCameraPrewarmSerial) || 0
    ].join(":");
  }
  const pixelRatio = editor.renderer?.getPixelRatio?.() || 1;
  const matrixKey = [
    ...inverseElements,
    ...projectionElements
  ].map((value) => stableScreenHitKeyNumber(value, 7)).join(",");
  return [
    Math.round((rect.width || 0) * pixelRatio),
    Math.round((rect.height || 0) * pixelRatio),
    matrixKey
  ].join(":");
}

export function installTextureAirbrushPointerMethods(BirdWeightEditor) {
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

    textureAirbrushHitTextureAlpha(record = null, hit = null, options = {}) {
      return textureAirbrushHitTextureAlpha(this, record, hit, options);
    },

    textureAirbrushHitHasVisibleTexel(record = null, hit = null, options = {}) {
      return textureAirbrushHitHasVisibleTexel(this, record, hit, options);
    },

    textureAirbrushSurfaceAnchorForPaintHit(paintHit = null, event = null, radiusPixels = 1) {
      const record = paintHit?.record || null;
      const hit = paintHit?.hit || null;
      const rect = this.canvas?.getBoundingClientRect?.() || null;
      if (!record || !hit?.face || !rect?.width || !rect?.height || !this.camera) {
        return null;
      }
      const screenPoint = Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
        ? {
            x: event.clientX - (Number(rect.left) || 0),
            y: event.clientY - (Number(rect.top) || 0)
          }
        : null;
      const surface = screenPoint
        ? interpolateScreenTriangleSurface(hit.screen, screenPoint)
        : null;
      let view = surface?.view || null;
      if (
        !view
        && Number.isFinite(hit.point?.x)
        && Number.isFinite(hit.point?.y)
        && Number.isFinite(hit.point?.z)
        && this.camera.matrixWorldInverse
      ) {
        const transformed = new Vector3(hit.point.x, hit.point.y, hit.point.z);
        transformed.applyMatrix4(this.camera.matrixWorldInverse);
        if (Number.isFinite(transformed.x) && Number.isFinite(transformed.y) && Number.isFinite(transformed.z)) {
          view = { x: transformed.x, y: transformed.y, z: transformed.z };
        }
      }
      if (!view) {
        return null;
      }
      let normal = viewNormalForScreenTriangle(hit.screen);
      const object = hit.object || record.object || null;
      if (
        !normal
        && Number.isFinite(hit.face.normal?.x)
        && Number.isFinite(hit.face.normal?.y)
        && Number.isFinite(hit.face.normal?.z)
        && object?.matrixWorld
        && this.camera.matrixWorldInverse
      ) {
        const transformed = new Vector3(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z);
        transformed.transformDirection(object.matrixWorld);
        transformed.transformDirection(this.camera.matrixWorldInverse);
        if (Number.isFinite(transformed.x) && Number.isFinite(transformed.y) && Number.isFinite(transformed.z)) {
          normal = { x: transformed.x, y: transformed.y, z: transformed.z };
        }
      }
      const componentState = this.textureAirbrushNeighborComponentState?.(record) || null;
      const faceVertices = (Array.isArray(hit.face.vertices)
        ? hit.face.vertices
        : [hit.face.a, hit.face.b, hit.face.c])
        .filter((vertexIndex) => Number.isInteger(vertexIndex));
      const componentCounts = new Map();
      for (const vertexIndex of faceVertices) {
        const componentId = Math.floor(Number(componentState?.componentIds?.[vertexIndex]));
        if (componentId >= 0) {
          componentCounts.set(componentId, (componentCounts.get(componentId) || 0) + 1);
        }
      }
      let component = -1;
      let componentCount = 0;
      for (const [componentId, count] of componentCounts) {
        if (count > componentCount) {
          component = componentId;
          componentCount = count;
        }
      }
      const viewRadiusPixels = viewRadiusForScreenRadius(
        this.camera,
        rect,
        view.z,
        radiusPixels
      );
      return {
        view: { x: view.x, y: view.y, z: view.z },
        ...(normal ? { normal } : {}),
        ...(Number.isFinite(viewRadiusPixels) && viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
        ...(component >= 0 ? { component } : {})
      };
    },

    textureAirbrushSurfaceAnchorAtClientPoint(point = null, anchor = null) {
      const rect = this.canvas?.getBoundingClientRect?.() || null;
      const viewZ = Number(anchor?.view?.z);
      const projectionInverse = this.camera?.projectionMatrixInverse || null;
      if (
        !Number.isFinite(point?.clientX)
        || !Number.isFinite(point?.clientY)
        || !Number.isFinite(viewZ)
        || !rect?.width
        || !rect?.height
        || !projectionInverse
      ) {
        return null;
      }
      const ndcX = ((point.clientX - (Number(rect.left) || 0)) / rect.width) * 2 - 1;
      const ndcY = -((point.clientY - (Number(rect.top) || 0)) / rect.height) * 2 + 1;
      const viewRay = new Vector3(ndcX, ndcY, 0).applyMatrix4(projectionInverse);
      let viewX = viewRay.x;
      let viewY = viewRay.y;
      if (this.camera?.isPerspectiveCamera === true) {
        if (!Number.isFinite(viewRay.z) || Math.abs(viewRay.z) <= 0.000001) {
          return null;
        }
        const scale = viewZ / viewRay.z;
        viewX *= scale;
        viewY *= scale;
      }
      if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) {
        return null;
      }
      return {
        ...anchor,
        view: { x: viewX, y: viewY, z: viewZ }
      };
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

    texturePaintHitForEvent(event, tool = this.activeTool, options = {}) {
      if (!event || !this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const canUseScreenHitIndex = options.useScreenHitIndex !== false
        && (tool === "airbrush" || tool === "texture-eraser" || tool === "eyedropper")
        && !this.texturePaintToolUsesRegion?.(tool);
      if (canUseScreenHitIndex) {
        const allowAnimationProgressMismatch = options.allowAnimationProgressMismatch === true
          || this.painting === true
          || this.textureAirbrushScreenStrokeHasPendingWork?.() === true;
        if (tool === "eyedropper") {
          const indexedHits = this.textureAirbrushScreenHitsForEvent?.(event, tool, {
            rect,
            allowAnimationProgressMismatch,
            firstOnly: false,
            maxHits: 8,
            skipTransparentTextureHits: options.skipTransparentTextureHits,
            includeBackFacingTriangles: options.includeBackFacingTriangles
          }) || [];
          const indexedHit = indexedHits[0] || null;
          if (indexedHit?.record && indexedHit?.hit) {
            indexedHit.hit.texturePaintAlternativeHits = indexedHits.slice(1);
            return indexedHit;
          }
        }
        const indexedHits = this.textureAirbrushScreenHitsForEvent?.(event, tool, {
          rect,
          allowAnimationProgressMismatch,
          firstOnly: true,
          skipTransparentTextureHits: options.skipTransparentTextureHits,
          includeBackFacingTriangles: options.includeBackFacingTriangles
        }) || [];
        const indexedHit = indexedHits[0] || null;
        if (indexedHit?.record && indexedHit?.hit) {
          return indexedHit;
        }
        const screenIndexReady = this.textureAirbrushScreenHitIndexCurrent?.(
          this.textureAirbrushScreenHitIndex,
          rect,
          { allowAnimationProgressMismatch }
        ) === true;
        if (
          screenIndexReady
          && (tool === "airbrush" || tool === "texture-eraser")
          && options.raycastFallbackOnScreenMiss !== true
        ) {
          return null;
        }
      }
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      if (options.refreshSkinnedBounds !== false) {
        this.refreshSkinnedRaycastBounds();
      }

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

      const textureRecords = tool === "airbrush" || tool === "texture-eraser" || tool === "eyedropper"
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
      const textureHit = this.texturePaintHitFromIntersections?.(intersections) || null;
      if (tool === "eyedropper" && textureHit?.hit) {
        const alternatives = [];
        for (const intersection of intersections.slice(0, 12)) {
          const candidate = this.texturePaintHitFromIntersections?.([intersection]) || null;
          if (
            candidate?.record
            && candidate?.hit
            && candidate.hit !== textureHit.hit
          ) {
            alternatives.push(candidate);
          }
          if (alternatives.length >= 7) {
            break;
          }
        }
        textureHit.hit.texturePaintAlternativeHits = alternatives;
      }
      return textureHit;
    },

    textureAirbrushInvalidateScreenHitIndex() {
      this.textureAirbrushScreenHitIndex = null;
      return true;
    },

    textureAirbrushScreenHitIndexCurrent(index = this.textureAirbrushScreenHitIndex, rect = this.canvas?.getBoundingClientRect?.(), options = {}) {
      if (!index || !this.canvas || !this.camera || !this.model || !rect?.width || !rect?.height) {
        return false;
      }
      const matchesView = index.canvas === this.canvas
        && index.camera === this.camera
        && index.model === this.model
        && index.rect?.width === rect.width
        && index.rect?.height === rect.height
        && index.rect?.left === rect.left
        && index.rect?.top === rect.top;
      if (!matchesView) {
        return false;
      }
      const frameKey = projectionFrameKey(this, rect);
      if (index.key === frameKey) {
        return true;
      }
      if (options.allowAnimationProgressMismatch !== true) {
        return false;
      }
      const viewKey = screenHitIndexViewKey(this, rect);
      return Boolean(viewKey && index.viewKey && index.viewKey === viewKey);
    },

    textureAirbrushBuildScreenHitIndex(options = {}) {
      const rect = options.rect || this.canvas?.getBoundingClientRect?.();
      if (!this.canvas || !this.camera || !this.model || !rect?.width || !rect?.height) {
        this.textureAirbrushScreenHitIndex = null;
        return null;
      }
      if (options.reuse !== false && this.textureAirbrushScreenHitIndexCurrent?.(this.textureAirbrushScreenHitIndex, rect, options)) {
        return this.textureAirbrushScreenHitIndex;
      }
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => (
        record?.object
        && record.geometry?.attributes?.position
        && record.geometry?.attributes?.uv
      ));
      if (!paintRecords.length) {
        this.textureAirbrushScreenHitIndex = null;
        return null;
      }
      this.model.updateMatrixWorld?.(true);
      const cellSize = Math.max(16, Math.floor(Number(options.cellSize) || TEXTURE_AIRBRUSH_SCREEN_HIT_CELL_SIZE));
      const columnCount = Math.max(1, Math.ceil(rect.width / cellSize));
      const rowCount = Math.max(1, Math.ceil(rect.height / cellSize));
      const cells = new Map();
      const scratch = new (globalThis.THREE?.Vector3 || Vector3)();
      const addTriangleToCell = (column, row, triangle) => {
        if (column < 0 || row < 0 || column >= columnCount || row >= rowCount) {
          return;
        }
        const key = `${column}:${row}`;
        const entries = cells.get(key) || [];
        entries.push(triangle);
        cells.set(key, entries);
      };
      for (const record of paintRecords) {
        const object = record.object;
        const geometry = record.geometry || object?.geometry || null;
        const position = geometry?.attributes?.position || null;
        const uvAttribute = geometry?.attributes?.uv || null;
        const indexAttribute = geometry?.index || null;
        const vertexCount = attributeCount(position);
        const triangleCount = indexAttribute
          ? Math.floor(attributeCount(indexAttribute) / 3)
          : Math.floor(vertexCount / 3);
        if (!object || !position || !uvAttribute || triangleCount <= 0) {
          continue;
        }
        object.updateMatrixWorld?.(true);
        const screenPoints = new Array(vertexCount);
        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
          screenPoints[vertexIndex] = projectedVertexPoint(object, position, vertexIndex, this.camera, rect, scratch);
        }
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
          const vertices = indexAttribute
            ? [
                attributeIndexValue(indexAttribute, triangleIndex * 3),
                attributeIndexValue(indexAttribute, triangleIndex * 3 + 1),
                attributeIndexValue(indexAttribute, triangleIndex * 3 + 2)
              ]
            : [
                triangleIndex * 3,
                triangleIndex * 3 + 1,
                triangleIndex * 3 + 2
              ];
          if (!vertices.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount)) {
            continue;
          }
          const screen = vertices.map((index) => screenPoints[index]);
          const uvs = vertices.map((index) => attributePoint2(uvAttribute, index));
          if (
            !screen.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z))
            || !uvs.every(Boolean)
          ) {
            continue;
          }
          if (screen.every((point) => point.z < -1 || point.z > 1)) {
            continue;
          }
          const materialIndex = materialIndexForScreenHitTriangle(geometry, triangleIndex);
          const materialSide = materialSideForScreenHitTriangle(record, geometry, triangleIndex);
          const matchesMaterialSide = screenTriangleMatchesMaterialSide(screen, materialSide);
          const minX = Math.min(screen[0].x, screen[1].x, screen[2].x);
          const maxX = Math.max(screen[0].x, screen[1].x, screen[2].x);
          const minY = Math.min(screen[0].y, screen[1].y, screen[2].y);
          const maxY = Math.max(screen[0].y, screen[1].y, screen[2].y);
          if (maxX < 0 || maxY < 0 || minX > rect.width || minY > rect.height) {
            continue;
          }
          const triangle = {
            record,
            object,
            faceIndex: triangleIndex,
            face: {
              a: vertices[0],
              b: vertices[1],
              c: vertices[2],
              materialIndex
            },
            screen,
            uvs,
            minX,
            minY,
            maxX,
            maxY,
            coverage: cameraFacingCoverageForScreenIndexTriangle(screen),
            matchesMaterialSide,
            minDepth: Math.min(screen[0].z, screen[1].z, screen[2].z)
          };
          const startColumn = Math.max(0, Math.floor(minX / cellSize));
          const endColumn = Math.min(columnCount - 1, Math.floor(maxX / cellSize));
          const startRow = Math.max(0, Math.floor(minY / cellSize));
          const endRow = Math.min(rowCount - 1, Math.floor(maxY / cellSize));
          for (let row = startRow; row <= endRow; row += 1) {
            for (let column = startColumn; column <= endColumn; column += 1) {
              addTriangleToCell(column, row, triangle);
            }
          }
        }
      }
      for (const entries of cells.values()) {
        entries.sort((left, right) => left.minDepth - right.minDepth);
      }
      this.textureAirbrushScreenHitIndex = {
        canvas: this.canvas,
        camera: this.camera,
        model: this.model,
        key: projectionFrameKey(this, rect),
        viewKey: screenHitIndexViewKey(this, rect),
        rect: {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          top: rect.top
        },
        cellSize,
        columnCount,
        rowCount,
        cells
      };
      return this.textureAirbrushScreenHitIndex;
    },

    textureAirbrushScreenTrianglesNearSegments(segments = [], radiusPixels = 1, options = {}) {
      if (!this.canvas || !this.camera || !this.model) {
        return [];
      }
      const rect = options.rect || this.canvas.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height) {
        return [];
      }
      const allowAnimationProgressMismatch = options.allowAnimationProgressMismatch === true
        || this.painting === true
        || this.textureAirbrushScreenStrokeHasPendingWork?.() === true;
      const debugCounts = options.debugCounts && typeof options.debugCounts === "object"
        ? options.debugCounts
        : null;
      const addDebugCount = (key, amount = 1) => {
        if (!debugCounts) {
          return;
        }
        debugCounts[key] = Math.max(0, Math.floor(Number(debugCounts[key]) || 0)) + amount;
      };
      const indexBuildStarted = typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
      const hadCurrentIndex = this.textureAirbrushScreenHitIndexCurrent?.(
        this.textureAirbrushScreenHitIndex,
        rect,
        { allowAnimationProgressMismatch }
      ) === true;
      const index = this.textureAirbrushBuildScreenHitIndex?.({
        rect,
        allowAnimationProgressMismatch
      });
      const indexBuildMs = Math.max(
        0,
        (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()) - indexBuildStarted
      );
      addDebugCount(hadCurrentIndex ? "screenIndexReuseCount" : "screenIndexBuildCount");
      addDebugCount(hadCurrentIndex ? "screenIndexReuseMs" : "screenIndexBuildMs", Math.round(indexBuildMs));
      if (!index?.cells || !index.cellSize || !index.columnCount || !index.rowCount) {
        return [];
      }
      const radius = Math.max(0.5, Number(radiusPixels) || 0.5);
      const rawSourceSegments = (Array.isArray(segments) ? segments : [])
        .map((segment) => ({
          start: Number.isFinite(segment?.start?.x) && Number.isFinite(segment?.start?.y)
            ? { x: segment.start.x, y: segment.start.y }
            : null,
          end: Number.isFinite(segment?.end?.x) && Number.isFinite(segment?.end?.y)
            ? { x: segment.end.x, y: segment.end.y }
            : null,
          radiusPixels: Math.max(0.5, Number(segment?.radiusPixels) || radius)
        }))
        .filter((segment) => segment.start && segment.end);
      const maxVisibilityQuerySegments = Math.max(
        8,
        Math.min(64, Math.floor(Number(options.maxVisibilityQuerySegments) || 8))
      );
      const sampleVisibilitySegments = (source = []) => {
        if (!Array.isArray(source) || source.length <= maxVisibilityQuerySegments) {
          return source;
        }
        const sampled = [];
        const stride = Math.max(1, Math.ceil(source.length / Math.max(1, maxVisibilityQuerySegments - 1)));
        for (let indexValue = 0; indexValue < source.length && sampled.length < maxVisibilityQuerySegments - 1; indexValue += stride) {
          sampled.push(source[indexValue]);
        }
        const last = source[source.length - 1];
        if (last && sampled[sampled.length - 1] !== last) {
          sampled.push(last);
        }
        return sampled.length ? sampled : source.slice(0, maxVisibilityQuerySegments);
      };
      const sourceSegments = sampleVisibilitySegments(rawSourceSegments);
      if (!sourceSegments.length) {
        return [];
      }
      if (rawSourceSegments.length > sourceSegments.length) {
        addDebugCount("screenIndexQuerySegmentsInput", rawSourceSegments.length);
        addDebugCount("screenIndexQuerySegmentsSampled", sourceSegments.length);
      }
      let minX = rect.width;
      let minY = rect.height;
      let maxX = 0;
      let maxY = 0;
      for (const segment of sourceSegments) {
        const pad = Math.max(radius, segment.radiusPixels);
        minX = Math.min(minX, segment.start.x - pad, segment.end.x - pad);
        minY = Math.min(minY, segment.start.y - pad, segment.end.y - pad);
        maxX = Math.max(maxX, segment.start.x + pad, segment.end.x + pad);
        maxY = Math.max(maxY, segment.start.y + pad, segment.end.y + pad);
      }
      if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
        return [];
      }
      if (maxX < 0 || maxY < 0 || minX > rect.width || minY > rect.height) {
        return [];
      }
      const materialIndex = Number.isFinite(Number(options.materialIndex))
        ? Math.max(0, Math.floor(Number(options.materialIndex)))
        : null;
      const sourceMaterial = options.material || null;
      const sourceEditable = options.editable || null;
      const materialMatchCache = new Map();
      const triangleMatchesMaterialTarget = (triangle = null) => {
        if (materialIndex === null) {
          return true;
        }
        const triangleMaterialIndex = Math.max(0, Math.floor(Number(triangle?.face?.materialIndex) || 0));
        if (triangleMaterialIndex === materialIndex) {
          return true;
        }
        if (materialMatchCache.has(triangleMaterialIndex)) {
          return materialMatchCache.get(triangleMaterialIndex);
        }
        const triangleMaterial = materialForScreenHitTriangle(triangle?.record, triangleMaterialIndex);
        const matches = materialMatchesEditablePaintTarget(this, triangleMaterial, sourceEditable, sourceMaterial);
        materialMatchCache.set(triangleMaterialIndex, matches);
        return matches;
      };
      const surfaceContinuityFilter = options.surfaceContinuityFilter === true;
      const surfaceContinuitySamplesIgnoreMaterial = options.surfaceContinuitySamplesIgnoreMaterial === true;
      const frontSurfaceFilter = options.frontSurfaceFilter === false
        ? false
        : options.frontSurfaceFilter === true || surfaceContinuityFilter;
      const continuityScale = Math.max(
        0.35,
        Number(options.surfaceContinuityRadiusScale) || 1.05
      );
      const continuityDepthWindow = Math.max(
        0.004,
        Number(options.surfaceContinuityDepthWindow) || 0.012
      );
      const continuityNormalDot = Math.max(
        -1,
        Math.min(1, Number(options.surfaceContinuityNormalDot) || 0.58)
      );
      const maxSurfaceSamples = Math.max(
        2,
        Math.min(96, Math.floor(Number(options.maxSurfaceContinuitySamples) || 56))
      );
      const record = options.record || null;
      const maxTriangles = Number.isFinite(Number(options.maxTriangles))
        ? Math.max(1, Math.floor(Number(options.maxTriangles)))
        : Number.isFinite(Number(options.maxScreenTriangles))
          ? Math.max(1, Math.floor(Number(options.maxScreenTriangles)))
          : Infinity;
      const skipTransparentTextureTriangles = options.skipTransparentTextureTriangles !== false;
      const alphaSampleCache = index.textureVisibilityAlphaCache ||= new Map();
      const hitForTriangleAtPoint = (triangle = null, point = null) => {
        if (!triangle?.record || !Array.isArray(triangle?.screen) || !Array.isArray(triangle?.uvs)) {
          return null;
        }
        const weights = barycentricScreenWeights(point, triangle.screen[0], triangle.screen[1], triangle.screen[2]);
        if (!weights) {
          return null;
        }
        return {
          object: triangle.object,
          uv: new (globalThis.THREE?.Vector2 || Vector2)(
            triangle.uvs[0].x * weights.w0 + triangle.uvs[1].x * weights.w1 + triangle.uvs[2].x * weights.w2,
            triangle.uvs[0].y * weights.w0 + triangle.uvs[1].y * weights.w1 + triangle.uvs[2].y * weights.w2
          ),
          face: triangle.face,
          faceIndex: triangle.faceIndex,
          screen: triangle.screen,
          point: null
        };
      };
      const triangleHasVisibleTexelAtPoint = (triangle = null, point = null) => {
        if (!skipTransparentTextureTriangles) {
          return true;
        }
        const hit = hitForTriangleAtPoint(triangle, point);
        if (!hit) {
          return true;
        }
        return textureAirbrushHitHasVisibleTexel(this, triangle.record, hit, {
          cache: alphaSampleCache
        });
      };
      const surfaceSampleCache = new Map();
      const triangleSurfaceCache = new WeakMap();
      const cachedTriangleSurfaceInfo = (triangle = null) => {
        if (!triangle || !Array.isArray(triangle.screen)) {
          return null;
        }
        if (triangleSurfaceCache.has(triangle)) {
          return triangleSurfaceCache.get(triangle);
        }
        const info = {
          bounds: triangleScreenBounds(triangle),
          centroid: screenTriangleSurfaceCentroid(triangle.screen),
          normal: viewNormalForScreenTriangle(triangle.screen),
          vertexSurfaces: triangle.screen
            .slice(0, 3)
            .map((point) => {
              const view = finiteViewPoint(point);
              return view
                ? {
                    point: { x: point.x, y: point.y },
                    depth: point.z,
                    view
                  }
                : null;
            })
            .filter(Boolean)
        };
        triangleSurfaceCache.set(triangle, info);
        return info;
      };
      const surfaceSampleAtPoint = (point = null, radiusForPoint = radius) => {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
          return null;
        }
        if (point.x < 0 || point.y < 0 || point.x > rect.width || point.y > rect.height) {
          return null;
        }
        const sampleCacheKey = [
          Math.round(point.x * 2),
          Math.round(point.y * 2),
          Math.round(Math.max(0.5, Number(radiusForPoint) || radius) * 2),
          surfaceContinuitySamplesIgnoreMaterial ? "all" : "material",
          options.includeBackFacingTriangles === true ? "two-sided" : "front"
        ].join(":");
        if (surfaceSampleCache.has(sampleCacheKey)) {
          return surfaceSampleCache.get(sampleCacheKey);
        }
        const column = Math.max(0, Math.min(index.columnCount - 1, Math.floor(point.x / index.cellSize)));
        const row = Math.max(0, Math.min(index.rowCount - 1, Math.floor(point.y / index.cellSize)));
        let best = null;
        let bestTransparent = null;
        for (const triangle of index.cells.get(`${column}:${row}`) || []) {
          if (record && triangle.record !== record) {
            continue;
          }
          if (triangle.matchesMaterialSide === false && options.includeBackFacingTriangles !== true) {
            continue;
          }
          if (!surfaceContinuitySamplesIgnoreMaterial && !triangleMatchesMaterialTarget(triangle)) {
            continue;
          }
          const surface = interpolateScreenTriangleSurface(triangle.screen, point);
          if (!surface || !Number.isFinite(surface.depth)) {
            continue;
          }
          const radiusPixelsForSample = Math.max(0.5, Number(radiusForPoint) || radius);
          const radiusWorld = viewRadiusForScreenRadius(
            this.camera,
            rect,
            surface.view?.z,
            radiusPixelsForSample
          );
          const sample = {
            point: {
              x: point.x,
              y: point.y
            },
            depth: surface.depth,
            view: surface.view,
            radiusPixels: radiusPixelsForSample,
            radiusWorld,
            triangle
          };
          if (!triangleHasVisibleTexelAtPoint(triangle, point)) {
            if (!bestTransparent || surface.depth < bestTransparent.depth) {
              bestTransparent = sample;
            }
            continue;
          }
          if (!best || surface.depth < best.depth) {
            best = sample;
          }
        }
        best ||= bestTransparent;
        surfaceSampleCache.set(sampleCacheKey, best);
        return best;
      };
      const surfaceSamples = [];
      const surfaceSampleKeys = new Set();
      const rememberSurfaceSample = (sample = null) => {
        if (
          !sample
          || !Number.isFinite(sample.point?.x)
          || !Number.isFinite(sample.point?.y)
          || !Number.isFinite(sample.view?.x)
          || !Number.isFinite(sample.view?.y)
          || !Number.isFinite(sample.view?.z)
        ) {
          return false;
        }
        const key = `${Math.round(sample.point.x * 2)}:${Math.round(sample.point.y * 2)}`;
        if (surfaceSampleKeys.has(key)) {
          return false;
        }
        surfaceSampleKeys.add(key);
        surfaceSamples.push(sample);
        return true;
      };
      if (surfaceContinuityFilter) {
        for (const segment of sourceSegments) {
          if (surfaceSamples.length >= maxSurfaceSamples) {
            break;
          }
          const segmentLength = pointDistance(segment.start, segment.end);
          const segmentRadius = Math.max(radius, Number(segment.radiusPixels) || radius);
          const step = Math.max(8, Math.min(24, segmentRadius * 0.28));
          const sampleCount = segmentLength <= 0.001
            ? 1
            : Math.max(1, Math.min(16, Math.ceil(segmentLength / step)));
          for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
            if (surfaceSamples.length >= maxSurfaceSamples) {
              break;
            }
            const t = sampleCount <= 0 ? 0 : sampleIndex / sampleCount;
            const point = {
              x: segment.start.x + (segment.end.x - segment.start.x) * t,
              y: segment.start.y + (segment.end.y - segment.start.y) * t
            };
            rememberSurfaceSample(surfaceSampleAtPoint(point, segmentRadius));
          }
        }
      }
      const candidateSurfaceContinuityAllowed = (triangle = null, distance = Infinity) => {
        if (!surfaceContinuityFilter || !surfaceSamples.length || !Array.isArray(triangle?.screen)) {
          return true;
        }
        const candidateInfo = cachedTriangleSurfaceInfo(triangle);
        const candidateNormal = candidateInfo?.normal || null;
        for (const sample of surfaceSamples) {
          const sampleNormal = cachedTriangleSurfaceInfo(sample?.triangle)?.normal || null;
          const normalDot = viewNormalDot(candidateNormal, sampleNormal);
          if (normalDot != null && normalDot < continuityNormalDot) {
            continue;
          }
          const sampleToTriangle = pointToTriangleDistance(sample.point, triangle.screen);
          const sampleRadiusPixels = Math.max(radius, Number(sample.radiusPixels) || radius);
          if (sampleToTriangle > sampleRadiusPixels + 2) {
            continue;
          }
          const samePixelSurface = interpolateScreenTriangleSurface(triangle.screen, sample.point);
          const surfaces = samePixelSurface
            ? [samePixelSurface]
            : [
                ...(candidateInfo?.centroid ? [candidateInfo.centroid] : []),
                ...(candidateInfo?.vertexSurfaces || [])
              ];
          for (const surface of surfaces) {
            const screenGap = samePixelSurface
              ? 0
              : Math.min(
                  pointDistance(surface.point, sample.point),
                  Number.isFinite(distance) ? distance : Infinity,
                  sampleToTriangle
                );
            const gapWorld = viewRadiusForScreenRadius(this.camera, rect, sample.view?.z, screenGap);
            const maxViewDistance = Math.max(
              0.015,
              (Number(sample.radiusWorld) || 0) * continuityScale + gapWorld * 0.28
            );
            const maxDepthDelta = continuityDepthWindow
              + Math.min(0.04, (screenGap / Math.max(1, sampleRadiusPixels)) * continuityDepthWindow * 0.85);
            if (
              viewPointDistance(surface.view, sample.view) <= maxViewDistance
              && (
                !Number.isFinite(surface.depth)
                || !Number.isFinite(sample.depth)
                || Math.abs(surface.depth - sample.depth) <= maxDepthDelta
              )
            ) {
              return true;
            }
          }
        }
        return false;
      };
      const candidateFrontSurfaceVisible = (triangle = null) => {
        if (!frontSurfaceFilter || !Array.isArray(triangle?.screen)) {
          return true;
        }
        const candidateKey = screenTriangleIndexKey(triangle);
        const samplePoints = candidateFrontSurfaceSamplePoints(
          triangle.screen,
          sourceSegments,
          radius,
          Math.max(3, Math.min(8, Math.floor(Number(options.maxFrontSurfaceSamples) || 3)))
        );
        if (!samplePoints.length) {
          return false;
        }
        const depthWindow = Math.max(
          0.00035,
          Number(options.frontSurfaceDepthWindow) || 0.0018
        );
        let sampled = false;
        for (const point of samplePoints) {
          const surface = interpolateScreenTriangleSurface(triangle.screen, point);
          if (!surface || !Number.isFinite(surface.depth)) {
            continue;
          }
          const nearest = surfaceSampleAtPoint(point, radius);
          if (!nearest || !Number.isFinite(nearest.depth)) {
            continue;
          }
          sampled = true;
          if (screenTriangleIndexKey(nearest.triangle) === candidateKey) {
            return true;
          }
          if (
            Number.isFinite(surface.depth)
            && surface.depth <= nearest.depth + depthWindow
          ) {
            return true;
          }
        }
        return false;
      };
      const triangleScreenBounds = (triangle = null) => {
        if (!Array.isArray(triangle?.screen) || triangle.screen.length < 3) {
          return null;
        }
        const points = triangle.screen.slice(0, 3);
        if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
          return null;
        }
        return {
          minX: Math.min(...points.map((point) => point.x)),
          minY: Math.min(...points.map((point) => point.y)),
          maxX: Math.max(...points.map((point) => point.x)),
          maxY: Math.max(...points.map((point) => point.y))
        };
      };
      const boundsGap = (left = null, right = null) => {
        if (!left || !right) {
          return Infinity;
        }
        const dx = rangeDistance(left.minX, left.maxX, right.minX, right.maxX);
        const dy = rangeDistance(left.minY, left.maxY, right.minY, right.maxY);
        return Math.sqrt(dx * dx + dy * dy);
      };
      const connectedSurfaceTriangles = (sourceTriangles = []) => {
        if (!surfaceContinuityFilter || !surfaceSamples.length || sourceTriangles.length <= 1) {
          return sourceTriangles;
        }
        if (options.surfaceContinuityKeepDisconnected === true) {
          return sourceTriangles;
        }
        const componentGap = Math.max(
          1.5,
          Math.min(5, Number(options.surfaceContinuityComponentGapPixels) || radius * 0.08)
        );
        const componentDepthWindow = Math.max(
          continuityDepthWindow * 1.5,
          Number(options.surfaceContinuityComponentDepthWindow) || 0.018
        );
        const componentNormalDot = Math.max(
          -1,
          Math.min(1, Number(options.surfaceContinuityComponentNormalDot) || continuityNormalDot * 0.9)
        );
        const entries = sourceTriangles.map((triangle, indexValue) => {
          const info = cachedTriangleSurfaceInfo(triangle);
          const bounds = info?.bounds || null;
          const centroid = info?.centroid || null;
          return bounds && centroid
            ? {
                index: indexValue,
                key: screenTriangleIndexKey(triangle),
                triangle,
                bounds,
                centroid,
                normal: info?.normal || null
              }
            : null;
        }).filter((entry) => entry?.key);
        if (entries.length <= 1) {
          return sourceTriangles;
        }
        const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
        const seedIndexes = new Set();
        for (const sample of surfaceSamples) {
          const sampleKey = screenTriangleIndexKey(sample?.triangle);
          const directSeed = entryByKey.get(sampleKey);
          if (directSeed) {
            seedIndexes.add(directSeed.index);
            continue;
          }
          let best = null;
          let bestDistance = Infinity;
          for (const entry of entries) {
            const distance = pointToTriangleDistance(sample.point, entry.triangle.screen);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = entry;
            }
          }
          if (best && bestDistance <= componentGap + 2) {
            seedIndexes.add(best.index);
          }
        }
        if (!seedIndexes.size) {
          return sourceTriangles;
        }
        const cellSize = Math.max(8, componentGap + 8);
        const grid = new Map();
        const cellKey = (x, y) => `${x}:${y}`;
        for (const entry of entries) {
          const minColumn = Math.floor((entry.bounds.minX - componentGap) / cellSize);
          const maxColumn = Math.floor((entry.bounds.maxX + componentGap) / cellSize);
          const minRow = Math.floor((entry.bounds.minY - componentGap) / cellSize);
          const maxRow = Math.floor((entry.bounds.maxY + componentGap) / cellSize);
          for (let row = minRow; row <= maxRow; row += 1) {
            for (let column = minColumn; column <= maxColumn; column += 1) {
              const key = cellKey(column, row);
              const bucket = grid.get(key) || [];
              bucket.push(entry);
              grid.set(key, bucket);
            }
          }
        }
        const connected = new Set(seedIndexes);
        const queueEntries = [...seedIndexes]
          .map((indexValue) => entries.find((entry) => entry.index === indexValue))
          .filter(Boolean);
        while (queueEntries.length) {
          const current = queueEntries.shift();
          const minColumn = Math.floor((current.bounds.minX - componentGap) / cellSize);
          const maxColumn = Math.floor((current.bounds.maxX + componentGap) / cellSize);
          const minRow = Math.floor((current.bounds.minY - componentGap) / cellSize);
          const maxRow = Math.floor((current.bounds.maxY + componentGap) / cellSize);
          for (let row = minRow; row <= maxRow; row += 1) {
            for (let column = minColumn; column <= maxColumn; column += 1) {
              for (const next of grid.get(cellKey(column, row)) || []) {
                if (connected.has(next.index) || next.index === current.index) {
                  continue;
                }
                if (boundsGap(current.bounds, next.bounds) > componentGap) {
                  continue;
                }
                if (
                  Number.isFinite(current.centroid.depth)
                  && Number.isFinite(next.centroid.depth)
                  && Math.abs(current.centroid.depth - next.centroid.depth) > componentDepthWindow
                ) {
                  continue;
                }
                const normalDot = viewNormalDot(current.normal, next.normal);
                if (normalDot != null && normalDot < componentNormalDot) {
                  continue;
                }
                connected.add(next.index);
                queueEntries.push(next);
              }
            }
          }
        }
        const filtered = sourceTriangles.filter((_triangle, indexValue) => connected.has(indexValue));
        return filtered.length ? filtered : sourceTriangles;
      };
      const candidateByKey = new Map();
      const cellKeys = new Set();
      const cellSegmentMap = new Map();
      const maxCellVisibilitySegments = Math.max(
        4,
        Math.min(24, Math.floor(Number(options.maxCellVisibilitySegments) || 4))
      );
      const sampledCellSegments = (segmentsForCell = []) => {
        if (!Array.isArray(segmentsForCell) || segmentsForCell.length <= maxCellVisibilitySegments) {
          return segmentsForCell;
        }
        const sampled = [];
        const stride = Math.max(1, Math.ceil(segmentsForCell.length / Math.max(1, maxCellVisibilitySegments - 1)));
        for (let indexValue = 0; indexValue < segmentsForCell.length && sampled.length < maxCellVisibilitySegments - 1; indexValue += stride) {
          sampled.push(segmentsForCell[indexValue]);
        }
        const last = segmentsForCell[segmentsForCell.length - 1];
        if (last && sampled[sampled.length - 1] !== last) {
          sampled.push(last);
        }
        return sampled.length ? sampled : segmentsForCell.slice(0, maxCellVisibilitySegments);
      };
      const segmentProgressStarts = new Map();
      let accumulatedStrokeLength = 0;
      for (const segment of sourceSegments) {
        segmentProgressStarts.set(segment, accumulatedStrokeLength);
        accumulatedStrokeLength += pointDistance(segment.start, segment.end);
      }
      const collectCells = (left, top, right, bottom, activeSegment = null) => {
        const startColumn = Math.max(0, Math.min(index.columnCount - 1, Math.floor(left / index.cellSize)));
        const endColumn = Math.max(0, Math.min(index.columnCount - 1, Math.floor(right / index.cellSize)));
        const startRow = Math.max(0, Math.min(index.rowCount - 1, Math.floor(top / index.cellSize)));
        const endRow = Math.max(0, Math.min(index.rowCount - 1, Math.floor(bottom / index.cellSize)));
        for (let row = startRow; row <= endRow; row += 1) {
          for (let column = startColumn; column <= endColumn; column += 1) {
            const cellKey = `${column}:${row}`;
            cellKeys.add(cellKey);
            if (activeSegment) {
              const segmentsForCell = cellSegmentMap.get(cellKey) || [];
              segmentsForCell.push(activeSegment);
              cellSegmentMap.set(cellKey, segmentsForCell);
            }
          }
        }
      };
      for (const segment of sourceSegments) {
        const pad = Math.max(radius, segment.radiusPixels);
        collectCells(
          Math.min(segment.start.x, segment.end.x) - pad,
          Math.min(segment.start.y, segment.end.y) - pad,
          Math.max(segment.start.x, segment.end.x) + pad,
          Math.max(segment.start.y, segment.end.y) + pad,
          segment
        );
      }
      if (!cellKeys.size) {
        collectCells(minX, minY, maxX, maxY);
      }
      for (const cellKey of cellKeys) {
        const cellSegments = cellSegmentMap.get(cellKey) || [];
        const distanceSegments = sampledCellSegments(cellSegments.length ? cellSegments : sourceSegments);
        addDebugCount("screenIndexDistanceSegments", distanceSegments.length);
        for (const triangle of index.cells.get(cellKey) || []) {
          addDebugCount("screenIndexVisited");
          const key = screenTriangleIndexKey(triangle);
          if (!key) {
            addDebugCount("screenIndexRejectSeen");
            continue;
          }
          if (record && triangle.record !== record) {
            addDebugCount("screenIndexRejectRecord");
            continue;
          }
          if (!triangleMatchesMaterialTarget(triangle)) {
            addDebugCount("screenIndexRejectMaterial");
            continue;
          }
          let boxDistance = Infinity;
          let closestSegment = null;
          for (const segment of distanceSegments) {
            const segmentBoxDistance = screenBoxDistanceToSegment(triangle, segment);
            if (segmentBoxDistance < boxDistance) {
              boxDistance = segmentBoxDistance;
              closestSegment = segment;
            }
          }
          if (!Number.isFinite(boxDistance) || boxDistance > radius + index.cellSize) {
            addDebugCount("screenIndexRejectBoxDistance");
            continue;
          }
          const distance = boxDistance;
          let strokeProgress = 0;
          let strokeSignedOffset = 0;
          const triangleCenter = screenTriangleCenterPoint(triangle);
          if (closestSegment) {
            const placement = pointToSegmentPlacement(triangleCenter, closestSegment);
            strokeProgress = (segmentProgressStarts.get(closestSegment) || 0)
              + (Number(placement?.ratio) || 0) * Math.max(0, Number(placement?.length) || 0);
            strokeSignedOffset = Number(placement?.signedOffset) || 0;
          }
          if (!Number.isFinite(distance) || distance > radius + 1) {
            addDebugCount("screenIndexRejectDistance");
            continue;
          }
          const previous = candidateByKey.get(key);
          if (previous && previous.screenStrokeDistance <= distance) {
            addDebugCount("screenIndexRejectSeen");
            continue;
          }
          candidateByKey.set(key, {
            ...triangle,
            screenStrokeDistance: Number.isFinite(distance) ? distance : Infinity,
            screenStrokeProgress: strokeProgress,
            screenStrokeSignedOffset: strokeSignedOffset
          });
        }
      }
      const triangles = [];
      for (const triangle of candidateByKey.values()) {
        const distance = Number(triangle.screenStrokeDistance);
        if (!candidateSurfaceContinuityAllowed(triangle, distance)) {
          addDebugCount("screenIndexRejectContinuity");
          continue;
        }
        if (!candidateFrontSurfaceVisible(triangle)) {
          addDebugCount("screenIndexRejectFrontSurface");
          continue;
        }
        const alphaSamplePoints = candidateFrontSurfaceSamplePoints(
          triangle.screen,
          sourceSegments,
          radius,
          3
        );
        if (
          alphaSamplePoints.length
          && !alphaSamplePoints.some((point) => triangleHasVisibleTexelAtPoint(triangle, point))
        ) {
          addDebugCount("screenIndexRejectAlpha");
          continue;
        }
        addDebugCount("screenIndexAccepted");
        triangles.push(triangle);
      }
      const connectedTriangles = connectedSurfaceTriangles(triangles);
      addDebugCount("screenIndexConnected", connectedTriangles.length);
      const selectedTriangles = selectScreenTrianglesNearStroke(connectedTriangles, sourceSegments, maxTriangles, radius);
      addDebugCount("screenIndexSelected", selectedTriangles.length);
      return selectedTriangles;
    },

    textureAirbrushScreenHitsForEvent(event = null, tool = this.activeTool, options = {}) {
      if (!event || !this.canvas || !this.camera || !this.model) {
        return [];
      }
      const rect = options.rect || this.canvas.getBoundingClientRect?.();
      const allowAnimationProgressMismatch = options.allowAnimationProgressMismatch === true
        || this.painting === true
        || this.textureAirbrushScreenStrokeHasPendingWork?.() === true;
      const index = this.textureAirbrushBuildScreenHitIndex?.({
        rect,
        allowAnimationProgressMismatch
      });
      if (!index?.cells || !rect?.width || !rect?.height) {
        return [];
      }
      const point = {
        x: event.clientX - (rect.left || 0),
        y: event.clientY - (rect.top || 0)
      };
      if (point.x < 0 || point.y < 0 || point.x > rect.width || point.y > rect.height) {
        return [];
      }
      const column = Math.max(0, Math.min(index.columnCount - 1, Math.floor(point.x / index.cellSize)));
      const row = Math.max(0, Math.min(index.rowCount - 1, Math.floor(point.y / index.cellSize)));
      const firstOnly = options.firstOnly === true;
      const cacheKey = screenHitPointCacheKey(point, tool, {
        firstOnly,
        maxHits: options.maxHits,
        skipTransparentTextureHits: options.skipTransparentTextureHits,
        includeBackFacingTriangles: options.includeBackFacingTriangles
      });
      if (cacheKey && index.hitCache?.has(cacheKey)) {
        return index.hitCache.get(cacheKey) || [];
      }
      const candidates = index.cells.get(`${column}:${row}`) || [];
      const hits = [];
      let bestHit = null;
      let bestTransparentHit = null;
      const transparentHits = [];
      const skipTransparentTextureHits = options.skipTransparentTextureHits !== false
        && (tool === "airbrush" || tool === "texture-eraser" || tool === "eyedropper");
      const alphaSampleCache = index.textureVisibilityAlphaCache ||= new Map();
      const maxHits = firstOnly
        ? 1
        : Math.max(0, Math.floor(Number(options.maxHits) || 0));
      for (const triangle of candidates) {
        if (triangle.matchesMaterialSide === false && options.includeBackFacingTriangles !== true) {
          continue;
        }
        if (
          firstOnly
          && bestHit
          && Number.isFinite(triangle.minDepth)
          && triangle.minDepth > bestHit.depth + 0.000001
        ) {
          break;
        }
        if (
          !firstOnly
          && maxHits > 0
          && hits.length >= maxHits
          && Number.isFinite(triangle.minDepth)
        ) {
          const worstDepth = Math.max(...hits.map((entry) => entry.depth));
          if (triangle.minDepth > worstDepth + 0.000001) {
            break;
          }
        }
        const weights = barycentricScreenWeights(point, triangle.screen[0], triangle.screen[1], triangle.screen[2]);
        if (!weights) {
          continue;
        }
        const depth = (
          triangle.screen[0].z * weights.w0
          + triangle.screen[1].z * weights.w1
          + triangle.screen[2].z * weights.w2
        );
        if (!Number.isFinite(depth) || depth < -1 || depth > 1) {
          continue;
        }
        const uv = new (globalThis.THREE?.Vector2 || Vector2)(
          triangle.uvs[0].x * weights.w0 + triangle.uvs[1].x * weights.w1 + triangle.uvs[2].x * weights.w2,
          triangle.uvs[0].y * weights.w0 + triangle.uvs[1].y * weights.w1 + triangle.uvs[2].y * weights.w2
        );
        const hitEntry = {
          depth,
          record: triangle.record,
          hit: {
            object: triangle.object,
            uv,
            face: triangle.face,
            faceIndex: triangle.faceIndex,
            screen: triangle.screen,
            point: null,
            distance: depth
          }
        };
        const hasVisibleTexel = !skipTransparentTextureHits
          || textureAirbrushHitHasVisibleTexel(this, hitEntry.record, hitEntry.hit, {
            cache: alphaSampleCache
          });
        if (firstOnly) {
          if (!hasVisibleTexel) {
            if (!bestTransparentHit || depth < bestTransparentHit.depth) {
              bestTransparentHit = hitEntry;
            }
            continue;
          }
          if (!bestHit || depth < bestHit.depth) {
            bestHit = hitEntry;
          }
          continue;
        }
        if (!hasVisibleTexel) {
          transparentHits.push(hitEntry);
          continue;
        }
        hits.push(hitEntry);
        if (!firstOnly && maxHits > 0 && hits.length > maxHits) {
          hits.sort((left, right) => left.depth - right.depth);
          hits.length = maxHits;
        }
      }
      if (firstOnly) {
        const selectedHit = bestHit || bestTransparentHit;
        return rememberScreenHitCacheEntry(index, cacheKey, selectedHit ? [{
          record: selectedHit.record,
          hit: selectedHit.hit
        }] : []);
      }
      if (!hits.length && transparentHits.length) {
        hits.push(...transparentHits);
        hits.sort((left, right) => left.depth - right.depth);
        if (maxHits > 0 && hits.length > maxHits) {
          hits.length = maxHits;
        }
      }
      hits.sort((left, right) => left.depth - right.depth);
      return rememberScreenHitCacheEntry(index, cacheKey, hits.map((entry) => ({
        record: entry.record,
        hit: entry.hit
      })));
    },

    textureAirbrushScreenHitForEvent(event = null, tool = this.activeTool, options = {}) {
      const hits = this.textureAirbrushScreenHitsForEvent?.(event, tool, {
        ...options,
        firstOnly: true
      }) || [];
      const best = hits[0] || null;
      if (!best) {
        return null;
      }
      if (tool === "clone") {
        return this.clonePaintHitFromIntersections?.([best.hit]) || null;
      }
      return best;
    },

    textureAirbrushPrewarmScreenHitIndex(options = {}) {
      if (!this.canvas || !this.camera || !this.model) {
        return false;
      }
      const tool = options.tool || this.activeTool || "airbrush";
      if (tool !== "airbrush" && tool !== "texture-eraser" && tool !== "eyedropper") {
        return false;
      }
      const rect = options.rect || this.canvas.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height) {
        return false;
      }
      return Boolean(this.textureAirbrushBuildScreenHitIndex?.({
        rect,
        allowAnimationProgressMismatch: options.allowAnimationProgressMismatch === true,
        reuse: options.force !== true
      }));
    },

    textureBrushRadiusValue() {
      return Math.max(0.004, Number(this.textureBrushRadius?.value || this.brushRadius?.value || 0.035));
    },

    textureBrushRadiusScreenPixels() {
      return Math.max(
        0.75,
        Math.min(TEXTURE_BRUSH_MAX_SCREEN_RADIUS_PIXELS, this.textureBrushRadiusValue() * 220)
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

    hideTextureBrushCursor() {
      if (this.textureBrushCursor) {
        this.textureBrushCursor.hidden = true;
        this.textureBrushCursor.classList.remove("is-clone", "is-selection", "is-deselect");
      }
      this.textureBrushCursorPositionState = null;
      this.textureBrushCursorPendingPosition = null;
      this.textureBrushCursorClassMode = "";
    },

    setTextureBrushCursorMode(mode = "airbrush") {
      if (!this.textureBrushCursor) {
        return false;
      }
      const previousMode = this.textureBrushCursorClassMode;
      this.textureBrushCursor.classList.toggle("is-clone", mode === "clone");
      this.textureBrushCursor.classList.toggle("is-selection", mode === "selection" || mode === "deselect");
      this.textureBrushCursor.classList.toggle("is-deselect", mode === "deselect");
      this.textureBrushCursorClassMode = mode;
      return previousMode !== mode;
    },

    showTextureBrushCursorElement() {
      if (!this.textureBrushCursor) {
        return false;
      }
      if (this.textureBrushCursor.hidden) {
        this.textureBrushCursor.hidden = false;
      }
      return true;
    },

    rememberBrushCursorEvent(event) {
      if (!event || !this.canvas) {
        return null;
      }
      const rect = this.brushCursorCanvasRect?.() || this.canvas.getBoundingClientRect();
      if (
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom
      ) {
        this.lastBrushCursorEvent = null;
        return null;
      }
      if (this.lastBrushCursorEvent) {
        this.lastBrushCursorEvent.clientX = event.clientX;
        this.lastBrushCursorEvent.clientY = event.clientY;
        return this.lastBrushCursorEvent;
      }
      this.lastBrushCursorEvent = {
        clientX: event.clientX,
        clientY: event.clientY
      };
      return this.lastBrushCursorEvent;
    },

    brushCursorCanvasRect() {
      if (this.painting && this.textureBrushCursorPositionState?.canvasRect) {
        return this.textureBrushCursorPositionState.canvasRect;
      }
      const canvasRect = this.canvas?.getBoundingClientRect?.() || null;
      if (this.painting && canvasRect) {
        this.textureBrushCursorPositionState = {
          ...(this.textureBrushCursorPositionState || {}),
          canvasRect
        };
      }
      return canvasRect;
    },

    brushCursorStageRect() {
      if (this.painting && this.textureBrushCursorPositionState?.stageRect) {
        return this.textureBrushCursorPositionState.stageRect;
      }
      const stageRect = this.canvas?.parentElement?.getBoundingClientRect?.()
        || this.canvas?.getBoundingClientRect?.()
        || { left: 0, top: 0 };
      if (this.painting) {
        this.textureBrushCursorPositionState = {
          ...(this.textureBrushCursorPositionState || {}),
          stageRect
        };
      }
      return stageRect;
    },

    positionBrushCursor(event, radius) {
      const stageRect = this.brushCursorStageRect();
      const diameter = Math.max(1, radius * 2);
      const x = quantizedCursorPosition(event.clientX - stageRect.left - radius);
      const y = quantizedCursorPosition(event.clientY - stageRect.top - radius);
      const state = this.textureBrushCursorPositionState || {};
      const nextStageRect = this.painting ? stageRect : null;
      if (
        state.diameter === diameter
        && state.x === x
        && state.y === y
        && state.stageRect === nextStageRect
      ) {
        return;
      }
      if (state.diameter !== diameter) {
        this.textureBrushCursor.style.width = `${diameter}px`;
        this.textureBrushCursor.style.height = `${diameter}px`;
      }
      if (state.x !== x || state.y !== y) {
        this.textureBrushCursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
      this.textureBrushCursorPositionState = {
        ...state,
        stageRect: nextStageRect,
        diameter,
        x,
        y
      };
    },

    scheduleBrushCursorPosition(event, radius) {
      if (!event || !this.textureBrushCursor) {
        return false;
      }
      this.textureBrushCursorPendingPosition = {
        clientX: event.clientX,
        clientY: event.clientY,
        radius
      };
      if (this.textureBrushCursorPositionFrame) {
        return true;
      }
      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : typeof globalThis.setTimeout === "function"
          ? (callback) => globalThis.setTimeout(callback, 16)
          : null;
      if (!requestFrame) {
        const pending = this.textureBrushCursorPendingPosition;
        this.textureBrushCursorPendingPosition = null;
        this.positionBrushCursor?.(pending, pending.radius);
        return true;
      }
      this.textureBrushCursorPositionFrame = requestFrame(() => {
        this.textureBrushCursorPositionFrame = null;
        const pending = this.textureBrushCursorPendingPosition;
        this.textureBrushCursorPendingPosition = null;
        if (!pending || !this.textureBrushCursor || this.textureBrushCursor.hidden) {
          return;
        }
        this.positionBrushCursor?.(pending, pending.radius);
      });
      return true;
    },

    updateBrushCursorForLastPointer(options = {}) {
      if (!this.lastBrushCursorEvent) {
        return false;
      }
      if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone") {
        return this.updateTextureBrushCursor(this.lastBrushCursorEvent, options);
      }
      if (this.usesSelectionBrushCursor?.(this.activeTool)) {
        return this.updateSelectionBrushCursor(this.lastBrushCursorEvent);
      }
      return false;
    },

    updateTextureBrushCursor(event, options = {}) {
      if (!this.textureBrushCursor || !this.canvas || !event) {
        return false;
      }
      const remembered = this.rememberBrushCursorEvent(event);
      const isTextureBrush = this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone";
      if (!isTextureBrush || !remembered) {
        this.hideTextureBrushCursor();
        return false;
      }
      let hit = null;
      if (this.activeTool === "clone") {
        hit = this.texturePaintHitForEvent(event, this.activeTool);
        if (!hit || !this.clonePaintSource?.records?.get(hit.record)) {
          this.hideTextureBrushCursor();
          return false;
        }
      } else if (this.activeTool === "airbrush" && !this.painting && options.prewarm !== false) {
        this.scheduleTextureAirbrushPrewarm?.(event, null, {
          preserveLayerDisplay: true
        });
      }
      const radius = this.textureBrushRadiusScreenPixels();
      this.showTextureBrushCursorElement?.();
      this.setTextureBrushCursorMode(this.activeTool === "clone" ? "clone" : "airbrush");
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
      this.showTextureBrushCursorElement?.();
      this.setTextureBrushCursorMode(this.activeTool === "deselect" || this.activeTool === "erase" ? "deselect" : "selection");
      this.positionBrushCursor(event, radius);
      return true;
    }
  });
}
