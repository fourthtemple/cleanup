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
  textureAirbrushCachedWebGpuStrokeSourceImage,
  textureAirbrushEditableWebGpuPayload,
  textureAirbrushEditableWebGpuStrokeSourceCurrent,
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
import { installPaintToolMethods } from "../../src/weight-editor/paint-tools.js";

function fakeWebGpuDevice({ readbackMappedData = null, externalImageUpload = false } = {}) {
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
    ...(externalImageUpload ? {
      copyExternalImageToTexture(source, destination, size) {
        calls.push([
          "copyExternalImageToTexture",
          source.source?.width || 0,
          source.source?.height || 0,
          destination.texture.id,
          size.width,
          size.height,
          destination.texture.desc?.label || ""
        ]);
      }
    } : {}),
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

function paintEncoderSlices(calls, label = /^texture-airbrush-editable(?:-live)?-command-encoder$/) {
  const slices = [];
  const matchesLabel = (value) => (
    label instanceof RegExp ? label.test(String(value || "")) : value === label
  );
  for (let index = 0; index < calls.length; index += 1) {
    if (calls[index]?.[0] !== "createCommandEncoder" || !matchesLabel(calls[index]?.[1])) {
      continue;
    }
    const end = calls.findIndex((call, callIndex) => (
      callIndex > index && call?.[0] === "finishCommandEncoder"
    ));
    slices.push(calls.slice(index, end >= 0 ? end + 1 : calls.length));
  }
  return slices;
}

function hasSourceToStrokeCopyBeforeCompute(slice = [], sourceTextureId = null, strokeSourceTextureId = null) {
  const computeIndex = slice.findIndex((call) => call?.[0] === "beginComputePass");
  if (computeIndex < 0) {
    return false;
  }
  return slice.slice(0, computeIndex).some((call) => (
    call?.[0] === "copyTextureToTexture"
    && call[1] === sourceTextureId
    && call[2] === strokeSourceTextureId
  ));
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
  assert.equal(undoCaptureCount, 0);
});

test("installed airbrush WebGPU live path queues distinct editable canvases without hot-path undo capture", () => {
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
  assert.equal(undoCaptureCount, 0);
});

test("installed airbrush WebGPU live path does not share queued undo capture across strokes", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-distinct-stroke-undo" };
  const record = { id: "record-distinct-stroke-undo" };
  const texture = { uuid: "texture-distinct-stroke-undo" };
  const editable = {
    canvas: { width: 8, height: 8 },
    texture
  };
  const firstStroke = { touched: new Map(), before: [] };
  const secondStroke = { touched: new Map(), before: [] };
  editor.texturePaintActiveStrokeUndo = function texturePaintActiveStrokeUndo() {
    return this.texturePaintStrokeUndoContext || this.texturePaintStrokeUndo || null;
  };
  const strokeSegments = [{ start: { x: 1, y: 1 }, end: { x: 2, y: 2 } }];
  const candidateBase = {
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
  };

  editor.texturePaintStrokeUndoContext = firstStroke;
  editor.textureAirbrushQueueWebGpuStrokeCandidate(candidateBase, { scheduleFlush: false });
  editor.texturePaintStrokeUndoContext = secondStroke;
  editor.textureAirbrushQueueWebGpuStrokeCandidate(candidateBase, { scheduleFlush: false });

  const batches = editor.textureAirbrushQueuedWebGpuStrokes || [];
  assert.equal(batches.length, 2);
  assert.equal(batches[0].strokeUndo, firstStroke);
  assert.equal(batches[1].strokeUndo, secondStroke);
  assert.equal(batches[0].undoCaptured, false);
  assert.equal(batches[1].undoCaptured, false);
  assert.equal(firstStroke.textureAirbrushWebGpuUndoKeys.has(texture), true);
  assert.equal(secondStroke.textureAirbrushWebGpuUndoKeys.has(texture), true);
});

test("installed airbrush WebGPU live path queues direct triangle masks before GPU paint", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-projected" };
  const record = {
    id: "record-projected",
    object: {},
    geometry: {
      attributes: {
        uv: {
          count: 3,
          getX(index) {
            return [0, 1, 0][index];
          },
          getY(index) {
            return [0, 0, 1][index];
          }
        }
      }
    }
  };
  const { editable } = fakeEditableTexture(9, 9, new Uint8Array(9 * 9 * 4));
  editor.model = {
    updateMatrixWorld() {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true
    }
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
      uv: { x: 0.5, y: 0.25 },
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
      faceIndex: 0
    }
  });
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
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => false;
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      raycastCount += 1;
      return [{
        object: record.object,
        distance: 1,
        uv: { x: 0.5, y: 0.25 },
        face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
        faceIndex: 0
      }];
    }
  };

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 50,
    clientY: 50
  }, {
    radiusPixels: 24,
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.ok(estimate > 0);
  assert.equal(raycastCount, 0);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  const queuedStroke = editor.textureAirbrushQueuedWebGpuStrokes[0];
  assert.ok(queuedStroke.strokeSegments.length >= 1);
  assert.equal(queuedStroke.options.fullProjectedSurfaceRenderTriangles, true);
  assert.equal((queuedStroke.options.visibilityMaskTriangles || []).length, 0);
  assert.equal(queuedStroke.options.visibilityMaskPixels, null);
});

test("installed airbrush WebGPU camera-facing triangle mask preserves observable coverage", () => {
  const material = { uuid: "material-grazing-triangle" };
  const record = {
    id: "record-grazing-triangle",
    object: {},
    geometry: {
      attributes: {
        uv: {
          count: 3,
          getX(index) {
            return [0, 1, 0][index];
          },
          getY(index) {
            return [0, 0, 1][index];
          }
        }
      }
    }
  };
  const { editable } = fakeEditableTexture(16, 16, new Uint8Array(16 * 16 * 4));
  const editor = {
    camera: {},
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 24,
    textureAirbrushOpacity: () => 0.9,
    textureAirbrushHardness: () => 0.36,
    textureAirbrushScatter: () => 0.36,
    textureAirbrushColor: () => ({ r: 0, g: 255, b: 74 }),
    clonePaintMaterialForHit: () => material,
    editableClonePaintTexture: () => editable,
    clonePaintTextureUv: (uv) => ({ x: uv.x, y: uv.y }),
    clonePaintPixelFromMappedTextureUv: (mappedUv, canvas) => ({
      x: Math.max(0, Math.min(canvas.width - 1, Math.round(mappedUv.x * (canvas.width - 1)))),
      y: Math.max(0, Math.min(canvas.height - 1, Math.round(mappedUv.y * (canvas.height - 1))))
    }),
    clonePaintPixelFromUv(uv, canvas, texture, options) {
      return this.clonePaintPixelFromMappedTextureUv(this.clonePaintTextureUv(uv), canvas, texture, options);
    }
  };
  const hit = {
    object: record.object,
    distance: 1,
    uv: { x: 0.35, y: 0.25 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 0.02 } },
    faceIndex: 0
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(editor, record, hit, {
    clientX: 50,
    clientY: 50
  }, {
    radiusPixels: 24,
    requireVisibilityMask: true
  });

  const [triangle] = candidate.options.visibilityMaskTriangles;
  assert.ok(triangle);
  assert.ok(triangle.coverage > 0);
  assert.ok(triangle.coverage < 1);
});

