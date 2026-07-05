import { TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS } from "./constants.js";

function typedArrayByteLength(data) {
  return Number.isFinite(data?.byteLength) ? data.byteLength : 0;
}

function writeBufferData(queue, buffer, data, writeByteLength = null) {
  if (!queue?.writeBuffer || !buffer || !data) {
    return false;
  }
  const dataByteLength = typedArrayByteLength(data);
  const requestedByteLength = Math.floor(Number(writeByteLength));
  const byteLength = Math.max(
    0,
    Math.min(
      dataByteLength,
      Number.isFinite(requestedByteLength) && requestedByteLength > 0
        ? requestedByteLength
        : dataByteLength
    )
  );
  if (byteLength <= 0) {
    return false;
  }
  if (data.buffer instanceof ArrayBuffer) {
    queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset || 0, byteLength);
    return true;
  }
  queue.writeBuffer(buffer, 0, data, 0, byteLength);
  return true;
}

function projectedRenderResourcesRequired(plan = null) {
  return plan?.screenProjectedCoverageActive === true
    && Math.floor(Number(
      plan?.projectedRenderTriangleCount
      ?? plan?.params?.visibilityTriangleCount
    ) || 0) > 0;
}

function reusablePaintResources(resources = null, payload = null) {
  const plan = payload?.plan;
  const source = payload?.source;
  const requiresProjectedRender = projectedRenderResourcesRequired(plan);
  const projectedRenderSource = requiresProjectedRender ? payload?.projectedRenderSource || "" : "";
  if (
    !resources
    || !plan
    || resources.source !== source
    || (requiresProjectedRender && (resources.projectedRenderSource || "") !== projectedRenderSource)
    || resources.width !== plan.width
    || resources.height !== plan.height
    || !resources.pipeline
    || !resources.bindGroup
    || !resources.sourceTexture
    || !resources.strokeSourceTexture
    || !resources.visibilityMaskTexture
    || !resources.outputTexture
    || (requiresProjectedRender && !resources.projectedScratchTexture)
    || (requiresProjectedRender && !resources.projectedMaskTexture)
    || !resources.uniformBuffer
    || !resources.strokeBuffer
    || !resources.visibilitySampleBuffer
    || (requiresProjectedRender && !resources.projectedTriangleBuffer)
    || (
      requiresProjectedRender
      && Math.floor(Number(resources.projectedTriangleBufferSize) || 0)
        !== Math.floor(Number(plan?.buffers?.projectedTriangles?.size) || 0)
    )
    || !resources.paintRegionBuffer
    || (requiresProjectedRender && (
      !resources.projectedRenderPipeline
      || !resources.projectedMaskPipeline
      || !resources.projectedRenderBindGroup
      || !resources.projectedSeamHealPipeline
      || !resources.projectedSeamHealBindGroup
    ))
  ) {
    return false;
  }
  return true;
}

function createProjectedRenderBindGroupLayout(device = null, label = "texture-airbrush") {
  if (!device || typeof device.createBindGroupLayout !== "function") {
    return null;
  }
  const shaderStage = typeof GPUShaderStage !== "undefined"
    ? GPUShaderStage
    : { VERTEX: 0x01, FRAGMENT: 0x02 };
  const vertexFragment = shaderStage.VERTEX | shaderStage.FRAGMENT;
  return device.createBindGroupLayout({
    label: `${label}-projected-render-bind-group-layout`,
    entries: [
      {
        binding: 0,
        visibility: shaderStage.FRAGMENT,
        texture: { sampleType: "float" }
      },
      {
        binding: 2,
        visibility: vertexFragment,
        buffer: { type: "uniform" }
      },
      {
        binding: 3,
        visibility: shaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 4,
        visibility: shaderStage.FRAGMENT,
        texture: { sampleType: "float" }
      },
      {
        binding: 6,
        visibility: vertexFragment,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 9,
        visibility: vertexFragment,
        buffer: { type: "read-only-storage" }
      }
    ]
  });
}

function createProjectedRenderBindGroup(device = null, resources = null, layout = null, label = "texture-airbrush") {
  if (!device || !resources || !layout || typeof device.createBindGroup !== "function") {
    return null;
  }
  return device.createBindGroup({
    label: `${label}-projected-render-bind-group`,
    layout,
    entries: [
      {
        binding: 0,
        resource: resources.sourceTexture.createView()
      },
      {
        binding: 2,
        resource: { buffer: resources.uniformBuffer }
      },
      {
        binding: 3,
        resource: { buffer: resources.strokeBuffer }
      },
      {
        binding: 4,
        resource: resources.strokeSourceTexture.createView()
      },
      {
        binding: 6,
        resource: { buffer: resources.visibilitySampleBuffer }
      },
      {
        binding: 9,
        resource: { buffer: resources.projectedTriangleBuffer || resources.visibilitySampleBuffer }
      }
    ]
  });
}

