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

test("CPU layer airbrush caps opacity against the stroke-start image", () => {
  class UvEditor {}
  class Vector2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
  }
  class Vector3 {
    fromBufferAttribute(attribute, index) {
      const point = attribute.points[index];
      this.x = point.x;
      this.y = point.y;
      this.z = point.z;
      return this;
    }
    project() {
      return this;
    }
  }
  installTextureAirbrushUvBrushMethods(UvEditor, { THREE: { Vector2, Vector3 } });
  const editor = new UvEditor();
  const canvas = { width: 4, height: 4 };
  const texture = {};
  const sourceImage = {
    width: 4,
    height: 4,
    data: new Uint8ClampedArray(4 * 4 * 4)
  };
  const image = {
    width: 4,
    height: 4,
    data: new Uint8ClampedArray(sourceImage.data)
  };
  const strokeAlphaByPixel = new Map();
  const record = {
    deleted: new Set(),
    object: {
      updateMatrixWorld() {},
      localToWorld(point) {
        return point;
      }
    },
    geometry: {
      attributes: {
        position: {
          points: [
            { x: -1, y: 1, z: 0 },
            { x: 1, y: 1, z: 0 },
            { x: -1, y: -1, z: 0 }
          ]
        },
        uv: {
          getX(index) {
            return [0, 1, 0][index];
          },
          getY(index) {
            return [0, 0, 1][index];
          }
        }
      }
    }
  };
  const hit = {
    uv: { x: 0.25, y: 0.25 },
    face: { a: 0, b: 1, c: 2, materialIndex: 0 }
  };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 4, height: 4 };
    }
  };
  editor.camera = {};
  editor.model = { updateMatrixWorld() {} };
  editor.applyBoneTransform = () => {};
  editor.clonePaintMaterialForHit = () => ({ uuid: "paint-material" });
  editor.editableClonePaintTexture = () => ({
    canvas,
    context: {},
    texture,
    layerMode: true
  });
  editor.textureAirbrushRegionPixelFromUv = (uv) => ({
    x: uv.x * canvas.width,
    y: uv.y * canvas.height
  });
  editor.texturePaintClosestTrianglePoint = () => ({ distanceSq: 0 });
  editor.clonePaintTriangleTransform = () => ({});
  editor.clonePaintTransformPoint = (transform, point) => ({ x: point.x, y: point.y });
  editor.clonePaintBarycentric = () => ({});
  editor.clonePaintBarycentricInside = () => true;
  editor.clonePaintActualPixelFromTexturePoint = (point) => {
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    return x >= 0 && x < canvas.width && y >= 0 && y < canvas.height ? { x, y } : null;
  };
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const centerOffset = (1 * canvas.width + 1) * 4;
  const paint = (opacity) => editor.textureAirbrushUvBrushOnFace(record, hit, {
    clientX: 1,
    clientY: 1
  }, {
    radiusPixels: 1,
    opacity,
    hardness: 1,
    scatter: 0,
    strength: 1,
    paintState: {
      image,
      sourceImage,
      strokeAlphaByPixel,
      changed: 0
    },
    deferCommit: true
  });

  assert.equal(paint(0.5) > 0, true);
  assert.equal(image.data[centerOffset + 3], 128);
  assert.equal(paint(0.5), 0);
  assert.equal(image.data[centerOffset + 3], 128);
  assert.equal(paint(0.8) > 0, true);
  assert.equal(image.data[centerOffset + 3], 204);
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

test("ending a layer airbrush stroke schedules the next layer source prewarm", () => {
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
  const targetEntry = {
    width: 1,
    height: 1,
    layerMode: true,
    target: { texture: {} }
  };
  const material = { uuid: "material-layer-next-source" };
  let scheduledPrewarms = 0;
  let snapshotCopies = 0;
  editor.undoStack = [];
  editor.redoStack = [];
  editor.updateUndoButton = () => {};
  editor.flushTextureAirbrushScreenStroke = () => 0;
  editor.cloneTextureRenderTargetSnapshot = () => {
    snapshotCopies += 1;
    return afterSnapshot;
  };
  editor.scheduleTextureAirbrushPostStrokePrewarm = () => {
    scheduledPrewarms += 1;
    return true;
  };
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

  assert.equal(editor.endTexturePaintStrokeUndo(), true);
  assert.equal(scheduledPrewarms, 1);
  assert.equal(snapshotCopies, 1);
  assert.equal(targetEntry.prewarmedStrokeSourceSnapshot?.snapshot, afterSnapshot);
  assert.equal(afterSnapshot.texturePaintSnapshotRefs, 2);
  assert.equal(editor.texturePaintGpuPrewarmSnapshotCurrent(targetEntry), true);

  editor.texturePaintStrokeUndo = {
    label: "Texture airbrush",
    changed: false,
    touched: new Map(),
    before: []
  };
  editor.cloneTextureRenderTargetSnapshot = () => {
    throw new Error("next stroke should reuse the finalized after snapshot");
  };

  assert.equal(editor.captureTexturePaintGpuUndoTarget({}, material, targetEntry, 0), true);
  assert.equal(editor.texturePaintStrokeUndo.before[0].before, afterSnapshot);
  assert.equal(targetEntry.prewarmedStrokeSourceSnapshot, undefined);
  assert.equal(afterSnapshot.texturePaintSnapshotRefs, 2);
});

