import assert from "node:assert/strict";
import test from "node:test";
import { installAssetExportMethods } from "../../src/weight-editor/asset-export.js";
import { installPaintToolMethods } from "../../src/weight-editor/paint-tools.js";
import { installTextureAirbrushMethods } from "../../src/weight-editor/airbrush/install.js";
import {
  installTextureAirbrushPointerMethods,
  screenTriangleDistance
} from "../../src/weight-editor/airbrush/pointer.js";
import { installTextureAirbrushNeighborPaintMethods } from "../../src/weight-editor/airbrush/neighbor.js";
import { installTextureAirbrushScreenStrokeMethods } from "../../src/weight-editor/airbrush/screen-strokes.js";
import { installTextureAirbrushWebGpuMethods } from "../../src/weight-editor/airbrush/webgpu.js";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../../src/weight-editor/airbrush/constants.js";

function strokePayload(overrides = {}) {
  return {
    clientX: 24,
    clientY: 30,
    strokeStart: { clientX: 18, clientY: 24 },
    radiusPixels: 8,
    color: { r: 32, g: 220, b: 80 },
    opacity: 0.5,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    styleKey: "8:32:220:80:500:350:350:1000:paint:soft:texture:0:all",
    styleRadiusPixels: 8,
    styleColor: { r: 32, g: 220, b: 80 },
    styleOpacity: 0.5,
    styleHardness: 0.35,
    styleScatter: 0.35,
    styleStrength: 1,
    ...overrides
  };
}

function installEditorDefaults(editor) {
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushColor = () => ({ r: 32, g: 220, b: 80 });
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushVisibleEdgeMode = () => "soft";
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};
}

test("visible Neighbor connectivity measures triangle pixels instead of overlapping bounds", () => {
  const chest = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 }
  ];
  const armAcrossAirGap = [
    { x: 10, y: 10 },
    { x: 10, y: 6 },
    { x: 6, y: 10 }
  ];
  const touchingNeighbor = [
    { x: 10, y: 10 },
    { x: 10, y: 0 },
    { x: 0, y: 10 }
  ];

  assert.ok(
    screenTriangleDistance(chest, armAcrossAirGap) > 4,
    "overlapping triangle bounds must not erase a real screen-space air gap"
  );
  assert.equal(screenTriangleDistance(chest, touchingNeighbor), 0);
});

test("WebGPU screen stroke flush reports unavailable backend instead of using legacy projected paint", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const reports = [];
  let backendOptions = null;
  editor.textureAirbrushScreenStrokeQueue = [strokePayload()];
  editor.textureAirbrushWebGpuDevice = () => null;
  editor.textureAirbrushResolveBackend = (options = {}) => {
    backendOptions = options;
    return { backend: "none", webGpuStatus: "backend-uninitialized" };
  };
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  editor.textureAirbrushProjectedMeshFromEvent = () => {
    throw new Error("WebGPU-only airbrush must not fall back to projected paint");
  };

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 0);

  assert.equal(backendOptions?.liveProjectedPaint, true);
  assert.equal(backendOptions?.visibleSurfaceMaskRequired, true);
  assert.deepEqual(reports, [{ backend: "none", webGpuStatus: "backend-uninitialized" }]);
});

test("layer eraser batches use the live WebGPU surface path", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const paintCalls = [];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintCalls.push({ event, options });
    return 1;
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    erase: true,
    layerMode: true,
    layerMutationSerial: 0,
    styleKey: "8:32:220:80:500:350:350:1000:erase:soft:layer:0:all"
  })];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.equal(paintCalls.length, 1);
  assert.equal(paintCalls[0].options.erase, true);
  assert.equal(paintCalls[0].options.layerMode, true);
  assert.equal(paintCalls[0].options.gpu, true);
  assert.equal(paintCalls[0].options.resolvedBackend?.backend, "webgpu");
});

test("texture-mode WebGPU pressure-radius strokes keep per-segment radii", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const paintCalls = [];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintCalls.push({ event, options });
    return 1;
  };
  editor.textureAirbrushScreenStrokeQueue = [
    strokePayload({
      clientX: 20,
      clientY: 20,
      strokeStart: { clientX: 10, clientY: 20 },
      radiusPixels: 4,
      styleRadiusPixels: 4,
      pressureRadius: true,
      pressurePointer: true,
      pressureApplied: true
    }),
    strokePayload({
      clientX: 30,
      clientY: 20,
      strokeStart: { clientX: 20, clientY: 20 },
      radiusPixels: 8,
      styleRadiusPixels: 8,
      pressureRadius: true,
      pressurePointer: true,
      pressureApplied: true
    })
  ];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.equal(paintCalls.length, 1);
  assert.deepEqual(
    paintCalls[0].options.strokeSegments.map((segment) => segment.radiusPixels),
    [4, 8]
  );
  assert.equal(paintCalls[0].options.radiusPixels, 8);
});

test("pressure-controlled screen batches preserve channel identity through the WebGPU paint call", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const paintCalls = [];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintCalls.push({ event, options });
    return 1;
  };
  editor.textureAirbrushScreenStrokeQueue = [
    strokePayload({
      opacity: 0.2,
      styleOpacity: 0.2,
      styleKey: "pressure-low",
      pressurePointer: true,
      pressureOpacity: true,
      pressureHardness: true,
      pressureScatter: true
    }),
    strokePayload({
      clientX: 32,
      strokeStart: { clientX: 24, clientY: 30 },
      opacity: 0.5,
      styleOpacity: 0.5,
      styleKey: "pressure-high",
      pressurePointer: true,
      pressureOpacity: true,
      pressureHardness: true,
      pressureScatter: true
    })
  ];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 2);
  assert.equal(paintCalls.length, 2);
  for (const call of paintCalls) {
    assert.equal(call.options.pressurePointer, true);
    assert.equal(call.options.pressureOpacity, true);
    assert.equal(call.options.pressureHardness, true);
    assert.equal(call.options.pressureScatter, true);
  }
});

test("continuous WebGPU screen strokes collapse accumulated path duplicates before painting", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const paintCalls = [];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintCalls.push({ event, options });
    return 1;
  };
  const p0 = { clientX: 10, clientY: 20 };
  const p1 = { clientX: 20, clientY: 20 };
  const p2 = { clientX: 30, clientY: 20 };
  const p3 = { clientX: 42, clientY: 20 };
  editor.textureAirbrushScreenStrokeQueue = [
    strokePayload({
      clientX: p1.clientX,
      clientY: p1.clientY,
      strokeStart: p0,
      continuousStrokePoints: [p0, p1]
    }),
    strokePayload({
      clientX: p2.clientX,
      clientY: p2.clientY,
      strokeStart: p1,
      continuousStrokePoints: [p0, p1, p2]
    }),
    strokePayload({
      clientX: p3.clientX,
      clientY: p3.clientY,
      strokeStart: p2,
      continuousStrokePoints: [p0, p1, p2, p3]
    })
  ];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.equal(paintCalls.length, 1);
  assert.deepEqual(
    paintCalls[0].options.strokeSegments.map((segment) => [segment.start, segment.end]),
    [
      [p0, p1],
      [p1, p2],
      [p2, p3]
    ]
  );
});

test("continuous WebGPU screen strokes merge full paths without backtracking to stale curve points", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const paintCalls = [];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintCalls.push({ event, options });
    return 1;
  };
  const p0 = { clientX: 10, clientY: 20 };
  const p1 = { clientX: 20, clientY: 20 };
  const p2 = { clientX: 30, clientY: 20 };
  const p3 = { clientX: 42, clientY: 20 };
  const payload = strokePayload({
    clientX: p3.clientX,
    clientY: p3.clientY,
    strokeStart: p0,
    curvePoints: [p1, p2],
    continuousStrokePoints: [p0, p1, p2, p3]
  });
  editor.textureAirbrushContinuousScreenStrokePath = {
    key: `${payload.styleKey}|no-undo|0|paint`,
    strokeUndo: null,
    points: [p0, p1, p2]
  };
  editor.textureAirbrushScreenStrokeQueue = [payload];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.equal(paintCalls.length, 1);
  assert.deepEqual(
    paintCalls[0].options.strokeSegments.map((segment) => [segment.start, segment.end]),
    [
      [p0, p1],
      [p1, p2],
      [p2, p3]
    ]
  );
});

test("continuous Neighbor screen strokes preserve view-space surface anchors", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const start = {
    clientX: 10,
    clientY: 20,
    textureAirbrushSurfaceAnchor: {
      view: { x: -0.2, y: 0.1, z: -2 },
      normal: { x: 0, y: 0, z: 1 },
      viewRadiusPixels: 0.04,
      component: 3
    }
  };
  const end = {
    clientX: 30,
    clientY: 24,
    textureAirbrushSurfaceAnchor: {
      view: { x: 0.2, y: 0.08, z: -2.02 },
      normal: { x: 0, y: 0.6, z: 0.8 },
      viewRadiusPixels: 0.05,
      component: 3
    }
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: end.clientX,
    clientY: end.clientY,
    strokeStart: start,
    continuousStrokePoints: [start, end],
    neighborPaintSeed: { enabled: true },
    neighborPaintKey: "torso"
  })];

  const [batch] = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);

  assert.equal(batch.strokeSegments.length, 1);
  assert.deepEqual(batch.strokeSegments[0], {
    start,
    end,
    viewStart: start.textureAirbrushSurfaceAnchor.view,
    viewEnd: end.textureAirbrushSurfaceAnchor.view,
    viewNormalStart: start.textureAirbrushSurfaceAnchor.normal,
    viewNormalEnd: end.textureAirbrushSurfaceAnchor.normal,
    viewRadiusPixels: 0.05,
    componentStart: 3,
    componentEnd: 3
  });
});

test("continuous WebGPU screen strokes submit only the new suffix across live flushes", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const paintCalls = [];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintCalls.push({ event, options });
    return 1;
  };
  const p0 = { clientX: 10, clientY: 20 };
  const p1 = { clientX: 20, clientY: 20 };
  const p2 = { clientX: 30, clientY: 20 };
  const p3 = { clientX: 40, clientY: 24 };
  const p4 = { clientX: 50, clientY: 30 };
  const first = strokePayload({
    clientX: p2.clientX,
    clientY: p2.clientY,
    strokeStart: p0,
    strokeReset: true,
    continuousStrokePoints: [p0, p1, p2]
  });
  assert.equal(editor.textureAirbrushAttachContinuousScreenStrokePath(first), true);
  editor.textureAirbrushScreenStrokeQueue = [first];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  const second = strokePayload({
    clientX: p4.clientX,
    clientY: p4.clientY,
    strokeStart: p2,
    continuousStrokePoints: [p0, p1, p2, p3, p4]
  });
  assert.equal(editor.textureAirbrushAttachContinuousScreenStrokePath(second), true);
  editor.textureAirbrushScreenStrokeQueue = [second];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.equal(paintCalls.length, 2);
  assert.deepEqual(
    paintCalls[0].options.strokeSegments.map((segment) => [segment.start, segment.end]),
    [[p0, p1], [p1, p2]]
  );
  const continuationSegments = paintCalls[1].options.strokeSegments;
  assert.deepEqual(continuationSegments[0].start, p2);
  assert.deepEqual(continuationSegments.at(-1).end, p4);
  assert.ok(continuationSegments.every((segment) => (
    segment.start.clientX >= p2.clientX
    && segment.end.clientX >= segment.start.clientX
  )));
});

test("continuous WebGPU screen paths stop at reset boundaries", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  const p0 = { clientX: 10, clientY: 20 };
  const p1 = { clientX: 20, clientY: 20 };
  const p2 = { clientX: 80, clientY: 60 };
  const p3 = { clientX: 90, clientY: 60 };
  const first = strokePayload({
    clientX: p1.clientX,
    clientY: p1.clientY,
    strokeStart: p0
  });
  const second = strokePayload({
    clientX: p3.clientX,
    clientY: p3.clientY,
    strokeStart: p2
  });

  assert.equal(editor.textureAirbrushAttachContinuousScreenStrokePath(first), true);
  assert.deepEqual(first.continuousStrokePoints, [p0, p1]);

  editor.textureAirbrushResetStrokeSpacing();

  assert.equal(editor.textureAirbrushAttachContinuousScreenStrokePath(second), true);
  assert.deepEqual(second.continuousStrokePoints, [p2, p3]);
});

test("continuous WebGPU screen paths do not attach across Neighbor identities", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  const p0 = { clientX: 10, clientY: 20 };
  const p1 = { clientX: 20, clientY: 20 };
  const p2 = { clientX: 30, clientY: 20 };
  const p3 = { clientX: 40, clientY: 20 };
  const first = strokePayload({
    clientX: p1.clientX,
    clientY: p1.clientY,
    strokeStart: p0,
    styleKey: "shared-style",
    neighborPaintKey: "torso"
  });
  const second = strokePayload({
    clientX: p3.clientX,
    clientY: p3.clientY,
    strokeStart: p2,
    styleKey: "shared-style",
    neighborPaintKey: "arm"
  });

  assert.equal(editor.textureAirbrushAttachContinuousScreenStrokePath(first), true);
  assert.equal(editor.textureAirbrushAttachContinuousScreenStrokePath(second), true);
  assert.deepEqual(second.continuousStrokePoints, [p2, p3]);
});

