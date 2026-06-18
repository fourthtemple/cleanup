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
} from "../src/weight-editor/airbrush/webgpu.js";
import {
  textureAirbrushApplyPixelsToEditable,
  textureAirbrushEditableWebGpuPayload,
  textureAirbrushPrewarmEditableWebGpuPaint,
  textureAirbrushSourcePixelsFromEditable
} from "../src/weight-editor/airbrush/webgpu-canvas.js";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../src/weight-editor/airbrush/constants.js";
import {
  textureAirbrushReadWebGpuPaintResult,
  textureAirbrushRunWebGpuPaint,
  textureAirbrushWebGpuDeviceFromRenderer
} from "../src/weight-editor/airbrush/webgpu-dispatch.js";
import {
  textureAirbrushUnpackWebGpuReadbackRows
} from "../src/weight-editor/airbrush/webgpu-readback.js";
import {
  TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD,
  TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE,
  TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE,
  airbrushAlphaForDistance,
  airbrushHaloRadius
} from "../src/weight-editor/airbrush/math.js";
import {
  textureAirbrushWebGpuDispatchSize,
  textureAirbrushWebGpuKernelParams,
  textureAirbrushWebGpuKernelSource
} from "../src/weight-editor/airbrush/webgpu-kernel.js";
import {
  TEXTURE_AIRBRUSH_WEBGPU_PROJECTION_DEPTH_WINDOW,
  textureAirbrushWebGpuProbePointsFromStroke,
  textureAirbrushWebGpuScreenStrokeFromEvent
} from "../src/weight-editor/airbrush/webgpu-projection.js";
import {
  textureAirbrushFrontIntersections
} from "../src/weight-editor/airbrush/projection.js";
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
} from "../src/weight-editor/airbrush/webgpu-plan.js";
import {
  textureAirbrushWebGpuStrokeCandidateFromHit,
  textureAirbrushWebGpuStrokeEstimate,
  textureAirbrushWebGpuTextureRadiusPixels
} from "../src/weight-editor/airbrush/webgpu-stroke.js";

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
      calls.push(["writeTexture", destination.texture.id, data.byteLength, layout.bytesPerRow, size.width, size.height]);
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

test("airbrush WebGPU query flag is opt-in", () => {
  assert.equal(textureAirbrushWebGpuRequestedFromSearch(""), false);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=0"), false);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?webgpu-airbrush=1"), true);
  assert.equal(textureAirbrushWebGpuRequestedFromSearch("?airbrush-webgpu=true"), true);
});

test("airbrush WebGPU renderer query flag is opt-in", () => {
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch(""), false);
  assert.equal(textureAirbrushWebGpuRendererRequestedFromSearch("?webgpu-renderer=0"), false);
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

  assert.equal(data.byteLength, 64);
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
  assert.equal(plan.buffers.uniform.data.byteLength, 64);
  assert.equal(plan.buffers.strokes.data.length, 16);
  assert.equal(plan.bindGroupLayoutEntries.length, 4);
  assert.deepEqual(textureAirbrushWebGpuUsageConstants(scope).shaderStage, { compute: 4 });
  assert.deepEqual(textureAirbrushWebGpuBindGroupLayoutEntries(scope).map((entry) => entry.binding), [0, 1, 2, 3]);
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
  assert.ok(device.calls.some((call) => call[0] === "writeBuffer" && call[4] === 64));
  assert.ok(device.calls.some((call) => call[0] === "writeTexture" && call[3] === payload.plan.width * 4));
  assert.ok(device.calls.some((call) => call[0] === "dispatchWorkgroups" && call[1] === 3 && call[2] === 5 && call[3] === 1));
  assert.deepEqual(device.calls.at(-1), ["submit", 1]);
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

test("installed airbrush WebGPU methods resolve the current backend", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = { isWebGLRenderer: true };
  editor.textureAirbrushForceWebGpu = true;

  const resolved = editor.textureAirbrushResolveBackend();

  assert.equal(resolved.backend, "webgl");
  assert.match(resolved.webGpuStatus, /unavailable|needs-webgpu-renderer/);
});

