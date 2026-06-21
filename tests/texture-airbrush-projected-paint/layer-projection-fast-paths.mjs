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

test("layer projection can reuse a warm partial pass without probing a long reset chunk", () => {
  class WebGlLayerEditor {}
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
  installTextureAirbrushWebGlBackendMethods(WebGlLayerEditor, {
    THREE: {
      NoBlending: "no-blending",
      NormalBlending: "normal-blending",
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlLayerEditor();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: {},
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    activeLayerId: layer.id,
    layers: [layer]
  };
  const material = {
    uuid: "material-warm-partial-layer",
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const targetEntry = {
    target: { name: "layer-target", texture: { uuid: "layer-texture" } },
    width: 64,
    height: 64,
    material,
    layer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  layer.gpuTarget = targetEntry;
  const recordObject = { material };
  const record = {
    object: recordObject,
    geometry: { attributes: { uv: {} } }
  };
  const pass = {
    key: "0:0:material-warm-partial-layer",
    record,
    materialIndex: 0,
    material,
    targetEntry,
    undoCaptured: false
  };
  const rect = { left: 0, top: 0, width: 120, height: 100 };
  const projectionFrame = {
    canvas: null,
    camera: null,
    model: null,
    rect,
    paintRecords: [record],
    paintObjects: [recordObject],
    recordByObject: new Map([[recordObject, record]]),
    recordIndices: new Map([[record, 0]]),
    seedPaintPasses: false,
    seedLayerProxies: false,
    paintPassCacheSeeded: false,
    paintPassCache: new Map([[pass.key, pass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[pass.key, { scene: {}, proxy: { skeleton: { update() {} } } }]])
  };
  let currentTarget = null;
  let renders = 0;
  let undoCaptures = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.canvas = {
    getBoundingClientRect() {
      return rect;
    }
  };
  editor.camera = {
    matrixWorldInverse: { copy() {} },
    projectionMatrix: { copy() {} }
  };
  editor.model = { updateMatrixWorld() {} };
  projectionFrame.canvas = editor.canvas;
  projectionFrame.camera = editor.camera;
  projectionFrame.model = editor.model;
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return currentTarget;
    },
    setRenderTarget(target) {
      currentTarget = target;
    },
    render() {
      renders += 1;
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("warm partial layer pass should paint without probing");
    },
    intersectObjects() {
      throw new Error("warm partial layer pass should paint without raycasting");
    }
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
      strokeRadii: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => 0) },
      viewportSize: { value: vector() },
      paintColor: { value: { setRGB() {} } },
      radiusPixels: { value: 0 },
      strength: { value: 0 },
      brushOpacity: { value: 0 },
      brushHardness: { value: 0 },
      scatterAmount: { value: 0 },
      depthEpsilon: { value: 0 },
      uvOffset: { value: vector() },
      strokeSourceTexture: { value: null },
      useStrokeSourceTexture: { value: false },
      strokeSourceClear: { value: false },
      eraseMode: { value: false }
    },
    blending: "normal-blending",
    transparent: true,
    needsUpdate: false
  });
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.captureTexturePaintGpuUndoTarget = () => {
    undoCaptures += 1;
    return true;
  };
  editor.texturePaintGpuStrokeSourceSnapshot = () => ({ clear: true });
  editor.markTexturePaintGpuTargetMutated = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 92, clientY: 30 }, {
    gpu: true,
    projectionFrame,
    reusePartialLayerPasses: true,
    strokeSegments: [{
      start: { clientX: 20, clientY: 30 },
      end: { clientX: 92, clientY: 30 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true
  });

  assert.equal(changed > 0, true);
  assert.equal(renders, 1);
  assert.equal(undoCaptures, 1);
});

