import assert from "node:assert/strict";
import test from "node:test";
import {
  installTextureAirbrushWebGpuMethods,
  resolveTextureAirbrushBackend,
  resolveTextureAirbrushRendererMode,
  textureAirbrushNativeWebGpuAvailable,
  textureAirbrushWebGpuRendererRequestedFromSearch,
  textureAirbrushRendererWebGpuState,
  textureAirbrushWebGpuRequestedFromSearch
} from "../../src/weight-editor/airbrush/webgpu.js";
import {
  textureAirbrushApplyPixelsToEditable,
  textureAirbrushEditableWebGpuPayload,
  textureAirbrushPrewarmEditableWebGpuPaint,
  textureAirbrushSourcePixelsFromEditable
} from "../../src/weight-editor/airbrush/webgpu-canvas.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS,
  TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE
} from "../../src/weight-editor/airbrush/constants.js";
import {
  textureAirbrushReadWebGpuPaintResult,
  textureAirbrushRunWebGpuPaint,
  textureAirbrushWebGpuDeviceFromRenderer
} from "../../src/weight-editor/airbrush/webgpu-dispatch.js";
import {
  textureAirbrushUnpackWebGpuReadbackRows
} from "../../src/weight-editor/airbrush/webgpu-readback.js";
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
  airbrushAlphaForDistance,
  airbrushHaloRadius
} from "../../src/weight-editor/airbrush/math.js";
import {
  textureAirbrushWebGpuDispatchSize,
  textureAirbrushWebGpuKernelParams,
  textureAirbrushWebGpuKernelSource
} from "../../src/weight-editor/airbrush/webgpu-kernel.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_PROJECTION_DEPTH_WINDOW,
  textureAirbrushWebGpuAssignVisibilityMasks,
  textureAirbrushWebGpuProbePointsFromStroke,
  textureAirbrushWebGpuVisibilityMaskPixels,
  textureAirbrushWebGpuScreenStrokeFromEvent
} from "../../src/weight-editor/airbrush/webgpu-projection.js";
import {
  textureAirbrushFrontIntersections
} from "../../src/weight-editor/airbrush/projection.js";
import {
  textureAirbrushWebGpuAlignedBytesPerRow,
  textureAirbrushWebGpuBindGroupLayoutEntries,
  textureAirbrushWebGpuBrushUniformData,
  textureAirbrushWebGpuPaintBounds,
  textureAirbrushWebGpuPaintPlan,
  textureAirbrushWebGpuReadbackBufferDescriptor,
  textureAirbrushWebGpuReadbackLayout,
  textureAirbrushWebGpuStrokeBufferData,
  TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS,
  textureAirbrushWebGpuVisibilitySampleBufferData,
  textureAirbrushWebGpuTextureDescriptors,
  textureAirbrushWebGpuUsageConstants
} from "../../src/weight-editor/airbrush/webgpu-plan.js";
import {
  textureAirbrushWebGpuScreenProjectedBrushPaintRegionsForTest,
  textureAirbrushWebGpuStrokeCandidateFromHit,
  textureAirbrushWebGpuStrokeEstimate,
  textureAirbrushWebGpuTextureRadiusPixels
} from "../../src/weight-editor/airbrush/webgpu-stroke.js";

function visibilitySampleSlots(data) {
  return Array.from(
    { length: data.length / TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS },
    (_, index) => Array.from(
      data.slice(
        index * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS,
        (index + 1) * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS
      )
    )
  );
}

function fakeWebGpuDevice({ readbackMappedData = null } = {}) {
  const calls = [];
  let nextId = 1;
  const resource = (type, desc = {}) => ({
    id: nextId++,
    type,
    desc,
    mappedData: desc.mappedData || null,
    async mapAsync(mode) {
      calls.push(["mapAsync", this.id, mode]);
    },
    getMappedRange() {
      calls.push(["getMappedRange", this.id]);
      return this.mappedData?.buffer || new ArrayBuffer(desc.size || 0);
    },
    unmap() {
      calls.push(["unmap", this.id]);
    },
    createView() {
      calls.push(["createView", type, this.id]);
      return { type: `${type}-view`, resource: this };
    }
  });
  const queue = {
    writeBuffer(buffer, offset, data, dataOffset, size) {
      calls.push(["writeBuffer", buffer.id, offset, dataOffset, size, data instanceof ArrayBuffer]);
    },
    writeTexture(destination, data, layout, size) {
      calls.push([
        "writeTexture",
        destination.texture.id,
        data.byteLength,
        layout.bytesPerRow,
        size.width,
        size.height,
        destination.texture.desc?.label || ""
      ]);
    },
    submit(commandBuffers) {
      calls.push(["submit", commandBuffers.length]);
    }
  };
  return {
    calls,
    queue,
    createShaderModule(desc) {
      calls.push(["createShaderModule", desc.label, /textureAirbrushPaint/.test(desc.code)]);
      return resource("shaderModule", desc);
    },
    createBindGroupLayout(desc) {
      calls.push(["createBindGroupLayout", desc.entries.length]);
      return resource("bindGroupLayout", desc);
    },
    createPipelineLayout(desc) {
      calls.push(["createPipelineLayout", desc.bindGroupLayouts.length]);
      return resource("pipelineLayout", desc);
    },
    createComputePipeline(desc) {
      calls.push(["createComputePipeline", desc.compute.entryPoint]);
      return resource("computePipeline", desc);
    },
    createTexture(desc) {
      calls.push(["createTexture", desc.label, desc.size.width, desc.size.height, desc.usage]);
      return resource("texture", desc);
    },
    createBuffer(desc) {
      calls.push(["createBuffer", desc.label, desc.size, desc.usage]);
      return resource("buffer", {
        ...desc,
        mappedData: String(desc.label || "").includes("readback") ? readbackMappedData : desc.mappedData
      });
    },
    createBindGroup(desc) {
      calls.push(["createBindGroup", desc.entries.map((entry) => entry.binding).join(",")]);
      return resource("bindGroup", desc);
    },
    createCommandEncoder(desc) {
      calls.push(["createCommandEncoder", desc.label]);
      return {
        beginComputePass(passDesc) {
          calls.push(["beginComputePass", passDesc.label]);
          return {
            setPipeline(pipeline) {
              calls.push(["setPipeline", pipeline.id]);
            },
            setBindGroup(index, bindGroup) {
              calls.push(["setBindGroup", index, bindGroup.id]);
            },
            dispatchWorkgroups(x, y, z) {
              calls.push(["dispatchWorkgroups", x, y, z]);
            },
            end() {
              calls.push(["endComputePass"]);
            }
          };
        },
        finish() {
          calls.push(["finishCommandEncoder"]);
          return resource("commandBuffer");
        },
        copyTextureToBuffer(source, destination, size) {
          calls.push([
            "copyTextureToBuffer",
            source.texture.id,
            destination.buffer.id,
            destination.bytesPerRow,
            size.width,
            size.height,
            source.origin?.x || 0,
            source.origin?.y || 0
          ]);
        },
        copyTextureToTexture(source, destination, size) {
          calls.push([
            "copyTextureToTexture",
            source.texture.id,
            destination.texture.id,
            size.width,
            size.height,
            source.origin?.x || 0,
            source.origin?.y || 0,
            destination.origin?.x || 0,
            destination.origin?.y || 0
          ]);
        }
      };
    }
  };
}

function fakeEditableTexture(width, height, pixels) {
  const state = {
    imageData: {
      width,
      height,
      data: new Uint8ClampedArray(pixels)
    },
    getCalls: 0,
    createCalls: 0,
    putCalls: []
  };
  const context = {
    getImageData(x, y, requestedWidth, requestedHeight) {
      state.getCalls += 1;
      state.lastGetImageData = [x, y, requestedWidth, requestedHeight];
      return {
        width,
        height,
        data: new Uint8ClampedArray(state.imageData.data)
      };
    },
    createImageData(requestedWidth, requestedHeight) {
      state.createCalls += 1;
      return {
        width: requestedWidth,
        height: requestedHeight,
        data: new Uint8ClampedArray(requestedWidth * requestedHeight * 4)
      };
    },
    putImageData(imageData, x, y) {
      state.putCalls.push([imageData, x, y]);
      if (imageData.width === width && imageData.height === height && x === 0 && y === 0) {
        state.imageData = {
          width: imageData.width,
          height: imageData.height,
          data: new Uint8ClampedArray(imageData.data)
        };
        return;
      }
      const next = new Uint8ClampedArray(state.imageData.data);
      for (let row = 0; row < imageData.height; row += 1) {
        const sourceOffset = row * imageData.width * 4;
        const targetOffset = ((y + row) * width + x) * 4;
        next.set(
          imageData.data.subarray(sourceOffset, sourceOffset + imageData.width * 4),
          targetOffset
        );
      }
      state.imageData = {
        width,
        height,
        data: next
      };
    }
  };
  return {
    state,
    editable: {
      canvas: { width, height },
      context,
      texture: {}
    }
  };
}

test("airbrush WebGPU query flag cannot opt out of WebGPU", () => {
  assert.equal(textureAirbrushWebGpuRequestedFromSearch(""), true);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=0"), true);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=false"), true);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=1"), true);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?airbrush-webgpu=true"), true);
});

test("airbrush WebGPU renderer query flag cannot opt out of WebGPU", () => {
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch(""), true);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?webgpu-renderer=0"), true);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?webgpu-renderer=off"), true);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?webgpu-renderer=1"), true);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?renderer-webgpu=true"), true);
});

test("airbrush WebGPU capability uses navigator.gpu", () => {
  assert.equal(textureAirbrushNativeWebGpuAvailable({ navigator: {} }), false);
  assert.equal(textureAirbrushNativeWebGpuAvailable({ navigator: { gpu: {} } }), true);
});

test("airbrush renderer WebGPU state requires a native WebGPU backend", () => {
  assert.deepEqual(textureAirbrushRendererWebGpuState({}), {
    isWebGpuRenderer: false,
    isNativeWebGpuBackend: false
  });
  assert.deepEqual(textureAirbrushRendererWebGpuState({
    isWebGPURenderer: true,
    backend: { isWebGPUBackend: true }
  }), {
    isWebGpuRenderer: true,
    isNativeWebGpuBackend: true
  });
});

test("airbrush backend is WebGPU-only unless native WebGPU is ready", () => {
  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: false,
    webGpuAvailable: true,
    renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }
  }), {
    backend: "webgpu",
    webGpuStatus: "ready"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: false,
    renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }
  }), {
    backend: "none",
    webGpuStatus: "unavailable"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    renderer: { isWebGPURenderer: false }
  }), {
    backend: "none",
    webGpuStatus: "needs-webgpu-renderer"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    renderer: { isWebGPURenderer: true, backend: {} }
  }), {
    backend: "none",
    webGpuStatus: "native-webgpu-required"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }
  }), {
    backend: "webgpu",
    webGpuStatus: "ready"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    visibleSurfaceMaskRequired: true,
    renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }
  }), {
    backend: "none",
    webGpuStatus: "visible-surface-mask-unavailable"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    visibleSurfaceMaskRequired: true,
    renderer: { isWebGLRenderer: true }
  }), {
    backend: "none",
    webGpuStatus: "visible-surface-mask-unavailable"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    visibleSurfaceMaskRequired: true,
    visibleSurfaceMaskReady: true,
    renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }
  }), {
    backend: "webgpu",
    webGpuStatus: "ready"
  });
});

test("airbrush backend does not fall through to CPU when GPU paint is unavailable", () => {
  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: false
  }), {
    backend: "none",
    webGpuStatus: "unavailable"
  });
});

test("airbrush renderer mode obeys native WebGPU readiness", () => {
  function WebGPURenderer() {}

  assert.deepEqual(resolveTextureAirbrushRendererMode({
    preferWebGpuRenderer: false,
    webGpuAvailable: true,
    WebGPURenderer
  }), {
    renderer: "webgpu",
    webGpuRendererStatus: "ready"
  });

  assert.deepEqual(resolveTextureAirbrushRendererMode({
    preferWebGpuRenderer: true,
    webGpuAvailable: false,
    WebGPURenderer
  }), {
    renderer: "none",
    webGpuRendererStatus: "unavailable"
  });

  assert.deepEqual(resolveTextureAirbrushRendererMode({
    preferWebGpuRenderer: true,
    webGpuAvailable: true,
    WebGPURenderer: null
  }), {
    renderer: "none",
    webGpuRendererStatus: "renderer-class-unavailable"
  });

  assert.deepEqual(resolveTextureAirbrushRendererMode({
    preferWebGpuRenderer: true,
    webGpuAvailable: true,
    WebGPURenderer
  }), {
    renderer: "webgpu",
    webGpuRendererStatus: "ready"
  });
});

test("airbrush WebGPU kernel params sanitize brush options", () => {
  const params = textureAirbrushWebGpuKernelParams({
    radiusPixels: 0,
    opacity: 4,
    hardness: -2,
    scatter: 3,
    strength: 2.5,
    color: { r: 300, g: -2, b: 128 },
    strokeSegments: Array.from({ length: TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS + 5 }, () => ({}))
  });

  assert.equal(params.radiusPixels, 0.75);
  assert.equal(params.opacity, 1);
  assert.equal(params.hardness, 0);
  assert.equal(params.scatter, 1);
  assert.equal(params.strength, 2.5);
  assert.deepEqual(params.color, { r: 1, g: 0, b: 128 / 255 });
  assert.equal(params.strokeSegmentCount, TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS);
});

test("airbrush WebGPU dispatch size uses workgroup tiles", () => {
  assert.deepEqual(textureAirbrushWebGpuDispatchSize(17, 33, 8), {
    x: 3,
    y: 5,
    workgroupSize: 8
  });
  assert.deepEqual(textureAirbrushWebGpuDispatchSize(0, 0, 0), {
    x: 1,
    y: 1,
    workgroupSize: 8
  });
});

