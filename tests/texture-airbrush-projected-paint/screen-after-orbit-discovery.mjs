import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../node_modules/three/build/three.module.js";
import { installSceneAndControlMethods } from "../../src/weight-editor/scene-and-controls.js";
import { installTextureAirbrushNeighborPaintMethods } from "../../src/weight-editor/airbrush/neighbor.js";
import { installTextureAirbrushScreenStrokeMethods } from "../../src/weight-editor/airbrush/screen-strokes.js";

function installSceneMethodsForTest(EditorClass) {
  installSceneAndControlMethods(EditorClass, {
    THREE,
    EDIT_ONLY_TOOLS: new Set(),
    finitePoseValue(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    }
  });
}

function vector(x = 0, y = 0, z = 0) {
  return {
    x,
    y,
    z,
    toArray() {
      return [this.x, this.y, this.z];
    }
  };
}

test("live layer stroke asks partial projection frames to discover missing paint passes", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);

  const editor = new LayerEditor();
  const materialA = {};
  const materialB = {};
  const record = {
    object: { material: [materialA, materialB] },
    geometry: { attributes: { uv: {} } }
  };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = {
    key: "active-pass",
    record,
    material: materialA,
    materialIndex: 0,
    targetEntry
  };
  const warmFrame = {
    rect: { left: 10, top: 20, width: 200, height: 140 },
    paintRecords: [record],
    seedPaintPasses: false,
    paintPassCacheSeeded: false,
    paintPassCache: new Map([["active-pass", layerPass]]),
    probePaintPassCache: new Map([["20:25", [layerPass]]]),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  const projected = [];

  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameState = warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.textureAirbrushCachedLayerStartProbeReady = () => true;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => warmFrame;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      reusePartialLayerPasses: options.reusePartialLayerPasses === true,
      renderAllCachedPasses: options.renderAllCachedPasses === true,
      discoverPartialLayerPasses: options.discoverPartialLayerPasses === true
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = [{
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
  }, {
    clientX: 90,
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
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 2);
  assert.deepEqual(projected, [{
    reusePartialLayerPasses: true,
    renderAllCachedPasses: true,
    discoverPartialLayerPasses: true
  }]);
});

test("live neighbor stroke forwards a connected surface seed through post-orbit projection", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const materialA = { uuid: "mat-a" };
  const materialB = { uuid: "mat-b" };
  const record = {
    object: {
      uuid: "mesh-a",
      material: [materialA, materialB]
    },
    geometry: {
      attributes: {
        position: { count: 6 },
        uv: {}
      },
      groups: [
        { start: 0, count: 3, materialIndex: 0 },
        { start: 3, count: 3, materialIndex: 1 }
      ]
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2, 3]),
      new Set([0, 2]),
      new Set([0, 1]),
      new Set([0, 4, 5]),
      new Set([3, 5]),
      new Set([3, 4])
    ]
  };
  const projectionFrame = { id: "fresh-after-orbit-frame" };
  const editor = new NeighborScreenEditor();
  const projected = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.clonePaintMaterialForHit = () => materialA;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => projectionFrame;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options = {}) => {
    projected.push({
      projectionFrame: options.projectionFrame,
      neighborPaintSeed: options.neighborPaintSeed,
      strokeSegments: options.strokeSegments?.length || 0,
      gpu: options.gpu === true
    });
    return options.strokeSegments?.length || 0;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);
  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 145,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, {
    strokeStart: { clientX: 80, clientY: 60 }
  }), true);

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 2);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].projectionFrame, projectionFrame);
  assert.equal(projected[0].gpu, true);
  assert.equal(projected[0].strokeSegments, 2);
  assert.equal(projected[0].neighborPaintSeed?.enabled, true);
  assert.equal(projected[0].neighborPaintSeed.record, record);
  assert.equal(projected[0].neighborPaintSeed.material, materialA);
  assert.equal(projected[0].neighborPaintSeed.materialIndex, 0);
  assert.deepEqual(
    [...projected[0].neighborPaintSeed.component].sort((left, right) => left - right),
    [0, 1, 2, 3, 4, 5]
  );
});