test("top layer GPU live paint refreshes a baked display from the real layer target", () => {
  class WebGlLayerEditor {}
  let underlaySerial = 0;
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
  const THREE = {
    CanvasTexture: class {
      constructor(canvas) {
        this.image = canvas;
      }
    },
    WebGLRenderTarget: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.texture = { name: `underlay-texture-${++underlaySerial}` };
      }
      dispose() {}
    },
    Color: class {},
    MeshBasicMaterial: class {
      constructor(options = {}) {
        Object.assign(this, options);
      }
    },
    Vector2: class {
      constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
      }
    },
    LinearFilter: "linear",
    ClampToEdgeWrapping: "clamp"
  };
  installTextureAirbrushWebGlBackendMethods(WebGlLayerEditor, { THREE });
  const editor = new WebGlLayerEditor();
  const renderTargets = [];
  let currentTarget = { name: "previous-target" };
  let queuedComposites = 0;
  let fullComposites = 0;
  const lowerTarget = { name: "lower-layer-target", texture: { name: "lower-layer-texture" } };
  const activeTarget = { name: "active-layer-target", texture: { name: "active-layer-texture" } };
  const lowerLayer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    isEmpty: false,
    canvas: {}
  };
  const activeLayer = {
    id: "paint-2",
    name: "Paint 2",
    visible: true,
    opacity: 1,
    isEmpty: true,
    canvas: {}
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: {},
    activeLayerId: activeLayer.id,
    layers: [lowerLayer, activeLayer]
  };
  const material = {
    uuid: "material-layer-underlay",
    map: { name: "stale-composite" },
    userData: {
      clonePaintTexture: { name: "base-source-texture" },
      texturePaintCompositeGpuTarget: {
        target: { name: "display-target", texture: { name: "display-texture" } },
        width: 64,
        height: 64
      },
      texturePaintLayerStack: stack
    },
    needsUpdate: false
  };
  lowerLayer.gpuTarget = {
    target: lowerTarget,
    width: 64,
    height: 64,
    material,
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  const activeTargetEntry = {
    target: activeTarget,
    width: 64,
    height: 64,
    material,
    layer: activeLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: true
  };
  activeLayer.gpuTarget = activeTargetEntry;
  const recordObject = { material };
  const record = {
    object: recordObject,
    geometry: { attributes: { uv: {} } }
  };
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return currentTarget;
    },
    setRenderTarget(target) {
      currentTarget = target;
    },
    setClearColor() {},
    clear() {},
    render() {
      renderTargets.push(currentTarget?.name || currentTarget?.texture?.name || "unknown");
    }
  };
  editor.textureAirbrushGpuCopyScene = {};
  editor.textureAirbrushGpuCopyCamera = {};
  editor.textureAirbrushGpuCopyMesh = {};
  editor.texturePaintLayerMutationSerialValue = () => 3;

  const prewarmed = editor.texturePaintLiveCompositeTargetForLayerGpuPaint(material, activeTargetEntry);

  assert.equal(prewarmed?.target, activeTarget);
  assert.equal(prewarmed.shaderComposite, true);
  assert.equal(material.map.name, "material live layer underlay");
  assert.equal(renderTargets.includes("display-target"), false);
  assert.equal(renderTargets.length > 0, true);
  renderTargets.length = 0;

  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {
    matrixWorldInverse: { copy() {} },
    projectionMatrix: { copy() {} }
  };
  editor.model = {
    updateMatrixWorld() {}
  };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      assert.deepEqual(objects, [recordObject]);
      return [{
        object: recordObject,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.textureAirbrushGpuTargetForMaterial = () => activeTargetEntry;
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
      strokeRadii: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => 0) },
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
    needsUpdate: false
  });
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.queueTexturePaintLayerGpuComposite = () => {
    queuedComposites += 1;
    return true;
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    fullComposites += 1;
    return true;
  };
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 24, clientY: 16 }, {
    gpu: true,
    deferLayerComposite: true,
    strokeSegments: [{
      start: { clientX: 8, clientY: 16 },
      end: { clientX: 24, clientY: 16 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    pressureApplied: true
  });

  assert.equal(changed > 0, true);
  assert.deepEqual(renderTargets, ["active-layer-target", "display-target", "display-target"]);
  assert.equal(queuedComposites, 0);
  assert.equal(fullComposites, 0);
  assert.equal(material.map.name, "display-texture");
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.layerOpacity, 0);
});

