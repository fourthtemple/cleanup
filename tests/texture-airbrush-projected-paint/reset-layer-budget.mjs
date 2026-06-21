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

test("camera-cold warmed layer reset uses the background-style first-frame budget", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const frameOptions = [];
  const seededPasses = [];
  const material = { uuid: "camera-cold-active-layer" };
  const record = { object: { material } };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const lightweightFrame = {
    rect: { left: 0, top: 0, width: 100, height: 100 },
    seedPaintPasses: false,
    paintPassCache: new Map(),
    proxySceneCache: new Map(),
    probePaintPassCache: new Map()
  };
  editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
  editor.textureAirbrushLayerTargetReadyForLiveReset = () => true;
  editor.textureAirbrushLayerPrewarmNeeded = () => {
    throw new Error("ready layer reset should not scan broad prewarm state before painting");
  };
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [{ record, materialIndex: 0, material }];
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushSeedProjectionFramePaintPass = (frame, candidateRecord, materialIndex, candidateMaterial, options) => {
    assert.equal(frame, lightweightFrame);
    assert.equal(candidateRecord, record);
    assert.equal(materialIndex, 0);
    assert.equal(candidateMaterial, material);
    assert.equal(options.seedLayerProxy, true);
    assert.equal(options.seedProbe, true);
    const pass = {
      key: "active-layer-pass",
      record,
      materialIndex,
      material,
      targetEntry
    };
    frame.paintPassCache.set(pass.key, pass);
    frame.proxySceneCache.set(pass.key, {});
    frame.probePaintPassCache.set("0:0", [pass]);
    seededPasses.push(options);
    return pass;
  };
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    frameOptions.push(options);
    return lightweightFrame;
  };
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      firstX: options.strokeSegments[0]?.start.clientX,
      lastX: options.strokeSegments.at(-1)?.end.clientX,
      reusePartialLayerPasses: options.reusePartialLayerPasses
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 32 }, (_, index) => ({
    clientX: index + 1,
    clientY: 0,
    strokeStart: { clientX: index, clientY: 0 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: index === 0
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 32);
  assert.equal(seededPasses.length, 1);
  assert.deepEqual(frameOptions, [{ seedLayerProxies: false, seedPaintPasses: false }]);
  assert.deepEqual(projected, [{
    segments: 24,
    firstX: 0,
    lastX: 24,
    reusePartialLayerPasses: true
  }, {
    segments: 8,
    firstX: 24,
    lastX: 32,
    reusePartialLayerPasses: true
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
});

test("paint-ready layer reset prewarms display before the fast budget", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  let displayReady = false, prewarmCalls = 0;
  const material = { uuid: "paint-ready-layer" };
  const record = { object: { material } };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: true,
    target: { texture: {} }
  };
  const frame = {
    rect: { left: 0, top: 0, width: 100, height: 100 },
    seedPaintPasses: false,
    paintPassCache: new Map(),
    proxySceneCache: new Map(),
    probePaintPassCache: new Map()
  };
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [{ record, materialIndex: 0, material }];
  editor.textureAirbrushLayerPaintTargetReadyForLiveReset = (candidateMaterial) => candidateMaterial === material;
  editor.textureAirbrushLayerTargetReadyForLiveReset = (candidateMaterial) => candidateMaterial === material && displayReady;
  editor.prewarmTextureAirbrushLayerResetStroke = (event, candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    assert.ok(Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY));
    prewarmCalls += 1; displayReady = true;
    return true;
  };
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushSeedProjectionFramePaintPass = (candidateFrame, candidateRecord, materialIndex, candidateMaterial, options) => {
    assert.equal(candidateFrame, frame);
    assert.equal(candidateRecord, record);
    assert.equal(materialIndex, 0);
    assert.equal(candidateMaterial, material);
    assert.equal(options.seedLayerProxy, true);
    const pass = { key: "paint-ready-pass", record, materialIndex, material, targetEntry };
    frame.paintPassCache.set(pass.key, pass);
    frame.proxySceneCache.set(pass.key, {});
    frame.probePaintPassCache.set("0:0", [pass]);
    return pass;
  };
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => frame;
  editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.length);
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};
  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 32 }, (_, index) => ({
    clientX: index + 1,
    clientY: 0,
    strokeStart: { clientX: index, clientY: 0 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: index === 0
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 32);
  assert.equal(prewarmCalls, 1);
  assert.deepEqual(projected, [24, 8]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
});

test("warmed cursor-hit layer reset seeds the cursor material before first paint", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const activeMaterial = { uuid: "previous-active-layer" };
  const cursorMaterial = { uuid: "cursor-hit-layer" };
  const cursorRecord = { object: { material: cursorMaterial } };
  const cursorTargetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const warmFrame = {
    rect: { left: 0, top: 0, width: 100, height: 100 },
    seedPaintPasses: false,
    paintPassCache: new Map(),
    proxySceneCache: new Map(),
    probePaintPassCache: new Map()
  };
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPreferredLayerMaterial = (material = null) => material || cursorMaterial;
  editor.textureAirbrushLayerTargetReadyForLiveReset = (material = null) => (
    editor.textureAirbrushPreferredLayerMaterial(material) === cursorMaterial
  );
  editor.textureAirbrushPaintableMaterials = () => [
    { record: { object: { material: activeMaterial } }, materialIndex: 0, material: activeMaterial },
    { record: cursorRecord, materialIndex: 3, material: cursorMaterial }
  ];
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === cursorTargetEntry;
  editor.textureAirbrushSeedProjectionFramePaintPass = (frame, record, materialIndex, material, options) => {
    assert.equal(frame, warmFrame);
    assert.equal(record, cursorRecord);
    assert.equal(materialIndex, 3);
    assert.equal(material, cursorMaterial);
    assert.equal(options.seedLayerProxy, true);
    const pass = {
      key: "cursor-hit-pass",
      record,
      materialIndex,
      material,
      targetEntry: cursorTargetEntry
    };
    frame.paintPassCache.set(pass.key, pass);
    frame.proxySceneCache.set(pass.key, {});
    frame.probePaintPassCache.set("0:0", [pass]);
    return pass;
  };
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.textureAirbrushGpuLayerTargetForMaterial = (material) => (
    material === cursorMaterial ? cursorTargetEntry : null
  );
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      firstX: options.strokeSegments[0]?.start.clientX,
      lastX: options.strokeSegments.at(-1)?.end.clientX,
      reusePartialLayerPasses: options.reusePartialLayerPasses
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 32 }, (_, index) => ({
    clientX: index + 1,
    clientY: 0,
    strokeStart: { clientX: index, clientY: 0 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: index === 0
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 32);
  assert.deepEqual(projected, [{
    segments: 24,
    firstX: 0,
    lastX: 24,
    reusePartialLayerPasses: true
  }, {
    segments: 8,
    firstX: 24,
    lastX: 32,
    reusePartialLayerPasses: true
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
});

test("painted layer reset ignores stale CPU-empty flags when choosing the first-flush budget", () => {
  const runPaintedLayerReset = (snapshotWarm) => {
    class LayerEditor {}
    installTextureAirbrushScreenStrokeMethods(LayerEditor);
    const editor = new LayerEditor();
    const projected = [];
    const material = { uuid: `painted-stale-empty-${snapshotWarm ? "warm" : "cold"}` };
    const record = { object: { material } };
    const layer = {
      id: "paint-1",
      isEmpty: true
    };
    const targetEntry = {
      layerMode: true,
      layer,
      emptyTransparent: true,
      paintRevision: 4,
      target: { texture: {} }
    };
    layer.gpuTarget = targetEntry;
    const pass = {
      key: "painted-layer-pass",
      record,
      materialIndex: 0,
      material,
      targetEntry
    };
    const frame = {
      rect: { left: 0, top: 0, width: 100, height: 100 },
      paintPassCacheSeeded: true,
      paintPassCache: new Map([[pass.key, pass]]),
      proxySceneCache: new Map([[pass.key, {}]]),
      probePaintPassCache: new Map()
    };
    editor.activeTool = "airbrush";
    editor.texturePaintActiveMaterial = material;
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLiveProjectionFrameState = frame;
    editor.textureAirbrushPaintableMaterials = () => [{ record, materialIndex: 0, material }];
    editor.textureAirbrushLiveProjectionFrameCurrent = (candidateFrame) => candidateFrame === frame;
    editor.textureAirbrushLayerTargetReadyForLiveReset = () => snapshotWarm;
    editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => snapshotWarm && candidate === targetEntry;
    editor.textureBrushRadiusScreenPixels = () => 24;
    editor.textureAirbrushSpacingPercent = () => 1;
    editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
    editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
    editor.textureAirbrushLiveProjectionFrame = () => frame;
    editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
    editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
      projected.push(options.strokeSegments.length);
      return options.strokeSegments.length;
    };
    editor.flushTexturePaintDeferredLayerComposites = () => 0;
    editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
    editor.clearTextureAirbrushScreenLayer = () => {};
    editor.setStatus = () => {};
    editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 32 }, (_, index) => ({
      clientX: index + 1,
      clientY: 0,
      strokeStart: { clientX: index, clientY: 0 },
      radiusPixels: 24,
      color: { r: 255, g: 255, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      spacing: 1,
      erase: false,
      layerMode: true,
      strokeReset: index === 0
    }));
    const changed = editor.flushTextureAirbrushScreenStroke({ live: true });
    return {
      changed,
      projected,
      pending: editor.textureAirbrushPendingScreenStrokeBatches?.length || 0
    };
  };

  assert.deepEqual(runPaintedLayerReset(false), {
    changed: 8,
    projected: [8],
    pending: 3
  });
  assert.deepEqual(runPaintedLayerReset(true), {
    changed: 32,
    projected: [24, 8],
    pending: 0
  });
});

test("cold selected layer reset paints before active-pass prewarm", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const material = { uuid: "cold-selected-layer" };
  const record = { object: { material } };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [{ record, materialIndex: 0, material }];
  editor.textureAirbrushLayerTargetReadyForLiveReset = () => false;
  editor.textureAirbrushLayerPrewarmNeeded = () => {
    throw new Error("cold selected reset should not scan broad layer prewarm state before painting");
  };
  editor.prewarmTextureAirbrushLayerResetStroke = () => {
    throw new Error("cold selected reset should paint before active-layer prewarm");
  };
  editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => ({});
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      firstX: options.strokeSegments[0]?.start.clientX,
      lastX: options.strokeSegments.at(-1)?.end.clientX,
      reusePartialLayerPasses: options.reusePartialLayerPasses
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 32 }, (_, index) => ({
    clientX: index + 1,
    clientY: 0,
    strokeStart: { clientX: index, clientY: 0 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: index === 0
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 8);
  assert.deepEqual(projected, [{
    segments: 8,
    firstX: 0,
    lastX: 8,
    reusePartialLayerPasses: undefined
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 3);
});

test("cold selected layer reset prewarm failure keeps the conservative first-frame budget", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const material = { uuid: "cold-selected-layer-fail" };
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [];
  editor.textureAirbrushLayerTargetReadyForLiveReset = () => false;
  editor.prewarmTextureAirbrushLayerResetStroke = () => false;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => ({});
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      firstX: options.strokeSegments[0]?.start.clientX,
      lastX: options.strokeSegments.at(-1)?.end.clientX
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 32 }, (_, index) => ({
    clientX: index + 1,
    clientY: 0,
    strokeStart: { clientX: index, clientY: 0 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: index === 0
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 8);
  assert.deepEqual(projected, [{
    segments: 8,
    firstX: 0,
    lastX: 8
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 3);
});

test("warmed broad layer GPU live flush renders all cached passes like background paint", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const frameOptions = [];
  const targetEntries = [0, 1].map((index) => ({
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {}, name: `target-${index}` }
  }));
  const warmFrame = {
    paintPassCacheSeeded: true,
    seedPaintPasses: true,
    paintPassCache: new Map(targetEntries.map((targetEntry, index) => [
      `pass-${index}`,
      {
        key: `pass-${index}`,
        targetEntry
      }
    ])),
    proxySceneCache: new Map([
      ["pass-0", {}],
      ["pass-1", {}]
    ])
  };
  editor.textureAirbrushLiveProjectionFrameState = warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => targetEntries.includes(candidate);
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    frameOptions.push(options);
    return warmFrame;
  };
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntries[0];
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      renderAllCachedPasses: options.renderAllCachedPasses,
      deferLayerComposite: options.deferLayerComposite,
      gpu: options.gpu
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 12,
    clientY: 10,
    strokeStart: { clientX: 10, clientY: 10 },
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
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.deepEqual(frameOptions, [{ seedLayerProxies: false, seedPaintPasses: false }]);
  assert.deepEqual(projected, [{
    renderAllCachedPasses: true,
    deferLayerComposite: true,
    gpu: true
  }]);
});

test("exact-probe warmed reset layer GPU live flush uses the background-style budget", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  let scheduled = 0;
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const pass = {
    key: "active-pass",
    targetEntry
  };
  const warmFrame = {
    seedPaintPasses: false,
    rect: { left: 0, top: 0, width: 100, height: 100 },
    paintPassCache: new Map([["active-pass", pass]]),
    probePaintPassCache: new Map([["0:0", [pass]]]),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  editor.textureAirbrushLiveProjectionFrameState = warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => warmFrame;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
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

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 72 }, (_, index) => ({
    clientX: index + 1,
    clientY: 0,
    strokeStart: { clientX: index, clientY: 0 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: index === 0
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 48);
  assert.deepEqual(projected, [{
    segments: 24,
    firstX: 0,
    lastX: 24
  }, {
    segments: 24,
    firstX: 24,
    lastX: 48
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 1);
  assert.equal(scheduled, 1);
});

test("partially warmed broad reset layer frame keeps the conservative first chunk", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const warmTargetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const coldTargetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const warmFrame = {
    paintPassCacheSeeded: true,
    seedPaintPasses: true,
    paintPassCache: new Map([[
      "warm-pass",
      {
        key: "warm-pass",
        targetEntry: warmTargetEntry
      }
    ], [
      "cold-pass",
      {
        key: "cold-pass",
        targetEntry: coldTargetEntry
      }
    ]]),
    proxySceneCache: new Map([["warm-pass", {}]])
  };
  editor.textureAirbrushLiveProjectionFrameState = warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === warmTargetEntry;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => warmFrame;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => warmTargetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.length);
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 32 }, (_, index) => ({
    clientX: index + 1,
    clientY: 0,
    strokeStart: { clientX: index, clientY: 0 },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true,
    strokeReset: index === 0
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 8);
  assert.deepEqual(projected, [8]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 3);
});

test("low spacing layer pressure-radius live flush keeps one GPU vector pass", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  let deferredCompositeFlushes = 0;
  editor.textureBrushRadiusScreenPixels = () => 28;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => ({});
  editor.textureAirbrushGpuLayerTargetForMaterial = () => ({});
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      radiusPixels: options.radiusPixels,
      segmentRadii: options.strokeSegments.map((segment) => segment.radiusPixels),
      deferLayerComposite: options.deferLayerComposite,
      gpu: options.gpu
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => {
    deferredCompositeFlushes += 1;
    return 1;
  };
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = [5, 9, 14, 18, 21].map((radiusPixels, index) => ({
    clientX: (index + 1) * 10,
    clientY: Math.sin(index / 2) * 8,
    strokeStart: {
      clientX: index * 10,
      clientY: Math.sin(Math.max(0, index - 1) / 2) * 8
    },
    radiusPixels,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    pressureRadius: true,
    erase: false,
    layerMode: true
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 5);
  assert.deepEqual(projected, [{
    radiusPixels: 21,
    segmentRadii: [5, 9, 14, 18, 21],
    deferLayerComposite: true,
    gpu: true
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
  assert.equal(deferredCompositeFlushes, 0);
  editor.finishTextureAirbrushScreenStrokeFlush();
  assert.equal(deferredCompositeFlushes, 1);
});

test("stale queued layer airbrush strokes are skipped after layer mutations", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  let projectedCalls = 0;
  let clearedPreview = 0;
  let resolvedWaiters = 0;
  editor.texturePaintLayerMutationSerial = 2;
  editor.clearTextureAirbrushScreenLayer = () => {
    clearedPreview += 1;
  };
  editor.resolveTextureAirbrushScreenStrokeFlushWaiters = () => {
    resolvedWaiters += 1;
  };
  editor.textureAirbrushProjectedMeshFromEvent = () => {
    projectedCalls += 1;
    return 4;
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 12,
    clientY: 10,
    strokeStart: { clientX: 10, clientY: 10 },
    radiusPixels: 8,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    erase: false,
    layerMode: true,
    layerMutationSerial: 1
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 0);
  assert.equal(projectedCalls, 0);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue, []);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches, []);
  assert.equal(clearedPreview, 1);
  assert.equal(resolvedWaiters, 1);
});

test("layer eraser screen flush uses the CPU layer path", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const statuses = [];
  let receivedOptions = null;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushResolveBackend = () => {
    throw new Error("layer flush should not resolve a GPU backend");
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    receivedOptions = options;
    return 7;
  };
  editor.setStatus = (message) => {
    statuses.push(message);
  };

  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 12,
    clientY: 10,
    strokeStart: { clientX: 10, clientY: 10 },
    radiusPixels: 8,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    erase: true,
    layerMode: true
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 7);
  assert.equal(receivedOptions.gpu, false);
  assert.equal(receivedOptions.erase, true);
  assert.equal(receivedOptions.resolvedBackend.backend, "cpu");
  assert.deepEqual(statuses, ["Erased 7 projected pixels"]);
});

test("CPU layer stroke samples stay dense enough for a continuous line", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  const stroke = textureAirbrushScreenStrokeFromEvent({ clientX: 40, clientY: 10 }, rect, {
    strokeSegments: [{
      start: { clientX: 0, clientY: 10 },
      end: { clientX: 40, clientY: 10 }
    }]
  });
  const samples = textureAirbrushPaintSamplePointsFromStroke(stroke, 8, { spacing: 1 });

  assert.equal(samples[0].x, 0);
  assert.equal(samples.at(-1).x, 40);
  assert.equal(samples.length > 10, true);
  for (let index = 1; index < samples.length; index += 1) {
    assert.equal(samples[index].x - samples[index - 1].x <= 3, true);
  }
});

test("CPU layer projected paint uses each stroke sample position", () => {
  const editor = new TestEditor();
  const material = { uuid: "material-layer-stroke", needsUpdate: false };
  const recordObject = {
    updateMatrixWorld() {}
  };
  const record = {
    object: recordObject
  };
  const imageData = {
    width: 4,
    height: 4,
    data: new Uint8ClampedArray(4 * 4 * 4)
  };
  const editable = {
    canvas: { width: 4, height: 4 },
    texture: {},
    context: {
      getImageData() {
        return imageData;
      },
      putImageData() {}
    }
  };
  const paintEvents = [];
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {
    updateMatrixWorld() {}
  };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.captureTexturePaintCanvasUndoTarget = () => {};
  editor.texturePaintCommitEditable = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.updateClonePaintPreviews = () => {};
  editor.setStatus = () => {};
  editor.textureAirbrushUvBrushOnFace = (candidateRecord, hit, event, options) => {
    assert.equal(candidateRecord, record);
    assert.equal(hit.object, recordObject);
    paintEvents.push({ x: event.clientX, y: event.clientY });
    options.paintState.changed = (options.paintState.changed || 0) + 1;
    return 1;
  };
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      assert.deepEqual(objects, [recordObject]);
      return [{
        object: recordObject,
        uv: { x: 0.5, y: 0.5 },
        face: { a: 0, b: 1, c: 2, materialIndex: 0 },
        distance: 1
      }];
    }
  };

  const changed = editor.textureAirbrushProjectedMeshFromEvent({ clientX: 40, clientY: 10 }, {
    gpu: false,
    resolvedBackend: { backend: "cpu", webGpuStatus: "layer-paint" },
    cpuStrokeSamples: true,
    strokeSegments: [{
      start: { clientX: 0, clientY: 10 },
      end: { clientX: 40, clientY: 10 }
    }],
    radiusPixels: 8,
    spacing: 1,
    pressureApplied: true
  });

  assert.equal(changed, paintEvents.length);
  assert.equal(paintEvents.length > 10, true);
  assert.equal(paintEvents.some((event) => event.x < 10), true);
  assert.equal(paintEvents.some((event) => event.x > 30), true);
  assert.equal(new Set(paintEvents.map((event) => Math.round(event.x))).size > 10, true);
});
