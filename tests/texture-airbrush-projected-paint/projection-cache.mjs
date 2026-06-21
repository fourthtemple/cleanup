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

test("broad layer projection frame seeds non-active material proxies before first paint", () => {
  class WebGlLayerFrameEditor {}
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
  const editor = new WebGlLayerFrameEditor();
  const materials = [{ name: "active", userData: {} }, { name: "other", userData: {} }];
  const records = materials.map((material, index) => {
    const layer = {
      id: `paint-${index}`,
      visible: true,
      opacity: 1,
      isEmpty: true
    };
    const stack = {
      activeLayerId: layer.id,
      baseCanvas: {},
      width: 64,
      height: 64,
      layers: [layer]
    };
    const target = { name: `layer-target-${index}`, texture: { name: `layer-texture-${index}` } };
    const targetEntry = {
      target,
      width: 64,
      height: 64,
      material,
      layer,
      layerStack: stack,
      layerMode: true,
      emptyTransparent: true
    };
    layer.gpuTarget = targetEntry;
    material.userData.texturePaintLayerStack = stack;
    const object = { material };
    return {
      object,
      geometry: {
        uuid: `geometry-${index}`,
        attributes: { uv: {} }
      },
      targetEntry
    };
  });
  const renderedTargets = [];
  let activeTarget = null;
  let proxyRequests = 0;
  let undoCaptures = 0;
  let raycasts = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = materials[0];
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
      return { left: 0, top: 0, width: 200, height: 140 };
    }
  };
  editor.camera = {
    matrixWorldInverse: {},
    projectionMatrix: {}
  };
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = records;
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      raycasts += 1;
      assert.deepEqual(objects, records.map((record) => record.object));
      return [{
        object: records[0].object,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.textureAirbrushGpuTargetForMaterial = () => {
    throw new Error("seeded broad layer projection should not look up paint targets during first paint");
  };
  editor.clonePaintMaterialForHit = (record) => record?.object?.material || null;
  editor.captureTexturePaintGpuUndoTarget = () => {
    undoCaptures += 1;
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
    needsUpdate: true
  });
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => {
    proxyRequests += 1;
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (material) => {
    const record = records.find((entry) => entry.object.material === material);
    return { target: record.targetEntry.target };
  };
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  assert.equal(projectionFrame.paintPassCache.size, 2);
  assert.equal(projectionFrame.proxySceneCache.size, 2);
  assert.equal(proxyRequests, 2);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 90, clientY: 70 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
    radiusPixels: 20,
    color: { r: 255, g: 255, b: 0 },
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
  assert.equal(proxyRequests, 2);
  assert.equal(raycasts > 0, true);
  assert.equal(raycasts <= 12, true);
  assert.equal(undoCaptures, 1);
  assert.deepEqual(renderedTargets, ["layer-target-0"]);
});

test("lightweight layer projection frame defers broad proxy seeding until paint hits", () => {
  class WebGlLayerFrameEditor {}
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
  const materials = [{ name: "active", userData: {} }, { name: "other", userData: {} }];
  const records = materials.map((material, index) => {
    const layer = {
      id: `paint-${index}`,
      visible: true,
      opacity: 1,
      isEmpty: true
    };
    const stack = {
      activeLayerId: layer.id,
      baseCanvas: {},
      width: 64,
      height: 64,
      layers: [layer]
    };
    const target = { name: `layer-target-${index}`, texture: { name: `layer-texture-${index}` } };
    const targetEntry = {
      target,
      width: 64,
      height: 64,
      material,
      layer,
      layerStack: stack,
      layerMode: true,
      emptyTransparent: true
    };
    layer.gpuTarget = targetEntry;
    material.userData.texturePaintLayerStack = stack;
    return {
      object: { material },
      geometry: { attributes: { uv: {} } },
      targetEntry
    };
  });
  let proxyRequests = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = materials[0];
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 200, height: 140 };
    }
  };
  editor.camera = {};
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = records;
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.textureAirbrushGpuProxyForRecord = () => {
    proxyRequests += 1;
    return { scene: {} };
  };

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame({ seedLayerProxies: false });

  assert.equal(projectionFrame.paintPassCache.size, 2);
  assert.equal(projectionFrame.proxySceneCache.size, 0);
  assert.equal(proxyRequests, 0);
  projectionFrame.seedLayerProxies = true;
  assert.equal(editor.textureAirbrushSeedProjectionFrameLayerProxies(projectionFrame), 2);
  assert.equal(projectionFrame.proxySceneCache.size, 2);
  assert.equal(proxyRequests, 2);
});

