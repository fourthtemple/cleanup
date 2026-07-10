import assert from "node:assert/strict";
import test from "node:test";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";

test("GPU undo can clear an empty layer target back to transparent", () => {
  class Color {}
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, { THREE: { Color } });
  const editor = new PaintEditor();
  const target = { texture: {} };
  const previousTarget = { texture: {} };
  const previousColor = { value: "previous" };
  const calls = [];
  editor.renderer = {
    isWebGPURenderer: true,
    autoClear: false,
    getRenderTarget: () => previousTarget,
    setRenderTarget: (value) => calls.push(["target", value]),
    getClearAlpha: () => 0.75,
    getClearColor: () => previousColor,
    setClearColor: (color, alpha) => calls.push(["clear-color", color, alpha]),
    clear: () => calls.push(["clear"])
  };
  const targetEntry = {
    target,
    emptyTransparent: false,
    texturePaintLayerHasPaint: true,
    paintRevision: 7
  };

  assert.equal(editor.clearTexturePaintGpuTarget(targetEntry, { markMutated: false }), true);
  assert.deepEqual(calls, [
    ["target", target],
    ["clear-color", 0x000000, 0],
    ["clear"],
    ["target", previousTarget],
    ["clear-color", previousColor, 0.75]
  ]);
  assert.equal(editor.renderer.autoClear, false);
  assert.equal(targetEntry.emptyTransparent, true);
  assert.equal(targetEntry.texturePaintLayerHasPaint, false);
  assert.equal(targetEntry.paintRevision, 7);
});

test("texture paint undo finalization exposes a promise while screen work drains", async () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let resolveScreenFlush = null;
  let finalized = false;
  const screenFlush = new Promise((resolve) => {
    resolveScreenFlush = resolve;
  });
  editor.finishTextureAirbrushScreenStrokeFlush = () => screenFlush;
  editor.finalizeTexturePaintStrokeUndo = (stroke) => {
    finalized = true;
    assert.equal(stroke.label, "Texture airbrush");
    return true;
  };
  editor.texturePaintStrokeUndo = {
    label: "Texture airbrush",
    changed: true,
    touched: new Map(),
    before: [{}]
  };

  const stroke = editor.texturePaintStrokeUndo;
  assert.equal(editor.endTexturePaintStrokeUndo(), false);
  assert.equal(editor.texturePaintStrokeUndo, null);
  assert.equal(editor.texturePaintPendingStrokeUndoFinalizations.has(stroke), true);
  assert.equal(typeof stroke.finalizationPromise?.then, "function");

  let promiseSettled = false;
  stroke.finalizationPromise.then(() => {
    promiseSettled = true;
  });
  const historyWait = editor.texturePaintSettlePendingUndoBeforeHistory();
  assert.equal(typeof historyWait?.then, "function");
  await Promise.resolve();
  assert.equal(finalized, false);
  assert.equal(promiseSettled, false);

  resolveScreenFlush();
  await historyWait;
  await Promise.resolve();
  assert.equal(finalized, true);
  assert.equal(promiseSettled, true);
  assert.equal(editor.texturePaintPendingStrokeUndoFinalizations.has(stroke), false);
});

