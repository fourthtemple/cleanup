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

test("layer low spacing can render all cached paint passes without raycasts", () => {
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
  const paintable = (name) => {
    const target = { name: `layer-target-${name}`, texture: { name: `layer-texture-${name}` } };
    const layer = {
      id: `layer-${name}`,
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
      uuid: `layer-material-${name}`,
      map: { name: `composite-${name}` },
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
      emptyTransparent: false
    };
    layer.gpuTarget = targetEntry;
    const object = { material };
    const record = {
      object,
      geometry: { attributes: { uv: {} } }
    };
    return { record, object, material, target, targetEntry };
  };
  const first = paintable("a");
  const second = paintable("b");
  const editor = new WebGlFrameEditor();
  const renderedTargets = [];
  const undoCaptures = [];
  const proxyRequests = [];
  let activeTarget = null;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 0;
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
  editor.paintRecords = [first.record, second.record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("warmed layer cached-pass projection should not raycast");
    },
    intersectObjects() {
      throw new Error("warmed layer cached-pass projection should not raycast");
    }
  };
  editor.clonePaintMaterialForHit = () => {
    throw new Error("warmed layer cached-pass projection should not need hit materials");
  };
  editor.textureAirbrushGpuTargetForMaterial = () => {
    throw new Error("warmed layer cached-pass projection should not look up a target");
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
      visibleOnlyDepthEpsilon: { value: 0 },
      uvOffset: { value: vector() }
    },
    needsUpdate: true
  });
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

  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  assert.equal(projectionFrame.paintPassCache.size, 2);
  assert.equal(projectionFrame.paintPassCacheSeeded, true);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 90, clientY: 70 }, {
    gpu: true,
    projectionFrame,
    deferLayerComposite: true,
    renderAllCachedPasses: true,
    radiusPixels: 24,
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
  assert.deepEqual(undoCaptures, [first.record, second.record]);
  assert.deepEqual(proxyRequests, [first.record, second.record]);
  assert.deepEqual(renderedTargets, ["layer-target-a", "layer-target-b"]);
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

test("airbrush WebGL texture copies clear layer targets as transparent", () => {
  const calls = [];
  const previousTarget = { name: "previous" };
  const previousColor = { name: "previous-clear-color" };
  class Color {
    constructor() {
      this.name = "color";
    }
  }
  class MeshBasicMaterial {
    constructor(options = {}) {
      Object.assign(this, options);
    }
  }
  class WebGlCopyEditor {}
  const THREE = {
    Color,
    MeshBasicMaterial,
    NoBlending: 0,
    LinearFilter: 1,
    ClampToEdgeWrapping: 2
  };
  installTextureAirbrushWebGlBackendMethods(WebGlCopyEditor, { THREE });
  const editor = new WebGlCopyEditor();
  editor.textureAirbrushGpuCopyScene = { name: "copy-scene" };
  editor.textureAirbrushGpuCopyCamera = { name: "copy-camera" };
  editor.textureAirbrushGpuCopyMesh = {};
  editor.renderer = {
    autoClear: false,
    getRenderTarget() {
      calls.push(["getRenderTarget"]);
      return previousTarget;
    },
    setRenderTarget(target) {
      calls.push(["setRenderTarget", target?.name || target]);
    },
    getClearAlpha() {
      calls.push(["getClearAlpha"]);
      return 0.75;
    },
    getClearColor(color) {
      calls.push(["getClearColor"]);
      color.name = previousColor.name;
    },
    setClearColor(color, alpha) {
      calls.push(["setClearColor", color?.name || color, alpha]);
    },
    clear(color, depth, stencil) {
      calls.push(["clear", color, depth, stencil, this.autoClear]);
    },
    render(scene, camera) {
      calls.push([
        "render",
        scene.name,
        camera.name,
        editor.textureAirbrushGpuCopyMesh.material.transparent,
        editor.textureAirbrushGpuCopyMesh.material.blending
      ]);
    }
  };
  const sourceTexture = {
    name: "transparent-layer",
    minFilter: 1,
    magFilter: 1,
    wrapS: 2,
    wrapT: 2,
    generateMipmaps: false
  };
  const destinationTarget = {
    name: "layer-target",
    texture: { name: "layer-target-texture" }
  };

  assert.equal(editor.textureAirbrushCopyTextureToTarget(sourceTexture, destinationTarget), true);
  assert.deepEqual(calls, [
    ["getRenderTarget"],
    ["getClearAlpha"],
    ["getClearColor"],
    ["setRenderTarget", "layer-target"],
    ["setClearColor", 0x000000, 0],
    ["clear", true, true, true, true],
    ["render", "copy-scene", "copy-camera", false, THREE.NoBlending],
    ["setRenderTarget", "previous"],
    ["setClearColor", previousColor.name, 0.75]
  ]);
  assert.equal(editor.renderer.autoClear, false);
});

test("airbrush WebGL brush shader supports per-stroke opacity caps", () => {
  class WebGlMaterialEditor {}
  class ShaderMaterial {
    constructor(options = {}) {
      Object.assign(this, options);
    }
  }
  class Matrix4 {}
  class Vector2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
  }
  class Color {
    constructor(r = 0, g = 0, b = 0) {
      this.r = r;
      this.g = g;
      this.b = b;
    }
  }
  installTextureAirbrushWebGlBackendMethods(WebGlMaterialEditor, {
    THREE: {
      ShaderMaterial,
      Matrix4,
      Vector2,
      Color,
      DoubleSide: 2,
      NormalBlending: 1
    }
  });
  const editor = new WebGlMaterialEditor();

  const material = editor.textureAirbrushBrushShaderMaterial();

  assert.equal(material.uniforms.useStrokeSourceTexture.value, false);
  assert.equal(material.uniforms.useCurrentTargetTexture.value, false);
  assert.equal(material.uniforms.strokeSourceClear.value, false);
  assert.equal(material.uniforms.eraseMode.value, false);
  assert.equal(material.uniforms.strokeSourceTexture.value, null);
  assert.equal(material.uniforms.currentTargetTexture.value, null);
  assert.match(material.fragmentShader, /useStrokeSourceTexture/);
  assert.match(material.fragmentShader, /useCurrentTargetTexture/);
  assert.match(material.fragmentShader, /strokeSourceClear/);
  assert.match(material.vertexShader, /vPaintTargetUv = targetUv/);
  assert.match(material.fragmentShader, /varying vec2 vPaintTargetUv/);
  assert.match(material.fragmentShader, /texture2D\(strokeSourceTexture, vPaintTargetUv\)/);
  assert.match(material.fragmentShader, /texture2D\(currentTargetTexture, vPaintTargetUv\)/);
  assert.doesNotMatch(material.fragmentShader, /texture2D\(strokeSourceTexture, vPaintUv\)/);
  assert.doesNotMatch(material.fragmentShader, /texture2D\(currentTargetTexture, vPaintUv\)/);
  assert.match(material.fragmentShader, /nextAlpha = alpha \+ sourceColor\.a \* \(1\.0 - alpha\)/);
  assert.match(material.fragmentShader, /if \(sourceColor\.a < 0\.9999\)/);
  assert.match(material.fragmentShader, /return clamp\(alphaProgress, 0\.0, 1\.0\)/);
  assert.match(material.fragmentShader, /return clamp\(colorProgress, 0\.0, 1\.0\)/);
  assert.match(material.fragmentShader, /currentProgress \+ 0\.0001 >= alpha/);
  assert.doesNotMatch(material.fragmentShader, /proposedProgress/);
});