test("post-camera Neighbor flush forwards rewarm state into projection", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const projectionFrame = { id: "fresh-after-orbit-frame" };
  const neighborPaintSeed = { enabled: true, key: "visible-neighbor", component: new Set([0, 1, 2]) };
  const editor = new NeighborScreenEditor();
  const projected = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => projectionFrame;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options = {}) => {
    projected.push({
      projectionFrame: options.projectionFrame,
      neighborPaintSeed: options.neighborPaintSeed,
      neighborProjectionRewarmed: options.neighborProjectionRewarmed === true,
      postCameraProjectionRewarmed: options.postCameraProjectionRewarmed === true
    });
    return options.strokeSegments?.length || 0;
  };
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};
  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 118,
    clientY: 64,
    strokeStart: { clientX: 80, clientY: 60 },
    radiusPixels: 24,
    color: { r: 255, g: 180, b: 80 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    erase: false,
    layerMode: false,
    strokeReset: true,
    neighborPaintSeed,
    neighborPaintKey: "visible-neighbor",
    neighborProjectionRewarmed: true,
    postCameraProjectionRewarmed: true
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].projectionFrame, projectionFrame);
  assert.equal(projected[0].neighborPaintSeed, neighborPaintSeed);
  assert.equal(projected[0].neighborProjectionRewarmed, true);
  assert.equal(projected[0].postCameraProjectionRewarmed, true);
});

test("post-orbit Neighbor warm state persists across live flushes for the whole stroke", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const projectionFrame = { id: "fresh-after-orbit-frame" };
  const editor = new NeighborScreenEditor();
  const projected = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushNeighborProjectionDirty = true;
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushResetLiveProjectionFrame = () => true;
  editor.textureAirbrushPrewarm = () => true;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => projectionFrame;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options = {}) => {
    projected.push({
      neighborProjectionRewarmed: options.neighborProjectionRewarmed === true,
      postCameraProjectionRewarmed: options.postCameraProjectionRewarmed === true,
      strokeOpacityCap: options.strokeOpacityCap,
      strokeReset: options.strokeSegments?.[0]?.strokeReset === true,
      strokeSegments: options.strokeSegments?.length || 0
    });
    return options.strokeSegments?.length || 0;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);
  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 92,
    clientY: 66,
    pointerType: "pen",
    pressure: 0.8
  }, {
    strokeStart: { clientX: 80, clientY: 60 }
  }), true);
  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  editor.textureAirbrushEndPostCameraProjectionStroke();
  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 104,
    clientY: 70,
    pointerType: "pen",
    pressure: 0.8
  }, {
    strokeStart: { clientX: 92, clientY: 66 }
  }), true);
  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  assert.deepEqual(projected.map((entry) => ({
    neighborProjectionRewarmed: entry.neighborProjectionRewarmed,
    postCameraProjectionRewarmed: entry.postCameraProjectionRewarmed,
    strokeOpacityCap: entry.strokeOpacityCap,
    strokeSegments: entry.strokeSegments
  })), [
    {
      neighborProjectionRewarmed: true,
      postCameraProjectionRewarmed: true,
      strokeOpacityCap: false,
      strokeSegments: 1
    },
    {
      neighborProjectionRewarmed: true,
      postCameraProjectionRewarmed: true,
      strokeOpacityCap: false,
      strokeSegments: 1
    },
    {
      neighborProjectionRewarmed: false,
      postCameraProjectionRewarmed: false,
      strokeOpacityCap: undefined,
      strokeSegments: 1
    }
  ]);
});

test("cold Neighbor cache warm keeps normal stroke opacity cap", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const editor = new NeighborScreenEditor();
  const projected = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushNeighborProjectionDirty = false;
  editor.textureAirbrushNeighborProjectionFirstStrokeRewarm = false;
  editor.textureAirbrushLiveProjectionFrameState = null;
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
  editor.textureAirbrushResetLiveProjectionFrame = () => true;
  editor.textureAirbrushPrewarm = () => true;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => ({ id: "cold-warm-frame" });
  editor.textureAirbrushProjectedMeshFromEvent = (event, options = {}) => {
    projected.push({
      neighborProjectionRewarmed: options.neighborProjectionRewarmed === true,
      postCameraProjectionRewarmed: options.postCameraProjectionRewarmed === true,
      strokeOpacityCap: options.strokeOpacityCap
    });
    return options.strokeSegments?.length || 0;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);
  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  assert.deepEqual(projected, [{
    neighborProjectionRewarmed: true,
    postCameraProjectionRewarmed: true,
    strokeOpacityCap: undefined
  }]);
});