test("airbrush WebGPU kernel source exposes a compute texture paint pass", () => {
  const source = textureAirbrushWebGpuKernelSource({ maxStrokeSegments: 12, workgroupSize: 4 });

  assert.match(source, /@compute\s+@workgroup_size\(4, 4, 1\)/);
  assert.match(source, /texture_storage_2d<rgba8unorm, write>/);
  assert.match(source, /array<StrokeSegment, 12>/);
  assert.match(source, /fn airbrushCoverage/);
  assert.match(source, /@group\(0\) @binding\(4\) var strokeSourceTexture/);
  assert.match(source, /@group\(0\) @binding\(5\) var visibilityMaskTexture/);
  assert.match(source, /@group\(0\) @binding\(6\) var<storage, read> visibilitySamples/);
  assert.match(source, /fn visibleMaskFeatherCoverage/);
  assert.doesNotMatch(source, /fn visibleTriangleInteriorCoverage/);
  assert.match(source, /fn visibleMaskBlurredCoverage/);
  assert.match(source, /brush\.visibilitySampleCount > 0u/);
  assert.match(source, /visibilityTriangleCount/);
  assert.match(source, /fn triangleVisibilityCoverage/);
  assert.match(source, /let triangleSlot = brush\.visibilitySampleCount \+ triangleIndex \* triangleStride/);
  assert.match(source, /fn visibilityTriangleSlotStride\(\) -> u32 \{\s+return 4u;\s+\}/);
  assert.match(source, /fn textureStrokeAirbrushCoverageWithRadiusLimit\(point: vec2<f32>, radiusLimit: f32\) -> f32/);
  assert.match(source, /fn textureStrokeAirbrushCoverage\(point: vec2<f32>\) -> f32/);
  assert.match(source, /textureStrokeAirbrushCoverageWithRadiusLimit\(point, f32\(max\(brush\.textureSize\.x, brush\.textureSize\.y\)\)\)/);
  assert.match(source, /var maskValue = 0\.0;/);
  assert.match(source, /maskValue = max\(maskValue, triangleValue\);/);
  assert.match(source, /hasTriangleMask && \(brush\.visibilityBleedRadius > 0\.5 \|\| brush\.visibilityFeatherRadius > 0\.5\)/);
  assert.match(source, /In hard mode they must not promote a texel/);
  assert.match(source, /let sampleSoftCap = max\(maskValue, 0\.22\);/);
  assert.match(source, /maskValue = max\(maskValue, min\(value, sampleSoftCap\)\);/);
  assert.doesNotMatch(source, /let sampleSoftCap = max\(maskValue, 0\.80\);/);
  assert.match(source, /maskValue = max\(maskValue, value\);/);
  assert.match(source, /return maskValue;/);
  assert.doesNotMatch(source, /return visibleMaskAt\(pixel\);/);
  assert.match(source, /fn visibleTriangleMaskAt\(pixel: vec2<u32>, allowBleed: bool\) -> f32/);
  assert.match(source, /triangleVisibilityCoverage\(point, a, b, c, second\.end\.x, allowBleed\)/);
  assert.match(source, /Camera-facing triangle interiors are a paint permission/);
  assert.match(source, /soft visible-edge mode can still use the precomputed normal-facing/);
  assert.match(source, /return select\(normalCoverage, 1\.0, normalCoverage >= 0\.985\);/);
  assert.match(source, /let center = visibleTriangleMaskAt\(pixel, false\);/);
  assert.match(source, /fn screenProjectedAirbrushCoverage\(point: vec2<f32>, screenProjectedActive: bool\) -> f32/);
  assert.match(source, /fn perspectiveCorrectScreenPoint/);
  assert.match(source, /let screenPoint = perspectiveCorrectScreenPoint\(/);
  assert.match(source, /var gutterCoverage = 0\.0;/);
  assert.match(source, /var insideAnyProjectedTriangle = false;/);
  assert.match(source, /let gutterRadius = max\(0\.0, brush\.visibilityBleedRadius\);/);
  assert.match(source, /let gutterEdge = closestTriangleEdgePoint\(point, first\.start, first\.end, second\.start\);/);
  assert.match(source, /let gutterOuterFade = min\(3\.0, max\(1\.0, gutterRadius \* 0\.125\)\);/);
  assert.match(source, /let gutterFade = 1\.0 - smoothstep\(max\(0\.0, gutterRadius - gutterOuterFade\), gutterRadius, gutterEdge\.z\);/);
  assert.match(source, /Gutter coverage is only for unrendered UV padding/);
  assert.match(source, /return select\(gutterCoverage, interiorCoverage, insideAnyProjectedTriangle\);/);
  assert.match(source, /airbrushCoverage\(distancePixels, screenRadius\)/);
  assert.match(source, /fn visibilitySamplePermission\(pixel: vec2<u32>, threshold: f32, screenProjectedActive: bool\) -> f32/);
  assert.match(source, /screenProjectedAirbrushCoverage\(vec2<f32>\(f32\(pixel\.x\), f32\(pixel\.y\)\), true\)/);
  assert.match(source, /continuous camera-facing permission field/);
  assert.match(source, /sampleCoverage <= threshold\) \{\s*return 0\.0;\s*\}/);
  assert.match(source, /Visibility is only a\s+\/\/ camera-facing permission gate/);
  assert.match(source, /return 1\.0;/);
  assert.match(source, /return smoothstep\(threshold, max\(threshold \+ 0\.0001, 1\.0\), sampleCoverage\);/);
  assert.doesNotMatch(source, /return max\(interiorCoverage, gutterCoverage\);/);
  assert.match(source, /compactPaintRegionTriangles/);
  assert.match(source, /fn visibilitySamplePermissionForTriangle\([\s\S]*?maxGutterRadius: f32[\s\S]*?\) -> f32/);
  assert.match(source, /fn visibleMaskFeatherCoverageForTriangle\([\s\S]*?maxGutterRadius: f32[\s\S]*?\) -> f32/);
  assert.match(source, /fn screenProjectedAirbrushCoverageForTriangle\([\s\S]*?maxGutterRadius: f32[\s\S]*?\) -> f32/);
  assert.match(source, /if \(!allowGutter \|\| gutterRadius <= 0\.5\) \{\s+return 0\.0;/);
  assert.match(source, /let samplePermission = visibilitySamplePermission\(pixel, threshold, screenProjectedActive\);/);
  assert.match(source, /keep the interior gate binary/);
  assert.match(source, /cannot print UV islands, triangle borders, or paint-region slabs/);
  assert.match(source, /if \(screenProjectedActive\) \{\s+\/\/ Projected strokes get their visible falloff/);
  assert.match(source, /if \(screenProjectedActive\) \{\s+\/\/ Projected strokes get their visible falloff[\s\S]*?return 1\.0;\s+\}\s+let softRadius = max\(brush\.visibilityFeatherRadius, bleed\);/);
  assert.doesNotMatch(source, /if \(screenProjectedActive\)[\s\S]*?return center;\s+\}\s+let softRadius = max\(brush\.visibilityFeatherRadius, bleed\);/);
  assert.match(source, /let softRadius = max\(brush\.visibilityFeatherRadius, bleed\);/);
  assert.match(source, /let softened = smoothstep\(threshold, 1\.0, blurredVisibility\);/);
  assert.match(source, /return clamp\(max\(softened, min\(center, 0\.18\)\), 0\.0, center\);/);
  assert.match(source, /return samplePermission;/);
  assert.doesNotMatch(source, /return min\(samplePermission, 0\.56\);/);
  assert.doesNotMatch(source, /if \(!screenProjectedActive\) \{\s+let samplePermission = visibilitySamplePermission\(pixel, threshold\);/);
  assert.doesNotMatch(source, /let softTriangleCoverage = min\(visibleTriangleMaskAt\(pixel, true\), 0\.22\);/);
  assert.doesNotMatch(source, /return softTriangleCoverage;/);
  assert.doesNotMatch(source, /fn visibleTriangleMaskBlurredCoverage/);
  assert.doesNotMatch(source, /let triangleBlur = visibleTriangleMaskBlurredCoverage/);
  assert.doesNotMatch(source, /toothFeather/);
  assert.match(source, /fn visibleSampleMaskAt\(pixel: vec2<u32>\) -> f32/);
  assert.match(source, /visibilityBleedRadius/);
  assert.match(source, /edgeDistance > bleed/);
  assert.match(source, /hiddenEdgeCoverage/);
  assert.match(source, /hiddenEdgeCoverage \* 0\.88/);
  assert.match(source, /if \(!centerAllowed\) \{\s+\/\/ Respect the camera-facing normal cutoff\./);
  assert.doesNotMatch(source, /if \(!centerAllowed && bleed <= 0\.5\)/);
  assert.match(source, /select\(bleed, feather, centerAllowed\)/);
  assert.match(source, /if \(!compactTriangleActive\) \{\s+textureStore\(outputTexture, vec2<i32>\(pixel\), current\);\s+\}\s+return;/);
  assert.match(source, /camera-facing permission/);
  assert.match(source, /projected surface field owns the airbrush shape/);
  assert.match(source, /let screenProjectedActive = screenProjectedCoverageActive\(\);/);
  assert.match(source, /var visibilityCoverage = 0\.0;/);
  assert.match(source, /var compactProjectedGutterRadius = 0\.0;/);
  assert.match(source, /if \(screenProjectedActive\) \{\s+compactProjectedGutterRadius = 16\.0;\s+\}/);
  assert.match(source, /visibilityCoverage = visibleMaskFeatherCoverageForTriangle\([\s\S]*?compactProjectedGutterRadius > 0\.5,[\s\S]*?compactProjectedGutterRadius[\s\S]*?\);/);
  assert.doesNotMatch(source, /visibilityCoverage = visibleMaskFeatherCoverageForTriangle\(pixel, id\.z, screenProjectedActive\);/);
  assert.match(source, /visibilityCoverage = visibleMaskFeatherCoverage\(pixel, screenProjectedActive\);/);
  assert.match(source, /let point = vec2<f32>\(f32\(pixel\.x\), f32\(pixel\.y\)\);/);
  assert.doesNotMatch(source, /projectedVisibility\.screenPoint/);
  assert.match(source, /let textureCoverage = textureStrokeAirbrushCoverage\(point\);/);
  assert.match(source, /var projectedCoverage = 0\.0;/);
  assert.match(source, /projectedCoverage = screenProjectedAirbrushCoverageForTriangle\(point, id\.z, compactProjectedGutterRadius > 0\.5, compactProjectedGutterRadius\);/);
  assert.match(source, /projectedCoverage = screenProjectedAirbrushCoverage\(point, screenProjectedActive\);/);
  assert.doesNotMatch(source, /let directInteriorCoverage = select\(/);
  assert.doesNotMatch(source, /textureCoverage \* visibleTriangleInteriorCoverage\(pixel, max\(2\.0, brush\.radiusPixels \* 0\.25\)\)/);
  assert.match(source, /let coverage = select\(textureCoverage, projectedCoverage, screenProjectedActive\);/);
  assert.doesNotMatch(source, /let coverage = max\(textureCoverage, projectedCoverage\);/);
  assert.doesNotMatch(source, /textureStrokeAirbrushCoverageWithRadiusLimit\(point, seamBridgeRadius\)/);
  assert.doesNotMatch(source, /let seamBridgeCoverage = screenProjectedAirbrushCoverage\(point, screenProjectedActive\);/);
  assert.doesNotMatch(source, /let coverage = select\(textureCoverage, max\(projectedCoverage, seamBridgeCoverage\), screenProjectedActive\);/);
  assert.match(source, /if \(coverage <= 0\.0001\) \{\s+if \(!compactTriangleActive\) \{\s+textureStore\(outputTexture, vec2<i32>\(pixel\), current\);\s+\}\s+return;\s+\}/);
  assert.match(source, /let strokeSource = textureLoad\(strokeSourceTexture/);
  assert.match(source, /coverage \* visibilityCoverage/);
  assert.match(source, /let visibilityAlphaCap = max\(strokeSource\.a, visibilityCoverage\)/);
  assert.match(source, /let effectiveAlpha = min\(alpha, maxAlphaForVisibility\)/);
  assert.match(source, /if \(effectiveAlpha <= 0\.008\) \{\s+if \(!compactTriangleActive\) \{\s+textureStore\(outputTexture, vec2<i32>\(pixel\), current\);\s+\}\s+return;\s+\}/);
  assert.match(source, /let layerAlpha = effectiveAlpha \+ strokeSource\.a \* \(1\.0 - effectiveAlpha\)/);
  assert.match(source, /strokeSource\.a < 0\.9999/);
  assert.match(source, /clamp\(alphaProgress, 0\.0, 1\.0\)/);
  assert.match(source, /clamp\(colorProgress, 0\.0, 1\.0\)/);
  assert.match(source, /let currentColorDistance = dot\(current\.rgb - brush\.color\.rgb, current\.rgb - brush\.color\.rgb\)/);
  assert.match(source, /let proposedColorDistance = dot\(proposed\.rgb - brush\.color\.rgb, proposed\.rgb - brush\.color\.rgb\)/);
  assert.match(source, /currentProgress \+ 0\.0001 >= effectiveAlpha && currentColorDistance <= proposedColorDistance \+ 0\.0001/);
  assert.doesNotMatch(source, /proposedProgress/);
  assert.match(source, /textureStore/);
});

test("airbrush shared brush math drives JS and WebGPU kernel falloff", () => {
  const halo = airbrushHaloRadius(10, 0.5, 0.4);
  assert.equal(halo, 10);
  assert.equal(airbrushAlphaForDistance(halo + 0.01, 10, 0.8, 0.5, 0.4), 0);
  assert.equal(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD, 0.004);
  assert.equal(TEXTURE_AIRBRUSH_SOFT_HALO_SCALE, 0.85);
  assert.equal(airbrushAlphaForDistance(0, 10, 0.8, 0.5, 0.4), 0.8);

  const softMid = airbrushAlphaForDistance(5, 10, 1, 0.35, 0);
  const defaultMid = airbrushAlphaForDistance(5, 10, 1, 0.35, 0.35);
  const hardMid = airbrushAlphaForDistance(5, 10, 1, 0.35, 1);
  assert.ok(softMid > 0 && softMid < defaultMid);
  assert.ok(defaultMid > 0 && defaultMid < hardMid);
  assert.equal(hardMid, 1);

  const nominalEdgeNoScatter = airbrushAlphaForDistance(10, 10, 1, 0, 0.35);
  const nominalEdgeWithScatter = airbrushAlphaForDistance(10, 10, 1, 0.8, 0.35);
  assert.equal(nominalEdgeNoScatter, 0);
  assert.equal(nominalEdgeWithScatter, 0);
  const midNoScatter = airbrushAlphaForDistance(7, 10, 1, 0, 0.35);
  const midWithScatter = airbrushAlphaForDistance(7, 10, 1, 0.8, 0.35);
  assert.ok(midWithScatter > 0);
  assert.ok(midWithScatter < midNoScatter);
  assert.ok(airbrushAlphaForDistance(airbrushHaloRadius(10, 0, 0.35), 10, 1, 0, 0.35) < 0.001);
  assert.ok(airbrushAlphaForDistance(airbrushHaloRadius(10, 0, 0.08) + 0.01, 10, 1, 0, 0.08) === 0);

  const source = textureAirbrushWebGpuKernelSource();
  assert.match(source, /let haloRadius = radius/);
  assert.doesNotMatch(source, new RegExp(`scatter \\* ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE}`));
  assert.doesNotMatch(source, new RegExp(`softness \\* ${TEXTURE_AIRBRUSH_SOFT_HALO_SCALE}`));
  assert.match(source, new RegExp(`${TEXTURE_AIRBRUSH_CORE_MIN_SCALE} \\+ pow\\(hardness, ${TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER}\\) \\* ${TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE}`));
  assert.match(source, new RegExp(`${TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE} \\+ pow\\(hardness, ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER}\\) \\* ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE} - scatter \\* ${TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE}`));
  assert.match(source, /let fadeRadius = max\(1\.0, haloRadius - coreRadius\)/);
  assert.match(source, /let shaped = clamp\(pow\(normalized, exponent\), 0\.0, 1\.0\)/);
  assert.match(source, /let smoothEdge = shaped \* shaped \* \(3\.0 - 2\.0 \* shaped\)/);
  assert.match(source, /return min\(1\.0, max\(0\.0, 1\.0 - smoothEdge\)\)/);
  assert.doesNotMatch(source, /tailAlpha/);
});

test("airbrush WebGPU stroke estimate uses precise paint regions when available", () => {
  const estimate = textureAirbrushWebGpuStrokeEstimate({
    radiusPixels: 500,
    strokeSegments: [{
      start: { x: 0, y: 0 },
      end: { x: 4096, y: 4096 }
    }],
    paintRegions: [
      { x: 10, y: 20, width: 32, height: 48 },
      { x: 300, y: 400, width: 12, height: 10 }
    ]
  });

  assert.equal(estimate, 1656);
});

test("airbrush WebGPU uniform buffer packs the brush struct layout", () => {
  const data = textureAirbrushWebGpuBrushUniformData({
    radiusPixels: 12,
    opacity: 0.5,
    hardness: 0.25,
    scatter: 0.75,
    strength: 2,
    strokeSegmentCount: 3,
    color: { r: 0.25, g: 0.5, b: 1 }
  }, 256, 128);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  assert.equal(data.byteLength, 128);
  assert.equal(view.getUint32(0, true), 256);
  assert.equal(view.getUint32(4, true), 128);
  assert.equal(view.getFloat32(8, true), 12);
  assert.equal(view.getFloat32(12, true), 0.5);
  assert.equal(view.getFloat32(16, true), 0.25);
  assert.equal(view.getFloat32(20, true), 0.75);
  assert.equal(view.getFloat32(24, true), 2);
  assert.equal(view.getUint32(28, true), 3);
  assert.equal(view.getFloat32(32, true), 0.25);
  assert.equal(view.getFloat32(36, true), 0.5);
  assert.equal(view.getFloat32(40, true), 1);
  assert.equal(view.getUint32(48, true), 0);
  assert.equal(view.getUint32(52, true), 0);
  assert.equal(view.getUint32(112, true), 0);
  assert.equal(view.getUint32(56, true), 256);
  assert.equal(view.getUint32(60, true), 128);
  assert.equal(view.getUint32(64, true), 0);
  assert.equal(view.getFloat32(68, true), 0);
  assert.equal(view.getFloat32(72, true), 0.5);
  assert.equal(view.getFloat32(76, true), 0);
  assert.equal(view.getUint32(80, true), 0);
  assert.equal(view.getFloat32(84, true), 0.5);
  assert.equal(view.getUint32(88, true), 0);
  assert.equal(view.getUint32(92, true), 0);
  assert.equal(view.getUint32(96, true), 0);
  assert.equal(view.getUint32(100, true), 0);
  assert.equal(view.getUint32(104, true), 0);
  assert.equal(view.getUint32(108, true), 0);

  const masked = textureAirbrushWebGpuBrushUniformData({
    useVisibilityMask: 1,
    visibilityFeatherRadius: 4,
    visibilityMaskThreshold: 0.25,
    visibilityBleedRadius: 1.5,
    visibilitySampleCount: 2,
    visibilityMaskStampRadiusPixels: 3.5,
    useVisibilitySamples: 1,
    visibilityTriangleCount: 3
  }, 32, 16);
  const maskedView = new DataView(masked.buffer, masked.byteOffset, masked.byteLength);
  assert.equal(maskedView.getUint32(64, true), 1);
  assert.equal(maskedView.getFloat32(68, true), 4);
  assert.equal(maskedView.getFloat32(72, true), 0.25);
  assert.equal(maskedView.getFloat32(76, true), 1.5);
  assert.equal(maskedView.getUint32(80, true), 2);
  assert.equal(maskedView.getFloat32(84, true), 3.5);
  assert.equal(maskedView.getUint32(88, true), 1);
  assert.equal(maskedView.getUint32(92, true), 3);

  const dirty = textureAirbrushWebGpuBrushUniformData({
    radiusPixels: 12,
    strokeSegmentCount: 1
  }, 256, 128, {
    x: 10,
    y: 12,
    width: 20,
    height: 22
  });
  const dirtyView = new DataView(dirty.buffer, dirty.byteOffset, dirty.byteLength);
  assert.equal(dirtyView.getUint32(48, true), 10);
  assert.equal(dirtyView.getUint32(52, true), 12);
  assert.equal(dirtyView.getUint32(56, true), 20);
  assert.equal(dirtyView.getUint32(60, true), 22);
});

test("airbrush WebGPU stroke buffer packs segment endpoints and radii", () => {
  const data = textureAirbrushWebGpuStrokeBufferData([
    { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, radiusPixels: 9 },
    { start: { clientX: 5, clientY: 6 }, end: { clientX: 7, clientY: 8 } }
  ], { maxStrokeSegments: 3, radiusPixels: 12 });

  assert.deepEqual([...data], [
    1, 2, 3, 4, 9, 0,
    5, 6, 7, 8, 12, 0,
    0, 0, 0, 0, 0, 0
  ]);
});

test("airbrush WebGPU visibility sample buffer packs compact point and segment permissions", () => {
  const data = textureAirbrushWebGpuVisibilitySampleBufferData([
    { x: 1, y: 2 },
    { segment: { start: { x: 3, y: 4 }, end: { x: 5, y: 6 } } }
  ], { maxVisibilitySamples: 3 });

  assert.deepEqual(visibilitySampleSlots(data), [
    [1, 2, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0],
    [3, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  ]);
});

test("airbrush WebGPU visibility sample buffer packs triangle permissions", () => {
  const data = textureAirbrushWebGpuVisibilitySampleBufferData([], {
    triangles: [{
      a: { x: 1, y: 2 },
      b: { x: 3, y: 4 },
      c: { x: 5, y: 6 }
    }],
    maxVisibilitySamples: 4
  });

  assert.deepEqual(visibilitySampleSlots(data), [
    [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0],
    [5, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  ]);
});

test("airbrush WebGPU visibility sample buffer packs samples before triangle permissions", () => {
  const data = textureAirbrushWebGpuVisibilitySampleBufferData([
    { segment: { start: { x: 1, y: 2 }, end: { x: 3, y: 4 } } }
  ], {
    triangles: [{
      a: { x: 5, y: 6 },
      b: { x: 7, y: 8 },
      c: { x: 9, y: 10 }
    }],
    maxVisibilitySamples: 5
  });

  assert.deepEqual(visibilitySampleSlots(data), [
    [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0],
    [5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0],
    [9, 10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  ]);
});

test("airbrush WebGPU visibility sample buffer packs triangle facing coverage", () => {
  const data = textureAirbrushWebGpuVisibilitySampleBufferData([], {
    triangles: [{
      a: { x: 1, y: 2 },
      b: { x: 3, y: 4 },
      c: { x: 5, y: 6 },
      coverage: 0.25
    }],
    maxVisibilitySamples: 4
  });

  assert.deepEqual(visibilitySampleSlots(data), [
    [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0],
    [5, 6, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  ]);
});

test("airbrush WebGPU paint plan prepares descriptors for dispatch", () => {
  const scope = {
    GPUTextureUsage: {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8,
      RENDER_ATTACHMENT: 16
    },
    GPUBufferUsage: {
      COPY_DST: 8,
      UNIFORM: 64,
      STORAGE: 128
    },
    GPUShaderStage: {
      COMPUTE: 4
    }
  };
  const plan = textureAirbrushWebGpuPaintPlan({
    width: 17,
    height: 33,
    workgroupSize: 8,
    maxStrokeSegments: 4,
    scope,
    options: {
      radiusPixels: 9,
      opacity: 0.5,
      strokeSegments: [{ start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }]
    }
  });

  assert.deepEqual(plan.paintBounds, { x: 0, y: 0, width: 15, height: 16 });
  assert.deepEqual(plan.dispatch, { x: 2, y: 2, workgroupSize: 8 });
  assert.equal(plan.textures.source.usage, 31);
  assert.equal(plan.textures.source.mipLevelCount, 6);
  assert.equal(plan.textures.output.usage, 31);
  assert.equal(plan.buffers.uniform.usage, 72);
  assert.equal(plan.buffers.strokes.usage, 136);
  assert.equal(plan.buffers.readback.usage, 9);
  assert.equal(plan.buffers.readback.layout.bytesPerRow, 256);
  assert.equal(plan.buffers.readback.size, 256 * 16);
  assert.equal(plan.buffers.readback.layout.width, 15);
  assert.equal(plan.buffers.readback.layout.height, 16);
  assert.equal(plan.buffers.uniform.data.byteLength, 128);
  assert.equal(plan.buffers.strokes.data.length, 24);
  assert.equal(plan.buffers.visibilitySamples.data.length, 48);
  assert.equal(plan.buffers.paintRegions.data.length, TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS * 4);
  assert.equal(plan.bindGroupLayoutEntries.length, 8);
  assert.deepEqual(textureAirbrushWebGpuUsageConstants(scope).shaderStage, { compute: 4 });
  assert.deepEqual(textureAirbrushWebGpuBindGroupLayoutEntries(scope).map((entry) => entry.binding), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(textureAirbrushWebGpuTextureDescriptors(4, 5, scope).strokeSource.usage, 7);
  assert.equal(textureAirbrushWebGpuTextureDescriptors(4, 5, scope).visibilityMask.usage, 6);
  assert.deepEqual(textureAirbrushWebGpuTextureDescriptors(4, 5, scope).output.size, {
    width: 4,
    height: 5,
    depthOrArrayLayers: 1
  });
  assert.equal(textureAirbrushWebGpuAlignedBytesPerRow(65), 512);
  assert.deepEqual(textureAirbrushWebGpuPaintBounds(100, 80, {
    strokeSegments: [{ start: { x: 40, y: 30 }, end: { x: 45, y: 35 } }],
    radiusPixels: 4,
    scatter: 0
  }), {
    x: 34,
    y: 24,
    width: 18,
    height: 18
  });
  assert.deepEqual(textureAirbrushWebGpuReadbackLayout(3, 2), {
    bytesPerRow: 256,
    rowsPerImage: 2,
    byteLength: 512,
    unpaddedBytesPerRow: 12
  });
  assert.equal(textureAirbrushWebGpuReadbackBufferDescriptor(3, 2, scope).usage, 9);
});

test("airbrush WebGPU paint plan preserves large projected region sets", () => {
  const paintRegions = Array.from({ length: 108 }, (_, index) => ({
    x: (index % 18) * 12,
    y: Math.floor(index / 18) * 14,
    width: 8,
    height: 9
  }));
  const plan = textureAirbrushWebGpuPaintPlan({
    width: 512,
    height: 512,
    options: {
      compactPaintRegions: true,
      paintRegions,
      strokeSegments: [{ start: { x: 12, y: 14 }, end: { x: 96, y: 120 } }]
    }
  });

  assert.equal(plan.compactPaintRegions, true);
  assert.equal(plan.paintRegions.length, paintRegions.length);
  assert.equal(plan.params.paintRegionCount, paintRegions.length);
  assert.deepEqual(plan.paintBounds, { x: 0, y: 0, width: 8, height: 9 });
  assert.deepEqual(plan.dispatch, { x: 1, y: 2, workgroupSize: 8, z: paintRegions.length });
  assert.equal(plan.buffers.paintRegions.data.length, TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS * 4);
  const finalOffset = (paintRegions.length - 1) * 4;
  assert.deepEqual(
    [...plan.buffers.paintRegions.data.slice(finalOffset, finalOffset + 4)],
    [
      paintRegions.at(-1).x,
      paintRegions.at(-1).y,
      paintRegions.at(-1).width,
      paintRegions.at(-1).height
    ]
  );
});

test("airbrush WebGPU paint plan falls back instead of truncating over-cap regions", () => {
  const paintRegions = Array.from({ length: TEXTURE_AIRBRUSH_WEBGPU_MAX_PAINT_REGIONS + 1 }, (_, index) => ({
    x: index % 512,
    y: Math.floor(index / 512),
    width: 2,
    height: 2
  }));
  const plan = textureAirbrushWebGpuPaintPlan({
    width: 1024,
    height: 1024,
    options: {
      compactPaintRegions: true,
      paintRegions,
      paintBounds: { x: 32, y: 48, width: 640, height: 512 },
      strokeSegments: [{ start: { x: 64, y: 64 }, end: { x: 128, y: 128 } }]
    }
  });

  assert.equal(plan.compactPaintRegions, false);
  assert.deepEqual(plan.paintRegions, []);
  assert.equal(plan.params.paintRegionCount, 0);
  assert.deepEqual(plan.paintBounds, { x: 32, y: 48, width: 640, height: 512 });
});

test("airbrush WebGPU paint plan keeps UV visibility samples before triangle permissions", () => {
  const plan = textureAirbrushWebGpuPaintPlan({
    width: 16,
    height: 16,
    maxStrokeSegments: 8,
    options: {
      useVisibilityMask: true,
      visibilityMaskSamples: Array.from({ length: 5 }, (_, index) => ({ x: index, y: index + 1 })),
      visibilityMaskTriangles: Array.from({ length: 4 }, (_, index) => ({
        a: { x: index, y: index },
        b: { x: index + 1, y: index },
        c: { x: index, y: index + 1 }
      })),
      strokeSegments: [{ start: { x: 2, y: 2 }, end: { x: 6, y: 6 } }]
    }
  });

  assert.equal(plan.params.visibilitySampleCount, 4);
  assert.equal(plan.params.visibilityTriangleCount, 1);
  assert.equal(plan.params.useVisibilitySamples, 1);
  const samples = plan.buffers.visibilitySamples.data;
  const stride = TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
  assert.deepEqual([...samples.slice(0, 4)], [0, 1, 0, 1]);
  assert.deepEqual([...samples.slice(stride, stride + 4)], [1, 2, 1, 2]);
  assert.deepEqual([...samples.slice(stride * 2, stride * 2 + 4)], [3, 4, 3, 4]);
  assert.deepEqual([...samples.slice(stride * 3, stride * 3 + 4)], [4, 5, 4, 5]);
  assert.deepEqual([...samples.slice(stride * 4, stride * 4 + 4)], [0, 0, 1, 0]);
  assert.deepEqual([...samples.slice(stride * 5, stride * 5 + 4)], [0, 1, 1, 0]);
});

test("airbrush WebGPU paint plan packs screen vertices without enabling screen coverage", () => {
  const plan = textureAirbrushWebGpuPaintPlan({
    width: 16,
    height: 16,
    maxStrokeSegments: 8,
    options: {
      useVisibilityMask: true,
      visibilityMaskTriangles: Array.from({ length: 3 }, (_, index) => ({
        a: { x: index, y: index },
        b: { x: index + 1, y: index },
        c: { x: index, y: index + 1 },
        screenA: { x: index + 10, y: index + 20 },
        screenB: { x: index + 11, y: index + 20 },
        screenC: { x: index + 10, y: index + 21 }
      })),
      strokeSegments: [{ start: { x: 2, y: 2 }, end: { x: 6, y: 6 } }]
    }
  });

  assert.equal(plan.params.visibilitySampleCount, 0);
  assert.equal(plan.params.visibilityTriangleCount, 2);
  assert.equal(plan.params.useVisibilitySamples, 0);
  const samples = plan.buffers.visibilitySamples.data;
  const stride = TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
  assert.deepEqual([...samples.slice(0, 4)], [0, 0, 1, 0]);
  assert.deepEqual([...samples.slice(stride, stride + 4)], [0, 1, 1, 1]);
  assert.deepEqual([...samples.slice(stride * 2, stride * 2 + 4)], [10, 20, 11, 20]);
  assert.deepEqual([...samples.slice(stride * 3, stride * 3 + 4)], [10, 21, 0, 0]);
  assert.deepEqual([...samples.slice(stride * 4, stride * 4 + 4)], [2, 2, 3, 2]);
  assert.deepEqual([...samples.slice(stride * 5, stride * 5 + 4)], [2, 3, 1, 1]);
  assert.deepEqual([...samples.slice(stride * 6, stride * 6 + 4)], [12, 22, 13, 22]);
  assert.deepEqual([...samples.slice(stride * 7, stride * 7 + 4)], [12, 23, 0, 0]);
});

test("airbrush WebGPU paint plan uploads screen stroke samples for projected triangle coverage", () => {
  const plan = textureAirbrushWebGpuPaintPlan({
    width: 16,
    height: 16,
    maxStrokeSegments: 8,
    options: {
      useVisibilityMask: true,
      visibilityMaskSamples: [{ x: 1, y: 2 }],
      screenProjectedStrokeSegments: [{
        start: { x: 30, y: 40 },
        end: { x: 50, y: 60 },
        radiusPixels: 12,
        viewStart: { x: 1, y: 2, z: -10 },
        viewEnd: { x: 3, y: 4, z: -12 },
        viewRadiusPixels: 0.75
      }],
      visibilityMaskTriangles: [{
        a: { x: 0, y: 0 },
        b: { x: 1, y: 0 },
        c: { x: 0, y: 1 },
        screenA: { x: 10, y: 20, viewX: 1, viewY: 2, viewZ: -10 },
        screenB: { x: 11, y: 20, viewX: 2, viewY: 2, viewZ: -10 },
        screenC: { x: 10, y: 21, viewX: 1, viewY: 3, viewZ: -10 }
      }],
      strokeSegments: [{ start: { x: 2, y: 2 }, end: { x: 6, y: 6 } }]
    }
  });

  assert.equal(plan.params.visibilitySampleCount, 1);
  assert.equal(plan.params.visibilityTriangleCount, 1);
  assert.equal(plan.params.visibilityMaskStampRadiusPixels, 12);
  const samples = plan.buffers.visibilitySamples.data;
  const stride = TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS;
  assert.deepEqual([...samples.slice(0, 4)], [30, 40, 50, 60]);
  assert.deepEqual([...samples.slice(4, 8)], [1, 2, -10, 1]);
  assert.deepEqual([...samples.slice(8, 12)], [3, 4, -12, 0.75]);
  assert.deepEqual([...samples.slice(stride, stride + 4)], [0, 0, 1, 0]);
  assert.deepEqual([...samples.slice(stride + 4, stride + 8)], [1, 2, -10, 1]);
  assert.deepEqual([...samples.slice(stride + 8, stride + 12)], [2, 2, -10, 1]);
  assert.deepEqual([...samples.slice(stride * 2, stride * 2 + 4)], [0, 1, 1, 1]);
  assert.deepEqual([...samples.slice(stride * 2 + 4, stride * 2 + 8)], [1, 3, -10, 1]);
  assert.deepEqual([...samples.slice(stride * 3, stride * 3 + 4)], [10, 20, 11, 20]);
  assert.deepEqual([...samples.slice(stride * 4, stride * 4 + 4)], [10, 21, 0, 0]);
});

test("airbrush WebGPU paint plan reserves projected visibility slots for UV triangles", () => {
  const plan = textureAirbrushWebGpuPaintPlan({
    width: 512,
    height: 512,
    options: {
      useVisibilityMask: true,
      screenProjectedStrokeSegments: Array.from({ length: 128 }, (_, index) => ({
        start: { x: index, y: 40 },
        end: { x: index + 1, y: 41 },
        radiusPixels: 48
      })),
      visibilityMaskTriangles: Array.from({ length: 160 }, (_, index) => ({
        a: { x: index, y: index },
        b: { x: index + 1, y: index },
        c: { x: index, y: index + 1 },
        screenA: { x: index + 10, y: index + 20 },
        screenB: { x: index + 11, y: index + 20 },
        screenC: { x: index + 10, y: index + 21 }
      })),
      strokeSegments: [{ start: { x: 220, y: 220 }, end: { x: 280, y: 280 } }]
    }
  });

  assert.equal(plan.params.visibilitySampleCount, Math.min(128, TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE));
  assert.equal(
    plan.params.visibilityTriangleCount,
    Math.min(
      160,
      Math.floor(
        (TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS - Math.min(128, TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE)) / 4
      )
    )
  );
});

test("airbrush WebGPU device detection requires a native WebGPU renderer backend", () => {
  const device = fakeWebGpuDevice();

  assert.equal(textureAirbrushWebGpuDeviceFromRenderer(null), null);
  assert.equal(textureAirbrushWebGpuDeviceFromRenderer({
    isWebGPURenderer: false,
    backend: { device }
  }), null);
  assert.equal(textureAirbrushWebGpuDeviceFromRenderer({
    isWebGPURenderer: true,
    backend: { isWebGPUBackend: true, device }
  }), device);
});

test("airbrush WebGPU dispatch helper allocates resources and submits compute work", () => {
  const device = fakeWebGpuDevice();
  const payload = {
    source: textureAirbrushWebGpuKernelSource({ maxStrokeSegments: 4, workgroupSize: 8 }),
    plan: textureAirbrushWebGpuPaintPlan({
      width: 17,
      height: 33,
      maxStrokeSegments: 4,
      workgroupSize: 8,
      options: {
        strokeSegments: [{ start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }]
      }
    })
  };
  const sourcePixels = new Uint8Array(payload.plan.width * payload.plan.height * 4);

  const run = textureAirbrushRunWebGpuPaint(device, payload, {
    sourcePixels,
    label: "test-airbrush"
  });

  assert.equal(run.result.dispatch.x, 3);
  assert.equal(run.result.dispatch.y, 4);
  assert.equal(run.result.outputTexture, run.resources.outputTexture);
  assert.ok(device.calls.some((call) => call[0] === "createShaderModule" && call[2] === true));
  assert.ok(device.calls.some((call) => call[0] === "createComputePipeline" && call[1] === "textureAirbrushPaint"));
  assert.ok(device.calls.some((call) => call[0] === "writeBuffer" && call[4] === 128));
  assert.ok(device.calls.some((call) => call[0] === "writeTexture" && call[3] === payload.plan.width * 4));
  assert.ok(device.calls.some((call) => call[0] === "createBindGroup" && call[1] === "0,1,2,3,4,5,6,7"));
  assert.ok(device.calls.some((call) => call[0] === "dispatchWorkgroups" && call[1] === 3 && call[2] === 4 && call[3] === 1));
  assert.deepEqual(device.calls.at(-1), ["submit", 1]);
});

test("airbrush WebGPU resources bind an optional visibility mask texture", () => {
  const device = fakeWebGpuDevice();
  const visibilityMaskPixels = new Uint8Array(4 * 4 * 4);
  visibilityMaskPixels.fill(255);
  const payload = {
    source: textureAirbrushWebGpuKernelSource({ maxStrokeSegments: 2, workgroupSize: 8 }),
    plan: textureAirbrushWebGpuPaintPlan({
      width: 4,
      height: 4,
      maxStrokeSegments: 2,
      workgroupSize: 8,
      options: {
        visibilityMaskPixels,
        visibilityFeatherRadius: 3,
        visibilityMaskThreshold: 0.4,
        visibilityBleedRadius: 1.25,
        strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 3, y: 3 } }]
      }
    })
  };

  const run = textureAirbrushRunWebGpuPaint(device, payload, {
    sourcePixels: new Uint8Array(4 * 4 * 4),
    visibilityMaskPixels,
    label: "test-airbrush-mask"
  });

  const uniformView = new DataView(payload.plan.buffers.uniform.data.buffer);
  assert.equal(payload.plan.params.useVisibilityMask, 1);
  assert.equal(uniformView.getUint32(64, true), 1);
  assert.equal(uniformView.getFloat32(68, true), 3);
  assert.ok(Math.abs(uniformView.getFloat32(72, true) - 0.4) < 0.000001);
  assert.ok(Math.abs(uniformView.getFloat32(76, true) - 1.25) < 0.000001);
  assert.ok(run.resources.visibilityMaskTexture);
  assert.ok(device.calls.some((call) => call[0] === "createTexture" && call[1] === "test-airbrush-mask-visibility-mask-texture"));
  assert.ok(device.calls.some((call) => call[0] === "writeTexture" && call[6] === "test-airbrush-mask-visibility-mask-texture"));
  assert.ok(device.calls.some((call) => call[0] === "createBindGroup" && call[1] === "0,1,2,3,4,5,6,7"));
});

test("airbrush WebGPU resources bind compact visibility samples without uploading a mask texture", () => {
  const device = fakeWebGpuDevice();
  const payload = {
    source: textureAirbrushWebGpuKernelSource({ maxStrokeSegments: 2, workgroupSize: 8 }),
    plan: textureAirbrushWebGpuPaintPlan({
      width: 4,
      height: 4,
      maxStrokeSegments: 2,
      workgroupSize: 8,
      options: {
        useVisibilityMask: true,
        visibilityMaskSamples: [
          { x: 1, y: 1 },
          { segment: { start: { x: 0, y: 0 }, end: { x: 3, y: 3 } } }
        ],
        visibilityMaskStampRadiusPixels: 2,
        strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 3, y: 3 } }]
      }
    })
  };

  const run = textureAirbrushRunWebGpuPaint(device, payload, {
    sourcePixels: new Uint8Array(4 * 4 * 4),
    label: "test-airbrush-samples"
  });

  const uniformView = new DataView(payload.plan.buffers.uniform.data.buffer);
  assert.equal(payload.plan.params.useVisibilityMask, 1);
  assert.equal(payload.plan.params.visibilitySampleCount, 2);
  assert.equal(uniformView.getUint32(80, true), 2);
  assert.equal(uniformView.getFloat32(84, true), 2);
  assert.equal(uniformView.getUint32(88, true), 1);
  assert.ok(run.resources.visibilitySampleBuffer);
  assert.ok(device.calls.some((call) => call[0] === "createBuffer" && call[1] === "test-airbrush-samples-visibility-sample-buffer"));
  assert.ok(device.calls.some((call) => (
    call[0] === "writeBuffer"
    && call[4] === 2 * TEXTURE_AIRBRUSH_WEBGPU_VISIBILITY_SAMPLE_FLOATS * 4
  )));
  assert.equal(
    device.calls.some((call) => call[0] === "writeTexture" && call[6] === "test-airbrush-samples-visibility-mask-texture"),
    false
  );
  assert.ok(device.calls.some((call) => call[0] === "createBindGroup" && call[1] === "0,1,2,3,4,5,6,7"));
});

test("airbrush WebGPU dispatch helper can copy output into a readback buffer", async () => {
  const device = fakeWebGpuDevice();
  const payload = {
    source: textureAirbrushWebGpuKernelSource({ maxStrokeSegments: 2, workgroupSize: 8 }),
    plan: textureAirbrushWebGpuPaintPlan({
      width: 3,
      height: 2,
      maxStrokeSegments: 2,
      workgroupSize: 8,
      options: {
        strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 2, y: 1 } }]
      }
    })
  };

  const run = textureAirbrushRunWebGpuPaint(device, payload, {
    sourcePixels: new Uint8Array(payload.plan.width * payload.plan.height * 4),
    readback: true,
    label: "test-airbrush-readback"
  });

  assert.ok(run.resources.readbackBuffer);
  assert.equal(run.result.readbackBuffer, run.resources.readbackBuffer);
  assert.deepEqual(run.result.readbackLayout, {
    bytesPerRow: 256,
    rowsPerImage: 2,
    byteLength: 512,
    unpaddedBytesPerRow: 12,
    x: 0,
    y: 0,
    width: 3,
    height: 2
  });
  assert.ok(device.calls.some((call) => call[0] === "copyTextureToBuffer" && call[3] === 256 && call[4] === 3 && call[5] === 2));

  const mapped = new Uint8Array(512);
  mapped.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0);
  mapped.set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], 256);
  run.result.readbackBuffer.mappedData = mapped;
  const pixels = await textureAirbrushReadWebGpuPaintResult(run.result, { mapRead: 1 });

  assert.deepEqual([...pixels], [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24
  ]);
  assert.ok(device.calls.some((call) => call[0] === "mapAsync" && call[2] === 1));
  assert.ok(device.calls.some((call) => call[0] === "unmap"));
});

