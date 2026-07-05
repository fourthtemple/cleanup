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
  TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS,
  TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS,
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
  TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS,
  textureAirbrushWebGpuStrokeBufferData,
  textureAirbrushWebGpuTextureDescriptors,
  textureAirbrushWebGpuUsageConstants
} from "../../src/weight-editor/airbrush/webgpu-plan.js";
import {
  textureAirbrushWebGpuStrokeCandidateFromHit,
  textureAirbrushWebGpuStrokeEstimate,
  textureAirbrushWebGpuTextureRadiusPixels
} from "../../src/weight-editor/airbrush/webgpu-stroke.js";

const TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_SCREEN_PROJECTED_TRIANGLE_CAP = 128;
const TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_LARGE_LIVE_TRIANGLE_CAP = Math.max(
  1,
  Math.min(
    768,
    Math.floor(
      (TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS - TEXTURE_AIRBRUSH_WEBGPU_SCREEN_PROJECTED_SEGMENT_RESERVE)
        / 4
    )
  )
);

function visibilityMaskPayloadByteLength(payload = null) {
  const direct = Number(payload?.byteLength);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const nested = Number(payload?.pixels?.byteLength);
  return Number.isFinite(nested) && nested > 0 ? nested : 0;
}

function fakeVisibleWebGpuPaintResult(overrides = {}) {
  return {
    pixels: new Uint8Array([255, 0, 0, 255]),
    applied: { byteLength: 4 },
    stats: {
      liveDisplayExternalTexture: true,
      liveDisplayWorkPixels: 1,
      ...(overrides.stats || {})
    },
    ...overrides
  };
}

function lastUint32BufferWrite(buffer = null) {
  const bytes = buffer?.lastWriteBytes || null;
  if (!bytes?.byteLength || bytes.byteLength % 4 !== 0) {
    return [];
  }
  return Array.from(new Uint32Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength / 4));
}

function fakeWebGpuDevice({ readbackMappedData = null, mapAsync = null } = {}) {
  const calls = [];
  let nextId = 1;
  const resource = (type, desc = {}) => ({
    id: nextId++,
    type,
    desc,
    mappedData: desc.mappedData || null,
    async mapAsync(mode) {
      calls.push(["mapAsync", this.id, mode]);
      if (typeof mapAsync === "function") {
        await mapAsync(this, mode, calls);
      }
    },
    getMappedRange() {
      calls.push(["getMappedRange", this.id]);
      return this.mappedData?.buffer || new ArrayBuffer(desc.size || 0);
    },
    unmap() {
      calls.push(["unmap", this.id]);
    },
    createView(desc = {}) {
      calls.push(["createView", type, this.id, desc.baseMipLevel ?? null, desc.mipLevelCount ?? null]);
      return { type: `${type}-view`, resource: this };
    }
});
  const queue = {
    writeBuffer(buffer, offset, data, dataOffset, size) {
      const byteOffset = Number(dataOffset) || 0;
      const byteLength = Number(size) || data?.byteLength || 0;
      if (data instanceof ArrayBuffer && byteLength > 0) {
        buffer.lastWriteBytes = new Uint8Array(data, byteOffset, byteLength).slice();
        if (byteLength % 4 === 0) {
          buffer.lastWriteFloat32 = Array.from(new Float32Array(data, byteOffset, byteLength / 4));
        }
      }
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
      calls.push(["createShaderModule", desc.label, /textureAirbrushPaint/.test(desc.code), desc.code]);
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
      const texture = resource("texture", desc);
      texture.mipLevelCount = Math.max(1, Math.floor(Number(desc.mipLevelCount) || 1));
      texture.format = desc.format;
      texture.depthOrArrayLayers = Math.max(1, Math.floor(Number(desc.size?.depthOrArrayLayers) || 1));
      return texture;
    },
    createBuffer(desc) {
      calls.push(["createBuffer", desc.label, desc.size, desc.usage]);
      return resource("buffer", {
        ...desc,
        mappedData: String(desc.label || "").includes("readback") ? readbackMappedData : desc.mappedData
      });
    },
    createBindGroup(desc) {
      calls.push(["createBindGroup", desc.entries.map((entry) => entry.binding).join(","), desc.label || ""]);
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
  editor.renderer = { isWebGPURenderer: false };
  editor.textureAirbrushForceWebGpu = true;

  const resolved = editor.textureAirbrushResolveBackend();

  assert.equal(resolved.backend, "none");
  assert.match(resolved.webGpuStatus, /unavailable|needs-webgpu-renderer/);
});

test("installed airbrush WebGPU methods resolve the renderer mode", () => {
  class TestEditor {}
  function WebGPURenderer() {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  editor.textureAirbrushForceWebGpuRenderer = true;

  const resolved = editor.textureAirbrushResolveRendererMode({ WebGPURenderer });

  assert.match(resolved.renderer, /none|webgpu/);
  assert.match(resolved.webGpuRendererStatus, /unavailable|ready/);
});

test("WebGPU prewarm skips editable texture materialization when backend is not ready", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { map: {} };
  let editableRequests = 0;
  editor.textureAirbrushResolveBackend = () => ({
    backend: "none",
    webGpuStatus: "backend-uninitialized"
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

test("WebGPU editable active prewarm keeps source image data ready for stroke undo", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const editable = { canvas: { width: 2, height: 1 }, context: {}, texture: {} };
  const material = { map: {} };
  let prewarmOptions = null;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushPrewarmEditableWebGpuPaint = (candidateEditable, options) => {
    assert.equal(candidateEditable, editable);
    prewarmOptions = options;
    return { resources: {} };
  };

  assert.ok(editor.textureAirbrushPrewarmWebGpuEditable(editable, material));
  assert.equal(prewarmOptions.ensureStrokeSourceImageData, true);
  assert.equal(prewarmOptions.externalSourceUpload, false);
  assert.equal(prewarmOptions.material, material);
});

test("direct WebGPU airbrush prewarm helper is lightweight by default", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const color = { r: 0, g: 255, b: 102 };
  let received = null;
  editor.textureAirbrushPrewarm = (event, hit, options) => {
    received = { event, hit, options };
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmWebGpu({ radiusPixels: 64, color }), true);
  assert.equal(received.event, null);
  assert.equal(received.hit, null);
  assert.equal(received.options.all, false);
  assert.equal(received.options.force, false);
  assert.equal(received.options.liveDisplayExternalTexture, false);
  assert.equal(received.options.allowPrewarmLiveDisplayMaterialSwap, false);
  assert.equal(received.options.warmScreenHitIndex, true);
  assert.equal(received.options.externalSourceUpload, false);
  assert.equal(received.options.tslSurfacePrewarmAll, false);
  assert.equal(received.options.tslSurfacePrewarmLimit, 1);
  assert.equal(received.options.renderCompilePass, false);
  assert.equal(received.options.prewarmPaintablesWithoutHit, false);
  assert.equal(received.options.radiusPixels, 64);
  assert.equal(received.options.color, color);
});

test("WebGPU-only install schedules forced live-display prewarm instead of blocking tool entry", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { map: {} };
  const callbacks = [];
  const prewarmCalls = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  try {
    editor.renderer = {};
    editor.model = {};
    editor.activeTool = "airbrush";
    editor.paintRecords = [{ object: { material } }];
    editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
    editor.editableClonePaintTexture = (candidateMaterial) => {
      assert.equal(candidateMaterial, material);
      return {
        canvas: { width: 2, height: 2 },
        context: {},
        texture: material.map
      };
    };
    editor.textureAirbrushPrewarmEditableWebGpuPaint = (editable, options) => {
      prewarmCalls.push({ editable, options });
      return {
        resources: {},
        stats: {
          liveDisplayExternalTexture: options.liveDisplayExternalTexture === true,
          liveDisplayFullUpdate: true,
          liveDisplayWorkPixels: 4
        }
      };
    };

    assert.equal(typeof editor.scheduleTextureAirbrushPrewarm, "function");
    assert.equal(typeof editor.textureAirbrushPrewarm, "function");
    assert.equal(editor.scheduleTextureAirbrushPrewarm(null, null, {
      all: true,
      force: true,
      liveDisplayExternalTexture: true,
      allowPrewarmLiveDisplayMaterialSwap: true,
      delay: 0
    }), true);
    assert.equal(callbacks.length, 1);
    assert.equal(prewarmCalls.length, 0);
    callbacks.shift()?.();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(prewarmCalls.length, 1);
  assert.equal(prewarmCalls[0].options.material, material);
  assert.equal(prewarmCalls[0].options.liveDisplayExternalTexture, true);
  assert.equal(prewarmCalls[0].options.externalSourceUpload, true);
});

test("WebGPU prewarm scheduler preserves queued TSL surface compile flags", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const callbacks = [];
  let prewarmOptions = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  try {
    editor.renderer = {};
    editor.model = {};
    editor.activeTool = "airbrush";
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      assert.equal(event, null);
      assert.equal(hit, null);
      prewarmOptions = options;
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm(null, null, {
      all: true,
      force: true,
      limit: 1,
      tslSurfacePrewarmAll: true,
      tslSurfacePrewarmLimit: 1,
      renderCompilePass: true,
      delay: 0
    }), true);
    assert.equal(editor.scheduleTextureAirbrushPrewarm(null, null, {
      all: false,
      force: true,
      tslSurfacePrewarmAll: false,
      renderCompilePass: false,
      delay: 0
    }), false);
    callbacks.shift()?.();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(prewarmOptions.tslSurfacePrewarmAll, true);
  assert.equal(prewarmOptions.tslSurfacePrewarmLimit, 1);
  assert.equal(prewarmOptions.renderCompilePass, true);
});

test("WebGPU prewarm scheduler defers throttled compile prewarm instead of dropping it", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const callbacks = [];
  const delays = [];
  let prewarmOptions = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay = 0) => {
    callbacks.push(callback);
    delays.push(delay);
    return callbacks.length;
  };
  try {
    editor.renderer = {};
    editor.model = {};
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      assert.equal(event, null);
      assert.equal(hit, null);
      prewarmOptions = options;
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm(null, null, {
      all: true,
      force: false,
      tslSurfacePrewarmAll: true,
      tslSurfacePrewarmLimit: 1,
      renderCompilePass: true
    }), true);
    assert.equal(callbacks.length, 1);
    assert.ok(delays[0] > 0);
    callbacks.shift()?.();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.equal(prewarmOptions.tslSurfacePrewarmAll, true);
  assert.equal(prewarmOptions.tslSurfacePrewarmLimit, 1);
  assert.equal(prewarmOptions.renderCompilePass, true);
});

test("WebGPU prewarm prioritizes the active texture paint layer", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const baseCanvas = { width: 4, height: 4 };
  const baseContext = {};
  const layerCanvas = { width: 4, height: 4 };
  const layerContext = {};
  const material = {
    map: { name: "base" },
    userData: {
      clonePaintCanvas: baseCanvas,
      clonePaintContext: baseContext,
      clonePaintTexture: { name: "clone-target" },
      texturePaintLayerStack: {
        activeLayerId: "paint-1",
        layers: [
          {
            id: "paint-1",
            name: "Paint 1",
            canvas: layerCanvas,
            context: layerContext
          }
        ]
      }
    }
  };
  const editor = new TestEditor();
  const prewarmCalls = [];
  editor.renderer = {};
  editor.model = {};
  editor.activeTool = "airbrush";
  editor.paintRecords = [{ object: { material } }];
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.editableClonePaintTexture = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    return {
      canvas: baseCanvas,
      context: baseContext,
      texture: material.map
    };
  };
  editor.textureAirbrushPrewarmEditableWebGpuPaint = (editable, options) => {
    prewarmCalls.push({ editable, options });
    return {
      resources: {},
      stats: {
        liveDisplayExternalTexture: false,
        liveDisplayFullUpdate: true,
        liveDisplayWorkPixels: 16
      }
    };
  };

  assert.equal(editor.textureAirbrushPrewarmAllWebGpuPaintables({ all: true }), 1);
  assert.equal(prewarmCalls[0].editable.canvas, layerCanvas);
  assert.equal(prewarmCalls[0].editable.context, layerContext);
  assert.equal(prewarmCalls[0].editable.layerMode, true);
  assert.equal(prewarmCalls[1].editable.canvas, baseCanvas);
  assert.equal(prewarmCalls[1].editable.layerMode, false);
});

test("WebGPU prewarm applies the material hint before the warmup limit", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const firstCanvas = { width: 4, height: 4 };
  const firstContext = {};
  const activeBaseCanvas = { width: 4, height: 4 };
  const activeBaseContext = {};
  const activeLayerCanvas = { width: 4, height: 4 };
  const activeLayerContext = {};
  const firstMaterial = {
    map: { name: "first" },
    userData: {
      clonePaintCanvas: firstCanvas,
      clonePaintContext: firstContext,
      clonePaintTexture: { name: "first-target" }
    }
  };
  const activeMaterial = {
    map: { name: "active" },
    userData: {
      clonePaintCanvas: activeBaseCanvas,
      clonePaintContext: activeBaseContext,
      clonePaintTexture: { name: "active-target" },
      texturePaintLayerStack: {
        activeLayerId: "active-layer",
        layers: [
          {
            id: "active-layer",
            name: "Active Layer",
            canvas: activeLayerCanvas,
            context: activeLayerContext
          }
        ]
      }
    }
  };
  const editor = new TestEditor();
  const prewarmCalls = [];
  editor.renderer = {};
  editor.model = {};
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.paintRecords = [{ object: { material: [firstMaterial, activeMaterial] } }];
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.editableClonePaintTexture = (candidateMaterial) => ({
    canvas: candidateMaterial === activeMaterial ? activeBaseCanvas : firstCanvas,
    context: candidateMaterial === activeMaterial ? activeBaseContext : firstContext,
    texture: candidateMaterial.map
  });
  editor.textureAirbrushPrewarmEditableWebGpuPaint = (editable, options) => {
    prewarmCalls.push({ editable, options });
    return { resources: {}, stats: { liveDisplayExternalTexture: false } };
  };

  assert.equal(editor.textureAirbrushPrewarmAllWebGpuPaintables({
    all: true,
    limit: 1,
    material: activeMaterial
  }), 1);
  assert.equal(prewarmCalls.length, 2);
  assert.equal(prewarmCalls[0].editable.canvas, activeLayerCanvas);
  assert.equal(prewarmCalls[0].editable.layerMode, true);
  assert.equal(prewarmCalls[0].options.material, activeMaterial);
  assert.equal(prewarmCalls[1].editable.canvas, activeBaseCanvas);
  assert.equal(prewarmCalls[1].editable.layerMode, false);
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
      device,
      textureUtils: {
        _generateMipmaps() {}
      }
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
  assert.deepEqual(status.liveProjectedBackend, { backend: "webgpu", webGpuStatus: "ready" });
  assert.equal(status.deviceReady, true);
  assert.equal(status.airbrushReady, true);
  assert.equal(status.liveProjectedAirbrushReady, true);
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
      device,
      textureUtils: {
        _generateMipmaps() {}
      }
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

test("installed airbrush WebGPU rendered snapshot is debug-gated", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  assert.equal(typeof editor.textureAirbrushExposeRenderedSnapshot, "function");
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: { search: "" }
  };
  try {
    assert.equal(await editor.textureAirbrushExposeRenderedSnapshot(), null);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
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
  assert.match(payload.source, /visibilitySamples/);
  assert.equal(payload.plan.buffers.uniform.data.byteLength, 128);
  assert.equal(
    payload.plan.buffers.strokes.data.length,
    TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS * TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS
  );

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

test("installed airbrush WebGPU live path caps ordered visibility probes", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  let capturedOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({});
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => {
    capturedOptions = options;
    return [];
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 120,
    clientY: 64,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    directVisibilityOnly: false,
    radiusPixels: 48,
    strokeStart: { clientX: 40, clientY: 64 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 64 },
      end: { clientX: 120, clientY: 64 }
    }]
  });

  assert.equal(changed, 0);
  assert.equal(capturedOptions.useVisibilityTrianglePaintRegions, true);
  assert.equal(capturedOptions.maxVisibilityProbePoints, 7);
  assert.equal(capturedOptions.maxVisibilityFootprintProbePoints, 53);
  assert.equal(capturedOptions.denseVisibilityFootprintProbes, true);
});

test("installed airbrush WebGPU large live brushes use full projected footprint visibility", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  let capturedOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({});
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => {
    capturedOptions = options;
    return [];
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 130,
    clientY: 80,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    radiusPixels: 52,
    strokeStart: { clientX: 40, clientY: 80 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 80 },
      end: { clientX: 130, clientY: 80 }
    }]
  });

  assert.equal(changed, 0);
  assert.equal(capturedOptions.directVisibilityOnly, true);
  assert.equal(capturedOptions.useVisibilityTrianglePaintRegions, true);
  assert.equal(capturedOptions.fullBrushVisibilityProbes, undefined);
  assert.equal(capturedOptions.keepVisibilitySamplesWithTriangles, true);
  assert.equal(capturedOptions.maxVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_LARGE_LIVE_TRIANGLE_CAP);
  assert.equal(capturedOptions.maxProbeVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_LARGE_LIVE_TRIANGLE_CAP);
  assert.equal(capturedOptions.maxMergedVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_LARGE_LIVE_TRIANGLE_CAP);
  assert.equal(capturedOptions.maxLiveBatchAreaPixels, 4_000_000);
  assert.equal(capturedOptions.denseVisibilityFootprintProbes, undefined);
  assert.equal(capturedOptions.maxVisibilityProbePoints, undefined);
  assert.equal(capturedOptions.maxVisibilityFootprintProbePoints, undefined);
});

test("installed airbrush WebGPU reset strokes use full projected footprint visibility", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  let capturedOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({});
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => {
    capturedOptions = options;
    return [];
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 42,
    clientY: 80,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    radiusPixels: 28,
    strokeReset: true,
    strokeStart: { clientX: 40, clientY: 80 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 80 },
      end: { clientX: 42, clientY: 80 }
    }]
  });

  assert.equal(changed, 0);
  assert.equal(capturedOptions.directVisibilityOnly, true);
  assert.equal(capturedOptions.fullBrushVisibilityProbes, undefined);
  assert.equal(capturedOptions.maxVisibilityFootprintProbePoints, undefined);
  assert.equal(capturedOptions.maxVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_LARGE_LIVE_TRIANGLE_CAP);
});

test("installed airbrush WebGPU large reset point stamps use projected footprint visibility", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  let capturedOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({});
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => {
    capturedOptions = options;
    return [];
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 80,
    clientY: 80,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    radiusPixels: 48,
    strokeReset: true,
    strokeSegments: [{
      start: { clientX: 80, clientY: 80 },
      end: { clientX: 80, clientY: 80 }
    }]
  });

  assert.equal(changed, 0);
  assert.equal(capturedOptions.directVisibilityOnly, true);
  assert.equal(capturedOptions.fullBrushVisibilityProbes, undefined);
  assert.equal(capturedOptions.maxVisibilityFootprintProbePoints, undefined);
  assert.equal(capturedOptions.maxVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_LARGE_LIVE_TRIANGLE_CAP);
});

test("installed airbrush WebGPU large continuation point stamps use projected footprint visibility", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  let capturedOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({});
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => {
    capturedOptions = options;
    return [];
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 80,
    clientY: 80,
    pointerType: "pen",
    pressure: 1,
    button: 0,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    visibleSurfaceMaskRequired: true,
    requireVisibilityMask: true,
    radiusPixels: 48,
    strokeSegments: [{
      start: { clientX: 80, clientY: 80 },
      end: { clientX: 80, clientY: 80 }
    }]
  });

  assert.equal(changed, 0);
  assert.equal(capturedOptions.directVisibilityOnly, true);
  assert.equal(capturedOptions.fullBrushVisibilityProbes, undefined);
});

test("installed airbrush WebGPU live path starts GPU paint from compact visible samples", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    0, 0, 0, 0,
    255, 0, 0, 128
  ], 0);
  let releaseReadback = () => {};
  let readbackStarted = 0;
  const blockedReadback = new Promise((resolve) => {
    releaseReadback = resolve;
  });
  const device = fakeWebGpuDevice({
    readbackMappedData: mapped,
    mapAsync: () => {
      readbackStarted += 1;
      return blockedReadback;
    }
  });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live" };
  const record = {
    id: "record-live",
    geometry: {
      attributes: {
        uv: {
          count: 3,
          getX(index) {
            return [0, 1, 1][index];
          },
          getY(index) {
            return [0, 0, 1][index];
          }
        }
      }
    }
  };
  const hit = {
    uv: { x: 1, y: 0 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const { editable, state } = fakeEditableTexture(2, 1, new Uint8Array(2 * 1 * 4));
  material.map = editable.texture;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  let generatedMipTexture = null;
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
      device,
      textureUtils: {
        _generateMipmaps(texture) {
          generatedMipTexture = texture;
        }
      }
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
  const externalTexture = { userData: {} };
  let externalTextureArgs = null;
  editor.textureAirbrushCreateExternalWebGpuTexture = (gpuTexture, referenceTexture, textureOptions) => {
    externalTextureArgs = { gpuTexture, referenceTexture, textureOptions };
    return externalTexture;
  };

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 10,
    clientY: 10
  }, {
    mapRead: 1,
    visibleSurfaceMaskRequired: true,
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibilityMaskStampRadiusPixels: 1,
    visibilityMaskThreshold: 0.5,
    visibilityFeatherRadius: 0,
    visibilityBleedRadius: 0
  });

  assert.ok(estimate > 0);
  assert.equal((editor.textureAirbrushQueuedWebGpuStrokes || []).length, 1);
  assert.equal(editor.capturedUndo, undefined);
  assert.equal(editor.markedChanged, undefined);
  assert.equal(device.calls.filter((call) => call[0] === "dispatchWorkgroups").length, 0);

  const flushPromise = editor.flushTextureAirbrushQueuedWebGpuStrokes();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal((editor.textureAirbrushQueuedWebGpuStrokes || []).length, 0);
  assert.equal(editor.capturedUndo, true);
  assert.equal(device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && call[1] === "texture-airbrush-editable-compute-pass"
  )).length, 1);
  assert.equal(
    device.calls.some((call) => call[0] === "writeTexture" && call[6] === "texture-airbrush-editable-visibility-mask-texture"),
    false
  );
  assert.equal(
    device.calls.some((call) => call[0] === "writeBuffer" && call[4] === TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS * 4 * 4),
    false
  );
  assert.ok(
    device.calls.some((call) => call[0] === "writeBuffer" && call[4] > 0 && call[4] < TEXTURE_AIRBRUSH_WEBGPU_MAX_BUFFER_SEGMENTS * 4 * 4)
  );

  assert.equal(material.map, externalTexture);
  assert.ok(externalTextureArgs);
  const liveCache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  assert.equal(externalTextureArgs.gpuTexture, liveCache.resources.sourceTexture);
  assert.equal(externalTextureArgs.referenceTexture, editable.texture);
  assert.equal(externalTextureArgs.textureOptions.mipmapped, true);
  assert.equal(generatedMipTexture, null);
  assert.equal(editor.refreshedTextures, undefined);
  assert.equal(editor.updatedPreviews, undefined);
  assert.equal(editor.markedChanged, true);
  await Promise.resolve();
  assert.equal(readbackStarted, 0);
  assert.deepEqual([...state.imageData.data], [
    0, 0, 0, 0,
    0, 0, 0, 0
  ]);
  assert.equal(editable.texture.needsUpdate, undefined);
  assert.equal(material.needsUpdate, true);

  await flushPromise;
  assert.equal(readbackStarted, 0);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToBuffer").length, 0);
  const pendingFlush = editor.flushTextureAirbrushPendingWebGpuPaints();
  for (let index = 0; index < 12 && readbackStarted === 0; index += 1) {
    await Promise.resolve();
  }
  assert.equal(readbackStarted, 1);
  releaseReadback();
  await pendingFlush;
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToBuffer").length, 1);

  assert.equal(editor.textureAirbrushLastWebGpuPaintStats.directLive, undefined);
  assert.ok(editor.textureAirbrushLastWebGpuPaintStats.visibilitySampleCount > 0);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats.liveDisplayExternalTexture, true);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats.deferredReadback, true);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats.reusedReadbackBuffer, false);
  assert.deepEqual([...state.imageData.data], [
    0, 0, 0, 0,
    255, 0, 0, 128
  ]);
  assert.equal(editable.texture.needsUpdate, true);
  assert.equal(material.map, externalTexture);
  assert.equal(material.userData.textureAirbrushWebGpuExternalMap, externalTexture);
  assert.equal(material.userData.textureAirbrushWebGpuCanvasMap, editable.texture);
  assert.equal(externalTexture.userData.textureAirbrushExternalWebGpuDisplay, true);
  assert.equal(externalTexture.userData.textureAirbrushWebGpuCanvasMap, editable.texture);
  assert.notEqual(externalTexture.needsUpdate, true);
  assert.equal(editor.refreshedTextures, true);
  assert.equal(editor.updatedPreviews, true);
});

test("editable WebGPU live paint reuses an already active external display texture", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  editable.texture.anisotropy = 4;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {
        _generateMipmaps() {}
      }
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  editor.textureAirbrushPrewarmEditableWebGpuPaint(editable, {
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const displayCopy = editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });
  await displayCopy;
  const externalTexture = { userData: {}, colorSpace: "srgb-linear" };
  externalTexture.isExternalTexture = true;
  externalTexture.version = 1;
  externalTexture.needsUpdate = false;
  externalTexture.minFilter = "linear-filter";
  externalTexture.generateMipmaps = false;
  externalTexture.anisotropy = 1;
  cache.externalDisplayGpuTexture = cache.liveDisplayCopy.displayTexture;
  cache.externalDisplayTexture = externalTexture;
  let created = 0;
  editor.textureAirbrushCreateExternalWebGpuTexture = () => {
    created += 1;
    return null;
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(material.map, externalTexture);
  assert.equal(material.userData.textureAirbrushWebGpuExternalMap, externalTexture);
  assert.equal(material.map.colorSpace, "srgb-linear");
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(material.map.anisotropy, 4);
  assert.equal(material.map.userData.textureAirbrushDisplayMipmapped, true);
  assert.equal(material.map.needsUpdate, false);
  assert.equal(material.map.version, 1);
  assert.equal(material.needsUpdate, true);
  assert.equal(created, 1);
});

