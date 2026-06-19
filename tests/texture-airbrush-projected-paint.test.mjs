import assert from "node:assert/strict";
import test from "node:test";
import { installClonePaintMethods } from "../src/weight-editor/clone-paint.js";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../src/weight-editor/airbrush/constants.js";
import { installTextureAirbrushScreenStrokeMethods } from "../src/weight-editor/airbrush/screen-strokes.js";
import { installTextureAirbrushPointerMethods } from "../src/weight-editor/airbrush/pointer.js";
import { installTextureAirbrushWebGlBackendMethods } from "../src/weight-editor/airbrush/webgl-backend.js";
import { installTextureAirbrushProjectedPaintMethods } from "../src/weight-editor/airbrush/projected-paint.js";

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
    return {};
  };
  editor.textureAirbrushGpuTargetForMaterial = (candidateMaterial) => {
    calls.push(["target", candidateMaterial]);
    return { target: { texture: {} } };
  };
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    calls.push(["proxy", candidateRecord, materialIndex, candidateMaterial]);
    return {};
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
      end: { clientX: 40, clientY: 5 }
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

test("airbrush WebGL projection stops probing after all cached passes are found", () => {
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
    uuid: "material-stop-a",
    map: targetA.texture,
    userData: { textureAirbrushGpuTarget: { target: targetA } }
  };
  const materialB = {
    uuid: "material-stop-b",
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
      return [
        {
          object: objectA,
          face: { materialIndex: 0 },
          distance: 1
        },
        {
          object: objectB,
          face: { materialIndex: 0 },
          distance: 1.001
        }
      ];
    }
  };
  editor.clonePaintMaterialForHit = (record) => (record === recordA ? materialA : materialB);
  editor.textureAirbrushGpuTargetForMaterial = () => {
    targetLookups += 1;
    return null;
  };
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
  assert.equal(projectionFrame.paintPassCache.size, 2);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 150, clientY: 70 }, {
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
      end: { clientX: 150, clientY: 70 }
    }]
  });

  assert.equal(changed > 0, true);
  assert.equal(targetLookups, 0);
  assert.equal(undoCaptures, 2);
  assert.equal(raycasts, 1);
  assert.deepEqual(renderedTargets, ["target-a", "target-b"]);
});

test("airbrush WebGL projection discovers additional cached passes along long strokes", () => {
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
    uuid: "material-long-a",
    map: targetA.texture,
    userData: { textureAirbrushGpuTarget: { target: targetA } }
  };
  const materialB = {
    uuid: "material-long-b",
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
      const screenX = (editor.pointer.x + 1) * 110;
      const screenY = (1 - editor.pointer.y) * 80;
      const nearFullPathMidpoint = Math.abs(screenX - 105) < 0.01 && Math.abs(screenY - 70) < 0.01;
      return [{
        object: nearFullPathMidpoint ? objectB : objectA,
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

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 150, clientY: 70 }, {
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
      end: { clientX: 150, clientY: 70 }
    }]
  });

  assert.equal(changed > 0, true);
  assert.equal(targetLookups, 0);
  assert.equal(undoCaptures, 2);
  assert.equal(raycasts > 1, true);
  assert.equal(raycasts <= 18, true);
  assert.deepEqual(proxyRequests, [recordA, recordB]);
  assert.deepEqual(renderedTargets, ["target-a", "target-b"]);
});

test("airbrush WebGL UV bleed offsets are cached per target and radius band", () => {
  class WebGlOffsetEditor {}
  let vectorAllocations = 0;
  installTextureAirbrushWebGlBackendMethods(WebGlOffsetEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          vectorAllocations += 1;
          this.x = x;
          this.y = y;
        }
      }
    }
  });
  const editor = new WebGlOffsetEditor();
  const targetEntry = { width: 512, height: 256 };

  const smallOffsets = editor.textureAirbrushGpuUvBleedOffsets(targetEntry, 8);
  const smallOffsetsAgain = editor.textureAirbrushGpuUvBleedOffsets(targetEntry, 9);
  const mediumOffsets = editor.textureAirbrushGpuUvBleedOffsets(targetEntry, 10);
  const mediumOffsetsAgain = editor.textureAirbrushGpuUvBleedOffsets(targetEntry, 16);
  const largeOffsets = editor.textureAirbrushGpuUvBleedOffsets(targetEntry, 17);
  const largeOffsetsAgain = editor.textureAirbrushGpuUvBleedOffsets(targetEntry, 72);

  assert.equal(smallOffsets, smallOffsetsAgain);
  assert.equal(mediumOffsets, mediumOffsetsAgain);
  assert.equal(largeOffsets, largeOffsetsAgain);
  assert.equal(smallOffsets.length, 1);
  assert.equal(mediumOffsets.length, 5);
  assert.equal(largeOffsets.length, 13);
  assert.equal(vectorAllocations, 19);
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

test("airbrush brush cursor skips repeated class writes for the same mode", () => {
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
    ["is-deselect", false]
  ]);

  assert.equal(editor.setTextureBrushCursorMode("clone"), true);
  assert.equal(toggles.length, 6);

  editor.hideTextureBrushCursor();
  assert.equal(removes.length, 1);
  assert.equal(editor.setTextureBrushCursorMode("clone"), true);
  assert.equal(toggles.length, 9);
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