test("undo waits for pending texture paint before popping history", async () => {
  class HistoryEditor {}
  installPaintToolMethods(HistoryEditor, {});
  installSceneAndControlMethods(HistoryEditor, {});
  const editor = new HistoryEditor();
  const previousLayerState = {
    kind: "texture-layer",
    label: "Add Paint 1"
  };
  const paintState = {
    kind: "texture-paint",
    label: "Texture airbrush",
    entries: ["paint-entry"]
  };
  let resolveFinalization = null;
  const pendingStroke = {
    finalizationPromise: new Promise((resolve) => {
      resolveFinalization = resolve;
    })
  };
  editor.undoStack = [previousLayerState];
  editor.redoStack = [];
  editor.maxUndoSteps = 40;
  editor.texturePaintPendingStrokeUndoFinalizations = new Set([pendingStroke]);
  editor.updateUndoButton = () => {};
  editor.setStatus = () => {};
  let restored = null;
  editor.restoreTexturePaintSnapshot = (entries, field) => {
    restored = { entries, field };
    return true;
  };
  editor.restoreTexturePaintLayerHistorySnapshot = () => {
    throw new Error("undo should not pop the older layer state first");
  };

  assert.equal(editor.undoLastEdit(), false);
  assert.equal(editor.historyRestoreBusy, true);
  assert.deepEqual(editor.undoStack, [previousLayerState]);
  assert.deepEqual(editor.redoStack, []);

  editor.undoStack.push(paintState);
  editor.texturePaintPendingStrokeUndoFinalizations.delete(pendingStroke);
  resolveFinalization(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(restored, {
    entries: ["paint-entry"],
    field: "before"
  });
  assert.equal(editor.historyRestoreBusy, false);
  assert.deepEqual(editor.undoStack, [previousLayerState]);
  assert.deepEqual(editor.redoStack, [paintState]);
});

test("pending undo places finalized texture paint above later non-paint states", () => {
  class HistoryEditor {}
  installPaintToolMethods(HistoryEditor, {});
  const editor = new HistoryEditor();
  const laterState = {
    kind: "selection",
    label: "Selection"
  };
  const paintEntry = {
    type: "canvas",
    key: "paint-entry"
  };
  const stroke = {
    label: "Texture airbrush",
    changed: true,
    undoStackInsertIndex: 0,
    before: [paintEntry]
  };
  editor.undoStack = [laterState];
  editor.redoStack = [];
  editor.maxUndoSteps = 40;
  editor.updateUndoButton = () => {};
  editor.finalizeTexturePaintUndoEntry = (entry) => entry === paintEntry;
  editor.texturePaintHistoryWaitDirection = "undo";

  assert.equal(editor.finalizeTexturePaintStrokeUndo(stroke), true);
  assert.equal(editor.undoStack.length, 2);
  assert.equal(editor.undoStack[0], laterState);
  assert.equal(editor.undoStack[1].kind, "texture-paint");
  assert.deepEqual(editor.undoStack[1].entries, [paintEntry]);
});

test("cached WebGPU stroke source is copied before undo capture can be mutated", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const canvas = { width: 2, height: 1 };
  const afterData = new Uint8ClampedArray([9, 9, 9, 255, 8, 8, 8, 255]);
  const context = {
    getImageData: (x, y, width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(afterData.subarray((y * canvas.width + x) * 4, (y * canvas.width + x + width) * 4))
    })
  };
  const editable = {
    canvas,
    context,
    texture: {}
  };
  const sourceBeforeImageData = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])
  };

  editor.texturePaintStrokeUndo = {
    label: "Texture airbrush",
    changed: true,
    touched: new Map(),
    before: []
  };
  assert.equal(editor.captureTexturePaintCanvasUndoTarget({}, {}, editable, 0, {
    beforeImageData: sourceBeforeImageData,
    bounds: { x: 0, y: 0, width: 2, height: 1 }
  }), true);

  sourceBeforeImageData.data.fill(200);
  const entry = editor.texturePaintStrokeUndo.before[0];
  assert.equal(editor.finalizeTexturePaintUndoEntry(entry), true);
  assert.deepEqual([...entry.before.data], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("texture paint undo captures disjoint UV regions without widening to their union", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const canvas = { width: 8, height: 4 };
  const getCalls = [];
  const putCalls = [];
  const context = {
    getImageData: (x, y, width, height) => {
      getCalls.push({ x, y, width, height });
      return {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4).fill(getCalls.length)
      };
    },
    putImageData: (image, x, y) => {
      putCalls.push({ x, y, width: image.width, height: image.height });
    }
  };
  const editable = {
    canvas,
    context,
    texture: {}
  };
  editor.texturePaintStrokeUndo = {
    label: "Texture airbrush",
    changed: true,
    touched: new Map(),
    before: []
  };

  assert.equal(editor.captureTexturePaintCanvasUndoTarget({}, {}, editable, 0, {
    bounds: { x: 1, y: 0, width: 6, height: 4 },
    boundsRegions: [
      { x: 1, y: 0, width: 2, height: 1 },
      { x: 6, y: 3, width: 1, height: 1 }
    ]
  }), true);

  assert.deepEqual(getCalls, [
    { x: 1, y: 0, width: 2, height: 1 },
    { x: 6, y: 3, width: 1, height: 1 }
  ]);
  const entry = editor.texturePaintStrokeUndo.before[0];
  assert.equal(editor.finalizeTexturePaintUndoEntry(entry), true);
  assert.deepEqual(getCalls, [
    { x: 1, y: 0, width: 2, height: 1 },
    { x: 6, y: 3, width: 1, height: 1 },
    { x: 1, y: 0, width: 2, height: 1 },
    { x: 6, y: 3, width: 1, height: 1 }
  ]);

  editor.restoreTexturePaintSnapshot([entry], "before");
  assert.deepEqual(putCalls, [
    { x: 1, y: 0, width: 2, height: 1 },
    { x: 6, y: 3, width: 1, height: 1 }
  ]);
});