test("airbrush WebGPU dispatch pre-copies compact triangle regions before compute", () => {
  const device = fakeWebGpuDevice();
  const paintRegions = [
    { x: 1, y: 2, width: 3, height: 4 },
    { x: 5, y: 6, width: 7, height: 8 }
  ];
  const payload = {
    source: textureAirbrushWebGpuKernelSource({ maxStrokeSegments: 12, workgroupSize: 8 }),
    plan: textureAirbrushWebGpuPaintPlan({
      width: 32,
      height: 32,
      maxStrokeSegments: 12,
      workgroupSize: 8,
      options: {
        compactPaintRegions: true,
        compactPaintRegionTriangles: true,
        paintRegions,
        useVisibilityMask: true,
        screenProjectedStrokeSegments: [{
          start: { x: 0, y: 0 },
          end: { x: 8, y: 8 },
          radiusPixels: 6
        }],
        visibilityMaskTriangles: [
          {
            a: { x: 1, y: 2 },
            b: { x: 4, y: 2 },
            c: { x: 1, y: 6 },
            screenA: { x: 0, y: 0 },
            screenB: { x: 3, y: 0 },
            screenC: { x: 0, y: 4 }
          },
          {
            a: { x: 5, y: 6 },
            b: { x: 12, y: 6 },
            c: { x: 5, y: 14 },
            screenA: { x: 5, y: 5 },
            screenB: { x: 12, y: 5 },
            screenC: { x: 5, y: 13 }
          }
        ],
        strokeSegments: [{ start: { x: 1, y: 2 }, end: { x: 5, y: 6 } }]
      }
    })
  };

  assert.equal(payload.plan.params.compactPaintRegionTriangles, 1);

  textureAirbrushRunWebGpuPaint(device, payload, {
    sourcePixels: new Uint8Array(payload.plan.width * payload.plan.height * 4),
    label: "test-airbrush-compact-triangles"
  });

  const firstComputeIndex = device.calls.findIndex((call) => call[0] === "beginComputePass");
  const preComputeCopies = device.calls
    .slice(0, firstComputeIndex)
    .filter((call) => call[0] === "copyTextureToTexture");
  assert.equal(preComputeCopies.length, paintRegions.length);
  assert.deepEqual(
    preComputeCopies.map((call) => call.slice(3)),
    [
      [3, 4, 1, 2, 1, 2],
      [7, 8, 5, 6, 5, 6]
    ]
  );
});

test("airbrush WebGPU readback helper strips padded row bytes", () => {
  const mapped = new Uint8Array(12);
  mapped.set([1, 2, 3, 4], 0);
  mapped.set([9, 9], 4);
  mapped.set([5, 6, 7, 8], 6);

  const pixels = textureAirbrushUnpackWebGpuReadbackRows(mapped, {
    bytesPerRow: 6,
    rowsPerImage: 2,
    unpaddedBytesPerRow: 4
  });

  assert.deepEqual([...pixels], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("airbrush WebGPU canvas bridge reads and applies editable pixels", () => {
  const { editable, state } = fakeEditableTexture(2, 1, [
    1, 2, 3, 4,
    5, 6, 7, 8
  ]);
  const source = textureAirbrushSourcePixelsFromEditable(editable);

  assert.deepEqual(state.lastGetImageData, [0, 0, 2, 1]);
  assert.equal(source.width, 2);
  assert.equal(source.height, 1);
  assert.deepEqual([...source.sourcePixels], [
    1, 2, 3, 4,
    5, 6, 7, 8
  ]);

  const material = {};
  const applied = textureAirbrushApplyPixelsToEditable(editable, new Uint8Array([
    9, 10, 11, 12,
    13, 14, 15, 16
  ]), {
    imageData: source.imageData,
    material
  });

  assert.equal(applied.byteLength, 8);
  assert.equal(state.putCalls.length, 1);
  assert.deepEqual([...state.imageData.data], [
    9, 10, 11, 12,
    13, 14, 15, 16
  ]);
  assert.equal(editable.texture.needsUpdate, true);
  assert.equal(material.needsUpdate, true);
});

test("airbrush WebGPU canvas bridge applies dirty subrect pixels only", () => {
  const { editable, state } = fakeEditableTexture(3, 1, [
    1, 2, 3, 255,
    4, 5, 6, 255,
    7, 8, 9, 255
  ]);
  const source = textureAirbrushSourcePixelsFromEditable(editable);

  const applied = textureAirbrushApplyPixelsToEditable(editable, new Uint8Array([
    20, 21, 22, 255
  ]), {
    imageData: source.imageData,
    bounds: {
      x: 1,
      y: 0,
      width: 1,
      height: 1
    }
  });

  assert.equal(applied.x, 1);
  assert.equal(applied.y, 0);
  assert.equal(applied.width, 1);
  assert.equal(applied.height, 1);
  assert.deepEqual(state.putCalls.at(-1).slice(1), [1, 0]);
  assert.deepEqual([...state.imageData.data], [
    1, 2, 3, 255,
    20, 21, 22, 255,
    7, 8, 9, 255
  ]);
});

test("airbrush WebGPU canvas bridge builds payloads from editable texture size", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(4, 3, new Uint8Array(4 * 3 * 4));
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 20, g: 40, b: 60 });

  const prepared = textureAirbrushEditableWebGpuPayload(editor, editable, {
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 3, y: 2 } }]
  });

  assert.equal(prepared.width, 4);
  assert.equal(prepared.height, 3);
  assert.equal(prepared.payload.plan.width, 4);
  assert.equal(prepared.payload.plan.height, 3);
  assert.equal(prepared.payload.params.radiusPixels, 10);
  assert.equal(prepared.payload.params.strokeSegmentCount, 1);
});

test("airbrush WebGPU projection helpers build screen probes from stroke footprint", () => {
  const stroke = textureAirbrushWebGpuScreenStrokeFromEvent({
    clientX: 110,
    clientY: 60
  }, {
    left: 10,
    top: 20
  }, {
    strokeStart: {
      clientX: 20,
      clientY: 30
    }
  });

  assert.deepEqual(stroke.center, { x: 100, y: 40 });
  assert.deepEqual(stroke.start, { x: 10, y: 10 });
  assert.deepEqual(stroke.strokeSegments, [{ start: { x: 10, y: 10 }, end: { x: 100, y: 40 } }]);

  const tinyProbes = textureAirbrushWebGpuProbePointsFromStroke(stroke, 8);
  const wideProbes = textureAirbrushWebGpuProbePointsFromStroke(stroke, 24);

  assert.equal(tinyProbes.length, 4);
  assert.ok(tinyProbes.some((point) => Math.round(point.x) === 40 && Math.round(point.y) === 20));
  assert.ok(tinyProbes.some((point) => Math.round(point.x) === 70 && Math.round(point.y) === 30));
  assert.ok(wideProbes.length > tinyProbes.length);
  assert.ok(wideProbes.some((point) => Math.round(point.x) === 112 && Math.round(point.y) === 40));
  assert.ok(wideProbes.some((point) => Math.round(point.x) === 22 && Math.round(point.y) === 10));
});

test("airbrush WebGPU visible mask feathers sampled UV texels and configures capped edge bleed", () => {
  const mask = textureAirbrushWebGpuVisibilityMaskPixels(8, 4, [
    { x: 2, y: 1 },
    { segment: { start: { x: 4, y: 2 }, end: { x: 6, y: 2 } } }
  ], {
    stampRadiusPixels: 1
  });
  const alphaAt = (x, y) => mask.pixels[(y * mask.width + x) * 4 + 3];

  assert.equal(mask.width, 8);
  assert.equal(mask.height, 4);
  assert.ok(mask.markedPixels > 0);
  assert.equal(alphaAt(2, 1), 255);
  assert.equal(alphaAt(5, 2), 255);
  assert.equal(alphaAt(3, 1) > 0 && alphaAt(3, 1) < 255, true);
  assert.equal(alphaAt(0, 3), 0);

  const candidate = {
    record: { id: "record-mask" },
    material: { uuid: "material-mask" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-mask" },
      canvas: { width: 8, height: 4 }
    },
    center: { x: 2, y: 1 },
    radiusPixels: 2,
    strokeSegments: [{ start: { x: 2, y: 1 }, end: { x: 6, y: 2 } }],
    options: {
      radiusPixels: 2
    }
  };
  textureAirbrushWebGpuAssignVisibilityMasks([candidate], {
    visibilityMaskStampRadiusPixels: 1,
    visibilityFeatherRadius: 2
  });

  assert.equal(candidate.options.useVisibilityMask, true);
  assert.equal(candidate.options.visibleSurfaceMaskReady, true);
  assert.equal(candidate.options.visibilityFeatherRadius, 2);
  assert.equal(candidate.options.visibilityMaskThreshold, 0.02);
  assert.equal(candidate.options.visibilityBleedRadius, 0.75);
  assert.equal(candidate.options.visibilityMaskPixels.byteLength, 8 * 4 * 4);
  assert.match(candidate.options.visibilityMaskKey, /record-mask:0:material-mask/);
  assert.equal(candidate.options.visibilityMaskPixels[(3 * 8 + 0) * 4 + 3], 0);
});

