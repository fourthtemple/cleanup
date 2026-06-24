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

test("depth cache keys normalize negative zero matrix values", () => {
  class WebGlFrameEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, { THREE: {} });
  const editor = new WebGlFrameEditor();
  const inverseElements = [
    -0, 1, 0, 0,
    0, -0, 1, 0,
    0, 0, -0, 0,
    1, 2, 3, 1
  ];
  const projectionElements = [
    1, 0, -0, 0,
    0, 1, 0, 0,
    0, 0, 1, -0,
    0, 0, 0, 1
  ];
  editor.camera = {
    updateMatrixWorld() {},
    matrixWorldInverse: { elements: inverseElements },
    projectionMatrix: { elements: projectionElements }
  };
  editor.renderer = {
    getPixelRatio() {
      return 1;
    }
  };
  editor.progress = -0;
  const rect = { width: 910, height: 858 };

  const negativeZeroKey = editor.textureAirbrushDepthCacheKey(rect);
  inverseElements[0] = 0;
  inverseElements[5] = 0;
  inverseElements[10] = 0;
  projectionElements[2] = 0;
  projectionElements[11] = 0;
  editor.progress = 0;
  const positiveZeroKey = editor.textureAirbrushDepthCacheKey(rect);

  assert.equal(negativeZeroKey, positiveZeroKey);
  assert.doesNotMatch(negativeZeroKey, /-0\.00000/);
});

test("airbrush depth target prefers 24-bit depth precision", () => {
  class WebGlFrameEditor {}
  class DepthTexture {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
  }
  class WebGLRenderTarget {
    constructor(width, height, options) {
      this.width = width;
      this.height = height;
      this.options = options;
      this.texture = {};
    }
  }
  const THREE = {
    DepthFormat: "depth-format",
    DepthTexture,
    NearestFilter: "nearest",
    UnsignedIntType: "uint-depth",
    UnsignedShortType: "ushort-depth",
    WebGLRenderTarget
  };
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, { THREE });
  const editor = new WebGlFrameEditor();
  editor.canvas = {
    getBoundingClientRect() {
      return { width: 400, height: 300 };
    }
  };
  editor.renderer = {
    getPixelRatio() {
      return 2;
    }
  };

  const target = editor.textureAirbrushEnsureDepthTarget();

  assert.equal(target.width, 800);
  assert.equal(target.height, 600);
  assert.equal(target.options.depthBuffer, true);
  assert.equal(target.depthTexture.type, "uint-depth");
  assert.equal(target.depthTexture.format, "depth-format");
});

test("live projection frames stay current across negative zero camera key flips", () => {
  class WebGlFrameEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, { THREE: {} });
  const editor = new WebGlFrameEditor();
  const rect = { left: 0, top: 0, width: 910, height: 858 };
  const inverseElements = [
    -0, 1, 0, 0,
    0, -0, 1, 0,
    0, 0, -0, 0,
    1, 2, 3, 1
  ];
  const projectionElements = [
    1, 0, -0, 0,
    0, 1, 0, 0,
    0, 0, 1, -0,
    0, 0, 0, 1
  ];
  editor.canvas = {
    getBoundingClientRect() {
      return rect;
    }
  };
  editor.camera = {
    updateMatrixWorld() {},
    matrixWorldInverse: { elements: inverseElements },
    projectionMatrix: { elements: projectionElements }
  };
  editor.model = {};
  editor.renderer = {
    getPixelRatio() {
      return 1;
    }
  };
  editor.texturePaintLayerModeActive = () => false;
  editor.progress = -0;
  const projectionFrame = {
    canvas: editor.canvas,
    camera: editor.camera,
    model: editor.model,
    rect,
    frameKey: editor.textureAirbrushDepthCacheKey(rect)
  };

  inverseElements[0] = 0;
  inverseElements[5] = 0;
  inverseElements[10] = 0;
  projectionElements[2] = 0;
  projectionElements[11] = 0;
  editor.progress = 0;

  assert.equal(editor.textureAirbrushLiveProjectionFrameCurrent(projectionFrame), true);
});

