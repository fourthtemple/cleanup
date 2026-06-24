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

test("projected region airbrush captures undo once per editable material state", () => {
  const editor = new TestEditor();
  const material = { uuid: "material-region" };
  const record = { object: {} };
  const target = {
    vertices: new Set([1]),
    originMaterialIndex: 0,
    materialIndex: 0,
    originUv: { x: 0.5, y: 0.5 }
  };
  const imageData = {
    width: 4,
    height: 4,
    data: new Uint8ClampedArray(4 * 4 * 4)
  };
  const editable = {
    canvas: { width: 4, height: 4 },
    texture: {},
    context: {
      getImageData() {
        return imageData;
      },
      putImageData() {}
    }
  };
  let undoCaptureCount = 0;
  editor.canvas = {
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: 100,
        height: 100
      };
    }
  };
  editor.camera = {};
  editor.pointer = { x: 0, y: 0 };
  editor.paintRecords = [record];
  editor.clonePaintTargets = new Map([[record, target]]);
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureBrushRadiusValue = () => 1;
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => editable;
  editor.captureTexturePaintCanvasUndoTarget = () => {
    undoCaptureCount += 1;
  };
  editor.clonePaintRegionTextureTriangles = () => [{}];
  editor.clonePaintHitInsideRegion = () => true;
  editor.textureAirbrushRegionPixelFromUv = () => ({ x: 1, y: 1 });
  editor.clonePaintPointInsideTextureTriangles = () => false;
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      return [{
        object: record.object,
        uv: { x: 0.5, y: 0.5 },
        face: { materialIndex: 0 }
      }];
    }
  };

  editor.textureAirbrushBrightMeshUnderRegionPointer({
    clientX: 10,
    clientY: 10
  });

  assert.equal(undoCaptureCount, 1);
});

test("airbrush prewarm prepares WebGL paint targets without a hover hit", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const firstMaterial = { color: {} };
  const secondMaterial = { map: {} };
  const record = {
    object: {
      material: [null, firstMaterial, secondMaterial]
    }
  };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.model = {};
  editor.paintRecords = [record];
  editor.textureAirbrushBrushShaderMaterial = () => {
    calls.push("shader");
    return {};
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    calls.push("copy-scene");
  };
  editor.textureAirbrushRenderDepthTarget = () => {
    calls.push("depth");
    return { name: "depth-target" };
  };
  editor.textureAirbrushGpuTargetForMaterial = (candidateMaterial) => {
    calls.push(["target", candidateMaterial]);
    return { target: { texture: {} } };
  };
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    calls.push(["proxy", candidateRecord, materialIndex, candidateMaterial]);
    return {};
  };
  const liveFrame = {};
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    calls.push(["live-frame", options]);
    return liveFrame;
  };

  assert.equal(editor.textureAirbrushPrewarm(), true);
  assert.deepEqual(calls.slice(0, 3), ["shader", "copy-scene", "depth"]);
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "target"),
    [
      ["target", firstMaterial],
      ["target", secondMaterial]
    ]
  );
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "proxy"),
    [
      ["proxy", record, 1, firstMaterial],
      ["proxy", record, 2, secondMaterial]
    ]
  );
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "live-frame"),
    [["live-frame", {}]]
  );
});

test("broad post-orbit airbrush prewarm warms every WebGL material even with a cursor hit", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const firstMaterial = { color: {}, uuid: "first" };
  const secondMaterial = { map: {}, uuid: "second" };
  const record = {
    object: {
      material: [firstMaterial, secondMaterial]
    }
  };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.model = {};
  editor.paintRecords = [record];
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: { face: { materialIndex: 0 } }
  });
  editor.clonePaintMaterialForHit = () => firstMaterial;
  editor.textureAirbrushBrushShaderMaterial = () => {
    calls.push("shader");
    return {};
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    calls.push("copy-scene");
  };
  editor.textureAirbrushRenderDepthTarget = () => {
    calls.push("depth");
    return { name: "depth-target" };
  };
  editor.textureAirbrushGpuTargetForMaterial = (candidateMaterial) => {
    calls.push(["target", candidateMaterial.uuid]);
    return { target: { texture: {} } };
  };
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    calls.push(["proxy", materialIndex, candidateMaterial.uuid]);
    return {};
  };
  const liveFrame = {};
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    calls.push(["live-frame", options]);
    return liveFrame;
  };

  assert.equal(editor.textureAirbrushPrewarm({ clientX: 50, clientY: 60 }, null, {
    all: true,
    force: true
  }), true);

  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "target"),
    [
      ["target", "first"],
      ["target", "second"]
    ]
  );
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "proxy"),
    [
      ["proxy", 0, "first"],
      ["proxy", 1, "second"]
    ]
  );
  assert.deepEqual(
    calls.filter((call) => Array.isArray(call) && call[0] === "live-frame"),
    [["live-frame", {}]]
  );
});