test("airbrush WebGPU live visible mask can use compact samples instead of texture-sized pixels", () => {
  const candidate = {
    record: { id: "record-mask-samples" },
    material: { uuid: "material-mask-samples" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-mask-samples" },
      canvas: { width: 2048, height: 2048 }
    },
    center: { x: 32, y: 24 },
    radiusPixels: 8,
    strokeSegments: [{ start: { x: 30, y: 24 }, end: { x: 40, y: 28 } }],
    options: {
      radiusPixels: 8
    }
  };

  textureAirbrushWebGpuAssignVisibilityMasks([candidate], {
    visibilityMaskMode: "samples",
    visibilityMaskStampRadiusPixels: 5
  });

  assert.equal(candidate.options.useVisibilityMask, true);
  assert.equal(candidate.options.visibleSurfaceMaskReady, true);
  assert.equal(candidate.options.visibilityMaskPixels, undefined);
  assert.equal(candidate.options.visibilityMaskSamples.length, 2);
  assert.equal(candidate.options.visibilityMaskStampRadiusPixels, 5);
  assert.match(candidate.options.visibilityMaskKey, /samples:2/);
});

test("airbrush WebGPU visibility masks keep temporary mesh records separated", () => {
  const sharedMaterial = { uuid: "material-shared-temp-records" };
  const editable = {
    texture: { uuid: "texture-shared-temp-records" },
    canvas: { width: 256, height: 256 }
  };
  const candidateForMesh = (objectUuid, x) => ({
    record: {
      object: { uuid: objectUuid },
      geometry: { uuid: `${objectUuid}-geometry` },
      texturePaintOnly: true
    },
    material: sharedMaterial,
    materialIndex: 0,
    editable,
    center: { x, y: 32 },
    radiusPixels: 8,
    strokeSegments: [{ start: { x, y: 32 }, end: { x: x + 8, y: 34 } }],
    options: {
      radiusPixels: 8
    }
  });
  const first = candidateForMesh("mesh-temp-a", 24);
  const second = candidateForMesh("mesh-temp-b", 96);

  textureAirbrushWebGpuAssignVisibilityMasks([first, second], {
    visibilityMaskMode: "samples",
    visibilityMaskStampRadiusPixels: 5
  });

  assert.notEqual(first.options.visibilityMaskKey, second.options.visibilityMaskKey);
  assert.match(first.options.visibilityMaskKey, /mesh-temp-a/);
  assert.match(second.options.visibilityMaskKey, /mesh-temp-b/);
  assert.equal(first.options.visibilityMaskSamples.length, 2);
  assert.equal(second.options.visibilityMaskSamples.length, 2);
  assert.equal(first.options.visibilityMaskSamples.some((sample) => sample.x === 96), false);
  assert.equal(second.options.visibilityMaskSamples.some((sample) => sample.x === 24), false);
});

test("airbrush WebGPU triangle visibility mask gets a narrow soft normal cutoff", () => {
  const candidate = {
    record: { id: "record-mask-triangle-edge" },
    material: { uuid: "material-mask-triangle-edge" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-mask-triangle-edge" },
      canvas: { width: 256, height: 256 }
    },
    center: { x: 32, y: 24 },
    radiusPixels: 12,
    strokeSegments: [{ start: { x: 30, y: 24 }, end: { x: 40, y: 28 } }],
    options: {
      radiusPixels: 12,
      visibilityMaskTriangles: [{
        a: { x: 24, y: 16 },
        b: { x: 48, y: 16 },
        c: { x: 24, y: 40 }
      }]
    }
  };

  textureAirbrushWebGpuAssignVisibilityMasks([candidate], {
    visibilityMaskMode: "samples",
    visibilityMaskStampRadiusPixels: 8
  });

  assert.equal(candidate.options.visibilityMaskPixels, undefined);
  assert.equal(candidate.options.visibilityMaskTriangles.length, 1);
  assert.equal(candidate.options.visibilityBleedRadius, 1.76);
  assert.match(candidate.options.visibilityMaskKey, /triangles:1/);
  assert.match(candidate.options.visibilityMaskKey, /edge:soft/);
});

test("airbrush WebGPU hard visible edge mode disables normal cutoff bleed", () => {
  const soft = {
    record: { id: "record-mask-hard-triangle-edge" },
    material: { uuid: "material-mask-hard-triangle-edge" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-mask-hard-triangle-edge" },
      canvas: { width: 256, height: 256 }
    },
    center: { x: 32, y: 24 },
    radiusPixels: 12,
    strokeSegments: [{ start: { x: 30, y: 24 }, end: { x: 40, y: 28 } }],
    options: {
      radiusPixels: 12,
      visibilityMaskTriangles: [{
        a: { x: 24, y: 16 },
        b: { x: 48, y: 16 },
        c: { x: 24, y: 40 }
      }]
    }
  };
  const hard = {
    ...soft,
    options: {
      ...soft.options,
      visibleEdgeMode: "hard"
    }
  };

  textureAirbrushWebGpuAssignVisibilityMasks([soft], {
    visibilityMaskMode: "samples",
    visibilityMaskStampRadiusPixels: 8,
    visibleEdgeMode: "soft"
  });
  textureAirbrushWebGpuAssignVisibilityMasks([hard], {
    visibilityMaskMode: "samples",
    visibilityMaskStampRadiusPixels: 8,
    visibleEdgeMode: "hard"
  });

  assert.equal(soft.options.visibilityBleedRadius, 1.76);
  assert.equal(soft.options.visibilityFeatherRadius, 6);
  assert.equal(hard.options.visibilityBleedRadius, 0);
  assert.equal(hard.options.visibilityFeatherRadius, 0);
  assert.notEqual(hard.options.visibilityMaskKey, soft.options.visibilityMaskKey);
  assert.match(hard.options.visibilityMaskKey, /edge:hard/);
});

test("airbrush WebGPU triangle visibility mask scales soft cutoff modestly for large brushes", () => {
  const candidate = {
    record: { id: "record-mask-large-triangle-edge" },
    material: { uuid: "material-mask-large-triangle-edge" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-mask-large-triangle-edge" },
      canvas: { width: 4096, height: 4096 }
    },
    center: { x: 1024, y: 1536 },
    radiusPixels: 80,
    strokeSegments: [{ start: { x: 1024, y: 1536 }, end: { x: 1100, y: 1536 } }],
    options: {
      radiusPixels: 80,
      visibilityMaskTriangles: [{
        a: { x: 980, y: 1480 },
        b: { x: 1160, y: 1480 },
        c: { x: 980, y: 1640 }
      }]
    }
  };

  textureAirbrushWebGpuAssignVisibilityMasks([candidate], {
    visibilityMaskMode: "samples"
  });

  assert.equal(candidate.options.visibilityMaskPixels, undefined);
  assert.equal(candidate.options.visibilityMaskTriangles.length, 1);
  assert.equal(candidate.options.visibilityBleedRadius, 17.82);
  assert.ok(candidate.options.visibilityFeatherRadius > 60);
});

test("airbrush projection keeps only front-surface depth-window hits", () => {
  const intersections = [
    { distance: 10, id: "front" },
    { distance: 10 + TEXTURE_AIRBRUSH_WEBGPU_PROJECTION_DEPTH_WINDOW * 0.5, id: "near-front" },
    { distance: 10 + TEXTURE_AIRBRUSH_WEBGPU_PROJECTION_DEPTH_WINDOW + 0.001, id: "hidden" }
  ];
  assert.deepEqual(
    textureAirbrushFrontIntersections(intersections).map((hit) => hit.id),
    ["front", "near-front"]
  );
});

test("airbrush WebGPU stroke planner maps hit uv and stroke start to texture pixels", () => {
  const material = { uuid: "material-a" };
  const { editable } = fakeEditableTexture(101, 51, new Uint8Array(101 * 51 * 4));
  const record = { id: "record-a" };
  const currentHit = {
    uv: { x: 0.5, y: 0.5 },
    face: { materialIndex: 0 }
  };
  const startHit = {
    uv: { x: 0.25, y: 0.25 },
    face: { materialIndex: 0 }
  };
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 20,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent() {
      return {
        record,
        hit: startHit
      };
    }
  };

  const radius = textureAirbrushWebGpuTextureRadiusPixels(editor, editable, {
    radiusPixels: 10
  });
  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    pointerType: "pen",
    pressure: 0.5
  }, {
    strokeStart: { clientX: 1, clientY: 2 },
    radiusPixels: 10,
    opacity: 0.5
  });

  assert.ok(Math.abs(radius - 3.636) < 0.000001);
  assert.deepEqual(candidate.start, { x: 25, y: 13 });
  assert.deepEqual(candidate.center, { x: 50, y: 25 });
  assert.deepEqual(candidate.strokeSegments, [{
    start: { x: 25, y: 13 },
    end: { x: 50, y: 25 }
  }]);
  assert.equal(candidate.options.radiusPixels, radius);
  assert.equal(candidate.options.opacity, 0.5);
  assert.equal(candidate.estimate, textureAirbrushWebGpuStrokeEstimate(candidate));
});

test("airbrush WebGPU stroke planner unwraps hit uv samples into one texture frame", () => {
  const material = { uuid: "material-unwrap" };
  const { editable } = fakeEditableTexture(101, 51, new Uint8Array(101 * 51 * 4));
  editable.texture = { wrapS: "repeat", wrapT: "repeat" };
  const record = { id: "record-unwrap" };
  const currentHit = {
    uv: { x: 0.02, y: 0.5 },
    face: { materialIndex: 0 }
  };
  const startHit = {
    uv: { x: 0.98, y: 0.5 },
    face: { materialIndex: 0 }
  };
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 20,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintUnwrapTextureCoordinate(value, reference) {
      return value + Math.round(reference - value);
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, options = {}) {
      const wrap = (value) => ((value % 1) + 1) % 1;
      const u = options.wrap === false ? mapped.x : wrap(mapped.x);
      const v = options.wrap === false ? mapped.y : wrap(mapped.y);
      return {
        x: Math.round(u * (canvas.width - 1)),
        y: Math.round(v * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent() {
      return {
        record,
        hit: startHit
      };
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 5,
    clientY: 1,
    pointerType: "pen",
    pressure: 0.5
  }, {
    strokeStart: { clientX: 1, clientY: 1 },
    radiusPixels: 10,
    opacity: 0.5
  });

  assert.deepEqual(candidate.center, { x: 2, y: 25 });
  assert.deepEqual(candidate.start, { x: -2, y: 25 });
  assert.deepEqual(candidate.strokeSegments, [{
    start: { x: -2, y: 25 },
    end: { x: 2, y: 25 }
  }]);
});

test("airbrush WebGPU low-spacing screen strokes densify the unwrapped UV path", () => {
  const material = { uuid: "material-dense-low-spacing" };
  const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
  const record = { id: "record-dense-low-spacing" };
  const uvFromClient = (event = null) => ({
    x: Math.max(0, Math.min(1, Number(event?.clientX) / 100)),
    y: 0.5
  });
  const editor = {
    textureBrushRadiusValue: () => 0.04,
    textureBrushRadiusScreenPixels: () => 40,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent(event) {
      return {
        record,
        hit: {
          uv: uvFromClient(event),
          face: { materialIndex: 0 }
        }
      };
    }
  };
  const screenSegment = {
    start: { clientX: 0, clientY: 10 },
    end: { clientX: 48, clientY: 10 },
    radiusPixels: 40,
    spacing: 1
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
    uv: uvFromClient({ clientX: 48 }),
    face: { materialIndex: 0 }
  }, {
    clientX: 48,
    clientY: 10,
    pointerType: "pen",
    pressure: 0.5
  }, {
    strokeStart: screenSegment.start,
    strokeSegments: [screenSegment],
    radiusPixels: 40,
    textureRadiusPixels: 40,
    spacing: 1,
    opacity: 0.5
  });

  assert.ok(candidate.strokeSegments.length >= 6);
  assert.ok(candidate.strokeSegments.every((segment, index, segments) => {
    if (index === 0) {
      return true;
    }
    return Math.abs(segment.start.x - segments[index - 1].end.x) <= 1
      && Math.abs(segment.start.y - segments[index - 1].end.y) <= 1;
  }));
});

test("airbrush WebGPU low-spacing default brush keeps a dense unwrapped UV path", () => {
  const material = { uuid: "material-dense-default-low-spacing" };
  const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
  const record = { id: "record-dense-default-low-spacing" };
  const uvFromClient = (event = null) => ({
    x: Math.max(0, Math.min(1, Number(event?.clientX) / 100)),
    y: 0.5
  });
  const editor = {
    textureBrushRadiusValue: () => 0.008,
    textureBrushRadiusScreenPixels: () => 8,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent(event) {
      return {
        record,
        hit: {
          uv: uvFromClient(event),
          face: { materialIndex: 0 }
        }
      };
    }
  };
  const screenSegment = {
    start: { clientX: 0, clientY: 10 },
    end: { clientX: 48, clientY: 10 },
    radiusPixels: 8,
    spacing: 1
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
    uv: uvFromClient({ clientX: 48 }),
    face: { materialIndex: 0 }
  }, {
    clientX: 48,
    clientY: 10,
    pointerType: "mouse",
    pressure: 0.5
  }, {
    strokeStart: screenSegment.start,
    strokeSegments: [screenSegment],
    radiusPixels: 8,
    textureRadiusPixels: 8,
    spacing: 1,
    opacity: 0.5
  });

  assert.ok(candidate.strokeSegments.length >= 12);
  assert.ok(candidate.strokeSegments.every((segment, index, segments) => {
    if (index === 0) {
      return true;
    }
    return Math.abs(segment.start.x - segments[index - 1].end.x) <= 1
      && Math.abs(segment.start.y - segments[index - 1].end.y) <= 1;
  }));
});

test("airbrush WebGPU stroke planner targets the active paint layer", () => {
  const material = { uuid: "material-layer-target" };
  const { editable: baseEditable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const { editable: layerEditable } = fakeEditableTexture(32, 32, new Uint8Array(32 * 32 * 4));
  layerEditable.layerMode = true;
  layerEditable.texture = { uuid: "layer-texture" };
  const record = { id: "record-layer-target" };
  const currentHit = {
    uv: { x: 0.25, y: 0.75 },
    face: { materialIndex: 0 }
  };
  let layerTargetCalls = 0;
  const pixelCanvases = [];
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 12,
    texturePaintLayerModeActive: () => true,
    texturePaintHasActivePaintLayer(candidateMaterial) {
      return candidateMaterial === material;
    },
    texturePaintEditableLayerTarget(candidateMaterial, editable) {
      assert.equal(candidateMaterial, material);
      assert.equal(editable, baseEditable);
      layerTargetCalls += 1;
      return layerEditable;
    },
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? baseEditable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      pixelCanvases.push(canvas);
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent() {
      throw new Error("projected cached UV sample test must not raycast");
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 8,
    clientY: 24,
    pointerType: "pen"
  }, {
    radiusPixels: 12
  });

  assert.equal(layerTargetCalls, 1);
  assert.equal(candidate.editable, layerEditable);
  assert.equal(candidate.layerMode, true);
  assert.equal(candidate.options.layerMode, true);
  assert.deepEqual(candidate.center, { x: 8, y: 23 });
  assert.deepEqual(pixelCanvases, [layerEditable.canvas]);
});

test("airbrush WebGPU stroke planner derives live texture radius from local screen UV scale", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-local-radius" };
    const { editable } = fakeEditableTexture(4096, 4096, new Uint8Array(4096 * 4096 * 4));
    const positions = [
      -0.1, 0.1, 0,
      0.1, 0.1, 0,
      -0.1, -0.1, 0
    ];
    const uvs = [
      0.1, 0.1,
      0.15, 0.1,
      0.1, 0.15
    ];
    const record = {
      id: "record-local-radius",
      object: {
        localToWorld(point) {
          return point;
        }
      },
      geometry: {
        attributes: {
          position: {
            getX(index) {
              return positions[index * 3];
            },
            getY(index) {
              return positions[index * 3 + 1];
            },
            getZ(index) {
              return positions[index * 3 + 2];
            }
          },
          uv: {
            getX(index) {
              return uvs[index * 2];
            },
            getY(index) {
              return uvs[index * 2 + 1];
            }
          }
        }
      }
    };
    const currentHit = {
      uv: { x: 0.12, y: 0.12 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0 }
    };
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 1000, height: 1000 };
        }
      },
      textureBrushRadiusValue: () => 0.036,
      textureBrushRadiusScreenPixels: () => 8,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      },
      texturePaintHitForEvent() {
        return { record, hit };
      }
    };

    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
      clientX: 500,
      clientY: 500,
      pointerType: "pen"
    }, {
      radiusPixels: 8
    });

    assert.ok(candidate.radiusPixels > 16);
    assert.ok(candidate.radiusPixels < 20);
    assert.equal(candidate.options.radiusPixels, candidate.radiusPixels);
  } finally {
    if (previousThree === undefined) {
      delete globalThis.THREE;
    } else {
      globalThis.THREE = previousThree;
    }
  }
});

test("airbrush WebGPU texture radius reuses local face scale within a frame", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const { editable } = fakeEditableTexture(1024, 1024, new Uint8Array(1024 * 1024 * 4));
    editable.texture.uuid = "texture-local-radius-cache";
    const positions = [
      -0.1, 0.1, 0,
      0.1, 0.1, 0,
      -0.1, -0.1, 0
    ];
    const uvs = [
      0.1, 0.1,
      0.15, 0.1,
      0.1, 0.15
    ];
    const record = {
      id: "record-local-radius-cache",
      object: {
        uuid: "object-local-radius-cache",
        localToWorld(point) {
          return point;
        }
      },
      geometry: {
        attributes: {
          position: {
            version: 1,
            getX(index) {
              return positions[index * 3];
            },
            getY(index) {
              return positions[index * 3 + 1];
            },
            getZ(index) {
              return positions[index * 3 + 2];
            }
          },
          uv: {
            version: 1,
            getX(index) {
              return uvs[index * 2];
            },
            getY(index) {
              return uvs[index * 2 + 1];
            }
          }
        }
      }
    };
    const hit = {
      object: record.object,
      uv: { x: 0.12, y: 0.12 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0 },
      faceIndex: 0
    };
    let mappedUvCalls = 0;
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 1000, height: 1000 };
        }
      },
      progress: 0,
      textureBrushRadiusValue: () => 0.036,
      textureBrushRadiusScreenPixels: () => 8,
      clonePaintTextureUv(uv) {
        mappedUvCalls += 1;
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      }
    };

    const first = textureAirbrushWebGpuTextureRadiusPixels(editor, editable, {
      record,
      hit,
      radiusPixels: 8
    });
    const callsAfterFirst = mappedUvCalls;
    const second = textureAirbrushWebGpuTextureRadiusPixels(editor, editable, {
      record,
      hit,
      radiusPixels: 8
    });

    assert.equal(second, first);
    assert.ok(callsAfterFirst > 0);
    assert.equal(mappedUvCalls, callsAfterFirst);
  } finally {
    if (previousThree === undefined) {
      delete globalThis.THREE;
    } else {
      globalThis.THREE = previousThree;
    }
  }
});

test("airbrush WebGPU local radius uses depth frame key without sampling camera matrices", () => {
  const { editable } = fakeEditableTexture(1024, 1024, new Uint8Array(1024 * 1024 * 4));
  const uvs = [
    0.1, 0.1,
    0.15, 0.1,
    0.1, 0.15
  ];
  const record = {
    id: "record-depth-frame-key-radius",
    object: { uuid: "object-depth-frame-key-radius" },
    geometry: {
      attributes: {
        uv: {
          version: 1,
          getX(index) {
            return uvs[index * 2];
          },
          getY(index) {
            return uvs[index * 2 + 1];
          }
        }
      }
    }
  };
  const hit = {
    object: record.object,
    uv: { x: 0.12, y: 0.12 },
    screen: [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 100, y: 200 }
    ],
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    faceIndex: 0
  };
  let matrixReads = 0;
  const throwingMatrix = {
    get elements() {
      matrixReads += 1;
      throw new Error("depth-keyed stroke planning should not sample camera matrices");
    }
  };
  let depthKeyCalls = 0;
  const editor = {
    camera: {
      matrixWorldInverse: throwingMatrix,
      projectionMatrix: throwingMatrix
    },
    canvas: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 1000, height: 1000 };
      }
    },
    textureAirbrushDepthCacheKey(rect) {
      depthKeyCalls += 1;
      return `depth:${rect.width}:${rect.height}`;
    },
    textureBrushRadiusValue: () => 0.036,
    textureBrushRadiusScreenPixels: () => 8,
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    }
  };

  const radius = textureAirbrushWebGpuTextureRadiusPixels(editor, editable, {
    record,
    hit,
    radiusPixels: 8
  });

  assert.ok(radius > 0);
  assert.ok(depthKeyCalls > 0);
  assert.equal(matrixReads, 0);
});