test("empty layer GPU undo uses a clear snapshot instead of copying the first target", () => {
  class PaintEditor {}
  class Color {}
  installPaintToolMethods(PaintEditor, { THREE: { Color } });
  const editor = new PaintEditor();
  const layerCanvas = { width: 2, height: 1 };
  const layerTexture = { needsUpdate: false };
  let layerClears = 0;
  const layer = {
    isEmpty: true,
    canvas: layerCanvas,
    context: {
      clearRect(x, y, width, height) {
        layerClears += 1;
        assert.deepEqual([x, y, width, height], [0, 0, 2, 1]);
      }
    },
    gpuLayerTexture: layerTexture
  };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: true,
    width: 64,
    height: 32,
    target: {
      name: "layer-target",
      texture: { uuid: "layer-texture" }
    },
    layer
  };
  editor.cloneTextureRenderTargetSnapshot = () => {
    throw new Error("empty layer before state should not clone the GPU target");
  };

  assert.equal(editor.beginTexturePaintStrokeUndo(), true);
  assert.equal(editor.captureTexturePaintGpuUndoTarget({}, { uuid: "material" }, targetEntry, 0), true);
  const entry = editor.texturePaintStrokeUndo.before[0];
  assert.deepEqual(entry.before, {
    clear: true,
    width: 64,
    height: 32
  });
  let disposedSnapshots = 0;
  targetEntry.paintRevision = 5;
  targetEntry.prewarmedStrokeSourceSnapshot = {
    snapshot: {
      dispose() {
        disposedSnapshots += 1;
      }
    },
    revision: 5,
    width: 64,
    height: 32
  };

  const calls = [];
  const previousTarget = { name: "previous-target" };
  editor.renderer = {
    autoClear: false,
    getRenderTarget() {
      calls.push(["getRenderTarget"]);
      return previousTarget;
    },
    setRenderTarget(target) {
      calls.push(["setRenderTarget", target?.name || target]);
    },
    getClearAlpha() {
      calls.push(["getClearAlpha"]);
      return 0.5;
    },
    getClearColor(color) {
      calls.push(["getClearColor"]);
      color.name = "previous-clear";
    },
    setClearColor(color, alpha) {
      calls.push(["setClearColor", color?.name || color, alpha]);
    },
    clear(color, depth, stencil) {
      calls.push(["clear", color, depth, stencil, this.autoClear]);
    }
  };
  editor.copyTextureToRenderTarget = () => {
    throw new Error("clear snapshots should not copy texture data");
  };
  let composites = 0;
  let flushes = 0;
  let displayUpdates = 0;
  editor.texturePaintCompositeMaterialLayerDisplay = (material, options = {}) => {
    displayUpdates += 1;
    assert.equal(material.uuid, "material");
    assert.equal(options.changedLayer, layer);
    return true;
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    composites += 1;
    return true;
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    flushes += 1;
    return true;
  };

  assert.equal(editor.restoreTexturePaintSnapshot([entry], "before"), true);
  assert.deepEqual(calls, [
    ["getRenderTarget"],
    ["getClearAlpha"],
    ["getClearColor"],
    ["setRenderTarget", "layer-target"],
    ["setClearColor", 0x000000, 0],
    ["clear", true, true, true, true],
    ["setRenderTarget", "previous-target"],
    ["setClearColor", "previous-clear", 0.5]
  ]);
  assert.equal(editor.renderer.autoClear, false);
  assert.equal(targetEntry.emptyTransparent, true);
  assert.equal(targetEntry.paintRevision, 0);
  assert.equal(targetEntry.layer.isEmpty, true);
  assert.equal(layerClears, 1);
  assert.equal(layerTexture.needsUpdate, true);
  assert.equal(disposedSnapshots, 1);
  assert.equal(displayUpdates, 1);
  assert.equal(composites, 0);
  assert.equal(flushes, 0);
});