test("airbrush hover prewarms the hit material before the first layer stroke flush", () => {
  class PointerDownEditor {}
  installTextureAirbrushPointerMethods(PointerDownEditor);
  installPaintToolMethods(PointerDownEditor, {});
  const editor = new PointerDownEditor();
  const event = { clientX: 20, clientY: 30 };
  const hit = {
    record: { id: "hit-record" },
    hit: { face: { materialIndex: 2 } }
  };
  let prewarmCall = null;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureBrushCursor = {
    hidden: false,
    classList: {
      remove() {}
    }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.rememberBrushCursorEvent = () => true;
  editor.showTextureBrushCursorElement = () => true;
  editor.setTextureBrushCursorMode = () => true;
  editor.positionBrushCursor = () => true;
  editor.texturePaintHitForEvent = (candidateEvent, tool) => {
    assert.equal(candidateEvent, event);
    assert.equal(tool, "airbrush");
    return hit;
  };
  editor.scheduleTextureAirbrushPrewarm = (candidateEvent, candidateHit) => {
    prewarmCall = { event: candidateEvent, hit: candidateHit };
    return true;
  };

  assert.equal(editor.showTextureStrokeCursor(event), true);
  assert.deepEqual(prewarmCall, { event, hit });
});

test("layer airbrush pointer down skips synchronous hit-test prewarm before queueing paint", () => {
  class PointerDownEditor {}
  installPaintToolMethods(PointerDownEditor, {});
  const editor = new PointerDownEditor();
  let queuedPaint = 0;
  let prevented = 0;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.texturePaintLayerModeActive = () => true;
  editor.textureBrushCursor = {
    hidden: false,
    classList: {
      remove() {}
    }
  };
  editor.canvas = {
    setPointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.rememberBrushCursorEvent = () => true;
  editor.showTextureBrushCursorElement = () => true;
  editor.setTextureBrushCursorMode = () => true;
  editor.positionBrushCursor = () => true;
  editor.texturePaintHitForEvent = () => {
    throw new Error("pointer-down should not synchronously raycast just to prewarm a layer stroke");
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    throw new Error("pointer-down should not schedule layer prewarm through the cursor path");
  };
  editor.textureAirbrushRefreshLayerHitSeedFromEvent = () => {
    throw new Error("pointer-down should not refresh the layer hit seed before queueing paint");
  };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    queuedPaint += 1;
    assert.deepEqual(options, { reset: true });
  };

  editor.onPointerDown({
    button: 0,
    pointerId: 7,
    clientX: 20,
    clientY: 30,
    preventDefault() {
      prevented += 1;
    }
  });

  assert.equal(prevented, 1);
  assert.equal(queuedPaint, 1);
  assert.equal(editor.painting, true);
  assert.equal(editor.controls.enabled, false);
});

test("active layer airbrush cursor updates skip synchronous hit-test prewarm while painting", () => {
  class PointerDownEditor {}
  installPaintToolMethods(PointerDownEditor, {});
  const editor = new PointerDownEditor();
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureBrushCursor = {
    hidden: false,
    classList: {
      remove() {}
    }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    }
  };
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.rememberBrushCursorEvent = () => true;
  editor.showTextureBrushCursorElement = () => true;
  editor.setTextureBrushCursorMode = () => true;
  editor.positionBrushCursor = () => true;
  editor.texturePaintHitForEvent = () => {
    throw new Error("painting cursor movement should stay lightweight");
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    throw new Error("painting cursor movement should not schedule prewarm from a hit-test");
  };

  assert.equal(editor.showTextureStrokeCursor({ clientX: 20, clientY: 30 }), true);
});

test("airbrush brush cursor reuses stage bounds while painting", () => {
  class PointerEditor {}
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  let canvasRectReads = 0;
  let stageRectReads = 0;
  const cursor = {
    hidden: false,
    style: {},
    classList: {
      remove() {}
    }
  };
  editor.textureBrushCursor = cursor;
  editor.painting = true;
  editor.canvas = {
    parentElement: {
      getBoundingClientRect() {
        stageRectReads += 1;
        return { left: 10, top: 20 };
      }
    },
    getBoundingClientRect() {
      canvasRectReads += 1;
      return { left: 10, top: 20, right: 110, bottom: 120 };
    }
  };

  const remembered = editor.rememberBrushCursorEvent({ clientX: 30, clientY: 50 });
  assert.deepEqual(remembered, {
    clientX: 30,
    clientY: 50
  });
  assert.equal(editor.rememberBrushCursorEvent({ clientX: 36, clientY: 62 }), remembered);
  assert.deepEqual(remembered, {
    clientX: 36,
    clientY: 62
  });
  editor.positionBrushCursor({ clientX: 30, clientY: 50 }, 5);
  editor.positionBrushCursor({ clientX: 36, clientY: 62 }, 5);

  assert.equal(canvasRectReads, 1);
  assert.equal(stageRectReads, 1);
  assert.equal(cursor.style.width, "10px");
  assert.equal(cursor.style.height, "10px");
  assert.equal(cursor.style.left, undefined);
  assert.equal(cursor.style.top, undefined);
  assert.equal(cursor.style.transform, "translate3d(21px, 37px, 0)");

  editor.hideTextureBrushCursor();
  editor.rememberBrushCursorEvent({ clientX: 42, clientY: 68 });
  editor.positionBrushCursor({ clientX: 42, clientY: 68 }, 5);

  assert.equal(canvasRectReads, 2);
  assert.equal(stageRectReads, 2);
});