test("default airbrush install does not add legacy WebGL backend methods", () => {
  class AppEditor {}
  installTextureAirbrushWebGpuMethods(AppEditor, { THREE: {} });
  installTextureAirbrushMethods(AppEditor, { THREE: {} });
  const editor = new AppEditor();

  assert.equal(typeof editor.textureAirbrushResolveBackend, "function");
  assert.equal(typeof editor.textureAirbrushVisibleSurfacePaintFromEvent, "function");
  assert.equal(editor.textureAirbrushWebGpuRequested(), true);
  assert.equal(editor.textureAirbrushWebGpuRendererRequested(), true);
  assert.equal(editor.textureAirbrushGpuProjectFromEvent, undefined);
  assert.equal(editor.textureAirbrushBrushShaderMaterial, undefined);
  assert.equal(editor.textureAirbrushCopyTextureToTarget, undefined);
  assert.equal(editor.pickTextureGpuSampleColor, undefined);
  assert.equal(editor.pickTextureGpuSampleTarget, undefined);
  assert.equal(editor.textureAirbrushRenderTargetPixelFromUv, undefined);
});

test("texture picker samples editable pixels without WebGL render targets", () => {
  class AppEditor {}
  installTextureAirbrushMethods(AppEditor, {
    THREE: {
      WebGLRenderTarget() {
        throw new Error("texture picking must not allocate a WebGL render target");
      },
      ShaderMaterial() {
        throw new Error("texture picking must not create a WebGL shader material");
      }
    }
  });
  const editor = new AppEditor();
  const material = { map: { uuid: "editable-texture" } };
  const record = { id: "picker-record" };
  const hit = { uv: { x: 0.5, y: 0.5 } };
  editor.renderer = {
    readRenderTargetPixels() {
      throw new Error("texture picking must not use WebGL readRenderTargetPixels");
    }
  };
  editor.clonePaintMaterialForHit = (hitRecord) => hitRecord === record ? material : null;
  editor.editableClonePaintTexture = () => ({
    canvas: { width: 1, height: 1 },
    context: {
      getImageData() {
        return { data: new Uint8ClampedArray([12, 34, 56, 255]) };
      }
    },
    texture: material.map
  });
  editor.clonePaintPixelFromUv = () => ({ x: 0, y: 0 });
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  const colorEvents = [];
  editor.texturePaintColor = {
    value: "",
    dispatchEvent(event) {
      colorEvents.push(event.type);
    }
  };

  assert.equal(editor.pickTextureColorNear(record, hit), true);
  assert.equal(editor.texturePaintColor.value, "#0c2238");
  assert.deepEqual(colorEvents, ["input", "change"]);
  assert.equal(editor.lastStatus, "Picked #0c2238");
});

test("texture picker can write a sampled color to the tint input", () => {
  class AppEditor {}
  installTextureAirbrushMethods(AppEditor, {});
  const editor = new AppEditor();
  const material = { map: { uuid: "editable-texture" } };
  const record = { id: "picker-record" };
  const hit = { uv: { x: 0.5, y: 0.5 } };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => ({
    canvas: { width: 1, height: 1 },
    context: {
      getImageData() {
        return { data: new Uint8ClampedArray([196, 139, 87, 255]) };
      }
    },
    texture: material.map
  });
  editor.clonePaintPixelFromUv = () => ({ x: 0, y: 0 });
  editor.texturePaintColor = { value: "#ffffff" };
  const tintEvents = [];
  const tintInput = {
    value: "#000000",
    dispatchEvent(event) {
      tintEvents.push(event.type);
    }
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(editor.pickTextureColorNear(record, hit, {
    input: tintInput,
    statusLabel: "tint"
  }), true);
  assert.equal(editor.texturePaintColor.value, "#ffffff");
  assert.equal(tintInput.value, "#c48b57");
  assert.deepEqual(tintEvents, ["input", "change"]);
  assert.equal(editor.lastStatus, "Picked tint #c48b57");
});

test("texture picker samples current TSL WebGPU target before stale editable pixels", async () => {
  class AppEditor {}
  installTextureAirbrushMethods(AppEditor, {
    THREE: {
      WebGLRenderTarget() {
        throw new Error("texture picking must not allocate a WebGL render target");
      },
      ShaderMaterial() {
        throw new Error("texture picking must not create a WebGL shader material");
      }
    }
  });
  const editor = new AppEditor();
  const target = {
    width: 4,
    height: 4,
    texture: { uuid: "tsl-target-texture", flipY: false }
  };
  const material = {
    map: target.texture,
    userData: {
      texturePaintTslSurfaceAirbrushTarget: {
        target,
        width: 4,
        height: 4
      }
    }
  };
  const record = { id: "picker-record" };
  const hit = { uv: { x: 0.5, y: 0.25 } };
  let readAsync = 0;
  const readbackWithCenter = (width, height, centerX, centerY, rgba) => {
    const data = new Uint8Array(width * height * 4);
    const offset = (centerY * width + centerX) * 4;
    data.set(rgba, offset);
    return data;
  };
  editor.renderer = {
    isWebGPURenderer: true,
    backend: { isWebGPUBackend: true },
    readRenderTargetPixels() {
      throw new Error("texture picking must not use WebGL readRenderTargetPixels");
    },
    async readRenderTargetPixelsAsync(readTarget, x, y, width, height) {
      readAsync += 1;
      assert.equal(readTarget, target);
      assert.equal(x, 0);
      assert.equal(y, 0);
      assert.equal(width, 4);
      assert.equal(height, 4);
      return readbackWithCenter(width, height, 2, 1, [0, 255, 102, 255]);
    }
  };
  editor.clonePaintMaterialForHit = (hitRecord) => hitRecord === record ? material : null;
  editor.editableClonePaintTexture = () => ({
    canvas: { width: 4, height: 4 },
    context: {
      getImageData() {
        throw new Error("fresh WebGPU target should be sampled before stale editable pixels");
      }
    },
    texture: { uuid: "stale-canvas-texture", flipY: false }
  });
  editor.clonePaintPixelFromUv = (uv, canvas, texture) => {
    assert.deepEqual(uv, hit.uv);
    assert.equal(canvas.width, 4);
    assert.equal(canvas.height, 4);
    assert.equal(texture, target.texture);
    return { x: 2, y: 1 };
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  editor.texturePaintColor = { value: "" };

  assert.equal(await editor.pickTextureColorNearAsync(record, hit), true);
  assert.equal(readAsync, 1);
  assert.equal(editor.texturePaintColor.value, "#00ff66");
  assert.equal(editor.lastStatus, "Picked #00ff66");
});

test("texture picker samples displayed layer composite before active layer target", async () => {
  class AppEditor {}
  installTextureAirbrushMethods(AppEditor, {});
  const activeLayerTarget = {
    width: 4,
    height: 4,
    texture: { uuid: "active-layer-target", flipY: false }
  };
  const compositeTarget = {
    width: 4,
    height: 4,
    texture: { uuid: "composite-target", flipY: false }
  };
  const layer = {
    gpuTarget: {
      target: activeLayerTarget,
      width: 4,
      height: 4
    }
  };
  const material = {
    userData: {
      texturePaintCompositeGpuTarget: {
        target: compositeTarget,
        width: 4,
        height: 4
      }
    }
  };
  const record = { id: "picker-record" };
  const hit = { uv: { x: 0.25, y: 0.75 } };
  const sampledTargets = [];
  const readbackWithCenter = (width, height, centerX, centerY, rgba) => {
    const data = new Uint8Array(width * height * 4);
    const offset = (centerY * width + centerX) * 4;
    data.set(rgba, offset);
    return data;
  };
  const editor = new AppEditor();
  editor.renderer = {
    isWebGPURenderer: true,
    backend: { isWebGPUBackend: true },
    async readRenderTargetPixelsAsync(target, x, y, width, height) {
      sampledTargets.push(target);
      assert.equal(x, 0);
      assert.equal(y, 0);
      assert.equal(width, 4);
      assert.equal(height, 4);
      return target === compositeTarget
        ? readbackWithCenter(width, height, 1, 3, [44, 55, 66, 255])
        : readbackWithCenter(width, height, 1, 3, [0, 0, 0, 0]);
    }
  };
  editor.clonePaintMaterialForHit = (hitRecord) => hitRecord === record ? material : null;
  editor.editableClonePaintTexture = () => ({
    canvas: { width: 4, height: 4 },
    context: {
      getImageData() {
        throw new Error("displayed WebGPU composite should be sampled before active layer canvas");
      }
    },
    texture: { uuid: "editable-texture", flipY: false },
    layer,
    layerMode: true
  });
  editor.clonePaintPixelFromUv = () => ({ x: 1, y: 3 });
  editor.texturePaintColor = { value: "" };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(await editor.pickTextureColorNearAsync(record, hit), true);
  assert.deepEqual(sampledTargets, [compositeTarget]);
  assert.equal(editor.texturePaintColor.value, "#2c3742");
  assert.equal(editor.lastStatus, "Picked #2c3742");
});

test("WebGPU-only install does not allocate WebGL render targets for legacy texture helpers", () => {
  class AppEditor {}
  const THREE = {
    WebGLRenderTarget() {
      throw new Error("WebGPU-only helpers must not allocate WebGL render targets");
    }
  };
  installPaintToolMethods(AppEditor, { THREE });
  installAssetExportMethods(AppEditor, { THREE, GLTFExporter: null, SkeletonUtils: null });
  const editor = new AppEditor();
  let rendered = false;
  editor.renderer = {
    getRenderTarget() {
      throw new Error("WebGPU-only helpers must not read WebGL render targets");
    },
    setRenderTarget() {
      throw new Error("WebGPU-only helpers must not set WebGL render targets");
    },
    clear() {
      throw new Error("WebGPU-only helpers must not clear WebGL render targets");
    },
    render() {
      rendered = true;
      throw new Error("WebGPU-only helpers must not render through WebGL");
    }
  };
  editor.textureAirbrushCopyTextureToTarget = () => {
    throw new Error("WebGPU-only helpers must not call legacy texture copy");
  };
  editor.textureAirbrushCanvasFromRenderTarget = () => {
    throw new Error("WebGPU-only helpers must not read WebGL render target pixels");
  };

  assert.equal(editor.copyTextureToRenderTarget({ uuid: "source" }, { texture: {} }), false);
  assert.equal(editor.cloneTextureRenderTargetSnapshot({ target: { texture: {}, width: 4, height: 4 } }), null);
  assert.equal(editor.clearTexturePaintGpuTarget({ target: { texture: {}, width: 4, height: 4 } }), false);
  assert.equal(editor.textureCanvasFromGpu({ image: { width: 4, height: 4 } }), null);
  assert.equal(rendered, false);
});

test("WebGPU screen stroke flush paints through the live WebGPU path only", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const webGpuPaints = [];
  editor.textureAirbrushScreenStrokeQueue = [strokePayload()];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    return options.strokeSegments.length;
  };
  editor.textureAirbrushProjectedMeshFromEvent = () => {
    throw new Error("WebGPU screen strokes must not use projected paint");
  };

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  assert.equal(webGpuPaints.length, 1);
  assert.equal(webGpuPaints[0].options.liveProjectedPaint, true);
  assert.equal(webGpuPaints[0].options.requireVisibilityMask, true);
  assert.equal(webGpuPaints[0].options.indexedStrokeSamplesOnly, true);
});

test("live WebGPU screen stroke flush respects requested realtime budgets", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const webGpuPaints = [];
  const points = Array.from({ length: 7 }, (_entry, index) => ({
    clientX: 18 + index * 6,
    clientY: 24
  }));
  editor.textureAirbrushScreenStrokeQueue = points.slice(1).map((point, index) => strokePayload({
    clientX: point.clientX,
    clientY: point.clientY,
    strokeStart: points[index],
    continuousStrokePoints: points.slice(0, index + 2)
  }));
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    return options.strokeSegments.length;
  };

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 1,
    maxBatchSegments: 2,
    maxSegments: 2,
    maxBatchMs: 1000
  }), 2);

  assert.equal(webGpuPaints.length, 1);
  assert.equal(webGpuPaints[0].options.strokeSegments.length, 2);
  assert.ok(editor.textureAirbrushPendingScreenStrokeBatches.length > 0);
});

test("live WebGPU batch merge preserves reset-origin stroke state", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const webGpuPaints = [];
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "8:32:220:80:500:350:350:1000:paint:soft:texture:0:all",
    radiusPixels: 8,
    color: { r: 32, g: 220, b: 80 },
    opacity: 0.5,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    pressureApplied: true,
    erase: false,
    layerMode: false,
    layerMutationSerial: 0,
    neighborPaintSeed: null,
    neighborPaintKey: "",
    spacing: 1,
    strokeReset: false,
    strokeStartedWithReset: false,
    strokeSegments: [{
      start: { clientX: 18, clientY: 24 },
      end: { clientX: 24, clientY: 30 }
    }]
  }];
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 30,
    clientY: 36,
    strokeStart: { clientX: 24, clientY: 30 },
    strokeStartedWithReset: true
  })];
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    return options.strokeSegments.length;
  };

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 2);

  assert.equal(webGpuPaints.length, 1);
  assert.equal(webGpuPaints[0].options.strokeStartedWithReset, true);
  assert.equal(webGpuPaints[0].options.strokeReset, false);
  assert.equal(webGpuPaints[0].options.strokeSegments.length, 2);
});

test("airbrush direct paint entrypoint refuses the old direct projected fallback", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const reports = [];
  editor.activeTool = "airbrush";
  editor.textureAirbrushCanUseScreenStroke = () => false;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  editor.paintFromEvent = () => {
    throw new Error("airbrush should not use direct projected paint when screen strokes are unavailable");
  };

  assert.equal(editor.paintTextureStrokeFromEvent({ clientX: 12, clientY: 14 }, { reset: true }), false);

  assert.deepEqual(reports, [{ backend: "none", webGpuStatus: "visible-surface-mask-unavailable" }]);
  assert.match(editor.lastStatus, /WebGPU airbrush/);
});

