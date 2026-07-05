import * as THREE from "../../node_modules/three/build/three.webgpu.js";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../weight-editor/airbrush/constants.js";
import {
  TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD,
  TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER,
  TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_CORE_MIN_SCALE,
  TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE,
  TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE,
  TEXTURE_AIRBRUSH_SOFT_HALO_SCALE
} from "../weight-editor/airbrush/math.js";

const MAX_TSL_SURFACE_SEGMENTS = Math.min(16, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
const MAX_TSL_SURFACE_STROKE_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS;
const MAX_TSL_SURFACE_STROKE_MASK_SIZE = 4096;
const UV_GUTTER_PIXELS = 0;
const UV_SEAM_BLEED_PIXELS = 8;
const UV_OVERLAP_MASK_SIZE = 1024;
const UV_OVERLAP_DISTANCE_THRESHOLD = 0.25;
const PROJECTED_GUTTER_GEOMETRY_MIN_TRIANGLES = 256;
const SOURCE_RASTER_GEOMETRY_MIN_TRIANGLES = 4096;
const TSL_SURFACE_DILATION_PASSES = 1;
const TSL_SURFACE_DILATION_SAMPLE_RADII = [1, 2, 4, 8, 16];
const SURFACE_AIRBRUSH_RETIRED_RESOURCE_LIMIT = 48;
const SURFACE_AIRBRUSH_RETIRE_FALLBACK_MS = 3000;
const SURFACE_AIRBRUSH_RETIRE_MIN_AGE_MS = 5000;
const SOFT_FACING_NORMAL_BACK_FEATHER = 0.0;
const SOFT_FACING_NORMAL_FRONT_FEATHER = 0.12;
const VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS = 0.18;
const SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_SCALE = 0.08;
const SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_MIN = 0.9;
const SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_SCALE = 0.08;
const SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_MIN = 0.45;

const _scratchUv = new THREE.Vector2();
const _scratchWorld = new THREE.Vector3();
const _scratchView = new THREE.Vector3();
const _scratchClip = new THREE.Vector3();
const _scratchClearColor = new THREE.Color();
const _scratchNormal = new THREE.Vector3();
const _scratchNormal4 = new THREE.Vector4();
const _scratchNormalMatrix = new THREE.Matrix3();
const _scratchBoneMatrix = new THREE.Matrix4();
const _scratchSkinMatrix = new THREE.Matrix4();
const _surfaceAirbrushUvOverlapMasks = new WeakMap();
const _surfaceAirbrushGeometryComponentStates = new WeakMap();
let _surfaceAirbrushWhiteMaskTexture = null;
let _surfaceAirbrushTransparentTexture = null;
const MIPMAP_MIN_FILTERS = new Set([
  THREE.NearestMipmapNearestFilter,
  THREE.NearestMipmapLinearFilter,
  THREE.LinearMipmapNearestFilter,
  THREE.LinearMipmapLinearFilter
].filter((value) => value !== undefined && value !== null));

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteComponentId(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : -1;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, finiteNumber(value, 0)));
}

function finitePoint(point = null) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
    ? { x: Number(point.x), y: Number(point.y) }
    : null;
}

function pointDistance(left = null, right = null) {
  return Number.isFinite(left?.x) && Number.isFinite(left?.y) && Number.isFinite(right?.x) && Number.isFinite(right?.y)
    ? Math.hypot(Number(left.x) - Number(right.x), Number(left.y) - Number(right.y))
    : Infinity;
}

function finiteView(point = null) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z)
    ? { x: Number(point.x), y: Number(point.y), z: Number(point.z) }
    : null;
}

function bufferAttributeComponent(attribute = null, vertexIndex = 0, component = 0, fallback = 0) {
  if (!attribute || vertexIndex < 0 || component < 0) {
    return fallback;
  }
  if (typeof attribute.getComponent === "function") {
    return finiteNumber(attribute.getComponent(vertexIndex, component), fallback);
  }
  const itemSize = Math.max(1, Math.floor(Number(attribute.itemSize) || 1));
  return finiteNumber(attribute.array?.[vertexIndex * itemSize + component], fallback);
}

function addWeightedMatrix(target = null, source = null, weight = 0) {
  const targetElements = target?.elements || null;
  const sourceElements = source?.elements || null;
  if (!targetElements || !sourceElements || !Number.isFinite(weight) || weight === 0) {
    return false;
  }
  for (let index = 0; index < 16; index += 1) {
    targetElements[index] += sourceElements[index] * weight;
  }
  return true;
}

function skinLocalNormalForVertex(object = null, geometry = null, vertexIndex = 0, normal = null) {
  const skinIndex = geometry?.attributes?.skinIndex || null;
  const skinWeight = geometry?.attributes?.skinWeight || null;
  const skeleton = object?.skeleton || null;
  if (!normal || object?.isSkinnedMesh !== true || !skinIndex || !skinWeight || !skeleton) {
    return normal;
  }
  skeleton.update?.();
  _scratchSkinMatrix.set(
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0
  );
  let totalWeight = 0;
  const influenceCount = Math.max(
    Math.floor(Number(skinIndex.itemSize) || 0),
    Math.floor(Number(skinWeight.itemSize) || 0),
    4
  );
  for (let influence = 0; influence < influenceCount; influence += 1) {
    const weight = bufferAttributeComponent(skinWeight, vertexIndex, influence, 0);
    if (!Number.isFinite(weight) || Math.abs(weight) <= 0.000001) {
      continue;
    }
    const boneIndex = Math.floor(bufferAttributeComponent(skinIndex, vertexIndex, influence, -1));
    if (!Number.isFinite(boneIndex) || boneIndex < 0) {
      continue;
    }
    if (typeof skeleton.getBoneMatrix === "function") {
      skeleton.getBoneMatrix(boneIndex, _scratchBoneMatrix);
    } else if (skeleton.boneMatrices?.length >= boneIndex * 16 + 16) {
      _scratchBoneMatrix.fromArray(skeleton.boneMatrices, boneIndex * 16);
    } else {
      continue;
    }
    addWeightedMatrix(_scratchSkinMatrix, _scratchBoneMatrix, weight);
    totalWeight += Math.abs(weight);
  }
  if (totalWeight <= 0.000001) {
    return normal;
  }
  if (object.bindMatrix && object.bindMatrixInverse) {
    _scratchSkinMatrix.multiplyMatrices(object.bindMatrixInverse, _scratchSkinMatrix).multiply(object.bindMatrix);
  }
  _scratchNormal4.set(normal.x, normal.y, normal.z, 0).applyMatrix4(_scratchSkinMatrix);
  normal.set(_scratchNormal4.x, _scratchNormal4.y, _scratchNormal4.z);
  return normal.lengthSq() > 0.000001 ? normal.normalize() : normal;
}

function worldFromView(editor = null, point = null) {
  if (!editor?.camera || !finiteView(point)) {
    return null;
  }
  const world = _scratchWorld.set(point.x, point.y, point.z).applyMatrix4(editor.camera.matrixWorld);
  return Number.isFinite(world.x) && Number.isFinite(world.y) && Number.isFinite(world.z)
    ? { x: world.x, y: world.y, z: world.z }
    : null;
}

function viewFromScreenPoint(point = null) {
  return Number.isFinite(point?.viewX) && Number.isFinite(point?.viewY) && Number.isFinite(point?.viewZ)
    ? { x: Number(point.viewX), y: Number(point.viewY), z: Number(point.viewZ) }
    : finiteView(point);
}

function triangleArea2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function barycentricForPoint(point, a, b, c) {
  const denom = triangleArea2(a, b, c);
  if (!Number.isFinite(denom) || Math.abs(denom) <= 0.000001) {
    return null;
  }
  const u = triangleArea2(point, b, c) / denom;
  const v = triangleArea2(a, point, c) / denom;
  const w = triangleArea2(a, b, point) / denom;
  return { u, v, w };
}

function interpolateView(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  return {
    x: a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w,
    y: a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w,
    z: a.z * barycentric.u + b.z * barycentric.v + c.z * barycentric.w
  };
}

function interpolateScreen(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  return {
    x: a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w,
    y: a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w,
    z: finiteNumber(a.z, 0) * barycentric.u
      + finiteNumber(b.z, 0) * barycentric.v
      + finiteNumber(c.z, 0) * barycentric.w
  };
}

function clampBarycentricToTriangle(barycentric = null) {
  if (!barycentric) {
    return null;
  }
  const u = Math.max(0, finiteNumber(barycentric.u, 0));
  const v = Math.max(0, finiteNumber(barycentric.v, 0));
  const w = Math.max(0, finiteNumber(barycentric.w, 0));
  const sum = u + v + w;
  if (sum <= 0.000001) {
    return { u: 1, v: 0, w: 0 };
  }
  return {
    u: u / sum,
    v: v / sum,
    w: w / sum
  };
}

function interpolatePoint2(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  return {
    x: a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w,
    y: a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w
  };
}

function interpolateNormal(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  const x = a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w;
  const y = a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w;
  const z = a.z * barycentric.u + b.z * barycentric.v + c.z * barycentric.w;
  const length = Math.hypot(x, y, z);
  if (length <= 0.000001) {
    return null;
  }
  return { x: x / length, y: y / length, z: z / length };
}

function rightNormal(edge) {
  const length = Math.hypot(edge.x, edge.y);
  if (length <= 0.000001) {
    return { x: 0, y: 0 };
  }
  return { x: edge.y / length, y: -edge.x / length };
}

function outwardNormal(edge, ccw) {
  const normal = rightNormal(edge);
  return ccw ? normal : { x: -normal.x, y: -normal.y };
}

function expandCorner(point, center, firstNormal, secondNormal, margin) {
  let x = firstNormal.x + secondNormal.x;
  let y = firstNormal.y + secondNormal.y;
  if (x * x + y * y <= 0.000001) {
    x = point.x - center.x;
    y = point.y - center.y;
  }
  const length = Math.hypot(x, y);
  if (length <= 0.000001) {
    return point;
  }
  x /= length;
  y /= length;
  const firstDot = Math.abs(x * firstNormal.x + y * firstNormal.y);
  const secondDot = Math.abs(x * secondNormal.x + y * secondNormal.y);
  const miterDenom = Math.max(0.35, firstDot, secondDot);
  const miterLength = Math.min(margin * 4, margin / miterDenom);
  return {
    x: point.x + x * miterLength,
    y: point.y + y * miterLength
  };
}

function expandedTrianglePoints(a, b, c, margin = UV_GUTTER_PIXELS) {
  const center = {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3
  };
  const ccw = triangleArea2(a, b, c) > 0;
  const normalAB = outwardNormal({ x: b.x - a.x, y: b.y - a.y }, ccw);
  const normalBC = outwardNormal({ x: c.x - b.x, y: c.y - b.y }, ccw);
  const normalCA = outwardNormal({ x: a.x - c.x, y: a.y - c.y }, ccw);
  return [
    expandCorner(a, center, normalCA, normalAB, margin),
    expandCorner(b, center, normalAB, normalBC, margin),
    expandCorner(c, center, normalBC, normalCA, margin)
  ];
}

function textureLikeSize(texture = null) {
  const image = texture?.image || texture?.source?.data || null;
  return {
    width: Math.max(1, Math.floor(Number(image?.width) || Number(texture?.width) || 1)),
    height: Math.max(1, Math.floor(Number(image?.height) || Number(texture?.height) || 1))
  };
}

function surfaceAirbrushDilationPasses() {
  if (
    typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushNoDilation")
  ) {
    return 0;
  }
  return TSL_SURFACE_DILATION_PASSES;
}

function surfaceAirbrushSourceRasterGutterPixels() {
  if (
    typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushNoSourceGutters")
  ) {
    return UV_GUTTER_PIXELS;
  }
  return UV_SEAM_BLEED_PIXELS;
}

function surfaceAirbrushUvOverlapMaskEnabled() {
  return (
    typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushUvOverlapMask")
  );
}

function surfaceAirbrushOriginalMeshUvRasterEnabled() {
  if (typeof window === "undefined") {
    return true;
  }
  const params = new URLSearchParams(window.location?.search || "");
  if (params.has("debugAirbrushSourceMeshUvRaster")) {
    return false;
  }
  return true;
}

function surfaceAirbrushSourceRasterClipEnabled() {
  return (
    typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushSourceRasterClip")
  );
}

function copyTextureSettings(targetTexture = null, referenceTexture = null) {
  if (!targetTexture || !referenceTexture) {
    return;
  }
  targetTexture.name = "texture-paint-tsl-surface-airbrush";
  targetTexture.colorSpace = referenceTexture.colorSpace ?? targetTexture.colorSpace;
  targetTexture.flipY = false;
  targetTexture.userData ||= {};
  targetTexture.userData.texturePaintTslSurfaceDisplayFlipY = referenceTexture.flipY === true;
  if ("channel" in targetTexture && "channel" in referenceTexture) {
    targetTexture.channel = referenceTexture.channel;
  }
  targetTexture.wrapS = referenceTexture.wrapS ?? targetTexture.wrapS;
  targetTexture.wrapT = referenceTexture.wrapT ?? targetTexture.wrapT;
  targetTexture.magFilter = referenceTexture.magFilter ?? targetTexture.magFilter;
  targetTexture.minFilter = MIPMAP_MIN_FILTERS.has(referenceTexture.minFilter)
    ? (THREE.LinearFilter || targetTexture.minFilter)
    : referenceTexture.minFilter ?? targetTexture.minFilter;
  targetTexture.generateMipmaps = false;
  targetTexture.matrixAutoUpdate = referenceTexture.matrixAutoUpdate ?? targetTexture.matrixAutoUpdate;
  if (referenceTexture.matrix && targetTexture.matrix?.copy) {
    targetTexture.matrix.copy(referenceTexture.matrix);
  }
}

function surfaceAirbrushWhiteMaskTexture() {
  if (_surfaceAirbrushWhiteMaskTexture) {
    return _surfaceAirbrushWhiteMaskTexture;
  }
  const data = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = "texture-paint-tsl-surface-airbrush-white-mask";
  texture.colorSpace = THREE.NoColorSpace || texture.colorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  _surfaceAirbrushWhiteMaskTexture = texture;
  return texture;
}

function surfaceAirbrushTransparentTexture() {
  if (_surfaceAirbrushTransparentTexture) {
    return _surfaceAirbrushTransparentTexture;
  }
  const data = new Uint8Array([0, 0, 0, 0]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = "texture-paint-tsl-surface-airbrush-transparent";
  texture.colorSpace = THREE.NoColorSpace || texture.colorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  _surfaceAirbrushTransparentTexture = texture;
  return texture;
}

function sourceObjectUvOverlapMaskKey(sourceObject = null) {
  const geometry = sourceObject?.geometry || null;
  return [
    geometry?.uuid || geometry?.id || "geometry",
    Number(geometry?.attributes?.position?.version) || 0,
    Number(geometry?.attributes?.uv?.version) || 0,
    Number(geometry?.index?.version) || 0,
    UV_OVERLAP_MASK_SIZE,
    UV_OVERLAP_DISTANCE_THRESHOLD
  ].join(":");
}

function uvTriangleContainsPoint(point = null, triangle = null) {
  if (!point || !triangle?.uvs?.length) {
    return false;
  }
  const [a, b, c] = triangle.uvs;
  const area = triangleArea2(a, b, c);
  if (!Number.isFinite(area) || Math.abs(area) <= 0.000000000001) {
    return false;
  }
  const sign = Math.sign(area) || 1;
  return (
    triangleArea2(a, b, point) * sign >= -0.0000001
    && triangleArea2(b, c, point) * sign >= -0.0000001
    && triangleArea2(c, a, point) * sign >= -0.0000001
  );
}

function centroidDistance(left = null, right = null) {
  if (!left || !right) {
    return 0;
  }
  return Math.hypot(
    finiteNumber(left.x, 0) - finiteNumber(right.x, 0),
    finiteNumber(left.y, 0) - finiteNumber(right.y, 0),
    finiteNumber(left.z, 0) - finiteNumber(right.z, 0)
  );
}

function sourceObjectUvOverlapMaskTexture(sourceObject = null) {
  if (!surfaceAirbrushUvOverlapMaskEnabled()) {
    return surfaceAirbrushWhiteMaskTexture();
  }
  const geometry = sourceObject?.geometry || null;
  const position = geometry?.attributes?.position || null;
  const uvAttribute = geometry?.attributes?.uv || null;
  if (!geometry || !position || !uvAttribute || typeof THREE.DataTexture !== "function") {
    return surfaceAirbrushWhiteMaskTexture();
  }
  const key = sourceObjectUvOverlapMaskKey(sourceObject);
  const cached = _surfaceAirbrushUvOverlapMasks.get(geometry);
  if (cached?.key === key && cached.texture) {
    return cached.texture;
  }
  const elementCount = geometry.index?.count || position.count || 0;
  const triangles = [];
  for (let elementStart = 0; elementStart + 2 < elementCount; elementStart += 3) {
    const ia = vertexIndexAt(geometry, elementStart);
    const ib = vertexIndexAt(geometry, elementStart + 1);
    const ic = vertexIndexAt(geometry, elementStart + 2);
    const uvs = [ia, ib, ic].map((index) => ({
      x: finiteNumber(uvAttribute.getX(index), 0),
      y: finiteNumber(uvAttribute.getY(index), 0)
    }));
    if (Math.abs(triangleArea2(uvs[0], uvs[1], uvs[2])) <= 0.000000000001) {
      continue;
    }
    const points = [ia, ib, ic].map((index) => ({
      x: finiteNumber(position.getX(index), 0),
      y: finiteNumber(position.getY(index), 0),
      z: finiteNumber(position.getZ(index), 0)
    }));
    triangles.push({
      uvs,
      centroid: {
        x: (points[0].x + points[1].x + points[2].x) / 3,
        y: (points[0].y + points[1].y + points[2].y) / 3,
        z: (points[0].z + points[1].z + points[2].z) / 3
      },
      minU: Math.min(uvs[0].x, uvs[1].x, uvs[2].x),
      maxU: Math.max(uvs[0].x, uvs[1].x, uvs[2].x),
      minV: Math.min(uvs[0].y, uvs[1].y, uvs[2].y),
      maxV: Math.max(uvs[0].y, uvs[1].y, uvs[2].y)
    });
  }
  const size = UV_OVERLAP_MASK_SIZE;
  const owner = new Int32Array(size * size);
  owner.fill(-1);
  const ambiguous = new Uint8Array(size * size);
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
    const triangle = triangles[triangleIndex];
    const minX = Math.max(0, Math.floor(triangle.minU * size));
    const maxX = Math.min(size - 1, Math.floor(triangle.maxU * size));
    const minY = Math.max(0, Math.floor(triangle.minV * size));
    const maxY = Math.min(size - 1, Math.floor(triangle.maxV * size));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const point = {
          x: (x + 0.5) / size,
          y: (y + 0.5) / size
        };
        if (!uvTriangleContainsPoint(point, triangle)) {
          continue;
        }
        const offset = y * size + x;
        const previous = owner[offset];
        if (previous < 0) {
          owner[offset] = triangleIndex;
          continue;
        }
        if (
          previous !== triangleIndex
          && centroidDistance(triangles[previous]?.centroid, triangle.centroid) > UV_OVERLAP_DISTANCE_THRESHOLD
        ) {
          ambiguous[offset] = 1;
        }
      }
    }
  }
  const expandedAmbiguous = new Uint8Array(ambiguous);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = y * size + x;
      if (!ambiguous[offset]) {
        continue;
      }
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            expandedAmbiguous[ny * size + nx] = 1;
          }
        }
      }
    }
  }
  let ambiguousTexels = 0;
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < expandedAmbiguous.length; index += 1) {
    const value = expandedAmbiguous[index] ? 0 : 255;
    if (!value) {
      ambiguousTexels += 1;
    }
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = "texture-paint-tsl-surface-airbrush-uv-overlap-mask";
  texture.colorSpace = THREE.NoColorSpace || texture.colorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.userData.texturePaintTslSurfaceOverlapMask = {
    ambiguousTexels,
    size,
    threshold: UV_OVERLAP_DISTANCE_THRESHOLD
  };
  cached?.texture?.dispose?.();
  _surfaceAirbrushUvOverlapMasks.set(geometry, { key, texture, ambiguousTexels });
  return texture;
}

function surfaceAirbrushEditorFromHolder(holder = null) {
  if (!holder) {
    return null;
  }
  if (holder.renderer || holder.textureAirbrushWebGpuDevice) {
    return holder;
  }
  return holder.editor || null;
}

function disposeSurfaceAirbrushResourceNow(resource = null) {
  const texture = surfaceAirbrushResourceTexture(resource);
  if (surfaceAirbrushTextureIsLiveTarget(texture)) {
    return false;
  }
  try {
    resource?.dispose?.();
    return true;
  } catch {
    return false;
  }
}

function surfaceAirbrushResourceTexture(resource = null) {
  return resource?.texture || (resource?.isTexture === true ? resource : null);
}

function surfaceAirbrushTextureIsRetired(texture = null) {
  return texture?.userData?.texturePaintTslSurfaceAirbrushRetiredResource === true;
}

function surfaceAirbrushTextureIsLiveTarget(texture = null) {
  return Boolean(
    texture
    && (
      texture.userData?.texturePaintTslSurfaceAirbrushTargetTexture === true
      || texture.userData?.texturePaintTslSurfaceAirbrushDisplayTexture === true
      || texture.name === "texture-paint-tsl-surface-airbrush"
      || texture.name === "texture-paint-tsl-surface-airbrush-display"
      || texture.name === "texture-paint-tsl-surface-airbrush-layer-display"
    )
  );
}

function surfaceAirbrushNowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function surfaceAirbrushResourceRetireAgeMs(resource = null) {
  const texture = surfaceAirbrushResourceTexture(resource);
  const retiredAt = Number(texture?.userData?.texturePaintTslSurfaceAirbrushRetiredAtMs);
  return Number.isFinite(retiredAt) ? surfaceAirbrushNowMs() - retiredAt : Number.POSITIVE_INFINITY;
}

function surfaceAirbrushCacheOwnsTexture(cache = null, texture = null) {
  if (!cache || !texture) {
    return false;
  }
  const renderTargetLists = [
    cache.targets,
    cache.dilationTargets
  ];
  for (const targets of renderTargetLists) {
    if ((targets || []).some((target) => target?.texture === texture)) {
      return true;
    }
  }
  if (cache.maskTarget?.texture === texture) {
    return true;
  }
  if (cache.visibleTarget?.texture === texture) {
    return true;
  }
  if (cache.strokeBaseTarget?.texture === texture) {
    return true;
  }
  if (cache.strokeMaskTarget?.texture === texture) {
    return true;
  }
  if (cache.strokeCompositeTarget?.texture === texture) {
    return true;
  }
  if (cache.displayTarget?.texture === texture) {
    return true;
  }
  if (cache.layerCompositeTarget?.texture === texture) {
    return true;
  }
  if ((cache.layerCompositeTargets || []).some((target) => target?.texture === texture)) {
    return true;
  }
  if (cache.uvOccupancyTarget?.texture === texture) {
    return true;
  }
  return false;
}

function markSurfaceAirbrushResourceRetired(resource = null) {
  const texture = surfaceAirbrushResourceTexture(resource);
  if (!texture) {
    return false;
  }
  texture.userData ||= {};
  texture.userData.texturePaintTslSurfaceAirbrushRetiredResource = true;
  texture.userData.texturePaintTslSurfaceAirbrushRetiredAtMs = surfaceAirbrushNowMs();
  return true;
}

function surfaceAirbrushStableTextureFromLiveTarget(texture = null) {
  if (!surfaceAirbrushTextureIsLiveTarget(texture)) {
    return texture || null;
  }
  const userData = texture.userData || {};
  for (const candidate of [
    userData.texturePaintTslSurfaceDisplayOriginalMap,
    userData.textureAirbrushWebGpuCanvasMap,
    userData.clonePaintOriginalMap,
    userData.textureAirbrushWebGpuExternalMap
  ]) {
    if (candidate && !surfaceAirbrushTextureIsLiveTarget(candidate)) {
      return candidate;
    }
  }
  return null;
}

function surfaceAirbrushTextureAppearsBound(editor = null, texture = null) {
  if (!editor || !texture) {
    return surfaceAirbrushTextureIsLiveTarget(texture);
  }
  let bound = false;
  editor.model?.traverse?.((node) => {
    if (bound || !node?.material) {
      return;
    }
    for (const material of materialArray(node.material)) {
      const userData = material?.userData || {};
      if (
        material?.map === texture
        || material?.map?.userData?.texturePaintTslSurfaceDisplaySourceTexture === texture
        || userData.clonePaintTexture === texture
        || userData.textureAirbrushWebGpuCanvasMap === texture
        || userData.textureAirbrushWebGpuExternalMap === texture
      ) {
        bound = true;
        return;
      }
    }
  });
  return bound;
}

function parkSurfaceAirbrushResource(holder = null, resource = null) {
  if (!resource) {
    return false;
  }
  const editor = surfaceAirbrushEditorFromHolder(holder);
  const parked = editor
    ? (editor.texturePaintTslSurfaceAirbrushParkedResources ||= new Set())
    : null;
  parked?.add(resource);
  scheduleSurfaceAirbrushParkedResourceReap(editor);
  return true;
}

function reapSurfaceAirbrushParkedResources(editor = null) {
  const parked = editor?.texturePaintTslSurfaceAirbrushParkedResources || null;
  if (!parked?.size) {
    return 0;
  }
  let disposed = 0;
  for (const resource of Array.from(parked)) {
    const texture = surfaceAirbrushResourceTexture(resource);
    if (surfaceAirbrushTextureIsLiveTarget(texture)) {
      continue;
    }
    if (surfaceAirbrushTextureAppearsBound(editor, texture)) {
      continue;
    }
    if (surfaceAirbrushResourceRetireAgeMs(resource) < SURFACE_AIRBRUSH_RETIRE_MIN_AGE_MS) {
      scheduleSurfaceAirbrushParkedResourceReap(editor);
      continue;
    }
    parked.delete(resource);
    if (disposeSurfaceAirbrushResourceNow(resource)) {
      disposed += 1;
    }
  }
  return disposed;
}

function scheduleAfterSurfaceAirbrushGpuIdle(editor = null, callback = null) {
  if (typeof callback !== "function") {
    return false;
  }
  const host = typeof window !== "undefined" ? window : globalThis;
  const runAfterQueue = () => {
    const device = editor?.textureAirbrushWebGpuDevice?.() || editor?.renderer?.backend?.device || null;
    const queueDone = typeof device?.queue?.onSubmittedWorkDone === "function"
      ? device.queue.onSubmittedWorkDone()
      : null;
    if (queueDone && typeof queueDone.then === "function") {
      queueDone.then(callback, () => {
        if (typeof host?.setTimeout === "function") {
          host.setTimeout(callback, SURFACE_AIRBRUSH_RETIRE_FALLBACK_MS);
        } else {
          callback();
        }
      });
      return;
    }
    if (typeof host?.setTimeout === "function") {
      host.setTimeout(callback, SURFACE_AIRBRUSH_RETIRE_FALLBACK_MS);
    } else {
      callback();
    }
  };
  if (typeof host?.requestAnimationFrame === "function") {
    host.requestAnimationFrame(() => {
      host.requestAnimationFrame(runAfterQueue);
    });
  } else if (typeof host?.setTimeout === "function") {
    host.setTimeout(runAfterQueue, 32);
  } else {
    runAfterQueue();
  }
  return true;
}

function scheduleSurfaceAirbrushParkedResourceReap(editor = null) {
  if (!editor || editor.texturePaintTslSurfaceAirbrushParkedResourceReapScheduled === true) {
    return false;
  }
  const parked = editor.texturePaintTslSurfaceAirbrushParkedResources || null;
  if (!parked?.size) {
    return false;
  }
  editor.texturePaintTslSurfaceAirbrushParkedResourceReapScheduled = true;
  const run = () => {
    editor.texturePaintTslSurfaceAirbrushParkedResourceReapScheduled = false;
    reapSurfaceAirbrushParkedResources(editor);
  };
  return scheduleAfterSurfaceAirbrushGpuIdle(editor, run);
}

function retireSurfaceAirbrushResource(holder = null, resource = null) {
  if (!resource) {
    return false;
  }
  const editor = surfaceAirbrushEditorFromHolder(holder);
  markSurfaceAirbrushResourceRetired(resource);
  const texture = surfaceAirbrushResourceTexture(resource);
  if (surfaceAirbrushTextureAppearsBound(editor, texture)) {
    parkSurfaceAirbrushResource(holder, resource);
    return true;
  }
  const retired = editor
    ? (editor.texturePaintTslSurfaceAirbrushRetiredResources ||= new Set())
    : null;
  const entry = { resource };
  retired?.add(entry);
  const release = () => {
    if (surfaceAirbrushTextureAppearsBound(editor, texture)) {
      parkSurfaceAirbrushResource(holder, resource);
      retired?.delete(entry);
      return;
    }
    if (surfaceAirbrushResourceRetireAgeMs(resource) < SURFACE_AIRBRUSH_RETIRE_MIN_AGE_MS) {
      parkSurfaceAirbrushResource(holder, resource);
      retired?.delete(entry);
      return;
    }
    retired?.delete(entry);
    disposeSurfaceAirbrushResourceNow(resource);
  };
  scheduleAfterSurfaceAirbrushGpuIdle(editor, release);
  if (retired && retired.size > SURFACE_AIRBRUSH_RETIRED_RESOURCE_LIMIT) {
    const [oldest] = retired;
    if (oldest && oldest !== entry) {
      retired.delete(oldest);
      parkSurfaceAirbrushResource(holder, oldest.resource);
    }
  }
  return true;
}

function retireSurfaceAirbrushResources(holder = null, resources = []) {
  let retired = 0;
  for (const resource of Array.isArray(resources) ? resources : []) {
    if (retireSurfaceAirbrushResource(holder, resource)) {
      retired += 1;
    }
  }
  return retired;
}

function projectedTriangleView(triangle = null) {
  const a = viewFromScreenPoint(triangle?.screenA || triangle?.screen?.a);
  const b = viewFromScreenPoint(triangle?.screenB || triangle?.screen?.b);
  const c = viewFromScreenPoint(triangle?.screenC || triangle?.screen?.c);
  return a && b && c ? [a, b, c] : null;
}

function projectedTriangleScreen(triangle = null) {
  const a = finitePoint(triangle?.screenA || triangle?.screen?.a);
  const b = finitePoint(triangle?.screenB || triangle?.screen?.b);
  const c = finitePoint(triangle?.screenC || triangle?.screen?.c);
  return a && b && c ? [a, b, c] : null;
}

function screenBoundsForPoints(points = []) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      continue;
    }
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)
    ? { minX, minY, maxX, maxY }
    : null;
}

function screenBoundsOverlap(left = null, right = null, margin = 0) {
  return Boolean(
    left
    && right
    && left.minX <= right.maxX + margin
    && left.maxX >= right.minX - margin
    && left.minY <= right.maxY + margin
    && left.maxY >= right.minY - margin
  );
}

function screenPointDistance(left = null, right = null) {
  if (
    !Number.isFinite(left?.x)
    || !Number.isFinite(left?.y)
    || !Number.isFinite(right?.x)
    || !Number.isFinite(right?.y)
  ) {
    return Infinity;
  }
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function screenPointToSegmentDistance(point = null, start = null, end = null) {
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
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.000001) {
    return screenPointDistance(point, start);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function screenOrientation(a = null, b = null, c = null) {
  if (
    !Number.isFinite(a?.x)
    || !Number.isFinite(a?.y)
    || !Number.isFinite(b?.x)
    || !Number.isFinite(b?.y)
    || !Number.isFinite(c?.x)
    || !Number.isFinite(c?.y)
  ) {
    return NaN;
  }
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function screenPointOnSegment(point = null, start = null, end = null) {
  return screenPointToSegmentDistance(point, start, end) <= 0.0001;
}

function screenSegmentsIntersect(a = null, b = null, c = null, d = null) {
  const abC = screenOrientation(a, b, c);
  const abD = screenOrientation(a, b, d);
  const cdA = screenOrientation(c, d, a);
  const cdB = screenOrientation(c, d, b);
  if (![abC, abD, cdA, cdB].every(Number.isFinite)) {
    return false;
  }
  if (
    (Math.abs(abC) <= 0.0001 && screenPointOnSegment(c, a, b))
    || (Math.abs(abD) <= 0.0001 && screenPointOnSegment(d, a, b))
    || (Math.abs(cdA) <= 0.0001 && screenPointOnSegment(a, c, d))
    || (Math.abs(cdB) <= 0.0001 && screenPointOnSegment(b, c, d))
  ) {
    return true;
  }
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function screenPointInTriangle(point = null, triangle = []) {
  if (!point || triangle.length < 3) {
    return false;
  }
  const [a, b, c] = triangle;
  const area = screenOrientation(a, b, c);
  if (!Number.isFinite(area) || Math.abs(area) <= 0.000001) {
    return false;
  }
  const ab = screenOrientation(a, b, point);
  const bc = screenOrientation(b, c, point);
  const ca = screenOrientation(c, a, point);
  const hasNegative = ab < -0.0001 || bc < -0.0001 || ca < -0.0001;
  const hasPositive = ab > 0.0001 || bc > 0.0001 || ca > 0.0001;
  return !(hasNegative && hasPositive);
}

function screenSegmentToSegmentDistance(a = null, b = null, c = null, d = null) {
  if (screenSegmentsIntersect(a, b, c, d)) {
    return 0;
  }
  return Math.min(
    screenPointToSegmentDistance(a, c, d),
    screenPointToSegmentDistance(b, c, d),
    screenPointToSegmentDistance(c, a, b),
    screenPointToSegmentDistance(d, a, b)
  );
}

function screenTriangleDistanceToSegment(screenPoints = [], segment = null) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (screenPoints.length < 3 || !start || !end) {
    return Infinity;
  }
  if (screenPointInTriangle(start, screenPoints) || screenPointInTriangle(end, screenPoints)) {
    return 0;
  }
  let distance = Infinity;
  for (let index = 0; index < 3; index += 1) {
    distance = Math.min(
      distance,
      screenSegmentToSegmentDistance(start, end, screenPoints[index], screenPoints[(index + 1) % 3])
    );
  }
  return distance;
}

function screenTriangleNearSegmentDomain(screenPoints = [], segments = [], scatter = 0) {
  const triangleBounds = screenBoundsForPoints(screenPoints);
  if (!triangleBounds || !segments.length) {
    return false;
  }
  for (const segment of segments) {
    const segmentBounds = screenBoundsForPoints([segment.start, segment.end]);
    const domainRadius = Math.max(
      1,
      finiteNumber(segment.radius, 1) * (1 + clamp01(scatter) * 0.65) + 32
    );
    if (
      screenBoundsOverlap(triangleBounds, segmentBounds, domainRadius)
      && screenTriangleDistanceToSegment(screenPoints, segment) <= domainRadius
    ) {
      return true;
    }
  }
  return false;
}

function screenBoundsExpand(bounds = null, margin = 0) {
  return bounds
    ? {
        minX: bounds.minX - margin,
        minY: bounds.minY - margin,
        maxX: bounds.maxX + margin,
        maxY: bounds.maxY + margin
      }
    : null;
}

function screenBoundsUnion(boundsList = []) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const bounds of boundsList) {
    if (!bounds) {
      continue;
    }
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  return Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)
    ? { minX, minY, maxX, maxY }
    : null;
}

function sourceRasterClipSegments(options = {}) {
  return Array.isArray(options.sourceRasterClipSegments)
    ? options.sourceRasterClipSegments
      .map((segment) => {
        const start = finitePoint(segment?.start);
        const end = finitePoint(segment?.end);
        if (!start || !end) {
          return null;
        }
        return {
          start,
          end,
          radius: Math.max(
            1,
            finiteNumber(segment.radius, finiteNumber(segment.radiusPixels, 1)),
            finiteNumber(segment.screenRadiusPixels, 0)
          )
        };
      })
      .filter(Boolean)
    : [];
}

function simplifiedSourceRasterClipSegments(segments = [], maxSegments = 16) {
  const normalized = sourceRasterClipSegments({ sourceRasterClipSegments: segments });
  if (normalized.length <= maxSegments) {
    return normalized;
  }
  const maxPoints = Math.max(2, Math.floor(maxSegments) + 1);
  const stride = Math.max(1, Math.ceil(normalized.length / Math.max(1, maxPoints - 1)));
  const points = [];
  const appendPoint = (point = null, radius = 1) => {
    const screenPoint = finitePoint(point);
    if (!screenPoint) {
      return;
    }
    const resolvedRadius = Math.max(1, finiteNumber(radius, 1));
    const previous = points[points.length - 1] || null;
    if (previous && pointDistance(previous, screenPoint) <= 0.001) {
      previous.radius = Math.max(previous.radius, resolvedRadius);
      return;
    }
    points.push({
      x: screenPoint.x,
      y: screenPoint.y,
      radius: resolvedRadius
    });
  };
  appendPoint(normalized[0]?.start, normalized[0]?.radius);
  for (let index = 0; index < normalized.length; index += stride) {
    const segment = normalized[index];
    appendPoint(segment?.end, segment?.radius);
  }
  appendPoint(normalized[normalized.length - 1]?.end, normalized[normalized.length - 1]?.radius);
  const output = [];
  for (let index = 1; index < points.length && output.length < maxSegments; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    output.push({
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
      radius: Math.max(start.radius, end.radius)
    });
  }
  return output;
}

function sourceRasterClipScatter(options = {}) {
  return clamp01(finiteNumber(
    options.sourceRasterClipScatter,
    finiteNumber(options.scatter, 0.35)
  ));
}

function sourceRasterClipHardness(options = {}) {
  return clamp01(finiteNumber(
    options.sourceRasterClipHardness,
    finiteNumber(options.hardness, 0.35)
  ));
}

function sourceRasterClipPaddingPixels(options = {}) {
  return Math.max(
    12,
    finiteNumber(options.sourceRasterClipPaddingPixels, 0)
  );
}

function sourceRasterClipDomainRadius(segment = null, options = {}) {
  const radius = Math.max(1, finiteNumber(segment?.radius, finiteNumber(segment?.radiusPixels, 1)));
  const scatter = sourceRasterClipScatter(options);
  const hardness = sourceRasterClipHardness(options);
  const softness = 1 - hardness;
  return radius * (
    1
    + scatter * (TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE + 0.35)
    + softness * TEXTURE_AIRBRUSH_SOFT_HALO_SCALE
  )
    + sourceRasterClipPaddingPixels(options);
}

function screenTriangleNearSourceRasterClip(screenPoints = [], options = {}) {
  const segments = sourceRasterClipSegments(options);
  const triangleBounds = screenBoundsForPoints(screenPoints);
  if (!triangleBounds || !segments.length) {
    return true;
  }
  for (const segment of segments) {
    const segmentBounds = screenBoundsForPoints([segment.start, segment.end]);
    const domainRadius = sourceRasterClipDomainRadius(segment, options);
    if (
      screenBoundsOverlap(triangleBounds, segmentBounds, domainRadius)
      && screenTriangleDistanceToSegment(screenPoints, segment) <= domainRadius
    ) {
      return true;
    }
  }
  return false;
}

function sourceRasterClipKey(options = {}) {
  const segments = sourceRasterClipSegments(options);
  if (!segments.length) {
    return "";
  }
  return [
    sourceRasterClipScatter(options),
    sourceRasterClipHardness(options),
    sourceRasterClipPaddingPixels(options),
    segments.map((segment) => [
      roundedSurfaceKeyNumber(segment.start.x, 10),
      roundedSurfaceKeyNumber(segment.start.y, 10),
      roundedSurfaceKeyNumber(segment.end.x, 10),
      roundedSurfaceKeyNumber(segment.end.y, 10),
      roundedSurfaceKeyNumber(segment.radius, 10)
    ].join(",")).join(";")
  ].join("|");
}

function filterProjectedTrianglesForScreenBrush(triangles = [], segments = [], options = {}) {
  if (!Array.isArray(triangles) || !triangles.length || !segments.length) {
    return [];
  }
  const scatter = Number.isFinite(Number(options.scatter)) ? Number(options.scatter) : 0.35;
  const domainSegments = simplifiedSourceRasterClipSegments(segments, 24);
  const domains = domainSegments
    .map((segment) => {
      const bounds = screenBoundsForPoints([segment.start, segment.end]);
      const radius = Math.max(
        1,
        finiteNumber(segment.radius, 1) * (1 + clamp01(scatter) * 0.65) + 32
      );
      return bounds
        ? {
            segment,
            radius,
            bounds: screenBoundsExpand(bounds, radius)
          }
        : null;
    })
    .filter(Boolean);
  const strokeBounds = screenBoundsUnion(domains.map((domain) => domain.bounds));
  if (!domains.length || !strokeBounds) {
    return [];
  }
  return triangles.filter((triangle) => {
    const screen = projectedTriangleScreen(triangle);
    const triangleBounds = triangle?.screenBounds || screenBoundsForPoints(screen || []);
    if (!screen || !screenBoundsOverlap(triangleBounds, strokeBounds, 0)) {
      return false;
    }
    for (const domain of domains) {
      if (
        screenBoundsOverlap(triangleBounds, domain.bounds, 0)
        && screenTriangleDistanceToSegment(screen, domain.segment) <= domain.radius
      ) {
        return true;
      }
    }
    return false;
  });
}

function projectedTriangleDebugSamples(triangles = [], limit = 4) {
  const samples = [];
  for (const triangle of Array.isArray(triangles) ? triangles : []) {
    if (samples.length >= limit) {
      break;
    }
    const screen = projectedTriangleScreen(triangle);
    const texture = projectedTrianglePixels(triangle);
    const screenBounds = screenBoundsForPoints(screen || []);
    const textureBounds = screenBoundsForPoints(texture || []);
    if (!screenBounds && !textureBounds) {
      continue;
    }
    samples.push({
      ...(screenBounds ? { screenBounds } : {}),
      ...(textureBounds ? { textureBounds } : {}),
      componentId: Number.isInteger(Math.floor(Number(triangle?.componentId)))
        ? Math.floor(Number(triangle.componentId))
        : null,
      screen,
      texture
    });
  }
  return samples;
}

function geometryTriangleMaterialIndex(geometry = null, elementStart = 0) {
  const groups = Array.isArray(geometry?.groups) ? geometry.groups : [];
  if (!groups.length) {
    return 0;
  }
  for (const group of groups) {
    const start = Math.max(0, Math.floor(Number(group.start) || 0));
    const count = Math.max(0, Math.floor(Number(group.count) || 0));
    if (elementStart >= start && elementStart < start + count) {
      return Math.max(0, Math.floor(Number(group.materialIndex) || 0));
    }
  }
  return 0;
}

function vertexIndexAt(geometry = null, elementIndex = 0) {
  const index = geometry?.index || null;
  if (index && typeof index.getX === "function") {
    return Math.max(0, Math.floor(Number(index.getX(elementIndex)) || 0));
  }
  return Math.max(0, Math.floor(Number(elementIndex) || 0));
}

function worldPositionForVertex(object = null, geometry = null, vertexIndex = 0) {
  const position = geometry?.attributes?.position || null;
  if (!object || !position) {
    return null;
  }
  const point = _scratchWorld;
  if (typeof object.applyBoneTransform === "function") {
    point.fromBufferAttribute(position, vertexIndex);
    object.applyBoneTransform(vertexIndex, point);
  } else if (typeof object.boneTransform === "function") {
    point.fromBufferAttribute(position, vertexIndex);
    object.boneTransform(vertexIndex, point);
  } else {
    point.fromBufferAttribute(position, vertexIndex);
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
    return null;
  }
  object.localToWorld?.(point);
  return {
    x: point.x,
    y: point.y,
    z: point.z
  };
}

function viewNormalForVertex(object = null, geometry = null, vertexIndex = 0, editor = null) {
  const normal = geometry?.attributes?.normal || null;
  const camera = editor?.camera || null;
  if (!object || !normal || !camera) {
    return null;
  }
  _scratchNormal.fromBufferAttribute(normal, vertexIndex);
  if (!_scratchNormal.lengthSq()) {
    return null;
  }
  skinLocalNormalForVertex(object, geometry, vertexIndex, _scratchNormal);
  _scratchNormalMatrix.getNormalMatrix(object.matrixWorld);
  _scratchNormal.applyMatrix3(_scratchNormalMatrix).normalize();
  _scratchNormal.transformDirection(camera.matrixWorldInverse);
  if (!Number.isFinite(_scratchNormal.x) || !Number.isFinite(_scratchNormal.y) || !Number.isFinite(_scratchNormal.z)) {
    return null;
  }
  return {
    x: _scratchNormal.x,
    y: _scratchNormal.y,
    z: _scratchNormal.z
  };
}

function screenPointForWorld(editor = null, world = null) {
  const camera = editor?.camera || null;
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  if (!camera || !rect || !Number.isFinite(world?.x) || !Number.isFinite(world?.y) || !Number.isFinite(world?.z)) {
    return null;
  }
  const view = _scratchView.set(world.x, world.y, world.z).applyMatrix4(camera.matrixWorldInverse);
  const viewX = view.x;
  const viewY = view.y;
  const viewZ = view.z;
  const clip = _scratchClip.set(viewX, viewY, viewZ).applyMatrix4(camera.projectionMatrix);
  if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y) || !Number.isFinite(viewZ)) {
    return null;
  }
  return {
    x: (clip.x * 0.5 + 0.5) * rect.width,
    y: (-clip.y * 0.5 + 0.5) * rect.height,
    z: Number.isFinite(clip.z) ? clip.z : 0,
    viewX,
    viewY,
    viewZ,
    clipW: camera.isPerspectiveCamera ? Math.abs(viewZ) : 1
  };
}

