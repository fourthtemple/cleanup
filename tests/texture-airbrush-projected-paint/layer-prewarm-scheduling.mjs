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

test("airbrush cursor hover prewarm preserves the current layer display", () => {
  class PointerEditor {}
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  const event = { clientX: 32, clientY: 48 };
  const hit = { record: { id: "hover-record" } };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.textureBrushCursor = {};
  editor.canvas = {};
  editor.rememberBrushCursorEvent = (candidateEvent) => {
    assert.equal(candidateEvent, event);
    return true;
  };
  editor.texturePaintHitForEvent = (candidateEvent, tool) => {
    assert.equal(candidateEvent, event);
    assert.equal(tool, "airbrush");
    return hit;
  };
  editor.scheduleTextureAirbrushPrewarm = (candidateEvent, candidateHit, options) => {
    calls.push([candidateEvent, candidateHit, options]);
    return true;
  };
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.showTextureBrushCursorElement = () => {};
  editor.setTextureBrushCursorMode = () => {};
  editor.positionBrushCursor = () => {};

  assert.equal(editor.updateTextureBrushCursor(event), true);
  assert.deepEqual(calls, [[event, hit, { preserveLayerDisplay: true }]]);
});

test("preserved layer material prewarm does not swap the visible layer display", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const targetEntry = {
    target: { texture: {} },
    layerMode: true,
    width: 4,
    height: 4
  };
  const layer = {
    id: "paint-1",
    visible: true,
    gpuTarget: targetEntry
  };
  const material = {
    userData: {
      texturePaintLayerStack: {
        activeLayerId: "paint-1",
        layers: [layer]
      }
    }
  };
  const record = { id: "record" };
  const calls = [];
  editor.renderer = {};
  editor.textureAirbrushGpuLayerTargetForMaterial = (candidateMaterial, options) => {
    calls.push(["target", candidateMaterial, options]);
    return targetEntry;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => {
    throw new Error("hover prewarm should not install a live display composite");
  };
  editor.texturePaintLiveUnderlayTargetForLayerGpuPaint = () => {
    throw new Error("hover prewarm should not build a live underlay display");
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("hover prewarm should not swap to a GPU display composite");
  };
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = () => {
    calls.push("source");
    return true;
  };
  editor.textureAirbrushPrewarmCurrentTargetSnapshot = () => {
    calls.push("current");
    return true;
  };
  editor.textureAirbrushGpuProxyForRecord = () => {
    calls.push("proxy");
    return {};
  };
  editor.textureAirbrushPrecompileBrushProxyScene = () => {
    calls.push("compile");
    return true;
  };

  assert.equal(
    editor.textureAirbrushPrewarmLayerMaterial(record, 0, material, { preserveLayerDisplay: true }),
    true
  );
  assert.equal(calls.some((call) => call === "source"), true);
  assert.equal(calls.some((call) => call === "proxy"), true);
});

test("reset layer prewarm seeds the active material projection without broad material work", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlPrewarmEditor();
  const targetEntry = {
    target: { texture: {} },
    layerMode: true,
    emptyTransparent: true
  };
  const layer = {
    id: "paint-1",
    isEmpty: true,
    gpuTarget: targetEntry
  };
  const stack = {
    activeLayerId: "paint-1",
    layers: [layer]
  };
  const material = {
    uuid: "material-reset-active",
    color: {},
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const record = {
    object: { material },
    geometry: { attributes: { uv: {} } }
  };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.model = {
    updateMatrixWorld(force) {
      calls.push(["model-update", force]);
    }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.paintRecords = [record];
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActivePaintLayerForStack = (candidateStack) => ({
    stack: candidateStack,
    layer
  });
  editor.refreshSkinnedRaycastBounds = () => {
    calls.push("bounds");
  };
  editor.textureAirbrushPrewarmAllLayerMaterials = () => {
    throw new Error("reset seed should not use broad layer material prewarm");
  };
  editor.textureAirbrushGpuLayerTargetForMaterial = (candidateMaterial, options) => {
    calls.push(["target", candidateMaterial, options]);
    return targetEntry;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, candidateTargetEntry) => {
    calls.push(["live-composite", candidateMaterial, candidateTargetEntry]);
    return { target: candidateTargetEntry.target };
  };
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = (candidateTargetEntry, options) => {
    calls.push(["source", candidateTargetEntry]);
    assert.deepEqual(options, { allowDuringStroke: true });
    return true;
  };
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    calls.push(["proxy", candidateRecord, materialIndex, candidateMaterial]);
    return {
      proxy: {
        skeleton: {
          update() {
            calls.push("skeleton");
          }
        }
      },
      scene: {}
    };
  };
  editor.textureAirbrushPrecompileBrushProxyScene = () => {
    calls.push("compile-proxy");
    return true;
  };
  editor.textureAirbrushBrushShaderMaterial = () => {
    calls.push("brush-shader");
    return {};
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    calls.push("copy-scene");
  };
  editor.textureAirbrushRenderDepthTarget = () => {
    calls.push("depth");
    return { name: "depth-target" };
  };

  assert.equal(editor.prewarmTextureAirbrushLayerResetStroke({ clientX: 30, clientY: 45 }), true);
  const frame = editor.textureAirbrushLiveProjectionFrameState;
  assert.equal(frame.seedPaintPasses, false);
  assert.equal(frame.paintPassCache.size, 1);
  assert.equal(frame.proxySceneCache.size, 1);
  assert.equal(frame.probePaintPassCache.get("30:45")?.length, 1);
  assert.equal(frame.probePaintPassCache.get("30:45")?.[0].targetEntry, targetEntry);
  assert.equal([...frame.paintPassCache.values()][0].targetEntry, targetEntry);
  assert.equal(frame.depthTarget?.name, "depth-target");
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "source"), true);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "proxy").length >= 1, true);
});