test("tablet raw updates retain pressure without painting the path twice", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const event = {
    clientX: 120,
    clientY: 90,
    pointerId: 7,
    pointerType: "pen",
    pressure: 0.64,
    preventDefault() {
      throw new Error("raw updates must not suppress the coalesced pointermove");
    }
  };
  let remembered = null;
  let paintedMoves = 0;
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.textureAirbrushRememberNativePressureEvent = (received) => {
    remembered = received;
    return true;
  };
  editor.onPointerMove = () => {
    paintedMoves += 1;
  };

  assert.equal(editor.onCanvasPointerRawUpdate(event), true);
  assert.equal(remembered, event);
  assert.equal(paintedMoves, 0);
});

test("tablet compatibility pressure moves do not duplicate an active pointer stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let cachedPressure = 0;
  let paintedMoves = 0;
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 7;
  editor.textureAirbrushCacheNativePressureForStroke = () => {
    cachedPressure += 1;
    return true;
  };
  editor.onPointerMove = () => {
    paintedMoves += 1;
  };

  assert.equal(editor.onCanvasPressureMouseMoveFallback({
    clientX: 120,
    clientY: 90,
    pointerType: "pen",
    pressure: 0.64,
    buttons: 1
  }), false);
  assert.equal(editor.onCanvasWebKitMouseForceChanged({
    clientX: 120,
    clientY: 90,
    webkitForce: 0.64,
    buttons: 1
  }), false);

  assert.equal(cachedPressure, 2);
  assert.equal(paintedMoves, 0);
});

test("tablet compatibility pressure down does not replace an active pointer stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let cachedPressure = 0;
  let pointerDowns = 0;
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 7;
  editor.texturePaintMouseFallbackActive = false;
  editor.textureAirbrushCacheNativePressureForStroke = () => {
    cachedPressure += 1;
    return true;
  };
  editor.onPointerDown = () => {
    pointerDowns += 1;
  };

  assert.equal(editor.onCanvasMouseDownFallback({
    button: 0,
    buttons: 1,
    clientX: 120,
    clientY: 90,
    webkitForce: 0.64
  }), false);

  assert.equal(cachedPressure, 1);
  assert.equal(pointerDowns, 0);
  assert.equal(editor.texturePaintMouseFallbackActive, false);
  assert.equal(editor.texturePaintActivePointerId, 7);
});

test("late tablet compatibility pressure down does not start a ghost stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let pointerDowns = 0;
  editor.activeTool = "airbrush";
  editor.painting = false;
  editor.texturePaintLastPointerEventAt = performance.now();
  editor.onPointerDown = () => {
    pointerDowns += 1;
  };

  assert.equal(editor.onCanvasMouseDownFallback({
    button: 0,
    buttons: 1,
    clientX: 120,
    clientY: 90,
    webkitForce: 0.64
  }), false);

  assert.equal(pointerDowns, 0);
  assert.notEqual(editor.texturePaintMouseFallbackActive, true);
});

test("airbrush curve sampling does not overshoot sharp zig-zag turns", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  editor.textureAirbrushShouldInterpolateContinuousStroke = () => true;
  editor.textureAirbrushCurveSampleStepPixels = () => 4;
  editor.textureAirbrushInputEventAtPoint = (sourceEvent, point) => ({
    ...sourceEvent,
    clientX: point.clientX,
    clientY: point.clientY
  });
  editor.textureAirbrushStrokeCurveState = {
    previousInputPoint: { clientX: 10, clientY: 10 },
    lastInputPoint: { clientX: 20, clientY: 20 }
  };

  const samples = editor.textureAirbrushInterpolatedStrokeEvents(
    { clientX: 10, clientY: 30, pointerType: "pen" },
    { clientX: 20, clientY: 20 },
    { clientX: 10, clientY: 30 }
  );

  assert.ok(samples.length > 1);
  assert.ok(samples.every((sample) => sample.clientX >= 10 && sample.clientX <= 20));
  assert.ok(samples.every((sample) => sample.clientY >= 20 && sample.clientY <= 30));
  assert.ok(samples.every((sample) => sample.textureAirbrushCurveSample !== true));
});

test("brush setting invalidation prewarms the active TSL surface brush profile", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const event = { clientX: 420, clientY: 310 };
  let prewarm = null;
  editor.activeTool = "airbrush";
  editor.painting = false;
  editor.textureBrushRadiusScreenPixels = () => 48;
  editor.textureAirbrushOpacity = () => 0.56;
  editor.textureAirbrushHardness = () => 0.12;
  editor.textureAirbrushScatter = () => 0.38;
  editor.textureAirbrushVisibleEdgeMode = () => "soft";
  editor.textureAirbrushColor = () => ({ r: 0, g: 255, b: 0 });
  editor.texturePaintLayerModeActive = () => false;
  editor.scheduleTextureAirbrushPrewarm = (receivedEvent, hit, options) => {
    prewarm = { event: receivedEvent, hit, options };
    return true;
  };

  assert.equal(editor.textureAirbrushInvalidateBrushSettings({ event }), true);

  assert.equal(prewarm.event, event);
  assert.equal(prewarm.hit, null);
  assert.equal(prewarm.options.force, true);
  assert.equal(prewarm.options.radiusPixels, 48);
  assert.equal(prewarm.options.opacity, 0.56);
  assert.equal(prewarm.options.hardness, 0.12);
  assert.equal(prewarm.options.scatter, 0.38);
  assert.equal(prewarm.options.visibleEdgeMode, "soft");
  assert.deepEqual(prewarm.options.color, { r: 0, g: 255, b: 0 });
  assert.equal(prewarm.options.warmNeighborTopology, true);
  assert.equal(prewarm.options.warmUvOccupancy, false);
  assert.equal(prewarm.options.tslSurfacePrewarmAll, true);
  assert.equal(prewarm.options.renderCompilePass, true);
  assert.equal(prewarm.options.compileOnly, true);
  assert.equal(prewarm.options.idle, true);
});

test("airbrush hover prewarms Neighbor topology before the first stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const event = { clientX: 420, clientY: 310 };
  let prewarm = null;
  editor.activeTool = "airbrush";
  editor.painting = false;
  editor.canvas = {};
  editor.textureBrushCursor = {
    hidden: true,
    classList: { remove() {} }
  };
  editor.rememberBrushCursorEvent = () => event;
  editor.textureBrushRadiusScreenPixels = () => 48;
  editor.textureAirbrushOpacity = () => 0.56;
  editor.textureAirbrushHardness = () => 0.12;
  editor.textureAirbrushScatter = () => 0.38;
  editor.textureAirbrushVisibleEdgeMode = () => "soft";
  editor.textureAirbrushColor = () => ({ r: 0, g: 255, b: 0 });
  editor.texturePaintLayerModeActive = () => true;
  editor.positionBrushCursor = () => {};
  editor.scheduleTextureAirbrushPrewarm = (receivedEvent, hit, options) => {
    prewarm = { event: receivedEvent, hit, options };
    return true;
  };

  assert.equal(editor.showTextureStrokeCursor(event), true);
  assert.equal(prewarm.event, event);
  assert.equal(prewarm.hit, null);
  assert.equal(prewarm.options.warmNeighborTopology, true);
  assert.equal(prewarm.options.warmUvOccupancy, true);
  assert.equal(prewarm.options.tslSurfacePrewarmAll, true);
  assert.equal(prewarm.options.renderCompilePass, true);
  assert.equal(prewarm.options.compileOnly, true);
  assert.equal(prewarm.options.idle, true);
});

test("visible-surface airbrush refuses CPU projection modes", () => {
  class AppEditor {}
  installTextureAirbrushMethods(AppEditor, { THREE: {} });
  const editor = new AppEditor();
  const reports = [];
  let canvasTouched = false;
  editor.canvas = {
    getBoundingClientRect() {
      canvasTouched = true;
      throw new Error("CPU projection should not read canvas geometry");
    }
  };
  editor.camera = {};
  editor.model = {};
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(editor.textureAirbrushVisibleSurfacePaintFromEvent({ clientX: 10, clientY: 12 }, {
    fullRegion: true
  }), 0);
  assert.equal(editor.textureAirbrushVisibleSurfacePaintFromEvent({ clientX: 10, clientY: 12 }, {
    meshFallback: true
  }), 0);
  assert.equal(editor.textureAirbrushVisibleSurfacePaintFromEvent({ clientX: 10, clientY: 12 }, {
    cpuStrokeSamples: true
  }), 0);

  assert.equal(canvasTouched, false);
  assert.deepEqual(reports, [
    { backend: "none", webGpuStatus: "cpu-projection-disabled" },
    { backend: "none", webGpuStatus: "cpu-projection-disabled" },
    { backend: "none", webGpuStatus: "cpu-projection-disabled" }
  ]);
  assert.match(editor.lastStatus, /WebGPU visible-surface/);
});

test("near and region airbrush refuse CPU UV paint", () => {
  class AppEditor {}
  installTextureAirbrushMethods(AppEditor, { THREE: {} });
  const editor = new AppEditor();
  const reports = [];
  editor.clonePaintMaterialForHit = () => {
    throw new Error("CPU UV paint should not resolve editable material");
  };
  editor.textureAirbrushReportWebGpuFallback = (status) => {
    reports.push(status);
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(editor.paintTextureRegion(), 0);
  assert.equal(editor.textureAirbrushNear({}, { uv: { x: 0.5, y: 0.5 } }, {
    fullRegion: true
  }), 0);
  assert.equal(editor.textureAirbrushNear({}, { uv: { x: 0.5, y: 0.5 } }, {
    meshFallback: true
  }), 0);
  assert.equal(editor.textureAirbrushNear({}, { uv: { x: 0.5, y: 0.5 } }, {}), 0);

  assert.deepEqual(reports, [
    { backend: "none", webGpuStatus: "cpu-region-paint-disabled" },
    { backend: "none", webGpuStatus: "cpu-uv-paint-disabled" },
    { backend: "none", webGpuStatus: "cpu-uv-paint-disabled" },
    { backend: "none", webGpuStatus: "cpu-uv-paint-disabled" }
  ]);
  assert.match(editor.lastStatus, /WebGPU visible-surface/);
});

test("large WebGPU Neighbor brush batches through scheduled screen flush instead of blocking pointer-down", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  let scheduled = 0;
  let flushes = 0;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.flushTextureAirbrushScreenStroke = () => {
    flushes += 1;
    editor.textureAirbrushScreenStrokeQueue = [];
    return 1;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
    strokeReset: true,
    radiusPixels: 37,
    styleRadiusPixels: 37,
    neighborPaintSeed: { enabled: true },
    neighborPaintKey: "neighbor"
  })), true);

  assert.equal(flushes, 0);
  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
});

test("large WebGPU Neighbor fast queue schedules once after batching without direct flush", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  let scheduled = 0;
  let flushes = 0;
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => strokePayload({
    clientX: event.clientX,
    clientY: event.clientY,
    strokeStart,
    radiusPixels: 37,
    styleRadiusPixels: 37
  });
  editor.flushTextureAirbrushScreenStroke = () => {
    flushes += 1;
    return 1;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueLargeWebGpuNeighborStrokeEvents([
    { clientX: 40, clientY: 50 },
    { clientX: 46, clientY: 56 },
    { clientX: 52, clientY: 62 }
  ], { reset: true }), true);

  assert.equal(flushes, 0);
  assert.equal(scheduled, 1);
  assert.ok(editor.textureAirbrushScreenStrokeQueue.length > 0);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].deferredNeighborPaintSeed, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].webGpuLiveNeighborProjectionCurrent, true);
});

test("large WebGPU Neighbor fast queue marks reschedule while a flush is active", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  let scheduled = 0;
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushFlushingScreenStroke = true;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 40;
  editor.textureBrushRadiusScreenPixels = () => 40;
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => strokePayload({
    clientX: event.clientX,
    clientY: event.clientY,
    strokeStart,
    radiusPixels: 40,
    styleRadiusPixels: 40
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueLargeWebGpuNeighborStrokeEvents([
    { clientX: 80, clientY: 90 },
    { clientX: 108, clientY: 118 }
  ], { reset: true }), true);

  assert.equal(scheduled, 0);
  assert.equal(editor.textureAirbrushScreenFlushRescheduleRequested, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].clientX, 108);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].clientY, 118);
});

test("large WebGPU Neighbor payloads queued during live flush schedule another flush", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const seed = { enabled: true, key: "active-flush-neighbor" };
  let scheduled = 0;
  let paintCalls = 0;
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushNeighborSeedKey = (candidateSeed) => candidateSeed?.key || "";
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => strokePayload({
    clientX: event.clientX,
    clientY: event.clientY,
    strokeStart,
    radiusPixels: 40,
    styleRadiusPixels: 40,
    neighborPaintSeed: seed,
    neighborPaintKey: "active-flush-neighbor"
  });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintCalls += 1;
    if (paintCalls === 1) {
      editor.textureAirbrushQueueLargeWebGpuNeighborStrokeEvents([
        { clientX: event.clientX + 28, clientY: event.clientY + 28 }
      ]);
    }
    return options.strokeSegments.length;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 80,
    clientY: 90,
    strokeStart: { clientX: 72, clientY: 84 },
    radiusPixels: 40,
    styleRadiusPixels: 40,
    neighborPaintSeed: seed,
    neighborPaintKey: "active-flush-neighbor",
    strokeReset: true
  })];

  const changed = editor.flushTextureAirbrushScreenStroke({ live: true });

  assert.equal(changed, 1);
  assert.equal(paintCalls, 1);
  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenFlushRescheduleRequested, false);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
});

