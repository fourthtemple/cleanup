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

test("installing the live layer shader marks the material for precompile", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = {
    userData: {},
    needsUpdate: false
  };

  const state = editor.texturePaintInstallLiveLayerShaderComposite(material);

  assert.equal(Boolean(state), true);
  assert.equal(material.needsUpdate, true);
});

test("live layer shader blends the layer over the background map with opacity", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = {
    userData: {},
    needsUpdate: false
  };

  const state = editor.texturePaintInstallLiveLayerShaderComposite(material);
  state.layerTexture = "layer-texture";
  state.layerOpacity = 0.35;
  state.layerBlendMode = 1;
  const shader = {
    uniforms: {},
    fragmentShader: "#include <map_pars_fragment>\n#include <map_fragment>"
  };

  material.onBeforeCompile(shader, {});

  assert.equal(shader.uniforms.texturePaintLiveLayerMap.value, "layer-texture");
  assert.equal(shader.uniforms.texturePaintLiveLayerOpacity.value, 0.35);
  assert.equal(shader.uniforms.texturePaintLiveLayerBlendMode.value, 1);
  assert.equal(shader.fragmentShader.includes("uniform float texturePaintLiveLayerOpacity"), true);
  assert.equal(shader.fragmentShader.includes("uniform int texturePaintLiveLayerBlendMode"), true);
  assert.equal(shader.fragmentShader.includes("texturePaintLiveBlendColor"), true);
  assert.equal(shader.fragmentShader.includes("sampledDiffuseColor.rgb"), true);
  assert.equal(
    shader.fragmentShader.includes("texturePaintLiveLayerColor.a * texturePaintLiveLayerOpacity"),
    true
  );
  assert.equal(material.customProgramCacheKey().includes("texture-paint-live-layer-v3"), true);
});

test("muting a hidden live layer keeps the shader warm for visibility restore", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const opacityUniform = { value: 0.72 };
  const material = {
    userData: {
      texturePaintLiveLayerShaderComposite: {
        layerOpacity: 0.72,
        shader: {
          uniforms: {
            texturePaintLiveLayerOpacity: opacityUniform
          }
        }
      }
    },
    needsUpdate: false
  };

  assert.equal(editor.texturePaintMuteLiveLayerShaderComposite(material), true);
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.layerOpacity, 0);
  assert.equal(opacityUniform.value, 0);
  assert.equal(Boolean(material.userData.texturePaintLiveLayerShaderComposite), true);
  assert.equal(material.needsUpdate, false);
});

test("reusing an uncompiled live layer shader dirties the material for viewport display", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const baseTexture = { uuid: "base-texture" };
  const layerTexture = { uuid: "paint-1-texture" };
  const layer = { visible: true, opacity: 1 };
  const stack = { layers: [layer] };
  const material = {
    map: baseTexture,
    userData: {
      texturePaintLiveLayerShaderComposite: {
        layerTexture: null,
        layerOpacity: 0,
        shader: null
      }
    },
    needsUpdate: false
  };
  const targetEntry = {
    target: { texture: layerTexture },
    layer,
    layerStack: stack
  };

  const liveComposite = editor.texturePaintUseLiveLayerShaderComposite(material, targetEntry, baseTexture);

  assert.equal(Boolean(liveComposite), true);
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.layerTexture, layerTexture);
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.layerOpacity, 1);
  assert.equal(material.needsUpdate, true);
});

test("clearing a layer GPU target makes it transparent and restores renderer state", () => {
  class WebGlClearEditor {}
  const previousColor = { name: "previous-clear-color" };
  const THREE = {
    Color: class {
      constructor() {
        this.name = "";
      }
    }
  };
  installTextureAirbrushWebGlBackendMethods(WebGlClearEditor, { THREE });
  const editor = new WebGlClearEditor();
  const previousTarget = { name: "previous-target" };
  const target = { name: "layer-target", texture: {} };
  const calls = [];
  editor.renderer = {
    autoClear: false,
    getRenderTarget() {
      return previousTarget;
    },
    setRenderTarget(nextTarget) {
      calls.push(["target", nextTarget]);
    },
    getClearAlpha() {
      return 0.42;
    },
    getClearColor(color) {
      color.name = previousColor.name;
    },
    setClearColor(color, alpha) {
      calls.push(["clearColor", color, alpha]);
    },
    clear(color, depth, stencil) {
      calls.push(["clear", color, depth, stencil]);
    }
  };
  let mutated = 0;
  editor.markTexturePaintGpuTargetMutated = (targetEntry) => {
    assert.equal(targetEntry.target, target);
    mutated += 1;
  };
  const entry = { target, emptyTransparent: false };

  assert.equal(editor.clearTexturePaintGpuTarget(entry), true);
  assert.equal(entry.emptyTransparent, true);
  assert.equal(mutated, 1);
  assert.equal(editor.renderer.autoClear, false);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.slice(0, 4), [
    ["target", target],
    ["clearColor", 0x000000, 0],
    ["clear", true, true, true],
    ["target", previousTarget]
  ]);
  assert.equal(calls[4][0], "clearColor");
  assert.equal(calls[4][1].name, previousColor.name);
  assert.equal(calls[4][2], 0.42);
});