test("GPU layer history restore refreshes display without draining layer paint queues", () => {
  class PaintEditor {}
  class Color {}
  installPaintToolMethods(PaintEditor, { THREE: { Color } });
  const editor = new PaintEditor();
  const layer = { id: "paint-1", isEmpty: true };
  const material = {
    uuid: "material",
    needsUpdate: false,
    userData: {
      texturePaintLayerStack: {
        baseCanvas: { width: 1, height: 1 },
        layers: [layer]
      }
    }
  };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: true,
    paintRevision: 7,
    width: 64,
    height: 32,
    target: {
      name: "painted-layer-target",
      texture: { uuid: "target-texture" }
    },
    layer
  };
  layer.gpuTarget = targetEntry;
  const restoredTexture = { uuid: "restored-texture" };
  const entry = {
    type: "gpu",
    material,
    targetEntry,
    after: { texture: restoredTexture }
  };
  const redoState = { kind: "texture-paint" };
  editor.redoStack = [redoState];
  const order = [];
  editor.copyTextureToRenderTarget = (texture, target) => {
    order.push("copy");
    assert.equal(texture, restoredTexture);
    assert.equal(target, targetEntry.target);
    return true;
  };
  editor.prepareTexturePaintLayerTargetChange = () => {
    throw new Error("history restore should not drain active layer paint queues");
  };
  editor.cancelTextureAirbrushDeferredBroadLayerPrewarm = () => {
    order.push("cancel");
  };
  editor.resetTexturePaintLayerDisplayCaches = (candidateMaterial) => {
    order.push("reset-display");
    assert.equal(candidateMaterial, material);
    return 1;
  };
  editor.bumpTexturePaintLayerMutationSerial = () => {
    editor.texturePaintLayerMutationSerial = (editor.texturePaintLayerMutationSerial || 0) + 1;
    order.push(`bump:${editor.texturePaintLayerMutationSerial}`);
    return editor.texturePaintLayerMutationSerial;
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    order.push("reset-frame");
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = (options = {}) => {
    order.push("flush-canvases");
    assert.equal(options.material, material);
    assert.equal(options.composite, false);
    return 1;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = (candidateMaterial, options = {}) => {
    order.push(`display:${editor.texturePaintLayerMutationSerial}`);
    assert.equal(candidateMaterial, material);
    assert.equal(options.changedLayer, layer);
    assert.equal(options.live, false);
    return true;
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("display refresh should handle the restored material");
  };
  editor.renderTexturePaintLayerPanel = () => {
    order.push("panel");
  };
  editor.scheduleTextureAirbrushPostStrokePrewarm = () => {
    order.push("prewarm");
  };
  editor.updateClonePaintPreviews = () => {};
  editor.syncPatchJson = () => {};
  editor.updateUndoButton = () => {};

  assert.equal(editor.restoreTexturePaintSnapshot([entry], "after"), true);
  assert.deepEqual(order, [
    "copy",
    "cancel",
    "reset-display",
    "bump:1",
    "reset-frame",
    "flush-canvases",
    "display:1",
    "panel",
    "prewarm"
  ]);
  assert.deepEqual(editor.redoStack, [redoState]);
  assert.equal(targetEntry.emptyTransparent, false);
  assert.equal(layer.isEmpty, false);
  assert.equal(targetEntry.paintRevision, 8);
  assert.equal(material.needsUpdate, true);
});

test("painted layer GPU undo ignores stale empty flags and copies the target", () => {
  class PaintEditor {}
  class Color {}
  installPaintToolMethods(PaintEditor, { THREE: { Color } });
  const editor = new PaintEditor();
  const targetEntry = {
    layerMode: true,
    emptyTransparent: true,
    paintRevision: 3,
    width: 64,
    height: 32,
    target: {
      name: "painted-layer-target",
      texture: { uuid: "painted-layer-texture" }
    },
    layer: { isEmpty: true }
  };
  const snapshot = { texture: { uuid: "copied-target" } };
  editor.cloneTextureRenderTargetSnapshot = (candidateTarget) => {
    assert.equal(candidateTarget, targetEntry);
    return snapshot;
  };

  assert.equal(editor.beginTexturePaintStrokeUndo(), true);
  assert.equal(editor.captureTexturePaintGpuUndoTarget({}, { uuid: "material" }, targetEntry, 0), true);
  assert.equal(editor.texturePaintStrokeUndo.before[0].before, snapshot);
});

test("airbrush WebGL projection frame reuses matrix and depth setup across same-frame batches", () => {
  class WebGlFrameEditor {}
  let strokeUniformWrites = 0;
  let staticUniformWrites = 0;
  const vector = (trackStrokeUniform = false) => ({
    x: 0,
    y: 0,
    set(x, y) {
      if (trackStrokeUniform) {
        strokeUniformWrites += 1;
      }
      this.x = x;
      this.y = y;
      return this;
    },
    copy(value = {}) {
      this.x = value.x ?? this.x;
      this.y = value.y ?? this.y;
      return this;
    }
  });
  const staticVector = () => ({
    x: 0,
    y: 0,
    set(x, y) {
      staticUniformWrites += 1;
      this.x = x;
      this.y = y;
      return this;
    }
  });
  const staticMatrix = () => ({
    copy() {
      staticUniformWrites += 1;
      return this;
    }
  });
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlFrameEditor();
  const recordObject = {};
  const record = {
    object: recordObject,
    geometry: { attributes: { uv: {} } }
  };
  const targetTexture = {};
  let materialUpdates = 0;
  let seedUserDataReads = 0;
  const material = {
    uuid: "material-frame",
    map: targetTexture,
    get userData() {
      seedUserDataReads += 1;
      return null;
    },
    set needsUpdate(value) {
      if (value) {
        materialUpdates += 1;
      }
    }
  };
  recordObject.material = material;
  const targetEntry = { target: { texture: targetTexture } };
  let modelUpdates = 0;
  let boundsRefreshes = 0;
  let depthCalls = 0;
  let renderCalls = 0;
  let targetLookups = 0;
  let undoCaptures = 0;
  let raycasts = 0;
  let proxyLookups = 0;
  let skeletonUpdates = 0;
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget() {},
    render() {
      renderCalls += 1;
    }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {
    matrixWorldInverse: {},
    projectionMatrix: {}
  };
  editor.model = {
    updateMatrixWorld(force) {
      assert.equal(force, true);
      modelUpdates += 1;
    }
  };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {
    boundsRefreshes += 1;
  };
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      raycasts += 1;
      assert.deepEqual(objects, [recordObject]);
      return [{
        object: recordObject,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.textureAirbrushGpuTargetForMaterial = () => {
    targetLookups += 1;
    return targetEntry;
  };
  editor.captureTexturePaintGpuUndoTarget = () => {
    undoCaptures += 1;
  };
  editor.textureAirbrushRenderDepthTarget = () => {
    depthCalls += 1;
    return { depthTexture: {} };
  };
  const shaderMaterial = {
    uniforms: {
      paintViewMatrix: { value: staticMatrix() },
      paintProjectionMatrix: { value: staticMatrix() },
      depthTexture: { value: null },
      brushCenter: { value: vector() },
      brushStart: { value: vector() },
      strokeSegmentCount: { value: 0 },
      strokeStarts: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => vector(true)) },
      strokeEnds: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => vector(true)) },
      strokeRadii: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => 0) },
      viewportSize: { value: staticVector() },
      paintColor: { value: { setRGB() {} } },
      radiusPixels: { value: 0 },
      strength: { value: 0 },
      brushOpacity: { value: 0 },
      brushHardness: { value: 0 },
      scatterAmount: { value: 0 },
      depthEpsilon: { value: 0 },
      uvOffset: { value: vector() }
    },
    needsUpdate: true
  };
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({
    proxy: {
      skeleton: {
        update() {
          skeletonUpdates += 1;
        }
      }
    },
    scene: {}
  });
  const originalProxyLookup = editor.textureAirbrushGpuProxyForRecord.bind(editor);
  editor.textureAirbrushGpuProxyForRecord = (...args) => {
    proxyLookups += 1;
    return originalProxyLookup(...args);
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  assert.equal(modelUpdates, 1);
  assert.equal(boundsRefreshes, 1);

  const options = {
    gpu: true,
    projectionFrame,
    strokeSegments: [{
      start: { clientX: 5, clientY: 5 },
      end: { clientX: 20, clientY: 5 }
    }],
    radiusPixels: 4,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    pressureApplied: true
  };

  assert.equal(editor.textureAirbrushGpuProjectFromEvent({ clientX: 20, clientY: 5 }, options) > 0, true);
  assert.equal(editor.textureAirbrushGpuProjectFromEvent({ clientX: 40, clientY: 5 }, {
    ...options,
    strokeSegments: [{
      start: { clientX: 20, clientY: 5 },
      end: { clientX: 40, clientY: 5 },
      radiusPixels: 7
    }]
  }) > 0, true);

  assert.equal(modelUpdates, 1);
  assert.equal(boundsRefreshes, 1);
  assert.equal(depthCalls, 1);
  assert.equal(targetLookups, 1);
  assert.equal(undoCaptures, 1);
  assert.equal(proxyLookups, 1);
  assert.equal(skeletonUpdates, 1);
  assert.equal(renderCalls, 2);
  assert.equal(materialUpdates, 0);
  assert.equal(raycasts, 3);
  assert.equal(seedUserDataReads, 1);
  assert.equal(strokeUniformWrites, 4);
  assert.equal(staticUniformWrites, 3);
  assert.equal(shaderMaterial.uniforms.radiusPixels.value, 7);
  assert.equal(shaderMaterial.uniforms.strokeRadii.value[0], 7);
});