test("large WebGPU Neighbor fast queue skips dense pointer noise before candidate creation", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  let payloadsBuilt = 0;
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureBrushRadiusScreenPixels = () => 40;
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 40;
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => {
    payloadsBuilt += 1;
    return strokePayload({
      clientX: event.clientX,
      clientY: event.clientY,
      strokeStart,
      radiusPixels: 40,
      styleRadiusPixels: 40
    });
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueLargeWebGpuNeighborStrokeEvents(
    Array.from({ length: 10 }, (_, index) => ({ clientX: 40 + index, clientY: 50 })),
    { reset: true }
  ), true);

  assert.ok(payloadsBuilt < 10);
  assert.ok(editor.textureAirbrushScreenStrokeQueue.length < 10);
});

function installNeighborScreenEditor(editor, seed, hits) {
  installEditorDefaults(editor);
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushActiveNeighborPaintSeed = seed;
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => hits[event.hitId] || null;
  editor.textureAirbrushNeighborSeedAllowsPaintHit = (candidateSeed, hit) => (
    candidateSeed === seed && Boolean(hit)
  );
  editor.textureAirbrushNeighborSeedKey = () => "torso-seed";
  editor.textureAirbrushScreenStrokeBaseOptions = () => ({ radiusPixels: 32, spacing: 1 });
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => strokePayload({
    clientX: event.clientX,
    clientY: event.clientY,
    strokeStart,
    radiusPixels: 32,
    styleRadiusPixels: 32,
    neighborPaintSeed: editor.textureAirbrushActiveNeighborPaintSeed,
    neighborPaintKey: "torso-seed"
  });
  editor.textureAirbrushBeginNeighborPaintStroke = () => {
    editor.textureAirbrushActiveNeighborPaintSeed = seed;
    editor.textureAirbrushBeginNeighborPaintFrontier(seed);
    return seed;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };
}

test("Neighbor paint frontier exposes a stable local topology raster seed", () => {
  class NeighborEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  const editor = new NeighborEditor();
  const record = {};
  const seed = { enabled: true, record, key: "torso-seed" };
  editor.textureAirbrushNeighborLinkedVertices = (_record, vertexIndex) => (
    vertexIndex === 1 ? [1, 10] : [vertexIndex]
  );

  const frontier = editor.textureAirbrushBeginNeighborPaintFrontier(seed);
  assert.equal(seed.localTopologyVertices, frontier.vertices);
  assert.equal(seed.localTopologyKey, "torso-seed:1");

  assert.equal(editor.textureAirbrushRecordNeighborPaintHit(seed, {
    record,
    hit: { face: { vertices: [0, 1, 2] } }
  }), true);
  assert.deepEqual([...seed.localTopologyVertices].sort((left, right) => left - right), [0, 1, 2, 10]);
  assert.equal(seed.localTopologySerial, 1);

  editor.textureAirbrushRecordNeighborPaintHit(seed, {
    record,
    hit: { face: { vertices: [0, 1, 2] } }
  });
  assert.equal(seed.localTopologySerial, 1);
});

test("Neighbor spaced strokes avoid per-sample hit probes", () => {
  class ScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(ScreenEditor);
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const record = {
    vertexNeighbors: {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3],
      10: [11],
      11: [10, 12],
      12: [11]
    },
    deleted: new Set()
  };
  const seed = {
    enabled: true,
    record,
    component: new Set([0, 1, 2, 3, 4, 10, 11, 12]),
    key: "torso-seed"
  };
  installNeighborScreenEditor(editor, seed, {});
  let hitProbeCount = 0;
  editor.textureAirbrushNeighborPaintHitFromEvent = () => {
    hitProbeCount += 1;
    return null;
  };
  const queuedPayloads = [];
  editor.textureAirbrushQueueScreenStrokePayload = (payload) => {
    queuedPayloads.push(payload);
    return true;
  };

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 20,
    clientY: 10,
    button: 0,
    buttons: 1,
    hitId: "torso"
  }, { reset: true, strokeStart: { clientX: 20, clientY: 10 } }), true);

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 70,
    clientY: 10,
    button: 0,
    buttons: 1,
    hitId: "arm"
  }, { reset: false, strokeStart: { clientX: 20, clientY: 10 } }), true);

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 38,
    clientY: 10,
    button: 0,
    buttons: 1,
    hitId: "torso2"
  }, { reset: false, strokeStart: { clientX: 70, clientY: 10 } }), true);

  assert.equal(hitProbeCount, 0);
  assert.equal(queuedPayloads.length, 3);
  assert.equal(queuedPayloads[0].clientX, 20);
  assert.equal(queuedPayloads[1].clientX, 70);
  assert.equal(queuedPayloads[2].clientX, 38);
  assert.equal(queuedPayloads[0].strokeReset, true);
  assert.equal(queuedPayloads[1].strokeReset, false);
  assert.equal(queuedPayloads[2].strokeReset, false);
});

function installNeighborInputQueueEditor(editor, seed, hits) {
  installEditorDefaults(editor);
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushActiveNeighborPaintSeed = seed;
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => hits[event.hitId] || null;
  editor.textureAirbrushNeighborSeedAllowsPaintHit = (candidateSeed, paintHit) => (
    candidateSeed === seed && paintHit?.record === seed.record
  );
  editor.textureAirbrushStrokeSourceEvents = (event) => [event];
  editor.textureAirbrushInterpolatedStrokeEvents = (event) => [event];
  editor.textureAirbrushInputEventAtPoint = (event, point) => ({
    ...event,
    ...point
  });
  editor.textureAirbrushShouldUseLargeWebGpuNeighborFastQueue = () => false;
  editor.textureAirbrushBeginNeighborPaintFrontier(seed);
  editor.textureAirbrushRecordNeighborPaintHit(seed, hits.torso);
  editor.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = { clientX: 20, clientY: 10 };
  editor.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = hits.torso;
  editor.texturePaintStrokePoint = { clientX: 20, clientY: 10 };
}

test("Neighbor input rejects a remote same-component surface without bridging through it", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const record = {
    vertexNeighbors: {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3],
      10: [11],
      11: [10, 12],
      12: [11]
    },
    deleted: new Set()
  };
  const seed = {
    enabled: true,
    record,
    component: new Set([0, 1, 2, 3, 4, 10, 11, 12]),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1, 2] } } },
    arm: { record, hit: { face: { vertices: [10, 11, 12] } } },
    torso2: { record, hit: { face: { vertices: [2, 3, 4] } } },
    torso3: { record, hit: { face: { vertices: [3, 4] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  const queued = [];
  editor.textureAirbrushQueueSpacedScreenStroke = (event, options) => {
    queued.push({ event, options });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 70,
    clientY: 10,
    pointerType: "mouse",
    hitId: "arm"
  }), false);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 38,
    clientY: 10,
    pointerType: "mouse",
    hitId: "torso2"
  }), true);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 44,
    clientY: 10,
    pointerType: "mouse",
    hitId: "torso3"
  }), true);

  assert.deepEqual(
    queued.map(({ event, options }) => [
      event.clientX,
      options.strokeStart.clientX,
      options.reset,
      options.forceStrokeReset === true
    ]),
    [
      [38, 38, true, true],
      [44, 38, false, false]
    ]
  );
  assert.equal(queued[0].options.preserveStrokeOpacity, true);
  assert.deepEqual(editor.textureAirbrushNeighborScreenStrokePendingPoints, []);
});

test("Neighbor input recovers a nearby covered surface within the brush topology radius", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const vertexNeighbors = {};
  for (let index = 0; index <= 10; index += 1) {
    vertexNeighbors[index] = [index - 1, index + 1]
      .filter((value) => value >= 0 && value <= 10);
  }
  const record = { vertexNeighbors, deleted: new Set() };
  const overlayRecord = { vertexNeighbors: {}, deleted: new Set() };
  const seed = {
    enabled: true,
    record,
    component: new Set(Object.keys(vertexNeighbors).map(Number)),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1] } } },
    overlay: { record: overlayRecord, hit: { face: { vertices: [20, 21, 22] } } },
    shoulder: { record, hit: { face: { vertices: [8, 9] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => (
    event.clientX <= 20
      ? hits.torso
      : event.clientX < 38
        ? hits.overlay
        : hits.shoulder
  );
  const queued = [];
  editor.textureAirbrushQueueSpacedScreenStroke = (event, options) => {
    queued.push({ event, options });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 26,
    clientY: 10,
    pointerType: "mouse",
    hitId: "overlay"
  }), false);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 38,
    clientY: 12,
    pointerType: "mouse",
    hitId: "shoulder"
  }), true);

  assert.ok(queued.some(({ event }) => event.clientX === 38));
  assert.ok(editor.textureAirbrushNeighborScreenStrokeFrontier.vertices.has(8));
  assert.ok(editor.textureAirbrushNeighborScreenStrokeFrontier.vertices.has(9));
});

test("Neighbor input does not recover across a background air gap", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const vertexNeighbors = {};
  for (let index = 0; index <= 10; index += 1) {
    vertexNeighbors[index] = [index - 1, index + 1]
      .filter((value) => value >= 0 && value <= 10);
  }
  const record = { vertexNeighbors, deleted: new Set() };
  const seed = {
    enabled: true,
    record,
    component: new Set(Object.keys(vertexNeighbors).map(Number)),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1] } } },
    elbow: { record, hit: { face: { vertices: [8, 9] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => (
    event.clientX <= 20
      ? hits.torso
      : event.clientX >= 38
        ? hits.elbow
        : null
  );
  editor.textureAirbrushQueueSpacedScreenStroke = () => true;

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 26,
    clientY: 10,
    pointerType: "mouse"
  }), false);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 38,
    clientY: 12,
    pointerType: "mouse"
  }), false);

  assert.equal(editor.textureAirbrushNeighborScreenStrokeFrontier.vertices.has(8), false);
  assert.equal(editor.textureAirbrushNeighborScreenStrokeFrontier.vertices.has(9), false);
});

test("Neighbor input preflights reconstructed batches before their samples can crawl the frontier", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const vertexNeighbors = {};
  for (let index = 0; index <= 12; index += 1) {
    vertexNeighbors[index] = [index - 1, index + 1].filter((value) => value >= 0 && value <= 12);
  }
  const record = { vertexNeighbors, deleted: new Set() };
  const seed = {
    enabled: true,
    record,
    component: new Set(Object.keys(vertexNeighbors).map(Number)),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1] } } },
    step1: { record, hit: { face: { vertices: [3, 4] } } },
    step2: { record, hit: { face: { vertices: [6, 7] } } },
    arm: { record, hit: { face: { vertices: [10, 11] } } },
    torso2: { record, hit: { face: { vertices: [1, 2] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => new Map([
    [20, hits.torso],
    [30, hits.step1],
    [40, hits.step2],
    [50, hits.arm],
    [60, hits.torso2]
  ]).get(event.clientX) || null;
  const reconstructed = [
    { clientX: 30, clientY: 10, pointerType: "pen", hitId: "step1", textureAirbrushPreSmoothedSample: true },
    { clientX: 40, clientY: 10, pointerType: "pen", hitId: "step2", textureAirbrushPreSmoothedSample: true },
    { clientX: 50, clientY: 10, pointerType: "pen", hitId: "arm", textureAirbrushPreSmoothedSample: true }
  ];
  editor.textureAirbrushStrokeSourceEvents = () => reconstructed;
  const queued = [];
  editor.textureAirbrushQueueSpacedScreenStroke = (event) => {
    queued.push(event);
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    ...reconstructed.at(-1),
    getCoalescedEvents: () => reconstructed
  }), false);

  assert.deepEqual(queued, []);
  assert.deepEqual([...editor.textureAirbrushNeighborScreenStrokeFrontier.vertices].sort((a, b) => a - b), [0, 1]);
  assert.equal(editor.textureAirbrushNeighborScreenStrokeHermiteBridgePending, true);

  editor.textureAirbrushStrokeSourceEvents = (event) => [event];
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 60,
    clientY: 12,
    pointerType: "pen",
    hitId: "torso2"
  }), true);

  assert.deepEqual(queued.map((event) => event.clientX), [30, 40, 50, 60]);
  assert.equal(editor.textureAirbrushNeighborScreenStrokeHermiteBridgePending, false);
});

test("Neighbor input replays short disconnected samples as a curved path bridge", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const record = {
    vertexNeighbors: {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3]
    },
    deleted: new Set()
  };
  const overlayRecord = { vertexNeighbors: {}, deleted: new Set() };
  const seed = {
    enabled: true,
    record,
    component: new Set([0, 1, 2, 3, 4]),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1, 2] } } },
    overlay1: { record: overlayRecord, hit: { face: { vertices: [20, 21, 22] } } },
    overlay2: { record: overlayRecord, hit: { face: { vertices: [23, 24, 25] } } },
    torso2: { record, hit: { face: { vertices: [2, 3, 4] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => new Map([
    [20, hits.torso],
    [26, hits.overlay1],
    [32, hits.overlay2],
    [38, hits.torso2]
  ]).get(event.clientX) || null;
  const queued = [];
  editor.textureAirbrushQueueSpacedScreenStroke = (event, options) => {
    queued.push({ event, options });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 26,
    clientY: 12,
    pointerType: "mouse",
    hitId: "overlay1"
  }), false);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 32,
    clientY: 16,
    pointerType: "mouse",
    hitId: "overlay2"
  }), false);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 38,
    clientY: 20,
    pointerType: "mouse",
    hitId: "torso2"
  }), true);

  assert.deepEqual(
    queued.map(({ event, options }) => [
      event.clientX,
      event.clientY,
      options.strokeStart.clientX,
      event.textureAirbrushNeighborBridgeSample === true
    ]),
    [
      [26, 12, 20, true],
      [32, 16, 26, true],
      [38, 20, 32, false]
    ]
  );
  assert.deepEqual(editor.textureAirbrushNeighborScreenStrokePendingPoints, []);
});