test("paint render texture settings avoid mipmap filters for dynamic targets", () => {
  class WebGlSettingsEditor {}
  const THREE = {
    LinearFilter: "linear",
    LinearMipmapLinearFilter: "linear-mipmap-linear",
    LinearMipmapNearestFilter: "linear-mipmap-nearest",
    NearestMipmapLinearFilter: "nearest-mipmap-linear",
    NearestMipmapNearestFilter: "nearest-mipmap-nearest",
    ClampToEdgeWrapping: "clamp"
  };
  installTextureAirbrushWebGlBackendMethods(WebGlSettingsEditor, { THREE });
  const editor = new WebGlSettingsEditor();

  const settings = editor.textureAirbrushRenderTextureSettings({
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: "mag",
    wrapS: "wrap-s",
    wrapT: "wrap-t",
    generateMipmaps: true
  });

  assert.equal(settings.minFilter, THREE.LinearFilter);
  assert.equal(settings.magFilter, "mag");
  assert.equal(settings.wrapS, "wrap-s");
  assert.equal(settings.wrapT, "wrap-t");
  assert.equal(settings.generateMipmaps, false);
});

test("layer blend composite shader avoids Three helper name collisions", () => {
  class WebGlBlendEditor {}
  class ShaderMaterial {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  const THREE = {
    ShaderMaterial,
    NoBlending: "no-blending"
  };
  installTextureAirbrushWebGlBackendMethods(WebGlBlendEditor, { THREE });
  const editor = new WebGlBlendEditor();
  editor.texturePaintLayerBlendShaderCode = () => 12;

  const material = editor.textureAirbrushLayerBlendCompositeMaterial("hue", 0.5);

  assert.equal(material.uniforms.blendMode.value, 12);
  assert.equal(material.uniforms.layerOpacity.value, 0.5);
  assert.equal(material.fragmentShader.includes("float luminance("), false);
  assert.equal(material.fragmentShader.includes("float saturation("), false);
  assert.equal(material.fragmentShader.includes("texturePaintBlendLuminance"), true);
  assert.equal(material.fragmentShader.includes("texturePaintBlendSaturation"), true);
});

test("GPU layer recomposite renders offscreen before swapping the displayed texture", () => {
  class WebGlPrewarmEditor {}
  let targetSerial = 0;
  const THREE = {
    CanvasTexture: class {
      constructor(canvas) {
        this.image = canvas;
        this.uuid = `canvas-${targetSerial++}`;
      }
    },
    Color: class {},
    LinearFilter: "linear",
    ClampToEdgeWrapping: "clamp",
    MeshBasicMaterial: class {
      constructor(options = {}) {
        Object.assign(this, options);
      }
    },
    WebGLRenderTarget: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.texture = { uuid: `target-${targetSerial++}` };
      }
      dispose() {
        this.disposed = true;
      }
    }
  };
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE });
  const editor = new WebGlPrewarmEditor();
  const displayedTarget = {
    width: 2,
    height: 1,
    texture: { uuid: "currently-displayed-composite" }
  };
  let currentTarget = null;
  const clearedTargets = [];
  const renderedTargets = [];
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return null;
    },
    setRenderTarget(target) {
      currentTarget = target;
    },
    getClearAlpha() {
      return 1;
    },
    getClearColor() {},
    setClearColor() {},
    clear() {
      clearedTargets.push(currentTarget);
    },
    render() {
      renderedTargets.push(currentTarget);
    }
  };
  editor.textureAirbrushGpuCopyScene = {};
  editor.textureAirbrushGpuCopyCamera = {};
  editor.textureAirbrushGpuCopyMesh = { material: null };
  editor.textureAirbrushEnsureCopyScene = () => {};
  editor.textureAirbrushWithRawTextureMatrix = (texture, callback) => callback();
  const baseCanvas = { width: 2, height: 1 };
  const layerCanvas = { width: 2, height: 1 };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    canvas: layerCanvas
  };
  const material = {
    map: displayedTarget.texture,
    needsUpdate: false,
    userData: {
      clonePaintTexture: { uuid: "clone-texture" },
      texturePaintCompositeGpuTarget: {
        target: displayedTarget,
        scratchTarget: null,
        width: 2,
        height: 1
      },
      texturePaintLayerStack: {
        baseCanvas,
        width: 2,
        height: 1,
        layers: [layer]
      }
    }
  };

  assert.equal(editor.texturePaintCompositeMaterialLayerGpuTargets(material), true);

  assert.equal(clearedTargets.includes(displayedTarget), false);
  assert.equal(renderedTargets.includes(displayedTarget), false);
  assert.notEqual(material.map, displayedTarget.texture);
  assert.equal(material.userData.texturePaintCompositeGpuTarget.scratchTarget, displayedTarget);
});

