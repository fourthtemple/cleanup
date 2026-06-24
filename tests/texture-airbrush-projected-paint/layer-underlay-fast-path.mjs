import assert from "node:assert/strict";
import test from "node:test";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../../src/weight-editor/airbrush/constants.js";
import { installTextureAirbrushWebGlBackendMethods } from "../../src/weight-editor/airbrush/webgl-backend.js";

function vector() {
  return {
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
  };
}

function brushShaderMaterial() {
  return {
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
      currentTargetTexture: { value: null },
      useCurrentTargetTexture: { value: false },
      strokeSourceClear: { value: false },
      eraseMode: { value: false }
    },
    blending: "normal-blending",
    transparent: true,
    needsUpdate: false
  };
}

function installWebGlTestEditor(threeOverrides = {}) {
  class WebGlLayerEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlLayerEditor, {
    THREE: {
      NoBlending: "no-blending",
      NormalBlending: "normal-blending",
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      },
      ...threeOverrides
    }
  });
  return WebGlLayerEditor;
}

test("lower active layer can use the upper layer live underlay target", () => {
  const WebGlLayerEditor = installWebGlTestEditor();
  const editor = new WebGlLayerEditor();
  const underlayTarget = { texture: { uuid: "underlay" } };
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    activeLayerId: lowerLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  const material = {
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const lowerTarget = {
    target: { texture: { uuid: "lower" } },
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true
  };
  const upperTarget = {
    target: { texture: { uuid: "upper" } },
    layer: upperLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  lowerLayer.gpuTarget = lowerTarget;
  upperLayer.gpuTarget = upperTarget;
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, candidateTarget) => {
    assert.equal(candidateMaterial, material);
    assert.equal(candidateTarget, upperTarget);
    material.userData.texturePaintLiveLayerUnderlayGpuTarget = {
      target: underlayTarget,
      key: "before",
      width: 64,
      height: 64
    };
    return { target: upperTarget.target, shaderComposite: true };
  };

  const patchTarget = editor.texturePaintLiveUnderlayTargetForLayerGpuPaint(material, lowerTarget);

  assert.equal(patchTarget?.target, underlayTarget);
  assert.equal(patchTarget.underlayComposite, true);
  assert.equal(patchTarget.activeTargetEntry, lowerTarget);
  assert.equal(patchTarget.displayTargetEntry, upperTarget);
  assert.equal(patchTarget.skipLiveBrushRender, false);
  assert.equal(patchTarget.refreshUnderlayAfterPaint, false);
});

test("lower active layer opacity can still use the upper layer live underlay target", () => {
  const WebGlLayerEditor = installWebGlTestEditor();
  const editor = new WebGlLayerEditor();
  const underlayTarget = { texture: { uuid: "underlay" } };
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 0.43,
    isEmpty: false
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    activeLayerId: lowerLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  const material = {
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const lowerTarget = {
    target: { texture: { uuid: "lower" } },
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true
  };
  const upperTarget = {
    target: { texture: { uuid: "upper" } },
    layer: upperLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  lowerLayer.gpuTarget = lowerTarget;
  upperLayer.gpuTarget = upperTarget;
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => {
    material.userData.texturePaintLiveLayerUnderlayGpuTarget = {
      target: underlayTarget,
      key: "before",
      width: 64,
      height: 64,
      baseTexture: { uuid: "base" }
    };
    return { target: upperTarget.target, shaderComposite: true };
  };

  const patchTarget = editor.texturePaintLiveUnderlayTargetForLayerGpuPaint(material, lowerTarget);

  assert.equal(patchTarget?.target, underlayTarget);
  assert.equal(patchTarget.underlayComposite, true);
  assert.equal(patchTarget.activeLayerOpacity, 0.43);
  assert.equal(patchTarget.skipLiveBrushRender, false);
  assert.equal(patchTarget.refreshUnderlayAfterPaint, false);
});

test("empty lower active opacity layer creates a base underlay for the first stroke", () => {
  let createdTargets = 0;
  const WebGlLayerEditor = installWebGlTestEditor({
    WebGLRenderTarget: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.texture = { uuid: `created-underlay-${createdTargets}` };
        createdTargets += 1;
      }
      dispose() {}
    }
  });
  const editor = new WebGlLayerEditor();
  const baseTexture = { uuid: "base-texture" };
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 0.43,
    isEmpty: true
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: { width: 64, height: 64 },
    activeLayerId: lowerLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  const material = {
    map: baseTexture,
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const lowerTarget = {
    target: { texture: { uuid: "lower" } },
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: true
  };
  const upperTarget = {
    target: { texture: { uuid: "upper" } },
    layer: upperLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  lowerLayer.gpuTarget = lowerTarget;
  upperLayer.gpuTarget = upperTarget;
  const copies = [];
  editor.renderer = {};
  editor.textureAirbrushCanvasTextureForLayerCanvas = (owner, key, canvas) => {
    assert.equal(owner, stack);
    assert.equal(key, "base");
    assert.equal(canvas, stack.baseCanvas);
    return baseTexture;
  };
  editor.textureAirbrushCopyTextureToTarget = (source, target) => {
    copies.push({ source, target });
    return true;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: upperTarget.target, shaderComposite: true });

  const patchTarget = editor.texturePaintLiveUnderlayTargetForLayerGpuPaint(material, lowerTarget);

  assert.equal(patchTarget?.underlayComposite, true);
  assert.equal(patchTarget.target.texture.uuid, "created-underlay-0");
  assert.equal(material.map, patchTarget.target.texture);
  assert.deepEqual(copies, [{ source: baseTexture, target: patchTarget.target }]);
  assert.equal(createdTargets, 1);
});

test("live layer underlay composites lower layers with their blend modes", () => {
  let createdTargets = 0;
  const WebGlLayerEditor = installWebGlTestEditor({
    WebGLRenderTarget: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.texture = { uuid: `underlay-target-${createdTargets}` };
        createdTargets += 1;
      }
      dispose() {}
    },
    Color: class {}
  });
  const editor = new WebGlLayerEditor();
  const baseTexture = { uuid: "base-texture" };
  const normalTexture = { uuid: "normal-layer" };
  const multiplyTexture = { uuid: "multiply-layer" };
  const lowerNormalLayer = {
    id: "paint-1",
    visible: true,
    opacity: 0.5,
    blendMode: "normal",
    isEmpty: false,
    gpuTarget: {
      target: { texture: normalTexture },
      paintRevision: 1
    }
  };
  const lowerMultiplyLayer = {
    id: "paint-2",
    visible: true,
    opacity: 0.75,
    blendMode: "multiply",
    isEmpty: false,
    gpuTarget: {
      target: { texture: multiplyTexture },
      paintRevision: 1
    }
  };
  const activeLayer = {
    id: "paint-3",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    isEmpty: true
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: { width: 64, height: 64 },
    activeLayerId: activeLayer.id,
    layers: [lowerNormalLayer, lowerMultiplyLayer, activeLayer]
  };
  const activeTarget = {
    target: { texture: { uuid: "active-layer" } },
    layer: activeLayer,
    layerStack: stack,
    layerMode: true
  };
  activeLayer.gpuTarget = activeTarget;
  const material = {
    map: baseTexture,
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const renderMaterials = [];
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return null;
    },
    setRenderTarget() {},
    getClearAlpha() {
      return 1;
    },
    getClearColor() {},
    setClearColor() {},
    clear() {},
    render() {
      renderMaterials.push(editor.textureAirbrushGpuCopyMesh.material);
    }
  };
  editor.textureAirbrushGpuCopyScene = {};
  editor.textureAirbrushGpuCopyCamera = {};
  editor.textureAirbrushGpuCopyMesh = { material: null };
  editor.textureAirbrushEnsureCopyScene = () => {};
  editor.textureAirbrushRenderTextureSettings = () => ({});
  editor.textureAirbrushCopyTextureRenderSettings = () => true;
  editor.textureAirbrushWithRawTextureMatrix = (texture, callback) => callback();
  editor.texturePaintLayerMutationSerialValue = () => 1;
  editor.texturePaintLayerBlendMode = (layer) => layer?.blendMode || "normal";
  editor.texturePaintGpuTargetRevision = (targetEntry) => targetEntry?.paintRevision || 0;
  editor.textureAirbrushLayerCompositeMaterial = (opacity) => ({
    kind: "copy",
    opacity,
    map: null,
    needsUpdate: false
  });
  editor.textureAirbrushLayerBlendCompositeMaterial = (blendMode, opacity) => ({
    kind: "blend",
    blendMode,
    opacity,
    uniforms: {
      baseTexture: { value: null },
      layerTexture: { value: null }
    }
  });

  const underlay = editor.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint(
    material,
    activeTarget,
    baseTexture
  );

  assert.equal(underlay?.texture, material.userData.texturePaintLiveLayerUnderlayGpuTarget.target.texture);
  assert.equal(underlay.texture.uuid, "underlay-target-1");
  assert.equal(material.userData.texturePaintLiveLayerUnderlayGpuTarget.stagingTarget.texture.uuid, "underlay-target-0");
  assert.deepEqual(renderMaterials.map((entry) => entry.kind), ["copy", "copy", "blend"]);
  const blendMaterial = renderMaterials.find((entry) => entry.kind === "blend");
  assert.equal(blendMaterial.blendMode, "multiply");
  assert.equal(blendMaterial.opacity, 0.75);
  assert.equal(blendMaterial.uniforms.layerTexture.value, multiplyTexture);
});