test("active pen airbrush cursor batches move transforms to animation frames", () => {
  class PointerEditor {}
  installPaintToolMethods(PointerEditor, {});
  installTextureAirbrushPointerMethods(PointerEditor);
  const editor = new PointerEditor();
  const originalWindow = globalThis.window;
  const animationFrameCallbacks = [];
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
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }
    };
    editor.activeTool = "airbrush";
    editor.textureAirbrushStrokeBrushState = { radiusPixels: 14 };
    editor.textureBrushCursor = {
      hidden: false,
      style,
      classList: {
        toggle() {},
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

    editor.painting = false;
    assert.equal(editor.showTextureStrokeCursor({ clientX: 40, clientY: 60, pointerType: "pen" }), true);
    editor.painting = true;
    assert.equal(editor.showTextureStrokeCursor({ clientX: 44, clientY: 64, pointerType: "pen" }), true);
    assert.equal(editor.showTextureStrokeCursor({ clientX: 50, clientY: 70, pointerType: "pen" }), true);

    assert.deepEqual(transforms, ["translate3d(16px, 26px, 0)"]);
    assert.equal(animationFrameCallbacks.length, 1);

    animationFrameCallbacks.shift()();

    assert.deepEqual(transforms, [
      "translate3d(16px, 26px, 0)",
      "translate3d(26px, 36px, 0)"
    ]);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("airbrush WebGL readback creates a canvas from render target pixels", () => {
  class WebGlReadbackEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlReadbackEditor, { THREE: {} });
  const previousDocument = globalThis.document;
  let writtenImage = null;
  globalThis.document = {
    createElement(name) {
      assert.equal(name, "canvas");
      return {
        width: 0,
        height: 0,
        getContext(type) {
          assert.equal(type, "2d");
          return {
            createImageData(width, height) {
              return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData(image) {
              writtenImage = image;
            }
          };
        }
      };
    }
  };
  try {
    const editor = new WebGlReadbackEditor();
    editor.renderer = {
      getRenderTarget() {
        return "previous-target";
      },
      setRenderTarget(target) {
        assert.equal(target, "previous-target");
      },
      readRenderTargetPixels(target, x, y, width, height, buffer) {
        assert.equal(target.name, "paint-target");
        assert.equal(x, 0);
        assert.equal(y, 0);
        assert.equal(width, 2);
        assert.equal(height, 2);
        buffer.set([
          1, 2, 3, 255,
          4, 5, 6, 255,
          7, 8, 9, 255,
          10, 11, 12, 255
        ]);
      }
    };

    const editable = editor.textureAirbrushCanvasFromRenderTarget({
      target: { name: "paint-target", width: 2, height: 2, texture: {} },
      width: 2,
      height: 2
    });

    assert.equal(editable.canvas.width, 2);
    assert.equal(editable.canvas.height, 2);
    assert.deepEqual([...writtenImage.data], [
      7, 8, 9, 255,
      10, 11, 12, 255,
      1, 2, 3, 255,
      4, 5, 6, 255
    ]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("airbrush WebGL flush bakes render targets into editable canvas textures", () => {
  class CanvasTexture {
    constructor(canvas) {
      this.image = canvas;
      this.name = "";
      this.needsUpdate = false;
    }
  }
  class WebGlFlushEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlFlushEditor, { THREE: { CanvasTexture } });
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData() {}
          };
        }
      };
    }
  };
  try {
    let targetDisposed = false;
    let previousTextureDisposed = false;
    const previousTexture = {
      dispose() {
        previousTextureDisposed = true;
      }
    };
    const targetEntry = {
      sourceTexture: {},
      target: {
        width: 1,
        height: 1,
        texture: { name: "paint-target" },
        dispose() {
          targetDisposed = true;
        }
      },
      width: 1,
      height: 1
    };
    const material = {
      map: targetEntry.target.texture,
      userData: {
        clonePaintTexture: previousTexture,
        textureAirbrushGpuTarget: targetEntry
      }
    };
    const editor = new WebGlFlushEditor();
    editor.renderer = {
      getRenderTarget() {
        return null;
      },
      setRenderTarget() {},
      readRenderTargetPixels(target, x, y, width, height, buffer) {
        buffer.set([12, 13, 14, 255]);
      }
    };
    editor.textureAirbrushPaintableMaterials = () => [{ material }];
    editor.textureAirbrushCopyTextureRenderSettings = (texture) => {
      texture.copiedSettings = true;
      return true;
    };
    editor.textureAirbrushGpuProxies = new Map([["proxy", {}]]);
    editor.updateClonePaintPreviews = () => {};

    const flushed = editor.flushTextureAirbrushGpuTargetsToCanvases();

    assert.equal(flushed, 1);
    assert.equal(material.map instanceof CanvasTexture, true);
    assert.equal(material.userData.clonePaintTexture, material.map);
    assert.equal(material.userData.clonePaintCanvas, material.map.image);
    assert.equal(material.userData.textureAirbrushGpuTarget, undefined);
    assert.equal(targetDisposed, true);
    assert.equal(previousTextureDisposed, true);
    assert.equal(editor.textureAirbrushGpuProxies.size, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("editable texture requests bake active WebGL airbrush targets without losing paint", () => {
  class CanvasTexture {
    constructor(canvas) {
      this.image = canvas;
      this.name = "";
      this.needsUpdate = false;
    }
  }
  class CloneEditor {}
  installClonePaintMethods(CloneEditor, {
    THREE: {
      CanvasTexture,
      SRGBColorSpace: "srgb",
      ClampToEdgeWrapping: "clamp",
      LinearFilter: "linear"
    }
  });
  const editor = new CloneEditor();
  const canvas = { width: 2, height: 2 };
  const context = {};
  const sourceTexture = {
    name: "original-source",
    userData: { clonePaintTextureScale: 3 }
  };
  const targetTexture = { name: "painted-target" };
  let disposed = false;
  let copiedSettingsFrom = null;
  const gpuEntry = {
    sourceTexture,
    target: {
      texture: targetTexture,
      dispose() {
        disposed = true;
      }
    }
  };
  const material = {
    map: targetTexture,
    userData: {
      textureAirbrushGpuTarget: gpuEntry
    }
  };
  editor.textureAirbrushCanvasFromRenderTarget = (entry) => {
    assert.equal(entry, gpuEntry);
    return { canvas, context };
  };
  editor.textureAirbrushCopyTextureRenderSettings = (texture, source) => {
    copiedSettingsFrom = source;
    texture.settingsCopied = true;
    return true;
  };
  editor.textureAirbrushGpuProxies = new Map([["proxy", {}]]);

  const editable = editor.editableClonePaintTexture(material);

  assert.equal(editable.canvas, canvas);
  assert.equal(editable.context, context);
  assert.equal(material.map instanceof CanvasTexture, true);
  assert.equal(material.map.image, canvas);
  assert.equal(material.map.settingsCopied, true);
  assert.equal(material.userData.clonePaintCanvas, canvas);
  assert.equal(material.userData.clonePaintContext, context);
  assert.equal(material.userData.clonePaintTexture, material.map);
  assert.equal(material.userData.clonePaintTextureScale, 3);
  assert.equal(material.userData.textureAirbrushGpuTarget, undefined);
  assert.equal(copiedSettingsFrom, targetTexture);
  assert.equal(disposed, true);
  assert.equal(editor.textureAirbrushGpuProxies.size, 0);
});

test("airbrush texture strokes queue coalesced pointer samples without synchronous paint", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  editor.activeTool = "airbrush";
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushShouldInterpolateContinuousStroke = () => false;
  editor.textureAirbrushQueueScreenStroke = (event, options) => {
    queued.push({
      end: { clientX: event.clientX, clientY: event.clientY },
      start: { ...options.strokeStart },
      pressure: event.pressure,
      pointerType: event.pointerType
    });
    return true;
  };
  editor.paintFromEvent = () => {
    throw new Error("airbrush should not paint synchronously from pointer input");
  };

  assert.equal(editor.paintTextureStrokeFromEvent({
    clientX: 30,
    clientY: 8,
    pressure: 0.6,
    pointerType: "pen",
    getCoalescedEvents() {
      return [
        { clientX: 10, clientY: 2, pressure: 0.2, pointerType: "pen" },
        { clientX: 20, clientY: 5, pressure: 0.4, pointerType: "pen" },
        { clientX: 30, clientY: 8, pressure: 0.6, pointerType: "pen" }
      ];
    }
  }), true);

  assert.deepEqual(queued, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 10, clientY: 2 },
      pressure: 0.2,
      pointerType: "pen"
    },
    {
      start: { clientX: 10, clientY: 2 },
      end: { clientX: 20, clientY: 5 },
      pressure: 0.4,
      pointerType: "pen"
    },
    {
      start: { clientX: 20, clientY: 5 },
      end: { clientX: 30, clientY: 8 },
      pressure: 0.6,
      pointerType: "pen"
    }
  ]);
  assert.deepEqual(editor.texturePaintStrokePoint, { clientX: 30, clientY: 8 });
});

test("primary pen pointer down still starts an airbrush stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let capturedPointer = null;
  let undoLabel = null;
  let cursorShown = null;
  let painted = null;
  let prevented = 0;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {
    setPointerCapture(pointerId) {
      capturedPointer = pointerId;
    }
  };
  editor.showTextureStrokeCursor = (event) => {
    cursorShown = event.pointerType;
  };
  editor.beginTexturePaintStrokeUndo = (label) => {
    undoLabel = label;
  };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted = {
      pointerType: event.pointerType,
      button: event.button,
      reset: options?.reset === true
    };
    return true;
  };

  editor.onPointerDown({
    button: 0,
    buttons: 1,
    pointerId: 23,
    pointerType: "pen",
    clientX: 120,
    clientY: 80,
    pressure: 0.5,
    preventDefault() {
      prevented += 1;
    }
  });

  assert.equal(prevented, 1);
  assert.equal(editor.painting, true);
  assert.equal(editor.controls.enabled, false);
  assert.equal(capturedPointer, 23);
  assert.equal(cursorShown, "pen");
  assert.equal(undoLabel, "Texture airbrush");
  assert.deepEqual(painted, {
    pointerType: "pen",
    button: 0,
    reset: true
  });
});

test("airbrush coalesced samples use lightweight point events", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const samples = editor.texturePaintCoalescedEvents({
    clientX: 20,
    clientY: 4,
    pointerType: "pen",
    pressure: 0.6,
    tiltX: 11,
    preventDefault() {
      throw new Error("coalesced sample normalization should not bind preventDefault");
    },
    getCoalescedEvents() {
      return [
        { clientX: 10, clientY: 2, pressure: 0.4, pointerType: "pen", tiltX: 7 },
        { clientX: 20, clientY: 4, pressure: 0.6, pointerType: "pen", tiltX: 11 }
      ];
    }
  });

  assert.deepEqual(samples.map((event) => ({
    x: event.clientX,
    y: event.clientY,
    pressure: event.pressure,
    pointerType: event.pointerType,
    tiltX: event.tiltX,
    hasPreventDefault: typeof event.preventDefault === "function"
  })), [
    { x: 10, y: 2, pressure: 0.4, pointerType: "pen", tiltX: 7, hasPreventDefault: false },
    { x: 20, y: 4, pressure: 0.6, pointerType: "pen", tiltX: 11, hasPreventDefault: false }
  ]);
});

