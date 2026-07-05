import {
  TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS
} from "./constants.js";
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
  TEXTURE_AIRBRUSH_SOFT_HALO_SCALE,
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
  const visibilityMaskSamples = Array.isArray(options.visibilityMaskSamples)
    ? options.visibilityMaskSamples
    : [];
  const visibilityMaskTriangles = Array.isArray(options.visibilityMaskTriangles)
    ? options.visibilityMaskTriangles
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
    layerMode: options.layerMode === true || defaults.layerMode === true,
    strokeSegmentCount: Math.max(1, Math.min(TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS, strokeSegments.length || 1)),
    visibilitySampleCount: Math.max(0, Math.min(TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS, visibilityMaskSamples.length)),
    visibilityTriangleCount: Math.max(0, Math.min(Math.floor(TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS / 4), visibilityMaskTriangles.length)),
    visibilityMaskStampRadiusPixels: Math.max(0.5, finiteNumber(
      options.visibilityMaskStampRadiusPixels,
      finiteNumber(defaults.visibilityMaskStampRadiusPixels, 0.5)
    )),
    useVisibilityMask: options.useVisibilityMask === true
      || Boolean(options.visibilityMaskPixels)
      || visibilityMaskSamples.length > 0
      || visibilityMaskTriangles.length > 0
      ? 1
      : 0,
    visibilityFeatherRadius: Math.max(0, finiteNumber(
      options.visibilityFeatherRadius,
      finiteNumber(defaults.visibilityFeatherRadius, 0)
    )),
    visibilityMaskThreshold: clamp01(finiteNumber(
      options.visibilityMaskThreshold,
      finiteNumber(defaults.visibilityMaskThreshold, 0.5)
    )),
    visibilityBleedRadius: Math.max(0, finiteNumber(
      options.visibilityBleedRadius,
      finiteNumber(defaults.visibilityBleedRadius, 0)
    )),
    projectedSurfaceMode: options.fullProjectedSurfaceRenderTriangles === true ? 1 : 0
  };
}

export function textureAirbrushWebGpuDispatchSize(
  width,
  height,
  workgroupSize = TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE,
  depth = 1
) {
  const requestedSize = finiteNumber(workgroupSize, TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE);
  const size = Math.max(
    1,
    Math.floor(requestedSize > 0 ? requestedSize : TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE)
  );
  const dispatch = {
    x: Math.max(1, Math.ceil(Math.max(1, finiteNumber(width, 1)) / size)),
    y: Math.max(1, Math.ceil(Math.max(1, finiteNumber(height, 1)) / size)),
    workgroupSize: size
  };
  const z = Math.max(1, Math.floor(finiteNumber(depth, 1)));
  if (z > 1) {
    dispatch.z = z;
  }
  return dispatch;
}