test("installed airbrush WebGPU methods resolve the renderer mode", () => {
  class TestEditor {}
  function WebGPURenderer() {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.textureAirbrushForceWebGpuRenderer = true;

  const resolved = editor.textureAirbrushResolveRendererMode({ WebGPURenderer });

  assert.match(resolved.renderer, /webgl|webgpu/);
  assert.match(resolved.webGpuRendererStatus, /unavailable|ready/);
});

test("WebGPU prewarm skips editable texture materialization when backend is not ready", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { map: {} };
  let editableRequests = 0;
  editor.textureAirbrushResolveBackend = () => ({
    backend: "webgl",
    webGpuStatus: "not-requested"
  });
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => {
    editableRequests += 1;
    return {
      canvas: {},
      context: {},
      texture: {}
    };
  };
  editor.textureAirbrushPaintableMaterials = () => [{
    record: {},
    materialIndex: 0,
    material
  }];
  editor.textureAirbrushRecords = () => [{
    object: { material }
  }];

  assert.equal(editor.textureAirbrushPrewarmWebGpuFromHit({ record: {}, hit: {} }), false);
  assert.equal(editor.textureAirbrushPrewarmFirstWebGpuPaintable(), false);
  assert.equal(editor.textureAirbrushPrewarmAllWebGpuPaintables(), false);
  assert.equal(editableRequests, 0);
});

test("installed airbrush WebGPU methods expose a runtime diagnostic snapshot", () => {
  class TestEditor {}
  function WebGPURenderer() {}
  const device = fakeWebGpuDevice();
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureAirbrushRendererMode = "webgpu";
  editor.textureAirbrushLastWebGpuPaintStats = { appliedBytes: 16 };
  editor.textureAirbrushLastWebGpuDispatch = {
    result: {
      commandBuffer: {},
      dispatch: { x: 2, y: 3, workgroupSize: 8 },
      readbackBuffer: {}
    }
  };

  const status = editor.textureAirbrushWebGpuRuntimeStatus({
    webgpu: true,
    webgpuRenderer: true,
    WebGPURenderer,
    scope: { navigator: { gpu: {} } }
  });

  assert.deepEqual(status.requested, { renderer: true, airbrush: true });
  assert.equal(status.nativeWebGpuAvailable, true);
  assert.equal(status.rendererMode.renderer, "webgpu");
  assert.equal(status.rendererState.isNativeWebGpuBackend, true);
  assert.equal(status.rendererRuntime, "webgpu");
  assert.equal(status.rendererReady, true);
  assert.deepEqual(status.backend, { backend: "webgpu", webGpuStatus: "ready" });
  assert.equal(status.deviceReady, true);
  assert.equal(status.airbrushReady, true);
  assert.deepEqual(status.lastPaintStats, { appliedBytes: 16 });
  assert.deepEqual(status.lastDispatch, {
    dispatch: { x: 2, y: 3, workgroupSize: 8 },
    hasCommandBuffer: true,
    hasReadback: true
  });
  assert.equal(editor.textureAirbrushLastRuntimeStatus, status);
});

test("airbrush WebGPU runtime status keeps the renderer mode chosen at startup", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.textureAirbrushLastRendererMode = {
    renderer: "webgpu",
    webGpuRendererStatus: "ready"
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device: fakeWebGpuDevice()
    }
  };

  const status = editor.textureAirbrushWebGpuRuntimeStatus({
    webgpu: true,
    webgpuRenderer: true,
    scope: { navigator: { gpu: {} } }
  });

  assert.deepEqual(status.rendererMode, {
    renderer: "webgpu",
    webGpuRendererStatus: "ready"
  });
});

test("installed airbrush WebGPU methods run a compute self-test through readback", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 4);
  mapped.set([255, 0, 0, 255], 0);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 1;
  editor.textureAirbrushHardness = () => 1;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const result = await editor.textureAirbrushRunWebGpuSelfTest({
    width: 4,
    height: 4,
    mapRead: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.width, 4);
  assert.equal(result.height, 4);
  assert.deepEqual(result.dispatch, { x: 1, y: 1, workgroupSize: 8 });
  assert.equal(result.readbackBytes, 64);
  assert.equal(result.paintedPixels, 1);
  assert.equal(result.maxChannel, 255);
  assert.equal(editor.textureAirbrushLastWebGpuSelfTest, result);
  assert.ok(device.calls.some((call) => call[0] === "createComputePipeline"));
  assert.ok(device.calls.some((call) => call[0] === "copyTextureToBuffer"));
});