function roundedSurfaceKeyNumber(value = null, scale = 1000000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * scale) : "n";
}

function matrixSurfaceKey(matrix = null, scale = 1000000) {
  const elements = matrix?.elements || matrix || null;
  if (!elements?.length) {
    return "";
  }
  return Array.from(elements)
    .map((value) => roundedSurfaceKeyNumber(value, scale))
    .join(",");
}

function arraySurfaceKey(values = null, scale = 100000) {
  if (!values?.length) {
    return "";
  }
  return Array.from(values)
    .map((value) => roundedSurfaceKeyNumber(value, scale))
    .join(",");
}

function surfaceDebugKeyHash(value = "") {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(36)}:${text.length}`;
}

function surfaceTextureDebugName(texture = null) {
  if (!texture) {
    return "";
  }
  return String(texture.name || texture.uuid || texture.id || texture.constructor?.name || "texture");
}

function sourceObjectSurfaceProjectionKey(sourceObject = null) {
  const geometry = sourceObject?.geometry || null;
  return [
    sourceObject?.uuid || sourceObject?.id || sourceObject?.name || "object",
    geometry?.uuid || geometry?.id || "geometry",
    Number(geometry?.attributes?.position?.version) || 0,
    Number(geometry?.attributes?.normal?.version) || 0,
    Number(geometry?.attributes?.uv?.version) || 0,
    Number(geometry?.index?.version) || 0,
    matrixSurfaceKey(sourceObject?.matrixWorld),
    arraySurfaceKey(sourceObject?.skeleton?.boneMatrices, 10000),
    arraySurfaceKey(sourceObject?.morphTargetInfluences, 100000)
  ].join("|");
}

function sourceObjectUvCoverageKey(sourceObject = null) {
  const geometry = sourceObject?.geometry || null;
  return [
    sourceObject?.uuid || sourceObject?.id || sourceObject?.name || "object",
    geometry?.uuid || geometry?.id || "geometry",
    Number(geometry?.attributes?.position?.version) || 0,
    Number(geometry?.attributes?.uv?.version) || 0,
    Number(geometry?.index?.version) || 0,
    maxGeometryGroupMaterialIndex(geometry)
  ].join("|");
}

function surfaceProjectionFrameKey(editor = null, sourceObjects = []) {
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  const camera = editor?.camera || null;
  camera?.updateMatrixWorld?.(true);
  const objectKeys = [];
  for (const sourceObject of Array.isArray(sourceObjects) ? sourceObjects : []) {
    sourceObject?.updateMatrixWorld?.(true);
    objectKeys.push(sourceObjectSurfaceProjectionKey(sourceObject));
  }
  return [
    rect?.width || editor?.canvas?.clientWidth || editor?.canvas?.width || 0,
    rect?.height || editor?.canvas?.clientHeight || editor?.canvas?.height || 0,
    Number(editor?.textureAirbrushCameraPrewarmSerial) || 0,
    matrixSurfaceKey(camera?.matrixWorldInverse),
    matrixSurfaceKey(camera?.projectionMatrix),
    objectKeys.join(";")
  ].join(":");
}

function texturePixelForUv(uvAttribute = null, vertexIndex = 0, texture = null, width = 1, height = 1) {
  if (!uvAttribute || !texture || typeof uvAttribute.getX !== "function" || typeof uvAttribute.getY !== "function") {
    return null;
  }
  if (texture.matrixAutoUpdate !== false && typeof texture.updateMatrix === "function") {
    texture.updateMatrix();
  }
  const uv = _scratchUv.set(uvAttribute.getX(vertexIndex), uvAttribute.getY(vertexIndex));
  if (texture.matrix && typeof uv.applyMatrix3 === "function") {
    uv.applyMatrix3(texture.matrix);
  }
  const displayFlipY = texture?.userData?.texturePaintTslSurfaceDisplayFlipY === true;
  const x = uv.x * Math.max(1, width - 1);
  const y = (
    texture.flipY === true || displayFlipY
      ? 1 - uv.y
      : uv.y
  ) * Math.max(1, height - 1);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function textureNodeAppliesFlipY(texture = null) {
  if (surfaceAirbrushTextureIsLiveTarget(texture)) {
    return false;
  }
  return Boolean(
    texture?.isRenderTargetTexture === true
    || texture?.isFramebufferTexture === true
    || texture?.isDepthTexture === true
    || (
      typeof ImageBitmap !== "undefined"
      && texture?.image instanceof ImageBitmap
      && texture.flipY === true
    )
  );
}

function meshUvProjectedTriangles(editor = null, candidate = null, width = 1, height = 1) {
  const object = candidate?.hit?.object || candidate?.record?.object || null;
  const geometry = object?.geometry || candidate?.record?.geometry || null;
  const uvAttribute = geometry?.attributes?.uv || null;
  const position = geometry?.attributes?.position || null;
  const fallbackMaterialIndex = Math.max(0, Math.floor(Number(candidate?.materialIndex ?? candidate?.hit?.face?.materialIndex) || 0));
  const editable = candidate?.editable || null;
  const texture = candidate?.editable?.texture || candidate?.material?.map || null;
  if (!object || !geometry || !uvAttribute || !position || !texture) {
    return [];
  }
  const editableTextures = surfaceEditableTextureSet(candidate, editable, texture, candidate?.material?.map || texture);
  const paintMaterialIndices = sourceObjectMaterialPaintIndices(
    object,
    editable,
    editableTextures,
    fallbackMaterialIndex
  );
  object.updateMatrixWorld?.(true);
  editor?.camera?.updateMatrixWorld?.(true);
  const elementCount = geometry.index?.count || position.count || 0;
  const vertexCount = Math.max(
    0,
    Math.floor(Number(position.count) || 0),
    Math.floor(Number(uvAttribute.count) || 0)
  );
  const uvPixels = new Array(vertexCount);
  const screenPoints = new Array(vertexCount);
  const viewNormals = new Array(vertexCount);
  const getUvPixel = (vertexIndex = 0) => {
    if (vertexIndex < 0 || vertexIndex >= vertexCount) {
      return null;
    }
    if (uvPixels[vertexIndex] === undefined) {
      uvPixels[vertexIndex] = texturePixelForUv(uvAttribute, vertexIndex, texture, width, height) || null;
    }
    return uvPixels[vertexIndex];
  };
  const getScreenPoint = (vertexIndex = 0) => {
    if (vertexIndex < 0 || vertexIndex >= vertexCount) {
      return null;
    }
    if (screenPoints[vertexIndex] === undefined) {
      screenPoints[vertexIndex] = screenPointForWorld(
        editor,
        worldPositionForVertex(object, geometry, vertexIndex)
      ) || null;
    }
    return screenPoints[vertexIndex];
  };
  const getViewNormal = (vertexIndex = 0, fallback = null) => {
    if (vertexIndex < 0 || vertexIndex >= vertexCount) {
      return fallback;
    }
    if (viewNormals[vertexIndex] === undefined) {
      viewNormals[vertexIndex] = viewNormalForVertex(object, geometry, vertexIndex, editor) || null;
    }
    return viewNormals[vertexIndex] || fallback;
  };
  const triangles = [];
  for (let elementStart = 0; elementStart + 2 < elementCount; elementStart += 3) {
    if (!paintMaterialIndices.has(geometryTriangleMaterialIndex(geometry, elementStart))) {
      continue;
    }
    const ia = vertexIndexAt(geometry, elementStart);
    const ib = vertexIndexAt(geometry, elementStart + 1);
    const ic = vertexIndexAt(geometry, elementStart + 2);
    const a = getUvPixel(ia);
    const b = getUvPixel(ib);
    const c = getUvPixel(ic);
    if (!a || !b || !c || Math.abs(triangleArea2(a, b, c)) <= 0.000001) {
      continue;
    }
    const screenA = getScreenPoint(ia);
    const screenB = getScreenPoint(ib);
    const screenC = getScreenPoint(ic);
    if (!screenA || !screenB || !screenC) {
      continue;
    }
    const normalA = getViewNormal(ia, { x: 0, y: 0, z: 1 });
    const normalB = getViewNormal(ib, normalA);
    const normalC = getViewNormal(ic, normalB);
    triangles.push({
      a,
      b,
      c,
      screenA,
      screenB,
      screenC,
      screenBounds: screenBoundsForPoints([screenA, screenB, screenC]),
      normalA,
      normalB,
      normalC
    });
  }
  return triangles;
}

function meshUvProjectedTrianglesCacheKey(editor = null, candidate = null, width = 1, height = 1) {
  const object = candidate?.hit?.object || candidate?.record?.object || null;
  const geometry = object?.geometry || candidate?.record?.geometry || null;
  const editable = candidate?.editable || null;
  const texture = candidate?.editable?.texture || candidate?.material?.map || null;
  if (!object || !geometry || !texture) {
    return "";
  }
  const materials = materialArray(object.material);
  const materialKey = materials.map((material, index) => [
    index,
    material?.uuid || material?.id || ""
  ].join(",")).join(";");
  return [
    width,
    height,
    texture.flipY === true ? "flipY" : "noFlipY",
    texture.matrixAutoUpdate === false ? "staticMatrix" : "autoMatrix",
    matrixSurfaceKey(texture.matrix),
    editable?.canvas?.width || 0,
    editable?.canvas?.height || 0,
    Math.max(0, Math.floor(Number(candidate?.materialIndex ?? candidate?.hit?.face?.materialIndex) || 0)),
    materialKey,
    surfaceProjectionFrameKey(editor, [object])
  ].join("|");
}

function cachedMeshUvProjectedTriangles(cache = null, editor = null, candidate = null, width = 1, height = 1) {
  if (!cache) {
    return meshUvProjectedTriangles(editor, candidate, width, height);
  }
  const key = meshUvProjectedTrianglesCacheKey(editor, candidate, width, height);
  if (key && cache.meshUvProjectedTrianglesKey === key && Array.isArray(cache.meshUvProjectedTriangles)) {
    return cache.meshUvProjectedTriangles;
  }
  const triangles = meshUvProjectedTriangles(editor, candidate, width, height);
  cache.meshUvProjectedTrianglesKey = key;
  cache.meshUvProjectedTriangles = triangles;
  return triangles;
}

function sourceObjectForCandidate(candidate = null) {
  return candidate?.hit?.object || candidate?.record?.object || null;
}

function sourceGeometryForCandidate(candidate = null) {
  return sourceObjectForCandidate(candidate)?.geometry || candidate?.record?.geometry || null;
}

function materialArray(material = null) {
  return Array.isArray(material)
    ? material.filter(Boolean)
    : material
      ? [material]
      : [];
}

function materialUsesEditableTexture(material = null, editable = null, textures = new Set(), options = {}) {
  if (!material) {
    return false;
  }
  const allowImageMatch = options.allowImageMatch !== false;
  const userData = material.userData || {};
  const materialMap = material.map || null;
  const materialImage = materialMap?.image || materialMap?.source?.data || null;
  const materialLinkedToEditable = Boolean(
    userData.clonePaintCanvas === editable?.canvas
    || userData.clonePaintContext === editable?.context
    || userData.clonePaintTexture === editable?.texture
    || userData.textureAirbrushWebGpuCanvasMap === editable?.texture
    || userData.textureAirbrushWebGpuExternalMap === editable?.texture
  );
  const editableImages = new Set([
    editable?.canvas,
    editable?.compositeCanvas,
    editable?.texture?.image,
    editable?.texture?.source?.data,
    materialLinkedToEditable ? userData.clonePaintCanvas : null,
    materialLinkedToEditable ? userData.clonePaintTexture?.image : null,
    materialLinkedToEditable ? userData.clonePaintTexture?.source?.data : null,
    materialLinkedToEditable ? userData.clonePaintOriginalMap?.image : null,
    materialLinkedToEditable ? userData.clonePaintOriginalMap?.source?.data : null
  ].filter(Boolean));
  if (allowImageMatch && materialImage && editableImages.has(materialImage)) {
    return true;
  }
  for (const texture of textures) {
    if (!texture) {
      continue;
    }
    if (materialMap === texture) {
      return true;
    }
    const textureImage = texture.image || texture.source?.data || null;
    if (allowImageMatch && materialImage && textureImage && materialImage === textureImage) {
      return true;
    }
  }
  return Boolean(
    textures.has(materialMap)
    || textures.has(userData.clonePaintTexture)
    || textures.has(userData.clonePaintOriginalMap)
    || textures.has(userData.textureAirbrushWebGpuCanvasMap)
    || textures.has(userData.textureAirbrushWebGpuExternalMap)
    || userData.clonePaintCanvas === editable?.canvas
  );
}

function surfaceEditableTextureSet(candidate = null, editable = null, sourceTexture = null, referenceTexture = null) {
  return new Set([
    sourceTexture,
    referenceTexture,
    editable?.texture,
    candidate?.material?.map,
    candidate?.material?.userData?.clonePaintTexture,
    candidate?.material?.userData?.clonePaintOriginalMap,
    candidate?.material?.userData?.textureAirbrushWebGpuCanvasMap,
    candidate?.material?.userData?.textureAirbrushWebGpuExternalMap
  ].filter(Boolean));
}

function sourceObjectMaterialPaintIndices(
  sourceObject = null,
  editable = null,
  textures = new Set(),
  fallbackMaterialIndex = null,
  options = {}
) {
  const indices = new Set();
  const materials = materialArray(sourceObject?.material);
  if (options.restrictToFallbackMaterialIndex === true && Number.isFinite(Number(fallbackMaterialIndex))) {
    indices.add(Math.max(0, Math.floor(Number(fallbackMaterialIndex) || 0)));
    return indices;
  }
  if (options.includeAllMaterialIndices === true && materials.length) {
    for (let index = 0; index < materials.length; index += 1) {
      indices.add(index);
    }
    return indices;
  }
  for (let index = 0; index < materials.length; index += 1) {
    if (materialUsesEditableTexture(materials[index], editable, textures)) {
      indices.add(index);
    }
  }
  if (!indices.size && Number.isFinite(Number(fallbackMaterialIndex))) {
    indices.add(Math.max(0, Math.floor(Number(fallbackMaterialIndex) || 0)));
  }
  if (!indices.size && materials.length <= 1) {
    indices.add(0);
  }
  return indices;
}

function materialScopeOptionsForSourceObject(options = {}, sourceObject = null, fallbackSourceObject = null) {
  void sourceObject;
  void fallbackSourceObject;
  if (options?.includeAllMaterialIndices === true) {
    return options || {};
  }
  const scoped = { ...(options || {}) };
  delete scoped.includeFallbackObjectMaterialIndices;
  return scoped;
}

function maxGeometryGroupMaterialIndex(geometry = null) {
  let maxIndex = 0;
  for (const group of Array.isArray(geometry?.groups) ? geometry.groups : []) {
    maxIndex = Math.max(maxIndex, Math.max(0, Math.floor(Number(group.materialIndex) || 0)));
  }
  return maxIndex;
}

function stableSurfaceAirbrushCacheKey(editable = null) {
  return editable?.canvas || editable?.compositeCanvas || editable?.texture || editable || null;
}

function resetSurfaceAirbrushDynamicState(cache = null) {
  if (!cache) {
    return false;
  }
  cache.currentTexture = null;
  cache.hasPaintedSurfaceStroke = false;
  cache.previousSurfaceStrokeSegment = null;
  cache.surfaceStrokeSegments = [];
  cache.lastSurfaceStrokeAppendSegments = [];
  cache.strokeResetOwner = null;
  cache.strokeBaseTexture = null;
  cache.strokeBaseWasEmptyLayer = false;
  cache.strokeBaseEmptyLayerOwner = null;
  cache.strokeMaskInitialized = false;
  return true;
}

function surfaceEditableOriginalMap(material = null, editable = null, references = []) {
  const userData = material?.userData || {};
  const explicitOriginalMap = Object.prototype.hasOwnProperty.call(userData, "clonePaintOriginalMap")
    ? userData.clonePaintOriginalMap || null
    : null;
  if (explicitOriginalMap && !surfaceAirbrushTextureIsLiveTarget(explicitOriginalMap)) {
    return explicitOriginalMap;
  }
  const displayReference = userData.textureAirbrushWebGpuCanvasMap
    || material?.map?.userData?.textureAirbrushWebGpuCanvasMap
    || material?.map?.userData?.clonePaintOriginalMap
    || null;
  if (displayReference && !surfaceAirbrushTextureIsLiveTarget(displayReference)) {
    return displayReference;
  }
  for (const texture of references) {
    const stableTexture = surfaceAirbrushStableTextureFromLiveTarget(texture) || texture;
    if (
      stableTexture
      && stableTexture !== editable?.texture
      && !surfaceAirbrushTextureIsLiveTarget(stableTexture)
      && stableTexture?.userData?.textureAirbrushExternalWebGpuDisplay !== true
    ) {
      return stableTexture;
    }
  }
  return null;
}

function surfaceAirbrushReferenceTexture(material = null, editable = null, originalMap = null, cache = null) {
  const displayTexture = material?.map || editable?.texture || null;
  const editableTexture = editable?.texture || null;
  const displayStableTexture = surfaceAirbrushStableTextureFromLiveTarget(displayTexture);
  const editableStableTexture = surfaceAirbrushStableTextureFromLiveTarget(editableTexture);
  for (const texture of [
    originalMap,
    displayStableTexture,
    editableStableTexture,
    !surfaceAirbrushTextureIsLiveTarget(editableTexture)
      && !surfaceAirbrushCacheOwnsTexture(cache, editableTexture)
      ? editableTexture
      : null,
    !surfaceAirbrushTextureIsLiveTarget(displayTexture)
      && !surfaceAirbrushCacheOwnsTexture(cache, displayTexture)
      ? displayTexture
      : null
  ]) {
    if (texture) {
      return texture;
    }
  }
  return null;
}

function bindSurfaceEditableMetadata(material = null, editable = null, finalTexture = null, options = {}) {
  if (!material || !editable?.canvas || !editable?.context || !finalTexture) {
    return false;
  }
  material.userData ||= {};
  const userData = material.userData;
  const originalMap = options.originalMap || surfaceEditableOriginalMap(material, editable, options.references || []);
  if (
    !Object.prototype.hasOwnProperty.call(userData, "clonePaintOriginalMap")
    || (!userData.clonePaintOriginalMap && originalMap)
  ) {
    userData.clonePaintOriginalMap = originalMap || null;
  }
  userData.clonePaintCanvas = editable.canvas;
  userData.clonePaintContext = editable.context;
  userData.clonePaintTexture = finalTexture;
  userData.clonePaintTextureScale = userData.clonePaintTextureScale
    || editable?.texture?.userData?.clonePaintTextureScale
    || finalTexture?.userData?.clonePaintTextureScale
    || 1;
  finalTexture.userData ||= {};
  finalTexture.userData.texturePaintTslSurfaceAirbrushTargetTexture = true;
  if (!finalTexture.userData.textureAirbrushWebGpuCanvasMap && (originalMap || userData.clonePaintOriginalMap)) {
    finalTexture.userData.textureAirbrushWebGpuCanvasMap = originalMap || userData.clonePaintOriginalMap;
  }
  return true;
}

function surfaceLayerBaseCanvasTexture(editor = null, editable = null, referenceTexture = null) {
  if (editable?.layerMode !== true || typeof THREE.CanvasTexture !== "function") {
    return null;
  }
  const stack = editable.layerStack || null;
  const canvas = stack?.baseCanvas || editable.compositeCanvas || null;
  const width = Math.max(0, Math.floor(Number(canvas?.width) || 0));
  const height = Math.max(0, Math.floor(Number(canvas?.height) || 0));
  if (!canvas || !width || !height) {
    return null;
  }
  const owner = stack || editable;
  const serial = Math.max(
    0,
    Math.floor(
      Number(
        editor?.texturePaintLayerMutationSerialValue?.()
        ?? editor?.texturePaintLayerMutationSerial
        ?? 0
      ) || 0
    )
  );
  let entry = owner.texturePaintTslSurfaceBaseCanvasTexture || null;
  if (!entry?.texture || entry.canvas !== canvas) {
    entry?.texture?.dispose?.();
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = stack?.baseCanvas
      ? "texture-paint-layer-stack-base"
      : "texture-paint-layer-composite-base";
    texture.userData ||= {};
    texture.userData.texturePaintTslSurfaceLayerBaseCanvasTexture = true;
    entry = {
      texture,
      canvas,
      serial: -1,
      width: 0,
      height: 0
    };
    owner.texturePaintTslSurfaceBaseCanvasTexture = entry;
  }
  const texture = entry.texture;
  texture.colorSpace = referenceTexture?.colorSpace || THREE.SRGBColorSpace || texture.colorSpace;
  texture.flipY = referenceTexture?.flipY ?? false;
  if ("channel" in texture && referenceTexture && "channel" in referenceTexture) {
    texture.channel = referenceTexture.channel;
  }
  texture.wrapS = referenceTexture?.wrapS || THREE.ClampToEdgeWrapping;
  texture.wrapT = referenceTexture?.wrapT || THREE.ClampToEdgeWrapping;
  texture.magFilter = referenceTexture?.magFilter || THREE.LinearFilter;
  texture.minFilter = MIPMAP_MIN_FILTERS.has(referenceTexture?.minFilter)
    ? (THREE.LinearFilter || texture.minFilter)
    : referenceTexture?.minFilter || THREE.LinearFilter;
  texture.generateMipmaps = false;
  if (entry.serial !== serial || entry.width !== width || entry.height !== height) {
    texture.needsUpdate = true;
    entry.serial = serial;
    entry.width = width;
    entry.height = height;
  }
  return texture;
}

function surfaceLayerBaseTexture(editor = null, material = null, editable = null, originalMap = null) {
  const userData = material?.userData || {};
  if (editable?.layerMode === true) {
    const stableReferenceBase = userData.textureAirbrushWebGpuCanvasMap
      || userData.clonePaintOriginalMap
      || originalMap
      || (surfaceAirbrushTextureIsLiveTarget(material?.map) ? null : material?.map)
      || null;
    const canvasBase = surfaceLayerBaseCanvasTexture(
      editor,
      editable,
      stableReferenceBase || userData.clonePaintTexture || null
    );
    const layerBase = stableReferenceBase
      || (surfaceAirbrushTextureIsLiveTarget(userData.clonePaintTexture) ? null : userData.clonePaintTexture)
      || canvasBase
      || null;
    return layerBase || null;
  }
  const stableBase = userData.clonePaintTexture
    || userData.textureAirbrushWebGpuCanvasMap
    || originalMap
    || null;
  return stableBase
    || editable?.texture
    || material?.map
    || null;
}

function surfaceLayerIndex(stack = null, layer = null) {
  return stack?.layers?.length && layer ? stack.layers.indexOf(layer) : -1;
}

function surfaceLayerMutationSerial(editor = null) {
  return Math.max(
    0,
    Math.floor(
      Number(
        editor?.texturePaintLayerMutationSerialValue?.()
        ?? editor?.texturePaintLayerMutationSerial
        ?? 0
      ) || 0
    )
  );
}

function surfaceLayerDisplayCompositeEntry(material = null) {
  const userData = material?.userData || {};
  for (const entry of [
    userData.texturePaintCompositeGpuTarget,
    userData.texturePaintTslSurfaceAirbrushTarget
  ]) {
    if (entry?.target?.texture || entry?.displayTarget?.texture) {
      return entry;
    }
  }
  return null;
}

function surfaceLayerCompositeTexture(entry = null, preferredTexture = null) {
  if (preferredTexture && (
    preferredTexture === entry?.target?.texture
    || preferredTexture === entry?.displayTarget?.texture
  )) {
    return preferredTexture;
  }
  return entry?.target?.texture || entry?.displayTarget?.texture || null;
}

function surfaceLayerCompositeIsBelowActive(entry = null, editable = null) {
  const stack = editable?.layerStack || entry?.layerStack || null;
  const activeLayer = editable?.layer || null;
  const entryLayer = entry?.layer || null;
  if (!stack?.layers?.length || !activeLayer || !entryLayer || entryLayer === activeLayer) {
    return false;
  }
  const activeIndex = surfaceLayerIndex(stack, activeLayer);
  const entryIndex = surfaceLayerIndex(stack, entryLayer);
  return entryIndex >= 0 && activeIndex >= 0 && entryIndex < activeIndex;
}

function surfaceLayerStoredUnderlayTexture(editor = null, editable = null) {
  const layer = editable?.layer || null;
  const targetEntry = layer?.gpuTarget || null;
  const stack = editable?.layerStack || targetEntry?.layerStack || null;
  if (
    !targetEntry?.liveCompositeBaseTexture
    || targetEntry.liveCompositeLayer !== layer
    || targetEntry.liveCompositeLayerIndex !== surfaceLayerIndex(stack, layer)
    || targetEntry.liveCompositeLayerCount !== (stack?.layers?.length || 0)
    || targetEntry.liveCompositeLayerMutationSerial !== surfaceLayerMutationSerial(editor)
  ) {
    return null;
  }
  return targetEntry.liveCompositeBaseTexture;
}

function surfaceLayerDisplayUnderlayTexture(editor = null, material = null, editable = null, originalMap = null, fallbackTexture = null) {
  if (editable?.layerMode !== true || !editable?.layer) {
    return fallbackTexture || null;
  }
  const storedUnderlay = surfaceLayerStoredUnderlayTexture(editor, editable);
  if (storedUnderlay) {
    return storedUnderlay;
  }
  const currentDisplayTexture = material?.map || null;
  const compositeEntry = surfaceLayerDisplayCompositeEntry(material);
  if (surfaceLayerCompositeIsBelowActive(compositeEntry, editable)) {
    const underlayTexture = surfaceLayerCompositeTexture(compositeEntry, currentDisplayTexture);
    if (underlayTexture) {
      return underlayTexture;
    }
  }
  return surfaceLayerBaseTexture(editor, material, editable, originalMap)
    || fallbackTexture
    || null;
}

function surfaceLayerCanvasIsEmpty(layer = null) {
  const canvas = layer?.canvas || null;
  const context = canvas?.getContext?.("2d", { willReadFrequently: true }) || null;
  const width = Math.max(0, Math.floor(Number(canvas?.width) || 0));
  const height = Math.max(0, Math.floor(Number(canvas?.height) || 0));
  if (!canvas || !context || !width || !height) {
    return true;
  }
  try {
    const image = context.getImageData(0, 0, width, height);
    for (let index = 3; index < image.data.length; index += 4) {
      if (image.data[index] !== 0) {
        return false;
      }
    }
  } catch {
    return layer.isEmpty !== false;
  }
  return true;
}

function surfaceLayerGpuTargetHasPaint(layer = null) {
  const targetEntry = layer?.gpuTarget || null;
  if (!targetEntry?.target?.texture) {
    return false;
  }
  if (targetEntry.emptyTransparent === true) {
    return false;
  }
  if (
    layer.texturePaintGpuPainted === true
    || targetEntry.texturePaintLayerHasPaint === true
  ) {
    return true;
  }
  if (
    layer.isEmpty === true
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
    && layer.isEmpty !== true;
}

function surfaceLayerSourceIsEmpty(editable = null) {
  const layer = editable?.layer || null;
  if (editable?.layerMode !== true || !layer?.canvas) {
    return false;
  }
  const gpuHasPaint = surfaceLayerGpuTargetHasPaint(layer);
  if (gpuHasPaint) {
    layer.isEmpty = false;
    layer.texturePaintHasPaint = true;
    layer.texturePaintGpuPainted = true;
    layer.gpuTarget.emptyTransparent = false;
    layer.gpuTarget.texturePaintLayerHasPaint = true;
    return false;
  }
  const hasPaintFlag = layer.texturePaintCpuPainted === true
    || layer.texturePaintGpuPainted === true
    || layer.texturePaintHasPaint === true
    || layer.gpuTarget?.texturePaintLayerHasPaint === true
    || layer.isEmpty === false;
  if (!hasPaintFlag) {
    return true;
  }
  if (surfaceLayerCanvasIsEmpty(layer)) {
    layer.isEmpty = true;
    layer.texturePaintHasPaint = false;
    layer.texturePaintCpuPainted = false;
    layer.texturePaintGpuPainted = false;
    if (layer.gpuTarget) {
      layer.gpuTarget.emptyTransparent = true;
      layer.gpuTarget.texturePaintLayerHasPaint = false;
    }
    return true;
  }
  return false;
}

function surfaceLayerSourceTexture(editable = null, referenceTexture = null) {
  const layer = editable?.layer || null;
  if (editable?.layerMode !== true || !layer?.canvas) {
    return null;
  }
  if (surfaceLayerSourceIsEmpty(editable)) {
    return surfaceAirbrushTransparentTexture();
  }
  if (layer.gpuTarget?.target?.texture && layer.gpuTarget.emptyTransparent !== true) {
    return layer.gpuTarget.target.texture;
  }
  if (!layer.gpuLayerTexture && typeof THREE.CanvasTexture === "function") {
    layer.gpuLayerTexture = new THREE.CanvasTexture(layer.canvas);
    layer.gpuLayerTexture.name = `${layer.name || "Paint layer"} source`;
  }
  const texture = layer.gpuLayerTexture || null;
  if (!texture) {
    return null;
  }
  copyTextureSettings(texture, referenceTexture || texture);
  texture.needsUpdate = true;
  return texture;
}

function clearRenderTargetTransparent(renderer = null, target = null, cache = null) {
  if (!renderer || !target) {
    return false;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  const previousClearAlpha = typeof renderer.getClearAlpha === "function"
    ? renderer.getClearAlpha()
    : 1;
  const previousClearColor = typeof renderer.getClearColor === "function"
    ? renderer.getClearColor(_scratchClearColor)
    : null;
  try {
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.setClearColor?.(0x000000, 0);
    renderer.clear?.();
    if (ensureTransparentClearPass(cache)) {
      renderer.autoClear = false;
      renderer.render(cache.transparentClearScene, cache.camera);
    }
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    if (previousClearColor) {
      renderer.setClearColor?.(previousClearColor, previousClearAlpha);
    }
  }
  return true;
}

function bindSurfaceDisplayTextureMetadata(
  displayTexture = null,
  sourceTexture = null,
  referenceTexture = null,
  originalMap = null
) {
  if (!displayTexture) {
    return false;
  }
  displayTexture.userData ||= {};
  const userData = displayTexture.userData;
  userData.texturePaintTslSurfaceAirbrushDisplayTexture = true;
  userData.texturePaintTslSurfaceDisplaySourceTexture = sourceTexture || null;
  userData.texturePaintTslSurfaceDisplayOriginalMap = originalMap || null;
  userData.texturePaintTslSurfaceDisplayFlipY = referenceTexture?.flipY === true;
  if (originalMap) {
    userData.textureAirbrushWebGpuCanvasMap = originalMap;
    userData.clonePaintOriginalMap = originalMap;
  }
  return true;
}

function ensureSurfaceDisplayTarget(cache = null, width = 1, height = 1, referenceTexture = null) {
  if (!cache) {
    return null;
  }
  if (
    !cache.displayTarget
    || cache.displayTarget.width !== width
    || cache.displayTarget.height !== height
  ) {
    retireSurfaceAirbrushResource(cache, cache.displayTarget);
    cache.displayTarget = createRenderTarget(width, height, referenceTexture);
  } else {
    copyTextureSettings(cache.displayTarget.texture, referenceTexture);
  }
  if (cache.displayTarget?.texture) {
    cache.displayTarget.texture.name = "texture-paint-tsl-surface-airbrush-display";
    cache.displayTarget.texture.flipY = false;
    bindSurfaceDisplayTextureMetadata(cache.displayTarget.texture, null, referenceTexture, null);
  }
  return cache.displayTarget?.texture ? cache.displayTarget : null;
}

function renderSurfaceDisplayTexture(
  renderer = null,
  cache = null,
  sourceTexture = null,
  referenceTexture = null,
  width = 1,
  height = 1,
  originalMap = null
) {
  if (!renderer || !cache || !sourceTexture || !cache.copyMaterial || !cache.copyScene) {
    return null;
  }
  const target = ensureSurfaceDisplayTarget(cache, width, height, referenceTexture || sourceTexture);
  if (!target?.texture || !updateTextureCopyMaterial(cache.copyMaterial, sourceTexture)) {
    return null;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  try {
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.clear?.();
    renderer.render(cache.copyScene, cache.camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
  target.texture.flipY = false;
  bindSurfaceDisplayTextureMetadata(target.texture, sourceTexture, referenceTexture, originalMap);
  return target;
}

function ensureSurfaceLayerCompositeTarget(cache = null, width = 1, height = 1, referenceTexture = null, options = {}) {
  if (!cache) {
    return null;
  }
  const avoidTextures = new Set(
    (Array.isArray(options.avoidTextures) ? options.avoidTextures : [])
      .filter(Boolean)
  );
  const targets = cache.layerCompositeTargets ||= [];
  if (cache.layerCompositeTarget && !targets.includes(cache.layerCompositeTarget)) {
    targets.push(cache.layerCompositeTarget);
  }
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index];
    if (!target?.texture || target.width !== width || target.height !== height) {
      retireSurfaceAirbrushResource(cache, target);
      targets.splice(index, 1);
    }
  }
  let target = targets.find((candidate) => (
    candidate?.texture && !avoidTextures.has(candidate.texture)
  )) || null;
  if (!target) {
    if (targets.length < 2) {
      target = createRenderTarget(width, height, referenceTexture);
      targets.push(target);
    } else {
      target = targets.find((candidate) => candidate?.texture) || null;
    }
  }
  if (!target?.texture) {
    cache.layerCompositeTarget = null;
    return null;
  }
  cache.layerCompositeTarget = target;
  copyTextureSettings(target.texture, referenceTexture);
  target.texture.name = "texture-paint-tsl-surface-airbrush-layer-display";
  target.texture.flipY = false;
  bindSurfaceDisplayTextureMetadata(target.texture, null, referenceTexture, null);
  if (!cache.layerCompositeScene) {
    cache.layerCompositeScene = new THREE.Scene();
  }
  if (!cache.layerCompositeCamera) {
    cache.layerCompositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  }
  if (!cache.layerCompositeMaterial) {
    cache.layerCompositeMaterial = createLayerCompositeMaterial(referenceTexture, referenceTexture);
  }
  if (!cache.layerCompositeMesh && cache.layerCompositeMaterial) {
    cache.layerCompositeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cache.layerCompositeMaterial);
    cache.layerCompositeMesh.frustumCulled = false;
    cache.layerCompositeScene.add(cache.layerCompositeMesh);
  }
  return target?.texture && cache.layerCompositeMaterial && cache.layerCompositeMesh
    ? target
    : null;
}

function renderSurfaceLayerComposite(
  renderer = null,
  cache = null,
  baseTexture = null,
  layerTexture = null,
  referenceTexture = null,
  width = 1,
  height = 1,
  opacity = 1,
  options = {}
) {
  if (!renderer || !baseTexture || !layerTexture) {
    return null;
  }
  const target = ensureSurfaceLayerCompositeTarget(cache, width, height, referenceTexture || baseTexture, {
    avoidTextures: [baseTexture, layerTexture]
  });
  const safeBaseTexture = baseTexture === target?.texture
    ? (
        surfaceAirbrushStableTextureFromLiveTarget(baseTexture)
        || (referenceTexture !== target?.texture ? referenceTexture : null)
      )
    : baseTexture;
  if (
    !target
    || !safeBaseTexture
    || !updateLayerCompositeMaterial(cache.layerCompositeMaterial, safeBaseTexture, layerTexture, opacity, options)
  ) {
    return null;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  try {
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.clear?.();
    renderer.render(cache.layerCompositeScene, cache.layerCompositeCamera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
  target.texture.flipY = false;
  bindSurfaceDisplayTextureMetadata(target.texture, layerTexture, referenceTexture, surfaceAirbrushStableTextureFromLiveTarget(safeBaseTexture));
  return target;
}

function renderSurfaceLayerPaintDisplay(
  renderer = null,
  cache = null,
  baseTexture = null,
  referenceTexture = null,
  width = 1,
  height = 1,
  surfaceMeshEntries = [],
  renderPaintSegments = [],
  options = {},
  editor = null,
  visibleTexture = null,
  uvOccupancyTexture = null,
  needsVisibleSurfaceTexture = false
) {
  if (!renderer || !cache || !baseTexture) {
    return null;
  }
  const target = ensureSurfaceLayerCompositeTarget(cache, width, height, referenceTexture || baseTexture);
  if (!target?.texture) {
    return null;
  }
  for (const entry of surfaceMeshEntries || []) {
    if (!entry?.material) {
      continue;
    }
    updateSurfaceMaterial(
      entry.material,
      baseTexture,
      renderPaintSegments,
      {
        ...options,
        blendOnly: false,
        emptyLayerSource: false,
        debugVisibleSurfaceDepth: needsVisibleSurfaceTexture
      },
      editor,
      visibleTexture,
      uvOccupancyTexture
    );
  }
  if (cache.projectedMesh?.visible && cache.projectedMaterial) {
    updateSurfaceMaterial(
      cache.projectedMaterial,
      baseTexture,
      renderPaintSegments,
      {
        ...options,
        projectedPaintGutterOnly: false,
        blendOnly: false,
        emptyLayerSource: false,
        debugVisibleSurfaceDepth: needsVisibleSurfaceTexture
      },
      editor,
      visibleTexture
    );
  }
  updateTextureCopyMaterial(cache.copyMaterial, baseTexture);
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  try {
    const copiedBaseTexture = copySurfaceBaseTexture(renderer, baseTexture, target, cache);
    renderer.setRenderTarget(target);
    if (!copiedBaseTexture) {
      renderer.autoClear = true;
      renderer.clear?.();
      renderer.render(cache.copyScene, cache.camera);
      renderer.autoClear = false;
    } else {
      renderer.autoClear = false;
    }
    renderer.render(cache.scene, cache.camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
  return target;
}

function bindSurfaceLayerTarget(editor = null, material = null, editable = null, finalTarget = null, options = {}) {
  const layer = editable?.layer || null;
  if (editable?.layerMode !== true || !layer || !finalTarget?.texture) {
    return null;
  }
  const targetEntry = layer.gpuTarget || {};
  targetEntry.target = finalTarget;
  targetEntry.width = options.width || finalTarget.width || layer.canvas?.width || 0;
  targetEntry.height = options.height || finalTarget.height || layer.canvas?.height || 0;
  targetEntry.material = material || null;
  targetEntry.layer = layer;
  targetEntry.layerStack = editable.layerStack || null;
  targetEntry.layerMode = true;
  targetEntry.editable = editable;
  targetEntry.emptyTransparent = false;
  targetEntry.texturePaintLayerHasPaint = true;
  targetEntry.updatedAt = options.updatedAt || surfaceAirbrushNowMs();
  layer.gpuTarget = targetEntry;
  layer.isEmpty = false;
  layer.texturePaintHasPaint = true;
  layer.texturePaintGpuPainted = true;
  if (!editor?.markTexturePaintGpuTargetMutated?.(targetEntry)) {
    targetEntry.paintRevision = Math.max(0, Math.floor(Number(targetEntry.paintRevision) || 0)) + 1;
  }
  return targetEntry;
}

function bindSurfaceTextureToMatchingMaterials(editor = null, editable = null, finalTexture = null, textures = [], options = {}) {
  if (!editor?.model || !editable || !finalTexture) {
    return 0;
  }
  const textureSet = new Set(textures.filter(Boolean));
  const materialTexture = options.materialTexture || finalTexture;
  let updated = 0;
  editor.model.traverse?.((node) => {
    if (!node?.isMesh || !node.material) {
      return;
    }
    for (const candidateMaterial of materialArray(node.material)) {
      if (!materialUsesEditableTexture(candidateMaterial, editable, textureSet, { allowImageMatch: true })) {
        continue;
      }
      bindSurfaceEditableMetadata(candidateMaterial, editable, finalTexture, {
        originalMap: options.originalMap || null,
        references: options.references || textures
      });
      if (candidateMaterial.map !== materialTexture) {
        candidateMaterial.map = materialTexture;
        candidateMaterial.needsUpdate = true;
        updated += 1;
      }
    }
  });
  return updated;
}

function addUniqueSourceObject(output = [], seen = new Set(), object = null) {
  if (!object || seen.has(object)) {
    return false;
  }
  const geometry = object.geometry || null;
  if (!geometry?.attributes?.position || !geometry.attributes.uv) {
    return false;
  }
  seen.add(object);
  output.push(object);
  return true;
}

function sourceObjectsForEditable(editor = null, candidate = null, editable = null, sourceTexture = null, referenceTexture = null) {
  const output = [];
  const seen = new Set();
  const fallbackObject = sourceObjectForCandidate(candidate);
  const textures = surfaceEditableTextureSet(candidate, editable, sourceTexture, referenceTexture);
  const records = (
    typeof editor?.textureAirbrushRecords === "function"
      ? editor.textureAirbrushRecords()
      : editor?.paintRecords
  ) || [];
  for (const record of Array.isArray(records) ? records : []) {
    const object = record?.object || null;
    if (!object) {
      continue;
    }
    const materials = materialArray(object.material);
    const usesEditable = materials.some((entry) => materialUsesEditableTexture(entry, editable, textures));
    if (usesEditable) {
      addUniqueSourceObject(output, seen, object);
    }
  }
  addUniqueSourceObject(output, seen, fallbackObject);
  return output;
}

function sourceRecordForObject(editor = null, sourceObject = null) {
  if (!sourceObject) {
    return null;
  }
  const records = (
    typeof editor?.textureAirbrushRecords === "function"
      ? editor.textureAirbrushRecords()
      : editor?.paintRecords
  ) || [];
  for (const record of Array.isArray(records) ? records : []) {
    if (
      record?.object === sourceObject
      || (record?.geometry && record.geometry === sourceObject.geometry)
    ) {
      return record;
    }
  }
  return null;
}

function geometryComponentState(geometry = null) {
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
  const cached = _surfaceAirbrushGeometryComponentStates.get(geometry);
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
    const ia = vertexIndexAt(geometry, elementStart);
    const ib = vertexIndexAt(geometry, elementStart + 1);
    const ic = vertexIndexAt(geometry, elementStart + 2);
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
    vertexCount,
    componentIds,
    components: Array.from({ length: rootToComponent.size }, () => [])
  };
  _surfaceAirbrushGeometryComponentStates.set(geometry, state);
  return state;
}

function sourceObjectComponentState(editor = null, sourceObject = null) {
  const record = sourceRecordForObject(editor, sourceObject);
  return editor?.textureAirbrushNeighborComponentState?.(record)
    || geometryComponentState(sourceObject?.geometry || null)
    || null;
}

function sourceObjectComponentKey(editor = null, sourceObject = null) {
  const state = sourceObjectComponentState(editor, sourceObject);
  if (!state?.componentIds) {
    return "components:none";
  }
  return [
    "components",
    state.vertexCount || state.componentIds.length || 0,
    Array.isArray(state.components) ? state.components.length : 0,
    state.positionVersion ?? 0,
    state.deletedSignature || ""
  ].join(":");
}

function componentIdForTriangleVertices(componentState = null, ia = -1, ib = -1, ic = -1) {
  const componentIds = componentState?.componentIds || null;
  if (!componentIds) {
    return -1;
  }
  const counts = new Map();
  for (const vertexIndex of [ia, ib, ic]) {
    const index = Math.floor(Number(vertexIndex));
    const componentId = Number.isInteger(index) && index >= 0
      ? finiteComponentId(componentIds[index])
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

function geometryTriangleCount(geometry = null, materialIndex = 0) {
  const position = geometry?.attributes?.position || null;
  const elementCount = geometry?.index?.count || position?.count || 0;
  if (!elementCount) {
    return 0;
  }
  const groups = Array.isArray(geometry.groups) ? geometry.groups : [];
  if (!groups.length) {
    return Math.floor(elementCount / 3);
  }
  let count = 0;
  const targetMaterial = Math.max(0, Math.floor(Number(materialIndex) || 0));
  for (const group of groups) {
    if (Math.max(0, Math.floor(Number(group.materialIndex) || 0)) === targetMaterial) {
      count += Math.floor(Math.max(0, Number(group.count) || 0) / 3);
    }
  }
  return count;
}

function geometryTotalTriangleCount(geometry = null) {
  const position = geometry?.attributes?.position || null;
  const elementCount = geometry?.index?.count || position?.count || 0;
  return Math.floor(Math.max(0, Number(elementCount) || 0) / 3);
}

function projectedTrianglePixels(triangle = null) {
  const a = finitePoint(triangle?.a || triangle?.[0]);
  const b = finitePoint(triangle?.b || triangle?.[1]);
  const c = finitePoint(triangle?.c || triangle?.[2]);
  return a && b && c ? [a, b, c] : null;
}

function projectedTriangleSourcePixels(triangle = null) {
  const a = finitePoint(triangle?.sourceA);
  const b = finitePoint(triangle?.sourceB);
  const c = finitePoint(triangle?.sourceC);
  return a && b && c ? [a, b, c] : null;
}

function projectedTrianglePlaneNormals(views = null) {
  if (!Array.isArray(views) || views.length !== 3) {
    return null;
  }
  const [a, b, c] = views;
  if (!finiteView(a) || !finiteView(b) || !finiteView(c)) {
    return null;
  }
  const edgeAx = b.x - a.x;
  const edgeAy = b.y - a.y;
  const edgeAz = b.z - a.z;
  const edgeBx = c.x - a.x;
  const edgeBy = c.y - a.y;
  const edgeBz = c.z - a.z;
  const normalX = edgeAy * edgeBz - edgeAz * edgeBy;
  const normalY = edgeAz * edgeBx - edgeAx * edgeBz;
  const normalZ = edgeAx * edgeBy - edgeAy * edgeBx;
  const normalLength = Math.hypot(normalX, normalY, normalZ);
  if (normalLength <= 0.000001) {
    return null;
  }
  const normal = {
    x: normalX / normalLength,
    y: normalY / normalLength,
    z: normalZ / normalLength
  };
  return [normal, normal, normal];
}

function addVertex(arrays, point, view, screen, normal, barycentric, width, height, referenceTexture = null, componentId = -1) {
  const sampleU = point.x / Math.max(1, width - 1);
  const sampleV = point.y / Math.max(1, height - 1);
  arrays.position.push(
    point.x / width * 2 - 1,
    1 - point.y / height * 2,
    0
  );
  arrays.uv.push(
    point.x / width,
    point.y / height
  );
  arrays.sourceUv.push(
    sampleU,
    textureNodeAppliesFlipY(referenceTexture) ? 1 - sampleV : sampleV
  );
  arrays.view.push(view.x, view.y, view.z);
  arrays.screen.push(screen.x, screen.y, finiteNumber(screen.z, 0));
  arrays.normal.push(normal.x, normal.y, normal.z);
  arrays.barycentric.push(
    finiteNumber(barycentric?.u, 0),
    finiteNumber(barycentric?.v, 0),
    finiteNumber(barycentric?.w, 0)
  );
  arrays.component.push(finiteComponentId(componentId) + 1);
}

function nextPowerOfTwo(value = 1) {
  let power = 1;
  const target = Math.max(1, Math.floor(Number(value) || 1));
  while (power < target) {
    power *= 2;
  }
  return power;
}

function surfaceGeometryData(triangles = [], width = 1, height = 1, referenceTexture = null, gutterPixels = UV_GUTTER_PIXELS) {
  const arrays = {
    position: [],
    uv: [],
    sourceUv: [],
    view: [],
    screen: [],
    normal: [],
    barycentric: [],
    component: []
  };
  for (const triangle of triangles) {
    const pixels = projectedTrianglePixels(triangle);
    const views = projectedTriangleView(triangle);
    const screens = projectedTriangleScreen(triangle);
    const normals = projectedTriangleNormals(triangle) || projectedTrianglePlaneNormals(views);
    if (!pixels || !views || !screens || !normals) {
      continue;
    }
    const expanded = gutterPixels > 0
      ? expandedTrianglePoints(pixels[0], pixels[1], pixels[2], gutterPixels)
      : pixels;
    for (let index = 0; index < 3; index += 1) {
      const barycentric = barycentricForPoint(expanded[index], pixels[0], pixels[1], pixels[2]);
      const view = interpolateView(barycentric, views[0], views[1], views[2]) || views[index];
      const screen = interpolateScreen(barycentric, screens[0], screens[1], screens[2]) || screens[index];
      const normal = interpolateNormal(barycentric, normals[0], normals[1], normals[2]) || normals[index];
      if (!finiteView(view) || !finitePoint(screen) || !finiteView(normal)) {
        continue;
      }
      addVertex(
        arrays,
        expanded[index],
        view,
        screen,
        normal,
        barycentric,
        width,
        height,
        referenceTexture,
        triangle.componentId
      );
    }
  }
  if (arrays.position.length < 9) {
    return null;
  }
  return {
    arrays,
    vertexCount: Math.floor(arrays.position.length / 3),
    triangleCount: Math.floor(arrays.position.length / 9)
  };
}

function surfaceGeometryAttributeArray(values = [], capacityVertices = 0, components = 3) {
  const array = new Float32Array(Math.max(values.length, capacityVertices * components));
  array.set(values);
  return array;
}

function createSurfaceGeometry(
  triangles = [],
  width = 1,
  height = 1,
  referenceTexture = null,
  reserveTriangleCount = 0,
  gutterPixels = UV_GUTTER_PIXELS
) {
  const data = surfaceGeometryData(triangles, width, height, referenceTexture, gutterPixels);
  if (!data) {
    return null;
  }
  const reserveVertices = Math.max(0, Math.floor(Number(reserveTriangleCount) || 0)) * 3;
  const capacityVertices = Math.max(data.vertexCount, reserveVertices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.position, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.uv, capacityVertices, 2), 2)
  );
  geometry.setAttribute(
    "paintUv",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.uv, capacityVertices, 2), 2)
  );
  geometry.setAttribute(
    "sourceUv",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.sourceUv, capacityVertices, 2), 2)
  );
  geometry.setAttribute(
    "paintView",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.view, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintScreen",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.screen, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintNormal",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.normal, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintBarycentric",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.barycentric, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintComponent",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.component, capacityVertices, 1), 1)
  );
  geometry.setDrawRange(0, data.vertexCount);
  geometry.userData.texturePaintTslSurfaceCapacityVertices = capacityVertices;
  geometry.userData.texturePaintTslSurfaceVertexCount = data.vertexCount;
  geometry.userData.texturePaintTslSurfaceTriangleCount = data.triangleCount;
  return geometry;
}

function updateSurfaceGeometry(
  geometry = null,
  triangles = [],
  width = 1,
  height = 1,
  referenceTexture = null,
  gutterPixels = UV_GUTTER_PIXELS
) {
  const data = surfaceGeometryData(triangles, width, height, referenceTexture, gutterPixels);
  if (!data) {
    return null;
  }
  const capacityVertices = Math.max(
    0,
    Math.floor(Number(geometry?.userData?.texturePaintTslSurfaceCapacityVertices) || 0)
  );
  if (!geometry || capacityVertices < data.vertexCount) {
    const reserveTriangles = nextPowerOfTwo(Math.max(
      PROJECTED_GUTTER_GEOMETRY_MIN_TRIANGLES,
      Math.ceil(data.vertexCount / 3)
    ));
    return createSurfaceGeometry(triangles, width, height, referenceTexture, reserveTriangles, gutterPixels);
  }
  const updates = [
    ["position", data.arrays.position],
    ["uv", data.arrays.uv],
    ["paintUv", data.arrays.uv],
    ["sourceUv", data.arrays.sourceUv],
    ["paintView", data.arrays.view],
    ["paintScreen", data.arrays.screen],
    ["paintNormal", data.arrays.normal],
    ["paintBarycentric", data.arrays.barycentric],
    ["paintComponent", data.arrays.component]
  ];
  for (const [name, values] of updates) {
    const attribute = geometry.getAttribute?.(name) || null;
    if (!attribute?.array || attribute.array.length < values.length) {
      return createSurfaceGeometry(
        triangles,
        width,
        height,
        referenceTexture,
        Math.ceil(data.vertexCount / 3),
        gutterPixels
      );
    }
    attribute.array.set(values, 0);
    attribute.needsUpdate = true;
  }
  geometry.setDrawRange(0, data.vertexCount);
  geometry.userData.texturePaintTslSurfaceVertexCount = data.vertexCount;
  geometry.userData.texturePaintTslSurfaceTriangleCount = data.triangleCount;
  return geometry;
}

function surfaceGeometryDrawTriangleCount(geometry = null) {
  const explicit = Number(geometry?.userData?.texturePaintTslSurfaceTriangleCount);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  const drawCount = Number(geometry?.drawRange?.count);
  if (Number.isFinite(drawCount) && drawCount >= 0 && drawCount !== Infinity) {
    return Math.floor(drawCount / 3);
  }
  return geometry?.attributes?.position?.count
    ? Math.floor(geometry.attributes.position.count / 3)
    : 0;
}

function projectedTriangleNormals(triangle = null) {
  const a = finiteView(triangle?.normalA || triangle?.normal?.a);
  const b = finiteView(triangle?.normalB || triangle?.normal?.b);
  const c = finiteView(triangle?.normalC || triangle?.normal?.c);
  return a && b && c ? [a, b, c] : null;
}

function addSourceRasterVertex(
  arrays,
  renderPoint,
  sourcePoint,
  view,
  screen,
  normal,
  barycentric,
  width,
  height,
  referenceTexture = null,
  componentId = -1,
  sourceWidth = width,
  sourceHeight = height
) {
  const sampleU = sourcePoint.x / Math.max(1, sourceWidth - 1);
  const sampleV = sourcePoint.y / Math.max(1, sourceHeight - 1);
  arrays.position.push(
    renderPoint.x / width * 2 - 1,
    1 - renderPoint.y / height * 2,
    0
  );
  arrays.uv.push(
    renderPoint.x / width,
    renderPoint.y / height
  );
  arrays.sourceUv.push(
    sampleU,
    textureNodeAppliesFlipY(referenceTexture) ? 1 - sampleV : sampleV
  );
  arrays.view.push(view.x, view.y, view.z);
  arrays.screen.push(screen.x, screen.y, finiteNumber(screen.z, 0));
  arrays.normal.push(normal.x, normal.y, normal.z);
  arrays.barycentric.push(
    finiteNumber(barycentric?.u, 0),
    finiteNumber(barycentric?.v, 0),
    finiteNumber(barycentric?.w, 0)
  );
  arrays.component.push(finiteComponentId(componentId) + 1);
}

function addSurfaceGeometryGroup(groups = [], start = 0, count = 0, materialIndex = 0) {
  if (count <= 0) {
    return;
  }
  const index = Math.max(0, Math.floor(Number(materialIndex) || 0));
  const previous = groups[groups.length - 1] || null;
  if (previous && previous.materialIndex === index && previous.start + previous.count === start) {
    previous.count += count;
    return;
  }
  groups.push({ start, count, materialIndex: index });
}

function applySurfaceGeometryGroups(geometry = null, groups = []) {
  if (!geometry) {
    return false;
  }
  geometry.clearGroups?.();
  for (const group of groups) {
    geometry.addGroup?.(group.start, group.count, group.materialIndex);
  }
  return true;
}

function sourceRasterGeometryData(
  triangles = [],
  width = 1,
  height = 1,
  referenceTexture = null,
  gutterPixels = UV_GUTTER_PIXELS,
  sourceWidth = width,
  sourceHeight = height
) {
  const arrays = {
    position: [],
    uv: [],
    sourceUv: [],
    view: [],
    screen: [],
    normal: [],
    barycentric: [],
    component: []
  };
  const groups = [];
  let vertexStart = 0;
  for (const triangle of triangles) {
    const pixels = projectedTrianglePixels(triangle);
    const sourcePixels = projectedTriangleSourcePixels(triangle) || pixels;
    const views = projectedTriangleView(triangle);
    const screens = projectedTriangleScreen(triangle);
    const normals = projectedTriangleNormals(triangle);
    if (!pixels || !sourcePixels || !views || !screens || !normals) {
      continue;
    }
    const expanded = gutterPixels > 0
      ? expandedTrianglePoints(pixels[0], pixels[1], pixels[2], gutterPixels)
      : pixels;
    const materialIndex = Math.max(0, Math.floor(Number(triangle.materialIndex) || 0));
    const triangleStart = vertexStart;
    for (let index = 0; index < 3; index += 1) {
      const barycentric = barycentricForPoint(expanded[index], pixels[0], pixels[1], pixels[2]);
      const clampedBarycentric = clampBarycentricToTriangle(barycentric);
      const sourcePoint = interpolatePoint2(clampedBarycentric, sourcePixels[0], sourcePixels[1], sourcePixels[2])
        || sourcePixels[index];
      const view = interpolateView(barycentric, views[0], views[1], views[2])
        || interpolateView(clampedBarycentric, views[0], views[1], views[2])
        || views[index];
      const screen = interpolateScreen(barycentric, screens[0], screens[1], screens[2])
        || interpolateScreen(clampedBarycentric, screens[0], screens[1], screens[2])
        || screens[index];
      const normal = interpolateNormal(barycentric, normals[0], normals[1], normals[2])
        || interpolateNormal(clampedBarycentric, normals[0], normals[1], normals[2])
        || normals[index];
      if (!finiteView(view) || !finitePoint(screen) || !finiteView(normal)) {
        continue;
      }
      addSourceRasterVertex(
        arrays,
        expanded[index],
        sourcePoint,
        view,
        screen,
        normal,
        barycentric,
        width,
        height,
        referenceTexture,
        triangle.componentId,
        sourceWidth,
        sourceHeight
      );
      vertexStart += 1;
    }
    if (vertexStart - triangleStart === 3) {
      addSurfaceGeometryGroup(groups, triangleStart, 3, materialIndex);
    } else {
      arrays.position.length -= (vertexStart - triangleStart) * 3;
      arrays.uv.length -= (vertexStart - triangleStart) * 2;
      arrays.sourceUv.length -= (vertexStart - triangleStart) * 2;
      arrays.view.length -= (vertexStart - triangleStart) * 3;
      arrays.screen.length -= (vertexStart - triangleStart) * 3;
      arrays.normal.length -= (vertexStart - triangleStart) * 3;
      arrays.barycentric.length -= (vertexStart - triangleStart) * 3;
      arrays.component.length -= (vertexStart - triangleStart);
      vertexStart = triangleStart;
    }
  }
  if (arrays.position.length < 9) {
    return null;
  }
  return {
    arrays,
    groups,
    vertexCount: Math.floor(arrays.position.length / 3),
    triangleCount: Math.floor(arrays.position.length / 9)
  };
}

function createSourceRasterGeometry(
  triangles = [],
  width = 1,
  height = 1,
  referenceTexture = null,
  reserveTriangleCount = 0,
  gutterPixels = UV_GUTTER_PIXELS,
  sourceWidth = width,
  sourceHeight = height
) {
  const data = sourceRasterGeometryData(triangles, width, height, referenceTexture, gutterPixels, sourceWidth, sourceHeight);
  if (!data) {
    return null;
  }
  const reserveVertices = Math.max(0, Math.floor(Number(reserveTriangleCount) || 0)) * 3;
  const capacityVertices = Math.max(data.vertexCount, reserveVertices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.position, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.uv, capacityVertices, 2), 2)
  );
  geometry.setAttribute(
    "sourceUv",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.sourceUv, capacityVertices, 2), 2)
  );
  geometry.setAttribute(
    "paintView",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.view, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintScreen",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.screen, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintNormal",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.normal, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintBarycentric",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.barycentric, capacityVertices, 3), 3)
  );
  geometry.setAttribute(
    "paintComponent",
    new THREE.BufferAttribute(surfaceGeometryAttributeArray(data.arrays.component, capacityVertices, 1), 1)
  );
  geometry.setDrawRange(0, data.vertexCount);
  applySurfaceGeometryGroups(geometry, data.groups);
  geometry.userData.texturePaintTslSourceRasterCapacityVertices = capacityVertices;
  geometry.userData.texturePaintTslSourceRasterVertexCount = data.vertexCount;
  geometry.userData.texturePaintTslSourceRasterTriangleCount = data.triangleCount;
  return geometry;
}

function updateSourceRasterGeometry(
  geometry = null,
  triangles = [],
  width = 1,
  height = 1,
  referenceTexture = null,
  gutterPixels = UV_GUTTER_PIXELS,
  sourceWidth = width,
  sourceHeight = height
) {
  const data = sourceRasterGeometryData(triangles, width, height, referenceTexture, gutterPixels, sourceWidth, sourceHeight);
  if (!data) {
    return null;
  }
  const capacityVertices = Math.max(
    0,
    Math.floor(Number(geometry?.userData?.texturePaintTslSourceRasterCapacityVertices) || 0)
  );
  if (!geometry || capacityVertices < data.vertexCount) {
    const reserveTriangles = nextPowerOfTwo(Math.max(
      SOURCE_RASTER_GEOMETRY_MIN_TRIANGLES,
      Math.ceil(data.vertexCount / 3)
    ));
    return createSourceRasterGeometry(
      triangles,
      width,
      height,
      referenceTexture,
      reserveTriangles,
      gutterPixels,
      sourceWidth,
      sourceHeight
    );
  }
  const updates = [
    ["position", data.arrays.position],
    ["uv", data.arrays.uv],
    ["sourceUv", data.arrays.sourceUv],
    ["paintView", data.arrays.view],
    ["paintScreen", data.arrays.screen],
    ["paintNormal", data.arrays.normal],
    ["paintBarycentric", data.arrays.barycentric],
    ["paintComponent", data.arrays.component]
  ];
  for (const [name, values] of updates) {
    const attribute = geometry.getAttribute?.(name) || null;
    if (!attribute?.array || attribute.array.length < values.length) {
      return createSourceRasterGeometry(
        triangles,
        width,
        height,
        referenceTexture,
        Math.ceil(data.vertexCount / 3),
        gutterPixels,
        sourceWidth,
        sourceHeight
      );
    }
    attribute.array.set(values, 0);
    attribute.needsUpdate = true;
  }
  geometry.setDrawRange(0, data.vertexCount);
  applySurfaceGeometryGroups(geometry, data.groups);
  geometry.userData.texturePaintTslSourceRasterVertexCount = data.vertexCount;
  geometry.userData.texturePaintTslSourceRasterTriangleCount = data.triangleCount;
  return geometry;
}

function sourceUvRasterGeometryKey(
  editor = null,
  sourceObject = null,
  texture = null,
  width = 1,
  height = 1,
  editable = null,
  textures = new Set(),
  fallbackMaterialIndex = null,
  options = {},
  gutterPixels = UV_GUTTER_PIXELS
) {
  const paintIndices = sourceObjectMaterialPaintIndices(sourceObject, editable, textures, fallbackMaterialIndex, options);
  const writeTexture = options.writeTexture || texture;
  const sampleTexture = options.sampleTexture || texture;
  return [
    width,
    height,
    gutterPixels,
    writeTexture?.flipY === true ? "writeFlipY" : "writeNoFlipY",
    writeTexture?.matrixAutoUpdate === false ? "writeStaticMatrix" : "writeAutoMatrix",
    matrixSurfaceKey(writeTexture?.matrix),
    sampleTexture?.flipY === true ? "sampleFlipY" : "sampleNoFlipY",
    sampleTexture?.matrixAutoUpdate === false ? "sampleStaticMatrix" : "sampleAutoMatrix",
    matrixSurfaceKey(sampleTexture?.matrix),
    [...paintIndices].sort((a, b) => a - b).join(","),
    sourceRasterClipKey(options),
    sourceObjectComponentKey(editor, sourceObject),
    surfaceProjectionFrameKey(editor, [sourceObject])
  ].join("|");
}

function sourceUvRasterTriangles(
  editor = null,
  sourceObject = null,
  texture = null,
  width = 1,
  height = 1,
  editable = null,
  textures = new Set(),
  fallbackMaterialIndex = null,
  options = {}
) {
  const geometry = sourceObject?.geometry || null;
  const position = geometry?.attributes?.position || null;
  const uvAttribute = geometry?.attributes?.uv || null;
  if (!editor?.camera || !sourceObject || !geometry || !position || !uvAttribute || !texture) {
    return [];
  }
  const writeTexture = options.writeTexture || texture;
  const sampleTexture = options.sampleTexture || texture;
  const sampleSize = textureLikeSize(sampleTexture);
  const paintMaterialIndices = sourceObjectMaterialPaintIndices(
    sourceObject,
    editable,
    textures,
    fallbackMaterialIndex,
    options
  );
  if (!paintMaterialIndices.size) {
    return [];
  }
  sourceObject.updateMatrixWorld?.(true);
  editor.camera.updateMatrixWorld?.(true);
  const componentState = sourceObjectComponentState(editor, sourceObject);
  const elementCount = geometry.index?.count || position.count || 0;
  const triangles = [];
  for (let elementStart = 0; elementStart + 2 < elementCount; elementStart += 3) {
    const materialIndex = geometryTriangleMaterialIndex(geometry, elementStart);
    if (!paintMaterialIndices.has(materialIndex)) {
      continue;
    }
    const ia = vertexIndexAt(geometry, elementStart);
    const ib = vertexIndexAt(geometry, elementStart + 1);
    const ic = vertexIndexAt(geometry, elementStart + 2);
    const a = texturePixelForUv(uvAttribute, ia, writeTexture, width, height);
    const b = texturePixelForUv(uvAttribute, ib, writeTexture, width, height);
    const c = texturePixelForUv(uvAttribute, ic, writeTexture, width, height);
    const sourceA = texturePixelForUv(uvAttribute, ia, sampleTexture, sampleSize.width, sampleSize.height);
    const sourceB = texturePixelForUv(uvAttribute, ib, sampleTexture, sampleSize.width, sampleSize.height);
    const sourceC = texturePixelForUv(uvAttribute, ic, sampleTexture, sampleSize.width, sampleSize.height);
    if (!a || !b || !c || Math.abs(triangleArea2(a, b, c)) <= 0.000001) {
      continue;
    }
    const worldA = worldPositionForVertex(sourceObject, geometry, ia);
    const worldB = worldPositionForVertex(sourceObject, geometry, ib);
    const worldC = worldPositionForVertex(sourceObject, geometry, ic);
    const screenA = screenPointForWorld(editor, worldA);
    const screenB = screenPointForWorld(editor, worldB);
    const screenC = screenPointForWorld(editor, worldC);
    const normalA = viewNormalForVertex(sourceObject, geometry, ia, editor) || { x: 0, y: 0, z: 1 };
    const normalB = viewNormalForVertex(sourceObject, geometry, ib, editor) || normalA;
    const normalC = viewNormalForVertex(sourceObject, geometry, ic, editor) || normalB;
    const componentId = componentIdForTriangleVertices(componentState, ia, ib, ic);
    if (!screenA || !screenB || !screenC) {
      continue;
    }
    if (!screenTriangleNearSourceRasterClip([screenA, screenB, screenC], options)) {
      continue;
    }
    triangles.push({
      a,
      b,
      c,
      ...(sourceA && sourceB && sourceC ? { sourceA, sourceB, sourceC } : {}),
      screenA,
      screenB,
      screenC,
      normalA,
      normalB,
      normalC,
      componentId,
      materialIndex
    });
  }
  return triangles;
}

function normalizeSurfaceSegments(editor = null, segments = [], fallbackRadius = 1) {
  const output = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (output.length >= MAX_TSL_SURFACE_STROKE_SEGMENTS) {
      break;
    }
    const start = finitePoint(segment?.screenStart) || finitePoint(segment?.start);
    const end = finitePoint(segment?.screenEnd) || finitePoint(segment?.end);
    const screenRadiusPixels = finiteNumber(segment?.screenRadiusPixels, 0);
    const radiusPixels = finiteNumber(segment?.radiusPixels, 0);
    const radius = Math.max(
      0.0001,
      screenRadiusPixels > 0
        ? screenRadiusPixels
        : radiusPixels > 0
          ? radiusPixels
          : finiteNumber(fallbackRadius, 0.0001)
    );
    if (!start || !end) {
      continue;
    }
    const viewStart = finiteView(segment?.viewStart);
    const viewEnd = finiteView(segment?.viewEnd);
    const viewNormalStart = finiteView(segment?.viewNormalStart || segment?.normalStart);
    const viewNormalEnd = finiteView(segment?.viewNormalEnd || segment?.normalEnd);
    const viewRadius = finiteNumber(segment?.viewRadiusPixels, 0);
    const worldStart = finiteView(segment?.worldStart) || worldFromView(editor, viewStart);
    const worldEnd = finiteView(segment?.worldEnd) || worldFromView(editor, viewEnd);
    const componentStart = finiteComponentId(segment?.componentStart);
    const componentEnd = finiteComponentId(segment?.componentEnd);
    const hasViewSegment = Boolean(viewStart && viewEnd && viewRadius > 0);
    output.push({
      start,
      end,
      radius,
      ...(componentStart >= 0 ? { componentStart } : {}),
      ...(componentEnd >= 0 ? { componentEnd } : {}),
      ...(hasViewSegment ? {
        viewStart,
        viewEnd,
        viewRadius,
        ...(viewNormalStart ? { viewNormalStart } : {}),
        ...(viewNormalEnd ? { viewNormalEnd } : {}),
        ...(worldStart ? { worldStart } : {}),
        ...(worldEnd ? { worldEnd } : {}),
        worldRadius: viewRadius
      } : {})
    });
  }
  return output;
}

function createRenderTarget(width, height, referenceTexture) {
  const target = new THREE.RenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    generateMipmaps: false
  });
  copyTextureSettings(target.texture, referenceTexture);
  target.texture.format = THREE.RGBAFormat;
  return target;
}

function createUvOccupancyTarget(width = 1, height = 1) {
  const target = new THREE.RenderTarget(width, height, {
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false
  });
  target.texture.name = "texture-paint-tsl-surface-airbrush-uv-occupancy";
  target.texture.colorSpace = THREE.NoColorSpace || target.texture.colorSpace;
  target.texture.flipY = false;
  target.texture.wrapS = THREE.ClampToEdgeWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;
  target.texture.minFilter = THREE.NearestFilter;
  target.texture.magFilter = THREE.NearestFilter;
  target.texture.generateMipmaps = false;
  return target;
}

function createUvOccupancyMaterial() {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const { Fn, positionLocal, vec4 } = tsl;
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  material.vertexNode = Fn(() => vec4(positionLocal.x, positionLocal.y, 0, 1))();
  material.fragmentNode = vec4(1, 1, 1, 1);
  material.name = "texture-paint-tsl-surface-airbrush-uv-occupancy";
  return material;
}

function createTextureCopyMaterial(sourceTexture = null) {
  const tsl = THREE.TSL || null;
  if (tsl && typeof THREE.MeshBasicNodeMaterial === "function") {
    const { Fn, float, mix, positionLocal, texture, uniform, uv, vec2, vec4 } = tsl;
    const sourceTextureNode = texture(sourceTexture);
    const sourceFlipY = uniform(0, "float");
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: false,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false
    });
    material.vertexNode = Fn(() => vec4(positionLocal.x, positionLocal.y, 0, 1))();
    material.fragmentNode = Fn(() => {
      const currentUv = uv().toVar();
      const sampleUv = vec2(
        currentUv.x,
        mix(currentUv.y, float(1).sub(currentUv.y), sourceFlipY)
      ).toVar();
      return sourceTextureNode.sample(sampleUv);
    })();
    material.name = "texture-paint-tsl-surface-airbrush-copy";
    material.userData.texturePaintTslSurfaceCopy = {
      sourceTextureNode,
      sourceFlipY,
      sourceTexture: sourceTexture || null
    };
    return material;
  }
  if (typeof THREE.MeshBasicMaterial !== "function") {
    return null;
  }
  const material = new THREE.MeshBasicMaterial({
    map: sourceTexture || null,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false
  });
  material.name = "texture-paint-tsl-surface-airbrush-copy";
  material.userData.texturePaintTslSurfaceCopy = {
    sourceTexture: sourceTexture || null
  };
  return material;
}

function updateTextureCopyMaterial(material = null, sourceTexture = null) {
  const state = material?.userData?.texturePaintTslSurfaceCopy || null;
  if (state?.sourceTextureNode) {
    const flipY = sourceTexture?.flipY === true && !surfaceAirbrushTextureIsLiveTarget(sourceTexture) ? 1 : 0;
    if (state.sourceFlipY && state.sourceFlipY.value !== flipY) {
      state.sourceFlipY.value = flipY;
      if (material) {
        material.needsUpdate = true;
      }
    }
    if (state.sourceTextureNode.value !== sourceTexture) {
      state.sourceTextureNode.value = sourceTexture || null;
      state.sourceTexture = sourceTexture || null;
      if (material) {
        material.needsUpdate = true;
      }
    }
    return Boolean(material);
  }
  if (material && "map" in material && material.map !== sourceTexture) {
    material.map = sourceTexture;
    if (state) {
      state.sourceTexture = sourceTexture || null;
    }
    material.needsUpdate = true;
    return true;
  }
  return Boolean(material);
}

function createStrokeMaskTarget(width = 1, height = 1) {
  const scale = Math.min(
    1,
    MAX_TSL_SURFACE_STROKE_MASK_SIZE / Math.max(1, Math.max(
      Math.floor(Number(width) || 1),
      Math.floor(Number(height) || 1)
    ))
  );
  const targetWidth = Math.max(1, Math.round(Math.max(1, Math.floor(Number(width) || 1)) * scale));
  const targetHeight = Math.max(1, Math.round(Math.max(1, Math.floor(Number(height) || 1)) * scale));
  const target = new THREE.RenderTarget(targetWidth, targetHeight, {
    depthBuffer: false,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    generateMipmaps: false
  });
  target.texture.name = "texture-paint-tsl-surface-airbrush-stroke-mask";
  target.texture.colorSpace = THREE.NoColorSpace || target.texture.colorSpace;
  target.texture.flipY = false;
  target.texture.wrapS = THREE.ClampToEdgeWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;
  target.texture.userData ||= {};
  target.texture.userData.texturePaintTslSurfaceAirbrushStrokeMask = true;
  target.texture.userData.texturePaintTslSurfaceAirbrushSourceWidth = Math.max(1, Math.floor(Number(width) || 1));
  target.texture.userData.texturePaintTslSurfaceAirbrushSourceHeight = Math.max(1, Math.floor(Number(height) || 1));
  return target;
}

function ensureSurfaceStrokeMaskTarget(cache = null, width = 1, height = 1) {
  if (!cache) {
    return null;
  }
  const targetWidth = Math.max(
    1,
    Math.round(Math.max(1, Math.floor(Number(width) || 1)) * Math.min(
      1,
      MAX_TSL_SURFACE_STROKE_MASK_SIZE / Math.max(1, Math.max(
        Math.floor(Number(width) || 1),
        Math.floor(Number(height) || 1)
      ))
    ))
  );
  const targetHeight = Math.max(
    1,
    Math.round(Math.max(1, Math.floor(Number(height) || 1)) * Math.min(
      1,
      MAX_TSL_SURFACE_STROKE_MASK_SIZE / Math.max(1, Math.max(
        Math.floor(Number(width) || 1),
        Math.floor(Number(height) || 1)
      ))
    ))
  );
  if (
    !cache.strokeMaskTarget
    || cache.strokeMaskTarget.width !== targetWidth
    || cache.strokeMaskTarget.height !== targetHeight
    || cache.strokeMaskTarget.texture?.userData?.texturePaintTslSurfaceAirbrushSourceWidth !== Math.max(1, Math.floor(Number(width) || 1))
    || cache.strokeMaskTarget.texture?.userData?.texturePaintTslSurfaceAirbrushSourceHeight !== Math.max(1, Math.floor(Number(height) || 1))
  ) {
    retireSurfaceAirbrushResource(cache, cache.strokeMaskTarget);
    cache.strokeMaskTarget = createStrokeMaskTarget(width, height);
    cache.strokeMaskInitialized = false;
  }
  return cache.strokeMaskTarget?.texture ? cache.strokeMaskTarget : null;
}

function clearSurfaceStrokeMaskTarget(renderer = null, cache = null) {
  const target = cache?.strokeMaskTarget || null;
  if (!renderer || !cache || !target) {
    return false;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  const previousClearAlpha = typeof renderer.getClearAlpha === "function"
    ? renderer.getClearAlpha()
    : 1;
  const previousClearColor = typeof renderer.getClearColor === "function"
    ? renderer.getClearColor(_scratchClearColor)
    : null;
  try {
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.setClearColor?.(0x000000, 0);
    renderer.clear?.();
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    if (previousClearColor) {
      renderer.setClearColor?.(previousClearColor, previousClearAlpha);
    }
  }
  cache.strokeMaskInitialized = true;
  return true;
}

function createStrokeCompositeMaterial(baseTexture = null, maskTexture = null, options = {}) {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const layerOnly = options.layerOnly === true;
  const {
    Fn,
    clamp,
    float,
    max,
    mix,
    positionLocal,
    texture,
    uniform,
    uv,
    vec2,
    vec3,
    vec4
  } = tsl;
  const baseTextureNode = texture(baseTexture);
  const maskTextureNode = texture(maskTexture);
  const brushColor = uniform(new THREE.Vector4(0, 1, 0.4, 1), "vec4");
  const blendOnly = uniform(0, "float");
  const emptyLayerSource = uniform(0, "float");
  const baseFlipY = uniform(0, "float");
  const maskFlipY = uniform(0, "float");
  const vertexNode = Fn(() => vec4(positionLocal.x, positionLocal.y, 0, 1))();
  const fragmentNode = Fn(() => {
    const currentUv = uv().toVar();
    const baseUv = vec2(
      currentUv.x,
      mix(currentUv.y, float(1).sub(currentUv.y), baseFlipY)
    ).toVar();
    const maskUv = vec2(
      currentUv.x,
      mix(currentUv.y, float(1).sub(currentUv.y), maskFlipY)
    ).toVar();
    const baseColor = baseTextureNode.sample(baseUv).toVar();
    const mask = maskTextureNode.sample(maskUv).toVar();
    const alpha = clamp(mask.a, 0.0, 1.0).toVar();
    const emptyLayer = emptyLayerSource.greaterThan(0.5).toVar();
    emptyLayer.and(alpha.lessThanEqual(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD)).discard();
    const oneMinusAlpha = float(1).sub(alpha).toVar();
    const compositedLayerAlpha = clamp(alpha.add(baseColor.a.mul(oneMinusAlpha)), 0.0, 1.0).toVar();
    const compositedLayerPremul = brushColor.rgb.mul(alpha)
      .add(baseColor.rgb.mul(baseColor.a).mul(oneMinusAlpha))
      .toVar();
    const compositedLayerRgb = compositedLayerAlpha.greaterThan(0.0001)
      .select(compositedLayerPremul.div(max(compositedLayerAlpha, 0.0001)), brushColor.rgb)
      .toVar();
    const layerOutAlpha = emptyLayer.select(alpha, compositedLayerAlpha).toVar();
    const layerOutRgb = emptyLayer.select(brushColor.rgb, compositedLayerRgb).toVar();
    const storedLayerRgb = layerOutAlpha.greaterThan(0.0001).select(layerOutRgb.mul(layerOutAlpha), vec3(0)).toVar();
    const brushOnlyColor = vec4(storedLayerRgb.x, storedLayerRgb.y, storedLayerRgb.z, layerOutAlpha).toVar();
    if (layerOnly) {
      return brushOnlyColor;
    }
    return vec4(mix(baseColor.rgb, brushColor.rgb, alpha), 1);
  })();
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: layerOnly ? THREE.NoBlending : THREE.CustomBlending,
    toneMapped: false
  });
  if (!layerOnly) {
    material.blendEquation = THREE.AddEquation;
    material.blendEquationAlpha = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.ZeroFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.ZeroFactor;
  }
  material.vertexNode = vertexNode;
  material.fragmentNode = fragmentNode;
  material.name = layerOnly
    ? "texture-paint-tsl-surface-airbrush-stroke-layer-composite"
    : "texture-paint-tsl-surface-airbrush-stroke-composite";
  material.userData.texturePaintTslSurfaceStrokeComposite = {
    baseTextureNode,
    maskTextureNode,
    brushColor,
    blendOnly,
    emptyLayerSource,
    baseFlipY,
    maskFlipY,
    layerOnly
  };
  return material;
}

function updateStrokeCompositeMaterial(
  material = null,
  baseTexture = null,
  maskTexture = null,
  options = {}
) {
  const state = material?.userData?.texturePaintTslSurfaceStrokeComposite || null;
  if (!material || !state || !baseTexture || !maskTexture) {
    return false;
  }
  let changed = false;
  if (state.baseTextureNode.value !== baseTexture) {
    state.baseTextureNode.value = baseTexture;
    changed = true;
  }
  if (state.maskTextureNode.value !== maskTexture) {
    state.maskTextureNode.value = maskTexture;
    changed = true;
  }
  const color = options.color || { r: 255, g: 255, b: 255 };
  state.brushColor.value.set(
    clamp01((Number(color.r) || 0) / 255),
    clamp01((Number(color.g) || 0) / 255),
    clamp01((Number(color.b) || 0) / 255),
    1
  );
  state.blendOnly.value = options.blendOnly === true ? 1 : 0;
  state.emptyLayerSource.value = options.emptyLayerSource === true ? 1 : 0;
  state.baseFlipY.value = textureNodeAppliesFlipY(baseTexture) ? 1 : 0;
  state.maskFlipY.value = maskTexture?.userData?.texturePaintTslSurfaceAirbrushStrokeMask === true
    ? 0
    : textureNodeAppliesFlipY(maskTexture) ? 1 : 0;
  if (changed) {
    material.needsUpdate = true;
  }
  return true;
}

function ensureStrokeCompositePass(cache = null, baseTexture = null, maskTexture = null, options = {}) {
  if (!cache || !baseTexture || !maskTexture) {
    return false;
  }
  if (!cache.strokeCompositeScene) {
    cache.strokeCompositeScene = new THREE.Scene();
  }
  const materialKey = options.blendOnly === true
    ? "strokeCompositeLayerMaterial"
    : "strokeCompositeMaterial";
  if (!cache[materialKey]) {
    cache[materialKey] = createStrokeCompositeMaterial(baseTexture, maskTexture, {
      layerOnly: options.blendOnly === true
    });
  }
  const material = cache[materialKey] || null;
  if (material && cache.strokeCompositeMaterial !== material) {
    cache.strokeCompositeMaterial = material;
    if (cache.strokeCompositeMesh) {
      cache.strokeCompositeMesh.material = material;
    }
  }
  if (!cache.strokeCompositeMesh && material) {
    cache.strokeCompositeMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      material
    );
    cache.strokeCompositeMesh.frustumCulled = false;
    cache.strokeCompositeScene.add(cache.strokeCompositeMesh);
  }
  return Boolean(cache.strokeCompositeScene && cache.strokeCompositeMesh && cache.strokeCompositeMaterial);
}

function renderSurfaceStrokeComposite(
  renderer = null,
  cache = null,
  target = null,
  baseTexture = null,
  maskTexture = null,
  options = {}
) {
  if (
    !renderer
    || !cache
    || !target?.texture
    || !baseTexture
    || !maskTexture
    || !ensureStrokeCompositePass(cache, baseTexture, maskTexture, options)
    || !updateStrokeCompositeMaterial(cache.strokeCompositeMaterial, baseTexture, maskTexture, options)
  ) {
    return null;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  const clearTransparentBase = options.emptyLayerSource === true;
  try {
    if (clearTransparentBase) {
      clearRenderTargetTransparent(renderer, target, cache);
      renderer.setRenderTarget(target);
      renderer.autoClear = false;
    } else {
      renderer.setRenderTarget(target);
      renderer.autoClear = true;
      renderer.clear?.();
    }
    renderer.render(cache.strokeCompositeScene, cache.camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
  return target;
}

function createTransparentClearMaterial() {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const { Fn, positionLocal, vec4 } = tsl;
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false
  });
  material.vertexNode = Fn(() => vec4(positionLocal.x, positionLocal.y, 0, 1))();
  material.fragmentNode = Fn(() => vec4(0, 0, 0, 0))();
  material.name = "texture-paint-tsl-surface-airbrush-transparent-clear";
  return material;
}

function ensureTransparentClearPass(cache = null) {
  if (!cache) {
    return false;
  }
  if (!cache.transparentClearScene) {
    cache.transparentClearScene = new THREE.Scene();
  }
  if (!cache.transparentClearMaterial) {
    cache.transparentClearMaterial = createTransparentClearMaterial();
  }
  if (!cache.transparentClearMesh && cache.transparentClearMaterial) {
    cache.transparentClearMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      cache.transparentClearMaterial
    );
    cache.transparentClearMesh.frustumCulled = false;
    cache.transparentClearScene.add(cache.transparentClearMesh);
  }
  return Boolean(cache.transparentClearScene && cache.transparentClearMesh && cache.transparentClearMaterial);
}

function createLayerCompositeMaterial(baseTexture = null, layerTexture = null) {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const {
    Fn,
    clamp,
    float,
    max,
    mix,
    positionLocal,
    texture,
    uniform,
    uv,
    vec2,
    vec4
  } = tsl;
  const baseTextureNode = texture(baseTexture);
  const layerTextureNode = texture(layerTexture);
  const opacity = uniform(1, "float");
  const alphaScale = uniform(1, "float");
  const alphaFallback = uniform(0, "float");
  const baseFlipY = uniform(0, "float");
  const layerFlipY = uniform(0, "float");
  const vertexNode = Fn(() => vec4(positionLocal.x, positionLocal.y, 0, 1))();
  const fragmentNode = Fn(() => {
    const currentUv = uv().toVar();
    const baseUv = vec2(
      currentUv.x,
      mix(currentUv.y, float(1).sub(currentUv.y), baseFlipY)
    ).toVar();
    const layerUv = vec2(
      currentUv.x,
      mix(currentUv.y, float(1).sub(currentUv.y), layerFlipY)
    ).toVar();
    const base = baseTextureNode.sample(baseUv).toVar();
    const layer = layerTextureNode.sample(layerUv).toVar();
    const rawAlpha = clamp(layer.a.mul(opacity), 0.0, 1.0).toVar();
    const layerPresence = clamp(max(max(layer.r, layer.g), layer.b), 0.0, 1.0).toVar();
    const needsAlphaFallback = alphaFallback.greaterThan(0.5)
      .and(rawAlpha.greaterThan(0.98))
      .and(layerPresence.greaterThan(0.001))
      .toVar();
    const sourceAlpha = needsAlphaFallback
      .select(clamp(layerPresence.mul(alphaScale), 0.0, 1.0), clamp(layer.a, 0.0, 1.0))
      .toVar();
    const alpha = clamp(sourceAlpha.mul(opacity), 0.0, 1.0).toVar();
    const layerRgb = sourceAlpha.greaterThan(0.0001)
      .select(clamp(layer.rgb.div(max(sourceAlpha, 0.0001)), 0.0, 1.0), layer.rgb)
      .toVar();
    const compositedRgb = mix(base.rgb, layerRgb, alpha).toVar();
    const compositedAlpha = clamp(alpha.add(base.a.mul(float(1).sub(alpha))), 0.0, 1.0).toVar();
    return vec4(compositedRgb, compositedAlpha);
  })();
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false
  });
  material.vertexNode = vertexNode;
  material.fragmentNode = fragmentNode;
  material.name = "texture-paint-tsl-surface-airbrush-layer-composite";
  material.userData.texturePaintTslSurfaceLayerComposite = {
    baseTextureNode,
    layerTextureNode,
    opacity,
    alphaScale,
    alphaFallback,
    baseFlipY,
    layerFlipY
  };
  return material;
}

function updateLayerCompositeMaterial(
  material = null,
  baseTexture = null,
  layerTexture = null,
  opacity = 1,
  options = {}
) {
  const state = material?.userData?.texturePaintTslSurfaceLayerComposite || null;
  if (!material || !state || !baseTexture || !layerTexture) {
    return false;
  }
  let changed = false;
  if (state.baseTextureNode.value !== baseTexture) {
    state.baseTextureNode.value = baseTexture;
    changed = true;
  }
  if (state.layerTextureNode.value !== layerTexture) {
    state.layerTextureNode.value = layerTexture;
    changed = true;
  }
  state.opacity.value = clamp01(opacity);
  if (state.alphaScale) {
    state.alphaScale.value = clamp01(options.alphaScale ?? 1);
  }
  if (state.alphaFallback) {
    state.alphaFallback.value = options.alphaFallback === true ? 1 : 0;
  }
  if (state.baseFlipY) {
    state.baseFlipY.value = baseTexture?.flipY === true ? 1 : 0;
  }
  if (state.layerFlipY) {
    state.layerFlipY.value = textureNodeAppliesFlipY(layerTexture) ? 1 : 0;
  }
  if (changed) {
    material.needsUpdate = true;
  }
  return true;
}

function copySurfaceBaseTexture(renderer = null, sourceTexture = null, target = null, cache = null) {
  if (
    !renderer
    || !sourceTexture
    || !target?.texture
    || typeof renderer.copyTextureToTexture !== "function"
  ) {
    cache && (cache.texturePaintTslSurfaceLastBaseCopyError = "missing-copyTextureToTexture");
    return false;
  }
  if (
    typeof window === "undefined"
    || !new URLSearchParams(window.location?.search || "").has("debugAirbrushNativeCopy")
  ) {
    cache && (cache.texturePaintTslSurfaceLastBaseCopyError = "native-copy-disabled");
    return false;
  }
  if (sourceTexture === target.texture) {
    return true;
  }
  const sourceNeedsFlip = textureNodeAppliesFlipY(sourceTexture);
  const targetNeedsFlip = textureNodeAppliesFlipY(target.texture);
  if (sourceNeedsFlip !== targetNeedsFlip) {
    cache && (cache.texturePaintTslSurfaceLastBaseCopyError = "copy-needs-flip");
    return false;
  }
  const sourceSize = textureLikeSize(sourceTexture);
  const targetSize = textureLikeSize(target.texture);
  if (
    sourceSize.width !== targetSize.width
    || sourceSize.height !== targetSize.height
    || sourceSize.width !== Math.max(1, Math.floor(Number(target.width) || 1))
    || sourceSize.height !== Math.max(1, Math.floor(Number(target.height) || 1))
  ) {
    return false;
  }
  try {
    renderer.copyTextureToTexture(sourceTexture, target.texture);
    cache && (cache.texturePaintTslSurfaceLastBaseCopyError = "");
    return true;
  } catch (error) {
    cache && (cache.texturePaintTslSurfaceLastBaseCopyError = String(error?.message || error || ""));
    return false;
  }
}

function ensureSurfaceStrokeBaseTexture(
  renderer = null,
  cache = null,
  sourceTexture = null,
  referenceTexture = null,
  width = 1,
  height = 1
) {
  if (!renderer || !cache || !sourceTexture) {
    return sourceTexture || null;
  }
  if (surfaceAirbrushTextureIsLiveTarget(sourceTexture) && !surfaceAirbrushCacheOwnsTexture(cache, sourceTexture)) {
    sourceTexture = surfaceAirbrushStableTextureFromLiveTarget(sourceTexture) || sourceTexture;
  }
  if (
    !cache.strokeBaseTarget
    || cache.strokeBaseTarget.width !== width
    || cache.strokeBaseTarget.height !== height
  ) {
    retireSurfaceAirbrushResource(cache, cache.strokeBaseTarget);
    cache.strokeBaseTarget = createRenderTarget(width, height, referenceTexture || sourceTexture);
  } else {
    copyTextureSettings(cache.strokeBaseTarget.texture, referenceTexture || sourceTexture);
  }
  const copiedBaseTexture = copySurfaceBaseTexture(renderer, sourceTexture, cache.strokeBaseTarget, cache);
  cache.texturePaintTslSurfaceLastStrokeBaseCopy = copiedBaseTexture ? "gpu-copy" : "shader-copy";
  if (copiedBaseTexture) {
    return cache.strokeBaseTarget.texture || sourceTexture;
  }
  if (!cache.copyMaterial || !cache.copyMesh || !cache.copyScene) {
    cache.texturePaintTslSurfaceLastStrokeBaseCopy = "none";
    return sourceTexture;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  try {
    updateTextureCopyMaterial(cache.copyMaterial, sourceTexture);
    renderer.setRenderTarget(cache.strokeBaseTarget);
    renderer.autoClear = true;
    renderer.clear?.();
    renderer.render(cache.copyScene, cache.camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
  return cache.strokeBaseTarget.texture || sourceTexture;
}

function editorViewportPixels(editor = null) {
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  return {
    width: Math.max(1, Math.ceil(finiteNumber(rect?.width, editor?.canvas?.clientWidth || editor?.canvas?.width || 1))),
    height: Math.max(1, Math.ceil(finiteNumber(rect?.height, editor?.canvas?.clientHeight || editor?.canvas?.height || 1)))
  };
}

function createVisibleSurfaceTarget(width = 1, height = 1) {
  const target = new THREE.RenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat
  });
  target.texture.name = "texture-paint-tsl-visible-surface";
  target.texture.colorSpace = THREE.NoColorSpace || target.texture.colorSpace;
  target.texture.flipY = false;
  target.texture.wrapS = THREE.ClampToEdgeWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;
  return target;
}

function createVisibleSurfaceMaterial() {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const { Fn, clamp, normalView, positionView, vec4 } = tsl;
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false
  });
  material.fragmentNode = Fn(() => {
    const encodedNormalZ = clamp(normalView.z.mul(0.5).add(0.5), 0.0, 1.0).toVar();
    return vec4(positionView.z.mul(-1), encodedNormalZ, 0, 1);
  })();
  material.name = "texture-paint-tsl-visible-surface-material";
  return material;
}

function createUvMaskMaterial() {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const { Fn, uv, vec2, vec4 } = tsl;
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  material.vertexNode = Fn(() => {
    const atlasUv = uv();
    return vec4(atlasUv.sub(vec2(0.5)).mul(2), 0, 1);
  })();
  material.fragmentNode = vec4(1, 1, 1, 1);
  material.name = "texture-paint-tsl-surface-airbrush-uv-mask";
  return material;
}

function createDilationSeedMaterial(sourceTexture = null, maskTexture = null, options = {}) {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const preserveSourceAlpha = options.preserveSourceAlpha === true;
  const { Fn, texture, uv, vec4 } = tsl;
  const sourceTextureNode = texture(sourceTexture, uv());
  const maskTextureNode = texture(maskTexture, uv());
  const fragmentNode = Fn(() => {
    const color = sourceTextureNode.toVar();
    const mask = maskTextureNode.toVar();
    return vec4(color.rgb, preserveSourceAlpha ? color.a : mask.r);
  })();
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  material.fragmentNode = fragmentNode;
  material.name = "texture-paint-tsl-surface-airbrush-dilation-seed";
  material.userData.texturePaintTslSurfaceDilationSeed = {
    sourceTextureNode,
    maskTextureNode,
    preserveSourceAlpha
  };
  return material;
}

function updateDilationSeedMaterial(material = null, sourceTexture = null, maskTexture = null) {
  const state = material?.userData?.texturePaintTslSurfaceDilationSeed || null;
  if (!state) {
    return false;
  }
  state.sourceTextureNode.value = sourceTexture;
  state.maskTextureNode.value = maskTexture;
  return true;
}

function createDilationMaterial(sourceTexture = null, texelSize = new THREE.Vector2(1, 1)) {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const { Fn, If, texture, uniform, uv, vec2, vec4 } = tsl;
  const sourceTextureNode = texture(sourceTexture, uv());
  const texelSizeNode = uniform(texelSize, "vec2");
  const offsets = TSL_SURFACE_DILATION_SAMPLE_RADII.flatMap((radius) => [
    [-radius, -radius], [0, -radius], [radius, -radius],
    [-radius, 0], [radius, 0],
    [-radius, radius], [0, radius], [radius, radius]
  ]);
  const fragmentNode = Fn(() => {
    const currentUv = uv().toVar();
    const result = sourceTextureNode.toVar();
    If(result.a.lessThan(0.5), () => {
      for (const offset of offsets) {
        const sample = sourceTextureNode.sample(currentUv.add(vec2(offset[0], offset[1]).mul(texelSizeNode))).toVar();
        If(sample.a.greaterThan(result.a), () => {
          result.assign(vec4(sample.rgb, sample.a));
        });
      }
    });
    return result;
  })();
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  material.fragmentNode = fragmentNode;
  material.name = "texture-paint-tsl-surface-airbrush-dilation";
  material.userData.texturePaintTslSurfaceDilation = {
    sourceTextureNode,
    texelSizeNode
  };
  return material;
}

function updateDilationMaterial(material = null, sourceTexture = null, width = 1, height = 1) {
  const state = material?.userData?.texturePaintTslSurfaceDilation || null;
  if (!state) {
    return false;
  }
  state.sourceTextureNode.value = sourceTexture;
  state.texelSizeNode.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  return true;
}

function ensureDilationResources(cache = null, referenceTexture = null, width = 1, height = 1) {
  if (!cache) {
    return false;
  }
  if (
    !cache.maskTarget
    || cache.maskTarget.width !== width
    || cache.maskTarget.height !== height
    || !cache.dilationTargets?.[0]
    || cache.dilationTargets[0].width !== width
    || cache.dilationTargets[0].height !== height
  ) {
    retireSurfaceAirbrushResource(cache, cache.maskTarget);
    retireSurfaceAirbrushResources(cache, cache.dilationTargets);
    cache.maskTarget = createRenderTarget(width, height, referenceTexture);
    cache.dilationTargets = [
      createRenderTarget(width, height, referenceTexture),
      createRenderTarget(width, height, referenceTexture)
    ];
  } else {
    copyTextureSettings(cache.maskTarget.texture, referenceTexture);
    for (const target of cache.dilationTargets) {
      copyTextureSettings(target.texture, referenceTexture);
    }
  }
  cache.maskMaterial ||= createUvMaskMaterial();
  cache.dilationSeedMaterial ||= createDilationSeedMaterial(referenceTexture, cache.maskTarget.texture);
  cache.dilationSeedAlphaMaterial ||= createDilationSeedMaterial(referenceTexture, cache.maskTarget.texture, {
    preserveSourceAlpha: true
  });
  cache.dilationMaterial ||= createDilationMaterial(referenceTexture, new THREE.Vector2(1 / width, 1 / height));
  if (!cache.dilationScene) {
    cache.dilationScene = new THREE.Scene();
    cache.dilationMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cache.dilationSeedMaterial);
    cache.dilationMesh.frustumCulled = false;
    cache.dilationScene.add(cache.dilationMesh);
  }
  return Boolean(
    cache.maskMaterial
    && cache.dilationSeedMaterial
    && cache.dilationSeedAlphaMaterial
    && cache.dilationMaterial
    && cache.dilationMesh
  );
}

function runSurfaceDilation(
  renderer = null,
  cache = null,
  paintedTarget = null,
  referenceTexture = null,
  width = 1,
  height = 1,
  passCount = surfaceAirbrushDilationPasses(),
  options = {}
) {
  const passes = Math.max(0, Math.floor(finiteNumber(passCount, surfaceAirbrushDilationPasses())));
  if (passes <= 0) {
    return paintedTarget;
  }
  const rasterMeshes = (Array.isArray(cache?.surfaceMeshes) && cache.surfaceMeshes.length
    ? cache.surfaceMeshes.map((entry) => entry?.mesh).filter(Boolean)
    : cache?.mesh
      ? [cache.mesh]
      : []);
  if (!renderer || !rasterMeshes.length || !paintedTarget || !ensureDilationResources(cache, referenceTexture, width, height)) {
    return paintedTarget;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  const previousMeshMaterials = rasterMeshes.map((mesh) => mesh.material);
  try {
    for (const mesh of rasterMeshes) {
      mesh.material = cache.maskMaterial;
    }
    renderer.setRenderTarget(cache.maskTarget);
    renderer.autoClear = true;
    renderer.clear?.();
    renderer.render(cache.scene, cache.camera);

    const seedMaterial = options.preserveSourceAlpha === true
      ? cache.dilationSeedAlphaMaterial
      : cache.dilationSeedMaterial;
    updateDilationSeedMaterial(seedMaterial, paintedTarget.texture, cache.maskTarget.texture);
    cache.dilationMesh.material = seedMaterial;
    renderer.setRenderTarget(cache.dilationTargets[0]);
    renderer.autoClear = true;
    renderer.clear?.();
    renderer.render(cache.dilationScene, cache.camera);

    let source = cache.dilationTargets[0];
    let destination = cache.dilationTargets[1];
    for (let pass = 0; pass < passes; pass += 1) {
      updateDilationMaterial(cache.dilationMaterial, source.texture, width, height);
      cache.dilationMesh.material = cache.dilationMaterial;
      renderer.setRenderTarget(destination);
      renderer.autoClear = true;
      renderer.clear?.();
      renderer.render(cache.dilationScene, cache.camera);
      const next = source;
      source = destination;
      destination = next;
    }
    return source;
  } finally {
    for (let index = 0; index < rasterMeshes.length; index += 1) {
      rasterMeshes[index].material = previousMeshMaterials[index];
    }
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
}

function syncUvRasterMeshFromSource(mesh = null, sourceObject = null) {
  if (!mesh || !sourceObject) {
    return false;
  }
  sourceObject.updateMatrixWorld?.(true);
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.matrix.copy(sourceObject.matrixWorld);
  mesh.matrixWorld.copy(sourceObject.matrixWorld);
  if (sourceObject.isSkinnedMesh === true) {
    mesh.skeleton = sourceObject.skeleton;
    if (sourceObject.bindMatrix && mesh.bindMatrix) {
      mesh.bindMatrix.copy(sourceObject.bindMatrix);
    }
    if (sourceObject.bindMatrixInverse && mesh.bindMatrixInverse) {
      mesh.bindMatrixInverse.copy(sourceObject.bindMatrixInverse);
    }
  }
  if (Array.isArray(sourceObject.morphTargetInfluences)) {
    mesh.morphTargetInfluences = sourceObject.morphTargetInfluences;
    mesh.morphTargetDictionary = sourceObject.morphTargetDictionary;
  }
  return true;
}

function createUvRasterMesh(sourceObject = null, material = null) {
  const geometry = sourceObject?.geometry || null;
  if (!sourceObject || !geometry || !material) {
    return null;
  }
  const rasterGeometry = geometry.clone();
  const mesh = sourceObject.isSkinnedMesh === true
    ? new THREE.SkinnedMesh(rasterGeometry, material)
    : new THREE.Mesh(rasterGeometry, material);
  if (sourceObject.isSkinnedMesh === true && sourceObject.skeleton) {
    mesh.bind?.(sourceObject.skeleton, sourceObject.bindMatrix);
  }
  mesh.name = "texture-paint-tsl-surface-airbrush-uv-raster";
  mesh.frustumCulled = false;
  syncUvRasterMeshFromSource(mesh, sourceObject);
  return mesh;
}

function createSourceUvRasterMesh(material = null) {
  if (!material) {
    return null;
  }
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.name = "texture-paint-tsl-surface-airbrush-expanded-uv-raster";
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.matrix.identity();
  mesh.matrixWorld.identity();
  return mesh;
}

function ensureSourceUvRasterGeometry(
  entry = null,
  editor = null,
  sourceObject = null,
  texture = null,
  width = 1,
  height = 1,
  editable = null,
  textures = new Set(),
  fallbackMaterialIndex = null,
  referenceTexture = null,
  options = {}
) {
  if (!entry?.mesh || !sourceObject || !texture || !editor?.camera) {
    return false;
  }
  const gutterPixels = Math.max(
    UV_GUTTER_PIXELS,
    Math.floor(finiteNumber(options.sourceRasterGutterPixels, surfaceAirbrushSourceRasterGutterPixels()))
  );
  const writeTexture = options.writeTexture || texture;
  const sampleTexture = options.sampleTexture || texture;
  const rasterWidth = Math.max(1, Math.floor(Number(options.rasterWidth) || width));
  const rasterHeight = Math.max(1, Math.floor(Number(options.rasterHeight) || height));
  const sampleSize = textureLikeSize(sampleTexture);
  const key = sourceUvRasterGeometryKey(
    editor,
    sourceObject,
    texture,
    rasterWidth,
    rasterHeight,
    editable,
    textures,
    fallbackMaterialIndex,
    options,
    gutterPixels
  );
  if (key && entry.texturePaintTslSourceRasterKey === key && entry.mesh.geometry?.attributes?.sourceUv) {
    entry.texturePaintTslSourceRasterCacheHit = true;
    entry.texturePaintTslSourceRasterKeyHash = surfaceDebugKeyHash(key);
    return true;
  }
  entry.texturePaintTslSourceRasterCacheHit = false;
  entry.texturePaintTslSourceRasterKeyHash = surfaceDebugKeyHash(key);
  const triangles = sourceUvRasterTriangles(
    editor,
    sourceObject,
    texture,
    rasterWidth,
    rasterHeight,
    editable,
    textures,
    fallbackMaterialIndex,
    {
      ...options,
      writeTexture,
      sampleTexture
    }
  );
  const geometry = updateSourceRasterGeometry(
    entry.mesh.geometry,
    triangles,
    rasterWidth,
    rasterHeight,
    referenceTexture || sampleTexture || texture,
    gutterPixels,
    sampleSize.width,
    sampleSize.height
  );
  if (!geometry) {
    return false;
  }
  if (entry.mesh.geometry !== geometry) {
    entry.mesh.geometry?.dispose?.();
    entry.mesh.geometry = geometry;
  }
  entry.ownsGeometry = true;
  entry.texturePaintTslSourceRasterKey = key;
  entry.texturePaintTslSourceRasterKeyHash = surfaceDebugKeyHash(key);
  entry.texturePaintTslSourceRasterTriangleCount = triangles.length;
  return true;
}

function sourceUvOccupancyKey(
  editor = null,
  sourceObjects = [],
  texture = null,
  width = 1,
  height = 1,
  editable = null,
  textures = new Set(),
  fallbackSourceObject = null,
  fallbackMaterialIndex = null,
  options = {}
) {
  return [
    width,
    height,
    texture?.flipY === true ? "flipY" : "noFlipY",
    texture?.matrixAutoUpdate === false ? "staticMatrix" : "autoMatrix",
    matrixSurfaceKey(texture?.matrix),
    ...sourceObjects.map((sourceObject) => [
      sourceObject?.uuid || sourceObject?.id || "",
      [...sourceObjectMaterialPaintIndices(
        sourceObject,
        editable,
        textures,
        sourceObject === fallbackSourceObject ? fallbackMaterialIndex : null,
        materialScopeOptionsForSourceObject(options, sourceObject, fallbackSourceObject)
      )].sort((a, b) => a - b).join(","),
      sourceObjectUvCoverageKey(sourceObject)
    ].join("/"))
  ].join("|");
}

function ensureUvOccupancyMask(
  renderer = null,
  cache = null,
  sourceObjects = [],
  texture = null,
  width = 1,
  height = 1,
  editable = null,
  textures = new Set(),
  fallbackSourceObject = null,
  fallbackMaterialIndex = null,
  options = {}
) {
  if (!renderer || !cache || !Array.isArray(sourceObjects) || !sourceObjects.length || !texture) {
    return null;
  }
  const key = sourceUvOccupancyKey(
    cache.editor || null,
    sourceObjects,
    texture,
    width,
    height,
    editable,
    textures,
    fallbackSourceObject,
    fallbackMaterialIndex,
    options
  );
  cache.texturePaintTslLastUvOccupancyKeyHash = surfaceDebugKeyHash(key);
  if (
    key
    && cache.uvOccupancyKey === key
    && cache.uvOccupancyTarget
    && cache.uvOccupancyTarget.width === width
    && cache.uvOccupancyTarget.height === height
  ) {
    cache.texturePaintTslLastUvOccupancyCacheHit = true;
    return cache.uvOccupancyTarget.texture;
  }
  cache.texturePaintTslLastUvOccupancyCacheHit = false;
  if (!cache.uvOccupancyTarget || cache.uvOccupancyTarget.width !== width || cache.uvOccupancyTarget.height !== height) {
    retireSurfaceAirbrushResource(cache, cache.uvOccupancyTarget);
    cache.uvOccupancyTarget = createUvOccupancyTarget(width, height);
  }
  cache.uvOccupancyScene ||= new THREE.Scene();
  cache.uvOccupancyMaterial ||= createUvOccupancyMaterial();
  if (!cache.uvOccupancyTarget || !cache.uvOccupancyMaterial) {
    return null;
  }
  cache.uvOccupancyMeshes ||= [];
  const wanted = new Set(sourceObjects);
  for (let index = cache.uvOccupancyMeshes.length - 1; index >= 0; index -= 1) {
    const entry = cache.uvOccupancyMeshes[index];
    if (!wanted.has(entry?.sourceObject) || entry?.geometry !== entry?.sourceObject?.geometry) {
      cache.uvOccupancyScene.remove(entry.mesh);
      entry.mesh?.geometry?.dispose?.();
      cache.uvOccupancyMeshes.splice(index, 1);
    }
  }
  for (const sourceObject of sourceObjects) {
    let entry = cache.uvOccupancyMeshes.find((item) => item?.sourceObject === sourceObject && item?.geometry === sourceObject.geometry);
    if (!entry) {
      entry = {
        sourceObject,
        geometry: sourceObject.geometry,
        mesh: new THREE.Mesh(new THREE.BufferGeometry(), cache.uvOccupancyMaterial)
      };
      entry.mesh.name = "texture-paint-tsl-surface-airbrush-uv-occupancy-mesh";
      entry.mesh.frustumCulled = false;
      entry.mesh.matrixAutoUpdate = false;
      entry.mesh.matrixWorldAutoUpdate = false;
      entry.mesh.matrix.identity();
      entry.mesh.matrixWorld.identity();
      cache.uvOccupancyMeshes.push(entry);
      cache.uvOccupancyScene.add(entry.mesh);
    }
    const triangles = sourceUvRasterTriangles(
      cache.editor || null,
      sourceObject,
      texture,
      width,
      height,
      editable,
      textures,
      sourceObject === fallbackSourceObject ? fallbackMaterialIndex : null,
      materialScopeOptionsForSourceObject(options, sourceObject, fallbackSourceObject)
    );
    const geometry = updateSourceRasterGeometry(
      entry.mesh.geometry,
      triangles,
      width,
      height,
      texture,
      0
    );
    if (!geometry) {
      entry.mesh.visible = false;
      continue;
    }
    if (entry.mesh.geometry !== geometry) {
      entry.mesh.geometry?.dispose?.();
      entry.mesh.geometry = geometry;
    }
    entry.mesh.geometry.clearGroups?.();
    entry.mesh.geometry.addGroup?.(0, entry.mesh.geometry.drawRange?.count || geometry.attributes?.position?.count || 0, 0);
    entry.mesh.material = cache.uvOccupancyMaterial;
    entry.mesh.visible = true;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  const previousClearAlpha = typeof renderer.getClearAlpha === "function"
    ? renderer.getClearAlpha()
    : 1;
  const previousClearColor = typeof renderer.getClearColor === "function"
    ? renderer.getClearColor(_scratchClearColor)
    : null;
  try {
    renderer.setRenderTarget(cache.uvOccupancyTarget);
    renderer.autoClear = true;
    renderer.setClearColor?.(0x000000, 0);
    renderer.clear?.();
    renderer.render(cache.uvOccupancyScene, cache.camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    if (previousClearColor) {
      renderer.setClearColor?.(previousClearColor, previousClearAlpha);
    }
  }
  cache.uvOccupancyKey = key;
  return cache.uvOccupancyTarget.texture;
}

function ensureSurfaceProjectionAttributes(entry = null, editor = null) {
  const sourceObject = entry?.sourceObject || null;
  const sourceGeometry = sourceObject?.geometry || entry?.geometry || null;
  const rasterGeometry = entry?.mesh?.geometry || null;
  const position = sourceGeometry?.attributes?.position || null;
  if (!sourceObject || !sourceGeometry || !rasterGeometry || !position || !editor?.camera) {
    return false;
  }
  sourceObject.updateMatrixWorld?.(true);
  editor.camera.updateMatrixWorld?.(true);
  const vertexCount = Math.max(0, Math.floor(Number(position.count) || 0));
  let viewAttribute = rasterGeometry.getAttribute?.("paintView") || null;
  let screenAttribute = rasterGeometry.getAttribute?.("paintScreen") || null;
  if (!viewAttribute || viewAttribute.count !== vertexCount) {
    viewAttribute = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    rasterGeometry.setAttribute("paintView", viewAttribute);
  }
  if (!screenAttribute || screenAttribute.count !== vertexCount) {
    screenAttribute = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    rasterGeometry.setAttribute("paintScreen", screenAttribute);
  }
  const projectionKey = surfaceProjectionFrameKey(editor, [sourceObject]);
  if (
    projectionKey
    && entry.texturePaintTslSurfaceProjectionKey === projectionKey
    && viewAttribute.count === vertexCount
    && screenAttribute.count === vertexCount
  ) {
    return true;
  }
  const viewArray = viewAttribute.array;
  const screenArray = screenAttribute.array;
  for (let index = 0; index < vertexCount; index += 1) {
    const world = worldPositionForVertex(sourceObject, sourceGeometry, index);
    const screen = screenPointForWorld(editor, world);
    const offset = index * 3;
    if (screen) {
      viewArray[offset] = finiteNumber(screen.viewX, 0);
      viewArray[offset + 1] = finiteNumber(screen.viewY, 0);
      viewArray[offset + 2] = finiteNumber(screen.viewZ, 0);
      screenArray[offset] = finiteNumber(screen.x, -1000000);
      screenArray[offset + 1] = finiteNumber(screen.y, -1000000);
      screenArray[offset + 2] = finiteNumber(screen.z, 0);
    } else {
      viewArray[offset] = 0;
      viewArray[offset + 1] = 0;
      viewArray[offset + 2] = 1000000;
      screenArray[offset] = -1000000;
      screenArray[offset + 1] = -1000000;
      screenArray[offset + 2] = 0;
    }
  }
  viewAttribute.needsUpdate = true;
  screenAttribute.needsUpdate = true;
  entry.texturePaintTslSurfaceProjectionKey = projectionKey;
  return true;
}

function ensureUvRasterMesh(cache = null, sourceObject = null, material = null) {
  if (!cache || !sourceObject || !material) {
    return null;
  }
  if (!cache.mesh || cache.meshSourceObject !== sourceObject || cache.mesh.geometry !== sourceObject.geometry) {
    if (cache.mesh) {
      cache.scene?.remove?.(cache.mesh);
      if (cache.ownsMeshGeometry) {
        cache.mesh.geometry?.dispose?.();
      }
    }
    cache.mesh = createUvRasterMesh(sourceObject, material);
    cache.meshSourceObject = sourceObject;
    cache.ownsMeshGeometry = true;
    if (cache.mesh) {
      cache.scene.add(cache.mesh);
    }
  }
  if (!cache.mesh) {
    return null;
  }
  cache.mesh.material = material;
  syncUvRasterMeshFromSource(cache.mesh, sourceObject);
  return cache.mesh;
}

function disposeUvRasterEntry(cache = null, entry = null) {
  if (!entry) {
    return;
  }
  cache?.scene?.remove?.(entry.mesh);
  entry.material?.dispose?.();
  if (entry.ownsGeometry === true) {
    entry.mesh?.geometry?.dispose?.();
  }
}

function disposeUvRasterEntries(cache = null) {
  if (!cache) {
    return;
  }
  for (const entry of cache.surfaceMeshes || []) {
    disposeUvRasterEntry(cache, entry);
  }
  cache.surfaceMeshes = [];
  cache.mesh = null;
  cache.meshSourceObject = null;
  cache.ownsMeshGeometry = false;
}

function disposeVisibleSurfaceEntry(cache = null, entry = null) {
  if (!entry) {
    return;
  }
  cache?.visibleScene?.remove?.(entry.mesh);
  if (entry.ownsGeometry === true) {
    entry.mesh?.geometry?.dispose?.();
  }
}

function disposeVisibleSurfaceEntries(cache = null) {
  if (!cache) {
    return;
  }
  for (const entry of cache.visibleMeshes || []) {
    disposeVisibleSurfaceEntry(cache, entry);
  }
  cache.visibleMeshes = [];
}

function disposeSurfaceAirbrushCache(cache = null) {
  if (!cache) {
    return;
  }
  disposeUvRasterEntries(cache);
  disposeVisibleSurfaceEntries(cache);
  if (cache.projectedMesh) {
    cache.scene?.remove?.(cache.projectedMesh);
    cache.projectedMesh.geometry?.dispose?.();
  }
  cache.projectedMaterial?.dispose?.();
  cache.projectedLayerMaterial?.dispose?.();
  cache.copyMesh?.geometry?.dispose?.();
  cache.copyMesh?.material?.dispose?.();
  cache.strokeCompositeMesh?.geometry?.dispose?.();
  cache.strokeCompositeMesh?.material?.dispose?.();
  cache.strokeCompositeMaterial?.dispose?.();
  cache.strokeCompositeLayerMaterial?.dispose?.();
  cache.noopMaterial?.dispose?.();
  cache.visibleMaterial?.dispose?.();
  cache.maskMaterial?.dispose?.();
  cache.uvOccupancyMaterial?.dispose?.();
  cache.dilationSeedMaterial?.dispose?.();
  cache.dilationSeedAlphaMaterial?.dispose?.();
  cache.dilationMaterial?.dispose?.();
  cache.dilationMesh?.geometry?.dispose?.();
  cache.dilationMesh?.material?.dispose?.();
  for (const entry of cache.uvOccupancyMeshes || []) {
    entry.mesh?.geometry?.dispose?.();
  }
  retireSurfaceAirbrushResource(cache, cache.uvOccupancyTarget);
  retireSurfaceAirbrushResource(cache, cache.visibleTarget);
  retireSurfaceAirbrushResource(cache, cache.maskTarget);
  retireSurfaceAirbrushResource(cache, cache.strokeMaskTarget);
  retireSurfaceAirbrushResource(cache, cache.strokeCompositeTarget);
  retireSurfaceAirbrushResources(cache, cache.layerCompositeTargets);
  if (!cache.layerCompositeTargets?.includes?.(cache.layerCompositeTarget)) {
    retireSurfaceAirbrushResource(cache, cache.layerCompositeTarget);
  }
  retireSurfaceAirbrushResources(cache, cache.dilationTargets);
  retireSurfaceAirbrushResources(cache, cache.targets);
}

function ensureUvRasterMeshes(
  cache = null,
  sourceObjects = [],
  sourceTexture = null,
  visibleTexture = null,
  uvOccupancyTexture = null,
  editable = null,
  textures = new Set(),
  fallbackSourceObject = null,
  fallbackMaterialIndex = null,
  options = {}
) {
  if (!cache || !Array.isArray(sourceObjects) || !sourceObjects.length || !sourceTexture) {
    return [];
  }
  const useOriginalMeshUvRaster = options.originalMeshUvRaster === true;
  const layerOnlyPaint = options.layerOnly === true && options.maskOnly !== true;
  const paintMode = options.maskOnly === true ? "stroke-mask" : layerOnlyPaint ? "layer" : "color";
  cache.surfaceMeshes ||= [];
  const wanted = new Set(sourceObjects);
  for (let index = cache.surfaceMeshes.length - 1; index >= 0; index -= 1) {
    const entry = cache.surfaceMeshes[index];
    if (
      !wanted.has(entry?.sourceObject)
      || entry?.geometry !== entry?.sourceObject?.geometry
      || entry?.originalMeshUvRaster !== useOriginalMeshUvRaster
      || (entry?.paintMode || "color") !== paintMode
    ) {
      disposeUvRasterEntry(cache, entry);
      cache.surfaceMeshes.splice(index, 1);
    }
  }
  for (const sourceObject of sourceObjects) {
    const objectScopeOptions = materialScopeOptionsForSourceObject(options, sourceObject, fallbackSourceObject);
    let entry = cache.surfaceMeshes.find((item) => item?.sourceObject === sourceObject && item?.geometry === sourceObject.geometry);
    if (!entry) {
      const material = createSurfaceMaterial(sourceTexture, sourceObject, visibleTexture, uvOccupancyTexture, {
        originalMeshUvRaster: useOriginalMeshUvRaster,
        maskOnly: options.maskOnly === true,
        layerOnly: layerOnlyPaint
      });
      const mesh = useOriginalMeshUvRaster
        ? createUvRasterMesh(sourceObject, material)
        : createSourceUvRasterMesh(material);
      if (!material || !mesh) {
        material?.dispose?.();
        mesh?.geometry?.dispose?.();
        continue;
      }
      entry = {
        sourceObject,
        geometry: sourceObject.geometry,
        mesh,
        material,
        originalMeshUvRaster: useOriginalMeshUvRaster,
        paintMode,
        ownsGeometry: true
      };
      cache.surfaceMeshes.push(entry);
      cache.scene?.add?.(mesh);
    }
    if (useOriginalMeshUvRaster) {
      syncUvRasterMeshFromSource(entry.mesh, sourceObject);
    } else if (!ensureSourceUvRasterGeometry(
      entry,
      cache.editor || null,
      sourceObject,
      sourceTexture,
      Math.max(1, Math.floor(Number(options.rasterWidth) || cache.width)),
      Math.max(1, Math.floor(Number(options.rasterHeight) || cache.height)),
      editable,
      textures,
      sourceObject === fallbackSourceObject ? fallbackMaterialIndex : null,
      sourceTexture,
      objectScopeOptions
    )) {
      entry.mesh.visible = false;
      continue;
    }
    entry.mesh.visible = true;
    entry.mesh.material = surfaceRasterMaterialsForSourceObject(
      cache,
      sourceObject,
      editable,
      textures,
      entry.material,
      sourceObject === fallbackSourceObject ? fallbackMaterialIndex : null,
      objectScopeOptions
    );
  }
  cache.mesh = cache.surfaceMeshes[0]?.mesh || null;
  cache.meshSourceObject = cache.surfaceMeshes[0]?.sourceObject || null;
  cache.ownsMeshGeometry = false;
  return cache.surfaceMeshes.filter((entry) => (
    entry?.mesh?.visible !== false
    && surfaceGeometryDrawTriangleCount(entry?.mesh?.geometry) > 0
  ));
}

function ensureVisibleSurfaceResources(
  cache = null,
  sourceObjects = [],
  editor = null,
  editable = null,
  textures = new Set(),
  fallbackSourceObject = null,
  fallbackMaterialIndex = null,
  options = {}
) {
  if (!cache || !Array.isArray(sourceObjects) || !sourceObjects.length || !editor?.camera) {
    return null;
  }
  const viewport = editorViewportPixels(editor);
  if (
    !cache.visibleTarget
    || cache.visibleTarget.width !== viewport.width
    || cache.visibleTarget.height !== viewport.height
  ) {
    retireSurfaceAirbrushResource(cache, cache.visibleTarget);
    cache.visibleTarget = createVisibleSurfaceTarget(viewport.width, viewport.height);
    cache.visibleWidth = viewport.width;
    cache.visibleHeight = viewport.height;
  }
  cache.visibleScene ||= new THREE.Scene();
  cache.visibleMaterial ||= createVisibleSurfaceMaterial();
  if (!cache.visibleTarget || !cache.visibleScene || !cache.visibleMaterial) {
    return null;
  }
  cache.visibleMeshes ||= [];
  const wanted = new Set(sourceObjects);
  for (let index = cache.visibleMeshes.length - 1; index >= 0; index -= 1) {
    const entry = cache.visibleMeshes[index];
    if (!wanted.has(entry?.sourceObject) || entry?.geometry !== entry?.sourceObject?.geometry) {
      disposeVisibleSurfaceEntry(cache, entry);
      cache.visibleMeshes.splice(index, 1);
    }
  }
  for (const sourceObject of sourceObjects) {
    const objectScopeOptions = materialScopeOptionsForSourceObject(options, sourceObject, fallbackSourceObject);
    let entry = cache.visibleMeshes.find((item) => item?.sourceObject === sourceObject && item?.geometry === sourceObject.geometry);
    if (!entry) {
      const mesh = createUvRasterMesh(sourceObject, cache.visibleMaterial);
      if (!mesh) {
        continue;
      }
      mesh.name = "texture-paint-tsl-visible-surface-mesh";
      entry = {
        sourceObject,
        geometry: sourceObject.geometry,
        mesh,
        ownsGeometry: true
      };
      cache.visibleMeshes.push(entry);
      cache.visibleScene.add(mesh);
    }
    entry.mesh.material = surfaceRasterMaterialsForSourceObject(
      cache,
      sourceObject,
      editable,
      textures,
      cache.visibleMaterial,
      sourceObject === fallbackSourceObject ? fallbackMaterialIndex : null,
      objectScopeOptions
    );
    syncUvRasterMeshFromSource(entry.mesh, sourceObject);
  }
  return cache.visibleTarget;
}

function renderVisibleSurfaceTarget(
  renderer = null,
  cache = null,
  sourceObjects = [],
  editor = null,
  editable = null,
  textures = new Set(),
  fallbackSourceObject = null,
  fallbackMaterialIndex = null,
  options = {}
) {
  const frameKey = surfaceProjectionFrameKey(editor, sourceObjects);
  if (
    frameKey
    && cache?.visibleTarget
    && cache.visibleSurfaceFrameKey === frameKey
    && cache.visibleSurfaceEditable === editable
    && cache.visibleSurfaceFallbackObject === fallbackSourceObject
    && cache.visibleSurfaceFallbackMaterialIndex === fallbackMaterialIndex
  ) {
    return cache.visibleTarget;
  }
  const target = ensureVisibleSurfaceResources(
    cache,
    sourceObjects,
    editor,
    editable,
    textures,
    fallbackSourceObject,
    fallbackMaterialIndex,
    options
  );
  if (!renderer || !target || !cache?.visibleScene || !editor?.camera) {
    return null;
  }
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  const previousClearAlpha = typeof renderer.getClearAlpha === "function"
    ? renderer.getClearAlpha()
    : 1;
  const previousClearColor = typeof renderer.getClearColor === "function"
    ? renderer.getClearColor(_scratchClearColor)
    : null;
  try {
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.setClearColor?.(0x000000, 0);
    renderer.clear?.();
    renderer.render(cache.visibleScene, editor.camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    if (previousClearColor) {
      renderer.setClearColor?.(previousClearColor, previousClearAlpha);
    }
  }
  if (cache && frameKey) {
    cache.visibleSurfaceFrameKey = frameKey;
    cache.visibleSurfaceEditable = editable || null;
    cache.visibleSurfaceFallbackObject = fallbackSourceObject || null;
    cache.visibleSurfaceFallbackMaterialIndex = fallbackMaterialIndex ?? null;
  }
  return target;
}

function ensureSurfaceAirbrushCache(editor = null, editable = null, referenceTexture = null, width = 1, height = 1) {
  if (!editor || !editable) {
    return null;
  }
  const cacheKey = stableSurfaceAirbrushCacheKey(editable);
  if (!cacheKey || (typeof cacheKey !== "object" && typeof cacheKey !== "function")) {
    return null;
  }
  editor.texturePaintTslSurfaceAirbrushCaches ||= new WeakMap();
  editor.texturePaintTslSurfaceAirbrushCacheSet ||= new Set();
  editor.texturePaintTslSurfaceAirbrushInvalidate ||= (editableOrTexture = null) => {
    // WebGPU render submissions may still reference the previous render target
    // for a frame after reset/history code invalidates paint state. Detach the
    // cache immediately, but let the old GPU textures age out instead of
    // destroying an in-flight texture and crashing the view.
    if (!editableOrTexture) {
      let invalidated = false;
      for (const candidateCache of editor.texturePaintTslSurfaceAirbrushCacheSet || []) {
        invalidated = resetSurfaceAirbrushDynamicState(candidateCache) || invalidated;
      }
      return invalidated;
    }
    if (editableOrTexture) {
      const key = stableSurfaceAirbrushCacheKey(editableOrTexture);
      const candidateKeys = new Set([
        key,
        editableOrTexture,
        editableOrTexture?.canvas,
        editableOrTexture?.compositeCanvas,
        editableOrTexture?.texture,
        editableOrTexture?.layer?.canvas
      ].filter((value) => value && (typeof value === "object" || typeof value === "function")));
      let invalidated = false;
      for (const candidateKey of candidateKeys) {
        const candidateCache = editor.texturePaintTslSurfaceAirbrushCaches?.get?.(candidateKey) || null;
        if (candidateCache) {
          invalidated = resetSurfaceAirbrushDynamicState(candidateCache) || invalidated;
        }
      }
      for (const candidateCache of editor.texturePaintTslSurfaceAirbrushCacheSet || []) {
        if (
          candidateKeys.has(candidateCache?.editableKey)
          || candidateKeys.has(candidateCache?.editableCanvas)
        ) {
          invalidated = resetSurfaceAirbrushDynamicState(candidateCache) || invalidated;
        }
      }
      if (invalidated) {
        return true;
      }
      if (editableOrTexture?.isMaterial !== true && !editableOrTexture?.userData?.texturePaintLayerStack) {
        return false;
      }
    }
    let invalidated = false;
    for (const candidateCache of editor.texturePaintTslSurfaceAirbrushCacheSet || []) {
      invalidated = resetSurfaceAirbrushDynamicState(candidateCache) || invalidated;
    }
    return invalidated;
  };
  let cache = editor.texturePaintTslSurfaceAirbrushCaches.get(cacheKey);
  const needsTargets = !cache
    || cache.width !== width
    || cache.height !== height
    || !cache.targets?.[0]
    || !cache.targets?.[1];
  if (needsTargets) {
    if (cache) {
      editor.texturePaintTslSurfaceAirbrushCacheSet.delete(cache);
    }
    if (cache?.ownsMeshGeometry) {
      cache.mesh?.geometry?.dispose?.();
    }
    disposeUvRasterEntries(cache);
    disposeVisibleSurfaceEntries(cache);
    cache?.mesh?.material?.dispose?.();
    cache?.copyMesh?.geometry?.dispose?.();
    cache?.copyMesh?.material?.dispose?.();
    cache?.strokeCompositeMesh?.geometry?.dispose?.();
    cache?.strokeCompositeMesh?.material?.dispose?.();
    cache?.strokeCompositeMaterial?.dispose?.();
    cache?.strokeCompositeLayerMaterial?.dispose?.();
    cache?.transparentClearMesh?.geometry?.dispose?.();
    cache?.transparentClearMesh?.material?.dispose?.();
    cache?.transparentClearMaterial?.dispose?.();
    cache?.noopMaterial?.dispose?.();
    cache?.visibleMaterial?.dispose?.();
    cache?.maskMaterial?.dispose?.();
    cache?.uvOccupancyMaterial?.dispose?.();
    cache?.dilationSeedMaterial?.dispose?.();
    cache?.dilationSeedAlphaMaterial?.dispose?.();
    cache?.dilationMaterial?.dispose?.();
    cache?.dilationMesh?.geometry?.dispose?.();
    cache?.dilationMesh?.material?.dispose?.();
    cache?.layerCompositeMesh?.geometry?.dispose?.();
    cache?.layerCompositeMesh?.material?.dispose?.();
    cache?.layerCompositeMaterial?.dispose?.();
    retireSurfaceAirbrushResource(cache, cache?.displayTarget);
    retireSurfaceAirbrushResources(cache, cache?.layerCompositeTargets);
    if (!cache?.layerCompositeTargets?.includes?.(cache?.layerCompositeTarget)) {
      retireSurfaceAirbrushResource(cache, cache?.layerCompositeTarget);
    }
    retireSurfaceAirbrushResource(cache, cache?.strokeMaskTarget);
    retireSurfaceAirbrushResource(cache, cache?.strokeCompositeTarget);
    for (const entry of cache?.uvOccupancyMeshes || []) {
      entry.mesh?.geometry?.dispose?.();
    }
    retireSurfaceAirbrushResource(cache, cache?.strokeBaseTarget);
    retireSurfaceAirbrushResource(cache, cache?.uvOccupancyTarget);
    if (cache?.projectedMesh) {
      cache.scene?.remove?.(cache.projectedMesh);
      cache.projectedMesh.geometry?.dispose?.();
    }
	    cache?.projectedMaterial?.dispose?.();
	    cache?.projectedLayerMaterial?.dispose?.();
    retireSurfaceAirbrushResource(cache, cache?.visibleTarget);
    retireSurfaceAirbrushResource(cache, cache?.maskTarget);
    retireSurfaceAirbrushResources(cache, cache?.dilationTargets);
    retireSurfaceAirbrushResources(cache, cache?.targets);
    cache = {
      editor,
      width,
      height,
      targets: [
        createRenderTarget(width, height, referenceTexture),
        createRenderTarget(width, height, referenceTexture)
      ],
      targetIndex: -1,
      currentTexture: null,
      hasPaintedSurfaceStroke: false,
      scene: new THREE.Scene(),
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1),
      mesh: null,
      material: null,
      copyScene: new THREE.Scene(),
      copyMesh: null,
      copyMaterial: null,
      strokeCompositeScene: null,
      strokeCompositeMesh: null,
      strokeCompositeMaterial: null,
      strokeCompositeTarget: null,
      displayTarget: null,
      transparentClearScene: null,
      transparentClearMesh: null,
      transparentClearMaterial: null,
      noopMaterial: null,
      strokeBaseTarget: null,
      strokeBaseWasEmptyLayer: false,
      strokeBaseEmptyLayerOwner: null,
      strokeMaskTarget: null,
      strokeMaskInitialized: false,
      projectedMesh: null,
      projectedMaterial: null,
      visibleScene: null,
      visibleMeshes: [],
      visibleMaterial: null,
      visibleTarget: null,
      uvOccupancyScene: null,
      uvOccupancyMeshes: [],
      uvOccupancyMaterial: null,
      uvOccupancyTarget: null,
      uvOccupancyKey: "",
      ownsMeshGeometry: false
    };
    cache.editableKey = cacheKey;
    cache.editableCanvas = editable.canvas || null;
    cache.copyMaterial = createTextureCopyMaterial(referenceTexture);
    cache.copyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cache.copyMaterial);
    cache.copyMesh.frustumCulled = false;
    cache.copyScene.add(cache.copyMesh);
    editor.texturePaintTslSurfaceAirbrushCaches.set(cacheKey, cache);
    editor.texturePaintTslSurfaceAirbrushCacheSet.add(cache);
  } else {
    cache.editor = editor;
    cache.editableKey = cacheKey;
    cache.editableCanvas = editable.canvas || cache.editableCanvas || null;
    for (const target of cache.targets) {
      copyTextureSettings(target.texture, referenceTexture);
    }
    if (cache.copyMaterial) {
      updateTextureCopyMaterial(cache.copyMaterial, referenceTexture);
    }
  }
  return cache;
}

function surfaceTargetIndexForBaseTexture(cache = null, baseTexture = null) {
  const targets = cache?.targets || [];
  const baseIndex = targets.findIndex((target) => target?.texture && target.texture === baseTexture);
  if (baseIndex === 0 && targets[1]) {
    return 1;
  }
  if (baseIndex === 1 && targets[0]) {
    return 0;
  }
  return cache?.targetIndex === 0 && targets[1] ? 1 : 0;
}

function createProjectedSurfaceMaterial(sourceTexture = null, visibleTexture = null, options = {}) {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const layerOnly = options.layerOnly === true;
  const {
    Fn,
    If,
    Loop,
    abs,
    attribute,
    clamp,
    dot,
    float,
    int,
    length,
    max,
    min,
    mix,
    positionLocal,
    pow,
    texture,
    uniform,
    uniformArray,
    uv,
    varyingProperty,
    vec2,
    vec3,
    vec4
  } = tsl;
  const paintUv = varyingProperty("vec2", "vTexturePaintSourceUv");
  const paintView = varyingProperty("vec3", "vTexturePaintView");
  const paintScreen = varyingProperty("vec3", "vTexturePaintScreen");
  const paintNormal = varyingProperty("vec3", "vTexturePaintNormal");
  const paintBarycentric = varyingProperty("vec3", "vTexturePaintBarycentric");
  const paintComponent = varyingProperty("float", "vTexturePaintComponent");
  const sourceTextureNode = texture(sourceTexture, paintUv);
  const visibleTextureNode = texture(visibleTexture || sourceTexture);
  const editorProjectionMatrix = uniform(new THREE.Matrix4(), "mat4");
  const editorViewportSize = uniform(new THREE.Vector2(1, 1), "vec2");
  const brushColor = uniform(new THREE.Vector4(0, 1, 0.4, 1), "vec4");
  const opacity = uniform(0.42, "float");
  const hardness = uniform(0.35, "float");
  const scatter = uniform(0.35, "float");
  const strength = uniform(1, "float");
  const hardVisibleEdge = uniform(0, "float");
  const visibleNormalEdge = uniform(1, "float");
  const blendOnly = uniform(0, "float");
  const emptyLayerSource = uniform(0, "float");
  const visibleSurfaceEnabled = uniform(0, "float");
  const sourceSampleFlipY = uniform(0, "float");
  const projectedPaintGutterOnly = uniform(0, "float");
  const segmentCount = uniform(0, "int");
  const segmentStarts = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentEnds = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentViewStarts = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentViewEnds = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentNormalStarts = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentNormalEnds = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentComponents = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const vertexNode = Fn(() => {
    paintUv.assign(attribute("sourceUv", "vec2"));
    paintView.assign(attribute("paintView", "vec3"));
    paintScreen.assign(attribute("paintScreen", "vec3"));
    paintNormal.assign(attribute("paintNormal", "vec3"));
    paintBarycentric.assign(attribute("paintBarycentric", "vec3"));
    paintComponent.assign(attribute("paintComponent", "float"));
    return vec4(positionLocal.x, positionLocal.y, 0, 1);
  })();
  const fragmentNode = Fn(() => {
    const coverage = float(0).toVar();
    const editorView = paintView.toVar();
    const surfaceScreen = paintScreen.toVar();
    const visibleUvRaw = clamp(surfaceScreen.xy.div(editorViewportSize), vec2(0), vec2(1)).toVar();
    const visibleUv = vec2(visibleUvRaw.x, float(1).sub(visibleUvRaw.y)).toVar();
    const visibleSample = visibleTextureNode.sample(visibleUv).toVar();
    const visibleActive = clamp(visibleSurfaceEnabled, 0.0, 1.0).toVar();
    const visibleSampleValid = clamp(visibleSample.a.mul(32.0), 0.0, 1.0).toVar();
    const editorNormalVector = paintNormal.toVar();
    const editorNormalLength = max(length(editorNormalVector), 0.0001).toVar();
    const editorNormal = editorNormalVector.div(editorNormalLength).toVar();
    const currentFacingNormalZ = editorNormalLength.greaterThan(0.0002)
      .select(editorNormal.z, float(1))
      .toVar();
    const visibleDepth = visibleSample.r.toVar();
    const fragmentDepth = editorView.z.mul(-1).toVar();
    const visibleDelta = abs(fragmentDepth.sub(visibleDepth)).toVar();
    const visibleFacingSampleZ = visibleSample.g.mul(2.0).sub(1.0).toVar();
    const visibleNormalRescue = visibleActive
      .mul(visibleSampleValid)
      .mul(visibleDelta.lessThanEqual(VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS).select(float(1), float(0)))
      .toVar();
    const facingNormalZ = mix(
      currentFacingNormalZ,
      visibleFacingSampleZ,
      visibleNormalRescue
    ).toVar();
    const softFacingRamp = clamp(
      facingNormalZ.add(SOFT_FACING_NORMAL_BACK_FEATHER)
        .div(SOFT_FACING_NORMAL_BACK_FEATHER + SOFT_FACING_NORMAL_FRONT_FEATHER),
      0.0,
      1.0
    ).toVar();
    const softFacingCoverage = softFacingRamp
      .mul(softFacingRamp)
      .mul(float(3).sub(softFacingRamp.mul(2)))
      .toVar();
    const hardFacingCoverage = facingNormalZ.greaterThanEqual(0.0).select(float(1), float(0)).toVar();
    const facingCoverage = mix(softFacingCoverage, hardFacingCoverage, hardVisibleEdge).toVar();
    const normalGate = mix(float(1), facingCoverage, visibleNormalEdge).toVar();
    Loop(MAX_TSL_SURFACE_SEGMENTS, ({ i }) => {
      If(i.lessThan(segmentCount), () => {
        const start = segmentStarts.element(i);
        const end = segmentEnds.element(i);
        const segmentComponent = segmentComponents.element(i);
        const radius = max(start.w, 0.0001);
        const haloRadius = radius.mul(float(1).add(scatter.mul(0.15))).toVar();
        const segmentVector = end.xy.sub(start.xy).toVar();
        const lengthSq = max(dot(segmentVector, segmentVector), 0.000001);
        const segmentT = clamp(dot(surfaceScreen.xy.sub(start.xy), segmentVector).div(lengthSq), 0.0, 1.0).toVar();
        const closest = start.xy.add(segmentVector.mul(segmentT));
        const distance = length(surfaceScreen.xy.sub(closest));
        const coreRadius = radius.mul(float(TEXTURE_AIRBRUSH_CORE_MIN_SCALE).add(
          pow(hardness, TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER).mul(TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE)
        ));
        const fadeRadius = max(haloRadius.sub(coreRadius), 0.0001);
        const normalized = clamp(distance.sub(coreRadius).div(fadeRadius), 0.0, 1.0).toVar();
        const exponent = max(
          1.0,
          float(TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE)
            .add(pow(hardness, TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER).mul(TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE))
            .sub(scatter.mul(TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE))
        );
        const shapedEdge = clamp(pow(normalized, exponent), 0.0, 1.0).toVar();
        const smoothEdge = shapedEdge.mul(shapedEdge).mul(float(3).sub(shapedEdge.mul(2))).toVar();
        const edgeCoverage = max(0.0, float(1).sub(smoothEdge)).toVar();
        const screenCoverage = edgeCoverage.toVar();
        const viewStart = segmentViewStarts.element(i);
        const viewEnd = segmentViewEnds.element(i);
        const viewRadius = max(viewStart.w, 0.0001);
        const hasViewField = viewStart.w.greaterThan(0.0001).and(viewEnd.w.greaterThan(0.0001));
        const viewHaloRadius = viewRadius.mul(float(1).add(scatter.mul(0.15))).toVar();
        const viewVector = viewEnd.xyz.sub(viewStart.xyz).toVar();
        const viewLengthSq = max(dot(viewVector, viewVector), 0.000001);
        const viewT = clamp(dot(editorView.sub(viewStart.xyz), viewVector).div(viewLengthSq), 0.0, 1.0).toVar();
        const viewClosest = viewStart.xyz.add(viewVector.mul(viewT));
        const viewDepthDelta = abs(editorView.z.sub(viewClosest.z)).toVar();
        const viewDepthRadius = max(
          SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_MIN,
          viewRadius.mul(SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_SCALE)
        ).toVar();
        const viewDepthFeather = max(
          SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_MIN,
          viewRadius.mul(SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_SCALE)
        ).toVar();
        const viewDepthFade = clamp(
          viewDepthDelta.sub(viewDepthRadius).div(max(viewDepthFeather, 0.0001)),
          0.0,
          1.0
        ).toVar();
        const viewDepthSmoothFade = viewDepthFade
          .mul(viewDepthFade)
          .mul(float(3).sub(viewDepthFade.mul(2)))
          .toVar();
        const viewDepthCoverage = float(1).sub(viewDepthSmoothFade).toVar();
        const viewCoverage = viewDepthCoverage.toVar();
        const brushFieldCoverage = hasViewField
          .select(screenCoverage.mul(viewCoverage), screenCoverage)
          .toVar();
        const surfaceFieldCoverage = brushFieldCoverage.toVar();
        const gatedCoverage = surfaceFieldCoverage.toVar();
        const insideOriginalTriangle = min(
          min(paintBarycentric.x, paintBarycentric.y),
          paintBarycentric.z
        ).greaterThanEqual(0.0);
        const gutterCoverage = insideOriginalTriangle.select(float(0), gatedCoverage).toVar();
        const baseSampleCoverage = projectedPaintGutterOnly.greaterThan(0.5)
          .select(gutterCoverage, gatedCoverage)
          .toVar();
        const componentGate = paintComponent.lessThan(0.5)
          .or(segmentComponent.x.lessThan(0.5).and(segmentComponent.y.lessThan(0.5)))
          .or(abs(paintComponent.sub(segmentComponent.x)).lessThan(0.5))
          .or(abs(paintComponent.sub(segmentComponent.y)).lessThan(0.5))
          .select(float(1), float(0))
          .toVar();
        const sampleCoverage = baseSampleCoverage
          .mul(componentGate)
          .mul(normalGate)
          .toVar();
        coverage.assign(max(coverage, sampleCoverage));
      });
    });
    const alpha = clamp(opacity.mul(strength).mul(coverage), 0.0, 1.0);
    const baseColor = sourceTextureNode.toVar();
    const gutterOnly = projectedPaintGutterOnly.greaterThan(0.5).toVar();
    const insideOriginalTriangle = min(
      min(paintBarycentric.x, paintBarycentric.y),
      paintBarycentric.z
    ).greaterThanEqual(0.0);
    const noCoverage = alpha.lessThanEqual(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD).toVar();
    const discardFragment = gutterOnly
      .select(insideOriginalTriangle.or(noCoverage), noCoverage)
      .toVar();
    discardFragment.discard();
    const gutterColor = vec4(mix(baseColor.rgb, brushColor.rgb, alpha), 1).toVar();
    const primaryColor = vec4(mix(baseColor.rgb, brushColor.rgb, alpha), 1).toVar();
    const oneMinusAlpha = float(1).sub(alpha).toVar();
    const compositedLayerAlpha = clamp(alpha.add(baseColor.a.mul(oneMinusAlpha)), 0.0, 1.0).toVar();
    const compositedLayerPremul = brushColor.rgb.mul(alpha)
      .add(baseColor.rgb.mul(baseColor.a).mul(oneMinusAlpha))
      .toVar();
    const compositedLayerRgb = compositedLayerAlpha.greaterThan(0.0001)
      .select(compositedLayerPremul.div(max(compositedLayerAlpha, 0.0001)), brushColor.rgb)
      .toVar();
    const emptyLayer = emptyLayerSource.greaterThan(0.5).toVar();
    const layerOutAlpha = emptyLayer.select(alpha, compositedLayerAlpha).toVar();
    const layerOutRgb = emptyLayer.select(brushColor.rgb, compositedLayerRgb).toVar();
    const storedLayerRgb = layerOutAlpha.greaterThan(0.0001).select(layerOutRgb.mul(layerOutAlpha), vec3(0)).toVar();
    const layerColor = vec4(storedLayerRgb.x, storedLayerRgb.y, storedLayerRgb.z, layerOutAlpha).toVar();
    if (layerOnly) {
      return layerColor;
    }
    return gutterOnly.select(gutterColor, primaryColor);
  })();
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  material.vertexNode = vertexNode;
  material.fragmentNode = fragmentNode;
  material.name = layerOnly
    ? "texture-paint-tsl-surface-airbrush-projected-layer-triangles"
    : "texture-paint-tsl-surface-airbrush-projected-triangles";
  material.userData.texturePaintTslSurfaceAirbrush = {
    sourceTextureNode,
    visibleTextureNode,
    visibleSurfaceEnabled,
    editorViewMatrix: null,
    editorProjectionMatrix,
    editorViewportSize,
    brushColor,
    opacity,
    hardness,
    scatter,
    strength,
    hardVisibleEdge,
    visibleNormalEdge,
    blendOnly,
    emptyLayerSource,
    projectedPaintGutterOnly,
    segmentCount,
    segmentStarts,
    segmentEnds,
    segmentViewStarts,
    segmentViewEnds,
    segmentNormalStarts,
    segmentNormalEnds,
    segmentComponents,
    layerOnly
  };
  return material;
}

function createSurfaceMaterial(
  sourceTexture = null,
  sourceObject = null,
  visibleTexture = null,
  uvOccupancyTexture = null,
  options = {}
) {
  const tsl = THREE.TSL || null;
  if (!tsl || typeof THREE.MeshBasicNodeMaterial !== "function") {
    return null;
  }
  const originalMeshUvRaster = options.originalMeshUvRaster === true;
  const maskOnly = options.maskOnly === true;
  const layerOnly = options.layerOnly === true && !maskOnly;
  const {
    Fn,
    If,
    Loop,
    abs,
    attribute,
    clamp,
    dot,
    float,
    int,
    length,
    max,
    min,
    mix,
    modelViewMatrix,
    modelWorldMatrix,
    normalView,
    normalViewGeometry,
    normalWorldGeometry,
    positionLocal,
    positionView,
    pow,
    texture,
    uniform,
    uniformArray,
    uv,
    varyingProperty,
    vec2,
    vec3,
    vec4
  } = tsl;
  const paintUv = varyingProperty("vec2", "vTexturePaintSourceUv");
  const paintView = varyingProperty("vec3", "vTexturePaintSourceView");
  const paintScreen = varyingProperty("vec3", "vTexturePaintSourceScreen");
  const paintNormal = varyingProperty("vec3", "vTexturePaintSourceNormal");
  const paintBarycentric = varyingProperty("vec3", "vTexturePaintSourceBarycentric");
  const paintComponent = varyingProperty("float", "vTexturePaintSourceComponent");
  const sourceTextureNode = texture(sourceTexture, paintUv);
  const visibleTextureNode = texture(visibleTexture || sourceTexture);
  const uvOccupancyTextureNode = texture(uvOccupancyTexture || surfaceAirbrushWhiteMaskTexture(), uv());
  const overlapMaskTexture = sourceObjectUvOverlapMaskTexture(sourceObject);
  const overlapMaskTextureNode = texture(overlapMaskTexture, paintUv);
  const editorViewMatrix = uniform(new THREE.Matrix4(), "mat4");
  const editorProjectionMatrix = uniform(new THREE.Matrix4(), "mat4");
  const editorViewportSize = uniform(new THREE.Vector2(1, 1), "vec2");
  const brushColor = uniform(new THREE.Vector4(0, 1, 0.4, 1), "vec4");
  const opacity = uniform(0.42, "float");
  const hardness = uniform(0.35, "float");
  const scatter = uniform(0.35, "float");
  const strength = uniform(1, "float");
  const hardVisibleEdge = uniform(0, "float");
  const visibleNormalEdge = uniform(1, "float");
  const blendOnly = uniform(0, "float");
  const emptyLayerSource = uniform(0, "float");
  const visibleSurfaceEnabled = uniform(0, "float");
  const sourceSampleFlipY = uniform(0, "float");
  const segmentCount = uniform(0, "int");
  const segmentStarts = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentEnds = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentViewStarts = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentViewEnds = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentNormalStarts = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentNormalEnds = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const segmentComponents = uniformArray(
    Array.from({ length: MAX_TSL_SURFACE_SEGMENTS }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  );
  const vertexNode = Fn(() => {
    if (originalMeshUvRaster) {
      const atlasUv = uv().toVar();
      const sampleUv = vec2(
        atlasUv.x,
        mix(atlasUv.y, float(1).sub(atlasUv.y), sourceSampleFlipY)
      ).toVar();
      const worldPosition = modelWorldMatrix.mul(vec4(positionLocal, 1)).toVar();
      const editorView = editorViewMatrix.mul(worldPosition).xyz.toVar();
      const clipPosition = editorProjectionMatrix.mul(vec4(editorView, 1)).toVar();
      const invClipW = float(1).div(max(abs(clipPosition.w), 0.0001)).toVar();
      const ndc = clipPosition.xyz.mul(invClipW).toVar();
      paintUv.assign(sampleUv);
      paintView.assign(editorView);
      paintScreen.assign(vec3(
        ndc.x.add(1).mul(0.5).mul(editorViewportSize.x),
        float(1).sub(ndc.y.add(1).mul(0.5)).mul(editorViewportSize.y),
        ndc.z
      ));
      paintNormal.assign(normalWorldGeometry.transformDirection(editorViewMatrix));
      paintBarycentric.assign(vec3(1, 0, 0));
      paintComponent.assign(float(0));
      return vec4(
        atlasUv.x.mul(2).sub(1),
        float(1).sub(atlasUv.y.mul(2)),
        0,
        1
      );
    }
    paintUv.assign(attribute("sourceUv", "vec2"));
    paintView.assign(attribute("paintView", "vec3"));
    paintScreen.assign(attribute("paintScreen", "vec3"));
    paintNormal.assign(attribute("paintNormal", "vec3"));
    paintBarycentric.assign(attribute("paintBarycentric", "vec3"));
    paintComponent.assign(attribute("paintComponent", "float"));
    return vec4(positionLocal.x, positionLocal.y, 0, 1);
  })();
  const fragmentNode = Fn(() => {
    const coverage = float(0).toVar();
    const editorView = paintView.toVar();
    const surfaceScreen = paintScreen.toVar();
    const visibleUvRaw = clamp(surfaceScreen.xy.div(editorViewportSize), vec2(0), vec2(1)).toVar();
    const visibleUv = vec2(visibleUvRaw.x, float(1).sub(visibleUvRaw.y)).toVar();
    const visibleSample = visibleTextureNode.sample(visibleUv).toVar();
    void overlapMaskTextureNode;
    let gutterCanWrite = null;
    if (!originalMeshUvRaster) {
      const occupancySample = uvOccupancyTextureNode.toVar();
      const overlapSample = overlapMaskTextureNode.toVar();
      const insideOriginalTriangle = min(
        min(paintBarycentric.x, paintBarycentric.y),
        paintBarycentric.z
      ).greaterThanEqual(0.0);
      const overlapCanWrite = overlapSample.r.greaterThan(0.5).toVar();
      gutterCanWrite = insideOriginalTriangle
        .or(occupancySample.r.lessThan(0.5))
        .and(overlapCanWrite)
        .toVar();
    }
    const visibleActive = clamp(visibleSurfaceEnabled, 0.0, 1.0).toVar();
    const visibleSampleValid = clamp(visibleSample.a.mul(32.0), 0.0, 1.0).toVar();
    const editorNormalVector = paintNormal.toVar();
    const editorNormalLength = max(length(editorNormalVector), 0.0001).toVar();
    const editorNormal = editorNormalVector.div(editorNormalLength).toVar();
    const currentFacingNormalZ = editorNormalLength.greaterThan(0.0002)
      .select(editorNormal.z, float(1))
      .toVar();
    const visibleDepth = visibleSample.r.toVar();
    const fragmentDepth = editorView.z.mul(-1).toVar();
    const visibleDelta = abs(fragmentDepth.sub(visibleDepth)).toVar();
    const visibleFacingSampleZ = visibleSample.g.mul(2.0).sub(1.0).toVar();
    const visibleNormalRescue = visibleActive
      .mul(visibleSampleValid)
      .mul(visibleDelta.lessThanEqual(VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS).select(float(1), float(0)))
      .toVar();
    const facingNormalZ = mix(
      currentFacingNormalZ,
      visibleFacingSampleZ,
      visibleNormalRescue
    ).toVar();
    const softFacingRamp = clamp(
      facingNormalZ.add(SOFT_FACING_NORMAL_BACK_FEATHER)
        .div(SOFT_FACING_NORMAL_BACK_FEATHER + SOFT_FACING_NORMAL_FRONT_FEATHER),
      0.0,
      1.0
    ).toVar();
    const softFacingCoverage = softFacingRamp
      .mul(softFacingRamp)
      .mul(float(3).sub(softFacingRamp.mul(2)))
      .toVar();
    const hardFacingCoverage = facingNormalZ.greaterThanEqual(0.0).select(float(1), float(0)).toVar();
    const facingCoverage = mix(softFacingCoverage, hardFacingCoverage, hardVisibleEdge).toVar();
    const normalGate = mix(float(1), facingCoverage, visibleNormalEdge).toVar();
    Loop(MAX_TSL_SURFACE_SEGMENTS, ({ i }) => {
      If(i.lessThan(segmentCount), () => {
        const start = segmentStarts.element(i);
        const end = segmentEnds.element(i);
        const segmentComponent = segmentComponents.element(i);
        const radius = max(start.w, 0.0001);
        const haloRadius = radius.mul(float(1).add(scatter.mul(0.15))).toVar();
        const segmentVector = end.xy.sub(start.xy).toVar();
        const lengthSq = max(dot(segmentVector, segmentVector), 0.000001);
        const segmentT = clamp(dot(surfaceScreen.xy.sub(start.xy), segmentVector).div(lengthSq), 0.0, 1.0).toVar();
        const closest = start.xy.add(segmentVector.mul(segmentT));
        const distance = length(surfaceScreen.xy.sub(closest));
        const coreRadius = radius.mul(float(TEXTURE_AIRBRUSH_CORE_MIN_SCALE).add(
          pow(hardness, TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER).mul(TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE)
        ));
        const fadeRadius = max(haloRadius.sub(coreRadius), 0.0001);
        const normalized = clamp(distance.sub(coreRadius).div(fadeRadius), 0.0, 1.0).toVar();
        const exponent = max(
          1.0,
          float(TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE)
            .add(pow(hardness, TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER).mul(TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE))
            .sub(scatter.mul(TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE))
        );
        const shapedEdge = clamp(pow(normalized, exponent), 0.0, 1.0).toVar();
        const smoothEdge = shapedEdge.mul(shapedEdge).mul(float(3).sub(shapedEdge.mul(2))).toVar();
        const edgeCoverage = max(0.0, float(1).sub(smoothEdge)).toVar();
        const screenCoverage = edgeCoverage.toVar();
        const viewStart = segmentViewStarts.element(i);
        const viewEnd = segmentViewEnds.element(i);
        const viewRadius = max(viewStart.w, 0.0001);
        const hasViewField = viewStart.w.greaterThan(0.0001).and(viewEnd.w.greaterThan(0.0001));
        const viewHaloRadius = viewRadius.mul(float(1).add(scatter.mul(0.15))).toVar();
        const viewVector = viewEnd.xyz.sub(viewStart.xyz).toVar();
        const viewLengthSq = max(dot(viewVector, viewVector), 0.000001);
        const viewT = clamp(dot(editorView.sub(viewStart.xyz), viewVector).div(viewLengthSq), 0.0, 1.0).toVar();
        const viewClosest = viewStart.xyz.add(viewVector.mul(viewT));
        const viewDepthDelta = abs(editorView.z.sub(viewClosest.z)).toVar();
        const viewDepthRadius = max(
          SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_MIN,
          viewRadius.mul(SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_SCALE)
        ).toVar();
        const viewDepthFeather = max(
          SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_MIN,
          viewRadius.mul(SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_SCALE)
        ).toVar();
        const viewDepthFade = clamp(
          viewDepthDelta.sub(viewDepthRadius).div(max(viewDepthFeather, 0.0001)),
          0.0,
          1.0
        ).toVar();
        const viewDepthSmoothFade = viewDepthFade
          .mul(viewDepthFade)
          .mul(float(3).sub(viewDepthFade.mul(2)))
          .toVar();
        const viewDepthCoverage = float(1).sub(viewDepthSmoothFade).toVar();
        const viewCoverage = viewDepthCoverage.toVar();
        const brushFieldCoverage = hasViewField
          .select(screenCoverage.mul(viewCoverage), screenCoverage)
          .toVar();
        const surfaceFieldCoverage = brushFieldCoverage.toVar();
        const componentGate = paintComponent.lessThan(0.5)
          .or(segmentComponent.x.lessThan(0.5).and(segmentComponent.y.lessThan(0.5)))
          .or(abs(paintComponent.sub(segmentComponent.x)).lessThan(0.5))
          .or(abs(paintComponent.sub(segmentComponent.y)).lessThan(0.5))
          .select(float(1), float(0))
          .toVar();
        const gatedCoverage = surfaceFieldCoverage
          .mul(componentGate)
          .mul(normalGate)
          .toVar();
        const sourceCoverage = originalMeshUvRaster
          ? gatedCoverage
          : gatedCoverage.mul(gutterCanWrite.select(float(1), float(0))).toVar();
        const sampleCoverage = sourceCoverage.toVar();
        coverage.assign(max(coverage, sampleCoverage));
      });
    });
    const alpha = clamp(opacity.mul(strength).mul(coverage), 0.0, 1.0);
    const noCoverage = alpha.lessThanEqual(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD).toVar();
    noCoverage.discard();
    if (maskOnly) {
      return vec4(alpha, alpha, alpha, alpha);
    }
    const baseColor = sourceTextureNode.toVar();
    const oneMinusAlpha = float(1).sub(alpha).toVar();
    const compositedLayerAlpha = clamp(alpha.add(baseColor.a.mul(oneMinusAlpha)), 0.0, 1.0).toVar();
    const compositedLayerPremul = brushColor.rgb.mul(alpha)
      .add(baseColor.rgb.mul(baseColor.a).mul(oneMinusAlpha))
      .toVar();
    const compositedLayerRgb = compositedLayerAlpha.greaterThan(0.0001)
      .select(compositedLayerPremul.div(max(compositedLayerAlpha, 0.0001)), brushColor.rgb)
      .toVar();
    const emptyLayer = emptyLayerSource.greaterThan(0.5).toVar();
    const layerOutAlpha = emptyLayer.select(alpha, compositedLayerAlpha).toVar();
    const layerOutRgb = emptyLayer.select(brushColor.rgb, compositedLayerRgb).toVar();
    const storedLayerRgb = layerOutAlpha.greaterThan(0.0001).select(layerOutRgb.mul(layerOutAlpha), vec3(0)).toVar();
    const brushOnlyColor = vec4(storedLayerRgb.x, storedLayerRgb.y, storedLayerRgb.z, layerOutAlpha).toVar();
    if (layerOnly) {
      return brushOnlyColor;
    }
    return vec4(mix(baseColor.rgb, brushColor.rgb, alpha), 1);
  })();
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: maskOnly === true || layerOnly,
    blending: maskOnly ? THREE.CustomBlending : THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  if (maskOnly) {
    material.blendEquation = THREE.MaxEquation;
    material.blendEquationAlpha = THREE.MaxEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneFactor;
  }
  material.vertexNode = vertexNode;
  material.fragmentNode = fragmentNode;
  material.name = "texture-paint-tsl-surface-airbrush-material";
  material.userData.texturePaintTslSurfaceAirbrush = {
    sourceTextureNode,
    visibleTextureNode,
    uvOccupancyTextureNode,
    uvOccupancyTexture: uvOccupancyTexture || null,
    visibleSurfaceEnabled,
    editorViewMatrix,
    editorProjectionMatrix,
    editorViewportSize,
    brushColor,
    opacity,
    hardness,
    scatter,
    strength,
    hardVisibleEdge,
    visibleNormalEdge,
    blendOnly,
    emptyLayerSource,
    sourceSampleFlipY,
    segmentCount,
    segmentStarts,
    segmentEnds,
    segmentViewStarts,
    segmentViewEnds,
    segmentNormalStarts,
    segmentNormalEnds,
    segmentComponents,
    maskOnly,
    layerOnly,
    overlapMaskTextureNode,
    overlapMaskTexture
  };
  return material;
}

function createNoopSurfaceMaterial() {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
    toneMapped: false
  });
  material.name = "texture-paint-tsl-surface-airbrush-noop-material";
  return material;
}

function surfaceRasterMaterialsForSourceObject(
  cache = null,
  sourceObject = null,
  editable = null,
  textures = new Set(),
  paintMaterial = null,
  fallbackMaterialIndex = null,
  options = {}
) {
  if (!paintMaterial) {
    return null;
  }
  const geometry = sourceObject?.geometry || null;
  const materialCount = Math.max(
    1,
    materialArray(sourceObject?.material).length,
    maxGeometryGroupMaterialIndex(geometry) + 1
  );
  const paintIndices = sourceObjectMaterialPaintIndices(sourceObject, editable, textures, fallbackMaterialIndex, options);
  if (materialCount <= 1) {
    return paintIndices.has(0) ? paintMaterial : (cache.noopMaterial ||= createNoopSurfaceMaterial());
  }
  const noopMaterial = cache.noopMaterial ||= createNoopSurfaceMaterial();
  return Array.from({ length: materialCount }, (_entry, index) => (
    paintIndices.has(index) ? paintMaterial : noopMaterial
  ));
}

function ensureProjectedSurfaceMesh(
  cache = null,
  triangles = [],
  material = null,
  width = 1,
  height = 1,
  referenceTexture = null,
  gutterPixels = UV_GUTTER_PIXELS
) {
  if (!cache || !material || !triangles.length) {
    return null;
  }
  const previousGeometry = cache.projectedMesh?.geometry || null;
  const referenceFlipY = referenceTexture?.flipY === true;
  const canReuseGeometry = Boolean(
    previousGeometry
    && cache.projectedGeometryTriangles === triangles
    && cache.projectedGeometryWidth === width
    && cache.projectedGeometryHeight === height
    && cache.projectedGeometryGutterPixels === gutterPixels
    && cache.projectedGeometryReferenceFlipY === referenceFlipY
  );
  const geometry = canReuseGeometry
    ? previousGeometry
    : updateSurfaceGeometry(previousGeometry, triangles, width, height, referenceTexture, gutterPixels);
  if (!geometry) {
    return null;
  }
  if (!cache.projectedMesh) {
    cache.projectedMesh = new THREE.Mesh(geometry, material);
    cache.projectedMesh.name = "texture-paint-tsl-surface-airbrush-projected-raster";
    cache.projectedMesh.frustumCulled = false;
    cache.projectedMesh.matrixAutoUpdate = false;
    cache.projectedMesh.matrix.identity();
    cache.projectedMesh.matrixWorld.identity();
    cache.scene.add(cache.projectedMesh);
  } else if (cache.projectedMesh.geometry !== geometry) {
    cache.projectedMesh.geometry?.dispose?.();
    cache.projectedMesh.geometry = geometry;
  }
  cache.projectedMesh.material = material;
  cache.projectedMesh.visible = true;
  cache.projectedGeometryTriangles = triangles;
  cache.projectedGeometryWidth = width;
  cache.projectedGeometryHeight = height;
  cache.projectedGeometryGutterPixels = gutterPixels;
  cache.projectedGeometryReferenceFlipY = referenceFlipY;
  return cache.projectedMesh;
}

function updateSurfaceMaterial(
  material = null,
  sourceTexture = null,
  segments = [],
  options = {},
  editor = null,
  visibleTexture = null,
  uvOccupancyTexture = null
) {
  const state = material?.userData?.texturePaintTslSurfaceAirbrush || null;
  if (!state) {
    return false;
  }
  const wantsBlendOnly = options.blendOnly === true;
  const shaderSourceTexture = sourceTexture || (wantsBlendOnly
    ? surfaceAirbrushTransparentTexture()
    : surfaceAirbrushWhiteMaskTexture());
  const shaderVisibleTexture = visibleTexture || shaderSourceTexture;
  const previousSourceTexture = state.sourceTextureNode.value;
  const previousVisibleTexture = state.visibleTextureNode?.value || null;
  const previousUvOccupancyTexture = state.uvOccupancyTextureNode?.value || null;
  state.sourceTextureNode.value = shaderSourceTexture;
  if (state.sourceSampleFlipY) {
    state.sourceSampleFlipY.value = textureNodeAppliesFlipY(shaderSourceTexture) ? 1 : 0;
  }
  if (state.visibleTextureNode) {
    state.visibleTextureNode.value = shaderVisibleTexture;
  }
  if (state.uvOccupancyTextureNode) {
    state.uvOccupancyTextureNode.value = uvOccupancyTexture || surfaceAirbrushWhiteMaskTexture();
    state.uvOccupancyTexture = uvOccupancyTexture || null;
  }
  if (
    material
    && (
      previousSourceTexture === undefined
      || previousVisibleTexture === undefined
      || previousUvOccupancyTexture === undefined
    )
  ) {
    material.needsUpdate = true;
  }
  if (state.visibleSurfaceEnabled) {
    state.visibleSurfaceEnabled.value = options.debugVisibleSurfaceDepth === true && visibleTexture ? 1 : 0;
  }
  const camera = editor?.camera || null;
  camera?.updateMatrixWorld?.(true);
  if (camera?.matrixWorldInverse && state.editorViewMatrix?.value?.copy) {
    state.editorViewMatrix.value.copy(camera.matrixWorldInverse);
  }
  if (camera?.projectionMatrix && state.editorProjectionMatrix?.value?.copy) {
    state.editorProjectionMatrix.value.copy(camera.projectionMatrix);
  }
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  state.editorViewportSize.value.set(
    Math.max(1, finiteNumber(rect?.width, editor?.canvas?.width || 1)),
    Math.max(1, finiteNumber(rect?.height, editor?.canvas?.height || 1))
  );
  const color = options.color || { r: 0, g: 255, b: 102 };
  state.brushColor.value.set(
    clamp01(finiteNumber(color.r, 0) / 255),
    clamp01(finiteNumber(color.g, 255) / 255),
    clamp01(finiteNumber(color.b, 102) / 255),
    1
  );
  state.opacity.value = clamp01(finiteNumber(options.opacity, 0.42));
  state.hardness.value = clamp01(finiteNumber(options.hardness, 0.35));
  state.scatter.value = clamp01(finiteNumber(options.scatter, 0.35));
  state.strength.value = Math.max(0, finiteNumber(options.strength, 1));
  const visibleEdgeMode = String(options.visibleEdgeMode || "soft").toLowerCase();
  if (state.hardVisibleEdge) {
    state.hardVisibleEdge.value = visibleEdgeMode === "hard" ? 1 : 0;
  }
  if (state.visibleNormalEdge) {
    const debugParams = typeof window !== "undefined"
      ? new URLSearchParams(window.location?.search || "")
      : null;
    state.visibleNormalEdge.value = debugParams?.has("debugAirbrushNoNormalGate") === true
      ? 0
      : visibleEdgeMode === "hard" || visibleEdgeMode === "soft" ? 1 : 0;
  }
  if (state.blendOnly) {
    state.blendOnly.value = wantsBlendOnly ? 1 : 0;
    if (state.maskOnly === true && material && material.blending !== THREE.CustomBlending) {
      material.transparent = true;
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.MaxEquation;
      material.blendEquationAlpha = THREE.MaxEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneFactor;
      material.blendSrcAlpha = THREE.OneFactor;
      material.blendDstAlpha = THREE.OneFactor;
      material.needsUpdate = true;
    } else if (!state.maskOnly && material && material.userData.texturePaintTslSurfaceBlendOnly !== wantsBlendOnly) {
      material.userData.texturePaintTslSurfaceBlendOnly = wantsBlendOnly;
      material.transparent = true;
      material.blending = THREE.NoBlending;
      material.needsUpdate = true;
    }
  }
  if (state.emptyLayerSource) {
    state.emptyLayerSource.value = options.emptyLayerSource === true ? 1 : 0;
  }
  if (state.projectedPaintGutterOnly) {
    state.projectedPaintGutterOnly.value = options.projectedPaintGutterOnly === false ? 0 : 1;
  }
  state.segmentCount.value = Math.max(0, Math.min(MAX_TSL_SURFACE_SEGMENTS, segments.length));
  for (let index = 0; index < MAX_TSL_SURFACE_SEGMENTS; index += 1) {
    const segment = segments[index] || null;
    const start = state.segmentStarts.array[index];
    const end = state.segmentEnds.array[index];
    if (segment) {
      start.set(segment.start.x, segment.start.y, finiteNumber(segment.start.z, 0), segment.radius);
      end.set(segment.end.x, segment.end.y, finiteNumber(segment.end.z, 0), segment.radius);
    } else {
      start.set(0, 0, 0, 0);
      end.set(0, 0, 0, 0);
    }
    const viewStart = state.segmentViewStarts?.array?.[index] || null;
    const viewEnd = state.segmentViewEnds?.array?.[index] || null;
    const normalStart = state.segmentNormalStarts?.array?.[index] || null;
    const normalEnd = state.segmentNormalEnds?.array?.[index] || null;
    const component = state.segmentComponents?.array?.[index] || null;
    if (viewStart && viewEnd) {
      if (segment?.viewStart && segment?.viewEnd) {
        const viewRadius = Math.max(0.0001, finiteNumber(segment.viewRadius ?? segment.worldRadius, 0.0001));
        viewStart.set(segment.viewStart.x, segment.viewStart.y, segment.viewStart.z, viewRadius);
        viewEnd.set(segment.viewEnd.x, segment.viewEnd.y, segment.viewEnd.z, viewRadius);
      } else {
        viewStart.set(0, 0, 0, 0);
        viewEnd.set(0, 0, 0, 0);
      }
    }
    if (normalStart && normalEnd) {
      const startNormal = finiteView(segment?.viewNormalStart);
      const endNormal = finiteView(segment?.viewNormalEnd);
      if (startNormal || endNormal) {
        const resolvedStart = startNormal || endNormal;
        const resolvedEnd = endNormal || startNormal;
        normalStart.set(resolvedStart.x, resolvedStart.y, resolvedStart.z, 1);
        normalEnd.set(resolvedEnd.x, resolvedEnd.y, resolvedEnd.z, 1);
      } else {
        normalStart.set(0, 0, 0, 0);
        normalEnd.set(0, 0, 0, 0);
      }
    }
    if (component) {
      const componentStart = finiteComponentId(segment?.componentStart);
      const componentEnd = finiteComponentId(segment?.componentEnd);
      component.set(
        componentStart >= 0 ? componentStart + 1 : 0,
        componentEnd >= 0 ? componentEnd + 1 : 0,
        0,
        0
      );
    }
  }
  return true;
}

function candidateProjectedTriangles(candidate = null, options = {}) {
  const direct = [
    options.projectedRenderTriangles,
    candidate?.options?.projectedRenderTriangles,
    options.visibilityMaskTriangles,
    candidate?.options?.visibilityMaskTriangles
  ].find((triangles) => Array.isArray(triangles) && triangles.length) || [];
  return direct.filter((triangle) => (
    projectedTrianglePixels(triangle)
    && projectedTriangleView(triangle)
    && projectedTriangleScreen(triangle)
  ));
}

function surfaceSegmentArray(value = null) {
  return Array.isArray(value) && value.length ? value : null;
}

function surfaceSegmentsIncludeScreenData(segments = [], allowStartEnd = false) {
  return Array.isArray(segments) && segments.some((segment) => (
    finitePoint(segment?.screenStart)
    || finitePoint(segment?.screenEnd)
    || (allowStartEnd && (finitePoint(segment?.start) || finitePoint(segment?.end)))
  ));
}

function surfaceSegmentsIncludeViewData(segments = []) {
  return Array.isArray(segments) && segments.some((segment) => (
    finiteView(segment?.viewStart)
    && finiteView(segment?.viewEnd)
    && finiteNumber(segment?.viewRadiusPixels ?? segment?.viewRadius, 0) > 0
  ));
}

function interpolateSurfacePoint(left = null, right = null, t = 0) {
  if (!left || !right) {
    return null;
  }
  return {
    x: left.x + (right.x - left.x) * t,
    y: left.y + (right.y - left.y) * t,
    ...(Number.isFinite(left.z) || Number.isFinite(right.z)
      ? { z: finiteNumber(left.z, 0) + (finiteNumber(right.z, 0) - finiteNumber(left.z, 0)) * t }
      : {})
  };
}

function normalizeSurfaceNormal(point = null) {
  const length = Math.hypot(
    finiteNumber(point?.x, 0),
    finiteNumber(point?.y, 0),
    finiteNumber(point?.z, 0)
  );
  return length > 0.000001
    ? { x: point.x / length, y: point.y / length, z: point.z / length }
    : null;
}

function surfaceNormalDot(left = null, right = null) {
  const a = normalizeSurfaceNormal(left);
  const b = normalizeSurfaceNormal(right);
  return a && b ? a.x * b.x + a.y * b.y + a.z * b.z : null;
}

function resampleSurfaceSegments(segments = []) {
  const output = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (output.length >= MAX_TSL_SURFACE_STROKE_SEGMENTS) {
      break;
    }
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    if (!start || !end) {
      continue;
    }
    const distance = pointDistance(start, end);
    const radius = Math.max(0.0001, finiteNumber(segment?.radius, 1));
    const step = Math.max(12, Math.min(48, radius * 0.9));
    const pieceCount = Math.max(1, Math.min(
      MAX_TSL_SURFACE_STROKE_SEGMENTS - output.length,
      Math.ceil(distance / step)
    ));
    for (let piece = 0; piece < pieceCount; piece += 1) {
      const t0 = piece / pieceCount;
      const t1 = (piece + 1) / pieceCount;
      const viewStart = interpolateSurfacePoint(segment.viewStart, segment.viewEnd, t0);
      const viewEnd = interpolateSurfacePoint(segment.viewStart, segment.viewEnd, t1);
      const normalStart = normalizeSurfaceNormal(interpolateSurfacePoint(
        segment.viewNormalStart,
        segment.viewNormalEnd,
        t0
      ));
      const normalEnd = normalizeSurfaceNormal(interpolateSurfacePoint(
        segment.viewNormalStart,
        segment.viewNormalEnd,
        t1
      ));
      output.push({
        ...segment,
        start: interpolateSurfacePoint(start, end, t0),
        end: interpolateSurfacePoint(start, end, t1),
        ...(viewStart && viewEnd ? { viewStart, viewEnd } : {}),
        ...(normalStart ? { viewNormalStart: normalStart } : {}),
        ...(normalEnd ? { viewNormalEnd: normalEnd } : {})
      });
    }
  }
  return output.length ? output : segments;
}

function chunkSurfaceSegmentsForShader(segments = [], maxSegments = MAX_TSL_SURFACE_SEGMENTS) {
  const source = Array.isArray(segments) ? segments.filter(Boolean) : [];
  const limit = Math.max(1, Math.min(MAX_TSL_SURFACE_SEGMENTS, Math.floor(Number(maxSegments) || 1)));
  if (source.length <= limit) {
    return [source];
  }
  const chunks = [];
  for (let index = 0; index < source.length; index += limit) {
    chunks.push(source.slice(index, index + limit));
  }
  return chunks.length ? chunks : [[]];
}

function candidateSurfaceSegments(editor = null, candidate = null, options = {}) {
  let best = [];
  for (const { segments, allowStartEnd, requireViewData } of [
    { segments: surfaceSegmentArray(options.screenProjectedStrokeSegments), allowStartEnd: true, requireViewData: false },
    { segments: surfaceSegmentArray(candidate?.options?.screenProjectedStrokeSegments), allowStartEnd: true, requireViewData: false },
    { segments: surfaceSegmentArray(options.strokeSegments), allowStartEnd: false, requireViewData: true },
    { segments: surfaceSegmentArray(candidate?.options?.strokeSegments), allowStartEnd: false, requireViewData: true },
    { segments: surfaceSegmentArray(candidate?.strokeSegments), allowStartEnd: false, requireViewData: true }
  ]) {
    if (!surfaceSegmentsIncludeScreenData(segments, allowStartEnd)) {
      continue;
    }
    if (requireViewData && !surfaceSegmentsIncludeViewData(segments)) {
      continue;
    }
    const normalized = normalizeSurfaceSegments(
      editor,
      segments,
      finiteNumber(options.radiusPixels, candidate?.radiusPixels || 1)
    );
    if (normalized.length > best.length) {
      best = normalized;
    }
  }
  return resampleSurfaceSegments(best);
}

function prewarmSurfaceBrushSegments(editor = null, candidate = null, options = {}) {
  const existing = candidateSurfaceSegments(editor, candidate, options);
  if (existing.length) {
    return existing.slice(0, MAX_TSL_SURFACE_SEGMENTS);
  }
  const radius = Math.max(
    1,
    finiteNumber(
      options.radiusPixels,
      finiteNumber(candidate?.radiusPixels, editor?.textureBrushRadiusScreenPixels?.() || 40)
    )
  );
  const rect = editor?.canvas?.getBoundingClientRect?.() || null;
  const x = Math.max(1, finiteNumber(rect?.width, editor?.canvas?.clientWidth || 512)) * 0.5;
  const y = Math.max(1, finiteNumber(rect?.height, editor?.canvas?.clientHeight || 512)) * 0.45;
  const viewRadius = Math.max(0.001, radius * 0.0125);
  const screenHalf = Math.max(1, radius * 0.2);
  return [{
    start: { x: x - screenHalf, y, z: 0 },
    end: { x: x + screenHalf, y, z: 0 },
    radius,
    viewStart: { x: -viewRadius, y: 0, z: -1 },
    viewEnd: { x: viewRadius, y: 0, z: -1 },
    viewRadius,
    viewNormalStart: { x: 0, y: 0, z: 1 },
    viewNormalEnd: { x: 0, y: 0, z: 1 },
    componentStart: finiteComponentId(candidate?.hit?.face?.materialIndex),
    componentEnd: finiteComponentId(candidate?.hit?.face?.materialIndex)
  }];
}

function surfaceStrokeResetRequested(candidate = null, options = {}) {
  return Boolean(
    candidate?.strokeReset === true
    || candidate?.strokeStartedWithReset === true
    || candidate?.options?.strokeReset === true
    || candidate?.options?.strokeStartedWithReset === true
    || options.strokeReset === true
    || options.strokeStartedWithReset === true
  );
}

function surfaceStrokeOwnerChanged(cache = null, owner = null) {
  return owner
    ? cache?.strokeSourceOwner !== owner
    : cache?.strokeSourceOwner != null;
}

function surfaceStrokeSegmentsAreContinuous(previousSegment = null, firstSegment = null) {
  const previousEnd = finitePoint(previousSegment?.end);
  const firstStart = finitePoint(firstSegment?.start);
  if (!previousSegment || !firstSegment || !previousEnd || !firstStart) {
    return false;
  }
  const radius = Math.max(
    finiteNumber(previousSegment.radius, finiteNumber(previousSegment.radiusPixels, 0)),
    finiteNumber(previousSegment.radiusPixels, 0),
    finiteNumber(firstSegment.radius, finiteNumber(firstSegment.radiusPixels, 0)),
    finiteNumber(firstSegment.radiusPixels, 0),
    1
  );
  const screenGap = Math.hypot(firstStart.x - previousEnd.x, firstStart.y - previousEnd.y);
  if (screenGap <= 0.001 || screenGap > radius * 2.25) {
    return false;
  }
  const previousViewEnd = finiteView(previousSegment?.viewEnd);
  const firstViewStart = finiteView(firstSegment?.viewStart);
  const viewRadius = Math.max(
    finiteNumber(previousSegment?.viewRadius, finiteNumber(previousSegment?.worldRadius, 0)),
    finiteNumber(previousSegment?.worldRadius, 0),
    finiteNumber(firstSegment?.viewRadius, finiteNumber(firstSegment?.worldRadius, 0)),
    finiteNumber(firstSegment?.worldRadius, 0),
    0
  );
  const viewGap = previousViewEnd && firstViewStart
    ? Math.hypot(
        firstViewStart.x - previousViewEnd.x,
        firstViewStart.y - previousViewEnd.y,
        firstViewStart.z - previousViewEnd.z
      )
    : 0;
  if (!previousViewEnd || !firstViewStart) {
    return false;
  }
  const maxViewGap = Math.max(viewRadius * 2.25, 0.001);
  if (viewGap > maxViewGap) {
    return false;
  }
  const normalDot = surfaceNormalDot(
    previousSegment?.viewNormalEnd || previousSegment?.viewNormalStart,
    firstSegment?.viewNormalStart || firstSegment?.viewNormalEnd
  );
  return normalDot === null || normalDot >= -0.05;
}

function surfaceStrokePointDistance(left = null, right = null) {
  const a = finitePoint(left);
  const b = finitePoint(right);
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;
}

function surfaceStrokeSegmentAlreadyCovered(existing = [], segment = null) {
  if (!Array.isArray(existing) || !existing.length || !segment) {
    return false;
  }
  const radius = Math.max(1, finiteNumber(segment.radius, finiteNumber(segment.radiusPixels, 1)));
  const tolerance = Math.max(1.5, radius * 0.08);
  return existing.some((entry) => (
    surfaceStrokePointDistance(entry?.start, segment.start) <= tolerance
    && surfaceStrokePointDistance(entry?.end, segment.end) <= tolerance
  ));
}

function surfaceStrokeSegmentsAlreadyCovered(cache = null, segments = []) {
  const existing = cache?.surfaceStrokeSegments || [];
  return Array.isArray(existing)
    && existing.length > 0
    && Array.isArray(segments)
    && segments.length > 0
    && segments.length <= existing.length
    && segments.every((segment) => surfaceStrokeSegmentAlreadyCovered(existing, segment));
}

function surfaceStrokeUncoveredSegments(existing = [], segments = []) {
  if (!Array.isArray(existing) || !existing.length || !Array.isArray(segments) || !segments.length) {
    return Array.isArray(segments) ? segments : [];
  }
  let firstUncoveredIndex = 0;
  while (
    firstUncoveredIndex < segments.length
    && surfaceStrokeSegmentAlreadyCovered(existing, segments[firstUncoveredIndex])
  ) {
    firstUncoveredIndex += 1;
  }
  return firstUncoveredIndex > 0 ? segments.slice(firstUncoveredIndex) : segments;
}

function surfaceStrokeStartsNewStroke(cache = null, owner = null, candidate = null, options = {}, segments = []) {
  const ownerChanged = surfaceStrokeOwnerChanged(cache, owner);
  if (ownerChanged) {
    return true;
  }
  const explicitReset = candidate?.strokeReset === true || candidate?.options?.strokeReset === true || options.strokeReset === true;
  if (explicitReset) {
    return true;
  }
  if (surfaceStrokeResetRequested(candidate, options)) {
    if (!Array.isArray(cache?.surfaceStrokeSegments) || !cache.surfaceStrokeSegments.length) {
      return true;
    }
    return cache.strokeResetOwner !== (owner || null);
  }
  if (surfaceStrokeSegmentsAlreadyCovered(cache, segments)) {
    return false;
  }
  if (
    owner
    && Array.isArray(cache?.surfaceStrokeSegments)
    && cache.surfaceStrokeSegments.length
  ) {
    return false;
  }
  if (
    Array.isArray(cache?.surfaceStrokeSegments)
    && cache.surfaceStrokeSegments.length
    && surfaceStrokeSegmentsAreContinuous(cache.previousSurfaceStrokeSegment, segments?.[0])
  ) {
    return false;
  }
  return Array.isArray(cache?.surfaceStrokeSegments) && cache.surfaceStrokeSegments.length > 0;
}

function appendSurfaceStrokeSegments(cache = null, segments = [], owner = null, sourceTexture = null, candidate = null, options = {}) {
  if (!cache || !Array.isArray(segments) || !segments.length || !sourceTexture) {
    return segments;
  }
  const startsNewStroke = surfaceStrokeStartsNewStroke(cache, owner, candidate, options, segments);
  if (!startsNewStroke && surfaceStrokeSegmentsAlreadyCovered(cache, segments)) {
    cache.lastSurfaceStrokeAppendSegments = [];
    return cache.surfaceStrokeSegments;
  }
  const ownerChanged = owner
    ? cache.strokeSourceOwner !== owner
    : cache.strokeSourceOwner != null;
  if (startsNewStroke || ownerChanged) {
    cache.strokeSourceOwner = owner || null;
    cache.previousSurfaceStrokeSegment = null;
    cache.strokeResetOwner = owner || null;
  }
  if (!owner && !startsNewStroke) {
    cache.previousSurfaceStrokeSegment = null;
  }
  const outputSegments = startsNewStroke || ownerChanged
    ? []
    : Array.isArray(cache.surfaceStrokeSegments)
      ? [...cache.surfaceStrokeSegments]
      : [];
  const segmentsToAppend = startsNewStroke || ownerChanged
    ? segments
    : surfaceStrokeUncoveredSegments(outputSegments, segments);
  if (!segmentsToAppend.length) {
    cache.surfaceStrokeSegments = outputSegments;
    cache.lastSurfaceStrokeAppendSegments = [];
    return cache.surfaceStrokeSegments;
  }
  const appendedSegments = [];
  const previousSegment = cache.previousSurfaceStrokeSegment || null;
  const firstSegment = segmentsToAppend[0] || null;
  const previousEnd = finitePoint(previousSegment?.end);
  const firstStart = finitePoint(firstSegment?.start);
  if (surfaceStrokeSegmentsAreContinuous(previousSegment, firstSegment) && previousEnd && firstStart) {
    const radius = Math.max(
      finiteNumber(previousSegment.radius, finiteNumber(previousSegment.radiusPixels, 0)),
      finiteNumber(previousSegment.radiusPixels, 0),
      finiteNumber(firstSegment.radius, finiteNumber(firstSegment.radiusPixels, 0)),
      finiteNumber(firstSegment.radiusPixels, 0),
      1
    );
    const previousViewEnd = finiteView(previousSegment?.viewEnd);
    const firstViewStart = finiteView(firstSegment?.viewStart);
    const previousComponentEnd = finiteComponentId(previousSegment?.componentEnd ?? previousSegment?.componentStart);
    const firstComponentStart = finiteComponentId(firstSegment?.componentStart ?? firstSegment?.componentEnd);
    const viewRadius = Math.max(
      finiteNumber(previousSegment?.viewRadius, finiteNumber(previousSegment?.worldRadius, 0)),
      finiteNumber(previousSegment?.worldRadius, 0),
      finiteNumber(firstSegment?.viewRadius, finiteNumber(firstSegment?.worldRadius, 0)),
      finiteNumber(firstSegment?.worldRadius, 0),
      0
    );
    const bridgeSegment = {
      start: previousEnd,
      end: firstStart,
      radius,
      ...(previousComponentEnd >= 0 ? { componentStart: previousComponentEnd } : {}),
      ...(firstComponentStart >= 0 ? { componentEnd: firstComponentStart } : {}),
      ...(previousViewEnd && firstViewStart ? {
        viewStart: previousViewEnd,
        viewEnd: firstViewStart,
        viewRadius,
        ...(previousSegment.viewNormalEnd || previousSegment.viewNormalStart
          ? { viewNormalStart: previousSegment.viewNormalEnd || previousSegment.viewNormalStart }
          : {}),
        ...(firstSegment.viewNormalStart || firstSegment.viewNormalEnd
          ? { viewNormalEnd: firstSegment.viewNormalStart || firstSegment.viewNormalEnd }
          : {}),
        worldStart: previousSegment.worldEnd || null,
        worldEnd: firstSegment.worldStart || null,
        worldRadius: viewRadius
      } : {})
    };
    outputSegments.push(bridgeSegment);
    appendedSegments.push(bridgeSegment);
  }
  outputSegments.push(...segmentsToAppend);
  appendedSegments.push(...segmentsToAppend);
  if (outputSegments.length > MAX_TSL_SURFACE_STROKE_SEGMENTS) {
    outputSegments.splice(0, outputSegments.length - MAX_TSL_SURFACE_STROKE_SEGMENTS);
  }
  cache.previousSurfaceStrokeSegment = segmentsToAppend[segmentsToAppend.length - 1] || previousSegment || null;
  cache.surfaceStrokeSegments = outputSegments;
  cache.lastSurfaceStrokeAppendSegments = appendedSegments;
  return cache.surfaceStrokeSegments;
}

function exposeSurfaceRunDebug(stats = null) {
  const dataset = typeof window !== "undefined" ? window.document?.documentElement?.dataset || null : null;
  if (!dataset || !stats || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
    return;
  }
  const entry = {
    width: stats.width,
    height: stats.height,
    field: stats.tslSurfaceField,
    meshUvTriangleCount: stats.meshUvTriangleCount,
    sourceTriangleCount: stats.sourceTriangleCount,
    rawProjectedTriangleCount: stats.rawProjectedTriangleCount,
    sourceMeshCount: stats.sourceMeshCount,
    filteredTriangleCount: stats.filteredTriangleCount,
    sourceTriangleKind: stats.sourceTriangleKind,
    screenProjectedStrokeSegmentCount: stats.screenProjectedStrokeSegmentCount,
    paintSegmentCount: stats.tslSurfacePaintSegmentCount,
    accumulatedPaintSegmentCount: stats.tslSurfaceAccumulatedPaintSegmentCount ?? stats.tslSurfacePaintSegmentCount,
    startsNewStroke: stats.tslSurfaceStartsNewStroke === true,
    strokeResetRequested: stats.tslSurfaceStrokeResetRequested === true,
    strokeSourceOwner: stats.tslSurfaceStrokeSourceOwner === true,
    strokeOwnerChanged: stats.tslSurfaceStrokeOwnerChanged === true,
    duplicateCoveredSegments: stats.tslSurfaceDuplicateCoveredSegments === true,
    strokeMaskCleared: stats.tslSurfaceStrokeMaskCleared === true,
    cachedTextureStillBound: stats.tslSurfaceCachedTextureStillBound === true,
    keptUnboundStrokeTexture: stats.tslSurfaceKeptUnboundStrokeTexture === true,
    skippedDuplicateSegments: stats.tslSurfaceSkippedDuplicateSegments === true,
    strokeMask: stats.tslSurfaceStrokeMask === true,
    strokeMaskInitialized: stats.tslSurfaceStrokeMaskInitialized === true,
    strokeBaseCopy: stats.tslSurfaceStrokeBaseCopy || "",
    baseCopy: stats.tslSurfaceBaseCopy || "",
    sourceColorSpace: stats.tslSurfaceSourceColorSpace || "",
    targetColorSpace: stats.tslSurfaceTargetColorSpace || "",
    targetFlipY: stats.tslSurfaceTargetFlipY === true,
    targetGenerateMipmaps: stats.tslSurfaceTargetGenerateMipmaps === true,
    targetMinFilter: stats.tslSurfaceTargetMinFilter ?? null,
    targetMagFilter: stats.tslSurfaceTargetMagFilter ?? null,
    displayTarget: stats.tslSurfaceDisplayTarget === true,
    displayTextureName: stats.tslSurfaceDisplayTextureName || "",
    displayFlipY: stats.tslSurfaceDisplayFlipY === true,
    displaySourceIsTarget: stats.tslSurfaceDisplaySourceIsTarget === true,
    materialName: stats.tslSurfaceMaterialName || "",
    materialMapName: stats.tslSurfaceMaterialMapName || "",
    materialMapIsDisplay: stats.tslSurfaceMaterialMapIsDisplay === true,
    layerMode: stats.tslSurfaceLayerMode === true,
    layerName: stats.tslSurfaceLayerName || "",
    layerOpacity: stats.tslSurfaceLayerOpacity ?? null,
    layerSourceEmpty: stats.tslSurfaceLayerSourceEmpty === true,
    layerSourceEmptyAtRunStart: stats.tslSurfaceLayerSourceEmptyAtRunStart === true,
    continuedEmptyLayerStroke: stats.tslSurfaceContinuedEmptyLayerStroke === true,
    strokeBaseWasEmptyLayer: stats.tslSurfaceStrokeBaseWasEmptyLayer === true,
    layerBaseTextureName: stats.tslSurfaceLayerBaseTextureName || "",
    layerCoordinateReferenceTextureName: stats.tslSurfaceLayerCoordinateReferenceTextureName || "",
    layerDisplayBaseTextureName: stats.tslSurfaceLayerDisplayBaseTextureName || "",
    layerTarget: stats.tslSurfaceLayerTarget === true,
    layerPaintRevision: stats.tslSurfaceLayerPaintRevision ?? null,
    layerDisplayComposite: stats.tslSurfaceLayerDisplayComposite === true,
    layerDisplayMode: stats.tslSurfaceLayerDisplayMode || "",
    brushColor: stats.tslSurfaceBrushColor || null,
    brushOpacity: stats.tslSurfaceBrushOpacity ?? null,
    brushHardness: stats.tslSurfaceBrushHardness ?? null,
    brushScatter: stats.tslSurfaceBrushScatter ?? null,
    sourceTextureName: stats.tslSurfaceSourceTextureName || "",
    sourceTextureImage: stats.tslSurfaceSourceTextureImage || null,
    sourceFlipY: stats.tslSurfaceSourceFlipY === true,
    baseFlipY: stats.tslSurfaceBaseFlipY === true,
    referenceFlipY: stats.tslSurfaceReferenceFlipY === true,
    originalFlipY: stats.tslSurfaceOriginalFlipY === true,
    sourceIsMaterialMap: stats.tslSurfaceSourceIsMaterialMap === true,
    sourceIsEditableTexture: stats.tslSurfaceSourceIsEditableTexture === true,
    sourceIsOriginalMap: stats.tslSurfaceSourceIsOriginalMap === true,
    sourceWasMaterialMap: stats.tslSurfaceSourceWasMaterialMap === true,
    sourceWasEditableTexture: stats.tslSurfaceSourceWasEditableTexture === true,
    sourceWasOriginalMap: stats.tslSurfaceSourceWasOriginalMap === true,
    sourceWasCacheOwned: stats.tslSurfaceSourceWasCacheOwned === true,
    baseWasCacheOwned: stats.tslSurfaceBaseWasCacheOwned === true,
    dilation: stats.tslSurfaceDilation === true,
    dilationPasses: stats.tslSurfaceDilationPasses,
    projectedGutterTriangleCount: stats.tslSurfaceProjectedGutterTriangleCount,
    projectedPrimary: stats.tslSurfaceProjectedPrimary === true,
    projectedTriangleSamples: stats.tslSurfaceProjectedTriangleSamples || null,
    overlapMaskAmbiguousTexels: stats.tslSurfaceOverlapMaskAmbiguousTexels,
    uvOccupancy: stats.tslSurfaceUvOccupancy === true,
    uvOccupancyCacheHit: stats.tslSurfaceUvOccupancyCacheHit ?? null,
    uvOccupancyKeyHash: stats.tslSurfaceUvOccupancyKeyHash || "",
    sourceRasterCacheHits: stats.tslSurfaceSourceRasterCacheHits || null,
    sourceRasterKeyHashes: stats.tslSurfaceSourceRasterKeyHashes || null,
    originalMeshUvRaster: stats.tslSurfaceOriginalMeshUvRaster === true,
    sourceRasterGutterPixels: stats.tslSurfaceSourceRasterGutterPixels ?? null,
    sourceRasterClipActive: stats.tslSurfaceSourceRasterClipActive === true,
    sourceRasterClipPaddingPixels: stats.tslSurfaceSourceRasterClipPaddingPixels ?? null,
    sourceMeshOriginalTriangleCount: stats.tslSurfaceSourceMeshOriginalTriangleCount ?? null,
    reboundMaterials: stats.tslSurfaceReboundMaterials,
    visibleSurface: stats.tslSurfaceVisibleSurface === true,
    visibleWidth: stats.tslSurfaceVisibleWidth,
    visibleHeight: stats.tslSurfaceVisibleHeight,
    prepareMs: stats.timings?.prepareMs ?? null,
    dispatchMs: stats.timings?.dispatchMs ?? null,
    prepareBreakdown: stats.timings?.prepareBreakdown || null,
    totalMs: stats.timings?.totalMs ?? null,
    firstSurfaceSegment: stats.tslSurfaceFirstSegment || null
    ,
    surfaceSegmentSamples: stats.tslSurfaceSegmentSamples || null
  };
  if (stats.tslSurfaceSkippedDuplicateSegments === true) {
    dataset.textureAirbrushDebugTslSurfaceSkippedRun = JSON.stringify(entry);
  } else {
    dataset.textureAirbrushDebugTslSurfaceRun = JSON.stringify(entry);
  }
  let history = [];
  try {
    history = JSON.parse(dataset.textureAirbrushDebugTslSurfaceRunHistory || "[]");
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) {
    history = [];
  }
  history.push(entry);
  dataset.textureAirbrushDebugTslSurfaceRunHistory = JSON.stringify(history.slice(-256));
}

function exposeSurfaceRunFailure(reason = "unknown", detail = {}) {
  const dataset = typeof window !== "undefined" ? window.document?.documentElement?.dataset || null : null;
  if (!dataset || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
    return null;
  }
  const entry = {
    reason,
    detail
  };
  dataset.textureAirbrushDebugTslSurfaceNullReason = JSON.stringify(entry);
  let history = [];
  try {
    history = JSON.parse(dataset.textureAirbrushDebugTslSurfaceNullHistory || "[]");
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) {
    history = [];
  }
  history.push(entry);
  dataset.textureAirbrushDebugTslSurfaceNullHistory = JSON.stringify(history.slice(-64));
  return null;
}

function exposeSurfacePrewarmDebug(entry = {}) {
  const dataset = typeof window !== "undefined" ? window.document?.documentElement?.dataset || null : null;
  if (!dataset || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")) {
    return;
  }
  dataset.textureAirbrushDebugTslSurfacePrewarm = JSON.stringify(entry);
  let history = [];
  try {
    history = JSON.parse(dataset.textureAirbrushDebugTslSurfacePrewarmHistory || "[]");
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) {
    history = [];
  }
  history.push(entry);
  dataset.textureAirbrushDebugTslSurfacePrewarmHistory = JSON.stringify(history.slice(-32));
}

export function texturePaintCanUseTslSurfaceAirbrush(editor = null, candidate = null, options = {}) {
  return Boolean(
    editor?.renderer?.isWebGPURenderer === true
    && editor?.renderer?.backend?.isWebGPUBackend === true
    && typeof THREE.RenderTarget === "function"
    && typeof THREE.MeshBasicNodeMaterial === "function"
    && THREE.TSL
    && candidate?.editable?.canvas
    && candidate?.material
    && candidateSurfaceSegments(editor, candidate, options).length > 0
  );
}

export function texturePaintCanPrewarmTslSurfaceAirbrush(editor = null, candidate = null) {
  return Boolean(
    editor?.renderer?.isWebGPURenderer === true
    && editor?.renderer?.backend?.isWebGPUBackend === true
    && typeof THREE.RenderTarget === "function"
    && typeof THREE.MeshBasicNodeMaterial === "function"
    && THREE.TSL
    && candidate?.editable?.canvas
    && candidate?.material
    && sourceObjectForCandidate(candidate)?.geometry
  );
}

export function texturePaintPrewarmTslSurfaceAirbrush(editor = null, candidate = null, options = {}) {
  const renderer = editor?.renderer || null;
  const editable = candidate?.editable || null;
  const material = candidate?.material || null;
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const finish = (warmed, detail = {}) => {
    const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    exposeSurfacePrewarmDebug({
      warmed: warmed === true,
      reason: detail.reason || "",
      width: detail.width ?? null,
      height: detail.height ?? null,
      sourceObjectCount: detail.sourceObjectCount ?? null,
      sourceMeshCount: detail.sourceMeshCount ?? null,
      meshUvTriangleCount: detail.meshUvTriangleCount ?? null,
      uvOccupancy: detail.uvOccupancy ?? null,
      uvOccupancyCacheHit: detail.uvOccupancyCacheHit ?? null,
      uvOccupancyKeyHash: detail.uvOccupancyKeyHash || "",
      sourceRasterCacheHits: detail.sourceRasterCacheHits || null,
      sourceRasterKeyHashes: detail.sourceRasterKeyHashes || null,
      originalMeshUvRaster: detail.originalMeshUvRaster ?? null,
      prewarmSegmentCount: detail.prewarmSegmentCount ?? null,
      targetIndex: detail.targetIndex ?? null,
      layerMode: detail.layerMode ?? null,
      layerSourceEmpty: detail.layerSourceEmpty ?? null,
      sourceTextureName: detail.sourceTextureName || "",
      baseTextureName: detail.baseTextureName || "",
      writeTextureName: detail.writeTextureName || "",
      referenceTextureName: detail.referenceTextureName || "",
      coordinateReferenceTextureName: detail.coordinateReferenceTextureName || "",
      renderedCompilePass: detail.renderedCompilePass === true,
      renderedVisibleSurface: detail.renderedVisibleSurface === true,
      renderedDilationPass: detail.renderedDilationPass === true,
      renderedDisplayPass: detail.renderedDisplayPass === true,
      elapsedMs: Math.max(0, endedAt - startedAt)
    });
    return warmed === true;
  };
  if (!texturePaintCanPrewarmTslSurfaceAirbrush(editor, candidate)) {
    return finish(false, {
      reason: "cannot-prewarm",
      hasRenderer: Boolean(renderer),
      isWebGpuRenderer: renderer?.isWebGPURenderer === true,
      hasEditableCanvas: Boolean(editable?.canvas),
      hasMaterial: Boolean(material),
      hasSourceObject: Boolean(sourceObjectForCandidate(candidate))
    });
  }
  const width = Math.max(1, Math.floor(Number(editable.canvas.width) || 1));
  const height = Math.max(1, Math.floor(Number(editable.canvas.height) || 1));
  const sourceObject = sourceObjectForCandidate(candidate);
  const materialIndex = Math.max(0, Math.floor(Number(candidate?.materialIndex ?? candidate?.hit?.face?.materialIndex) || 0));
  const materialOriginalMap = surfaceEditableOriginalMap(material, editable, [
    material.map,
    editable.texture
  ]);
  const layerMode = editable?.layerMode === true && editable?.layer;
  const layerBaseTexture = layerMode
    ? surfaceLayerBaseTexture(editor, material, editable, materialOriginalMap)
    : null;
  const layerCoordinateReferenceTexture = layerMode
    ? (layerBaseTexture || materialOriginalMap || material.map || editable.texture || null)
    : null;
  const layerSourceEmpty = Boolean(layerMode && surfaceLayerSourceIsEmpty(editable));
  let referenceTexture = layerMode
    ? surfaceLayerSourceTexture(editable, layerCoordinateReferenceTexture)
    : surfaceAirbrushReferenceTexture(material, editable, materialOriginalMap, null);
  let coordinateReferenceTexture = layerMode
    ? (layerCoordinateReferenceTexture || referenceTexture)
    : referenceTexture;
  const cache = ensureSurfaceAirbrushCache(editor, editable, coordinateReferenceTexture || referenceTexture, width, height);
  if (!cache) {
    return finish(false, { reason: "missing-cache", width, height });
  }
  referenceTexture = layerMode
    ? surfaceLayerSourceTexture(editable, layerCoordinateReferenceTexture)
    : surfaceAirbrushReferenceTexture(material, editable, materialOriginalMap, cache);
  coordinateReferenceTexture = layerMode
    ? (layerCoordinateReferenceTexture || referenceTexture)
    : referenceTexture;
  const cachedTextureStillBound = Boolean(
    cache.currentTexture
    && surfaceAirbrushCacheOwnsTexture(cache, cache.currentTexture)
    && cache.hasPaintedSurfaceStroke === true
    && (
      material.map === cache.currentTexture
      || editable.texture === cache.currentTexture
    )
  );
  const sourceTexture = cachedTextureStillBound
    ? cache.currentTexture
    : layerMode
      ? (referenceTexture || layerBaseTexture)
      : referenceTexture;
  if (!sourceTexture) {
    return finish(false, { reason: "missing-source-texture", width, height });
  }
  const sourceObjects = sourceObjectsForEditable(editor, candidate, editable, sourceTexture, referenceTexture);
  if (!sourceObjects.length) {
    return finish(false, { reason: "missing-source-objects", width, height });
  }
  const editableTextures = surfaceEditableTextureSet(candidate, editable, sourceTexture, referenceTexture);
  const materialScopeOptions = {};
  const visibleEdgeMode = String(
    options.visibleEdgeMode
    || editor?.textureAirbrushVisibleEdgeMode?.()
    || "soft"
  ).toLowerCase() === "hard" ? "hard" : "soft";
  const prewarmSegments = prewarmSurfaceBrushSegments(editor, candidate, {
    ...options,
    visibleEdgeMode,
    radiusPixels: Math.max(
      1,
      finiteNumber(options.radiusPixels, editor?.textureBrushRadiusScreenPixels?.() || 40)
    ),
    opacity: finiteNumber(options.opacity, editor?.textureAirbrushOpacity?.() ?? 0.42),
    hardness: finiteNumber(options.hardness, editor?.textureAirbrushHardness?.() ?? 0.35),
    scatter: finiteNumber(options.scatter, editor?.textureAirbrushScatter?.() ?? 0.35),
    color: options.color || editor?.textureAirbrushColor?.() || { r: 0, g: 255, b: 102 }
  });
  const prewarmRadiusPixels = Math.max(1, finiteNumber(options.radiusPixels, editor?.textureBrushRadiusScreenPixels?.() || 40));
  const usePrewarmSourceRasterClip = !layerMode && surfaceAirbrushSourceRasterClipEnabled();
  const prewarmRasterClipPath = usePrewarmSourceRasterClip
    ? simplifiedSourceRasterClipSegments(prewarmSegments, 18)
    : [];
  const prewarmBaseTexture = layerSourceEmpty
    ? surfaceAirbrushTransparentTexture()
    : ensureSurfaceStrokeBaseTexture(
        renderer,
        cache,
        sourceTexture,
        coordinateReferenceTexture || referenceTexture,
        width,
        height
      );
  const prewarmTargetIndex = surfaceTargetIndexForBaseTexture(cache, prewarmBaseTexture);
  const prewarmTarget = cache.targets?.[prewarmTargetIndex] || cache.targets?.[0] || null;
  const prewarmWriteTexture = prewarmTarget?.texture || prewarmBaseTexture;
  const prewarmStrokeMaskTarget = ensureSurfaceStrokeMaskTarget(cache, width, height);
  const prewarmRasterWriteTexture = prewarmStrokeMaskTarget?.texture || prewarmWriteTexture;
  const prewarmRasterWriteSize = textureLikeSize(prewarmRasterWriteTexture);
  const uvOccupancyTexture = ensureUvOccupancyMask(
    renderer,
    cache,
    sourceObjects,
    prewarmRasterWriteTexture,
    width,
    height,
    editable,
    editableTextures,
    sourceObject,
    materialIndex,
    materialScopeOptions
  );
  const visibleTexture = null;
  const prewarmOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled();
  const surfaceMeshEntries = ensureUvRasterMeshes(
    cache,
    sourceObjects,
    prewarmBaseTexture,
    visibleTexture,
    uvOccupancyTexture,
    editable,
      editableTextures,
    sourceObject,
    materialIndex,
    {
      ...materialScopeOptions,
      originalMeshUvRaster: prewarmOriginalMeshUvRaster,
      sourceRasterGutterPixels: surfaceAirbrushSourceRasterGutterPixels(),
      sourceRasterClipSegments: prewarmRasterClipPath,
      sourceRasterClipScatter: finiteNumber(options.scatter, editor?.textureAirbrushScatter?.() ?? 0.35),
      sourceRasterClipHardness: finiteNumber(options.hardness, editor?.textureAirbrushHardness?.() ?? 0.35),
      hardness: finiteNumber(options.hardness, editor?.textureAirbrushHardness?.() ?? 0.35),
        maskOnly: true,
        sourceRasterClipPaddingPixels: Math.max(
          18,
          Math.min(48, prewarmRadiusPixels * 0.35)
        ),
        writeTexture: prewarmRasterWriteTexture,
        rasterWidth: prewarmRasterWriteSize.width,
        rasterHeight: prewarmRasterWriteSize.height,
        sampleTexture: prewarmBaseTexture
      }
  );
  if (!surfaceMeshEntries.length) {
    return finish(false, {
      reason: "missing-surface-meshes",
      width,
      height,
      sourceObjectCount: sourceObjects.length,
      uvOccupancy: Boolean(uvOccupancyTexture),
      uvOccupancyCacheHit: cache.texturePaintTslLastUvOccupancyCacheHit === true,
      uvOccupancyKeyHash: cache.texturePaintTslLastUvOccupancyKeyHash || "",
      targetIndex: prewarmTargetIndex,
      layerMode: Boolean(layerMode),
      layerSourceEmpty,
      sourceTextureName: surfaceTextureDebugName(sourceTexture),
      baseTextureName: surfaceTextureDebugName(prewarmBaseTexture),
      writeTextureName: surfaceTextureDebugName(prewarmWriteTexture),
      referenceTextureName: surfaceTextureDebugName(referenceTexture),
      coordinateReferenceTextureName: surfaceTextureDebugName(coordinateReferenceTexture)
    });
  }
  for (const entry of surfaceMeshEntries) {
    updateSurfaceMaterial(
      entry.material,
      prewarmBaseTexture,
      prewarmSegments,
      {
        ...options,
        blendOnly: Boolean(layerMode),
        emptyLayerSource: layerSourceEmpty,
        visibleEdgeMode,
        debugVisibleSurfaceDepth: false,
        projectedPaintGutterOnly: false,
        radiusPixels: Math.max(1, finiteNumber(options.radiusPixels, editor?.textureBrushRadiusScreenPixels?.() || 40)),
        opacity: finiteNumber(options.opacity, editor?.textureAirbrushOpacity?.() ?? 0.42),
        hardness: finiteNumber(options.hardness, editor?.textureAirbrushHardness?.() ?? 0.35),
        scatter: finiteNumber(options.scatter, editor?.textureAirbrushScatter?.() ?? 0.35),
        color: options.color || editor?.textureAirbrushColor?.() || { r: 0, g: 255, b: 102 }
      },
      editor,
      visibleTexture,
      uvOccupancyTexture
    );
    entry.mesh.visible = true;
  }
  let renderedCompilePass = false;
  let renderedDilationPass = false;
  let renderedDisplayPass = false;
  if (options.renderCompilePass === true && prewarmTarget) {
    const previousTarget = typeof renderer.getRenderTarget === "function"
      ? renderer.getRenderTarget()
      : null;
    const previousAutoClear = renderer.autoClear;
    const previousProjectedVisible = cache.projectedMesh?.visible;
    try {
      if (cache.projectedMesh) {
        cache.projectedMesh.visible = false;
      }
      const strokeMaskTarget = prewarmStrokeMaskTarget || ensureSurfaceStrokeMaskTarget(cache, width, height);
      if (strokeMaskTarget?.texture) {
        clearSurfaceStrokeMaskTarget(renderer, cache);
        renderer.setRenderTarget(strokeMaskTarget);
        renderer.autoClear = false;
      } else {
        updateTextureCopyMaterial(cache.copyMaterial, prewarmBaseTexture);
        renderer.setRenderTarget(prewarmTarget);
        renderer.autoClear = true;
        renderer.clear?.();
        renderer.render(cache.copyScene, cache.camera);
        renderer.autoClear = false;
      }
      renderer.autoClear = false;
      renderer.render(cache.scene, cache.camera);
      if (strokeMaskTarget?.texture) {
        renderSurfaceStrokeComposite(
          renderer,
          cache,
          prewarmTarget,
          prewarmBaseTexture,
          strokeMaskTarget.texture,
          {
            ...options,
            blendOnly: Boolean(layerMode),
            emptyLayerSource: layerSourceEmpty
          }
        );
      }
      renderedCompilePass = true;
      const prewarmDilationPasses = layerMode ? 0 : surfaceAirbrushDilationPasses();
	      const dilationResult = runSurfaceDilation(
	        renderer,
	        cache,
	        prewarmTarget,
        coordinateReferenceTexture || referenceTexture,
        width,
        height,
        prewarmDilationPasses,
	        { preserveSourceAlpha: Boolean(layerMode) }
	      );
	      renderedDilationPass = dilationResult !== prewarmTarget || prewarmDilationPasses > 0;
	      let prewarmLayerTarget = dilationResult || prewarmTarget;
	      if (layerMode && layerSourceEmpty && prewarmTarget?.texture) {
	        clearRenderTargetTransparent(renderer, prewarmTarget, cache);
	        if (dilationResult && dilationResult !== prewarmTarget) {
	          clearRenderTargetTransparent(renderer, dilationResult, cache);
	        }
	        prewarmLayerTarget = prewarmTarget;
	      }
      if (layerMode) {
        const layerDisplay = renderSurfaceLayerComposite(
          renderer,
          cache,
	          layerBaseTexture || coordinateReferenceTexture || referenceTexture,
	          prewarmLayerTarget.texture,
	          layerBaseTexture || coordinateReferenceTexture || referenceTexture,
	          width,
	          height,
          editable.layer?.opacity ?? 1
        );
        renderedDisplayPass = Boolean(layerDisplay?.texture);
      } else {
        const displayTarget = renderSurfaceDisplayTexture(
          renderer,
          cache,
          (dilationResult || prewarmTarget).texture,
          coordinateReferenceTexture || referenceTexture,
          width,
          height,
          materialOriginalMap
	        );
	        renderedDisplayPass = Boolean(displayTarget?.texture);
	      }
      if (strokeMaskTarget?.texture) {
        clearSurfaceStrokeMaskTarget(renderer, cache);
        cache.strokeMaskInitialized = false;
      }
	    } finally {
      if (cache.projectedMesh && previousProjectedVisible !== undefined) {
        cache.projectedMesh.visible = previousProjectedVisible;
      }
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
  }
  const meshUvTriangleCount = surfaceMeshEntries.reduce((sum, entry) => (
    sum + surfaceGeometryDrawTriangleCount(entry?.mesh?.geometry)
  ), 0);
  const sourceRasterCacheHits = surfaceMeshEntries.map((entry) => entry?.texturePaintTslSourceRasterCacheHit === true);
  const sourceRasterKeyHashes = surfaceMeshEntries.map((entry) => entry?.texturePaintTslSourceRasterKeyHash || "");
  return finish(true, {
    width,
    height,
    sourceObjectCount: sourceObjects.length,
    sourceMeshCount: surfaceMeshEntries.length,
    meshUvTriangleCount,
    uvOccupancy: Boolean(uvOccupancyTexture),
    uvOccupancyCacheHit: cache.texturePaintTslLastUvOccupancyCacheHit === true,
    uvOccupancyKeyHash: cache.texturePaintTslLastUvOccupancyKeyHash || "",
    sourceRasterCacheHits,
      sourceRasterKeyHashes,
      originalMeshUvRaster: prewarmOriginalMeshUvRaster,
      prewarmSegmentCount: prewarmSegments.length,
    targetIndex: prewarmTargetIndex,
    layerMode: Boolean(layerMode),
    layerSourceEmpty,
    sourceTextureName: surfaceTextureDebugName(sourceTexture),
    baseTextureName: surfaceTextureDebugName(prewarmBaseTexture),
    writeTextureName: surfaceTextureDebugName(prewarmWriteTexture),
    referenceTextureName: surfaceTextureDebugName(referenceTexture),
    coordinateReferenceTextureName: surfaceTextureDebugName(coordinateReferenceTexture),
    renderedCompilePass,
    renderedVisibleSurface: Boolean(visibleTexture),
    renderedDilationPass,
    renderedDisplayPass
  });
}

export function texturePaintRunTslSurfaceAirbrush(editor = null, candidate = null, options = {}) {
  const renderer = editor?.renderer || null;
  const editable = candidate?.editable || null;
  const material = candidate?.material || null;
  const fail = (reason, detail = {}) => exposeSurfaceRunFailure(reason, detail);
  if (!texturePaintCanUseTslSurfaceAirbrush(editor, candidate, options)) {
    return fail("cannot-use-surface-airbrush", {
      hasRenderer: Boolean(renderer),
      isWebGpuRenderer: renderer?.isWebGPURenderer === true,
      hasEditableCanvas: Boolean(editable?.canvas),
      hasMaterial: Boolean(material),
      segmentCount: candidateSurfaceSegments(editor, candidate, options).length
    });
  }
  const functionStartMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const width = Math.max(1, Math.floor(Number(editable.canvas.width) || 1));
  const height = Math.max(1, Math.floor(Number(editable.canvas.height) || 1));
  const segments = candidateSurfaceSegments(editor, candidate, options);
  const sourceObject = sourceObjectForCandidate(candidate);
  const sourceGeometry = sourceGeometryForCandidate(candidate);
  const debugParams = typeof window !== "undefined"
    ? new URLSearchParams(window.location?.search || "")
    : null;
  const projectedGuttersDisabled = debugParams?.has("debugAirbrushDisableProjectedGutters") === true;
  const forceFullProjectedMesh = debugParams?.has("debugAirbrushFullProjectedMesh") === true;
  const candidateTriangles = candidateProjectedTriangles(candidate, options);
  const candidateProjectedPrimaryAvailable = candidateTriangles.length > 0 && !forceFullProjectedMesh;
  const projectedPrimaryRequested = debugParams?.has("debugAirbrushProjectedPrimary") === true
    || options.projectedPrimary === true
    || candidate?.options?.projectedPrimary === true;
  const preferProjectedPrimary = projectedGuttersDisabled !== true
    && !debugParams?.has("debugAirbrushFullSurfaceRaster")
    && projectedPrimaryRequested
    && candidateProjectedPrimaryAvailable;
  const useCandidateProjectedPrimary = Boolean(
    preferProjectedPrimary
    && candidateProjectedPrimaryAvailable
  );
  const forceFullProjectedGutters = debugParams?.has("debugAirbrushFullProjectedGutters") === true;
  const projectedGuttersRequested = forceFullProjectedGutters === true
    || debugParams?.has("debugAirbrushProjectedGutters") === true
    || debugParams?.has("debugAirbrushCandidateProjectedGutters") === true
    || options.projectedGutters === true
    || candidate?.options?.projectedGutters === true;
  const enableProjectedGutters = projectedGuttersDisabled !== true
    && !useCandidateProjectedPrimary
    && projectedGuttersRequested;
  const candidateProjectedGuttersRequested = forceFullProjectedGutters !== true
    && debugParams?.has("debugAirbrushCandidateProjectedGutters") === true;
  const useCandidateProjectedGutters = Boolean(
    enableProjectedGutters
    && candidateProjectedGuttersRequested
    && candidateTriangles.length
  );
  const materialIndex = Math.max(0, Math.floor(Number(candidate?.materialIndex ?? candidate?.hit?.face?.materialIndex) || 0));
  const triangleCount = geometryTriangleCount(sourceGeometry, materialIndex);
  if (!sourceObject || !sourceGeometry || !triangleCount) {
    return fail("missing-source-geometry", {
      hasSourceObject: Boolean(sourceObject),
      hasSourceGeometry: Boolean(sourceGeometry),
      triangleCount,
      materialIndex
    });
  }
  const materialOriginalMap = surfaceEditableOriginalMap(material, editable, [
    material.map,
    editable.texture
  ]);
  const layerMode = editable?.layerMode === true && editable?.layer;
  const layerBaseTexture = layerMode
    ? surfaceLayerBaseTexture(editor, material, editable, materialOriginalMap)
    : null;
  const layerCoordinateReferenceTexture = layerMode
    ? (layerBaseTexture || materialOriginalMap || material.map || editable.texture || null)
    : null;
  const layerSourceEmpty = Boolean(layerMode && surfaceLayerSourceIsEmpty(editable));
  let referenceTexture = layerMode
    ? surfaceLayerSourceTexture(editable, layerCoordinateReferenceTexture)
    : surfaceAirbrushReferenceTexture(material, editable, materialOriginalMap, null);
  let coordinateReferenceTexture = layerMode
    ? (layerCoordinateReferenceTexture || referenceTexture)
    : referenceTexture;
  const cache = ensureSurfaceAirbrushCache(editor, editable, coordinateReferenceTexture || referenceTexture, width, height);
  if (!cache) {
    return fail("missing-cache", {
      hasEditable: Boolean(editable),
      hasReferenceTexture: Boolean(referenceTexture),
      width,
      height
    });
  }
  referenceTexture = layerMode
    ? surfaceLayerSourceTexture(editable, layerCoordinateReferenceTexture)
    : surfaceAirbrushReferenceTexture(material, editable, materialOriginalMap, cache);
  coordinateReferenceTexture = layerMode
    ? (layerCoordinateReferenceTexture || referenceTexture)
    : referenceTexture;
  const strokeSourceOwner = options.strokeSourceOwner
    || candidate?.webGpuStrokeSourceOwner
    || candidate?.options?.webGpuStrokeSourceOwner
    || null;
  const startsNewSurfaceStroke = surfaceStrokeStartsNewStroke(cache, strokeSourceOwner, candidate, options, segments);
  const strokeOwnerChangedAtRunStart = surfaceStrokeOwnerChanged(cache, strokeSourceOwner);
  const strokeResetRequestedAtRunStart = surfaceStrokeResetRequested(candidate, options);
  const duplicateCoveredSegmentsBeforeReset = !surfaceStrokeOwnerChanged(cache, strokeSourceOwner)
    && !startsNewSurfaceStroke
    && surfaceStrokeSegmentsAlreadyCovered(cache, segments);
  const cachedTextureStillBound = Boolean(
    cache.currentTexture
    && surfaceAirbrushCacheOwnsTexture(cache, cache.currentTexture)
    && cache.hasPaintedSurfaceStroke === true
    && (
      material.map === cache.currentTexture
      || editable.texture === cache.currentTexture
    )
  );
  const keepUnboundStrokeTexture = Boolean(
    cache.currentTexture
    && surfaceAirbrushCacheOwnsTexture(cache, cache.currentTexture)
    && cache.strokeBaseTexture
    && Array.isArray(cache.surfaceStrokeSegments)
    && cache.surfaceStrokeSegments.length
    && (!startsNewSurfaceStroke || duplicateCoveredSegmentsBeforeReset)
  );
  if (!cachedTextureStillBound && !keepUnboundStrokeTexture && !duplicateCoveredSegmentsBeforeReset) {
    cache.currentTexture = null;
    cache.previousSurfaceStrokeSegment = null;
    cache.surfaceStrokeSegments = [];
    cache.lastSurfaceStrokeAppendSegments = [];
    cache.strokeResetOwner = null;
    cache.strokeBaseTexture = null;
    cache.strokeMaskInitialized = false;
    cache.hasPaintedSurfaceStroke = false;
  }
  const sourceTexture = cachedTextureStillBound || keepUnboundStrokeTexture
    ? cache.currentTexture
    : layerMode
      ? (referenceTexture || layerBaseTexture)
      : referenceTexture;
  if (!sourceTexture) {
    return fail("missing-source-texture", {
      cachedTextureStillBound,
      keepUnboundStrokeTexture,
      hasReferenceTexture: Boolean(referenceTexture),
      hasCurrentTexture: Boolean(cache.currentTexture)
    });
  }
  const duplicateCoveredSegments = duplicateCoveredSegmentsBeforeReset
    || (
      !surfaceStrokeOwnerChanged(cache, strokeSourceOwner)
      && surfaceStrokeSegmentsAlreadyCovered(cache, segments)
    );
  if (duplicateCoveredSegments && cache.currentTexture && (cachedTextureStillBound || keepUnboundStrokeTexture)) {
    const endMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const stats = {
      width,
      height,
      dirtyBounds: options.paintBounds || candidate.paintBounds || null,
      sourceUploaded: false,
      strokeSourceUploaded: false,
      visibilitySampleCount: 0,
      visibilityTriangleCount: 0,
      projectedRenderTriangleCount: 0,
      screenProjectedCoverageActive: true,
      screenProjectedStrokeSegmentCount: segments.length,
      liveDisplayExternalTexture: false,
      liveDisplayTslRenderTarget: false,
      liveDisplayFullUpdate: false,
      liveDisplayWorkPixels: 0,
      liveDisplayBounds: null,
      liveDisplayMipmapDirty: false,
      liveDisplayMipmapDeferred: false,
      liveDisplayMipmapPixels: 0,
      sourceBytes: 0,
      strokeSourceBytes: 0,
      readbackBytes: 0,
      appliedBytes: 0,
      reusedResources: true,
      deferredReadback: true,
      deferredReadbackCopy: false,
      deferredCanvasSync: false,
      tslSurfaceAirbrush: true,
      tslSurfaceStartsNewStroke: startsNewSurfaceStroke,
      tslSurfaceStrokeResetRequested: strokeResetRequestedAtRunStart,
      tslSurfaceStrokeSourceOwner: Boolean(strokeSourceOwner),
      tslSurfaceStrokeOwnerChanged: strokeOwnerChangedAtRunStart,
      tslSurfaceDuplicateCoveredSegments: duplicateCoveredSegments,
      tslSurfaceStrokeMaskCleared: false,
      tslSurfaceStrokeMask: cache.strokeMaskInitialized === true,
      tslSurfaceStrokeMaskInitialized: cache.strokeMaskInitialized === true,
      tslSurfaceSkippedDuplicateSegments: true,
      tslSurfaceField: preferProjectedPrimary
        ? "screen-and-view-projected-triangles"
        : "screen-and-view-source-mesh",
      tslSurfaceVisibleSurface: false,
      tslSurfaceVisibleWidth: 0,
      tslSurfaceVisibleHeight: 0,
      tslSurfaceDilation: false,
      tslSurfaceDilationPasses: 0,
      tslSurfaceProjectedGutterTriangleCount: 0,
      tslSurfaceProjectedPrimary: preferProjectedPrimary,
      tslSurfaceProjectedTriangleSamples: null,
      tslSurfaceOverlapMaskAmbiguousTexels: 0,
      tslSurfaceReboundMaterials: 0,
      tslSurfacePaintSegmentCount: cache.surfaceStrokeSegments?.length || segments.length,
      tslSurfaceCachedTextureStillBound: cachedTextureStillBound,
      tslSurfaceKeptUnboundStrokeTexture: keepUnboundStrokeTexture,
      tslSurfaceSkippedStaleFullSurfaceRender: false,
      tslSurfaceStrokeBaseCopy: cache.texturePaintTslSurfaceLastStrokeBaseCopy || "",
      tslSurfaceBaseCopy: "skipped-duplicate",
      tslSurfaceSourceColorSpace: String(sourceTexture?.colorSpace || ""),
      tslSurfaceSourceFlipY: sourceTexture?.flipY === true,
      tslSurfaceBaseFlipY: (cache.strokeBaseTexture || sourceTexture)?.flipY === true,
      tslSurfaceReferenceFlipY: referenceTexture?.flipY === true,
      tslSurfaceOriginalFlipY: materialOriginalMap?.flipY === true,
      tslSurfaceTargetColorSpace: String(cache.currentTexture?.colorSpace || ""),
      tslSurfaceTargetFlipY: cache.currentTexture?.flipY === true,
      tslSurfaceTargetGenerateMipmaps: cache.currentTexture?.generateMipmaps === true,
      tslSurfaceTargetMinFilter: cache.currentTexture?.minFilter ?? null,
      tslSurfaceTargetMagFilter: cache.currentTexture?.magFilter ?? null,
      tslSurfaceSourceTextureName: String(sourceTexture?.name || ""),
      tslSurfaceSourceTextureImage: sourceTexture?.image || sourceTexture?.source?.data
        ? {
            width: Math.max(0, Number((sourceTexture.image || sourceTexture.source?.data)?.width) || 0),
            height: Math.max(0, Number((sourceTexture.image || sourceTexture.source?.data)?.height) || 0),
            type: String((sourceTexture.image || sourceTexture.source?.data)?.constructor?.name || "")
          }
        : null,
      tslSurfaceSourceIsMaterialMap: sourceTexture === material.map,
      tslSurfaceSourceIsEditableTexture: sourceTexture === editable.texture,
      tslSurfaceSourceIsOriginalMap: sourceTexture === materialOriginalMap,
      tslSurfaceSourceWasMaterialMap: sourceTexture === material.map,
      tslSurfaceSourceWasEditableTexture: sourceTexture === editable.texture,
      tslSurfaceSourceWasOriginalMap: sourceTexture === materialOriginalMap,
      tslSurfaceSourceWasCacheOwned: surfaceAirbrushCacheOwnsTexture(cache, sourceTexture),
      tslSurfaceBaseWasCacheOwned: surfaceAirbrushCacheOwnsTexture(cache, cache.strokeBaseTexture || sourceTexture),
      tslSurfaceFirstSegment: segments[0]
        ? {
            start: segments[0].start || null,
            end: segments[0].end || null,
            radius: segments[0].radius ?? null,
            viewStart: segments[0].viewStart || null,
            viewEnd: segments[0].viewEnd || null,
            viewNormalStart: segments[0].viewNormalStart || null,
            viewNormalEnd: segments[0].viewNormalEnd || null,
            viewRadius: segments[0].viewRadius ?? null,
            componentStart: segments[0].componentStart ?? null,
            componentEnd: segments[0].componentEnd ?? null
          }
        : null,
      tslSurfaceSegmentSamples: segments.slice(0, 8).map((segment) => ({
        start: segment.start || null,
        end: segment.end || null,
        radius: segment.radius ?? null,
        viewStart: segment.viewStart || null,
        viewEnd: segment.viewEnd || null,
        viewNormalStart: segment.viewNormalStart || null,
        viewNormalEnd: segment.viewNormalEnd || null,
        viewRadius: segment.viewRadius ?? null,
        componentStart: segment.componentStart ?? null,
        componentEnd: segment.componentEnd ?? null
      })),
      meshUvTriangleCount: 0,
      sourceTriangleCount: 0,
      rawProjectedTriangleCount: 0,
      filteredProjectedTriangleCount: 0,
      sourceMeshCount: 0,
      filteredTriangleCount: 0,
      sourceTriangleKind: "source-mesh-uv",
      tslSurfaceUvOccupancy: Boolean(cache.uvOccupancyTarget?.texture),
      tslSurfaceUvOccupancyCacheHit: cache.texturePaintTslLastUvOccupancyCacheHit ?? null,
      tslSurfaceUvOccupancyKeyHash: cache.texturePaintTslLastUvOccupancyKeyHash || "",
      tslSurfaceSourceRasterCacheHits: null,
      tslSurfaceSourceRasterKeyHashes: null,
      tslSurfaceSourceRasterGutterPixels: surfaceAirbrushSourceRasterGutterPixels(),
      timings: {
        prepareMs: Math.max(0, endMs - functionStartMs),
        dispatchMs: 0,
        readbackMs: 0,
        applyMs: 0,
        totalMs: Math.max(0, endMs - functionStartMs)
      }
    };
    if (editor) {
      editor.textureAirbrushLastSkippedWebGpuPaintStats = stats;
    }
    exposeSurfaceRunDebug(stats);
    return {
      payload: null,
      sourcePixels: null,
      pixels: null,
      applied: null,
      readbackPromise: null,
      stats
    };
  }
  const sourceWasMaterialMap = sourceTexture === material.map;
  const sourceWasEditableTexture = sourceTexture === editable.texture;
  const sourceWasOriginalMap = sourceTexture === materialOriginalMap;
  const sourceWasCacheOwned = surfaceAirbrushCacheOwnsTexture(cache, sourceTexture);
  const prepTimings = {};
  let prepTimingMarkMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const markPrepTiming = (name = "") => {
    if (!name) {
      return;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    prepTimings[name] = Math.max(0, now - prepTimingMarkMs);
    prepTimingMarkMs = now;
  };
  if (!cache.copyMaterial || !cache.copyMesh || !cache.copyScene) {
    return fail("missing-copy-resources", {
      hasCopyMaterial: Boolean(cache.copyMaterial),
      hasCopyMesh: Boolean(cache.copyMesh),
      hasCopyScene: Boolean(cache.copyScene)
    });
  }
  let continuedEmptyLayerStroke = false;
  if (
    !cache.strokeBaseTexture
    || startsNewSurfaceStroke
  ) {
    const ownerChangedForBase = surfaceStrokeOwnerChanged(cache, strokeSourceOwner);
    const continuingEmptyLayerStroke = Boolean(
      layerMode
      && cache.strokeBaseWasEmptyLayer === true
      && !ownerChangedForBase
      && cache.strokeBaseTexture === surfaceAirbrushTransparentTexture()
    );
    continuedEmptyLayerStroke = continuingEmptyLayerStroke;
    if (layerMode && (layerSourceEmpty || continuingEmptyLayerStroke)) {
      cache.strokeBaseTexture = surfaceAirbrushTransparentTexture();
      cache.strokeBaseWasEmptyLayer = true;
      cache.strokeBaseEmptyLayerOwner = strokeSourceOwner || null;
      cache.texturePaintTslSurfaceLastStrokeBaseCopy = layerSourceEmpty
        ? "transparent-layer"
        : "transparent-layer-continuation";
    } else {
      cache.strokeBaseTexture = ensureSurfaceStrokeBaseTexture(
        renderer,
        cache,
        sourceTexture,
        coordinateReferenceTexture || referenceTexture,
        width,
        height
      );
      cache.strokeBaseWasEmptyLayer = false;
      cache.strokeBaseEmptyLayerOwner = null;
    }
  }
  markPrepTiming("strokeBase");
  const paintSegments = appendSurfaceStrokeSegments(cache, segments, strokeSourceOwner, sourceTexture, candidate, options);
  markPrepTiming("appendSegments");
  const meshProjectedTriangles = (enableProjectedGutters && !useCandidateProjectedGutters)
    || (preferProjectedPrimary && !useCandidateProjectedPrimary)
    ? cachedMeshUvProjectedTriangles(cache, editor, candidate, width, height)
    : [];
  markPrepTiming("meshProjectedTriangles");
  const rawProjectedTriangles = useCandidateProjectedPrimary
    ? candidateTriangles
    : useCandidateProjectedGutters
    ? candidateTriangles
    : meshProjectedTriangles.length
    ? meshProjectedTriangles
    : enableProjectedGutters
      ? candidateTriangles
      : [];
  const useProjectedPrimary = Boolean(preferProjectedPrimary && rawProjectedTriangles.length);
  const baseTexture = cache.strokeBaseTexture || sourceTexture;
  const emptyLayerSourceTexture = Boolean(layerMode && baseTexture === surfaceAirbrushTransparentTexture());
  const baseWasMaterialMap = baseTexture === material.map;
  const baseWasEditableTexture = baseTexture === editable.texture;
  const baseWasOriginalMap = baseTexture === materialOriginalMap;
  const baseWasCacheOwned = surfaceAirbrushCacheOwnsTexture(cache, baseTexture);
  editor?.textureAirbrushCancelDeferredWebGpuCanvasSync?.();
  const blendOntoBaseTarget = false;
  const useStrokeMaskComposite = !useProjectedPrimary
    && debugParams?.has("debugAirbrushDirectSurfaceComposite") !== true;
  const newlyAppendedPaintSegments = Array.isArray(cache.lastSurfaceStrokeAppendSegments)
    && cache.lastSurfaceStrokeAppendSegments.length
    ? cache.lastSurfaceStrokeAppendSegments
    : startsNewSurfaceStroke
      ? paintSegments
      : segments;
  const renderPaintSegments = useStrokeMaskComposite
    ? newlyAppendedPaintSegments
    : paintSegments;
  const maskRenderBatches = useStrokeMaskComposite
    ? chunkSurfaceSegmentsForShader(renderPaintSegments)
    : [];
  const shaderPaintSegments = useStrokeMaskComposite
    ? maskRenderBatches[0] || []
    : renderPaintSegments;
  const filteredProjectedTriangles = filterProjectedTrianglesForScreenBrush(rawProjectedTriangles, renderPaintSegments, options);
  markPrepTiming("filterProjectedTriangles");
  const projectedTriangles = useStrokeMaskComposite
    ? []
    : useProjectedPrimary
    ? (filteredProjectedTriangles.length ? filteredProjectedTriangles : rawProjectedTriangles)
    : filteredProjectedTriangles;
  const targetIndex = blendOntoBaseTarget
    ? baseTargetIndex
    : surfaceTargetIndexForBaseTexture(cache, baseTexture);
  const target = cache.targets[targetIndex];
  const writeTexture = target?.texture || baseTexture;
  const strokeMaskTargetForRaster = useStrokeMaskComposite
    ? ensureSurfaceStrokeMaskTarget(cache, width, height)
    : null;
  const rasterWriteTexture = strokeMaskTargetForRaster?.texture || writeTexture;
  const rasterWriteSize = textureLikeSize(rasterWriteTexture);
  const rasterGutterScale = Math.min(
    1,
    rasterWriteSize.width / Math.max(1, width),
    rasterWriteSize.height / Math.max(1, height)
  );
  const sourceRasterGutterPixels = useStrokeMaskComposite
    ? Math.max(1, Math.ceil(surfaceAirbrushSourceRasterGutterPixels() * rasterGutterScale))
    : surfaceAirbrushSourceRasterGutterPixels();
  updateTextureCopyMaterial(cache.copyMaterial, baseTexture);
  if (cache.copyMaterial && cache.copyMaterial.transparent !== false) {
    cache.copyMaterial.transparent = false;
    cache.copyMaterial.blending = THREE.NoBlending;
    cache.copyMaterial.needsUpdate = true;
  }
  const sourceObjects = sourceObjectsForEditable(editor, candidate, editable, sourceTexture, referenceTexture);
  const editableTextures = surfaceEditableTextureSet(candidate, editable, sourceTexture, referenceTexture);
  const materialScopeOptions = {};
  const liveProjectedPaint = options.liveProjectedPaint === true;
  const screenStrokePaint = options.screenStrokePaint === true;
  const liveStrokeMaskComposite = useStrokeMaskComposite
    && (liveProjectedPaint || screenStrokePaint);
  const useSourceRasterClip = !layerMode
    && useStrokeMaskComposite
    && surfaceAirbrushSourceRasterClipEnabled();
  const sourceRasterClipPath = useSourceRasterClip
    ? simplifiedSourceRasterClipSegments(renderPaintSegments, 18)
    : [];
  const useOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled();
  const sourceRasterOptions = {
    ...materialScopeOptions,
    originalMeshUvRaster: useOriginalMeshUvRaster,
    sourceRasterClipSegments: sourceRasterClipPath,
    sourceRasterClipScatter: options.scatter,
    sourceRasterClipHardness: options.hardness,
    writeTexture: rasterWriteTexture,
    rasterWidth: rasterWriteSize.width,
    rasterHeight: rasterWriteSize.height,
    sampleTexture: baseTexture,
    maskOnly: useStrokeMaskComposite,
    layerOnly: layerMode && !useStrokeMaskComposite,
    hardness: options.hardness,
    sourceRasterGutterPixels,
    sourceRasterClipPaddingPixels: Math.max(
      18,
      Math.min(
        48,
        Math.max(1, finiteNumber(options.screenRadiusPixels, finiteNumber(options.radiusPixels, 1))) * 0.35
      )
    )
  };
  const visibleEdgeMode = String(options.visibleEdgeMode || "soft").toLowerCase() === "hard"
    ? "hard"
    : "soft";
  const needsVisibleSurfaceTexture = false;
	  const visibleTarget = null;
  markPrepTiming("visibleSurface");
	  const visibleTexture = visibleTarget?.texture || null;
	  const uvOccupancyTexture = !useProjectedPrimary
    ? ensureUvOccupancyMask(
        renderer,
        cache,
        sourceObjects,
        writeTexture,
        width,
        height,
        editable,
        editableTextures,
        sourceObject,
        materialIndex,
        materialScopeOptions
	      )
	    : null;
  markPrepTiming("uvOccupancy");
	  let surfaceMeshEntries = [];
  if (useProjectedPrimary) {
    for (const entry of cache.surfaceMeshes || []) {
      if (entry?.mesh) {
        entry.mesh.visible = false;
      }
    }
  } else {
    surfaceMeshEntries = ensureUvRasterMeshes(
      cache,
      sourceObjects,
      baseTexture,
      visibleTexture,
      uvOccupancyTexture,
      editable,
      editableTextures,
      sourceObject,
      materialIndex,
	      sourceRasterOptions
	    );
	  }
  markPrepTiming("uvRasterMeshes");
  if (!useProjectedPrimary && !surfaceMeshEntries.length) {
    return fail("missing-surface-meshes", {
      sourceObjectCount: sourceObjects.length,
      hasVisibleTexture: Boolean(visibleTexture),
      editableTextureCount: editableTextures.size
    });
  }
  const sourceMeshTriangleCount = surfaceMeshEntries.reduce((sum, entry) => (
    sum + surfaceGeometryDrawTriangleCount(entry?.mesh?.geometry)
  ), 0);
  const sourceMeshOriginalTriangleCount = surfaceMeshEntries.reduce((sum, entry) => (
    sum + geometryTotalTriangleCount(entry?.sourceObject?.geometry || entry?.geometry || null)
  ), 0);
  const overlapMaskAmbiguousTexels = surfaceMeshEntries.reduce((sum, entry) => (
    sum + Math.max(
      0,
      Number(
        entry?.material?.userData?.texturePaintTslSurfaceAirbrush?.overlapMaskTexture
          ?.userData?.texturePaintTslSurfaceOverlapMask?.ambiguousTexels
      ) || 0
    )
  ), 0);
  const sourceRasterCacheHits = surfaceMeshEntries.map((entry) => entry?.texturePaintTslSourceRasterCacheHit === true);
  const sourceRasterKeyHashes = surfaceMeshEntries.map((entry) => entry?.texturePaintTslSourceRasterKeyHash || "");
  for (const entry of surfaceMeshEntries) {
    if (!updateSurfaceMaterial(
	      entry.material,
	      baseTexture,
	      shaderPaintSegments,
	      {
	        ...options,
	        blendOnly: layerMode,
	        emptyLayerSource: emptyLayerSourceTexture,
	        projectedPaintGutterOnly: false,
	        debugVisibleSurfaceDepth: needsVisibleSurfaceTexture
	      },
	      editor,
	      visibleTexture,
	      uvOccupancyTexture
	    )) {
      return fail("surface-material-update-failed", {
        hasMaterial: Boolean(entry?.material),
        segmentCount: shaderPaintSegments.length,
        hasBaseTexture: Boolean(baseTexture),
        hasVisibleTexture: Boolean(visibleTexture),
        hasUvOccupancyTexture: Boolean(uvOccupancyTexture)
      });
    }
  }
  markPrepTiming("updateSourceMaterials");
  let projectedGutterTriangleCount = 0;
  if (projectedTriangles.length) {
    const projectedMaterialKey = layerMode ? "projectedLayerMaterial" : "projectedMaterial";
    cache[projectedMaterialKey] ||= createProjectedSurfaceMaterial(baseTexture, visibleTexture, {
      layerOnly: layerMode
    });
    cache.projectedMaterial = cache[projectedMaterialKey];
    if (
      cache.projectedMaterial
      && updateSurfaceMaterial(cache.projectedMaterial, baseTexture, shaderPaintSegments, {
        ...options,
        projectedPaintGutterOnly: !useProjectedPrimary,
        blendOnly: layerMode,
        emptyLayerSource: emptyLayerSourceTexture,
        debugVisibleSurfaceDepth: needsVisibleSurfaceTexture
      }, editor, visibleTexture)
    ) {
      const projectedMesh = ensureProjectedSurfaceMesh(
        cache,
        projectedTriangles,
        cache.projectedMaterial,
        width,
        height,
        baseTexture,
        UV_SEAM_BLEED_PIXELS
      );
      projectedGutterTriangleCount = surfaceGeometryDrawTriangleCount(projectedMesh?.geometry);
    }
  } else if (cache.projectedMesh) {
    cache.projectedMesh.visible = false;
    projectedGutterTriangleCount = 0;
  }
  markPrepTiming("projectedMesh");
  for (const entry of surfaceMeshEntries) {
    if (entry?.mesh) {
      entry.mesh.visible = !useProjectedPrimary;
    }
  }

  const startMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  let finalTarget = null;
  let copiedBaseTexture = false;
  let shaderCopiedBaseTexture = false;
  let clearedTransparentBaseTexture = false;
  let strokeMaskCleared = false;
  const previousTarget = typeof renderer.getRenderTarget === "function"
    ? renderer.getRenderTarget()
    : null;
  const previousAutoClear = renderer.autoClear;
  try {
    if (useStrokeMaskComposite) {
      const strokeMaskTarget = ensureSurfaceStrokeMaskTarget(cache, width, height);
      if (!strokeMaskTarget?.texture) {
        return fail("missing-stroke-mask-target", {
          width,
          height,
          useStrokeMaskComposite
        });
      }
      if (startsNewSurfaceStroke || cache.strokeMaskInitialized !== true) {
        clearSurfaceStrokeMaskTarget(renderer, cache);
        strokeMaskCleared = true;
      }
      renderer.setRenderTarget(strokeMaskTarget);
      renderer.autoClear = false;
      for (const batchSegments of maskRenderBatches) {
        for (const entry of surfaceMeshEntries) {
          if (!updateSurfaceMaterial(
            entry.material,
            baseTexture,
            batchSegments,
            {
              ...options,
              blendOnly: layerMode,
              emptyLayerSource: emptyLayerSourceTexture,
              projectedPaintGutterOnly: false,
              debugVisibleSurfaceDepth: needsVisibleSurfaceTexture
            },
            editor,
            visibleTexture,
            uvOccupancyTexture
          )) {
            return fail("surface-material-batch-update-failed", {
              hasMaterial: Boolean(entry?.material),
              segmentCount: batchSegments.length,
              hasBaseTexture: Boolean(baseTexture),
              hasVisibleTexture: Boolean(visibleTexture),
              hasUvOccupancyTexture: Boolean(uvOccupancyTexture)
            });
          }
        }
        renderer.render(cache.scene, cache.camera);
      }
      finalTarget = renderSurfaceStrokeComposite(
        renderer,
        cache,
        target,
        baseTexture,
        strokeMaskTarget.texture,
        {
          ...options,
          blendOnly: layerMode,
          emptyLayerSource: emptyLayerSourceTexture
        }
      );
      if (!finalTarget?.texture) {
        return fail("stroke-mask-composite-failed", {
          width,
          height,
          hasMaskTexture: Boolean(strokeMaskTarget.texture),
          hasBaseTexture: Boolean(baseTexture),
          segmentCount: renderPaintSegments.length,
          batchCount: maskRenderBatches.length
        });
      }
    } else {
      const transparentBaseTexture = layerMode && baseTexture === surfaceAirbrushTransparentTexture();
      copiedBaseTexture = transparentBaseTexture
        ? false
        : copySurfaceBaseTexture(renderer, baseTexture, target, cache);
      renderer.setRenderTarget(target);
      if (transparentBaseTexture) {
        clearedTransparentBaseTexture = clearRenderTargetTransparent(renderer, target, cache);
        renderer.setRenderTarget(target);
        renderer.autoClear = false;
      } else if (!copiedBaseTexture) {
        shaderCopiedBaseTexture = true;
        renderer.autoClear = true;
        renderer.clear?.();
        renderer.render(cache.copyScene, cache.camera);
        renderer.autoClear = false;
      } else {
        renderer.autoClear = false;
      }
      renderer.render(cache.scene, cache.camera);
      finalTarget = target;
    }
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
  }
  const surfaceDilationPasses = layerMode
    ? 0
    : useStrokeMaskComposite
    ? 0
    : projectedGutterTriangleCount > 0
    ? 0
    : surfaceAirbrushDilationPasses();
  finalTarget = runSurfaceDilation(renderer, cache, finalTarget || target, referenceTexture, width, height, surfaceDilationPasses, {
    preserveSourceAlpha: Boolean(layerMode)
  });
  const endMs = typeof performance !== "undefined" ? performance.now() : Date.now();

  cache.targetIndex = targetIndex;
  const previousEditableTexture = editable.texture || null;
  const previousMaterialMap = material.map || null;
  const originalMap = surfaceEditableOriginalMap(material, editable, [
    referenceTexture,
    sourceTexture,
    previousEditableTexture,
    previousMaterialMap
  ]);
  if (finalTarget?.texture) {
    finalTarget.texture.flipY = false;
    finalTarget.texture.userData ||= {};
    finalTarget.texture.userData.texturePaintTslSurfaceAirbrushTargetTexture = true;
    finalTarget.texture.userData.texturePaintTslSurfaceDisplayFlipY = (coordinateReferenceTexture || referenceTexture)?.flipY === true;
    if (originalMap && !finalTarget.texture.userData.textureAirbrushWebGpuCanvasMap) {
      finalTarget.texture.userData.textureAirbrushWebGpuCanvasMap = originalMap;
    }
  }
  cache.currentTexture = finalTarget.texture;
  cache.hasPaintedSurfaceStroke = true;
  let reboundMaterialCount = 0;
  let layerTargetEntry = null;
  let layerDisplayTarget = null;
  let layerDisplayBaseTexture = null;
  let layerDisplayMode = "";
  let layerDisplayUsedLiveUnderlay = false;
  let displayTarget = null;
  let displayTexture = finalTarget.texture;
  if (layerMode) {
    layerTargetEntry = bindSurfaceLayerTarget(editor, material, editable, finalTarget, {
      width,
      height,
      updatedAt: endMs
    });
    const displayBaseTexture = surfaceLayerDisplayUnderlayTexture(
      editor,
      material,
      editable,
      originalMap,
      layerBaseTexture || coordinateReferenceTexture || referenceTexture
    );
    layerDisplayBaseTexture = displayBaseTexture || null;
    layerDisplayUsedLiveUnderlay = Boolean(
      layerDisplayBaseTexture
      && layerDisplayBaseTexture !== layerBaseTexture
      && surfaceAirbrushTextureIsLiveTarget(layerDisplayBaseTexture)
    );
    layerDisplayTarget = renderSurfaceLayerComposite(
      renderer,
      cache,
      displayBaseTexture,
      finalTarget.texture,
      displayBaseTexture || coordinateReferenceTexture || referenceTexture,
      width,
      height,
      editable.layer?.opacity ?? 1,
      { alphaFallback: true }
    );
    if (layerDisplayTarget?.texture) {
      layerDisplayMode = "texture-composite";
      displayTexture = layerDisplayTarget.texture;
      if (layerTargetEntry) {
        const stack = editable.layerStack || layerTargetEntry.layerStack || null;
        const activeLayer = editable.layer || null;
        layerTargetEntry.displayTarget = layerDisplayTarget;
        layerTargetEntry.liveCompositeBaseTexture = layerDisplayBaseTexture;
        layerTargetEntry.liveCompositeTarget = layerDisplayTarget;
        layerTargetEntry.liveCompositeLayer = activeLayer;
        layerTargetEntry.liveCompositeLayerIndex = surfaceLayerIndex(stack, activeLayer);
        layerTargetEntry.liveCompositeLayerCount = stack?.layers?.length || 0;
        layerTargetEntry.liveCompositeLayerOpacity = activeLayer?.opacity ?? 1;
        layerTargetEntry.liveCompositeLayerBlendMode = activeLayer?.blendMode || "source-over";
        layerTargetEntry.liveCompositeLayerMutationSerial = surfaceLayerMutationSerial(editor);
        layerTargetEntry.liveCompositeUnderlayKey = editor?.texturePaintLiveLayerUnderlayKey?.(layerTargetEntry) || "";
      }
    }
    if (layerDisplayTarget?.texture) {
      material.userData ||= {};
      material.userData.texturePaintCompositeGpuTarget = {
        target: layerDisplayTarget,
        width,
        height,
        material,
        layer: editable.layer || null,
        layerStack: editable.layerStack || null,
        layerMode: true,
        updatedAt: endMs
      };
      material.map = layerDisplayTarget.texture;
      if (previousMaterialMap !== layerDisplayTarget.texture) {
        material.needsUpdate = true;
      }
    }
    editor?.scheduleTexturePaintLayerPanelRender?.();
  } else {
    displayTarget = renderSurfaceDisplayTexture(
      renderer,
      cache,
      finalTarget.texture,
      referenceTexture || finalTarget.texture,
      width,
      height,
      originalMap
    );
    if (displayTarget?.texture) {
      displayTexture = displayTarget.texture;
    }
    bindSurfaceEditableMetadata(material, editable, finalTarget.texture, {
      originalMap,
      references: [
        referenceTexture,
        sourceTexture,
        previousEditableTexture,
        previousMaterialMap
      ]
    });
    material.map = displayTexture;
    if (previousMaterialMap !== displayTexture) {
      material.needsUpdate = true;
    }
    editable.texture = finalTarget.texture;
    reboundMaterialCount = bindSurfaceTextureToMatchingMaterials(editor, editable, finalTarget.texture, [
      referenceTexture,
      sourceTexture,
      previousEditableTexture,
      previousMaterialMap,
      cache.currentTexture
    ], {
      originalMap,
      references: [
        referenceTexture,
        sourceTexture,
        previousEditableTexture,
        previousMaterialMap
      ],
      materialTexture: displayTexture
    });
  }
  scheduleSurfaceAirbrushParkedResourceReap(editor);
  material.userData ||= {};
  const surfaceTargetEntry = layerMode && layerTargetEntry
    ? layerTargetEntry
    : material.userData.texturePaintTslSurfaceAirbrushTarget || {};
  surfaceTargetEntry.target = finalTarget;
  surfaceTargetEntry.displayTarget = displayTarget || layerDisplayTarget || null;
  surfaceTargetEntry.editable = editable;
  surfaceTargetEntry.width = width;
  surfaceTargetEntry.height = height;
  surfaceTargetEntry.material = material;
  surfaceTargetEntry.layer = editable.layer || null;
  surfaceTargetEntry.layerStack = editable.layerStack || null;
  surfaceTargetEntry.layerMode = Boolean(layerMode);
  surfaceTargetEntry.updatedAt = endMs;
  material.userData.texturePaintTslSurfaceAirbrushTarget = surfaceTargetEntry;
  const completeMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const stats = {
    width,
    height,
    dirtyBounds: options.paintBounds || candidate.paintBounds || null,
    sourceUploaded: false,
    strokeSourceUploaded: false,
    visibilitySampleCount: renderPaintSegments.length,
    visibilityTriangleCount: projectedTriangles.length,
    projectedRenderTriangleCount: projectedTriangles.length,
    screenProjectedCoverageActive: true,
    screenProjectedStrokeSegmentCount: renderPaintSegments.length,
    liveDisplayExternalTexture: false,
    liveDisplayTslRenderTarget: true,
    liveDisplayFullUpdate: false,
    liveDisplayWorkPixels: 0,
    liveDisplayBounds: null,
    liveDisplayMipmapDirty: false,
    liveDisplayMipmapDeferred: false,
    liveDisplayMipmapPixels: 0,
    sourceBytes: 0,
    strokeSourceBytes: 0,
    readbackBytes: 0,
    appliedBytes: 0,
    reusedResources: true,
    deferredReadback: true,
    deferredReadbackCopy: false,
    deferredCanvasSync: false,
    tslSurfaceAirbrush: true,
    tslSurfaceStartsNewStroke: startsNewSurfaceStroke,
    tslSurfaceStrokeResetRequested: strokeResetRequestedAtRunStart,
    tslSurfaceStrokeSourceOwner: Boolean(strokeSourceOwner),
    tslSurfaceStrokeOwnerChanged: strokeOwnerChangedAtRunStart,
    tslSurfaceDuplicateCoveredSegments: duplicateCoveredSegments,
    tslSurfaceStrokeMaskCleared: strokeMaskCleared,
    tslSurfaceStrokeMask: useStrokeMaskComposite,
    tslSurfaceStrokeMaskInitialized: cache.strokeMaskInitialized === true,
    tslSurfaceStrokeMaskWidth: cache.strokeMaskTarget?.width || 0,
    tslSurfaceStrokeMaskHeight: cache.strokeMaskTarget?.height || 0,
    tslSurfaceField: useProjectedPrimary
      ? "screen-and-view-projected-triangles"
      : projectedGutterTriangleCount > 0
        ? "screen-and-view-source-mesh-with-projected-gutters"
        : "screen-and-view-source-mesh",
    tslSurfaceVisibleEdgeMode: visibleEdgeMode,
    tslSurfaceVisibleNormalEdge: visibleEdgeMode === "hard" || visibleEdgeMode === "soft",
    tslSurfaceVisibleSurface: Boolean(visibleTexture),
    tslSurfaceVisibleWidth: cache.visibleWidth || 0,
    tslSurfaceVisibleHeight: cache.visibleHeight || 0,
    tslSurfaceDilation: finalTarget !== target,
    tslSurfaceDilationPasses: finalTarget !== target ? surfaceDilationPasses : 0,
    tslSurfaceProjectedGutterTriangleCount: projectedGutterTriangleCount,
    tslSurfaceProjectedPrimary: useProjectedPrimary,
    tslSurfaceCandidateProjectedGutters: useCandidateProjectedGutters,
    tslSurfaceCandidateProjectedTriangleCount: candidateTriangles.length,
    tslSurfaceBrushColor: options.color
      ? {
          r: Math.max(0, Math.min(255, Math.round(Number(options.color.r) || 0))),
          g: Math.max(0, Math.min(255, Math.round(Number(options.color.g) || 0))),
          b: Math.max(0, Math.min(255, Math.round(Number(options.color.b) || 0)))
        }
      : null,
    tslSurfaceBrushOpacity: Math.max(0, Math.min(1, Number(options.opacity) || 0)),
    tslSurfaceBrushHardness: Math.max(0, Math.min(1, Number(options.hardness) || 0)),
    tslSurfaceBrushScatter: Math.max(0, Math.min(1, Number(options.scatter) || 0)),
    tslSurfaceMaterialName: String(material?.name || ""),
    tslSurfaceMaterialMapName: String(material?.map?.name || ""),
    tslSurfaceMaterialMapIsDisplay: material?.map === (displayTarget || layerDisplayTarget)?.texture,
    tslSurfaceLayerMode: Boolean(layerMode),
    tslSurfaceLayerName: String(editable?.layer?.name || ""),
    tslSurfaceLayerOpacity: editable?.layer?.opacity ?? null,
    tslSurfaceLayerSourceEmpty: emptyLayerSourceTexture,
    tslSurfaceLayerSourceEmptyAtRunStart: layerSourceEmpty,
    tslSurfaceContinuedEmptyLayerStroke: continuedEmptyLayerStroke,
    tslSurfaceStrokeBaseWasEmptyLayer: cache.strokeBaseWasEmptyLayer === true,
    tslSurfaceLayerBaseTextureName: surfaceTextureDebugName(layerBaseTexture),
    tslSurfaceLayerCoordinateReferenceTextureName: surfaceTextureDebugName(layerCoordinateReferenceTexture),
    tslSurfaceLayerDisplayBaseTextureName: surfaceTextureDebugName(layerDisplayBaseTexture),
    tslSurfaceLayerDisplayUsedLiveUnderlay: layerDisplayUsedLiveUnderlay,
    tslSurfaceLayerTarget: Boolean(layerTargetEntry?.target?.texture),
    tslSurfaceLayerPaintRevision: Math.max(0, Math.floor(Number(layerTargetEntry?.paintRevision) || 0)),
    tslSurfaceLayerDisplayComposite: Boolean(layerDisplayTarget?.texture),
    tslSurfaceLayerDisplayMode: layerDisplayMode,
    tslSurfaceDisplayTarget: Boolean((displayTarget || layerDisplayTarget)?.texture),
    tslSurfaceDisplayTextureName: String((displayTarget || layerDisplayTarget)?.texture?.name || ""),
    tslSurfaceDisplayFlipY: (displayTarget || layerDisplayTarget)?.texture?.flipY === true,
    tslSurfaceDisplaySourceIsTarget: (displayTarget || layerDisplayTarget)?.texture
      ?.userData?.texturePaintTslSurfaceDisplaySourceTexture === finalTarget?.texture,
    tslSurfaceProjectedTriangleSamples: projectedTriangleDebugSamples(projectedTriangles),
    tslSurfaceOverlapMaskAmbiguousTexels: overlapMaskAmbiguousTexels,
    tslSurfaceReboundMaterials: reboundMaterialCount,
    tslSurfacePaintSegmentCount: renderPaintSegments.length,
    tslSurfaceShaderSegmentLimit: MAX_TSL_SURFACE_SEGMENTS,
    tslSurfaceShaderBatchCount: useStrokeMaskComposite ? maskRenderBatches.length : 1,
    tslSurfaceAccumulatedPaintSegmentCount: paintSegments.length,
    tslSurfaceCachedTextureStillBound: cachedTextureStillBound,
    tslSurfaceKeptUnboundStrokeTexture: keepUnboundStrokeTexture,
    tslSurfaceSkippedStaleFullSurfaceRender: false,
    tslSurfaceStrokeBaseCopy: cache.texturePaintTslSurfaceLastStrokeBaseCopy || "",
    tslSurfaceBaseCopy: blendOntoBaseTarget
      ? "blend-in-place"
      : useStrokeMaskComposite
      ? "stroke-mask-composite"
      : clearedTransparentBaseTexture
      ? "transparent-clear"
      : copiedBaseTexture
      ? "gpu-copy"
      : shaderCopiedBaseTexture
        ? "shader-copy"
        : "none",
    tslSurfaceBlendInPlace: blendOntoBaseTarget,
    tslSurfaceSourceColorSpace: String(baseTexture?.colorSpace || ""),
    tslSurfaceSourceFlipY: baseTexture?.flipY === true,
    tslSurfaceBaseFlipY: baseTexture?.flipY === true,
    tslSurfaceReferenceFlipY: referenceTexture?.flipY === true,
    tslSurfaceOriginalFlipY: originalMap?.flipY === true,
    tslSurfaceTargetColorSpace: String(finalTarget?.texture?.colorSpace || ""),
    tslSurfaceTargetFlipY: finalTarget?.texture?.flipY === true,
    tslSurfaceTargetGenerateMipmaps: finalTarget?.texture?.generateMipmaps === true,
    tslSurfaceTargetMinFilter: finalTarget?.texture?.minFilter ?? null,
    tslSurfaceTargetMagFilter: finalTarget?.texture?.magFilter ?? null,
    tslSurfaceSourceTextureName: String(baseTexture?.name || ""),
    tslSurfaceSourceTextureImage: baseTexture?.image || baseTexture?.source?.data
      ? {
          width: Math.max(0, Number((baseTexture.image || baseTexture.source?.data)?.width) || 0),
          height: Math.max(0, Number((baseTexture.image || baseTexture.source?.data)?.height) || 0),
          type: String((baseTexture.image || baseTexture.source?.data)?.constructor?.name || "")
        }
      : null,
    tslSurfaceSourceIsMaterialMap: baseWasMaterialMap,
    tslSurfaceSourceIsEditableTexture: baseWasEditableTexture,
    tslSurfaceSourceIsOriginalMap: baseWasOriginalMap,
    tslSurfaceSourceWasMaterialMap: sourceWasMaterialMap,
    tslSurfaceSourceWasEditableTexture: sourceWasEditableTexture,
    tslSurfaceSourceWasOriginalMap: sourceWasOriginalMap,
    tslSurfaceSourceWasCacheOwned: sourceWasCacheOwned,
    tslSurfaceBaseWasCacheOwned: baseWasCacheOwned,
    tslSurfaceFirstSegment: renderPaintSegments[0]
      ? {
          start: renderPaintSegments[0].start || null,
          end: renderPaintSegments[0].end || null,
          radius: renderPaintSegments[0].radius ?? null,
          viewStart: renderPaintSegments[0].viewStart || null,
          viewEnd: renderPaintSegments[0].viewEnd || null,
          viewNormalStart: renderPaintSegments[0].viewNormalStart || null,
          viewNormalEnd: renderPaintSegments[0].viewNormalEnd || null,
          viewRadius: renderPaintSegments[0].viewRadius ?? null,
          componentStart: renderPaintSegments[0].componentStart ?? null,
          componentEnd: renderPaintSegments[0].componentEnd ?? null
        }
      : null,
    tslSurfaceSegmentSamples: renderPaintSegments.slice(0, 8).map((segment) => ({
      start: segment.start || null,
      end: segment.end || null,
      radius: segment.radius ?? null,
      viewStart: segment.viewStart || null,
      viewEnd: segment.viewEnd || null,
      viewNormalStart: segment.viewNormalStart || null,
      viewNormalEnd: segment.viewNormalEnd || null,
      viewRadius: segment.viewRadius ?? null,
      componentStart: segment.componentStart ?? null,
      componentEnd: segment.componentEnd ?? null
    })),
    meshUvTriangleCount: sourceMeshTriangleCount,
    sourceTriangleCount: rawProjectedTriangles.length,
    rawProjectedTriangleCount: rawProjectedTriangles.length,
    filteredProjectedTriangleCount: filteredProjectedTriangles.length,
    sourceMeshCount: surfaceMeshEntries.length,
    filteredTriangleCount: projectedTriangles.length,
    sourceTriangleKind: "source-mesh-uv",
    tslSurfaceUvOccupancy: Boolean(uvOccupancyTexture),
    tslSurfaceUvOccupancyCacheHit: cache.texturePaintTslLastUvOccupancyCacheHit ?? null,
    tslSurfaceUvOccupancyKeyHash: cache.texturePaintTslLastUvOccupancyKeyHash || "",
    tslSurfaceSourceRasterCacheHits: sourceRasterCacheHits,
    tslSurfaceSourceRasterKeyHashes: sourceRasterKeyHashes,
    tslSurfaceOriginalMeshUvRaster: sourceRasterOptions.originalMeshUvRaster === true,
    tslSurfaceSourceRasterGutterPixels: sourceRasterOptions.sourceRasterGutterPixels,
    tslSurfaceSourceRasterClipActive: sourceRasterOptions.originalMeshUvRaster !== true
      && sourceRasterClipSegments(sourceRasterOptions).length > 0,
    tslSurfaceSourceRasterClipPaddingPixels: sourceRasterClipPaddingPixels(sourceRasterOptions),
    tslSurfaceSourceMeshOriginalTriangleCount: sourceMeshOriginalTriangleCount,
    timings: {
      prepareMs: Math.max(0, startMs - functionStartMs),
      dispatchMs: Math.max(0, endMs - startMs),
      readbackMs: 0,
      applyMs: 0,
      postDisplayMs: Math.max(0, completeMs - endMs),
      functionTotalMs: Math.max(0, completeMs - functionStartMs),
      totalMs: Math.max(0, endMs - functionStartMs),
      prepareBreakdown: prepTimings
    }
  };
  if (editor) {
    editor.textureAirbrushLastWebGpuPaintStats = stats;
  }
  exposeSurfaceRunDebug(stats);
  return {
    payload: null,
    sourcePixels: null,
    pixels: null,
    applied: {
      deferred: true,
      byteLength: 0,
      bounds: options.paintBounds || candidate.paintBounds || null
    },
    readbackPromise: null,
    stats
  };
}