test("Neighbor input interpolates surface anchors across a short occlusion", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const record = {
    vertexNeighbors: {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3]
    },
    deleted: new Set()
  };
  const overlayRecord = { vertexNeighbors: {}, deleted: new Set() };
  const seed = {
    enabled: true,
    record,
    component: new Set([0, 1, 2, 3, 4]),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1, 2] } } },
    overlay: { record: overlayRecord, hit: { face: { vertices: [20, 21, 22] } } },
    torso2: { record, hit: { face: { vertices: [2, 3, 4] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  const startAnchor = {
    view: { x: 0, y: 0, z: -2 },
    normal: { x: 0, y: 0, z: 1 },
    viewRadiusPixels: 0.04,
    component: 0
  };
  const endAnchor = {
    view: { x: 1, y: 0.2, z: -2.1 },
    normal: { x: 0, y: 0.6, z: 0.8 },
    viewRadiusPixels: 0.05,
    component: 0
  };
  editor.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = {
    clientX: 20,
    clientY: 10,
    textureAirbrushSurfaceAnchor: startAnchor
  };
  editor.texturePaintStrokePoint = {
    clientX: 20,
    clientY: 10,
    textureAirbrushSurfaceAnchor: startAnchor
  };
  editor.textureAirbrushSurfaceAnchorForPaintHit = (paintHit) => (
    paintHit === hits.torso2 ? endAnchor : startAnchor
  );
  editor.textureAirbrushSurfaceAnchorAtClientPoint = (point, anchor) => ({
    ...anchor,
    view: {
      x: point.clientX / 40,
      y: point.clientY / 40,
      z: anchor.view.z
    }
  });
  const queued = [];
  editor.textureAirbrushQueueSpacedScreenStroke = (event, options) => {
    queued.push({ event, options });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 28,
    clientY: 15,
    pointerType: "mouse",
    hitId: "overlay"
  }), false);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 38,
    clientY: 20,
    pointerType: "mouse",
    hitId: "torso2"
  }), true);

  assert.equal(queued.length, 2);
  const bridgeAnchor = queued[0].event.textureAirbrushSurfaceAnchor;
  assert.equal(bridgeAnchor.view.x, 0.7);
  assert.equal(bridgeAnchor.view.y, 0.375);
  assert.deepEqual(queued[0].options.strokeStart.textureAirbrushSurfaceAnchor, startAnchor);
  assert.deepEqual(queued[1].event.textureAirbrushSurfaceAnchor, endAnchor);
  assert.deepEqual(queued[1].options.strokeStart.textureAirbrushSurfaceAnchor, bridgeAnchor);
});

test("Neighbor bridge recovers local surface anchors around a missed edge span", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const record = {
    vertexNeighbors: {
      0: [1],
      1: [0, 2, 4],
      2: [1],
      4: [1, 5],
      5: [4],
      10: [11],
      11: [10]
    },
    deleted: new Set()
  };
  const seed = {
    enabled: true,
    record,
    component: new Set([0, 1, 2, 4, 5, 10, 11]),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1] } } },
    localStart: { record, hit: { face: { vertices: [1, 2] } } },
    remote: { record, hit: { face: { vertices: [10, 11] } } },
    localEnd: { record, hit: { face: { vertices: [4, 5] } } },
    torso2: { record, hit: { face: { vertices: [1, 4] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  const anchorForHit = new Map([
    [hits.torso, { view: { x: 0, y: 0, z: -2 }, component: 0 }],
    [hits.localStart, { view: { x: 1, y: 0, z: -2 }, component: 0 }],
    [hits.remote, { view: { x: 10, y: 0, z: -1 }, component: 0 }],
    [hits.localEnd, { view: { x: 2, y: 0, z: -2 }, component: 0 }],
    [hits.torso2, { view: { x: 3, y: 0, z: -2 }, component: 0 }]
  ]);
  editor.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = {
    clientX: 20,
    clientY: 10,
    textureAirbrushSurfaceAnchor: anchorForHit.get(hits.torso)
  };
  editor.texturePaintStrokePoint = editor.textureAirbrushNeighborScreenStrokeLastAcceptedPoint;
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => new Map([
    [30, hits.localStart],
    [40, hits.remote],
    [50, hits.localEnd],
    [60, hits.torso2]
  ]).get(event.clientX) || null;
  editor.textureAirbrushSurfaceAnchorForPaintHit = (paintHit) => anchorForHit.get(paintHit) || null;
  editor.textureAirbrushSurfaceAnchorAtClientPoint = (point, anchor) => anchor;
  const queued = [];
  editor.textureAirbrushQueueSpacedScreenStroke = (event, options) => {
    queued.push({ event, options });
    return true;
  };

  assert.equal(editor.textureAirbrushHoldPreSmoothedNeighborBatch([
    { clientX: 30, clientY: 10 },
    { clientX: 40, clientY: 10 },
    { clientX: 50, clientY: 10 }
  ]), true);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 60,
    clientY: 10,
    pointerType: "pen",
    buttons: 1
  }), true);

  assert.deepEqual(
    queued.map(({ event }) => event.textureAirbrushSurfaceAnchor?.view?.x),
    [1, 1.5, 2, 3]
  );
  assert.equal(editor.textureAirbrushNeighborScreenStrokeFrontier.vertices.has(10), false);
  assert.equal(editor.textureAirbrushNeighborScreenStrokeFrontier.vertices.has(11), false);
});

test("Neighbor bridge clips a long empty-background excursion at the surface edge", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: {} });
  installTextureAirbrushNeighborPaintMethods(PaintEditor);
  const editor = new PaintEditor();
  const record = {
    vertexNeighbors: {
      0: [1],
      1: [0]
    },
    deleted: new Set()
  };
  const seed = {
    enabled: true,
    record,
    component: new Set([0, 1]),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1] } } },
    edge: { record, hit: { face: { vertices: [0, 1] } } },
    torso2: { record, hit: { face: { vertices: [0, 1] } } }
  };
  installNeighborInputQueueEditor(editor, seed, hits);
  const startAnchor = { view: { x: 20, y: 0, z: -2 }, component: 0 };
  editor.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = {
    clientX: 20,
    clientY: 10,
    textureAirbrushSurfaceAnchor: startAnchor
  };
  editor.texturePaintStrokePoint = editor.textureAirbrushNeighborScreenStrokeLastAcceptedPoint;
  const probedClientXs = [];
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => {
    probedClientXs.push(event.clientX);
    if (event.clientX >= 21 && event.clientX <= 23) {
      return hits.edge;
    }
    return event.clientX === 60 ? hits.torso2 : null;
  };
  editor.textureAirbrushSurfaceAnchorForPaintHit = (paintHit, point) => ({
    view: { x: point.clientX, y: 0, z: -2 },
    component: 0
  });
  editor.textureAirbrushSurfaceAnchorAtClientPoint = (point, anchor) => anchor;
  const queued = [];
  editor.textureAirbrushQueueSpacedScreenStroke = (event, options) => {
    queued.push({ event, options });
    return true;
  };
  const pending = Array.from({ length: 30 }, (_, index) => ({
    clientX: 21 + index,
    clientY: 10
  }));

  assert.equal(editor.textureAirbrushHoldPreSmoothedNeighborBatch(pending), true);
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 60,
    clientY: 10,
    pointerType: "pen",
    buttons: 1
  }), true);

  assert.deepEqual(
    queued.map(({ event, options }) => [
      event.clientX,
      options.strokeStart.clientX,
      options.reset,
      options.forceStrokeReset === true
    ]),
    [
      [21, 20, false, false],
      [22, 21, false, false],
      [23, 22, false, false],
      [60, 60, true, true]
    ]
  );
  assert.equal(queued.at(-1).options.preserveStrokeOpacity, true);
  assert.ok(probedClientXs.includes(23));
  assert.equal(probedClientXs.includes(33), false);
  assert.ok(probedClientXs.length <= 25);
});

test("large WebGPU Neighbor fast queue gates sampled hits and preserves opacity across re-entry", () => {
  class ScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(ScreenEditor);
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const record = {
    vertexNeighbors: {
      0: [1],
      1: [0, 2],
      2: [1, 3],
      3: [2, 4],
      4: [3],
      10: [11],
      11: [10, 12],
      12: [11]
    },
    deleted: new Set()
  };
  const seed = {
    enabled: true,
    record,
    component: new Set([0, 1, 2, 3, 4, 10, 11, 12]),
    key: "torso-seed"
  };
  const hits = {
    torso: { record, hit: { face: { vertices: [0, 1, 2] } } },
    arm: { record, hit: { face: { vertices: [10, 11, 12] } } },
    torso2: { record, hit: { face: { vertices: [2, 3, 4] } } }
  };
  installNeighborScreenEditor(editor, seed, hits);
  const strokeUndo = { label: "one pointer stroke" };
  const buildPayload = editor.textureAirbrushScreenStrokePayload;
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => ({
    ...buildPayload(event, strokeStart),
    strokeUndo
  });
  let hitProbeCount = 0;
  editor.textureAirbrushNeighborPaintHitFromEvent = (event) => {
    hitProbeCount += 1;
    return hits[event.hitId] || null;
  };
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureBrushRadiusScreenPixels = () => 80;
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 80;

  assert.equal(editor.textureAirbrushQueueLargeWebGpuNeighborStrokeEvents([
    { clientX: 20, clientY: 10, hitId: "torso" },
    { clientX: 100, clientY: 10, hitId: "arm" },
    { clientX: 180, clientY: 10, hitId: "arm" },
    { clientX: 38, clientY: 10, hitId: "torso2" }
  ], { reset: true }), true);

  assert.equal(hitProbeCount, 4);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
  assert.deepEqual(
    editor.textureAirbrushScreenStrokeQueue.map((payload) => [
      payload.clientX,
      payload.strokeStart.clientX,
      payload.strokeReset,
      payload.strokePathReset === true,
      payload.strokePathSerial
    ]),
    [
      [20, 20, true, false, 1],
      [38, 38, false, true, 2]
    ]
  );
  assert.equal(
    editor.textureAirbrushScreenStrokeQueue[0].neighborPaintSeed,
    editor.textureAirbrushScreenStrokeQueue[1].neighborPaintSeed
  );
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].strokeUndo, strokeUndo);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[1].strokeUndo, strokeUndo);
});

test("large direct WebGPU reset footprint coalesces into first move", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  let scheduled = 0;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
    clientX: 100,
    clientY: 100,
    strokeStart: { clientX: 100, clientY: 100 },
    strokeReset: true,
    radiusPixels: 40,
    styleRadiusPixels: 40,
    postCameraProjectionRewarmed: true
  })), true);
  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
    clientX: 124,
    clientY: 100,
    strokeStart: { clientX: 100, clientY: 100 },
    radiusPixels: 40,
    styleRadiusPixels: 40,
    deferredNeighborProjectionRewarm: true,
    webGpuLiveNeighborProjectionCurrent: true
  })), true);

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].strokeReset, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].strokeStartedWithReset, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].clientX, 124);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].clientY, 100);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].postCameraProjectionRewarmed, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].deferredNeighborProjectionRewarm, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].webGpuLiveNeighborProjectionCurrent, true);
  assert.equal(Number.isFinite(editor.textureAirbrushScreenStrokeQueue[0].resetFootprintQueuedAt), true);

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].strokeSegments.length, 1);
  assert.deepEqual(batches[0].strokeSegments[0], {
    start: { clientX: 100, clientY: 100 },
    end: { clientX: 124, clientY: 100 }
  });
});

test("wide-spacing airbrush stamps survive as point segments", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 100,
    clientY: 100,
    strokeStart: { clientX: 100, clientY: 100 },
    spacing: 160,
    radiusPixels: 40,
    styleRadiusPixels: 40
  })];

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].spacing, 160);
  assert.deepEqual(batches[0].strokeSegments, [{
    start: { clientX: 100, clientY: 100 },
    end: { clientX: 100, clientY: 100 }
  }]);
});

test("wide-spacing queued stamps preserve sparse spacing metadata without recursive expansion", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const queuedPayloads = [];
  editor.activeTool = "airbrush";
  editor.painting = false;
  editor.texturePaintStrokePoint = { clientX: 100, clientY: 100 };
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 35;
  editor.textureBrushRadiusScreenPixels = () => 35;
  editor.textureAirbrushScreenStrokeBaseOptions = () => ({ radiusPixels: 35, spacing: 160 });
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => strokePayload({
    clientX: event.clientX,
    clientY: event.clientY,
    strokeStart,
    radiusPixels: 35,
    styleRadiusPixels: 35,
    spacing: 160
  });
  editor.textureAirbrushQueueScreenStroke = () => {
    throw new Error("wide spacing stamps should queue a payload directly");
  };
  editor.textureAirbrushQueueScreenStrokePayload = (payload) => {
    queuedPayloads.push(payload);
    return true;
  };

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 100,
    clientY: 100,
    button: 0,
    buttons: 1
  }, {
    reset: true,
    strokeStart: editor.texturePaintStrokePoint
  }), true);

  assert.equal(queuedPayloads.length, 1);
  assert.equal(queuedPayloads[0].spacing, 160);
  assert.equal(queuedPayloads[0].spacedStamp, true);
  assert.equal(queuedPayloads[0].spacingPixels, 112);
});