test("new Neighbor brush strokes use a full projection reset like the checkbox", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const editor = new NeighborScreenEditor();
  const resetCalls = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.texturePaintHitForEvent = () => null;
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    resetCalls.push(options);
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);

  editor.setTexturePaintNeighborMode(false, { status: false });
  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 84,
    clientY: 64,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);

  assert.deepEqual(resetCalls, [
    { keepCurrent: false },
    { keepCurrent: false },
    { keepCurrent: true }
  ]);
});

test("Neighbor brush reset rewarms the active layer projection after clearing orbit state", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const editor = new NeighborScreenEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushNeighborProjectionDirty = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.prewarmTextureAirbrushLayerResetStroke = (event) => {
    calls.push(["layer-rewarm", { clientX: event.clientX, clientY: event.clientY }]);
    return true;
  };
  editor.textureAirbrushPrewarm = (event, hit, options = {}) => {
    calls.push(["broad-rewarm", {
      dirty: editor.textureAirbrushNeighborProjectionDirty,
      options
    }]);
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);

  assert.deepEqual(calls, [
    ["reset", { keepCurrent: false }],
    ["layer-rewarm", { clientX: 80, clientY: 60 }],
    ["broad-rewarm", {
      dirty: true,
      options: {
        all: true,
        force: true,
        preserveLayerDisplay: true
      }
    }]
  ]);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, false);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, false);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).strokeReset, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborPaintSeed?.enabled, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborProjectionRewarmed, true);
});

test("Neighbor reset keeps post-camera first-stroke warm treatment after dirty flag was prewarmed clear", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const editor = new NeighborScreenEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushNeighborProjectionDirty = false;
  editor.textureAirbrushNeighborProjectionFirstStrokeRewarm = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.prewarmTextureAirbrushLayerResetStroke = (event) => {
    calls.push(["layer-rewarm", { clientX: event.clientX, clientY: event.clientY }]);
    return true;
  };
  editor.textureAirbrushPrewarm = (event, hit, options = {}) => {
    calls.push(["broad-rewarm", {
      marker: editor.textureAirbrushNeighborProjectionFirstStrokeRewarm,
      options
    }]);
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);

  assert.deepEqual(calls, [
    ["reset", { keepCurrent: false }],
    ["layer-rewarm", { clientX: 80, clientY: 60 }],
    ["broad-rewarm", {
      marker: true,
      options: {
        all: true,
        force: true,
        preserveLayerDisplay: true
      }
    }]
  ]);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, false);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, false);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborProjectionRewarmed, true);
});

test("Neighbor reset uses non-layer prewarm when layer mode has no active paint layer", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const editor = new NeighborScreenEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushNeighborProjectionDirty = true;
  editor.textureAirbrushNeighborProjectionFirstStrokeRewarm = true;
  editor.textureAirbrushLayerProjectionFirstStrokeRewarm = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushLiveProjectionFrameState = null;
  editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.prewarmTextureAirbrushLayerResetStroke = () => {
    throw new Error("No active paint layer should not take layer reset prewarm");
  };
  editor.textureAirbrushPrewarm = (event, hit, options = {}) => {
    calls.push(["broad-rewarm", options]);
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);

  assert.deepEqual(calls, [
    ["reset", { keepCurrent: false }],
    ["broad-rewarm", {
      all: true,
      force: true,
      preserveLayerDisplay: true
    }]
  ]);
  const payload = editor.textureAirbrushScreenStrokeQueue.at(-1);
  assert.equal(payload.layerMode, false);
  assert.equal(payload.neighborProjectionRewarmed, true);
  assert.equal(payload.postCameraProjectionRewarmed, true);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, false);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, false);
});