test("layer airbrush prewarm prepares the active layer GPU target and live composite", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { userData: {} };
  const record = { object: { material } };
  const targetEntry = {
    target: { texture: {} },
    layerMode: true
  };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.model = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushBrushShaderMaterial = () => {
    calls.push("shader");
    return {};
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    calls.push("copy-scene");
  };
  editor.textureAirbrushRenderDepthTarget = () => {
    calls.push("depth");
    return { name: "depth-target" };
  };
  editor.textureAirbrushPaintableMaterials = () => [{
    record,
    materialIndex: 0,
    material
  }];
  editor.textureAirbrushGpuLayerTargetForMaterial = (candidateMaterial, options) => {
    calls.push(["layer-target", candidateMaterial, options]);
    return targetEntry;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, candidateTarget) => {
    calls.push(["live-composite", candidateMaterial, candidateTarget]);
    return { target: { texture: {} } };
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("layer prewarm should use the live composite target when available");
  };
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    calls.push(["proxy", candidateRecord, materialIndex, candidateMaterial]);
    return {};
  };
  const liveFrame = {};
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    calls.push(["live-frame", options]);
    return liveFrame;
  };
  editor.textureAirbrushSeedProjectionFramePaintPass = (frame, candidateRecord, materialIndex, candidateMaterial, options) => {
    calls.push(["seed-pass", frame, candidateRecord, materialIndex, candidateMaterial, options]);
    return {};
  };

  assert.equal(editor.textureAirbrushPrewarm(), true);
  assert.deepEqual(calls, [
    "shader",
    "copy-scene",
    ["layer-target", material, { renderPanel: false, setActiveMaterial: false }],
    ["live-composite", material, targetEntry],
    ["proxy", record, 0, material],
    ["live-frame", { seedLayerProxies: false, seedPaintPasses: false }],
    "depth",
    ["seed-pass", liveFrame, record, 0, material, {
      event: null,
      seedLayerProxy: true,
      seedProbe: false
    }]
  ]);
  assert.equal(liveFrame.depthTarget?.name, "depth-target");
});

test("broad post-orbit layer prewarm stays broad even with a cursor hit", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { uuid: "hit-material", userData: {} };
  const record = { object: { material } };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.model = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: { face: { materialIndex: 0 } }
  });
  editor.clonePaintMaterialForHit = () => material;
  editor.textureAirbrushBrushShaderMaterial = () => {
    calls.push("shader");
    return {};
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    calls.push("copy-scene");
  };
  editor.textureAirbrushPrewarmLayerMaterial = () => {
    throw new Error("all:true post-orbit warm must not stay on the single hit material");
  };
  editor.textureAirbrushPrewarmAllLayerMaterials = (options) => {
    calls.push(["all-layer", options]);
    return 2;
  };
  const liveFrame = {};
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    calls.push(["live-frame", options]);
    return liveFrame;
  };

  assert.equal(editor.textureAirbrushPrewarm({ clientX: 30, clientY: 45 }, null, {
    all: true,
    force: true,
    preserveLayerDisplay: true
  }), true);

  assert.deepEqual(calls, [
    "shader",
    "copy-scene",
    ["all-layer", {
      all: true,
      force: true,
      preserveLayerDisplay: true,
      activeOnly: false
    }],
    ["live-frame", {}]
  ]);
});

