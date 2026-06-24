import assert from "node:assert/strict";
import test from "node:test";
import { installTextureAirbrushNeighborPaintMethods } from "../../src/weight-editor/airbrush/neighbor.js";
import { installTextureAirbrushScreenStrokeMethods } from "../../src/weight-editor/airbrush/screen-strokes.js";
import { installTextureAirbrushWebGlBackendMethods } from "../../src/weight-editor/airbrush/webgl-backend.js";
import { installTextureAirbrushWebGlProjectMethods } from "../../src/weight-editor/airbrush/webgl-project.js";
import { textureAirbrushWebGpuStrokeCandidateFromHit } from "../../src/weight-editor/airbrush/webgpu-stroke.js";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../../src/weight-editor/airbrush/constants.js";

function vector() {
  return {
    x: 0,
    y: 0,
    set(x = 0, y = 0) {
      this.x = x;
      this.y = y;
      return this;
    },
    copy(value = {}) {
      this.x = value.x || 0;
      this.y = value.y || 0;
      return this;
    }
  };
}

function vector3() {
  return {
    x: 0,
    y: 0,
    z: 0,
    set(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  };
}

function matrix() {
  return {
    copy() {
      return this;
    }
  };
}

function testRecord() {
  const geometry = {
    uuid: "geometry-a",
    attributes: {
      position: { count: 6 },
      uv: {}
    },
    setAttribute(name, attribute) {
      this.attributes[name] = attribute;
    }
  };
  return {
    object: { uuid: "mesh-a" },
    geometry,
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1]),
      new Set([4, 5]),
      new Set([3, 5]),
      new Set([3, 4])
    ]
  };
}

function screenEditorForNeighborStroke(activeTool = "airbrush") {
  class ScreenEditor {}
  installTextureAirbrushNeighborPaintMethods(ScreenEditor);
  installTextureAirbrushScreenStrokeMethods(ScreenEditor);
  const editor = new ScreenEditor();
  const record = testRecord();
  const material = { uuid: "mat-a" };
  editor.activeTool = activeTool;
  editor.texturePaintNeighborEnabled = true;
  editor.clonePaintMaterialForHit = () => material;
  editor.texturePaintHitForEvent = () => ({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });
  editor.textureAirbrushColor = () => ({ r: 10, g: 20, b: 30 });
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.1;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.texturePaintLayerModeActive = () => false;
  editor.texturePaintHasActivePaintLayer = () => false;
  return editor;
}

test("texture paint neighbor seed constrains hits to the starting connected surface", () => {
  class NeighborEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  const editor = new NeighborEditor();
  editor.texturePaintNeighborEnabled = true;
  const record = testRecord();
  const material = { uuid: "mat-a" };
  const otherMaterial = { uuid: "mat-b" };
  editor.clonePaintMaterialForHit = () => material;

  const seed = editor.textureAirbrushNeighborSeedFromHit({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 2 } }
    }
  });

  assert.equal(seed.enabled, true);
  assert.deepEqual(seed.seedNormal, { x: 0, y: 0, z: 1 });
  assert.deepEqual([...seed.component].sort((left, right) => left - right), [0, 1, 2]);
  assert.equal(editor.textureAirbrushNeighborCanReuseCachedPasses(seed), false);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    seed,
    record,
    { face: { a: 1, b: 2, c: 0, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } } },
    material,
    0
  ), true);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    seed,
    record,
    { face: { a: 1, b: 2, c: 0, materialIndex: 0, normal: { x: 0, y: 0, z: -1 } } },
    material,
    0
  ), true);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    seed,
    record,
    { face: { a: 3, b: 4, c: 5, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } } },
    material,
    0
  ), false);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    { ...seed, component: null },
    record,
    { face: { a: 1, b: 2, c: 0, materialIndex: 0, normal: { x: 0, y: 0, z: -1 } } },
    material,
    0
  ), false);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    seed,
    record,
    { face: { a: 0, b: 1, c: 2, materialIndex: 1, normal: { x: 0, y: 0, z: 1 } } },
    otherMaterial,
    1
  ), true);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    { ...seed, component: null },
    record,
    { face: { a: 0, b: 1, c: 2, materialIndex: 1, normal: { x: 0, y: 0, z: 1 } } },
    otherMaterial,
    1
  ), false);
  assert.equal(editor.textureAirbrushNeighborPassAllowed(seed, {
    record,
    material,
    materialIndex: 0
  }), true);
  assert.equal(editor.textureAirbrushNeighborPassAllowed(seed, {
    record,
    material: otherMaterial,
    materialIndex: 1
  }), true);
  assert.equal(editor.textureAirbrushNeighborPassAllowed({ ...seed, component: null }, {
    record,
    material: otherMaterial,
    materialIndex: 1
  }), false);
});