test("installed airbrush WebGPU live path batches coalesced visible candidates with scoped visibility payloads", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-merged-triangles" };
  const record = {
    object: { uuid: "mesh-live-merged", isMesh: true },
    geometry: { uuid: "mesh-live-merged-geometry" },
    texturePaintOnly: true
  };
  const { editable } = fakeEditableTexture(512, 512, new Uint8Array(512 * 512 * 4));
  const triangle = (offset) => ({
    a: { x: 20 + offset, y: 20 },
    b: { x: 40 + offset, y: 20 },
    c: { x: 20 + offset, y: 40 }
  });
  const points = [
    { x: 60, y: 80 },
    { x: 450, y: 84 },
    { x: 72, y: 420 }
  ];
  const radii = [10, 15, 12];
  const candidateForSegment = (index) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: points[index],
    start: { x: points[index].x - 4, y: points[index].y },
    radiusPixels: radii[index],
    strokeSegments: [{
      start: { x: points[index].x - 4, y: points[index].y },
      end: { x: points[index].x + 4, y: points[index].y }
    }],
    options: {
      radiusPixels: radii[index],
      opacity: 0.5,
      hardness: 0.35,
      scatter: 0.2,
      strength: 1,
      allowDisjointLiveBatchBounds: true,
      allowVariableStrokeSegmentRadius: true,
      visibilityMaskKey: `temporary-visible-triangle-mask-${index}`,
      visibilityMaskTriangles: [triangle(index * 8)]
    },
    estimate: 10
  });
  const queued = [];

  editor.model = {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [0, 1, 2].map(candidateForSegment);
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return Math.max(1, candidate.strokeSegments?.length || 0);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 60,
    clientY: 80,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(estimate, 3);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments.length, 3);
  assert.deepEqual(queued[0].strokeSegments.map((segment) => segment.radiusPixels), radii);
  assert.equal(queued[0].options.radiusPixels, 15);
  assert.ok(queued[0].options.visibilityMaskSamples.length >= 3);
  assert.equal(queued[0].options.visibilityMaskTriangles.length, 0);
  assert.equal(queued[0].options.visibilityMaskPixels, null);
});

test("installed airbrush WebGPU pressure-shrunk screen strokes still request TSL surface data", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  let candidateOptions = null;

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({});
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options = {}) => {
    candidateOptions = options;
    return [];
  };
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 120,
    clientY: 140,
    buttons: 1,
    pointerType: "pen",
    pressure: 0.28
  }, {
    radiusPixels: 8,
    opacity: 0.23,
    pressureRadius: true,
    pressureOpacity: true,
    liveProjectedPaint: true,
    screenStrokePaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    strokeSegments: [
      { start: { clientX: 100, clientY: 140 }, end: { clientX: 120, clientY: 140 }, radiusPixels: 8 },
      { start: { clientX: 120, clientY: 140 }, end: { clientX: 140, clientY: 138 }, radiusPixels: 8 }
    ]
  });

  assert.equal(estimate, 0);
  assert.equal(candidateOptions.paintProjectedSurfaceCandidates, false);
  assert.equal(candidateOptions.dedupProjectedSurfacePaintCandidates, false);
  assert.equal(candidateOptions.paintOrderedProbeCandidates, false);
  assert.equal(candidateOptions.fullProjectedSurfaceRenderTriangles, true);
  assert.equal(candidateOptions.fullProjectedTrianglePaintRegions, undefined);
  assert.equal(candidateOptions.projectedSurfaceScreenCandidateGroups, undefined);
  assert.equal(candidateOptions.largeLiveBrushPaint, undefined);
  assert.equal(candidateOptions.maxProjectedRenderTriangles, 128);
});

test("installed airbrush WebGPU live visibility-only probes do not expand paint bounds", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-visibility-only-bounds" };
  const record = {
    object: { uuid: "mesh-live-visibility-only-bounds", isMesh: true },
    geometry: { uuid: "mesh-live-visibility-only-bounds-geometry" },
    texturePaintOnly: true
  };
  const { editable } = fakeEditableTexture(1024, 1024, new Uint8Array(1024 * 1024 * 4));
  const paintCandidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 64, y: 64 },
    start: { x: 48, y: 64 },
    radiusPixels: 24,
    strokeSegments: [{
      start: { x: 48, y: 64 },
      end: { x: 80, y: 64 }
    }],
    options: {
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.35,
      scatter: 0.2,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      allowVariableStrokeSegmentRadius: true,
      visibilityMaskSamples: [{
        segment: {
          start: { x: 48, y: 64 },
          end: { x: 80, y: 64 }
        }
      }]
    },
    estimate: 32
  };
  const farVisibilityOnlyCandidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 900, y: 900 },
    start: { x: 900, y: 900 },
    radiusPixels: 24,
    strokeSegments: [{
      start: { x: 900, y: 900 },
      end: { x: 904, y: 900 }
    }],
    visibilityOnly: true,
    options: {
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.35,
      scatter: 0.2,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      allowVariableStrokeSegmentRadius: true,
      visibilityOnly: true,
      visibilityMaskSamples: [{ x: 900, y: 900 }]
    },
    estimate: 1
  };
  const queued = [];

  editor.model = {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureBrushRadiusScreenPixels = () => 96;
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    paintCandidate,
    farVisibilityOnlyCandidate
  ];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return Math.max(1, candidate.strokeSegments?.length || 0);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 64,
    clientY: 64,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true
  });

  assert.equal(estimate, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments.length, 1);
  assert.ok(queued[0].options.visibilityMaskSamples.some((sample) => sample.x === 900));
  assert.ok(queued[0].paintBounds.x < 40);
  assert.ok(queued[0].paintBounds.width < 120);
  assert.ok(queued[0].paintRegions.every((region) => region.x < 120));
});

test("installed airbrush WebGPU live projected UV islands share projected paint scope", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-projected-local-islands" };
  const record = {
    object: { uuid: "mesh-live-projected-local-islands", isMesh: true },
    geometry: { uuid: "mesh-live-projected-local-islands-geometry" },
    texturePaintOnly: true
  };
  const { editable } = fakeEditableTexture(1024, 2048, new Uint8Array(1024 * 2048 * 4));
  const strokeSegments = [
    {
      start: { x: 88, y: 92 },
      end: { x: 112, y: 92 },
      radiusPixels: 32
    },
    {
      start: { x: 748, y: 1804 },
      end: { x: 776, y: 1804 },
      radiusPixels: 32
    }
  ];
  const paintRegions = [
    { x: 48, y: 52, width: 112, height: 88 },
    { x: 708, y: 1760, width: 120, height: 96 }
  ];
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 776, y: 1804 },
    start: { x: 88, y: 92 },
    radiusPixels: 32,
    strokeSegments,
    paintBounds: { x: 48, y: 52, width: 780, height: 1804 },
    paintRegions,
    options: {
      radiusPixels: 32,
      opacity: 0.5,
      hardness: 0.35,
      scatter: 0.2,
      strength: 1,
      color: { r: 0, g: 255, b: 80 },
      liveProjectedPaint: true,
      visibilityMaskMode: "samples",
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      allowVariableStrokeSegmentRadius: true,
      visibilityMaskSamples: strokeSegments.map((segment) => ({ segment })),
      screenProjectedStrokeSegments: [{
        start: { x: 300, y: 280 },
        end: { x: 360, y: 280 },
        radiusPixels: 32
      }],
      strokeSegments
    },
    estimate: 400
  };
  const queued = [];

  editor.model = {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureBrushRadiusScreenPixels = () => 64;
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [candidate];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (queuedCandidate) => {
    queued.push(queuedCandidate);
    return Math.max(1, queuedCandidate.strokeSegments?.length || 0);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 300,
    clientY: 280,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true
  });

  assert.equal(estimate, 2);
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map((queuedCandidate) => queuedCandidate.strokeSegments.length), [1, 1]);
  assert.deepEqual(queued.map((queuedCandidate) => queuedCandidate.paintRegions.length), [2, 2]);
  assert.deepEqual(
    queued.map((queuedCandidate) => queuedCandidate.paintBounds),
    [
      { x: 48, y: 52, width: 780, height: 1804 },
      { x: 48, y: 52, width: 780, height: 1804 }
    ]
  );
  assert.deepEqual(
    queued.map((queuedCandidate) => queuedCandidate.paintRegions.map((region) => region.x)),
    [
      [48, 708],
      [48, 708]
    ]
  );
});