test("layer hover prewarm seeds the first-hit live projection probe", () => {
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
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    isEmpty: false
  };
  const stack = {
    activeLayerId: layer.id,
    baseCanvas: {},
    width: 64,
    height: 64,
    layers: [layer]
  };
  const material = {
    userData: {
      texturePaintLayerStack: stack
    }
  };
  const targetEntry = {
    target: { texture: {} },
    width: 64,
    height: 64,
    material,
    layer,
    layerStack: stack,
    layerMode: true
  };
  layer.gpuTarget = targetEntry;
  const record = {
    object: { material },
    geometry: { attributes: { uv: {} } }
  };
  const hit = {
    record,
    hit: { face: { materialIndex: 0 } }
  };
  let proxyRequests = 0;
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.model = { updateMatrixWorld() {} };
  editor.camera = {};
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 200, height: 140 };
    }
  };
  editor.paintRecords = [record];
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushBrushShaderMaterial = () => ({});
  editor.textureAirbrushEnsureCopyScene = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({});
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: targetEntry.target });
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = () => true;
  editor.clonePaintMaterialForHit = (candidateRecord, candidateHit) => {
    assert.equal(candidateRecord, record);
    assert.equal(candidateHit, hit.hit);
    return material;
  };
  editor.textureAirbrushGpuProxyForRecord = () => {
    proxyRequests += 1;
    return {
      proxy: {
        skeleton: {
          update() {}
        }
      },
      scene: {}
    };
  };
  editor.textureAirbrushPrecompileBrushProxyScene = () => true;

  assert.equal(editor.textureAirbrushPrewarm({ clientX: 30, clientY: 45 }, hit), true);

  const frame = editor.textureAirbrushLiveProjectionFrameState;
  assert.equal(frame.seedPaintPasses, false);
  assert.equal(frame.paintPassCache.size, 1);
  assert.equal(frame.proxySceneCache.size, 1);
  assert.deepEqual(
    frame.probePaintPassCache.get("20:25")?.map((pass) => pass.material),
    [material]
  );
  assert.equal(proxyRequests >= 1, true);
});

test("layer airbrush prewarm prepares the stroke source snapshot before first paint", () => {
  class WebGlPrewarmEditor {}
  const createdTargets = [];
  const THREE = {
    WebGLRenderTarget: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.texture = { uuid: `snapshot-${createdTargets.length}` };
        createdTargets.push(this);
      }

      dispose() {
        this.disposed = true;
      }
    },
    LinearFilter: "linear",
    ClampToEdgeWrapping: "clamp"
  };
  installPaintToolMethods(WebGlPrewarmEditor, { THREE });
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE });
  const editor = new WebGlPrewarmEditor();
  const record = {};
  const material = { uuid: "material-prewarm-source", userData: {} };
  const targetEntry = {
    target: {
      texture: { uuid: "layer-texture" }
    },
    width: 32,
    height: 16,
    layerMode: true,
    emptyTransparent: false
  };
  let copies = 0;
  editor.renderer = {};
  editor.paintRecords = [record];
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: targetEntry.target });
  editor.textureAirbrushGpuProxyForRecord = () => ({});
  editor.textureAirbrushRenderTextureSettings = () => ({
    minFilter: "linear",
    magFilter: "linear",
    wrapS: "clamp",
    wrapT: "clamp",
    generateMipmaps: false
  });
  editor.textureAirbrushCopyTextureRenderSettings = () => true;
  editor.copyTextureToRenderTarget = (sourceTexture, destinationTarget) => {
    assert.equal(sourceTexture, targetEntry.target.texture);
    assert.equal(destinationTarget, createdTargets[0]);
    copies += 1;
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmLayerMaterial(record, 0, material), true);
  assert.equal(copies, 1);
  assert.equal(Boolean(targetEntry.prewarmedStrokeSourceSnapshot?.snapshot), true);

  editor.beginTexturePaintStrokeUndo("Texture airbrush");
  assert.equal(editor.captureTexturePaintGpuUndoTarget(record, material, targetEntry, 0), true);
  assert.equal(copies, 1);
  assert.equal(targetEntry.prewarmedStrokeSourceSnapshot, undefined);
  assert.equal(editor.texturePaintStrokeUndo.before[0].before, createdTargets[0]);
});