test("airbrush preserves dense coalesced pen samples before normalizing them", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const originalEventAtPoint = editor.textureAirbrushInputEventAtPoint.bind(editor);
  let normalized = 0;
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushInputEventAtPoint = (sourceEvent, point, fallbackEvent) => {
    normalized += 1;
    return originalEventAtPoint(sourceEvent, point, fallbackEvent);
  };

  const events = editor.textureAirbrushStrokeInputEvents({
    clientX: 60,
    clientY: 0,
    pressure: 0.5,
    pointerType: "pen",
    getCoalescedEvents() {
      return Array.from({ length: 60 }, (_, index) => ({
        clientX: index + 1,
        clientY: 0,
        pressure: 0.5,
        pointerType: "pen"
      }));
    }
  });

  assert.deepEqual(events.map((event) => event.clientX), Array.from({ length: 60 }, (_, index) => index + 1));
  assert.equal(normalized, 60);
});

test("airbrush live queue uses raw pen samples without normalizing retained points", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  const originalEventAtPoint = editor.textureAirbrushInputEventAtPoint.bind(editor);
  let normalized = 0;
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushContinuousSampleStepPixels = () => 100;
  editor.textureAirbrushInputEventAtPoint = (sourceEvent, point, fallbackEvent) => {
    normalized += 1;
    return originalEventAtPoint(sourceEvent, point, fallbackEvent);
  };
  editor.textureAirbrushQueueScreenStroke = (event, options) => {
    queued.push({
      x: event.clientX,
      pressure: event.pressure,
      startX: options.strokeStart.clientX
    });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 60,
    clientY: 0,
    pressure: 0.5,
    pointerType: "pen",
    getCoalescedEvents() {
      return Array.from({ length: 60 }, (_, index) => ({
        clientX: index + 1,
        clientY: 0,
        pressure: 0.5,
        pointerType: "pen"
      }));
    }
  }), true);

  assert.equal(normalized, 0);
  assert.equal(queued.length, 60);
  assert.deepEqual(queued.at(0), { x: 1, pressure: 0.5, startX: 0 });
  assert.deepEqual(queued.at(-1), { x: 60, pressure: 0.5, startX: 59 });
  assert.deepEqual(queued.map((entry) => entry.x), Array.from({ length: 60 }, (_, index) => index + 1));
});

test("airbrush input sampling settings are cached for a stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let radiusReads = 0;
  let spacingReads = 0;
  editor.textureBrushRadiusScreenPixels = () => {
    radiusReads += 1;
    return 10;
  };
  editor.textureAirbrushSpacingPercent = () => {
    spacingReads += 1;
    return 1;
  };

  assert.equal(editor.textureAirbrushShouldInterpolateContinuousStroke(), true);
  assert.equal(editor.textureAirbrushContinuousSampleStepPixels(), 7.5);
  assert.equal(radiusReads, 1);
  assert.equal(spacingReads, 1);

  editor.textureAirbrushResetInputSamplingState();
  assert.equal(editor.textureAirbrushContinuousSampleStepPixels(), 7.5);
  assert.equal(radiusReads, 2);
  assert.equal(spacingReads, 2);
});

test("airbrush interpolated smooth mouse samples keep pointer values", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureAirbrushShouldInterpolateContinuousStroke = () => true;
  editor.textureAirbrushContinuousSampleStepPixels = () => 4;
  editor.textureAirbrushQueueScreenStroke = (event, options) => {
    queued.push({
      x: event.clientX,
      pressure: event.pressure,
      pointerType: event.pointerType,
      tiltX: event.tiltX,
      startX: options.strokeStart.clientX
    });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 12,
    clientY: 0,
    pressure: 0.35,
    pointerType: "mouse",
    tiltX: 17
  }), true);

  assert.deepEqual(queued, [
    { x: 4, pressure: 0.35, pointerType: "mouse", tiltX: 17, startX: 0 },
    { x: 8, pressure: 0.35, pointerType: "mouse", tiltX: 17, startX: 4 },
    { x: 12, pressure: 0.35, pointerType: "mouse", tiltX: 17, startX: 8 }
  ]);
});

test("airbrush single pen moves use one continuous stroke segment", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureAirbrushShouldInterpolateContinuousStroke = () => true;
  editor.textureAirbrushContinuousSampleStepPixels = () => 4;
  editor.textureAirbrushQueueScreenStroke = (event, options) => {
    queued.push({
      x: event.clientX,
      pressure: event.pressure,
      pointerType: event.pointerType,
      tiltX: event.tiltX,
      startX: options.strokeStart.clientX
    });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 12,
    clientY: 0,
    pressure: 0.35,
    pointerType: "pen",
    tiltX: 17
  }), true);

  assert.deepEqual(queued, [
    { x: 12, pressure: 0.35, pointerType: "pen", tiltX: 17, startX: 0 }
  ]);
});

test("airbrush preserves dense pen coalesced samples without re-densifying them", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureAirbrushShouldInterpolateContinuousStroke = () => true;
  editor.textureAirbrushContinuousSampleStepPixels = () => 6;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushQueueScreenStroke = (event) => {
    queued.push({
      x: event.clientX,
      pressure: event.pressure
    });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 12,
    clientY: 0,
    pressure: 0.32,
    pointerType: "pen",
    getCoalescedEvents() {
      return Array.from({ length: 12 }, (_, index) => ({
        clientX: index + 1,
        clientY: 0,
        pressure: index % 2 === 0 ? 0.31 : 0.33,
        pointerType: "pen"
      }));
    }
  }), true);

  assert.deepEqual(queued.map((entry) => Math.round(entry.x * 10) / 10), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(queued.length, 12);
});

test("airbrush preserves jittery high-rate pen packets before live queueing", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureAirbrushShouldInterpolateContinuousStroke = () => true;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushQueueScreenStroke = (event, options) => {
    queued.push({
      x: event.clientX,
      y: event.clientY,
      startX: options.strokeStart.clientX,
      startY: options.strokeStart.clientY
    });
    return true;
  };
  const coalesced = Array.from({ length: 1200 }, (_, index) => ({
    clientX: index * 0.75,
    clientY: index % 2 === 0 ? -8 : 8,
    pressure: 0.5,
    pointerType: "pen"
  }));

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: coalesced.at(-1).clientX,
    clientY: coalesced.at(-1).clientY,
    pressure: 0.5,
    pointerType: "pen",
    getCoalescedEvents() {
      return coalesced;
    }
  }), true);

  assert.equal(queued.length, coalesced.length);
  assert.deepEqual(queued.at(0), {
    x: coalesced[0].clientX,
    y: coalesced[0].clientY,
    startX: 0,
    startY: 0
  });
  assert.deepEqual({
    x: queued.at(-1).x,
    y: queued.at(-1).y
  }, {
    x: coalesced.at(-1).clientX,
    y: coalesced.at(-1).clientY
  });
  assert.deepEqual(editor.texturePaintStrokePoint, {
    clientX: coalesced.at(-1).clientX,
    clientY: coalesced.at(-1).clientY
  });
});

test("airbrush keeps dense curved coalesced pen packets complete and curved", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  let normalized = 0;
  const originalEventAtPoint = editor.textureAirbrushInputEventAtPoint.bind(editor);
  editor.texturePaintStrokePoint = { clientX: 40, clientY: 170 };
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushContinuousSampleStepPixels = () => 8;
  editor.textureAirbrushInputEventAtPoint = (sourceEvent, point, fallbackEvent) => {
    normalized += 1;
    return originalEventAtPoint(sourceEvent, point, fallbackEvent);
  };
  editor.textureAirbrushQueueScreenStroke = (event, options) => {
    queued.push({
      x: event.clientX,
      y: event.clientY,
      pressure: event.pressure,
      startX: options.strokeStart.clientX,
      startY: options.strokeStart.clientY
    });
    return true;
  };

  const sampleCount = 240;
  const coalesced = Array.from({ length: sampleCount }, (_, index) => {
    const t = index / (sampleCount - 1);
    return {
      clientX: 42 + t * 420,
      clientY: 170 + Math.sin(t * Math.PI * 2.35) * 54,
      pressure: 0.38 + t * 0.28,
      pointerType: "pen"
    };
  });

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: coalesced.at(-1).clientX,
    clientY: coalesced.at(-1).clientY,
    pressure: coalesced.at(-1).pressure,
    pointerType: "pen",
    getCoalescedEvents() {
      return coalesced;
    }
  }), true);

  const yValues = queued.map((entry) => entry.y);
  assert.equal(normalized, 0);
  assert.equal(queued.length, sampleCount);
  assert.equal(Math.max(...yValues) - Math.min(...yValues) > 85, true);
  assert.deepEqual(queued.at(0), {
    x: 42,
    y: 170,
    pressure: 0.38,
    startX: 40,
    startY: 170
  });
  assert.equal(Math.round(queued.at(-1).x), 462);
  assert.deepEqual(editor.texturePaintStrokePoint, {
    clientX: coalesced.at(-1).clientX,
    clientY: coalesced.at(-1).clientY
  });
});