test("editable WebGPU live display replaces initialized external texture when mipmap contract changes", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(16 * 16 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(16, 16, new Uint8Array(16 * 16 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {}
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 1;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const created = [];
  editor.textureAirbrushCreateExternalWebGpuTexture = (gpuTexture, referenceTexture, textureOptions) => {
    const texture = {
      isExternalTexture: true,
      version: created.length === 0 ? 1 : 0,
      userData: {},
      name: textureOptions?.name || "",
      colorSpace: textureOptions?.colorSpace ?? referenceTexture?.colorSpace,
      flipY: textureOptions?.flipY ?? referenceTexture?.flipY,
      minFilter: textureOptions?.mipmapped === true ? referenceTexture?.minFilter : "linear-filter",
      generateMipmaps: textureOptions?.mipmapped === true,
      needsUpdate: true
    };
    created.push({ gpuTexture, referenceTexture, textureOptions, texture });
    return texture;
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });
  const firstExternalTexture = material.map;
  assert.equal(created.length, 1);
  assert.equal(created[0].textureOptions?.mipmapped, true);
  assert.equal(firstExternalTexture.generateMipmaps, true);

  editor.painting = true;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapImmediatePixels: 0,
    liveDisplayMipmapDelayMs: 0,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 1, y: 1, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);

  assert.equal(result?.stats?.liveDisplayMipmapDeferred, true);
  assert.equal(result?.stats?.liveDisplayMipmapPixels, 0);
  assert.equal(created.length, 2);
  assert.equal(created[1].textureOptions?.mipmapped, false);
  assert.notEqual(material.map, firstExternalTexture);
  assert.equal(material.map, created[1].texture);
  assert.equal(material.map.generateMipmaps, false);
  assert.equal(material.map.userData.textureAirbrushExternalWebGpuDisplay, true);
  assert.equal(cache.externalDisplayTexture, material.map);
  assert.equal(firstExternalTexture.needsUpdate, true);
  editor.painting = false;
  await new Promise((resolve) => setTimeout(resolve, 64));
  await Promise.resolve();
});

test("editable WebGPU deferred live display refresh reuses display-copy texture", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {
        _generateMipmaps() {}
      }
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  editor.textureAirbrushPrewarmEditableWebGpuPaint(editable, {
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const externalTexture = {
    userData: {
      textureAirbrushExternalWebGpuDisplay: true
    }
  };
  externalTexture.isExternalTexture = true;
  cache.externalDisplayGpuTexture = cache.liveDisplayCopy.displayTexture;
  cache.externalDisplayTexture = externalTexture;
  material.map = externalTexture;
  const liveDisplayPassesBefore = device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("texture-airbrush-live-display")
  )).length;

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  const liveDisplayPassesAfter = device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("texture-airbrush-live-display")
  )).length;
  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayWorkPixels, 0);
  assert.deepEqual(cache.deferredLiveDisplayDirtyBounds, {
    x: 0,
    y: 0,
    width: 2,
    height: 2
  });
  assert.equal(material.map, externalTexture);
  assert.equal(liveDisplayPassesAfter, liveDisplayPassesBefore);

  const refreshed = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }]
  });

  assert.equal(refreshed?.stats?.liveDisplayExternalTexture, true);
  assert.equal(cache.deferredLiveDisplayDirtyBounds, null);
});

test("editable WebGPU deferred live display avoids huge UV-space dirty unions", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {
        _generateMipmaps() {}
      }
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 1;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  editor.textureAirbrushPrewarmEditableWebGpuPaint(editable, {
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 0, y: 0, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const externalTexture = {
    userData: {
      textureAirbrushExternalWebGpuDisplay: true
    }
  };
  externalTexture.isExternalTexture = true;
  cache.externalDisplayGpuTexture = cache.liveDisplayCopy.displayTexture;
  cache.externalDisplayTexture = externalTexture;
  material.map = externalTexture;

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 0, y: 0, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });
  const deferredBeforeFarStroke = cache.deferredLiveDisplayDirtyBounds;
  const liveDisplayPassesBeforeFarStroke = device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("texture-airbrush-live-display")
  )).length;

  const farResult = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 62, y: 62, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 62, y: 62 }, end: { x: 63, y: 63 } }]
  });
  const liveDisplayPassesAfterFarStroke = device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("texture-airbrush-live-display")
  )).length;

  assert.deepEqual(deferredBeforeFarStroke, {
    x: 0,
    y: 0,
    width: 2,
    height: 2
  });
  assert.equal(farResult?.stats?.liveDisplayExternalTexture, true);
  assert.equal(liveDisplayPassesAfterFarStroke, liveDisplayPassesBeforeFarStroke);
  assert.equal(farResult?.stats?.liveDisplayWorkPixels, 0);
  assert.deepEqual(cache.deferredLiveDisplayDirtyBounds, {
    x: 0,
    y: 0,
    width: 64,
    height: 64
  });
  assert.deepEqual(cache.deferredLiveDisplayDirtyRegions, [
    {
      x: 0,
      y: 0,
      width: 2,
      height: 2
    },
    {
      x: 62,
      y: 62,
      width: 2,
      height: 2
    }
  ]);

  const liveDisplayPassesBeforeRefresh = device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("texture-airbrush-live-display")
  )).length;
  const refreshed = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 31, y: 31, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 31, y: 31 }, end: { x: 32, y: 32 } }]
  });
  const liveDisplayPassesAfterRefresh = device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("texture-airbrush-live-display")
  )).length;

  assert.equal(refreshed?.stats?.liveDisplayExternalTexture, true);
  assert.ok(liveDisplayPassesAfterRefresh > liveDisplayPassesBeforeRefresh);
  assert.ok(refreshed?.stats?.liveDisplayWorkPixels > 0);
  assert.ok(
    refreshed?.stats?.liveDisplayWorkPixels < 64 * 64 * 0.1,
    `expected low region work, got ${refreshed?.stats?.liveDisplayWorkPixels}`
  );
  assert.equal(cache.deferredLiveDisplayDirtyBounds, null);
  assert.equal(cache.deferredLiveDisplayDirtyRegions, null);
  assert.ok(cache.lastLiveDisplayStats?.displayRegions?.length >= 2);
});

test("editable WebGPU live display copy fully refreshes after source texture handoff", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  const externalTexture = {
    isExternalTexture: true,
    version: 1,
    userData: {
      textureAirbrushExternalWebGpuDisplay: true,
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: "linear-mipmap-linear"
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 1;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 0, y: 0, width: 4, height: 4 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  assert.equal(cache.liveDisplayCopy.initialized, true);
  cache.externalDisplayGpuTexture = cache.liveDisplayCopy.displayTexture;
  cache.externalDisplayTexture = externalTexture;
  material.map = externalTexture;
  cache.liveDisplayCopy.bindGroupSourceTexture = cache.liveDisplayCopy.displayTexture;
  const callsBefore = device.calls.length;

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapImmediatePixels: 0,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    forceLiveDisplayDirtyRegions: true,
    displayDirtyRegions: [
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 60, y: 60, width: 4, height: 4 }
    ],
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 63, y: 63 } }]
  });
  const displayDispatches = device.calls.slice(callsBefore).filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("live-display-copy-compute-pass")
  ));

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayFullUpdate, true);
  assert.equal(result?.stats?.liveDisplayWorkPixels, 64 * 64);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.ok(result?.stats?.liveDisplayMipmapPixels > 0);
  assert.equal(cache.liveDisplayCopy.updatedDisplayRegions, null);
  assert.deepEqual(cache.liveDisplayCopy.updatedDisplayBounds, {
    x: 0,
    y: 0,
    width: 64,
    height: 64
  });
  assert.equal(displayDispatches.length, 1);
});

test("editable WebGPU active live display refresh skips deferred dirty union", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {
        _generateMipmaps() {}
      }
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 1;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  editor.textureAirbrushPrewarmEditableWebGpuPaint(editable, {
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 0, y: 0, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const externalTexture = {
    userData: {
      textureAirbrushExternalWebGpuDisplay: true
    }
  };
  externalTexture.isExternalTexture = true;
  cache.externalDisplayGpuTexture = cache.liveDisplayCopy.displayTexture;
  cache.externalDisplayTexture = externalTexture;
  material.map = externalTexture;

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 0, y: 0, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayRefresh: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 62, y: 62, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 62, y: 62 }, end: { x: 63, y: 63 } }]
  });

  assert.deepEqual(cache.deferredLiveDisplayDirtyBounds, {
    x: 0,
    y: 0,
    width: 64,
    height: 64
  });
  assert.equal(cache.deferredLiveDisplayDirtyRegions.length, 2);

  const refreshed = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    liveDisplayIncludeDeferredDirtyRegions: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 31, y: 31, width: 2, height: 2 },
    strokeSegments: [{ start: { x: 31, y: 31 }, end: { x: 32, y: 32 } }]
  });

  assert.equal(refreshed?.stats?.liveDisplayExternalTexture, true);
  assert.ok(
    refreshed?.stats?.liveDisplayWorkPixels < 64 * 64 * 0.1,
    `expected local active display work, got ${refreshed?.stats?.liveDisplayWorkPixels}`
  );
  assert.deepEqual(cache.deferredLiveDisplayDirtyBounds, {
    x: 0,
    y: 0,
    width: 64,
    height: 64
  });
  assert.equal(cache.deferredLiveDisplayDirtyRegions.length, 2);
  assert.notDeepEqual(cache.lastLiveDisplayStats?.displayBounds, {
    x: 0,
    y: 0,
    width: 64,
    height: 64
  });
});

test("direct editable WebGPU live display paint defaults to deferred copy", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.fill(120);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(4, 4, new Uint8Array(4 * 4 * 4));
  editable.texture.colorSpace = "srgb";
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  const externalTexture = { userData: {} };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }]
  });

  assert.equal(result?.stats?.deferredReadback, true);
  assert.equal(result?.stats?.deferredReadbackCopy, true);
  assert.equal(result?.readbackPromise, null);
  assert.equal(result?.stats?.readbackBytes, 0);
  assert.equal(result?.stats?.appliedBytes, 0);
  assert.equal(state.putCalls.length, 0);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToBuffer").length, 0);

  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });

  assert.equal(sync.length, 1);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToBuffer").length, 1);
  assert.equal(state.putCalls.length, 1);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats.deferredCanvasSync, true);
  assert.ok(editor.textureAirbrushLastWebGpuPaintStats.readbackBytes > 0);
});

test("direct editable WebGPU live display coalesces paint display and mipmaps into one submit", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 30, y: 32 }, end: { x: 34, y: 32 } }]
  });
  const submitCalls = device.calls.filter((call) => call[0] === "submit");
  const commandEncoders = device.calls.filter((call) => call[0] === "createCommandEncoder");

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.equal(result?.stats?.liveDisplayMipmapDowngraded, false);
  assert.equal(result?.stats?.readbackBytes, 0);
  assert.equal(submitCalls.length, 1);
  assert.equal(commandEncoders.length, 1);
  assert.ok(String(commandEncoders[0][1]).includes("live-command-encoder"));
});

test("deferred editable WebGPU sync preserves earlier readbacks when a newer stroke arrives", async () => {
  class TestEditor {}
  let editor = null;
  let editable = null;
  let paintOptions = null;
  let paintedDuringReadback = false;
  const mapped = new Uint8Array(4 * 256);
  mapped.fill(120);
  const device = fakeWebGpuDevice({
    readbackMappedData: mapped,
    mapAsync: async () => {
      if (paintedDuringReadback || !editor || !editable || !paintOptions) {
        return;
      }
      paintedDuringReadback = true;
      await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
        ...paintOptions,
        strokeSegments: [{ start: { x: 2, y: 1 }, end: { x: 3, y: 1 } }]
      });
    }
  });
  installTextureAirbrushWebGpuMethods(TestEditor);
  editor = new TestEditor();
  const fixture = fakeEditableTexture(4, 4, new Uint8Array(4 * 4 * 4));
  editable = fixture.editable;
  const { state } = fixture;
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  paintOptions = {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }]
  };

  const firstRun = await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);

  assert.equal(firstRun?.stats?.deferredReadbackCopy, true);
  assert.equal(cache.gpuSourceRevision, 1);
  assert.equal(state.putCalls.length, 0);

  const firstSync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });

  assert.equal(paintedDuringReadback, true);
  assert.equal(cache.gpuSourceRevision, 2);
  assert.equal(firstSync.length, 1);
  assert.ok(firstSync[0].applied);
  assert.equal(firstSync[0].stats.staleReadbackSkipped, undefined);
  assert.equal(state.putCalls.length, 1);
  assert.equal(cache.deferredReadbackApplyPending, true);

  const secondSync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });

  assert.equal(secondSync.length, 1);
  assert.ok(secondSync[0].applied);
  assert.equal(secondSync[0].stats.staleReadbackSkipped, undefined);
  assert.equal(state.putCalls.length, 2);
  assert.equal(cache.deferredReadbackApplyPending, false);
  assert.equal(cache.strokeSourceMatchesSource, true);
});

test("deferred editable WebGPU sync drops stale precopies when another stroke paints first", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(4 * 256);
  mapped.fill(140);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(8, 8, new Uint8Array(8 * 8 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  const firstStrokeOptions = {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 2, y: 2 }, end: { x: 3, y: 2 } }]
  };
  const secondStrokeOptions = {
    ...firstStrokeOptions,
    deferReadbackPrecopy: false,
    refreshStrokeSource: true,
    strokeSegments: [{ start: { x: 5, y: 5 }, end: { x: 6, y: 5 } }]
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, firstStrokeOptions);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const copiesAfterFirstStroke = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;

  assert.equal(cache?.gpuSourceRevision, 1);
  assert.equal(cache?.deferredCanvasSync?.sourceRevision, 1);
  assert.equal(cache?.deferredCanvasSync?.readbackCopies?.length, 1);
  assert.equal(copiesAfterFirstStroke, 1);

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, secondStrokeOptions);

  assert.equal(cache.gpuSourceRevision, 2);
  assert.equal(cache.deferredCanvasSync.sourceRevision, 2);
  assert.equal(cache.deferredCanvasSync.readbackCopies.length, 0);
  assert.equal(device.calls.filter((call) => call[0] === "copyTextureToBuffer").length, copiesAfterFirstStroke);

  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copiesAfterSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;

  assert.equal(sync.length, 1);
  assert.equal(copiesAfterSync, copiesAfterFirstStroke + 1);
  assert.equal(state.putCalls.length, 1);
  assert.equal(cache.deferredReadbackApplyPending, false);
});

test("deferred editable WebGPU sync pre-copies medium dirty regions by default", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(768 * 256);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(512, 512, new Uint8Array(512 * 512 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: true,
    paintBounds: { x: 64, y: 96, width: 160, height: 256 },
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 80, y: 128 }, end: { x: 180, y: 256 } }]
  });

  const copiesBeforeSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copiesAfterSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;

  assert.ok(copiesBeforeSync > 1);
  assert.equal(copiesAfterSync, copiesBeforeSync);
  assert.equal(sync.length, copiesBeforeSync);
  assert.equal(state.putCalls.length, copiesBeforeSync);
});

test("deferred editable WebGPU sync combines pre-copied and generated dirty regions", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 32);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(128, 16, new Uint8Array(128 * 16 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  const paintOptions = {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 }
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    ...paintOptions,
    deferReadbackPrecopy: false,
    strokeSegments: [{ start: { x: 4, y: 8 }, end: { x: 6, y: 8 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    ...paintOptions,
    deferReadbackPrecopy: true,
    strokeSegments: [{ start: { x: 116, y: 8 }, end: { x: 118, y: 8 } }]
  });

  const copiesBeforeSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyOrigins = copyCalls.map((call) => call[6]);

  assert.equal(copiesBeforeSync, 1);
  assert.equal(copyCalls.length, 2);
  assert.equal(sync.length, 2);
  assert.equal(state.putCalls.length, 2);
  assert.ok(Math.min(...copyOrigins) < 16);
  assert.ok(Math.max(...copyOrigins) > 100);
});

test("deferred editable WebGPU sync batches multiple dirty region readbacks", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 32);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(128, 16, new Uint8Array(128 * 16 * 4));
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
  const paintOptions = {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 }
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    ...paintOptions,
    strokeSegments: [{ start: { x: 4, y: 8 }, end: { x: 6, y: 8 } }]
  });
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    ...paintOptions,
    strokeSegments: [{ start: { x: 116, y: 8 }, end: { x: 118, y: 8 } }]
  });
  const copiesBeforeSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;

  let syncClock = 0;
  let syncYieldCount = 0;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({
    mapRead: 1,
    canvasSyncApplyBudgetMs: 1,
    now: () => {
      syncClock += 2;
      return syncClock;
    },
    canvasSyncYield: () => {
      syncYieldCount += 1;
    }
  });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const batchEncoders = device.calls.filter((call) => (
    call[0] === "createCommandEncoder"
    && call[1] === "texture-airbrush-deferred-sync-batch-command-encoder"
  ));

  assert.equal(copiesBeforeSync, 0);
  assert.equal(copyCalls.length, 2);
  assert.equal(batchEncoders.length, 1);
  assert.equal(sync.length, 2);
  assert.ok(sync.every((result) => result?.applied));
  assert.equal(syncYieldCount, 1);
  assert.equal(state.putCalls.length, 2);
});

test("deferred editable WebGPU sync honors explicit disjoint regions from one broad paint run", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 32);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(128, 16, new Uint8Array(128 * 16 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 128, height: 16 },
    deferredCanvasSyncRegions: [
      { x: 4, y: 8, width: 4, height: 4 },
      { x: 116, y: 8, width: 4, height: 4 }
    ],
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 4, y: 8 }, end: { x: 118, y: 8 } }]
  });

  const copiesBeforeSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyOrigins = copyCalls.map((call) => call[6]);
  const copyWidths = copyCalls.map((call) => call[4]);

  assert.equal(copiesBeforeSync, 0);
  assert.equal(copyCalls.length, 2);
  assert.equal(sync.length, 2);
  assert.deepEqual([...copyOrigins].sort((left, right) => left - right), [4, 116]);
  assert.ok(copyWidths.every((width) => width === 4));
  assert.equal(state.putCalls.length, 2);
});

test("deferred editable WebGPU sync merges overlapping dirty regions before readback", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 32);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(128, 16, new Uint8Array(128 * 16 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 128, height: 16 },
    deferredCanvasSyncRegions: [
      { x: 24, y: 4, width: 12, height: 8 },
      { x: 30, y: 6, width: 12, height: 8 }
    ],
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 24, y: 8 }, end: { x: 42, y: 8 } }]
  });

  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");

  assert.equal(copyCalls.length, 1);
  assert.equal(sync.length, 1);
  assert.equal(copyCalls[0][6], 24);
  assert.equal(copyCalls[0][7], 4);
  assert.equal(copyCalls[0][4], 18);
  assert.equal(copyCalls[0][5], 10);
  assert.equal(state.putCalls.length, 1);
});

test("deferred editable WebGPU sync tiles large pre-copied dirty regions", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 128);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    liveDisplayExternalTexture: false,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: true,
    deferredCanvasSyncTileBytes: 2048,
    radiusPixels: 32,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 4, y: 32 }, end: { x: 60, y: 32 } }]
  });

  const copiesBeforeSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({
    mapRead: 1,
    deferredCanvasSyncTileBytes: 2048
  });
  const copiesAfterSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;

  assert.ok(copiesBeforeSync > 1);
  assert.equal(copiesAfterSync, copiesBeforeSync);
  assert.equal(sync.length, copiesBeforeSync);
  assert.equal(state.putCalls.length, copiesBeforeSync);
});

test("deferred editable WebGPU sync tiles large generated dirty readbacks", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256 * 128);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 64, height: 64 },
    radiusPixels: 32,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 4, y: 32 }, end: { x: 60, y: 32 } }]
  });

  const copiesBeforeSync = device.calls.filter((call) => call[0] === "copyTextureToBuffer").length;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({
    mapRead: 1,
    deferredCanvasSyncTileBytes: 2048
  });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyHeights = copyCalls.map((call) => call[5]);

  assert.equal(copiesBeforeSync, 0);
  assert.ok(copyCalls.length > 1);
  assert.equal(sync.length, copyCalls.length);
  assert.ok(copyHeights.every((height) => height <= 8));
  assert.equal(state.putCalls.length, copyCalls.length);
  assert.ok(sync.every((result) => Number(result?.stats?.readbackBytes) <= 2048));
});

test("deferred editable WebGPU live sync defaults to coarse generated readback tiles", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(1024 * 64);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(256, 256, new Uint8Array(256 * 256 * 4));
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 128;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 256, height: 256 },
    deferredCanvasSyncRegions: [{ x: 0, y: 0, width: 256, height: 256 }],
    radiusPixels: 128,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 128 }, end: { x: 255, y: 128 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  cache.deferredCanvasSync.liveDisplayExternalTexture = true;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyHeights = copyCalls.map((call) => call[5]);

  assert.equal(copyCalls.length, 1);
  assert.equal(sync.length, copyCalls.length);
  assert.deepEqual(copyHeights, [256]);
  assert.equal(state.putCalls.length, copyCalls.length);
  assert.ok(sync.every((result) => Number(result?.stats?.readbackBytes) <= 512 * 1024));
});

test("deferred editable WebGPU live sync keeps four-megabyte tiles together", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(4 * 1024 * 1024);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(1024, 1024, new Uint8Array(1024 * 1024 * 4));
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 512;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 1024, height: 1024 },
    deferredCanvasSyncRegions: [{ x: 0, y: 0, width: 1024, height: 1024 }],
    radiusPixels: 512,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 512 }, end: { x: 1023, y: 512 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  cache.deferredCanvasSync.liveDisplayExternalTexture = true;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({
    mapRead: 1,
    deferCanvasSyncUntilIdle: true
  });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyHeights = copyCalls.map((call) => call[5]);

  assert.equal(copyCalls.length, 1);
  assert.equal(sync.length, 1);
  assert.deepEqual(copyHeights, [1024]);
  assert.equal(state.putCalls.length, 1);
  assert.equal(Number(sync[0]?.stats?.readbackBytes), 4 * 1024 * 1024);
});

test("deferred editable WebGPU live sync yields between explicit unbounded four-megabyte chunks", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(4 * 1024 * 1024);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(1024, 2048, new Uint8Array(1024 * 2048 * 4));
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 512;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 1024, height: 2048 },
    deferredCanvasSyncRegions: [{ x: 0, y: 0, width: 1024, height: 2048 }],
    radiusPixels: 512,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 1024 }, end: { x: 1023, y: 1024 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  cache.deferredCanvasSync.liveDisplayExternalTexture = true;
  let syncClock = 0;
  let syncYieldCount = 0;
  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({
    mapRead: 1,
    deferCanvasSyncUntilIdle: true,
    deferredCanvasSyncMaxTiles: false,
    now: () => {
      syncClock += 5;
      return syncClock;
    },
    canvasSyncYield: () => {
      syncYieldCount += 1;
    }
  });
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyHeights = copyCalls.map((call) => call[5]);

  assert.equal(copyCalls.length, 2);
  assert.equal(sync.length, 2);
  assert.deepEqual(copyHeights, [1024, 1024]);
  assert.equal(syncYieldCount, 1);
  assert.equal(state.putCalls.length, 2);
  assert.ok(sync.every((result) => Number(result?.stats?.readbackBytes) === 4 * 1024 * 1024));
});

test("deferred editable WebGPU live sync defaults to one one-megabyte active catch-up chunk per pass", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(1024 * 1024);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(1024, 512, new Uint8Array(1024 * 512 * 4));
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 512;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 1024, height: 512 },
    deferredCanvasSyncRegions: [{ x: 0, y: 0, width: 1024, height: 512 }],
    radiusPixels: 512,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 256 }, end: { x: 1023, y: 256 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  cache.deferredCanvasSync.liveDisplayExternalTexture = true;
  const firstSync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const firstCopyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");

  assert.equal(firstCopyCalls.length, 1);
  assert.equal(firstSync.length, 1);
  assert.equal(firstCopyCalls[0][5], 256);
  assert.equal(state.putCalls.length, 1);
  assert.equal(Number(firstSync[0]?.stats?.readbackBytes), 1024 * 1024);
  assert.equal(cache.deferredReadbackApplyPending, true);
  assert.equal(editor.textureAirbrushDeferredWebGpuCanvasSyncCaches?.has(cache), true);

  const secondSync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({ mapRead: 1 });
  const allCopyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");

  assert.equal(allCopyCalls.length, 2);
  assert.equal(secondSync.length, 1);
  assert.equal(allCopyCalls[1][5], 256);
  assert.equal(state.putCalls.length, 2);
  assert.equal(cache.deferredReadbackApplyPending, false);
});

test("deferred editable WebGPU live sync keeps over-budget catch-up tiled and pending", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(1024 * 2);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable, state } = fakeEditableTexture(256, 256, new Uint8Array(256 * 256 * 4));
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 128;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    paintBounds: { x: 0, y: 0, width: 256, height: 256 },
    deferredCanvasSyncRegions: [{ x: 0, y: 0, width: 256, height: 256 }],
    radiusPixels: 128,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 128 }, end: { x: 255, y: 128 } }]
  });

  const sync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({
    mapRead: 1,
    deferredCanvasSyncTileBytes: 2048,
    deferredCanvasSyncMaxTiles: 4
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const copyCalls = device.calls.filter((call) => call[0] === "copyTextureToBuffer");
  const copyHeights = copyCalls.map((call) => call[5]);

  assert.equal(copyCalls.length, 4);
  assert.equal(sync.length, 4);
  assert.ok(copyHeights.every((height) => height <= 2));
  assert.equal(state.putCalls.length, 4);
  assert.equal(cache.deferredReadbackApplyPending, true);
  assert.ok(cache.deferredCanvasSync?.regions?.length > 0);

  const secondSync = await editor.textureAirbrushSyncDeferredWebGpuCanvases({
    mapRead: 1,
    deferredCanvasSyncTileBytes: 2048
  });

  assert.ok(secondSync.length > 4);
  assert.equal(cache.deferredReadbackApplyPending, false);
  assert.equal(cache.deferredCanvasSync, undefined);
});

test("deferred editable WebGPU sync caps queued dirty regions", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(512 * 32);
  mapped.fill(180);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(512, 16, new Uint8Array(512 * 16 * 4));
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
  const paintOptions = {
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferReadbackPrecopy: false,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 }
  };

  for (let index = 0; index < 24; index += 1) {
    const x = 8 + index * 20;
    await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
      ...paintOptions,
      strokeSegments: [{ start: { x, y: 8 }, end: { x: x + 1, y: 8 } }]
    });
  }

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);

  assert.ok(cache?.deferredCanvasSync);
  assert.ok(cache.deferredCanvasSync.regions.length <= 32);
});