test("canvas undo restore rebinds away from transient TSL surface display textures", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const invalidated = [];
  let tslInvalidations = 0;
  editor.textureAirbrushInvalidateWebGpuCache = (texture) => {
    invalidated.push(texture);
    return true;
  };
  editor.texturePaintTslSurfaceAirbrushInvalidate = () => {
    tslInvalidations += 1;
    return true;
  };

  const canvasTexture = { name: "canvas", userData: {}, needsUpdate: false };
  const targetTexture = {
    name: "tsl-target",
    userData: {
      texturePaintTslSurfaceAirbrushTargetTexture: true,
      textureAirbrushWebGpuCanvasMap: canvasTexture
    },
    needsUpdate: false
  };
  const displayTexture = {
    name: "tsl-display",
    userData: {
      texturePaintTslSurfaceAirbrushDisplayTexture: true,
      textureAirbrushWebGpuCanvasMap: canvasTexture
    },
    needsUpdate: false
  };
  const material = {
    map: displayTexture,
    userData: {
      clonePaintTexture: targetTexture
    },
    needsUpdate: false,
    disposed: 0,
    dispose() {
      this.disposed += 1;
    }
  };

  assert.equal(editor.restoreTexturePaintCanvasWebGpuDisplay({
    type: "canvas",
    material,
    texture: targetTexture,
    canvas: { width: 4, height: 4 }
  }), true);

  assert.equal(material.map, canvasTexture);
  assert.equal(material.userData.clonePaintTexture, canvasTexture);
  assert.equal(material.needsUpdate, true);
  assert.equal(material.disposed, 1);
  assert.equal(canvasTexture.needsUpdate, true);
  assert.equal(targetTexture.needsUpdate, true);
  assert.equal(tslInvalidations, 1);
  assert.ok(invalidated.includes(displayTexture));
  assert.ok(invalidated.includes(targetTexture));
  assert.ok(invalidated.includes(canvasTexture));
});

test("canvas undo restore rebinds stale material maps when entry texture was a TSL target", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  editor.textureAirbrushInvalidateWebGpuCache = () => true;
  let tslInvalidations = 0;
  editor.texturePaintTslSurfaceAirbrushInvalidate = () => {
    tslInvalidations += 1;
    return true;
  };

  const canvasTexture = { name: "canvas", userData: {}, needsUpdate: false };
  const targetTexture = {
    name: "tsl-target",
    userData: {
      texturePaintTslSurfaceAirbrushTargetTexture: true,
      textureAirbrushWebGpuCanvasMap: canvasTexture
    },
    needsUpdate: false
  };
  const staleMaterialMap = {
    name: "stale-display-without-marker",
    userData: {},
    needsUpdate: false
  };
  const material = {
    map: staleMaterialMap,
    userData: {
      clonePaintTexture: targetTexture
    },
    needsUpdate: false,
    disposed: 0,
    dispose() {
      this.disposed += 1;
    }
  };

  assert.equal(editor.restoreTexturePaintCanvasWebGpuDisplay({
    type: "canvas",
    material,
    texture: targetTexture,
    canvas: { width: 4, height: 4 }
  }), true);

  assert.equal(material.map, canvasTexture);
  assert.equal(material.userData.clonePaintTexture, canvasTexture);
  assert.equal(material.needsUpdate, true);
  assert.equal(material.disposed, 1);
  assert.equal(canvasTexture.needsUpdate, true);
  assert.equal(targetTexture.needsUpdate, true);
  assert.equal(tslInvalidations, 1);
});