test("airbrush preserves pen pressure changes from coalesced input", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const queued = [];
  editor.texturePaintStrokePoint = { clientX: 0, clientY: 0 };
  editor.textureAirbrushShouldInterpolateContinuousStroke = () => true;
  editor.textureAirbrushContinuousSampleStepPixels = () => 6;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushQueueScreenStroke = (event) => {
    queued.push({
      x: event.clientX,
      pressure: event.pressure
    });
    return true;
  };

  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    clientX: 12,
    clientY: 0,
    pressure: 0.75,
    pointerType: "pen",
    getCoalescedEvents() {
      return [
        { clientX: 1, clientY: 0, pressure: 0.25, pointerType: "pen" },
        { clientX: 2, clientY: 0, pressure: 0.26, pointerType: "pen" },
        { clientX: 3, clientY: 0, pressure: 0.27, pointerType: "pen" },
        { clientX: 6, clientY: 0, pressure: 0.52, pointerType: "pen" },
        { clientX: 9, clientY: 0, pressure: 0.53, pointerType: "pen" },
        { clientX: 12, clientY: 0, pressure: 0.75, pointerType: "pen" }
      ];
    }
  }), true);

  assert.deepEqual(queued.map((entry) => ({
    x: entry.x,
    pressure: entry.pressure
  })), [
    { x: 1, pressure: 0.25 },
    { x: 2, pressure: 0.26 },
    { x: 3, pressure: 0.27 },
    { x: 6, pressure: 0.52 },
    { x: 9, pressure: 0.53 },
    { x: 12, pressure: 0.75 }
  ]);
});

test("airbrush screen stroke payload preserves long fast segments as continuous lines", () => {
  class SpacingEditor {}
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const payload = editor.textureAirbrushScreenStrokePayload({
    clientX: 360,
    clientY: 120
  }, {
    clientX: 10,
    clientY: 20
  });

  assert.deepEqual(payload.strokeStart, { clientX: 10, clientY: 20 });
  assert.equal(payload.clientX, 360);
  assert.equal(payload.clientY, 120);
});

test("airbrush screen stroke payload caches stable brush controls but keeps pressure live", () => {
  class SpacingEditor {}
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  let radiusReads = 0;
  let opacityReads = 0;
  let hardnessReads = 0;
  let scatterReads = 0;
  let spacingReads = 0;
  let colorReads = 0;
  let pressureSettingReads = 0;
  editor.textureBrushRadiusScreenPixels = () => {
    radiusReads += 1;
    return 10;
  };
  editor.textureAirbrushOpacity = () => {
    opacityReads += 1;
    return 0.5;
  };
  editor.textureAirbrushHardness = () => {
    hardnessReads += 1;
    return 0.35;
  };
  editor.textureAirbrushScatter = () => {
    scatterReads += 1;
    return 0.25;
  };
  editor.textureAirbrushSpacingPercent = () => {
    spacingReads += 1;
    return 1;
  };
  editor.textureAirbrushColor = () => {
    colorReads += 1;
    return { r: 255, g: 0, b: 0 };
  };
  editor.textureAirbrushPressureSettings = () => {
    pressureSettingReads += 1;
    return { radius: true, opacity: false, hardness: false, scatter: false };
  };
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    radiusPixels: options.pressureRadius ? options.radiusPixels * event.pressure : options.radiusPixels,
    pressureApplied: true
  });

  const first = editor.textureAirbrushScreenStrokePayload({
    clientX: 10,
    clientY: 10,
    pointerType: "pen",
    pressure: 0.4
  }, { clientX: 0, clientY: 0 });
  const second = editor.textureAirbrushScreenStrokePayload({
    clientX: 20,
    clientY: 10,
    pointerType: "pen",
    pressure: 0.7
  }, { clientX: 10, clientY: 10 });

  assert.equal(first.radiusPixels, 4);
  assert.equal(second.radiusPixels, 7);
  assert.equal(first.pressure, 0.4);
  assert.equal(second.pressure, 0.7);
  assert.equal(radiusReads, 1);
  assert.equal(opacityReads, 1);
  assert.equal(hardnessReads, 1);
  assert.equal(scatterReads, 1);
  assert.equal(spacingReads, 1);
  assert.equal(colorReads, 1);
  assert.equal(pressureSettingReads, 1);

  editor.textureAirbrushResetStrokeBrushState();
  editor.textureAirbrushScreenStrokePayload({
    clientX: 30,
    clientY: 10,
    pointerType: "pen",
    pressure: 0.9
  }, { clientX: 20, clientY: 10 });

  assert.equal(radiusReads, 2);
  assert.equal(opacityReads, 2);
  assert.equal(hardnessReads, 2);
  assert.equal(scatterReads, 2);
  assert.equal(spacingReads, 2);
  assert.equal(colorReads, 2);
  assert.equal(pressureSettingReads, 2);
});

test("airbrush screen batches reuse cached payload style", () => {
  class SpacingEditor {}
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.25;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushPressureSettings = () => ({ radius: false, opacity: false, hardness: false, scatter: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;

  const first = editor.textureAirbrushScreenStrokePayload({ clientX: 0, clientY: 0 }, { clientX: 0, clientY: 0 });
  const second = editor.textureAirbrushScreenStrokePayload({ clientX: 12, clientY: 0 }, { clientX: 0, clientY: 0 });

  editor.textureBrushRadiusScreenPixels = () => {
    throw new Error("cached style should provide radius");
  };
  editor.textureAirbrushOpacity = () => {
    throw new Error("cached style should provide opacity");
  };
  editor.textureAirbrushHardness = () => {
    throw new Error("cached style should provide hardness");
  };
  editor.textureAirbrushScatter = () => {
    throw new Error("cached style should provide scatter");
  };
  editor.textureAirbrushColor = () => {
    throw new Error("cached style should provide color");
  };

  const [batch] = editor.textureAirbrushScreenStrokeBatches([first, second]);

  assert.equal(batch.styleKey, first.styleKey);
  assert.equal(batch.radiusPixels, 10);
  assert.deepEqual(batch.color, { r: 255, g: 0, b: 0 });
  assert.equal(batch.opacity, 0.5);
  assert.equal(batch.hardness, 0.35);
  assert.equal(batch.scatter, 0.25);
  assert.deepEqual(batch.strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 0, clientY: 0 }
    },
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 12, clientY: 0 }
    }
  ]);
});

test("airbrush queue coalescing keeps the existing payload object", () => {
  class SpacingEditor {}
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  let scheduled = 0;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  const payload = (startX, endX) => ({
    clientX: endX,
    clientY: 0,
    strokeStart: { clientX: startX, clientY: 0 },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.5,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1
  });

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(payload(0, 10)), true);
  const retainedPayload = editor.textureAirbrushScreenStrokeQueue[0];

  assert.equal(editor.textureAirbrushQueueScreenStrokePayload(payload(10, 20)), true);

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0], retainedPayload);
  assert.deepEqual({
    startX: retainedPayload.strokeStart.clientX,
    endX: retainedPayload.clientX
  }, {
    startX: 0,
    endX: 20
  });
});

test("airbrush high spacing queues stamps along fast pointer movement before flushing", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  const projected = [];
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPixels = () => 5;
  editor.textureAirbrushSpacingPercent = () => 125;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => true;
  editor.drawTextureAirbrushScreenStrokePreview = () => {
    throw new Error("airbrush should not draw a fake preview before texture paint");
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      segments: options.strokeSegments.map((segment) => ({
        startX: Math.round(segment.start.clientX),
        startY: Math.round(segment.start.clientY),
        endX: Math.round(segment.end.clientX),
        endY: Math.round(segment.end.clientY)
      }))
    });
    return 1;
  };

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0 }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({ clientX: 12, clientY: 0 });

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 3);
  assert.deepEqual(projected, []);

  editor.flushTextureAirbrushScreenStroke();

  assert.deepEqual(projected, [
    {
      x: 10,
      y: 0,
      segments: [
        { startX: 0, startY: 0, endX: 0, endY: 0 },
        { startX: 5, startY: 0, endX: 5, endY: 0 },
        { startX: 10, startY: 0, endX: 10, endY: 0 }
      ]
    }
  ]);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
  assert.deepEqual(editor.texturePaintStrokePoint, { clientX: 12, clientY: 0 });
});

