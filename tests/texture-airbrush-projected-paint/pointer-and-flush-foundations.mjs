import assert from "node:assert/strict";
import test from "node:test";
import { installClonePaintMethods } from "../../src/weight-editor/clone-paint.js";
import { installPaintToolMethods } from "../../src/weight-editor/paint-tools.js";
import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "../../src/weight-editor/airbrush/constants.js";
import { installTextureAirbrushPressureMethods } from "../../src/weight-editor/airbrush/pressure.js";
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

    const skipped = editor.flushTextureAirbrushGpuTargetsToCanvases({ mutatedOnly: true });
    assert.equal(skipped, 0);
    assert.equal(material.userData.textureAirbrushGpuTarget, targetEntry);
    assert.equal(targetDisposed, false);
    assert.equal(previousTextureDisposed, false);

    targetEntry.paintRevision = 1;
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

test("editable texture remains available after a layer composite replaces the visible map", () => {
  class CloneEditor {}
  installClonePaintMethods(CloneEditor, { THREE: {} });
  const editor = new CloneEditor();
  const baseCanvas = { width: 4, height: 4 };
  const baseContext = {};
  const layerCanvas = { width: 4, height: 4 };
  const layerContext = {};
  const cloneTexture = { name: "editable clone texture" };
  const compositeTexture = { name: "material texture layer composite" };
  const layerTexture = { name: "active paint layer texture" };
  const material = {
    map: compositeTexture,
    userData: {
      clonePaintCanvas: baseCanvas,
      clonePaintContext: baseContext,
      clonePaintTexture: cloneTexture
    }
  };
  let layerTargetEditable = null;
  const layerEditable = {
    canvas: layerCanvas,
    context: layerContext,
    texture: layerTexture,
    layerMode: true
  };
  editor.texturePaintEditableLayerTarget = (targetMaterial, editable) => {
    assert.equal(targetMaterial, material);
    layerTargetEditable = editable;
    return layerEditable;
  };

  const editable = editor.editableClonePaintTexture(material);

  assert.equal(layerTargetEditable.canvas, baseCanvas);
  assert.equal(layerTargetEditable.context, baseContext);
  assert.equal(layerTargetEditable.texture, cloneTexture);
  assert.equal(editable, layerEditable);
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

test("Safari mouse fallback can drag an airbrush stroke without pointer events", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const painted = [];
  let undoLabel = null;
  let prevented = 0;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {};
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = (label) => {
    undoLabel = label;
  };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      reset: options?.reset === true,
      webkitForce: event.webkitForce
    });
    return true;
  };

  assert.equal(editor.onCanvasMouseDownFallback({
    button: 0,
    buttons: 1,
    clientX: 12,
    clientY: 20,
    webkitForce: 0.18,
    preventDefault() {
      prevented += 1;
    }
  }), true);
  assert.equal(editor.onCanvasMouseMoveFallback({
    button: 0,
    buttons: 1,
    clientX: 16,
    clientY: 24,
    webkitForce: 0.62,
    preventDefault() {
      prevented += 1;
    }
  }), true);
  assert.equal(editor.onCanvasMouseUpFallback({}), true);

  assert.equal(undoLabel, "Texture airbrush");
  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, false);
  assert.deepEqual(painted, [
    { x: 12, y: 20, reset: true, webkitForce: 0.18 },
    { x: 16, y: 24, reset: false, webkitForce: 0.62 }
  ]);
  assert.equal(prevented, 2);
});

test("mouse fallback ignores duplicate mousedown immediately after pointerdown", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let painted = 0;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {};
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = () => {};
  editor.paintTextureStrokeFromEvent = () => {
    painted += 1;
    return true;
  };

  editor.onPointerDown({
    button: 0,
    buttons: 1,
    pointerType: "pen",
    clientX: 10,
    clientY: 20,
    preventDefault() {}
  });

  assert.equal(editor.onCanvasMouseDownFallback({
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 20,
    preventDefault() {}
  }), false);
  assert.equal(painted, 1);
});

test("Safari WebKit force changes feed the active airbrush stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushPressureMethods(PaintEditor);
  const editor = new PaintEditor();
  const painted = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.controls = { enabled: false };
  editor.showTextureStrokeCursor = () => {};
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      reset: options?.reset === true,
      webkitForce: event.webkitForce
    });
    return true;
  };

  assert.equal(editor.onCanvasWebKitMouseForceChanged({
    button: 0,
    buttons: 1,
    clientX: 32,
    clientY: 44,
    webkitForce: 0.72,
    preventDefault() {}
  }), true);

  assert.deepEqual(painted, [
    { x: 32, y: 44, reset: false, webkitForce: 0.72 }
  ]);
});