test("texture paint neighbor bridges duplicated hard-edge vertices by position", () => {
  class NeighborEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  const editor = new NeighborEditor();
  editor.texturePaintNeighborEnabled = true;
  editor.linkedSeamVertices = (record, vertexIndex) => [vertexIndex];
  const record = {
    object: { uuid: "mesh-a" },
    geometry: {
      uuid: "geometry-a",
      attributes: {
        position: {
          count: 6,
          itemSize: 3,
          array: new Float32Array([
            0, 0, 0,
            1, 0, 0,
            1, 1, 0,
            1, 1, 0,
            2, 1, 0,
            2, 0, 0
          ])
        }
      }
    },
    deleted: new Set(),
    vertexNeighbors: [
      new Set([1, 2]),
      new Set([0, 2]),
      new Set([0, 1]),
      new Set([4, 5]),
      new Set([3, 5]),
      new Set([3, 4])
    ]
  };
  const material = { uuid: "mat-a" };
  const otherMaterial = { uuid: "mat-b" };
  editor.clonePaintMaterialForHit = () => material;

  const seed = editor.textureAirbrushNeighborSeedFromHit({
    record,
    hit: {
      face: { a: 0, b: 1, c: 2, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } }
    }
  });

  assert.deepEqual([...seed.component].sort((left, right) => left - right), [0, 1, 2, 3, 4, 5]);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    seed,
    record,
    { face: { a: 3, b: 4, c: 5, materialIndex: 0, normal: { x: 0, y: 1, z: 0 } } },
    material,
    0
  ), true);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    seed,
    record,
    { face: { a: 3, b: 4, c: 5, materialIndex: 1, normal: { x: 0, y: 1, z: 0 } } },
    otherMaterial,
    1
  ), true);
});

test("airbrush WebGL neighbor mask keeps linked seams strict without filling whole faces", () => {
  class WebGlNeighborEditor {}
  installTextureAirbrushWebGlProjectMethods(WebGlNeighborEditor, {
    THREE: {
      BufferAttribute: class {
        constructor(array, itemSize) {
          this.array = array;
          this.itemSize = itemSize;
          this.needsUpdate = false;
        }
      }
    }
  });
  const editor = new WebGlNeighborEditor();
  editor.textureAirbrushNeighborRecordMatches = () => true;
  editor.textureAirbrushNeighborSeedKey = (seed) => seed.key || "";
  editor.textureAirbrushNeighborLinkedVertices = (record, vertexIndex) => {
    if (vertexIndex === 0) {
      return [0, 3];
    }
    if (vertexIndex === 3) {
      return [3, 0];
    }
    return [vertexIndex];
  };
  const geometry = {
    uuid: "geometry-linked-face",
    index: {
      array: new Uint16Array([
        0, 1, 2,
        3, 4, 5,
        6, 7, 8
      ])
    },
    attributes: {
      position: { count: 9 },
      uv: {}
    },
    setAttribute(name, attribute) {
      this.attributes[name] = attribute;
    },
    userData: {}
  };
  const record = {
    object: { uuid: "mesh-linked-face" },
    geometry
  };
  const seed = {
    enabled: true,
    key: "linked-face",
    record,
    component: new Set([0])
  };

  const attribute = editor.textureAirbrushNeighborGpuMaskAttribute(seed, record);

  assert.deepEqual([...attribute.array], [
    1, 0, 0,
    1, 0, 0,
    0, 0, 0
  ]);
});

test("airbrush WebGL neighbor mask completes edge-linked seam faces", () => {
  class WebGlNeighborEditor {}
  installTextureAirbrushWebGlProjectMethods(WebGlNeighborEditor, {
    THREE: {
      BufferAttribute: class {
        constructor(array, itemSize) {
          this.array = array;
          this.itemSize = itemSize;
          this.needsUpdate = false;
        }
      }
    }
  });
  const editor = new WebGlNeighborEditor();
  editor.textureAirbrushNeighborRecordMatches = () => true;
  editor.textureAirbrushNeighborSeedKey = (seed) => seed.key || "";
  editor.textureAirbrushNeighborLinkedVertices = (record, vertexIndex) => {
    if (vertexIndex === 0) {
      return [0, 3];
    }
    if (vertexIndex === 1) {
      return [1, 4];
    }
    if (vertexIndex === 3) {
      return [3, 0];
    }
    if (vertexIndex === 4) {
      return [4, 1];
    }
    return [vertexIndex];
  };
  const geometry = {
    uuid: "geometry-edge-linked-face",
    index: {
      array: new Uint16Array([
        0, 1, 2,
        3, 4, 5,
        6, 7, 8
      ])
    },
    attributes: {
      position: { count: 9 },
      uv: {}
    },
    setAttribute(name, attribute) {
      this.attributes[name] = attribute;
    },
    userData: {}
  };
  const record = {
    object: { uuid: "mesh-edge-linked-face" },
    geometry
  };
  const seed = {
    enabled: true,
    key: "edge-linked-face",
    record,
    component: new Set([0, 1, 2])
  };

  const attribute = editor.textureAirbrushNeighborGpuMaskAttribute(seed, record);

  assert.deepEqual([...attribute.array], [
    1, 1, 1,
    1, 1, 1,
    0, 0, 0
  ]);
});

test("texture airbrush screen batches carry the active neighbor seed", () => {
  const editor = screenEditorForNeighborStroke("airbrush");
  editor.textureAirbrushBeginNeighborPaintStroke({ clientX: 12, clientY: 14 }, "airbrush");

  const payload = editor.textureAirbrushScreenStrokePayload(
    { clientX: 18, clientY: 20, pointerType: "mouse" },
    { clientX: 12, clientY: 14 }
  );
  const batches = editor.textureAirbrushScreenStrokeBatches([payload]);

  assert.equal(payload.neighborPaintSeed.enabled, true);
  assert.match(payload.styleKey, /mesh-a:0:mat-a:0/);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].neighborPaintSeed, payload.neighborPaintSeed);
  assert.equal(batches[0].neighborPaintKey, payload.neighborPaintKey);
});