test("installed airbrush WebGPU live projected regions keep the shared region capacity", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-projected-region-capacity" };
  const record = {
    object: { uuid: "mesh-live-projected-region-capacity", isMesh: true },
    geometry: { uuid: "mesh-live-projected-region-capacity-geometry" },
    texturePaintOnly: true
  };
  const { editable } = fakeEditableTexture(4096, 4096, new Uint8Array(4096 * 4096 * 4));
  const paintRegions = Array.from({ length: 108 }, (_, index) => ({
    x: (index % 12) * 128,
    y: Math.floor(index / 12) * 144,
    width: 48,
    height: 52
  }));
  const strokeSegment = {
    start: { x: 180, y: 220 },
    end: { x: 180, y: 220 },
    radiusPixels: 40
  };
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: strokeSegment.end,
    start: strokeSegment.start,
    radiusPixels: 40,
    strokeSegments: [strokeSegment],
    paintBounds: { x: 0, y: 0, width: 1460, height: 1256 },
    paintRegions,
    options: {
      radiusPixels: 40,
      opacity: 0.82,
      hardness: 0.2,
      scatter: 0.36,
      strength: 1,
      color: { r: 0, g: 255, b: 102 },
      liveProjectedPaint: true,
      visibilityMaskMode: "samples",
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      allowVariableStrokeSegmentRadius: true,
      visibilityMaskSamples: [{ segment: strokeSegment }],
      screenProjectedStrokeSegments: [{
        start: { x: 300, y: 280 },
        end: { x: 340, y: 300 },
        radiusPixels: 40
      }],
      strokeSegments: [strokeSegment]
    },
    estimate: 400
  };
  const queued = [];

  editor.model = {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureBrushRadiusScreenPixels = () => 80;
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [candidate];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (queuedCandidate) => {
    queued.push(queuedCandidate);
    return Math.max(1, queuedCandidate.strokeSegments?.length || 0);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 320,
    clientY: 280,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true
  });

  assert.equal(estimate, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].paintRegions.length, paintRegions.length);
  assert.deepEqual(queued[0].paintRegions.at(-1), paintRegions.at(-1));
});

test("installed airbrush WebGPU live path rejects disjoint UV island batch merges", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-disjoint-islands" };
  const record = {
    object: { uuid: "mesh-live-disjoint-islands", isMesh: true },
    geometry: { uuid: "mesh-live-disjoint-islands-geometry" },
    texturePaintOnly: true
  };
  const { editable } = fakeEditableTexture(4096, 4096, new Uint8Array(4096 * 4096 * 4));
  const makeCandidate = (x) => {
    const segment = {
      start: { x, y: 3952 },
      end: { x: x + 24, y: 3958 },
      radiusPixels: 56
    };
    return {
      record,
      material,
      materialIndex: 0,
      editable,
      center: segment.end,
      start: segment.start,
      radiusPixels: 56,
      strokeSegments: [segment],
      options: {
        radiusPixels: 56,
        opacity: 0.42,
        hardness: 0.36,
        scatter: 0.36,
        strength: 1,
        color: { r: 192, g: 111, b: 79 },
        liveProjectedPaint: true,
        visibilityMaskMode: "samples",
        useVisibilityMask: true,
        visibleSurfaceMaskReady: true,
        allowVariableStrokeSegmentRadius: true,
        visibilityMaskSamples: [{ segment }],
        strokeSegments: [segment]
      },
      estimate: 20000
    };
  };
  const queued = [];

  editor.model = {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureBrushRadiusScreenPixels = () => 80;
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    makeCandidate(900),
    makeCandidate(2550)
  ];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (queuedCandidate) => {
    queued.push(queuedCandidate);
    return Math.max(1, queuedCandidate.strokeSegments?.length || 0);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 320,
    clientY: 280,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true
  });

  assert.equal(estimate, 2);
  assert.equal(queued.length, 2);
  assert.ok(queued.every((queuedCandidate) => queuedCandidate.strokeSegments.length === 1));
  assert.ok(queued.every((queuedCandidate) => queuedCandidate.paintRegions.length === 1));
  assert.ok(queued.every((queuedCandidate) => queuedCandidate.paintBounds.width < 260));
  assert.ok(queued.every((queuedCandidate) => queuedCandidate.paintBounds.height < 240));
  assert.deepEqual(
    queued.map((queuedCandidate) => queuedCandidate.paintRegions[0].x),
    [842, 2492]
  );
});

test("installed airbrush WebGPU live path keeps temporary mesh records in separate batches", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-temp-records" };
  const { editable } = fakeEditableTexture(128, 128, new Uint8Array(128 * 128 * 4));
  const queued = [];
  const candidateForMesh = (objectUuid, x) => ({
    record: {
      object: { uuid: objectUuid },
      geometry: { uuid: `${objectUuid}-geometry` },
      texturePaintOnly: true
    },
    material,
    materialIndex: 0,
    editable,
    center: { x, y: 40 },
    start: { x, y: 40 },
    radiusPixels: 8,
    strokeSegments: [{ start: { x, y: 40 }, end: { x: x + 6, y: 42 } }],
    options: {
      radiusPixels: 8,
      opacity: 0.5,
      hardness: 0.35,
      scatter: 0.2,
      strength: 1
    },
    estimate: 1
  });

  editor.model = {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    candidateForMesh("mesh-live-temp-a", 24),
    candidateForMesh("mesh-live-temp-b", 36)
  ];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return Math.max(1, candidate.strokeSegments?.length || 0);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 40,
    clientY: 40,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(estimate, 2);
  assert.equal(queued.length, 2);
  assert.equal(queued[0].record.object.uuid, "mesh-live-temp-a");
  assert.equal(queued[1].record.object.uuid, "mesh-live-temp-b");
  assert.notEqual(queued[0].record.object.uuid, queued[1].record.object.uuid);
  assert.equal((queued[0].options.visibilityMaskTriangles || []).length, 0);
  assert.equal((queued[1].options.visibilityMaskTriangles || []).length, 0);
  assert.equal(queued[0].strokeSegments.length, 1);
  assert.equal(queued[1].strokeSegments.length, 1);
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

test("editable WebGPU prewarm can upload source directly from the canvas", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    150, 151, 152, 255,
    160, 161, 162, 255
  ], 0);
  const device = fakeWebGpuDevice({
    readbackMappedData: mapped,
    externalImageUpload: true
  });
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

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    now,
    externalSourceUpload: true
  });
  const firstRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    mapRead: 1,
    now,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
  });

  assert.ok(prewarm?.resources);
  assert.equal(prewarm.stats.sourceBytes, 0);
  assert.equal(prewarm.stats.sourceExternalUploaded, true);
  assert.equal(prewarm.stats.strokeSourceCopiedFromSource, true);
  assert.equal(firstRun.stats.sourceUploaded, false);
  assert.equal(firstRun.stats.strokeSourceUploaded, false);
  assert.equal(firstRun.stats.reusedResources, true);
  assert.equal(state.getCalls, 0);
  assert.equal(device.calls.filter((call) => call[0] === "copyExternalImageToTexture").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 0);
  assert.ok(device.calls.some((call) => (
    call[0] === "createCommandEncoder"
    && call[1] === "texture-airbrush-copy-source-to-stroke-source"
  )));
  assert.ok(device.calls.filter((call) => call[0] === "copyTextureToTexture").length >= 1);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToBuffer").length, 1);
});