test("airbrush live WebGL projection frame persists for the active stroke", () => {
  class WebGlFrameEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlFrameEditor();
  let modelUpdates = 0;
  let boundsRefreshes = 0;
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {
    updateMatrixWorld(force) {
      assert.equal(force, true);
      modelUpdates += 1;
    }
  };
  editor.paintRecords = [{ object: {} }];
  editor.refreshSkinnedRaycastBounds = () => {
    boundsRefreshes += 1;
  };

  const firstFrame = editor.textureAirbrushLiveProjectionFrame();
  const secondFrame = editor.textureAirbrushLiveProjectionFrame();

  assert.equal(firstFrame, secondFrame);
  assert.equal(modelUpdates, 1);
  assert.equal(boundsRefreshes, 1);

  editor.textureAirbrushResetLiveProjectionFrame();
  const thirdFrame = editor.textureAirbrushLiveProjectionFrame();

  assert.notEqual(thirdFrame, firstFrame);
  assert.equal(modelUpdates, 2);
  assert.equal(boundsRefreshes, 2);
});

test("airbrush live projection frame invalidates after layer mutations", () => {
  class WebGlFrameEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlFrameEditor();
  let modelUpdates = 0;
  let boundsRefreshes = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintLayerMutationSerial = 2;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.texturePaintLayerMutationSerialValue = () => editor.texturePaintLayerMutationSerial;
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {
    updateMatrixWorld(force) {
      assert.equal(force, true);
      modelUpdates += 1;
    }
  };
  editor.paintRecords = [{ object: {} }];
  editor.refreshSkinnedRaycastBounds = () => {
    boundsRefreshes += 1;
  };

  const firstFrame = editor.textureAirbrushLiveProjectionFrame();
  assert.equal(firstFrame.layerMutationSerial, 2);

  editor.texturePaintLayerMutationSerial = 3;

  assert.equal(editor.textureAirbrushLiveProjectionFrameCurrent(firstFrame), false);
  const secondFrame = editor.textureAirbrushLiveProjectionFrame();

  assert.notEqual(secondFrame, firstFrame);
  assert.equal(secondFrame.layerMutationSerial, 3);
  assert.equal(modelUpdates, 2);
  assert.equal(boundsRefreshes, 2);
});

