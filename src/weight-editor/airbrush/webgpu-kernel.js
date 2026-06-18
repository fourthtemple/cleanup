import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import {
  TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE,
  TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE,
  clampByte
} from "./math.js";

export const TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE = 8;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function textureAirbrushWebGpuKernelParams(options = {}, defaults = {}) {
  const color = options.color || defaults.color || { r: 255, g: 255, b: 255 };
  const strokeSegments = Array.isArray(options.strokeSegments)
    ? options.strokeSegments
    : [];
  return {
    radiusPixels: Math.max(0.75, finiteNumber(options.radiusPixels, finiteNumber(defaults.radiusPixels, 24))),
    opacity: clamp01(finiteNumber(options.opacity, finiteNumber(defaults.opacity, 0.42))),
    hardness: clamp01(finiteNumber(options.hardness, finiteNumber(defaults.hardness, 0.35))),
    scatter: clamp01(finiteNumber(options.scatter, finiteNumber(defaults.scatter, 0.35))),
    strength: Math.max(0, finiteNumber(options.strength, finiteNumber(defaults.strength, 1))),
    color: {
      r: clampByte(color.r) / 255,
      g: clampByte(color.g) / 255,
      b: clampByte(color.b) / 255
    },
    strokeSegmentCount: Math.max(1, Math.min(TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS, strokeSegments.length || 1))
  };
}

export function textureAirbrushWebGpuDispatchSize(width, height, workgroupSize = TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE) {
  const requestedSize = finiteNumber(workgroupSize, TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE);
  const size = Math.max(
    1,
    Math.floor(requestedSize > 0 ? requestedSize : TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE)
  );
  return {
    x: Math.max(1, Math.ceil(Math.max(1, finiteNumber(width, 1)) / size)),
    y: Math.max(1, Math.ceil(Math.max(1, finiteNumber(height, 1)) / size)),
    workgroupSize: size
  };
}

export function textureAirbrushWebGpuKernelSource({
  maxStrokeSegments = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
  workgroupSize = TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE
} = {}) {
  const maxSegments = Math.max(1, Math.floor(finiteNumber(maxStrokeSegments, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS)));
  const groupSize = Math.max(1, Math.floor(finiteNumber(workgroupSize, TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE)));
  return `
struct BrushParams {
  textureSize: vec2<u32>,
  radiusPixels: f32,
  opacity: f32,
  hardness: f32,
  scatter: f32,
  strength: f32,
  segmentCount: u32,
  color: vec3<f32>,
  paintOrigin: vec2<u32>,
  paintSize: vec2<u32>,
};

struct StrokeSegment {
  start: vec2<f32>,
  end: vec2<f32>,
};

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> brush: BrushParams;
@group(0) @binding(3) var<storage, read> strokeSegments: array<StrokeSegment, ${maxSegments}>;

fn distanceToSegment(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> f32 {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.0001) {
    return distance(point, end);
  }
  let t = clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
  return distance(point, start + segment * t);
}

fn airbrushCoverage(distancePixels: f32) -> f32 {
  let scatter = clamp(brush.scatter, 0.0, 1.0);
  let radius = max(0.75, brush.radiusPixels);
  let haloRadius = radius * (1.0 + scatter * ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE});
  if (distancePixels > haloRadius) {
    return 0.0;
  }
  let hardness = clamp(brush.hardness, 0.0, 1.0);
  let hardRadius = radius * hardness;
  if (distancePixels <= hardRadius) {
    return 1.0;
  }
  let fadeRadius = max(1.0, haloRadius - hardRadius);
  let edge = max(0.0, 1.0 - (distancePixels - hardRadius) / fadeRadius);
  let exponent = ${TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE} - hardness * ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE} + scatter * ${TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE};
  return min(1.0, pow(edge, exponent));
}

@compute @workgroup_size(${groupSize}, ${groupSize}, 1)
fn textureAirbrushPaint(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= brush.paintSize.x || id.y >= brush.paintSize.y) {
    return;
  }
  let pixel = brush.paintOrigin + id.xy;
  if (pixel.x >= brush.textureSize.x || pixel.y >= brush.textureSize.y) {
    return;
  }
  let point = vec2<f32>(f32(pixel.x), f32(pixel.y));
  var distancePixels = 100000.0;
  let count = min(brush.segmentCount, ${maxSegments}u);
  for (var index = 0u; index < count; index = index + 1u) {
    let segment = strokeSegments[index];
    distancePixels = min(distancePixels, distanceToSegment(point, segment.start, segment.end));
  }
  let coverage = airbrushCoverage(distancePixels);
  let alpha = clamp(brush.opacity * brush.strength * coverage, 0.0, 1.0);
  let current = textureLoad(sourceTexture, vec2<i32>(pixel), 0);
  let nextRgb = current.rgb * (1.0 - alpha) + brush.color * alpha;
  textureStore(outputTexture, vec2<i32>(pixel), vec4<f32>(nextRgb, max(current.a, alpha)));
}
`.trim();
}
