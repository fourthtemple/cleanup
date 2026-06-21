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

test("first paint on an empty queued layer refreshes layer display after flush", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const layer = {
    id: "paint-1",
    isEmpty: true,
    gpuTarget: { emptyTransparent: true }
  };
  const material = {
    userData: {
      texturePaintLayerStack: {
        activeLayerId: layer.id,
        layers: [layer]
      }
    }
  };
  let displayRefreshes = 0;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    layerMode: true,
    erase: false,
    strokeSegments: [{
      start: { clientX: 10, clientY: 10 },
      end: { clientX: 18, clientY: 10 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1
  }];
  editor.textureAirbrushScreenStrokeQueue = [];
  editor.textureAirbrushProjectedMeshFromEvent = () => {
    layer.isEmpty = false;
    layer.gpuTarget.emptyTransparent = false;
    return 7;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = (candidateMaterial, options = {}) => {
    displayRefreshes += 1;
    assert.equal(candidateMaterial, material);
    assert.equal(options.changedLayer, layer);
    assert.equal(options.live, undefined);
    assert.equal(layer.isEmpty, false);
    return true;
  };
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.resolveTextureAirbrushScreenStrokeFlushWaiters = () => {};
  editor.scheduleTexturePaintExactFirstPaintDisplayRefresh = () => true;
  editor.setStatus = () => {};

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 7);
  assert.equal(displayRefreshes, 1);
});

test("layer flush refreshes the material touched by projection", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const staleLayer = { id: "stale-layer", isEmpty: false };
  const touchedLayer = { id: "touched-layer", isEmpty: true, gpuTarget: { emptyTransparent: true } };
  const staleMaterial = {
    name: "stale",
    userData: {
      texturePaintLayerStack: {
        activeLayerId: staleLayer.id,
        layers: [staleLayer]
      }
    }
  };
  const touchedMaterial = {
    name: "touched",
    userData: {
      texturePaintLayerStack: {
        activeLayerId: touchedLayer.id,
        layers: [touchedLayer]
      }
    }
  };
  const displayRefreshes = [];
  editor.texturePaintActiveMaterial = staleMaterial;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    layerMode: true,
    erase: false,
    strokeSegments: [{
      start: { clientX: 10, clientY: 10 },
      end: { clientX: 18, clientY: 10 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1
  }];
  editor.textureAirbrushScreenStrokeQueue = [];
  editor.textureAirbrushProjectedMeshFromEvent = () => {
    touchedLayer.isEmpty = false;
    touchedLayer.gpuTarget.emptyTransparent = false;
    editor.texturePaintActiveMaterial = touchedMaterial;
    return 5;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = (material, options = {}) => {
    displayRefreshes.push([material.name, options.changedLayer?.id, options.live]);
    return true;
  };
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.resolveTextureAirbrushScreenStrokeFlushWaiters = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 5);
  assert.deepEqual(displayRefreshes, [["stale", staleLayer.id, undefined], ["touched", touchedLayer.id, undefined]]);
});