test("airbrush stroke reset keeps a current prewarmed live projection frame", () => {
  class WebGlFrameEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlFrameEditor();
  let modelUpdates = 0;
  let boundsRefreshes = 0;
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {
    matrixWorldInverse: { elements: Array.from({ length: 16 }, (_, index) => index + 1) },
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, index) => index + 17) }
  };
  editor.renderer = {
    getPixelRatio() {
      return 1;
    }
  };
  editor.model = {
    updateMatrixWorld(force) {
      assert.equal(force, true);
      modelUpdates += 1;
    }
  };
  editor.progress = 0;
  editor.paintRecords = [{ object: {} }];
  editor.refreshSkinnedRaycastBounds = () => {
    boundsRefreshes += 1;
  };

  const firstFrame = editor.textureAirbrushLiveProjectionFrame();

  assert.equal(editor.textureAirbrushResetLiveProjectionFrame({ keepCurrent: true }), false);
  assert.equal(editor.textureAirbrushLiveProjectionFrame(), firstFrame);
  assert.equal(modelUpdates, 1);
  assert.equal(boundsRefreshes, 1);

  editor.camera.projectionMatrix.elements[0] += 1;

  assert.equal(editor.textureAirbrushResetLiveProjectionFrame({ keepCurrent: true }), true);
  assert.notEqual(editor.textureAirbrushLiveProjectionFrame(), firstFrame);
  assert.equal(modelUpdates, 2);
  assert.equal(boundsRefreshes, 2);
});

