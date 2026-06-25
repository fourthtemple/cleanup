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
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../../src/weight-editor/airbrush/constants.js";
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
  TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE,
  TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE,
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
  textureAirbrushWebGpuProbePointsFromStroke,
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
  textureAirbrushWebGpuTextureDescriptors,
  textureAirbrushWebGpuUsageConstants
} from "../../src/weight-editor/airbrush/webgpu-plan.js";
import {
  textureAirbrushWebGpuStrokeCandidateFromHit,
  textureAirbrushWebGpuStrokeEstimate,
  textureAirbrushWebGpuTextureRadiusPixels
} from "../../src/weight-editor/airbrush/webgpu-stroke.js";

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

test("airbrush WebGPU query flag defaults on with explicit opt-out", () => {
  assert.equal(textureAirbrushWebGpuRequestedFromSearch(""), true);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=0"), false);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=false"), false);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=1"), true);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?airbrush-webgpu=true"), true);
});

test("airbrush WebGPU renderer query flag stays opt-in until scene materials are ported", () => {
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch(""), false);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?webgpu-renderer=0"), false);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?webgpu-renderer=off"), false);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?webgpu-renderer=1"), true);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?renderer-webgpu=true"), true);
});

test("airbrush WebGPU capability uses navigator.gpu", () => {
  assert.equal(textureAirbrushNativeWebGpuAvailable({ navigator: {} }), false);
  assert.equal(textureAirbrushNativeWebGpuAvailable({ navigator: { gpu: {} } }), true);
});

test("airbrush renderer WebGPU state requires a native backend", () => {
  assert.deepEqual(textureAirbrushRendererWebGpuState({}), {
    isWebGpuRenderer: false,
    isNativeWebGpuBackend: false,
    isWebGlFallbackBackend: false
  });
  assert.deepEqual(textureAirbrushRendererWebGpuState({
    isWebGPURenderer: true,
    backend: { isWebGLBackend: true }
  }), {
    isWebGpuRenderer: true,
    isNativeWebGpuBackend: false,
    isWebGlFallbackBackend: true
  });
  assert.deepEqual(textureAirbrushRendererWebGpuState({
    isWebGPURenderer: true,
    backend: { isWebGPUBackend: true }
  }), {
    isWebGpuRenderer: true,
    isNativeWebGpuBackend: true,
    isWebGlFallbackBackend: false
  });
});