export function textureAirbrushWebGpuProjectedRenderSource({
  maxStrokeSegments = TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS
} = {}) {
  const maxSegments = Math.max(1, Math.floor(finiteNumber(maxStrokeSegments, TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS)));
  const alphaDiscardThreshold = Math.max(0.008, TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD);
  const debugProjectedScreenOnly = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushProjectedScreenOnly");
  const debugProjectedDirectColor = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushProjectedDirectColor");
  return `
struct BrushParams {
  textureSize: vec2<u32>,
  radiusPixels: f32,
  opacity: f32,
  hardness: f32,
  scatter: f32,
  strength: f32,
  segmentCount: u32,
  color: vec4<f32>,
  paintRect: vec4<u32>,
  useVisibilityMask: u32,
  visibilityFeatherRadius: f32,
  visibilityMaskThreshold: f32,
  visibilityBleedRadius: f32,
  visibilitySampleCount: u32,
  visibilitySampleRadius: f32,
  useVisibilitySamples: u32,
  visibilityTriangleCount: u32,
  paintRegionCount: u32,
  paintRegionPixelCount: u32,
  compactPaintRegions: u32,
  compactPaintRegionTriangles: u32,
  projectedSurfaceMode: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

struct StrokeSegment {
  start: vec2<f32>,
  end: vec2<f32>,
  radiusPixels: f32,
  _pad: f32,
};

struct VisibilitySample {
  start: vec2<f32>,
  end: vec2<f32>,
  viewStart: vec4<f32>,
  viewEnd: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uvPoint: vec2<f32>,
  @location(1) @interpolate(flat) triangleIndex: u32,
};

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> brush: BrushParams;
@group(0) @binding(3) var<storage, read> strokeSegments: array<StrokeSegment, ${maxSegments}>;
@group(0) @binding(4) var strokeSourceTexture: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> visibilitySamples: array<VisibilitySample, ${maxSegments}>;
@group(0) @binding(9) var<storage, read> projectedTriangles: array<VisibilitySample>;

fn distanceToSegment(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> f32 {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.0001) {
    return distance(point, end);
  }
  let t = clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
  return distance(point, start + segment * t);
}

fn segmentRatio(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> f32 {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.0001) {
    return 1.0;
  }
  return clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
}

fn airbrushCoverage(distancePixels: f32, radiusPixels: f32) -> f32 {
  let scatter = clamp(brush.scatter, 0.0, 1.0);
  let radius = max(0.75, radiusPixels);
  let hardness = clamp(brush.hardness, 0.0, 1.0);
  let softness = 1.0 - hardness;
  let haloRadius = radius * (1.0 + scatter * ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE} + softness * ${TEXTURE_AIRBRUSH_SOFT_HALO_SCALE});
  if (distancePixels > haloRadius) {
    return 0.0;
  }
  let coreRadius = radius * (${TEXTURE_AIRBRUSH_CORE_MIN_SCALE} + pow(hardness, ${TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER}) * ${TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE});
  if (distancePixels <= coreRadius) {
    return 1.0;
  }
  let fadeRadius = max(1.0, haloRadius - coreRadius);
  let normalized = clamp((distancePixels - coreRadius) / fadeRadius, 0.0, 1.0);
  let exponent = max(0.05, ${TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE} + pow(hardness, ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER}) * ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE} - scatter * ${TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE});
  let shaped = clamp(pow(normalized, exponent), 0.0, 1.0);
  let smoothEdge = shaped * shaped * (3.0 - 2.0 * shaped);
  return min(1.0, max(0.0, 1.0 - smoothEdge));
}

fn paintProgress(color: vec4<f32>, strokeSource: vec4<f32>) -> f32 {
  let brushColor = brush.color.rgb;
  let paintDelta = brushColor - strokeSource.rgb;
  let colorDelta = color.rgb - strokeSource.rgb;
  let colorDenom = dot(paintDelta, paintDelta);
  let colorProgress = select(
    0.0,
    dot(colorDelta, paintDelta) / colorDenom,
    colorDenom > 0.0001
  );
  let alphaProgress = select(
    0.0,
    (color.a - strokeSource.a) / max(0.0001, 1.0 - strokeSource.a),
    strokeSource.a < 0.9999
  );
  let layerMode = brush.color.a > 0.5;
  return select(
    clamp(colorProgress, 0.0, 1.0),
    clamp(alphaProgress, 0.0, 1.0),
    layerMode && strokeSource.a < 0.9999
  );
}

fn visibilityTriangleSlotStride() -> u32 {
  return 4u;
}

fn visibilityTriangleSlot(triangleIndex: u32) -> u32 {
  return brush.visibilitySampleCount + triangleIndex * visibilityTriangleSlotStride();
}

fn visibilityTriangleSlotValid(triangleIndex: u32) -> bool {
  let triangleCount = min(brush.visibilityTriangleCount, ${Math.floor(maxSegments / 4)}u);
  if (triangleIndex >= triangleCount) {
    return false;
  }
  return visibilityTriangleSlot(triangleIndex) + visibilityTriangleSlotStride() - 1u < ${maxSegments}u;
}

fn projectedTriangleSlot(triangleIndex: u32) -> u32 {
  return triangleIndex * visibilityTriangleSlotStride();
}

fn projectedTriangleSlotValid(triangleIndex: u32) -> bool {
  let slot = projectedTriangleSlot(triangleIndex);
  return slot + visibilityTriangleSlotStride() - 1u < arrayLength(&projectedTriangles);
}

fn triangleBarycentric(point: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec4<f32> {
  let v0 = b - a;
  let v1 = c - a;
  let v2 = point - a;
  let denom = v0.x * v1.y - v1.x * v0.y;
  if (abs(denom) <= 0.0001) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let invDenom = 1.0 / denom;
  let u = (v2.x * v1.y - v1.x * v2.y) * invDenom;
  let v = (v0.x * v2.y - v2.x * v0.y) * invDenom;
  let w = 1.0 - u - v;
  let inside = select(0.0, 1.0, u >= -0.0001 && v >= -0.0001 && w >= -0.0001);
  return vec4<f32>(w, u, v, inside);
}

fn rightNormal(edge: vec2<f32>) -> vec2<f32> {
  let edgeLength = length(edge);
  if (edgeLength <= 0.0001) {
    return vec2<f32>(0.0, 0.0);
  }
  let unit = edge / edgeLength;
  return vec2<f32>(unit.y, -unit.x);
}

fn triangleOutwardNormal(edge: vec2<f32>, ccw: bool) -> vec2<f32> {
  let normal = rightNormal(edge);
  return select(-normal, normal, ccw);
}

fn projectedUvGutterRadius() -> f32 {
  // Hidden UV padding must be wider than texture filtering and mip sampling.
  // Fill most of that padding with the same projected surface coverage as the
  // nearest real triangle edge. Fading at the true edge makes UV islands print
  // into soft strokes once the rendered material samples across atlas padding.
  return 16.0;
}

fn projectedUvGutterCoverage(distancePixels: f32) -> f32 {
  let radius = projectedUvGutterRadius();
  let outerFade = min(3.0, max(1.0, radius * 0.125));
  return 1.0 - smoothstep(max(0.0, radius - outerFade), radius + 0.5, distancePixels);
}

fn expandTriangleCorner(
  point: vec2<f32>,
  center: vec2<f32>,
  firstNormal: vec2<f32>,
  secondNormal: vec2<f32>,
  margin: f32
) -> vec2<f32> {
  var direction = firstNormal + secondNormal;
  if (dot(direction, direction) <= 0.0001) {
    direction = point - center;
  }
  if (dot(direction, direction) <= 0.0001) {
    return point;
  }
  direction = normalize(direction);
  let firstDot = abs(dot(direction, firstNormal));
  let secondDot = abs(dot(direction, secondNormal));
  let miterDenom = max(0.35, max(firstDot, secondDot));
  let miterLength = min(margin * 4.0, margin / miterDenom);
  return point + direction * miterLength;
}

fn closestPointOnSegment2d(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> vec2<f32> {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.0001) {
    return start;
  }
  let t = clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
  return start + segment * t;
}

fn closestTriangleEdgePoint(point: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec4<f32> {
  let ab = closestPointOnSegment2d(point, a, b);
  let bc = closestPointOnSegment2d(point, b, c);
  let ca = closestPointOnSegment2d(point, c, a);
  let abDistance = distance(point, ab);
  let bcDistance = distance(point, bc);
  let caDistance = distance(point, ca);
  var closest = ab;
  var closestDistance = abDistance;
  if (bcDistance < closestDistance) {
    closest = bc;
    closestDistance = bcDistance;
  }
  if (caDistance < closestDistance) {
    closest = ca;
    closestDistance = caDistance;
  }
  return vec4<f32>(closest, closestDistance, 1.0);
}

fn safePerspectiveScale(value: f32) -> f32 {
  return select(1.0, clamp(value, 0.000001, 1000000.0), value > 0.000001);
}

fn perspectiveCorrectScreenPoint(
  barycentric: vec4<f32>,
  screenA: vec2<f32>,
  screenB: vec2<f32>,
  screenC: vec2<f32>,
  screenBScale: f32,
  screenCScale: f32
) -> vec2<f32> {
  let bScale = safePerspectiveScale(screenBScale);
  let cScale = safePerspectiveScale(screenCScale);
  let weightedB = barycentric.y * bScale;
  let weightedC = barycentric.z * cScale;
  let denom = max(0.000001, barycentric.x + weightedB + weightedC);
  return (screenA * barycentric.x + screenB * weightedB + screenC * weightedC) / denom;
}

fn distanceToSegment3d(point: vec3<f32>, start: vec3<f32>, end: vec3<f32>) -> f32 {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.000001) {
    return distance(point, end);
  }
  let t = clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
  return distance(point, start + segment * t);
}

fn triangleViewPoint(barycentric: vec4<f32>, first: VisibilitySample, second: VisibilitySample) -> vec4<f32> {
  if (first.viewStart.w <= 0.5 || first.viewEnd.w <= 0.5 || second.viewStart.w <= 0.5) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let viewPoint = first.viewStart.xyz * barycentric.x
    + first.viewEnd.xyz * barycentric.y
    + second.viewStart.xyz * barycentric.z;
  return vec4<f32>(viewPoint, 1.0);
}

fn projectedSurfaceModeActive() -> bool {
  return brush.projectedSurfaceMode != 0u;
}

fn screenProjectedStrokeCoverage(screenPoint: vec2<f32>, surfacePoint: vec4<f32>, screenRadius: f32, sampleCount: u32) -> f32 {
  var coverage = 0.0;
  for (var sampleIndex = 0u; sampleIndex < sampleCount; sampleIndex = sampleIndex + 1u) {
    let sample = visibilitySamples[sampleIndex];
    let distancePixels = distanceToSegment(screenPoint, sample.start, sample.end);
    let screenCoverage = airbrushCoverage(distancePixels, screenRadius);
    var sampleCoverage = screenCoverage;
    if (${debugProjectedScreenOnly ? "false" : "true"} && surfacePoint.w > 0.5 && sample.viewStart.w > 0.5 && sample.viewEnd.w > 0.0001) {
      let surfaceDistance = distanceToSegment3d(surfacePoint.xyz, sample.viewStart.xyz, sample.viewEnd.xyz);
      let surfaceRadius = max(0.0001, sample.viewEnd.w);
      let surfaceDistancePixels = surfaceDistance / surfaceRadius * screenRadius;
      let surfaceCoverage = airbrushCoverage(surfaceDistancePixels, screenRadius);
      let screenHaloRadius = screenRadius * (
        1.0
        + clamp(brush.scatter, 0.0, 1.0) * ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE}
        + (1.0 - clamp(brush.hardness, 0.0, 1.0)) * ${TEXTURE_AIRBRUSH_SOFT_HALO_SCALE}
      );
      let screenGateFade = max(8.0, screenRadius * 0.55);
      let screenGate = 1.0 - smoothstep(screenHaloRadius, screenHaloRadius + screenGateFade, distancePixels);
      sampleCoverage = select(max(screenCoverage, surfaceCoverage), surfaceCoverage * screenGate, projectedSurfaceModeActive());
    } else if (projectedSurfaceModeActive()) {
      sampleCoverage = 0.0;
    }
    coverage = max(coverage, sampleCoverage);
  }
  return coverage;
}

fn triangleVertexPoint(triangleIndex: u32, vertexIndex: u32) -> vec2<f32> {
  if (!projectedTriangleSlotValid(triangleIndex)) {
    return vec2<f32>(-100000.0, -100000.0);
  }
  let triangleSlot = projectedTriangleSlot(triangleIndex);
  let first = projectedTriangles[triangleSlot];
  let second = projectedTriangles[triangleSlot + 1u];
  if (vertexIndex == 0u) {
    return first.start;
  }
  if (vertexIndex == 1u) {
    return first.end;
  }
  return second.start;
}

fn triangleExpandedVertexPoint(triangleIndex: u32, vertexIndex: u32) -> vec2<f32> {
  if (!projectedTriangleSlotValid(triangleIndex)) {
    return vec2<f32>(-100000.0, -100000.0);
  }
  let a = triangleVertexPoint(triangleIndex, 0u);
  let b = triangleVertexPoint(triangleIndex, 1u);
  let c = triangleVertexPoint(triangleIndex, 2u);
  let center = (a + b + c) / 3.0;
  let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let ccw = cross > 0.0;
  let normalAB = triangleOutwardNormal(b - a, ccw);
  let normalBC = triangleOutwardNormal(c - b, ccw);
  let normalCA = triangleOutwardNormal(a - c, ccw);
  let margin = projectedUvGutterRadius();
  if (vertexIndex == 0u) {
    return expandTriangleCorner(a, center, normalCA, normalAB, margin);
  }
  if (vertexIndex == 1u) {
    return expandTriangleCorner(b, center, normalAB, normalBC, margin);
  }
  return expandTriangleCorner(c, center, normalBC, normalCA, margin);
}

@vertex
fn textureAirbrushProjectedVertex(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let triangleIndex = vertexIndex / 3u;
  let localVertex = vertexIndex % 3u;
  let uv = triangleExpandedVertexPoint(triangleIndex, localVertex);
  let size = vec2<f32>(max(1.0, f32(brush.textureSize.x)), max(1.0, f32(brush.textureSize.y)));
  var output: VertexOutput;
  output.position = vec4<f32>(
    uv.x / size.x * 2.0 - 1.0,
    1.0 - uv.y / size.y * 2.0,
    0.0,
    1.0
  );
  output.uvPoint = uv;
  output.triangleIndex = triangleIndex;
  return output;
}

@fragment
fn textureAirbrushProjectedFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let x = clamp(i32(floor(input.uvPoint.x)), 0, i32(brush.textureSize.x) - 1);
  let y = clamp(i32(floor(input.uvPoint.y)), 0, i32(brush.textureSize.y) - 1);
  let pixel = vec2<i32>(x, y);
  let current = textureLoad(sourceTexture, pixel, 0);
  if (!projectedTriangleSlotValid(input.triangleIndex) || brush.useVisibilitySamples == 0u || brush.visibilitySampleCount == 0u) {
    discard;
  }
  let triangleSlot = projectedTriangleSlot(input.triangleIndex);
  let first = projectedTriangles[triangleSlot];
  let second = projectedTriangles[triangleSlot + 1u];
  if (second.end.y <= 0.5) {
    discard;
  }
  let normalCoverage = clamp(second.end.x, 0.0, 1.0);
  if (normalCoverage <= 0.0 && brush.visibilityBleedRadius <= 0.5) {
    discard;
  }
  let barycentric = triangleBarycentric(input.uvPoint, first.start, first.end, second.start);
  var fieldBarycentric = barycentric;
  var gutterFade = 1.0;
  if (barycentric.w <= 0.5) {
    let gutterEdge = closestTriangleEdgePoint(input.uvPoint, first.start, first.end, second.start);
    if (gutterEdge.z > projectedUvGutterRadius()) {
      discard;
    }
    fieldBarycentric = triangleBarycentric(gutterEdge.xy, first.start, first.end, second.start);
    if (fieldBarycentric.w <= 0.5) {
      discard;
    }
    gutterFade = projectedUvGutterCoverage(gutterEdge.z);
    if (gutterFade <= 0.0001) {
      discard;
    }
  }
  let third = projectedTriangles[triangleSlot + 2u];
  let fourth = projectedTriangles[triangleSlot + 3u];
  let screenPoint = perspectiveCorrectScreenPoint(
    fieldBarycentric,
    third.start,
    third.end,
    fourth.start,
    fourth.end.x,
    fourth.end.y
  );
  let surfacePoint = triangleViewPoint(fieldBarycentric, first, second);
  let sampleCount = min(brush.visibilitySampleCount, ${maxSegments}u);
  let screenRadius = max(0.75, brush.visibilitySampleRadius);
  let projectedCoverage = screenProjectedStrokeCoverage(screenPoint, surfacePoint, screenRadius, sampleCount) * gutterFade;
  if (projectedCoverage <= 0.0001) {
    discard;
  }
  let visibilityCoverage = 1.0;
  let strokeSource = textureLoad(strokeSourceTexture, pixel, 0);
  let layerMode = brush.color.a > 0.5;
  let alpha = clamp(brush.opacity * brush.strength * projectedCoverage * visibilityCoverage, 0.0, 1.0);
  let visibilityAlphaCap = max(strokeSource.a, visibilityCoverage);
  let maxAlphaForVisibility = select(
    1.0,
    clamp((visibilityAlphaCap - strokeSource.a) / max(0.0001, 1.0 - strokeSource.a), 0.0, 1.0),
    strokeSource.a < 0.9999
  );
  let effectiveAlpha = min(alpha, maxAlphaForVisibility);
  if (effectiveAlpha <= ${alphaDiscardThreshold}) {
    discard;
  }
  let layerAlpha = effectiveAlpha + strokeSource.a * (1.0 - effectiveAlpha);
  let layerRgb = select(
    vec3<f32>(0.0),
    (brush.color.rgb * effectiveAlpha + strokeSource.rgb * strokeSource.a * (1.0 - effectiveAlpha)) / layerAlpha,
    layerAlpha > 0.0001
  );
  let baseRgb = mix(strokeSource.rgb, brush.color.rgb, effectiveAlpha);
  let baseAlpha = select(
    strokeSource.a,
    max(strokeSource.a, effectiveAlpha),
    strokeSource.a <= 0.02 && effectiveAlpha >= 0.16
  );
  let nextAlpha = select(baseAlpha, layerAlpha, layerMode);
  let nextRgb = select(baseRgb, layerRgb, layerMode);
  let proposed = vec4<f32>(nextRgb, nextAlpha);
  let currentProgress = paintProgress(current, strokeSource);
  let currentColorDistance = dot(current.rgb - brush.color.rgb, current.rgb - brush.color.rgb);
  let proposedColorDistance = dot(proposed.rgb - brush.color.rgb, proposed.rgb - brush.color.rgb);
  if (currentProgress + 0.0001 >= effectiveAlpha && currentColorDistance <= proposedColorDistance + 0.0001) {
    discard;
  }
  return ${debugProjectedDirectColor ? "proposed" : "vec4<f32>(effectiveAlpha, effectiveAlpha, effectiveAlpha, effectiveAlpha)"};
}

@fragment
fn textureAirbrushProjectedMaskFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  if (!projectedTriangleSlotValid(input.triangleIndex)) {
    discard;
  }
  let triangleSlot = projectedTriangleSlot(input.triangleIndex);
  let first = projectedTriangles[triangleSlot];
  let second = projectedTriangles[triangleSlot + 1u];
  if (second.end.y <= 0.5) {
    discard;
  }
  let normalCoverage = clamp(second.end.x, 0.0, 1.0);
  if (normalCoverage <= 0.0 && brush.visibilityBleedRadius <= 0.5) {
    discard;
  }
  let barycentric = triangleBarycentric(input.uvPoint, first.start, first.end, second.start);
  if (barycentric.w <= 0.5) {
    discard;
  }
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`.trim();
}