test("airbrush low spacing queues continuous smooth stroke segments before flushing", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  const projected = [];
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPixels = () => 0.2;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => true;
  editor.drawTextureAirbrushScreenStrokePreview = () => {
    throw new Error("airbrush should not draw a fake preview before texture paint");
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: Math.round(event.clientX),
      spacing: options.spacing,
      segments: options.strokeSegments.map((segment) => ({
        startX: Math.round(segment.start.clientX),
        endX: Math.round(segment.end.clientX)
      }))
    });
    return 1;
  };

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0 }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({ clientX: 12, clientY: 0 });

  assert.equal(scheduled, 1);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
  assert.deepEqual(projected, []);

  editor.flushTextureAirbrushScreenStroke();

  assert.deepEqual(projected, [
    {
      x: 12,
      spacing: 1,
      segments: [
        { startX: 0, endX: 0 },
        { startX: 0, endX: 12 }
      ]
    }
  ]);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
});

test("airbrush coalesces repeated same-style continuous moves before flushing", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  let scheduled = 0;
  let pressureCalls = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushContinuousSampleStepPixels = () => 50;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => {
    pressureCalls += 1;
    return options;
  };
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0 }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({ clientX: 2, clientY: 0 });
  const continuousPayload = editor.textureAirbrushScreenStrokeQueue[1];
  for (let index = 2; index <= 30; index += 1) {
    editor.queueAirbrushTextureStrokeEvent({ clientX: index * 2, clientY: 0 });
  }

  assert.equal(scheduled, 1);
  assert.equal(pressureCalls, 2);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[1], continuousPayload);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue.map((payload) => ({
    startX: payload.strokeStart.clientX,
    endX: payload.clientX
  })), [
    { startX: 0, endX: 0 },
    { startX: 0, endX: 60 }
  ]);
});

test("airbrush queue coalescing preserves bends", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushContinuousSampleStepPixels = () => 50;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  [
    { clientX: 0, clientY: 0, reset: true },
    { clientX: 10, clientY: 0 },
    { clientX: 20, clientY: 0 },
    { clientX: 24, clientY: 18 }
  ].forEach((point) => {
    editor.queueAirbrushTextureStrokeEvent(point, { reset: point.reset === true });
  });

  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue.map((payload) => ({
    start: payload.strokeStart,
    end: { clientX: payload.clientX, clientY: payload.clientY }
  })), [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 0, clientY: 0 }
    },
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 20, clientY: 0 }
    },
    {
      start: { clientX: 20, clientY: 0 },
      end: { clientX: 24, clientY: 18 }
    }
  ]);
});

test("airbrush low spacing applies pen pressure once per queued continuous sample", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  let pressureCalls = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushContinuousSampleStepPixels = () => 50;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.textureAirbrushOptionsWithPressure = (event, options) => {
    pressureCalls += 1;
    return {
      ...options,
      pressure: event.pressure,
      pressureRadius: true,
      radiusPixels: options.radiusPixels * event.pressure,
      pressureApplied: true
    };
  };

  editor.queueAirbrushTextureStrokeEvent({
    clientX: 0,
    clientY: 0,
    pointerType: "pen",
    pressure: 0.5
  }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({
    clientX: 12,
    clientY: 0,
    pointerType: "pen",
    pressure: 0.6
  });

  assert.equal(pressureCalls, 2);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
});

test("airbrush screen batches preserve queued straight strokes and bends", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const segment = (startX, startY, endX, endY) => ({
    clientX: endX,
    clientY: endY,
    strokeStart: { clientX: startX, clientY: startY },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });

  const [batch] = editor.textureAirbrushScreenStrokeBatches([
    segment(0, 0, 10, 0),
    segment(10, 0, 20, 0),
    segment(20, 0, 30, 0),
    segment(30, 0, 30, 16)
  ]);

  assert.deepEqual(batch.strokeSegments.map((entry) => ({
    start: entry.start,
    end: entry.end
  })), [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 10, clientY: 0 }
    },
    {
      start: { clientX: 10, clientY: 0 },
      end: { clientX: 20, clientY: 0 }
    },
    {
      start: { clientX: 20, clientY: 0 },
      end: { clientX: 30, clientY: 0 }
    },
    {
      start: { clientX: 30, clientY: 0 },
      end: { clientX: 30, clientY: 16 }
    }
  ]);
});

test("airbrush batches tolerate tiny pen pressure radius jitter without merging queued segments", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const segment = (startX, endX, radiusPixels) => ({
    clientX: endX,
    clientY: 0,
    strokeStart: { clientX: startX, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.421,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });

  const batches = editor.textureAirbrushScreenStrokeBatches([
    segment(0, 8, 7.82),
    segment(8, 16, 8.11),
    segment(16, 24, 8.36)
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].radiusPixels, 8);
  assert.deepEqual(batches[0].strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 8, clientY: 0 }
    },
    {
      start: { clientX: 8, clientY: 0 },
      end: { clientX: 16, clientY: 0 }
    },
    {
      start: { clientX: 16, clientY: 0 },
      end: { clientX: 24, clientY: 0 }
    }
  ]);
});

test("airbrush stabilizes tiny pen pressure radius jitter before batching", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0, pointerType: "pen", pressure: 0.44 }, { reset: true });
  for (let index = 1; index <= 8; index += 1) {
    editor.queueAirbrushTextureStrokeEvent({
      clientX: index * 4,
      clientY: 0,
      pointerType: "pen",
      pressure: index % 2 === 0 ? 0.44 : 0.47
    });
  }

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].radiusPixels, 4);
  assert.deepEqual(batches[0].strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 0, clientY: 0 }
    },
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 32, clientY: 0 }
    }
  ]);
});

test("airbrush pressure radius stabilization keeps meaningful pressure changes", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  [
    { clientX: 0, pressure: 0.3, reset: true },
    { clientX: 8, pressure: 0.32 },
    { clientX: 16, pressure: 0.56 },
    { clientX: 24, pressure: 0.58 },
    { clientX: 32, pressure: 0.86 }
  ].forEach((sample) => {
    editor.queueAirbrushTextureStrokeEvent({
      clientX: sample.clientX,
      clientY: 0,
      pointerType: "pen",
      pressure: sample.pressure
    }, { reset: sample.reset === true });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.deepEqual(batches.map((batch) => batch.radiusPixels), [3, 6, 9]);
});

test("airbrush large brush pressure jitter stays bounded", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 72;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };

  const sampleCount = 600;
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / (sampleCount - 1);
    editor.queueAirbrushTextureStrokeEvent({
      clientX: 80 + t * 1000,
      clientY: 240 + Math.sin(t * Math.PI * 4) * 80,
      pointerType: "pen",
      pressure: 0.15 + t * 0.85 + (index % 2 === 0 ? -0.03 : 0.03)
    }, { reset: index === 0 });
  }

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.length <= 14, true);
  assert.equal(batches.length <= 14, true);
  assert.equal(segmentCount <= 18, true);
  assert.equal(batches.at(-1).radiusPixels > batches[0].radiusPixels, true);
});

test("airbrush ignores rapid pen pressure reversals while keeping pressure trends", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  Array.from({ length: 1200 }, (_, index) => {
    const t = index / 1199;
    return {
      clientX: 100 + t * 540,
      clientY: 260 + Math.sin(t * Math.PI * 3.5) * 78,
      pointerType: "pen",
      pressure: 0.45 + t * 0.24 + (index % 2 === 0 ? -0.07 : 0.07)
    };
  }).forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.length <= 8, true);
  assert.equal(batches.length <= 8, true);
  assert.equal(segmentCount <= 12, true);
  assert.equal(batches.at(-1).radiusPixels > batches[0].radiusPixels, true);
});

test("airbrush bounds subpixel pen pressure spikes by stroke distance", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  Array.from({ length: 600 }, (_, index) => {
    const t = index / 599;
    return {
      clientX: 100 + t * 540,
      clientY: 260 + Math.sin(t * Math.PI * 3.5) * 78,
      pointerType: "pen",
      pressure: index % 2 === 0 ? 0.85 : 0.25
    };
  }).forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.length <= 64, true);
  assert.equal(batches.length <= 64, true);
  assert.equal(segmentCount <= 64, true);
  assert.equal(batches.some((batch) => batch.radiusPixels <= 10), true);
  assert.equal(batches.some((batch) => batch.radiusPixels >= 24), true);
});