test("editable WebGPU live display preserves mipmapped quality when dirty mipmap refresh misses", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  editable.texture.anisotropy = 4;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {}
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const externalTexture = {
    userData: {
      textureAirbrushExternalWebGpuDisplay: true,
      textureAirbrushDisplayMipmapped: true,
      textureAirbrushNonMipmapMinFilter: "linear-filter"
    },
    colorSpace: "srgb-linear",
    minFilter: "linear-mipmap-linear",
    magFilter: "mag-filter",
    anisotropy: 4,
    generateMipmaps: true
  };
  cache.externalDisplayGpuTexture = cache.liveDisplayCopy.displayTexture;
  cache.externalDisplayTexture = externalTexture;
  material.map = externalTexture;
  cache.dirtyMipmapResources.pipeline = null;
  const originalCreateComputePipeline = device.createComputePipeline;
  device.createComputePipeline = (desc) => {
    if (desc.compute.entryPoint === "textureAirbrushGenerateDirtyMipmap") {
      device.calls.push(["createComputePipeline-failed", desc.compute.entryPoint]);
      return null;
    }
    return originalCreateComputePipeline(desc);
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, null);
  assert.equal(result?.stats?.liveDisplayMipmapPixels, 0);
  assert.equal(material.map, externalTexture);
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(material.map.userData.textureAirbrushDisplayMipmapped, true);
  assert.equal(material.map.needsUpdate, true);
});

test("editable WebGPU live display does not install a non-mipmapped first external map for mipmapped sources", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {}
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const originalCreateComputePipeline = device.createComputePipeline;
  device.createComputePipeline = (desc) => {
    if (desc.compute.entryPoint === "textureAirbrushGenerateDirtyMipmap") {
      device.calls.push(["createComputePipeline-failed", desc.compute.entryPoint]);
      return null;
    }
    return originalCreateComputePipeline(desc);
  };
  let created = 0;
  editor.textureAirbrushCreateExternalWebGpuTexture = () => {
    created += 1;
    return { userData: {} };
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, false);
  assert.equal(result?.stats?.liveDisplayMipmapDowngradeBlocked, true);
  assert.equal(material.map, editable.texture);
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(created, 0);
});

test("editable WebGPU live display honors generateMipmaps even without a mipmap minFilter", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.minFilter = "linear-filter";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {}
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const originalCreateComputePipeline = device.createComputePipeline;
  device.createComputePipeline = (desc) => {
    if (desc.compute.entryPoint === "textureAirbrushGenerateDirtyMipmap") {
      device.calls.push(["createComputePipeline-failed", desc.compute.entryPoint]);
      return null;
    }
    return originalCreateComputePipeline(desc);
  };
  let created = 0;
  editor.textureAirbrushCreateExternalWebGpuTexture = () => {
    created += 1;
    return { userData: {} };
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, false);
  assert.equal(result?.stats?.liveDisplayMipmapDowngradeBlocked, true);
  assert.equal(material.map, editable.texture);
  assert.equal(material.map.minFilter, "linear-filter");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(created, 0);
});

test("editable WebGPU live display uses a mipmapped copy for direct source textures", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(4, 4, new Uint8Array(4 * 4 * 4));
  editable.texture.colorSpace = "srgb-linear";
  editable.texture.flipY = false;
  editable.texture.minFilter = "linear-filter";
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {}
    }
  };
  const originalCreateTexture = device.createTexture;
  device.createTexture = (desc) => {
    const texture = originalCreateTexture(desc);
    if (String(desc.label || "").includes("source-texture")) {
      texture.mipLevelCount = 1;
    }
    return texture;
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  let externalTextureArgs = null;
  const externalTexture = { userData: {} };
  editor.textureAirbrushCreateExternalWebGpuTexture = (gpuTexture, referenceTexture, textureOptions) => {
    externalTextureArgs = { gpuTexture, referenceTexture, textureOptions };
    return externalTexture;
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 3, y: 3 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(cache.resources.sourceTexture.mipLevelCount, 1);
  assert.ok(cache.liveDisplayCopy.mipLevelCount > 1);
  assert.equal(externalTextureArgs?.gpuTexture, cache.liveDisplayCopy.displayTexture);
  assert.equal(externalTextureArgs?.referenceTexture, editable.texture);
  assert.equal(externalTextureArgs?.textureOptions?.mipmapped, true);
  assert.equal(material.map, externalTexture);
});

test("editable WebGPU live display trusts descriptor mip levels when native texture hides them", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(4, 4, new Uint8Array(4 * 4 * 4));
  editable.texture.colorSpace = "srgb-linear";
  editable.texture.flipY = false;
  editable.texture.minFilter = "linear-filter";
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {}
    }
  };
  const originalCreateTexture = device.createTexture;
  device.createTexture = (desc) => {
    const texture = originalCreateTexture(desc);
    if (String(desc.label || "").includes("source-texture")) {
      delete texture.mipLevelCount;
    }
    return texture;
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  let externalTextureArgs = null;
  const externalTexture = { userData: {} };
  editor.textureAirbrushCreateExternalWebGpuTexture = (gpuTexture, referenceTexture, textureOptions) => {
    externalTextureArgs = { gpuTexture, referenceTexture, textureOptions };
    return externalTexture;
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 3, y: 3 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(cache.resources.sourceTexture.mipLevelCount, undefined);
  assert.ok(cache.resources.sourceTextureMipLevelCount > 1);
  assert.equal(cache.liveDisplayCopy, undefined);
  assert.equal(externalTextureArgs?.gpuTexture, cache.resources.sourceTexture);
  assert.equal(externalTextureArgs?.referenceTexture, editable.texture);
  assert.equal(externalTextureArgs?.textureOptions?.mipmapped, true);
  assert.equal(material.map, externalTexture);
});

test("editable WebGPU prewarm initializes live display before the first drawing stroke", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  let generatedMipTexture = null;
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {
        _generateMipmaps(texture) {
          generatedMipTexture = texture;
        }
      }
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  let created = 0;
  const externalTexture = { userData: {}, colorSpace: "srgb-linear" };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => {
    created += 1;
    return externalTexture;
  };

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    liveDisplayExternalTexture: true,
    allowPrewarmLiveDisplayMaterialSwap: true,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 32, y: 32 }, end: { x: 32, y: 32 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);

  assert.equal(prewarm?.stats?.liveDisplayExternalTexture, true);
  assert.equal(prewarm?.stats?.liveDisplayFullUpdate, true);
  assert.equal(prewarm?.stats?.liveDisplayWorkPixels, 64 * 64);
  assert.equal(prewarm?.stats?.liveDisplayMipmapDirty, true);
  assert.ok(prewarm?.stats?.liveDisplayMipmapPixels > 0);
  assert.equal(cache.liveDisplayCopy.initialized, true);
  assert.equal(material.map, externalTexture);
  assert.equal(generatedMipTexture, null);
  assert.equal(created, 1);

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 30, y: 32 }, end: { x: 34, y: 32 } }]
  });

  assert.equal(result?.stats?.sourceUploaded, false);
  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayFullUpdate, false);
  assert.ok(result?.stats?.liveDisplayWorkPixels > 0);
  assert.ok(result?.stats?.liveDisplayWorkPixels < 64 * 64 * 0.35);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(created, 1);
  const dirtyMipmapBindGroupsAfterFirstStroke = device.calls.filter((call) => (
    call[0] === "createBindGroup"
    && String(call[2] || "").includes("dirty-mipmap-level")
  )).length;
  assert.ok(dirtyMipmapBindGroupsAfterFirstStroke > 0);
  const liveDisplayCopyBindGroupsAfterFirstStroke = device.calls.filter((call) => (
    call[0] === "createBindGroup"
    && String(call[2] || "").includes("copy-bind-group")
  )).length;
  assert.ok(liveDisplayCopyBindGroupsAfterFirstStroke > 0);

  const secondResult = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 31, y: 32 }, end: { x: 35, y: 32 } }]
  });

  assert.equal(secondResult?.stats?.sourceUploaded, false);
  assert.equal(secondResult?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(device.calls.filter((call) => (
    call[0] === "createBindGroup"
    && String(call[2] || "").includes("dirty-mipmap-level")
  )).length, dirtyMipmapBindGroupsAfterFirstStroke);
  assert.equal(device.calls.filter((call) => (
    call[0] === "createBindGroup"
    && String(call[2] || "").includes("copy-bind-group")
  )).length, liveDisplayCopyBindGroupsAfterFirstStroke);
  assert.equal(created, 1);
});

test("editable WebGPU prewarm stays hot while deferred canvas sync is pending", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {}
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const externalTexture = { userData: {} };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 30, y: 32 }, end: { x: 34, y: 32 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  const sourceRevision = cache.gpuSourceRevision;

  assert.equal(cache.deferredReadbackApplyPending, true);
  assert.notEqual(cache.gpuStrokeSourceRevision, sourceRevision);

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    liveDisplayExternalTexture: true,
    allowPrewarmLiveDisplayMaterialSwap: true,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 32, y: 32 }, end: { x: 32, y: 32 } }]
  });

  assert.ok(prewarm);
  assert.equal(prewarm.stats.strokeSourceCopiedFromSource, true);
  assert.equal(cache.gpuStrokeSourceRevision, sourceRevision);
  assert.equal(cache.deferredReadbackApplyPending, true);
  assert.equal(material.map, externalTexture);
});

test("editable WebGPU live display defers repeat mipmap refresh without hiding fresh paint", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  const material = {
    map: editable.texture,
    userData: {}
  };
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
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true,
      textureAirbrushNonMipmapMinFilter: "linear-filter"
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  const dirtyMipmapPassCount = () => device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("dirty-mipmap-level")
  )).length;

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    liveDisplayExternalTexture: true,
    allowPrewarmLiveDisplayMaterialSwap: true,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 32, y: 32 }, end: { x: 32, y: 32 } }]
  });
  assert.equal(prewarm?.stats?.liveDisplayExternalTexture, true);
  assert.equal(prewarm?.stats?.liveDisplayMipmapDirty, true);
  const mipmapPassesAfterPrewarm = dirtyMipmapPassCount();

  editor.painting = true;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapImmediatePixels: 0,
    liveDisplayMipmapDelayMs: 0,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 30, y: 32 }, end: { x: 34, y: 32 } }]
  });
  const mipmapPassesAfterPaintReturn = dirtyMipmapPassCount();

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, true);
  assert.equal(result?.stats?.liveDisplayMipmapPixels, 0);
  assert.equal(result?.stats?.liveDisplayMipmapDowngraded, true);
  assert.equal(material.map, externalTexture);
  assert.equal(material.map.minFilter, "linear-filter");
  assert.equal(material.map.generateMipmaps, false);
  assert.equal(material.map.userData.textureAirbrushDisplayMipmapped, false);
  assert.equal(mipmapPassesAfterPaintReturn, mipmapPassesAfterPrewarm);

  const secondResult = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapImmediatePixels: 0,
    liveDisplayMipmapDelayMs: 0,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 31, y: 32 }, end: { x: 35, y: 32 } }]
  });

  assert.equal(secondResult?.stats?.liveDisplayExternalTexture, true);
  assert.equal(secondResult?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(secondResult?.stats?.liveDisplayMipmapDeferred, true);
  assert.equal(secondResult?.stats?.liveDisplayMipmapPixels, 0);
  assert.equal(secondResult?.stats?.liveDisplayMipmapDowngraded, true);
  assert.equal(dirtyMipmapPassCount(), mipmapPassesAfterPrewarm);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  assert.equal(dirtyMipmapPassCount(), mipmapPassesAfterPrewarm);

  editor.painting = false;
  await new Promise((resolve) => setTimeout(resolve, 64));
  await Promise.resolve();
  assert.ok(dirtyMipmapPassCount() > mipmapPassesAfterPrewarm);
  assert.equal(material.map, externalTexture);
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(material.map.userData.textureAirbrushDisplayMipmapped, true);
});

test("editable WebGPU live display refreshes small dirty mipmaps during live strokes", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  const material = {
    map: editable.texture,
    userData: {}
  };
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
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  const dirtyMipmapPassCount = () => device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("dirty-mipmap-level")
  )).length;

  textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 32, y: 32 }, end: { x: 32, y: 32 } }]
  });
  const mipmapPassesAfterPrewarm = dirtyMipmapPassCount();

  editor.painting = true;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapDelayMs: 0,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 30, y: 32 }, end: { x: 34, y: 32 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.ok(result?.stats?.liveDisplayMipmapPixels > 0);
  assert.equal(result?.stats?.liveDisplayMipmapDowngraded, false);
  assert.ok(dirtyMipmapPassCount() > mipmapPassesAfterPrewarm);
  assert.equal(material.map, externalTexture);
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(material.map.userData.textureAirbrushDisplayMipmapped, true);
});

test("editable WebGPU live display refreshes medium dirty mipmaps by default", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2048, 2048, new Uint8Array(2048 * 2048 * 4));
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 128;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 1024, y: 1024 }, end: { x: 1024, y: 1024 } }]
  });

  editor.painting = true;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapDelayMs: 0,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 128,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 760, y: 1024 }, end: { x: 1288, y: 1024 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.ok(result?.stats?.liveDisplayWorkPixels > 2048 * 2048 * 0.03);
  assert.ok(result?.stats?.liveDisplayMipmapPixels > 0);
  assert.equal(result?.stats?.liveDisplayMipmapDowngraded, false);
  assert.equal(material.map, externalTexture);
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(material.map.userData.textureAirbrushDisplayMipmapped, true);
});

test("editable WebGPU live display keeps large local dirty mipmaps sharp during live strokes", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2048, 2048, new Uint8Array(2048 * 2048 * 4));
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 300;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 1024, y: 1024 }, end: { x: 1024, y: 1024 } }]
  });

  editor.painting = true;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapDelayMs: 0,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 300,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 650, y: 1024 }, end: { x: 1398, y: 1024 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.ok(result?.stats?.liveDisplayWorkPixels > 2048 * 2048 * 0.12);
  assert.ok(result?.stats?.liveDisplayMipmapPixels > 0);
  assert.equal(result?.stats?.liveDisplayMipmapDowngraded, false);
  assert.equal(material.map, externalTexture);
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
  assert.equal(material.map.userData.textureAirbrushDisplayMipmapped, true);
});

test("editable WebGPU live display refreshes disjoint dirty mipmaps level by level", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(128, 128, new Uint8Array(128 * 128 * 4));
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
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
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 64, y: 64 }, end: { x: 64, y: 64 } }]
  });
  const callsBeforePaint = device.calls.length;

  editor.painting = true;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapDelayMs: 0,
    forceLiveDisplayDirtyRegions: true,
    displayDirtyRegions: [
      { x: 0, y: 0, width: 12, height: 12 },
      { x: 116, y: 116, width: 12, height: 12 }
    ],
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 60, y: 64 }, end: { x: 68, y: 64 } }]
  });

  const dirtyMipmapLevels = device.calls.slice(callsBeforePaint)
    .filter((call) => call[0] === "beginComputePass" && String(call[1] || "").includes("dirty-mipmap-level"))
    .map((call) => Number(String(call[1]).match(/dirty-mipmap-level-(\d+)/)?.[1] || 0))
    .filter(Boolean);
  const firstLevelTwoIndex = dirtyMipmapLevels.indexOf(2);

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.ok(dirtyMipmapLevels.filter((level) => level === 1).length > 1);
  assert.ok(firstLevelTwoIndex > 1);
  assert.deepEqual(
    dirtyMipmapLevels.slice(0, firstLevelTwoIndex),
    Array.from({ length: firstLevelTwoIndex }, () => 1)
  );
});

test("editable WebGPU live display budgets dirty mipmaps by generated mip pixels", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(2048, 2048, new Uint8Array(2048 * 2048 * 4));
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 460;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 1024, y: 1024 }, end: { x: 1024, y: 1024 } }]
  });

  editor.painting = true;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapImmediatePixels: 1_600_000,
    liveDisplayMipmapDelayMs: 0,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 460,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 460, y: 1024 }, end: { x: 1588, y: 1024 } }]
  });

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayMipmapDirty, true);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.ok(result?.stats?.liveDisplayWorkPixels > 1_600_000);
  assert.ok(result?.stats?.liveDisplayMipmapPixels > 0);
  assert.ok(result?.stats?.liveDisplayMipmapPixels <= 1_600_000);
  assert.equal(material.map, externalTexture);
  assert.equal(material.map.minFilter, "linear-mipmap-linear");
  assert.equal(material.map.generateMipmaps, true);
});

test("editable WebGPU deferred live mipmaps use the next frame when no delay is requested", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  const material = {
    map: editable.texture,
    userData: {}
  };
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
  const externalTexture = {
    userData: {
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: editable.texture.minFilter
  };
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;
  const originalWindow = globalThis.window;
  const frames = [];
  const timerDelays = [];
  globalThis.window = {
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    setTimeout(callback, delayMs = 0) {
      timerDelays.push(delayMs);
      return 1;
    }
  };

  const dirtyMipmapPassCount = () => device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("dirty-mipmap-level")
  )).length;

  try {
    textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
      material,
      liveDisplayExternalTexture: true,
      allowPrewarmLiveDisplayMaterialSwap: true,
      radiusPixels: 2,
      scatter: 0,
      strokeSegments: [{ start: { x: 32, y: 32 }, end: { x: 32, y: 32 } }]
    });
    const mipmapPassesAfterPrewarm = dirtyMipmapPassCount();

    const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
      material,
      liveDisplayExternalTexture: true,
      deferLiveDisplayMipmaps: true,
      liveDisplayMipmapImmediatePixels: 0,
      liveDisplayMipmapDelayMs: 0,
      deferReadbackApply: true,
      deferReadbackCopy: true,
      radiusPixels: 2,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 30, y: 32 }, end: { x: 34, y: 32 } }]
    });

    assert.equal(result?.stats?.liveDisplayMipmapDeferred, true);
    assert.equal(dirtyMipmapPassCount(), mipmapPassesAfterPrewarm);
    assert.equal(frames.length, 1);
    assert.deepEqual(timerDelays, []);

    const callsBeforeDeferredFrame = device.calls.length;
    frames.shift()?.();
    const deferredFrameEncoders = device.calls.slice(callsBeforeDeferredFrame).filter((call) => (
      call[0] === "createCommandEncoder"
      && String(call[1] || "").includes("dirty-mipmap-command-encoder")
    ));
    assert.ok(deferredFrameEncoders.length > 0);
    assert.ok(dirtyMipmapPassCount() > mipmapPassesAfterPrewarm);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("editable WebGPU prewarm generates full live mipmaps without backend fallback", () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(32 * 32 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const { editable } = fakeEditableTexture(32, 32, new Uint8Array(32 * 32 * 4));
  editable.texture.colorSpace = "srgb";
  editable.texture.flipY = true;
  editable.texture.minFilter = "linear-mipmap-linear";
  editable.texture.generateMipmaps = true;
  const material = {
    map: editable.texture,
    userData: {}
  };
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
  let externalOptions = null;
  const externalTexture = { userData: {} };
  editor.textureAirbrushCreateExternalWebGpuTexture = (gpuTexture, referenceTexture, options) => {
    externalOptions = options;
    return externalTexture;
  };

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    material,
    liveDisplayExternalTexture: true,
    allowPrewarmLiveDisplayMaterialSwap: true,
    radiusPixels: 2,
    scatter: 0,
    strokeSegments: [{ start: { x: 16, y: 16 }, end: { x: 16, y: 16 } }]
  });

  const dirtyMipmapPasses = device.calls.filter((call) => (
    call[0] === "createBindGroup"
    && String(call[2] || "").includes("dirty-mipmap-level")
  )).length;

  assert.equal(prewarm?.stats?.liveDisplayExternalTexture, true);
  assert.equal(prewarm?.stats?.liveDisplayFullUpdate, true);
  assert.equal(prewarm?.stats?.liveDisplayMipmapDirty, true);
  assert.ok(prewarm?.stats?.liveDisplayMipmapPixels > 0);
  assert.ok(dirtyMipmapPasses > 0);
  assert.equal(externalOptions?.mipmapped, true);
  assert.equal(material.map, externalTexture);
});

test("editable WebGPU live layer paint displays a composite texture instead of the raw layer", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const base = fakeEditableTexture(2, 2, new Uint8Array([
    20, 30, 40, 255,
    20, 30, 40, 255,
    20, 30, 40, 255,
    20, 30, 40, 255
  ]));
  base.editable.texture.colorSpace = "srgb";
  const layerEditable = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  const layer = { id: "paint-layer", opacity: 1, canvas: layerEditable.editable.canvas };
  const editable = {
    ...layerEditable.editable,
    texture: base.editable.texture,
    compositeCanvas: base.editable.canvas,
    compositeContext: base.editable.context,
    layerStack: {
      baseCanvas: base.editable.canvas,
      baseContext: base.editable.context,
      width: 2,
      height: 2,
      layers: [layer]
    },
    layer,
    layerMode: true
  };
  const material = {
    map: base.editable.texture,
    userData: {}
  };
  let externalTextureArgs = null;
  const externalTexture = { userData: {} };
  let generatedMipTexture = null;
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {
        _generateMipmaps(texture) {
          generatedMipTexture = texture;
        }
      }
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushCreateExternalWebGpuTexture = (gpuTexture, referenceTexture, textureOptions) => {
    externalTextureArgs = { gpuTexture, referenceTexture, textureOptions };
    return externalTexture;
  };
  const paintOptions = {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.canvas);

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(material.map, externalTexture);
  assert.equal(externalTextureArgs?.referenceTexture, base.editable.texture);
  assert.equal(externalTextureArgs?.gpuTexture, cache.layerDisplayComposite.displayTexture);
  assert.equal(externalTextureArgs?.textureOptions?.colorSpace, "srgb-linear");
  assert.equal(externalTextureArgs?.textureOptions?.mipmapped, true);
  assert.equal(generatedMipTexture, null);
  assert.equal(cache.layerDisplayComposite.mipLevelCount, 2);
  assert.notEqual(externalTextureArgs?.gpuTexture, cache.resources.sourceTexture);
  assert.deepEqual(cache.layerDisplayComposite.uniformBuffer.lastWriteFloat32, [2, 2, 1, 0, 1, 0, 0, 2, 2, 0, 0, 0]);
  assert.equal(result?.stats?.liveDisplayFullUpdate, true);
  assert.equal(result?.stats?.liveDisplayWorkPixels, 4);
  assert.ok(device.calls.some((call) => call[0] === "createComputePipeline" && call[1] === "textureAirbrushCompositeLayer"));
  assert.ok(device.calls.some((call) => (
    call[0] === "createShaderModule"
    && String(call[1]).includes("layer-display")
    && String(call[3]).includes("textureAirbrushSrgbToLinear")
  )));
  assert.ok(device.calls.some((call) => (
    call[0] === "writeTexture"
    && call[6] === "texture-airbrush-layer-display-base-texture"
  )));

  const baseGetCalls = base.state.getCalls;
  const layerDisplayBindGroupsAfterFirstStroke = device.calls.filter((call) => (
    call[0] === "createBindGroup"
    && String(call[2] || "").includes("layer-display-bind-group")
  )).length;
  assert.ok(layerDisplayBindGroupsAfterFirstStroke > 0);
  await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  assert.equal(base.state.getCalls, baseGetCalls);
  assert.equal(device.calls.filter((call) => (
    call[0] === "createBindGroup"
    && String(call[2] || "").includes("layer-display-bind-group")
  )).length, layerDisplayBindGroupsAfterFirstStroke);
});

test("editable WebGPU live layer display composites disjoint dirty regions separately", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const base = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4).fill(32));
  base.editable.texture.colorSpace = "srgb";
  const layerEditable = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const layer = { id: "paint-layer", opacity: 1, canvas: layerEditable.editable.canvas };
  const editable = {
    ...layerEditable.editable,
    texture: base.editable.texture,
    compositeCanvas: base.editable.canvas,
    compositeContext: base.editable.context,
    layerStack: {
      baseCanvas: base.editable.canvas,
      baseContext: base.editable.context,
      width: 64,
      height: 64,
      layers: [layer]
    },
    layer,
    layerMode: true
  };
  const material = {
    map: base.editable.texture,
    userData: {}
  };
  const externalTexture = { userData: {} };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device,
      textureUtils: {
        _generateMipmaps() {}
      }
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 2;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;
  const paintOptions = {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 2, y: 2 }, end: { x: 3, y: 3 } }]
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, paintOptions);
  const callsBeforeRegionPaint = device.calls.length;
  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    ...paintOptions,
    forceLiveDisplayDirtyRegions: true,
    displayDirtyRegions: [
      { x: 0, y: 0, width: 8, height: 8 },
      { x: 48, y: 48, width: 8, height: 8 }
    ],
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 56, y: 56 } }]
  });
  const layerCompositePasses = device.calls.slice(callsBeforeRegionPaint).filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("layer-display-compute-pass")
  ));
  const layerDispatches = device.calls.slice(callsBeforeRegionPaint).filter((call) => (
    call[0] === "dispatchWorkgroups"
  )).slice(1, 3);
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.canvas);

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayFullUpdate, false);
  assert.equal(result?.stats?.liveDisplayWorkPixels, 128);
  assert.equal(cache.layerDisplayComposite.updatedDisplayRegions.length, 2);
  assert.equal(layerCompositePasses.length, 2);
  assert.deepEqual(layerDispatches, [
    ["dispatchWorkgroups", 1, 1, 1],
    ["dispatchWorkgroups", 1, 1, 1]
  ]);
});

test("editable WebGPU live layer display fully refreshes after layer texture handoff", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(64 * 64 * 4) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const base = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4).fill(32));
  base.editable.texture.colorSpace = "srgb";
  base.editable.texture.minFilter = "linear-mipmap-linear";
  base.editable.texture.generateMipmaps = true;
  const layerEditable = fakeEditableTexture(64, 64, new Uint8Array(64 * 64 * 4));
  const layer = { id: "paint-layer-handoff", opacity: 1, canvas: layerEditable.editable.canvas };
  const editable = {
    ...layerEditable.editable,
    texture: base.editable.texture,
    compositeCanvas: base.editable.canvas,
    compositeContext: base.editable.context,
    layerStack: {
      baseCanvas: base.editable.canvas,
      baseContext: base.editable.context,
      width: 64,
      height: 64,
      layers: [layer]
    },
    layer,
    layerMode: true
  };
  const material = {
    map: base.editable.texture,
    userData: {}
  };
  const externalTexture = {
    isExternalTexture: true,
    version: 1,
    userData: {
      textureAirbrushExternalWebGpuDisplay: true,
      textureAirbrushDisplayMipmapped: true
    },
    generateMipmaps: true,
    minFilter: "linear-mipmap-linear"
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 1;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushCreateExternalWebGpuTexture = () => externalTexture;

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    displayDirtyBounds: { x: 0, y: 0, width: 4, height: 4 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });
  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.canvas);
  assert.equal(cache.layerDisplayComposite.initialized, true);
  cache.externalDisplayGpuTexture = cache.layerDisplayComposite.displayTexture;
  cache.externalDisplayTexture = externalTexture;
  material.map = externalTexture;
  cache.layerDisplayComposite.bindGroupLayerTexture = cache.layerDisplayComposite.displayTexture;
  const callsBefore = device.calls.length;

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    deferLiveDisplayMipmaps: true,
    liveDisplayMipmapImmediatePixels: 0,
    radiusPixels: 1,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    forceLiveDisplayDirtyRegions: true,
    displayDirtyRegions: [
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 60, y: 60, width: 4, height: 4 }
    ],
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 63, y: 63 } }]
  });
  const layerCompositePasses = device.calls.slice(callsBefore).filter((call) => (
    call[0] === "beginComputePass"
    && String(call[1] || "").includes("layer-display-compute-pass")
  ));

  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
  assert.equal(result?.stats?.liveDisplayFullUpdate, true);
  assert.equal(result?.stats?.liveDisplayWorkPixels, 64 * 64);
  assert.equal(result?.stats?.liveDisplayMipmapDeferred, false);
  assert.ok(result?.stats?.liveDisplayMipmapPixels > 0);
  assert.equal(cache.layerDisplayComposite.updatedDisplayRegions, null);
  assert.deepEqual(cache.layerDisplayComposite.updatedDisplayBounds, {
    x: 0,
    y: 0,
    width: 64,
    height: 64
  });
  assert.equal(layerCompositePasses.length, 1);
});