test("post-orbit Neighbor layer reset uses a full warmed projection frame on the first live pass", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = {
    key: "active-layer-pass",
    record,
    material,
    materialIndex: 0,
    targetEntry
  };
  const fullFrame = {
    rect: { left: 0, top: 0, width: 220, height: 160 },
    paintRecords: [record],
    seedPaintPasses: true,
    paintPassCacheSeeded: true,
    paintPassCache: new Map([[layerPass.key, layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[layerPass.key, {}]])
  };
  const editor = new NeighborScreenEditor();
  const frameOptions = [];
  const projected = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushNeighborProjectionDirty = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushResetLiveProjectionFrame = () => true;
  editor.prewarmTextureAirbrushLayerResetStroke = () => true;
  editor.textureAirbrushPrewarm = () => true;
  editor.textureAirbrushLayerPrewarmNeeded = (hit, options = {}) => options.all !== true;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = (options = {}) => {
    frameOptions.push(options);
    return fullFrame;
  };
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options = {}) => {
    projected.push({
      projectionFrame: options.projectionFrame,
      renderAllCachedPasses: options.renderAllCachedPasses === true,
      reusePartialLayerPasses: options.reusePartialLayerPasses === true,
      deferLayerComposite: options.deferLayerComposite === true,
      forceLayerDisplayComposite: options.forceLayerDisplayComposite === true,
      strokeSegments: options.strokeSegments?.length || 0
    });
    return options.strokeSegments?.length || 0;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborProjectionRewarmed, true);
  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.deepEqual(frameOptions, [{}]);
  assert.deepEqual(projected, [{
    projectionFrame: fullFrame,
    renderAllCachedPasses: true,
    reusePartialLayerPasses: true,
    deferLayerComposite: false,
    forceLayerDisplayComposite: true,
    strokeSegments: 1
  }]);
});

test("post-camera non-Neighbor layer reset uses a full warmed projection frame on the first live pass", () => {
  class LayerScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    }
  };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = {
    key: "active-layer-pass",
    record,
    material,
    materialIndex: 0,
    targetEntry
  };
  const fullFrame = {
    rect: { left: 0, top: 0, width: 220, height: 160 },
    paintRecords: [record],
    seedPaintPasses: true,
    paintPassCacheSeeded: true,
    paintPassCache: new Map([[layerPass.key, layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[layerPass.key, {}]])
  };
  const editor = new LayerScreenEditor();
  const prewarmCalls = [];
  const frameOptions = [];
  const projected = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = false;
  editor.textureAirbrushLayerProjectionFirstStrokeRewarm = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    prewarmCalls.push(["reset", options]);
    return true;
  };
  editor.textureAirbrushPrewarm = (event, hit, options = {}) => {
    prewarmCalls.push(["layer-post-camera-rewarm", options]);
    return true;
  };
  editor.textureAirbrushLayerPrewarmNeeded = (hit, options = {}) => options.all !== true;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = (options = {}) => {
    frameOptions.push(options);
    return fullFrame;
  };
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options = {}) => {
    projected.push({
      projectionFrame: options.projectionFrame,
      renderAllCachedPasses: options.renderAllCachedPasses === true,
      reusePartialLayerPasses: options.reusePartialLayerPasses === true,
      deferLayerComposite: options.deferLayerComposite === true,
      forceLayerDisplayComposite: options.forceLayerDisplayComposite === true,
      strokeSegments: options.strokeSegments?.length || 0
    });
    return options.strokeSegments?.length || 0;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);

  assert.deepEqual(prewarmCalls, [
    ["reset", { keepCurrent: true }],
    ["layer-post-camera-rewarm", {
      all: true,
      force: true,
      preserveLayerDisplay: true
    }]
  ]);
  assert.equal(editor.textureAirbrushLayerProjectionFirstStrokeRewarm, false);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).postCameraProjectionRewarmed, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborProjectionRewarmed, undefined);
  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.deepEqual(frameOptions, [{}]);
  assert.deepEqual(projected, [{
    projectionFrame: fullFrame,
    renderAllCachedPasses: true,
    reusePartialLayerPasses: true,
    deferLayerComposite: false,
    forceLayerDisplayComposite: true,
    strokeSegments: 1
  }]);
});