test("mutating a layer GPU target invalidates a prewarmed stroke source snapshot", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const snapshot = {
    disposed: false,
    dispose() {
      this.disposed = true;
    }
  };
  const targetEntry = {
    paintRevision: 3,
    width: 4,
    height: 4,
    target: {
      texture: { uuid: "layer-texture" }
    },
    prewarmedStrokeSourceSnapshot: {
      snapshot,
      revision: 3,
      width: 4,
      height: 4
    }
  };

  assert.equal(editor.texturePaintGpuPrewarmSnapshotCurrent(targetEntry), true);
  assert.equal(editor.markTexturePaintGpuTargetMutated(targetEntry), true);
  assert.equal(snapshot.disposed, true);
  assert.equal(targetEntry.prewarmedStrokeSourceSnapshot, undefined);
  assert.equal(targetEntry.paintRevision, 4);
});

test("layer source prewarm can run after stroke begin before the target is touched", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const beforeSnapshot = {
    width: 2,
    height: 2,
    texture: {}
  };
  const targetEntry = {
    width: 2,
    height: 2,
    target: {
      texture: {}
    }
  };
  let clonedSnapshots = 0;
  editor.cloneTextureRenderTargetSnapshot = (candidateTarget) => {
    assert.equal(candidateTarget, targetEntry);
    clonedSnapshots += 1;
    return beforeSnapshot;
  };
  editor.beginTexturePaintStrokeUndo("Texture airbrush");

  assert.equal(editor.prewarmTexturePaintGpuStrokeSourceSnapshot(targetEntry), false);
  assert.equal(editor.prewarmTexturePaintGpuStrokeSourceSnapshot(targetEntry, { allowDuringStroke: true }), true);
  assert.equal(clonedSnapshots, 1);
  assert.equal(editor.texturePaintGpuPrewarmSnapshotCurrent(targetEntry), true);

  const material = { uuid: "material-layer-source-prewarm" };
  assert.equal(editor.captureTexturePaintGpuUndoTarget({}, material, targetEntry, 0), true);
  assert.equal(editor.texturePaintStrokeUndo.before[0].before, beforeSnapshot);
  assert.equal(targetEntry.prewarmedStrokeSourceSnapshot, undefined);

  assert.equal(editor.prewarmTexturePaintGpuStrokeSourceSnapshot(targetEntry, { allowDuringStroke: true }), false);
  assert.equal(clonedSnapshots, 1);
});

test("live layer shader prewarm compiles synchronously before async completion can race the stroke", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { userData: {} };
  const targetEntry = {
    target: {
      texture: {
        uuid: "layer-texture-compile-key"
      }
    },
    layerMode: true
  };
  const calls = [];
  editor.scene = {};
  editor.camera = {};
  editor.renderer = {
    compile(scene, camera) {
      calls.push(["compile", scene, camera]);
    },
    compileAsync(scene, camera) {
      calls.push(["compileAsync", scene, camera]);
      return Promise.resolve();
    }
  };

  assert.equal(editor.texturePaintPrecompileLiveLayerShaderComposite(material, targetEntry), true);
  assert.deepEqual(calls, [
    ["compile", editor.scene, editor.camera],
    ["compileAsync", editor.scene, editor.camera]
  ]);
  assert.equal(material.userData.texturePaintLiveLayerShaderCompileKey, "layer-texture-compile-key");

  assert.equal(editor.texturePaintPrecompileLiveLayerShaderComposite(material, targetEntry), false);
  assert.equal(calls.length, 2);
});

test("layer airbrush prewarm compiles the brush proxy before first paint", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { userData: {} };
  const record = { object: { material } };
  const targetEntry = {
    target: { texture: {} },
    layerMode: true
  };
  const proxyEntry = { scene: { name: "brush-proxy" } };
  const copyCamera = { name: "copy-camera" };
  const calls = [];
  editor.renderer = {
    compile(scene, camera) {
      calls.push(["compile", scene, camera]);
    },
    compileAsync(scene, camera) {
      calls.push(["compileAsync", scene, camera]);
      return Promise.resolve();
    }
  };
  editor.textureAirbrushGpuCopyCamera = copyCamera;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: { texture: {} } });
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("live layer composite should be warm");
  };
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = () => true;
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    assert.equal(candidateRecord, record);
    assert.equal(materialIndex, 0);
    assert.equal(candidateMaterial, material);
    return proxyEntry;
  };

  assert.equal(editor.textureAirbrushPrewarmLayerMaterial(record, 0, material), true);
  assert.equal(proxyEntry.brushShaderPrecompiled, true);
  assert.deepEqual(calls, [
    ["compile", proxyEntry.scene, copyCamera],
    ["compileAsync", proxyEntry.scene, copyCamera]
  ]);

  assert.equal(editor.textureAirbrushPrewarmLayerMaterial(record, 0, material), true);
  assert.equal(calls.length, 2);
});