test("editable WebGPU live layer display preflips composite output for flipY textures", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const base = fakeEditableTexture(2, 2, new Uint8Array([
    20, 30, 40, 255,
    20, 30, 40, 255,
    20, 30, 40, 255,
    20, 30, 40, 255
  ]));
  base.editable.texture.flipY = true;
  base.editable.texture.colorSpace = "srgb";
  const layerEditable = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  const layer = { id: "paint-layer-flip", opacity: 1, canvas: layerEditable.editable.canvas };
  const editable = {
    ...layerEditable.editable,
    texture: base.editable.texture,
    compositeCanvas: base.editable.canvas,
    compositeContext: base.editable.context,
    layerStack: {
      baseCanvas: base.editable.canvas,
      baseContext: base.editable.context,
      width: 2,
      height: 2,
      layers: [layer]
    },
    layer,
    layerMode: true
  };
  const material = {
    map: base.editable.texture,
    userData: {}
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  let externalTextureArgs = null;
  editor.textureAirbrushCreateExternalWebGpuTexture = (gpuTexture, referenceTexture, textureOptions) => {
    externalTextureArgs = { gpuTexture, referenceTexture, textureOptions };
    return { userData: {}, flipY: textureOptions?.flipY };
  };

  await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.canvas);
  assert.deepEqual(cache.layerDisplayComposite.uniformBuffer.lastWriteFloat32, [2, 2, 1, 1, 1, 0, 0, 2, 2, 0, 0, 0]);
  assert.equal(externalTextureArgs?.referenceTexture, base.editable.texture);
  assert.equal(externalTextureArgs?.textureOptions?.flipY, false);
  assert.equal(externalTextureArgs?.textureOptions?.colorSpace, "srgb-linear");
  assert.equal(material.map.flipY, false);
  assert.ok(device.calls.some((call) => (
    call[0] === "createShaderModule"
    && String(call[1]).includes("layer-display")
    && String(call[3]).includes("textureAirbrushSrgbToLinear")
  )));
});

test("installed airbrush WebGPU live path reuses prewarmed stroke source for undo", async () => {
  class TestEditor {}
  const mapped = new Uint8Array(256);
  mapped.set([
    0, 0, 0, 0,
    255, 0, 0, 128
  ], 0);
  const device = fakeWebGpuDevice({ readbackMappedData: mapped });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-prewarm" };
  const record = {
    id: "record-live-prewarm",
    geometry: {
      attributes: {
        uv: {
          count: 3,
          getX(index) {
            return [0, 1, 1][index];
          },
          getY(index) {
            return [0, 0, 1][index];
          }
        }
      }
    }
  };
  const hit = {
    uv: { x: 1, y: 0 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } },
    faceIndex: 0
  };
  const { editable } = fakeEditableTexture(2, 1, new Uint8Array([
    10, 20, 30, 0,
    40, 50, 60, 0
  ]));
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
  let capturedBeforeImageData = null;
  let strokeSourceImageData = null;
  editor.captureTexturePaintCanvasUndoTarget = (capturedRecord, capturedMaterial, capturedEditable, materialIndex, options) => {
    assert.equal(capturedRecord, record);
    assert.equal(capturedMaterial, material);
    assert.equal(capturedEditable, editable);
    assert.equal(materialIndex, 0);
    capturedBeforeImageData = options?.beforeImageData || null;
    strokeSourceImageData = capturedBeforeImageData;
    return true;
  };
  editor.texturePaintCanvasStrokeSourceImage = () => strokeSourceImageData;
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushCreateExternalWebGpuTexture = () => ({ userData: {} });

  const prewarm = textureAirbrushPrewarmEditableWebGpuPaint(editor, editable, {
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
  });
  const strokeSourceWritesBefore = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && call[6] === "texture-airbrush-prewarm-stroke-source-texture"
  )).length;

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 10,
    clientY: 10
  }, {
    mapRead: 1,
    visibleSurfaceMaskRequired: true,
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibilityMaskStampRadiusPixels: 1,
    visibilityMaskThreshold: 0.5,
    visibilityFeatherRadius: 0,
    visibilityBleedRadius: 0
  });

  assert.ok(estimate > 0);
  assert.equal(capturedBeforeImageData, null);
  await editor.flushTextureAirbrushQueuedWebGpuStrokes();
  assert.equal(capturedBeforeImageData, prewarm.sourceImageData);
  await editor.flushTextureAirbrushPendingWebGpuPaints();

  const strokeSourceWritesAfter = device.calls.filter((call) => (
    call[0] === "writeTexture"
    && /stroke-source-texture$/.test(call[6])
  ));
  assert.equal(strokeSourceWritesBefore, 1);
  assert.equal(strokeSourceWritesAfter.length, 1);
});

test("installed airbrush WebGPU live path batches compatible visible candidates before GPU paint", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-direct-batch" };
  const record = { id: "record-direct-batch" };
  const editable = {
    texture: { uuid: "texture-direct-batch" },
    canvas: { width: 32, height: 32 }
  };
  const candidateBase = {
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 2,
    options: {
      radiusPixels: 2,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskKey: "visible-direct-batch",
      visibilityMaskStampRadiusPixels: 4
    },
    estimate: 4
  };
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    {
      ...candidateBase,
      center: { x: 4, y: 4 },
      strokeSegments: [{ start: { x: 4, y: 4 }, end: { x: 6, y: 4 } }],
      options: {
        ...candidateBase.options,
        visibilityMaskKey: "visible-direct-batch-a",
        visibilityMaskSamples: [{ x: 4, y: 4 }],
        strokeSegments: [{ start: { x: 4, y: 4 }, end: { x: 6, y: 4 } }]
      }
    },
    {
      ...candidateBase,
      center: { x: 8, y: 4 },
      strokeSegments: [{ start: { x: 6, y: 4 }, end: { x: 8, y: 4 } }],
      options: {
        ...candidateBase.options,
        visibilityMaskKey: "visible-direct-batch-b",
        visibilityMaskSamples: [{ x: 8, y: 4 }],
        strokeSegments: [{ start: { x: 6, y: 4 }, end: { x: 8, y: 4 } }]
      }
    }
  ];
  editor.textureAirbrushPaintWebGpuCandidateDirect = (candidate) => {
    throw new Error(`CPU direct paint should not run for ${candidate.material?.uuid || "candidate"}`);
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(changed, 2);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments.length, 2);
  assert.ok(queued[0].options.visibilityMaskSamples.length > 0);
  assert.equal(visibilityMaskPayloadByteLength(queued[0].options.visibilityMaskPixels), 0);
  assert.equal(queued[0].estimate, 8);
});

test("installed airbrush WebGPU live paint bounds include the full scatter halo", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-direct-halo-bounds" };
  const record = { id: "record-direct-halo-bounds" };
  const editable = {
    texture: { uuid: "texture-direct-halo-bounds" },
    canvas: { width: 64, height: 64 }
  };
  const radiusPixels = 10;
  const scatter = 1;
  const segment = { start: { x: 24, y: 30 }, end: { x: 28, y: 30 } };
  const queued = [];

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, candidateOptions = {}) => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: segment.end,
    radiusPixels,
    strokeSegments: [segment],
    options: {
      radiusPixels,
      opacity: 0.5,
      hardness: 0.4,
      scatter,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskKey: "visible-direct-halo-bounds",
      visibilityMaskSamples: [{ segment }],
      visibilityMaskStampRadiusPixels: airbrushHaloRadius(radiusPixels, scatter) + 1,
      strokeSegments: [segment]
    },
    estimate: 4
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });
  const halo = Math.ceil(airbrushHaloRadius(radiusPixels, scatter) + 2);

  assert.equal(changed, 1);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].paintBounds, {
    x: Math.max(0, Math.floor(segment.start.x - halo)),
    y: Math.max(0, Math.floor(segment.start.y - halo)),
    width: Math.ceil(segment.end.x + halo + 1) - Math.max(0, Math.floor(segment.start.x - halo)),
    height: Math.ceil(segment.end.y + halo + 1) - Math.max(0, Math.floor(segment.start.y - halo))
  });
});

test("installed airbrush WebGPU live path keeps different Neighbor seeds in separate batches", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-direct-neighbor-batch" };
  const record = { id: "record-direct-neighbor-batch" };
  const editable = {
    texture: { uuid: "texture-direct-neighbor-batch" },
    canvas: { width: 32, height: 32 }
  };
  const candidateBase = {
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 2,
    options: {
      radiusPixels: 2,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskKey: "visible-direct-neighbor-batch",
      visibilityMaskSamples: [{ x: 4, y: 4 }],
      visibilityMaskStampRadiusPixels: 4
    },
    estimate: 4
  };
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    {
      ...candidateBase,
      center: { x: 4, y: 4 },
      strokeSegments: [{ start: { x: 4, y: 4 }, end: { x: 6, y: 4 } }],
      options: {
        ...candidateBase.options,
        neighborPaintSeed: { enabled: true, key: "neighbor-a" },
        strokeSegments: [{ start: { x: 4, y: 4 }, end: { x: 6, y: 4 } }]
      }
    },
    {
      ...candidateBase,
      center: { x: 8, y: 4 },
      strokeSegments: [{ start: { x: 6, y: 4 }, end: { x: 8, y: 4 } }],
      options: {
        ...candidateBase.options,
        neighborPaintSeed: { enabled: true, key: "neighbor-b" },
        strokeSegments: [{ start: { x: 6, y: 4 }, end: { x: 8, y: 4 } }]
      }
    }
  ];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(changed, 2);
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map((candidate) => candidate.options.neighborPaintSeed.key), ["neighbor-a", "neighbor-b"]);
  assert.deepEqual(queued.map((candidate) => candidate.strokeSegments.length), [1, 1]);
});

test("installed airbrush WebGPU live path merges different visibility triangles in one live batch", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-direct-triangle-split" };
  const record = { id: "record-direct-triangle-split" };
  const editable = {
    texture: { uuid: "texture-direct-triangle-split" },
    canvas: { width: 64, height: 64 }
  };
  const candidateBase = {
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 3,
    estimate: 4,
    options: {
      radiusPixels: 3,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskSamples: [{ x: 20, y: 20 }],
      visibilityMaskStampRadiusPixels: 4
    }
  };
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    {
      ...candidateBase,
      center: { x: 20, y: 20 },
      strokeSegments: [{ start: { x: 20, y: 20 }, end: { x: 22, y: 20 } }],
      options: {
        ...candidateBase.options,
        visibilityMaskTriangles: [{
          a: { x: 18, y: 18 },
          b: { x: 24, y: 18 },
          c: { x: 18, y: 24 }
        }],
        strokeSegments: [{ start: { x: 20, y: 20 }, end: { x: 22, y: 20 } }]
      }
    },
    {
      ...candidateBase,
      center: { x: 24, y: 20 },
      strokeSegments: [{ start: { x: 22, y: 20 }, end: { x: 24, y: 20 } }],
      options: {
        ...candidateBase.options,
        visibilityMaskTriangles: [{
          a: { x: 28, y: 18 },
          b: { x: 34, y: 18 },
          c: { x: 28, y: 24 }
        }],
        strokeSegments: [{ start: { x: 22, y: 20 }, end: { x: 24, y: 20 } }]
      }
    }
  ];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(changed, 2);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments.length, 2);
  assert.ok(queued[0].options.visibilityMaskSamples.length > 0);
  assert.equal(queued[0].options.visibilityMaskTriangles.length, 2);
  assert.equal(visibilityMaskPayloadByteLength(queued[0].options.visibilityMaskPixels), 0);
});

test("installed airbrush WebGPU live queue merges compatible triangle-mask batches", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-queue-triangle-merge" };
  const record = { id: "record-live-queue-triangle-merge" };
  const editable = {
    texture: { uuid: "texture-live-queue-triangle-merge" },
    canvas: { width: 128, height: 128 }
  };
  const baseOptions = {
    liveProjectedPaint: true,
    visibilityMaskMode: "samples",
    radiusPixels: 6,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    useVisibilityMask: true,
    visibleSurfaceMaskReady: true,
    visibilityMaskStampRadiusPixels: 6,
    visibilityMaskSamples: []
  };
  const makeCandidate = (x, triangle) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x, y: 32 },
    radiusPixels: 6,
    strokeSegments: [{ start: { x, y: 32 }, end: { x: x + 8, y: 32 } }],
    estimate: 10,
    options: {
      ...baseOptions,
      visibilityMaskTriangles: [triangle],
      screenProjectedStrokeSegments: [{
        start: { x: x * 2, y: 48 },
        end: { x: x * 2 + 12, y: 48 },
        radiusPixels: 10
      }],
      strokeSegments: [{ start: { x, y: 32 }, end: { x: x + 8, y: 32 } }]
    }
  });

  const first = editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(24, {
    a: { x: 20, y: 24 },
    b: { x: 36, y: 24 },
    c: { x: 20, y: 40 }
  }), { scheduleFlush: false });
  const second = editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(34, {
    a: { x: 32, y: 24 },
    b: { x: 48, y: 24 },
    c: { x: 32, y: 40 }
  }), { scheduleFlush: false });

  assert.ok(first > 0);
  assert.ok(second > 0);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].strokeSegments.length, 2);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].options.visibilityMaskTriangles.length, 2);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].options.screenProjectedStrokeSegments.length, 2);
});

test("installed airbrush WebGPU large direct live batches keep segment visibility with triangles", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-direct-segment-mask" };
  const record = { id: "record-large-direct-segment-mask" };
  const editable = {
    texture: { uuid: "texture-large-direct-segment-mask" },
    canvas: { width: 512, height: 512 }
  };
  const strokeSegments = [{
    start: { x: 120, y: 240 },
    end: { x: 240, y: 240 }
  }];
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0.5, y: 0.5 } } });
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 240, y: 240 },
    radiusPixels: 52,
    strokeSegments,
    estimate: 64,
    options: {
      ...options,
      radiusPixels: 52,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskTriangles: [{
        a: { x: 120, y: 210 },
        b: { x: 240, y: 210 },
        c: { x: 240, y: 270 }
      }],
      strokeSegments
    }
  }];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => false;

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 240, clientY: 80 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    radiusPixels: 52,
    strokeStart: { clientX: 40, clientY: 80 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 80 },
      end: { clientX: 240, clientY: 80 }
    }]
  });

  assert.equal(changed, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].options.visibilityMaskTriangles.length, 1);
  assert.ok(queued[0].options.visibilityMaskSamples.some((sample) => (
    sample?.segment?.start?.x === strokeSegments[0].start.x
    && sample?.segment?.end?.x === strokeSegments[0].end.x
  )));
  assert.equal(visibilityMaskPayloadByteLength(queued[0].options.visibilityMaskPixels), 0);
});

test("installed airbrush WebGPU footprint visibility probes do not paint dots", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-footprint-visibility-only" };
  const record = { id: "record-footprint-visibility-only" };
  const editable = {
    texture: { uuid: "texture-footprint-visibility-only" },
    canvas: { width: 512, height: 512 }
  };
  const paintSegment = {
    start: { x: 120, y: 240 },
    end: { x: 240, y: 240 }
  };
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0.5, y: 0.5 } } });
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => [
    {
      record,
      material,
      materialIndex: 0,
      editable,
      center: { x: 240, y: 240 },
      radiusPixels: 52,
      strokeSegments: [paintSegment],
      estimate: 64,
      options: {
        ...options,
        radiusPixels: 52,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0.3,
        strength: 1,
        color: { r: 255, g: 0, b: 0 },
        useVisibilityMask: true,
        visibleSurfaceMaskReady: true,
        visibilityMaskTriangles: [{
          a: { x: 120, y: 210 },
          b: { x: 240, y: 210 },
          c: { x: 240, y: 270 }
        }],
        strokeSegments: [paintSegment]
      }
    },
    {
      record,
      material,
      materialIndex: 0,
      editable,
      center: { x: 310, y: 260 },
      radiusPixels: 52,
      strokeSegments: [{
        start: { x: 300, y: 260 },
        end: { x: 310, y: 260 }
      }],
      visibilityOnly: true,
      estimate: 64,
      options: {
        ...options,
        visibilityOnly: true,
        radiusPixels: 52,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0.3,
        strength: 1,
        color: { r: 255, g: 0, b: 0 },
        useVisibilityMask: true,
        visibleSurfaceMaskReady: true,
        visibilityMaskTriangles: [{
          a: { x: 290, y: 230 },
          b: { x: 330, y: 230 },
          c: { x: 330, y: 280 }
        }],
        strokeSegments: [{
          start: { x: 300, y: 260 },
          end: { x: 310, y: 260 }
        }]
      }
    }
  ];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => false;

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 240, clientY: 80 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    radiusPixels: 52,
    strokeStart: { clientX: 40, clientY: 80 },
    strokeSegments: [{
      start: { clientX: 40, clientY: 80 },
      end: { clientX: 240, clientY: 80 }
    }]
  });

  assert.equal(changed, 1);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].strokeSegments, [{ ...paintSegment, radiusPixels: 52 }]);
  assert.equal(queued[0].options.visibilityMaskTriangles.length, 2);
  assert.ok(queued[0].options.visibilityMaskSamples.some((sample) => (
    sample?.segment?.start?.x === 300
    && sample?.segment?.end?.x === 310
  )));
});

test("installed airbrush WebGPU live path splits far UV islands before GPU paint", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-far-islands" };
  const record = { id: "record-far-islands" };
  const editable = {
    texture: { uuid: "texture-far-islands" },
    canvas: { width: 4096, height: 4096 }
  };
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    {
      record,
      material,
      materialIndex: 0,
      editable,
      center: { x: 128, y: 512 },
      radiusPixels: 32,
      strokeSegments: [{ start: { x: 128, y: 512 }, end: { x: 180, y: 512 } }],
      estimate: 64,
      options: {
        radiusPixels: 32,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0.3,
        strength: 1,
        color: { r: 255, g: 0, b: 0 },
        useVisibilityMask: true,
        visibleSurfaceMaskReady: true,
        visibilityMaskSamples: [{ segment: { start: { x: 128, y: 512 }, end: { x: 180, y: 512 } } }],
        visibilityMaskStampRadiusPixels: 24,
        strokeSegments: [{ start: { x: 128, y: 512 }, end: { x: 180, y: 512 } }]
      }
    },
    {
      record,
      material,
      materialIndex: 0,
      editable,
      center: { x: 3800, y: 3600 },
      radiusPixels: 32,
      strokeSegments: [{ start: { x: 3750, y: 3600 }, end: { x: 3800, y: 3600 } }],
      estimate: 64,
      options: {
        radiusPixels: 32,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0.3,
        strength: 1,
        color: { r: 255, g: 0, b: 0 },
        useVisibilityMask: true,
        visibleSurfaceMaskReady: true,
        visibilityMaskSamples: [{ segment: { start: { x: 3750, y: 3600 }, end: { x: 3800, y: 3600 } } }],
        visibilityMaskStampRadiusPixels: 24,
        strokeSegments: [{ start: { x: 3750, y: 3600 }, end: { x: 3800, y: 3600 } }]
      }
    }
  ];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(changed, 2);
  assert.equal(queued.length, 2);
  assert.ok(queued.every((candidate) => candidate.strokeSegments.length === 1));
  assert.ok(queued.every((candidate) => candidate.options.visibilityMaskSamples.length > 0));
  assert.ok(queued.every((candidate) => visibilityMaskPayloadByteLength(candidate.options.visibilityMaskPixels) === 0));
});

test("installed airbrush WebGPU live queue splits one candidate with UV-jump bounds", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-uv-jump" };
  const record = { id: "record-uv-jump" };
  const editable = {
    texture: { uuid: "texture-uv-jump" },
    canvas: { width: 4096, height: 4096 }
  };
  const segment = {
    start: { x: 96, y: 128 },
    end: { x: 3900, y: 3840 }
  };

  const estimate = editor.textureAirbrushQueueWebGpuStrokeCandidate({
    record,
    material,
    materialIndex: 0,
    editable,
    center: segment.end,
    radiusPixels: 24,
    strokeSegments: [segment],
    estimate: 64,
    options: {
      liveProjectedPaint: true,
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [segment]
    }
  }, { scheduleFlush: false });
  const queued = editor.textureAirbrushQueuedWebGpuStrokes || [];
  const maxArea = 700_000;

  assert.ok(estimate > 1);
  assert.ok(queued.length > 1);
  assert.ok(queued.every((batch) => batch.strokeSegments.length >= 1));
  assert.ok(queued.every((batch) => (
    Math.max(1, batch.paintBounds?.width || 0) * Math.max(1, batch.paintBounds?.height || 0)
  ) <= maxArea));
});

test("installed airbrush WebGPU live queue splits large-brush UV-jump bounds", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-uv-jump" };
  const record = { id: "record-large-uv-jump" };
  const editable = {
    texture: { uuid: "texture-large-uv-jump" },
    canvas: { width: 4096, height: 4096 }
  };
  const segment = {
    start: { x: 220, y: 120 },
    end: { x: 3880, y: 3980 }
  };
  const maxArea = 1_600_000;

  const estimate = editor.textureAirbrushQueueWebGpuStrokeCandidate({
    record,
    material,
    materialIndex: 0,
    editable,
    center: segment.end,
    radiusPixels: 314,
    strokeSegments: [segment],
    estimate: 512,
    options: {
      radiusPixels: 314,
      opacity: 0.9,
      hardness: 0.36,
      scatter: 0.36,
      strength: 1,
      color: { r: 0, g: 255, b: 74 },
      maxLiveBatchAreaPixels: maxArea,
      strokeSegments: [segment]
    }
  }, { scheduleFlush: false });
  const queued = editor.textureAirbrushQueuedWebGpuStrokes || [];

  assert.ok(estimate > 1);
  assert.ok(queued.length > 1);
  assert.ok(queued.every((batch) => batch.strokeSegments.length >= 1));
  assert.ok(queued.every((batch) => (
    Math.max(1, batch.paintBounds?.width || 0) * Math.max(1, batch.paintBounds?.height || 0)
  ) <= maxArea));
});

test("installed airbrush WebGPU live queue merges repeated oversized large-brush bounds", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-oversized-repeat" };
  const record = { id: "record-large-oversized-repeat" };
  const editable = {
    texture: { uuid: "texture-large-oversized-repeat" },
    canvas: { width: 4096, height: 4096 }
  };
  const makeSegment = (x) => ({
    start: { x, y: 2048 },
    end: { x, y: 2048 }
  });
  const makeCandidate = (x) => {
    const segment = makeSegment(x);
    return {
      record,
      material,
      materialIndex: 0,
      editable,
      center: segment.end,
      radiusPixels: 640,
      strokeSegments: [segment],
      estimate: 1024,
      options: {
        liveProjectedPaint: true,
        allowDisjointLiveBatchBounds: true,
        largeLiveBrushPaint: true,
        maxLiveBatchAreaPixels: 4096 * 4096,
        radiusPixels: 640,
        opacity: 0.9,
        hardness: 0.36,
        scatter: 0.3,
        strength: 1,
        color: { r: 0, g: 255, b: 74 },
        strokeSegments: [segment]
      }
    };
  };

  const first = editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(2048), { scheduleFlush: false });
  const second = editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(2049), { scheduleFlush: false });
  const queued = editor.textureAirbrushQueuedWebGpuStrokes || [];

  assert.ok(first > 0);
  assert.ok(second > 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments.length, 2);
  assert.ok(queued[0].paintBounds.height > 1400);
  assert.ok(queued[0].paintBounds.width > 1400);
  assert.ok(
    queued[0].paintBounds.width * queued[0].paintBounds.height < 4096 * 4096 * 0.35
  );
});

test("installed airbrush WebGPU live queue merges overlapping large-brush bounds across locality tiles", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-cross-locality" };
  const record = { id: "record-large-cross-locality" };
  const editable = {
    texture: { uuid: "texture-large-cross-locality" },
    canvas: { width: 4096, height: 4096 }
  };
  const makeCandidate = (x) => {
    const segment = {
      start: { x, y: 2048 },
      end: { x, y: 2048 }
    };
    return {
      record,
      material,
      materialIndex: 0,
      editable,
      center: segment.end,
      radiusPixels: 120,
      strokeSegments: [segment],
      estimate: 256,
      options: {
        liveProjectedPaint: true,
        allowDisjointLiveBatchBounds: true,
        largeLiveBrushPaint: true,
        maxLiveBatchAreaPixels: 4096 * 4096,
        radiusPixels: 120,
        opacity: 0.9,
        hardness: 0.36,
        scatter: 0.3,
        strength: 1,
        color: { r: 0, g: 255, b: 74 },
        strokeSegments: [segment]
      }
    };
  };

  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(1000), { scheduleFlush: false });
  const firstLocality = editor.textureAirbrushQueuedWebGpuStrokes[0].localityKey;
  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(1040), { scheduleFlush: false });

  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].localityKey, firstLocality);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].strokeSegments.length, 2);

  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(1900), { scheduleFlush: false });

  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 2);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].strokeSegments.length, 2);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[1].strokeSegments.length, 1);
});

test("installed airbrush WebGPU live queue recomputes chunk bounds from local UV segments", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-explicit-broad-chunk-bounds" };
  const record = { id: "record-explicit-broad-chunk-bounds" };
  const editable = {
    texture: { uuid: "texture-explicit-broad-chunk-bounds" },
    canvas: { width: 4096, height: 4096 }
  };
  const segment = {
    start: { x: 96, y: 128 },
    end: { x: 3900, y: 3840 }
  };
  const maxArea = 700_000;

  editor.textureAirbrushQueueWebGpuStrokeCandidate({
    record,
    material,
    materialIndex: 0,
    editable,
    center: segment.end,
    radiusPixels: 24,
    paintBounds: { x: 0, y: 0, width: 4096, height: 4096 },
    paintRegions: [{ x: 0, y: 0, width: 4096, height: 4096 }],
    strokeSegments: [segment],
    estimate: 64,
    options: {
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [segment]
    }
  }, { scheduleFlush: false });
  const queued = editor.textureAirbrushQueuedWebGpuStrokes || [];

  assert.ok(queued.length > 1);
  assert.ok(queued.every((batch) => (
    Math.max(1, batch.paintBounds?.width || 0) * Math.max(1, batch.paintBounds?.height || 0)
  ) <= maxArea));
  assert.ok(queued.every((batch) => batch.paintBounds.width < 4096 && batch.paintBounds.height < 4096));
});