test("airbrush WebGL projection uses the stroke-start snapshot to cap opacity", () => {
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
  const sourceTexture = { name: "stroke-start" };
  const target = { name: "paint-target", texture: { name: "paint-texture" } };
  const material = { uuid: "material", map: target.texture };
  const record = {
    object: { material },
    geometry: { attributes: { uv: {} } }
  };
  const targetEntry = {
    target,
    width: 64,
    height: 64
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
        blending: shaderMaterial.blending,
        transparent: shaderMaterial.transparent,
        source: shaderMaterial.uniforms.strokeSourceTexture.value,
        useStrokeSource: shaderMaterial.uniforms.useStrokeSourceTexture.value,
        current: shaderMaterial.uniforms.currentTargetTexture.value,
        useCurrentTarget: shaderMaterial.uniforms.useCurrentTargetTexture.value,
        sourceClear: shaderMaterial.uniforms.strokeSourceClear.value,
        uvOffset: {
          x: shaderMaterial.uniforms.uvOffset.value.x,
          y: shaderMaterial.uniforms.uvOffset.value.y
        }
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
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // Live airbrush must render exactly one UV pass. If code asks for bleed
  // offsets again, the test throws because bleed offsets can paint hidden UVs
  // just to make coverage look fuller.
  const bleedOffsets = [vector(), vector(), vector()];
  bleedOffsets[1].set(1 / targetEntry.width, 0);
  bleedOffsets[2].set(0, 1 / targetEntry.height);
  editor.textureAirbrushGpuUvBleedOffsets = () => {
    throw new Error("DO NOT PAINT ON NON CAMERA FACING SIDES via UV bleed offsets");
  };
  editor.captureTexturePaintGpuUndoTarget = () => true;
  editor.texturePaintGpuStrokeSourceSnapshot = () => ({ texture: sourceTexture });
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

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 20, clientY: 5 }, {
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
    spacing: 1,
    strength: 1,
    pressureApplied: true
  });

  assert.equal(changed > 0, true);
  assert.deepEqual(renders, [
    {
      target,
      blending: THREE.NoBlending,
      transparent: false,
      source: sourceTexture,
      useStrokeSource: true,
      current: null,
      useCurrentTarget: false,
      sourceClear: false,
      uvOffset: { x: 0, y: 0 }
    }
  ]);
  assert.equal(shaderMaterial.blending, "previous-blending");
  assert.equal(shaderMaterial.transparent, true);
  assert.equal(shaderMaterial.uniforms.strokeSourceTexture.value, null);
  assert.equal(shaderMaterial.uniforms.useStrokeSourceTexture.value, false);
  assert.equal(shaderMaterial.uniforms.currentTargetTexture.value, null);
  assert.equal(shaderMaterial.uniforms.useCurrentTargetTexture.value, false);
});