test("post-orbit Neighbor layer reset refreshes first-paint display without waiting for the delayed exact timer", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const layer = {
    id: "paint-1",
    isEmpty: true,
    gpuTarget: null
  };
  const material = {
    uuid: "mat-a",
    userData: {
      texturePaintLayerStack: {
        activeLayerId: layer.id,
        layers: [layer]
      }
    }
  };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    }
  };
  const targetEntry = {
    layerMode: true,
    layer,
    emptyTransparent: true,
    target: { texture: {} }
  };
  layer.gpuTarget = targetEntry;
  const layerPass = {
    key: "active-layer-pass",
    record,
    material,
    materialIndex: 0,
    targetEntry
  };
  const fullFrame = {
    rect: { left: 0, top: 0, width: 220, height: 160 },
    paintRecords: [record],
    seedPaintPasses: true,
    paintPassCacheSeeded: true,
    paintPassCache: new Map([[layerPass.key, layerPass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[layerPass.key, {}]])
  };
  const editor = new NeighborScreenEditor();
  let exactFlushes = 0;
  let normalDisplayRefreshes = 0;
  let delayedExactSchedules = 0;

  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushLayerPrewarmNeeded = (hit, options = {}) => options.all !== true;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => fullFrame;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushProjectedMeshFromEvent = () => {
    layer.isEmpty = false;
    targetEntry.emptyTransparent = false;
    targetEntry.paintRevision = 1;
    editor.texturePaintNeedsExactFirstPaintDisplayRefresh = true;
    return 1;
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = (options = {}) => {
    exactFlushes += 1;
    assert.equal(options.material, material);
    return 1;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = () => {
    normalDisplayRefreshes += 1;
    return true;
  };
  editor.scheduleTexturePaintExactFirstPaintDisplayRefresh = () => {
    delayedExactSchedules += 1;
    return true;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 80,
    clientY: 60,
    strokeStart: { clientX: 80, clientY: 60 },
    radiusPixels: 18,
    color: { r: 255, g: 180, b: 80 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    erase: false,
    layerMode: true,
    layerMutationSerial: 0,
    strokeReset: true,
    strokeStartedWithReset: true,
    neighborProjectionRewarmed: true
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);
  assert.equal(exactFlushes, 1);
  assert.equal(normalDisplayRefreshes, 0);
  assert.equal(delayedExactSchedules, 0);
  assert.equal(editor.texturePaintNeedsExactFirstPaintDisplayRefresh, false);
});

test("Neighbor camera changes force a fresh visible-surface rewarm for later rotations", () => {
  class NeighborCameraEditor {}
  installSceneMethodsForTest(NeighborCameraEditor);
  installTextureAirbrushNeighborPaintMethods(NeighborCameraEditor);

  const editor = new NeighborCameraEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushActiveNeighborPaintSeed = { enabled: true };
  editor.texturePaintLayerModeActive = () => true;
  editor.updateBrushCursorForLastPointer = () => {
    calls.push(["cursor"]);
    return true;
  };
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.textureAirbrushPrewarm = (event, hit, options = {}) => {
    calls.push(["prewarm", options]);
    return true;
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    calls.push(["schedule"]);
    return true;
  };
  editor.textureAirbrushLayerPrewarmNeeded = () => false;

  assert.equal(editor.prewarmTextureAirbrushAfterCameraChange(), true);
  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed, null);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, false);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, true);
  assert.deepEqual(calls, [
    ["cursor"],
    ["reset", { keepCurrent: false }],
    ["prewarm", {
      all: true,
      force: true,
      preserveLayerDisplay: true
    }]
  ]);
});

test("settled camera prewarm also splits active Neighbor paint before resetting projection", () => {
  class NeighborCameraEditor {}
  installSceneMethodsForTest(NeighborCameraEditor);
  installTextureAirbrushNeighborPaintMethods(NeighborCameraEditor);

  const editor = new NeighborCameraEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushActiveNeighborPaintSeed = { enabled: true };
  editor.texturePaintLayerModeActive = () => false;
  editor.textureAirbrushScreenStrokeHasPendingWork = () => true;
  editor.flushTextureAirbrushScreenStroke = (options = {}) => {
    calls.push(["flush", options]);
    return 1;
  };
  editor.updateBrushCursorForLastPointer = () => {
    calls.push(["cursor"]);
    return true;
  };
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.textureAirbrushPrewarm = (event, hit, options = {}) => {
    calls.push(["prewarm", options]);
    return true;
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    calls.push(["schedule"]);
    return true;
  };

  assert.equal(editor.prewarmTextureAirbrushAfterCameraChange(), true);
  assert.equal(editor.textureAirbrushForceNextScreenStrokeResetAfterCameraChange, true);
  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed, null);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, false);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, true);
  assert.deepEqual(calls, [
    ["flush", { live: true }],
    ["cursor"],
    ["reset", { keepCurrent: false }],
    ["prewarm", {
      all: true,
      force: true,
      preserveLayerDisplay: true
    }]
  ]);
});