test("scheduled first layer flush prioritizes queued paint over cold layer prewarm", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const originalWindow = globalThis.window;
  const calls = [];
  let animationFrameCallback = null;
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        animationFrameCallback = callback;
        return 1;
      }
    };
    editor.textureAirbrushCameraPrewarmScheduled = true;
    editor.texturePaintLayerMutationSerialValue = () => 3;
    editor.textureAirbrushScreenStrokeQueue = [{
      clientX: 12,
      clientY: 8,
      strokeStart: { clientX: 10, clientY: 8 },
      radiusPixels: 8,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      spacing: 1,
      erase: false,
      layerMode: true,
      strokeReset: true,
      layerMutationSerial: 3
    }];
    editor.textureAirbrushPrewarmStableCameraFrame = () => {
      throw new Error("layer paint should not run broad camera prewarm before the first flush");
    };
    editor.activeTool = "airbrush";
    editor.texturePaintLayerModeActive = () => true;
    editor.texturePaintActiveMaterial = "active-layer-material";
    editor.textureAirbrushLayerTargetReadyForLiveReset = (material) => {
      throw new Error(`queued layer paint should not run ready checks before the first flush for ${material}`);
    };
    editor.prewarmTexturePaintActiveLayerMaterialGpu = (material, options) => {
      throw new Error(`queued layer paint should not prewarm before the first flush for ${material} ${options}`);
    };
    editor.prewarmTexturePaintActiveLayerGpu = () => {
      throw new Error("cold layer paint should not run broad prewarm before the first flush");
    };
    editor.flushTextureAirbrushScreenStroke = (options) => {
      calls.push(`flush:${options?.live === true ? "live" : "full"}`);
      editor.textureAirbrushScreenStrokeQueue = [];
      return 1;
    };

    assert.equal(editor.scheduleTextureAirbrushScreenStrokeFlush(), true);
    animationFrameCallback();

    assert.equal(editor.textureAirbrushCameraPrewarmScheduled, false);
    assert.equal(editor.textureAirbrushCameraPrewarmStableFrames, 0);
    assert.deepEqual(calls, ["flush:live"]);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("ending an airbrush stroke finishes pending screen batches before undo finalization", async () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushScreenStrokeMethods(PaintEditor);
  const editor = new PaintEditor();
  const originalWindow = globalThis.window;
  const animationFrameCallbacks = [];
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }
    };
    const projected = [];
    const projectedStrokeContexts = [];
    let finalized = 0;
    let finalizedProjectedCount = 0;
    editor.textureBrushRadiusScreenPixels = () => 10;
    editor.textureAirbrushSpacingPercent = () => 1;
    editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
    editor.clearTextureAirbrushScreenLayer = () => {};
    editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
      projected.push(options.radiusPixels);
      projectedStrokeContexts.push(editor.texturePaintActiveStrokeUndo());
      return options.strokeSegments.length;
    };
    editor.finalizeTexturePaintStrokeUndo = (stroke) => {
      finalized += 1;
      finalizedProjectedCount = projected.length;
      assert.equal(stroke.label, "Texture airbrush");
      return true;
    };
    editor.texturePaintStrokeUndo = {
      label: "Texture airbrush",
      changed: true,
      touched: new Map(),
      before: [{}]
    };
    editor.textureAirbrushPendingScreenStrokeBatches = [8, 10].map((radiusPixels, index) => ({
      styleKey: `stale:${radiusPixels}`,
      radiusPixels,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      strokeSegments: [{
        start: { clientX: index * 8 + 60, clientY: 0 },
        end: { clientX: index * 8 + 64, clientY: 0 }
      }]
    }));
    editor.textureAirbrushScreenStrokeQueue = [4, 6, 12, 14].map((radiusPixels, index) => ({
      clientX: index * 8,
      clientY: 0,
      strokeStart: { clientX: index * 8 - 4, clientY: 0 },
      radiusPixels,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1
    }));
    const stroke = editor.texturePaintStrokeUndo;

    assert.equal(editor.endTexturePaintStrokeUndo(), false);
    assert.deepEqual(projected, [8, 10, 4, 6]);
    assert.equal(finalized, 0);
    assert.equal(editor.texturePaintStrokeUndo, null);
    assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 2);
    assert.equal(animationFrameCallbacks.length, 1);

    animationFrameCallbacks.shift()();

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(finalized, 1);
    assert.deepEqual(projected, [8, 10, 4, 6, 12, 14]);
    assert.deepEqual(projectedStrokeContexts, [stroke, stroke, stroke, stroke, stroke, stroke]);
    assert.equal(finalizedProjectedCount, 6);
    assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("airbrush screen batches preserve gentle curves and sharp turns", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const segment = (startX, startY, endX, endY) => ({
    clientX: endX,
    clientY: endY,
    strokeStart: { clientX: startX, clientY: startY },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });

  const [batch] = editor.textureAirbrushScreenStrokeBatches([
    segment(0, 0, 10, 1),
    segment(10, 1, 20, 2),
    segment(20, 2, 30, 2),
    segment(30, 2, 40, 1),
    segment(40, 1, 50, 0),
    segment(50, 0, 54, 22)
  ]);

  assert.deepEqual(batch.strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 10, clientY: 1 }
    },
    {
      start: { clientX: 10, clientY: 1 },
      end: { clientX: 20, clientY: 2 }
    },
    {
      start: { clientX: 20, clientY: 2 },
      end: { clientX: 30, clientY: 2 }
    },
    {
      start: { clientX: 30, clientY: 2 },
      end: { clientX: 40, clientY: 1 }
    },
    {
      start: { clientX: 40, clientY: 1 },
      end: { clientX: 50, clientY: 0 }
    },
    {
      start: { clientX: 50, clientY: 0 },
      end: { clientX: 54, clientY: 22 }
    }
  ]);
});

