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

test("texture paint neighbor seed constrains hits to the starting connected material", () => {
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
    { face: { a: 3, b: 4, c: 5, materialIndex: 0, normal: { x: 0, y: 0, z: 1 } } },
    material,
    0
  ), false);
  assert.equal(editor.textureAirbrushNeighborHitAllowed(
    seed,
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
  }), false);
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
      NormalBlending: "normal-blending"
    }
  });

  const editor = new NeighborEditor();
  const material = { uuid: "mat-a", userData: {} };
  const target = { texture: {} };
  const targetEntry = { target, paintRevision: 0 };
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
      depthEpsilon: { value: 0 },
      uvOffset: { value: vector() },
      useNeighborMask: { value: false },
      useNeighborNormalMask: { value: false },
      neighborSeedNormal: { value: vector3() },
      neighborNormalThreshold: { value: 1 },
      neighborViewNormalThreshold: { value: 0 },
      paintOccludedNeighborFragments: { value: false }
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
        neighborViewNormalThreshold: shaderMaterial.uniforms.neighborViewNormalThreshold.value,
        paintOccludedNeighborFragments: shaderMaterial.uniforms.paintOccludedNeighborFragments.value,
        strokeSegmentCount: shaderMaterial.uniforms.strokeSegmentCount.value
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
  assert.equal(renderUniforms[0].useNeighborNormalMask, true);
  assert.deepEqual(renderUniforms[0].neighborSeedNormal, { x: 0, y: 0, z: 1 });
  assert.equal(renderUniforms[0].neighborNormalThreshold, 0);
  assert.equal(renderUniforms[0].neighborViewNormalThreshold, 0.18);
  assert.equal(renderUniforms[0].paintOccludedNeighborFragments, true);
  assert.equal(renderUniforms[0].strokeSegmentCount, 1);
  assert.deepEqual([...record.geometry.attributes.textureAirbrushNeighborMask.array], [1, 1, 1, 0, 0, 0]);
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
      DoubleSide: 2,
      NormalBlending: 1
    }
  });
  const editor = new WebGlMaterialEditor();

  const material = editor.textureAirbrushBrushShaderMaterial();

  assert.equal(material.uniforms.useNeighborMask.value, false);
  assert.equal(material.uniforms.useNeighborNormalMask.value, false);
  assert.equal(material.uniforms.neighborNormalThreshold.value, 0);
  assert.equal(material.uniforms.neighborViewNormalThreshold.value, 0.18);
  assert.equal(material.uniforms.paintOccludedNeighborFragments.value, false);
  assert.match(material.vertexShader, /attribute float textureAirbrushNeighborMask/);
  assert.match(material.vertexShader, /varying float vNeighborMask/);
  assert.match(material.vertexShader, /varying vec3 vPaintObjectNormal/);
  assert.match(material.vertexShader, /varying vec3 vPaintViewNormal/);
  assert.match(material.vertexShader, /#include <skinnormal_vertex>/);
  assert.match(material.vertexShader, /mat3\(paintViewMatrix \* modelMatrix\) \* objectNormal/);
  assert.match(material.fragmentShader, /uniform bool useNeighborMask/);
  assert.match(material.fragmentShader, /uniform bool useNeighborNormalMask/);
  assert.match(material.fragmentShader, /uniform vec3 neighborSeedNormal/);
  assert.match(material.fragmentShader, /uniform float neighborNormalThreshold/);
  assert.match(material.fragmentShader, /uniform float neighborViewNormalThreshold/);
  assert.match(material.fragmentShader, /uniform bool paintOccludedNeighborFragments/);
  assert.match(material.fragmentShader, /if \(useNeighborMask && vNeighborMask < 0\.5\)/);
  assert.match(material.fragmentShader, /dot\(normalize\(vPaintObjectNormal\), normalize\(neighborSeedNormal\)\) < neighborNormalThreshold/);
  assert.match(material.fragmentShader, /normalize\(vPaintViewNormal\)\.z < neighborViewNormalThreshold/);
  assert.match(material.fragmentShader, /!\(useNeighborMask && paintOccludedNeighborFragments\)/);
});