test("texture eraser screen batches carry the active neighbor seed", () => {
  const editor = screenEditorForNeighborStroke("texture-eraser");
  editor.textureAirbrushBeginNeighborPaintStroke({ clientX: 12, clientY: 14 }, "texture-eraser");

  const payload = editor.textureAirbrushScreenStrokePayload(
    { clientX: 18, clientY: 20, pointerType: "mouse" },
    { clientX: 12, clientY: 14 }
  );
  const batches = editor.textureAirbrushScreenStrokeBatches([payload]);

  assert.equal(payload.erase, true);
  assert.equal(payload.neighborPaintSeed.enabled, true);
  assert.match(payload.styleKey, /mesh-a:0:mat-a:0/);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].erase, true);
  assert.equal(batches[0].neighborPaintSeed, payload.neighborPaintSeed);
  assert.equal(batches[0].neighborPaintKey, payload.neighborPaintKey);
});

test("WebGPU airbrush candidates reject hits outside the neighbor seed", () => {
  class NeighborEditor {}
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  const editor = new NeighborEditor();
  const record = testRecord();
  const material = { uuid: "mat-a" };
  const seed = {
    enabled: true,
    record,
    material,
    materialIndex: 0,
    seedVertexIndex: 0,
    seedNormal: { x: 0, y: 0, z: 1 },
    component: new Set([0, 1, 2])
  };
  editor.clonePaintMaterialForHit = () => material;
  editor.editableClonePaintTexture = () => ({
    canvas: { width: 16, height: 16 },
    texture: {}
  });

  const candidate = textureAirbrushWebGpuStrokeCandidateFromHit(
    editor,
    record,
    {
      uv: { x: 0.5, y: 0.5 },
      face: { a: 3, b: 4, c: 5, materialIndex: 0 }
    },
    { clientX: 4, clientY: 4 },
    { neighborPaintSeed: seed }
  );

  assert.equal(candidate, null);
});

test("WebGL neighbor paint builds a GPU mask for only the seeded surface island", () => {
  class NeighborEditor {}
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.needsUpdate = false;
    }
  }
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  installTextureAirbrushWebGlProjectMethods(NeighborEditor, {
    THREE: { BufferAttribute }
  });
  const editor = new NeighborEditor();
  const record = testRecord();
  const seed = {
    enabled: true,
    record,
    materialIndex: 0,
    seedVertexIndex: 0,
    component: new Set([0, 1, 2]),
    key: "mesh-a:0:mat-a:0"
  };

  const attribute = editor.textureAirbrushNeighborGpuMaskAttribute(seed, record);

  assert.equal(record.geometry.attributes.textureAirbrushNeighborMask, attribute);
  assert.deepEqual([...attribute.array], [1, 1, 1, 0, 0, 0]);
  assert.equal(attribute.itemSize, 1);
  assert.equal(attribute.needsUpdate, true);
  assert.equal(editor.textureAirbrushNeighborGpuMaskAttribute(seed, record), attribute);
});