test("layer airbrush prewarm prepares UV bleed offsets before first paint", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { userData: {} };
  const record = { object: { material } };
  const targetEntry = {
    target: { texture: {} },
    width: 64,
    height: 64,
    layerMode: true
  };
  const radii = [];
  editor.renderer = {};
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: { texture: {} } });
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = () => true;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushPrecompileBrushProxyScene = () => true;
  editor.textureAirbrushGpuUvBleedOffsets = (candidateTarget, radiusPixels) => {
    assert.equal(candidateTarget, targetEntry);
    radii.push(radiusPixels);
    return [];
  };

  assert.equal(editor.textureAirbrushPrewarmLayerMaterial(record, 0, material), true);
  assert.deepEqual(radii, [8, 10, 17]);
});

test("layer airbrush prewarm allocates the current-target opacity scratch before first paint", () => {
  class RenderTarget {
    constructor(width, height, options = {}) {
      this.width = width;
      this.height = height;
      this.options = options;
      this.texture = { name: "" };
    }
    dispose() {}
  }
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: { WebGLRenderTarget: RenderTarget } });
  const editor = new WebGlPrewarmEditor();
  const sourceTexture = {
    minFilter: "min",
    magFilter: "mag",
    wrapS: "wrap-s",
    wrapT: "wrap-t"
  };
  const targetEntry = {
    width: 8,
    height: 4,
    target: { texture: sourceTexture },
    layerMode: true
  };
  const copiedSettings = [];
  const copiedTargets = [];
  editor.renderer = {};
  editor.textureAirbrushRenderTextureSettings = (texture) => ({
    minFilter: texture.minFilter,
    magFilter: texture.magFilter,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT
  });
  editor.textureAirbrushCopyTextureRenderSettings = (targetTexture, source) => {
    copiedSettings.push({ targetTexture, source });
    targetTexture.settingsCopiedFrom = source;
    return true;
  };
  editor.textureAirbrushCopyTextureToTarget = (source, target) => {
    copiedTargets.push({ source, target });
    return true;
  };

  assert.equal(editor.textureAirbrushPrewarmCurrentTargetSnapshot(targetEntry), true);
  const scratch = editor.textureAirbrushCurrentTargetSnapshotTarget;
  assert.equal(scratch.width, 8);
  assert.equal(scratch.height, 4);
  assert.equal(scratch.texture.name, "texture airbrush current stroke target");
  assert.deepEqual(copiedTargets, []);

  assert.equal(editor.textureAirbrushCurrentTargetSnapshot(targetEntry), scratch);
  assert.deepEqual(copiedTargets, [{ source: sourceTexture, target: scratch }]);
  assert.equal(copiedSettings.length, 2);
});

test("active layer material prewarm prepares current-target opacity scratch", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { userData: {} };
  const record = { object: { material } };
  const targetEntry = {
    target: { texture: {} },
    width: 8,
    height: 4,
    layerMode: true
  };
  const currentScratchTargets = [];
  editor.renderer = {};
  editor.texturePaintActiveMaterial = material;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({ target: { texture: {} } });
  editor.textureAirbrushPrewarmUvBleedOffsets = () => true;
  editor.prewarmTexturePaintGpuStrokeSourceSnapshot = () => true;
  editor.textureAirbrushPrewarmCurrentTargetSnapshot = (candidateTarget) => {
    currentScratchTargets.push(candidateTarget);
    return true;
  };
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushPrecompileBrushProxyScene = () => true;

  assert.equal(editor.textureAirbrushPrewarmLayerMaterial(record, 0, material), true);
  assert.deepEqual(currentScratchTargets, [targetEntry]);
});