export function textureAirbrushWebGpuKernelSource({
  maxStrokeSegments = TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  workgroupSize = TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE
} = {}) {
  const maxSegments = Math.max(1, Math.floor(finiteNumber(maxStrokeSegments, TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS)));
  const groupSize = Math.max(1, Math.floor(finiteNumber(workgroupSize, TEXTURE_AIRBRUSH_WEBGPU_WORKGROUP_SIZE)));
  const alphaDiscardThreshold = Math.max(0.008, TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD);
  const debugBypassVisibility = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushBypassVisibility");
  const debugForcePaintBounds = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushForcePaintBounds");
  const debugForceOrigin = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushForceOrigin");
  const debugProjectedScreenOnly = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushProjectedScreenOnly");
  return `
struct BrushParams {
  textureSize: vec2<u32>,
  radiusPixels: f32,
  opacity: f32,
  hardness: f32,
  scatter: f32,
  strength: f32,
  segmentCount: u32,
  color: vec4<f32>,
  paintRect: vec4<u32>,
  useVisibilityMask: u32,
  visibilityFeatherRadius: f32,
  visibilityMaskThreshold: f32,
  visibilityBleedRadius: f32,
  visibilitySampleCount: u32,
  visibilitySampleRadius: f32,
  useVisibilitySamples: u32,
  visibilityTriangleCount: u32,
  paintRegionCount: u32,
  paintRegionPixelCount: u32,
  compactPaintRegions: u32,
  compactPaintRegionTriangles: u32,
  projectedSurfaceMode: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

struct StrokeSegment {
  start: vec2<f32>,
  end: vec2<f32>,
  radiusPixels: f32,
  _pad: f32,
};

struct VisibilitySample {
  start: vec2<f32>,
  end: vec2<f32>,
  viewStart: vec4<f32>,
  viewEnd: vec4<f32>,
};

struct PixelLookup {
  pixel: vec2<u32>,
  valid: u32,
};

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> brush: BrushParams;
@group(0) @binding(3) var<storage, read> strokeSegments: array<StrokeSegment, ${maxSegments}>;
@group(0) @binding(4) var strokeSourceTexture: texture_2d<f32>;
@group(0) @binding(5) var visibilityMaskTexture: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> visibilitySamples: array<VisibilitySample, ${maxSegments}>;
@group(0) @binding(7) var<storage, read> paintRegions: array<vec4<u32>, ${TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS}>;

fn distanceToSegment(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> f32 {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.0001) {
    return distance(point, end);
  }
  let t = clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
  return distance(point, start + segment * t);
}

fn segmentRatio(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> f32 {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.0001) {
    return 1.0;
  }
  return clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
}

fn airbrushCoverage(distancePixels: f32, radiusPixels: f32) -> f32 {
  let scatter = clamp(brush.scatter, 0.0, 1.0);
  let radius = max(0.75, radiusPixels);
  let hardness = clamp(brush.hardness, 0.0, 1.0);
  let softness = 1.0 - hardness;
  let haloRadius = radius * (1.0 + scatter * ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE} + softness * ${TEXTURE_AIRBRUSH_SOFT_HALO_SCALE});
  if (distancePixels > haloRadius) {
    return 0.0;
  }
  // Airbrush hardness should firm up the spray center without turning the
  // whole nominal radius into a stamped opaque disk. Scatter extends the halo
  // and keeps the outer spray soft.
  let coreRadius = radius * (${TEXTURE_AIRBRUSH_CORE_MIN_SCALE} + pow(hardness, ${TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER}) * ${TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE});
  if (distancePixels <= coreRadius) {
    return 1.0;
  }
  let fadeRadius = max(1.0, haloRadius - coreRadius);
  let normalized = clamp((distancePixels - coreRadius) / fadeRadius, 0.0, 1.0);
  let exponent = max(0.05, ${TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE} + pow(hardness, ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER}) * ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE} - scatter * ${TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE});
  let shaped = clamp(pow(normalized, exponent), 0.0, 1.0);
  let smoothEdge = shaped * shaped * (3.0 - 2.0 * shaped);
  return min(1.0, max(0.0, 1.0 - smoothEdge));
}

fn paintProgress(color: vec4<f32>, strokeSource: vec4<f32>) -> f32 {
  let brushColor = brush.color.rgb;
  let paintDelta = brushColor - strokeSource.rgb;
  let colorDelta = color.rgb - strokeSource.rgb;
  let colorDenom = dot(paintDelta, paintDelta);
  let colorProgress = select(
    0.0,
    dot(colorDelta, paintDelta) / colorDenom,
    colorDenom > 0.0001
  );
  let alphaProgress = select(
    0.0,
    (color.a - strokeSource.a) / max(0.0001, 1.0 - strokeSource.a),
    strokeSource.a < 0.9999
  );
  let layerMode = brush.color.a > 0.5;
  return select(
    clamp(colorProgress, 0.0, 1.0),
    clamp(alphaProgress, 0.0, 1.0),
    layerMode && strokeSource.a < 0.9999
  );
}

fn visibilityTriangleSlotStride() -> u32 {
  return 4u;
}

fn visibilityTriangleSlot(triangleIndex: u32) -> u32 {
  return brush.visibilitySampleCount + triangleIndex * visibilityTriangleSlotStride();
}

fn visibilityTriangleSlotValid(triangleIndex: u32) -> bool {
  let triangleCount = min(brush.visibilityTriangleCount, ${Math.floor(maxSegments / 4)}u);
  if (triangleIndex >= triangleCount) {
    return false;
  }
  return visibilityTriangleSlot(triangleIndex) + visibilityTriangleSlotStride() - 1u < ${maxSegments}u;
}

fn triangleBarycentric(point: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec4<f32> {
  let v0 = b - a;
  let v1 = c - a;
  let v2 = point - a;
  let denom = v0.x * v1.y - v1.x * v0.y;
  if (abs(denom) <= 0.0001) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let invDenom = 1.0 / denom;
  let u = (v2.x * v1.y - v1.x * v2.y) * invDenom;
  let v = (v0.x * v2.y - v2.x * v0.y) * invDenom;
  let w = 1.0 - u - v;
  let inside = select(0.0, 1.0, u >= -0.0001 && v >= -0.0001 && w >= -0.0001);
  return vec4<f32>(w, u, v, inside);
}

fn closestPointOnSegment2d(point: vec2<f32>, start: vec2<f32>, end: vec2<f32>) -> vec2<f32> {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.0001) {
    return start;
  }
  let t = clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
  return start + segment * t;
}

fn closestTriangleEdgePoint(point: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec4<f32> {
  let ab = closestPointOnSegment2d(point, a, b);
  let bc = closestPointOnSegment2d(point, b, c);
  let ca = closestPointOnSegment2d(point, c, a);
  let abDistance = distance(point, ab);
  let bcDistance = distance(point, bc);
  let caDistance = distance(point, ca);
  var closest = ab;
  var closestDistance = abDistance;
  if (bcDistance < closestDistance) {
    closest = bc;
    closestDistance = bcDistance;
  }
  if (caDistance < closestDistance) {
    closest = ca;
    closestDistance = caDistance;
  }
  return vec4<f32>(closest, closestDistance, 1.0);
}

fn safePerspectiveScale(value: f32) -> f32 {
  return select(1.0, clamp(value, 0.000001, 1000000.0), value > 0.000001);
}

fn perspectiveCorrectScreenPoint(
  barycentric: vec4<f32>,
  screenA: vec2<f32>,
  screenB: vec2<f32>,
  screenC: vec2<f32>,
  screenBScale: f32,
  screenCScale: f32
) -> vec2<f32> {
  let bScale = safePerspectiveScale(screenBScale);
  let cScale = safePerspectiveScale(screenCScale);
  let weightedB = barycentric.y * bScale;
  let weightedC = barycentric.z * cScale;
  let denom = max(0.000001, barycentric.x + weightedB + weightedC);
  return (screenA * barycentric.x + screenB * weightedB + screenC * weightedC) / denom;
}

fn distanceToSegment3d(point: vec3<f32>, start: vec3<f32>, end: vec3<f32>) -> f32 {
  let segment = end - start;
  let lengthSq = dot(segment, segment);
  if (lengthSq <= 0.000001) {
    return distance(point, end);
  }
  let t = clamp(dot(point - start, segment) / lengthSq, 0.0, 1.0);
  return distance(point, start + segment * t);
}

fn triangleViewPoint(barycentric: vec4<f32>, first: VisibilitySample, second: VisibilitySample) -> vec4<f32> {
  if (first.viewStart.w <= 0.5 || first.viewEnd.w <= 0.5 || second.viewStart.w <= 0.5) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let viewPoint = first.viewStart.xyz * barycentric.x
    + first.viewEnd.xyz * barycentric.y
    + second.viewStart.xyz * barycentric.z;
  return vec4<f32>(viewPoint, 1.0);
}

fn projectedSurfaceModeActive() -> bool {
  return brush.projectedSurfaceMode != 0u;
}

fn screenProjectedStrokeCoverage(screenPoint: vec2<f32>, surfacePoint: vec4<f32>, screenRadius: f32, sampleCount: u32) -> f32 {
  var coverage = 0.0;
  for (var sampleIndex = 0u; sampleIndex < sampleCount; sampleIndex = sampleIndex + 1u) {
    let sample = visibilitySamples[sampleIndex];
    let distancePixels = distanceToSegment(screenPoint, sample.start, sample.end);
    let screenCoverage = airbrushCoverage(distancePixels, screenRadius);
    var sampleCoverage = screenCoverage;
    if (${debugProjectedScreenOnly ? "false" : "true"} && surfacePoint.w > 0.5 && sample.viewStart.w > 0.5 && sample.viewEnd.w > 0.0001) {
      let surfaceDistance = distanceToSegment3d(surfacePoint.xyz, sample.viewStart.xyz, sample.viewEnd.xyz);
      let surfaceRadius = max(0.0001, sample.viewEnd.w);
      let surfaceDistancePixels = surfaceDistance / surfaceRadius * screenRadius;
      let surfaceCoverage = airbrushCoverage(surfaceDistancePixels, screenRadius);
      let screenHaloRadius = screenRadius * (
        1.0
        + clamp(brush.scatter, 0.0, 1.0) * ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE}
        + (1.0 - clamp(brush.hardness, 0.0, 1.0)) * ${TEXTURE_AIRBRUSH_SOFT_HALO_SCALE}
      );
      let screenGateFade = max(8.0, screenRadius * 0.55);
      let screenGate = 1.0 - smoothstep(screenHaloRadius, screenHaloRadius + screenGateFade, distancePixels);
      sampleCoverage = select(max(screenCoverage, surfaceCoverage), surfaceCoverage * screenGate, projectedSurfaceModeActive());
    } else if (projectedSurfaceModeActive()) {
      sampleCoverage = 0.0;
    }
    coverage = max(coverage, sampleCoverage);
  }
  return coverage;
}

fn triangleVisibilityCoverage(point: vec2<f32>, a: vec2<f32>, b: vec2<f32>, c: vec2<f32>, facingCoverage: f32, allowBleed: bool) -> f32 {
  let normalCoverage = clamp(facingCoverage, 0.0, 1.0);
  if (normalCoverage <= 0.0) {
    return 0.0;
  }
  let barycentric = triangleBarycentric(point, a, b, c);
  if (barycentric.w > 0.5) {
    // Camera-facing triangle interiors are a paint permission, not a UV
    // opacity stencil. Strongly facing interiors paint at full strength, while
    // soft visible-edge mode can still use the precomputed normal-facing
    // coverage near the actual camera-facing cutoff.
    return select(normalCoverage, 1.0, normalCoverage >= 0.985);
  }
  if (!allowBleed) {
    return 0.0;
  }
  let bleed = max(0.0, brush.visibilityBleedRadius);
  if (bleed <= 0.5) {
    return 0.0;
  }
  let edgeDistance = min(
    distanceToSegment(point, a, b),
    min(
      distanceToSegment(point, b, c),
      distanceToSegment(point, c, a)
    )
  );
  if (edgeDistance > bleed) {
    return 0.0;
  }
  let normalized = clamp(edgeDistance / max(0.5, bleed), 0.0, 1.0);
  let hiddenEdgeCoverage = 1.0 - normalized * normalized * (3.0 - 2.0 * normalized);
  return clamp(hiddenEdgeCoverage * 0.88 * normalCoverage, 0.0, 0.88);
}

fn visibleTriangleMaskAt(pixel: vec2<u32>, allowBleed: bool) -> f32 {
  if (brush.visibilityTriangleCount == 0u) {
    return 0.0;
  }
  let point = vec2<f32>(f32(pixel.x), f32(pixel.y));
  var triangleValue = 0.0;
  let triangleStride = visibilityTriangleSlotStride();
  let triangleCount = min(brush.visibilityTriangleCount, ${Math.floor(maxSegments / 4)}u);
  for (var triangleIndex = 0u; triangleIndex < triangleCount; triangleIndex = triangleIndex + 1u) {
    let triangleSlot = brush.visibilitySampleCount + triangleIndex * triangleStride;
    if (triangleSlot + triangleStride - 1u >= ${maxSegments}u) {
      continue;
    }
    let first = visibilitySamples[triangleSlot];
    let second = visibilitySamples[triangleSlot + 1u];
    let a = first.start;
    let b = first.end;
    let c = second.start;
    triangleValue = max(triangleValue, triangleVisibilityCoverage(point, a, b, c, second.end.x, allowBleed));
  }
  return triangleValue;
}

fn visibleTriangleMaskAtIndex(pixel: vec2<u32>, triangleIndex: u32, allowBleed: bool) -> f32 {
  if (!visibilityTriangleSlotValid(triangleIndex)) {
    return 0.0;
  }
  let point = vec2<f32>(f32(pixel.x), f32(pixel.y));
  let triangleSlot = visibilityTriangleSlot(triangleIndex);
  let first = visibilitySamples[triangleSlot];
  let second = visibilitySamples[triangleSlot + 1u];
  return triangleVisibilityCoverage(point, first.start, first.end, second.start, second.end.x, allowBleed);
}

fn screenProjectedCoverageActive() -> bool {
  return brush.visibilityTriangleCount > 0u && brush.useVisibilitySamples != 0u && brush.visibilitySampleCount > 0u;
}

fn textureStrokeAirbrushCoverageWithRadiusLimit(point: vec2<f32>, radiusLimit: f32) -> f32 {
  var coverage = 0.0;
  let count = min(brush.segmentCount, ${maxSegments}u);
  let safeRadiusLimit = max(0.75, radiusLimit);
  for (var index = 0u; index < count; index = index + 1u) {
    let segment = strokeSegments[index];
    let segmentRadius = min(
      select(brush.radiusPixels, segment.radiusPixels, segment.radiusPixels > 0.0),
      safeRadiusLimit
    );
    let distancePixels = distanceToSegment(point, segment.start, segment.end);
    coverage = max(coverage, airbrushCoverage(distancePixels, segmentRadius));
  }
  return coverage;
}

fn textureStrokeAirbrushCoverage(point: vec2<f32>) -> f32 {
  return textureStrokeAirbrushCoverageWithRadiusLimit(point, f32(max(brush.textureSize.x, brush.textureSize.y)));
}

fn screenProjectedAirbrushCoverage(point: vec2<f32>, screenProjectedActive: bool) -> f32 {
  if (!screenProjectedActive || brush.visibilityTriangleCount == 0u || brush.useVisibilitySamples == 0u || brush.visibilitySampleCount == 0u) {
    return 0.0;
  }
  let sampleCount = min(brush.visibilitySampleCount, ${maxSegments}u);
  let triangleStride = visibilityTriangleSlotStride();
  let triangleCount = min(brush.visibilityTriangleCount, ${Math.floor(maxSegments / 4)}u);
  var interiorCoverage = 0.0;
  var gutterCoverage = 0.0;
  var insideAnyProjectedTriangle = false;
  let gutterRadius = max(0.0, brush.visibilityBleedRadius);
  for (var triangleIndex = 0u; triangleIndex < triangleCount; triangleIndex = triangleIndex + 1u) {
    let triangleSlot = brush.visibilitySampleCount + triangleIndex * triangleStride;
    if (triangleSlot + triangleStride - 1u >= ${maxSegments}u) {
      continue;
    }
    let first = visibilitySamples[triangleSlot];
    let second = visibilitySamples[triangleSlot + 1u];
    if (second.end.y <= 0.5) {
      continue;
    }
    let barycentric = triangleBarycentric(point, first.start, first.end, second.start);
    if (barycentric.w > 0.5) {
      let third = visibilitySamples[triangleSlot + 2u];
      let fourth = visibilitySamples[triangleSlot + 3u];
      let screenPoint = perspectiveCorrectScreenPoint(
        barycentric,
        third.start,
        third.end,
        fourth.start,
        fourth.end.x,
        fourth.end.y
      );
      let surfacePoint = triangleViewPoint(barycentric, first, second);
      let screenRadius = max(0.75, brush.visibilitySampleRadius);
      insideAnyProjectedTriangle = true;
      interiorCoverage = max(interiorCoverage, screenProjectedStrokeCoverage(screenPoint, surfacePoint, screenRadius, sampleCount));
    } else if (gutterRadius > 0.5) {
      let third = visibilitySamples[triangleSlot + 2u];
      let fourth = visibilitySamples[triangleSlot + 3u];
      let gutterEdge = closestTriangleEdgePoint(point, first.start, first.end, second.start);
      if (gutterEdge.z <= gutterRadius) {
        let edgeBarycentric = triangleBarycentric(gutterEdge.xy, first.start, first.end, second.start);
        let edgeScreenPoint = perspectiveCorrectScreenPoint(
          edgeBarycentric,
          third.start,
          third.end,
          fourth.start,
          fourth.end.x,
          fourth.end.y
        );
        let edgeSurfacePoint = triangleViewPoint(edgeBarycentric, first, second);
        let screenRadius = max(0.75, brush.visibilitySampleRadius);
        let gutterOuterFade = min(3.0, max(1.0, gutterRadius * 0.125));
        let gutterFade = 1.0 - smoothstep(max(0.0, gutterRadius - gutterOuterFade), gutterRadius, gutterEdge.z);
        gutterCoverage = max(
          gutterCoverage,
          screenProjectedStrokeCoverage(edgeScreenPoint, edgeSurfacePoint, screenRadius, sampleCount) * gutterFade
        );
      }
    }
  }
  // Gutter coverage is only for unrendered UV padding around projected
  // triangles. If this texel is inside any uploaded visible triangle, ignore
  // neighboring edge bleed so triangle edges cannot become visible brush shape.
  return select(gutterCoverage, interiorCoverage, insideAnyProjectedTriangle);
}

fn screenProjectedAirbrushCoverageForTriangle(
  point: vec2<f32>,
  triangleIndex: u32,
  allowGutter: bool,
  maxGutterRadius: f32
) -> f32 {
  if (!visibilityTriangleSlotValid(triangleIndex) || brush.useVisibilitySamples == 0u || brush.visibilitySampleCount == 0u) {
    return 0.0;
  }
  let triangleSlot = visibilityTriangleSlot(triangleIndex);
  let first = visibilitySamples[triangleSlot];
  let second = visibilitySamples[triangleSlot + 1u];
  if (second.end.y <= 0.5) {
    return 0.0;
  }
  let sampleCount = min(brush.visibilitySampleCount, ${maxSegments}u);
  let barycentric = triangleBarycentric(point, first.start, first.end, second.start);
  let third = visibilitySamples[triangleSlot + 2u];
  let fourth = visibilitySamples[triangleSlot + 3u];
  let screenRadius = max(0.75, brush.visibilitySampleRadius);
  if (barycentric.w > 0.5) {
    let screenPoint = perspectiveCorrectScreenPoint(
      barycentric,
      third.start,
      third.end,
      fourth.start,
      fourth.end.x,
      fourth.end.y
    );
    let surfacePoint = triangleViewPoint(barycentric, first, second);
    return screenProjectedStrokeCoverage(screenPoint, surfacePoint, screenRadius, sampleCount);
  }
  let gutterRadius = min(max(0.0, brush.visibilityBleedRadius), max(0.0, maxGutterRadius));
  if (!allowGutter || gutterRadius <= 0.5) {
    return 0.0;
  }
  let gutterEdge = closestTriangleEdgePoint(point, first.start, first.end, second.start);
  if (gutterEdge.z > gutterRadius) {
    return 0.0;
  }
  let edgeBarycentric = triangleBarycentric(gutterEdge.xy, first.start, first.end, second.start);
  let edgeScreenPoint = perspectiveCorrectScreenPoint(
    edgeBarycentric,
    third.start,
    third.end,
    fourth.start,
    fourth.end.x,
    fourth.end.y
  );
  let edgeSurfacePoint = triangleViewPoint(edgeBarycentric, first, second);
  let gutterOuterFade = min(3.0, max(1.0, gutterRadius * 0.125));
  let gutterFade = 1.0 - smoothstep(max(0.0, gutterRadius - gutterOuterFade), gutterRadius, gutterEdge.z);
  return screenProjectedStrokeCoverage(edgeScreenPoint, edgeSurfacePoint, screenRadius, sampleCount) * gutterFade;
}

fn visibleTriangleMaskAtOffset(pixel: vec2<u32>, offset: vec2<i32>, allowBleed: bool) -> f32 {
  let x = clamp(i32(pixel.x) + offset.x, 0, i32(brush.textureSize.x) - 1);
  let y = clamp(i32(pixel.y) + offset.y, 0, i32(brush.textureSize.y) - 1);
  return visibleTriangleMaskAt(vec2<u32>(u32(x), u32(y)), allowBleed);
}

fn visibleMaskAt(pixel: vec2<u32>, screenProjectedActive: bool) -> f32 {
  var maskValue = 0.0;
  var hasProceduralMask = false;
  var hasTriangleMask = false;
  if (brush.visibilityTriangleCount > 0u) {
    let triangleValue = visibleTriangleMaskAt(pixel, true);
    maskValue = max(maskValue, triangleValue);
    hasProceduralMask = true;
    hasTriangleMask = true;
  }
  if (brush.useVisibilitySamples != 0u && brush.visibilitySampleCount > 0u && !screenProjectedActive) {
    let point = vec2<f32>(f32(pixel.x), f32(pixel.y));
    let radius = max(0.5, brush.visibilitySampleRadius);
    var value = 0.0;
    let count = min(brush.visibilitySampleCount, ${maxSegments}u);
    for (var index = 0u; index < count; index = index + 1u) {
      let sample = visibilitySamples[index];
      let distancePixels = distanceToSegment(point, sample.start, sample.end);
      if (distancePixels <= radius) {
        let normalized = distancePixels / radius;
        value = max(value, clamp(exp(-0.5 * pow(normalized * 2.4, 2.0)), 0.0, 1.0));
      }
    }
    if (hasTriangleMask && (brush.visibilityBleedRadius > 0.5 || brush.visibilityFeatherRadius > 0.5)) {
      // In soft mode, samples may fill a small amount of tooth between known
      // camera-facing triangles. In hard mode they must not promote a texel
      // whose triangle/normal mask is zero.
      let sampleSoftCap = max(maskValue, 0.22);
      maskValue = max(maskValue, min(value, sampleSoftCap));
    } else if (!hasTriangleMask) {
      maskValue = max(maskValue, value);
    }
    hasProceduralMask = true;
  }
  if (hasProceduralMask) {
    return maskValue;
  }
  let mask = textureLoad(visibilityMaskTexture, vec2<i32>(pixel), 0);
  return max(max(mask.r, mask.g), max(mask.b, mask.a));
}

fn visibleMaskAtOffset(pixel: vec2<u32>, offset: vec2<i32>, screenProjectedActive: bool) -> f32 {
  let x = clamp(i32(pixel.x) + offset.x, 0, i32(brush.textureSize.x) - 1);
  let y = clamp(i32(pixel.y) + offset.y, 0, i32(brush.textureSize.y) - 1);
  return visibleMaskAt(vec2<u32>(u32(x), u32(y)), screenProjectedActive);
}

fn visibleSampleMaskAt(pixel: vec2<u32>) -> f32 {
  if (brush.useVisibilitySamples == 0u || brush.visibilitySampleCount == 0u) {
    return 0.0;
  }
  let point = vec2<f32>(f32(pixel.x), f32(pixel.y));
  let radius = max(0.5, brush.visibilitySampleRadius);
  var value = 0.0;
  let count = min(brush.visibilitySampleCount, ${maxSegments}u);
  for (var index = 0u; index < count; index = index + 1u) {
    let sample = visibilitySamples[index];
    let distancePixels = distanceToSegment(point, sample.start, sample.end);
    if (distancePixels <= radius) {
      let normalized = distancePixels / radius;
      value = max(value, clamp(exp(-0.5 * pow(normalized * 2.4, 2.0)), 0.0, 1.0));
    }
  }
  return value;
}

fn visibilitySamplePermission(pixel: vec2<u32>, threshold: f32, screenProjectedActive: bool) -> f32 {
  if (screenProjectedActive) {
    let screenCoverage = screenProjectedAirbrushCoverage(vec2<f32>(f32(pixel.x), f32(pixel.y)), true);
    if (screenCoverage <= 0.0001) {
      return 0.0;
    }
    // Projected coverage is already the brush alpha. Visibility is only a
    // camera-facing permission gate; thresholding projected coverage here
    // turns soft halos into hard seams, rectangles, and triangle edges.
    return 1.0;
  }
  let sampleCoverage = visibleSampleMaskAt(pixel);
  if (sampleCoverage <= threshold) {
    return 0.0;
  }
  // The sampled live stroke is a continuous camera-facing permission field, not
  // a triangle-opacity stencil. Use its own rolloff as the soft permission so
  // missing/quantized triangle slots do not print as plaid fragments.
  return smoothstep(threshold, max(threshold + 0.0001, 1.0), sampleCoverage);
}

fn visibilitySamplePermissionForTriangle(
  pixel: vec2<u32>,
  threshold: f32,
  triangleIndex: u32,
  allowGutter: bool,
  maxGutterRadius: f32
) -> f32 {
  let screenCoverage = screenProjectedAirbrushCoverageForTriangle(
    vec2<f32>(f32(pixel.x), f32(pixel.y)),
    triangleIndex,
    allowGutter,
    maxGutterRadius
  );
  if (screenCoverage <= 0.0001) {
    return 0.0;
  }
  return 1.0;
}

fn visibleMaskBlurredCoverage(pixel: vec2<u32>, radius: f32, screenProjectedActive: bool) -> f32 {
  let center = visibleMaskAt(pixel, screenProjectedActive);
  let blurRadius = max(0.0, radius);
  if (blurRadius <= 0.5) {
    return center;
  }

  let innerStep = i32(max(1.0, floor(blurRadius * 0.25 + 0.5)));
  let nearStep = i32(max(1.0, floor(blurRadius * 0.5 + 0.5)));
  let farStep = i32(max(f32(nearStep + 1), floor(blurRadius + 0.5)));
  var weighted = center * 0.227027;
  var weight = 0.227027;

  let innerWeight = 0.080000;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(innerStep, 0), screenProjectedActive) * innerWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(-innerStep, 0), screenProjectedActive) * innerWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(0, innerStep), screenProjectedActive) * innerWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(0, -innerStep), screenProjectedActive) * innerWeight;
  weight = weight + innerWeight * 4.0;

  let nearWeight = 0.097603;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(nearStep, 0), screenProjectedActive) * nearWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(-nearStep, 0), screenProjectedActive) * nearWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(0, nearStep), screenProjectedActive) * nearWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(0, -nearStep), screenProjectedActive) * nearWeight;
  weight = weight + nearWeight * 4.0;

  let diagonalWeight = 0.059634;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(nearStep, nearStep), screenProjectedActive) * diagonalWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(nearStep, -nearStep), screenProjectedActive) * diagonalWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(-nearStep, nearStep), screenProjectedActive) * diagonalWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(-nearStep, -nearStep), screenProjectedActive) * diagonalWeight;
  weight = weight + diagonalWeight * 4.0;

  let farWeight = 0.027027;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(farStep, 0), screenProjectedActive) * farWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(-farStep, 0), screenProjectedActive) * farWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(0, farStep), screenProjectedActive) * farWeight;
  weighted = weighted + visibleMaskAtOffset(pixel, vec2<i32>(0, -farStep), screenProjectedActive) * farWeight;
  weight = weight + farWeight * 4.0;

  let blurredVisibility = clamp(weighted / max(weight, 0.0001), 0.0, 1.0);
  return blurredVisibility;
}

fn visibleMaskFeatherCoverage(pixel: vec2<u32>, screenProjectedActive: bool) -> f32 {
  if (${debugBypassVisibility ? "true" : "false"}) {
    return 1.0;
  }
  if (brush.useVisibilityMask == 0u) {
    return 1.0;
  }

  // The visibility mask is a permission source. Center-visible UV texels paint
  // normally in solid interiors. Do not attenuate a camera-facing center texel
  // from blurred neighbor triangles: the live mask uploads only a bounded local
  // triangle list, so treating missing neighbors as alpha would print the mesh
  // triangulation/UV layout into broad strokes.
  let threshold = clamp(brush.visibilityMaskThreshold, 0.0, 1.0);
  let bleed = max(0.0, brush.visibilityBleedRadius);

  if (brush.visibilityTriangleCount > 0u) {
    // DO NOT PAINT ON NON CAMERA FACING SIDES.
    // A texel must be inside a camera-facing normal-observable triangle before
    // it can paint at full strength. Hard mode keeps that permission binary.
    // Soft mode feathers even center-visible texels against the local
    // camera-facing mask so real normal cutoffs do not become rectangular UV
    // slabs, while the continuous projected stroke still bridges ordinary
    // uploaded triangle seams.
    let center = visibleTriangleMaskAt(pixel, false);
    if (center > threshold) {
      if (screenProjectedActive) {
        // Projected strokes get their visible falloff from the continuous
        // screen-space brush field. Once a projected triangle authorizes this
        // texel, keep the interior gate binary so per-triangle normal coverage
        // cannot print UV islands, triangle borders, or paint-region slabs into
        // broad soft strokes. Actual camera-facing cutoffs are handled by the
        // absence of authorized projected triangles plus the local gutter path.
        return 1.0;
      }
      let softRadius = max(brush.visibilityFeatherRadius, bleed);
      if (softRadius <= 0.5) {
        return center;
      }
      let blurredVisibility = visibleMaskBlurredCoverage(pixel, softRadius, screenProjectedActive);
      let softened = smoothstep(threshold, 1.0, blurredVisibility);
      return clamp(max(softened, min(center, 0.18)), 0.0, center);
    }
    if (bleed <= 0.5 && brush.visibilityFeatherRadius <= 0.5) {
      return 0.0;
    }
    let samplePermission = visibilitySamplePermission(pixel, threshold, screenProjectedActive);
    if (samplePermission > 0.0) {
      return samplePermission;
    }
    return 0.0;
  }

  let center = visibleMaskAt(pixel, screenProjectedActive);
  let centerAllowed = center > threshold;
  if (!centerAllowed) {
    // Respect the camera-facing normal cutoff. Soft mode can blend a texel that
    // already has explicit observable coverage down to zero, but it must not
    // blur neighboring visible coverage into a texel whose current normal is
    // unobservable/back-facing.
    return 0.0;
  }

  let feather = max(0.0, brush.visibilityFeatherRadius);
  if (centerAllowed && feather <= 0.5) {
    return 1.0;
  }

  let blurRadius = select(bleed, feather, centerAllowed);
  let blurredVisibility = visibleMaskBlurredCoverage(pixel, blurRadius, screenProjectedActive);
  let softened = smoothstep(threshold, 1.0, blurredVisibility);
  return select(softened, max(center, softened), centerAllowed);
}

fn visibleMaskFeatherCoverageForTriangle(
  pixel: vec2<u32>,
  triangleIndex: u32,
  screenProjectedActive: bool,
  allowGutter: bool,
  maxGutterRadius: f32
) -> f32 {
  if (${debugBypassVisibility ? "true" : "false"}) {
    return 1.0;
  }
  if (brush.useVisibilityMask == 0u) {
    return 1.0;
  }
  let threshold = clamp(brush.visibilityMaskThreshold, 0.0, 1.0);
  let bleed = max(0.0, brush.visibilityBleedRadius);
  let center = visibleTriangleMaskAtIndex(pixel, triangleIndex, false);
  if (center > threshold) {
    if (screenProjectedActive) {
      return 1.0;
    }
    let softRadius = max(brush.visibilityFeatherRadius, bleed);
    if (softRadius <= 0.5) {
      return center;
    }
    return center;
  }
  if (bleed <= 0.5 && brush.visibilityFeatherRadius <= 0.5) {
    return 0.0;
  }
  if (!allowGutter) {
    return 0.0;
  }
  return visibilitySamplePermissionForTriangle(pixel, threshold, triangleIndex, allowGutter, maxGutterRadius);
}

fn paintPixelForInvocation(id: vec3<u32>) -> PixelLookup {
  if (brush.compactPaintRegions == 0u || brush.paintRegionCount == 0u) {
    if (id.x >= brush.paintRect.z || id.y >= brush.paintRect.w) {
      return PixelLookup(vec2<u32>(0u, 0u), 0u);
    }
    let pixel = brush.paintRect.xy + id.xy;
    if (pixel.x >= brush.textureSize.x || pixel.y >= brush.textureSize.y) {
      return PixelLookup(pixel, 0u);
    }
    return PixelLookup(pixel, 1u);
  }
  let regionIndex = id.z;
  let regionCount = min(brush.paintRegionCount, ${TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS}u);
  if (regionIndex >= regionCount) {
    return PixelLookup(vec2<u32>(0u, 0u), 0u);
  }
  let region = paintRegions[regionIndex];
  let regionWidth = max(1u, region.z);
  let regionHeight = max(1u, region.w);
  if (id.x >= regionWidth || id.y >= regionHeight) {
    return PixelLookup(vec2<u32>(0u, 0u), 0u);
  }
  let pixel = vec2<u32>(region.x + id.x, region.y + id.y);
  if (pixel.x >= brush.textureSize.x || pixel.y >= brush.textureSize.y) {
    return PixelLookup(pixel, 0u);
  }
  return PixelLookup(pixel, 1u);
}

@compute @workgroup_size(${groupSize}, ${groupSize}, 1)
fn textureAirbrushPaint(@builtin(global_invocation_id) id: vec3<u32>) {
  if (${debugForceOrigin ? "true" : "false"}) {
    textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(0.0, 1.0, 0.0, 1.0));
    return;
  }
  if (${debugForcePaintBounds ? "true" : "false"}) {
    let forcePixel = brush.paintRect.xy + id.xy;
    if (forcePixel.x >= brush.textureSize.x || forcePixel.y >= brush.textureSize.y) {
      return;
    }
    textureStore(outputTexture, vec2<i32>(forcePixel), vec4<f32>(0.0, 1.0, 0.0, 1.0));
    return;
  }
  let lookup = paintPixelForInvocation(id);
  if (lookup.valid == 0u) {
    return;
  }
  let pixel = lookup.pixel;
  let current = textureLoad(sourceTexture, vec2<i32>(pixel), 0);
  let strokeSource = textureLoad(strokeSourceTexture, vec2<i32>(pixel), 0);
  let layerMode = brush.color.a > 0.5;
  // Screen-projected triangles map observable UV texels back to the viewer for
  // camera-facing permission and brush coverage. Once projection is active, the
  // projected surface field owns the airbrush shape; the UV-space stroke path is
  // only a fallback for non-projected strokes so UV islands cannot print into
  // the rendered brush.
  let screenProjectedActive = screenProjectedCoverageActive();
  let compactTriangleActive = brush.compactPaintRegions != 0u
    && brush.compactPaintRegionTriangles != 0u
    && id.z < brush.paintRegionCount
    && id.z < brush.visibilityTriangleCount;
  var visibilityCoverage = 0.0;
  var compactProjectedGutterRadius = 0.0;
  if (screenProjectedActive) {
    compactProjectedGutterRadius = 16.0;
  }
  if (compactTriangleActive) {
    visibilityCoverage = visibleMaskFeatherCoverageForTriangle(
      pixel,
      id.z,
      screenProjectedActive,
      compactProjectedGutterRadius > 0.5,
      compactProjectedGutterRadius
    );
  } else {
    visibilityCoverage = visibleMaskFeatherCoverage(pixel, screenProjectedActive);
  }
  if (visibilityCoverage <= 0.0) {
    if (!compactTriangleActive) {
      textureStore(outputTexture, vec2<i32>(pixel), current);
    }
    return;
  }
  let point = vec2<f32>(f32(pixel.x), f32(pixel.y));
  // Ray-hit UV segments tell us where to dispatch and give non-projected
  // strokes a texture-space fallback. For live surface strokes, projected
  // coverage owns the visible brush shape; direct UV coverage must not be
  // blended back in or the ray-hit path can print UV seams and triangle edges.
  let textureCoverage = textureStrokeAirbrushCoverage(point);
  var projectedCoverage = 0.0;
  if (compactTriangleActive && screenProjectedActive) {
    projectedCoverage = screenProjectedAirbrushCoverageForTriangle(point, id.z, compactProjectedGutterRadius > 0.5, compactProjectedGutterRadius);
  } else {
    projectedCoverage = screenProjectedAirbrushCoverage(point, screenProjectedActive);
  }
  let coverage = select(textureCoverage, projectedCoverage, screenProjectedActive);
  if (coverage <= 0.0001) {
    if (!compactTriangleActive) {
      textureStore(outputTexture, vec2<i32>(pixel), current);
    }
    return;
  }
  let alpha = clamp(brush.opacity * brush.strength * coverage * visibilityCoverage, 0.0, 1.0);
  let visibilityAlphaCap = max(strokeSource.a, visibilityCoverage);
  let maxAlphaForVisibility = select(
    1.0,
    clamp((visibilityAlphaCap - strokeSource.a) / max(0.0001, 1.0 - strokeSource.a), 0.0, 1.0),
    strokeSource.a < 0.9999
  );
  let effectiveAlpha = min(alpha, maxAlphaForVisibility);
  if (effectiveAlpha <= ${alphaDiscardThreshold}) {
    if (!compactTriangleActive) {
      textureStore(outputTexture, vec2<i32>(pixel), current);
    }
    return;
  }
  let layerAlpha = effectiveAlpha + strokeSource.a * (1.0 - effectiveAlpha);
  let layerRgb = select(
    vec3<f32>(0.0),
    (brush.color.rgb * effectiveAlpha + strokeSource.rgb * strokeSource.a * (1.0 - effectiveAlpha)) / layerAlpha,
    layerAlpha > 0.0001
  );
  let baseRgb = mix(strokeSource.rgb, brush.color.rgb, effectiveAlpha);
  let baseAlpha = select(
    strokeSource.a,
    max(strokeSource.a, effectiveAlpha),
    strokeSource.a <= 0.02 && effectiveAlpha >= 0.16
  );
  let nextAlpha = select(baseAlpha, layerAlpha, layerMode);
  let nextRgb = select(baseRgb, layerRgb, layerMode);
  let proposed = vec4<f32>(nextRgb, nextAlpha);
  let currentProgress = paintProgress(current, strokeSource);
  let currentColorDistance = dot(current.rgb - brush.color.rgb, current.rgb - brush.color.rgb);
  let proposedColorDistance = dot(proposed.rgb - brush.color.rgb, proposed.rgb - brush.color.rgb);
  var outputColor = proposed;
  if (currentProgress + 0.0001 >= effectiveAlpha && currentColorDistance <= proposedColorDistance + 0.0001) {
    outputColor = current;
  }
  textureStore(outputTexture, vec2<i32>(pixel), outputColor);
}
`.trim();
}