test("airbrush WebGPU stroke planner carries connected UV triangles for visibility", () => {
  const material = { uuid: "material-triangle-mask" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0, 0,
    1, 0,
    0, 1,
    1, 1
  ];
  const indexValues = [0, 1, 2, 1, 3, 2];
  const record = {
    id: "record-triangle-mask",
    geometry: {
      index: {
        count: indexValues.length,
        getX(index) {
          return indexValues[index];
        }
      },
      attributes: {
        uv: {
          count: 4,
          getX(index) {
            return uvValues[index * 2];
          },
          getY(index) {
            return uvValues[index * 2 + 1];
          }
        }
      }
    }
  };
  const currentHit = {
    uv: { x: 0.25, y: 0.25 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 20,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 25,
    clientY: 25
  }, {
    textureRadiusPixels: 60,
    maxVisibilityTriangles: 4
  });

  assert.equal(candidate.options.visibilityMaskTriangles.length, 2);
  assert.deepEqual(candidate.options.visibilityMaskTriangles[0], {
    a: { x: 0, y: 0 },
    b: { x: 100, y: 0 },
    c: { x: 0, y: 100 }
  });
  assert.deepEqual(candidate.options.visibilityMaskTriangles[1], {
    a: { x: 100, y: 0 },
    b: { x: 100, y: 100 },
    c: { x: 0, y: 100 }
  });
});

test("airbrush WebGPU stroke planner connects split vertices by shared UV edges", () => {
  const material = { uuid: "material-split-uv-edge-mask" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0, 0,
    1, 0,
    0, 1,
    1, 0,
    1, 1,
    0, 1
  ];
  const record = {
    id: "record-split-uv-edge-mask",
    geometry: {
      attributes: {
        uv: {
          count: 6,
          getX(index) {
            return uvValues[index * 2];
          },
          getY(index) {
            return uvValues[index * 2 + 1];
          }
        }
      }
    }
  };
  const currentHit = {
    uv: { x: 0.25, y: 0.25 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 20,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 25,
    clientY: 25
  }, {
    textureRadiusPixels: 60,
    maxVisibilityTriangles: 4
  });

  assert.equal(candidate.options.visibilityMaskTriangles.length, 2);
  assert.deepEqual(candidate.options.visibilityMaskTriangles[1], {
    a: { x: 100, y: 0 },
    b: { x: 100, y: 100 },
    c: { x: 0, y: 100 }
  });
});

test("airbrush WebGPU stroke planner paints duplicated-position UV seams in local islands", () => {
  const material = { uuid: "material-position-seam-mask" };
  const { editable } = fakeEditableTexture(1001, 101, new Uint8Array(1001 * 101 * 4));
  const uvValues = [
    0.10, 0.10,
    0.20, 0.10,
    0.10, 0.20,
    0.80, 0.10,
    0.90, 0.10,
    0.80, 0.20
  ];
  const positionValues = [
    -0.2, -0.2, 0,
     0.2, -0.2, 0,
    -0.2,  0.2, 0,
     0.2, -0.2, 0,
     0.2,  0.2, 0,
    -0.2,  0.2, 0
  ];
  const attribute = (values, itemSize) => ({
    count: values.length / itemSize,
    getX(index) {
      return values[index * itemSize];
    },
    getY(index) {
      return values[index * itemSize + 1];
    },
    getZ(index) {
      return values[index * itemSize + 2];
    }
  });
  const geometry = {
    attributes: {
      uv: attribute(uvValues, 2),
      position: attribute(positionValues, 3)
    }
  };
  const record = {
    id: "record-position-seam-mask",
    geometry,
    seamVertexMap: new Map([
      [1, [1, 3]],
      [3, [1, 3]],
      [2, [2, 5]],
      [5, [2, 5]]
    ]),
    object: {
      geometry,
      localToWorld() {}
    }
  };
  const identity = {
    elements: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]
  };
  const currentHit = {
    object: record.object,
    uv: { x: 0.14, y: 0.14 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const editor = {
    camera: {
      matrixWorldInverse: identity,
      projectionMatrix: identity
    },
    canvas: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 100 };
      }
    },
    textureBrushRadiusValue: () => 0.02,
    textureBrushRadiusScreenPixels: () => 28,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    textureAirbrushNeighborLinkedVertices(hitRecord, vertexIndex) {
      return hitRecord.seamVertexMap?.get(vertexIndex) || [vertexIndex];
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 50,
    clientY: 50
  }, {
    radiusPixels: 28,
    textureRadiusPixels: 18,
    maxVisibilityTriangles: 4,
    strokeSegments: [{
      start: { clientX: 50, clientY: 50 },
      end: { clientX: 50, clientY: 50 }
    }]
  });

  assert.equal(candidate.options.visibilityMaskTriangles.length, 2);
  assert.ok(candidate.strokeSegments.some((segment) => Math.max(segment.start.x, segment.end.x) < 300));
  assert.ok(candidate.strokeSegments.some((segment) => Math.min(segment.start.x, segment.end.x) > 700));
  assert.ok(candidate.strokeSegments.every((segment) => {
    const minX = Math.min(segment.start.x, segment.end.x);
    const maxX = Math.max(segment.start.x, segment.end.x);
    return !(minX < 300 && maxX > 700);
  }));

  const dragCandidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 55,
    clientY: 50
  }, {
    radiusPixels: 28,
    textureRadiusPixels: 18,
    maxVisibilityTriangles: 4,
    strokeStart: { clientX: 45, clientY: 50 },
    strokeSegments: [{
      start: { clientX: 45, clientY: 50 },
      end: { clientX: 55, clientY: 50 }
    }]
  });
  const remoteDragSegments = dragCandidate.strokeSegments.filter((segment) => (
    Math.min(segment.start.x, segment.end.x) > 700
  ));
  assert.ok(remoteDragSegments.length > 0);
  assert.ok(remoteDragSegments.every((segment) => (
    Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) > 0.001
  )));
  assert.ok(dragCandidate.strokeSegments.every((segment) => {
    const minX = Math.min(segment.start.x, segment.end.x);
    const maxX = Math.max(segment.start.x, segment.end.x);
    return !(minX < 300 && maxX > 700);
  }));
});

test("airbrush WebGPU stroke planner keeps unwrapped UV samples as the paint path", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-screen-projected-radius" };
    const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
    const positions = [
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
      -0.5,  0.5, 0
    ];
    const uvs = [
      0.10, 0.10,
      0.12, 0.10,
      0.10, 0.12
    ];
    const attribute = (values, itemSize) => ({
      count: values.length / itemSize,
      getX(index) {
        return values[index * itemSize];
      },
      getY(index) {
        return values[index * itemSize + 1];
      },
      getZ(index) {
        return values[index * itemSize + 2];
      }
    });
    const geometry = {
      attributes: {
        position: attribute(positions, 3),
        uv: attribute(uvs, 2)
      }
    };
    const record = {
      id: "record-screen-projected-radius",
      geometry,
      object: {
        geometry,
        localToWorld(point) {
          return point;
        }
      }
    };
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        }
      },
      textureBrushRadiusValue: () => 0.18,
      textureBrushRadiusScreenPixels: () => 40,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      },
      texturePaintHitForEvent() {
        return { record, hit };
      }
    };
    const hit = {
      object: record.object,
      uv: { x: 0.105, y: 0.105 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    };
    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
      clientX: 30,
      clientY: 70
    }, {
      radiusPixels: 40,
      textureRadiusPixels: 250,
      requireVisibilityTriangles: true,
      liveProjectedPaint: true,
      strokeSegments: [{
        start: { clientX: 30, clientY: 70 },
        end: { clientX: 30, clientY: 70 }
      }]
    });

    assert.deepEqual(candidate.strokeSegments, [{
      start: { x: 105, y: 105 },
      end: { x: 105, y: 105 },
      screenStart: { x: 30, y: 70 },
      screenEnd: { x: 30, y: 70 },
      screenRadiusPixels: 40,
      radiusPixels: 160
    }]);
    assert.equal(candidate.radiusPixels, 160);
    assert.equal(candidate.options.radiusPixels, 160);
    assert.equal(candidate.options.hardTextureAirbrushComponentGate, undefined);
    assert.equal(candidate.options.screenProjectedStrokeSegments, undefined);
    assert.deepEqual(candidate.options.visibilityMaskTriangles[0].screenA, { x: 25, y: 75 });
    assert.deepEqual(candidate.options.visibilityMaskTriangles[0].screenB, { x: 75, y: 75 });
    assert.deepEqual(candidate.options.visibilityMaskTriangles[0].screenC, { x: 25, y: 25 });
  } finally {
    globalThis.THREE = previousThree;
  }
});

test("airbrush WebGPU large brushes project adjacent screen triangles into local UV stroke pieces", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-screen-brush-triangles" };
    const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
    const positions = [
      -0.20, -0.20, 0,
       0.00, -0.20, 0,
      -0.20,  0.00, 0,
       0.05, -0.20, 0,
       0.25, -0.20, 0,
       0.05,  0.00, 0
    ];
    const uvs = [
      0.10, 0.10,
      0.12, 0.10,
      0.10, 0.12,
      0.80, 0.10,
      0.82, 0.10,
      0.80, 0.12
    ];
    const attribute = (values, itemSize) => ({
      count: values.length / itemSize,
      getX(index) {
        return values[index * itemSize];
      },
      getY(index) {
        return values[index * itemSize + 1];
      },
      getZ(index) {
        return values[index * itemSize + 2];
      }
    });
    const geometry = {
      attributes: {
        position: attribute(positions, 3),
        uv: attribute(uvs, 2)
      }
    };
    const record = {
      id: "record-screen-brush-triangles",
      geometry,
      object: {
        geometry,
        localToWorld(point) {
          return point;
        }
      }
    };
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        }
      },
      textureBrushRadiusValue: () => 0.18,
      textureBrushRadiusScreenPixels: () => 24,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      }
    };
    const hit = {
      object: record.object,
      uv: { x: 0.105, y: 0.105 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    };
    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
      clientX: 50,
      clientY: 55
    }, {
      radiusPixels: 24,
      textureRadiusPixels: 240,
      requireVisibilityTriangles: true,
      liveProjectedPaint: true,
      useVisibilityTrianglePaintRegions: true,
      fullBrushVisibilityProbes: true,
      screenBrushVisibilityTriangles: true,
      maxVisibilityTriangles: 4,
      strokeSegments: [{
        start: { clientX: 50, clientY: 55 },
        end: { clientX: 58, clientY: 55 }
      }]
    });

    assert.ok(candidate);
    assert.ok(candidate.options.visibilityMaskTriangles.length >= 2);
    assert.ok(candidate.options.visibilityMaskTriangles.some((triangle) => triangle.a.x > 700));
    assert.ok(candidate.options.visibilityMaskTriangles.every((triangle) => triangle.screenA));
    assert.ok(candidate.strokeSegments.length > 0);
    assert.ok(candidate.strokeSegments.some((segment) => (
      Math.max(segment.start.x, segment.end.x) < 700
    )));
    assert.ok(candidate.strokeSegments.some((segment) => (
      Math.min(segment.start.x, segment.end.x) > 700
    )));
    assert.ok(candidate.strokeSegments.every((segment) => {
      const minX = Math.min(segment.start.x, segment.end.x);
      const maxX = Math.max(segment.start.x, segment.end.x);
      return !(minX < 700 && maxX > 700);
    }));
    assert.ok(Array.isArray(candidate.paintRegions));
    assert.ok(candidate.paintRegions.length >= 2);
    assert.ok(candidate.paintRegions.some((region) => region.x + region.width > 700));
    assert.ok(textureAirbrushWebGpuStrokeEstimate(candidate) > 0);
    assert.ok(textureAirbrushWebGpuStrokeEstimate(candidate) < 50000);

    const directLargeCandidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
      clientX: 50,
      clientY: 55
    }, {
      radiusPixels: 24,
      textureRadiusPixels: 240,
      requireVisibilityTriangles: true,
      liveProjectedPaint: true,
      largeLiveBrushPaint: true,
      useVisibilityTrianglePaintRegions: true,
      fullBrushVisibilityProbes: true,
      screenBrushVisibilityTriangles: true,
      maxVisibilityTriangles: 4,
      strokeSegments: [{
        start: { clientX: 50, clientY: 55 },
        end: { clientX: 58, clientY: 55 }
      }]
    });

    assert.ok(directLargeCandidate);
    assert.ok(directLargeCandidate.options.visibilityMaskTriangles.length >= 2);
    assert.ok(directLargeCandidate.strokeSegments.every((segment) => (
      Math.max(segment.start.x, segment.end.x) < 700
    )));
    assert.ok(directLargeCandidate.paintRegions.some((region) => region.x + region.width > 700));
    assert.ok(textureAirbrushWebGpuStrokeEstimate(directLargeCandidate) < 50000);
  } finally {
    globalThis.THREE = previousThree;
  }
});

test("airbrush WebGPU soft projected visibility keeps screen-visible low-normal triangles", () => {
  const material = { uuid: "material-soft-projected-low-normal" };
  const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
  const uvs = [
    0.10, 0.10,
    0.20, 0.10,
    0.10, 0.20,
    0.80, 0.10,
    0.90, 0.10,
    0.80, 0.20
  ];
  const positions = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    1, 0, 0,
    2, 0, 0,
    1, 1, 0
  ];
  const attribute = (values, itemSize) => ({
    count: values.length / itemSize,
    getX(index) {
      return values[index * itemSize];
    },
    getY(index) {
      return values[index * itemSize + 1];
    },
    getZ(index) {
      return values[index * itemSize + 2];
    }
  });
  const geometry = {
    attributes: {
      position: attribute(positions, 3),
      uv: attribute(uvs, 2)
    }
  };
  const record = {
    id: "record-soft-projected-low-normal",
    geometry,
    object: { geometry }
  };
  const editor = {
    camera: {},
    canvas: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 100 };
      }
    },
    textureBrushRadiusValue: () => 0.18,
    textureBrushRadiusScreenPixels: () => 24,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    textureAirbrushScreenTrianglesNearSegments() {
      return [
        {
          faceIndex: 0,
          coverage: 1,
          matchesMaterialSide: true,
          screen: [
            { x: 40, y: 60 },
            { x: 55, y: 60 },
            { x: 40, y: 45 }
          ]
        },
        {
          faceIndex: 1,
          coverage: 0,
          matchesMaterialSide: true,
          screen: [
            { x: 55, y: 60 },
            { x: 70, y: 60 },
            { x: 55, y: 45 }
          ]
        }
      ];
    }
  };
  const hit = {
    object: record.object,
    uv: { x: 0.12, y: 0.12 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const baseOptions = {
    radiusPixels: 24,
    textureRadiusPixels: 240,
    requireVisibilityTriangles: true,
    liveProjectedPaint: true,
    useVisibilityTrianglePaintRegions: true,
    screenBrushVisibilityTriangles: true,
    maxVisibilityTriangles: 4,
    strokeSegments: [{
      start: { clientX: 46, clientY: 54 },
      end: { clientX: 64, clientY: 54 }
    }]
  };

  const softCandidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
    clientX: 46,
    clientY: 54
  }, {
    ...baseOptions,
    visibleEdgeMode: "soft"
  });
  const hardCandidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
    clientX: 46,
    clientY: 54
  }, {
    ...baseOptions,
    visibleEdgeMode: "hard"
  });

  assert.equal(softCandidate.options.visibilityMaskTriangles.length, 2);
  assert.equal(hardCandidate.options.visibilityMaskTriangles.length, 1);
  assert.ok(softCandidate.options.visibilityMaskTriangles.some((triangle) => triangle.a.x > 700));
});

test("airbrush WebGPU screen-projected footprint regions do not double-apply brush radius padding", () => {
  const canvas = { width: 4096, height: 4096 };
  const regions = textureAirbrushWebGpuScreenProjectedBrushPaintRegionsForTest(
    [{
      a: { x: 512, y: 512 },
      b: { x: 2300, y: 512 },
      c: { x: 512, y: 2300 },
      screenA: { x: 80, y: 80 },
      screenB: { x: 180, y: 80 },
      screenC: { x: 80, y: 180 }
    }],
    [{
      start: { x: 92, y: 95 },
      end: { x: 155, y: 145 },
      radiusPixels: 64
    }],
    canvas,
    {
      radiusPixels: 64,
      scatter: 0.36,
      maxTextureRadiusPixels: 900
    }
  );
  const totalArea = regions.reduce((total, region) => total + region.width * region.height, 0);

  assert.ok(regions.length > 0);
  assert.ok(regions.every((region) => region.width < canvas.width && region.height < canvas.height));
  assert.ok(totalArea < 4_100_000);
});

test("airbrush WebGPU screen-projected footprint regions include soft visibility gutter", () => {
  const canvas = { width: 4096, height: 4096 };
  const triangle = {
    a: { x: 512, y: 512 },
    b: { x: 2300, y: 512 },
    c: { x: 512, y: 2300 },
    screenA: { x: 80, y: 80 },
    screenB: { x: 180, y: 80 },
    screenC: { x: 80, y: 180 }
  };
  const segment = {
    start: { x: 92, y: 95 },
    end: { x: 155, y: 145 },
    radiusPixels: 64
  };
  const tight = textureAirbrushWebGpuScreenProjectedBrushPaintRegionsForTest(
    [triangle],
    [segment],
    canvas,
    {
      radiusPixels: 64,
      scatter: 0.36,
      maxTextureRadiusPixels: 180,
      visibilityBleedRadius: 4
    }
  );
  const soft = textureAirbrushWebGpuScreenProjectedBrushPaintRegionsForTest(
    [triangle],
    [segment],
    canvas,
    {
      radiusPixels: 64,
      scatter: 0.36,
      maxTextureRadiusPixels: 180,
      visibilityBleedRadius: 48
    }
  );

  assert.equal(tight.length, 1);
  assert.equal(soft.length, 1);
  assert.ok(tight[0].x - soft[0].x >= 22);
  assert.ok(tight[0].y - soft[0].y >= 22);
  assert.ok(soft[0].width - tight[0].width >= 44);
  assert.ok(soft[0].height - tight[0].height >= 44);
});

test("airbrush WebGPU screen-projected footprint regions keep bounded large-brush padding", () => {
  const canvas = { width: 4096, height: 4096 };
  const triangle = {
    a: { x: 512, y: 512 },
    b: { x: 2300, y: 512 },
    c: { x: 512, y: 2300 },
    screenA: { x: 80, y: 80 },
    screenB: { x: 180, y: 80 },
    screenC: { x: 80, y: 180 }
  };
  const segment = {
    start: { x: 92, y: 95 },
    end: { x: 155, y: 145 },
    radiusPixels: 64
  };
  const modest = textureAirbrushWebGpuScreenProjectedBrushPaintRegionsForTest(
    [triangle],
    [segment],
    canvas,
    {
      radiusPixels: 64,
      scatter: 0.36,
      maxTextureRadiusPixels: 300
    }
  );
  const large = textureAirbrushWebGpuScreenProjectedBrushPaintRegionsForTest(
    [triangle],
    [segment],
    canvas,
    {
      radiusPixels: 64,
      scatter: 0.36,
      maxTextureRadiusPixels: 900
    }
  );
  const largeArea = large.reduce((total, region) => total + region.width * region.height, 0);

  assert.equal(modest.length, 1);
  assert.equal(large.length, 1);
  assert.ok(modest[0].x - large[0].x >= 16);
  assert.ok(modest[0].y - large[0].y >= 16);
  assert.ok(large[0].width - modest[0].width >= 32);
  assert.ok(large[0].height - modest[0].height >= 32);
  assert.ok(largeArea < 4_100_000);
});

test("airbrush WebGPU projected seam jumps become local stamps instead of plaid lines", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-screen-projected-seam-jump" };
    const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
    const positions = [
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
      -0.5,  0.5, 0
    ];
    const uvs = [
      0.0, 0.0,
      1.0, 0.0,
      0.0, 1.0
    ];
    const attribute = (values, itemSize) => ({
      count: values.length / itemSize,
      getX(index) {
        return values[index * itemSize];
      },
      getY(index) {
        return values[index * itemSize + 1];
      },
      getZ(index) {
        return values[index * itemSize + 2];
      }
    });
    const geometry = {
      attributes: {
        position: attribute(positions, 3),
        uv: attribute(uvs, 2)
      }
    };
    const record = {
      id: "record-screen-projected-seam-jump",
      geometry,
      object: {
        geometry,
        localToWorld(point) {
          return point;
        }
      }
    };
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        }
      },
      textureBrushRadiusValue: () => 0.18,
      textureBrushRadiusScreenPixels: () => 8,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      }
    };
    const hit = {
      object: record.object,
      uv: { x: 0.5, y: 0.1 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    };
    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
      clientX: 65,
      clientY: 70
    }, {
      radiusPixels: 8,
      textureRadiusPixels: 250,
      requireVisibilityTriangles: true,
      strokeStart: { clientX: 35, clientY: 70 },
      strokeSegments: [{
        start: { clientX: 35, clientY: 70 },
        end: { clientX: 65, clientY: 70 }
      }]
    });

    assert.ok(candidate.strokeSegments.length > 0);
    assert.ok(candidate.strokeSegments.every((segment) => (
      Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) <= 0.001
    )));
  } finally {
    globalThis.THREE = previousThree;
  }
});

test("airbrush WebGPU projected seam radius cannot inflate beyond the resolved texture brush", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-screen-projected-seam-radius" };
    const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
    const positions = [
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
      -0.5,  0.5, 0
    ];
    const uvs = [
      0.0, 0.0,
      1.0, 0.0,
      0.0, 1.0
    ];
    const attribute = (values, itemSize) => ({
      count: values.length / itemSize,
      getX(index) {
        return values[index * itemSize];
      },
      getY(index) {
        return values[index * itemSize + 1];
      },
      getZ(index) {
        return values[index * itemSize + 2];
      }
    });
    const geometry = {
      attributes: {
        position: attribute(positions, 3),
        uv: attribute(uvs, 2)
      }
    };
    const record = {
      id: "record-screen-projected-seam-radius",
      geometry,
      object: {
        geometry,
        localToWorld(point) {
          return point;
        }
      }
    };
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        }
      },
      textureBrushRadiusValue: () => 0.036,
      textureBrushRadiusScreenPixels: () => 8,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      }
    };
    const hit = {
      object: record.object,
      uv: { x: 0.5, y: 0.1 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    };
    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
      clientX: 65,
      clientY: 70
    }, {
      radiusPixels: 8,
      requireVisibilityTriangles: true,
      screenBrushVisibilityTriangles: true,
      strokeStart: { clientX: 35, clientY: 70 },
      strokeSegments: [{
        start: { clientX: 35, clientY: 70 },
        end: { clientX: 65, clientY: 70 }
      }]
    });

    assert.ok(candidate.radiusPixels > 20);
    assert.ok(candidate.radiusPixels < 30);
    assert.ok(candidate.strokeSegments.length > 0);
    assert.ok(candidate.strokeSegments.every((segment) => (
      !Number.isFinite(Number(segment.radiusPixels))
      || Number(segment.radiusPixels) <= candidate.radiusPixels + 0.000001
    )));
    assert.ok(textureAirbrushWebGpuStrokeEstimate(candidate) < 10000);
  } finally {
    globalThis.THREE = previousThree;
  }
});