test("active layer opacity updates reuse the live shader composite path", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const baseTexture = { name: "base-texture" };
  const layerTexture = { uuid: "opacity-layer-texture" };
  const cachedComposite = { target: { texture: layerTexture }, shaderComposite: true };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 0.45,
    isEmpty: true
  };
  const stack = {
    activeLayerId: layer.id,
    baseCanvas: {},
    layers: [layer]
  };
  const shaderUniform = { value: null };
  const opacityUniform = { value: 1 };
  const material = {
    map: baseTexture,
    userData: {
      texturePaintLiveLayerShaderCompileKey: layerTexture.uuid,
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: shaderUniform,
            texturePaintLiveLayerOpacity: opacityUniform
          }
        }
      },
      texturePaintLayerStack: stack
    }
  };
  const targetEntry = {
    target: cachedComposite.target,
    layer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: true,
    liveCompositeTarget: cachedComposite,
    liveCompositeBaseTexture: baseTexture,
    liveCompositeLayer: layer,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 0.45,
    liveCompositeUnderlayKey: "live-underlay-v1|7|0|0|0",
    liveCompositeLayerMutationSerial: 7
  };
  layer.gpuTarget = targetEntry;
  editor.texturePaintLayerMutationSerialValue = () => 7;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLiveLayerShaderCompositeForLayerGpuPaint = () => {
    throw new Error("semi-transparent active layer should reuse the live shader composite");
  };

  layer.opacity = 0.25;
  assert.equal(editor.texturePaintLayerCanUseLiveShaderComposite(material, targetEntry), true);
  assert.equal(editor.texturePaintLiveCompositeTargetForLayerGpuPaint(material, targetEntry), cachedComposite);
  assert.equal(shaderUniform.value, layerTexture);
  assert.equal(opacityUniform.value, 0.25);
  assert.equal(targetEntry.liveCompositeLayerOpacity, 0.25);
  assert.equal(editor.textureAirbrushLayerTargetReadyForLiveReset(material), true);
});

test("live shader composite uses non-normal layer modes over the background texture", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const baseCanvas = { width: 4, height: 4 };
  const baseTexture = { image: baseCanvas, uuid: "background-texture" };
  const layerTexture = { uuid: "multiply-layer-texture" };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 0.6,
    blendMode: "multiply",
    isEmpty: false
  };
  const stack = {
    width: 4,
    height: 4,
    activeLayerId: layer.id,
    baseCanvas,
    layers: [layer]
  };
  const material = {
    map: { uuid: "old-map" },
    userData: {
      texturePaintLayerStack: stack
    },
    needsUpdate: false
  };
  const targetEntry = {
    target: { texture: layerTexture },
    layer,
    layerStack: stack,
    layerMode: true
  };
  layer.gpuTarget = targetEntry;
  editor.texturePaintLayerMutationSerialValue = () => 11;
  editor.texturePaintLayerBlendMode = (candidateLayer) => candidateLayer?.blendMode || "normal";
  editor.texturePaintLayerBlendShaderCode = (mode) => (mode === "multiply" ? 1 : 0);
  editor.textureAirbrushCanvasTextureForLayerCanvas = (owner, key, canvas) => {
    assert.equal(owner, stack);
    assert.equal(key, "base");
    assert.equal(canvas, baseCanvas);
    return baseTexture;
  };
  editor.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint = () => ({
    texture: baseTexture,
    key: "background-only"
  });
  editor.texturePaintPrecompileLiveLayerShaderComposite = () => false;

  const composite = editor.texturePaintLiveCompositeTargetForLayerGpuPaint(material, targetEntry);

  assert.equal(composite?.target.texture, layerTexture);
  assert.equal(material.map, baseTexture);
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.layerBlendMode, 1);
  assert.equal(targetEntry.liveCompositeLayerBlendMode, "multiply");
  assert.equal(editor.texturePaintLayerCanUseLiveShaderComposite(material, targetEntry), true);
});

test("cached live shader composite is invalidated when the layer blend mode changes", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const baseTexture = { uuid: "background-texture" };
  const layerTexture = { uuid: "layer-texture" };
  const cachedComposite = { target: { texture: layerTexture }, shaderComposite: true };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    blendMode: "multiply",
    isEmpty: false
  };
  const stack = {
    activeLayerId: layer.id,
    baseCanvas: {},
    layers: [layer]
  };
  const material = {
    map: baseTexture,
    userData: {
      texturePaintLiveLayerShaderCompileKey: layerTexture.uuid,
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: { value: null },
            texturePaintLiveLayerOpacity: { value: 1 },
            texturePaintLiveLayerBlendMode: { value: 0 }
          }
        }
      },
      texturePaintLayerStack: stack
    }
  };
  const targetEntry = {
    target: cachedComposite.target,
    layer,
    layerStack: stack,
    layerMode: true,
    liveCompositeTarget: cachedComposite,
    liveCompositeBaseTexture: baseTexture,
    liveCompositeLayer: layer,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeLayerBlendMode: "normal",
    liveCompositeUnderlayKey: "",
    liveCompositeLayerMutationSerial: 5
  };
  layer.gpuTarget = targetEntry;
  editor.texturePaintLayerMutationSerialValue = () => 5;
  editor.texturePaintLayerBlendMode = (candidateLayer) => candidateLayer?.blendMode || "normal";
  editor.texturePaintLayerBlendShaderCode = (mode) => (mode === "multiply" ? 1 : 0);

  assert.equal(editor.texturePaintCachedLiveCompositeTargetForLayerGpuPaint(material, targetEntry), null);
});