test("editable WebGPU live candidate defaults to direct canvas source upload", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ externalImageUpload: true });
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
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => true;
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  const { editable, state } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const candidate = {
    editable,
    material: {},
    record: {},
    materialIndex: 0,
    estimate: 2,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    }
  };

  const result = await editor.textureAirbrushStartWebGpuPaintCandidate(candidate, {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    liveDisplayExternalTexture: false
  });

  assert.equal(state.getCalls, 0);
  assert.equal(device.calls.filter((call) => call[0] === "copyExternalImageToTexture").length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 0);
  assert.equal(result.stats.sourceExternalUploaded, true);
  assert.equal(result.stats.strokeSourceCopiedFromSource, true);
});

test("editable WebGPU live candidate failure does not disable WebGPU airbrush", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const error = new Error("dispatch failed");
  const warnings = [];
  const originalWarn = console.warn;
  let trackedPromise = null;
  editor.textureAirbrushRunEditableWebGpuPaint = () => Promise.reject(error);
  editor.textureAirbrushTrackWebGpuPaint = (promise) => {
    trackedPromise = promise;
  };
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  try {
    console.warn = (...args) => warnings.push(args);
    const result = await editor.textureAirbrushStartWebGpuPaintCandidate({
      editable,
      material: {},
      record: {},
      materialIndex: 0,
      estimate: 2,
      options: {
        radiusPixels: 1,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0,
        color: { r: 255, g: 0, b: 0 },
        strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
      }
    });

    assert.equal(result, null);
    assert.equal(await trackedPromise, null);
    assert.equal(editor.textureAirbrushLastWebGpuPaintError, error);
    assert.notEqual(editor.textureAirbrushWebGpuDisabled, true);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("editable WebGPU live candidate uses candidate bounds over stale option segments", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(4096, 4096, new Uint8Array(4));
  const candidateStrokeSegments = [
    {
      start: { x: 2442, y: 672 },
      end: { x: 2480, y: 710 },
      radiusPixels: 245
    }
  ];
  const staleOptionSegments = [
    {
      start: { x: 450, y: 139 },
      end: { x: 520, y: 210 },
      radiusPixels: 24
    }
  ];
  const screenProjectedStrokeSegments = [
    {
      start: { x: 90, y: 140 },
      end: { x: 145, y: 192 },
      radiusPixels: 28
    }
  ];
  const candidatePaintBounds = {
    x: 2130,
    y: 360,
    width: 625,
    height: 625
  };
  let capturedEditable = null;
  let capturedOptions = null;
  editor.textureAirbrushRunEditableWebGpuPaint = (runEditable, runOptions) => {
    capturedEditable = runEditable;
    capturedOptions = runOptions;
    return { applied: true, stats: {} };
  };
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;

  const result = await editor.textureAirbrushStartWebGpuPaintCandidate({
    editable,
    material: {},
    record: {},
    materialIndex: 0,
    center: { x: 2442, y: 672 },
    radiusPixels: 245,
    strokeSegments: candidateStrokeSegments,
    paintBounds: candidatePaintBounds,
    undoCaptured: true,
    options: {
      radiusPixels: 245,
      opacity: 1,
      hardness: 0.36,
      scatter: 0.36,
      color: { r: 255, g: 0, b: 255 },
      strokeSegments: staleOptionSegments,
      screenProjectedStrokeSegments,
      paintBounds: { x: 450, y: 139, width: 71, height: 71 }
    },
    estimate: 390625
  }, {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });

  assert.equal(capturedEditable, editable);
  assert.deepEqual(capturedOptions.strokeSegments, candidateStrokeSegments);
  assert.notDeepEqual(capturedOptions.strokeSegments, screenProjectedStrokeSegments);
  assert.deepEqual(capturedOptions.screenProjectedStrokeSegments, screenProjectedStrokeSegments);
  assert.deepEqual(capturedOptions.paintBounds, candidatePaintBounds);
  assert.ok(result?.applied);
});

test("editable WebGPU live candidate ignores cropped undo images as stroke source", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ externalImageUpload: true });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.texturePaintCanvasStrokeSourceImage = () => ({
    width: 1,
    height: 1,
    data: new Uint8ClampedArray(4)
  });
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => true;
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const candidate = {
    editable,
    material: {},
    record: {},
    materialIndex: 0,
    estimate: 2,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    }
  };

  const result = await editor.textureAirbrushStartWebGpuPaintCandidate(candidate, {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    liveDisplayExternalTexture: false
  });

  assert.ok(result?.applied);
  assert.equal(result.stats.deferredReadbackCopy, true);
  assert.equal(result.stats.strokeSourceUploaded, true);
  assert.equal(result.stats.strokeSourceCopiedFromSource, true);
});

test("layer WebGPU live display uploads the base canvas without a CPU read when possible", () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ externalImageUpload: true });
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
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const base = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  editable.layerMode = true;
  editable.layer = { id: "paint-layer-1", opacity: 1 };
  editable.layerStack = {
    baseCanvas: base.editable.canvas,
    baseContext: base.editable.context,
    width: 2,
    height: 1
  };

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material: { map: { name: "base-map", flipY: false } },
    externalSourceUpload: true,
    liveDisplayExternalTexture: true,
    allowPrewarmLiveDisplayMaterialSwap: true,
    radiusPixels: 1,
    scatter: 0,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
  });

  assert.ok(prewarm?.resources);
  assert.equal(base.state.getCalls, 0);
  assert.equal(device.calls.filter((call) => call[0] === "copyExternalImageToTexture").length, 2);
  assert.ok(device.calls.some((call) => (
    call[0] === "copyExternalImageToTexture"
    && String(call[6] || "").includes("base-texture")
  )));
});