test("airbrush WebGPU rejects discontinuous projected UV triangles instead of painting through the atlas interior", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-discontinuous-projected-seam" };
    const { editable } = fakeEditableTexture(4096, 4096, new Uint8Array(4096 * 4096 * 4));
    const positions = [
      -0.1, -0.1, 0,
       0.1, -0.1, 0,
      -0.1,  0.1, 0
    ];
    const uvs = [
      0.99, 0.48,
      0.01, 0.48,
      0.99, 0.52
    ];
    const attribute = (values, itemSize) => ({
      count: values.length / itemSize,
      getX(index) {
        return values[index * itemSize];
      },
      getY(index) {
        return values[index * itemSize + 1];
      },
      getZ(index) {
        return values[index * itemSize + 2];
      }
    });
    const geometry = {
      attributes: {
        position: attribute(positions, 3),
        uv: attribute(uvs, 2)
      }
    };
    const record = {
      id: "record-discontinuous-projected-seam",
      geometry,
      object: {
        geometry,
        localToWorld(point) {
          return point;
        }
      }
    };
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        }
      },
      textureBrushRadiusValue: () => 0.12,
      textureBrushRadiusScreenPixels: () => 26.4,
      textureAirbrushScatter: () => 0.36,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      }
    };
    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
      object: record.object,
      uv: { x: 0.99, y: 0.49 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    }, {
      clientX: 50,
      clientY: 50
    }, {
      radiusPixels: 26.4,
      requireVisibilityTriangles: true,
      liveProjectedPaint: true,
      screenBrushVisibilityTriangles: true,
      fullBrushVisibilityProbes: true,
      maxVisibilityTriangles: 4,
      strokeStart: { clientX: 45, clientY: 50 },
      strokeSegments: [{
        start: { clientX: 45, clientY: 50 },
        end: { clientX: 55, clientY: 50 }
      }]
    });

    assert.ok(candidate);
    assert.ok(candidate.strokeSegments.length > 0);
    assert.ok(candidate.strokeSegments.every((segment) => (
      segment.start.x > 3500
      && segment.end.x > 3500
    )));
    assert.equal(candidate.paintRegions, undefined);
    assert.ok(textureAirbrushWebGpuStrokeEstimate(candidate) < 500000);
  } finally {
    globalThis.THREE = previousThree;
  }
});

test("airbrush WebGPU neighbor visibility stays inside the active component", () => {
  const material = { uuid: "material-neighbor-component-mask" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0, 0,
    1, 0,
    0, 1,
    1, 0,
    1, 1,
    0, 1
  ];
  const record = {
    id: "record-neighbor-component-mask",
    geometry: {
      attributes: {
        uv: {
          count: 6,
          getX(index) {
            return uvValues[index * 2];
          },
          getY(index) {
            return uvValues[index * 2 + 1];
          }
        }
      }
    }
  };
  const currentHit = {
    uv: { x: 0.25, y: 0.25 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const neighborPaintSeed = {
    enabled: true,
    record,
    material,
    materialIndex: 0,
    seedVertexIndex: 0,
    component: new Set([0, 1, 2]),
    key: "record-neighbor-component-mask:0:material:0"
  };
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 20,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    textureAirbrushNeighborHitAllowed(seed, hitRecord, hit) {
      return seed === neighborPaintSeed && hitRecord === record && hit === currentHit;
    },
    textureAirbrushNeighborRecordMatches(seed, hitRecord) {
      return seed === neighborPaintSeed && hitRecord === record;
    },
    textureAirbrushNeighborLinkedVertices() {
      return [];
    },
    textureAirbrushNeighborSeedKey(seed) {
      return seed?.key || "";
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 25,
    clientY: 25
  }, {
    textureRadiusPixels: 60,
    maxVisibilityTriangles: 4,
    neighborPaintSeed
  });

  assert.equal(candidate.options.visibilityMaskTriangles.length, 1);
  assert.deepEqual(candidate.options.visibilityMaskTriangles[0], {
    a: { x: 0, y: 0 },
    b: { x: 100, y: 0 },
    c: { x: 0, y: 100 }
  });
});

test("airbrush WebGPU TSL Neighbor surface field does not gate front coverage by seed component", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-neighbor-tsl-component-gate" };
    const { editable } = fakeEditableTexture(257, 257, new Uint8Array(257 * 257 * 4));
    const positions = [
      -0.3, -0.3, 0,
       0.1, -0.3, 0,
      -0.3,  0.1, 0,
       0.5,  0.5, 0,
       0.8,  0.5, 0,
       0.5,  0.8, 0
    ];
    const uvs = [
      0.10, 0.10,
      0.35, 0.10,
      0.10, 0.35,
      0.62, 0.62,
      0.88, 0.62,
      0.62, 0.88
    ];
    const attribute = (values, itemSize) => ({
      count: values.length / itemSize,
      getX(index) {
        return values[index * itemSize];
      },
      getY(index) {
        return values[index * itemSize + 1];
      },
      getZ(index) {
        return values[index * itemSize + 2];
      }
    });
    const geometry = {
      attributes: {
        position: attribute(positions, 3),
        uv: attribute(uvs, 2)
      }
    };
    const record = {
      id: "record-neighbor-tsl-component-gate",
      geometry,
      object: {
        geometry,
        localToWorld(point) {
          return point;
        }
      }
    };
    const currentHit = {
      object: record.object,
      uv: { x: 0.18, y: 0.18 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    };
    const editor = {
      renderer: {
        isWebGPURenderer: true,
        backend: { isWebGPUBackend: true }
      },
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        }
      },
      textureBrushRadiusValue: () => 0.2,
      textureBrushRadiusScreenPixels: () => 34,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      }
    };
    const neighborPaintSeed = {
      enabled: true,
      record,
      material,
      materialIndex: 0,
      seedVertexIndex: 0,
      componentId: 0,
      component: new Set([0, 1, 2]),
      key: "record-neighbor-tsl-component-gate:0:material:0"
    };

    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
      clientX: 38,
      clientY: 62
    }, {
      radiusPixels: 34,
      textureRadiusPixels: 180,
      liveProjectedPaint: true,
      useTslSurfaceAirbrush: true,
      useVisibilityTrianglePaintRegions: true,
      fullProjectedSurfaceRenderTriangles: true,
      requireVisibilityTriangles: true,
      neighborPaintSeed,
      strokeStart: { clientX: 32, clientY: 62 },
      strokeSegments: [{
        start: { clientX: 32, clientY: 62 },
        end: { clientX: 44, clientY: 62 }
      }]
    });

    assert.notEqual(candidate.options.hardTextureAirbrushComponentGate, true);
    assert.notEqual(candidate.options.relaxComponentGateOnFrontmost, true);
    assert.equal(candidate.options.fullProjectedSurfaceRenderTriangles, true);
    assert.ok(candidate.options.screenProjectedStrokeSegments.length > 0);
    const segmentComponents = candidate.options.screenProjectedStrokeSegments.map((segment) => [
      segment.componentStart,
      segment.componentEnd
    ]);
    assert.ok(segmentComponents.some(([start, end]) => start !== 0 || end !== 0));
  } finally {
    globalThis.THREE = previousThree;
  }
});

test("airbrush WebGPU stroke planner does not authorize vertex-only UV neighbors", () => {
  const material = { uuid: "material-vertex-only-mask" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0, 0,
    1, 0,
    0, 1,
    0.12, 0.92,
    0.22, 0.92
  ];
  const indexValues = [0, 1, 2, 2, 3, 4];
  const record = {
    id: "record-vertex-only-mask",
    geometry: {
      index: {
        count: indexValues.length,
        getX(index) {
          return indexValues[index];
        }
      },
      attributes: {
        uv: {
          count: 5,
          getX(index) {
            return uvValues[index * 2];
          },
          getY(index) {
            return uvValues[index * 2 + 1];
          }
        }
      }
    }
  };
  const currentHit = {
    uv: { x: 0.15, y: 0.15 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 20,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 15,
    clientY: 15
  }, {
    textureRadiusPixels: 120,
    maxVisibilityTriangles: 4
  });

  assert.equal(candidate.options.visibilityMaskTriangles.length, 1);
  assert.deepEqual(candidate.options.visibilityMaskTriangles[0], {
    a: { x: 0, y: 0 },
    b: { x: 100, y: 0 },
    c: { x: 0, y: 100 }
  });
});

test("airbrush WebGPU stroke planner samples direct path pieces around UV seams", () => {
  const material = { uuid: "material-seam" };
  const { editable } = fakeEditableTexture(1001, 101, new Uint8Array(1001 * 101 * 4));
  const record = { id: "record-seam" };
  const editor = {
    textureBrushRadiusValue: () => 0.02,
    textureBrushRadiusScreenPixels: () => 10,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent(event) {
      const clientX = Math.max(0, Math.min(100, Number(event?.clientX) || 0));
      const uvX = clientX <= 50
        ? 0.1 + (clientX / 50) * 0.1
        : 0.8 + ((clientX - 50) / 50) * 0.1;
      return {
        record,
        hit: {
          uv: { x: uvX, y: 0.5 },
          face: { materialIndex: 0 }
        }
      };
    }
  };
  const currentHit = editor.texturePaintHitForEvent({ clientX: 100, clientY: 0 }).hit;

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 100,
    clientY: 0,
    pointerType: "pen"
  }, {
    radiusPixels: 10,
    strokeSegments: [{
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 100, clientY: 0 }
    }]
  });

  assert.ok(candidate.strokeSegments.length > 2);
  assert.ok(candidate.strokeSegments.some((segment) => Math.max(segment.start.x, segment.end.x) < 300));
  assert.ok(candidate.strokeSegments.some((segment) => Math.min(segment.start.x, segment.end.x) > 700));
  assert.ok(candidate.strokeSegments.every((segment) => {
    const minX = Math.min(segment.start.x, segment.end.x);
    const maxX = Math.max(segment.start.x, segment.end.x);
    return !(minX < 300 && maxX > 700);
  }));
});

test("airbrush WebGPU stroke planner keeps both visible samples on short UV seam jumps", () => {
  const material = { uuid: "material-short-seam" };
  const { editable } = fakeEditableTexture(1001, 101, new Uint8Array(1001 * 101 * 4));
  const record = { id: "record-short-seam" };
  const editor = {
    textureBrushRadiusValue: () => 0.02,
    textureBrushRadiusScreenPixels: () => 10,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent(event) {
      return {
        record,
        hit: {
          uv: {
            x: Number(event?.clientX) < 3 ? 0.2 : 0.82,
            y: 0.5
          },
          face: { materialIndex: 0 }
        }
      };
    }
  };
  const currentHit = editor.texturePaintHitForEvent({ clientX: 6, clientY: 0 }).hit;

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 6,
    clientY: 0,
    pointerType: "pen"
  }, {
    radiusPixels: 10,
    strokeSegments: [{
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 6, clientY: 0 }
    }]
  });

  assert.ok(candidate.strokeSegments.some((segment) => (
    segment.start.x === segment.end.x && segment.start.x < 300
  )));
  assert.ok(candidate.strokeSegments.some((segment) => (
    segment.start.x === segment.end.x && segment.start.x > 700
  )));
  assert.ok(candidate.strokeSegments.every((segment) => {
    const minX = Math.min(segment.start.x, segment.end.x);
    const maxX = Math.max(segment.start.x, segment.end.x);
    return !(minX < 300 && maxX > 700);
  }));
});

test("airbrush WebGPU stroke planner links visible UV seams with local projected segments", () => {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }

    fromBufferAttribute(attribute, index) {
      this.x = attribute.getX(index);
      this.y = attribute.getY(index);
      this.z = attribute.getZ(index);
      return this;
    }

    project() {
      return this;
    }
  }
  const previousThree = globalThis.THREE;
  globalThis.THREE = { Vector3 };
  try {
    const material = { uuid: "material-linked-visible-seam" };
    const { editable } = fakeEditableTexture(1001, 1001, new Uint8Array(1001 * 1001 * 4));
    const positions = [
      -0.22, -0.20, 0,
      -0.02, -0.20, 0,
      -0.22,  0.00, 0,
       0.02, -0.20, 0,
       0.22, -0.20, 0,
       0.02,  0.00, 0
    ];
    const uvs = [
      0.20, 0.40,
      0.24, 0.40,
      0.20, 0.44,
      0.80, 0.40,
      0.84, 0.40,
      0.80, 0.44
    ];
    const attribute = (values, itemSize) => ({
      count: values.length / itemSize,
      getX(index) {
        return values[index * itemSize];
      },
      getY(index) {
        return values[index * itemSize + 1];
      },
      getZ(index) {
        return values[index * itemSize + 2];
      }
    });
    const geometry = {
      attributes: {
        position: attribute(positions, 3),
        uv: attribute(uvs, 2)
      }
    };
    const record = {
      id: "record-linked-visible-seam",
      geometry,
      object: {
        geometry,
        localToWorld(point) {
          return point;
        }
      },
      seamVertexMap: new Map([
        [3, [3, 0]],
        [4, [4, 1]],
        [5, [5, 2]]
      ])
    };
    const leftHit = {
      object: record.object,
      uv: { x: 0.22, y: 0.42 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    };
    const rightHit = {
      object: record.object,
      uv: { x: 0.82, y: 0.42 },
      face: { a: 3, b: 4, c: 5, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 1
    };
    const editor = {
      camera: {},
      canvas: {
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 100, height: 100 };
        }
      },
      textureBrushRadiusValue: () => 0.08,
      textureBrushRadiusScreenPixels: () => 14,
      clonePaintMaterialForHit(hitRecord) {
        return hitRecord === record ? material : null;
      },
      editableClonePaintTexture(candidateMaterial) {
        return candidateMaterial === material ? editable : null;
      },
      clonePaintTextureUv(uv) {
        return { x: uv.x, y: uv.y };
      },
      clonePaintPixelFromMappedTextureUv(mapped, canvas) {
        return {
          x: Math.round(mapped.x * (canvas.width - 1)),
          y: Math.round(mapped.y * (canvas.height - 1))
        };
      },
      clonePaintPixelFromUv(uv, canvas, texture, options) {
        return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
      },
      texturePaintHitForEvent(event) {
        return {
          record,
          hit: Number(event?.clientX) <= 50 ? leftHit : rightHit
        };
      }
    };

    const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, rightHit, {
      clientX: 56,
      clientY: 60,
      pointerType: "pen"
    }, {
      radiusPixels: 14,
      textureRadiusPixels: 80,
      requireVisibilityTriangles: true,
      liveProjectedPaint: true,
      screenBrushVisibilityTriangles: true,
      maxVisibilityTriangles: 4,
      strokeSegments: [{
        start: { clientX: 44, clientY: 60 },
        end: { clientX: 56, clientY: 60 }
      }]
    });

    const nonZeroSegments = candidate.strokeSegments.filter((segment) => (
      Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) > 0.001
    ));
    assert.ok(nonZeroSegments.some((segment) => Math.max(segment.start.x, segment.end.x) < 300));
    assert.ok(nonZeroSegments.some((segment) => Math.min(segment.start.x, segment.end.x) > 700));
    assert.ok(candidate.strokeSegments.every((segment) => {
      const minX = Math.min(segment.start.x, segment.end.x);
      const maxX = Math.max(segment.start.x, segment.end.x);
      return !(minX < 300 && maxX > 700);
    }));
  } finally {
    globalThis.THREE = previousThree;
  }
});

test("airbrush WebGPU stroke planner breaks long direct paths at missing visible samples", () => {
  const material = { uuid: "material-visible-gap" };
  const { editable } = fakeEditableTexture(1001, 101, new Uint8Array(1001 * 101 * 4));
  const record = { id: "record-visible-gap" };
  let hitTests = 0;
  const editor = {
    textureBrushRadiusValue: () => 0.02,
    textureBrushRadiusScreenPixels: () => 10,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent(event) {
      hitTests += 1;
      const clientX = Math.max(0, Math.min(100, Number(event?.clientX) || 0));
      if (clientX > 40 && clientX < 60) {
        return null;
      }
      return {
        record,
        hit: {
          uv: { x: 0.2 + (clientX / 100) * 0.02, y: 0.5 },
          face: { materialIndex: 0 }
        }
      };
    }
  };
  const currentHit = editor.texturePaintHitForEvent({ clientX: 100, clientY: 0 }).hit;

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, currentHit, {
    clientX: 100,
    clientY: 0,
    pointerType: "pen"
  }, {
    radiusPixels: 10,
    strokeSegments: [{
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 100, clientY: 0 }
    }]
  });

  const longestSegment = Math.max(...candidate.strokeSegments.map((segment) => (
    Math.abs(segment.end.x - segment.start.x)
  )));
  assert.ok(candidate.strokeSegments.length > 1);
  assert.ok(longestSegment < 12);
  assert.ok(hitTests <= 16);
});

test("airbrush WebGPU cached live stroke samples never raycast or bridge cache gaps", () => {
  const material = { uuid: "material-cached-live" };
  const { editable } = fakeEditableTexture(512, 512, new Uint8Array(512 * 512 * 4));
  const record = { id: "record-cached-live" };
  let raycastCalls = 0;
  const editor = {
    textureBrushRadiusValue: () => 0.05,
    textureBrushRadiusScreenPixels: () => 20,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    },
    texturePaintHitForEvent() {
      raycastCalls += 1;
      throw new Error("cached live WebGPU stroke planning must not raycast missing samples");
    }
  };
  const cacheKey = (point) => [
    record.id,
    0,
    material.uuid,
    Math.round(point.clientX * 2),
    Math.round(point.clientY * 2)
  ].join(":");

  const connectedCache = new Map();
  const connectedStart = { clientX: 10, clientY: 12 };
  const connectedEnd = { clientX: 18, clientY: 12 };
  connectedCache.set(cacheKey(connectedStart), {
    client: connectedStart,
    pixel: { x: 120, y: 200 }
  });
  const connected = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
    uv: { x: 130 / 511, y: 205 / 511 },
    face: { materialIndex: 0 }
  }, {
    ...connectedEnd,
    pointerType: "pen"
  }, {
    cachedStrokeSamplesOnly: true,
    hitSampleCache: connectedCache,
    radiusPixels: 10,
    textureRadiusPixels: 24,
    strokeStart: connectedStart,
    strokeSegments: [{
      start: connectedStart,
      end: connectedEnd
    }]
  });

  assert.deepEqual(connected.strokeSegments, [{
    start: { x: 120, y: 200 },
    end: { x: 130, y: 205 },
    screenStart: { x: 10, y: 12 },
    screenEnd: { x: 18, y: 12 },
    screenRadiusPixels: 10,
    radiusPixels: 24
  }]);
  assert.equal(connected.options.cachedStrokeSamplesOnly, true);

  const missingStart = { clientX: 100, clientY: 112 };
  const missingEnd = { clientX: 112, clientY: 112 };
  const missing = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
    uv: { x: 420 / 511, y: 410 / 511 },
    face: { materialIndex: 0 }
  }, {
    ...missingEnd,
    pointerType: "pen"
  }, {
    cachedStrokeSamplesOnly: true,
    hitSampleCache: new Map(),
    radiusPixels: 10,
    textureRadiusPixels: 24,
    strokeStart: missingStart,
    strokeSegments: [{
      start: missingStart,
      end: missingEnd
    }]
  });

  assert.deepEqual(missing.strokeSegments, [{
    start: { x: 420, y: 410 },
    end: { x: 420, y: 410 }
  }]);
  assert.equal(raycastCalls, 0);
});

test("airbrush WebGPU projected strokes keep the screen field when UV geometry collapses", () => {
  const material = { uuid: "material-projected-disconnected-samples" };
  const { editable } = fakeEditableTexture(4096, 4096, new Uint8Array(4096 * 4096 * 4));
  const record = { id: "record-projected-disconnected-samples" };
  const start = { clientX: 420, clientY: 500 };
  const end = { clientX: 430, clientY: 505 };
  const editor = {
    canvas: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 800, height: 700 };
      }
    },
    textureBrushRadiusValue: () => 0.18,
    textureBrushRadiusScreenPixels: () => 40,
    clonePaintMaterialForHit(hitRecord) {
      return hitRecord === record ? material : null;
    },
    editableClonePaintTexture(candidateMaterial) {
      return candidateMaterial === material ? editable : null;
    },
    clonePaintTextureUv(uv) {
      return { x: uv.x, y: uv.y };
    },
    clonePaintPixelFromMappedTextureUv(mapped, canvas) {
      return {
        x: Math.round(mapped.x * (canvas.width - 1)),
        y: Math.round(mapped.y * (canvas.height - 1))
      };
    },
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };
  const cacheKey = (point) => [
    record.id,
    0,
    material.uuid,
    Math.round(point.clientX * 2),
    Math.round(point.clientY * 2)
  ].join(":");
  const hitSampleCache = new Map([
    [cacheKey(start), { client: start, pixel: { x: 820, y: 2980 } }],
    [cacheKey(end), { client: end, pixel: { x: 2940, y: 3190 } }]
  ]);
  const screenProjectedStrokeSegments = [
    { start, end, radiusPixels: 40 }
  ];

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
    uv: { x: 2940 / 4095, y: 3190 / 4095 },
    face: { materialIndex: 0 }
  }, {
    ...end,
    pointerType: "pen"
  }, {
    cachedStrokeSamplesOnly: true,
    hitSampleCache,
    liveProjectedPaint: true,
    screenStrokePaint: true,
    requireVisibilityMask: true,
    deferVisibilityMaskAssignment: true,
    captureCandidateTimings: true,
    radiusPixels: 40,
    textureRadiusPixels: 245,
    strokeStart: start,
    strokeSegments: screenProjectedStrokeSegments,
    screenProjectedStrokeSegments
  });

  assert.ok(candidate);
  assert.equal(candidate.options.candidateDebugCounts.strokeSegments, 1);
  assert.deepEqual(candidate.options.screenProjectedStrokeSegments, screenProjectedStrokeSegments);
  assert.ok(candidate.strokeSegments.every((segment) => (
    segment.start.x === segment.end.x && segment.start.y === segment.end.y
  )));
});