test("Safari WebKit force changes keep painting active strokes when buttons is zero", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushPressureMethods(PaintEditor);
  const editor = new PaintEditor();
  const painted = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.controls = { enabled: false };
  editor.showTextureStrokeCursor = () => {};
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      reset: options?.reset === true,
      webkitForce: event.webkitForce
    });
    return true;
  };

  assert.equal(editor.onCanvasWebKitMouseForceChanged({
    type: "webkitmouseforcechanged",
    button: 0,
    buttons: 0,
    clientX: 36,
    clientY: 48,
    webkitForce: 1.5
  }), true);

  assert.deepEqual(painted, [
    { x: 36, y: 48, reset: false, webkitForce: 1.5 }
  ]);
});

test("Safari mousemove force feeds active airbrush strokes when pointer pressure is default", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushPressureMethods(PaintEditor);
  const editor = new PaintEditor();
  const painted = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.controls = { enabled: false };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      reset: options?.reset === true,
      pressure: event.pressure,
      webkitForce: event.webkitForce
    });
    return true;
  };

  assert.equal(editor.onCanvasPressureMouseMoveFallback({
    type: "mousemove",
    pointerType: "mouse",
    pressure: 0.5,
    buttons: 1,
    clientX: 42,
    clientY: 56,
    webkitForce: 1.6
  }), true);

  assert.equal(painted.length, 1);
  assert.deepEqual({
    x: painted[0].x,
    y: painted[0].y,
    reset: painted[0].reset,
    webkitForce: painted[0].webkitForce
  }, {
    x: 42,
    y: 56,
    reset: false,
    webkitForce: 1.6
  });
  assert.ok(Math.abs(painted[0].pressure - 0.3) < 0.000001);
});

test("Safari WebKit force changes seed native pressure before the paint payload", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushPressureMethods(PaintEditor);
  const editor = new PaintEditor();
  const painted = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.controls = { enabled: false };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      pressure: event.pressure,
      source: event.__cleanupPressureSource,
      reset: options?.reset === true,
      webkitForce: event.webkitForce
    });
    return true;
  };

  assert.equal(editor.onCanvasWebKitMouseForceChanged({
    type: "webkitmouseforcechanged",
    pointerType: "mouse",
    pressure: 0.5,
    buttons: 0,
    clientX: 12,
    clientY: 16,
    webkitForce: 1.6
  }), true);

  assert.equal(painted.length, 1);
  assert.equal(painted[0].source, "native");
  assert.equal(painted[0].reset, false);
  assert.equal(painted[0].webkitForce, 1.6);
  assert.ok(Math.abs(painted[0].pressure - 0.3) < 0.000001);
});

test("Safari native pressure is retained for mouse-shaped airbrush move samples", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushPressureMethods(PaintEditor);
  const editor = new PaintEditor();
  const queued = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.textureAirbrushCanUseScreenStroke = () => true;
  editor.textureAirbrushQueueScreenStroke = (event, options) => {
    queued.push({
      x: event.clientX,
      pressure: event.pressure,
      webkitPressure: event.webkitPressure,
      webkitForce: event.webkitForce,
      retained: event.__cleanupRetainedNativePressure === true,
      startX: options.strokeStart.clientX
    });
    return true;
  };

  editor.onCanvasWebKitMouseForceChanged({
    type: "webkitmouseforcechanged",
    buttons: 1,
    clientX: 10,
    clientY: 20,
    webkitForce: 0.25
  });
  assert.equal(editor.queueAirbrushTextureStrokeEvent({
    type: "pointermove",
    pointerType: "mouse",
    pressure: 0.5,
    clientX: 20,
    clientY: 20,
    getCoalescedEvents() {
      return [
        { type: "pointermove", pointerType: "mouse", pressure: 0.5, clientX: 14, clientY: 20 },
        { type: "pointermove", pointerType: "mouse", pressure: 0.5, clientX: 20, clientY: 20 }
      ];
    }
  }), true);

  assert.deepEqual(queued, [
    { x: 10, pressure: 0.25, webkitPressure: 0.25, webkitForce: 0.25, retained: true, startX: 10 },
    { x: 14, pressure: 0.25, webkitPressure: 0.25, webkitForce: 0.25, retained: true, startX: 10 },
    { x: 20, pressure: 0.25, webkitPressure: 0.25, webkitForce: 0.25, retained: true, startX: 14 }
  ]);
});