test("editable WebGPU deferred copy sync keeps distant dirty regions separate", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 32);
  mapped.fill(180);
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
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable } = fakeEditableTexture(128, 16, new Uint8Array(128 * 16 * 4));
  editable.layerMode = true;
  const base = fakeEditableTexture(128, 16, new Uint8Array(128 * 16 * 4));
  editable.layer = { id: "layer-1", opacity: 1 };
  editable.layerStack = {
    baseCanvas: base.editable.canvas,
    baseContext: base.editable.context,
    width: 128,
    height: 16,
    layers: [editable.layer]
  };
  const material = {
    map: editable.texture,
    userData: {
      clonePaintTexture: editable.texture
    }
  };
  const externalTexture = { userData: {} };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;
  const layerCommits = [];
  editor.texturePaintCommitEditable = (commitEditable, commitMaterial, record, options = {}) => {
    layerCommits.push({ commitEditable, commitMaterial, record, options });
    return true;
  };

  textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    mapRead: 1,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    liveDisplayExternalTexture: true,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 4, y: 8 }, end: { x: 6, y: 8 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    mapRead: 1,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    liveDisplayExternalTexture: true,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 116, y: 8 }, end: { x: 118, y: 8 } }]
  });

  const precopyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");

  assert.equal(precopyCalls.length, 0);

  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyOrigins = copyCalls.map((call) => call[6]);
  const copyWidths = copyCalls.map((call) => call[4]);

  assert.equal(sync.length, 2);
  assert.equal(copyCalls.length, 2);
  assert.ok(Math.max(...copyOrigins) - Math.min(...copyOrigins) > 80);
  assert.ok(copyWidths.every((width) => width < 32));
  assert.ok(sync.every((result) => result?.applied));
  const syncStats = editor.textureAirbrushWebGpuPaintStats.filter((stats) => (
    stats.deferredCanvasSync === true
  ));
  const liveStats = editor.textureAirbrushWebGpuPaintStats.filter((stats) => (
    stats.deferredReadbackCopy === true && stats.deferredCanvasSync !== true
  ));
  assert.equal(syncStats.length, 2);
  assert.equal(liveStats.length, 2);
  assert.ok(syncStats.every((stats) => stats.readbackBytes < 32 * 16 * 4));
  assert.ok(liveStats.every((stats) => stats.readbackBytes === 0 && stats.appliedBytes === 0));
  assert.equal(material.needsUpdate, true);
  assert.equal(layerCommits.length, 1);
  assert.equal(layerCommits[0].commitEditable, editable);
  assert.equal(layerCommits[0].commitMaterial, material);
  assert.equal(layerCommits[0].options.skipGpuTargetUpload, true);
  assert.equal(layerCommits[0].options.preserveWebGpuDisplay, true);

  const readbackBuffersAfterFirstSync = device.calls.filter((call) => (
    call[0] === "createBuffer"
    && String(call[1] || "").includes("readback-buffer")
  )).length;
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    mapRead: 1,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    liveDisplayExternalTexture: true,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 116, y: 8 }, end: { x: 118, y: 8 } }]
  });
  const copyCallsBeforeSecondSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;
  const secondSync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copyCallsAfterSecondSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;
  const readbackBuffersAfterSecondSync = device.calls.filter((call) => (
    call[0] === "createBuffer"
    && String(call[1] || "").includes("readback-buffer")
  )).length;

  assert.equal(secondSync.length, 1);
  assert.equal(copyCallsAfterSecondSync, copyCallsBeforeSecondSync + 1);
  assert.equal(readbackBuffersAfterSecondSync, readbackBuffersAfterFirstSync + 1);
});

test("texture paint history restore cancels deferred WebGPU canvas sync", async () => {
  class TestEditor {}
  const originalPixels = new Uint8Array([
    1, 2, 3, 255,
    4, 5, 6, 255
  ]);
  const mapped = new Uint8Array(256);
  mapped.fill(220);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  installPaintToolMethods(TestEditor, {});
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(2, 1, originalPixels);
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    deferredCanvasSyncRegions: [{ x: 0, y: 0, width: 2, height: 1 }],
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  assert.equal(cache.deferredReadbackApplyPending, true);
  assert.ok(editor.textureAirbrushDeferredWebGpuCanvasSyncCaches.has(cache));

  assert.equal(editor.prepareTexturePaintHistoryRestore(), true);
  assert.equal(cache.deferredCanvasSync, undefined);
  assert.equal(cache.deferredReadbackApplyPending, false);
  assert.equal(editor.textureAirbrushDeferredWebGpuCanvasSyncCaches.size, 0);

  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  assert.deepEqual(sync, []);
  assert.equal(state.putCalls.length, 0);
  assert.deepEqual([...state.imageData.data], [...originalPixels]);
});

test("editable WebGPU layer paint marks layer non-empty before deferred canvas sync", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  const { editable, state } = fakeEditableTexture(4, 4, new Uint8Array(4 * 4 * 4));
  const gpuTarget = { emptyTransparent: true, paintRevision: 0 };
  const layer = { id: "live-layer", opacity: 1, isEmpty: true, gpuTarget };
  editable.layerMode = true;
  editable.layer = layer;
  editable.layerStack = {
    baseCanvas: { width: 4, height: 4 },
    baseContext: {},
    width: 4,
    height: 4,
    layers: [layer]
  };
  const mutatedTargets = [];
  editor.markTexturePaintGpuTargetMutated = (targetEntry) => {
    mutatedTargets.push(targetEntry);
    targetEntry.paintRevision = (targetEntry.paintRevision || 0) + 1;
    return true;
  };

  const run = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }],
    deferReadbackApply: true,
    deferReadbackCopy: true
  });

  assert.equal(run?.stats?.deferredReadbackCopy, true);
  assert.equal(layer.isEmpty, false);
  assert.equal(gpuTarget.emptyTransparent, false);
  assert.equal(gpuTarget.paintRevision, 1);
  assert.deepEqual(mutatedTargets, [gpuTarget]);
  assert.equal(state.putCalls.length, 0);

  const secondRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 2, y: 2 }, end: { x: 3, y: 2 } }],
    strokeSourceOwner: {},
    deferReadbackApply: true,
    deferReadbackCopy: true
  });

  assert.equal(secondRun?.stats?.sourceUploaded, false);
  assert.equal(secondRun?.stats?.strokeSourceCopiedFromSource, true);
  assert.equal(layer.isEmpty, false);
  assert.equal(gpuTarget.emptyTransparent, false);
  assert.equal(gpuTarget.paintRevision, 2);
  assert.deepEqual(mutatedTargets, [gpuTarget, gpuTarget]);
  assert.equal(state.putCalls.length, 0);
});

test("editable WebGPU paint refreshes the warmed stroke source after readback apply", async () => {
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

  const firstPrewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, paintOptions);
  const firstRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const refreshedSource = textureAirbrushCachedWebGpuStrokeSourceImage(editor, editable);
  const refreshedPrewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, paintOptions);
  const skippedPrewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, paintOptions);
  const gpuStrokeSourceCopiesAfterPrewarm = device.calls.filter((call) => (
    call[0] === "createCommandEncoder"
    && call[1] === "texture-airbrush-copy-source-to-stroke-source"
  )).length;
  const ownerRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    ...paintOptions,
    strokeSourceOwner: {}
  });
  const gpuStrokeSourceCopiesAfterOwnerRun = device.calls.filter((call) => (
    call[0] === "createCommandEncoder"
    && call[1] === "texture-airbrush-copy-source-to-stroke-source"
  )).length;

  assert.ok(firstPrewarm?.resources);
  assert.equal(firstRun.stats.sourceUploaded, false);
  assert.equal(firstRun.stats.strokeSourceUploaded, false);
  assert.equal(ownerRun.stats.strokeSourceUploaded, false);
  assert.ok(refreshedSource);
  assert.equal(refreshedSource, firstRun.applied.imageData);
  assert.equal(refreshedPrewarm?.stats?.strokeSourceCopiedFromSource, true);
  assert.equal(skippedPrewarm, null);
  assert.equal(gpuStrokeSourceCopiesAfterOwnerRun, gpuStrokeSourceCopiesAfterPrewarm);
  assert.equal(state.getCalls, 1);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, 2);
  assert.equal(
    device.calls.filter((call) => call[0] === "writeTexture" && /stroke-source-texture$/.test(call[6])).length,
    1
  );
});

