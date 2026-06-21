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
  assert.equal(run.stats.strokeSourceUploaded, true);
  assert.equal(run.stats.sourceBytes, 16);
  assert.equal(run.stats.strokeSourceBytes, 16);
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
  assert.equal(firstRun.stats.strokeSourceUploaded, false);
  assert.equal(firstRun.stats.sourceBytes, 0);
  assert.equal(firstRun.stats.reusedResources, true);
  assert.equal(state.getCalls, 1);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 2);
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
  assert.equal(firstRun.stats.strokeSourceUploaded, true);
  assert.equal(firstRun.stats.reusedResources, false);
  assert.equal(firstRun.stats.reusedReadbackBuffer, false);
  assert.equal(firstRun.stats.reusedApplyImageData, false);
  assert.equal(secondRun.stats.sourceUploaded, false);
  assert.equal(secondRun.stats.strokeSourceUploaded, false);
  assert.equal(secondRun.stats.reusedResources, true);
  assert.equal(secondRun.stats.reusedReadbackBuffer, true);
  assert.equal(secondRun.stats.reusedApplyImageData, true);
  assert.equal(secondRun.stats.sourceBytes, 0);
  assert.equal(state.getCalls, 1);
  assert.equal(state.createCalls, 0);
  assert.equal(device.calls.filter((call) => call[0] === "createShaderModule").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "createComputePipeline").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "createTexture" && /source-texture|output-texture/.test(call[1])).length, 3);
  assert.equal(device.calls.filter((call) => call[0] === "createBuffer" && /readback-buffer/.test(call[1])).length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 2);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToTexture").length, 2);

  assert.equal(editor.textureAirbrushInvalidateWebGpuCache(editable), true);
  const thirdRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, timedPaintOptions);
  assert.equal(thirdRun.stats.sourceUploaded, true);
  assert.equal(thirdRun.stats.strokeSourceUploaded, true);
  assert.equal(thirdRun.stats.reusedResources, false);
  assert.equal(thirdRun.stats.reusedReadbackBuffer, false);
  assert.equal(thirdRun.stats.reusedApplyImageData, false);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats, thirdRun.stats);
  assert.equal(editor.textureAirbrushWebGpuPaintStats.length, 3);
  assert.equal(state.getCalls, 2);
  assert.equal(device.calls.filter((call) => call[0] === "createBuffer" && /readback-buffer/.test(call[1])).length, 2);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 4);
});

test("editable WebGPU paint reuses the same stroke source across live stroke chunks", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    90, 91, 92, 128,
    100, 101, 102, 128
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
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const strokeSourceImageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      10, 20, 30, 64,
      40, 50, 60, 64
    ])
  };
  const paintOptions = {
    mapRead: 1,
    strokeSourceImageData,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
  };

  const firstRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const secondRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const writes = device.calls.filter((call) => call[0] === "writeTexture");

  assert.equal(firstRun.stats.sourceUploaded, true);
  assert.equal(firstRun.stats.strokeSourceUploaded, true);
  assert.equal(firstRun.stats.strokeSourceBytes, 8);
  assert.equal(secondRun.stats.sourceUploaded, false);
  assert.equal(secondRun.stats.strokeSourceUploaded, false);
  assert.equal(writes.filter((call) => call[6] === "texture-airbrush-editable-source-texture").length, 1);
  assert.equal(writes.filter((call) => call[6] === "texture-airbrush-editable-stroke-source-texture").length, 1);
});