test("Neighbor camera changes mark projection dirty even while orbit is active", () => {
  class NeighborCameraEditor {}
  installSceneMethodsForTest(NeighborCameraEditor);
  installTextureAirbrushNeighborPaintMethods(NeighborCameraEditor);

  const editor = new NeighborCameraEditor();
  const calls = [];

  editor.activeTool = "orbit";
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushActiveNeighborPaintSeed = { enabled: true };
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed, null);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, true);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, true);
  assert.equal(editor.textureAirbrushCameraPrewarmScheduled, false);
  assert.deepEqual(calls, [
    ["reset", {}]
  ]);
});

test("airbrush camera changes split an active stroke before resetting projection", () => {
  class NeighborCameraEditor {}
  installSceneMethodsForTest(NeighborCameraEditor);
  installTextureAirbrushNeighborPaintMethods(NeighborCameraEditor);

  const editor = new NeighborCameraEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushActiveNeighborPaintSeed = { enabled: true };
  editor.textureAirbrushScreenStrokeHasPendingWork = () => true;
  editor.flushTextureAirbrushScreenStroke = (options = {}) => {
    calls.push(["flush", options]);
    return 1;
  };
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.texturePaintLayerModeActive = () => false;
  editor.scheduleTextureAirbrushSettledCameraPrewarm = () => {
    calls.push(["schedule-settled"]);
    return true;
  };

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(editor.textureAirbrushForceNextScreenStrokeResetAfterCameraChange, true);
  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed, null);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, true);
  assert.equal(editor.textureAirbrushNeighborProjectionFirstStrokeRewarm, true);
  assert.deepEqual(calls, [
    ["flush", { live: true }],
    ["reset", {}],
    ["schedule-settled"]
  ]);
});

test("tiny orbit settle samples during active airbrush do not split the first post-orbit stroke", () => {
  class NeighborCameraEditor {}
  installSceneMethodsForTest(NeighborCameraEditor);

  const editor = new NeighborCameraEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.camera = {
    position: vector(100.03, 20, -50.04),
    up: vector(0, 1, 0),
    zoom: 1,
    fov: 38
  };
  editor.controls = {
    target: vector(0, 0, 0)
  };
  editor.textureAirbrushLastPaintCameraSplitSnapshot = {
    position: [100, 20, -50],
    target: [0, 0, 0],
    up: [0, 1, 0],
    zoom: 1,
    fov: 38
  };
  editor.textureAirbrushScreenStrokeHasPendingWork = () => true;
  editor.texturePaintLayerModeActive = () => false;
  editor.flushTextureAirbrushScreenStroke = (options = {}) => {
    calls.push(["flush", options]);
    return 1;
  };
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.scheduleTextureAirbrushSettledCameraPrewarm = () => {
    calls.push(["schedule-settled"]);
    return true;
  };

  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // This only suppresses repeated sub-pixel camera-settle splits. It must not
  // broaden the brush beyond the current visible camera-facing surface.
  assert.equal(editor.textureAirbrushCameraChanged(), false);
  assert.equal(editor.textureAirbrushForceNextScreenStrokeResetAfterCameraChange, undefined);
  assert.deepEqual(calls, []);
});