test("canvas undo restore clears TSL surface caches even for plain canvas entries", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  editor.textureAirbrushInvalidateWebGpuCache = () => true;
  const invalidationArgs = [];
  editor.texturePaintTslSurfaceAirbrushInvalidate = (arg) => {
    invalidationArgs.push(arg);
    return arg == null;
  };

  const canvasTexture = { name: "canvas", userData: {}, needsUpdate: false };
  const material = {
    map: canvasTexture,
    userData: {},
    needsUpdate: false,
    dispose() {}
  };

  assert.equal(editor.restoreTexturePaintCanvasWebGpuDisplay({
    type: "canvas",
    material,
    texture: canvasTexture,
    canvas: { width: 4, height: 4 }
  }), true);

  assert.equal(invalidationArgs.length, 2);
  assert.equal(invalidationArgs[0], material);
  assert.equal(invalidationArgs[1], undefined);
  assert.equal(canvasTexture.needsUpdate, true);
});

test("canvas undo rebuild does not dispose transient TSL clone textures", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  editor.textureAirbrushInvalidateWebGpuCache = () => true;
  editor.texturePaintTslSurfaceAirbrushInvalidate = () => true;

  const canvas = { width: 4, height: 4 };
  const context = {};
  let disposed = 0;
  const transientTexture = {
    name: "tsl-target",
    userData: {
      texturePaintTslSurfaceAirbrushTargetTexture: true
    },
    needsUpdate: false,
    dispose() {
      disposed += 1;
    }
  };
  const rebuiltTexture = { name: "rebuilt-canvas", userData: {}, needsUpdate: false };
  const material = {
    map: transientTexture,
    userData: {
      clonePaintCanvas: canvas,
      clonePaintContext: context,
      clonePaintTexture: transientTexture
    },
    needsUpdate: false,
    disposed: 0,
    dispose() {
      this.disposed += 1;
    }
  };
  editor.rebuildTexturePaintCompositeCanvasTexture = function rebuild(materialArg) {
    assert.equal(materialArg, material);
    material.userData.clonePaintTexture = rebuiltTexture;
    material.map = rebuiltTexture;
    return rebuiltTexture;
  };

  assert.equal(editor.restoreTexturePaintCanvasWebGpuDisplay({
    type: "canvas",
    material,
    texture: transientTexture,
    canvas,
    context
  }), true);

  assert.equal(material.map, rebuiltTexture);
  assert.equal(material.userData.clonePaintTexture, rebuiltTexture);
  assert.equal(disposed, 0);
  assert.equal(material.disposed, 0);
});

test("canvas texture rebuild inherits presentation from stable TSL canvas map", () => {
  class PaintEditor {}
  const THREE = {
    SRGBColorSpace: "srgb",
    ClampToEdgeWrapping: "clamp",
    LinearFilter: "linear",
    CanvasTexture: class CanvasTexture {
      constructor(canvas) {
        this.image = canvas;
        this.userData = {};
        this.offset = { copy() {} };
        this.repeat = { copy() {} };
        this.center = { copy() {} };
        this.needsUpdate = false;
      }
    }
  };
  installPaintToolMethods(PaintEditor, { THREE });
  const editor = new PaintEditor();
  editor.textureAirbrushInvalidateWebGpuCache = () => true;

  const stableCanvasTexture = {
    name: "stable-canvas",
    colorSpace: "stable-srgb",
    flipY: true,
    wrapS: "stable-wrap-s",
    wrapT: "stable-wrap-t",
    magFilter: "stable-mag",
    minFilter: "stable-min",
    generateMipmaps: true,
    anisotropy: 4,
    userData: {}
  };
  let disposed = 0;
  const transientTarget = {
    name: "tsl-target",
    colorSpace: "target-srgb",
    flipY: false,
    userData: {
      texturePaintTslSurfaceAirbrushTargetTexture: true,
      textureAirbrushWebGpuCanvasMap: stableCanvasTexture
    },
    dispose() {
      disposed += 1;
    }
  };
  const canvas = { width: 4, height: 4 };
  const material = {
    map: transientTarget,
    userData: {
      clonePaintCanvas: canvas,
      clonePaintContext: {},
      clonePaintTexture: transientTarget
    },
    needsUpdate: false
  };

  const rebuilt = editor.rebuildTexturePaintCompositeCanvasTexture(material, {
    referenceTexture: transientTarget
  });

  assert.ok(rebuilt);
  assert.equal(rebuilt.flipY, true);
  assert.equal(rebuilt.colorSpace, "stable-srgb");
  assert.equal(rebuilt.wrapS, "stable-wrap-s");
  assert.equal(rebuilt.wrapT, "stable-wrap-t");
  assert.equal(material.map, rebuilt);
  assert.equal(material.userData.clonePaintTexture, rebuilt);
  assert.equal(disposed, 0);
});