test("airbrush live projection frame invalidates after orbit updates camera matrix", () => {
  class WebGlFrameEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlFrameEditor();
  let cameraUpdates = 0;
  let orbitMatrixValue = 1;
  let modelUpdates = 0;
  let boundsRefreshes = 0;
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {
    matrixWorldInverse: { elements: Array.from({ length: 16 }, (_, index) => index + 1) },
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, index) => index + 17) },
    updateMatrixWorld(force) {
      assert.equal(force, true);
      cameraUpdates += 1;
      this.matrixWorldInverse.elements[0] = orbitMatrixValue;
    }
  };
  editor.renderer = {
    getPixelRatio() {
      return 1;
    }
  };
  editor.model = {
    updateMatrixWorld(force) {
      assert.equal(force, true);
      modelUpdates += 1;
    }
  };
  editor.progress = 0;
  editor.paintRecords = [{ object: {} }];
  editor.refreshSkinnedRaycastBounds = () => {
    boundsRefreshes += 1;
  };

  const firstFrame = editor.textureAirbrushLiveProjectionFrame();
  orbitMatrixValue = 2;

  assert.equal(editor.textureAirbrushLiveProjectionFrameCurrent(firstFrame), false);
  const secondFrame = editor.textureAirbrushLiveProjectionFrame();

  assert.notEqual(secondFrame, firstFrame);
  assert.equal(secondFrame.frameKey.includes("2.0000000"), true);
  assert.equal(cameraUpdates >= 3, true);
  assert.equal(modelUpdates, 2);
  assert.equal(boundsRefreshes, 2);
});