test("installed airbrush WebGPU live path coalesces visible samples across events before flush", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-visible-coalesce" };
  const record = { id: "record-visible-coalesce" };
  const editable = {
    texture: { uuid: "texture-visible-coalesce" },
    canvas: { width: 64, height: 64 }
  };
  let eventIndex = 0;
  let scheduled = 0;

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.captureTexturePaintCanvasUndoTarget = () => {
    editor.undoCaptures = (editor.undoCaptures || 0) + 1;
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => {
    const x = eventIndex === 0 ? 10 : 18;
    eventIndex += 1;
    const segment = { start: { x, y: 12 }, end: { x: x + 4, y: 12 } };
    return [{
      record,
      material,
      materialIndex: 0,
      editable,
      center: { x, y: 12 },
      radiusPixels: 4,
      strokeSegments: [segment],
      estimate: 16,
      options: {
        radiusPixels: 4,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0.3,
        strength: 1,
        color: { r: 255, g: 0, b: 0 },
        useVisibilityMask: true,
        visibleSurfaceMaskReady: true,
        visibilityMaskKey: `visible-event-${eventIndex}`,
        visibilityMaskSamples: [{ x, y: 12 }],
        visibilityMaskStampRadiusPixels: 5,
        strokeSegments: [segment]
      }
    }];
  };

  const first = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });
  const second = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 2, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.ok(first > 0);
  assert.ok(second > 0);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes[0].strokeSegments.length, 2);
  assert.ok(editor.textureAirbrushQueuedWebGpuStrokes[0].options.visibilityMaskSamples.length > 0);
  assert.equal(
    visibilityMaskPayloadByteLength(editor.textureAirbrushQueuedWebGpuStrokes[0].options.visibilityMaskPixels),
    0
  );
  assert.equal(editor.undoCaptures, undefined);
  assert.ok(scheduled >= 1);
});

test("installed airbrush WebGPU live path can dispatch immediately without a second frame hop", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-visible-immediate" };
  const record = { id: "record-visible-immediate" };
  const editable = {
    texture: { uuid: "texture-visible-immediate" },
    canvas: { width: 64, height: 64 }
  };
  let scheduled = 0;
  let flushed = 0;
  let queuedAtFlush = 0;
  let flushOptions = null;

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = (options = {}) => {
    flushed += 1;
    flushOptions = options;
    queuedAtFlush = editor.textureAirbrushQueuedWebGpuStrokes?.length || 0;
    return Promise.resolve(queuedAtFlush);
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 10, y: 12 },
    radiusPixels: 4,
    strokeSegments: [{ start: { x: 10, y: 12 }, end: { x: 14, y: 12 } }],
    estimate: 16,
    options: {
      radiusPixels: 4,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskSamples: [{ x: 10, y: 12 }],
      visibilityMaskStampRadiusPixels: 5,
      strokeSegments: [{ start: { x: 10, y: 12 }, end: { x: 14, y: 12 } }]
    }
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    immediateWebGpuFlush: true
  });

  assert.ok(changed > 0);
  assert.equal(flushed, 1);
  assert.equal(queuedAtFlush, 1);
  assert.equal(scheduled, 0);
  assert.equal(flushOptions.maxBatches, 32);
  assert.equal(flushOptions.force, false);
});

test("installed airbrush WebGPU large direct live path flushes direct batch budget immediately", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-visible-immediate" };
  const record = { id: "record-large-visible-immediate" };
  const editable = {
    texture: { uuid: "texture-large-visible-immediate" },
    canvas: { width: 1024, height: 1024 }
  };
  let flushOptions = null;

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.flushTextureAirbrushQueuedWebGpuStrokes = (options = {}) => {
    flushOptions = options;
    return Promise.resolve(editor.textureAirbrushQueuedWebGpuStrokes?.length || 0);
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options = {}) => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 100, y: 120 },
    radiusPixels: 52,
    strokeSegments: [{ start: { x: 100, y: 120 }, end: { x: 160, y: 120 }, radiusPixels: 52 }],
    estimate: 100,
    options: {
      ...options,
      radiusPixels: 52,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      visibilityMaskSamples: [{ x: 100, y: 120 }],
      visibilityMaskStampRadiusPixels: 52,
      strokeSegments: [{ start: { x: 100, y: 120 }, end: { x: 160, y: 120 }, radiusPixels: 52 }]
    }
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 160, clientY: 80 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    immediateWebGpuFlush: true,
    maxImmediateWebGpuFlushBatches: 4,
    radiusPixels: 52,
    strokeStart: { clientX: 80, clientY: 80 },
    strokeSegments: [{
      start: { clientX: 80, clientY: 80 },
      end: { clientX: 160, clientY: 80 },
      radiusPixels: 52
    }]
  });

  assert.ok(changed > 0);
  assert.equal(flushOptions.maxBatches, 32);
  assert.equal(flushOptions.force, false);
});

test("installed airbrush WebGPU live scheduler flushes on a microtask", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const originalSetTimeout = globalThis.setTimeout;
  let flushed = 0;
  globalThis.setTimeout = () => {
    throw new Error("live WebGPU flush scheduling should not wait for a timer");
  };
  try {
    editor.textureAirbrushQueuedWebGpuStrokes = [{ estimate: 1 }];
    editor.flushTextureAirbrushQueuedWebGpuStrokes = () => {
      flushed += 1;
      return Promise.resolve(1);
    };

    assert.equal(editor.scheduleTextureAirbrushQueuedWebGpuFlush(), true);
    assert.equal(editor.textureAirbrushWebGpuFlushScheduled, true);
    assert.equal(flushed, 0);

    await Promise.resolve();

    assert.equal(flushed, 1);
    assert.equal(editor.textureAirbrushWebGpuFlushScheduled, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("installed airbrush WebGPU live scheduler budgets queued flushes during active strokes", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const originalSetTimeout = globalThis.setTimeout;
  const flushOptions = [];
  globalThis.setTimeout = () => {
    throw new Error("live WebGPU flush scheduling should not wait for a timer");
  };
  try {
    editor.painting = true;
    editor.textureAirbrushQueuedWebGpuStrokes = [{ estimate: 1 }, { estimate: 1 }];
    editor.flushTextureAirbrushQueuedWebGpuStrokes = (options = {}) => {
      flushOptions.push(options);
      return Promise.resolve(1);
    };

    assert.equal(editor.scheduleTextureAirbrushQueuedWebGpuFlush(), true);
    await Promise.resolve();

    assert.equal(flushOptions.length, 1);
    assert.equal(flushOptions[0].maxBatches, 8);

    editor.painting = false;
    editor.textureAirbrushQueuedWebGpuStrokes = [{ estimate: 1 }, { estimate: 1 }];
    assert.equal(editor.scheduleTextureAirbrushQueuedWebGpuFlush(), true);
    await Promise.resolve();

    assert.equal(flushOptions.length, 2);
    assert.equal(flushOptions[1].maxBatches, undefined);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("installed airbrush WebGPU active scheduler does not wait for animation frames", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  let microtasks = 0;
  const flushOptions = [];
  globalThis.requestAnimationFrame = () => {
    throw new Error("active WebGPU stroke flush scheduling should not wait for animation frames");
  };
  globalThis.queueMicrotask = (callback) => {
    microtasks += 1;
    return originalQueueMicrotask ? originalQueueMicrotask(callback) : Promise.resolve().then(callback);
  };
  try {
    editor.painting = true;
    editor.textureAirbrushQueuedWebGpuStrokes = [{ estimate: 1 }, { estimate: 1 }];
    editor.flushTextureAirbrushQueuedWebGpuStrokes = (options = {}) => {
      flushOptions.push(options);
      return Promise.resolve(1);
    };

    assert.equal(editor.scheduleTextureAirbrushQueuedWebGpuFlush(), true);
    assert.equal(microtasks, 1);
    assert.equal(flushOptions.length, 0);

    await Promise.resolve();

    assert.equal(flushOptions.length, 1);
    assert.equal(flushOptions[0].maxBatches, 8);
  } finally {
    if (originalRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalQueueMicrotask === undefined) {
      delete globalThis.queueMicrotask;
    } else {
      globalThis.queueMicrotask = originalQueueMicrotask;
    }
  }
});

test("installed airbrush WebGPU live path throttles high-frequency queue status updates", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-status-throttle" };
  const record = { id: "record-status-throttle" };
  const editable = {
    texture: { uuid: "texture-status-throttle" },
    canvas: { width: 64, height: 64 }
  };
  let now = 1000;
  let scheduled = 0;
  const statuses = [];
  editor.model = {};
  editor.textureAirbrushStatusNow = () => now;
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.setStatus = (message) => {
    statuses.push(message);
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 10, y: 12 },
    radiusPixels: 4,
    strokeSegments: [{ start: { x: 10, y: 12 }, end: { x: 12, y: 12 } }],
    estimate: 16,
    options: {
      radiusPixels: 4,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskSamples: [{ x: 10, y: 12 }],
      visibilityMaskStampRadiusPixels: 5,
      strokeSegments: [{ start: { x: 10, y: 12 }, end: { x: 12, y: 12 } }]
    }
  }];

  for (let index = 0; index < 5; index += 1) {
    assert.ok(editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1 + index, clientY: 1 }, {
      liveProjectedPaint: true,
      requireVisibilityMask: true
    }) > 0);
    now += 10;
  }

  assert.equal(scheduled, 5);
  assert.equal(statuses.length, 1);

  now += 140;
  assert.ok(editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 20, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  }) > 0);

  assert.equal(statuses.length, 2);
});

test("installed airbrush WebGPU live flush throttles high-frequency DOM status updates", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-flush-status-throttle" };
  const record = { id: "record-flush-status-throttle" };
  const editable = {
    texture: { uuid: "texture-flush-status-throttle" },
    canvas: { width: 64, height: 64 }
  };
  let now = 1000;
  const statuses = [];
  const makeCandidate = (index = 0) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 10 + index, y: 12 },
    radiusPixels: 4,
    strokeSegments: [{ start: { x: 10 + index, y: 12 }, end: { x: 12 + index, y: 12 } }],
    estimate: 16,
    undoCaptured: true,
    options: {
      radiusPixels: 4,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 10 + index, y: 12 }, end: { x: 12 + index, y: 12 } }]
    }
  });

  editor.textureAirbrushStatusNow = () => now;
  editor.setStatus = (message) => {
    statuses.push(message);
  };
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.textureAirbrushRunEditableWebGpuPaint = () => fakeVisibleWebGpuPaintResult();
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};

  for (let index = 0; index < 5; index += 1) {
    editor.textureAirbrushQueuedWebGpuStrokes = [makeCandidate(index)];
    await editor.flushTextureAirbrushQueuedWebGpuStrokes();
    now += 10;
  }

  assert.equal(statuses.length, 1);

  now += 140;
  editor.textureAirbrushQueuedWebGpuStrokes = [makeCandidate(10)];
  await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(statuses.length, 2);
});

test("installed airbrush WebGPU live path keeps fast visible strokes continuous before GPU dispatch", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-continuous-live" };
  const record = {
    id: "record-continuous-live",
    object: {},
    geometry: {
      index: {
        count: 6,
        getX(index) {
          return [0, 1, 2, 1, 3, 2][index];
        }
      },
      attributes: {
        uv: {
          count: 4,
          getX(index) {
            return [0, 1, 0, 1][index];
          },
          getY(index) {
            return [0, 0, 1, 1][index];
          }
        }
      }
    }
  };
  const { editable } = fakeEditableTexture(101, 3, new Uint8Array(101 * 3 * 4));
  const queued = [];

  editor.model = {
    updateMatrixWorld() {}
  };
  editor.canvas = {
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: 100,
        height: 10
      };
    }
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.textureBrushRadiusValue = () => 0.08;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.4;
  editor.textureAirbrushScatter = () => 0.3;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.texturePaintHitForEvent = (event) => ({
    record,
    hit: (() => {
      const uvX = Math.max(0, Math.min(1, event.clientX / 100));
      const firstTriangle = uvX <= 0.5;
      return {
        object: record.object,
        distance: 1,
        uv: { x: uvX, y: 0.5 },
        face: firstTriangle
          ? { a: 0, b: 1, c: 2, materialIndex: 0, normal: { z: 1 } }
          : { a: 1, b: 3, c: 2, materialIndex: 0, normal: { z: 1 } },
        faceIndex: firstTriangle ? 0 : 1
      };
    })()
  });
  editor.clonePaintMaterialForHit = (candidateRecord) => candidateRecord === record ? material : null;
  editor.editableClonePaintTexture = (candidateMaterial) => candidateMaterial === material ? editable : null;
  editor.clonePaintTextureUv = (uv) => ({ x: uv.x, y: uv.y });
  editor.clonePaintPixelFromMappedTextureUv = (mappedUv, canvas) => ({
    x: Math.max(0, Math.min(canvas.width - 1, Math.round(mappedUv.x * (canvas.width - 1)))),
    y: 1
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
      return [{
        object: record.object,
        distance: 1,
        uv: { x: Math.max(0, Math.min(1, (editor.pointer.x + 1) / 2)), y: 0.5 },
        face: { materialIndex: 0 }
      }];
    }
  };
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);
  editor.textureAirbrushPaintWebGpuCandidateDirect = () => {
    throw new Error("CPU direct paint should not run for live WebGPU strokes");
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 100,
    clientY: 5
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    radiusPixels: 10,
    strokeSegments: [{
      start: { clientX: 0, clientY: 5 },
      end: { clientX: 100, clientY: 5 }
    }]
  });

  const segments = queued.flatMap((candidate) => candidate.strokeSegments || []);
  const visibilitySegments = queued
    .flatMap((candidate) => candidate.options?.visibilityMaskSamples || [])
    .filter((sample) => sample?.segment);
  const visibilityTriangles = queued
    .flatMap((candidate) => candidate.options?.visibilityMaskTriangles || []);

  assert.ok(changed > 0);
  assert.equal(raycastCount, 0);
  assert.ok(queued.length > 0);
  assert.ok(queued.every((candidate) => candidate.strokeSegments.length <= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS));
  assert.ok(segments.some((segment) => segment.end.x > segment.start.x));
  assert.ok(
    Math.max(...segments.map((segment) => segment.end.x)) - Math.min(...segments.map((segment) => segment.start.x)) >= 80
  );
  assert.ok(visibilitySegments.length > 0);
  assert.ok(visibilityTriangles.length > 0);
  assert.ok(queued.every((candidate) => visibilityMaskPayloadByteLength(candidate.options?.visibilityMaskPixels) === 0));
});

test("installed airbrush WebGPU live path keeps long visible strokes in one shader-capacity batch", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-long-live" };
  const record = { id: "record-long-live" };
  const editable = {
    texture: { uuid: "texture-long-live" },
    canvas: { width: 512, height: 64 }
  };
  const strokeSegments = Array.from({ length: 40 }, (_, index) => ({
    start: { x: index * 2, y: 32 },
    end: { x: index * 2 + 1.5, y: 32 }
  }));
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 40, y: 32 },
    radiusPixels: 4,
    strokeSegments,
    estimate: 80,
    options: {
      radiusPixels: 4,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      visibilityMaskSamples: strokeSegments.map((segment) => ({ segment })),
      visibilityMaskStampRadiusPixels: 5,
      strokeSegments
    }
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(changed, 40);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments.length, 40);
  assert.ok(queued[0].options.visibilityMaskSamples.length > 0);
  assert.equal(visibilityMaskPayloadByteLength(queued[0].options.visibilityMaskPixels), 0);
});

test("installed airbrush WebGPU live path merges screen-projected stroke segments", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-projected-segments" };
  const record = { id: "record-live-projected-segments" };
  const editable = {
    texture: { uuid: "texture-live-projected-segments" },
    canvas: { width: 512, height: 512 }
  };
  const queued = [];
  const baseOptions = {
    liveProjectedPaint: true,
    visibilityMaskMode: "samples",
    radiusPixels: 18,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 0, g: 255, b: 80 },
    useVisibilityMask: true,
    visibleSurfaceMaskReady: true,
    visibilityMaskStampRadiusPixels: 18,
    allowVariableStrokeSegmentRadius: true
  };
  const makeCandidate = (index) => {
    const x = 96 + index * 20;
    const screenX = 300 + index * 22;
    return {
      record,
      material,
      materialIndex: 0,
      editable,
      center: { x: x + 10, y: 220 },
      radiusPixels: 18,
      strokeSegments: [{ start: { x, y: 220 }, end: { x: x + 16, y: 220 } }],
      estimate: 100,
      options: {
        ...baseOptions,
        visibilityMaskTriangles: [{
          a: { x, y: 200 },
          b: { x: x + 24, y: 200 },
          c: { x, y: 232 },
          screenA: { x: screenX, y: 260 },
          screenB: { x: screenX + 24, y: 260 },
          screenC: { x: screenX, y: 292 }
        }],
        screenProjectedStrokeSegments: [{
          start: { x: screenX, y: 276 },
          end: { x: screenX + 18, y: 276 },
          radiusPixels: 18
        }],
        strokeSegments: [{ start: { x, y: 220 }, end: { x: x + 16, y: 220 } }]
      }
    };
  };

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [
    makeCandidate(0),
    makeCandidate(1)
  ];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 320, clientY: 276 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 18
  });

  assert.equal(changed, 2);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments.length, 2);
  assert.equal(queued[0].options.visibilityMaskTriangles.length, 2);
  assert.equal(queued[0].options.screenProjectedStrokeSegments.length, 2);
  assert.deepEqual(
    queued[0].options.screenProjectedStrokeSegments.map((segment) => segment.start.x),
    [300, 322]
  );
});

test("installed airbrush WebGPU live queue replaces stale TSL surface full-path batches", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-queue-tsl-replace" };
  const record = { id: "record-live-queue-tsl-replace" };
  const editable = {
    texture: { uuid: "texture-live-queue-tsl-replace" },
    canvas: { width: 1024, height: 1024 }
  };
  const triangle = {
    a: { x: 20, y: 24 },
    b: { x: 80, y: 24 },
    c: { x: 20, y: 84 },
    screenA: { x: 100, y: 100 },
    screenB: { x: 160, y: 100 },
    screenC: { x: 100, y: 160 }
  };
  const firstScreenSegment = {
    start: { x: 100, y: 128 },
    end: { x: 124, y: 128 },
    radiusPixels: 36
  };
  const secondScreenSegment = {
    start: { x: 124, y: 128 },
    end: { x: 156, y: 128 },
    radiusPixels: 36
  };
  const baseOptions = {
    liveProjectedPaint: true,
    screenStrokePaint: true,
    visibilityMaskMode: "samples",
    radiusPixels: 36,
    opacity: 0.5,
    hardness: 0.25,
    scatter: 0.35,
    strength: 1,
    color: { r: 0, g: 255, b: 80 },
    useVisibilityMask: true,
    visibleSurfaceMaskReady: true,
    fullProjectedSurfaceRenderTriangles: true,
    visibilityMaskTriangles: [triangle]
  };
  const makeCandidate = (screenSegments, x = 48) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x, y: 48 },
    radiusPixels: 36,
    strokeSegments: [{ start: { x, y: 48 }, end: { x: x + 16, y: 48 } }],
    estimate: 10,
    options: {
      ...baseOptions,
      screenProjectedStrokeSegments: screenSegments,
      strokeSegments: [{ start: { x, y: 48 }, end: { x: x + 16, y: 48 } }]
    }
  });

  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate([firstScreenSegment]), {
    scheduleFlush: false
  });
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  const staleBatch = editor.textureAirbrushQueuedWebGpuStrokes[0];

  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate([
    firstScreenSegment,
    secondScreenSegment
  ], 256), {
    scheduleFlush: false
  });

  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 1);
  assert.notEqual(editor.textureAirbrushQueuedWebGpuStrokes[0], staleBatch);
  assert.deepEqual(
    editor.textureAirbrushQueuedWebGpuStrokes[0].options.screenProjectedStrokeSegments.map((segment) => segment.end.x),
    [124, 156]
  );
});

test("installed airbrush WebGPU live path keeps screen-projected radius in screen pixels", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-screen-radius" };
  const record = { id: "record-live-screen-radius" };
  const editable = {
    texture: { uuid: "texture-live-screen-radius" },
    canvas: { width: 4096, height: 4096 }
  };
  const queued = [];
  const textureSegment = {
    start: { x: 1254, y: 2871 },
    end: { x: 1253, y: 2834 },
    screenStart: { x: 525, y: 302 },
    screenEnd: { x: 530, y: 310 },
    screenRadiusPixels: 18,
    radiusPixels: 145
  };

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: textureSegment.end,
    radiusPixels: textureSegment.radiusPixels,
    strokeSegments: [textureSegment],
    estimate: 100,
    options: {
      liveProjectedPaint: true,
      visibilityMaskMode: "samples",
      radiusPixels: textureSegment.radiusPixels,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 0, g: 255, b: 80 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      allowVariableStrokeSegmentRadius: true,
      strokeSegments: [textureSegment],
      visibilityMaskTriangles: [{
        a: { x: 1240, y: 2860 },
        b: { x: 1280, y: 2860 },
        c: { x: 1240, y: 2910 },
        screenA: { x: 520, y: 300 },
        screenB: { x: 540, y: 300 },
        screenC: { x: 520, y: 320 }
      }]
    }
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 530, clientY: 310 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 18
  });

  assert.equal(changed, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].strokeSegments[0].radiusPixels, 145);
  assert.equal(queued[0].strokeSegments[0].screenRadiusPixels, 18);
  assert.equal(queued[0].options.screenProjectedStrokeSegments.length, 1);
  assert.equal(queued[0].options.screenProjectedStrokeSegments[0].radiusPixels, 18);
});

test("installed airbrush WebGPU live path keeps full projected surface triangle permission", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-screen-triangle-filter" };
  const record = { id: "record-live-screen-triangle-filter" };
  const editable = {
    texture: { uuid: "texture-live-screen-triangle-filter" },
    canvas: { width: 4096, height: 4096 }
  };
  const queued = [];
  const segment = {
    start: { x: 1000, y: 1000 },
    end: { x: 1040, y: 1000 },
    screenStart: { x: 500, y: 300 },
    screenEnd: { x: 520, y: 300 },
    screenRadiusPixels: 18,
    radiusPixels: 160
  };
  const uvNearButScreenFarTriangle = {
    a: { x: 1020, y: 990 },
    b: { x: 1060, y: 990 },
    c: { x: 1020, y: 1030 },
    screenA: { x: 800, y: 500 },
    screenB: { x: 830, y: 500 },
    screenC: { x: 800, y: 530 }
  };
  const screenNearTriangle = {
    a: { x: 1010, y: 1010 },
    b: { x: 1050, y: 1010 },
    c: { x: 1010, y: 1050 },
    screenA: { x: 510, y: 292 },
    screenB: { x: 530, y: 292 },
    screenC: { x: 510, y: 312 }
  };

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: segment.end,
    radiusPixels: segment.radiusPixels,
    strokeSegments: [segment],
    estimate: 100,
    options: {
      liveProjectedPaint: true,
      visibilityMaskMode: "samples",
      radiusPixels: segment.radiusPixels,
      screenRadiusPixels: segment.screenRadiusPixels,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 0, g: 255, b: 80 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      allowVariableStrokeSegmentRadius: true,
      strokeSegments: [segment],
      visibilityMaskTriangles: [
        uvNearButScreenFarTriangle,
        screenNearTriangle
      ]
    }
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 520, clientY: 300 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 18
  });

  assert.equal(changed, 1);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].options.visibilityMaskTriangles, [
    uvNearButScreenFarTriangle,
    screenNearTriangle
  ]);
});

test("installed airbrush WebGPU visibility-only probes filter projected triangles in screen space", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-visibility-only-screen-triangle-filter" };
  const record = { id: "record-visibility-only-screen-triangle-filter" };
  const editable = {
    texture: { uuid: "texture-visibility-only-screen-triangle-filter" },
    canvas: { width: 4096, height: 4096 }
  };
  const queued = [];
  const segment = {
    start: { x: 1000, y: 1000 },
    end: { x: 1040, y: 1000 },
    screenStart: { x: 500, y: 300 },
    screenEnd: { x: 520, y: 300 },
    screenRadiusPixels: 18,
    radiusPixels: 160
  };
  const basePaintTriangle = {
    a: { x: 1000, y: 990 },
    b: { x: 1040, y: 990 },
    c: { x: 1000, y: 1030 },
    screenA: { x: 500, y: 292 },
    screenB: { x: 522, y: 292 },
    screenC: { x: 500, y: 314 }
  };
  const uvNearButScreenFarTriangle = {
    a: { x: 1020, y: 990 },
    b: { x: 1060, y: 990 },
    c: { x: 1020, y: 1030 },
    screenA: { x: 800, y: 500 },
    screenB: { x: 830, y: 500 },
    screenC: { x: 800, y: 530 }
  };
  const screenNearVisibilityTriangle = {
    a: { x: 1010, y: 1010 },
    b: { x: 1050, y: 1010 },
    c: { x: 1010, y: 1050 },
    screenA: { x: 510, y: 292 },
    screenB: { x: 530, y: 292 },
    screenC: { x: 510, y: 312 }
  };
  const baseOptions = {
    liveProjectedPaint: true,
    visibilityMaskMode: "samples",
    radiusPixels: segment.radiusPixels,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 0, g: 255, b: 80 },
    useVisibilityMask: true,
    visibleSurfaceMaskReady: true,
    allowVariableStrokeSegmentRadius: true,
    screenProjectedStrokeSegments: [{
      start: segment.screenStart,
      end: segment.screenEnd,
      radiusPixels: segment.screenRadiusPixels
    }]
  };

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: segment.end,
    radiusPixels: segment.radiusPixels,
    strokeSegments: [segment],
    estimate: 100,
    options: {
      ...baseOptions,
      strokeSegments: [segment],
      visibilityMaskTriangles: [basePaintTriangle]
    }
  }, {
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 1024, y: 1010 },
    radiusPixels: segment.radiusPixels,
    strokeSegments: [],
    visibilityOnly: true,
    estimate: 1,
    options: {
      ...baseOptions,
      visibilityOnly: true,
      strokeSegments: [],
      visibilityMaskTriangles: [
        uvNearButScreenFarTriangle,
        screenNearVisibilityTriangle
      ]
    }
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 520, clientY: 300 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 18
  });

  assert.equal(changed, 1);
  assert.equal(queued.length, 1);
  assert.deepEqual(
    queued[0].options.visibilityMaskTriangles,
    [basePaintTriangle, screenNearVisibilityTriangle]
  );
});