test("airbrush screen flush does not replace a successful stroke status with a later miss", () => {
  class StatusEditor {}
  installTextureAirbrushScreenStrokeMethods(StatusEditor);
  const editor = new StatusEditor();
  const statuses = [];
  let nextChanged = 12;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = () => nextChanged;
  editor.setStatus = (message) => {
    statuses.push(message);
  };
  const payload = {
    clientX: 12,
    clientY: 10,
    strokeStart: { clientX: 10, clientY: 10 },
    radiusPixels: 8,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  };

  editor.textureAirbrushScreenStrokeQueue = [payload];
  assert.equal(editor.flushTextureAirbrushScreenStroke(), 12);
  assert.deepEqual(statuses, ["Airbrushed 12 projected pixels"]);

  nextChanged = 0;
  editor.textureAirbrushScreenStrokeQueue = [payload];
  assert.equal(editor.flushTextureAirbrushScreenStroke(), 0);
  assert.deepEqual(statuses, ["Airbrushed 12 projected pixels"]);

  editor.textureAirbrushScreenStrokeChanged = false;
  editor.textureAirbrushScreenStrokeQueue = [payload];
  assert.equal(editor.flushTextureAirbrushScreenStroke(), 0);
  assert.deepEqual(statuses, [
    "Airbrushed 12 projected pixels",
    "Airbrush needs the cursor over textured mesh"
  ]);
});

test("layer airbrush still uses queued screen strokes", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureAirbrushGpuDisabled = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushPressureSettings = () => ({});
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;

  assert.equal(editor.textureAirbrushCanUseScreenStroke(), true);
  const payload = editor.textureAirbrushScreenStrokePayload(
    { clientX: 12, clientY: 14 },
    { clientX: 10, clientY: 11 }
  );
  assert.equal(payload.layerMode, true);
  assert.equal(payload.layerMutationSerial, 0);
  assert.equal(payload.erase, false);
});

test("direct layer airbrush uses the GPU vector path when available", () => {
  class LayerPaintEditor {}
  installPaintToolMethods(LayerPaintEditor, {});
  const editor = new LayerPaintEditor();
  const projectedOptions = [];
  editor.model = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.raycaster = { setFromCamera() {} };
  editor.camera = {};
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => ({});
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.texturePaintHitForEvent = () => null;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projectedOptions.push(options);
    return 1;
  };

  editor.paintFromEvent({ clientX: 10, clientY: 12 });

  assert.equal(projectedOptions.length, 1);
  assert.equal(projectedOptions[0].gpu, true);
  assert.equal(projectedOptions[0].resolvedBackend, undefined);
});