test("airbrush keeps long high-frequency curved pen strokes bounded", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    if (editor.textureAirbrushScreenFlushScheduled) {
      return false;
    }
    editor.textureAirbrushScreenFlushScheduled = true;
    scheduled += 1;
    return true;
  };

  const samples = Array.from({ length: 97 }, (_, index) => {
    const t = index / 96;
    const jitter = index % 2 === 0 ? 0.012 : -0.012;
    return {
      clientX: 80 + index * 3.2,
      clientY: 160 + Math.sin(t * Math.PI * 1.65) * 46,
      pointerType: "pen",
      pressure: 0.38 + t * 0.32 + jitter
    };
  });

  samples.forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);
  const nonZeroSegments = batches.flatMap((batch) => batch.strokeSegments).filter((segment) => (
    Math.abs(segment.end.clientX - segment.start.clientX) > 0.001
    || Math.abs(segment.end.clientY - segment.start.clientY) > 0.001
  ));

  assert.equal(scheduled < samples.length, true);
  assert.equal(batches.length <= 6, true);
  assert.equal(segmentCount <= 24, true);
  assert.equal(nonZeroSegments.length >= 6, true);
  assert.equal(batches.some((batch) => batch.strokeSegments.some((segment) => (
    Math.abs(segment.end.clientY - segment.start.clientY) > 10
  ))), true);

  const projected = [];
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      clientX: event.clientX,
      segmentCount: options.strokeSegments.length,
      radiusPixels: options.radiusPixels
    });
    return options.strokeSegments.length;
  };

  const changed = editor.flushTextureAirbrushScreenStroke();

  assert.equal(projected.length, batches.length);
  assert.equal(changed, segmentCount);
  assert.equal(projected.every((call) => call.segmentCount <= 24), true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
});

test("airbrush continuous coalescing preserves natural curved pen stroke shape", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  const samples = Array.from({ length: 360 }, (_, index) => {
    const t = index / 359;
    const angle = t * Math.PI * 1.65;
    const radius = 20 + t * 145;
    return {
      clientX: 330 + Math.cos(angle) * radius,
      clientY: 300 + Math.sin(angle) * radius,
      pointerType: "pen",
      pressure: 0.5
    };
  });
  samples.forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segments = batches.flatMap((batch) => batch.strokeSegments);
  const pointToSegmentDistance = (point, start, end) => {
    const dx = end.clientX - start.clientX;
    const dy = end.clientY - start.clientY;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 0.000001) {
      return Math.hypot(point.clientX - start.clientX, point.clientY - start.clientY);
    }
    const ratio = Math.max(
      0,
      Math.min(
        1,
        ((point.clientX - start.clientX) * dx + (point.clientY - start.clientY) * dy) / lengthSq
      )
    );
    return Math.hypot(
      point.clientX - (start.clientX + dx * ratio),
      point.clientY - (start.clientY + dy * ratio)
    );
  };
  const maxCurveError = Math.max(...samples.map((sample) => Math.min(
    ...segments.map((segment) => pointToSegmentDistance(sample, segment.start, segment.end))
  )));

  assert.equal(batches.length, 1);
  assert.equal(segments.length <= 24, true);
  assert.equal(segments.length >= 12, true);
  assert.equal(maxCurveError < 6, true);
});

test("airbrush radius-pressure pen strokes avoid excessive live projection passes", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 36;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  const sampleCount = 2400;
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / (sampleCount - 1);
    editor.queueAirbrushTextureStrokeEvent({
      clientX: 120 + t * 980,
      clientY: 260 + Math.sin(t * Math.PI * 6) * 115 + Math.sin(t * Math.PI * 29) * 4,
      pointerType: "pen",
      pressure: 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * Math.PI * 1.4)) + Math.sin(t * Math.PI * 37) * 0.025
    }, { reset: index === 0 });
  }

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const projected = [];
  let liveFrames = 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };
  while (editor.textureAirbrushScreenStrokeQueue?.length || editor.textureAirbrushPendingScreenStrokeBatches?.length) {
    editor.textureAirbrushScreenFlushScheduled = false;
    editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 4, maxBatchMs: 999 });
    liveFrames += 1;
  }

  assert.equal(scheduled < sampleCount, true);
  assert.equal(batches.length <= 6, true);
  assert.equal(projected.length <= 6, true);
  assert.equal(liveFrames <= 2, true);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  assert.equal(Math.max(...projected) - Math.min(...projected) >= 14, true);
});

test("live airbrush flush carries remaining batches forward in stroke order", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: event.clientX,
      radiusPixels: options.radiusPixels,
      segments: options.strokeSegments.length
    });
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [4, 6, 8, 10, 12].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.deepEqual(projected.map((call) => call.radiusPixels), [4, 6]);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 3);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 3);

  assert.deepEqual(projected.map((call) => call.radiusPixels), [4, 6, 8, 10, 12]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush paints old pending batches before fresh pointer batches", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };
  const payload = (radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [4, 6, 8].map((radiusPixels, index) => ({
    styleKey: `pending:${radiusPixels}`,
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    strokeSegments: [{
      start: { clientX: index * 8 - 4, clientY: 0 },
      end: { clientX: index * 8, clientY: 0 }
    }]
  }));
  editor.textureAirbrushScreenStrokeQueue = [payload(20, 20), payload(22, 21)];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 1 }), 1);

  assert.deepEqual(projected, [4]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 4);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches.map((batch) => batch.radiusPixels), [6, 8, 20, 22]);
  assert.equal(scheduled, 1);
});

test("live airbrush flush merges compatible pending and fresh batches without reordering", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => [
      segment.start.clientX,
      segment.start.clientY,
      segment.end.clientX,
      segment.end.clientY
    ]));
    return options.strokeSegments.length;
  };
  const style = {
    styleKey: "same-soft-brush",
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true
  };
  const queuedPayload = (startX, endX) => ({
    clientX: endX,
    clientY: 0,
    strokeStart: { clientX: startX, clientY: 0 },
    styleKey: style.styleKey,
    styleRadiusPixels: style.radiusPixels,
    styleColor: style.color,
    styleOpacity: style.opacity,
    styleHardness: style.hardness,
    styleScatter: style.scatter,
    styleStrength: style.strength,
    spacing: style.spacing
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    ...style,
    strokeSegments: [{
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 10, clientY: 0 }
    }]
  }];
  editor.textureAirbrushScreenStrokeQueue = [
    queuedPayload(10, 20),
    queuedPayload(20, 30)
  ];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 1 }), 3);

  assert.deepEqual(projected, [[[0, 0, 10, 0], [10, 0, 20, 0], [20, 0, 30, 0]]]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush keeps fresh small pen batches behind older large pending batches", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };
  const batch = (radiusPixels, index) => ({
    styleKey: `batch:${radiusPixels}`,
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    strokeSegments: [{
      start: { clientX: index * 8 - 4, clientY: 0 },
      end: { clientX: index * 8, clientY: 0 }
    }]
  });
  const payload = (radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [batch(24, 0), batch(28, 1)];
  editor.textureAirbrushScreenStrokeQueue = [payload(6, 20), payload(8, 21)];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.deepEqual(projected, [24, 28]);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches.map((pending) => pending.radiusPixels), [6, 8]);
  assert.equal(scheduled, 1);
});