test("lower layer underlay patch readiness avoids requiring a full composite target", () => {
  const WebGlLayerEditor = installWebGlTestEditor();
  const editor = new WebGlLayerEditor();
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    activeLayerId: lowerLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  const material = {
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const lowerTarget = {
    target: { texture: { uuid: "lower" } },
    width: 64,
    height: 64,
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  lowerLayer.gpuTarget = lowerTarget;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushPaintableMaterials = () => [{ material }];
  editor.texturePaintGpuPrewarmSnapshotCurrent = (targetEntry) => {
    assert.equal(targetEntry, lowerTarget);
    return true;
  };
  const underlayOptions = [];
  editor.texturePaintLiveUnderlayTargetForLayerGpuPaint = (candidateMaterial, targetEntry, options) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, lowerTarget);
    underlayOptions.push(options);
    return { target: { texture: { uuid: "underlay" } }, underlayComposite: true };
  };

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(material), false);
  assert.equal(editor.textureAirbrushLayerTargetReadyForLiveReset(material), true);
  assert.deepEqual(underlayOptions, [
    { cachedOnly: true },
    { cachedOnly: true }
  ]);
});

test("lower layer material prewarm uses the underlay patch path before full composite", () => {
  const WebGlLayerEditor = installWebGlTestEditor();
  const editor = new WebGlLayerEditor();
  const material = {
    userData: {
      texturePaintLayerStack: {}
    }
  };
  const targetEntry = {
    target: { texture: { uuid: "lower" } },
    width: 64,
    height: 64,
    layerMode: true
  };
  let underlayPrewarms = 0;
  let uvPrewarms = 0;
  editor.renderer = {};
  editor.textureAirbrushGpuLayerTargetForMaterial = (candidateMaterial, options) => {
    assert.equal(candidateMaterial, material);
    assert.deepEqual(options, {
      renderPanel: false,
      setActiveMaterial: false
    });
    return targetEntry;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.texturePaintLiveUnderlayTargetForLayerGpuPaint = (candidateMaterial, candidateTarget) => {
    assert.equal(candidateMaterial, material);
    assert.equal(candidateTarget, targetEntry);
    underlayPrewarms += 1;
    return { target: { texture: { uuid: "underlay" } }, underlayComposite: true };
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("lower layer material prewarm should not build a full composite when underlay is available");
  };
  editor.textureAirbrushPrewarmUvBleedOffsets = (candidateTarget) => {
    assert.equal(candidateTarget, targetEntry);
    uvPrewarms += 1;
  };

  assert.equal(editor.textureAirbrushPrewarmLayerMaterial(null, 0, material, { strokeSource: false }), true);
  assert.equal(underlayPrewarms, 1);
  assert.equal(uvPrewarms, 1);
});

test("lower layer projection paints the live underlay instead of queuing a full composite", () => {
  const WebGlLayerEditor = installWebGlTestEditor();
  const editor = new WebGlLayerEditor();
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    canvas: {},
    isEmpty: false
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    canvas: {},
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    activeLayerId: lowerLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  const material = {
    uuid: "material-underlay-fast-path",
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const lowerTarget = {
    target: { name: "lower-target", texture: { uuid: "lower-texture" } },
    width: 64,
    height: 64,
    material,
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  const upperTarget = {
    target: { name: "upper-target", texture: { uuid: "upper-texture" } },
    width: 64,
    height: 64,
    material,
    layer: upperLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  const underlayTarget = { name: "underlay-target", texture: { uuid: "underlay-texture" } };
  lowerLayer.gpuTarget = lowerTarget;
  upperLayer.gpuTarget = upperTarget;
  const recordObject = { material };
  const record = {
    object: recordObject,
    geometry: { attributes: { uv: {} } }
  };
  const pass = {
    key: "0:0:material-underlay-fast-path",
    record,
    materialIndex: 0,
    material,
    targetEntry: lowerTarget,
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
    paintPassCache: new Map([[pass.key, pass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[pass.key, { scene: {}, proxy: { skeleton: { update() {} } } }]])
  };
  const renderEntries = [];
  let currentTarget = null;
  let refreshedUnderlay = 0;
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
      renderEntries.push({
        target: currentTarget,
        useStrokeSourceTexture: brushShader.uniforms.useStrokeSourceTexture.value,
        useCurrentTargetTexture: brushShader.uniforms.useCurrentTargetTexture.value,
        strokeSourceClear: brushShader.uniforms.strokeSourceClear.value,
        blending: brushShader.blending,
        transparent: brushShader.transparent
      });
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  const brushShader = brushShaderMaterial();
  editor.textureAirbrushBrushShaderMaterial = () => brushShader;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.texturePaintLiveUnderlayTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, lowerTarget);
    return {
      target: underlayTarget,
      shaderComposite: true,
      underlayComposite: true,
      activeTargetEntry: lowerTarget,
      displayTargetEntry: upperTarget
    };
  };
  editor.texturePaintRefreshLiveUnderlayPatchForLayerGpuPaint = (candidateMaterial, targetEntry, patchTarget) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, lowerTarget);
    assert.equal(patchTarget.target, underlayTarget);
    refreshedUnderlay += 1;
    return true;
  };
  editor.queueTexturePaintLayerGpuComposite = () => {
    throw new Error("lower layer live paint should patch the underlay instead of queuing a full composite");
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("lower layer live paint should not synchronously composite layers");
  };
  editor.captureTexturePaintGpuUndoTarget = () => true;
  editor.texturePaintGpuStrokeSourceSnapshot = () => ({ clear: true });
  editor.markTexturePaintGpuTargetMutated = (targetEntry) => {
    targetEntry.paintRevision = (targetEntry.paintRevision || 0) + 1;
  };
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 92, clientY: 30 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
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
  assert.deepEqual(renderEntries.map((entry) => entry.target), [lowerTarget.target, underlayTarget]);
  assert.deepEqual(renderEntries.map((entry) => entry.useStrokeSourceTexture), [true, false]);
  assert.deepEqual(renderEntries.map((entry) => entry.useCurrentTargetTexture), [false, false]);
  assert.deepEqual(renderEntries.map((entry) => entry.strokeSourceClear), [true, false]);
  assert.deepEqual(renderEntries.map((entry) => entry.blending), ["no-blending", "normal-blending"]);
  assert.deepEqual(renderEntries.map((entry) => entry.transparent), [false, true]);
  assert.equal(refreshedUnderlay, 1);
  assert.equal(lowerTarget.paintRevision, 1);
});

test("lower opacity layer projection paints a scaled live underlay instead of full compositing", () => {
  const WebGlLayerEditor = installWebGlTestEditor();
  const editor = new WebGlLayerEditor();
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 0.43,
    canvas: {},
    isEmpty: false
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    canvas: {},
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    activeLayerId: lowerLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  const material = {
    uuid: "material-underlay-opacity-fast-path",
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const lowerTarget = {
    target: { name: "lower-target", texture: { uuid: "lower-texture" } },
    width: 64,
    height: 64,
    material,
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  const upperTarget = {
    target: { name: "upper-target", texture: { uuid: "upper-texture" } },
    width: 64,
    height: 64,
    material,
    layer: upperLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  const underlayTarget = { name: "underlay-target", texture: { uuid: "underlay-texture" } };
  lowerLayer.gpuTarget = lowerTarget;
  upperLayer.gpuTarget = upperTarget;
  const recordObject = { material };
  const record = {
    object: recordObject,
    geometry: { attributes: { uv: {} } }
  };
  const pass = {
    key: "0:0:material-underlay-opacity-fast-path",
    record,
    materialIndex: 0,
    material,
    targetEntry: lowerTarget,
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
    paintPassCache: new Map([[pass.key, pass]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[pass.key, { scene: {}, proxy: { skeleton: { update() {} } } }]])
  };
  const shader = brushShaderMaterial();
  const renderEntries = [];
  let currentTarget = null;
  let refreshedUnderlay = 0;
  let queuedUnderlayRefresh = 0;
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
      renderEntries.push({
        target: currentTarget,
        brushOpacity: shader.uniforms.brushOpacity.value,
        useStrokeSourceTexture: shader.uniforms.useStrokeSourceTexture.value,
        blending: shader.blending
      });
    }
  };
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shader;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.texturePaintLiveUnderlayTargetForLayerGpuPaint = () => ({
    target: underlayTarget,
    shaderComposite: true,
    underlayComposite: true,
    skipLiveBrushRender: false,
    refreshUnderlayAfterPaint: false,
    activeLayerOpacity: 0.43,
    activeTargetEntry: lowerTarget,
    displayTargetEntry: upperTarget
  });
  editor.texturePaintRefreshLiveUnderlayPatchForLayerGpuPaint = (candidateMaterial, targetEntry, patchTarget) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, lowerTarget);
    assert.equal(patchTarget.target, underlayTarget);
    assert.equal(patchTarget.refreshUnderlayAfterPaint, false);
    refreshedUnderlay += 1;
    return true;
  };
  editor.queueTexturePaintLiveUnderlayRefresh = (candidateMaterial, displayTargetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(displayTargetEntry, upperTarget);
    queuedUnderlayRefresh += 1;
    return true;
  };
  editor.queueTexturePaintLayerGpuComposite = () => {
    throw new Error("lower opacity layer paint should refresh the underlay instead of queuing a full composite");
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("lower opacity layer paint should not synchronously composite layers");
  };
  editor.captureTexturePaintGpuUndoTarget = () => true;
  editor.texturePaintGpuStrokeSourceSnapshot = () => ({ clear: true });
  editor.markTexturePaintGpuTargetMutated = (targetEntry) => {
    targetEntry.paintRevision = (targetEntry.paintRevision || 0) + 1;
  };
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 92, clientY: 30 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
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
  assert.deepEqual(renderEntries.map((entry) => entry.target), [lowerTarget.target, underlayTarget]);
  assert.equal(renderEntries[0].brushOpacity, 0.42);
  assert.equal(Math.abs(renderEntries[1].brushOpacity - (0.42 * 0.43)) < 0.00001, true);
  assert.equal(renderEntries[1].useStrokeSourceTexture, false);
  assert.equal(refreshedUnderlay, 1);
  assert.equal(queuedUnderlayRefresh, 1);
  assert.equal(lowerTarget.paintRevision, 1);
});