test("minimal layer projection frame defers broad paint pass seeding until requested", () => {
  class WebGlLayerFrameEditor {}
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
  const materials = [{ name: "active", userData: {} }, { name: "other", userData: {} }];
  const records = materials.map((material, index) => {
    const layer = {
      id: `paint-${index}`,
      visible: true,
      opacity: 1,
      isEmpty: true
    };
    const stack = {
      activeLayerId: layer.id,
      baseCanvas: {},
      width: 64,
      height: 64,
      layers: [layer]
    };
    const targetEntry = {
      target: { name: `layer-target-${index}`, texture: { name: `layer-texture-${index}` } },
      width: 64,
      height: 64,
      material,
      layer,
      layerStack: stack,
      layerMode: true,
      emptyTransparent: true
    };
    layer.gpuTarget = targetEntry;
    material.userData.texturePaintLayerStack = stack;
    return {
      object: { material },
      geometry: { attributes: { uv: {} } },
      targetEntry
    };
  });
  let proxyRequests = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = materials[0];
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 200, height: 140 };
    }
  };
  editor.camera = {};
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = records;
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.textureAirbrushGpuProxyForRecord = () => {
    proxyRequests += 1;
    return { scene: {} };
  };

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame({
    seedLayerProxies: false,
    seedPaintPasses: false
  });

  assert.equal(projectionFrame.seedPaintPasses, false);
  assert.equal(projectionFrame.paintPassCache.size, 0);
  assert.equal(projectionFrame.proxySceneCache.size, 0);
  assert.equal(proxyRequests, 0);

  projectionFrame.seedPaintPasses = true;
  assert.equal(editor.textureAirbrushSeedProjectionFramePaintPasses(projectionFrame), 2);
  assert.equal(projectionFrame.paintPassCache.size, 2);
  assert.equal(projectionFrame.proxySceneCache.size, 0);
  assert.equal(proxyRequests, 0);

  projectionFrame.seedLayerProxies = true;
  assert.equal(editor.textureAirbrushSeedProjectionFrameLayerProxies(projectionFrame), 2);
  assert.equal(projectionFrame.proxySceneCache.size, 2);
  assert.equal(proxyRequests, 2);
});

test("minimal layer projection frame keeps probing after caching one hit pass", () => {
  class WebGlLayerFrameEditor {}
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
  const editor = new WebGlLayerFrameEditor();
  const materials = [{ name: "left", userData: {} }, { name: "right", userData: {} }];
  const records = materials.map((material, index) => {
    const layer = {
      id: `paint-${index}`,
      visible: true,
      opacity: 1,
      isEmpty: true
    };
    const stack = {
      activeLayerId: layer.id,
      baseCanvas: {},
      width: 64,
      height: 64,
      layers: [layer]
    };
    const targetEntry = {
      target: { name: `layer-target-${index}`, texture: { name: `layer-texture-${index}` } },
      width: 64,
      height: 64,
      material,
      layer,
      layerStack: stack,
      layerMode: true,
      emptyTransparent: true
    };
    layer.gpuTarget = targetEntry;
    material.userData.texturePaintLayerStack = stack;
    return {
      object: { material },
      geometry: {
        attributes: { uv: {} }
      },
      targetEntry
    };
  });
  const renderedTargets = [];
  let activeTarget = null;
  let targetRequests = 0;
  let raycasts = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintActiveMaterial = materials[0];
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
      return { left: 0, top: 0, width: 200, height: 140 };
    }
  };
  editor.camera = {
    matrixWorldInverse: {},
    projectionMatrix: {}
  };
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = records;
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      raycasts += 1;
      const record = editor.pointer.x < 0 ? records[0] : records[1];
      assert.deepEqual(objects, records.map((entry) => entry.object));
      return [{
        object: record.object,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.textureAirbrushGpuTargetForMaterial = (material) => {
    targetRequests += 1;
    return records.find((entry) => entry.object.material === material)?.targetEntry || null;
  };
  editor.clonePaintMaterialForHit = (record) => record?.object?.material || null;
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
    needsUpdate: true
  });
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (material) => {
    const record = records.find((entry) => entry.object.material === material);
    return { target: record.targetEntry.target };
  };
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame({
    seedLayerProxies: false,
    seedPaintPasses: false
  });

  assert.equal(projectionFrame.paintPassCache.size, 0);
  assert.equal(editor.textureAirbrushGpuProjectFromEvent({ clientX: 40, clientY: 70 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
    radiusPixels: 12,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: [{
      start: { clientX: 40, clientY: 70 },
      end: { clientX: 40, clientY: 70 }
    }]
  }) > 0, true);
  assert.equal(projectionFrame.paintPassCache.size, 1);

  assert.equal(editor.textureAirbrushGpuProjectFromEvent({ clientX: 160, clientY: 70 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
    radiusPixels: 12,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: [{
      start: { clientX: 160, clientY: 70 },
      end: { clientX: 160, clientY: 70 }
    }]
  }) > 0, true);

  assert.equal(projectionFrame.paintPassCache.size, 2);
  assert.equal(targetRequests, 0);
  assert.equal(raycasts > 1, true);
  assert.deepEqual(renderedTargets, ["layer-target-0", "layer-target-1"]);
  assert.equal(editor.texturePaintActiveMaterial, materials[1]);
});