test("editable WebGPU new stroke uses current GPU source while canvas readback is deferred", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
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
  editor.markTexturePaintStrokeChanged = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.updateClonePaintPreviews = () => {};
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const material = { uuid: "material-deferred-new-stroke-source" };
  const record = { id: "record-deferred-new-stroke-source" };
  const strokeSegments = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }];

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const sourceTextureId = cache?.resources?.sourceTexture?.id;
  const strokeSourceTextureId = cache?.resources?.strokeSourceTexture?.id;
  const strokeSourceWritesAfterFirst = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;

  const staleCanvasStrokeSource = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      1, 2, 3, 4,
      5, 6, 7, 8
    ])
  };
  const strokeUndo = { touched: new Map(), before: [] };
  let strokeSourceReadCount = 0;
  editor.texturePaintActiveStrokeUndo = () => strokeUndo;
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.texturePaintCanvasStrokeSourceImage = () => {
    strokeSourceReadCount += 1;
    return staleCanvasStrokeSource;
  };
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;

  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1, y: 0 },
    start: { x: 0, y: 0 },
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments
    },
    estimate: 2
  };

  const firstCandidateRun = await editor.textureAirbrushStartWebGpuPaintCandidate(candidate, {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });
  await editor.textureAirbrushStartWebGpuPaintCandidate({
    ...candidate,
    undoCaptured: true
  }, {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });

  const strokeSourceWritesAfterNewStroke = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;
  const gpuStrokeSourceCopies = device.calls.filter((call) => (
    call[0] === "createCommandEncoder"
    && call[1] === "texture-airbrush-copy-source-to-stroke-source"
  )).length;
  const paintSlices = paintEncoderSlices(device.calls);

  assert.equal(strokeSourceWritesAfterFirst, 1);
  assert.equal(strokeSourceWritesAfterNewStroke, strokeSourceWritesAfterFirst);
  assert.equal(firstCandidateRun?.stats?.strokeSourceCopiedFromSource, true);
  assert.equal(gpuStrokeSourceCopies, 0);
  assert.ok(hasSourceToStrokeCopyBeforeCompute(paintSlices[1], sourceTextureId, strokeSourceTextureId));
  assert.equal(strokeSourceReadCount, 0);
});

test("editable WebGPU reset strokes prefer current GPU source over stale canvas stroke snapshots", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    80, 90, 100, 255,
    110, 120, 130, 255
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
  editor.markTexturePaintStrokeChanged = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.updateClonePaintPreviews = () => {};
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const material = { uuid: "material-reset-prefers-gpu-source" };
  const record = { id: "record-reset-prefers-gpu-source" };
  const strokeSegments = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }];

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    mapRead: 1,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const sourceTextureId = cache?.resources?.sourceTexture?.id;
  const strokeSourceTextureId = cache?.resources?.strokeSourceTexture?.id;
  const strokeSourceWritesAfterFirst = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;

  const staleCanvasStrokeSource = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      1, 2, 3, 4,
      5, 6, 7, 8
    ])
  };
  const strokeUndo = { touched: new Map(), before: [] };
  let strokeSourceReadCount = 0;
  editor.texturePaintActiveStrokeUndo = () => strokeUndo;
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.texturePaintCanvasStrokeSourceImage = () => {
    strokeSourceReadCount += 1;
    return staleCanvasStrokeSource;
  };
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;

  const candidateRun = await editor.textureAirbrushStartWebGpuPaintCandidate({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1, y: 0 },
    start: { x: 0, y: 0 },
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      color: { r: 255, g: 0, b: 0 },
      strokeReset: true,
      strokeSegments
    },
    estimate: 2
  }, {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });

  const strokeSourceWritesAfterReset = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;
  const paintSlices = paintEncoderSlices(device.calls);

  assert.equal(strokeSourceWritesAfterFirst, 1);
  assert.equal(strokeSourceWritesAfterReset, strokeSourceWritesAfterFirst);
  assert.equal(candidateRun?.stats?.strokeSourceCopiedFromSource, true);
  assert.ok(hasSourceToStrokeCopyBeforeCompute(paintSlices[1], sourceTextureId, strokeSourceTextureId));
  assert.equal(strokeSourceReadCount, 0);
});

test("editable WebGPU repeated reset strokes refresh the stroke source from current GPU paint", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
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
  editor.markTexturePaintStrokeChanged = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.updateClonePaintPreviews = () => {};
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const material = { uuid: "material-repeated-reset-source" };
  const record = { id: "record-repeated-reset-source" };
  const strokeSegments = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }];
  const strokeUndo = { touched: new Map(), before: [] };
  let strokeSourceReadCount = 0;
  editor.texturePaintActiveStrokeUndo = () => strokeUndo;
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.texturePaintCanvasStrokeSourceImage = () => {
    strokeSourceReadCount += 1;
    return {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([
        1, 2, 3, 4,
        5, 6, 7, 8
      ])
    };
  };
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1, y: 0 },
    start: { x: 0, y: 0 },
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      color: { r: 255, g: 0, b: 0 },
      strokeReset: true,
      strokeSegments
    },
    estimate: 2
  };
  const runOptions = {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  };

  const firstRun = await editor.textureAirbrushStartWebGpuPaintCandidate(candidate, runOptions);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const sourceTextureId = cache?.resources?.sourceTexture?.id;
  const strokeSourceTextureId = cache?.resources?.strokeSourceTexture?.id;
  const strokeSourceReadsAfterFirst = strokeSourceReadCount;
  const strokeSourceWritesAfterFirst = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;
  const firstOwner = strokeUndo.textureAirbrushWebGpuStrokeSourceOwners?.get(editable.texture);

  const secondRun = await editor.textureAirbrushStartWebGpuPaintCandidate({
    ...candidate,
    undoCaptured: false
  }, runOptions);
  const secondOwner = strokeUndo.textureAirbrushWebGpuStrokeSourceOwners?.get(editable.texture);
  const strokeSourceWritesAfterSecond = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;
  const paintSlices = paintEncoderSlices(device.calls);

  assert.ok(firstRun?.applied);
  assert.ok(secondRun?.applied);
  assert.equal(firstOwner, secondOwner);
  assert.equal(strokeSourceWritesAfterFirst, 1);
  assert.equal(strokeSourceWritesAfterSecond, strokeSourceWritesAfterFirst);
  assert.equal(secondRun.stats.sourceUploaded, false);
  assert.equal(secondRun.stats.strokeSourceUploaded, true);
  assert.equal(secondRun.stats.strokeSourceCopiedFromSource, true);
  assert.ok(hasSourceToStrokeCopyBeforeCompute(paintSlices[1], sourceTextureId, strokeSourceTextureId));
  assert.equal(strokeSourceReadCount, strokeSourceReadsAfterFirst);
});