test("lower layer opacity and visibility changes reuse the live underlay target", () => {
  let createdTargets = 0;
  let disposedTargets = 0;
  const WebGlLayerEditor = installWebGlTestEditor({
    WebGLRenderTarget: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.texture = { uuid: `underlay-${createdTargets}` };
        createdTargets += 1;
      }
      dispose() {
        disposedTargets += 1;
      }
    }
  });
  const editor = new WebGlLayerEditor();
  const baseTexture = { uuid: "base-texture" };
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "lower-texture" } }, paintRevision: 1 }
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    layers: [lowerLayer, upperLayer]
  };
  const upperTarget = {
    target: { texture: { uuid: "upper-texture" } },
    layer: upperLayer,
    layerStack: stack,
    layerMode: true
  };
  upperLayer.gpuTarget = upperTarget;
  const material = {
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const renderedTargets = [];
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return null;
    },
    setRenderTarget(target) {
      renderedTargets.push(target);
    },
    setClearColor() {},
    clear() {},
    render() {}
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    editor.textureAirbrushGpuCopyScene = {};
    editor.textureAirbrushGpuCopyCamera = {};
    editor.textureAirbrushGpuCopyMesh = {};
  };
  editor.textureAirbrushLayerCompositeMaterial = (opacity) => ({ opacity, map: null, needsUpdate: false });
  editor.textureAirbrushWithRawTextureMatrix = (texture, callback) => callback();
  editor.textureAirbrushCopyTextureRenderSettings = () => {};

  const first = editor.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint(
    material,
    upperTarget,
    baseTexture
  );
  lowerLayer.opacity = 0.42;
  const second = editor.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint(
    material,
    upperTarget,
    baseTexture
  );
  lowerLayer.visible = false;
  const hidden = editor.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint(
    material,
    upperTarget,
    baseTexture
  );
  lowerLayer.visible = true;
  const restored = editor.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint(
    material,
    upperTarget,
    baseTexture
  );

  assert.equal(first.texture, second.texture);
  assert.equal(restored.texture, first.texture);
  assert.equal(hidden.texture, baseTexture);
  assert.equal(createdTargets, 1);
  assert.equal(disposedTargets, 0);
  const underlayTarget = material.userData.texturePaintLiveLayerUnderlayGpuTarget.target;
  assert.equal(renderedTargets.some((target) => target === underlayTarget), true);
  assert.equal(renderedTargets.every((target) => target === null || target === underlayTarget), true);
});