test("GPU undo restore keeps TSL surface targets bound to restored display texture", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const copyCalls = [];
  editor.copyTextureToRenderTarget = (source, target) => {
    copyCalls.push({ source, target });
    return true;
  };
  editor.restoreTexturePaintCanvasWebGpuDisplay = () => {
    throw new Error("TSL GPU undo should not rebind through stale canvas display");
  };
  editor.refreshCloneSpotlightTextures = () => {};
  editor.updateClonePaintPreviews = () => {};
  editor.syncPatchJson = () => {};
  editor.updateUndoButton = () => {};

  const targetTexture = {
    name: "tsl-target",
    userData: {
      texturePaintTslSurfaceAirbrushTargetTexture: true
    }
  };
  const displayTexture = {
    name: "tsl-display",
    userData: {
      texturePaintTslSurfaceAirbrushDisplayTexture: true,
      texturePaintTslSurfaceDisplaySourceTexture: targetTexture
    }
  };
  const target = { texture: targetTexture };
  const displayTarget = { texture: displayTexture };
  const editable = { texture: null };
  const material = {
    map: displayTexture,
    userData: {},
    needsUpdate: false,
    disposed: 0,
    dispose() {
      this.disposed += 1;
    }
  };
  const targetEntry = {
    target,
    displayTarget,
    editable,
    layerMode: false
  };
  const beforeSnapshot = {
    texture: { name: "before-target" },
    texturePaintDisplaySnapshot: {
      texture: { name: "before-display" }
    }
  };

  editor.restoreTexturePaintSnapshot([{
    type: "gpu",
    record: {},
    material,
    materialIndex: 0,
    targetEntry,
    before: beforeSnapshot,
    after: { texture: { name: "after-target" } }
  }], "before");

  assert.deepEqual(copyCalls, [
    { source: beforeSnapshot.texture, target },
    { source: beforeSnapshot.texturePaintDisplaySnapshot.texture, target: displayTarget }
  ]);
  assert.equal(material.map, displayTexture);
  assert.equal(material.userData.clonePaintTexture, targetTexture);
  assert.equal(material.userData.texturePaintTslSurfaceAirbrushTarget, targetEntry);
  assert.equal(editable.texture, targetTexture);
  assert.equal(material.needsUpdate, true);
  assert.equal(material.disposed, 1);
});