test("zero-distance reset samples create immediate startup point stamps", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 100,
    clientY: 100,
    strokeStart: { clientX: 100, clientY: 100 },
    strokeReset: true,
    spacing: 160,
    radiusPixels: 40,
    styleRadiusPixels: 40
  })];

  const resetOnlyBatches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);

  assert.equal(resetOnlyBatches.length, 1);
  assert.equal(resetOnlyBatches[0].strokeStartedWithReset, true);
  assert.deepEqual(resetOnlyBatches[0].strokeSegments, [{
    start: { clientX: 100, clientY: 100 },
    end: { clientX: 100, clientY: 100 }
  }]);

  editor.textureAirbrushScreenStrokeQueue.push(strokePayload({
    clientX: 124,
    clientY: 100,
    strokeStart: { clientX: 100, clientY: 100 },
    spacing: 160,
    radiusPixels: 40,
    styleRadiusPixels: 40
  }));

  const continuedBatches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);

  assert.equal(continuedBatches.length, 1);
  assert.equal(continuedBatches[0].strokeStartedWithReset, true);
  assert.deepEqual(continuedBatches[0].strokeSegments, [
    {
      start: { clientX: 100, clientY: 100 },
      end: { clientX: 100, clientY: 100 }
    },
    {
      start: { clientX: 100, clientY: 100 },
      end: { clientX: 124, clientY: 100 }
    }
  ]);
});

test("ordinary live WebGPU continuation strokes defer after a recent immediate flush", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  let immediateFlushes = 0;
  let scheduledFrameFlushes = 0;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.flushTextureAirbrushScreenStroke = () => 1;
  editor.scheduleTextureAirbrushImmediateWebGpuScreenFlush = () => {
    immediateFlushes += 1;
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduledFrameFlushes += 1;
    return true;
  };
  editor.textureAirbrushLastImmediateWebGpuScreenFlushMs = typeof performance !== "undefined"
    && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
    strokeReset: false,
    radiusPixels: 8,
    styleRadiusPixels: 8
  })), true);

  assert.equal(immediateFlushes, 0);
  assert.equal(scheduledFrameFlushes, 1);
});

test("large direct WebGPU continuation strokes coalesce briefly during drag", async () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  const flushOptions = [];
  let scheduledFrameFlushes = 0;
  globalThis.setTimeout = (callback, delayMs = 0) => {
    timers.push({ callback, delayMs });
    return timers.length;
  };
  try {
    editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
    editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
    editor.flushTextureAirbrushScreenStroke = (options = {}) => {
      flushOptions.push(options);
      return 1;
    };
    editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
      scheduledFrameFlushes += 1;
      return true;
    };

    assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
      strokeReset: false,
      radiusPixels: 48,
      styleRadiusPixels: 48
    })), true);

    assert.equal(scheduledFrameFlushes, 0);
    assert.equal(flushOptions.length, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 40);

    await Promise.resolve();

    assert.equal(flushOptions.length, 0);
    timers[0].callback();

    assert.equal(flushOptions.length, 1);
    assert.equal(flushOptions[0].immediateWebGpuFlush, true);
    assert.equal(flushOptions[0].maxBatches, 4);
    assert.equal(flushOptions[0].maxBatchSegments, 192);
    assert.equal(flushOptions[0].maxSegments, 192);
    assert.equal(flushOptions[0].maxBatchMs, 12);
    assert.equal(flushOptions[0].maxImmediateWebGpuFlushBatches, 32);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("layer live WebGPU continuation strokes coalesce briefly during drag", async () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  const flushOptions = [];
  let scheduledFrameFlushes = 0;
  globalThis.setTimeout = (callback, delayMs = 0) => {
    timers.push({ callback, delayMs });
    return timers.length;
  };
  try {
    editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
    editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
    editor.flushTextureAirbrushScreenStroke = (options = {}) => {
      flushOptions.push(options);
      return 1;
    };
    editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
      scheduledFrameFlushes += 1;
      return true;
    };
    editor.textureAirbrushImmediateWebGpuScreenFlushUsed = true;

    assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
      strokeReset: false,
      layerMode: true,
      layerMutationSerial: 7,
      styleKey: "8:32:220:80:500:350:350:1000:paint:soft:layer:7:all",
      radiusPixels: 8,
      styleRadiusPixels: 8
    })), true);

    assert.equal(scheduledFrameFlushes, 0);
    assert.equal(flushOptions.length, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 16);

    await Promise.resolve();

    assert.equal(flushOptions.length, 0);
    timers[0].callback();

    assert.equal(flushOptions.length, 1);
    assert.equal(flushOptions[0].immediateWebGpuFlush, true);
    assert.equal(flushOptions[0].continuationCoalesceMs, 16);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("first ordinary live WebGPU reset stroke schedules without an extra paint frame", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const flushOptions = [];
  const scheduledImmediateFlushes = [];
  let scheduledFrameFlushes = 0;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.flushTextureAirbrushScreenStroke = (options = {}) => {
    flushOptions.push(options);
    return 1;
  };
  editor.scheduleTextureAirbrushImmediateWebGpuScreenFlush = (options = {}) => {
    scheduledImmediateFlushes.push(options);
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduledFrameFlushes += 1;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
    strokeReset: true,
    radiusPixels: 8,
    styleRadiusPixels: 8
  })), true);

  assert.equal(flushOptions.length, 0);
  assert.equal(scheduledImmediateFlushes.length, 1);
  assert.equal(scheduledImmediateFlushes[0].immediateWebGpuFlush, true);
  assert.equal(scheduledImmediateFlushes[0].frameScheduled, undefined);
  assert.equal(scheduledImmediateFlushes[0].afterPresentation, undefined);
  assert.equal(scheduledFrameFlushes, 0);
  assert.notEqual(editor.textureAirbrushImmediateWebGpuScreenFlushUsed, true);
});

test("first layer live WebGPU reset stroke also schedules without an extra paint frame", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const flushOptions = [];
  const scheduledImmediateFlushes = [];
  let scheduledFrameFlushes = 0;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.flushTextureAirbrushScreenStroke = (options = {}) => {
    flushOptions.push(options);
    return 1;
  };
  editor.scheduleTextureAirbrushImmediateWebGpuScreenFlush = (options = {}) => {
    scheduledImmediateFlushes.push(options);
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduledFrameFlushes += 1;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
    clientX: 34,
    clientY: 30,
    strokeStart: { clientX: 18, clientY: 24 },
    strokeReset: true,
    layerMode: true,
    layerMutationSerial: 7,
    styleKey: "8:32:220:80:500:350:350:1000:paint:soft:layer:7:all",
    radiusPixels: 8,
    styleRadiusPixels: 8
  })), true);

  assert.equal(flushOptions.length, 0);
  assert.equal(scheduledImmediateFlushes.length, 1);
  assert.equal(scheduledImmediateFlushes[0].frameScheduled, undefined);
  assert.equal(scheduledImmediateFlushes[0].afterPresentation, undefined);
  assert.equal(scheduledFrameFlushes, 0);
  assert.notEqual(editor.textureAirbrushImmediateWebGpuScreenFlushUsed, true);
});

test("first-contact scheduler runs WebGPU work on the next frame", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const frames = [];
  let flushes = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  try {
    editor.textureAirbrushScreenStrokeQueue = [strokePayload({
      strokeReset: true
    })];
    editor.flushTextureAirbrushScreenStroke = () => {
      flushes += 1;
      return 1;
    };

    assert.equal(editor.scheduleTextureAirbrushImmediateWebGpuScreenFlush({
      frameScheduled: true
    }), true);
    assert.equal(frames.length, 1);
    assert.equal(flushes, 0);

    frames.shift()?.();
    assert.equal(flushes, 1);
    assert.equal(editor.textureAirbrushImmediateWebGpuScreenFlushUsed, true);
  } finally {
    if (originalRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  }
});

test("coalesced tablet first contact does not add a paint frame", () => {
  class ScreenEditor {}
  installPaintToolMethods(ScreenEditor, { THREE: {} });
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const scheduled = [];
  const samples = [
    {
      clientX: 18,
      clientY: 24,
      pointerType: "pen",
      button: 0,
      buttons: 1,
      pressure: 0.6
    },
    {
      clientX: 42,
      clientY: 30,
      pointerType: "pen",
      button: 0,
      buttons: 1,
      pressure: 0.65
    }
  ];
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 480 };
    }
  };
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushStrokeSourceEvents = () => samples;
  editor.textureAirbrushInputEventAtPoint = (sourceEvent, point) => ({
    ...sourceEvent,
    clientX: point.clientX,
    clientY: point.clientY
  });
  editor.textureAirbrushShouldUseLargeWebGpuNeighborFastQueue = () => false;
  editor.flushTextureAirbrushScreenStroke = () => 1;
  editor.scheduleTextureAirbrushImmediateWebGpuScreenFlush = (options = {}) => {
    scheduled.push(options);
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent(samples.at(-1), {
    reset: true,
    strokeStart: { clientX: 12, clientY: 22 }
  }), true);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].frameScheduled, undefined);
  assert.equal(scheduled[0].afterPresentation, undefined);
  assert.ok((editor.textureAirbrushScreenStrokeQueue || []).length > 0);
});

test("ordinary live WebGPU continuation strokes coalesce briefly after first paint", async () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  const flushOptions = [];
  let scheduledFrameFlushes = 0;
  globalThis.setTimeout = (callback, delayMs = 0) => {
    timers.push({ callback, delayMs });
    return timers.length;
  };
  try {
    editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
    editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
    editor.flushTextureAirbrushScreenStroke = (options = {}) => {
      flushOptions.push(options);
      return 1;
    };
    editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
      scheduledFrameFlushes += 1;
      return true;
    };
    editor.textureAirbrushImmediateWebGpuScreenFlushUsed = true;

    assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
      strokeReset: false,
      radiusPixels: 8,
      styleRadiusPixels: 8
    })), true);

    assert.equal(scheduledFrameFlushes, 0);
    assert.equal(flushOptions.length, 0);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 16);

    await Promise.resolve();

    assert.equal(flushOptions.length, 0);
    timers[0].callback();

    assert.equal(flushOptions.length, 1);
    assert.equal(flushOptions[0].immediateWebGpuFlush, true);
    assert.equal(flushOptions[0].continuationCoalesceMs, 16);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("zero-distance layer reset samples retain the immediate contact stamp", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  let paintCalls = 0;
  let scheduledImmediateFlushes = 0;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = () => {
    paintCalls += 1;
    return 1;
  };
  editor.scheduleTextureAirbrushImmediateWebGpuScreenFlush = () => {
    scheduledImmediateFlushes += 1;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(strokePayload({
    clientX: 100,
    clientY: 100,
    strokeStart: { clientX: 100, clientY: 100 },
    strokeReset: true,
    layerMode: true,
    layerMutationSerial: 7,
    styleKey: "40:32:220:80:500:350:350:1000:paint:soft:layer:7:all",
    spacing: 160,
    radiusPixels: 40,
    styleRadiusPixels: 40
  })), true);

  assert.equal(paintCalls, 0);
  assert.equal(scheduledImmediateFlushes, 1);
  assert.equal((editor.textureAirbrushScreenStrokeQueue || []).length, 1);
  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].strokeReset, true);
  assert.deepEqual(batches[0].strokeSegments, [{
    start: { clientX: 100, clientY: 100 },
    end: { clientX: 100, clientY: 100 }
  }]);
});

test("sparse pen WebGPU screen strokes interpolate instead of leaving client gaps", () => {
  class ScreenEditor {}
  installPaintToolMethods(ScreenEditor, { THREE: {} });
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 480 };
    }
  };
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushInputEventAtPoint = (sourceEvent, point) => ({
    ...sourceEvent,
    clientX: point.clientX,
    clientY: point.clientY
  });
  editor.textureAirbrushStrokeSourceEvents = (event) => [event];
  editor.textureAirbrushWebGpuDevice = () => null;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.texturePaintStrokePoint = { clientX: 100, clientY: 100 };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 170,
    clientY: 100,
    pointerType: "pen",
    button: 0,
    buttons: 1,
    pressure: 1
  }), true);

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.equal(batches.length, 1);
  assert.ok(batches[0].strokeSegments.length > 1);
  assert.deepEqual(batches[0].strokeSegments[0].start, { clientX: 100, clientY: 100 });
  assert.deepEqual(batches[0].strokeSegments.at(-1).end, { clientX: 170, clientY: 100 });
});

test("reset WebGPU queue can start from deferred pointer-down point", () => {
  class ScreenEditor {}
  installPaintToolMethods(ScreenEditor, { THREE: {} });
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 480 };
    }
  };
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushInputEventAtPoint = (sourceEvent, point) => ({
    ...sourceEvent,
    clientX: point.clientX,
    clientY: point.clientY
  });
  editor.textureAirbrushStrokeSourceEvents = (event) => [event];
  editor.textureAirbrushWebGpuDevice = () => null;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  assert.equal(editor.paintTextureStrokeFromEvent({
    clientX: 184,
    clientY: 142,
    pointerType: "pen",
    button: 0,
    buttons: 1,
    pressure: 1
  }, {
    reset: true,
    strokeStart: { clientX: 160, clientY: 140 }
  }), true);

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.equal(batches.length, 1);
  assert.ok(batches[0].strokeSegments.length > 1);
  assert.deepEqual(batches[0].strokeSegments[0].start, { clientX: 160, clientY: 140 });
  assert.deepEqual(batches[0].strokeSegments.at(-1).end, { clientX: 184, clientY: 142 });
  assert.equal(batches[0].strokeStartedWithReset, true);
});