test("installed airbrush WebGPU live batching reuses earlier compatible UV island batches", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-reuse-earlier-batch" };
  const record = { id: "record-live-reuse-earlier-batch" };
  const editable = {
    texture: { uuid: "texture-live-reuse-earlier-batch" },
    canvas: { width: 4096, height: 4096 }
  };
  const queued = [];
  const segments = [
    {
      start: { x: 100, y: 100 },
      end: { x: 120, y: 100 },
      radiusPixels: 24
    },
    {
      start: { x: 3200, y: 3200 },
      end: { x: 3220, y: 3200 },
      radiusPixels: 24
    },
    {
      start: { x: 128, y: 100 },
      end: { x: 148, y: 100 },
      radiusPixels: 24
    }
  ];

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.textureAirbrushWebGpuCandidatesFromEvent = () => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: segments.at(-1).end,
    radiusPixels: 24,
    strokeSegments: segments,
    estimate: 100,
    options: {
      liveProjectedPaint: true,
      visibilityMaskMode: "samples",
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 0, g: 255, b: 80 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      allowVariableStrokeSegmentRadius: true,
      strokeSegments: segments
    }
  }];

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 520, clientY: 300 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 24
  });

  assert.equal(changed, 3);
  assert.equal(queued.length, 2);
  assert.deepEqual(
    queued.map((candidate) => candidate.strokeSegments.length).sort((a, b) => a - b),
    [1, 2]
  );
});

test("installed airbrush WebGPU stroke candidate rejects referenced UVs outside the editable texture", () => {
  const material = { uuid: "material-outside-referenced-uv" };
  const record = { id: "record-outside-referenced-uv" };
  const editable = {
    texture: { uuid: "texture-outside-referenced-uv" },
    canvas: { width: 100, height: 100 }
  };
  const editor = {
    textureBrushRadiusValue: () => 0.1,
    textureBrushRadiusScreenPixels: () => 10,
    textureAirbrushOpacity: () => 0.5,
    textureAirbrushHardness: () => 0.4,
    textureAirbrushScatter: () => 0.3,
    textureAirbrushColor: () => ({ r: 255, g: 0, b: 0 }),
    clonePaintMaterialForHit: () => material,
    editableClonePaintTexture: () => editable,
    clonePaintTextureUv: (uv) => ({ x: uv.x, y: uv.y }),
    clonePaintUnwrapTextureCoordinate: (value) => value,
    clonePaintPixelFromMappedTextureUv: (mappedUv, canvas) => ({
      x: Math.round(mappedUv.x * (canvas.width - 1)),
      y: Math.round(mappedUv.y * (canvas.height - 1))
    }),
    clonePaintPixelFromUv: () => ({ x: 0, y: 50 })
  };

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(
    editor,
    record,
    { uv: { x: 1.2, y: 0.5 }, face: { materialIndex: 0 } },
    { clientX: 10, clientY: 10 },
    { referenceUv: { x: 1.2, y: 0.5 } }
  );

  assert.equal(candidate, null);
});

test("installed airbrush WebGPU large projected visibility overflow stays capped in one live pass", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-projected-overflow" };
  const record = { id: "record-live-projected-overflow" };
  const editable = {
    texture: { uuid: "texture-live-projected-overflow" },
    canvas: { width: 1024, height: 1024 }
  };
  const screenStroke = {
    start: { x: 300, y: 260 },
    end: { x: 360, y: 260 },
    radiusPixels: 52
  };
  const triangle = (index) => {
    const x = 100 + (index % 8) * 18;
    const y = 200 + Math.floor(index / 8) * 20;
    const screenX = 300 + (index % 8) * 10;
    const screenY = 240 + Math.floor(index / 8) * 12;
    return {
      a: { x, y },
      b: { x: x + 16, y },
      c: { x, y: y + 18 },
      screenA: { x: screenX, y: screenY },
      screenB: { x: screenX + 12, y: screenY },
      screenC: { x: screenX, y: screenY + 14 }
    };
  };
  const baseOptions = (options = {}) => ({
    liveProjectedPaint: true,
    visibilityMaskMode: "samples",
    radiusPixels: 52,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    strength: 1,
    color: { r: 0, g: 255, b: 80 },
    useVisibilityMask: true,
    visibleSurfaceMaskReady: true,
    visibilityMaskStampRadiusPixels: 52,
    allowVariableStrokeSegmentRadius: true,
    ...(options.allowVisibilityOverflowBatches === true ? { allowVisibilityOverflowBatches: true } : {}),
    maxMergedVisibilityTriangles: options.maxMergedVisibilityTriangles,
    screenProjectedStrokeSegments: [screenStroke]
  });
  const paintCandidate = (options = {}) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 120, y: 220 },
    radiusPixels: 52,
    strokeSegments: [{ start: { x: 120, y: 220 }, end: { x: 140, y: 220 }, radiusPixels: 52 }],
    estimate: 100,
    options: {
      ...baseOptions(options),
      visibilityMaskTriangles: [triangle(0)],
      strokeSegments: [{ start: { x: 120, y: 220 }, end: { x: 140, y: 220 }, radiusPixels: 52 }]
    }
  });
  const visibilityCandidate = (index, options = {}) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 120 + index, y: 220 },
    radiusPixels: 52,
    strokeSegments: [],
    visibilityOnly: true,
    paintRegions: [{ x: 100 + index, y: 200, width: 20, height: 20 }],
    paintBounds: { x: 100 + index, y: 200, width: 20, height: 20 },
    estimate: 1,
    options: {
      ...baseOptions(options),
      visibilityOnly: true,
      visibilityMaskTriangles: [triangle(index)]
    }
  });
  const queued = [];
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options = {}) => [
    paintCandidate(options),
    ...Array.from({ length: 55 }, (_, index) => visibilityCandidate(index + 1, options))
  ];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 320, clientY: 260 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 52,
    strokeStart: { clientX: 300, clientY: 260 },
    strokeSegments: [{
      start: { clientX: 300, clientY: 260 },
      end: { clientX: 360, clientY: 260 },
      radiusPixels: 52
    }]
  });

  assert.equal(changed, 1);
  assert.equal(queued.length, 1);
  const expectedVisibilityTriangleCount = Math.min(
    56,
    TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_SCREEN_PROJECTED_TRIANGLE_CAP
  );
  assert.deepEqual(
    queued.map((candidate) => candidate.options.visibilityMaskTriangles.length),
    [expectedVisibilityTriangleCount]
  );
  assert.ok(queued.every((candidate) => candidate.strokeSegments.length === 1));
  assert.ok(queued.every((candidate) => candidate.options.screenProjectedStrokeSegments.length === 1));
  assert.equal(
    queued.reduce((total, candidate) => total + candidate.options.visibilityMaskTriangles.length, 0),
    expectedVisibilityTriangleCount
  );

  const queuedEditor = new TestEditor();
  queuedEditor.model = {};
  queuedEditor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  queuedEditor.textureAirbrushWebGpuCandidatesFromEvent = (event, options = {}) => [
    paintCandidate(options),
    ...Array.from({ length: 55 }, (_, index) => visibilityCandidate(index + 1, options))
  ];
  const queuedChanged = queuedEditor.textureAirbrushWebGpuPaintFromEvent({ clientX: 320, clientY: 260 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 52,
    deferQueuedWebGpuFlush: true,
    strokeStart: { clientX: 300, clientY: 260 },
    strokeSegments: [{
      start: { clientX: 300, clientY: 260 },
      end: { clientX: 360, clientY: 260 },
      radiusPixels: 52
    }]
  });
  const realQueued = queuedEditor.textureAirbrushQueuedWebGpuStrokes || [];

  assert.ok(queuedChanged > 0);
  assert.equal(realQueued.length, 1);
  assert.deepEqual(
    realQueued.map((candidate) => candidate.options.visibilityMaskTriangles.length),
    [expectedVisibilityTriangleCount]
  );
  assert.notEqual(realQueued[0].options.liveVisibilityOverflowBatch, true);

  const overflowEditor = new TestEditor();
  const overflowQueued = [];
  overflowEditor.model = {};
  overflowEditor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  overflowEditor.textureAirbrushWebGpuCandidatesFromEvent = (event, options = {}) => [
    paintCandidate(options),
    ...Array.from({ length: 55 }, (_, index) => visibilityCandidate(index + 1, options))
  ];
  overflowEditor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    overflowQueued.push(candidate);
    return candidate.strokeSegments.length;
  };
  const overflowChanged = overflowEditor.textureAirbrushWebGpuPaintFromEvent({ clientX: 320, clientY: 260 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    radiusPixels: 52,
    allowVisibilityOverflowBatches: true,
    strokeStart: { clientX: 300, clientY: 260 },
    strokeSegments: [{
      start: { clientX: 300, clientY: 260 },
      end: { clientX: 360, clientY: 260 },
      radiusPixels: 52
    }]
  });

  const expectedOverflowTriangleBatches = expectedVisibilityTriangleCount >= 56
    ? [56]
    : [expectedVisibilityTriangleCount, 56 - expectedVisibilityTriangleCount];
  assert.equal(overflowChanged, expectedOverflowTriangleBatches.length);
  assert.equal(overflowQueued.length, expectedOverflowTriangleBatches.length);
  assert.deepEqual(
    overflowQueued.map((candidate) => candidate.options.visibilityMaskTriangles.length),
    expectedOverflowTriangleBatches
  );
  if (expectedOverflowTriangleBatches.length > 1) {
    assert.equal(overflowQueued[1].options.liveVisibilityOverflowBatch, true);
  }
});

test("installed airbrush WebGPU live path keeps ordinary projected surface triangles", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-triangle-cap" };
  const record = { id: "record-live-triangle-cap" };
  const editable = {
    texture: { uuid: "texture-live-triangle-cap" },
    canvas: { width: 256, height: 256 }
  };
  const triangle = (index) => {
    const x = 12 + (index % 5) * 2;
    const y = 12 + Math.floor(index / 5) * 2;
    return {
      a: { x, y },
      b: { x: x + 1, y },
      c: { x, y: y + 1 }
    };
  };
  const candidate = (index, options) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x: 16, y: 16 },
    radiusPixels: 4,
    strokeSegments: [{ start: { x: 16, y: 16 }, end: { x: 18, y: 16 } }],
    estimate: 8,
    options: {
      radiusPixels: 4,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      useVisibilityMask: true,
      visibleSurfaceMaskReady: true,
      maxMergedVisibilityTriangles: options.maxMergedVisibilityTriangles,
      visibilityMaskTriangles: Array.from({ length: 20 }, (_, offset) => triangle(index * 20 + offset)),
      strokeSegments: [{ start: { x: 16, y: 16 }, end: { x: 18, y: 16 } }]
    }
  });
  const queued = [];
  let capturedOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0, y: 0 } } });
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options = {}) => {
    capturedOptions = options;
    return [candidate(0, options)];
  };
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (paintCandidate) => {
    queued.push(paintCandidate);
    return paintCandidate.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => Promise.resolve(queued.length);

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 1, clientY: 1 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(changed, 1);
  assert.equal(capturedOptions.keepVisibilitySamplesWithTriangles, true);
  assert.equal(capturedOptions.maxVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_SCREEN_PROJECTED_TRIANGLE_CAP);
  assert.equal(capturedOptions.maxProbeVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_SCREEN_PROJECTED_TRIANGLE_CAP);
  assert.equal(capturedOptions.maxMergedVisibilityTriangles, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_SCREEN_PROJECTED_TRIANGLE_CAP);
  assert.equal(queued.length, 1);
  assert.equal(
    queued[0].options.visibilityMaskTriangles.length,
    Math.min(20, TEXTURE_AIRBRUSH_WEBGPU_EXPECTED_SCREEN_PROJECTED_TRIANGLE_CAP)
  );
  assert.equal(visibilityMaskPayloadByteLength(queued[0].options.visibilityMaskPixels), 0);
});

test("installed airbrush WebGPU live Neighbor path keeps segment visibility with triangles", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-live-neighbor-segment-mask" };
  const record = { id: "record-live-neighbor-segment-mask" };
  const editable = {
    texture: { uuid: "texture-live-neighbor-segment-mask" },
    canvas: { width: 128, height: 128 }
  };
  const strokeSegments = [{
    start: { x: 24, y: 64 },
    end: { x: 88, y: 64 }
  }];
  const queued = [];
  let candidateOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record, hit: { uv: { x: 0.5, y: 0.5 } } });
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => {
    candidateOptions = options;
    return [{
      record,
      material,
      materialIndex: 0,
      editable,
      center: { x: 88, y: 64 },
      radiusPixels: 8,
      strokeSegments,
      estimate: 64,
      options: {
        ...options,
        radiusPixels: 8,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0.3,
        strength: 1,
        color: { r: 255, g: 0, b: 0 },
        useVisibilityMask: true,
        visibleSurfaceMaskReady: true,
        visibilityMaskTriangles: [{
          a: { x: 24, y: 56 },
          b: { x: 88, y: 56 },
          c: { x: 88, y: 72 }
        }],
        strokeSegments
      }
    }];
  };
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate) => {
    queued.push(candidate);
    return candidate.strokeSegments.length;
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => false;

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 88, clientY: 64 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    neighborPaintSeed: { enabled: true },
    radiusPixels: 8
  });

  assert.equal(changed, 1);
  assert.equal(candidateOptions.keepVisibilitySamplesWithTriangles, true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].options.visibilityMaskTriangles.length, 1);
  assert.ok(queued[0].options.visibilityMaskSamples.some((sample) => (
    sample?.segment?.start?.x === strokeSegments[0].start.x
    && sample?.segment?.end?.x === strokeSegments[0].end.x
  )));
  assert.equal(visibilityMaskPayloadByteLength(queued[0].options.visibilityMaskPixels), 0);
});

test("installed airbrush WebGPU large live Neighbor brushes keep bounded projected surface probes", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  let capturedOptions = null;
  editor.model = {};
  editor.texturePaintHitForEvent = () => ({});
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options) => {
    capturedOptions = options;
    return [];
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent({ clientX: 88, clientY: 64 }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true,
    visibleSurfaceMaskRequired: true,
    neighborPaintSeed: { enabled: true },
    radiusPixels: 37,
    strokeStart: { clientX: 24, clientY: 64 },
    strokeSegments: [{
      start: { clientX: 24, clientY: 64 },
      end: { clientX: 88, clientY: 64 }
    }]
  });

  assert.equal(changed, 0);
  assert.equal(capturedOptions.keepVisibilitySamplesWithTriangles, true);
  assert.equal(capturedOptions.fullBrushVisibilityProbes, undefined);
  assert.equal(capturedOptions.skipVisibilityFootprintProbes, undefined);
  assert.equal(capturedOptions.largeLiveNeighborPaint, true);
  assert.equal(capturedOptions.paintProjectedSurfaceCandidates, true);
  assert.equal(capturedOptions.dedupProjectedSurfacePaintCandidates, true);
  assert.equal(capturedOptions.paintOrderedProbeCandidates, true);
  assert.equal(capturedOptions.visibilityFootprintViewRadiusScale, 1.35);
  assert.equal(capturedOptions.denseVisibilityFootprintProbes, false);
  assert.equal(capturedOptions.maxVisibilityFootprintProbePoints, 10);
  assert.equal(capturedOptions.maxNeighborVisibilityIntersections, 3);
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
  assert.equal(device.calls.filter((call) => (
    call[0] === "beginComputePass"
    && call[1] === "texture-airbrush-editable-compute-pass"
  )).length, 1);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats.deferredReadbackCopy, true);
  assert.equal(editor.textureAirbrushLastWebGpuPaintStats.dispatch, null);
  assert.deepEqual([...state.imageData.data], [
    41, 42, 43, 255,
    51, 52, 53, 255,
    61, 62, 63, 255
  ]);
});

test("installed airbrush WebGPU live path captures undo once for split same-texture batches", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const record = { id: "record-split-undo" };
  const material = { uuid: "material-split-undo" };
  const editable = {
    texture: { uuid: "texture-split-undo" },
    canvas: { width: 4096, height: 4096 }
  };
  const makeCandidate = (x) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x, y: 512 },
    radiusPixels: 10,
    strokeSegments: [{ start: { x, y: 512 }, end: { x: x + 8, y: 512 } }],
    options: {
      radiusPixels: 10,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x, y: 512 }, end: { x: x + 8, y: 512 } }]
    },
    estimate: 100
  });
  let undoCaptureCount = 0;
  const started = [];
  editor.captureTexturePaintCanvasUndoTarget = () => {
    undoCaptureCount += 1;
  };
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.textureAirbrushRunEditableWebGpuPaint = () => fakeVisibleWebGpuPaintResult();
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};
  const start = editor.textureAirbrushStartWebGpuPaintCandidate;
  editor.textureAirbrushStartWebGpuPaintCandidate = function wrappedStart(batch, options = {}) {
    started.push({
      localityKey: batch.localityKey,
      undoCapturedBeforeStart: batch.undoCaptured
    });
    return start.call(this, batch, options);
  };

  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(64), { scheduleFlush: false });
  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(512), { scheduleFlush: false });

  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 2);
  await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(started.length, 2);
  assert.notEqual(started[0].localityKey, started[1].localityKey);
  assert.equal(started[0].undoCapturedBeforeStart, false);
  assert.equal(started[1].undoCapturedBeforeStart, true);
  assert.equal(undoCaptureCount, 1);
});

test("installed airbrush WebGPU live path keeps same-stroke undo capture across flushes", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const record = { id: "record-same-stroke-undo" };
  const material = { uuid: "material-same-stroke-undo" };
  const editable = {
    texture: { uuid: "texture-same-stroke-undo" },
    canvas: { width: 4096, height: 4096 }
  };
  const makeCandidate = (x) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    center: { x, y: 1024 },
    radiusPixels: 10,
    strokeSegments: [{ start: { x, y: 1024 }, end: { x: x + 8, y: 1024 } }],
    options: {
      radiusPixels: 10,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x, y: 1024 }, end: { x: x + 8, y: 1024 } }]
    },
    estimate: 100
  });
  const strokeUndo = {};
  const started = [];
  let undoCaptureCount = 0;
  editor.texturePaintStrokeUndo = strokeUndo;
  editor.captureTexturePaintCanvasUndoTarget = () => {
    undoCaptureCount += 1;
  };
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.textureAirbrushRunEditableWebGpuPaint = () => fakeVisibleWebGpuPaintResult();
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};
  const start = editor.textureAirbrushStartWebGpuPaintCandidate;
  editor.textureAirbrushStartWebGpuPaintCandidate = function wrappedStart(batch, options = {}) {
    started.push(batch.undoCaptured);
    return start.call(this, batch, options);
  };

  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(64), { scheduleFlush: false });
  await editor.flushTextureAirbrushQueuedWebGpuStrokes();
  editor.textureAirbrushQueueWebGpuStrokeCandidate(makeCandidate(512), { scheduleFlush: false });
  await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.deepEqual(started, [false, true]);
  assert.equal(undoCaptureCount, 1);
  assert.ok(strokeUndo.textureAirbrushWebGpuUndoKeys instanceof Set);
  assert.equal(strokeUndo.textureAirbrushWebGpuUndoKeys.size, 1);
});

test("installed airbrush WebGPU live path clips disjoint UV stroke bounds before painting", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const editable = {
    texture: { uuid: "texture-disjoint-display-regions" },
    canvas: { width: 4096, height: 4096 }
  };
  const strokeSegments = [
    { start: { x: 100, y: 100 }, end: { x: 128, y: 100 } },
    { start: { x: 3800, y: 3800 }, end: { x: 3828, y: 3800 } }
  ];
  const runOptions = [];
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.textureAirbrushRunEditableWebGpuPaint = (candidateEditable, options = {}) => {
    assert.equal(candidateEditable, editable);
    runOptions.push(options);
    const displayPixels = (options.displayDirtyRegions || []).reduce((total, region) => (
      total + Math.max(0, Number(region?.width) || 0) * Math.max(0, Number(region?.height) || 0)
    ), 0);
    return {
      applied: true,
      stats: {
        liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false,
        liveDisplayWorkPixels: options.liveDisplayExternalTexture !== false ? displayPixels : 0
      }
    };
  };
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};

  const result = await editor.textureAirbrushStartWebGpuPaintCandidate({
    record: { id: "record-disjoint-display-regions" },
    material: { uuid: "material-disjoint-display-regions" },
    materialIndex: 0,
    editable,
    center: { x: 100, y: 100 },
    radiusPixels: 24,
    paintBounds: { x: 0, y: 0, width: 4096, height: 4096 },
    strokeSegments,
    options: {
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments
    },
    undoCaptured: true,
    estimate: 100
  });

  assert.equal(runOptions.length, 2);
  assert.deepEqual(runOptions.map((options) => options.liveDisplayExternalTexture), [false, undefined]);
  assert.deepEqual(runOptions.map((options) => options.displayDirtyRegions?.length || 0), [0, 2]);
  assert.equal(runOptions[1].forceLiveDisplayDirtyRegions, true);
  assert.ok(runOptions.every((options) => options.paintBounds.width < 128 && options.paintBounds.height < 96));
  assert.ok(runOptions[1].displayDirtyRegions.every((region) => region.width < 128 && region.height < 96));
  assert.ok(runOptions[1].paintBounds.x > 3000);
  assert.equal(result?.splitPaintRuns, 2);
  assert.ok(result?.stats?.liveDisplayWorkPixels < 4096 * 4096 * 0.01);
  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
});

test("installed airbrush WebGPU live path coalesces display regions without merging paint islands", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const editable = {
    texture: { uuid: "texture-display-coalesce-paint-local" },
    canvas: { width: 1024, height: 1024 }
  };
  const paintRegions = [
    { x: 0, y: 0, width: 64, height: 64 },
    { x: 90, y: 0, width: 64, height: 64 },
    { x: 0, y: 200, width: 64, height: 64 },
    { x: 90, y: 200, width: 64, height: 64 }
  ];
  const runOptions = [];
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.textureAirbrushRunEditableWebGpuPaint = (candidateEditable, options = {}) => {
    assert.equal(candidateEditable, editable);
    runOptions.push(options);
    const displayPixels = (options.displayDirtyRegions || []).reduce((total, region) => (
      total + Math.max(0, Number(region?.width) || 0) * Math.max(0, Number(region?.height) || 0)
    ), 0);
    return {
      applied: true,
      stats: {
        liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false,
        liveDisplayWorkPixels: options.liveDisplayExternalTexture !== false ? displayPixels : 0
      }
    };
  };
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};

  const result = await editor.textureAirbrushStartWebGpuPaintCandidate({
    record: { id: "record-display-coalesce-paint-local" },
    material: { uuid: "material-display-coalesce-paint-local" },
    materialIndex: 0,
    editable,
    center: { x: 32, y: 32 },
    radiusPixels: 16,
    paintBounds: { x: 0, y: 0, width: 1024, height: 1024 },
    paintRegions,
    strokeSegments: paintRegions.map((region) => ({
      start: { x: region.x + 32, y: region.y + 32 },
      end: { x: region.x + 32, y: region.y + 32 }
    })),
    options: {
      radiusPixels: 16,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 }
    },
    undoCaptured: true,
    estimate: 100
  });

  assert.equal(runOptions.length, paintRegions.length);
  assert.deepEqual(runOptions.map((options) => options.paintBounds), paintRegions);
  assert.deepEqual(runOptions.map((options) => options.liveDisplayExternalTexture), [
    false,
    false,
    false,
    undefined
  ]);
  assert.equal(runOptions[3].displayDirtyRegions.length, 2);
  assert.deepEqual(runOptions[3].displayDirtyRegions, [
    { x: 0, y: 0, width: 154, height: 64 },
    { x: 0, y: 200, width: 154, height: 64 }
  ]);
  assert.equal(runOptions[3].forceLiveDisplayDirtyRegions, true);
  assert.equal(result?.splitPaintRuns, paintRegions.length);
  assert.equal(result?.stats?.liveDisplayWorkPixels, 154 * 64 * 2);
});

test("installed airbrush WebGPU projected live display refresh pads soft halo regions", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const editable = {
    texture: { uuid: "texture-projected-display-halo" },
    canvas: { width: 1024, height: 1024 }
  };
  const paintRegion = { x: 300, y: 300, width: 80, height: 60 };
  const runOptions = [];
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.textureAirbrushRunEditableWebGpuPaint = (candidateEditable, options = {}) => {
    assert.equal(candidateEditable, editable);
    runOptions.push(options);
    return {
      applied: true,
      stats: {
        liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false,
        liveDisplayWorkPixels: (options.displayDirtyRegions || []).reduce((total, region) => (
          total + Math.max(0, Number(region?.width) || 0) * Math.max(0, Number(region?.height) || 0)
        ), 0)
      }
    };
  };
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};

  await editor.textureAirbrushStartWebGpuPaintCandidate({
    record: { id: "record-projected-display-halo" },
    material: { uuid: "material-projected-display-halo" },
    materialIndex: 0,
    editable,
    center: { x: 340, y: 330 },
    radiusPixels: 160,
    paintBounds: paintRegion,
    paintRegions: [paintRegion],
    strokeSegments: [{
      start: { x: 330, y: 325 },
      end: { x: 350, y: 335 },
      radiusPixels: 160
    }],
    options: {
      radiusPixels: 160,
      opacity: 0.82,
      hardness: 0.2,
      scatter: 0.36,
      strength: 1,
      color: { r: 0, g: 255, b: 102 },
      screenStrokePaint: true,
      liveProjectedPaint: true,
      screenProjectedStrokeSegments: [{
        start: { x: 100, y: 100 },
        end: { x: 120, y: 110 },
        radiusPixels: 40
      }]
    },
    undoCaptured: true,
    estimate: 100
  });

  const padding = Math.ceil(Math.min(192, Math.max(12, airbrushHaloRadius(160, 0.36) * 0.75 + 8)));
  assert.equal(runOptions.length, 1);
  assert.deepEqual(runOptions[0].paintBounds, paintRegion);
  assert.deepEqual(runOptions[0].displayDirtyRegions, [{
    x: paintRegion.x - padding,
    y: paintRegion.y - padding,
    width: paintRegion.width + padding * 2,
    height: paintRegion.height + padding * 2
  }]);
  assert.deepEqual(runOptions[0].deferredCanvasSyncRegions, runOptions[0].displayDirtyRegions);
});