test("installed airbrush WebGPU methods prepare a kernel payload", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 64, g: 128, b: 255 });

  const payload = editor.textureAirbrushWebGpuKernelPayload({
    strokeSegments: [{}, {}]
  });

  assert.equal(payload.params.radiusPixels, 32);
  assert.equal(payload.params.opacity, 0.5);
  assert.equal(payload.params.hardness, 0.4);
  assert.equal(payload.params.scatter, 0.3);
  assert.equal(payload.params.strokeSegmentCount, 2);
  assert.deepEqual(payload.params.color, { r: 64 / 255, g: 128 / 255, b: 1 });
  assert.match(payload.source, /textureAirbrushPaint/);
  assert.equal(payload.plan.buffers.uniform.data.byteLength, 64);
  assert.equal(payload.plan.buffers.strokes.data.length, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS * 4);

  editor.textureAirbrushWebGpuProjectFromEvent(null, { radiusPixels: 12 });
  assert.equal(editor.textureAirbrushLastWebGpuKernel.params.radiusPixels, 12);
});

test("installed airbrush WebGPU methods dispatch when source pixels and native device are available", () => {
  class TestEditor {}
  const device = fakeWebGpuDevice();
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.canvas = { width: 8, height: 8 };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  const changed = editor.textureAirbrushWebGpuProjectFromEvent(null, {
    sourcePixels: new Uint8Array(8 * 8 * 4),
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 7, y: 7 } }]
  });

  assert.equal(changed, 8);
  assert.ok(editor.textureAirbrushLastWebGpuDispatch?.result);
  assert.match(editor.lastStatus, /WebGPU airbrush dispatched/);
  assert.ok(device.calls.some((call) => call[0] === "dispatchWorkgroups"));
});

test("installed airbrush WebGPU project path sizes editable payloads to texture canvas", () => {
  class TestEditor {}
  const device = fakeWebGpuDevice();
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.canvas = { width: 99, height: 77 };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable } = fakeEditableTexture(3, 2, new Uint8Array(3 * 2 * 4));

  const changed = editor.textureAirbrushWebGpuProjectFromEvent(null, {
    editable,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 2, y: 1 } }]
  });

  assert.equal(changed, 3);
  assert.equal(editor.textureAirbrushLastWebGpuKernel.plan.width, 3);
  assert.equal(editor.textureAirbrushLastWebGpuKernel.plan.height, 2);
  assert.ok(device.calls.some((call) => call[0] === "writeTexture" && call[2] === 3 * 2 * 4 && call[3] === 3 * 4));
});

test("installed airbrush WebGPU live path queues editable texture paint from a hit", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    21, 22, 23, 255,
    31, 32, 33, 255
  ], 0);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live" };
  const record = { id: "record-live" };
  const hit = {
    uv: { x: 1, y: 0 },
    face: { materialIndex: 0 }
  };
  const { editable, state } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.model = {};
  editor.textureBrushRadiusValue = () => 0.1;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.texturePaintHitForEvent = () => ({ record, hit });
  editor.clonePaintMaterialForHit = (candidateRecord) => candidateRecord === record ? material : null;
  editor.editableClonePaintTexture = (candidateMaterial) => candidateMaterial === material ? editable : null;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mappedUv, canvas) => ({
    x: Math.round(mappedUv.x * (canvas.width - 1)),
    y: Math.round(mappedUv.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas, texture, options) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas, texture, options)
  );
  editor.captureTexturePaintCanvasUndoTarget = () => {
    editor.capturedUndo = true;
  };
  editor.markTexturePaintStrokeChanged = () => {
    editor.markedChanged = true;
  };
  editor.refreshCloneSpotlightTextures = () => {
    editor.refreshedTextures = true;
  };
  editor.updateClonePaintPreviews = () => {
    editor.updatedPreviews = true;
  };

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 10,
    clientY: 10
  }, {
    mapRead: 1
  });
  await editor.flushTextureAirbrushPendingWebGpuPaints();

  assert.ok(estimate > 0);
  assert.equal(editor.capturedUndo, true);
  assert.equal(editor.markedChanged, true);
  assert.deepEqual([...state.imageData.data], [
    21, 22, 23, 255,
    31, 32, 33, 255
  ]);
  assert.equal(editable.texture.needsUpdate, true);
  assert.equal(material.needsUpdate, true);
  assert.equal(editor.refreshedTextures, true);
  assert.equal(editor.updatedPreviews, true);
});