test("layer live composite reuses a warmed shader target during stroke projection", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const baseTexture = { name: "base-texture" };
  const layerTexture = { uuid: "layer-texture-cache-key" };
  const cachedComposite = { target: { texture: layerTexture }, shaderComposite: true };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1
  };
  const stack = {
    layers: [layer]
  };
  const shaderUniform = { value: null };
  editor.texturePaintLayerMutationSerialValue = () => 7;
  editor.texturePaintLiveLayerUnderlayKey = () => {
    throw new Error("single warmed layer should not recompute the underlay key");
  };
  const material = {
    map: baseTexture,
    userData: {
      texturePaintLiveLayerShaderCompileKey: layerTexture.uuid,
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: shaderUniform
          }
        }
      },
      texturePaintLayerStack: stack
    }
  };
  const targetEntry = {
    target: cachedComposite.target,
    layer,
    layerStack: stack,
    layerMode: true,
    liveCompositeTarget: cachedComposite,
    liveCompositeBaseTexture: baseTexture,
    liveCompositeLayer: layer,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeUnderlayKey: "live-underlay-v1|7|0|0|0",
    liveCompositeLayerMutationSerial: 7
  };
  editor.texturePaintLiveLayerShaderCompositeForLayerGpuPaint = () => {
    throw new Error("warm live composite should not rebuild shader composite state");
  };

  assert.equal(editor.texturePaintLiveCompositeTargetForLayerGpuPaint(material, targetEntry), cachedComposite);
  assert.equal(shaderUniform.value, layerTexture);
});

test("layer prewarm detects a stale live underlay before the first stroke", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const baseTexture = { name: "base-texture" };
  const layerTexture = { uuid: "active-layer-texture" };
  const underlayTexture = { uuid: "underlay-texture" };
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false,
    gpuTarget: {
      target: { texture: { uuid: "lower-layer-texture" } }
    }
  };
  const activeLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: true
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: {},
    activeLayerId: activeLayer.id,
    layers: [lowerLayer, activeLayer]
  };
  const shaderUniform = { value: null };
  const material = {
    map: underlayTexture,
    userData: {
      texturePaintLayerStack: stack,
      texturePaintLiveLayerShaderCompileKey: layerTexture.uuid,
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: shaderUniform
          }
        }
      }
    }
  };
  const target = { texture: layerTexture };
  const targetEntry = {
    target,
    width: 64,
    height: 64,
    material,
    layer: activeLayer,
    layerStack: stack,
    layerMode: true,
    liveCompositeTarget: {
      target,
      shaderComposite: true
    },
    liveCompositeBaseTexture: underlayTexture,
    liveCompositeLayer: activeLayer,
    liveCompositeLayerCount: 2,
    liveCompositeLayerIndex: 1,
    liveCompositeLayerOpacity: 1,
    liveCompositeUnderlayKey: "old-underlay"
  };
  activeLayer.gpuTarget = targetEntry;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [{ material }];

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), true);

  const underlayKey = editor.texturePaintLiveLayerUnderlayKey(targetEntry);
  targetEntry.liveCompositeUnderlayKey = underlayKey;
  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), true);

  material.userData.texturePaintLiveLayerUnderlayGpuTarget = {
    target: { texture: underlayTexture },
    key: underlayKey,
    width: 64,
    height: 64,
    baseTexture
  };
  material.userData.texturePaintCompositeGpuTarget = { target: { texture: underlayTexture }, width: 64, height: 64 };
  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), false);
  assert.equal(material.map, underlayTexture);
});

test("live layer underlay key changes when lower layer paint revision changes", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false,
    gpuTarget: {
      target: { texture: { uuid: "lower-layer-texture" } },
      paintRevision: 4
    }
  };
  const activeLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    layers: [lowerLayer, activeLayer]
  };
  const targetEntry = {
    layer: activeLayer,
    layerStack: stack
  };
  editor.texturePaintLayerMutationSerialValue = () => 3;
  editor.texturePaintGpuTargetRevision = (candidateTarget) => candidateTarget?.paintRevision || 0;

  const firstKey = editor.texturePaintLiveLayerUnderlayKey(targetEntry);
  lowerLayer.gpuTarget.paintRevision = 5;
  const secondKey = editor.texturePaintLiveLayerUnderlayKey(targetEntry);

  assert.notEqual(firstKey, secondKey);
  assert.equal(firstKey.includes("lower-layer-texture|4"), true);
  assert.equal(secondKey.includes("lower-layer-texture|5"), true);
});