test("live airbrush flush uses the batch budget and retains ordered large-brush backlog", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [24, 28, 32].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.deepEqual(projected, [24, 28]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches.map((batch) => batch.radiusPixels), [32]);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 1);

  assert.deepEqual(projected, [24, 28, 32]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush splits oversized batches into ordered chunks", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  const segments = Array.from({ length: 50 }, (_, index) => ({
    start: { clientX: index, clientY: 0 },
    end: { clientX: index + 1, clientY: 0 }
  }));
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "large-live-stroke",
    radiusPixels: 32,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: segments
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 1,
    maxBatchSegments: 16
  }), 16);

  assert.deepEqual(projected, [
    Array.from({ length: 16 }, (_, index) => index)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 3);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 2,
    maxBatchSegments: 16
  }), 32);

  assert.deepEqual(projected, [
    Array.from({ length: 16 }, (_, index) => index),
    Array.from({ length: 16 }, (_, index) => index + 16),
    Array.from({ length: 16 }, (_, index) => index + 32)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 2);

  assert.deepEqual(projected.flat(), Array.from({ length: 50 }, (_, index) => index));
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush yields by segment budget without dropping chunks", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  const segments = Array.from({ length: 45 }, (_, index) => ({
    start: { clientX: index, clientY: 0 },
    end: { clientX: index + 1, clientY: 0 }
  }));
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "segment-budget-stroke",
    radiusPixels: 32,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: segments
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 10,
    maxBatchSegments: 10,
    maxSegments: 20
  }), 20);

  assert.deepEqual(projected, [
    Array.from({ length: 10 }, (_, index) => index),
    Array.from({ length: 10 }, (_, index) => index + 10)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 3);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 10,
    maxBatchSegments: 10,
    maxSegments: 20
  }), 20);

  assert.deepEqual(projected, [
    Array.from({ length: 10 }, (_, index) => index),
    Array.from({ length: 10 }, (_, index) => index + 10),
    Array.from({ length: 10 }, (_, index) => index + 20),
    Array.from({ length: 10 }, (_, index) => index + 30)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 5);

  assert.deepEqual(projected.flat(), Array.from({ length: 45 }, (_, index) => index));
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush adapts small-brush budgets to avoid smooth stroke backlog", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  const segments = Array.from({ length: 96 }, (_, index) => {
    const t = index / 95;
    return {
      start: {
        clientX: index,
        clientY: Math.sin(t * Math.PI * 2) * 18
      },
      end: {
        clientX: index + 1,
        clientY: Math.sin((index + 1) / 95 * Math.PI * 2) * 18
      }
    };
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "small-brush-smooth-stroke",
    radiusPixels: 8,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: segments
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 96);

  assert.deepEqual(projected.flat(), Array.from({ length: 96 }, (_, index) => index));
  assert.deepEqual(projected.map((chunk) => chunk.length), [96]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  assert.equal(scheduled, 0);
});

test("live airbrush flush keeps large-brush adaptive budgets conservative", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "large-brush-stroke",
    radiusPixels: 32,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: Array.from({ length: 96 }, (_, index) => ({
      start: { clientX: index, clientY: 0 },
      end: { clientX: index + 1, clientY: 0 }
    }))
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 48);

  assert.deepEqual(projected.flat(), Array.from({ length: 48 }, (_, index) => index));
  assert.deepEqual(projected.map((chunk) => chunk.length), [24, 24]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 2);
  assert.equal(scheduled, 1);
});

test("live airbrush flush reuses one WebGL projection frame for same-frame batches", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const backend = { backend: "webgl", webGpuStatus: "not-requested" };
  const frame = { marker: "projection-frame" };
  const projectedFrames = [];
  const projectedBackends = [];
  let frameCalls = 0;
  let backendCalls = 0;
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushResolveBackend = (options) => {
    backendCalls += 1;
    assert.deepEqual(options, { gpu: true });
    return backend;
  };
  editor.textureAirbrushGpuProjectionFrame = () => {
    frameCalls += 1;
    return frame;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projectedFrames.push(options.projectionFrame);
    projectedBackends.push(options.resolvedBackend);
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [4, 6, 8].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.equal(backendCalls, 1);
  assert.equal(frameCalls, 1);
  assert.deepEqual(projectedFrames, [frame, frame]);
  assert.deepEqual(projectedBackends, [backend, backend]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);
  assert.equal(scheduled, 1);
});

test("single-batch live airbrush flush still uses the shared WebGL projection frame", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const backend = { backend: "webgl", webGpuStatus: "not-requested" };
  const frame = { marker: "projection-frame" };
  let backendCalls = 0;
  let frameCalls = 0;
  let projectedFrame = null;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushResolveBackend = (options) => {
    backendCalls += 1;
    assert.deepEqual(options, { gpu: true });
    return backend;
  };
  editor.textureAirbrushLiveProjectionFrame = () => {
    frameCalls += 1;
    return frame;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projectedFrame = options.projectionFrame;
    return options.strokeSegments.length;
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 8,
    clientY: 0,
    strokeStart: { clientX: 0, clientY: 0 },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  assert.equal(backendCalls, 1);
  assert.equal(frameCalls, 1);
  assert.equal(projectedFrame, frame);
});

test("live airbrush flush yields when the frame time budget is spent", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: event.clientX,
      radiusPixels: options.radiusPixels,
      segments: options.strokeSegments.length
    });
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [4, 6, 8].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 10,
    maxBatchMs: 0
  }), 1);

  assert.deepEqual(projected.map((call) => call.radiusPixels), [4]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 2);
  assert.equal(scheduled, 1);
});

test("scheduled live airbrush flush projects pending batches in order", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const originalWindow = globalThis.window;
  let animationFrameCallback = null;
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        animationFrameCallback = callback;
        return 1;
      }
    };
    const projected = [];
    editor.textureAirbrushScreenStrokeQueue = [];
    editor.textureAirbrushPendingScreenStrokeBatches = [{
      strokeSegments: [{
        start: { clientX: 0, clientY: 0 },
        end: { clientX: 8, clientY: 0 }
      }],
      radiusPixels: 4,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1
    }];
    editor.clearTextureAirbrushScreenLayer = () => {};
    editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
      projected.push(options.radiusPixels);
      return options.strokeSegments.length;
    };

    assert.equal(editor.scheduleTextureAirbrushScreenStrokeFlush(), true);
    assert.deepEqual(projected, []);
    assert.equal(typeof animationFrameCallback, "function");

    animationFrameCallback();

    assert.deepEqual(projected, [4]);
    assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("ending an airbrush stroke finishes pending screen batches before undo finalization", async () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushScreenStrokeMethods(PaintEditor);
  const editor = new PaintEditor();
  const originalWindow = globalThis.window;
  const animationFrameCallbacks = [];
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }
    };
    const projected = [];
    let finalized = 0;
    let finalizedProjectedCount = 0;
    editor.textureBrushRadiusScreenPixels = () => 10;
    editor.textureAirbrushSpacingPercent = () => 1;
    editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
    editor.clearTextureAirbrushScreenLayer = () => {};
    editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
      projected.push(options.radiusPixels);
      return options.strokeSegments.length;
    };
    editor.finalizeTexturePaintStrokeUndo = (stroke) => {
      finalized += 1;
      finalizedProjectedCount = projected.length;
      assert.equal(stroke.label, "Texture airbrush");
      return true;
    };
    editor.texturePaintStrokeUndo = {
      label: "Texture airbrush",
      changed: true,
      touched: new Map(),
      before: [{}]
    };
    editor.textureAirbrushPendingScreenStrokeBatches = [8, 10].map((radiusPixels, index) => ({
      styleKey: `stale:${radiusPixels}`,
      radiusPixels,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      strokeSegments: [{
        start: { clientX: index * 8 + 60, clientY: 0 },
        end: { clientX: index * 8 + 64, clientY: 0 }
      }]
    }));
    editor.textureAirbrushScreenStrokeQueue = [4, 6].map((radiusPixels, index) => ({
      clientX: index * 8,
      clientY: 0,
      strokeStart: { clientX: index * 8 - 4, clientY: 0 },
      radiusPixels,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1
    }));

    assert.equal(editor.endTexturePaintStrokeUndo(), false);
    assert.deepEqual(projected, [8, 10, 4, 6]);
    assert.equal(finalized, 0);
    assert.equal(editor.texturePaintStrokeUndo, null);
    assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
    assert.equal(animationFrameCallbacks.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(finalized, 1);
    assert.equal(finalizedProjectedCount, 4);
    assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("airbrush screen batches preserve gentle curves and sharp turns", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const segment = (startX, startY, endX, endY) => ({
    clientX: endX,
    clientY: endY,
    strokeStart: { clientX: startX, clientY: startY },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });

  const [batch] = editor.textureAirbrushScreenStrokeBatches([
    segment(0, 0, 10, 1),
    segment(10, 1, 20, 2),
    segment(20, 2, 30, 2),
    segment(30, 2, 40, 1),
    segment(40, 1, 50, 0),
    segment(50, 0, 54, 22)
  ]);

  assert.deepEqual(batch.strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 10, clientY: 1 }
    },
    {
      start: { clientX: 10, clientY: 1 },
      end: { clientX: 20, clientY: 2 }
    },
    {
      start: { clientX: 20, clientY: 2 },
      end: { clientX: 30, clientY: 2 }
    },
    {
      start: { clientX: 30, clientY: 2 },
      end: { clientX: 40, clientY: 1 }
    },
    {
      start: { clientX: 40, clientY: 1 },
      end: { clientX: 50, clientY: 0 }
    },
    {
      start: { clientX: 50, clientY: 0 },
      end: { clientX: 54, clientY: 22 }
    }
  ]);
});