test("airbrush backend falls back to WebGL unless native WebGPU is ready", () => {
  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: false,
    webGpuAvailable: true,
    renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }
  }), {
    backend: "webgl",
    webGpuStatus: "not-requested"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: false,
    renderer: { isWebGPURenderer: true, backend: { isWebGPUBackend: true } }
  }), {
    backend: "webgl",
    webGpuStatus: "unavailable"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    renderer: { isWebGLRenderer: true }
  }), {
    backend: "webgl",
    webGpuStatus: "needs-webgpu-renderer"
  });

  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: true,
    renderer: { isWebGPURenderer: true, backend: { isWebGLBackend: true } }
  }), {
    backend: "webgl",
    webGpuStatus: "renderer-webgl-fallback"
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
    backend: "webgl",
    webGpuStatus: "visible-surface-mask-required"
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

test("airbrush backend can fall through to CPU when WebGL is disabled", () => {
  assert.deepEqual(resolveTextureAirbrushBackend({
    preferWebGpu: true,
    webGpuAvailable: false,
    webGlDisabled: true
  }), {
    backend: "cpu",
    webGpuStatus: "unavailable"
  });
});

test("airbrush renderer mode stays WebGL unless native WebGPU renderer is ready", () => {
  function WebGPURenderer() {}

  assert.deepEqual(resolveTextureAirbrushRendererMode({
    preferWebGpuRenderer: false,
    webGpuAvailable: true,
    WebGPURenderer
  }), {
    renderer: "webgl",
    webGpuRendererStatus: "not-requested"
  });

  assert.deepEqual(resolveTextureAirbrushRendererMode({
    preferWebGpuRenderer: true,
    webGpuAvailable: false,
    WebGPURenderer
  }), {
    renderer: "webgl",
    webGpuRendererStatus: "unavailable"
  });

  assert.deepEqual(resolveTextureAirbrushRendererMode({
    preferWebGpuRenderer: true,
    webGpuAvailable: true,
    WebGPURenderer: null
  }), {
    renderer: "webgl",
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
    strokeSegments: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS + 5 }, () => ({}))
  });

  assert.equal(params.radiusPixels, 0.75);
  assert.equal(params.opacity, 1);
  assert.equal(params.hardness, 0);
  assert.equal(params.scatter, 1);
  assert.equal(params.strength, 2.5);
  assert.deepEqual(params.color, { r: 1, g: 0, b: 128 / 255 });
  assert.equal(params.strokeSegmentCount, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
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
  assert.match(source, /fn visibleMaskFeatherCoverage/);
  assert.match(source, /Hidden\/non-camera-facing texels are never painted/);
  assert.match(source, /if \(center <= threshold\)/);
  assert.match(source, /textureStore\(outputTexture, vec2<i32>\(pixel\), current\);\s+return;/);
  assert.match(source, /let strokeSource = textureLoad\(strokeSourceTexture/);
  assert.match(source, /coverage \* visibilityCoverage/);
  assert.match(source, /let nextAlpha = alpha \+ strokeSource\.a \* \(1\.0 - alpha\)/);
  assert.match(source, /strokeSource\.a < 0\.9999/);
  assert.match(source, /clamp\(alphaProgress, 0\.0, 1\.0\)/);
  assert.match(source, /clamp\(colorProgress, 0\.0, 1\.0\)/);
  assert.match(source, /currentProgress \+ 0\.0001 >= alpha/);
  assert.doesNotMatch(source, /proposedProgress/);
  assert.match(source, /textureStore/);
});

test("airbrush shared brush math drives JS and WebGPU kernel falloff", () => {
  const halo = airbrushHaloRadius(10, 0.5);
  assert.equal(halo, 10 * (1 + 0.5 * TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE));
  assert.equal(airbrushAlphaForDistance(halo + 0.01, 10, 0.8, 0.5, 0.4), 0);
  assert.equal(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD, 0.004);

  const source = textureAirbrushWebGpuKernelSource();
  assert.match(source, new RegExp(`scatter \\* ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE}`));
  assert.match(source, new RegExp(`${TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE} - hardness \\* ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE} \\+ scatter \\* ${TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE}`));
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

  assert.equal(data.byteLength, 80);
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
  assert.equal(view.getUint32(56, true), 256);
  assert.equal(view.getUint32(60, true), 128);
  assert.equal(view.getUint32(64, true), 0);
  assert.equal(view.getFloat32(68, true), 0);
  assert.equal(view.getFloat32(72, true), 0.5);
  assert.equal(view.getFloat32(76, true), 0);

  const masked = textureAirbrushWebGpuBrushUniformData({
    useVisibilityMask: 1,
    visibilityFeatherRadius: 4,
    visibilityMaskThreshold: 0.25
  }, 32, 16);
  const maskedView = new DataView(masked.buffer, masked.byteOffset, masked.byteLength);
  assert.equal(maskedView.getUint32(64, true), 1);
  assert.equal(maskedView.getFloat32(68, true), 4);
  assert.equal(maskedView.getFloat32(72, true), 0.25);

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

test("airbrush WebGPU stroke buffer packs segment endpoints", () => {
  const data = textureAirbrushWebGpuStrokeBufferData([
    { start: { x: 1, y: 2 }, end: { x: 3, y: 4 } },
    { start: { clientX: 5, clientY: 6 }, end: { clientX: 7, clientY: 8 } }
  ], { maxStrokeSegments: 3 });

  assert.deepEqual([...data], [
    1, 2, 3, 4,
    5, 6, 7, 8,
    0, 0, 0, 0
  ]);
});

test("airbrush WebGPU paint plan prepares descriptors for dispatch", () => {
  const scope = {
    GPUTextureUsage: {
      COPY_SRC: 1,
      COPY_DST: 2,
      TEXTURE_BINDING: 4,
      STORAGE_BINDING: 8
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

  assert.deepEqual(plan.paintBounds, { x: 0, y: 0, width: 17, height: 19 });
  assert.deepEqual(plan.dispatch, { x: 3, y: 3, workgroupSize: 8 });
  assert.equal(plan.textures.source.usage, 6);
  assert.equal(plan.textures.output.usage, 11);
  assert.equal(plan.buffers.uniform.usage, 72);
  assert.equal(plan.buffers.strokes.usage, 136);
  assert.equal(plan.buffers.readback.usage, 9);
  assert.equal(plan.buffers.readback.layout.bytesPerRow, 256);
  assert.equal(plan.buffers.readback.size, 256 * 19);
  assert.equal(plan.buffers.readback.layout.width, 17);
  assert.equal(plan.buffers.readback.layout.height, 19);
  assert.equal(plan.buffers.uniform.data.byteLength, 80);
  assert.equal(plan.buffers.strokes.data.length, 16);
  assert.equal(plan.bindGroupLayoutEntries.length, 6);
  assert.deepEqual(textureAirbrushWebGpuUsageConstants(scope).shaderStage, { compute: 4 });
  assert.deepEqual(textureAirbrushWebGpuBindGroupLayoutEntries(scope).map((entry) => entry.binding), [0, 1, 2, 3, 4, 5]);
  assert.equal(textureAirbrushWebGpuTextureDescriptors(4, 5, scope).strokeSource.usage, 6);
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

test("airbrush WebGPU device detection requires a native WebGPU renderer backend", () => {
  const device = fakeWebGpuDevice();

  assert.equal(textureAirbrushWebGpuDeviceFromRenderer(null), null);
  assert.equal(textureAirbrushWebGpuDeviceFromRenderer({
    isWebGLRenderer: true,
    backend: { device }
  }), null);
  assert.equal(textureAirbrushWebGpuDeviceFromRenderer({
    isWebGPURenderer: true,
    backend: { isWebGPUBackend: true, isWebGLBackend: true, device }
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
  assert.equal(run.result.dispatch.y, 5);
  assert.equal(run.result.outputTexture, run.resources.outputTexture);
  assert.ok(device.calls.some((call) => call[0] === "createShaderModule" && call[2] === true));
  assert.ok(device.calls.some((call) => call[0] === "createComputePipeline" && call[1] === "textureAirbrushPaint"));
  assert.ok(device.calls.some((call) => call[0] === "writeBuffer" && call[4] === 80));
  assert.ok(device.calls.some((call) => call[0] === "writeTexture" && call[3] === payload.plan.width * 4));
  assert.ok(device.calls.some((call) => call[0] === "createBindGroup" && call[1] === "0,1,2,3,4,5"));
  assert.ok(device.calls.some((call) => call[0] === "dispatchWorkgroups" && call[1] === 3 && call[2] === 5 && call[3] === 1));
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
  assert.ok(run.resources.visibilityMaskTexture);
  assert.ok(device.calls.some((call) => call[0] === "createTexture" && call[1] === "test-airbrush-mask-visibility-mask-texture"));
  assert.ok(device.calls.some((call) => call[0] === "writeTexture" && call[6] === "test-airbrush-mask-visibility-mask-texture"));
  assert.ok(device.calls.some((call) => call[0] === "createBindGroup" && call[1] === "0,1,2,3,4,5"));
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