test("empty active layer does not require a stroke source prewarm before first paint", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: true
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: {},
    activeLayerId: layer.id,
    layers: [layer]
  };
  const targetEntry = {
    target: { texture: {} },
    width: 64,
    height: 64,
    layer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: true
  };
  layer.gpuTarget = targetEntry;
  const material = {
    userData: {
      texturePaintLayerStack: stack,
      texturePaintLiveLayerShaderCompileKey: "live-layer",
      texturePaintLiveLayerShaderComposite: {}
    }
  };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushPaintableMaterials = () => [{ material }];
  editor.texturePaintGpuPrewarmSnapshotCurrent = () => {
    throw new Error("empty layer should use a clear stroke source without prewarm validation");
  };
  editor.texturePaintCachedLiveLayerShaderComposite = (candidateMaterial, candidateTarget) => {
    assert.equal(candidateMaterial, material);
    assert.equal(candidateTarget, targetEntry);
    return { target: targetEntry.target, shaderComposite: true };
  };

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), false);
});

test("painted active layer still requires a current stroke source prewarm", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: {},
    activeLayerId: layer.id,
    layers: [layer]
  };
  const targetEntry = {
    target: { texture: {} },
    width: 64,
    height: 64,
    layer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: false
  };
  layer.gpuTarget = targetEntry;
  const material = {
    userData: {
      texturePaintLayerStack: stack,
      texturePaintLiveLayerShaderCompileKey: "live-layer",
      texturePaintLiveLayerShaderComposite: {}
    }
  };
  let snapshotChecks = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushPaintableMaterials = () => [{ material }];
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidateTarget) => {
    assert.equal(candidateTarget, targetEntry);
    snapshotChecks += 1;
    return false;
  };

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), true);
  assert.equal(snapshotChecks, 1);
});

test("painted GPU layers ignore stale CPU-empty flags for reset readiness", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: true
  };
  const stack = {
    width: 64,
    height: 64,
    baseCanvas: {},
    activeLayerId: layer.id,
    layers: [layer]
  };
  const targetEntry = {
    target: { texture: { uuid: "painted-gpu-layer" } },
    width: 64,
    height: 64,
    layer,
    layerStack: stack,
    layerMode: true,
    emptyTransparent: true,
    paintRevision: 3
  };
  layer.gpuTarget = targetEntry;
  const material = {
    userData: {
      texturePaintLayerStack: stack,
      texturePaintLiveLayerShaderCompileKey: targetEntry.target.texture.uuid,
      texturePaintLiveLayerShaderComposite: {}
    }
  };
  let snapshotWarm = false;
  let snapshotChecks = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushPaintableMaterials = () => [{ material }];
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidateTarget) => {
    assert.equal(candidateTarget, targetEntry);
    snapshotChecks += 1;
    return snapshotWarm;
  };
  editor.texturePaintLayerCanUseLiveShaderComposite = (candidateMaterial, candidateTarget) => (
    candidateMaterial === material && candidateTarget === targetEntry
  );
  editor.texturePaintCachedLiveLayerShaderComposite = (candidateMaterial, candidateTarget) => (
    candidateMaterial === material && candidateTarget === targetEntry
      ? { target: targetEntry.target, shaderComposite: true }
      : null
  );

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), true);
  assert.equal(editor.textureAirbrushLayerTargetReadyForLiveReset(), false);
  snapshotWarm = true;
  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), false);
  assert.equal(editor.textureAirbrushLayerTargetReadyForLiveReset(), true);
  assert.equal(snapshotChecks, 4);
});

test("active layer under empty visible layers still uses the live shader composite", () => {
  class WebGlPrewarmEditor {}
  const THREE = {
    CanvasTexture: class {
      constructor(canvas) {
        this.image = canvas;
      }
    },
    SRGBColorSpace: "srgb",
    ClampToEdgeWrapping: "clamp",
    LinearFilter: "linear"
  };
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE });
  const editor = new WebGlPrewarmEditor();
  const baseCanvas = { width: 64, height: 64 };
  const layerTexture = { uuid: "lower-active-layer-texture" };
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const emptyUpperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: true
  };
  const transparentUpperLayer = {
    id: "paint-3",
    visible: true,
    opacity: 0,
    isEmpty: false
  };
  const stack = {
    baseCanvas,
    layers: [lowerLayer, emptyUpperLayer, transparentUpperLayer]
  };
  const material = {
    map: { name: "source-map" },
    userData: {
      clonePaintTexture: { name: "base-source-texture" },
      texturePaintLayerStack: stack
    },
    needsUpdate: false
  };
  const targetEntry = {
    target: { texture: layerTexture },
    layer: lowerLayer,
    layerStack: stack,
    layerMode: true
  };
  lowerLayer.gpuTarget = targetEntry;
  emptyUpperLayer.gpuTarget = {
    target: { texture: { uuid: "empty-upper-texture" } },
    emptyTransparent: true
  };
  transparentUpperLayer.gpuTarget = {
    target: { texture: { uuid: "transparent-upper-texture" } },
    emptyTransparent: false
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("empty upper layers should not force the full layer composite");
  };

  const composite = editor.texturePaintLiveCompositeTargetForLayerGpuPaint(material, targetEntry);

  assert.equal(composite?.target, targetEntry.target);
  assert.equal(composite?.shaderComposite, true);
  assert.equal(typeof material.onBeforeCompile, "function");
  assert.equal(material.map.image, baseCanvas);
});