test("active layer material-only prewarm skips camera projection work", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { name: "active-material" };
  const record = { name: "active-record" };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushPaintableMaterials = () => [{
    record,
    materialIndex: 2,
    material
  }];
  editor.textureAirbrushPrewarmLayerMaterial = (candidateRecord, materialIndex, candidateMaterial, options) => {
    calls.push(["layer-material", candidateRecord, materialIndex, candidateMaterial, options]);
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
    throw new Error("material-only prewarm should not render a camera depth target");
  };
  editor.textureAirbrushLiveProjectionFrame = () => {
    throw new Error("material-only prewarm should not build a live projection frame");
  };

  assert.equal(editor.prewarmTexturePaintActiveLayerMaterialGpu(material), true);
  assert.deepEqual(calls, [
    ["layer-material", record, 2, material, {
      material,
      activeOnly: true,
      allowDuringStroke: false
    }],
    "brush-shader",
    "copy-scene"
  ]);
});

test("active layer projection prewarm seeds the active pass and depth target", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const material = { name: "active-material" };
  const record = {
    name: "active-record",
    geometry: { attributes: { uv: {} } }
  };
  const frame = {
    paintPassCache: new Map(),
    proxySceneCache: new Map(),
    probePaintPassCache: new Map()
  };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.canvas = {};
  editor.camera = {};
  editor.model = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.textureAirbrushPaintableMaterials = () => [{
    record,
    materialIndex: 2,
    material
  }];
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    calls.push(["live-frame", options]);
    return frame;
  };
  editor.textureAirbrushSeedProjectionFramePaintPass = (candidateFrame, candidateRecord, materialIndex, candidateMaterial, options) => {
    calls.push(["seed-pass", candidateFrame, candidateRecord, materialIndex, candidateMaterial, options]);
    return { key: "active-pass" };
  };
  editor.textureAirbrushRenderDepthTarget = (options) => {
    calls.push(["depth", options]);
    return { name: "depth-target" };
  };

  assert.equal(editor.prewarmTexturePaintActiveLayerProjectionGpu(material), true);
  assert.deepEqual(calls, [
    ["live-frame", { seedLayerProxies: false, seedPaintPasses: false }],
    ["depth", { reuse: true }],
    ["seed-pass", frame, record, 2, material, {
      seedLayerProxy: true,
      seedProbe: false
    }]
  ]);
  assert.equal(frame.depthTarget?.name, "depth-target");
});

test("camera-warmed active layer frame seeds the reset probe before live flush", () => {
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
  installTextureAirbrushScreenStrokeMethods(WebGlPrewarmEditor);
  const editor = new WebGlPrewarmEditor();
  const layer = {
    id: "paint-1",
    isEmpty: false,
    visible: true,
    opacity: 1
  };
  const targetEntry = {
    layerMode: true,
    emptyTransparent: false,
    target: { texture: {} },
    layer
  };
  layer.gpuTarget = targetEntry;
  const material = {
    uuid: "active-layer-material",
    userData: {
      texturePaintLayerStack: {
        activeLayerId: layer.id,
        layers: [layer]
      }
    }
  };
  const record = {
    object: { material },
    geometry: { attributes: { uv: {} } }
  };
  let scheduledFlushes = 0;
  editor.activeTool = "airbrush";
  editor.renderer = {
    getPixelRatio() {
      return 1;
    }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 200, height: 140 };
    }
  };
  editor.camera = {
    matrixWorldInverse: { elements: Array.from({ length: 16 }, (_, index) => index + 1) },
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, index) => index + 17) }
  };
  editor.model = {
    updateMatrixWorld() {}
  };
  editor.paintRecords = [record];
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintGpuPrewarmSnapshotCurrent = (candidate) => candidate === targetEntry;
  editor.textureAirbrushPaintableMaterials = () => [{
    record,
    materialIndex: 0,
    material
  }];
  editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
  editor.textureAirbrushGpuProxyForRecord = () => ({
    proxy: {
      skeleton: {
        update() {}
      }
    },
    scene: {}
  });
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduledFlushes += 1;
    return true;
  };

  assert.equal(editor.prewarmTexturePaintActiveLayerProjectionGpu(material), true);
  assert.equal(editor.textureAirbrushLiveProjectionFrameState.paintPassCache.size, 1);
  assert.equal(editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.size, 0);

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload({
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
  }), true);

  assert.equal(scheduledFlushes, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.deepEqual(
    editor.textureAirbrushLiveProjectionFrameState.probePaintPassCache.get("20:25")?.map((pass) => pass.targetEntry),
    [targetEntry]
  );
});