test("Safari WebKit force capable texture strokes do not cancel native force mouse events", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const previousDocument = globalThis.document;
  globalThis.document = { onwebkitmouseforcechanged: null };
  try {
    const painted = [];
    let prevented = 0;
    let captured = 0;
    editor.activeTool = "airbrush";
    editor.controls = { enabled: true };
    editor.canvas = {
      setPointerCapture() {
        captured += 1;
      }
    };
    editor.showTextureStrokeCursor = () => {};
    editor.beginTexturePaintStrokeUndo = () => {};
    editor.paintTextureStrokeFromEvent = (event, options) => {
      painted.push({
        type: event.type,
        x: event.clientX,
        reset: options?.reset === true
      });
      return true;
    };

    editor.onPointerDown({
      type: "pointerdown",
      button: 0,
      pointerId: 4,
      pointerType: "mouse",
      clientX: 10,
      clientY: 20,
      preventDefault() {
        prevented += 1;
      }
    });
    editor.onPointerMove({
      type: "pointermove",
      pointerType: "mouse",
      clientX: 12,
      clientY: 22,
      preventDefault() {
        prevented += 1;
      }
    });

    assert.equal(prevented, 0);
    assert.equal(captured, 0);
    assert.deepEqual(painted, [
      { type: "pointerdown", x: 10, reset: true },
      { type: "pointermove", x: 12, reset: false }
    ]);
  } finally {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test("pointerrawupdate feeds active airbrush strokes when Safari exposes raw pen data", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const painted = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.controls = { enabled: false };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      pressure: event.pressure,
      reset: options?.reset === true
    });
    return true;
  };

  assert.equal(editor.onCanvasPointerRawUpdate({
    type: "pointerrawupdate",
    pointerType: "mouse",
    buttons: 1,
    clientX: 36,
    clientY: 48,
    pressure: 0.42,
    preventDefault() {}
  }), true);

  assert.deepEqual(painted, [
    { x: 36, y: 48, pressure: 0.42, reset: false }
  ]);
});

test("Safari WebKit force changes can start fallback strokes without a button field", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const painted = [];
  let undoLabel = null;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {};
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = (label) => {
    undoLabel = label;
  };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      reset: options?.reset === true,
      webkitForce: event.webkitForce
    });
    return true;
  };

  assert.equal(editor.onCanvasWebKitMouseForceChanged({
    type: "webkitmouseforcechanged",
    buttons: 1,
    clientX: 22,
    clientY: 28,
    webkitForce: 0.33,
    preventDefault() {}
  }), true);
  assert.equal(editor.painting, true);
  assert.equal(undoLabel, "Texture airbrush");
  assert.deepEqual(painted, [
    { x: 22, y: 28, reset: true, webkitForce: 0.33 }
  ]);

  assert.equal(editor.onCanvasMouseUpFallback({}), true);
});

test("Safari fallback does not treat a real secondary button as primary", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let painted = 0;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {};
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = () => {};
  editor.paintTextureStrokeFromEvent = () => {
    painted += 1;
    return true;
  };

  assert.equal(editor.onCanvasMouseDownFallback({
    button: 2,
    buttons: 2,
    clientX: 22,
    clientY: 28,
    webkitForce: 0.33,
    preventDefault() {}
  }, { allowMissingButton: true }), false);
  assert.equal(painted, 0);
});

test("Safari touch force fallback can drag an airbrush stroke", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushPressureMethods(PaintEditor);
  const editor = new PaintEditor();
  const painted = [];
  let prevented = 0;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {};
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = () => {};
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
      pressure: event.pressure,
      force: event.force,
      source: event.__cleanupPressureSource,
      reset: options?.reset === true
    });
    return true;
  };

  assert.equal(editor.onCanvasTouchStartFallback({
    changedTouches: [{
      identifier: 9,
      clientX: 18,
      clientY: 22,
      force: 0.3,
      touchType: "stylus"
    }],
    preventDefault() {
      prevented += 1;
    }
  }), true);
  assert.equal(editor.onCanvasTouchMoveFallback({
    changedTouches: [{
      identifier: 9,
      clientX: 28,
      clientY: 32,
      force: 0.7,
      touchType: "stylus"
    }],
    preventDefault() {
      prevented += 1;
    }
  }), true);
  assert.equal(editor.onCanvasTouchEndFallback({
    preventDefault() {
      prevented += 1;
    }
  }), true);

  assert.equal(editor.painting, false);
  assert.equal(prevented, 5);
  assert.deepEqual(painted, [
    { x: 18, y: 22, pointerType: "pen", pressure: 0.3, force: 0.3, source: "native", reset: true },
    { x: 28, y: 32, pointerType: "pen", pressure: 0.7, force: 0.7, source: "native", reset: false }
  ]);
});