test("airbrush WebGPU cached live candidates skip skinned bounds refresh", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-cached-candidate" };
  const { editable } = fakeEditableTexture(32, 32, new Uint8Array(32 * 32 * 4));
  const record = { id: "record-cached-candidate" };
  const hitOptions = [];

  editor.model = {};
  editor.texturePaintHitForEvent = (event, tool, options) => {
    hitOptions.push(options || {});
    return {
      record,
      hit: {
        uv: { x: 0.5, y: 0.5 },
        face: { materialIndex: 0 }
      }
    };
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 10,
    clientY: 12
  }, {
    cachedStrokeSamplesOnly: true,
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    radiusPixels: 8
  });

  assert.equal(candidates.length, 1);
  assert.equal(hitOptions.length, 1);
  assert.equal(hitOptions[0].refreshSkinnedBounds, false);
});

test("airbrush WebGPU live candidates reuse cached screen hits", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-hit-cache" };
  const { editable } = fakeEditableTexture(32, 32, new Uint8Array(32 * 32 * 4));
  const record = { id: "record-live-hit-cache" };
  let hitCalls = 0;

  editor.model = {};
  editor.texturePaintHitForEvent = () => {
    hitCalls += 1;
    return {
      record,
      hit: {
        uv: { x: 0.5, y: 0.5 },
        face: { materialIndex: 0 }
      }
    };
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  const hitSampleCache = new Map();
  const event = {
    clientX: 10,
    clientY: 12
  };
  const options = {
    cachedStrokeSamplesOnly: true,
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    deferVisibilityMaskAssignment: true,
    radiusPixels: 8,
    hitSampleCache
  };

  const firstCandidates = editor.textureAirbrushWebGpuCandidatesFromEvent(event, options);
  const secondCandidates = editor.textureAirbrushWebGpuCandidatesFromEvent(event, options);

  assert.equal(firstCandidates.length, 1);
  assert.equal(secondCandidates.length, 1);
  assert.equal(hitCalls, 1);
});

test("airbrush WebGPU direct live candidates use indexed screen hits before full hit tests", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-direct-indexed-live-hit" };
  const { editable } = fakeEditableTexture(32, 32, new Uint8Array(32 * 32 * 4));
  const record = { id: "record-direct-indexed-live-hit" };
  let screenHitCalls = 0;
  let fullHitCalls = 0;

  editor.model = {};
  editor.painting = true;
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 120,
      height: 80
    })
  };
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => {
    screenHitCalls += 1;
    return [{
      record,
      hit: {
        uv: { x: 0.5, y: 0.5 },
        face: { materialIndex: 0 }
      }
    }];
  };
  editor.texturePaintHitForEvent = () => {
    fullHitCalls += 1;
    throw new Error("direct live WebGPU candidates should use the indexed screen hit");
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 20,
    clientY: 24,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityTriangles: false,
    deferVisibilityMaskAssignment: true,
    radiusPixels: 8,
    hitSampleCache: new Map()
  });

  assert.equal(candidates.length, 1);
  assert.equal(screenHitCalls, 1);
  assert.equal(fullHitCalls, 0);
  assert.deepEqual(candidates[0].center, { x: 16, y: 16 });
});

test("airbrush WebGPU stroke samples use indexed screen hits before full hit tests", () => {
  const material = { uuid: "material-indexed-stroke-samples" };
  const { editable } = fakeEditableTexture(32, 32, new Uint8Array(32 * 32 * 4));
  const record = { id: "record-indexed-stroke-samples" };
  const startHit = {
    uv: { x: 0.25, y: 0.5 },
    face: { materialIndex: 0 }
  };
  const endHit = {
    uv: { x: 0.75, y: 0.5 },
    face: { materialIndex: 0 }
  };
  let screenHitCalls = 0;
  let fullHitCalls = 0;
  const editor = {
    canvas: {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 120,
        height: 80
      })
    },
    model: {},
    painting: true,
    textureAirbrushScreenHitsForEvent(event) {
      screenHitCalls += 1;
      return [{
        record,
        hit: event.clientX < 50 ? startHit : endHit
      }];
    },
    textureAirbrushScreenHitIndexCurrent() {
      return true;
    },
    texturePaintHitForEvent() {
      fullHitCalls += 1;
      throw new Error("live indexed samples should not use the full hit path");
    },
    clonePaintMaterialForHit() {
      return material;
    },
    editableClonePaintTexture() {
      return editable;
    },
    clonePaintTextureUv: (uv) => ({ x: uv.x, y: uv.y }),
    clonePaintPixelFromMappedTextureUv: (mapped, canvas) => ({
      x: Math.round(mapped.x * (canvas.width - 1)),
      y: Math.round(mapped.y * (canvas.height - 1))
    }),
    clonePaintPixelFromUv(uv, canvas) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas);
    },
    textureBrushRadiusValue: () => 0.05,
    textureBrushRadiusScreenPixels: () => 12,
    textureAirbrushOpacity: () => 0.5,
    textureAirbrushHardness: () => 0.4,
    textureAirbrushScatter: () => 0.3
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(
    editor,
    record,
    endHit,
    { clientX: 100, clientY: 40, button: 0, buttons: 1 },
    {
      liveProjectedPaint: true,
      visibleSurfaceMaskRequired: true,
      requireVisibilityMask: true,
      strokeStart: { clientX: 10, clientY: 40 },
      strokeSegments: [{
        start: { clientX: 10, clientY: 40 },
        end: { clientX: 100, clientY: 40 }
      }],
      hitSampleCache: new Map(),
      radiusPixels: 12
    }
  );

  assert.ok(candidate);
  assert.equal(fullHitCalls, 0);
  assert.ok(screenHitCalls > 1);
  assert.equal(candidate.strokeSegments.length, 1);
  assert.deepEqual(candidate.strokeSegments[0], {
    start: { x: 8, y: 16 },
    end: { x: 23, y: 16 },
    screenStart: { x: 47.5, y: 40 },
    screenEnd: { x: 55, y: 40 },
    screenRadiusPixels: 12,
    radiusPixels: 8
  });
});

test("airbrush WebGPU indexed-only stroke samples skip full hit fallback on misses", () => {
  const material = { uuid: "material-indexed-stroke-miss" };
  const { editable } = fakeEditableTexture(32, 32, new Uint8Array(32 * 32 * 4));
  const record = { id: "record-indexed-stroke-miss" };
  const endHit = {
    uv: { x: 0.75, y: 0.5 },
    face: { materialIndex: 0 }
  };
  let screenHitCalls = 0;
  let fullHitCalls = 0;
  const editor = {
    canvas: {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 120,
        height: 80
      })
    },
    model: {},
    painting: true,
    textureAirbrushScreenHitsForEvent() {
      screenHitCalls += 1;
      return [];
    },
    textureAirbrushScreenHitIndexCurrent() {
      return true;
    },
    texturePaintHitForEvent() {
      fullHitCalls += 1;
      throw new Error("indexed-only live stroke samples should not use full hit fallback");
    },
    clonePaintMaterialForHit() {
      return material;
    },
    editableClonePaintTexture() {
      return editable;
    },
    clonePaintTextureUv: (uv) => ({ x: uv.x, y: uv.y }),
    clonePaintPixelFromMappedTextureUv: (mapped, canvas) => ({
      x: Math.round(mapped.x * (canvas.width - 1)),
      y: Math.round(mapped.y * (canvas.height - 1))
    }),
    clonePaintPixelFromUv(uv, canvas) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas);
    },
    textureBrushRadiusValue: () => 0.05,
    textureBrushRadiusScreenPixels: () => 12,
    textureAirbrushOpacity: () => 0.5,
    textureAirbrushHardness: () => 0.4,
    textureAirbrushScatter: () => 0.3
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(
    editor,
    record,
    endHit,
    { clientX: 100, clientY: 40, button: 0, buttons: 1 },
    {
      liveProjectedPaint: true,
      visibleSurfaceMaskRequired: true,
      requireVisibilityMask: true,
      indexedStrokeSamplesOnly: true,
      strokeStart: { clientX: 10, clientY: 40 },
      strokeSegments: [{
        start: { clientX: 10, clientY: 40 },
        end: { clientX: 100, clientY: 40 }
      }],
      radiusPixels: 12
    }
  );

  assert.ok(candidate);
  assert.equal(screenHitCalls > 0, true);
  assert.equal(fullHitCalls, 0);
  assert.deepEqual(candidate.strokeSegments, [{
    start: { x: 23, y: 16 },
    end: { x: 23, y: 16 }
  }]);
});

test("airbrush WebGPU Neighbor probes reuse cached indexed screen hits", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-neighbor-screen-hit-cache" };
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const record = {
    id: "record-neighbor-screen-hit-cache",
    object: {
      updateMatrixWorld() {}
    }
  };
  let screenHitCalls = 0;
  const hit = {
    uv: { x: 0.5, y: 0.5 },
    face: {
      a: 0,
      b: 1,
      c: 2,
      materialIndex: 0
    }
  };

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100
    })
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.texturePaintHitForEvent = () => ({ record, hit });
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = (hitEvent) => {
    screenHitCalls += 1;
    const uvX = Math.max(0, Math.min(1, Number(hitEvent?.clientX) / 200));
    return [{
      record,
      hit: {
        ...hit,
        uv: { x: uvX, y: 0.5 }
      }
    }];
  };
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      throw new Error("cached indexed Neighbor probes should not raycast");
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  let editableCalls = 0;
  editor.editableClonePaintTexture = () => {
    editableCalls += 1;
    return editable;
  };
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  editor.textureAirbrushNeighborHitAllowed = () => true;
  const hitSampleCache = new Map();
  const event = {
    clientX: 50,
    clientY: 50,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  };
  const options = {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    requireVisibilityTriangles: false,
    deferVisibilityMaskAssignment: true,
    directVisibilityOnly: false,
    neighborPaintSeed: { enabled: true },
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 4,
    radiusPixels: 12,
    hitSampleCache
  };

  const firstCandidates = editor.textureAirbrushWebGpuCandidatesFromEvent(event, options);
  const firstScreenHitCalls = screenHitCalls;
  const firstEditableCalls = editableCalls;
  const secondCandidates = editor.textureAirbrushWebGpuCandidatesFromEvent(event, options);

  assert.ok(firstCandidates.length > 0);
  assert.ok(secondCandidates.length > 0);
  assert.ok(firstScreenHitCalls > 0);
  assert.equal(screenHitCalls, firstScreenHitCalls);
  assert.equal(firstEditableCalls, 1);
  assert.equal(editableCalls, 2);
});

test("airbrush WebGPU Neighbor probes skip disallowed hits before stroke conversion", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-neighbor-early-reject", name: "neighbor material" };
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const record = {
    id: "record-neighbor-early-reject",
    object: {
      updateMatrixWorld() {}
    }
  };
  const allowedHit = {
    object: record.object,
    uv: { x: 0.5, y: 0.5 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    faceIndex: 0
  };
  const rejectedHit = {
    object: record.object,
    uv: { x: 0.75, y: 0.75 },
    face: { a: 3, b: 4, c: 5, materialIndex: 0 },
    faceIndex: 1
  };

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100
    })
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.texturePaintHitForEvent = () => ({ record, hit: allowedHit });
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => [
    { record, hit: allowedHit },
    { record, hit: rejectedHit }
  ];
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      throw new Error("indexed Neighbor early-reject test should not raycast");
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  editor.textureAirbrushNeighborHitAllowed = (seed, candidateRecord, hit) => (
    seed?.enabled === true
    && candidateRecord === record
    && hit?.faceIndex !== rejectedHit.faceIndex
  );
  const convertedFaceIndexes = [];
  const originalCandidateFromHit = editor.textureAirbrushWebGpuStrokeCandidateFromHit.bind(editor);
  editor.textureAirbrushWebGpuStrokeCandidateFromHit = (candidateRecord, hit, event, options) => {
    convertedFaceIndexes.push(hit?.faceIndex ?? -1);
    return originalCandidateFromHit(candidateRecord, hit, event, options);
  };

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 50,
    clientY: 50,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    requireVisibilityTriangles: false,
    deferVisibilityMaskAssignment: true,
    directVisibilityOnly: false,
    neighborPaintSeed: { enabled: true },
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 4,
    radiusPixels: 12
  });

  assert.ok(candidates.length > 0);
  assert.ok(convertedFaceIndexes.includes(allowedHit.faceIndex));
  assert.equal(convertedFaceIndexes.includes(rejectedHit.faceIndex), false);
});

test("airbrush WebGPU indexed Neighbor probes scan past rejected hits to keep the latched island", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-neighbor-deep-latched", name: "neighbor material" };
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const record = {
    id: "record-neighbor-deep-latched",
    object: {
      updateMatrixWorld() {}
    }
  };
  const hitForFace = (faceIndex, uv) => ({
    object: record.object,
    uv,
    face: {
      a: faceIndex * 3,
      b: faceIndex * 3 + 1,
      c: faceIndex * 3 + 2,
      materialIndex: 0
    },
    faceIndex
  });
  const rejectedHits = Array.from({ length: 8 }, (_, index) => (
    hitForFace(index, { x: 0.1 + index * 0.02, y: 0.1 })
  ));
  const allowedHit = hitForFace(9, { x: 0.75, y: 0.75 });

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100
    })
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.texturePaintHitForEvent = () => ({ record, hit: rejectedHits[0] });
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => [
    ...rejectedHits.map((hit) => ({ record, hit })),
    { record, hit: allowedHit }
  ];
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      throw new Error("indexed Neighbor deep-latch test should not raycast");
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  editor.textureAirbrushNeighborHitAllowed = (seed, candidateRecord, hit) => (
    seed?.enabled === true
    && candidateRecord === record
    && hit?.faceIndex === allowedHit.faceIndex
  );
  const convertedFaceIndexes = [];
  const originalCandidateFromHit = editor.textureAirbrushWebGpuStrokeCandidateFromHit.bind(editor);
  editor.textureAirbrushWebGpuStrokeCandidateFromHit = (candidateRecord, hit, event, options) => {
    convertedFaceIndexes.push(hit?.faceIndex ?? -1);
    return originalCandidateFromHit(candidateRecord, hit, event, options);
  };

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 50,
    clientY: 50,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    requireVisibilityTriangles: false,
    deferVisibilityMaskAssignment: true,
    directVisibilityOnly: false,
    neighborPaintSeed: { enabled: true },
    maxNeighborVisibilityIntersections: 2,
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 4,
    radiusPixels: 12
  });

  assert.ok(candidates.length > 0);
  assert.ok(convertedFaceIndexes.includes(allowedHit.faceIndex));
  assert.equal(convertedFaceIndexes.some((faceIndex) => faceIndex >= 0 && faceIndex !== allowedHit.faceIndex), false);
});

test("airbrush WebGPU raycast Neighbor probes scan past rejected hits to keep the latched island", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-neighbor-raycast-deep-latched", name: "neighbor material" };
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const record = {
    id: "record-neighbor-raycast-deep-latched",
    object: {
      updateMatrixWorld() {}
    }
  };
  const hitForFace = (faceIndex, uv) => ({
    object: record.object,
    uv,
    face: {
      a: faceIndex * 3,
      b: faceIndex * 3 + 1,
      c: faceIndex * 3 + 2,
      materialIndex: 0
    },
    faceIndex
  });
  const rejectedHits = Array.from({ length: 8 }, (_, index) => (
    hitForFace(index, { x: 0.1 + index * 0.02, y: 0.1 })
  ));
  const allowedHit = hitForFace(9, { x: 0.75, y: 0.75 });

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100
    })
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.texturePaintHitForEvent = () => ({ record, hit: rejectedHits[0] });
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      return [...rejectedHits, allowedHit];
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  editor.textureAirbrushNeighborHitAllowed = (seed, candidateRecord, hit) => (
    seed?.enabled === true
    && candidateRecord === record
    && hit?.faceIndex === allowedHit.faceIndex
  );
  const convertedFaceIndexes = [];
  const originalCandidateFromHit = editor.textureAirbrushWebGpuStrokeCandidateFromHit.bind(editor);
  editor.textureAirbrushWebGpuStrokeCandidateFromHit = (candidateRecord, hit, event, options) => {
    convertedFaceIndexes.push(hit?.faceIndex ?? -1);
    return originalCandidateFromHit(candidateRecord, hit, event, options);
  };

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 50,
    clientY: 50,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    requireVisibilityTriangles: false,
    deferVisibilityMaskAssignment: true,
    directVisibilityOnly: false,
    neighborPaintSeed: { enabled: true },
    maxNeighborVisibilityIntersections: 2,
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 4,
    radiusPixels: 12
  });

  assert.ok(candidates.length > 0);
  assert.ok(convertedFaceIndexes.includes(allowedHit.faceIndex));
  assert.equal(convertedFaceIndexes.some((faceIndex) => faceIndex >= 0 && faceIndex !== allowedHit.faceIndex), false);
});

test("airbrush WebGPU indexed Neighbor probes do not request a direct hit fallback", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-neighbor-no-direct-hit" };
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const record = {
    id: "record-neighbor-no-direct-hit",
    object: {
      updateMatrixWorld() {}
    }
  };
  const hit = {
    object: record.object,
    uv: { x: 0.5, y: 0.5 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    faceIndex: 0
  };

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100
    })
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.texturePaintHitForEvent = () => {
    throw new Error("indexed Neighbor probes should not request a direct hit fallback");
  };
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => [{ record, hit }];
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      throw new Error("indexed Neighbor probes should not raycast");
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  editor.textureAirbrushNeighborHitAllowed = () => true;

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 50,
    clientY: 50,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    requireVisibilityTriangles: false,
    deferVisibilityMaskAssignment: true,
    directVisibilityOnly: false,
    neighborPaintSeed: { enabled: true },
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 4,
    radiusPixels: 12
  });

  assert.ok(candidates.length > 0);
});

test("airbrush WebGPU live footprint probes are budgeted for large brushes", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-budgeted-candidate" };
  const { editable } = fakeEditableTexture(512, 512, new Uint8Array(512 * 512 * 4));
  const record = {
    id: "record-budgeted-candidate",
    object: {
      updateMatrixWorld() {}
    }
  };
  let hitCalls = 0;

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 640,
      height: 480
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      throw new Error("budgeted live probes should use indexed screen hits in this test");
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.texturePaintHitForEvent = (event) => {
    hitCalls += 1;
    return {
      record,
      hit: {
        uv: {
          x: Math.max(0, Math.min(1, event.clientX / 640)),
          y: Math.max(0, Math.min(1, event.clientY / 480))
        },
        face: { materialIndex: 0 }
      }
    };
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 320,
    clientY: 240,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    cachedStrokeSamplesOnly: true,
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    captureCandidateDebug: true,
    radiusPixels: 72,
    strokeStart: { clientX: 260, clientY: 240 },
    strokeSegments: [{
      start: { clientX: 260, clientY: 240 },
      end: { clientX: 320, clientY: 240 }
    }]
  });

  assert.ok(candidates.length > 0);
  assert.ok(editor.textureAirbrushLastWebGpuCandidateDebug.probeCount <= 96);
  assert.ok(hitCalls < 180);
});

test("airbrush WebGPU live bounds forced footprint probes after ordered samples hit", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-ordered-live-skip-footprint" };
  const { editable } = fakeEditableTexture(128, 128, new Uint8Array(128 * 128 * 4));
  const record = {
    id: "record-ordered-live-skip-footprint",
    object: {
      updateMatrixWorld() {}
    }
  };
  const hit = {
    object: record.object,
    uv: { x: 0.5, y: 0.5 },
    face: { materialIndex: 0 }
  };
  let screenHitCalls = 0;

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("ordered live samples should not raycast");
    },
    intersectObjects() {
      throw new Error("ordered live samples should not raycast");
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.textureAirbrushScreenHitIndex = {};
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => {
    screenHitCalls += 1;
    return [{ record, hit }];
  };
  editor.texturePaintHitForEvent = () => {
    throw new Error("ordered live samples should not need direct hits");
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 100,
    clientY: 100,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    captureCandidateDebug: true,
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 24,
    radiusPixels: 24,
    strokeStart: { clientX: 40, clientY: 100 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 100 },
      end: { clientX: 100, clientY: 100 }
    }]
  });

  assert.ok(candidates.length > 0);
  assert.ok(screenHitCalls > 2);
  assert.ok(screenHitCalls <= 40, `screenHitCalls=${screenHitCalls}`);
  assert.equal(editor.textureAirbrushLastWebGpuCandidateDebug.probeCount, 24);
});