test("airbrush brush cursor skips subpixel duplicate transform writes", () => {
  class PointerEditor {}
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  const transforms = [];
  const style = {
    set transform(value) {
      transforms.push(value);
      this.lastTransform = value;
    },
    get transform() {
      return this.lastTransform;
    }
  };
  editor.textureBrushCursor = {
    hidden: false,
    style,
    classList: {
      remove() {}
    }
  };
  editor.painting = true;
  editor.canvas = {
    parentElement: {
      getBoundingClientRect() {
        return { left: 10, top: 20 };
      }
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, right: 110, bottom: 120 };
    }
  };

  editor.positionBrushCursor({ clientX: 30, clientY: 50 }, 5);
  const firstState = editor.textureBrushCursorPositionState;
  editor.positionBrushCursor({ clientX: 30.04, clientY: 50.04 }, 5);
  assert.equal(editor.textureBrushCursorPositionState, firstState);
  editor.positionBrushCursor({ clientX: 30.2, clientY: 50 }, 5);
  assert.notEqual(editor.textureBrushCursorPositionState, firstState);

  assert.deepEqual(transforms, [
    "translate3d(15px, 25px, 0)",
    "translate3d(15.25px, 25px, 0)"
  ]);
});

test("airbrush brush cursor cleans stale classes even when the mode is unchanged", () => {
  class PointerEditor {}
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  const toggles = [];
  const removes = [];
  editor.textureBrushCursor = {
    hidden: false,
    classList: {
      toggle(name, value) {
        toggles.push([name, value]);
      },
      remove(...names) {
        removes.push(names);
      }
    }
  };

  assert.equal(editor.setTextureBrushCursorMode("airbrush"), true);
  assert.equal(editor.setTextureBrushCursorMode("airbrush"), false);
  assert.deepEqual(toggles, [
    ["is-clone", false],
    ["is-selection", false],
    ["is-deselect", false],
    ["is-clone", false],
    ["is-selection", false],
    ["is-deselect", false]
  ]);

  assert.equal(editor.setTextureBrushCursorMode("clone"), true);
  assert.equal(toggles.length, 9);

  editor.hideTextureBrushCursor();
  assert.equal(removes.length, 1);
  assert.equal(editor.setTextureBrushCursorMode("clone"), true);
  assert.equal(toggles.length, 12);
});

test("active airbrush cursor reuses cached stroke radius", () => {
  class PointerEditor {}
  installPaintToolMethods(PointerEditor, {});
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  let radiusReads = 0;
  const toggles = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.textureAirbrushStrokeBrushState = { radiusPixels: 14 };
  editor.textureBrushRadiusScreenPixels = () => {
    radiusReads += 1;
    return 99;
  };
  editor.textureBrushCursor = {
    hidden: true,
    style: {},
    classList: {
      toggle(name, value) {
        toggles.push([name, value]);
      },
      remove() {}
    }
  };
  editor.canvas = {
    parentElement: {
      getBoundingClientRect() {
        return { left: 10, top: 20 };
      }
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, right: 110, bottom: 120 };
    }
  };

  assert.equal(editor.showTextureStrokeCursor({ clientX: 40, clientY: 60 }), true);

  assert.equal(radiusReads, 0);
  assert.equal(editor.textureBrushCursor.style.width, "28px");
  assert.equal(editor.textureBrushCursor.style.height, "28px");
  assert.equal(editor.textureBrushCursor.style.transform, "translate3d(16px, 26px, 0)");
  assert.deepEqual(toggles, [
    ["is-clone", false],
    ["is-selection", false],
    ["is-deselect", false]
  ]);
});