test("post-stroke layer prewarm prepares the next active layer source off the downstroke", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  let scheduledCallback = null;
  try {
    globalThis.window = {
      setTimeout(callback) {
        scheduledCallback = callback;
        return 1;
      }
    };
    const material = { uuid: "material-post-stroke-source" };
    const targetEntry = {
      target: { texture: { uuid: "layer-texture" } }
    };
    let prewarmedTargets = 0;
    editor.activeTool = "airbrush";
    editor.renderer = {};
    editor.painting = false;
    editor.texturePaintActiveMaterial = material;
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushGpuLayerTargetForMaterial = (candidateMaterial, options) => {
      assert.equal(candidateMaterial, material);
      assert.deepEqual(options, { renderPanel: false, setActiveMaterial: false });
      return targetEntry;
    };
    editor.prewarmTexturePaintGpuStrokeSourceSnapshot = (candidateTarget) => {
      assert.equal(candidateTarget, targetEntry);
      prewarmedTargets += 1;
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPostStrokePrewarm(), true);
    assert.equal(editor.textureAirbrushPostStrokePrewarmPending, true);
    assert.equal(prewarmedTargets, 0);
    scheduledCallback();
    assert.equal(editor.textureAirbrushPostStrokePrewarmPending, false);
    assert.equal(prewarmedTargets, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("post-stroke layer prewarm uses the next frame before idle timing", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  let frameCallback = null;
  let idleCalls = 0;
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        frameCallback = callback;
        return 1;
      },
      requestIdleCallback() {
        idleCalls += 1;
        throw new Error("post-stroke layer source prewarm should not wait for browser idle");
      },
      setTimeout() {
        throw new Error("post-stroke layer source prewarm should prefer animation frame");
      }
    };
    const material = { uuid: "material-post-stroke-frame-source" };
    const targetEntry = {
      target: { texture: { uuid: "layer-frame-texture" } }
    };
    let prewarmedTargets = 0;
    editor.activeTool = "airbrush";
    editor.renderer = {};
    editor.painting = false;
    editor.texturePaintActiveMaterial = material;
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
    editor.prewarmTexturePaintGpuStrokeSourceSnapshot = (candidateTarget) => {
      assert.equal(candidateTarget, targetEntry);
      prewarmedTargets += 1;
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPostStrokePrewarm(), true);
    assert.equal(typeof frameCallback, "function");
    assert.equal(idleCalls, 0);
    assert.equal(prewarmedTargets, 0);
    frameCallback();
    assert.equal(editor.textureAirbrushPostStrokePrewarmPending, false);
    assert.equal(prewarmedTargets, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("post-stroke layer prewarm retries after active painting clears", () => {
  class WebGlPrewarmEditor {}
  installTextureAirbrushWebGlBackendMethods(WebGlPrewarmEditor, { THREE: {} });
  const editor = new WebGlPrewarmEditor();
  const originalWindow = globalThis.window;
  const frameCallbacks = [];
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }
    };
    const material = { uuid: "material-post-stroke-retry-source" };
    const targetEntry = {
      target: { texture: { uuid: "layer-retry-texture" } }
    };
    let prewarmedTargets = 0;
    editor.activeTool = "airbrush";
    editor.renderer = {};
    editor.painting = true;
    editor.texturePaintActiveMaterial = material;
    editor.texturePaintLayerModeActive = () => true;
    editor.textureAirbrushScreenStrokeHasPendingWork = () => false;
    editor.textureAirbrushGpuLayerTargetForMaterial = () => targetEntry;
    editor.prewarmTexturePaintGpuStrokeSourceSnapshot = (candidateTarget) => {
      assert.equal(candidateTarget, targetEntry);
      prewarmedTargets += 1;
      return true;
    };

    assert.equal(editor.scheduleTextureAirbrushPostStrokePrewarm(), true);
    assert.equal(frameCallbacks.length, 1);
    frameCallbacks.shift()();
    assert.equal(prewarmedTargets, 0);
    assert.equal(editor.textureAirbrushPostStrokePrewarmPending, true);
    assert.equal(frameCallbacks.length, 1);

    editor.painting = false;
    frameCallbacks.shift()();
    assert.equal(editor.textureAirbrushPostStrokePrewarmPending, false);
    assert.equal(prewarmedTargets, 1);
  } finally {
    globalThis.window = originalWindow;
  }
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

test("live airbrush never falls through to CPU texture paint when visible shader misses", () => {
  const editor = new TestEditor();
  let uvBrushTouched = false;
  let cpuRaycastTouched = false;
  editor.canvas = {
    getBoundingClientRect() {
      cpuRaycastTouched = true;
      return { left: 0, top: 0, width: 100, height: 100 };
    }
  };
  editor.camera = {};
  editor.model = {
    updateMatrixWorld() {
      cpuRaycastTouched = true;
    }
  };
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushResolveBackend = () => ({ backend: "cpu", webGpuStatus: "test-cpu-requested" });
  editor.textureAirbrushGpuProjectFromEvent = () => 0;
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // DO NOT PAINT ON NON CAMERA FACING SIDES.
  // This throw is deliberate. A live shader miss must not fall through to the
  // old CPU/UV path, because that path does not own the current visible-depth
  // and camera-facing normal masks.
  editor.textureAirbrushUvBrushOnFace = () => {
    uvBrushTouched = true;
    throw new Error("DO NOT PAINT ON NON CAMERA FACING SIDES via CPU UV fallback");
  };
  editor.setStatus = () => {};

  const changed = editor.textureAirbrushProjectedMeshFromEvent({ clientX: 10, clientY: 12 }, {
    cpuStrokeSamples: true
  });

  assert.equal(changed, 0);
  assert.equal(uvBrushTouched, false);
  assert.equal(cpuRaycastTouched, false);
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