test("airbrush screen flush does not replace a successful stroke status with a later miss", () => {
  class StatusEditor {}
  installTextureAirbrushScreenStrokeMethods(StatusEditor);
  const editor = new StatusEditor();
  const statuses = [];
  let nextChanged = 12;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = () => nextChanged;
  editor.setStatus = (message) => {
    statuses.push(message);
  };
  const payload = {
    clientX: 12,
    clientY: 10,
    strokeStart: { clientX: 10, clientY: 10 },
    radiusPixels: 8,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  };

  editor.textureAirbrushScreenStrokeQueue = [payload];
  assert.equal(editor.flushTextureAirbrushScreenStroke(), 12);
  assert.deepEqual(statuses, ["Airbrushed 12 projected pixels"]);

  nextChanged = 0;
  editor.textureAirbrushScreenStrokeQueue = [payload];
  assert.equal(editor.flushTextureAirbrushScreenStroke(), 0);
  assert.deepEqual(statuses, ["Airbrushed 12 projected pixels"]);

  editor.textureAirbrushScreenStrokeChanged = false;
  editor.textureAirbrushScreenStrokeQueue = [payload];
  assert.equal(editor.flushTextureAirbrushScreenStroke(), 0);
  assert.deepEqual(statuses, [
    "Airbrushed 12 projected pixels",
    "Airbrush needs the cursor over textured mesh"
  ]);
});

test("ending an airbrush stroke keeps WebGL target paint live for smooth follow-up strokes", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const beforeSnapshot = {
    width: 1,
    height: 1,
    texture: {}
  };
  const afterSnapshot = {
    width: 1,
    height: 1,
    texture: {}
  };
  const material = { userData: {} };
  const targetEntry = {
    width: 1,
    height: 1,
    target: { texture: {} }
  };
  let readbackTouched = false;
  editor.undoStack = [];
  editor.redoStack = [];
  editor.updateUndoButton = () => {};
  editor.texturePaintStrokeUndo = {
    label: "Texture airbrush",
    changed: true,
    touched: new Map(),
    before: [{
      type: "gpu",
      key: "gpu:0",
      record: {},
      material,
      materialIndex: 0,
      targetEntry,
      before: beforeSnapshot,
      after: null
    }]
  };
  editor.flushTextureAirbrushScreenStroke = () => 0;
  editor.textureAirbrushCanvasFromRenderTarget = () => {
    readbackTouched = true;
    return null;
  };
  editor.flushTextureAirbrushGpuTargetsToCanvases = () => {
    readbackTouched = true;
    return 0;
  };
  editor.cloneTextureRenderTargetSnapshot = (candidateEntry) => {
    assert.equal(candidateEntry, targetEntry);
    return afterSnapshot;
  };

  assert.equal(editor.endTexturePaintStrokeUndo(), true);
  assert.equal(readbackTouched, false);
  assert.equal(editor.undoStack.length, 1);
  const entry = editor.undoStack[0].entries[0];
  assert.equal(entry.type, "gpu");
  assert.equal(entry.targetEntry, targetEntry);
  assert.equal(entry.before, beforeSnapshot);
  assert.equal(entry.after, afterSnapshot);
});

test("ending an async airbrush stroke finalizes the captured stroke only", async () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let resolveFlush = null;
  const flushPromise = new Promise((resolve) => {
    resolveFlush = resolve;
  });
  const targetEntry = {
    width: 1,
    height: 1,
    target: { texture: {} }
  };
  const oldBefore = { texture: {}, dispose() {} };
  const oldAfter = { texture: {}, dispose() {} };
  const oldStroke = {
    label: "Old async stroke",
    changed: true,
    touched: new Map(),
    before: [{
      type: "gpu",
      key: "old:gpu",
      record: {},
      material: {},
      materialIndex: 0,
      targetEntry,
      before: oldBefore,
      after: null
    }]
  };
  const activeNextStroke = {
    label: "Active next stroke",
    changed: false,
    touched: new Map(),
    before: []
  };
  editor.undoStack = [];
  editor.redoStack = [];
  editor.texturePaintStrokeUndo = oldStroke;
  editor.textureAirbrushPendingWebGpuPaints = new Set([flushPromise]);
  editor.flushTextureAirbrushScreenStroke = () => 0;
  editor.flushTextureAirbrushPendingWebGpuPaints = () => flushPromise;
  editor.cloneTextureRenderTargetSnapshot = (candidateEntry) => {
    assert.equal(candidateEntry, targetEntry);
    return oldAfter;
  };
  editor.updateUndoButton = () => {};

  assert.equal(editor.endTexturePaintStrokeUndo(), false);
  assert.equal(editor.texturePaintStrokeUndo, null);

  editor.texturePaintStrokeUndo = activeNextStroke;
  resolveFlush();
  await flushPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(editor.texturePaintStrokeUndo, activeNextStroke);
  assert.equal(editor.undoStack.length, 1);
  assert.equal(editor.undoStack[0].label, "Old async stroke");
  assert.equal(editor.undoStack[0].entries[0].before, oldBefore);
  assert.equal(editor.undoStack[0].entries[0].after, oldAfter);
});

test("projected airbrush reuses a resolved WebGL backend without resolving per batch", () => {
  const editor = new TestEditor();
  const backend = { backend: "webgl", webGpuStatus: "not-requested" };
  let resolveCalls = 0;
  let reportedBackend = null;
  let projectedOptions = null;
  editor.canvas = {};
  editor.camera = {};
  editor.model = {};
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushResolveBackend = () => {
    resolveCalls += 1;
    return { backend: "cpu", webGpuStatus: "test-should-not-resolve" };
  };
  editor.textureAirbrushReportWebGpuFallback = (resolved) => {
    reportedBackend = resolved;
  };
  editor.textureAirbrushGpuProjectFromEvent = (event, options) => {
    projectedOptions = options;
    return 7;
  };

  const changed = editor.textureAirbrushProjectedMeshFromEvent({
    clientX: 10,
    clientY: 12
  }, {
    gpu: true,
    resolvedBackend: backend,
    pressureApplied: true
  });

  assert.equal(changed, 7);
  assert.equal(resolveCalls, 0);
  assert.equal(reportedBackend, backend);
  assert.equal(projectedOptions.resolvedBackend, backend);
});

test("live GPU airbrush does not fall through to CPU texture paint when the shader misses", () => {
  const editor = new TestEditor();
  let cpuPathTouched = false;
  editor.canvas = {
    getBoundingClientRect() {
      cpuPathTouched = true;
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {
    updateMatrixWorld() {
      cpuPathTouched = true;
    }
  };
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl", webGpuStatus: "not-requested" });
  editor.textureAirbrushGpuProjectFromEvent = () => 0;
  editor.setStatus = () => {};

  const changed = editor.textureAirbrushProjectedMeshFromEvent({ clientX: 10, clientY: 12 }, { gpu: true });

  assert.equal(changed, 0);
  assert.equal(cpuPathTouched, false);
});

test("live GPU airbrush does not fall through to CPU texture paint after a shader error", () => {
  const editor = new TestEditor();
  const previousWarn = console.warn;
  let cpuPathTouched = false;
  let status = "";
  editor.canvas = {
    getBoundingClientRect() {
      cpuPathTouched = true;
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {
    updateMatrixWorld() {
      cpuPathTouched = true;
    }
  };
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushResolveBackend = () => ({ backend: "webgl", webGpuStatus: "not-requested" });
  editor.textureAirbrushGpuProjectFromEvent = () => {
    throw new Error("shader failed");
  };
  editor.setStatus = (message) => {
    status = message;
  };

  console.warn = () => {};
  let changed = 0;
  try {
    changed = editor.textureAirbrushProjectedMeshFromEvent({ clientX: 10, clientY: 12 }, { gpu: true });
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(changed, 0);
  assert.equal(cpuPathTouched, false);
  assert.equal(editor.textureAirbrushGpuDisabled, true);
  assert.match(status, /GPU path failed/);
});