test("WebGL neighbor paint renders the seeded masked pass when overlaps hide the seed from raycasts", () => {
  class NeighborEditor {}
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.needsUpdate = false;
    }
  }
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  installTextureAirbrushWebGlProjectMethods(NeighborEditor, {
    THREE: {
      BufferAttribute,
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

  const editor = new NeighborEditor();
  const material = { uuid: "mat-a", userData: {} };
  const target = { texture: {} };
  const targetEntry = { target, width: 64, height: 32, paintRevision: 0 };
  const record = testRecord();
  record.object = {
    uuid: "mesh-a",
    material
  };
  let activeTarget = null;
  const renderUniforms = [];
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
      visibleOnlyDepthEpsilon: { value: 0 },
      uvOffset: { value: vector() },
      useNeighborMask: { value: false },
      useNeighborNormalMask: { value: false },
      neighborSeedNormal: { value: vector3() },
      neighborNormalThreshold: { value: 1 }
    },
    needsUpdate: true
  };
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget(targetValue) {
      activeTarget = targetValue;
    },
    render() {
      renderUniforms.push({
        target: activeTarget,
        useNeighborMask: shaderMaterial.uniforms.useNeighborMask.value,
        useNeighborNormalMask: shaderMaterial.uniforms.useNeighborNormalMask.value,
        neighborSeedNormal: {
          x: shaderMaterial.uniforms.neighborSeedNormal.value.x,
          y: shaderMaterial.uniforms.neighborSeedNormal.value.y,
          z: shaderMaterial.uniforms.neighborSeedNormal.value.z
        },
        neighborNormalThreshold: shaderMaterial.uniforms.neighborNormalThreshold.value,
        visibleOnlyDepthEpsilon: shaderMaterial.uniforms.visibleOnlyDepthEpsilon.value,
        strokeSegmentCount: shaderMaterial.uniforms.strokeSegmentCount.value,
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
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("seeded neighbor masked paint should not need a fresh raycast");
    },
    intersectObjects() {
      throw new Error("seeded neighbor masked paint should not need a fresh raycast");
    }
  };
  editor.textureAirbrushGpuTargetForMaterial = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    return targetEntry;
  };
  editor.captureTexturePaintGpuUndoTarget = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0.4, b: 0.1 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    assert.equal(candidateRecord, record);
    assert.equal(materialIndex, 0);
    assert.equal(candidateMaterial, material);
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.markTexturePaintGpuTargetMutated = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};
  const seed = {
    enabled: true,
    record,
    material,
    materialIndex: 0,
    seedVertexIndex: 0,
    seedNormal: { x: 0, y: 0, z: 1 },
    component: new Set([0, 1, 2]),
    key: "mesh-a:0:mat-a:0"
  };
  const projectionFrame = editor.textureAirbrushGpuProjectionFrame({ seedPaintPasses: false });

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 48, clientY: 50 }, {
    projectionFrame,
    neighborPaintSeed: seed,
    strokeSegments: [{
      start: { clientX: 20, clientY: 50 },
      end: { clientX: 48, clientY: 50 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 128, b: 32 },
    opacity: 0.8,
    hardness: 0.35,
    scatter: 0.2,
    strength: 1
  });

  assert.equal(changed > 0, true);
  assert.equal(renderUniforms.length, 1);
  assert.equal(renderUniforms[0].target, target);
  assert.equal(renderUniforms[0].useNeighborMask, true);
  assert.equal(renderUniforms[0].useNeighborNormalMask, false);
  assert.deepEqual(renderUniforms[0].neighborSeedNormal, { x: 0, y: 0, z: 1 });
  assert.equal(renderUniforms[0].neighborNormalThreshold, 0);
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // Neighbor fixes must not bypass visible-field culling for connected seeds.
  assert.equal(renderUniforms[0].visibleOnlyDepthEpsilon, 0.0008);
  assert.equal(renderUniforms[0].strokeSegmentCount, 1);
  assert.deepEqual(renderUniforms.map((entry) => entry.uvOffset), [{ x: 0, y: 0 }]);
  assert.deepEqual([...record.geometry.attributes.textureAirbrushNeighborMask.array], [1, 1, 1, 0, 0, 0]);
});