test("installed airbrush WebGPU projected live path splits wasteful paint islands for scoped masks", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const editable = {
    texture: { uuid: "texture-projected-compact-islands" },
    canvas: { width: 4096, height: 4096 }
  };
  const paintRegions = [
    { x: 420, y: 2600, width: 96, height: 96 },
    { x: 520, y: 2600, width: 96, height: 96 },
    { x: 620, y: 2600, width: 96, height: 96 },
    { x: 3100, y: 100, width: 96, height: 96 }
  ];
  const visibilityMaskTriangles = paintRegions.map((region, index) => ({
    a: { x: region.x + 8, y: region.y + 8 },
    b: { x: region.x + 84, y: region.y + 8 },
    c: { x: region.x + 8, y: region.y + 84 },
    screenA: { x: 100 + index * 10, y: 100 },
    screenB: { x: 110 + index * 10, y: 100 },
    screenC: { x: 100 + index * 10, y: 110 }
  }));
  const runOptions = [];
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.textureAirbrushRunEditableWebGpuPaint = (candidateEditable, options = {}) => {
    assert.equal(candidateEditable, editable);
    runOptions.push(options);
    return {
      applied: true,
      stats: {
        liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false,
        liveDisplayWorkPixels: 1
      }
    };
  };
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};

  await editor.textureAirbrushStartWebGpuPaintCandidate({
    record: { id: "record-projected-compact-islands" },
    material: { uuid: "material-projected-compact-islands" },
    materialIndex: 0,
    editable,
    center: { x: 468, y: 2648 },
    radiusPixels: 48,
    paintBounds: { x: 420, y: 100, width: 2776, height: 2596 },
    paintRegions,
    strokeSegments: [{
      start: { x: 468, y: 2648 },
      end: { x: 568, y: 2648 },
      screenStart: { x: 100, y: 100 },
      screenEnd: { x: 112, y: 100 },
      screenRadiusPixels: 40
    }],
    options: {
      radiusPixels: 48,
      opacity: 0.5,
      hardness: 0.2,
      scatter: 0.35,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      liveProjectedPaint: true,
      screenStrokePaint: true,
      visibilityMaskTriangles,
      screenProjectedStrokeSegments: [
        { start: { x: 100, y: 100 }, end: { x: 160, y: 100 }, radiusPixels: 40 },
        { start: { x: 160, y: 100 }, end: { x: 220, y: 100 }, radiusPixels: 40 }
      ]
    },
    undoCaptured: true,
    estimate: 100
  }, {
    liveDisplayExternalTexture: true,
    deferReadbackCopy: true
  });

  assert.equal(runOptions.length, paintRegions.length);
  assert.deepEqual(runOptions.map((options) => options.paintBounds), paintRegions);
  assert.ok(runOptions.every((options) => options.compactPaintRegions !== true));
  assert.deepEqual(
    runOptions.map((options) => options.visibilityMaskTriangles?.length || 0),
    [1, 1, 1, 1]
  );
  assert.deepEqual(
    runOptions.map((options) => options.visibilityMaskTriangles?.[0]?.a.x),
    visibilityMaskTriangles.map((triangle) => triangle.a.x)
  );
  assert.ok(runOptions.every((options) => options.screenProjectedStrokeSegments?.length === 2));
  assert.deepEqual(
    runOptions.map((options) => options.screenProjectedStrokeSegments?.map((segment) => segment.end.x)),
    [[160, 220], [160, 220], [160, 220], [160, 220]]
  );
	});

test("installed airbrush WebGPU live event path keeps disjoint batch bounds splittable for paint", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const editable = {
    texture: { uuid: "texture-live-disjoint-splittable" },
    canvas: { width: 4096, height: 4096 }
  };
  const material = { uuid: "material-live-disjoint-splittable" };
  const record = { id: "record-live-disjoint-splittable" };
  const strokeSegments = [
    { start: { x: 1666, y: 2915 }, end: { x: 1712, y: 2915 } },
    { start: { x: 2180, y: 2915 }, end: { x: 2227, y: 2915 } }
  ];
  const queued = [];

  editor.model = {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, candidateOptions = {}) => [{
    record,
    material,
    materialIndex: 0,
    editable,
    center: strokeSegments.at(-1).end,
    radiusPixels: 24,
    strokeSegments,
    options: {
      ...candidateOptions,
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 0, g: 255, b: 255 },
      strokeSegments
    },
    estimate: 100
  }];
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate, options = {}) => {
    queued.push({ candidate, options });
    return Math.max(1, candidate.strokeSegments?.length || 0);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => true;
  editor.setStatus = () => {};

  const estimate = editor.textureAirbrushWebGpuPaintFromEvent({
    clientX: 2180,
    clientY: 2915,
    buttons: 1
  }, {
    liveProjectedPaint: true,
    requireVisibilityMask: true
  });

  assert.equal(estimate, 2);
  assert.equal(queued.length, 1);
  assert.ok(queued.every((entry) => entry.candidate.options.allowDisjointLiveBatchBounds === true));
  assert.ok(queued.every((entry) => entry.candidate.options.allowDisjointPaintBounds !== true));
  assert.equal(queued.reduce((total, entry) => total + (entry.candidate.strokeSegments?.length || 0), 0), 2);
  assert.ok((queued[0].candidate.paintRegions || []).length >= 2);
});

test("installed airbrush WebGPU live path starts split UV paint runs without sharing mutable buffers", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const device = fakeWebGpuDevice();
  const editable = {
    texture: { uuid: "texture-disjoint-serialized-runs" },
    canvas: { width: 4096, height: 4096 }
  };
  const strokeSegments = [
    { start: { x: 100, y: 100 }, end: { x: 128, y: 100 } },
    { start: { x: 3800, y: 3800 }, end: { x: 3828, y: 3800 } }
  ];
  const order = [];
  const runOptions = [];
  let resolveFirstRun = null;
  editor.textureAirbrushWebGpuDevice = () => device;
  editor.texturePaintCanvasStrokeSourceImage = () => null;
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.textureAirbrushRunEditableWebGpuPaint = (candidateEditable, options = {}) => {
    assert.equal(candidateEditable, editable);
    const runIndex = runOptions.length;
    runOptions.push(options);
    order.push(`start-${runIndex}`);
    if (runIndex === 0) {
      return new Promise((resolve) => {
        resolveFirstRun = () => {
          order.push("resolve-0");
          resolve({
            applied: true,
            stats: { liveDisplayExternalTexture: false }
          });
        };
      });
    }
    return {
      applied: true,
      stats: {
        liveDisplayExternalTexture: options.liveDisplayExternalTexture !== false,
        liveDisplayWorkPixels: 1
      }
    };
  };
  editor.textureAirbrushTrackWebGpuPaint = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.textureAirbrushQueueWebGpuApplyRefresh = () => {};

  const paintPromise = editor.textureAirbrushStartWebGpuPaintCandidate({
    record: { id: "record-disjoint-serialized-runs" },
    material: { uuid: "material-disjoint-serialized-runs" },
    materialIndex: 0,
    editable,
    center: { x: 100, y: 100 },
    radiusPixels: 24,
    paintBounds: { x: 0, y: 0, width: 4096, height: 4096 },
    strokeSegments,
    options: {
      radiusPixels: 24,
      opacity: 0.5,
      hardness: 0.4,
      liveProjectedPaint: true,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments
    },
    undoCaptured: true,
    estimate: 100
  }, {
    allowSharedSplitCommandEncoder: true
  });

  await Promise.resolve();
  assert.deepEqual(order, ["start-0", "start-1"]);
  await Promise.resolve();
  assert.deepEqual(order, ["start-0", "start-1"]);
  assert.equal(typeof resolveFirstRun, "function");

  resolveFirstRun();
  const result = await paintPromise;

  assert.deepEqual(order, ["start-0", "start-1", "resolve-0"]);
  assert.equal(runOptions.length, 2);
  assert.deepEqual(runOptions.map((options) => options.liveDisplayExternalTexture), [undefined, undefined]);
  assert.ok(runOptions.every((options) => options.forceLiveDisplayDirtyRegions !== true));
  assert.equal(new Set(runOptions.map((options) => options.commandEncoder)).size, 1);
  assert.ok(runOptions.every((options) => options.commandEncoder));
  assert.ok(runOptions.every((options) => options.submit === false));
  assert.ok(runOptions.every((options) => options.dedicatedBrushBuffers === true));
  const commandEncoders = device.calls.filter((call) => call[0] === "createCommandEncoder");
  const submitCalls = device.calls.filter((call) => call[0] === "submit");
  assert.equal(commandEncoders.length, 1);
  assert.ok(String(commandEncoders[0][1]).includes("split-live-command-encoder"));
  assert.equal(submitCalls.length, 1);
  assert.equal(result?.splitPaintRuns, 2);
  assert.equal(result?.stats?.liveDisplayExternalTexture, true);
});

test("installed airbrush WebGPU live path defers preview refresh until pending paint drains", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const record = { id: "record-deferred-refresh" };
  const material = { uuid: "material-deferred-refresh" };
  const editable = {
    texture: { uuid: "texture-deferred-refresh" },
    canvas: { width: 8, height: 8 }
  };
  const refreshRecords = [];
  let previewRefreshes = 0;
  let strokeChanged = 0;
  editor.textureAirbrushRunEditableWebGpuPaint = () => Promise.resolve(fakeVisibleWebGpuPaintResult());
  editor.markTexturePaintStrokeChanged = () => {
    strokeChanged += 1;
  };
  editor.refreshCloneSpotlightTextures = (refreshedRecord) => {
    refreshRecords.push(refreshedRecord || null);
  };
  editor.updateClonePaintPreviews = () => {
    previewRefreshes += 1;
  };
  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record,
    material,
    materialIndex: 0,
    editable,
    undoCaptured: true,
    estimate: 12,
    strokeSegments: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }],
    options: {
      radiusPixels: 2,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }]
    }
  }];

  await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(strokeChanged, 1);
  assert.deepEqual(refreshRecords, []);
  assert.equal(previewRefreshes, 0);
  assert.equal(editor.textureAirbrushDeferredWebGpuRefreshRecords.size, 1);

  await editor.flushTextureAirbrushPendingWebGpuPaints();

  assert.deepEqual(refreshRecords, [record]);
  assert.equal(previewRefreshes, 1);
  assert.equal(editor.textureAirbrushDeferredWebGpuRefreshRecords.size, 0);
});

test("installed airbrush WebGPU deferred refresh does not reinitialize live ExternalTexture", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const externalTexture = {
    version: 1,
    needsUpdate: false,
    userData: {
      textureAirbrushExternalWebGpuDisplay: true
    }
  };
  const canvasMap = { uuid: "canvas-map-deferred-external" };
  const material = {
    map: externalTexture,
    needsUpdate: false,
    userData: {
      textureAirbrushWebGpuExternalMap: externalTexture,
      textureAirbrushWebGpuCanvasMap: canvasMap
    }
  };
  let previewRefreshes = 0;
  editor.updateClonePaintPreviews = () => {
    previewRefreshes += 1;
  };
  editor.textureAirbrushDeferredWebGpuDisplayMaterials = new Set([material]);
  editor.textureAirbrushDeferredWebGpuRefreshRecords = new Set();
  editor.textureAirbrushDeferredWebGpuPreviewRefresh = false;

  assert.equal(editor.flushTextureAirbrushDeferredWebGpuApplyRefresh(), true);

  assert.equal(material.map, externalTexture);
  assert.equal(material.needsUpdate, false);
  assert.equal(externalTexture.version, 1);
  assert.equal(externalTexture.needsUpdate, false);
  assert.equal(material.userData.textureAirbrushWebGpuExternalMap, externalTexture);
  assert.equal(material.userData.textureAirbrushWebGpuCanvasMap, canvasMap);
  assert.equal(previewRefreshes, 1);
});

test("installed airbrush WebGPU external display texture mirrors the canvas texture contract", () => {
  class FakeExternalTexture {
    constructor(sourceTexture) {
      this.sourceTexture = sourceTexture;
      this.offset = { copy(value) { this.value = value; } };
      this.repeat = { copy(value) { this.value = value; } };
      this.center = { copy(value) { this.value = value; } };
      this.matrix = { copy(value) { this.value = value; } };
      this.userData = {};
    }
  }
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor, {
    THREE: {
      ExternalTexture: FakeExternalTexture,
      LinearFilter: "linear-filter",
      LinearMipmapLinearFilter: "linear-mipmap-linear",
      LinearMipmapNearestFilter: "linear-mipmap-nearest",
      NearestMipmapLinearFilter: "nearest-mipmap-linear",
      NearestMipmapNearestFilter: "nearest-mipmap-nearest"
    }
  });
  const editor = new TestEditor();
  const gpuTexture = { label: "gpu-live-source" };
  const referenceTexture = {
    name: "paint canvas",
    image: { width: 64, height: 32 },
    colorSpace: "srgb",
    flipY: false,
    channel: 2,
    wrapS: "wrap-s",
    wrapT: "wrap-t",
    magFilter: "mag-filter",
    minFilter: "linear-mipmap-linear",
    anisotropy: 4,
    generateMipmaps: true,
    offset: { x: 0.25 },
    repeat: { x: 0.5 },
    center: { x: 0.75 },
    rotation: 0.35,
    matrixAutoUpdate: false,
    matrix: { elements: [1, 0, 0, 1] }
  };

  const texture = editor.textureAirbrushCreateExternalWebGpuTexture(gpuTexture, referenceTexture, {
    width: 128,
    height: 96,
    name: "live display",
    colorSpace: "srgb-linear"
  });

  assert.ok(texture instanceof FakeExternalTexture);
  assert.equal(texture.sourceTexture, gpuTexture);
  assert.equal(texture.name, "live display");
  assert.deepEqual(texture.image, { width: 128, height: 96 });
  assert.equal(texture.colorSpace, "srgb-linear");
  assert.equal(texture.flipY, false);
  assert.equal(texture.channel, 2);
  assert.equal(texture.wrapS, "wrap-s");
  assert.equal(texture.wrapT, "wrap-t");
  assert.equal(texture.magFilter, "mag-filter");
  assert.equal(texture.minFilter, "linear-filter");
  assert.equal(texture.anisotropy, 4);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.offset.value, referenceTexture.offset);
  assert.equal(texture.repeat.value, referenceTexture.repeat);
  assert.equal(texture.center.value, referenceTexture.center);
  assert.equal(texture.rotation, 0.35);
  assert.equal(texture.matrixAutoUpdate, false);
  assert.equal(texture.matrix.value, referenceTexture.matrix);
  assert.equal(texture.userData.textureAirbrushExternalWebGpuDisplay, true);
  assert.equal(texture.userData.textureAirbrushWebGpuCanvasMap, referenceTexture);
  assert.equal(texture.needsUpdate, true);

  const reused = editor.textureAirbrushCreateExternalWebGpuTexture(gpuTexture, referenceTexture, {
    reuseTexture: texture
  });
  assert.equal(reused, texture);

  const other = editor.textureAirbrushCreateExternalWebGpuTexture({ label: "other" }, referenceTexture, {
    reuseTexture: texture
  });
  assert.notEqual(other, texture);

  const displayReadyTexture = editor.textureAirbrushCreateExternalWebGpuTexture(gpuTexture, {
    ...referenceTexture,
    flipY: true
  }, {
    flipY: false
  });
  assert.equal(displayReadyTexture.flipY, false);

  const mipmappedTexture = editor.textureAirbrushCreateExternalWebGpuTexture(gpuTexture, referenceTexture, {
    width: 128,
    height: 96,
    name: "live mip display",
    colorSpace: "srgb-linear",
    mipmapped: true
  });
  assert.equal(mipmappedTexture.minFilter, "linear-mipmap-linear");
  assert.equal(mipmappedTexture.generateMipmaps, true);
  assert.equal(mipmappedTexture.anisotropy, 4);
});

test("installed airbrush WebGPU queued strokes keep minimal live mipmaps during active strokes", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const capturedOptions = [];
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options) => {
    capturedOptions.push(options);
    return Promise.resolve(fakeVisibleWebGpuPaintResult({ batch }));
  };
  editor.setStatus = () => {};
  editor.painting = true;
  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record: { id: "record-default-mipmap-delay" },
    material: { uuid: "material-default-mipmap-delay" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-default-mipmap-delay" },
      canvas: { width: 8, height: 8 }
    },
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    estimate: 1
  }];

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 1);
  assert.equal(capturedOptions.length, 1);
  assert.equal(capturedOptions[0].deferLiveDisplayMipmaps, true);
  assert.equal(capturedOptions[0].liveDisplayMipmapDelayMs, 0);
  assert.ok(capturedOptions[0].liveDisplayMipmapImmediatePixels > 0);
  assert.ok(capturedOptions[0].liveDisplayMipmapImmediatePixels <= 32 * 1024);
  assert.equal(capturedOptions[0].deferReadbackApply, true);
  assert.equal(capturedOptions[0].deferReadbackCopy, true);
  assert.equal(capturedOptions[0].deferReadbackPrecopy, false);

  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record: { id: "record-large-default-mipmap-delay" },
    material: { uuid: "material-large-default-mipmap-delay" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-large-default-mipmap-delay" },
      canvas: { width: 2048, height: 2048 }
    },
    paintBounds: { x: 0, y: 0, width: 1200, height: 1000 },
    options: {
      radiusPixels: 500,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 100, y: 100 }, end: { x: 1100, y: 900 } }]
    },
    strokeSegments: [{ start: { x: 100, y: 100 }, end: { x: 1100, y: 900 } }],
    estimate: 1
  }];

  await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(capturedOptions[1].deferLiveDisplayMipmaps, true);
  assert.ok(capturedOptions[1].liveDisplayMipmapImmediatePixels <= 2 * 1024 * 1024);
  assert.ok(capturedOptions[1].liveDisplayMipmapImmediatePixels > capturedOptions[0].liveDisplayMipmapImmediatePixels);
  assert.equal(capturedOptions[1].liveDisplayIncludeDeferredDirtyRegions, false);

  editor.painting = false;
  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record: { id: "record-live-projected-after-pointer" },
    material: { uuid: "material-live-projected-after-pointer" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-live-projected-after-pointer" },
      canvas: { width: 2048, height: 2048 }
    },
    paintBounds: { x: 0, y: 0, width: 1200, height: 1000 },
    options: {
      liveProjectedPaint: true,
      visibilityMaskMode: "samples",
      radiusPixels: 500,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 100, y: 100 }, end: { x: 1100, y: 900 } }]
    },
    strokeSegments: [{ start: { x: 100, y: 100 }, end: { x: 1100, y: 900 } }],
    estimate: 1
  }];

  await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(capturedOptions[2].deferLiveDisplayMipmaps, true);
  assert.equal(capturedOptions[2].liveDisplayMipmapImmediatePixels, capturedOptions[1].liveDisplayMipmapImmediatePixels);
  assert.equal(capturedOptions[2].liveDisplayIncludeDeferredDirtyRegions, false);

  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record: { id: "record-default-mipmap-delay-optout" },
    material: { uuid: "material-default-mipmap-delay-optout" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-default-mipmap-delay-optout" },
      canvas: { width: 8, height: 8 }
    },
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    estimate: 1
  }];

  await editor.flushTextureAirbrushQueuedWebGpuStrokes({
    deferReadbackPrecopy: false,
    liveDisplayMipmapImmediatePixels: 0
  });

  assert.equal(capturedOptions[3].deferReadbackPrecopy, false);
  assert.equal(capturedOptions[3].liveDisplayMipmapImmediatePixels, 0);
});

test("installed airbrush WebGPU active queued flush shares one live command encoder", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const device = fakeWebGpuDevice();
  const capturedOptions = [];
  const record = { id: "record-batched-live-encoder" };
  const material = { uuid: "material-batched-live-encoder" };
  const editable = {
    texture: { uuid: "texture-batched-live-encoder" },
    canvas: { width: 64, height: 64 }
  };
  const makeBatch = (index) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    paintBounds: { x: index * 4, y: 0, width: 8, height: 8 },
    options: {
      liveProjectedPaint: true,
      radiusPixels: 4,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: index * 4, y: 0 }, end: { x: index * 4 + 3, y: 0 } }]
    },
    strokeSegments: [{ start: { x: index * 4, y: 0 }, end: { x: index * 4 + 3, y: 0 } }],
    estimate: 8
  });
  editor.painting = true;
  editor.setStatus = () => {};
  editor.textureAirbrushWebGpuDevice = () => device;
  editor.textureAirbrushQueuedWebGpuStrokes = [makeBatch(0), makeBatch(1), makeBatch(2)];
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options = {}) => {
    capturedOptions.push(options);
    return Promise.resolve(fakeVisibleWebGpuPaintResult({ batch }));
  };

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 24);
  assert.equal(capturedOptions.length, 3);
  assert.ok(capturedOptions.every((options) => options.commandEncoder));
  assert.equal(new Set(capturedOptions.map((options) => options.commandEncoder)).size, 1);
  assert.ok(capturedOptions.every((options) => options.submit === false));
  const commandEncoders = device.calls.filter((call) => call[0] === "createCommandEncoder");
  const submitCalls = device.calls.filter((call) => call[0] === "submit");
  assert.equal(commandEncoders.length, 1);
  assert.ok(String(commandEncoders[0][1]).includes("batched-live-command-encoder"));
  assert.equal(submitCalls.length, 1);
});

test("installed airbrush WebGPU active queued flush shares one live command encoder across split UV batches", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const device = fakeWebGpuDevice();
  const capturedOptions = [];
  const record = { id: "record-batched-live-split-encoder" };
  const material = { uuid: "material-batched-live-split-encoder" };
  const editable = {
    texture: { uuid: "texture-batched-live-split-encoder" },
    canvas: { width: 4096, height: 4096 }
  };
  const makeBatch = (index) => {
    const offset = index * 128;
    const paintRegions = [
      { x: 100 + offset, y: 100, width: 48, height: 48 },
      { x: 3200 + offset, y: 3200, width: 48, height: 48 }
    ];
    const strokeSegments = paintRegions.map((region) => ({
      start: { x: region.x + 8, y: region.y + 8 },
      end: { x: region.x + 40, y: region.y + 8 }
    }));
    return {
      record,
      material,
      materialIndex: 0,
      editable,
      paintBounds: { x: 100 + offset, y: 100, width: 3148, height: 3148 },
      paintRegions,
      options: {
        liveProjectedPaint: true,
        allowDisjointLiveBatchBounds: true,
        radiusPixels: 24,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0,
        strength: 1,
        color: { r: 255, g: 0, b: 0 },
        strokeSegments
      },
      strokeSegments,
      estimate: 16
    };
  };
  editor.painting = true;
  editor.setStatus = () => {};
  editor.textureAirbrushWebGpuDevice = () => device;
  editor.textureAirbrushQueuedWebGpuStrokes = [makeBatch(0), makeBatch(1)];
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options = {}) => {
    capturedOptions.push({ batch, options });
    return Promise.resolve(fakeVisibleWebGpuPaintResult({ batch }));
  };

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 32);
  assert.equal(capturedOptions.length, 2);
  assert.ok(capturedOptions.every((entry) => entry.batch.paintRegions.length > 1));
  assert.ok(capturedOptions.every((entry) => entry.options.commandEncoder));
  assert.equal(new Set(capturedOptions.map((entry) => entry.options.commandEncoder)).size, 1);
  assert.ok(capturedOptions.every((entry) => entry.options.submit === false));
  const commandEncoders = device.calls.filter((call) => call[0] === "createCommandEncoder");
  const submitCalls = device.calls.filter((call) => call[0] === "submit");
  assert.equal(commandEncoders.length, 1);
  assert.ok(String(commandEncoders[0][1]).includes("batched-live-command-encoder"));
  assert.equal(submitCalls.length, 1);
});

test("installed airbrush WebGPU screen-stroke split batches keep independent live submissions", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const device = fakeWebGpuDevice();
  const capturedOptions = [];
  const record = { id: "record-screen-split-no-shared-encoder" };
  const material = { uuid: "material-screen-split-no-shared-encoder" };
  const editable = {
    texture: { uuid: "texture-screen-split-no-shared-encoder" },
    canvas: { width: 4096, height: 4096 }
  };
  const makeBatch = (index) => {
    const offset = index * 96;
    const paintRegions = [
      { x: 600 + offset, y: 700, width: 96, height: 96 },
      { x: 2600 + offset, y: 2600, width: 96, height: 96 }
    ];
    const strokeSegments = paintRegions.map((region) => ({
      start: { x: region.x + 16, y: region.y + 16 },
      end: { x: region.x + 80, y: region.y + 16 }
    }));
    return {
      record,
      material,
      materialIndex: 0,
      editable,
      paintBounds: { x: 600 + offset, y: 700, width: 2096, height: 1996 },
      paintRegions,
      screenStrokePaint: true,
      options: {
        screenStrokePaint: true,
        liveProjectedPaint: true,
        allowDisjointLiveBatchBounds: true,
        radiusPixels: 32,
        opacity: 0.5,
        hardness: 0.4,
        scatter: 0,
        strength: 1,
        color: { r: 0, g: 255, b: 0 },
        strokeSegments
      },
      strokeSegments,
      estimate: 16
    };
  };
  editor.painting = true;
  editor.setStatus = () => {};
  editor.textureAirbrushWebGpuDevice = () => device;
  editor.textureAirbrushQueuedWebGpuStrokes = [makeBatch(0), makeBatch(1)];
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options = {}) => {
    capturedOptions.push({ batch, options });
    return Promise.resolve(fakeVisibleWebGpuPaintResult({ batch }));
  };

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 32);
  assert.equal(capturedOptions.length, 2);
  assert.ok(capturedOptions.every((entry) => entry.batch.options.screenStrokePaint === true));
  assert.ok(capturedOptions.every((entry) => !entry.options.commandEncoder));
  assert.ok(capturedOptions.every((entry) => entry.options.submit !== false));
  assert.equal(device.calls.filter((call) => call[0] === "createCommandEncoder").length, 0);
  assert.equal(device.calls.filter((call) => call[0] === "submit").length, 0);
});

test("installed airbrush WebGPU queued strokes defer redundant live display refreshes", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const capturedOptions = [];
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options) => {
    capturedOptions.push({ batch, options });
    return Promise.resolve(fakeVisibleWebGpuPaintResult({ batch }));
  };
  editor.setStatus = () => {};
  const record = { id: "record-display-refresh" };
  const material = { uuid: "material-display-refresh" };
  const editable = {
    texture: { uuid: "texture-display-refresh" },
    canvas: { width: 8, height: 8 }
  };
  const makeBatch = (index, overrides = {}) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    estimate: 1,
    ...overrides
  });
  editor.textureAirbrushQueuedWebGpuStrokes = [
    makeBatch(0),
    makeBatch(1),
    makeBatch(2, {
      material: { uuid: "material-display-refresh-other" }
    })
  ];

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 3);
  assert.equal(capturedOptions.length, 3);
  assert.equal(capturedOptions[0].options.deferLiveDisplayRefresh, true);
  assert.equal(capturedOptions[1].options.deferLiveDisplayRefresh, undefined);
  assert.equal(capturedOptions[2].options.deferLiveDisplayRefresh, undefined);
});