test("empty layer GPU target initialization clears instead of copying the empty canvas", () => {
  class WebGlPrewarmEditor {}
  const createdTargets = [];
  const THREE = {
    CanvasTexture: class {
      constructor(canvas) {
        this.image = canvas;
      }
    },
    WebGLRenderTarget: class {
      constructor(width, height, options) {
        this.width = width;
        this.height = height;
        this.options = options;
        this.texture = {};
        createdTargets.push(this);
      }

      dispose() {
        this.disposed = true;
      }
    },
    SRGBColorSpace: "srgb",
    ClampToEdgeWrapping: "clamp",
    LinearFilter: "linear"
  };
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE });
  const editor = new WebGlPrewarmEditor();
  const canvas = { width: 64, height: 32 };
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas,
    isEmpty: true
  };
  const stack = {
    width: canvas.width,
    height: canvas.height,
    baseCanvas: canvas,
    layers: [layer],
    activeLayerId: layer.id
  };
  const material = {
    userData: {
      clonePaintCanvas: canvas,
      clonePaintContext: {},
      clonePaintTexture: {
        colorSpace: "srgb",
        flipY: false,
        wrapS: "clamp",
        wrapT: "clamp",
        minFilter: "linear",
        magFilter: "linear",
        generateMipmaps: false
      },
      texturePaintLayerStack: stack
    }
  };
  let clearCalls = 0;
  editor.renderer = {};
  editor.texturePaintLayerStackForMaterial = (candidateMaterial, editable, options) => {
    assert.equal(candidateMaterial, material);
    assert.equal(options.create, true);
    return stack;
  };
  editor.texturePaintActivePaintLayerForStack = (candidateStack, options) => {
    assert.equal(candidateStack, stack);
    assert.equal(options.fallback, false);
    return { stack, layer };
  };
  editor.clearTexturePaintGpuTarget = (targetEntry) => {
    clearCalls += 1;
    assert.equal(targetEntry.layer, layer);
    targetEntry.emptyTransparent = true;
    return true;
  };
  editor.textureAirbrushCopyTextureToTarget = () => {
    throw new Error("empty layer target should be cleared, not copied from the empty canvas");
  };

  const targetEntry = editor.textureAirbrushGpuLayerTargetForMaterial(material, { renderPanel: false });

  assert.equal(targetEntry?.target, createdTargets[0]);
  assert.equal(targetEntry.emptyTransparent, true);
  assert.equal(layer.gpuTarget, targetEntry);
  assert.equal(clearCalls, 1);
});

test("layer airbrush prewarm warms only the active material by default", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const materials = Array.from({ length: 13 }, (_, index) => ({ name: `material-${index}` }));
  const paintables = materials.map((material, materialIndex) => ({
    record: { id: `record-${materialIndex}` },
    materialIndex,
    material
  }));
  const warmedMaterials = [];
  editor.texturePaintActiveMaterial = materials[6];
  editor.textureAirbrushPaintableMaterials = () => paintables;
  editor.textureAirbrushPrewarmLayerMaterial = (record, materialIndex, material) => {
    warmedMaterials.push({ record, materialIndex, material });
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmAllLayerMaterials({ activeOnly: true }), 1);
  assert.equal(warmedMaterials.length, 1);
  assert.equal(warmedMaterials[0].material, materials[6]);
});

test("layer airbrush prewarm can still warm a broader material budget when requested", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const materials = Array.from({ length: 13 }, (_, index) => ({ name: `material-${index}` }));
  const paintables = materials.map((material, materialIndex) => ({
    record: { id: `record-${materialIndex}` },
    materialIndex,
    material
  }));
  const warmedMaterials = [];
  editor.texturePaintActiveMaterial = materials[6];
  editor.textureAirbrushPaintableMaterials = () => paintables;
  editor.textureAirbrushPrewarmLayerMaterial = (record, materialIndex, material) => {
    warmedMaterials.push({ record, materialIndex, material });
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmAllLayerMaterials({ all: true }), 12);
  assert.equal(warmedMaterials.length, 12);
  assert.equal(warmedMaterials[0].material, materials[6]);
  assert.equal(warmedMaterials.some((entry) => entry.material === materials[12]), false);
});