test("installed airbrush WebGPU live path batches compatible queued strokes", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    41, 42, 43, 255,
    51, 52, 53, 255,
    61, 62, 63, 255
  ], 0);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-batch" };
  const record = { id: "record-batch" };
  const { editable, state } = fakeEditableTexture(3, 1, new Uint8Array(3 * 1 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.model = {};
  editor.textureBrushRadiusValue = () => 0.1;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.texturePaintHitForEvent = (event) => ({
    record,
    hit: {
      uv: { x: event.clientX / 20, y: 0 },
      face: { materialIndex: 0 }
    }
  });
  editor.clonePaintMaterialForHit = (candidateRecord) => candidateRecord === record ? material : null;
  editor.editableClonePaintTexture = (candidateMaterial) => candidateMaterial === material ? editable : null;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mappedUv, canvas) => ({
    x: Math.round(mappedUv.x * (canvas.width - 1)),
    y: Math.round(mappedUv.y * (canvas.height - 1))
  });
  editor.clonePaintPixelFromUv = (uv, canvas, texture, options) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas, texture, options)
  );
  let undoCaptureCount = 0;
  editor.captureTexturePaintCanvasUndoTarget = () => {
    undoCaptureCount += 1;
  };

  const first = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 0, clientY: 0 }, { mapRead: 1 });
  const second = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 20, clientY: 0 }, {
    mapRead: 1,
    strokeStart: { clientX: 0, clientY: 0 }
  });

  assert.ok(first > 0);
  assert.ok(second > 0);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "dispatchWorkgroups").length, 0);

  await editor.flushTextureAirbrushPendingWebGpuPaints();

  assert.equal(undoCaptureCount, 1);
  assert.equal(device.calls.filter((call) => call[0] === "dispatchWorkgroups").length, 1);
  assert.deepEqual([...state.imageData.data], [
    41, 42, 43, 255,
    51, 52, 53, 255,
    61, 62, 63, 255
  ]);
});

test("installed airbrush WebGPU live path coalesces queued strokes while a flush is in flight", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-in-flight" };
  const record = { id: "record-in-flight" };
  const editable = {
    texture: { uuid: "texture-in-flight" },
    canvas: { width: 8, height: 8 }
  };
  const segment = { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 1,
    strokeSegments: [segment],
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [segment]
    },
    estimate: 1
  };
  let undoCaptureCount = 0;
  let resolveFirstFlush;
  let scheduledCallback = null;
  const originalSetTimeout = globalThis.setTimeout;
  const started = [];
  editor.captureTexturePaintCanvasUndoTarget = () => {
    undoCaptureCount += 1;
  };
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch) => {
    started.push(batch);
    if (started.length === 1) {
      return new Promise((resolve) => {
        resolveFirstFlush = resolve;
      });
    }
    return Promise.resolve(batch);
  };
  globalThis.setTimeout = (callback) => {
    scheduledCallback = callback;
    return 1;
  };
  try {
    editor.textureAirbrushQueuedWebGpuStrokes = [{
      ...candidate,
      undoCaptured: true,
      styleKey: "first"
    }];
    const firstFlush = editor.flushTextureAirbrushQueuedWebGpuStrokes();
    await Promise.resolve();
    assert.equal(started.length, 1);

    editor.textureAirbrushQueueWebGpuStrokeCandidate({
      ...candidate,
      strokeSegments: [{ start: { x: 2, y: 0 }, end: { x: 3, y: 0 } }],
      options: {
        ...candidate.options,
        strokeSegments: [{ start: { x: 2, y: 0 }, end: { x: 3, y: 0 } }]
      }
    });

    assert.equal(started.length, 1);
    assert.equal(undoCaptureCount, 1);
    assert.equal(editor.textureAirbrushWebGpuFlushScheduled, true);
    assert.equal(scheduledCallback, null);

    resolveFirstFlush(null);
    await firstFlush;
    await Promise.resolve();

    assert.equal(typeof scheduledCallback, "function");
    scheduledCallback();
    await editor.flushTextureAirbrushPendingWebGpuPaints();

    assert.equal(started.length, 2);
    assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 0);
    assert.equal(editor.textureAirbrushWebGpuFlushInFlight, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("installed airbrush WebGPU live path splits batches at shader segment capacity", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-capacity" };
  const record = { id: "record-capacity" };
  const editable = {
    texture: { uuid: "texture-capacity" },
    canvas: { width: 8, height: 8 }
  };
  let undoCaptureCount = 0;
  editor.captureTexturePaintCanvasUndoTarget = () => {
    undoCaptureCount += 1;
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  const strokeSegments = Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS + 2 }, (_, index) => ({
    start: { x: index, y: 0 },
    end: { x: index + 0.5, y: 0 }
  }));

  const estimate = editor.textureAirbrushQueueWebGpuStrokeCandidate({
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments
    },
    estimate: 1
  });

  assert.ok(estimate > 0);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 2);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].strokeSegments.length, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[1].strokeSegments.length, 2);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].options.strokeSegments.length, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[1].options.strokeSegments.length, 2);
  assert.equal(undoCaptureCount, 1);
});