test("editable WebGPU reset skips source copy after post-stroke prewarm refreshes stroke source", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
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
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.markTexturePaintStrokeChanged = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.updateClonePaintPreviews = () => {};
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const material = { uuid: "material-prewarmed-reset-source" };
  const record = { id: "record-prewarmed-reset-source" };
  const strokeSegments = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }];
  const strokeUndo = { touched: new Map(), before: [] };
  editor.texturePaintActiveStrokeUndo = () => strokeUndo;
  editor.editableClonePaintTexture = (candidateMaterial) => (
    candidateMaterial === material ? editable : null
  );
  editor.captureTexturePaintCanvasUndoTarget = function captureTexturePaintCanvasUndoTarget(
    candidateRecord,
    candidateMaterial,
    candidateEditable,
    materialIndex
  ) {
    const key = candidateEditable.texture;
    if (strokeUndo.touched.has(key)) {
      return true;
    }
    const entry = {
      type: "canvas",
      key,
      record: candidateRecord,
      material: candidateMaterial,
      materialIndex,
      canvas: candidateEditable.canvas,
      context: candidateEditable.context,
      texture: candidateEditable.texture,
      before: null,
      after: null
    };
    strokeUndo.touched.set(key, entry);
    strokeUndo.before.push(entry);
    return true;
  };
  editor.texturePaintCanvasStrokeSourceImage = () => ({
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      1, 2, 3, 4,
      5, 6, 7, 8
    ])
  });
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1, y: 0 },
    start: { x: 0, y: 0 },
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      color: { r: 255, g: 0, b: 0 },
      strokeReset: true,
      strokeSegments
    },
    estimate: 2
  };
  const runOptions = {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  };

  await editor.textureAirbrushStartWebGpuPaintCandidate(candidate, runOptions);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const sourceTextureId = cache?.resources?.sourceTexture?.id;
  const strokeSourceTextureId = cache?.resources?.strokeSourceTexture?.id;

  assert.equal(textureAirbrushEditableWebGpuStrokeSourceCurrent(editor, editable), false);
  assert.equal(editor.textureAirbrushPrewarmWebGpuStrokeSourcesForStroke(strokeUndo), 1);
  assert.equal(textureAirbrushEditableWebGpuStrokeSourceCurrent(editor, editable), true);
  assert.equal(editor.textureAirbrushLastWebGpuPrewarmStats.liveDisplayExternalTexture, false);
  assert.equal(editor.textureAirbrushLastWebGpuPrewarmStats.liveDisplayMipmapPixels, 0);
  const sourceToStrokeCopiesAfterPrewarm = device.calls.filter((call) => (
    call[0] === "copyTextureToTexture"
    && call[1] === sourceTextureId
    && call[2] === strokeSourceTextureId
  )).length;

  const secondRun = await editor.textureAirbrushStartWebGpuPaintCandidate({
    ...candidate,
    undoCaptured: false
  }, runOptions);
  const sourceToStrokeCopiesAfterSecond = device.calls.filter((call) => (
    call[0] === "copyTextureToTexture"
    && call[1] === sourceTextureId
    && call[2] === strokeSourceTextureId
  )).length;
  const paintSlices = paintEncoderSlices(device.calls);

  assert.ok(secondRun?.applied);
  assert.equal(secondRun.stats.sourceUploaded, false);
  assert.equal(secondRun.stats.strokeSourceUploaded, false);
  assert.equal(secondRun.stats.strokeSourceCopiedFromSource, false);
  assert.equal(sourceToStrokeCopiesAfterSecond, sourceToStrokeCopiesAfterPrewarm);
  assert.equal(hasSourceToStrokeCopyBeforeCompute(paintSlices[1], sourceTextureId, strokeSourceTextureId), false);
});

test("editable WebGPU force prewarm preserves live GPU source instead of reuploading stale canvas", () => {
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
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable, state } = fakeEditableTexture(2, 1, new Uint8Array([
    1, 2, 3, 4,
    5, 6, 7, 8
  ]));
  const material = { uuid: "material-force-prewarm-preserve", map: { userData: {} } };

  const firstPrewarm = editor.textureAirbrushPrewarmWebGpuEditable(editable, material, {
    liveDisplayExternalTexture: false
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const warmedResources = cache?.resources;
  cache.externalDisplayTexture = { userData: {} };
  cache.externalDisplayGpuTexture = warmedResources?.sourceTexture;
  state.imageData.data.fill(99);
  const getCallsAfterFirst = state.getCalls;
  const writeTexturesAfterFirst = device.calls.filter((call) => call[0] === "writeTexture").length;

  const forcedPrewarm = editor.textureAirbrushPrewarmWebGpuEditable(editable, material, {
    force: true,
    liveDisplayExternalTexture: false
  });

  assert.ok(firstPrewarm?.resources);
  assert.equal(forcedPrewarm?.resources, warmedResources);
  assert.equal(forcedPrewarm?.stats?.reusedResources, true);
  assert.equal(forcedPrewarm?.stats?.sourceBytes, 0);
  assert.equal(forcedPrewarm?.stats?.sourceImageDataReady, true);
  assert.equal(cache.resources, warmedResources);
  assert.equal(state.getCalls, getCallsAfterFirst);
  assert.equal(device.calls.filter((call) => call[0] === "writeTexture").length, writeTexturesAfterFirst);
});

test("editable WebGPU reset strokes without undo keep previous deferred strokes", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
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
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const material = { uuid: "material-reset-no-undo" };
  const record = { id: "record-reset-no-undo" };
  const strokeSegments = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }];
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1, y: 0 },
    start: { x: 0, y: 0 },
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      color: { r: 255, g: 0, b: 0 },
      strokeReset: true,
      strokeSegments
    },
    estimate: 2
  };
  const runOptions = {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  };

  await editor.textureAirbrushStartWebGpuPaintCandidate(candidate, runOptions);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const sourceTextureId = cache?.resources?.sourceTexture?.id;
  const strokeSourceTextureId = cache?.resources?.strokeSourceTexture?.id;
  const firstFallbackOwner = editor.textureAirbrushWebGpuFallbackStrokeSourceRoot
    ?.textureAirbrushWebGpuStrokeSourceOwners?.get(editable.texture);
  await editor.textureAirbrushStartWebGpuPaintCandidate({
    ...candidate,
    undoCaptured: true
  }, runOptions);

  const paintSlices = paintEncoderSlices(device.calls);
  const secondFallbackOwner = editor.textureAirbrushWebGpuFallbackStrokeSourceRoot
    ?.textureAirbrushWebGpuStrokeSourceOwners?.get(editable.texture);

  assert.ok(firstFallbackOwner);
  assert.ok(secondFallbackOwner);
  assert.notEqual(secondFallbackOwner, firstFallbackOwner);
  assert.ok(hasSourceToStrokeCopyBeforeCompute(paintSlices[1], sourceTextureId, strokeSourceTextureId));
});