test("broad layer prewarm passes each warmed material as its own source target", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const materials = Array.from({ length: 13 }, (_, index) => ({ name: `material-${index}` }));
  const paintables = materials.map((material, materialIndex) => ({
    record: { id: `record-${materialIndex}` },
    materialIndex,
    material
  }));
  const materialOptions = [];
  editor.texturePaintActiveMaterial = materials[6];
  editor.textureAirbrushPaintableMaterials = () => paintables;
  editor.textureAirbrushPrewarmLayerMaterial = (record, materialIndex, material, options) => {
    materialOptions.push({ material, optionMaterial: options.material });
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmAllLayerMaterials({ all: true }), 12);
  assert.equal(materialOptions.length, 12);
  assert.deepEqual(materialOptions.map((entry) => entry.optionMaterial), materialOptions.map((entry) => entry.material));
  assert.equal(materialOptions.some((entry) => entry.material === materials[12]), false);
});

test("broad layer prewarm snapshots every warmed material source", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const activeMaterial = { name: "active" };
  const otherMaterial = { name: "other" };
  const activeTarget = { target: { texture: {} } };
  const otherTarget = { target: { texture: {} } };
  const snapshots = [];
  editor.renderer = {};
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.textureAirbrushPaintableMaterials = () => [
    { record: { id: "active-record" }, materialIndex: 0, material: activeMaterial },
    { record: { id: "other-record" }, materialIndex: 0, material: otherMaterial }
  ];
  editor.textureAirbrushGpuLayerTargetForMaterial = (material) => (
    material === activeMaterial ? activeTarget : otherTarget
  );
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: { texture: {} } });
  editor.textureAirbrushPrewarmUvBleedOffsets = () => [];
  editor.textureAirbrushGpuProxyForRecord = () => ({});
  editor.textureAirbrushPrecompileBrushProxyScene = () => {};
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = (targetEntry) => {
    snapshots.push(targetEntry);
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmAllLayerMaterials({ all: true }), 2);
  assert.deepEqual(snapshots, [activeTarget, otherTarget]);
});

test("layer airbrush prewarm does not steal the active paint material", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const activeMaterial = { name: "active" };
  const otherMaterial = { name: "other" };
  const targetOptions = [];
  editor.renderer = {};
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.textureAirbrushPaintableMaterials = () => [
    { record: { id: "active-record" }, materialIndex: 0, material: activeMaterial },
    { record: { id: "other-record" }, materialIndex: 0, material: otherMaterial }
  ];
  editor.textureAirbrushGpuLayerTargetForMaterial = (material, options) => {
    targetOptions.push({ material, options });
    return { target: { texture: {} }, layerMode: true };
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: { texture: {} } });
  editor.textureAirbrushPrewarmUvBleedOffsets = () => [];
  editor.textureAirbrushGpuProxyForRecord = () => ({});
  editor.textureAirbrushPrecompileBrushProxyScene = () => {};
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = () => true;

  assert.equal(editor.textureAirbrushPrewarmAllLayerMaterials({ all: true }), 2);
  assert.deepEqual(targetOptions.map((entry) => entry.options), [
    { renderPanel: false, setActiveMaterial: false },
    { renderPanel: false, setActiveMaterial: false }
  ]);
  assert.equal(editor.texturePaintActiveMaterial, activeMaterial);
});

test("active layer GPU prewarm runs the active material prewarm inline while airbrush is active", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { name: "active-material" };
  const record = { name: "active-record" };
  const fullPrewarmCalls = [];
  const warmCalls = [];
  const liveFrame = {};
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [{
    record,
    materialIndex: 2,
    material
  }];
  editor.textureAirbrushPrewarmLayerMaterial = () => {
    throw new Error("active layer prewarm should use the full inline prewarm in airbrush layer mode");
  };
  editor.textureAirbrushPrewarmAllLayerMaterials = (options) => {
    fullPrewarmCalls.push(options);
    return 2;
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    throw new Error("active layer prewarm should not race the first stroke through a timer");
  };
  editor.textureAirbrushBrushShaderMaterial = () => {
    warmCalls.push("brush-shader");
    return {};
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    warmCalls.push("copy-scene");
  };
  editor.textureAirbrushRenderDepthTarget = () => {
    warmCalls.push("depth-target");
    return {};
  };
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    warmCalls.push({ liveFrame: options });
    return liveFrame;
  };
  editor.textureAirbrushSeedProjectionFramePaintPass = (frame, candidateRecord, materialIndex, candidateMaterial, options) => {
    warmCalls.push({ seed: [frame, candidateRecord, materialIndex, candidateMaterial, options] });
    return {};
  };

  assert.equal(editor.prewarmTexturePaintActiveLayerGpu(material), true);
  assert.deepEqual(fullPrewarmCalls, [{ material, activeOnly: true }]);
  assert.deepEqual(warmCalls, [
    "brush-shader",
    "copy-scene",
    { liveFrame: { seedLayerProxies: false, seedPaintPasses: false } },
    "depth-target",
    { seed: [liveFrame, record, 2, material, { seedLayerProxy: true, seedProbe: false }] }
  ]);
});

