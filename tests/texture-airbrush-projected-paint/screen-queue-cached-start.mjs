import assert from "node:assert/strict";
import test from "node:test";
import { installClonePaintMethods } from "../../src/weight-editor/clone-paint.js";
import { installPaintToolMethods } from "../../src/weight-editor/paint-tools.js";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../../src/weight-editor/airbrush/constants.js";
import { installTextureAirbrushScreenStrokeMethods } from "../../src/weight-editor/airbrush/screen-strokes.js";
import { installTextureAirbrushPointerMethods } from "../../src/weight-editor/airbrush/pointer.js";
import { installTextureAirbrushWebGlBackendMethods } from "../../src/weight-editor/airbrush/webgl-backend.js";
import { installTextureAirbrushProjectedPaintMethods } from "../../src/weight-editor/airbrush/projected-paint.js";
import { installTextureAirbrushUvBrushMethods } from "../../src/weight-editor/airbrush/uv-brush.js";
import {
  textureAirbrushPaintSamplePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent
} from "../../src/weight-editor/airbrush/projection.js";

class TestEditor {}

installTextureAirbrushProjectedPaintMethods(TestEditor);

test("airbrush screen batches reuse cached payload style", () => {
  class SpacingEditor {}
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.25;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushPressureSettings = () => ({ radius: false, opacity: false, hardness: false, scatter: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;

  const first = editor.textureAirbrushScreenStrokePayload({ clientX: 0, clientY: 0 }, { clientX: 0, clientY: 0 });
  const second = editor.textureAirbrushScreenStrokePayload({ clientX: 12, clientY: 0 }, { clientX: 0, clientY: 0 });

  editor.textureBrushRadiusScreenPixels = () => {
    throw new Error("cached style should provide radius");
  };
  editor.textureAirbrushOpacity = () => {
    throw new Error("cached style should provide opacity");
  };
  editor.textureAirbrushHardness = () => {
    throw new Error("cached style should provide hardness");
  };
  editor.textureAirbrushScatter = () => {
    throw new Error("cached style should provide scatter");
  };
  editor.textureAirbrushColor = () => {
    throw new Error("cached style should provide color");
  };

  const [batch] = editor.textureAirbrushScreenStrokeBatches([first, second]);

  assert.equal(batch.styleKey, first.styleKey);
  assert.equal(batch.radiusPixels, 10);
  assert.deepEqual(batch.color, { r: 255, g: 0, b: 0 });
  assert.equal(batch.opacity, 0.5);
  assert.equal(batch.hardness, 0.35);
  assert.equal(batch.scatter, 0.25);
  assert.deepEqual(batch.strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 0, clientY: 0 }
    },
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 12, clientY: 0 }
    }
  ]);
});

test("airbrush queue coalescing keeps the existing payload object", () => {
  class SpacingEditor {}
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  let scheduled = 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  const payload = (startX, endX) => ({
    clientX: endX,
    clientY: 0,
    strokeStart: { clientX: startX, clientY: 0 },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.5,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1
  });

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(payload(0, 10)), true);
  const retainedPayload = editor.textureAirbrushScreenStrokeQueue[0];

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(payload(10, 20)), true);

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0], retainedPayload);
  assert.deepEqual({
    startX: retainedPayload.strokeStart.clientX,
    endX: retainedPayload.clientX
  }, {
    startX: 0,
    endX: 20
  });
});

test("layer airbrush cached start probe is exact and layer-only", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  const layerPass = { key: "layer-pass", targetEntry: { layerMode: true } };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame?.current === true;
  editor.textureAirbrushLiveProjectionFrameState = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    probePaintPassCache: new Map([
      ["20:25", [layerPass]],
      ["40:25", [{ targetEntry: { layerMode: false } }]]
    ])
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    layerMode: true,
    erase: false,
    radiusPixels: 24
  }];

  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 30, clientY: 45 }), true);
  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 33, clientY: 47 }), true);
  assert.deepEqual(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("23:27"), [layerPass]);
  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 50, clientY: 45 }), false);

  editor.textureAirbrushScreenStrokeQueue = [{ layerMode: true, erase: true }];
  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 30, clientY: 45 }), false);

  editor.textureAirbrushScreenStrokeQueue = [{ layerMode: true, erase: false }];
  editor.textureAirbrushLiveProjectionFrameState.current = false;
  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 30, clientY: 45 }), false);
});

