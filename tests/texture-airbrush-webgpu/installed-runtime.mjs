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
  assert.deepEqual(status.liveProjectedBackend, { backend: "none", webGpuStatus: "visible-surface-mask-unavailable" });
  assert.equal(status.deviceReady, true);
  assert.equal(status.airbrushReady, true);
  assert.equal(status.liveProjectedAirbrushReady, false);
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
  assert.match(payload.source, /visibilityMaskTexture/);
  assert.equal(payload.plan.buffers.uniform.data.byteLength, 80);
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
  const strokeSourceImageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      10, 20, 30, 0,
      40, 50, 60, 0
    ])
  };
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
  editor.texturePaintCanvasStrokeSourceImage = () => strokeSourceImageData;
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
  assert.equal(
    device.calls.filter((call) => call[0] === "writeTexture" && call[6] === "texture-airbrush-editable-stroke-source-texture").length,
    1
  );
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
