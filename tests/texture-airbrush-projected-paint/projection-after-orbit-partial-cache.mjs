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

function shaderMaterial() {
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
      uvOffset: { value: vector() }
    },
    needsUpdate: true
  };
}

test("after camera rotation partial layer cache still discovers crossed paint targets", () => {
  class WebGlLayerEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlLayerEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });

  const paintable = (name) => {
    const target = { name: `target-${name}`, texture: {} };
    const layer = {
      id: `layer-${name}`,
      visible: true,
      opacity: 1,
      isEmpty: false
    };
    const stack = {
      activeLayerId: layer.id,
      width: 64,
      height: 64,
      layers: [layer]
    };
    const material = {
      uuid: `material-${name}`,
      userData: { texturePaintLayerStack: stack }
    };
    const targetEntry = {
      target,
      width: 64,
      height: 64,
      material,
      layer,
      layerStack: stack,
      layerMode: true,
      emptyTransparent: false,
      paintRevision: 1
    };
    layer.gpuTarget = targetEntry;
    return {
      object: { material },
      record: {
        object: null,
        geometry: { attributes: { uv: {} } }
      },
      material,
      targetEntry
    };
  };

  const left = paintable("left");
  const right = paintable("right");
  left.record.object = left.object;
  right.record.object = right.object;

  const editor = new WebGlLayerEditor();
  const renderedTargets = [];
  const proxyRequests = [];
  let activeTarget = null;
  let raycasts = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return null;
    },
    setRenderTarget(target) {
      activeTarget = target;
    },
    render() {
      renderedTargets.push(activeTarget?.name || "unknown");
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
  editor.paintRecords = [left.record, right.record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      raycasts += 1;
      assert.deepEqual(objects, [left.object, right.object]);
      const record = editor.pointer.x > 0 ? right : left;
      return [{
        object: record.object,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.clonePaintMaterialForHit = (record) => record?.object?.material || null;
  editor.captureTexturePaintGpuUndoTarget = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial();
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = (record) => {
    proxyRequests.push(record);
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.queueTexturePaintLayerGpuComposite = () => true;
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const leftPassKey = "0:0:material-left";
  const projectionFrame = {
    canvas: editor.canvas,
    camera: editor.camera,
    model: editor.model,
    rect: editor.canvas.getBoundingClientRect(),
    frameKey: "after-orbit",
    layerMutationSerial: 0,
    paintRecords: editor.paintRecords,
    paintObjects: [left.object, right.object],
    recordByObject: new Map([[left.object, left.record], [right.object, right.record]]),
    recordIndices: new Map([[left.record, 0], [right.record, 1]]),
    seedPaintPasses: false,
    seedLayerProxies: false,
    paintPassCache: new Map([[
      leftPassKey,
      {
        key: leftPassKey,
        record: left.record,
        materialIndex: 0,
        material: left.material,
        targetEntry: left.targetEntry
      }
    ]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[leftPassKey, { scene: {} }]])
  };

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 160, clientY: 70 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
    renderAllCachedPasses: true,
    reusePartialLayerPasses: true,
    discoverPartialLayerPasses: true,
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: [{
      start: { clientX: 40, clientY: 70 },
      end: { clientX: 160, clientY: 70 }
    }]
  });

  assert.equal(changed > 0, true);
  assert.equal(renderedTargets.includes("target-left"), true);
  assert.equal(renderedTargets.includes("target-right"), true);
  assert.deepEqual(proxyRequests, [right.record]);
  assert.equal(raycasts > 0, true);
  assert.equal(raycasts <= 26, true);
  assert.equal(projectionFrame.paintPassCache.size, 2);
});

test("after camera rotation GPU paint rejects stale supplied projection frames", () => {
  class WebGlLayerEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlLayerEditor, {
    THREE: {
      Vector2: class {
        constructor(x = 0, y = 0) {
          this.x = x;
          this.y = y;
        }
      }
    }
  });

  const paintable = (name) => {
    const target = { name: `target-${name}`, texture: {} };
    const layer = {
      id: `layer-${name}`,
      visible: true,
      opacity: 1,
      isEmpty: false
    };
    const stack = {
      activeLayerId: layer.id,
      width: 64,
      height: 64,
      layers: [layer]
    };
    const material = {
      uuid: `material-${name}`,
      userData: { texturePaintLayerStack: stack }
    };
    const targetEntry = {
      target,
      width: 64,
      height: 64,
      material,
      layer,
      layerStack: stack,
      layerMode: true,
      emptyTransparent: false,
      paintRevision: 1
    };
    layer.gpuTarget = targetEntry;
    return {
      object: { material },
      record: {
        object: null,
        geometry: { attributes: { uv: {} } }
      },
      material,
      targetEntry
    };
  };

  const left = paintable("left");
  const right = paintable("right");
  left.record.object = left.object;
  right.record.object = right.object;

  const editor = new WebGlLayerEditor();
  const renderedTargets = [];
  let activeTarget = null;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
  editor.textureAirbrushDepthCacheKey = () => "camera-after-orbit";
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return null;
    },
    setRenderTarget(target) {
      activeTarget = target;
    },
    render() {
      renderedTargets.push(activeTarget?.name || "unknown");
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
  editor.paintRecords = [left.record, right.record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {},
    intersectObjects(objects) {
      assert.deepEqual(objects, [left.object, right.object]);
      return [{
        object: right.object,
        face: { materialIndex: 0 },
        distance: 1
      }];
    }
  };
  editor.clonePaintMaterialForHit = (record) => record?.object?.material || null;
  editor.captureTexturePaintGpuUndoTarget = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial();
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 1, b: 0 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => null;
  editor.queueTexturePaintLayerGpuComposite = () => true;
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};

  const staleLeftPassKey = "0:0:material-left";
  const staleProjectionFrame = {
    canvas: editor.canvas,
    camera: editor.camera,
    model: editor.model,
    rect: editor.canvas.getBoundingClientRect(),
    frameKey: "camera-before-orbit",
    layerMutationSerial: 0,
    paintRecords: [left.record],
    paintObjects: [left.object],
    recordByObject: new Map([[left.object, left.record]]),
    recordIndices: new Map([[left.record, 0]]),
    seedPaintPasses: false,
    seedLayerProxies: false,
    paintPassCache: new Map([[
      staleLeftPassKey,
      {
        key: staleLeftPassKey,
        record: left.record,
        materialIndex: 0,
        material: left.material,
        targetEntry: left.targetEntry
      }
    ]]),
    probePaintPassCache: new Map(),
    proxySceneCache: new Map([[staleLeftPassKey, { scene: {} }]])
  };

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 160, clientY: 70 }, {
    gpu: true,
    projectionFrame: staleProjectionFrame,
    deferLayerComposite: true,
    renderAllCachedPasses: true,
    reusePartialLayerPasses: true,
    discoverPartialLayerPasses: true,
    radiusPixels: 24,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: [{
      start: { clientX: 150, clientY: 70 },
      end: { clientX: 160, clientY: 70 }
    }]
  });

  assert.equal(changed > 0, true);
  assert.equal(renderedTargets.includes("target-right"), true);
  assert.equal(renderedTargets.includes("target-left"), false);
  assert.equal(staleProjectionFrame.paintPassCache.size, 1);
});