test("WebGL neighbor paint seeds all connected component material passes without priming", () => {
  class NeighborEditor {}
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.needsUpdate = false;
    }
  }
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  installTextureAirbrushWebGlProjectMethods(NeighborEditor, {
    THREE: {
      BufferAttribute,
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

  const editor = new NeighborEditor();
  const targetA = { name: "target-a", texture: {} };
  const targetB = { name: "target-b", texture: {} };
  const materialA = { uuid: "mat-a", userData: { textureAirbrushGpuTarget: { target: targetA, width: 64, height: 32, paintRevision: 0 } } };
  const materialB = { uuid: "mat-b", userData: { textureAirbrushGpuTarget: { target: targetB, width: 64, height: 32, paintRevision: 0 } } };
  const record = testRecord();
  record.geometry.groups = [
    { start: 0, count: 3, materialIndex: 0 },
    { start: 3, count: 3, materialIndex: 1 }
  ];
  record.object = {
    uuid: "mesh-a",
    material: [materialA, materialB]
  };
  const targets = new Map([
    [materialA, materialA.userData.textureAirbrushGpuTarget],
    [materialB, materialB.userData.textureAirbrushGpuTarget]
  ]);
  let activeTarget = null;
  const renderedTargets = [];
  const renderedUniforms = [];
  const proxyRequests = [];
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
      visibleOnlyDepthEpsilon: { value: 0 },
      uvOffset: { value: vector() },
      useNeighborMask: { value: false },
      useNeighborNormalMask: { value: false },
      neighborSeedNormal: { value: vector3() },
      neighborNormalThreshold: { value: 1 }
    },
    needsUpdate: true
  };
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget(targetValue) {
      activeTarget = targetValue;
    },
    render() {
      renderedTargets.push(activeTarget?.name || "unknown");
      renderedUniforms.push({
        target: activeTarget?.name || "unknown",
        useNeighborMask: shaderMaterial.uniforms.useNeighborMask.value,
        useNeighborNormalMask: shaderMaterial.uniforms.useNeighborNormalMask.value,
        visibleOnlyDepthEpsilon: shaderMaterial.uniforms.visibleOnlyDepthEpsilon.value
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
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  editor.raycaster = {
    setFromCamera() {
      throw new Error("connected neighbor seed should not need raycast priming");
    },
    intersectObjects() {
      throw new Error("connected neighbor seed should not need raycast priming");
    }
  };
  editor.textureAirbrushGpuTargetForMaterial = (material) => targets.get(material) || null;
  editor.captureTexturePaintGpuUndoTarget = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0.4, b: 0.1 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    proxyRequests.push({ record: candidateRecord, materialIndex, material: candidateMaterial });
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.markTexturePaintGpuTargetMutated = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};
  const seed = {
    enabled: true,
    record,
    material: materialA,
    materialIndex: 0,
    seedVertexIndex: 0,
    seedNormal: { x: 0, y: 0, z: 1 },
    component: new Set([0, 1, 2, 3, 4, 5]),
    key: "mesh-a:0:mat-a:0"
  };
  const projectionFrame = editor.textureAirbrushGpuProjectionFrame({ seedPaintPasses: false });

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 48, clientY: 50 }, {
    projectionFrame,
    neighborPaintSeed: seed,
    strokeSegments: [{
      start: { clientX: 20, clientY: 50 },
      end: { clientX: 48, clientY: 50 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 128, b: 32 },
    opacity: 0.8,
    hardness: 0.35,
    scatter: 0.2,
    strength: 1
  });

  assert.equal(changed > 0, true);
  assert.deepEqual(renderedTargets.sort(), ["target-a", "target-b"]);
  assert.deepEqual(
    renderedUniforms
      .sort((left, right) => left.target.localeCompare(right.target))
      .map((entry) => ({
        target: entry.target,
        useNeighborMask: entry.useNeighborMask,
        useNeighborNormalMask: entry.useNeighborNormalMask,
        visibleOnlyDepthEpsilon: entry.visibleOnlyDepthEpsilon
      })),
    [
      {
        target: "target-a",
        useNeighborMask: true,
        useNeighborNormalMask: false,
        visibleOnlyDepthEpsilon: 0.0008
      },
      {
        target: "target-b",
        useNeighborMask: true,
        useNeighborNormalMask: false,
        visibleOnlyDepthEpsilon: 0.0008
      }
    ]
  );
  assert.deepEqual(proxyRequests.map((request) => request.materialIndex).sort(), [0, 1]);
  assert.equal(projectionFrame.paintPassCache.size, 2);
});

test("post-camera Neighbor projection probes visible hits for missing warm passes", () => {
  class NeighborEditor {}
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.needsUpdate = false;
    }
  }
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  installTextureAirbrushWebGlProjectMethods(NeighborEditor, {
    THREE: {
      BufferAttribute,
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

  const editor = new NeighborEditor();
  const targetA = { name: "target-a", texture: {} };
  const targetB = { name: "target-b", texture: {} };
  const materialA = { uuid: "mat-a", userData: { textureAirbrushGpuTarget: { target: targetA, width: 64, height: 32, paintRevision: 0 } } };
  const materialB = { uuid: "mat-b", userData: { textureAirbrushGpuTarget: { target: targetB, width: 64, height: 32, paintRevision: 0 } } };
  const record = testRecord();
  record.geometry.groups = [
    { start: 0, count: 6, materialIndex: 0 }
  ];
  record.object = {
    uuid: "mesh-a",
    material: [materialA, materialB]
  };
  const targets = new Map([
    [materialA, materialA.userData.textureAirbrushGpuTarget],
    [materialB, materialB.userData.textureAirbrushGpuTarget]
  ]);
  let activeTarget = null;
  const renderedTargets = [];
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
      visibleOnlyDepthEpsilon: { value: 0 },
      uvOffset: { value: vector() },
      useNeighborMask: { value: false },
      useNeighborNormalMask: { value: false },
      neighborSeedNormal: { value: vector3() },
      neighborNormalThreshold: { value: 1 }
    },
    needsUpdate: true
  };
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget(targetValue) {
      activeTarget = targetValue;
    },
    render() {
      renderedTargets.push(activeTarget?.name || "unknown");
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
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  let raycastCalls = 0;
  editor.raycaster = {
    setFromCamera() {
      raycastCalls += 1;
    },
    intersectObjects(objects) {
      assert.deepEqual(objects, [record.object]);
      return [{
        distance: 1,
        object: record.object,
        face: { a: 0, b: 1, c: 2, materialIndex: 1, normal: { x: 0, y: 0, z: 1 } }
      }];
    }
  };
  editor.clonePaintMaterialForHit = (candidateRecord, hit) => {
    assert.equal(candidateRecord, record);
    return hit?.face?.materialIndex === 1 ? materialB : materialA;
  };
  editor.textureAirbrushGpuTargetForMaterial = (material) => targets.get(material) || null;
  editor.captureTexturePaintGpuUndoTarget = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0.4, b: 0.1 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = (candidateRecord, materialIndex, candidateMaterial) => {
    assert.equal(candidateRecord, record);
    assert.equal(candidateMaterial, materialIndex === 1 ? materialB : materialA);
    return { scene: {} };
  };
  editor.textureAirbrushGpuUvBleedOffsets = () => [vector()];
  editor.markTexturePaintGpuTargetMutated = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};
  const seed = {
    enabled: true,
    record,
    material: materialA,
    materialIndex: 0,
    seedVertexIndex: 0,
    seedNormal: { x: 0, y: 0, z: 1 },
    component: new Set([0, 1, 2]),
    key: "mesh-a:0:mat-a:0"
  };
  const projectionFrame = editor.textureAirbrushGpuProjectionFrame({ seedPaintPasses: false });
  const staleProbePass = {
    key: "stale-before-orbit-target-a",
    record,
    material: materialA,
    materialIndex: 0,
    targetEntry: targets.get(materialA)
  };
  projectionFrame.probePaintPassCache.set("48:50", [staleProbePass]);

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 48, clientY: 50 }, {
    projectionFrame,
    neighborPaintSeed: seed,
    neighborProjectionRewarmed: true,
    strokeSegments: [{
      start: { clientX: 20, clientY: 50 },
      end: { clientX: 48, clientY: 50 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 128, b: 32 },
    opacity: 0.8,
    hardness: 0.35,
    scatter: 0.2,
    strength: 1
  });

  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // The extra post-camera probe may add only visible raycast candidate passes;
  // the WebGL shader still performs the strict camera-facing/depth discard.
  // The stale pre-orbit probe cache may not short-circuit this fresh visible
  // raycast, or the first post-orbit stroke leaves holes until the next stroke.
  assert.equal(changed > 0, true);
  assert.equal(raycastCalls > 0, true);
  assert.deepEqual([...new Set(renderedTargets)].sort(), ["target-a", "target-b"]);
  assert.equal(projectionFrame.paintPassCache.size, 2);
  assert.deepEqual(
    projectionFrame.probePaintPassCache.get("48:50")?.map((pass) => pass.targetEntry?.target?.name).sort(),
    ["target-b"]
  );
});