test("active layer GPU prewarm can run the broad background-style material pass", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { name: "active-material" };
  const record = { name: "active-record" };
  const fullPrewarmCalls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [{
    record,
    materialIndex: 1,
    material
  }];
  editor.textureAirbrushPrewarmAllLayerMaterials = (options) => {
    fullPrewarmCalls.push(options);
    return 12;
  };
  const liveFrame = {};
  const liveFrameOptions = [];
  const seedCalls = [];
  editor.textureAirbrushBrushShaderMaterial = () => ({});
  editor.textureAirbrushEnsureCopyScene = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ name: "depth-target" });
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    liveFrameOptions.push(options);
    return liveFrame;
  };
  editor.textureAirbrushSeedProjectionFramePaintPass = (...args) => {
    seedCalls.push(args);
    return {};
  };

  assert.equal(editor.prewarmTexturePaintActiveLayerGpu(material, { all: true }), true);
  assert.deepEqual(fullPrewarmCalls, [{ material, activeOnly: false, all: true }]);
  assert.deepEqual(liveFrameOptions, [{}]);
  assert.equal(liveFrame.depthTarget?.name, "depth-target");
  assert.deepEqual(seedCalls, [[liveFrame, record, 1, material, { seedLayerProxy: true, seedProbe: false }]]);
});

test("active layer prewarm prefers the cached cursor hit material", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const activeMaterial = { name: "active-material" };
  const cursorMaterial = { name: "cursor-material" };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 9;
  editor.textureAirbrushCameraPrewarmSerial = 2;
  editor.textureAirbrushCachedLayerHitSeed = {
    material: cursorMaterial,
    layerMutationSerial: 9,
    cameraSerial: 2,
    createdAt: typeof performance !== "undefined" ? performance.now() : Date.now()
  };
  editor.textureAirbrushPaintableMaterials = () => [
    { record: { id: "active-record" }, materialIndex: 0, material: activeMaterial },
    { record: { id: "cursor-record" }, materialIndex: 3, material: cursorMaterial }
  ];
  editor.textureAirbrushPrewarmLayerMaterial = (record, materialIndex, material, options) => {
    calls.push({ record, materialIndex, material, options });
    return true;
  };
  editor.textureAirbrushBrushShaderMaterial = () => ({});
  editor.textureAirbrushEnsureCopyScene = () => {};

  assert.equal(editor.prewarmTexturePaintActiveLayerMaterialGpu(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].material, cursorMaterial);
  assert.equal(calls[0].materialIndex, 3);
  assert.deepEqual(calls[0].options, {
    material: cursorMaterial,
    activeOnly: true,
    allowDuringStroke: false
  });
});

test("broad layer prewarm orders the cached cursor hit material first", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const activeMaterial = { name: "active-material" };
  const cursorMaterial = { name: "cursor-material" };
  const otherMaterial = { name: "other-material" };
  const warmedMaterials = [];
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 4;
  editor.textureAirbrushCameraPrewarmSerial = 1;
  editor.textureAirbrushCachedLayerHitSeed = {
    material: cursorMaterial,
    layerMutationSerial: 4,
    cameraSerial: 1,
    createdAt: typeof performance !== "undefined" ? performance.now() : Date.now()
  };
  editor.textureAirbrushPaintableMaterials = () => [
    { record: { id: "active-record" }, materialIndex: 0, material: activeMaterial },
    { record: { id: "cursor-record" }, materialIndex: 1, material: cursorMaterial },
    { record: { id: "other-record" }, materialIndex: 2, material: otherMaterial }
  ];
  editor.textureAirbrushPrewarmLayerMaterial = (record, materialIndex, material, options) => {
    warmedMaterials.push({ material, optionMaterial: options.material });
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmAllLayerMaterials({ all: true, limit: 2 }), 2);
  assert.deepEqual(warmedMaterials.map((entry) => entry.material), [cursorMaterial, activeMaterial]);
  assert.deepEqual(warmedMaterials.map((entry) => entry.optionMaterial), [cursorMaterial, activeMaterial]);
});

test("broad active layer GPU prewarm keeps per-material source options", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const activeMaterial = { name: "active-material" };
  const otherMaterial = { name: "other-material" };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [
    { record: { name: "active-record" }, materialIndex: 0, material: activeMaterial },
    { record: { name: "other-record" }, materialIndex: 1, material: otherMaterial }
  ];
  editor.textureAirbrushPrewarmLayerMaterial = (record, materialIndex, material, options) => {
    calls.push({ material, optionMaterial: options.material, all: options.all });
    return true;
  };
  editor.textureAirbrushBrushShaderMaterial = () => ({});
  editor.textureAirbrushEnsureCopyScene = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({});
  editor.textureAirbrushLiveProjectionFrame = (options) => ({ ...options });
  editor.textureAirbrushSeedProjectionFramePaintPass = () => ({});

  assert.equal(editor.prewarmTexturePaintActiveLayerGpu(activeMaterial, { all: true }), true);
  assert.deepEqual(calls, [
    { material: activeMaterial, optionMaterial: activeMaterial, all: true },
    { material: otherMaterial, optionMaterial: otherMaterial, all: true }
  ]);
});
