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
    transparent: true
  };
}

function installEditor() {
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
      }
    }
  });
  return WebGlLayerEditor;
}

function layerStackFixture() {
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    isEmpty: false
  };
  const topLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    isEmpty: true
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: { width: 64, height: 64 },
    activeLayerId: topLayer.id,
    layers: [lowerLayer, topLayer]
  };
  const material = {
    uuid: "layer-material",
    userData: { texturePaintLayerStack: stack }
  };
  const lowerTarget = {
    target: { texture: { uuid: "lower-texture" } },
    width: 64,
    height: 64,
    material,
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false,
    paintRevision: 1
  };
  const topTarget = {
    target: { name: "top-target", texture: { uuid: "top-texture" } },
    width: 64,
    height: 64,
    material,
    layer: topLayer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: true,
    paintRevision: 0
  };
  lowerLayer.gpuTarget = lowerTarget;
  topLayer.gpuTarget = topTarget;
  return { lowerLayer, topLayer, stack, material, lowerTarget, topTarget };
}

function warmTopLayerLiveShader(editor, material, targetEntry, underlayTexture = { uuid: "underlay-texture" }) {
  material.map = underlayTexture;
  material.userData.texturePaintLiveLayerShaderComposite = {
    shader: {
      uniforms: {
        texturePaintLiveLayerMap: { value: null },
        texturePaintLiveLayerOpacity: { value: 0 }
      }
    }
  };
  material.userData.texturePaintLiveLayerShaderCompileKey = targetEntry.target.texture.uuid;
  const underlayKey = editor.texturePaintLiveLayerUnderlayKey?.(targetEntry) || "";
  material.userData.texturePaintLiveLayerUnderlayGpuTarget = {
    target: { texture: underlayTexture },
    width: targetEntry.width,
    height: targetEntry.height,
    key: underlayKey,
    baseTexture: underlayTexture
  };
  targetEntry.liveCompositeTarget = {
    target: targetEntry.target,
    shaderComposite: true
  };
  targetEntry.liveCompositeBaseTexture = underlayTexture;
  targetEntry.liveCompositeLayer = targetEntry.layer;
  targetEntry.liveCompositeLayerCount = targetEntry.layerStack.layers.length;
  targetEntry.liveCompositeLayerIndex = targetEntry.layerStack.layers.indexOf(targetEntry.layer);
  targetEntry.liveCompositeLayerOpacity = targetEntry.layer.opacity ?? 1;
  targetEntry.liveCompositeUnderlayKey = underlayKey;
  targetEntry.liveCompositeLayerMutationSerial = editor.texturePaintLayerMutationSerialValue?.() ?? 0;
  return underlayTexture;
}

test("top paint layer over lower paint requires a warmed live shader composite", () => {
  const Editor = installEditor();
  const editor = new Editor();
  const { material, topTarget } = layerStackFixture();
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushPaintableMaterials = () => [{ material }];
  editor.texturePaintLayerMutationSerialValue = () => 0;

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(material), true);
  assert.equal(editor.textureAirbrushLayerTargetReadyForLiveReset(material), false);

  const underlayTexture = warmTopLayerLiveShader(editor, material, topTarget);

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(material), false);
  assert.equal(editor.textureAirbrushLayerTargetReadyForLiveReset(material), true);
  assert.equal(material.map, underlayTexture);
  assert.equal(
    material.userData.texturePaintLiveLayerShaderComposite.shader.uniforms.texturePaintLiveLayerMap.value,
    topTarget.target.texture
  );
});

test("top paint layer over lower paint uses a baked live display after painting the real target", () => {
  const Editor = installEditor();
  const editor = new Editor();
  const { material, topLayer, topTarget } = layerStackFixture();
  const underlayTexture = warmTopLayerLiveShader(editor, material, topTarget);
  const recordObject = { material };
  const record = { object: recordObject, geometry: { attributes: { uv: {} } } };
  const pass = {
    key: "0:0:layer-material",
    record,
    materialIndex: 0,
    material,
    targetEntry: topTarget,
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
  const renderTargets = [];
  const renderModes = [];
  let bakedDisplayRefreshes = 0;
  const bakedDisplayTexture = { uuid: "baked-display-texture" };
  let currentTarget = null;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.canvas = { getBoundingClientRect: () => rect };
  editor.camera = { matrixWorldInverse: { copy() {} }, projectionMatrix: { copy() {} } };
  editor.model = { updateMatrixWorld() {} };
  projectionFrame.canvas = editor.canvas;
  projectionFrame.camera = editor.camera;
  projectionFrame.model = editor.model;
  editor.renderer = {
    autoClear: true,
    getRenderTarget: () => currentTarget,
    setRenderTarget(target) {
      currentTarget = target;
    },
    render() {
      renderTargets.push(currentTarget);
      renderModes.push({
        useStrokeSourceTexture: shader.uniforms.useStrokeSourceTexture.value,
        useCurrentTargetTexture: shader.uniforms.useCurrentTargetTexture.value,
        strokeSourceClear: shader.uniforms.strokeSourceClear.value,
        blending: shader.blending,
        transparent: shader.transparent
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
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("warmed live layer paint should not synchronously composite the stack");
  };
  editor.queueTexturePaintLayerGpuComposite = () => {
    throw new Error("warmed live layer paint should not queue a delayed composite");
  };
  editor.texturePaintRefreshLiveBakedCompositeForLayerGpuPaint = (candidateMaterial, candidateTarget, liveComposite) => {
    assert.equal(candidateMaterial, material);
    assert.equal(candidateTarget, topTarget);
    assert.equal(liveComposite.shaderComposite, true);
    bakedDisplayRefreshes += 1;
    material.map = bakedDisplayTexture;
    return true;
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
  assert.deepEqual(renderTargets, [topTarget.target]);
  assert.equal(bakedDisplayRefreshes, 1);
  assert.deepEqual(renderModes, [
    {
      useStrokeSourceTexture: true,
      useCurrentTargetTexture: false,
      strokeSourceClear: true,
      blending: "no-blending",
      transparent: false
    }
  ]);
  assert.equal(editor.texturePaintNeedsExactFirstPaintDisplayRefresh, true);
  assert.equal(topLayer.isEmpty, false);
  assert.equal(topTarget.emptyTransparent, false);
  assert.equal(topTarget.paintRevision, 1);
  assert.equal(material.map, bakedDisplayTexture);
});