test("airbrush WebGPU live Neighbor skips footprint probes after ordered under samples hit", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-neighbor-ordered-skip-footprint" };
  const { editable } = fakeEditableTexture(128, 128, new Uint8Array(128 * 128 * 4));
  const record = {
    id: "record-neighbor-ordered-skip-footprint",
    object: {
      updateMatrixWorld() {}
    }
  };
  const frontHit = {
    object: record.object,
    uv: { x: 0.35, y: 0.5 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    faceIndex: 0
  };
  const underHit = {
    object: record.object,
    uv: { x: 0.65, y: 0.5 },
    face: { a: 3, b: 4, c: 5, materialIndex: 0 },
    faceIndex: 1
  };
  let screenHitCalls = 0;

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("ordered live Neighbor samples should not raycast");
    },
    intersectObjects() {
      throw new Error("ordered live Neighbor samples should not raycast");
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.textureAirbrushScreenHitIndex = {};
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = (hitEvent) => {
    screenHitCalls += 1;
    const x = Math.max(0, Math.min(1, Number(hitEvent?.clientX) || 0));
    return [
      {
        record,
        hit: {
          ...frontHit,
          uv: { x: Math.max(0, Math.min(1, x / 300)), y: 0.5 }
        }
      },
      {
        record,
        hit: {
          ...underHit,
          uv: { x: Math.max(0, Math.min(1, 0.45 + x / 500)), y: 0.5 }
        }
      }
    ];
  };
  editor.texturePaintHitForEvent = () => {
    throw new Error("ordered live Neighbor samples should not need direct hits");
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  editor.textureAirbrushNeighborHitAllowed = () => true;

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 100,
    clientY: 100,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    captureCandidateDebug: true,
    neighborPaintSeed: { enabled: true },
    maxNeighborVisibilityIntersections: 4,
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 24,
    radiusPixels: 24,
    strokeStart: { clientX: 40, clientY: 100 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 100 },
      end: { clientX: 100, clientY: 100 }
    }]
  });

  assert.ok(candidates.length > 0);
  assert.ok(screenHitCalls > 2);
  assert.ok(screenHitCalls <= 12);
  assert.equal(editor.textureAirbrushLastWebGpuCandidateDebug.probeCount, 0);
});

test("airbrush WebGPU large live Neighbor skips footprint fallback when ordered samples miss", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const record = {
    id: "record-large-neighbor-no-footprint-fallback",
    object: {
      updateMatrixWorld() {}
    }
  };
  let screenHitCalls = 0;
  let directHitCalls = 0;

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("large live Neighbor misses must not raycast footprint probes");
    },
    intersectObjects() {
      throw new Error("large live Neighbor misses must not raycast footprint probes");
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.textureAirbrushScreenHitIndex = {};
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => {
    screenHitCalls += 1;
    return [];
  };
  editor.texturePaintHitForEvent = () => {
    directHitCalls += 1;
    return null;
  };
  editor.textureAirbrushNeighborHitAllowed = () => true;

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 100,
    clientY: 100,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    captureCandidateDebug: true,
    neighborPaintSeed: { enabled: true },
    maxNeighborVisibilityIntersections: 3,
    maxVisibilityProbePoints: 2,
    radiusPixels: 37,
    skipVisibilityFootprintProbes: true,
    strokeStart: { clientX: 40, clientY: 100 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 100 },
      end: { clientX: 100, clientY: 100 }
    }]
  });

  assert.equal(candidates.length, 0);
  assert.equal(directHitCalls, 1);
  assert.ok(screenHitCalls <= 3, `screenHitCalls=${screenHitCalls}`);
  assert.equal(editor.textureAirbrushLastWebGpuCandidateDebug.probeCount, 0);
});

test("airbrush WebGPU live skips footprint fallback when indexed ordered samples resolve", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-ordered-live-footprint-fallback" };
  const { editable } = fakeEditableTexture(128, 128, new Uint8Array(128 * 128 * 4));
  const record = {
    id: "record-ordered-live-footprint-fallback",
    object: {
      updateMatrixWorld() {}
    }
  };
  const hit = {
    object: record.object,
    uv: { x: 0.5, y: 0.5 },
    face: { materialIndex: 0 }
  };
  let screenHitCalls = 0;

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("indexed live fallback should not raycast");
    },
    intersectObjects() {
      throw new Error("indexed live fallback should not raycast");
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.textureAirbrushScreenHitIndex = {};
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => {
    screenHitCalls += 1;
    return screenHitCalls <= 2 ? [] : [{ record, hit }];
  };
  editor.texturePaintHitForEvent = () => null;
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 100,
    clientY: 100,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    captureCandidateDebug: true,
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 4,
    radiusPixels: 24,
    strokeStart: { clientX: 40, clientY: 100 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 100 },
      end: { clientX: 100, clientY: 100 }
    }]
  });

  assert.ok(candidates.length > 0);
  assert.ok(screenHitCalls > 2);
  assert.equal(editor.textureAirbrushLastWebGpuCandidateDebug.probeCount, 0);
});

test("airbrush WebGPU live footprint probes keep duplicate hit conversions bounded", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-duplicate-footprint-hit" };
  const { editable } = fakeEditableTexture(128, 128, new Uint8Array(128 * 128 * 4));
  const record = {
    id: "record-live-duplicate-footprint-hit",
    object: {
      updateMatrixWorld() {}
    }
  };
  const hit = {
    object: record.object,
    uv: { x: 0.5, y: 0.5 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    faceIndex: 0
  };
  let conversions = 0;

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("duplicate indexed live probes should not raycast");
    },
    intersectObjects() {
      throw new Error("duplicate indexed live probes should not raycast");
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.textureAirbrushScreenHitIndex = {};
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => [{ record, hit }];
  editor.texturePaintHitForEvent = () => {
    throw new Error("duplicate indexed live probes should not need direct hits");
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );
  const originalCandidateFromHit = editor.textureAirbrushWebGpuStrokeCandidateFromHit.bind(editor);
  editor.textureAirbrushWebGpuStrokeCandidateFromHit = (...args) => {
    conversions += 1;
    return originalCandidateFromHit(...args);
  };

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 100,
    clientY: 100,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    fullBrushVisibilityProbes: true,
    captureCandidateDebug: true,
    maxVisibilityProbePoints: 2,
    maxVisibilityFootprintProbePoints: 24,
    radiusPixels: 24,
    strokeStart: { clientX: 40, clientY: 100 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 100 },
      end: { clientX: 100, clientY: 100 }
    }]
  });

  assert.ok(candidates.length > 0);
  assert.equal(editor.textureAirbrushLastWebGpuCandidateDebug.probeCount, 24);
  assert.equal(conversions, 3);
});

test("airbrush WebGPU indexed probe misses skip raycast fallback", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-indexed-miss" };
  const { editable } = fakeEditableTexture(128, 128, new Uint8Array(128 * 128 * 4));
  const record = {
    id: "record-indexed-miss",
    object: {
      updateMatrixWorld() {}
    }
  };
  let hitCalls = 0;

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("indexed WebGPU probe misses should not raycast fallback");
    },
    intersectObjects() {
      throw new Error("indexed WebGPU probe misses should not raycast fallback");
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.textureAirbrushScreenHitIndex = {};
  editor.textureAirbrushScreenHitIndexCurrent = () => true;
  editor.textureAirbrushScreenHitsForEvent = () => [];
  editor.texturePaintHitForEvent = (event) => {
    hitCalls += 1;
    if (event.clientX === 100 && event.clientY === 100) {
      return {
        record,
        hit: {
          uv: { x: 0.5, y: 0.5 },
          face: { materialIndex: 0 }
        }
      };
    }
    return null;
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 100,
    clientY: 100,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    radiusPixels: 24,
    strokeStart: { clientX: 60, clientY: 100 },
    strokeSegments: [{
      start: { clientX: 60, clientY: 100 },
      end: { clientX: 100, clientY: 100 }
    }]
  });

  assert.ok(candidates.length > 0);
  assert.ok(hitCalls > 0);
});

test("airbrush WebGPU visibility footprint probe budget honors explicit caps", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-explicit-probe-budget" };
  const { editable } = fakeEditableTexture(512, 512, new Uint8Array(512 * 512 * 4));
  const record = {
    id: "record-explicit-probe-budget",
    object: {
      updateMatrixWorld() {}
    }
  };

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 640,
      height: 480
    })
  };
  editor.camera = {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      return [];
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureAirbrushRecords = () => [record];
  editor.texturePaintHitForEvent = (event) => ({
    record,
    hit: {
      uv: {
        x: Math.max(0, Math.min(1, event.clientX / 640)),
        y: Math.max(0, Math.min(1, event.clientY / 480))
      },
      face: { materialIndex: 0 }
    }
  });
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mapped, canvas) => ({
    x: Math.round(mapped.x * (canvas.width - 1)),
    y: Math.round(mapped.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas)
  );

  editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 320,
    clientY: 240,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    directVisibilityOnly: false,
    fullBrushVisibilityProbes: true,
    captureCandidateDebug: true,
    maxVisibilityFootprintProbePoints: 24,
    radiusPixels: 96,
    strokeStart: { clientX: 260, clientY: 240 },
    strokeSegments: [{
      start: { clientX: 260, clientY: 240 },
      end: { clientX: 320, clientY: 240 }
    }]
  });

  assert.equal(editor.textureAirbrushLastWebGpuCandidateDebug.probeCount, 24);
});

test("airbrush WebGPU stroke planner ignores missing hits before material lookup", () => {
  let materialLookups = 0;
  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit({
    clonePaintMaterialForHit() {
      materialLookups += 1;
      return {};
    }
  }, null, null, null);

  assert.equal(candidate, null);
  assert.equal(materialLookups, 0);
});

test("airbrush WebGPU visibility triangles use camera-facing normal rolloff", () => {
  const material = { uuid: "material-facing-rolloff" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0.0, 0.0,
    1.0, 0.0,
    0.0, 1.0
  ];
  const positionValues = [
    0.0, 0.0, 0.0,
    1.0, 0.0, 0.0,
    0.0, 0.09, 0.996
  ];
  const attribute = (values, itemSize) => ({
    count: values.length / itemSize,
    getX(index) {
      return values[index * itemSize];
    },
    getY(index) {
      return values[index * itemSize + 1];
    },
    getZ(index) {
      return values[index * itemSize + 2];
    }
  });
  const geometry = {
    attributes: {
      uv: attribute(uvValues, 2),
      position: attribute(positionValues, 3)
    }
  };
  const record = {
    id: "record-facing-rolloff",
    geometry,
    object: {
      geometry,
      localToWorld() {}
    }
  };
  const editor = {
    camera: {
      matrixWorldInverse: {
        elements: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1
        ]
      }
    },
    textureBrushRadiusValue: () => 0.05,
    clonePaintMaterialForHit: () => material,
    editableClonePaintTexture: () => editable,
    clonePaintTextureUv: (uv) => ({ x: uv.x, y: uv.y }),
    clonePaintPixelFromMappedTextureUv: (uv, canvas) => ({
      x: Math.round(uv.x * (canvas.width - 1)),
      y: Math.round(uv.y * (canvas.height - 1))
    }),
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
    object: record.object,
    uv: { x: 0.1, y: 0.1 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 }
  }, null, {
    requireVisibilityTriangles: true,
    textureRadiusPixels: 5
  });
  const coverage = candidate?.options?.visibilityMaskTriangles?.[0]?.coverage;

  assert.ok(Number.isFinite(coverage));
  assert.ok(coverage > 0.45 && coverage < 0.55);
});

test("airbrush WebGPU visibility triangles cache camera-facing coverage per frame", () => {
  const material = { uuid: "material-facing-cache" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0, 0,
    1, 0,
    0, 1
  ];
  const positionValues = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ];
  const attribute = (values, itemSize) => ({
    count: values.length / itemSize,
    getX(index) {
      return values[index * itemSize];
    },
    getY(index) {
      return values[index * itemSize + 1];
    },
    getZ(index) {
      return values[index * itemSize + 2];
    }
  });
  const geometry = {
    attributes: {
      uv: attribute(uvValues, 2),
      position: attribute(positionValues, 3)
    }
  };
  let vertexPositionReads = 0;
  const record = {
    id: "record-facing-cache",
    geometry,
    object: {
      geometry,
      getVertexPosition(index, target) {
        vertexPositionReads += 1;
        target.x = positionValues[index * 3];
        target.y = positionValues[index * 3 + 1];
        target.z = positionValues[index * 3 + 2];
        return target;
      },
      localToWorld() {}
    }
  };
  const editor = {
    camera: {
      matrixWorldInverse: {
        elements: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1
        ]
      },
      projectionMatrix: {
        elements: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1
        ]
      }
    },
    canvas: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 100 };
      }
    },
    textureBrushRadiusValue: () => 0.05,
    clonePaintMaterialForHit: () => material,
    editableClonePaintTexture: () => editable,
    clonePaintTextureUv: (uv) => ({ x: uv.x, y: uv.y }),
    clonePaintPixelFromMappedTextureUv: (uv, canvas) => ({
      x: Math.round(uv.x * (canvas.width - 1)),
      y: Math.round(uv.y * (canvas.height - 1))
    }),
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };
  const hitForUv = (uv) => ({
    object: record.object,
    uv,
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    faceIndex: 0
  });

  const first = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hitForUv({ x: 0.1, y: 0.1 }), null, {
    requireVisibilityTriangles: true,
    textureRadiusPixels: 5
  });
  const second = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hitForUv({ x: 0.2, y: 0.1 }), null, {
    requireVisibilityTriangles: true,
    textureRadiusPixels: 5
  });

  assert.ok(first);
  assert.ok(second);
  assert.equal(vertexPositionReads, 3);

  record.object.isSkinnedMesh = true;
  editor.progress = 0;
  const skinnedFirst = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hitForUv({ x: 0.3, y: 0.1 }), null, {
    requireVisibilityTriangles: true,
    textureRadiusPixels: 5
  });
  const skinnedSecond = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hitForUv({ x: 0.4, y: 0.1 }), null, {
    requireVisibilityTriangles: true,
    textureRadiusPixels: 5
  });

  assert.ok(skinnedFirst);
  assert.ok(skinnedSecond);
  assert.equal(vertexPositionReads, 6);

  editor.progress = 1;
  const skinnedMoved = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hitForUv({ x: 0.5, y: 0.1 }), null, {
    requireVisibilityTriangles: true,
    textureRadiusPixels: 5
  });

  assert.ok(skinnedMoved);
  assert.equal(vertexPositionReads, 9);
});

test("airbrush WebGPU visibility triangles reject unknown normal observability", () => {
  const material = { uuid: "material-unknown-normal" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0.0, 0.0,
    1.0, 0.0,
    0.0, 1.0
  ];
  const geometry = {
    attributes: {
      uv: {
        count: 3,
        getX(index) {
          return uvValues[index * 2];
        },
        getY(index) {
          return uvValues[index * 2 + 1];
        }
      }
    }
  };
  const record = {
    id: "record-unknown-normal",
    geometry,
    object: { geometry }
  };
  const editor = {
    textureBrushRadiusValue: () => 0.05,
    clonePaintMaterialForHit: () => material,
    editableClonePaintTexture: () => editable,
    clonePaintTextureUv: (uv) => ({ x: uv.x, y: uv.y }),
    clonePaintPixelFromMappedTextureUv: (uv, canvas) => ({
      x: Math.round(uv.x * (canvas.width - 1)),
      y: Math.round(uv.y * (canvas.height - 1))
    }),
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, {
    object: record.object,
    uv: { x: 0.1, y: 0.1 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 }
  }, null, {
    requireVisibilityTriangles: true,
    textureRadiusPixels: 5
  });

  assert.equal(candidate, null);
});

test("airbrush WebGPU Neighbor discovery includes under camera-facing intersections only", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-neighbor-under" };
  const { editable } = fakeEditableTexture(101, 101, new Uint8Array(101 * 101 * 4));
  const uvValues = [
    0.0, 0.0,
    0.2, 0.0,
    0.0, 0.2,
    0.7, 0.7,
    0.9, 0.7,
    0.7, 0.9,
    0.2, 0.7,
    0.4, 0.7,
    0.2, 0.9
  ];
  const record = {
    id: "record-neighbor-under",
    object: { uuid: "object-neighbor-under" },
    geometry: {
      attributes: {
        uv: {
          count: 9,
          getX(index) {
            return uvValues[index * 2];
          },
          getY(index) {
            return uvValues[index * 2 + 1];
          }
        }
      }
    }
  };
  const hitForFace = (vertices, uv, distance, normalZ = 1, faceIndex = 0) => ({
    object: record.object,
    distance,
    uv,
    face: {
      a: vertices[0],
      b: vertices[1],
      c: vertices[2],
      materialIndex: 0,
      normal: { x: 0, y: 0, z: normalZ }
    },
    faceIndex
  });
  const frontHit = hitForFace([0, 1, 2], { x: 0.1, y: 0.1 }, 1, 1, 0);
  const underFacingHit = hitForFace([3, 4, 5], { x: 0.8, y: 0.8 }, 2, 1, 1);
  const underBackHit = hitForFace([6, 7, 8], { x: 0.3, y: 0.8 }, 3, -1, 2);

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureBrushRadiusValue = () => 0.1;
  editor.textureBrushRadiusScreenPixels = () => 12;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.texturePaintHitForEvent = () => ({ record, hit: frontHit });
  editor.clonePaintMaterialForHit = (candidateRecord) => candidateRecord === record ? material : null;
  editor.editableClonePaintTexture = (candidateMaterial) => candidateMaterial === material ? editable : null;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mappedUv, canvas) => ({
    x: Math.max(0, Math.min(canvas.width - 1, Math.round(mappedUv.x * (canvas.width - 1)))),
    y: Math.max(0, Math.min(canvas.height - 1, Math.round(mappedUv.y * (canvas.height - 1))))
  });
  editor.clonePaintPixelFromUv = (uv, canvas, texture, options) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas, texture, options)
  );
  editor.refreshSkinnedRaycastBounds = () => {};
  let raycastCount = 0;
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      raycastCount += 1;
      return [frontHit, underFacingHit, underBackHit];
    }
  };
  editor.textureAirbrushNeighborHitAllowed = () => true;

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 50,
    clientY: 50,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    requireVisibilityTriangles: true,
    deferVisibilityMaskAssignment: true,
    directVisibilityOnly: false,
    neighborPaintSeed: { enabled: true },
    maxVisibilityFootprintProbePoints: 4,
    radiusPixels: 12
  });
  const centers = candidates.map((item) => item.center);

  assert.ok(raycastCount > 0);
  assert.ok(centers.some((center) => center.x <= 20 && center.y <= 20));
  assert.ok(centers.some((center) => center.x >= 70 && center.y >= 70));
  assert.equal(centers.some((center) => center.x >= 20 && center.x <= 40 && center.y >= 70), false);
  assert.ok(candidates.every((candidateItem) => (
    candidateItem.options.visibilityMaskTriangles || []
  ).every((triangle) => (triangle.coverage ?? 1) > 0)));
});

test("airbrush WebGPU projected surface grouping discovers all visible material passes", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const materialA = { uuid: "material-projected-surface-a", name: "A" };
  const materialB = { uuid: "material-projected-surface-b", name: "B" };
  const editableA = { texture: { uuid: "texture-a" }, canvas: { width: 64, height: 64 } };
  const editableB = { texture: { uuid: "texture-b" }, canvas: { width: 64, height: 64 } };
  const record = {
    id: "record-projected-surface-materials",
    object: { uuid: "object-projected-surface-materials", material: [materialA, materialB] },
    geometry: {
      attributes: {
        position: { count: 6 },
        uv: { count: 6 }
      }
    }
  };
  record.object.geometry = record.geometry;
  const directHit = {
    object: record.object,
    uv: { x: 0.2, y: 0.4 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    faceIndex: 0
  };
  const screenEntry = (materialIndex, faceIndex, offset = 0) => ({
    record,
    object: record.object,
    face: { a: offset, b: offset + 1, c: offset + 2, materialIndex },
    faceIndex,
    uvs: [
      { x: 0.2, y: 0.4 },
      { x: 0.3, y: 0.4 },
      { x: 0.2, y: 0.5 }
    ],
    screen: [
      { x: 32 + offset, y: 48, z: 1 },
      { x: 48 + offset, y: 48, z: 1 },
      { x: 32 + offset, y: 64, z: 1 }
    ]
  });
  let screenTriangleOptions = null;
  const candidateCalls = [];

  editor.model = { updateMatrixWorld() {} };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      return [];
    }
  };
  editor.paintRecords = [record];
  editor.texturePaintHitForEvent = () => ({ record, hit: directHit });
  editor.clonePaintMaterialForHit = (candidateRecord, hit) => (
    hit?.face?.materialIndex === 1 ? materialB : materialA
  );
  editor.editableClonePaintTexture = (material) => (
    material === materialB ? editableB : material === materialA ? editableA : null
  );
  editor.textureAirbrushScreenTrianglesNearSegments = (segments, radiusPixels, options) => {
    screenTriangleOptions = options;
    return [screenEntry(0, 0, 0), screenEntry(1, 1, 3)];
  };
  editor.textureAirbrushWebGpuStrokeCandidateFromHit = (candidateRecord, hit, event, options = {}) => {
    const material = Object.prototype.hasOwnProperty.call(options, "resolvedMaterial")
      ? options.resolvedMaterial
      : editor.clonePaintMaterialForHit(candidateRecord, hit);
    const editable = Object.prototype.hasOwnProperty.call(options, "resolvedEditable")
      ? options.resolvedEditable
      : editor.editableClonePaintTexture(material);
    const candidate = {
      record: candidateRecord,
      hit,
      material,
      editable,
      materialIndex: options.resolvedMaterialIndex ?? hit?.face?.materialIndex ?? 0,
      center: { x: event?.clientX ?? 0, y: event?.clientY ?? 0 },
      radiusPixels: 12,
      strokeSegments: options.strokeSegments || [],
      options: {
        ...options,
        liveProjectedPaint: true
      }
    };
    candidateCalls.push(candidate);
    return candidate;
  };

  const candidates = editor.textureAirbrushWebGpuCandidatesFromEvent({
    clientX: 60,
    clientY: 50,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    directVisibilityOnly: false,
    paintProjectedSurfaceCandidates: true,
    projectedSurfaceScreenCandidateGroups: true,
    radiusPixels: 20,
    strokeStart: { clientX: 30, clientY: 50 },
    strokeSegments: [{
      start: { clientX: 30, clientY: 50 },
      end: { clientX: 60, clientY: 50 }
    }]
  });

  assert.ok(screenTriangleOptions);
  assert.equal(screenTriangleOptions.materialIndex, undefined);
  assert.equal(screenTriangleOptions.material, undefined);
  assert.equal(screenTriangleOptions.editable, undefined);
  assert.ok(candidateCalls.some((candidate) => candidate.material === materialA && candidate.editable === editableA));
  assert.ok(candidateCalls.some((candidate) => candidate.material === materialB && candidate.editable === editableB));
  assert.ok(candidates.some((candidate) => candidate.material === materialB && candidate.editable === editableB));
});