test("layer airbrush projection does not seed stale background targets without a layer target", () => {
  class WebGlLayerFrameEditor {}
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
  const backgroundTargetEntry = {
    target: { name: "background-target", texture: { name: "background-target-texture" } }
  };
  const stack = {
    activeLayerId: "paint-1",
    layers: [{
      id: "paint-1",
      name: "Paint 1",
      visible: true,
      opacity: 1
    }]
  };
  const material = {
    uuid: "material-layer-missing-target",
    userData: {
      texturePaintLayerStack: stack,
      textureAirbrushGpuTarget: backgroundTargetEntry
    }
  };
  const record = {
    object: { material },
    geometry: { attributes: { uv: {} } }
  };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 220, height: 160 };
    }
  };
  editor.camera = {};
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = [record];
  editor.refreshSkinnedRaycastBounds = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  assert.equal(projectionFrame.paintPassCache.size, 0);
});

test("airbrush WebGL projection renders only hit cached paint passes", () => {
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
  const targetA = { name: "target-a", texture: {} };
  const targetB = { name: "target-b", texture: {} };
  const materialA = {
    uuid: "material-a",
    map: targetA.texture,
    userData: { textureAirbrushGpuTarget: { target: targetA } }
  };
  const materialB = {
    uuid: "material-b",
    map: targetB.texture,
    userData: { textureAirbrushGpuTarget: { target: targetB } }
  };
  const objectA = { material: materialA };
  const objectB = { material: materialB };
  const recordA = {
    object: objectA,
    geometry: { attributes: { uv: {} } }
  };
  const recordB = {
    object: objectB,
    geometry: { attributes: { uv: {} } }
  };
  const renderedTargets = [];
  const proxyRequests = [];
  let activeTarget = null;
  let targetLookups = 0;
  let undoCaptures = 0;
  let raycasts = 0;
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
  editor.paintRecords = [recordA, recordB];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      raycasts += 1;
      assert.deepEqual(objects, [objectA, objectB]);
      return [{
        object: objectA,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.clonePaintMaterialForHit = (record) => (record === recordA ? materialA : materialB);
  editor.textureAirbrushGpuTargetForMaterial = () => {
    targetLookups += 1;
    return null;
  };
  editor.captureTexturePaintGpuUndoTarget = (record) => {
    undoCaptures += 1;
    assert.equal(record, recordA);
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
  editor.textureAirbrushGpuProxyForRecord = (record) => {
    proxyRequests.push(record);
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  assert.equal(projectionFrame.paintPassCache.size, 2);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 90, clientY: 70 }, {
    gpu: true,
    projectionFrame,
    radiusPixels: 24,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    pressureApplied: true,
    strokeSegments: [{
      start: { clientX: 60, clientY: 70 },
      end: { clientX: 90, clientY: 70 }
    }]
  });

  assert.equal(changed > 0, true);
  assert.equal(targetLookups, 0);
  assert.equal(undoCaptures, 1);
  assert.equal(raycasts > 0, true);
  assert.equal(raycasts <= 12, true);
  assert.deepEqual(proxyRequests, [recordA]);
  assert.deepEqual(renderedTargets, ["target-a"]);
});

test("airbrush low spacing renders continuous strokes across cached paint passes", () => {
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
  const targetA = { name: "target-a", texture: {} };
  const targetB = { name: "target-b", texture: {} };
  const materialA = {
    uuid: "material-low-spacing-a",
    map: targetA.texture,
    userData: { textureAirbrushGpuTarget: { target: targetA } }
  };
  const materialB = {
    uuid: "material-low-spacing-b",
    map: targetB.texture,
    userData: { textureAirbrushGpuTarget: { target: targetB } }
  };
  const objectA = { material: materialA };
  const objectB = { material: materialB };
  const recordA = {
    object: objectA,
    geometry: { attributes: { uv: {} } }
  };
  const recordB = {
    object: objectB,
    geometry: { attributes: { uv: {} } }
  };
  const renderedTargets = [];
  const proxyRequests = [];
  const undoCaptures = [];
  let activeTarget = null;
  let targetLookups = 0;
  let raycasts = 0;
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
  editor.paintRecords = [recordA, recordB];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects() {
      raycasts += 1;
      return [];
    }
  };
  editor.clonePaintMaterialForHit = (record) => (record === recordA ? materialA : materialB);
  editor.textureAirbrushGpuTargetForMaterial = () => {
    targetLookups += 1;
    return null;
  };
  editor.captureTexturePaintGpuUndoTarget = (record) => {
    undoCaptures.push(record);
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
  editor.textureAirbrushGpuProxyForRecord = (record) => {
    proxyRequests.push(record);
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  assert.equal(projectionFrame.paintPassCache.size, 2);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 90, clientY: 70 }, {
    gpu: true,
    projectionFrame,
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
  assert.equal(targetLookups, 0);
  assert.equal(raycasts, 0);
  assert.deepEqual(undoCaptures, [recordA, recordB]);
  assert.deepEqual(proxyRequests, [recordA, recordB]);
  assert.deepEqual(renderedTargets, ["target-a", "target-b"]);
});