test("layer airbrush cached start can seed from the warmed hover hit", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  const layerPass = { key: "layer-pass", targetEntry: { layerMode: true } };
  const seedCalls = [];
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame?.current === true;
  editor.textureAirbrushLiveProjectionFrameState = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    probePaintPassCache: new Map()
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    layerMode: true,
    erase: false,
    radiusPixels: 24
  }];
  editor.textureAirbrushCachedLayerHitPassesForProbe = (frame, point, options) => {
    seedCalls.push({ frame, point, radiusPixels: options.radiusPixels });
    frame.probePaintPassCache.set(`${Math.round(point.x)}:${Math.round(point.y)}`, [layerPass]);
    return [layerPass];
  };

  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 30, clientY: 45 }), true);
  assert.deepEqual(seedCalls, [{
    frame: editor.textureAirbrushLiveProjectionFrameState,
    point: { x: 20, y: 25 },
    radiusPixels: 24
  }]);
  assert.deepEqual(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("20:25"), [layerPass]);
});

test("layer airbrush cached start accepts a fully warmed layer frame without an exact hover probe", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = { key: "layer-pass", targetEntry };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame?.current === true;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushLiveProjectionFrameState = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    paintPassCacheSeeded: true,
    seedPaintPasses: true,
    paintPassCache: new Map([["layer-pass", layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([["layer-pass", {}]])
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    layerMode: true,
    erase: false,
    radiusPixels: 24,
    spacing: 1
  }];

  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 30, clientY: 45 }), true);
  assert.deepEqual(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("20:25"), [layerPass]);
});

test("layer airbrush cached start accepts a warm active-layer pass without an exact hover probe", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  let hitProbeSeeds = 0;
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = { key: "active-pass", targetEntry };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame?.current === true;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushCachedLayerHitPassesForProbe = () => {
    hitProbeSeeds += 1;
    return [];
  };
  editor.textureAirbrushLiveProjectionFrameState = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    seedPaintPasses: false,
    paintPassCache: new Map([["active-pass", layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    layerMode: true,
    erase: false,
    radiusPixels: 24,
    spacing: 1
  }];

  assert.equal(editor.textureAirbrushCachedLayerStartProbeReady({ clientX: 30, clientY: 45 }), true);
  assert.equal(hitProbeSeeds, 0);
  assert.deepEqual(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("20:25"), [layerPass]);
});