function createProjectedRenderPipeline(device = null, source = "", bindGroupLayout = null, format = "rgba8unorm", label = "texture-airbrush") {
  if (!device || !source || !bindGroupLayout || typeof device.createRenderPipeline !== "function") {
    return { shaderModule: null, pipelineLayout: null, pipeline: null, maskPipeline: null };
  }
  const shaderModule = device.createShaderModule({
    label: `${label}-projected-render-shader`,
    code: source
  });
  const pipelineLayout = device.createPipelineLayout({
    label: `${label}-projected-render-pipeline-layout`,
    bindGroupLayouts: [bindGroupLayout]
  });
  const pipeline = device.createRenderPipeline({
    label: `${label}-projected-render-pipeline`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "textureAirbrushProjectedVertex"
    },
    fragment: {
      module: shaderModule,
      entryPoint: "textureAirbrushProjectedFragment",
      targets: [{
        format,
        blend: {
          color: {
            operation: "max",
            srcFactor: "one",
            dstFactor: "one"
          },
          alpha: {
            operation: "max",
            srcFactor: "one",
            dstFactor: "one"
          }
        }
      }]
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none"
    }
  });
  const maskPipeline = device.createRenderPipeline({
    label: `${label}-projected-mask-pipeline`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "textureAirbrushProjectedVertex"
    },
    fragment: {
      module: shaderModule,
      entryPoint: "textureAirbrushProjectedMaskFragment",
      targets: [{
        format
      }]
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "none"
    }
  });
  return { shaderModule, pipelineLayout, pipeline, maskPipeline };
}