test("layer GPU screen flush composites once after projected batches", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projectedOptions = [];
  const statuses = [];
  let deferredCompositeFlushes = 0;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = (options) => ({ ...options });
  editor.textureAirbrushGpuLayerTargetForMaterial = () => ({});
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projectedOptions.push(options);
    return 5;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => {
    deferredCompositeFlushes += 1;
    return 1;
  };
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = (message) => {
    statuses.push(message);
  };
  editor.textureAirbrushScreenStrokeQueue = [
    {
      clientX: 12,
      clientY: 10,
      strokeStart: { clientX: 10, clientY: 10 },
      radiusPixels: 8,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      spacing: 1,
      erase: false,
      layerMode: true
    },
    {
      clientX: 18,
      clientY: 15,
      strokeStart: { clientX: 12, clientY: 10 },
      radiusPixels: 8,
      color: { r: 255, g: 255, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      spacing: 1,
      erase: false,
      layerMode: true
    }
  ];

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 10);
  assert.equal(projectedOptions.length, 2);
  assert.equal(projectedOptions.every((options) => options.deferLayerComposite === true), true);
  assert.equal(deferredCompositeFlushes, 1);
  assert.deepEqual(statuses, ["Airbrushed 10 projected pixels"]);
});

test("low spacing layer GPU live flush uses background-style adaptive vector chunks", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  let deferredCompositeFlushes = 0;
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => ({});
  editor.textureAirbrushGpuLayerTargetForMaterial = () => ({});
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      firstX: options.strokeSegments[0]?.start.clientX,
      lastX: options.strokeSegments.at(-1)?.end.clientX,
      deferLayerComposite: options.deferLayerComposite,
      gpu: options.gpu
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => {
    deferredCompositeFlushes += 1;
    return 1;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 72 }, (_, index) => ({
    clientX: index + 1,
    clientY: Math.sin(index / 8) * 6,
    strokeStart: {
      clientX: index,
      clientY: Math.sin(Math.max(0, index - 1) / 8) * 6
    },
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    erase: false,
    layerMode: true
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 48);
  assert.deepEqual(projected, [{
    segments: 24,
    firstX: 0,
    lastX: 24,
    deferLayerComposite: true,
    gpu: true
  }, {
    segments: 24,
    firstX: 24,
    lastX: 48,
    deferLayerComposite: true,
    gpu: true
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 1);
  assert.equal(deferredCompositeFlushes, 0);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 24);
  assert.deepEqual(projected, [{
    segments: 24,
    firstX: 0,
    lastX: 24,
    deferLayerComposite: true,
    gpu: true
  }, {
    segments: 24,
    firstX: 24,
    lastX: 48,
    deferLayerComposite: true,
    gpu: true
  }, {
    segments: 24,
    firstX: 48,
    lastX: 72,
    deferLayerComposite: true,
    gpu: true
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
  assert.equal(deferredCompositeFlushes, 1);
});

test("reset layer GPU live flush paints a small first chunk before continuing", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = () => ({});
  editor.textureAirbrushGpuLayerTargetForMaterial = () => ({});
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
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 24);
  assert.deepEqual(projected, [{
    segments: 8,
    firstX: 0,
    lastX: 8
  }, {
    segments: 24,
    firstX: 8,
    lastX: 32
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
  assert.equal(scheduled, 1);
});

test("reset layer GPU live flush skips broad seeded-frame prewarm checks before painting", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = (options) => ({ ...options });
  editor.textureAirbrushGpuLayerTargetForMaterial = () => ({});
  editor.textureAirbrushLayerPrewarmNeeded = () => {
    throw new Error("reset downstroke should not scan broad layer prewarm state");
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      seedLayerProxies: options.projectionFrame?.seedLayerProxies,
      seedPaintPasses: options.projectionFrame?.seedPaintPasses
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 1,
    clientY: 0,
    strokeStart: { clientX: 0, clientY: 0 },
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
  assert.deepEqual(projected, [{
    segments: 1,
    seedLayerProxies: false,
    seedPaintPasses: false
  }]);
});

test("warmed reset layer GPU live flush uses the background-style budget", () => {
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
  const warmFrame = {
    paintPassCacheSeeded: true,
    seedPaintPasses: true,
    paintPassCache: new Map([[
      "active-pass",
      {
        key: "active-pass",
        targetEntry
      }
    ]]),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameState = warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
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

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 24);
  assert.deepEqual(projected.at(-1), {
    segments: 24,
    firstX: 48,
    lastX: 72
  });
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
});

test("warmed partial reset layer GPU live flush reuses the active layer pass immediately", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const layerPass = {
    key: "active-pass",
    targetEntry
  };
  const warmFrame = {
    rect: { left: 0, top: 0, width: 100, height: 100 },
    paintPassCacheSeeded: false,
    seedPaintPasses: false,
    paintPassCache: new Map([["active-pass", layerPass]]),
    probePaintPassCache: new Map([["0:0", [layerPass]]]),
    proxySceneCache: new Map([["active-pass", {}]])
  };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLiveProjectionFrameState = warmFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === warmFrame;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureBrushRadiusScreenPixels = () => 24;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl" });
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    assert.deepEqual(options, { seedLayerProxies: false, seedPaintPasses: false });
    return warmFrame;
  };
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushLayerPrewarmNeeded = () => false;
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      segments: options.strokeSegments.length,
      reusePartialLayerPasses: options.reusePartialLayerPasses === true,
      renderAllCachedPasses: options.renderAllCachedPasses === true
    });
    return options.strokeSegments.length;
  };
  editor.flushTexturePaintDeferredLayerComposites = () => 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.setStatus = () => {};

  editor.textureAirbrushScreenStrokeQueue = Array.from({ length: 16 }, (_, index) => ({
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

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 16);
  assert.deepEqual(projected, [{
    segments: 16,
    reusePartialLayerPasses: true,
    renderAllCachedPasses: true
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 0);
});

test("warm layer GPU reset flush keeps a lightweight projection frame after camera reset", () => {
  class LayerEditor {}
  installTextureAirbrushScreenStrokeMethods(LayerEditor);
  const editor = new LayerEditor();
  const projected = [];
  const frameOptions = [];
  const prewarmChecks = [];
  let scheduled = 0;
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} }
  };
  const lightweightFrame = {
    seedPaintPasses: false,
    paintPassCache: new Map(),
    proxySceneCache: new Map()
  };
  editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushLayerPrewarmNeeded = (material, options) => {
    prewarmChecks.push([material, options]);
    return false;
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
      renderAllCachedPasses: options.renderAllCachedPasses
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

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 8);
  assert.deepEqual(prewarmChecks, []);
  assert.deepEqual(frameOptions, [{ seedLayerProxies: false, seedPaintPasses: false }]);
  assert.deepEqual(projected, [{
    segments: 8,
    firstX: 0,
    lastX: 8,
    renderAllCachedPasses: undefined
  }]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, 8);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.every((batch) => batch.strokeStartedWithReset === true), true);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 48);
  assert.deepEqual(frameOptions, [
    { seedLayerProxies: false, seedPaintPasses: false },
    { seedLayerProxies: false, seedPaintPasses: false }
  ]);
  assert.deepEqual(projected, [{
    segments: 8,
    firstX: 0,
    lastX: 8,
    renderAllCachedPasses: undefined
  }, {
    segments: 24,
    firstX: 8,
    lastX: 32,
    renderAllCachedPasses: undefined
  }, {
    segments: 24,
    firstX: 32,
    lastX: 56,
    renderAllCachedPasses: undefined
  }]);
  assert.deepEqual([editor.textureAirbrushPendingScreenStrokeBatches?.length || 0, editor.flushTextureAirbrushScreenStroke(), editor.textureAirbrushPendingScreenStrokeBatches?.length || 0], [1, 16, 0]);
});