test("installed airbrush WebGPU live path captures undo separately for distinct editable canvases", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-distinct-editable" };
  const record = { id: "record-distinct-editable" };
  const firstEditable = {
    canvas: { width: 8, height: 8 }
  };
  const secondEditable = {
    canvas: { width: 8, height: 8 }
  };
  let undoCaptureCount = 0;
  editor.captureTexturePaintCanvasUndoTarget = () => {
    undoCaptureCount += 1;
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  const candidateBase = {
    record,
    material,
    materialIndex: 0,
    radiusPixels: 1,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    },
    estimate: 1
  };

  editor.textureAirbrushQueueWebGpuStrokeCandidate({
    ...candidateBase,
    editable: firstEditable
  });
  editor.textureAirbrushQueueWebGpuStrokeCandidate({
    ...candidateBase,
    editable: secondEditable
  });

  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 2);
  assert.equal(undoCaptureCount, 2);
});

test("installed airbrush WebGPU live path queues projected brush footprint probes", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-projected" };
  const record = { id: "record-projected", object: {} };
  const { editable } = fakeEditableTexture(9, 1, new Uint8Array(9 * 1 * 4));
  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: 100,
        height: 100
      };
    }
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureBrushRadiusValue = () => 0.1;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      object: record.object,
      distance: 1,
      uv: { x: 0.5, y: 0 },
      face: { materialIndex: 0 }
    }
  });
  editor.clonePaintMaterialForHit = (candidateRecord) => candidateRecord === record ? material : null;
  editor.editableClonePaintTexture = (candidateMaterial) => candidateMaterial === material ? editable : null;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mappedUv, canvas) => ({
    x: Math.max(0, Math.min(canvas.width - 1, Math.round(mappedUv.x * (canvas.width - 1)))),
    y: 0
  });
  editor.clonePaintPixelFromUv = (uv, canvas, texture, options) => (
    editor.clonePaintPixelFromMappedTextureUv(editor.clonePaintTextureUv(uv), canvas, texture, options)
  );
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => false;
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      const u = Math.max(0, Math.min(1, (editor.pointer.x + 1) * 0.5));
      return [{
        object: record.object,
        distance: 1,
        uv: { x: u, y: 0 },
        face: { materialIndex: 0 }
      }];
    }
  };

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 50,
    clientY: 50
  }, {
    radiusPixels: 24
  });

  assert.ok(estimate > 0);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  assert.ok(editor.textureAirbrushQueuedWebGpuStrokes[0].strokeSegments.length > 1);
});