test("Safari touchmove uses active touches force before changedTouches", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  installTextureAirbrushPressureMethods(PaintEditor);
  const editor = new PaintEditor();
  const painted = [];
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {};
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = () => {};
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      x: event.clientX,
      y: event.clientY,
      pressure: event.pressure,
      force: event.force,
      source: event.__cleanupPressureSource,
      reset: options?.reset === true
    });
    return true;
  };

  assert.equal(editor.onCanvasTouchStartFallback({
    touches: [{
      identifier: 9,
      clientX: 18,
      clientY: 22,
      force: 0.2,
      touchType: "stylus"
    }],
    preventDefault() {}
  }), true);
  assert.equal(editor.onCanvasTouchMoveFallback({
    touches: [{
      identifier: 9,
      clientX: 30,
      clientY: 34,
      force: 0.8,
      touchType: "stylus"
    }],
    changedTouches: [{
      identifier: 9,
      clientX: 28,
      clientY: 32,
      force: 0.1,
      touchType: "stylus"
    }],
    preventDefault() {}
  }), true);

  assert.deepEqual(painted, [
    { x: 18, y: 22, pressure: 0.2, force: 0.2, source: "native", reset: true },
    { x: 30, y: 34, pressure: 0.8, force: 0.8, source: "native", reset: false }
  ]);
});

test("airbrush coalesced samples use lightweight point events", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const samples = editor.texturePaintCoalescedEvents({
    type: "pointermove",
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
        { type: "pointermove", clientX: 10, clientY: 2, pressure: 0.4, pointerType: "pen", tiltX: 7 },
        { type: "pointermove", clientX: 20, clientY: 4, pressure: 0.6, pointerType: "pen", tiltX: 11 }
      ];
    }
  });

  assert.deepEqual(samples.map((event) => ({
    type: event.type,
    x: event.clientX,
    y: event.clientY,
    pressure: event.pressure,
    pointerType: event.pointerType,
    tiltX: event.tiltX,
    hasPreventDefault: typeof event.preventDefault === "function"
  })), [
    { type: "pointermove", x: 10, y: 2, pressure: 0.4, pointerType: "pen", tiltX: 7, hasPreventDefault: false },
    { type: "pointermove", x: 20, y: 4, pressure: 0.6, pointerType: "pen", tiltX: 11, hasPreventDefault: false }
  ]);
});

test("airbrush coalesced samples preserve Safari WebKit force", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const samples = editor.texturePaintCoalescedEvents({
    clientX: 20,
    clientY: 4,
    pointerType: "pen",
    pressure: 0.5,
    webkitForce: 0.5,
    force: 0.51,
    getCoalescedEvents() {
      return [
        { clientX: 10, clientY: 2, pressure: 0.5, pointerType: "pen", webkitForce: 0.2, force: 0.21 },
        { clientX: 20, clientY: 4, pressure: 0.5, pointerType: "pen", webkitForce: 0.8, force: 0.81 }
      ];
    }
  });

  assert.deepEqual(samples.map((event) => ({
    x: event.clientX,
    y: event.clientY,
    webkitForce: event.webkitForce,
    force: event.force
  })), [
    { x: 10, y: 2, webkitForce: 0.2, force: 0.21 },
    { x: 20, y: 4, webkitForce: 0.8, force: 0.81 }
  ]);
});

test("airbrush coalesced samples preserve Safari vendor pressure", () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  const samples = editor.texturePaintCoalescedEvents({
    type: "pointermove",
    clientX: 20,
    clientY: 4,
    pointerType: "mouse",
    pressure: 0.5,
    webkitPressure: 0.4,
    getCoalescedEvents() {
      return [
        { type: "pointermove", clientX: 10, clientY: 2, pressure: 0.5, pointerType: "mouse", webkitPressure: 0.2 },
        { type: "pointermove", clientX: 20, clientY: 4, pressure: 0.5, pointerType: "mouse", webkitPressure: 0.7 }
      ];
    }
  });

  assert.deepEqual(samples.map((event) => ({
    type: event.type,
    x: event.clientX,
    y: event.clientY,
    pressure: event.pressure,
    pointerType: event.pointerType,
    webkitPressure: event.webkitPressure
  })), [
    { type: "pointermove", x: 10, y: 2, pressure: 0.5, pointerType: "mouse", webkitPressure: 0.2 },
    { type: "pointermove", x: 20, y: 4, pressure: 0.5, pointerType: "mouse", webkitPressure: 0.7 }
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