test("Neighbor screen hit probes bound under-surface hit extraction", () => {
  class PointerEditor {}
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  const trianglesVisited = [];
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {};
  const triangles = Array.from({ length: 30 }, (_, index) => ({
    record: { id: index },
    object: { uuid: `object-${index}` },
    faceIndex: index,
    face: { a: 0, b: 1, c: 2, materialIndex: 0 },
    uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    screen: [
      { x: 0, y: 0, z: index * 0.01 },
      { x: 100, y: 0, z: index * 0.01 },
      { x: 0, y: 100, z: index * 0.01 }
    ],
    get minDepth() {
      trianglesVisited.push(index);
      return index * 0.01;
    }
  }));
  editor.textureAirbrushBuildScreenHitIndex = () => ({
    cellSize: 16,
    columnCount: 8,
    rowCount: 8,
    cells: new Map([["3:3", triangles]]),
    hitCache: new Map()
  });

  const hits = editor.textureAirbrushScreenHitsForEvent({
    clientX: 50,
    clientY: 50
  }, "airbrush", {
    maxHits: 3
  });

  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((entry) => entry.hit.faceIndex), [0, 1, 2]);
  assert.ok(trianglesVisited.length < triangles.length);

  const widerHits = editor.textureAirbrushScreenHitsForEvent({
    clientX: 50,
    clientY: 50
  }, "airbrush", {
    maxHits: 5
  });

  assert.equal(widerHits.length, 5);
  assert.deepEqual(widerHits.map((entry) => entry.hit.faceIndex), [0, 1, 2, 3, 4]);
});

test("screen hit cache separates frontmost geometry from visible-texel queries", () => {
  class PointerEditor {}
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  const index = {
    cellSize: 16,
    columnCount: 8,
    rowCount: 8,
    cells: new Map([["3:3", []]]),
    hitCache: new Map()
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {};
  editor.textureAirbrushBuildScreenHitIndex = () => index;

  editor.textureAirbrushScreenHitsForEvent({ clientX: 50, clientY: 50 }, "airbrush", {
    firstOnly: true
  });
  editor.textureAirbrushScreenHitsForEvent({ clientX: 50, clientY: 50 }, "airbrush", {
    firstOnly: true,
    skipTransparentTextureHits: false
  });

  assert.equal(index.hitCache.size, 2);
});

test("Neighbor hit sampling requests frontmost geometry from the screen index", () => {
  class NeighborEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  const editor = new NeighborEditor();
  const paintHit = { record: { id: "body" }, hit: { face: { a: 0, b: 1, c: 2 } } };
  let receivedOptions = null;
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintHitForEvent = (_event, _tool, options) => {
    receivedOptions = options;
    return paintHit;
  };

  assert.equal(editor.textureAirbrushNeighborPaintHitFromEvent({
    clientX: 50,
    clientY: 50
  }, "airbrush"), paintHit);
  assert.equal(receivedOptions.skipTransparentTextureHits, false);
  assert.equal(receivedOptions.raycastFallbackOnScreenMiss, false);
});

test("finishing a large WebGPU Neighbor stroke schedules instead of synchronously flushing", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const seed = { enabled: true, key: "neighbor-seed" };
  let scheduled = 0;
  let flushes = 0;

  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.flushTextureAirbrushScreenStroke = () => {
    flushes += 1;
    return 1;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    strokeReset: true,
    radiusPixels: 37,
    styleRadiusPixels: 37,
    neighborPaintSeed: seed,
    neighborPaintKey: "neighbor-seed"
  })];

  const promise = editor.finishTextureAirbrushScreenStrokeFlush();

  assert.ok(promise && typeof promise.then === "function");
  assert.equal(flushes, 0);
  assert.equal(scheduled, 1);
});

test("scheduled large WebGPU Neighbor flush uses the low-latency frame budget", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const previousWindow = globalThis.window;
  const previousSetTimeout = globalThis.setTimeout;
  const flushOptions = [];
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        callback(0);
        return 1;
      }
    };
    globalThis.setTimeout = (callback) => {
      callback();
      return 1;
    };
    editor.textureAirbrushScreenStrokeQueue = [strokePayload({
      radiusPixels: 40,
      styleRadiusPixels: 40,
      neighborPaintSeed: { enabled: true },
      neighborPaintKey: "large-neighbor"
    })];
    editor.flushTextureAirbrushScreenStroke = (options = {}) => {
      flushOptions.push(options);
      editor.textureAirbrushScreenStrokeQueue = [];
      return 1;
    };

    assert.equal(editor.scheduleTextureAirbrushScreenStrokeFlush(), true);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    globalThis.setTimeout = previousSetTimeout;
  }

  assert.equal(flushOptions.length, 1);
  assert.equal(flushOptions[0].largeLiveNeighborFlush, true);
  assert.equal(flushOptions[0].maxBatchMs, 8);
  assert.equal(flushOptions[0].maxBatchSegments, 64);
  assert.equal(flushOptions[0].maxSegments, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
});

test("scheduled large WebGPU brush flush does not add a first-frame throttle", async () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const previousWindow = globalThis.window;
  const previousSetTimeout = globalThis.setTimeout;
  const timeoutDelays = [];
  const flushOptions = [];
  let rafCalls = 0;
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        rafCalls += 1;
        callback(0);
        return rafCalls;
      }
    };
    globalThis.setTimeout = (callback, delay = 0) => {
      timeoutDelays.push(delay);
      callback();
      return timeoutDelays.length;
    };
    editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
    editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
    editor.textureAirbrushScreenStrokeQueue = [strokePayload({
      radiusPixels: 52,
      styleRadiusPixels: 52
    })];
    editor.flushTextureAirbrushScreenStroke = (options = {}) => {
      flushOptions.push(options);
      editor.textureAirbrushScreenStrokeQueue = [];
      return 1;
    };

    assert.equal(editor.scheduleTextureAirbrushScreenStrokeFlush(), true);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    globalThis.setTimeout = previousSetTimeout;
  }

  assert.equal(rafCalls, 0);
  await Promise.resolve();
  assert.deepEqual(timeoutDelays, []);
  assert.equal(flushOptions.length, 1);
  assert.equal(flushOptions[0].maxBatchMs, 12);
  assert.equal(flushOptions[0].maxBatchSegments, 192);
  assert.equal(flushOptions[0].maxSegments, 192);
});

test("large WebGPU Neighbor live flush drains a full stroke within the WebGPU frame budget", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const seed = { enabled: true, key: "neighbor-seed" };
  const webGpuPaints = [];
  let scheduled = 0;
  let queuedFlushOptions = null;

  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    editor.textureAirbrushQueuedWebGpuStrokes = [{
      estimate: 1,
      options: { largeLiveNeighborPaint: true }
    }];
    return options.strokeSegments.length;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = (options = {}) => {
    queuedFlushOptions = options;
    editor.textureAirbrushQueuedWebGpuStrokes = [];
    return Promise.resolve(1);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    queuedFlushOptions = {};
    editor.textureAirbrushQueuedWebGpuStrokes = [];
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 96 }, (_, index) => strokePayload({
    clientX: 24 + index * 4,
    clientY: 30 + index * 2,
    strokeStart: { clientX: 20 + index * 4, clientY: 28 + index * 2 },
    radiusPixels: 40,
    styleRadiusPixels: 40,
    neighborPaintSeed: seed,
    neighborPaintKey: "neighbor-seed",
    strokeReset: index === 0
  }));

  const changed = editor.flushTextureAirbrushScreenStroke({ live: true });

  assert.ok(changed > 0);
  assert.equal(webGpuPaints.length, 2);
  assert.ok(webGpuPaints.every((paint) => paint.options.strokeSegments.length <= 64));
  assert.ok(webGpuPaints.every((paint) => paint.options.largeLiveNeighborPaint === true));
  assert.ok(webGpuPaints.every((paint) => paint.options.neighborPaintKey === "neighbor-seed"));
  assert.equal(
    webGpuPaints.reduce((total, paint) => total + paint.options.strokeSegments.length, 0),
    96
  );
  assert.deepEqual(queuedFlushOptions, {});
  assert.equal((editor.textureAirbrushPendingScreenStrokeBatches || []).length, 0);
  assert.equal(scheduled, 0);
});

test("large WebGPU Neighbor layer live flush keeps the large-neighbor marker", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const seed = { enabled: true, key: "neighbor-layer-seed" };
  const webGpuPaints = [];

  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    return options.strokeSegments.length;
  };
  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 3 }, (_, index) => strokePayload({
    clientX: 80 + index * 24,
    clientY: 90 + index * 12,
    strokeStart: { clientX: 70 + index * 24, clientY: 84 + index * 12 },
    radiusPixels: 40,
    styleRadiusPixels: 40,
    layerMode: true,
    neighborPaintSeed: seed,
    neighborPaintKey: "neighbor-layer-seed",
    strokeReset: index === 0
  }));

  const changed = editor.flushTextureAirbrushScreenStroke({ live: true });

  assert.equal(changed, 3);
  assert.equal(webGpuPaints.length, 1);
  assert.equal(webGpuPaints[0].options.largeLiveNeighborPaint, true);
  assert.equal(webGpuPaints[0].options.neighborPaintKey, "neighbor-layer-seed");
  assert.equal(webGpuPaints[0].options.layerMode, true);
});

test("large WebGPU Neighbor scheduled flush resolves seedless large batches", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const seed = { enabled: true, key: "adopted-neighbor-seed" };
  const webGpuPaints = [];
  let beginCalls = 0;

  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushBeginNeighborPaintStroke = () => {
    beginCalls += 1;
    return seed;
  };
  editor.textureAirbrushNeighborSeedKey = (candidateSeed) => candidateSeed?.key || "";
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    return options.strokeSegments.length;
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 96,
    clientY: 116,
    strokeStart: { clientX: 86, clientY: 108 },
    radiusPixels: 40,
    styleRadiusPixels: 40,
    layerMode: true,
    strokeReset: true
  })];

  const changed = editor.flushTextureAirbrushScreenStroke({
    live: true,
    largeLiveNeighborFlush: true
  });

  assert.equal(changed, 1);
  assert.equal(beginCalls, 1);
  assert.equal(webGpuPaints.length, 1);
  assert.equal(webGpuPaints[0].options.neighborPaintSeed, seed);
  assert.equal(webGpuPaints[0].options.neighborPaintKey, "adopted-neighbor-seed");
  assert.equal(webGpuPaints[0].options.largeLiveNeighborPaint, true);
});

test("large WebGPU Neighbor scheduled flush paints when deferred seed lookup misses", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const webGpuPaints = [];

  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushBeginNeighborPaintStroke = () => null;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    return 1;
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 120,
    clientY: 140,
    strokeStart: { clientX: 96, clientY: 128 },
    radiusPixels: 40,
    styleRadiusPixels: 40,
    layerMode: true,
    deferredNeighborPaintSeed: true,
    strokeReset: false
  })];

  const changed = editor.flushTextureAirbrushScreenStroke({
    live: true,
    largeLiveNeighborFlush: true
  });

  assert.equal(changed, 1);
  assert.equal(webGpuPaints.length, 1);
  assert.equal(webGpuPaints[0].options.neighborPaintSeed, undefined);
  assert.equal(webGpuPaints[0].options.neighborPaintKey, undefined);
  assert.equal(webGpuPaints[0].options.largeLiveNeighborPaint, undefined);
});

test("large WebGPU Neighbor immediate live flush resolves seedless large batches", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const seed = { enabled: true, key: "immediate-neighbor-seed" };
  const webGpuPaints = [];

  editor.activeTool = "pen";
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushBeginNeighborPaintStroke = (event, tool) => {
    assert.equal(tool, "airbrush");
    return seed;
  };
  editor.textureAirbrushNeighborSeedKey = (candidateSeed) => candidateSeed?.key || "";
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    webGpuPaints.push({ event, options });
    return options.strokeSegments.length;
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 126,
    clientY: 146,
    strokeStart: { clientX: 116, clientY: 138 },
    radiusPixels: 40,
    styleRadiusPixels: 40
  })];

  const changed = editor.flushTextureAirbrushScreenStroke({
    live: true,
    immediateWebGpuFlush: true
  });

  assert.equal(changed, 1);
  assert.equal(webGpuPaints.length, 1);
  assert.equal(webGpuPaints[0].options.neighborPaintSeed, seed);
  assert.equal(webGpuPaints[0].options.neighborPaintKey, "immediate-neighbor-seed");
  assert.equal(webGpuPaints[0].options.largeLiveNeighborPaint, true);
});