test("reset layer airbrush seeds an exact start probe from an already warm frame", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  const previousWindow = globalThis.window;
  let resetPrewarmFrames = 0;
  let screenFlushes = 0;
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = { key: "active-pass", targetEntry };
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        resetPrewarmFrames += 1;
        return callback;
      }
    };
    editor.activeTool = "airbrush";
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame?.current === true;
    editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
    editor.textureAirbrushLiveProjectionFrameState = {
      current: true,
      rect: { left: 10, top: 20, width: 200, height: 140 },
      paintPassCache: new Map([["active-pass", layerPass]]),
      probePaintPassCache: new Map(),
      proxySceneCache: new Map([["active-pass", {}]])
    };
    editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
      screenFlushes += 1;
      return true;
    };
    editor.textureAirbrushFlushCachedLayerStart = () => false;
    editor.textureAirbrushFlushLayerStartImmediately = () => false;
    editor.prewarmTextureAirbrushLayerResetStroke = () => {
      throw new Error("warm reset layer stroke should not schedule reset prewarm");
    };

    assert.equal(editor.textureAirbrushQueueScreenStrokePayload({
      clientX: 30,
      clientY: 45,
      strokeStart: { clientX: 30, clientY: 45 },
      radiusPixels: 24,
      color: { r: 255, g: 255, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      spacing: 1,
      erase: false,
      layerMode: true,
      strokeReset: true
    }), true);

    assert.deepEqual(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("20:25"), [layerPass]);
    assert.equal(resetPrewarmFrames, 0);
    assert.equal(screenFlushes, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("warm reset layer airbrush keeps pointer-down non-blocking", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  let scheduled = 0;
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = { key: "active-pass", targetEntry };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame?.current === true;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushLiveProjectionFrameState = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    paintPassCache: new Map([["active-pass", layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushLayerTargetReadyForLiveReset = () => true;
  editor.flushTextureAirbrushScreenStroke = () => {
    throw new Error("warm layer reset should schedule paint instead of flushing inside pointer-down");
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload({
    clientX: 30,
    clientY: 45,
    strokeStart: { clientX: 30, clientY: 45 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: true
  }), true);

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.deepEqual(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("20:25"), [layerPass]);
});

test("fully warmed reset layer frame still schedules the first paint", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  let scheduled = 0;
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = { key: "active-pass", targetEntry };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame?.current === true;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushLiveProjectionFrameState = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    paintPassCacheSeeded: true,
    seedPaintPasses: true,
    paintPassCache: new Map([["active-pass", layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushLayerTargetReadyForLiveReset = () => true;
  editor.flushTextureAirbrushScreenStroke = () => {
    throw new Error("fully warmed layer reset should not flush from pointer-down");
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload({
    clientX: 30,
    clientY: 45,
    strokeStart: { clientX: 30, clientY: 45 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: true
  }), true);

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.deepEqual(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("20:25"), [layerPass]);
});

test("ready reset layer airbrush defers missing start probe seeding to the scheduled flush", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  let scheduled = 0;
  const frameOptions = [];
  const seeded = [];
  const material = { uuid: "active-ready-layer" };
  const record = { object: { material } };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const warmFrame = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    seedPaintPasses: false,
    paintPassCache: new Map(),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map()
  };
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLayerTargetReadyForLiveReset = (candidateMaterial) => {
    assert.equal(candidateMaterial || material, material);
    return true;
  };
  editor.textureAirbrushPaintableMaterials = () => [{ record, materialIndex: 2, material }];
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    frameOptions.push(options);
    editor.textureAirbrushLiveProjectionFrameState = warmFrame;
    return warmFrame;
  };
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushSeedProjectionFramePaintPass = (frame, candidateRecord, materialIndex, candidateMaterial, options) => {
    assert.equal(frame, warmFrame);
    assert.equal(candidateRecord, record);
    assert.equal(materialIndex, 2);
    assert.equal(candidateMaterial, material);
    const pass = {
      key: "active-ready-pass",
      record,
      materialIndex,
      material,
      targetEntry
    };
    frame.paintPassCache.set(pass.key, pass);
    frame.proxySceneCache.set(pass.key, {});
    frame.probePaintPassCache.set("20:25", [pass]);
    seeded.push(options);
    return pass;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.flushTextureAirbrushScreenStroke = () => {
    throw new Error("ready layer reset should not seed/render synchronously on pointer-down");
  };

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload({
    clientX: 30,
    clientY: 45,
    strokeStart: { clientX: 30, clientY: 45 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: true
  }), true);

  assert.deepEqual(frameOptions, []);
  assert.deepEqual(seeded, []);
  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
});

test("first layer move after a warm cached start keeps the partial pass fast path", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  const projected = [];
  let scheduled = 0;
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = { key: "active-pass", targetEntry };
  const warmFrame = {
    current: true,
    rect: { left: 10, top: 20, width: 200, height: 140 },
    paintPassCacheSeeded: false,
    seedPaintPasses: false,
    paintPassCache: new Map([["active-pass", layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameState = warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushLayerTargetReadyForLiveReset = () => false;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => warmFrame;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      reusePartialLayerPasses: options.reusePartialLayerPasses === true,
      firstX: options.strokeSegments[0]?.start.clientX,
      lastX: options.strokeSegments.at(-1)?.end.clientX
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload({
    clientX: 30,
    clientY: 45,
    strokeStart: { clientX: 30, clientY: 45 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: true
  }), true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.equal(scheduled, 1);

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload({
    clientX: 44,
    clientY: 45,
    strokeStart: { clientX: 30, clientY: 45 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true
  }), true);
  assert.equal(scheduled, 1);
  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 2);

  assert.deepEqual(projected, [{
    segments: 2,
    reusePartialLayerPasses: true,
    firstX: 30,
    lastX: 44
  }]);
});

test("cold reset layer airbrush stroke queues the start without a synchronous layer flush", () => {
  class LayerStartEditor {}
  installPaintToolMethods(LayerStartEditor, {});
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushLayerTargetReadyForLiveReset = () => false;
  editor.textureAirbrushFlushCachedLayerStart = (event) => {
    throw new Error(`reset layer stroke should stay non-blocking, got ${event?.clientX}`);
  };

  assert.equal(editor.paintTextureStrokeFromEvent({ clientX: 30, clientY: 45 }, { reset: true }), true);
  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].layerMode, true);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue[0].strokeStart, { clientX: 30, clientY: 45 });

  assert.equal(editor.paintTextureStrokeFromEvent({ clientX: 34, clientY: 45 }), true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
  assert.deepEqual({
    startX: editor.textureAirbrushScreenStrokeQueue[1].strokeStart.clientX,
    endX: editor.textureAirbrushScreenStrokeQueue[1].clientX
  }, {
    startX: 30,
    endX: 34
  });
});

test("cold reset layer airbrush schedules the first live flush instead of blocking pointer down", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  const originalWindow = globalThis.window;
  const frameCallbacks = [];
  const order = [];
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }
    };
    editor.activeTool = "airbrush";
    editor.model = {};
    editor.canvas = {};
    editor.texturePaintLayerModeActive = () => true;
    editor.textureBrushRadiusScreenPixels = () => 24;
    editor.textureAirbrushSpacingPercent = () => 1;
    editor.textureAirbrushOptionsWithPressure = (event, options) => options;
    editor.textureAirbrushOpacity = () => 0.42;
    editor.textureAirbrushHardness = () => 0.35;
    editor.textureAirbrushScatter = () => 0.35;
    editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
    editor.prewarmTextureAirbrushLayerResetStroke = () => {
      throw new Error("reset layer stroke should not block the first live flush on prewarm");
    };
    editor.textureAirbrushPrewarm = () => {
      throw new Error("reset layer stroke should not run broad prewarm before the first live flush");
    };
    editor.flushTextureAirbrushScreenStroke = (options) => {
      order.push({ type: "flush", options });
      return 1;
    };

    assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({ clientX: 30, clientY: 45 }, { reset: true }), true);
    assert.deepEqual(order, []);
    assert.equal(frameCallbacks.length, 1);
    assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("cold reset layer airbrush keeps the queued start for the scheduled live flush", () => {
  class LayerStartEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerStartEditor);
  const editor = new LayerStartEditor();
  let scheduled = 0;
  let immediateFlushes = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.flushTextureAirbrushScreenStroke = () => {
    immediateFlushes += 1;
    editor.textureAirbrushScreenStrokeQueue = [];
    return 0;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({ clientX: 30, clientY: 45 }, { reset: true }), true);
  assert.equal(immediateFlushes, 0);
  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue[0].strokeStart, { clientX: 30, clientY: 45 });
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].strokeReset, true);
});

test("airbrush high spacing queues stamps along fast pointer movement before flushing", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  const projected = [];
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPixels = () => 5;
  editor.textureAirbrushSpacingPercent = () => 125;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => true;
  editor.drawTextureAirbrushScreenStrokePreview = () => {
    throw new Error("airbrush should not draw a fake preview before texture paint");
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      segments: options.strokeSegments.map((segment) => ({
        startX: Math.round(segment.start.clientX),
        startY: Math.round(segment.start.clientY),
        endX: Math.round(segment.end.clientX),
        endY: Math.round(segment.end.clientY)
      }))
    });
    return 1;
  };

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0 }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({ clientX: 12, clientY: 0 });

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 3);
  assert.deepEqual(projected, []);

  editor.flushTextureAirbrushScreenStroke();

  assert.deepEqual(projected, [
    {
      x: 10,
      y: 0,
      segments: [
        { startX: 0, startY: 0, endX: 0, endY: 0 },
        { startX: 5, startY: 0, endX: 5, endY: 0 },
        { startX: 10, startY: 0, endX: 10, endY: 0 }
      ]
    }
  ]);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
  assert.deepEqual(editor.texturePaintStrokePoint, { clientX: 12, clientY: 0 });
});

test("airbrush low spacing queues continuous smooth stroke segments before flushing", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  const projected = [];
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPixels = () => 0.2;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => true;
  editor.drawTextureAirbrushScreenStrokePreview = () => {
    throw new Error("airbrush should not draw a fake preview before texture paint");
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: Math.round(event.clientX),
      spacing: options.spacing,
      segments: options.strokeSegments.map((segment) => ({
        startX: Math.round(segment.start.clientX),
        endX: Math.round(segment.end.clientX)
      }))
    });
    return 1;
  };

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0 }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({ clientX: 12, clientY: 0 });

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
  assert.deepEqual(projected, []);

  editor.flushTextureAirbrushScreenStroke();

  assert.deepEqual(projected, [
    {
      x: 12,
      spacing: 1,
      segments: [
        { startX: 0, endX: 0 },
        { startX: 0, endX: 12 }
      ]
    }
  ]);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
});