test("installed airbrush WebGPU queued flush reports zero when no candidate paints", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const reports = [];
  editor.textureAirbrushStartWebGpuPaintCandidate = () => Promise.resolve(null);
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  editor.setStatus = () => {};
  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record: { id: "record-no-paint" },
    material: { uuid: "material-no-paint" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-no-paint" },
      canvas: { width: 8, height: 8 }
    },
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    estimate: 1
  }];

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 0);
  assert.deepEqual(reports, [{ backend: "webgpu", webGpuStatus: "dispatch-failed" }]);
  assert.equal(editor.textureAirbrushWebGpuFlushInFlight, null);
});

test("installed airbrush WebGPU queued flush rejects truthy no-op paint results", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const reports = [];
  editor.textureAirbrushStartWebGpuPaintCandidate = () => Promise.resolve({ applied: true });
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  editor.setStatus = () => {};
  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record: { id: "record-truthy-noop-paint" },
    material: { uuid: "material-truthy-noop-paint" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-truthy-noop-paint" },
      canvas: { width: 8, height: 8 }
    },
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    estimate: 1
  }];

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 0);
  assert.deepEqual(reports, [{ backend: "webgpu", webGpuStatus: "dispatch-failed" }]);
});

test("installed airbrush WebGPU queued flush accepts TSL duplicate no-op paint results", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const reports = [];
  editor.textureAirbrushStartWebGpuPaintCandidate = () => Promise.resolve({
    applied: null,
    stats: {
      tslSurfaceAirbrush: true,
      tslSurfaceSkippedDuplicateSegments: true,
      liveDisplayTslRenderTarget: false,
      liveDisplayWorkPixels: 0
    }
  });
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  editor.setStatus = () => {};
  editor.textureAirbrushQueuedWebGpuStrokes = [{
    record: { id: "record-tsl-duplicate-noop" },
    material: { uuid: "material-tsl-duplicate-noop" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-tsl-duplicate-noop" },
      canvas: { width: 8, height: 8 }
    },
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }]
    },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    estimate: 1
  }];

  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(estimate, 0);
  assert.deepEqual(reports, []);
  assert.equal(editor.textureAirbrushWebGpuFlushInFlight, null);
});

test("editable WebGPU live paint fails instead of deferring when required display is unavailable", async () => {
  class TestEditor {}
  const device = fakeWebGpuDevice({ readbackMappedData: new Uint8Array(256) });
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const reports = [];
  editor.renderer = {
    isWebGPURenderer: true,
    backend: {
      isWebGPUBackend: true,
      device
    }
  };
  editor.textureAirbrushExternalWebGpuDisplayEnabled = false;
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  const { editable } = fakeEditableTexture(2, 2, new Uint8Array(2 * 2 * 4));
  const material = {
    map: editable.texture,
    userData: {}
  };

  const result = await editor.textureAirbrushRunEditableWebGpuPaint(editable, {
    material,
    liveDisplayExternalTexture: true,
    requireLiveDisplayTexture: true,
    deferReadbackApply: true,
    deferReadbackCopy: true,
    radiusPixels: 2,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0,
    strength: 1,
    color: { r: 255, g: 0, b: 0 },
    strokeSegments: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]
  });

  const cache = editor.textureAirbrushWebGpuPaintCaches.get(editable.texture);
  assert.equal(result, null);
  assert.deepEqual(reports, [{ backend: "webgpu", webGpuStatus: "live-display-unavailable" }]);
  assert.equal(cache?.deferredCanvasSync, undefined);
  assert.equal(material.map, editable.texture);
  assert.equal(device.calls.some((call) => call[0] === "submit"), false);
});

test("installed airbrush WebGPU active display cadence refreshes same-texture batches while queued", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const capturedOptions = [];
  let resolvePaint = null;
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options) => {
    capturedOptions.push({ batch, options });
    return new Promise((resolve) => {
      resolvePaint = resolve;
    });
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => false;
  editor.setStatus = () => {};
  editor.painting = true;
  editor.textureAirbrushStatusNow = () => 105;
  const record = { id: "record-display-cadence" };
  const material = { uuid: "material-display-cadence" };
  const editable = {
    texture: { uuid: "texture-display-cadence" },
    canvas: { width: 8, height: 8 }
  };
  const makeBatch = (index) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    estimate: 1
  });
  const refreshKey = [
    record.id,
    0,
    material.uuid,
    editable.texture.uuid,
    editable.canvas.width,
    editable.canvas.height
  ].join(":");
  editor.textureAirbrushWebGpuLastDisplayRefreshMsByKey = new Map([[refreshKey, 100]]);
  editor.textureAirbrushQueuedWebGpuStrokes = [
    makeBatch(0),
    makeBatch(1),
    makeBatch(2)
  ];

  const flush = editor.flushTextureAirbrushQueuedWebGpuStrokes({ maxBatches: 1 });

  assert.equal(capturedOptions.length, 1);
  assert.notEqual(capturedOptions[0].options.deferLiveDisplayRefresh, true);
  resolvePaint(fakeVisibleWebGpuPaintResult());
  await flush;
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
    return Promise.resolve(fakeVisibleWebGpuPaintResult({ batch }));
  };
  globalThis.setTimeout = () => {
    throw new Error("live WebGPU flush scheduling should not wait for a timer");
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
    assert.equal(undoCaptureCount, 0);
    assert.equal(editor.textureAirbrushWebGpuFlushScheduled, true);

    resolveFirstFlush(null);
    await firstFlush;
    await Promise.resolve();

    await editor.flushTextureAirbrushPendingWebGpuPaints();

    assert.equal(started.length, 2);
    assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 0);
    assert.equal(editor.textureAirbrushWebGpuFlushInFlight, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("installed airbrush WebGPU live flush starts queued batches without promise-chain gaps", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-parallel-start" };
  const record = { id: "record-parallel-start" };
  const editable = {
    texture: { uuid: "texture-parallel-start" },
    canvas: { width: 8, height: 8 }
  };
  const makeBatch = (index = 0) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 1,
    styleKey: `style-${index}`,
    localityKey: `locality-${index}`,
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    estimate: 1,
    undoCaptured: true
  });
  let resolveFirstStart = null;
  const started = [];
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch) => {
    started.push(batch);
    if (started.length === 1) {
      return new Promise((resolve) => {
        resolveFirstStart = resolve;
      });
    }
    return Promise.resolve(fakeVisibleWebGpuPaintResult());
  };
  editor.textureAirbrushQueuedWebGpuStrokes = [
    makeBatch(0),
    makeBatch(2),
    makeBatch(4)
  ];

  const flush = editor.flushTextureAirbrushQueuedWebGpuStrokes();

  assert.equal(started.length, 3);
  assert.equal(editor.textureAirbrushWebGpuFlushInFlight, flush);

  resolveFirstStart(fakeVisibleWebGpuPaintResult());
  assert.equal(await flush, 3);
  assert.equal(editor.textureAirbrushWebGpuFlushInFlight, null);
});

test("installed airbrush WebGPU live flush budgets pointer-time queued batches", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-budgeted-flush" };
  const record = { id: "record-budgeted-flush" };
  const editable = {
    texture: { uuid: "texture-budgeted-flush" },
    canvas: { width: 8, height: 8 }
  };
  const makeBatch = (index = 0) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 1,
    styleKey: `style-${index}`,
    localityKey: `locality-${index}`,
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    estimate: 1,
    undoCaptured: true
  });
  const started = [];
  let scheduled = 0;
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch) => {
    started.push(batch);
    return Promise.resolve(fakeVisibleWebGpuPaintResult());
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduled += 1;
    return true;
  };

  editor.textureAirbrushQueuedWebGpuStrokes = [
    makeBatch(0),
    makeBatch(2),
    makeBatch(4)
  ];
  const budgetedEstimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes({ maxBatches: 1 });

  assert.equal(budgetedEstimate, 1);
  assert.deepEqual(started.map((batch) => batch.styleKey), ["style-0"]);
  assert.deepEqual(
    editor.textureAirbrushQueuedWebGpuStrokes.map((batch) => batch.styleKey),
    ["style-2", "style-4"]
  );
  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushWebGpuFlushInFlight, null);

  started.length = 0;
  scheduled = 0;
  editor.textureAirbrushQueuedWebGpuStrokes = [
    makeBatch(6),
    makeBatch(8),
    makeBatch(10)
  ];
  const forcedEstimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes({
    force: true,
    maxBatches: 1
  });

  assert.equal(forcedEstimate, 3);
  assert.deepEqual(started.map((batch) => batch.styleKey), ["style-6", "style-8", "style-10"]);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 0);
  assert.equal(scheduled, 0);
});

test("installed airbrush WebGPU large live Neighbor queued flush drains bounded batches per frame", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-neighbor-budgeted-flush" };
  const record = { id: "record-large-neighbor-budgeted-flush" };
  const editable = {
    texture: { uuid: "texture-large-neighbor-budgeted-flush" },
    canvas: { width: 8, height: 8 }
  };
  const makeBatch = (index = 0) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 40,
    styleKey: `large-neighbor-style-${index}`,
    localityKey: `large-neighbor-locality-${index}`,
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    options: {
      radiusPixels: 40,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      largeLiveNeighborPaint: true,
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    estimate: 1,
    undoCaptured: true
  });
  const started = [];
  let scheduled = 0;
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch) => {
    started.push(batch);
    return Promise.resolve(fakeVisibleWebGpuPaintResult());
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduled += 1;
    return true;
  };

  editor.textureAirbrushQueuedWebGpuStrokes = Array.from({ length: 16 }, (_, index) => makeBatch(index * 2));
  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes({ maxBatches: 16 });

  assert.equal(estimate, 16);
  assert.deepEqual(
    started.map((batch) => batch.styleKey),
    Array.from({ length: 16 }, (_, index) => `large-neighbor-style-${index * 2}`)
  );
  assert.deepEqual(
    editor.textureAirbrushQueuedWebGpuStrokes.map((batch) => batch.styleKey),
    []
  );
  assert.equal(scheduled, 0);
});

test("installed airbrush WebGPU large direct queued flush drains direct batch budget per frame", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-direct-budgeted-flush" };
  const record = { id: "record-large-direct-budgeted-flush" };
  const editable = {
    texture: { uuid: "texture-large-direct-budgeted-flush" },
    canvas: { width: 8, height: 8 }
  };
  const makeBatch = (index = 0) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 40,
    styleKey: `large-direct-style-${index}`,
    localityKey: `large-direct-locality-${index}`,
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    options: {
      radiusPixels: 40,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      largeLiveBrushPaint: true,
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    estimate: 1,
    undoCaptured: true
  });
  const started = [];
  let scheduled = 0;
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch) => {
    started.push(batch);
    return Promise.resolve(fakeVisibleWebGpuPaintResult());
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduled += 1;
    return true;
  };

  editor.textureAirbrushQueuedWebGpuStrokes = [
    makeBatch(0),
    makeBatch(2),
    makeBatch(4),
    makeBatch(6)
  ];
  const estimate = await editor.flushTextureAirbrushQueuedWebGpuStrokes({ maxBatches: 4 });

  assert.equal(estimate, 4);
  assert.deepEqual(started.map((batch) => batch.styleKey), [
    "large-direct-style-0",
    "large-direct-style-2",
    "large-direct-style-4",
    "large-direct-style-6"
  ]);
  assert.deepEqual(
    editor.textureAirbrushQueuedWebGpuStrokes.map((batch) => batch.styleKey),
    []
  );
  assert.equal(scheduled, 0);
});

test("installed airbrush WebGPU large live Neighbor queue trims stale batches", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-neighbor-trim" };
  const record = { id: "record-large-neighbor-trim" };
  const editable = {
    texture: { uuid: "texture-large-neighbor-trim" },
    canvas: { width: 2048, height: 2048 }
  };
  const makeQueuedBatch = (index = 0) => ({
    record: { id: `queued-record-${index}` },
    material: { uuid: `queued-material-${index}` },
    materialIndex: 0,
    editable,
    radiusPixels: 40,
    styleKey: `queued-style-${index}`,
    localityKey: `queued-locality-${index}`,
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    options: {
      radiusPixels: 40,
      largeLiveNeighborPaint: true,
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    estimate: 1,
    undoCaptured: true
  });
  const segment = { start: { x: 512, y: 512 }, end: { x: 560, y: 512 }, radiusPixels: 40 };
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 40,
    strokeSegments: [segment],
    options: {
      radiusPixels: 40,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      largeLiveNeighborPaint: true,
      strokeSegments: [segment]
    },
    estimate: 1,
    undoCaptured: true
  };
  editor.textureAirbrushQueuedWebGpuStrokes = Array.from({ length: 64 }, (_, index) => makeQueuedBatch(index));

  editor.textureAirbrushQueueWebGpuStrokeCandidate(candidate, { scheduleFlush: false, largeLiveNeighborPaint: true });

  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 64);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.some((batch) => batch.styleKey === "queued-style-0"), false);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.some((batch) => batch.record === record), true);
});

test("installed airbrush WebGPU large direct queue trims stale batches", () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-large-direct-trim" };
  const record = { id: "record-large-direct-trim" };
  const editable = {
    texture: { uuid: "texture-large-direct-trim" },
    canvas: { width: 2048, height: 2048 }
  };
  const makeQueuedBatch = (index = 0) => ({
    record: { id: `queued-direct-record-${index}` },
    material: { uuid: `queued-direct-material-${index}` },
    materialIndex: 0,
    editable,
    radiusPixels: 40,
    styleKey: `queued-direct-style-${index}`,
    localityKey: `queued-direct-locality-${index}`,
    strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }],
    options: {
      radiusPixels: 40,
      largeLiveBrushPaint: true,
      strokeSegments: [{ start: { x: index, y: 0 }, end: { x: index + 1, y: 0 } }]
    },
    estimate: 1,
    undoCaptured: true
  });
  const segment = { start: { x: 512, y: 512 }, end: { x: 560, y: 512 }, radiusPixels: 40 };
  const candidate = {
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 40,
    strokeSegments: [segment],
    options: {
      radiusPixels: 40,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 0, g: 255, b: 0 },
      largeLiveBrushPaint: true,
      strokeSegments: [segment]
    },
    estimate: 1,
    undoCaptured: true
  };
  editor.textureAirbrushQueuedWebGpuStrokes = Array.from({ length: 64 }, (_, index) => makeQueuedBatch(index));

  editor.textureAirbrushQueueWebGpuStrokeCandidate(candidate, { scheduleFlush: false, largeLiveBrushPaint: true });

  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 64);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.some((batch) => batch.styleKey === "queued-direct-style-0"), false);
  assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.some((batch) => batch.record === record), true);
});

test("installed airbrush WebGPU live flush waits for dispatch but not deferred readback", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-readback-in-flight" };
  const record = { id: "record-readback-in-flight" };
  const editable = {
    texture: { uuid: "texture-readback-in-flight" },
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
  let resolveFirstDispatch;
  let resolveReadback;
  let readbackSettled = false;
  const originalSetTimeout = globalThis.setTimeout;
  const started = [];
  const firstReadback = new Promise((resolve) => {
    resolveReadback = resolve;
  }).then((value) => {
    readbackSettled = true;
    return value;
  });
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch) => {
    started.push(batch);
    if (started.length === 1) {
      return new Promise((resolve) => {
        resolveFirstDispatch = () => resolve(fakeVisibleWebGpuPaintResult({
          readbackPromise: firstReadback
        }));
      });
    }
    return Promise.resolve(fakeVisibleWebGpuPaintResult());
  };
  globalThis.setTimeout = () => {
    throw new Error("live WebGPU flush scheduling should not wait for a timer");
  };
  try {
    editor.textureAirbrushQueuedWebGpuStrokes = [{
      ...candidate,
      undoCaptured: true,
      styleKey: "first"
    }];
    const flush = editor.flushTextureAirbrushQueuedWebGpuStrokes();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(started.length, 1);
    assert.equal(editor.textureAirbrushWebGpuFlushInFlight, flush);

    editor.textureAirbrushQueueWebGpuStrokeCandidate({
      ...candidate,
      strokeSegments: [{ start: { x: 2, y: 0 }, end: { x: 3, y: 0 } }],
      options: {
        ...candidate.options,
        strokeSegments: [{ start: { x: 2, y: 0 }, end: { x: 3, y: 0 } }]
      }
    });

    assert.equal(started.length, 1);
    assert.equal(editor.textureAirbrushWebGpuFlushScheduled, true);

    resolveFirstDispatch();
    await flush;
    await Promise.resolve();

	    assert.equal(readbackSettled, false);
	    if (editor.textureAirbrushWebGpuFlushInFlight) {
	      await editor.textureAirbrushWebGpuFlushInFlight;
	    }
	    assert.equal(editor.textureAirbrushWebGpuFlushInFlight, null);
	    await editor.flushTextureAirbrushPendingWebGpuPaints();

    assert.equal(started.length, 2);
    assert.equal(editor.textureAirbrushQueuedWebGpuStrokes.length, 0);
    resolveReadback(fakeVisibleWebGpuPaintResult());
    await firstReadback;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pending WebGPU flush keeps live display and deferred readback during budgeted queue drain", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const material = { uuid: "material-forced-live-display" };
  const record = { id: "record-forced-live-display" };
  const editable = {
    texture: { uuid: "texture-forced-live-display" },
    canvas: { width: 8, height: 8 }
  };
  const segment = { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };
  const makeCandidate = (index = 0) => ({
    record,
    material,
    materialIndex: 0,
    editable,
    radiusPixels: 1,
    styleKey: `pending-budget-style-${index}`,
    localityKey: `pending-budget-locality-${index}`,
    strokeSegments: [{
      start: { x: index, y: 0 },
      end: { x: index + 1, y: 0 }
    }],
    options: {
      radiusPixels: 1,
      opacity: 0.5,
      hardness: 0.4,
      scatter: 0.3,
      strength: 1,
      color: { r: 255, g: 0, b: 0 },
      strokeSegments: [{
        start: { x: index, y: 0 },
        end: { x: index + 1, y: 0 }
      }]
    },
    estimate: 1,
    undoCaptured: true
  });
  const candidates = Array.from({ length: 5 }, (_, index) => makeCandidate(index));
  const capturedOptions = [];
  const capturedFlushOptions = [];
  const capturedSyncOptions = [];
  const originalFlush = editor.flushTextureAirbrushQueuedWebGpuStrokes.bind(editor);
  editor.flushTextureAirbrushQueuedWebGpuStrokes = (options = {}) => {
    capturedFlushOptions.push({
      autoSchedule: options.autoSchedule,
      force: options.force,
      maxBatches: options.maxBatches,
      queued: editor.textureAirbrushQueuedWebGpuStrokes?.length || 0
    });
    return originalFlush(options);
  };
  editor.textureAirbrushQueuedWebGpuStrokes = candidates;
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options = {}) => {
    assert.ok(candidates.includes(batch));
    capturedOptions.push(options);
    return Promise.resolve(fakeVisibleWebGpuPaintResult());
  };
  editor.textureAirbrushSyncDeferredWebGpuCanvases = (options = {}) => {
    capturedSyncOptions.push(options);
    return [];
  };
  editor.textureAirbrushReleaseDeferredWebGpuReadbacks = () => 0;
  editor.flushTextureAirbrushDeferredWebGpuApplyRefresh = () => {};

  await editor.flushTextureAirbrushPendingWebGpuPaints({
    deferCanvasSyncUntilIdle: true,
    canvasSyncIdleDelayMs: 0
  });

  assert.deepEqual(capturedFlushOptions.map((entry) => entry.queued), [5]);
  assert.equal(capturedFlushOptions[0].force, false);
  assert.equal(capturedFlushOptions[0].autoSchedule, false);
  assert.equal(capturedFlushOptions[0].maxBatches, 8);
  assert.equal(capturedOptions.length, 5);
  assert.equal(capturedOptions[0].force, false);
  assert.equal(capturedOptions[0].liveDisplayExternalTexture, true);
  assert.equal(capturedOptions[0].deferReadbackApply, true);
  assert.equal(capturedOptions[0].deferReadbackStart, true);
  assert.equal(capturedOptions[0].deferReadbackCopy, true);
  assert.equal(capturedOptions[0].deferReadbackPrecopy, true);
  assert.equal(capturedSyncOptions.length, 1);
  assert.equal(capturedSyncOptions[0].canvasSyncApplyBudgetMs, 4);
});

test("pending WebGPU flush can still force queue drain explicitly", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const candidate = {
    record: { id: "record-explicit-forced-pending-drain" },
    material: { uuid: "material-explicit-forced-pending-drain" },
    materialIndex: 0,
    editable: {
      texture: { uuid: "texture-explicit-forced-pending-drain" },
      canvas: { width: 8, height: 8 }
    },
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
    estimate: 1,
    undoCaptured: true
  };
  const capturedOptions = [];
  editor.textureAirbrushQueuedWebGpuStrokes = [candidate];
  editor.textureAirbrushStartWebGpuPaintCandidate = (batch, options = {}) => {
    assert.equal(batch, candidate);
    capturedOptions.push(options);
    return Promise.resolve(fakeVisibleWebGpuPaintResult());
  };
  editor.textureAirbrushSyncDeferredWebGpuCanvases = () => [];
  editor.textureAirbrushReleaseDeferredWebGpuReadbacks = () => 0;
  editor.flushTextureAirbrushDeferredWebGpuApplyRefresh = () => {};

  await editor.flushTextureAirbrushPendingWebGpuPaints({
    deferCanvasSyncUntilIdle: true,
    forceQueuedDrain: true,
    canvasSyncIdleDelayMs: 0
  });

  assert.equal(capturedOptions.length, 1);
  assert.equal(capturedOptions[0].force, true);
});

test("pending WebGPU canvas sync waits for continuous idle before releasing readbacks", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const advance = async (deltaMs) => {
    const target = now + deltaMs;
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (timers[0].at > target) {
        break;
      }
      const timer = timers.shift();
      now = timer.at;
      timer.callback();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };

  let releaseCount = 0;
  let syncCount = 0;
  editor.painting = true;
  editor.textureAirbrushStatusNow = () => now;
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => 0;
  editor.textureAirbrushReleaseDeferredWebGpuReadbacks = () => {
    releaseCount += 1;
    return 1;
  };
  editor.textureAirbrushSyncDeferredWebGpuCanvases = () => {
    syncCount += 1;
    return [];
  };
  editor.flushTextureAirbrushDeferredWebGpuApplyRefresh = () => {};
  globalThis.setTimeout = (callback, delayMs = 0) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.push({
      id,
      callback,
      at: now + Math.max(0, Number(delayMs) || 0)
    });
    return id;
  };

  try {
    const pending = editor.flushTextureAirbrushPendingWebGpuPaints({
      deferCanvasSyncUntilIdle: true,
      canvasSyncIdleDelayMs: 100,
      canvasSyncIdlePollMs: 10,
      canvasSyncMaxDelayMs: 1000
    });

    await advance(500);
    assert.equal(releaseCount, 0);
    assert.equal(syncCount, 0);

    editor.painting = false;
    await advance(90);
    assert.equal(releaseCount, 0);
    assert.equal(syncCount, 0);

    await advance(50);
    await pending;
    assert.equal(releaseCount, 1);
    assert.equal(syncCount, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pending WebGPU canvas sync waits for pointer quiet after paint", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const advance = async (deltaMs) => {
    const target = now + deltaMs;
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (timers[0].at > target) {
        break;
      }
      const timer = timers.shift();
      now = timer.at;
      timer.callback();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };

  let releaseCount = 0;
  let syncCount = 0;
  editor.painting = false;
  editor.textureAirbrushStatusNow = () => now;
  editor.texturePaintLastPointerEventAt = 100;
  editor.textureAirbrushDeferredCanvasSyncPointerQuietMs = 250;
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => 0;
  editor.textureAirbrushReleaseDeferredWebGpuReadbacks = () => {
    releaseCount += 1;
    return 1;
  };
  editor.textureAirbrushSyncDeferredWebGpuCanvases = () => {
    syncCount += 1;
    return [];
  };
  editor.flushTextureAirbrushDeferredWebGpuApplyRefresh = () => {};
  globalThis.setTimeout = (callback, delayMs = 0) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.push({
      id,
      callback,
      at: now + Math.max(0, Number(delayMs) || 0)
    });
    return id;
  };

  try {
    now = 100;
    const pending = editor.flushTextureAirbrushPendingWebGpuPaints({
      deferCanvasSyncUntilIdle: true,
      canvasSyncIdleDelayMs: 50,
      canvasSyncIdlePollMs: 10,
      canvasSyncMaxDelayMs: 1000
    });

    await advance(220);
    assert.equal(releaseCount, 0);
    assert.equal(syncCount, 0);

    await advance(100);
    await pending;
    assert.equal(releaseCount, 1);
    assert.equal(syncCount, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pending WebGPU canvas sync waits for OrbitControls to become idle", async () => {
  class TestEditor {}
  installTextureAirbrushWebGpuMethods(TestEditor);
  const editor = new TestEditor();
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const advance = async (deltaMs) => {
    const target = now + deltaMs;
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (timers[0].at > target) {
        break;
      }
      const timer = timers.shift();
      now = timer.at;
      timer.callback();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  };

  let releaseCount = 0;
  let syncCount = 0;
  editor.painting = false;
  editor.controls = {
    state: 0,
    _pointers: [17]
  };
  editor.textureAirbrushStatusNow = () => now;
  editor.flushTextureAirbrushQueuedWebGpuStrokes = () => 0;
  editor.textureAirbrushReleaseDeferredWebGpuReadbacks = () => {
    releaseCount += 1;
    return 1;
  };
  editor.textureAirbrushSyncDeferredWebGpuCanvases = () => {
    syncCount += 1;
    return [];
  };
  editor.flushTextureAirbrushDeferredWebGpuApplyRefresh = () => {};
  globalThis.setTimeout = (callback, delayMs = 0) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.push({
      id,
      callback,
      at: now + Math.max(0, Number(delayMs) || 0)
    });
    return id;
  };

  try {
    const pending = editor.flushTextureAirbrushPendingWebGpuPaints({
      deferCanvasSyncUntilIdle: true,
      canvasSyncIdleDelayMs: 50,
      canvasSyncIdlePollMs: 10,
      canvasSyncMaxDelayMs: 1000
    });

    await advance(500);
    assert.equal(releaseCount, 0);
    assert.equal(syncCount, 0);

    editor.controls.state = -1;
    editor.controls._pointers = [];
    await advance(40);
    assert.equal(releaseCount, 0);
    assert.equal(syncCount, 0);

    await advance(50);
    await pending;
    assert.equal(releaseCount, 1);
    assert.equal(syncCount, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