test("meaningful camera motion during active airbrush still splits and rewarms visible projection", () => {
  class NeighborCameraEditor {}
  installSceneMethodsForTest(NeighborCameraEditor);

  const editor = new NeighborCameraEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.camera = {
    position: vector(104, 20, -50),
    up: vector(0, 1, 0),
    zoom: 1,
    fov: 38
  };
  editor.controls = {
    target: vector(0, 0, 0)
  };
  editor.textureAirbrushLastPaintCameraSplitSnapshot = {
    position: [100, 20, -50],
    target: [0, 0, 0],
    up: [0, 1, 0],
    zoom: 1,
    fov: 38
  };
  editor.textureAirbrushScreenStrokeHasPendingWork = () => true;
  editor.texturePaintLayerModeActive = () => false;
  editor.flushTextureAirbrushScreenStroke = (options = {}) => {
    calls.push(["flush", options]);
    return 1;
  };
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.scheduleTextureAirbrushSettledCameraPrewarm = () => {
    calls.push(["schedule-settled"]);
    return true;
  };

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(editor.textureAirbrushForceNextScreenStrokeResetAfterCameraChange, true);
  assert.deepEqual(editor.textureAirbrushLastPaintCameraSplitSnapshot.position, [104, 20, -50]);
  assert.deepEqual(calls, [
    ["flush", { live: true }],
    ["reset", {}],
    ["schedule-settled"]
  ]);
});

test("first Neighbor sample after an in-stroke camera change is forced through reset rewarm", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const editor = new NeighborScreenEditor();
  const calls = [];

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.texturePaintNeighborEnabled = true;
  editor.textureAirbrushNeighborProjectionDirty = true;
  editor.textureAirbrushForceNextScreenStrokeResetAfterCameraChange = true;
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushResetLiveProjectionFrame = (options = {}) => {
    calls.push(["reset", options]);
    return true;
  };
  editor.textureAirbrushPrewarm = (event, hit, options = {}) => {
    calls.push(["prewarm", options]);
    return true;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    calls.push(["schedule-flush"]);
    return true;
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 70,
    clientY: 60,
    strokeStart: { clientX: 50, clientY: 50 },
    radiusPixels: 18,
    color: { r: 255, g: 180, b: 80 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    erase: false,
    layerMode: false
  }];

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 72,
    clientY: 62,
    pointerType: "pen",
    pressure: 0.8
  }, { strokeStart: { clientX: 70, clientY: 60 } }), true);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
  const resetPayload = editor.textureAirbrushScreenStrokeQueue.at(-1);
  assert.equal(resetPayload.strokeReset, true);
  assert.equal(resetPayload.strokeStartedWithReset, undefined);
  assert.equal(resetPayload.neighborProjectionRewarmed, true);
  assert.equal(resetPayload.postCameraProjectionRewarmed, true);
  assert.equal(resetPayload.neighborPaintSeed?.enabled, true);
  assert.equal(editor.textureAirbrushNeighborProjectionDirty, false);
  assert.equal(editor.textureAirbrushForceNextScreenStrokeResetAfterCameraChange, false);
  assert.deepEqual(calls, [
    ["reset", { keepCurrent: false }],
    ["prewarm", {
      all: true,
      force: true,
      preserveLayerDisplay: true
    }],
    ["schedule-flush"]
  ]);
});

test("Neighbor continuous strokes attach a seed from the first valid in-stroke hit", () => {
  class NeighborScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborScreenEditor);
  installTextureAirbrushScreenStrokeMethods(NeighborScreenEditor);

  const material = { uuid: "mat-a" };
  const record = {
    object: {
      uuid: "mesh-a",
      material
    },
    geometry: {
      attributes: {
        position: { count: 3 },
        uv: {}
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1])
    ]
  };
  const editor = new NeighborScreenEditor();
  let hitCalls = 0;

  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.texturePaintNeighborEnabled = true;
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 180, b: 80 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => {
    hitCalls += 1;
    if (hitCalls === 1) {
      return null;
    }
    return {
      record,
      hit: {
        face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
      }
    };
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => true;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 80,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, { reset: true }), true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborPaintSeed, undefined);

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 112,
    clientY: 60,
    pointerType: "pen",
    pressure: 0.8
  }, {
    strokeStart: { clientX: 80, clientY: 60 }
  }), true);

  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed?.enabled, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].neighborPaintSeed?.enabled, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborPaintSeed?.enabled, true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.at(-1).neighborPaintKey, editor.textureAirbrushScreenStrokeQueue[0].neighborPaintKey);
});