test("installed airbrush WebGPU methods can paint an editable canvas through readback", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(512);
  mapped.set([
    100, 101, 102, 255,
    110, 111, 112, 255
  ], 0);
  mapped.set([
    120, 121, 122, 255,
    130, 131, 132, 255
  ], 256);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable, state } = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  const material = {};
  let clock = 0;

  const run = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    mapRead: 1,
    now: () => {
      clock += 5;
      return clock;
    },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  assert.ok(run?.result);
  assert.equal(run.applied.byteLength, 16);
  assert.deepEqual(run.stats.dirtyBounds, { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(run.stats.sourceUploaded, true);
  assert.equal(run.stats.sourceBytes, 16);
  assert.equal(run.stats.readbackBytes, 16);
  assert.equal(run.stats.appliedBytes, 16);
  assert.equal(run.stats.reusedResources, false);
  assert.equal(run.stats.reusedReadbackBuffer, false);
  assert.equal(run.stats.reusedApplyImageData, false);
  assert.deepEqual(run.stats.timings, {
    prepareMs: 5,
    dispatchMs: 5,
    readbackMs: 5,
    applyMs: 5,
    totalMs: 30
  });
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats, run.stats);
  assert.equal(editor.textureAirbrushWebGpuPaintStats.length, 1);
  assert.deepEqual([...state.imageData.data], [
    100, 101, 102, 255,
    110, 111, 112, 255,
    120, 121, 122, 255,
    130, 131, 132, 255
  ]);
  assert.equal(editable.texture.needsUpdate, true);
  assert.equal(material.needsUpdate, true);
  assert.ok(device.calls.some((call) => call[0] === "copyTextureToBuffer"));
  assert.ok(device.calls.some((call) => call[0] === "mapAsync" && call[2] === 1));
});

test("editable WebGPU prewarm uploads source before the first drawing stroke", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    150, 151, 152, 255,
    160, 161, 162, 255
  ], 0);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable, state } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  let clock = 0;
  const now = () => {
    clock += 1;
    return clock;
  };

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, { now });
  const firstRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    mapRead: 1,
    now,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
  });

  assert.ok(prewarm?.resources);
  assert.equal(prewarm.stats.sourceBytes, 8);
  assert.equal(prewarm.stats.reusedResources, false);
  assert.equal(editor.textureAirbrushLastWebGpuPrewarmStats, prewarm.stats);
  assert.equal(firstRun.stats.sourceUploaded, false);
  assert.equal(firstRun.stats.sourceBytes, 0);
  assert.equal(firstRun.stats.reusedResources, true);
  assert.equal(state.getCalls, 1);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToBuffer").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToTexture").length, 1);
});

test("editable WebGPU paint reuses cached textures after the first source upload", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    150, 151, 152, 255,
    160, 161, 162, 255
  ], 0);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable, state } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const paintOptions = {
    mapRead: 1,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
  };
  let clock = 0;
  const timedPaintOptions = {
    ...paintOptions,
    now: () => {
      clock += 1;
      return clock;
    }
  };

  const firstRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, timedPaintOptions);
  const secondRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, timedPaintOptions);

  assert.equal(firstRun.stats.sourceUploaded, true);
  assert.equal(firstRun.stats.reusedResources, false);
  assert.equal(firstRun.stats.reusedReadbackBuffer, false);
  assert.equal(firstRun.stats.reusedApplyImageData, false);
  assert.equal(secondRun.stats.sourceUploaded, false);
  assert.equal(secondRun.stats.reusedResources, true);
  assert.equal(secondRun.stats.reusedReadbackBuffer, true);
  assert.equal(secondRun.stats.reusedApplyImageData, true);
  assert.equal(secondRun.stats.sourceBytes, 0);
  assert.equal(state.getCalls, 1);
  assert.equal(state.createCalls, 0);
  assert.equal(device.calls.filter((call) => call[0] === "createShaderModule").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "createComputePipeline").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "createTexture" && /source-texture|output-texture/.test(call[1])).length, 2);
  assert.equal(device.calls.filter((call) => call[0] === "createBuffer" && /readback-buffer/.test(call[1])).length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToTexture").length, 2);

  assert.equal(editor.textureAirbrushInvalidateWebGpuCache(editable), true);
  const thirdRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, timedPaintOptions);
  assert.equal(thirdRun.stats.sourceUploaded, true);
  assert.equal(thirdRun.stats.reusedResources, false);
  assert.equal(thirdRun.stats.reusedReadbackBuffer, false);
  assert.equal(thirdRun.stats.reusedApplyImageData, false);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats, thirdRun.stats);
  assert.equal(editor.textureAirbrushWebGpuPaintStats.length, 3);
  assert.equal(state.getCalls, 2);
  assert.equal(device.calls.filter((call) => call[0] === "createBuffer" && /readback-buffer/.test(call[1])).length, 2);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 2);
});