test("post-camera Neighbor rewarm reuses complete current cached passes for solid first stroke", () => {
  class NeighborEditor {}
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.needsUpdate = false;
    }
  }
  installTextureAirbrushNeighborPaintMethods(NeighborEditor);
  installTextureAirbrushWebGlProjectMethods(NeighborEditor, {
    THREE: {
      BufferAttribute,
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

  const editor = new NeighborEditor();
  const targetA = { name: "target-a", texture: {} };
  const targetB = { name: "target-b", texture: {} };
  const materialA = { uuid: "mat-a", userData: { textureAirbrushGpuTarget: { target: targetA, width: 64, height: 32, paintRevision: 0 } } };
  const materialB = { uuid: "mat-b", userData: { textureAirbrushGpuTarget: { target: targetB, width: 64, height: 32, paintRevision: 0 } } };
  const record = testRecord();
  record.object = {
    uuid: "mesh-a",
    material: [materialA, materialB]
  };
  const targets = new Map([
    [materialA, materialA.userData.textureAirbrushGpuTarget],
    [materialB, materialB.userData.textureAirbrushGpuTarget]
  ]);
  let activeTarget = null;
  const renderedTargets = [];
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
      visibleOnlyDepthEpsilon: { value: 0 },
      uvOffset: { value: vector() },
      useNeighborMask: { value: false },
      useNeighborNormalMask: { value: false },
      neighborSeedNormal: { value: vector3() },
      neighborNormalThreshold: { value: 1 }
    },
    needsUpdate: true
  };
  editor.renderer = {
    autoClear: true,
    getRenderTarget() {
      return "previous-target";
    },
    setRenderTarget(targetValue) {
      activeTarget = targetValue;
    },
    render() {
      renderedTargets.push(activeTarget?.name || "unknown");
    }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = { matrixWorldInverse: {}, projectionMatrix: {} };
  editor.model = { updateMatrixWorld() {} };
  editor.paintRecords = [record];
  editor.pointer = { x: 0, y: 0 };
  editor.refreshSkinnedRaycastBounds = () => {};
  let raycastCalls = 0;
  editor.raycaster = {
    setFromCamera() {
      raycastCalls += 1;
    },
    intersectObjects() {
      throw new Error("complete post-camera Neighbor frame should reuse cached passes");
    }
  };
  editor.textureAirbrushGpuTargetForMaterial = (material) => targets.get(material) || null;
  editor.captureTexturePaintGpuUndoTarget = () => {};
  editor.textureAirbrushRenderDepthTarget = () => ({ depthTexture: {} });
  editor.textureAirbrushBrushShaderMaterial = () => shaderMaterial;
  editor.textureAirbrushShaderColor = () => ({ r: 1, g: 0.4, b: 0.1 });
  editor.textureBrushRadiusValue = () => 0.04;
  editor.textureAirbrushGpuProxyForRecord = () => ({ scene: {} });
  editor.markTexturePaintGpuTargetMutated = () => {};
  editor.markTexturePaintStrokeChanged = () => {};
  editor.setStatus = () => {};
  const seed = {
    enabled: true,
    record,
    material: materialA,
    materialIndex: 0,
    seedVertexIndex: 0,
    seedNormal: { x: 0, y: 0, z: 1 },
    component: new Set([0, 1, 2]),
    key: "mesh-a:0:mat-a:0"
  };
  const projectionFrame = editor.textureAirbrushGpuProjectionFrame();
  editor.textureAirbrushLiveProjectionFrameState = projectionFrame;
  editor.textureAirbrushLiveProjectionFrameCurrent = (frame) => frame === projectionFrame;

  const changed = editor.textureAirbrushGpuProjectFromEvent({ clientX: 48, clientY: 50 }, {
    neighborPaintSeed: seed,
    neighborProjectionRewarmed: true,
    strokeSegments: [{
      start: { clientX: 20, clientY: 50 },
      end: { clientX: 48, clientY: 50 }
    }],
    radiusPixels: 8,
    color: { r: 255, g: 128, b: 32 },
    opacity: 0.8,
    hardness: 0.35,
    scatter: 0.2,
    spacing: 1,
    strength: 1
  });

  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // The direct airbrush path may arrive with only the post-camera rewarm flag,
  // not an explicit projectionFrame option. It must still reuse the current
  // warmed visible-frame pass list instead of falling back to sparse probes.
  // The actual fragment shader still rejects hidden, behind, and
  // non-camera-facing fragments.
  assert.equal(changed > 0, true);
  assert.equal(raycastCalls, 0);
  assert.deepEqual([...new Set(renderedTargets)].sort(), ["target-a", "target-b"]);
});