test("editable WebGPU screen-flushed stroke context keeps previous deferred strokes", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
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
  editor.markTexturePaintStrokeChanged = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.updateClonePaintPreviews = () => {};
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const material = { uuid: "material-context-deferred-source" };
  const record = { id: "record-context-deferred-source" };
  const strokeSegments = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }];

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });
  const strokeSourceWritesAfterFirst = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;

  const staleCanvasStrokeSource = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      1, 2, 3, 4,
      5, 6, 7, 8
    ])
  };
  const strokeUndoContext = { touched: new Map(), before: [] };
  let strokeSourceReadCount = 0;
  editor.texturePaintStrokeUndoContext = strokeUndoContext;
  editor.captureTexturePaintCanvasUndoTarget = () => true;
  editor.texturePaintCanvasStrokeSourceImage = () => {
    strokeSourceReadCount += 1;
    return staleCanvasStrokeSource;
  };
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;

  const candidateRun = await editor.textureAirbrushStartWebGpuPaintCandidate({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1, y: 0 },
    start: { x: 0, y: 0 },
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments
    },
    estimate: 2
  }, {
    deferApplyRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });

  const strokeSourceWritesAfterContextStroke = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;
  const sameEncoderSourceCopies = device.calls.filter((call) => (
    call[0] === "copyTextureToTexture"
    && call[3] === 2
    && call[4] === 1
    && call[5] === 0
    && call[6] === 0
    && call[7] === 0
    && call[8] === 0
  ));

  assert.equal(strokeSourceWritesAfterContextStroke, strokeSourceWritesAfterFirst);
  assert.equal(candidateRun?.stats?.strokeSourceCopiedFromSource, true);
  assert.equal(strokeUndoContext.textureAirbrushWebGpuStrokeSourceOwners instanceof Map, true);
  assert.ok(sameEncoderSourceCopies.length >= 2);
  assert.equal(strokeSourceReadCount, 0);
});

test("editable WebGPU queued strokes retain separate undo contexts through flush", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
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
  editor.refreshCloneSpotlightTextures = () => {};
  editor.updateClonePaintPreviews = () => {};
  editor.setStatus = () => {};
  editor.textureAirbrushTrackWebGpuPaint = (promise) => promise;
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const material = { uuid: "material-queued-stroke-context" };
  const record = { id: "record-queued-stroke-context" };
  const strokeSegments = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }];
  const paintOptions = {
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments,
    deferReadbackApply: true,
    deferReadbackCopy: true
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const sourceTextureId = cache?.resources?.sourceTexture?.id;
  const strokeSourceTextureId = cache?.resources?.strokeSourceTexture?.id;
  const strokeSourceWritesAfterWarmPaint = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;

  const staleCanvasStrokeSource = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      1, 2, 3, 4,
      5, 6, 7, 8
    ])
  };
  const firstStroke = { touched: new Map(), before: [] };
  const secondStroke = { touched: new Map(), before: [] };
  const activeContexts = [];
  editor.texturePaintActiveStrokeUndo = function texturePaintActiveStrokeUndo() {
    return this.texturePaintStrokeUndoContext || this.texturePaintStrokeUndo || null;
  };
  editor.captureTexturePaintCanvasUndoTarget = function captureTexturePaintCanvasUndoTarget() {
    const stroke = this.texturePaintActiveStrokeUndo();
    activeContexts.push(["capture", stroke]);
    if (stroke) {
      stroke.captured = true;
    }
    return Boolean(stroke);
  };
  editor.texturePaintCanvasStrokeSourceImage = function texturePaintCanvasStrokeSourceImage() {
    activeContexts.push(["source", this.texturePaintActiveStrokeUndo()]);
    return staleCanvasStrokeSource;
  };
  editor.markTexturePaintStrokeChanged = function markTexturePaintStrokeChanged() {
    const stroke = this.texturePaintActiveStrokeUndo();
    activeContexts.push(["changed", stroke]);
    if (stroke) {
      stroke.changed = true;
    }
    return Boolean(stroke);
  };
  const candidateBase = {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1, y: 0 },
    start: { x: 0, y: 0 },
    radiusPixels: 1,
    strokeSegments,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments
    },
    estimate: 2
  };

  editor.texturePaintStrokeUndoContext = firstStroke;
  editor.textureAirbrushQueueWebGpuStrokeCandidate(candidateBase, { scheduleFlush: false });
  editor.texturePaintStrokeUndoContext = secondStroke;
  editor.textureAirbrushQueueWebGpuStrokeCandidate(candidateBase, { scheduleFlush: false });
  delete editor.texturePaintStrokeUndoContext;

  const queued = editor.textureAirbrushQueuedWebGpuStrokes || [];
  assert.equal(queued.length, 2);
  assert.equal(queued[0].strokeUndo, firstStroke);
  assert.equal(queued[1].strokeUndo, secondStroke);
  assert.equal(queued[0].undoCaptured, false);
  assert.equal(queued[1].undoCaptured, false);
  const queuedEstimate = queued.reduce((total, batch) => total + batch.estimate, 0);

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes({
    force: true,
    deferReadbackApply: true,
    deferReadbackCopy: true
  });
  const strokeSourceWritesAfterFlush = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  )).length;
  const deferredStrokePaintSlices = paintEncoderSlices(device.calls).slice(1);

  assert.equal(estimate, queuedEstimate);
  assert.equal(firstStroke.captured, true);
  assert.equal(firstStroke.changed, true);
  assert.equal(secondStroke.captured, true);
  assert.equal(secondStroke.changed, true);
  assert.equal(firstStroke.textureAirbrushWebGpuStrokeSourceOwners instanceof Map, true);
  assert.equal(secondStroke.textureAirbrushWebGpuStrokeSourceOwners instanceof Map, true);
  assert.equal(strokeSourceWritesAfterFlush, strokeSourceWritesAfterWarmPaint);
  assert.equal(deferredStrokePaintSlices.length, 2);
  assert.ok(deferredStrokePaintSlices.every((slice) => (
    hasSourceToStrokeCopyBeforeCompute(slice, sourceTextureId, strokeSourceTextureId)
  )));
  assert.ok(activeContexts.some(([kind, stroke]) => kind === "capture" && stroke === firstStroke));
  assert.ok(activeContexts.some(([kind, stroke]) => kind === "capture" && stroke === secondStroke));
  assert.equal(activeContexts.some(([kind]) => kind === "source"), false);
  assert.ok(activeContexts.some(([kind, stroke]) => kind === "changed" && stroke === firstStroke));
  assert.ok(activeContexts.some(([kind, stroke]) => kind === "changed" && stroke === secondStroke));
});

test("editable WebGPU external display texture aliases the current paint cache for the next stroke", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
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
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  const paintOptions = {
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    deferReadbackApply: true,
    deferReadbackCopy: true,
    liveDisplayExternalTexture: false
  };

  const firstRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const baseCache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const externalTexture = {
    userData: {
      textureAirbrushExternalWebGpuDisplay: true,
      textureAirbrushWebGpuCanvasMap: editable.texture
    }
  };
  const sourceUploadsAfterFirst = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /source-texture$/.test(call[6])
  )).length;

  const secondRun = await editor.textureAirbrushRunEditableWebGpuPaint(
    {
      ...editable,
      texture: externalTexture
    },
    {
      ...paintOptions,
      strokeSourceOwner: {}
    }
  );

  const sourceUploadsAfterSecond = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /source-texture$/.test(call[6])
  )).length;
  const gpuStrokeSourceCopies = device.calls.filter((call) => (
    call[0] === "createCommandEncoder"
    && call[1] === "texture-airbrush-copy-source-to-stroke-source"
  )).length;

  assert.ok(firstRun?.applied);
  assert.ok(secondRun?.applied);
  assert.equal(editor.textureAirbrushWebGpuPaintCaches.get(editable.texture), baseCache);
  assert.equal(editor.textureAirbrushWebGpuPaintCaches.get(externalTexture), undefined);
  assert.equal(secondRun.stats.reusedResources, true);
  assert.equal(secondRun.stats.sourceUploaded, false);
  assert.equal(secondRun.stats.strokeSourceCopiedFromSource, true);
  assert.equal(sourceUploadsAfterSecond, sourceUploadsAfterFirst);
  assert.equal(gpuStrokeSourceCopies, 0);
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
