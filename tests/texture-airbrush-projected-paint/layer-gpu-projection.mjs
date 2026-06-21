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

test("airbrush WebGL cached pass refreshes the opacity cap for each new stroke", () => {
  class WebGlProjectionEditor {}
  const THREE = {
    NoBlending: "no-blending",
    NormalBlending: "normal-blending",
    Vector2: class {
      constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
      }
    }
  };
  installTextureAirbrushWebGlBackendMethods(WebGlProjectionEditor, { THREE });
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
  const matrix = () => ({
    copy() {
      return this;
    }
  });
  const editor = new WebGlProjectionEditor();
  const firstSource = { name: "first-stroke-source" };
  const secondSource = { name: "second-stroke-source" };
  const currentSnapshotTexture = { name: "same-stroke-current-target" };
  let currentStroke = { label: "first", source: firstSource };
  const target = { name: "paint-target", texture: { name: "paint-texture" } };
  const material = { uuid: "material", map: target.texture };
  const record = {
    object: { material },
    geometry: { attributes: { uv: {} } }
  };
  const targetEntry = {
    target,
    width: 64,
    height: 64,
    paintRevision: 0
  };
  const shaderMaterial = {
    uniforms: {
      paintViewMatrix: { value: matrix() },
      paintProjectionMatrix: { value: matrix() },
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
      currentTargetTexture: { value: null },
      useCurrentTargetTexture: { value: false },
      strokeSourceClear: { value: false },
      eraseMode: { value: false }
    },
    blending: "previous-blending",
    transparent: true,
    needsUpdate: true
  };
  const renders = [];
  const captures = [];
  const currentSnapshots = [];
  let currentTarget = null;
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget(nextTarget) {
      currentTarget = nextTarget;
    },
    render() {
      renders.push({
        target: currentTarget,
        source: shaderMaterial.uniforms.strokeSourceTexture.value,
        useStrokeSource: shaderMaterial.uniforms.useStrokeSourceTexture.value,
        current: shaderMaterial.uniforms.currentTargetTexture.value,
        useCurrentTarget: shaderMaterial.uniforms.useCurrentTargetTexture.value
      });
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
  editor.model = {};
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintActiveStrokeUndo = () => currentStroke;
  editor.captureTexturePaintGpuUndoTarget = () => {
    captures.push(currentStroke);
    return true;
  };
  editor.texturePaintGpuStrokeSourceSnapshot = () => ({ texture: currentStroke.source });
  editor.texturePaintGpuTargetRevision = (candidateTargetEntry) => candidateTargetEntry?.paintRevision || 0;
  editor.textureAirbrushCurrentTargetSnapshot = (candidateTargetEntry) => {
    currentSnapshots.push(candidateTargetEntry);
    return { texture: currentSnapshotTexture };
  };
  editor.markTexturePaintGpuTargetMutated = (candidateTargetEntry) => {
    candidateTargetEntry.paintRevision = (candidateTargetEntry.paintRevision || 0) + 1;
  };
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};
  const projectionFrame = {
    canvas: editor.canvas,
    camera: editor.camera,
    model: editor.model,
    rect: { left: 0, top: 0, width: 100, height: 100 },
    frameKey: "",
    paintRecords: [record],
    paintObjects: [record.object],
    recordByObject: new Map([[record.object, record]]),
    recordIndices: new Map([[record, 0]]),
    paintPassCache: new Map([["0:0:material", {
      key: "0:0:material",
      record,
      materialIndex: 0,
      material,
      targetEntry,
      undoCaptured: false
    }]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map(),
    paintPassCacheSeeded: true
  };
  const paint = (x) => editor.textureAirbrushGpuProjectFromEvent({ clientX: x, clientY: 5 }, {
    gpu: true,
    projectionFrame,
    strokeSegments: [{
      start: { clientX: 5, clientY: 5 },
      end: { clientX: x, clientY: 5 }
    }],
    radiusPixels: 4,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true
  });

  assert.equal(paint(20) > 0, true);
  assert.equal(paint(24) > 0, true);
  currentStroke = { label: "second", source: secondSource };
  assert.equal(paint(30) > 0, true);

  assert.deepEqual(captures.map((stroke) => stroke.label), ["first", "second"]);
  assert.deepEqual(renders.map((render) => render.source), [firstSource, firstSource, secondSource]);
  assert.deepEqual(renders.map((render) => render.useStrokeSource), [true, true, true]);
  assert.deepEqual(renders.map((render) => render.current), [null, currentSnapshotTexture, null]);
  assert.deepEqual(renders.map((render) => render.useCurrentTarget), [false, true, false]);
  assert.deepEqual(currentSnapshots, [targetEntry]);
});

test("top layer GPU live paint uses a shader composite without duplicate brush renders", () => {
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
      CanvasTexture: class {
        constructor(canvas) {
          this.image = canvas;
        }
      },
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlLayerEditor();
  const renderTargets = [];
  let currentTarget = { name: "previous-target" };
  let queuedComposites = 0;
  let fullComposites = 0;
  const layerTarget = { name: "layer-target", texture: { name: "layer-texture" } };
  const compositeTarget = { name: "composite-target", texture: { name: "composite-texture" } };
  let liveDisplayRestores = 0;
  let fastLayerDisplays = 0;
  let exactDisplayComposites = 0;
  const layer = {
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: {},
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: {},
    layers: [layer]
  };
  const material = {
    uuid: "material-layer-live-composite",
    map: compositeTarget.texture,
    userData: {
      clonePaintTexture: { name: "base-source-texture" },
      texturePaintLayerStack: stack,
      texturePaintCompositeGpuTarget: {
        target: compositeTarget,
        width: 64,
        height: 64
      }
    },
    needsUpdate: false
  };
  const layerTargetEntry = {
    target: layerTarget,
    width: 64,
    height: 64,
    material,
    layer,
    layerStack: stack,
    layerMode: true,
    paintRevision: 1
  };
  layer.gpuTarget = layerTargetEntry;
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
    render() {
      renderTargets.push(currentTarget?.name || "unknown");
    }
  };
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
  editor.textureAirbrushGpuTargetForMaterial = () => layerTargetEntry;
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
  editor.texturePaintCompositeMaterialLayerDisplay = (candidateMaterial, options = {}) => {
    exactDisplayComposites += 1;
    assert.equal(candidateMaterial, material);
    assert.equal(options.changedLayer, layer);
    assert.equal(options.live, false);
    assert.equal(layer.isEmpty, false);
    assert.equal(layerTargetEntry.emptyTransparent, false);
    return true;
  };
  editor.texturePaintFastMaterialLayerDisplay = (candidateMaterial, options = {}) => {
    fastLayerDisplays += 1;
    assert.equal(candidateMaterial, material);
    assert.equal(options.changedLayer, layer);
    assert.equal(layer.isEmpty, false);
    assert.equal(layerTargetEntry.emptyTransparent, false);
    return editor.texturePaintRestoreLiveLayerShaderDisplayState(candidateMaterial, layerTargetEntry, {
      shaderComposite: true
    });
  };
  editor.texturePaintRestoreLiveLayerShaderDisplayState = (candidateMaterial, candidateTargetEntry, liveComposite) => {
    liveDisplayRestores += 1;
    assert.equal(candidateMaterial, material);
    assert.equal(candidateTargetEntry, layerTargetEntry);
    assert.equal(liveComposite.shaderComposite, true);
    return true;
  };
  editor.markTexturePaintGpuTargetMutated = (candidateTargetEntry) => {
    candidateTargetEntry.paintRevision = (candidateTargetEntry.paintRevision || 0) + 1;
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
  assert.deepEqual(renderTargets, ["layer-target"]);
  assert.equal(queuedComposites, 0);
  assert.equal(fullComposites, 0);
  assert.equal(exactDisplayComposites, 0);
  assert.equal(fastLayerDisplays, 1);
  assert.equal(liveDisplayRestores, 1);
  assert.equal(material.map, stack.baseTexture);
  assert.equal(typeof material.onBeforeCompile, "function");
  assert.equal(typeof material.customProgramCacheKey, "function");
  const shader = {
    uniforms: {},
    fragmentShader: [
      "#include <map_pars_fragment>",
      "void main() {",
      "  vec4 diffuseColor = vec4(1.0);",
      "  #include <map_fragment>",
      "}"
    ].join("\n")
  };
  material.onBeforeCompile(shader, {});
  assert.equal(shader.uniforms.texturePaintLiveLayerMap.value, layerTarget.texture);
  assert.equal(shader.fragmentShader.includes("texturePaintLiveLayerMap"), true);
  assert.equal(shader.fragmentShader.includes("mix("), true);

  renderTargets.length = 0;
  queuedComposites = 0;
  fullComposites = 0;
  exactDisplayComposites = 0;
  fastLayerDisplays = 0;
  layerTargetEntry.forceDisplayCompositeOnce = true;

  const forcedChanged = editor.textureAirbrushGpuProjectFromEvent({ clientX: 28, clientY: 16 }, {
    gpu: true,
    deferLayerComposite: true,
    strokeSegments: [{
      start: { clientX: 24, clientY: 16 },
      end: { clientX: 28, clientY: 16 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    pressureApplied: true
  });

  assert.equal(forcedChanged > 0, true);
  assert.deepEqual(renderTargets, ["layer-target"]);
  assert.equal(queuedComposites, 0);
  assert.equal(fullComposites, 0);
  assert.equal(exactDisplayComposites, 0);
  assert.equal(fastLayerDisplays, 1);
  assert.equal(liveDisplayRestores, 2);
  assert.equal(layerTargetEntry.forceDisplayCompositeOnce, false);

  renderTargets.length = 0;
  queuedComposites = 0;
  fullComposites = 0;
  exactDisplayComposites = 0;
  fastLayerDisplays = 0;
  layer.isEmpty = true;
  layerTargetEntry.emptyTransparent = true;
  layerTargetEntry.paintRevision = 7;

  const emptyLayerChanged = editor.textureAirbrushGpuProjectFromEvent({ clientX: 32, clientY: 16 }, {
    gpu: true,
    deferLayerComposite: true,
    strokeSegments: [{
      start: { clientX: 28, clientY: 16 },
      end: { clientX: 32, clientY: 16 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    pressureApplied: true
  });

  assert.equal(emptyLayerChanged > 0, true);
  assert.deepEqual(renderTargets, ["layer-target"]);
  assert.equal(queuedComposites, 0);
  assert.equal(fullComposites, 0);
  assert.equal(exactDisplayComposites, 0);
  assert.equal(fastLayerDisplays, 1);
  assert.equal(editor.texturePaintNeedsExactFirstPaintDisplayRefresh, true);
  assert.equal(layer.isEmpty, false);
  assert.equal(layerTargetEntry.emptyTransparent, false);
});

test("layer GPU projection reuses the warmed active layer target during live paint", () => {
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
      NormalBlending: "normal-blending"
    }
  });
  const editor = new WebGlLayerEditor();
  const renderTargets = [];
  let currentTarget = { name: "previous-target" };
  let undoCaptures = 0;
  let sourceSnapshotLookups = 0;
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
    baseCanvas: {},
    activeLayerId: layer.id,
    layers: [layer]
  };
  const material = {
    uuid: "material-warmed-layer-projection",
    map: { name: "base-texture" },
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const layerTarget = { name: "active-layer-target", texture: { name: "active-layer-texture" } };
  const layerTargetEntry = {
    target: layerTarget,
    width: 64,
    height: 64,
    material,
    layer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  layer.gpuTarget = layerTargetEntry;
  const recordObject = { material };
  const record = {
    object: recordObject,
    geometry: { attributes: { uv: {} } }
  };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActivePaintLayerForStack = (candidateStack) => {
    assert.equal(candidateStack, stack);
    return { stack, layer };
  };
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return currentTarget;
    },
    setRenderTarget(target) {
      currentTarget = target;
    },
    render() {
      renderTargets.push(currentTarget?.name || "unknown");
    }
  };
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
  editor.texturePaintActiveLayerForMaterial = () => {
    throw new Error("live projection should not re-enter active layer setup");
  };
  editor.textureAirbrushGpuTargetForMaterial = () => {
    throw new Error("live projection should reuse the warmed layer target");
  };
  editor.texturePaintStrokeUndo = {
    label: "Texture airbrush",
    before: [],
    touched: new Map(),
    changed: false
  };
  editor.captureTexturePaintGpuUndoTarget = () => {
    undoCaptures += 1;
    return true;
  };
  editor.texturePaintGpuStrokeSourceSnapshot = () => {
    sourceSnapshotLookups += 1;
    return { clear: true };
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
      uvOffset: { value: vector() }
    },
    blending: "normal-blending",
    transparent: true,
    needsUpdate: false
  });
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.queueTexturePaintLayerGpuComposite = () => true;
  editor.markTexturePaintGpuTargetMutated = () => {};
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
  assert.deepEqual(renderTargets, ["active-layer-target"]);
  assert.equal(undoCaptures, 1);
  assert.equal(sourceSnapshotLookups, 1);
});

test("layer projection uses cached hover hit before raycasting reset stroke", () => {
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
    uuid: "material-cached-layer-hit",
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
  const rect = { left: 0, top: 0, width: 100, height: 100 };
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
    paintPassCache: new Map(),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map()
  };
  let currentTarget = null;
  let raycasts = 0;
  let renders = 0;
  editor.activeTool = "airbrush";
  editor.textureAirbrushCameraPrewarmSerial = 1;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActivePaintLayerForStack = (candidateStack) => {
    assert.equal(candidateStack, stack);
    return { stack, layer };
  };
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
  editor.model = {
    updateMatrixWorld() {}
  };
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
    setFromCamera() {},
    intersectObjects() {
      raycasts += 1;
      return [];
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
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {}, proxy: { skeleton: { update() {} } } });
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.captureTexturePaintGpuUndoTarget = () => true;
  editor.texturePaintGpuStrokeSourceSnapshot = () => ({ clear: true });
  editor.markTexturePaintGpuTargetMutated = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.textureAirbrushRememberLayerHitSeed({
    clientX: 20,
    clientY: 30
  }, {
    record,
    hit: { face: { materialIndex: 0 } }
  }, material), true);
  editor.textureAirbrushCameraPrewarmSerial = 2;
  assert.deepEqual(editor.textureAirbrushCachedLayerHitPassesForProbe(
    projectionFrame,
    { x: 20, y: 30 },
    { radiusPixels: 8 }
  ), []);
  editor.textureAirbrushCameraPrewarmSerial = 1;
  editor.textureAirbrushCachedLayerHitSeed.createdAt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - 5000;
  assert.equal(editor.textureAirbrushRefreshLayerHitSeedFromEvent({ clientX: 24, clientY: 30 }), true);
  assert.deepEqual(editor.textureAirbrushCachedLayerHitPassesForProbe(
    projectionFrame,
    { x: 24, y: 30 },
    { radiusPixels: 8 }
  ).map((pass) => pass.targetEntry), [targetEntry]);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 24, clientY: 30 }, {
    gpu: true,
    projectionFrame,
    strokeSegments: [{
      start: { clientX: 20, clientY: 30 },
      end: { clientX: 24, clientY: 30 }
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
  assert.equal(raycasts, 0);
  assert.equal(renders, 1);
  assert.equal(projectionFrame.paintPassCache.size, 1);
  assert.equal(projectionFrame.probePaintPassCache.get("24:30")?.[0]?.targetEntry, targetEntry);
});