test("layer GPU history restore keeps its target attached after canvas restoration", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const copyCalls = [];
  const displayCalls = [];
  let disposedLayerGpuState = 0;
  editor.copyTextureToRenderTarget = (source, target) => {
    copyCalls.push({ source, target });
    return true;
  };
  editor.restoreTexturePaintCanvasWebGpuDisplay = () => true;
  editor.texturePaintUpdateLayerEmptyState = () => true;
  editor.disposeTexturePaintLayerGpuState = () => {
    disposedLayerGpuState += 1;
  };
  editor.texturePaintCompositeMaterialLayers = () => true;
  editor.rebuildTexturePaintCompositeCanvasTexture = () => ({});
  editor.resetTexturePaintLayerDisplayCaches = () => true;
  editor.bumpTexturePaintLayerMutationSerial = () => true;
  editor.textureAirbrushResetLiveProjectionFrame = () => true;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => 1;
  editor.texturePaintCompositeMaterialLayerDisplay = (material, options) => {
    displayCalls.push({ material, options });
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => {};
  editor.scheduleTextureAirbrushPostStrokePrewarm = () => {};
  editor.updateClonePaintPreviews = () => {};
  editor.syncPatchJson = () => {};
  editor.updateUndoButton = () => {};

  const layer = {
    id: "paint-layer",
    isEmpty: true,
    canvas: { width: 2, height: 2 }
  };
  const material = { userData: {}, needsUpdate: false };
  const target = { texture: {} };
  const targetEntry = {
    target,
    layer,
    layerMode: true,
    emptyTransparent: true,
    paintRevision: 0
  };
  layer.gpuTarget = targetEntry;
  const canvasImage = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const canvasEntry = {
    type: "canvas",
    material,
    layer,
    layerStack: { layers: [layer] },
    canvas: layer.canvas,
    context: { putImageData() {} },
    regions: [{ bounds: { x: 0, y: 0, width: 1, height: 1 }, before: canvasImage }]
  };
  const snapshot = { texture: { name: "painted-layer" } };
  const gpuEntry = {
    type: "gpu",
    material,
    targetEntry,
    before: snapshot
  };

  assert.equal(editor.restoreTexturePaintSnapshot([canvasEntry, gpuEntry], "before"), true);
  assert.equal(disposedLayerGpuState, 0);
  assert.equal(layer.gpuTarget, targetEntry);
  assert.equal(layer.isEmpty, false);
  assert.equal(layer.texturePaintHasPaint, true);
  assert.equal(layer.texturePaintGpuPainted, true);
  assert.equal(targetEntry.emptyTransparent, false);
  assert.equal(targetEntry.texturePaintLayerHasPaint, true);
  assert.deepEqual(copyCalls, [{ source: snapshot.texture, target }]);
  assert.equal(displayCalls.length, 1);
  assert.equal(displayCalls[0].material, material);
  assert.equal(displayCalls[0].options.changedLayer, layer);
});

test("repeated layer GPU undo rebuilds the cleared CPU composite after redo", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const calls = [];
  editor.clearTexturePaintGpuTarget = () => {
    calls.push("clear-target");
    return true;
  };
  editor.copyTextureToRenderTarget = () => {
    calls.push("copy-target");
    return true;
  };
  editor.restoreTexturePaintCanvasWebGpuDisplay = () => true;
  editor.resetTexturePaintLayerDisplayCaches = () => true;
  editor.bumpTexturePaintLayerMutationSerial = () => true;
  editor.textureAirbrushResetLiveProjectionFrame = () => true;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    calls.push("flush-layer-canvas");
    return 1;
  };
  editor.texturePaintCompositeMaterialLayers = (material, options) => {
    calls.push(["cpu-composite", material, options]);
    return true;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = () => {
    calls.push("display");
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => {};
  editor.scheduleTextureAirbrushPostStrokePrewarm = () => {};
  editor.updateClonePaintPreviews = () => {};
  editor.syncPatchJson = () => {};
  editor.updateUndoButton = () => {};

  const layer = {
    canvas: { width: 2, height: 2 },
    context: {
      clearRect() {
        calls.push("clear-layer-canvas");
      }
    }
  };
  const material = { userData: {} };
  const targetEntry = {
    target: { texture: {} },
    layer,
    layerMode: true
  };
  layer.gpuTarget = targetEntry;
  const entry = {
    type: "gpu",
    material,
    targetEntry,
    before: { clear: true, width: 2, height: 2 },
    after: { texture: {} }
  };

  editor.restoreTexturePaintSnapshot([entry], "before");
  editor.restoreTexturePaintSnapshot([entry], "after");
  editor.restoreTexturePaintSnapshot([entry], "before");

  const cpuComposites = calls.filter((call) => Array.isArray(call) && call[0] === "cpu-composite");
  assert.equal(cpuComposites.length, 2);
  assert.deepEqual(cpuComposites[0], [
    "cpu-composite",
    material,
    { skipGpuFlush: true, preferCpuDisplay: true }
  ]);
  assert.equal(calls.filter((call) => call === "clear-target").length, 2);
  assert.equal(calls.filter((call) => call === "clear-layer-canvas").length, 2);
  assert.equal(calls.filter((call) => call === "copy-target").length, 1);
  assert.equal(calls.filter((call) => call === "flush-layer-canvas").length, 1);
  assert.equal(calls.at(-1), "display");
});