test("immediate WebGPU screen-stroke paint flushes queued surface work during drag", () => {
  class AppEditor {}
  installTextureAirbrushWebGpuMethods(AppEditor, { THREE: {} });
  const editor = new AppEditor();
  installEditorDefaults(editor);
  const candidateOptions = [];
  const queued = [];
  let scheduledFlushes = 0;
  let flushOptions = null;
  const strokeSegment = {
    start: { x: 480, y: 512 },
    end: { x: 560, y: 520 },
    screenStart: { x: 320, y: 240 },
    screenEnd: { x: 400, y: 248 },
    radiusPixels: 44,
    screenRadiusPixels: 44
  };

  editor.model = {};
  editor.texturePaintHitForEvent = () => ({ record: { id: "record" }, hit: { uv: { x: 0.5, y: 0.5 } } });
  editor.textureBrushRadiusScreenPixels = () => 44;
  editor.textureAirbrushQueuedWebGpuStrokes = [];
  editor.textureAirbrushWebGpuCandidatesFromEvent = (event, options = {}) => {
    candidateOptions.push(options);
    return [{
      record: { id: "record" },
      material: { uuid: "material" },
      materialIndex: 0,
      editable: {
        canvas: { width: 1024, height: 1024 },
        texture: { uuid: "texture" }
      },
      radiusPixels: 44,
      center: { x: 560, y: 520 },
      start: { x: 480, y: 512 },
      strokeSegments: [strokeSegment],
      estimate: 4096,
      options: {
        ...options,
        radiusPixels: 44,
        opacity: 0.55,
        hardness: 0.02,
        scatter: 0.25,
        strength: 1,
        color: { r: 0, g: 255, b: 96 },
        strokeSegments: [strokeSegment],
        screenProjectedStrokeSegments: [{
          start: strokeSegment.screenStart,
          end: strokeSegment.screenEnd,
          radiusPixels: 44
        }]
      }
    }];
  };
  editor.textureAirbrushQueueWebGpuStrokeCandidate = (candidate, options = {}) => {
    queued.push({ candidate, options });
    editor.textureAirbrushQueuedWebGpuStrokes.push({
      ...candidate,
      options: {
        ...candidate.options,
        ...options,
        screenStrokePaint: true
      }
    });
    return candidate.estimate;
  };
  editor.flushTextureAirbrushQueuedWebGpuStrokes = (options = {}) => {
    flushOptions = options;
    return Promise.resolve(1);
  };
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduledFlushes += 1;
    return true;
  };

  const changed = editor.textureAirbrushWebGpuPaintFromEvent(
    { clientX: 400, clientY: 248, buttons: 1 },
    {
      liveProjectedPaint: true,
      requireVisibilityMask: true,
      screenStrokePaint: true,
      immediateWebGpuFlush: true,
      deferQueuedWebGpuFlush: true,
      maxImmediateWebGpuFlushBatches: 3,
      radiusPixels: 44,
      opacity: 0.55,
      hardness: 0.02,
      scatter: 0.25,
      strokeStart: { clientX: 320, clientY: 240 },
      strokeSegments: [{
        start: { clientX: 320, clientY: 240 },
        end: { clientX: 400, clientY: 248 },
        radiusPixels: 44
      }]
    }
  );

  assert.equal(changed, 4096);
  assert.equal(queued.length, 1);
  assert.equal(scheduledFlushes, 0);
  assert.equal(flushOptions?.force, false);
  assert.equal(flushOptions?.maxBatches, 3);
  assert.equal(candidateOptions[0].fullProjectedSurfaceRenderTriangles, true);
  assert.equal(candidateOptions[0].deferVisibilityMaskAssignment, true);
  assert.equal(candidateOptions[0].screenStrokePaint, true);
});

test("in-flight WebGPU screen-stroke flush schedules a follow-up drain", () => {
  class AppEditor {}
  installTextureAirbrushWebGpuMethods(AppEditor, { THREE: {} });
  const editor = new AppEditor();
  let scheduled = 0;
  let resolveInFlight = null;
  const inFlight = new Promise((resolve) => {
    resolveInFlight = resolve;
  });
  editor.textureAirbrushWebGpuFlushInFlight = inFlight;
  editor.textureAirbrushQueuedWebGpuStrokes = [{
    estimate: 1,
    options: { screenStrokePaint: true }
  }];
  editor.scheduleTextureAirbrushQueuedWebGpuFlush = () => {
    scheduled += 1;
    return true;
  };

  assert.equal(
    editor.flushTextureAirbrushQueuedWebGpuStrokes({
      force: false,
      maxBatches: 8
    }),
    inFlight
  );
  assert.equal(scheduled, 1);

  resolveInFlight(1);
});

test("large WebGPU Neighbor live flush paints seedless large batches", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  let paintCalls = 0;
  let paintOptions = null;

  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushBeginNeighborPaintStroke = () => null;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgpu", webGpuStatus: "ready" });
  editor.textureAirbrushWebGpuPaintFromEvent = (event, options = {}) => {
    paintOptions = options;
    paintCalls += 1;
    return 1;
  };
  editor.textureAirbrushScreenStrokeQueue = [strokePayload({
    clientX: 126,
    clientY: 146,
    strokeStart: { clientX: 116, clientY: 138 },
    radiusPixels: 40,
    styleRadiusPixels: 40
  })];

  const changed = editor.flushTextureAirbrushScreenStroke({
    live: true,
    immediateWebGpuFlush: true
  });

  assert.equal(changed, 1);
  assert.equal(paintCalls, 1);
  assert.equal(paintOptions?.screenStrokePaint, true);
  assert.equal(paintOptions?.immediateWebGpuFlush, true);
});

test("large WebGPU Neighbor reset defers seed without legacy projection rewarm", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  let beginCalls = 0;
  let rewarmCalls = 0;
  let queuedPayload = null;
  editor.activeTool = "airbrush";
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureBrushRadiusScreenPixels = () => 37;
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 8;
  editor.textureAirbrushEndPostCameraProjectionStroke = () => {};
  editor.textureAirbrushResetLiveProjectionFrame = () => {};
  editor.textureAirbrushResetStrokePressureState = () => {};
  editor.textureAirbrushResetStrokeBrushState = () => {};
  editor.textureAirbrushScreenStrokeBaseOptions = () => ({ radiusPixels: 37, spacing: 1 });
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => strokePayload({
    clientX: event.clientX,
    clientY: event.clientY,
    strokeStart,
    radiusPixels: 37,
    styleRadiusPixels: 37
  });
  editor.textureAirbrushQueueScreenStrokePayload = (payload) => {
    queuedPayload = payload;
    return true;
  };
  editor.textureAirbrushBeginNeighborPaintStroke = () => {
    beginCalls += 1;
    return { enabled: true };
  };
  editor.textureAirbrushRewarmNeighborResetProjection = () => {
    rewarmCalls += 1;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 40,
    clientY: 50,
    button: 0,
    buttons: 1
  }, { reset: true }), true);

  assert.equal(beginCalls, 0);
  assert.equal(rewarmCalls, 0);
  assert.equal(queuedPayload.deferredNeighborPaintSeed, true);
  assert.equal(queuedPayload.deferredNeighborProjectionRewarm, undefined);
  assert.equal(queuedPayload.webGpuLiveNeighborProjectionCurrent, undefined);
});

test("Neighbor reset lets the TSL paint pass rebuild visible projection", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushNeighborProjectionDirty = true;
  editor.textureAirbrushNeighborProjectionFirstStrokeRewarm = true;
  editor.textureAirbrushLayerProjectionFirstStrokeRewarm = true;
  editor.textureAirbrushPrewarm = () => {
    throw new Error("reset must not run a broad synchronous prewarm");
  };

  assert.equal(editor.textureAirbrushRewarmNeighborResetProjection(), true);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, false);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, false);
  assert.equal(editor.textureAirbrushLayerProjectionFirstStrokeRewarm, false);
});

test("layer reset lets the TSL paint pass rebuild visible projection", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLayerProjectionFirstStrokeRewarm = true;
  editor.textureAirbrushPrewarm = () => {
    throw new Error("reset must not run a broad synchronous prewarm");
  };

  assert.equal(editor.textureAirbrushRewarmLayerResetProjection(), true);
  assert.equal(editor.textureAirbrushLayerProjectionFirstStrokeRewarm, false);
});

test("paint entrypoint routes large WebGPU Neighbor strokes through the fast queue", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushScreenStrokeMethods(PaintEditor);
  const editor = new PaintEditor();
  let queuedPayload = null;
  editor.activeTool = "airbrush";
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureBrushRadiusScreenPixels = () => 37;
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 37;
  editor.textureAirbrushScreenStrokeBaseOptions = () => ({ radiusPixels: 37, spacing: 1 });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushStabilizedPressureOptions = (event, options) => options;
  editor.textureAirbrushColor = () => ({ r: 32, g: 220, b: 80 });
  editor.textureAirbrushVisibleEdgeMode = () => "soft";
  editor.textureAirbrushQueueSpacedScreenStroke = () => {
    throw new Error("large Neighbor WebGPU strokes should bypass the spaced pointer path");
  };
  editor.textureAirbrushQueueScreenStrokePayload = (payload) => {
    queuedPayload = payload;
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 40,
    clientY: 50,
    button: 0,
    buttons: 1
  }, { reset: true }), true);

  assert.equal(queuedPayload.radiusPixels, 37);
  assert.equal(queuedPayload.strokeReset, true);
  assert.equal(queuedPayload.deferredNeighborPaintSeed, true);
  assert.equal(queuedPayload.deferredNeighborProjectionRewarm, undefined);
  assert.equal(queuedPayload.webGpuLiveNeighborProjectionCurrent, true);
});

test("spaced WebGPU screen strokes ignore duplicate reset markers during one active drag", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  let queuedPayload = null;
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintStrokePoint = { clientX: 36, clientY: 44 };
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 37;
  editor.textureBrushRadiusScreenPixels = () => 37;
  editor.textureAirbrushScreenStrokeBaseOptions = () => ({ radiusPixels: 37, spacing: 1 });
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    throw new Error("duplicate active-stroke reset must not reset the live projection frame");
  };
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => strokePayload({
    clientX: event.clientX,
    clientY: event.clientY,
    strokeStart,
    radiusPixels: 37,
    styleRadiusPixels: 37
  });
  editor.textureAirbrushQueueScreenStrokePayload = (payload) => {
    queuedPayload = payload;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 48,
    clientY: 56,
    button: 0,
    buttons: 1
  }, {
    reset: true,
    strokeStart: editor.texturePaintStrokePoint
  }), true);

  assert.equal(queuedPayload.strokeReset, false);
  assert.deepEqual(queuedPayload.strokeStart, { clientX: 36, clientY: 44 });
});

test("spaced WebGPU Neighbor discontinuities preserve opacity during one active drag", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  let queuedPayload = null;
  let projectionResets = 0;
  let neighborStrokeBegins = 0;
  const originalNeighborSeed = {
    enabled: true,
    key: "original-neighbor-seed"
  };
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushActiveNeighborPaintSeed = originalNeighborSeed;
  editor.texturePaintStrokePoint = { clientX: 36, clientY: 44 };
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.textureAirbrushCachedStrokeRadiusPixels = () => 8;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushScreenStrokeBaseOptions = () => ({ radiusPixels: 8, spacing: 1 });
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    projectionResets += 1;
  };
  editor.textureAirbrushBeginNeighborPaintStroke = () => {
    neighborStrokeBegins += 1;
    editor.textureAirbrushActiveNeighborPaintSeed = {
      enabled: true,
      key: "replacement-neighbor-seed"
    };
    return editor.textureAirbrushActiveNeighborPaintSeed;
  };
  editor.textureAirbrushScreenStrokePayload = (event, strokeStart) => ({
    ...strokePayload({
      clientX: event.clientX,
      clientY: event.clientY,
      strokeStart,
      radiusPixels: 8,
      styleRadiusPixels: 8
    }),
    neighborPaintSeed: editor.textureAirbrushActiveNeighborPaintSeed,
    neighborPaintKey: editor.textureAirbrushActiveNeighborPaintSeed?.key || ""
  });
  editor.textureAirbrushQueueScreenStrokePayload = (payload) => {
    queuedPayload = payload;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 48,
    clientY: 56,
    button: 0,
    buttons: 1
  }, {
    reset: true,
    forceStrokeReset: true,
    preserveStrokeOpacity: true,
    strokeStart: { clientX: 48, clientY: 56 }
  }), true);

  assert.equal(queuedPayload.strokeReset, false);
  assert.equal(queuedPayload.strokePathReset, true);
  assert.ok(queuedPayload.strokePathSerial > 0);
  assert.equal(projectionResets, 0);
  assert.equal(neighborStrokeBegins, 0);
  assert.equal(queuedPayload.neighborPaintSeed, originalNeighborSeed);
  assert.equal(queuedPayload.neighborPaintKey, "original-neighbor-seed");
  assert.deepEqual(queuedPayload.strokeStart, { clientX: 48, clientY: 56 });
});

test("Neighbor path-only resets stay separate while retaining one opacity stroke", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  const firstPath = strokePayload({
    clientX: 20,
    clientY: 10,
    strokeStart: { clientX: 10, clientY: 10 },
    strokePathSerial: 1
  });
  const returnedPath = strokePayload({
    clientX: 50,
    clientY: 10,
    strokeStart: { clientX: 50, clientY: 10 },
    strokePathReset: true,
    strokePathSerial: 2
  });
  const continuation = strokePayload({
    clientX: 60,
    clientY: 10,
    strokeStart: { clientX: 50, clientY: 10 },
    strokePathSerial: 2
  });

  const batches = editor.textureAirbrushScreenStrokeBatches([
    firstPath,
    returnedPath,
    continuation
  ]);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].strokeReset, false);
  assert.equal(batches[0].strokePathReset, false);
  assert.equal(batches[0].strokePathSerial, 1);
  assert.equal(batches[1].strokeReset, false);
  assert.equal(batches[1].strokePathReset, true);
  assert.equal(batches[1].strokePathSerial, 2);
  assert.equal(batches[1].strokeSegments.length, 2);
});

test("retargeted reset WebGPU payloads become reset-start continuations", () => {
  class ScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  installEditorDefaults(editor);
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.textureAirbrushWebGpuPaintFromEvent = () => 1;
  editor.textureAirbrushWebGpuDevice = () => ({ label: "native-webgpu-device" });
  editor.scheduleTextureAirbrushImmediateWebGpuScreenFlush = () => {
    scheduled += 1;
    return true;
  };
  const payload = strokePayload({
    clientX: 20,
    clientY: 10,
    strokeStart: { clientX: 10, clientY: 10 },
    radiusPixels: 40,
    styleRadiusPixels: 40,
    strokeReset: true
  });
  editor.textureAirbrushScreenStrokeQueue = [payload];

  assert.equal(editor.textureAirbrushRetargetQueuedContinuousStroke({
    clientX: 30,
    clientY: 10,
    button: 0,
    buttons: 1
  }, { clientX: 20, clientY: 10 }, { radiusPixels: 40, spacing: 1 }), true);

  assert.equal(payload.strokeReset, false);
  assert.equal(payload.strokeStartedWithReset, true);
  assert.equal(payload.clientX, 30);
  assert.equal(payload.clientY, 10);
  assert.equal(scheduled, 1);
});