test("new airbrush stroke reset asks to keep a valid prewarmed frame", () => {
  class ScreenStrokeEditor {}
  installTextureAirbrushScreenStrokeMethods(ScreenStrokeEditor);
  const editor = new ScreenStrokeEditor();
  let resetOptions = null;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureAirbrushGpuDisabled = false;
  editor.textureAirbrushResetLiveProjectionFrame = (options) => {
    resetOptions = options;
    return false;
  };
  editor.textureBrushRadiusScreenPixels = () => 12;
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });
  editor.textureAirbrushPressureSettings = () => ({ pressureRadius: true });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  assert.equal(editor.textureAirbrushQueueSpacedScreenStroke({
    clientX: 20,
    clientY: 30,
    pressure: 0.8,
    pointerType: "pen"
  }, { reset: true }), true);
  assert.deepEqual(resetOptions, { keepCurrent: true });
});

test("airbrush WebGL projection seeds prewarmed paint passes for cheap wide batches", () => {
  class WebGlFrameEditor {}
  const vector = () => ({
    x: 0,
    y: 0,
    set(x, y) {
      this.x = x;
      this.y = y;
      return this;
    },
    copy(value = {}) {
      this.x = value.x ?? this.x;
      this.y = value.y ?? this.y;
      return this;
    }
  });
  installTextureAirbrushWebGlBackendMethods(WebGlFrameEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlFrameEditor();
  const recordObject = {};
  const targetEntry = { target: { texture: {} } };
  const material = {
    uuid: "material-wide",
    needsUpdate: false,
    userData: {
      textureAirbrushGpuTarget: targetEntry
    }
  };
  const record = {
    object: {
      ...recordObject,
      material
    },
    geometry: { attributes: { uv: {} } }
  };
  let raycasts = 0;
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget() {},
    render() {}
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.camera = {
    matrixWorldInverse: {},
    projectionMatrix: {}
  };
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      raycasts += 1;
      assert.deepEqual(objects, [record.object]);
      return [{
        object: record.object,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.textureAirbrushGpuTargetForMaterial = () => targetEntry;
  editor.captureTexturePaintGpuUndoTarget = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => ({
    uniforms: {
      paintViewMatrix: { value: { copy() {} } },
      paintProjectionMatrix: { value: { copy() {} } },
      depthTexture: { value: null },
      brushCenter: { value: vector() },
      brushStart: { value: vector() },
      strokeSegmentCount: { value: 0 },
      strokeStarts: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => vector()) },
      strokeEnds: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => vector()) },
      viewportSize: { value: vector() },
      paintColor: { value: { setRGB() {} } },
      radiusPixels: { value: 0 },
      strength: { value: 0 },
      brushOpacity: { value: 0 },
      brushHardness: { value: 0 },
      scatterAmount: { value: 0 },
      depthEpsilon: { value: 0 },
      uvOffset: { value: vector() }
    },
    needsUpdate: true
  });
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  const baseOptions = {
    gpu: true,
    projectionFrame,
    radiusPixels: 24,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    pressureApplied: true
  };

  assert.equal(editor.textureAirbrushGpuProjectFromEvent({ clientX: 90, clientY: 70 }, {
    ...baseOptions,
    strokeSegments: [{
      start: { clientX: 60, clientY: 70 },
      end: { clientX: 90, clientY: 70 }
    }]
  }) > 0, true);
  assert.equal(raycasts, 1);

  assert.equal(editor.textureAirbrushGpuProjectFromEvent({ clientX: 120, clientY: 70 }, {
    ...baseOptions,
    strokeSegments: [{
      start: { clientX: 90, clientY: 70 },
      end: { clientX: 120, clientY: 70 }
    }]
  }) > 0, true);

  assert.equal(raycasts, 2);
});