test("airbrush WebGL brush shader discards fragments outside an active neighbor mask", () => {
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
  class Vector3 extends Vector2 {
    constructor(x = 0, y = 0, z = 0) {
      super(x, y);
      this.z = z;
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
      Vector3,
      Color,
      FrontSide: 0,
      DoubleSide: 2,
      NormalBlending: 1
    }
  });
  const editor = new WebGlMaterialEditor();

  const material = editor.textureAirbrushBrushShaderMaterial();

  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // This test is intentionally noisy: the shader must keep the visible-only
  // gates. The visible-normal buffer rejects depth-close wrap/back fragments,
  // and the strict one-sided depth gate blocks hidden/behind fragments.
  // The shader must not use smoothed normal.z as the silhouette cutoff because
  // that creates triangle-ridge holes on visible front-side wrap surfaces.
  assert.deepEqual(material.extensions, { derivatives: true });
  assert.equal(material.uniforms.useNeighborMask.value, false);
  assert.equal(material.uniforms.useNeighborNormalMask.value, false);
  assert.equal(material.uniforms.neighborNormalThreshold.value, 0);
  assert.equal(material.uniforms.visibleOnlyDepthEpsilon.value, 0.0008);
  assert.equal(material.uniforms.useVisibleNormalTexture.value, false);
  assert.equal(material.uniforms.visibleNormalTexture.value, null);
  assert.equal(material.uniforms.visibleNormalMatchThreshold.value, 0.12);
  assert.equal("paintOccludedNeighborFragments" in material.uniforms, false);
  assert.match(material.vertexShader, /attribute float textureAirbrushNeighborMask/);
  assert.match(material.vertexShader, /varying float vNeighborMask/);
  assert.match(material.vertexShader, /varying vec3 vPaintObjectNormal/);
  assert.match(material.vertexShader, /varying vec3 vPaintViewNormal/);
  assert.match(material.vertexShader, /varying vec3 vPaintViewPosition/);
  assert.match(material.vertexShader, /#include <skinnormal_vertex>/);
  assert.match(material.vertexShader, /vPaintViewNormal = normalize\(mat3\(paintViewMatrix \* modelMatrix\) \* objectNormal\)/);
  assert.match(material.vertexShader, /vPaintViewPosition = \(paintViewMatrix \* worldPosition\)\.xyz/);
  assert.match(material.fragmentShader, /uniform bool useNeighborMask/);
  assert.match(material.fragmentShader, /uniform bool useNeighborNormalMask/);
  assert.match(material.fragmentShader, /uniform vec3 neighborSeedNormal/);
  assert.match(material.fragmentShader, /uniform float neighborNormalThreshold/);
  assert.match(material.fragmentShader, /uniform float visibleOnlyDepthEpsilon/);
  assert.match(material.fragmentShader, /uniform sampler2D visibleNormalTexture/);
  assert.match(material.fragmentShader, /uniform bool useVisibleNormalTexture/);
  assert.match(material.fragmentShader, /uniform float visibleNormalMatchThreshold/);
  assert.match(material.fragmentShader, /varying vec3 vPaintViewPosition/);
  assert.match(material.fragmentShader, /paintFragmentViewNormal/);
  assert.match(material.fragmentShader, /cross\(dFdx\(vPaintViewPosition\), dFdy\(vPaintViewPosition\)\)/);
  assert.match(material.fragmentShader, /gl_FrontFacing \? 1\.0 : -1\.0/);
  assert.match(material.fragmentShader, /return viewNormal/);
  assert.match(material.fragmentShader, /if \(useNeighborMask && vNeighborMask < 0\.5\)/);
  assert.match(material.fragmentShader, /vec3 paintViewNormal = paintFragmentViewNormal\(\)/);
  assert.match(material.fragmentShader, /visibleNormal = texture2D\(visibleNormalTexture, depthUv\)\.rgb \* 2\.0 - 1\.0/);
  assert.match(material.fragmentShader, /dot\(visibleNormal, paintViewNormal\) < visibleNormalMatchThreshold/);
  assert.match(material.fragmentShader, /dot\(normalize\(vPaintObjectNormal\), normalize\(neighborSeedNormal\)\) < neighborNormalThreshold/);
  assert.match(material.fragmentShader, /DO NOT PAINT ON NON CAMERA FACING SIDES/);
  assert.match(material.fragmentShader, /visible-normal buffer/);
  assert.match(material.fragmentShader, /The airbrush paints only the visible field/);
  assert.match(material.fragmentShader, /Neighbor mode is also visible-field-only/);
  assert.match(material.fragmentShader, /non-visible side, the back of the leg/);
  assert.match(material.fragmentShader, /fragmentDepth > sceneDepth \+ visibleOnlyDepthEpsilon/);
  assert.doesNotMatch(material.fragmentShader, /abs\(fragmentDepth - sceneDepth\)/);
  assert.doesNotMatch(material.fragmentShader, /paintViewNormal\.z <=|visibleNormal\.z <=|visibleFacingNormalThreshold/);
  const normalMaterial = editor.textureAirbrushVisibleSurfaceNormalMaterial();
  assert.equal(normalMaterial.side, 0);
  assert.match(normalMaterial.vertexShader, /#include <skinning_pars_vertex>/);
  assert.match(normalMaterial.fragmentShader, /FrontSide plus depth is the camera/);
  assert.doesNotMatch(normalMaterial.fragmentShader, /visibleNormal\.z <=/);
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // These old names and shortcuts were associated with painting behind/through
  // the model. If they come back, this visible-only regression test should fail
  // before the bug reaches the browser again.
  assert.doesNotMatch(material.fragmentShader, /depthEpsilon|paintOccludedNeighborFragments|neighborDepthEpsilon|neighborVisibleOnlyDepthEpsilon|neighborViewNormalThreshold/);
  assert.doesNotMatch(material.fragmentShader, /bool fragmentOccluded|strictNeighborVisibleSurface/);
  assert.doesNotMatch(material.fragmentShader, /if \(useNeighborMask\) \{\s*coverage = 1(?:\.0)?;/);
  assert.doesNotMatch(material.fragmentShader, /!\(useNeighborMask/);
});

test("broad WebGL prewarm warms all material slots for post-orbit Neighbor repaint", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, {
    THREE: {
      DoubleSide: 2,
      NormalBlending: 1
    }
  });
  const editor = new WebGlPrewarmEditor();
  const materials = Array.from({ length: 16 }, (_, index) => ({
    name: `material-${index}`,
    map: { name: `texture-${index}` }
  }));
  const record = { object: { material: materials } };
  const paintables = materials.map((material, materialIndex) => ({
    record,
    materialIndex,
    material
  }));
  const warmedIndexes = [];
  editor.textureAirbrushPaintableMaterials = () => paintables;
  editor.textureAirbrushPrewarmWebGlMaterial = (candidateRecord, materialIndex, material) => {
    assert.equal(candidateRecord, record);
    assert.equal(material, materials[materialIndex]);
    warmedIndexes.push(materialIndex);
    return true;
  };

  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // The broad all:true path is only a post-camera warm-up; actual paint still
  // has to pass the shader's camera-facing normal and strict depth gates.
  assert.equal(editor.textureAirbrushPrewarmAllWebGlMaterials({ all: true }), 16);
  assert.deepEqual(warmedIndexes, Array.from({ length: 16 }, (_, index) => index));

  warmedIndexes.length = 0;
  assert.equal(editor.textureAirbrushPrewarmAllWebGlMaterials({ all: true, limit: 2 }), 2);
  assert.deepEqual(warmedIndexes, [0, 1]);

  warmedIndexes.length = 0;
  assert.equal(editor.textureAirbrushPrewarmAllWebGlMaterials(), 12);
  assert.deepEqual(warmedIndexes, Array.from({ length: 12 }, (_, index) => index));
});

test("broad prewarm stays on non-layer path when no paint layer is active", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, {
    THREE: {
      DoubleSide: 2,
      NormalBlending: 1
    }
  });
  const editor = new WebGlPrewarmEditor();
  const calls = [];
  const liveFrame = {};

  editor.activeTool = "airbrush";
  editor.renderer = {};
  editor.model = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.textureAirbrushBrushShaderMaterial = () => {
    calls.push("shader");
    return {};
  };
  editor.textureAirbrushEnsureCopyScene = () => {
    calls.push("copy-scene");
    return true;
  };
  editor.textureAirbrushRenderDepthTarget = () => {
    calls.push("depth");
    return {};
  };
  editor.textureAirbrushPrewarmAllWebGlMaterials = (options) => {
    calls.push(["webgl-all", options]);
    return 1;
  };
  editor.textureAirbrushPrewarmAllWebGpuPaintables = (options) => {
    calls.push(["webgpu-all", options]);
    return 0;
  };
  editor.textureAirbrushPrewarmAllLayerMaterials = () => {
    throw new Error("No active paint layer should not use layer prewarm");
  };
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    calls.push(["live-frame", options]);
    return liveFrame;
  };

  assert.equal(editor.textureAirbrushPrewarm(null, null, {
    all: true,
    force: true,
    preserveLayerDisplay: true
  }), true);
  assert.deepEqual(calls, [
    "shader",
    "copy-scene",
    "depth",
    ["webgl-all", {
      all: true,
      force: true,
      preserveLayerDisplay: true
    }],
    ["webgpu-all", {
      all: true,
      force: true,
      preserveLayerDisplay: true
    }],
    ["live-frame", {}]
  ]);
});

test("projection target lookup stays non-layer when no paint layer is active", () => {
  class WebGlTargetEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlTargetEditor, {
    THREE: {
      DoubleSide: 2,
      NormalBlending: 1
    }
  });
  const editor = new WebGlTargetEditor();
  const baseTarget = { target: { texture: { name: "base-texture" } } };
  const material = {
    map: baseTarget.target.texture,
    userData: {
      textureAirbrushGpuTarget: baseTarget
    }
  };
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => false;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => {
    throw new Error("No active paint layer should not request a layer paint target");
  };

  assert.equal(editor.textureAirbrushGpuTargetForMaterial(material), baseTarget);
});