function projectedSeamHealSource() {
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

struct PixelLookup {
  pixel: vec2<u32>,
  valid: u32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> brush: BrushParams;
@group(0) @binding(4) var strokeSourceTexture: texture_2d<f32>;
@group(0) @binding(5) var projectedMaskTexture: texture_2d<f32>;
@group(0) @binding(7) var<storage, read> paintRegions: array<vec4<u32>, ${TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS}>;
@group(0) @binding(8) var projectedCoverageTexture: texture_2d<f32>;

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

fn clampedPixel(pixel: vec2<i32>) -> vec2<i32> {
  return vec2<i32>(
    clamp(pixel.x, 0, i32(brush.textureSize.x) - 1),
    clamp(pixel.y, 0, i32(brush.textureSize.y) - 1)
  );
}

fn maskAt(pixel: vec2<i32>) -> f32 {
  return textureLoad(projectedMaskTexture, clampedPixel(pixel), 0).r;
}

fn coverageAt(pixel: vec2<i32>) -> f32 {
  let coverage = textureLoad(projectedCoverageTexture, clampedPixel(pixel), 0);
  return max(max(coverage.r, coverage.g), max(coverage.b, coverage.a));
}

fn compositedPaintColor(base: vec4<f32>, strokeSource: vec4<f32>, effectiveAlpha: f32) -> vec4<f32> {
  let alpha = clamp(effectiveAlpha, 0.0, 1.0);
  let layerMode = brush.color.a > 0.5;
  let layerAlpha = alpha + strokeSource.a * (1.0 - alpha);
  let layerRgb = select(
    vec3<f32>(0.0),
    (brush.color.rgb * alpha + strokeSource.rgb * strokeSource.a * (1.0 - alpha)) / layerAlpha,
    layerAlpha > 0.0001
  );
  let baseRgb = mix(strokeSource.rgb, brush.color.rgb, alpha);
  let baseAlpha = select(
    strokeSource.a,
    max(strokeSource.a, alpha),
    strokeSource.a <= 0.02 && alpha >= 0.16
  );
  let nextAlpha = select(baseAlpha, layerAlpha, layerMode);
  let nextRgb = select(baseRgb, layerRgb, layerMode);
  let proposed = vec4<f32>(nextRgb, nextAlpha);
  let currentProgress = paintProgress(base, strokeSource);
  let currentColorDistance = dot(base.rgb - brush.color.rgb, base.rgb - brush.color.rgb);
  let proposedColorDistance = dot(proposed.rgb - brush.color.rgb, proposed.rgb - brush.color.rgb);
  if (currentProgress + 0.0001 >= alpha && currentColorDistance <= proposedColorDistance + 0.0001) {
    return base;
  }
  return proposed;
}

struct DilationCandidate {
  progress: f32,
  distancePixels: f32,
  color: vec4<f32>,
};

fn emptyDilationCandidate() -> DilationCandidate {
  return DilationCandidate(0.0, 0.0, vec4<f32>(0.0, 0.0, 0.0, 0.0));
}

fn progressAt(pixel: vec2<i32>) -> f32 {
  return coverageAt(pixel);
}

fn projectedHealRadius() -> f32 {
  let requested = max(0.0, brush.visibilityBleedRadius);
  return clamp(max(8.0, requested * 0.75), 8.0, 24.0);
}

fn betterDilationCandidate(current: DilationCandidate, pixel: vec2<i32>, offset: vec2<i32>, maxRadius: f32) -> DilationCandidate {
  let offsetVector = vec2<f32>(f32(offset.x), f32(offset.y));
  let distancePixels = length(offsetVector);
  if (distancePixels <= 0.001 || distancePixels > maxRadius + 0.001) {
    return current;
  }
  let neighborPixel = clampedPixel(pixel + offset);
  if (maskAt(neighborPixel) <= 0.5) {
    return current;
  }
  let neighborProgress = progressAt(neighborPixel);
  if (neighborProgress <= 0.04) {
    return current;
  }
  let distanceFade = 1.0 - smoothstep(1.0, maxRadius + 1.0, distancePixels);
  let targetProgress = clamp(neighborProgress * mix(0.88, 0.997, distanceFade), 0.0, 1.0);
  if (targetProgress <= current.progress) {
    return current;
  }
  let neighborBase = textureLoad(inputTexture, neighborPixel, 0);
  let neighborStrokeSource = textureLoad(strokeSourceTexture, neighborPixel, 0);
  let neighborColor = compositedPaintColor(neighborBase, neighborStrokeSource, targetProgress);
  return DilationCandidate(targetProgress, distancePixels, neighborColor);
}

fn dilationCandidatesAtRadius(pixel: vec2<i32>, radiusPixels: i32, maxRadius: f32) -> DilationCandidate {
  var best = emptyDilationCandidate();
  let halfRadius = max(1, radiusPixels / 2);
  best = betterDilationCandidate(best, pixel, vec2<i32>(radiusPixels, 0), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(-radiusPixels, 0), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(0, radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(0, -radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(radiusPixels, radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(radiusPixels, -radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(-radiusPixels, radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(-radiusPixels, -radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(radiusPixels, halfRadius), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(radiusPixels, -halfRadius), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(-radiusPixels, halfRadius), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(-radiusPixels, -halfRadius), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(halfRadius, radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(halfRadius, -radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(-halfRadius, radiusPixels), maxRadius);
  best = betterDilationCandidate(best, pixel, vec2<i32>(-halfRadius, -radiusPixels), maxRadius);
  return best;
}

fn projectedDilationCandidate(pixel: vec2<i32>) -> DilationCandidate {
  let maxRadius = projectedHealRadius();
  var best = emptyDilationCandidate();
  let radius1 = dilationCandidatesAtRadius(pixel, 1, maxRadius);
  if (radius1.progress > best.progress) { best = radius1; }
  let radius2 = dilationCandidatesAtRadius(pixel, 2, maxRadius);
  if (radius2.progress > best.progress) { best = radius2; }
  let radius3 = dilationCandidatesAtRadius(pixel, 3, maxRadius);
  if (radius3.progress > best.progress) { best = radius3; }
  let radius5 = dilationCandidatesAtRadius(pixel, 5, maxRadius);
  if (radius5.progress > best.progress) { best = radius5; }
  let radius8 = dilationCandidatesAtRadius(pixel, 8, maxRadius);
  if (radius8.progress > best.progress) { best = radius8; }
  let radius12 = dilationCandidatesAtRadius(pixel, 12, maxRadius);
  if (radius12.progress > best.progress) { best = radius12; }
  let radius16 = dilationCandidatesAtRadius(pixel, 16, maxRadius);
  if (radius16.progress > best.progress) { best = radius16; }
  let radius24 = dilationCandidatesAtRadius(pixel, 24, maxRadius);
  if (radius24.progress > best.progress) { best = radius24; }
  return best;
}

@compute @workgroup_size(8, 8, 1)
fn textureAirbrushProjectedSeamHeal(@builtin(global_invocation_id) id: vec3<u32>) {
  let lookup = paintPixelForInvocation(id);
  if (lookup.valid == 0u) {
    return;
  }
  let pixel = vec2<i32>(i32(lookup.pixel.x), i32(lookup.pixel.y));
  let center = textureLoad(inputTexture, pixel, 0);
  let centerStrokeSource = textureLoad(strokeSourceTexture, pixel, 0);
  let centerCoverage = coverageAt(pixel);
  let dilation = projectedDilationCandidate(pixel);
  if (dilation.progress > centerCoverage + 0.01) {
    textureStore(outputTexture, pixel, dilation.color);
    return;
  }
  if (maskAt(pixel) > 0.5) {
    if (centerCoverage <= 0.02) {
      textureStore(outputTexture, pixel, center);
      return;
    }
    textureStore(outputTexture, pixel, compositedPaintColor(center, centerStrokeSource, centerCoverage));
    return;
  }
  if (centerCoverage <= 0.02) {
    textureStore(outputTexture, pixel, center);
    return;
  }
  textureStore(outputTexture, pixel, compositedPaintColor(center, centerStrokeSource, centerCoverage));
}
`.trim();
}

function createProjectedSeamHealPipeline(device = null, format = "rgba8unorm", label = "texture-airbrush") {
  if (!device || typeof device.createComputePipeline !== "function") {
    return { shaderModule: null, bindGroupLayout: null, pipelineLayout: null, pipeline: null };
  }
  void format;
  const shaderStage = typeof GPUShaderStage !== "undefined" ? GPUShaderStage : { COMPUTE: 0x04 };
  const bindGroupLayout = device.createBindGroupLayout({
    label: `${label}-projected-seam-heal-bind-group-layout`,
    entries: [
      {
        binding: 0,
        visibility: shaderStage.COMPUTE,
        texture: { sampleType: "float" }
      },
      {
        binding: 1,
        visibility: shaderStage.COMPUTE,
        storageTexture: {
          access: "write-only",
          format: "rgba8unorm"
        }
      },
      {
        binding: 2,
        visibility: shaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      {
        binding: 4,
        visibility: shaderStage.COMPUTE,
        texture: { sampleType: "float" }
      },
      {
        binding: 5,
        visibility: shaderStage.COMPUTE,
        texture: { sampleType: "float" }
      },
      {
        binding: 7,
        visibility: shaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 8,
        visibility: shaderStage.COMPUTE,
        texture: { sampleType: "float" }
      }
    ]
  });
  const pipelineLayout = device.createPipelineLayout({
    label: `${label}-projected-seam-heal-pipeline-layout`,
    bindGroupLayouts: [bindGroupLayout]
  });
  const shaderModule = device.createShaderModule({
    label: `${label}-projected-seam-heal-shader`,
    code: projectedSeamHealSource()
  });
  const pipeline = device.createComputePipeline({
    label: `${label}-projected-seam-heal-pipeline`,
    layout: pipelineLayout,
    compute: {
      module: shaderModule,
      entryPoint: "textureAirbrushProjectedSeamHeal"
    }
  });
  return { shaderModule, bindGroupLayout, pipelineLayout, pipeline };
}

function createProjectedSeamHealBindGroup(device = null, resources = null, layout = null, label = "texture-airbrush") {
  if (!device || !resources || !layout || typeof device.createBindGroup !== "function") {
    return null;
  }
  return device.createBindGroup({
    label: `${label}-projected-seam-heal-bind-group`,
    layout,
    entries: [
      {
        binding: 0,
        resource: resources.sourceTexture.createView()
      },
      {
        binding: 1,
        resource: resources.outputTexture.createView()
      },
      {
        binding: 2,
        resource: { buffer: resources.uniformBuffer }
      },
      {
        binding: 4,
        resource: resources.strokeSourceTexture.createView()
      },
      {
        binding: 5,
        resource: resources.projectedMaskTexture.createView()
      },
      {
        binding: 7,
        resource: { buffer: resources.paintRegionBuffer }
      },
      {
        binding: 8,
        resource: resources.projectedScratchTexture.createView()
      }
    ]
  });
}

function textureMipLevelCountFromDescriptorOrTexture(texture = null, descriptor = null) {
  const textureMipCount = Math.floor(Number(texture?.mipLevelCount));
  if (Number.isFinite(textureMipCount) && textureMipCount > 0) {
    return textureMipCount;
  }
  const descriptorMipCount = Math.floor(Number(descriptor?.mipLevelCount));
  return Number.isFinite(descriptorMipCount) && descriptorMipCount > 0
    ? descriptorMipCount
    : 1;
}

function reusableReadbackBuffer(resources = null, plan = null) {
  const buffer = resources?.readbackBuffer || null;
  const descriptor = plan?.buffers?.readback || null;
  if (!buffer || !descriptor) {
    return null;
  }
  const size = Number(buffer.desc?.size ?? buffer.size ?? 0);
  const usage = Number(buffer.desc?.usage ?? buffer.usage ?? 0);
  if (size === descriptor.size && usage === descriptor.usage) {
    return buffer;
  }
  return null;
}

function textureAirbrushDefaultVisibleMaskPixels(plan) {
  const byteLength = Math.max(1, Math.floor(Number(plan?.width) || 1))
    * Math.max(1, Math.floor(Number(plan?.height) || 1))
    * 4;
  const pixels = new Uint8Array(byteLength);
  pixels.fill(255);
  return pixels;
}

function texturePayloadPixels(payload = null) {
  return payload?.pixels || payload || null;
}

function texturePayloadLayout(payload = null, plan = null, textureDescriptor = null) {
  const pixels = texturePayloadPixels(payload);
  const size = textureDescriptor?.size || plan?.textures?.source?.size || {
    width: plan?.width || 1,
    height: plan?.height || 1,
    depthOrArrayLayers: 1
  };
  if (!payload?.pixels) {
    return {
      pixels,
      origin: { x: 0, y: 0, z: 0 },
      bytesPerRow: plan.width * 4,
      rowsPerImage: plan.height,
      size
    };
  }
  const width = Math.max(1, Math.floor(Number(payload.width) || size.width || plan.width || 1));
  const height = Math.max(1, Math.floor(Number(payload.height) || size.height || plan.height || 1));
  return {
    pixels,
    origin: {
      x: Math.max(0, Math.floor(Number(payload.x) || 0)),
      y: Math.max(0, Math.floor(Number(payload.y) || 0)),
      z: 0
    },
    bytesPerRow: Math.max(width * 4, Math.floor(Number(payload.bytesPerRow) || width * 4)),
    rowsPerImage: height,
    size: {
      width,
      height,
      depthOrArrayLayers: 1
    }
  };
}

function textureAirbrushUploadWebGpuTexture(device, texture, pixels, plan, textureDescriptor = null) {
  const layout = texturePayloadLayout(pixels, plan, textureDescriptor);
  if (!layout.pixels || !device?.queue?.writeTexture || !texture || !plan) {
    return false;
  }
  device.queue.writeTexture(
    {
      texture,
      origin: layout.origin
    },
    layout.pixels,
    {
      bytesPerRow: layout.bytesPerRow,
      rowsPerImage: layout.rowsPerImage
    },
    layout.size
  );
  return true;
}

function textureAirbrushUploadWebGpuSourceTexture(device, texture, sourcePixels, plan) {
  return textureAirbrushUploadWebGpuTexture(device, texture, sourcePixels, plan, plan.textures.source);
}

function textureAirbrushUploadExternalWebGpuTexture(device, texture, sourceExternalImage, plan, textureDescriptor = null) {
  const size = textureDescriptor?.size || plan?.textures?.source?.size || {
    width: plan?.width || 1,
    height: plan?.height || 1,
    depthOrArrayLayers: 1
  };
  if (!sourceExternalImage || !device?.queue?.copyExternalImageToTexture || !texture || !plan) {
    return false;
  }
  try {
    device.queue.copyExternalImageToTexture(
      { source: sourceExternalImage },
      { texture },
      {
        width: Math.max(1, Math.floor(Number(size.width) || plan.width || 1)),
        height: Math.max(1, Math.floor(Number(size.height) || plan.height || 1)),
        depthOrArrayLayers: 1
      }
    );
    return true;
  } catch {
    return false;
  }
}

function textureAirbrushUploadExternalWebGpuSourceTexture(device, texture, sourceExternalImage, plan) {
  return textureAirbrushUploadExternalWebGpuTexture(device, texture, sourceExternalImage, plan, plan.textures.source);
}

function textureAirbrushCopyWebGpuTexture(
  device,
  sourceTexture,
  destinationTexture,
  plan,
  label = "texture-airbrush-copy-texture"
) {
  const size = plan?.textures?.strokeSource?.size || plan?.textures?.source?.size || null;
  if (!device || !sourceTexture || !destinationTexture || !size || typeof device.createCommandEncoder !== "function") {
    return false;
  }
  const encoder = device.createCommandEncoder({
    label
  });
  if (typeof encoder.copyTextureToTexture !== "function") {
    return false;
  }
  encoder.copyTextureToTexture(
    { texture: sourceTexture, origin: { x: 0, y: 0, z: 0 } },
    { texture: destinationTexture, origin: { x: 0, y: 0, z: 0 } },
    {
      width: Math.max(1, Math.floor(Number(size.width) || plan.width || 1)),
      height: Math.max(1, Math.floor(Number(size.height) || plan.height || 1)),
      depthOrArrayLayers: 1
    }
  );
  device.queue?.submit?.([encoder.finish()]);
  return true;
}

export function textureAirbrushCopyWebGpuSourceToStrokeTexture(device, sourceTexture, strokeSourceTexture, plan) {
  return textureAirbrushCopyWebGpuTexture(
    device,
    sourceTexture,
    strokeSourceTexture,
    plan,
    "texture-airbrush-copy-source-to-stroke-source"
  );
}

function textureAirbrushMarkDeferredSourceToStrokeCopy(resources = null, sourceUploaded = false, copySourceToStrokeSource = false) {
  if (!resources || (!sourceUploaded && copySourceToStrokeSource !== true)) {
    return false;
  }
  resources.copySourceToStrokeBeforeDispatch = true;
  return true;
}

function textureAirbrushUploadWebGpuVisibilityMaskTexture(device, texture, visibilityMaskPixels, plan) {
  if (
    !visibilityMaskPixels
    && (
      plan?.params?.visibilitySampleCount > 0
      || plan?.params?.visibilityTriangleCount > 0
    )
  ) {
    return false;
  }
  if (!visibilityMaskPixels && !plan?.params?.useVisibilityMask) {
    return false;
  }
  return textureAirbrushUploadWebGpuTexture(
    device,
    texture,
    visibilityMaskPixels || textureAirbrushDefaultVisibleMaskPixels(plan),
    plan,
    plan.textures.visibilityMask
  );
}

export function textureAirbrushCreateWebGpuPaintResources(device, payload, {
  sourcePixels = null,
  strokeSourcePixels = null,
  readback = false,
  label = "texture-airbrush",
  reuseResources = null,
  reuseReadbackBuffer = true,
  visibilityMaskPixels = null,
  sourceExternalImage = null,
  uploadSource = true,
  uploadStrokeSource = strokeSourcePixels ? true : uploadSource,
  copySourceToStrokeSource = false,
  deferSourceToStrokeCopy = false,
  uploadVisibilityMask = null,
  dedicatedBrushBuffers = false,
  entryPoint = "textureAirbrushPaint"
} = {}) {
  const plan = payload?.plan;
  const source = payload?.source;
  if (!device || !plan || typeof source !== "string") {
    return null;
  }
  const shouldUploadVisibilityMask = uploadVisibilityMask === null
    ? Boolean(visibilityMaskPixels || (
        plan.params?.useVisibilityMask
        && !(plan.params?.visibilitySampleCount > 0)
        && !(plan.params?.visibilityTriangleCount > 0)
      ))
    : uploadVisibilityMask !== false;

  if (reusablePaintResources(reuseResources, payload)) {
    const requiresProjectedRender = projectedRenderResourcesRequired(plan);
    const readbackBuffer = readback
      ? (
          reuseReadbackBuffer !== false
            ? reusableReadbackBuffer(reuseResources, plan)
            : null
        ) || device.createBuffer({
          label: `${label}-readback-buffer`,
          size: plan.buffers.readback.size,
          usage: plan.buffers.readback.usage
        })
      : null;
    const useDedicatedBrushBuffers = dedicatedBrushBuffers === true;
    const uniformBuffer = useDedicatedBrushBuffers
      ? device.createBuffer({
          label: `${label}-uniform-buffer`,
          size: plan.buffers.uniform.size,
          usage: plan.buffers.uniform.usage
        })
      : reuseResources.uniformBuffer;
    const strokeBuffer = useDedicatedBrushBuffers
      ? device.createBuffer({
          label: `${label}-stroke-buffer`,
          size: plan.buffers.strokes.size,
          usage: plan.buffers.strokes.usage
        })
      : reuseResources.strokeBuffer;
    const visibilitySampleBuffer = useDedicatedBrushBuffers
      ? device.createBuffer({
          label: `${label}-visibility-sample-buffer`,
          size: plan.buffers.visibilitySamples.size,
          usage: plan.buffers.visibilitySamples.usage
        })
      : reuseResources.visibilitySampleBuffer;
    const projectedTriangleBuffer = requiresProjectedRender && useDedicatedBrushBuffers
      ? device.createBuffer({
          label: `${label}-projected-triangle-buffer`,
          size: plan.buffers.projectedTriangles.size,
          usage: plan.buffers.projectedTriangles.usage
        })
      : requiresProjectedRender
        ? reuseResources.projectedTriangleBuffer
        : null;
    const paintRegionBuffer = useDedicatedBrushBuffers
      ? device.createBuffer({
          label: `${label}-paint-region-buffer`,
          size: plan.buffers.paintRegions.size,
          usage: plan.buffers.paintRegions.usage
        })
      : reuseResources.paintRegionBuffer;
    const bindGroup = useDedicatedBrushBuffers
      ? device.createBindGroup({
          label: `${label}-bind-group`,
          layout: reuseResources.bindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: reuseResources.sourceTexture.createView()
            },
            {
              binding: 1,
              resource: reuseResources.outputTexture.createView()
            },
            {
              binding: 2,
              resource: { buffer: uniformBuffer }
            },
            {
              binding: 3,
              resource: { buffer: strokeBuffer }
            },
            {
              binding: 4,
              resource: reuseResources.strokeSourceTexture.createView()
            },
            {
              binding: 5,
              resource: reuseResources.visibilityMaskTexture.createView()
            },
            {
              binding: 6,
              resource: { buffer: visibilitySampleBuffer }
            },
            {
              binding: 7,
              resource: { buffer: paintRegionBuffer }
            }
          ]
        })
      : reuseResources.bindGroup;
    const projectedRenderBindGroup = requiresProjectedRender && useDedicatedBrushBuffers
      ? createProjectedRenderBindGroup(device, {
          sourceTexture: reuseResources.sourceTexture,
          strokeSourceTexture: reuseResources.strokeSourceTexture,
          uniformBuffer,
          strokeBuffer,
          visibilitySampleBuffer,
          projectedTriangleBuffer
        }, reuseResources.projectedRenderBindGroupLayout, label)
      : requiresProjectedRender
        ? reuseResources.projectedRenderBindGroup
        : null;
    const projectedSeamHealBindGroup = requiresProjectedRender && useDedicatedBrushBuffers
      ? createProjectedSeamHealBindGroup(device, {
        sourceTexture: reuseResources.sourceTexture,
        outputTexture: reuseResources.outputTexture,
        projectedScratchTexture: reuseResources.projectedScratchTexture,
        projectedMaskTexture: reuseResources.projectedMaskTexture,
        strokeSourceTexture: reuseResources.strokeSourceTexture,
        uniformBuffer,
        paintRegionBuffer
        }, reuseResources.projectedSeamHealBindGroupLayout, label)
      : requiresProjectedRender
        ? reuseResources.projectedSeamHealBindGroup
        : null;
    const resources = {
      ...reuseResources,
      plan,
      uniformBuffer,
      strokeBuffer,
      visibilitySampleBuffer,
      projectedTriangleBuffer,
      projectedTriangleBufferSize: requiresProjectedRender ? plan.buffers.projectedTriangles.size : 0,
      paintRegionBuffer,
      bindGroup,
      projectedRenderBindGroup,
      projectedSeamHealBindGroup,
      readbackBuffer,
      readbackBufferReused: reuseReadbackBuffer !== false && readbackBuffer === reuseResources.readbackBuffer,
      sourceTextureMipLevelCount: textureMipLevelCountFromDescriptorOrTexture(
        reuseResources.sourceTexture,
        plan.textures.source
      ),
      sourceExternalUploaded: false,
      strokeSourceCopiedFromSource: false,
      dedicatedBrushBuffers: useDedicatedBrushBuffers
    };
    writeBufferData(device.queue, resources.uniformBuffer, plan.buffers.uniform.data, plan.buffers.uniform.writeByteLength);
    writeBufferData(device.queue, resources.strokeBuffer, plan.buffers.strokes.data, plan.buffers.strokes.writeByteLength);
    writeBufferData(
      device.queue,
      resources.visibilitySampleBuffer,
      plan.buffers.visibilitySamples.data,
      plan.buffers.visibilitySamples.writeByteLength
    );
    if (requiresProjectedRender && resources.projectedTriangleBuffer) {
      writeBufferData(
        device.queue,
        resources.projectedTriangleBuffer,
        plan.buffers.projectedTriangles.data,
        plan.buffers.projectedTriangles.writeByteLength
      );
    }
    writeBufferData(
      device.queue,
      resources.paintRegionBuffer,
      plan.buffers.paintRegions.data,
      plan.buffers.paintRegions.writeByteLength
    );
    const sourceUploaded = uploadSource !== false && (
      sourcePixels
        ? textureAirbrushUploadWebGpuSourceTexture(device, resources.sourceTexture, sourcePixels, plan)
        : textureAirbrushUploadExternalWebGpuSourceTexture(device, resources.sourceTexture, sourceExternalImage, plan)
    );
    resources.sourceExternalUploaded = sourceUploaded && !sourcePixels && Boolean(sourceExternalImage);
    resources.sourceUploaded = sourceUploaded === true;
    if (uploadStrokeSource !== false) {
      const strokeUploaded = strokeSourcePixels || sourcePixels
        ? textureAirbrushUploadWebGpuSourceTexture(
            device,
            resources.strokeSourceTexture,
            strokeSourcePixels || sourcePixels,
            plan
          )
        : false;
      if (!strokeUploaded && (sourceUploaded || copySourceToStrokeSource === true)) {
        resources.strokeSourceCopiedFromSource = deferSourceToStrokeCopy === true
          ? textureAirbrushMarkDeferredSourceToStrokeCopy(resources, sourceUploaded, copySourceToStrokeSource)
          : textureAirbrushCopyWebGpuSourceToStrokeTexture(
              device,
              resources.sourceTexture,
              resources.strokeSourceTexture,
              plan
            );
      }
    }
    if (shouldUploadVisibilityMask) {
      textureAirbrushUploadWebGpuVisibilityMaskTexture(
        device,
        resources.visibilityMaskTexture,
        visibilityMaskPixels,
        plan
      );
    }
    return resources;
  }

  const debugErrorScope = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrush")
    && typeof device.pushErrorScope === "function"
    && typeof device.popErrorScope === "function";
  if (debugErrorScope) {
    try {
      device.pushErrorScope("validation");
    } catch {
      // Debug-only instrumentation; resource creation should continue.
    }
  }
  const shaderModule = device.createShaderModule({
    label: `${label}-shader`,
    code: source
  });
  const bindGroupLayout = device.createBindGroupLayout({
    label: `${label}-bind-group-layout`,
    entries: plan.bindGroupLayoutEntries
  });
  const pipelineLayout = device.createPipelineLayout({
    label: `${label}-pipeline-layout`,
    bindGroupLayouts: [bindGroupLayout]
  });
  const pipeline = device.createComputePipeline({
    label: `${label}-pipeline`,
    layout: pipelineLayout,
    compute: {
      module: shaderModule,
      entryPoint
    }
  });
  const requiresProjectedRender = projectedRenderResourcesRequired(plan);
  const projectedRenderBindGroupLayout = requiresProjectedRender
    ? createProjectedRenderBindGroupLayout(device, label)
    : null;
  const projectedRender = requiresProjectedRender
    ? createProjectedRenderPipeline(
        device,
        payload?.projectedRenderSource || "",
        projectedRenderBindGroupLayout,
        plan.textures?.output?.format || "rgba8unorm",
        label
      )
    : { shaderModule: null, pipelineLayout: null, pipeline: null, maskPipeline: null };
  const projectedSeamHeal = requiresProjectedRender
    ? createProjectedSeamHealPipeline(
        device,
        plan.textures?.output?.format || "rgba8unorm",
        label
      )
    : { shaderModule: null, bindGroupLayout: null, pipelineLayout: null, pipeline: null };
  const sourceTexture = device.createTexture({
    label: `${label}-source-texture`,
    ...plan.textures.source
  });
  const strokeSourceTexture = device.createTexture({
    label: `${label}-stroke-source-texture`,
    ...plan.textures.strokeSource
  });
  const visibilityMaskTexture = device.createTexture({
    label: `${label}-visibility-mask-texture`,
    ...plan.textures.visibilityMask
  });
  const outputTexture = device.createTexture({
    label: `${label}-output-texture`,
    ...plan.textures.output
  });
  const projectedScratchTexture = requiresProjectedRender
    ? device.createTexture({
        label: `${label}-projected-scratch-texture`,
        ...plan.textures.output
      })
    : null;
  const projectedMaskTexture = requiresProjectedRender
    ? device.createTexture({
        label: `${label}-projected-mask-texture`,
        ...plan.textures.output
      })
    : null;
  const sourceTextureMipLevelCount = textureMipLevelCountFromDescriptorOrTexture(
    sourceTexture,
    plan.textures.source
  );
  const uniformBuffer = device.createBuffer({
    label: `${label}-uniform-buffer`,
    size: plan.buffers.uniform.size,
    usage: plan.buffers.uniform.usage
  });
  const strokeBuffer = device.createBuffer({
    label: `${label}-stroke-buffer`,
    size: plan.buffers.strokes.size,
    usage: plan.buffers.strokes.usage
  });
  const visibilitySampleBuffer = device.createBuffer({
    label: `${label}-visibility-sample-buffer`,
    size: plan.buffers.visibilitySamples.size,
    usage: plan.buffers.visibilitySamples.usage
  });
  const projectedTriangleBuffer = requiresProjectedRender
    ? device.createBuffer({
        label: `${label}-projected-triangle-buffer`,
        size: plan.buffers.projectedTriangles.size,
        usage: plan.buffers.projectedTriangles.usage
      })
    : null;
  const paintRegionBuffer = device.createBuffer({
    label: `${label}-paint-region-buffer`,
    size: plan.buffers.paintRegions.size,
    usage: plan.buffers.paintRegions.usage
  });
  const readbackBuffer = readback
    ? device.createBuffer({
        label: `${label}-readback-buffer`,
        size: plan.buffers.readback.size,
        usage: plan.buffers.readback.usage
      })
    : null;

  writeBufferData(device.queue, uniformBuffer, plan.buffers.uniform.data, plan.buffers.uniform.writeByteLength);
  writeBufferData(device.queue, strokeBuffer, plan.buffers.strokes.data, plan.buffers.strokes.writeByteLength);
  writeBufferData(
    device.queue,
    visibilitySampleBuffer,
    plan.buffers.visibilitySamples.data,
    plan.buffers.visibilitySamples.writeByteLength
  );
  if (requiresProjectedRender && projectedTriangleBuffer) {
    writeBufferData(
      device.queue,
      projectedTriangleBuffer,
      plan.buffers.projectedTriangles.data,
      plan.buffers.projectedTriangles.writeByteLength
    );
  }
  writeBufferData(
    device.queue,
    paintRegionBuffer,
    plan.buffers.paintRegions.data,
    plan.buffers.paintRegions.writeByteLength
  );
  const sourceUploaded = sourcePixels
    ? textureAirbrushUploadWebGpuSourceTexture(device, sourceTexture, sourcePixels, plan)
    : textureAirbrushUploadExternalWebGpuSourceTexture(device, sourceTexture, sourceExternalImage, plan);
  const sourceTextureCopiedFromReuse = sourceUploaded !== true
    && uploadSource === false
    && reuseResources?.sourceTexture
    ? textureAirbrushCopyWebGpuTexture(
        device,
        reuseResources.sourceTexture,
        sourceTexture,
        plan,
        `${label}-copy-reused-source-texture`
      )
    : false;
  const sourceExternalUploaded = sourceUploaded && !sourcePixels && Boolean(sourceExternalImage);
  const strokeSourceTextureCopiedFromReuse = uploadStrokeSource === false
    && reuseResources?.strokeSourceTexture
    ? textureAirbrushCopyWebGpuTexture(
        device,
        reuseResources.strokeSourceTexture,
        strokeSourceTexture,
        plan,
        `${label}-copy-reused-stroke-source-texture`
      )
    : false;
  const strokeUploaded = strokeSourcePixels || sourcePixels
    ? textureAirbrushUploadWebGpuSourceTexture(device, strokeSourceTexture, strokeSourcePixels || sourcePixels, plan)
    : false;
  const strokeSourceCopiedFromSource = !strokeUploaded
    && !strokeSourceTextureCopiedFromReuse
    && (
      deferSourceToStrokeCopy === true
        ? textureAirbrushMarkDeferredSourceToStrokeCopy(
            { sourceTexture, strokeSourceTexture },
            sourceUploaded || sourceTextureCopiedFromReuse,
            copySourceToStrokeSource
          )
        : (sourceUploaded || sourceTextureCopiedFromReuse || copySourceToStrokeSource === true)
          && textureAirbrushCopyWebGpuSourceToStrokeTexture(device, sourceTexture, strokeSourceTexture, plan)
    );
  if (shouldUploadVisibilityMask) {
    textureAirbrushUploadWebGpuVisibilityMaskTexture(device, visibilityMaskTexture, visibilityMaskPixels, plan);
  }

  const bindGroup = device.createBindGroup({
    label: `${label}-bind-group`,
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: sourceTexture.createView()
      },
      {
        binding: 1,
        resource: outputTexture.createView()
      },
      {
        binding: 2,
        resource: { buffer: uniformBuffer }
      },
      {
        binding: 3,
        resource: { buffer: strokeBuffer }
      },
      {
        binding: 4,
        resource: strokeSourceTexture.createView()
      },
      {
        binding: 5,
        resource: visibilityMaskTexture.createView()
      },
      {
        binding: 6,
        resource: { buffer: visibilitySampleBuffer }
      },
      {
        binding: 7,
        resource: { buffer: paintRegionBuffer }
      }
    ]
  });
  const projectedRenderBindGroup = requiresProjectedRender
    ? createProjectedRenderBindGroup(device, {
        sourceTexture,
        strokeSourceTexture,
        uniformBuffer,
        strokeBuffer,
        visibilitySampleBuffer,
        projectedTriangleBuffer
      }, projectedRenderBindGroupLayout, label)
    : null;
  const projectedSeamHealBindGroup = requiresProjectedRender
    ? createProjectedSeamHealBindGroup(device, {
        sourceTexture,
        outputTexture,
        projectedScratchTexture,
        projectedMaskTexture,
        strokeSourceTexture,
        uniformBuffer,
        paintRegionBuffer
      }, projectedSeamHeal.bindGroupLayout, label)
    : null;
  if (debugErrorScope) {
    try {
      device.popErrorScope().then((error) => {
        const root = window?.document?.documentElement || null;
        if (root?.dataset) {
          root.dataset.textureAirbrushDebugGpuResourceValidationError = error?.message || "";
        }
      }).catch((error) => {
        const root = window?.document?.documentElement || null;
        if (root?.dataset) {
          root.dataset.textureAirbrushDebugGpuResourceValidationError = error?.message || String(error || "");
        }
      });
    } catch (error) {
      const root = window?.document?.documentElement || null;
      if (root?.dataset) {
        root.dataset.textureAirbrushDebugGpuResourceValidationError = error?.message || String(error || "");
      }
    }
  }

  return {
    plan,
    source,
    width: plan.width,
    height: plan.height,
    shaderModule,
    projectedRenderShaderModule: projectedRender.shaderModule,
    projectedSeamHealShaderModule: projectedSeamHeal.shaderModule,
    bindGroupLayout,
    projectedRenderBindGroupLayout,
    projectedSeamHealBindGroupLayout: projectedSeamHeal.bindGroupLayout,
    pipelineLayout,
    projectedRenderPipelineLayout: projectedRender.pipelineLayout,
    projectedSeamHealPipelineLayout: projectedSeamHeal.pipelineLayout,
    pipeline,
    projectedRenderPipeline: projectedRender.pipeline,
    projectedMaskPipeline: projectedRender.maskPipeline,
    projectedSeamHealPipeline: projectedSeamHeal.pipeline,
    projectedRenderBindGroup,
    projectedSeamHealBindGroup,
    projectedRenderSource: payload?.projectedRenderSource || "",
    sourceTexture,
    sourceTextureMipLevelCount,
    strokeSourceTexture,
    visibilityMaskTexture,
    outputTexture,
    projectedScratchTexture,
    projectedMaskTexture,
    uniformBuffer,
    strokeBuffer,
    visibilitySampleBuffer,
    projectedTriangleBuffer,
    projectedTriangleBufferSize: requiresProjectedRender ? plan.buffers.projectedTriangles.size : 0,
    paintRegionBuffer,
    readbackBuffer,
    readbackBufferReused: false,
    sourceExternalUploaded,
    sourceTextureCopiedFromReuse,
    strokeSourceTextureCopiedFromReuse,
    sourceUploaded: sourceUploaded === true,
    strokeSourceCopiedFromSource,
    copySourceToStrokeBeforeDispatch: deferSourceToStrokeCopy === true && strokeSourceCopiedFromSource === true,
    bindGroup
  };
}