test("layer airbrush projection seeds prewarmed active layer passes like background paint", () => {
  class WebGlLayerFrameEditor {}
  const vector = () => ({
    x: 0,
    y: 0,
    set(x, y) {
      this.x = x;
      this.y = y;
      return this;
    },
    copy(value = {}) {
      this.x = value.x ?? this.x;
      this.y = value.y ?? this.y;
      return this;
    }
  });
  installTextureAirbrushWebGlBackendMethods(WebGlLayerFrameEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlLayerFrameEditor();
  const layerTarget = { name: "layer-target", texture: { name: "layer-target-texture" } };
  const layerTargetEntry = {
    target: layerTarget,
    layerMode: true,
    emptyTransparent: true
  };
  const staleBackgroundTargetEntry = {
    target: { name: "background-target", texture: { name: "background-target-texture" } }
  };
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    isEmpty: true,
    gpuTarget: layerTargetEntry
  };
  const stack = {
    activeLayerId: "paint-1",
    layers: [layer]
  };
  const material = {
    uuid: "material-layer-seeded-pass",
    userData: {
      texturePaintLayerStack: stack,
      textureAirbrushGpuTarget: staleBackgroundTargetEntry
    }
  };
  const object = { material };
  const record = {
    object,
    geometry: { attributes: { uv: {} } }
  };
  const renderedTargets = [];
  const undoCaptures = [];
  let proxyRequests = 0;
  let activeTarget = null;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget(target) {
      activeTarget = target;
    },
    render() {
      renderedTargets.push(activeTarget?.name || "unknown-target");
    }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.camera = {
    matrixWorldInverse: {},
    projectionMatrix: {}
  };
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("seeded layer projection should not set up raycasts");
    },
    intersectObjects() {
      throw new Error("seeded layer projection should not raycast");
    }
  };
  editor.textureAirbrushGpuTargetForMaterial = () => {
    throw new Error("seeded layer projection should not create or look up a paint target");
  };
  editor.captureTexturePaintGpuUndoTarget = (candidateRecord, candidateMaterial, candidateTargetEntry) => {
    undoCaptures.push([candidateRecord, candidateMaterial, candidateTargetEntry]);
  };
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => ({
    uniforms: {
      paintViewMatrix: { value: { copy() {} } },
      paintProjectionMatrix: { value: { copy() {} } },
      depthTexture: { value: null },
      brushCenter: { value: vector() },
      brushStart: { value: vector() },
      strokeSegmentCount: { value: 0 },
      strokeStarts: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => vector()) },
      strokeEnds: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => vector()) },
      viewportSize: { value: vector() },
      paintColor: { value: { setRGB() {} } },
      radiusPixels: { value: 0 },
      strength: { value: 0 },
      brushOpacity: { value: 0 },
      brushHardness: { value: 0 },
      scatterAmount: { value: 0 },
      depthEpsilon: { value: 0 },
      uvOffset: { value: vector() }
    },
    needsUpdate: true
  });
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    proxyRequests += 1;
    assert.equal(candidateRecord, record);
    assert.equal(materialIndex, 0);
    assert.equal(candidateMaterial, material);
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, candidateTargetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(candidateTargetEntry, layerTargetEntry);
    return { target: layerTarget };
  };
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  assert.equal(projectionFrame.paintPassCache.size, 1);
  const seededPass = [...projectionFrame.paintPassCache.values()][0];
  assert.equal(seededPass.targetEntry, layerTargetEntry);
  assert.notEqual(seededPass.targetEntry, staleBackgroundTargetEntry);
  assert.equal(layerTargetEntry.material, material);
  assert.equal(layerTargetEntry.layer, layer);
  assert.equal(layerTargetEntry.layerStack, stack);
  assert.equal(projectionFrame.proxySceneCache.size, 1);
  assert.equal(proxyRequests, 1);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 90, clientY: 70 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
    radiusPixels: 24,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: [{
      start: { clientX: 60, clientY: 70 },
      end: { clientX: 90, clientY: 70 }
    }]
  });

  assert.equal(changed > 0, true);
  assert.equal(layer.isEmpty, false);
  assert.equal(layerTargetEntry.emptyTransparent, false);
  assert.equal(undoCaptures.length, 1);
  assert.deepEqual(undoCaptures[0], [record, material, layerTargetEntry]);
  assert.equal(proxyRequests, 1);
  assert.deepEqual(renderedTargets, ["layer-target"]);
});