test("scheduled layer prewarm bypasses recent background prewarm and runs inline", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  let prewarmCalls = 0;
  try {
    globalThis.window = {
      setTimeout() {
        throw new Error("missing layer targets should prewarm before the timer can race the first stroke");
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLayerPrewarmNeeded = () => true;
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      prewarmCalls += 1;
      assert.equal(event, null);
      assert.equal(hit, null);
      assert.deepEqual(options, { force: false });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm(), true);
    assert.equal(prewarmCalls, 1);
    assert.equal(editor.textureAirbrushPrewarmPending, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("scheduled layer prewarm can defer null-event work to avoid blocking tool select", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  let timerCallback = null;
  let prewarmCalls = 0;
  try {
    globalThis.window = {
      setTimeout(callback, delay) {
        assert.equal(delay, 0);
        timerCallback = callback;
        return 1;
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLayerPrewarmNeeded = () => true;
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      prewarmCalls += 1;
      assert.equal(event, null);
      assert.equal(hit, null);
      assert.deepEqual(options, { force: false, immediateLayer: false, delay: 0 });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm(null, null, {
      immediateLayer: false,
      delay: 0
    }), true);
    assert.equal(prewarmCalls, 0);
    assert.equal(editor.textureAirbrushPrewarmPending, true);
    assert.equal(typeof timerCallback, "function");

    timerCallback();

    assert.equal(prewarmCalls, 1);
    assert.equal(editor.textureAirbrushPrewarmPending, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("scheduled layer prewarm stays throttled when layer targets are already warm", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  let prewarmCalls = 0;
  editor.activeTool = "airbrush";
  editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushLayerPrewarmNeeded = () => false;
  editor.textureAirbrushLiveProjectionFrameCurrent = () => true;
  editor.textureAirbrushPrewarm = () => {
    prewarmCalls += 1;
    return true;
  };

  assert.equal(editor.scheduleTextureAirbrushPrewarm(), false);
  assert.equal(prewarmCalls, 0);
});

test("scheduled layer prewarm runs inline when the current frame lacks the active layer seed", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  const material = { uuid: "active-layer-material" };
  const record = { id: "active-layer-record" };
  const frame = {
    paintPassCache: new Map(),
    proxySceneCache: new Map()
  };
  let prewarmCalls = 0;
  try {
    globalThis.window = {
      setTimeout() {
        throw new Error("missing active layer projection seed should prewarm before a timer can race the first stroke");
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.textureAirbrushLiveProjectionFrameState = frame;
    editor.texturePaintLayerModeActive = () => true;
    editor.texturePaintActiveMaterial = material;
    editor.textureAirbrushLayerPrewarmNeeded = () => false;
    editor.textureAirbrushLiveProjectionFrameCurrent = (candidateFrame) => candidateFrame === frame;
    editor.textureAirbrushPaintableMaterials = () => [{
      record,
      materialIndex: 0,
      material
    }];
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      prewarmCalls += 1;
      assert.equal(event, null);
      assert.equal(hit, null);
      assert.deepEqual(options, { force: false });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm(), true);
    assert.equal(prewarmCalls, 1);
    assert.equal(editor.textureAirbrushPrewarmPending, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("scheduled layer prewarm runs inline when layer target is warm but live frame is cold", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  let prewarmCalls = 0;
  try {
    globalThis.window = {
      setTimeout() {
        throw new Error("cold live frame should prewarm before the timer can race the first stroke");
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLayerPrewarmNeeded = () => false;
    editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      prewarmCalls += 1;
      assert.equal(event, null);
      assert.equal(hit, null);
      assert.deepEqual(options, { force: false });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm(), true);
    assert.equal(prewarmCalls, 1);
    assert.equal(editor.textureAirbrushPrewarmPending, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("scheduled layer hover prewarm runs inline when the live projection frame is cold", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  const hit = {
    record: { id: "hover-record" },
    hit: { face: { materialIndex: 0 } }
  };
  let prewarmCalls = 0;
  try {
    globalThis.window = {
      setTimeout() {
        throw new Error("cold layer hover frame should not wait on a timer");
      },
      requestIdleCallback() {
        throw new Error("cold layer hover frame should not wait for idle time");
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLayerPrewarmNeeded = () => false;
    editor.textureAirbrushLiveProjectionFrameCurrent = () => false;
    editor.textureAirbrushPrewarm = (event, candidateHit, options) => {
      prewarmCalls += 1;
      assert.deepEqual(event, { clientX: 40, clientY: 50 });
      assert.equal(candidateHit, hit);
      assert.deepEqual(options, { force: false });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm({ clientX: 40, clientY: 50 }, hit), true);
    assert.equal(prewarmCalls, 1);
    assert.equal(editor.textureAirbrushPrewarmPending, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("scheduled layer hover prewarm runs inline when the current frame lacks the hit seed", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  const material = { id: "hit-material" };
  const hit = {
    record: { id: "hover-record" },
    hit: { face: { materialIndex: 0 } }
  };
  const frame = {
    rect: { left: 10, top: 20, width: 200, height: 140 },
    paintPassCache: new Map(),
    proxySceneCache: new Map(),
    probePaintPassCache: new Map()
  };
  let prewarmCalls = 0;
  try {
    globalThis.window = {
      setTimeout() {
        throw new Error("unseeded layer hover frame should not wait on a timer");
      },
      requestIdleCallback() {
        throw new Error("unseeded layer hover frame should not wait for idle time");
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.textureAirbrushLiveProjectionFrameState = frame;
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLayerPrewarmNeeded = () => false;
    editor.textureAirbrushLiveProjectionFrameCurrent = (candidateFrame) => candidateFrame === frame;
    editor.clonePaintMaterialForHit = (record, candidateHit) => {
      assert.equal(record, hit.record);
      assert.equal(candidateHit, hit.hit);
      return material;
    };
    editor.textureAirbrushPrewarm = (event, candidateHit, options) => {
      prewarmCalls += 1;
      assert.deepEqual(event, { clientX: 40, clientY: 50 });
      assert.equal(candidateHit, hit);
      assert.deepEqual(options, { force: false });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm({ clientX: 40, clientY: 50 }, hit), true);
    assert.equal(prewarmCalls, 1);
    assert.equal(editor.textureAirbrushPrewarmPending, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("scheduled layer prewarm follows the cursor hit material instead of the active layer material", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  const activeLayer = {
    id: "active-layer",
    visible: true,
    opacity: 1
  };
  const activeStack = {
    activeLayerId: activeLayer.id,
    baseCanvas: {},
    width: 64,
    height: 64,
    layers: [activeLayer]
  };
  const activeMaterial = {
    map: { name: "active-base" },
    userData: {
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: { value: null }
          }
        }
      },
      texturePaintLiveLayerShaderCompileKey: "active-layer-texture",
      texturePaintLayerStack: activeStack
    }
  };
  activeLayer.gpuTarget = {
    target: { texture: { uuid: "active-layer-texture" } },
    width: 64,
    height: 64,
    layer: activeLayer,
    layerStack: activeStack,
    layerMode: true,
    liveCompositeTarget: {
      target: { texture: { uuid: "active-layer-texture" } },
      shaderComposite: true
    },
    liveCompositeBaseTexture: activeMaterial.map,
    liveCompositeLayer: activeLayer,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeUnderlayKey: "live-underlay-v1|0|64|64|0"
  };
  activeLayer.gpuTarget.liveCompositeTarget.target = activeLayer.gpuTarget.target;
  const hitMaterial = {
    userData: {
      texturePaintLayerStack: {
        activeLayerId: "",
        layers: []
      }
    }
  };
  const hit = {
    record: { id: "hit-record" },
    hit: { face: { materialIndex: 1 } }
  };
  let prewarmCalls = 0;
  try {
    globalThis.window = {
      setTimeout() {
        throw new Error("cold cursor-hit material should not wait on a timer");
      },
      requestIdleCallback() {
        throw new Error("cold cursor-hit material should not wait for idle time");
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.texturePaintActiveMaterial = activeMaterial;
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLiveProjectionFrameCurrent = () => true;
    editor.textureAirbrushPaintableMaterials = () => [
      { material: activeMaterial },
      { material: hitMaterial }
    ];
    editor.clonePaintMaterialForHit = (record, candidateHit) => {
      assert.equal(record, hit.record);
      assert.equal(candidateHit, hit.hit);
      return hitMaterial;
    };
    editor.textureAirbrushPrewarm = (event, candidateHit, options) => {
      prewarmCalls += 1;
      assert.deepEqual(event, { clientX: 20, clientY: 30 });
      assert.equal(candidateHit, hit);
      assert.deepEqual(options, { force: false });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm({ clientX: 20, clientY: 30 }, hit), true);
    assert.equal(prewarmCalls, 1);
    assert.equal(editor.textureAirbrushPrewarmPending, false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("scheduled broad layer prewarm checks all layer materials and preserves the broad option", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  const layerPrewarmChecks = [];
  const prewarmCalls = [];
  try {
    globalThis.window = {
      setTimeout() {
        throw new Error("broad cold layer prewarm should run inline before first paint");
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLayerPrewarmNeeded = (material, options) => {
      layerPrewarmChecks.push({ material, options });
      return options?.all === true;
    };
    editor.textureAirbrushLiveProjectionFrameCurrent = () => true;
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      prewarmCalls.push({ event, hit, options });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm(null, null, { all: true }), true);

    assert.deepEqual(layerPrewarmChecks, [{ material: null, options: { all: true } }]);
    assert.deepEqual(prewarmCalls, [{ event: null, hit: null, options: { force: false, all: true } }]);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("pending scheduled layer prewarm keeps a later broad material request", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  let idleCallback = null;
  const prewarmCalls = [];
  try {
    globalThis.window = {
      requestIdleCallback(callback) {
        idleCallback = callback;
      },
      setTimeout() {
        throw new Error("idle callback should be used for pointer prewarm in this test");
      }
    };
    editor.activeTool = "airbrush";
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushLayerPrewarmNeeded = (material, options) => options?.all === true;
    editor.textureAirbrushLiveProjectionFrameCurrent = () => true;
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      prewarmCalls.push({ event, hit, options });
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPrewarm({ clientX: 10, clientY: 20 }), true);
    assert.equal(typeof idleCallback, "function");
    assert.equal(editor.scheduleTextureAirbrushPrewarm(null, null, { all: true }), false);

    idleCallback();

    assert.deepEqual(prewarmCalls, [{
      event: { clientX: 10, clientY: 20 },
      hit: null,
      options: { force: false, all: true }
    }]);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("layer prewarm needed ignores cold non-active materials by default", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const warmTexture = {};
  const warmTarget = { texture: warmTexture };
  const warmLayer = {
    id: "warm",
    visible: true,
    opacity: 1
  };
  const warmStack = {
    activeLayerId: warmLayer.id,
    baseCanvas: {},
    width: 64,
    height: 64,
    layers: [warmLayer]
  };
  const warmMaterial = {
    map: { name: "warm-base" },
    userData: {
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: { value: null }
          }
        }
      },
      texturePaintLiveLayerShaderCompileKey: "live-layer",
      texturePaintLayerStack: warmStack
    }
  };
  warmLayer.gpuTarget = {
    target: warmTarget,
    width: 64,
    height: 64,
    layer: warmLayer,
    layerStack: warmStack,
    layerMode: true,
    liveCompositeTarget: {
      target: warmTarget,
      shaderComposite: true
    },
    liveCompositeBaseTexture: warmMaterial.map,
    liveCompositeLayer: warmLayer,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeUnderlayKey: "live-underlay-v1|0|64|64|0"
  };
  const coldLayer = { id: "cold" };
  const coldMaterial = {
    userData: {
      texturePaintLiveLayerShaderComposite: {},
      texturePaintLayerStack: {
        activeLayerId: coldLayer.id,
        layers: [coldLayer]
      }
    }
  };
  const editor = new WebGlPrewarmEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = warmMaterial;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [
    { material: warmMaterial },
    { material: coldMaterial }
  ];

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), false);
  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(warmMaterial), false);
  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(null, { all: true }), true);
});

test("broad layer prewarm detects cold non-active stroke source snapshots", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const warmLayer = {
    id: "warm",
    visible: true,
    opacity: 1
  };
  const coldLayer = {
    id: "cold",
    visible: true,
    opacity: 1
  };
  const warmTexture = { uuid: "warm-layer-texture" };
  const coldTexture = { uuid: "cold-layer-texture" };
  const warmMaterial = {
    map: { name: "warm-base" },
    userData: {
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: { value: null }
          }
        }
      },
      texturePaintLiveLayerShaderCompileKey: warmTexture.uuid
    }
  };
  const coldMaterial = {
    map: { name: "cold-base" },
    userData: {
      texturePaintLiveLayerShaderComposite: {
        shader: {
          uniforms: {
            texturePaintLiveLayerMap: { value: null }
          }
        }
      },
      texturePaintLiveLayerShaderCompileKey: coldTexture.uuid
    }
  };
  const warmStack = {
    activeLayerId: warmLayer.id,
    baseCanvas: {},
    width: 64,
    height: 64,
    layers: [warmLayer]
  };
  const coldStack = {
    activeLayerId: coldLayer.id,
    baseCanvas: {},
    width: 64,
    height: 64,
    layers: [coldLayer]
  };
  warmMaterial.userData.texturePaintLayerStack = warmStack;
  coldMaterial.userData.texturePaintLayerStack = coldStack;
  const warmTarget = { texture: warmTexture };
  const coldTarget = { texture: coldTexture };
  warmLayer.gpuTarget = {
    target: warmTarget,
    width: 64,
    height: 64,
    layer: warmLayer,
    layerStack: warmStack,
    layerMode: true,
    liveCompositeTarget: {
      target: warmTarget,
      shaderComposite: true
    },
    liveCompositeBaseTexture: warmMaterial.map,
    liveCompositeLayer: warmLayer,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeUnderlayKey: "live-underlay-v1|0|64|64|0"
  };
  coldLayer.gpuTarget = {
    target: coldTarget,
    width: 64,
    height: 64,
    layer: coldLayer,
    layerStack: coldStack,
    layerMode: true,
    liveCompositeTarget: {
      target: coldTarget,
      shaderComposite: true
    },
    liveCompositeBaseTexture: coldMaterial.map,
    liveCompositeLayer: coldLayer,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeUnderlayKey: "live-underlay-v1|0|64|64|0"
  };
  const editor = new WebGlPrewarmEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = warmMaterial;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [
    { material: warmMaterial },
    { material: coldMaterial }
  ];
  editor.texturePaintGpuPrewarmSnapshotCurrent = (targetEntry) => targetEntry !== coldLayer.gpuTarget;

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), false);
  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(null, { all: true }), true);
});

test("layer prewarm accepts a warm full composite when live shader composite is not eligible", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const activeLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    gpuTarget: {
      width: 64,
      height: 64,
      target: { texture: { uuid: "active-layer-texture" } },
      layerMode: true
    }
  };
  const paintedUpperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    isEmpty: false,
    gpuTarget: {
      emptyTransparent: false,
      target: { texture: { uuid: "upper-layer-texture" } }
    }
  };
  const stack = {
    activeLayerId: activeLayer.id,
    baseCanvas: {},
    width: 64,
    height: 64,
    layers: [activeLayer, paintedUpperLayer]
  };
  activeLayer.gpuTarget.layer = activeLayer;
  activeLayer.gpuTarget.layerStack = stack;
  const material = {
    userData: {
      texturePaintLayerStack: stack,
      texturePaintCompositeGpuTarget: {
        width: 64,
        height: 64,
        target: { texture: { uuid: "warm-composite-texture" } }
      }
    }
  };
  const editor = new WebGlPrewarmEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushPaintableMaterials = () => [{ material }];

  assert.equal(editor.textureAirbrushLayerPrewarmNeeded(), false);
});
