import assert from "node:assert/strict";
import test from "node:test";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";
import { installTexturePaintLayerMethods } from "../src/weight-editor/texture-layers.js";

class TestEditor {}
class PaintUndoEditor {}

installTexturePaintLayerMethods(TestEditor);
installTexturePaintLayerMethods(PaintUndoEditor);
installPaintToolMethods(PaintUndoEditor, {});

function fakeCanvas(width = 2, height = 1) {
  const canvas = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    className: "",
    operations: [],
    getContext() {
      return context;
    },
    setAttribute() {},
    toDataURL() {
      return "data:image/png;base64,test";
    }
  };
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    clearRect() {
      canvas.data.fill(0);
    },
    drawImage(source) {
      canvas.operations.push(this.globalCompositeOperation);
      const alpha = Number.isFinite(this.globalAlpha) ? this.globalAlpha : 1;
      for (let index = 0; index < canvas.data.length; index += 4) {
        const sourceA = (source.data[index + 3] / 255) * alpha;
        const destA = canvas.data[index + 3] / 255;
        const outA = sourceA + destA * (1 - sourceA);
        if (outA <= 0) {
          canvas.data[index] = 0;
          canvas.data[index + 1] = 0;
          canvas.data[index + 2] = 0;
          canvas.data[index + 3] = 0;
          continue;
        }
        const destWeight = destA * (1 - sourceA);
        canvas.data[index] = Math.round((source.data[index] * sourceA + canvas.data[index] * destWeight) / outA);
        canvas.data[index + 1] = Math.round((source.data[index + 1] * sourceA + canvas.data[index + 1] * destWeight) / outA);
        canvas.data[index + 2] = Math.round((source.data[index + 2] * sourceA + canvas.data[index + 2] * destWeight) / outA);
        canvas.data[index + 3] = Math.round(outA * 255);
      }
    },
    getImageData(x = 0, y = 0, width = canvas.width, height = canvas.height) {
      const sx = Math.max(0, Math.min(canvas.width - 1, Math.floor(Number(x) || 0)));
      const sy = Math.max(0, Math.min(canvas.height - 1, Math.floor(Number(y) || 0)));
      const sw = Math.max(1, Math.min(canvas.width - sx, Math.floor(Number(width) || canvas.width)));
      const sh = Math.max(1, Math.min(canvas.height - sy, Math.floor(Number(height) || canvas.height)));
      const data = new Uint8ClampedArray(sw * sh * 4);
      for (let row = 0; row < sh; row += 1) {
        const sourceOffset = ((sy + row) * canvas.width + sx) * 4;
        const targetOffset = row * sw * 4;
        data.set(canvas.data.subarray(sourceOffset, sourceOffset + sw * 4), targetOffset);
      }
      return {
        width: sw,
        height: sh,
        data
      };
    },
    putImageData(image, x = 0, y = 0) {
      const dx = Math.max(0, Math.min(canvas.width - 1, Math.floor(Number(x) || 0)));
      const dy = Math.max(0, Math.min(canvas.height - 1, Math.floor(Number(y) || 0)));
      const width = Math.max(0, Math.min(image?.width || 0, canvas.width - dx));
      const height = Math.max(0, Math.min(image?.height || 0, canvas.height - dy));
      for (let row = 0; row < height; row += 1) {
        const sourceOffset = row * image.width * 4;
        const targetOffset = ((dy + row) * canvas.width + dx) * 4;
        canvas.data.set(image.data.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
      }
    }
  };
  return canvas;
}

function fakeElement(tagName = "div") {
  return {
    tagName,
    children: [],
    className: "",
    dataset: {},
    disabled: false,
    title: "",
    value: "",
    _textContent: "",
    classList: {
      toggle() {},
      contains() {
        return false;
      }
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    get textContent() {
      const visibleValue = this.tagName === "input" ? this.value : "";
      return `${this._textContent}${visibleValue}${this.children.map((child) => child.textContent || "").join("")}`;
    },
    set textContent(value) {
      this._textContent = String(value);
    }
  };
}

test("texture paint layer pixels paint and erase alpha", () => {
  const editor = new TestEditor();
  const image = {
    data: new Uint8ClampedArray([0, 0, 0, 0])
  };

  assert.equal(editor.texturePaintApplyLayerPixel(image, 0, { r: 200, g: 100, b: 50 }, 0.5), true);
  assert.equal(image.data[3], 128);
  assert.equal(editor.texturePaintApplyLayerPixel(image, 0, { r: 0, g: 0, b: 0 }, 0.5, { erase: true }), true);
  assert.equal(image.data[3], 64);
});

test("texture paint layers composite over the base canvas", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    editor.activeTool = "airbrush";
    editor.texturePaintLayersEnabled = true;
    const material = {
      needsUpdate: false,
      userData: {}
    };
    const composite = fakeCanvas();
    composite.data.set([10, 20, 30, 255, 10, 20, 30, 255]);
    const texture = { needsUpdate: false };
    const editable = {
      canvas: composite,
      context: composite.getContext("2d"),
      texture
    };
    material.userData.clonePaintCanvas = composite;
    material.userData.clonePaintContext = editable.context;
    material.userData.clonePaintTexture = texture;
    editor.texturePaintActiveMaterial = material;

    assert.equal(editor.addTexturePaintLayer(), true);
    const layerEditable = editor.texturePaintEditableLayerTarget(material, editable);
    const image = layerEditable.context.getImageData(0, 0, 2, 1);
    editor.texturePaintApplyLayerPixel(image, 0, { r: 210, g: 110, b: 10 }, 0.5);
    layerEditable.context.putImageData(image, 0, 0);
    assert.equal(editor.texturePaintCommitEditable(layerEditable, material), true);

    assert.deepEqual([...composite.data.slice(0, 4)], [110, 65, 20, 255]);
    assert.equal(texture.needsUpdate, true);
    assert.equal(material.needsUpdate, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("texture paint layer composite uses each layer blend mode", () => {
  const editor = new TestEditor();
  const material = {
    needsUpdate: false,
    userData: {}
  };
  const baseCanvas = fakeCanvas();
  baseCanvas.data.set([10, 20, 30, 255, 10, 20, 30, 255]);
  const composite = fakeCanvas();
  const layerCanvas = fakeCanvas();
  layerCanvas.data.set([210, 110, 10, 128, 50, 220, 90, 128]);
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 0.75,
    blendMode: "screen",
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: false
  };
  material.userData.clonePaintCanvas = composite;
  material.userData.clonePaintContext = composite.getContext("2d");
  material.userData.clonePaintTexture = { needsUpdate: false };
  material.userData.texturePaintLayerStack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };

  assert.equal(editor.texturePaintCompositeMaterialLayers(material, { skipGpuFlush: true }), true);
  assert.deepEqual(composite.operations, ["source-over", "screen"]);
  assert.equal(material.userData.clonePaintContext.globalCompositeOperation, "source-over");
  assert.equal(material.userData.clonePaintContext.globalAlpha, 1);
});

test("texture paint layer commit preserves live WebGPU display when requested", () => {
  const editor = new TestEditor();
  const baseCanvas = fakeCanvas();
  baseCanvas.data.set([10, 20, 30, 255, 10, 20, 30, 255]);
  const composite = fakeCanvas();
  const layerCanvas = fakeCanvas();
  layerCanvas.data.set([210, 110, 10, 128, 50, 220, 90, 128]);
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true
  };
  const stack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  const clonePaintTexture = { needsUpdate: false };
  const externalMap = {};
  const material = {
    needsUpdate: false,
    map: externalMap,
    userData: {
      clonePaintCanvas: composite,
      clonePaintContext: composite.getContext("2d"),
      clonePaintTexture,
      textureAirbrushWebGpuCanvasMap: clonePaintTexture,
      textureAirbrushWebGpuExternalMap: externalMap,
      texturePaintLayerStack: stack
    }
  };
  const editable = {
    canvas: layerCanvas,
    context: layer.context,
    texture: clonePaintTexture,
    layer,
    layerStack: stack,
    layerMode: true
  };
  let invalidateCalls = 0;
  editor.textureAirbrushInvalidateWebGpuCache = () => {
    invalidateCalls += 1;
  };

  assert.equal(editor.texturePaintCommitEditable(editable, material, null, {
    skipGpuTargetUpload: true,
    preserveWebGpuDisplay: true,
    refreshSpotlight: false,
    renderPanel: false
  }), true);

  assert.equal(material.map, externalMap);
  assert.equal(material.needsUpdate, false);
  assert.equal(clonePaintTexture.needsUpdate, true);
  assert.equal(layer.isEmpty, false);
  assert.equal(invalidateCalls, 0);
});

test("texture paint layer commits defer layer panel rendering", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    editor.activeTool = "airbrush";
    editor.texturePaintLayersEnabled = true;
    editor.renderTexturePaintLayerPanelCalls = 0;
    editor.scheduledLayerPanelRenders = 0;
    editor.renderTexturePaintLayerPanel = () => {
      editor.renderTexturePaintLayerPanelCalls += 1;
      return true;
    };
    editor.scheduleTexturePaintLayerPanelRender = () => {
      editor.scheduledLayerPanelRenders += 1;
      return true;
    };
    const material = {
      needsUpdate: false,
      userData: {}
    };
    const composite = fakeCanvas();
    const texture = { needsUpdate: false };
    const editable = {
      canvas: composite,
      context: composite.getContext("2d"),
      texture
    };
    material.userData.clonePaintCanvas = composite;
    material.userData.clonePaintContext = editable.context;
    material.userData.clonePaintTexture = texture;
    editor.texturePaintActiveMaterial = material;

    assert.equal(editor.addTexturePaintLayer(), true);
    editor.renderTexturePaintLayerPanelCalls = 0;
    editor.scheduledLayerPanelRenders = 0;
    const layerEditable = editor.texturePaintEditableLayerTarget(material, editable);
    assert.equal(editor.texturePaintCommitEditable(layerEditable, material), true);
    assert.equal(editor.renderTexturePaintLayerPanelCalls, 0);
    assert.equal(editor.scheduledLayerPanelRenders, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("texture paint layer panel render scheduling is debounced", async () => {
  const editor = new TestEditor();
  editor.texturePaintLayerList = {};
  editor.renderTexturePaintLayerPanelCalls = 0;
  editor.renderTexturePaintLayerPanel = () => {
    editor.renderTexturePaintLayerPanelCalls += 1;
    return true;
  };

  assert.equal(editor.scheduleTexturePaintLayerPanelRender(0), true);
  assert.equal(editor.scheduleTexturePaintLayerPanelRender(0), true);
  assert.equal(editor.renderTexturePaintLayerPanelCalls, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(editor.renderTexturePaintLayerPanelCalls, 1);
});

test("adding the first empty texture paint layer preserves the current display", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    editor.model = {};
    editor.texturePaintLayersEnabled = true;
    editor.renderTexturePaintLayerPanel = () => true;
    editor.setStatus = () => {};
    let prewarmCalls = 0;
    let fastDisplayCalls = 0;
    editor.prewarmTexturePaintActiveLayerGpu = (candidateMaterial, options) => {
      prewarmCalls += 1;
      assert.equal(candidateMaterial, material);
      assert.deepEqual(options, { all: false });
      return true;
    };
    editor.texturePaintCompositeMaterialLayers = () => {
      throw new Error("adding an empty layer should not composite synchronously");
    };
    editor.discardTexturePaintMaterialGpuComposite = () => {
      throw new Error("adding an empty layer should not discard the current layer composite");
    };
    editor.texturePaintFastMaterialLayerDisplay = (candidateMaterial, options) => {
      fastDisplayCalls += 1;
      assert.equal(candidateMaterial, material);
      assert.equal(options.changedLayer, material.userData.texturePaintLayerStack.layers[0]);
      return true;
    };
    const material = {
      needsUpdate: false,
      userData: {}
    };
    const composite = fakeCanvas();
    const texture = { needsUpdate: false };
    material.userData.clonePaintCanvas = composite;
    material.userData.clonePaintContext = composite.getContext("2d");
    material.userData.clonePaintTexture = texture;
    editor.texturePaintActiveMaterial = material;

    assert.equal(editor.addTexturePaintLayer(), true);
    const stack = material.userData.texturePaintLayerStack;
    assert.equal(stack.layers.length, 1);
    assert.equal(stack.layers[0].name, "Paint 1");
    assert.equal(stack.activeLayerId, stack.layers[0].id);
    assert.equal(prewarmCalls, 1);
    assert.equal(fastDisplayCalls, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("adding later blank texture paint layers keeps them empty and warms display", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    editor.model = {};
    editor.activeTool = "airbrush";
    editor.texturePaintLayersEnabled = true;
    editor.renderTexturePaintLayerPanel = () => true;
    editor.setStatus = () => {};
    let fastDisplayCalls = 0;
    const prewarmCalls = [];
    editor.texturePaintLayerModeActive = () => true;
    editor.texturePaintFastMaterialLayerDisplay = () => {
      fastDisplayCalls += 1;
      return true;
    };
    editor.prewarmTexturePaintActiveLayerMaterialGpu = (candidateMaterial, options) => {
      prewarmCalls.push({ candidateMaterial, options });
      return true;
    };
    editor.prewarmTexturePaintActiveLayerProjectionGpu = () => false;
    editor.prewarmTexturePaintActiveLayerCursorProbe = () => false;
    editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => true;
    const material = {
      needsUpdate: false,
      userData: {}
    };
    const composite = fakeCanvas();
    const texture = { needsUpdate: false };
    material.userData.clonePaintCanvas = composite;
    material.userData.clonePaintContext = composite.getContext("2d");
    material.userData.clonePaintTexture = texture;
    editor.texturePaintActiveMaterial = material;

    assert.equal(editor.addTexturePaintLayer(), true);
    const stack = material.userData.texturePaintLayerStack;
    stack.layers[0].canvas.data.set([1, 2, 3, 128, 0, 0, 0, 0]);
    stack.layers[0].isEmpty = false;

    assert.equal(editor.addTexturePaintLayer(), true);
    stack.layers[1].canvas.data.set([9, 8, 7, 128, 0, 0, 0, 0]);
    stack.layers[1].isEmpty = false;

    assert.equal(editor.addTexturePaintLayer(), true);

    assert.equal(stack.layers.length, 3);
    assert.equal(stack.layers[2].id, stack.activeLayerId);
    assert.deepEqual([...stack.layers[2].canvas.data], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(fastDisplayCalls, 0);
    assert.equal(prewarmCalls.length, 3);
    assert.deepEqual(prewarmCalls.map((call) => call.options.preserveLayerDisplay), [
      true,
      true,
      true
    ]);
    assert.deepEqual(prewarmCalls.map((call) => call.options.liveDisplayExternalTexture), [
      false,
      false,
      false
    ]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("airbrush layer action prewarm avoids a live display swap by default", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const editable = { canvas: fakeCanvas(), texture: {} };
  const webGpuCalls = [];
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerModeActive = () => true;
  editor.prewarmTexturePaintActiveLayerMaterialGpu = () => true;
  editor.prewarmTexturePaintActiveLayerProjectionGpu = () => false;
  editor.prewarmTexturePaintActiveLayerCursorProbe = () => false;
  editor.editableClonePaintTexture = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    return editable;
  };
  editor.textureAirbrushPrewarmWebGpuEditable = (candidateEditable, candidateMaterial, options) => {
    webGpuCalls.push({ candidateEditable, candidateMaterial, options });
    return { resources: {} };
  };
  editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => true;

  assert.equal(editor.prewarmTexturePaintActiveLayerForAction(material), true);
  assert.equal(webGpuCalls.length, 1);
  assert.equal(webGpuCalls[0].candidateEditable, editable);
  assert.equal(webGpuCalls[0].candidateMaterial, material);
  assert.equal(webGpuCalls[0].options.liveDisplayExternalTexture, false);
  assert.equal(webGpuCalls[0].options.allowPrewarmLiveDisplayMaterialSwap, false);
  assert.equal(webGpuCalls[0].options.preserveLayerDisplay, true);
});

test("adding a layer pushes a layer undo above the previous paint stroke", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    editor.model = {};
    editor.texturePaintLayersEnabled = true;
    editor.undoStack = [{ kind: "texture-paint", label: "Texture airbrush", entries: [] }];
    editor.redoStack = [];
    editor.maxUndoSteps = 40;
    editor.renderTexturePaintLayerPanel = () => true;
    editor.setStatus = () => {};
    let undoButtonUpdates = 0;
    editor.updateUndoButton = () => {
      undoButtonUpdates += 1;
    };
    const material = {
      map: null,
      needsUpdate: false,
      userData: {}
    };
    const composite = fakeCanvas();
    composite.data.set([10, 20, 30, 255, 10, 20, 30, 255]);
    const texture = { needsUpdate: false };
    material.userData.clonePaintCanvas = composite;
    material.userData.clonePaintContext = composite.getContext("2d");
    material.userData.clonePaintTexture = texture;
    editor.texturePaintActiveMaterial = material;

    assert.equal(editor.addTexturePaintLayer(), true);
    const stack = material.userData.texturePaintLayerStack;
    assert.equal(stack.layers.length, 1);
    assert.equal(editor.undoStack.length, 2);
    assert.equal(editor.undoStack[0].kind, "texture-paint");
    assert.equal(editor.undoStack[1].kind, "texture-layer");
    assert.match(editor.undoStack[1].label, /^Add Paint 1/);

    const addLayerUndo = editor.undoStack.pop();
    assert.equal(editor.restoreTexturePaintLayerHistorySnapshot(addLayerUndo.before), true);
    assert.equal(stack.layers.length, 0);
    assert.equal(stack.activeLayerId, "");
    assert.equal(editor.undoStack.length, 1);
    assert.equal(editor.undoStack[0].kind, "texture-paint");

    assert.equal(editor.restoreTexturePaintLayerHistorySnapshot(addLayerUndo.after), true);
    assert.equal(stack.layers.length, 1);
    assert.equal(stack.layers[0].name, "Paint 1");
    assert.equal(stack.activeLayerId, stack.layers[0].id);
    assert.equal(undoButtonUpdates >= 1, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("delayed paint undo finalization stays below later layer actions", () => {
  const editor = new PaintUndoEditor();
  editor.undoStack = [];
  editor.redoStack = [];
  editor.maxUndoSteps = 40;
  editor.updateUndoButton = () => {};
  const canvas = fakeCanvas();
  const context = canvas.getContext("2d");

  assert.equal(editor.beginTexturePaintStrokeUndo("Texture airbrush"), true);
  const stroke = editor.texturePaintStrokeUndo;
  const before = context.getImageData(0, 0, canvas.width, canvas.height);
  canvas.data[0] = 255;
  canvas.data[3] = 255;
  stroke.changed = true;
  stroke.before.push({
    type: "canvas",
    key: "canvas:0",
    canvas,
    context,
    before,
    after: null
  });

  editor.undoStack.push({ kind: "texture-layer", label: "Add Paint 1" });

  assert.equal(editor.finalizeTexturePaintStrokeUndo(stroke), true);
  assert.equal(editor.undoStack.length, 2);
  assert.equal(editor.undoStack[0].kind, "texture-paint");
  assert.equal(editor.undoStack[1].kind, "texture-layer");
  assert.deepEqual([...editor.undoStack[0].entries[0].after.data], [...canvas.data]);
});

test("texture paint canvas undo snapshots can stay bounded to dirty paint regions", () => {
  const editor = new PaintUndoEditor();
  editor.undoStack = [];
  editor.redoStack = [];
  editor.maxUndoSteps = 40;
  editor.updateUndoButton = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.textureAirbrushInvalidateWebGpuCache = () => {};
  const canvas = fakeCanvas(4, 1);
  const context = canvas.getContext("2d");
  canvas.data.set([
    1, 2, 3, 255,
    11, 12, 13, 255,
    21, 22, 23, 255,
    31, 32, 33, 255
  ]);
  const original = [...canvas.data];
  const editable = {
    canvas,
    context,
    texture: { needsUpdate: false }
  };
  const material = { needsUpdate: false };
  const record = {};

  assert.equal(editor.beginTexturePaintStrokeUndo("Texture airbrush"), true);
  assert.equal(editor.captureTexturePaintCanvasUndoTarget(record, material, editable, 0, {
    bounds: { x: 1, y: 0, width: 1, height: 1 }
  }), true);
  assert.equal(editor.captureTexturePaintCanvasUndoTarget(record, material, editable, 0, {
    bounds: { x: 2, y: 0, width: 2, height: 1 }
  }), true);

  canvas.data.set([100, 101, 102, 255], 4);
  canvas.data.set([110, 111, 112, 255], 8);
  canvas.data.set([120, 121, 122, 255], 12);
  editor.markTexturePaintStrokeChanged();
  const stroke = editor.texturePaintStrokeUndo;

  assert.equal(editor.finalizeTexturePaintStrokeUndo(stroke), true);
  const entry = editor.undoStack[0].entries[0];
  assert.deepEqual(entry.bounds, { x: 1, y: 0, width: 3, height: 1 });
  assert.equal(entry.before.width, 3);
  assert.equal(entry.after.width, 3);
  assert.deepEqual([...entry.before.data], original.slice(4));
  assert.deepEqual([...entry.after.data], [...canvas.data].slice(4));

  assert.equal(editor.restoreTexturePaintSnapshot([entry], "before"), true);
  assert.deepEqual([...canvas.data], original);
});

test("texture paint canvas undo rebinds material after live WebGPU display", () => {
  const editor = new PaintUndoEditor();
  const canvas = fakeCanvas(2, 1);
  const context = canvas.getContext("2d");
  canvas.data.set([
    90, 91, 92, 255,
    100, 101, 102, 255
  ]);
  const before = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      1, 2, 3, 255,
      4, 5, 6, 255
    ])
  };
  const texture = { uuid: "canvas-texture", needsUpdate: false };
  const externalMap = {
    uuid: "webgpu-live-map",
    userData: {
      textureAirbrushExternalWebGpuDisplay: true,
      textureAirbrushWebGpuCanvasMap: texture
    }
  };
  const material = {
    map: externalMap,
    needsUpdate: false,
    userData: {
      textureAirbrushWebGpuExternalMap: externalMap,
      textureAirbrushWebGpuCanvasMap: texture
    }
  };
  const record = {};
  const invalidated = [];
  editor.textureAirbrushInvalidateWebGpuCache = (target) => {
    invalidated.push(target);
  };
  editor.refreshCloneSpotlightTextures = (targetRecord) => {
    assert.equal(targetRecord, record);
  };

  assert.equal(editor.restoreTexturePaintSnapshot([{
    type: "canvas",
    record,
    canvas,
    context,
    texture,
    material,
    before
  }], "before"), true);

  assert.deepEqual([...canvas.data], [...before.data]);
  assert.equal(material.map, texture);
  assert.equal(material.needsUpdate, true);
  assert.equal(texture.needsUpdate, true);
  assert.equal(material.userData.textureAirbrushWebGpuExternalMap, undefined);
  assert.equal(material.userData.textureAirbrushWebGpuCanvasMap, undefined);
  assert.ok(invalidated.includes(texture));
  assert.ok(invalidated.includes(canvas));
});

test("texture paint layer undo rebinds live WebGPU display to composite texture", () => {
  const editor = new PaintUndoEditor();
  const layerCanvas = fakeCanvas(2, 1);
  const layerTexture = { uuid: "layer-texture", needsUpdate: false };
  const compositeTexture = { uuid: "composite-texture", needsUpdate: false };
  const layer = {
    id: "paint-1",
    gpuTarget: {
      liveCompositeTarget: { target: { texture: { uuid: "stale-live" } } },
      liveCompositeBaseTexture: { uuid: "stale-base" },
      liveCompositeLayer: null,
      liveCompositeLayerCount: 1,
      liveCompositeLayerIndex: 0,
      liveCompositeLayerOpacity: 1,
      liveCompositeLayerBlendMode: "normal",
      liveCompositeUnderlayKey: "stale",
      liveCompositeLayerMutationSerial: 1,
      liveShaderComposite: true
    }
  };
  layer.gpuTarget.liveCompositeLayer = layer;
  const stack = { layers: [layer] };
  const externalMap = {
    uuid: "webgpu-layer-live-map",
    userData: {
      textureAirbrushExternalWebGpuDisplay: true,
      textureAirbrushWebGpuCanvasMap: compositeTexture
    }
  };
  const material = {
    map: externalMap,
    needsUpdate: false,
    userData: {
      clonePaintTexture: compositeTexture,
      textureAirbrushWebGpuExternalMap: externalMap,
      textureAirbrushWebGpuCanvasMap: compositeTexture,
      texturePaintLayerStack: stack,
      texturePaintLiveLayerShaderComposite: { active: true }
    }
  };
  const invalidated = [];
  editor.textureAirbrushInvalidateWebGpuCache = (target) => {
    invalidated.push(target);
  };
  let disabledLiveShaderMaterial = null;
  editor.texturePaintDisableLiveLayerShaderComposite = (candidate) => {
    disabledLiveShaderMaterial = candidate;
    return true;
  };

  assert.equal(editor.restoreTexturePaintCanvasWebGpuDisplay({
    type: "canvas",
    canvas: layerCanvas,
    texture: layerTexture,
    material,
    layer,
    layerStack: stack
  }), true);

  assert.equal(material.map, compositeTexture);
  assert.notEqual(material.map, layerTexture);
  assert.equal(material.needsUpdate, true);
  assert.equal(layerTexture.needsUpdate, true);
  assert.equal(compositeTexture.needsUpdate, true);
  assert.equal(material.userData.textureAirbrushWebGpuExternalMap, undefined);
  assert.equal(material.userData.textureAirbrushWebGpuCanvasMap, undefined);
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite, undefined);
  assert.equal(disabledLiveShaderMaterial, material);
  assert.equal("liveCompositeTarget" in layer.gpuTarget, false);
  assert.equal("liveCompositeBaseTexture" in layer.gpuTarget, false);
  assert.equal("liveCompositeLayer" in layer.gpuTarget, false);
  assert.equal("liveCompositeLayerCount" in layer.gpuTarget, false);
  assert.equal("liveCompositeLayerIndex" in layer.gpuTarget, false);
  assert.equal("liveCompositeLayerOpacity" in layer.gpuTarget, false);
  assert.equal("liveCompositeLayerBlendMode" in layer.gpuTarget, false);
  assert.equal("liveCompositeUnderlayKey" in layer.gpuTarget, false);
  assert.equal("liveCompositeLayerMutationSerial" in layer.gpuTarget, false);
  assert.equal("liveShaderComposite" in layer.gpuTarget, false);
  assert.ok(invalidated.includes(externalMap));
  assert.ok(invalidated.includes(layerTexture));
  assert.ok(invalidated.includes(compositeTexture));
  assert.ok(invalidated.includes(layerCanvas));
});

test("texture paint layer canvas undo does not restore stale GPU target paint", () => {
  const editor = new PaintUndoEditor();
  const baseCanvas = fakeCanvas(2, 1);
  const compositeCanvas = fakeCanvas(2, 1);
  const layerCanvas = fakeCanvas(2, 1);
  const context = layerCanvas.getContext("2d");
  const before = context.getImageData(0, 0, 2, 1);
  layerCanvas.data.set([
    255, 0, 255, 255,
    255, 0, 255, 255
  ]);
  const after = context.getImageData(0, 0, 2, 1);
  const disposed = [];
  const layerTexture = {
    needsUpdate: false,
    dispose: () => disposed.push("texture")
  };
  const layerTarget = {
    emptyTransparent: false,
    paintRevision: 4,
    target: {
      texture: { uuid: "stale-layer-target" },
      dispose: () => disposed.push("target")
    }
  };
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    canvas: layerCanvas,
    context,
    isEmpty: false,
    gpuLayerTexture: layerTexture,
    gpuTarget: layerTarget
  };
  const material = {
    needsUpdate: false,
    userData: {
      clonePaintCanvas: compositeCanvas,
      clonePaintContext: compositeCanvas.getContext("2d"),
      clonePaintTexture: { needsUpdate: false },
      texturePaintLayerStack: {
        baseCanvas,
        baseContext: baseCanvas.getContext("2d"),
        width: 2,
        height: 1,
        activeLayerId: layer.id,
        selectedLayerIds: [layer.id],
        selectionAnchorLayerId: layer.id,
        layers: [layer]
      }
    }
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("undo restore must not copy stale GPU layer target back to the canvas");
  };
  editor.textureAirbrushInvalidateWebGpuCache = () => {};
  editor.updateClonePaintPreviews = () => {};
  editor.refreshCloneSpotlightTextures = () => {};

  assert.equal(editor.restoreTexturePaintSnapshot([{
    type: "canvas",
    canvas: layerCanvas,
    context,
    texture: layerTexture,
    material,
    layer,
    before,
    after
  }], "before"), true);

  assert.deepEqual([...layerCanvas.data], [...before.data]);
  assert.equal(layer.gpuTarget, undefined);
  assert.equal(layer.gpuLayerTexture, undefined);
  assert.deepEqual(disposed, ["target", "texture"]);
});

test("texture paint GPU undo rebinds live WebGPU display to canvas texture", () => {
  const editor = new PaintUndoEditor();
  const canvas = fakeCanvas(2, 1);
  const context = canvas.getContext("2d");
  const baseTexture = { uuid: "base-texture", needsUpdate: false };
  const target = { texture: { uuid: "gpu-target-texture" } };
  const snapshotTexture = { uuid: "snapshot-texture" };
  const externalMap = {
    uuid: "webgpu-live-map",
    userData: {
      textureAirbrushExternalWebGpuDisplay: true,
      textureAirbrushWebGpuCanvasMap: baseTexture
    }
  };
  const material = {
    map: externalMap,
    needsUpdate: false,
    userData: {
      clonePaintCanvas: canvas,
      clonePaintContext: context,
      clonePaintTexture: baseTexture,
      textureAirbrushWebGpuExternalMap: externalMap,
      textureAirbrushWebGpuCanvasMap: baseTexture
    }
  };
  const invalidated = [];
  const copies = [];
  editor.copyTextureToRenderTarget = (texture, renderTarget) => {
    copies.push({ texture, renderTarget });
  };
  editor.markTexturePaintGpuTargetMutated = () => true;
  editor.textureAirbrushInvalidateWebGpuCache = (targetToInvalidate) => {
    invalidated.push(targetToInvalidate);
  };
  editor.updateClonePaintPreviews = () => {};
  editor.syncPatchJson = () => {};
  editor.updateUndoButton = () => {};

  assert.equal(editor.restoreTexturePaintSnapshot([{
    type: "gpu",
    record: {},
    material,
    targetEntry: {
      target,
      width: 2,
      height: 1,
      layerMode: false
    },
    before: {
      texture: snapshotTexture,
      width: 2,
      height: 1
    }
  }], "before"), true);

  assert.deepEqual(copies, [{ texture: snapshotTexture, renderTarget: target }]);
  assert.equal(material.map, baseTexture);
  assert.equal(material.needsUpdate, true);
  assert.equal(baseTexture.needsUpdate, true);
  assert.equal(material.userData.textureAirbrushWebGpuExternalMap, undefined);
  assert.equal(material.userData.textureAirbrushWebGpuCanvasMap, undefined);
  assert.ok(invalidated.includes(baseTexture));
  assert.ok(invalidated.includes(canvas));
});

test("texture paint canvas undo defers bounded source cropping until finalization", () => {
  const editor = new PaintUndoEditor();
  editor.undoStack = [];
  editor.redoStack = [];
  editor.maxUndoSteps = 40;
  editor.updateUndoButton = () => {};
  editor.refreshCloneSpotlightTextures = () => {};
  editor.textureAirbrushInvalidateWebGpuCache = () => {};
  const canvas = fakeCanvas(4, 1);
  const context = canvas.getContext("2d");
  canvas.data.set([
    1, 2, 3, 255,
    11, 12, 13, 255,
    21, 22, 23, 255,
    31, 32, 33, 255
  ]);
  const sourceBefore = {
    width: canvas.width,
    height: canvas.height,
    data: new Uint8ClampedArray(canvas.data)
  };
  let getImageDataCalls = 0;
  const originalGetImageData = context.getImageData.bind(context);
  context.getImageData = (...args) => {
    getImageDataCalls += 1;
    return originalGetImageData(...args);
  };
  const editable = {
    canvas,
    context,
    texture: { needsUpdate: false }
  };
  const material = { needsUpdate: false };
  const record = {};

  assert.equal(editor.beginTexturePaintStrokeUndo("Texture airbrush"), true);
  assert.equal(editor.captureTexturePaintCanvasUndoTarget(record, material, editable, 0, {
    beforeImageData: sourceBefore,
    bounds: { x: 1, y: 0, width: 1, height: 1 }
  }), true);
  assert.equal(editor.captureTexturePaintCanvasUndoTarget(record, material, editable, 0, {
    bounds: { x: 2, y: 0, width: 2, height: 1 }
  }), true);
  const stroke = editor.texturePaintStrokeUndo;
  assert.equal(getImageDataCalls, 0);
  assert.equal(stroke.before[0].before, null);
  assert.notEqual(stroke.before[0].beforeSourceImageData, sourceBefore);
  assert.deepEqual([...stroke.before[0].beforeSourceImageData.data], [...sourceBefore.data]);

  canvas.data.set([100, 101, 102, 255], 4);
  canvas.data.set([110, 111, 112, 255], 8);
  canvas.data.set([120, 121, 122, 255], 12);
  editor.markTexturePaintStrokeChanged();

  assert.equal(editor.finalizeTexturePaintStrokeUndo(stroke), true);
  const entry = editor.undoStack[0].entries[0];
  assert.equal(getImageDataCalls, 1);
  assert.deepEqual(entry.bounds, { x: 1, y: 0, width: 3, height: 1 });
  assert.equal(entry.before.width, 3);
  assert.equal(entry.after.width, 3);
  assert.deepEqual([...entry.before.data], [...sourceBefore.data].slice(4));
  assert.deepEqual([...entry.after.data], [...canvas.data].slice(4));
});

test("WebGPU layer readback commit can skip stale CanvasTexture upload", () => {
  const editor = new TestEditor();
  const baseCanvas = fakeCanvas(2, 1);
  const layerCanvas = fakeCanvas(2, 1);
  const compositeCanvas = fakeCanvas(2, 1);
  const material = {
    needsUpdate: false,
    userData: {
      clonePaintCanvas: compositeCanvas,
      clonePaintContext: compositeCanvas.getContext("2d"),
      clonePaintTexture: { needsUpdate: false }
    }
  };
  const layer = {
    id: "paint-layer-1",
    name: "Paint 1",
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true,
    texturePaintGpuPainted: true,
    visible: true,
    opacity: 1,
    blendMode: "normal",
    gpuLayerTexture: { needsUpdate: false },
    gpuTarget: {
      target: {},
      emptyTransparent: false,
      texturePaintLayerHasPaint: true,
      paintRevision: 1
    }
  };
  const stack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    layers: [layer]
  };
  material.userData.texturePaintLayerStack = stack;
  const editable = {
    canvas: layerCanvas,
    context: layer.context,
    texture: material.userData.clonePaintTexture,
    layer,
    layerStack: stack,
    layerMode: true
  };
  let copyCalls = 0;
  let mutatedCalls = 0;
  let gpuFlushCalls = 0;
  editor.textureAirbrushCopyTextureToTarget = () => {
    copyCalls += 1;
    return true;
  };
  editor.markTexturePaintGpuTargetMutated = () => {
    mutatedCalls += 1;
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    gpuFlushCalls += 1;
  };

  assert.equal(editor.texturePaintCommitEditable(editable, material, null, {
    skipGpuTargetUpload: true,
    refreshSpotlight: false,
    renderPanel: false
  }), true);
  assert.equal(copyCalls, 0);
  assert.equal(mutatedCalls, 0);
  assert.equal(gpuFlushCalls, 0);
  assert.equal(layer.gpuLayerTexture.needsUpdate, false);
  assert.equal(layer.isEmpty, false);
  assert.equal(layer.gpuTarget.emptyTransparent, false);

  assert.equal(editor.texturePaintCommitEditable(editable, material, null, {
    refreshSpotlight: false,
    renderPanel: false
  }), true);
  assert.equal(copyCalls, 1);
  assert.equal(mutatedCalls, 1);
  assert.equal(gpuFlushCalls, 1);
  assert.equal(layer.gpuLayerTexture.needsUpdate, true);
});

test("background paint undo after layer restore updates the current base canvas", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new PaintUndoEditor();
    editor.updateClonePaintPreviews = () => {};
    editor.syncPatchJson = () => {};
    editor.updateUndoButton = () => {};
    editor.renderTexturePaintLayerPanel = () => true;

    const material = {
      needsUpdate: false,
      userData: {}
    };
    const texture = { needsUpdate: false };
    const displayCanvas = fakeCanvas();
    const currentBaseCanvas = fakeCanvas();
    const staleUndoCanvas = fakeCanvas();
    const staleUndoContext = staleUndoCanvas.getContext("2d");
    const before = staleUndoContext.getImageData(0, 0, staleUndoCanvas.width, staleUndoCanvas.height);
    const paintedPixels = [240, 90, 30, 255, 240, 90, 30, 255];
    displayCanvas.data.set(paintedPixels);
    currentBaseCanvas.data.set(paintedPixels);
    staleUndoCanvas.data.set(paintedPixels);
    const after = staleUndoContext.getImageData(0, 0, staleUndoCanvas.width, staleUndoCanvas.height);
    material.userData.clonePaintCanvas = displayCanvas;
    material.userData.clonePaintContext = displayCanvas.getContext("2d");
    material.userData.clonePaintTexture = texture;
    material.userData.texturePaintLayerStack = {
      baseCanvas: currentBaseCanvas,
      baseContext: currentBaseCanvas.getContext("2d"),
      width: currentBaseCanvas.width,
      height: currentBaseCanvas.height,
      activeLayerId: "",
      selectedLayerIds: [],
      selectionAnchorLayerId: "",
      layers: []
    };

    assert.equal(editor.restoreTexturePaintSnapshot([{
      type: "canvas",
      canvas: staleUndoCanvas,
      context: staleUndoContext,
      texture,
      material,
      before,
      after
    }], "before"), true);

    assert.deepEqual([...staleUndoCanvas.data], [...before.data]);
    assert.deepEqual([...currentBaseCanvas.data], [...before.data]);
    assert.deepEqual([...displayCanvas.data], [...before.data]);
    assert.equal(texture.needsUpdate, true);
    assert.equal(material.needsUpdate, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("adding a layer drains pending background paint before capturing layer undo", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    editor.model = {};
    editor.texturePaintLayersEnabled = true;
    editor.undoStack = [];
    editor.redoStack = [];
    editor.maxUndoSteps = 40;
    editor.updateUndoButton = () => {};
    editor.renderTexturePaintLayerPanel = () => true;
    editor.setStatus = () => {};
    const material = {
      map: null,
      needsUpdate: false,
      userData: {}
    };
    const composite = fakeCanvas();
    const texture = { needsUpdate: false };
    const baseCanvas = fakeCanvas();
    material.userData.clonePaintCanvas = composite;
    material.userData.clonePaintContext = composite.getContext("2d");
    material.userData.clonePaintTexture = texture;
    material.userData.texturePaintLayerStack = {
      baseCanvas,
      baseContext: baseCanvas.getContext("2d"),
      width: baseCanvas.width,
      height: baseCanvas.height,
      activeLayerId: "",
      selectedLayerIds: [],
      selectionAnchorLayerId: "",
      layers: []
    };
    editor.texturePaintActiveMaterial = material;
    const paintedPixels = [220, 100, 40, 255, 220, 100, 40, 255];
    let flushedBeforeSnapshot = false;
    editor.flushTexturePaintPendingBrushWorkBeforeLayerMutation = () => {
      const stack = material.userData.texturePaintLayerStack;
      stack.baseCanvas.data.set(paintedPixels);
      composite.data.set(paintedPixels);
      flushedBeforeSnapshot = true;
      return true;
    };

    assert.equal(editor.addTexturePaintLayer(), true);
    assert.equal(flushedBeforeSnapshot, true);
    assert.equal(editor.undoStack.length, 1);
    const addLayerUndo = editor.undoStack[0];
    assert.equal(addLayerUndo.kind, "texture-layer");
    assert.deepEqual([...addLayerUndo.before.baseCanvas.data], paintedPixels);
    assert.deepEqual([...addLayerUndo.after.baseCanvas.data], paintedPixels);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("layer mutation drain prepares pending GPU undo before baking GPU targets", () => {
  const editor = new TestEditor();
  const order = [];
  editor.texturePaintStrokeUndo = { label: "Texture airbrush" };
  editor.textureAirbrushScreenStrokeQueue = [{ strokeUndo: null }];
  editor.textureAirbrushAttachStrokeUndoToPendingScreenWork = (stroke) => {
    editor.textureAirbrushScreenStrokeQueue[0].strokeUndo = stroke;
    return true;
  };
  editor.flushTextureAirbrushScreenStroke = () => {
    order.push("screen");
    return 1;
  };
  editor.prepareTexturePaintPendingGpuUndoEntriesForCanvas = () => {
    order.push("prepare-undo");
    return true;
  };
  editor.flushTextureAirbrushGpuTargetsToCanvases = () => {
    order.push("bake-gpu");
    return 1;
  };

  assert.equal(editor.flushTexturePaintPendingBrushWorkBeforeLayerMutation(), true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[0].strokeUndo, editor.texturePaintStrokeUndo);
  assert.deepEqual(order, ["screen", "prepare-undo", "bake-gpu"]);
});

test("layer mutation drain closes an active texture stroke before baking", () => {
  const editor = new TestEditor();
  const activeStroke = { label: "Texture airbrush" };
  const order = [];
  editor.texturePaintStrokeUndo = activeStroke;
  editor.endTexturePaintStrokeUndo = () => {
    order.push("end-stroke");
    editor.texturePaintStrokeUndo = null;
    editor.texturePaintPendingStrokeUndoFinalizations = new Set([activeStroke]);
    return false;
  };
  editor.textureAirbrushAttachStrokeUndoToPendingScreenWork = () => {
    order.push("attach");
    return true;
  };
  editor.flushTextureAirbrushScreenStroke = () => {
    order.push("screen");
    return 1;
  };
  editor.prepareTexturePaintPendingGpuUndoEntriesForCanvas = () => {
    order.push("prepare-undo");
    return true;
  };
  editor.flushTextureAirbrushGpuTargetsToCanvases = () => {
    order.push("bake-gpu");
    return 1;
  };

  assert.equal(editor.flushTexturePaintPendingBrushWorkBeforeLayerMutation(), true);
  assert.deepEqual(order, ["end-stroke", "attach", "screen", "prepare-undo", "bake-gpu"]);
  assert.equal(editor.texturePaintPendingStrokeUndoFinalizations.has(activeStroke), true);
});

test("pending GPU undo conversion includes async finalization strokes", () => {
  const editor = new PaintUndoEditor();
  const pendingStroke = { label: "Texture airbrush", before: [] };
  editor.texturePaintPendingStrokeUndoFinalizations = new Set([pendingStroke]);
  let preparedStroke = null;
  editor.prepareTexturePaintGpuUndoEntriesForCanvas = (stroke) => {
    preparedStroke = stroke;
    return true;
  };

  assert.equal(editor.prepareTexturePaintPendingGpuUndoEntriesForCanvas(), true);
  assert.equal(preparedStroke, pendingStroke);
});

test("layer mutation converts finalized background GPU paint undo to canvas", () => {
  const editor = new PaintUndoEditor();
  editor.undoStack = [];
  editor.redoStack = [];
  editor.maxUndoSteps = 40;
  editor.updateUndoButton = () => {};
  editor.updateClonePaintPreviews = () => {};
  editor.syncPatchJson = () => {};
  editor.renderTexturePaintLayerPanel = () => true;
  editor.flushTextureAirbrushScreenStroke = () => 0;
  editor.flushTextureAirbrushGpuTargetsToCanvases = () => 1;
  editor.textureAirbrushCanvasFromRenderTarget = ({ target }) => ({
    canvas: target,
    context: target.getContext("2d")
  });

  const displayCanvas = fakeCanvas();
  const baseCanvas = fakeCanvas();
  const beforeSnapshot = fakeCanvas();
  const afterSnapshot = fakeCanvas();
  const restoredBaseCanvas = fakeCanvas();
  const beforePixels = [0, 0, 0, 0, 0, 0, 0, 0];
  const afterPixels = [230, 80, 20, 255, 230, 80, 20, 255];
  beforeSnapshot.data.set(beforePixels);
  afterSnapshot.data.set(afterPixels);
  displayCanvas.data.set(afterPixels);
  baseCanvas.data.set(afterPixels);

  const material = {
    map: null,
    needsUpdate: false,
    userData: {
      clonePaintCanvas: displayCanvas,
      clonePaintContext: displayCanvas.getContext("2d"),
      clonePaintTexture: { needsUpdate: false },
      texturePaintLayerStack: {
        baseCanvas,
        baseContext: baseCanvas.getContext("2d"),
        width: baseCanvas.width,
        height: baseCanvas.height,
        activeLayerId: "",
        selectedLayerIds: [],
        selectionAnchorLayerId: "",
        layers: []
      }
    }
  };
  const entry = {
    type: "gpu",
    material,
    targetEntry: {
      width: 2,
      height: 1,
      target: { texture: {} }
    },
    before: beforeSnapshot,
    after: afterSnapshot
  };
  editor.undoStack.push({
    kind: "texture-paint",
    label: "Texture airbrush",
    entries: [entry]
  });

  assert.equal(editor.flushTexturePaintPendingBrushWorkBeforeLayerMutation(), true);
  assert.equal(entry.type, "canvas");
  assert.equal(entry.canvas, displayCanvas);
  assert.equal(entry.context, displayCanvas.getContext("2d"));
  assert.deepEqual([...entry.before.data], beforePixels);
  assert.deepEqual([...entry.after.data], afterPixels);
  assert.equal("targetEntry" in entry, false);

  material.userData.texturePaintLayerStack.baseCanvas = restoredBaseCanvas;
  material.userData.texturePaintLayerStack.baseContext = restoredBaseCanvas.getContext("2d");
  displayCanvas.data.set(afterPixels);
  restoredBaseCanvas.data.set(afterPixels);

  assert.equal(editor.restoreTexturePaintSnapshot([entry], "before"), true);
  assert.deepEqual([...displayCanvas.data], beforePixels);
  assert.deepEqual([...restoredBaseCanvas.data], beforePixels);
});

test("adding a layer reuses an empty airbrush-prewarmed layer", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    editor.model = {};
    editor.texturePaintLayersEnabled = true;
    editor.renderTexturePaintLayerPanel = () => true;
    editor.setStatus = () => {};
    editor.prepareTexturePaintLayerMutation = () => {
      throw new Error("reusing an empty warmed layer should not flush or mutate layer GPU state");
    };
    editor.discardTexturePaintMaterialAirbrushGpuTarget = () => {
      throw new Error("reusing an empty warmed layer should not discard the warmed target");
    };
    editor.discardTexturePaintMaterialGpuComposite = () => {
      throw new Error("reusing an empty warmed layer should not discard the warmed composite");
    };
    editor.texturePaintCompositeMaterialLayers = () => {
      throw new Error("reusing an empty warmed layer should not composite synchronously");
    };
    let targetChanges = 0;
    editor.prepareTexturePaintLayerTargetChange = () => {
      targetChanges += 1;
      return true;
    };
    let undoButtonUpdates = 0;
    editor.redoStack = [{ kind: "texture-paint" }];
    editor.updateUndoButton = () => {
      undoButtonUpdates += 1;
    };
    let prewarmCalls = 0;
    editor.prewarmTexturePaintActiveLayerGpu = (candidateMaterial, options) => {
      prewarmCalls += 1;
      assert.equal(candidateMaterial, material);
      assert.deepEqual(options, { all: false });
      return true;
    };
    const material = {
      needsUpdate: false,
      userData: {}
    };
    const composite = fakeCanvas();
    const texture = { needsUpdate: false };
    material.userData.clonePaintCanvas = composite;
    material.userData.clonePaintContext = composite.getContext("2d");
    material.userData.clonePaintTexture = texture;
    editor.texturePaintActiveMaterial = material;

    const active = editor.texturePaintActiveLayerForMaterial(material, {
      canvas: composite,
      context: composite.getContext("2d"),
      texture
    }, { create: true, renderPanel: false });
    active.layer.gpuTarget = {
      target: { texture: { uuid: "warmed-layer-texture" } },
      emptyTransparent: true,
      paintRevision: 0,
      liveCompositeTarget: { target: { texture: { uuid: "stale-live-texture" } } },
      liveCompositeBaseTexture: { uuid: "stale-base-texture" },
      liveCompositeLayer: active.layer,
      liveCompositeLayerCount: 1,
      liveCompositeLayerIndex: 0,
      liveCompositeLayerOpacity: 0,
      liveCompositeUnderlayKey: "stale-underlay",
      liveCompositeLayerMutationSerial: 1,
      liveShaderComposite: true
    };

    assert.equal(editor.addTexturePaintLayer(), true);
    const stack = material.userData.texturePaintLayerStack;
    assert.equal(stack.layers.length, 1);
    assert.equal(stack.layers[0], active.layer);
    assert.equal(stack.layers[0].name, "Paint 1");
    assert.equal(stack.layers[0].autoCreated, false);
    assert.equal(stack.activeLayerId, active.layer.id);
    assert.equal(targetChanges, 1);
    assert.deepEqual(editor.redoStack, []);
    assert.equal(undoButtonUpdates, 1);
    assert.equal(prewarmCalls, 1);
    assert.equal(active.layer.gpuTarget.forceDisplayCompositeOnce, true);
    assert.equal("liveCompositeTarget" in active.layer.gpuTarget, false);
    assert.equal("liveCompositeBaseTexture" in active.layer.gpuTarget, false);
    assert.equal("liveCompositeLayer" in active.layer.gpuTarget, false);
    assert.equal("liveCompositeLayerCount" in active.layer.gpuTarget, false);
    assert.equal("liveCompositeLayerIndex" in active.layer.gpuTarget, false);
    assert.equal("liveCompositeLayerOpacity" in active.layer.gpuTarget, false);
    assert.equal("liveCompositeUnderlayKey" in active.layer.gpuTarget, false);
    assert.equal("liveCompositeLayerMutationSerial" in active.layer.gpuTarget, false);
    assert.equal("liveShaderComposite" in active.layer.gpuTarget, false);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("texture paint base layer is labeled Background", () => {
  const editor = new TestEditor();

  assert.equal(editor.texturePaintBackgroundLayerName(), "Background");
});

test("empty GPU paint layer stacks serialize without a GPU readback", () => {
  const editor = new TestEditor();
  const baseCanvas = fakeCanvas();
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true,
    gpuTarget: {
      target: { texture: { uuid: "empty-layer-texture" } },
      emptyTransparent: true,
      paintRevision: 0
    }
  };
  const material = {
    name: "Paint material",
    userData: {
      texturePaintLayerStack: {
        width: baseCanvas.width,
        height: baseCanvas.height,
        baseCanvas,
        activeLayerId: layer.id,
        layers: [layer]
      }
    }
  };
  editor.paintRecords = [{ object: { name: "Mesh" } }];
  editor.texturePaintMaterialsForRecord = () => [material];
  let flushes = 0;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    flushes += 1;
    return 1;
  };

  assert.deepEqual(editor.serializeTexturePaintLayers(), []);
  assert.equal(flushes, 0);
});

test("texture paint layer stack can prepare a material without making it active", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    const editor = new TestEditor();
    const activeMaterial = { userData: {} };
    const warmMaterial = { userData: {} };
    const composite = fakeCanvas();
    const editable = {
      canvas: composite,
      context: composite.getContext("2d"),
      texture: {}
    };
    editor.texturePaintActiveMaterial = activeMaterial;

    const stack = editor.texturePaintLayerStackForMaterial(warmMaterial, editable, {
      create: true,
      setActiveMaterial: false
    });

    assert.equal(Boolean(stack), true);
    assert.equal(editor.texturePaintActiveMaterial, activeMaterial);
    assert.equal(editor.texturePaintLayerStackForMaterial(warmMaterial, editable, {
      create: true
    }), stack);
    assert.equal(editor.texturePaintActiveMaterial, warmMaterial);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("adding a texture paint layer prewarms the active TSL airbrush path without swapping display", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas(4, 4);
    }
  };
  try {
    const editor = new TestEditor();
    const composite = fakeCanvas(4, 4);
    const material = {
      map: { name: "Diffuse Texture" },
      needsUpdate: false,
      userData: {
        clonePaintCanvas: composite,
        clonePaintContext: composite.getContext("2d"),
        clonePaintTexture: { name: "Diffuse Texture" }
      }
    };
    const calls = [];
    editor.activeTool = "airbrush";
    editor.texturePaintLayersEnabled = true;
    editor.texturePaintActiveMaterial = material;
    editor.texturePaintFirstLayerMaterial = () => material;
    editor.flushTexturePaintPendingBrushWorkBeforeLayerMutation = () => true;
    editor.flushTextureAirbrushGpuTargetsToCanvases = () => 0;
    editor.prepareTexturePaintLayerMutation = () => true;
    editor.discardTexturePaintMaterialAirbrushGpuTarget = (candidateMaterial) => {
      calls.push(["discard", candidateMaterial]);
      return false;
    };
    editor.prewarmTexturePaintActiveLayerMaterialGpu = (candidateMaterial, options) => {
      calls.push(["material", candidateMaterial, options]);
      return true;
    };
    editor.prewarmTexturePaintActiveLayerProjectionGpu = (candidateMaterial) => {
      calls.push(["projection", candidateMaterial]);
      return true;
    };
    editor.prewarmTexturePaintActiveLayerCursorProbe = (candidateMaterial) => {
      calls.push(["cursor", candidateMaterial]);
      return true;
    };
    editor.textureAirbrushPrewarmWebGpuEditable = (editable, candidateMaterial, options) => {
      calls.push(["editable", editable, candidateMaterial, options]);
      return true;
    };
    editor.textureAirbrushPrewarm = (event, hit, options) => {
      calls.push(["airbrush", event, hit, options]);
      return true;
    };
    editor.scheduleTextureAirbrushPrewarm = () => {
      throw new Error("immediate new-layer TSL prewarm should not need a delayed retry");
    };
    editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => {
      calls.push(["broad"]);
      return true;
    };
    editor.renderTexturePaintLayerPanel = () => true;
    editor.setStatus = () => {};
    editor.pushTexturePaintLayerUndoState = () => {};
    editor.captureTexturePaintLayerHistorySnapshot = () => ({});

    assert.equal(editor.addTexturePaintLayer(), true);

    const materialWarm = calls.find((call) => call[0] === "material");
    const editableWarm = calls.find((call) => call[0] === "editable");
    const airbrushWarm = calls.find((call) => call[0] === "airbrush");
    assert.equal(materialWarm?.[1], material);
    assert.equal(materialWarm?.[2].preserveLayerDisplay, true);
    assert.equal(materialWarm?.[2].allowPrewarmLiveDisplayMaterialSwap, false);
    assert.equal(editableWarm?.[2], material);
    assert.equal(editableWarm?.[3].preserveLayerDisplay, true);
    assert.equal(editableWarm?.[3].liveDisplayExternalTexture, false);
    assert.equal(editableWarm?.[3].allowPrewarmLiveDisplayMaterialSwap, false);
    assert.equal(airbrushWarm?.[1], null);
    assert.equal(airbrushWarm?.[2], null);
    assert.equal(airbrushWarm?.[3].material, material);
    assert.equal(airbrushWarm?.[3].preserveLayerDisplay, true);
    assert.equal(airbrushWarm?.[3].liveDisplayExternalTexture, false);
    assert.equal(airbrushWarm?.[3].allowPrewarmLiveDisplayMaterialSwap, false);
    assert.equal(airbrushWarm?.[3].prewarmPaintablesWithoutHit, true);
    assert.equal(airbrushWarm?.[3].tslSurfacePrewarmAll, true);
    assert.equal(airbrushWarm?.[3].tslSurfacePrewarmLimit, 1);
    assert.equal(airbrushWarm?.[3].renderCompilePass, true);
    assert.equal(calls.some((call) => call[0] === "broad"), true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("layer panel shows Background instead of Paint 1 placeholder before painting", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return tag === "canvas" ? fakeCanvas() : fakeElement(tag);
    }
  };
  try {
    const editor = new TestEditor();
    editor.model = {};
    editor.texturePaintLayerList = fakeElement("div");
    editor.texturePaintFirstLayerMaterial = () => null;

    assert.equal(editor.renderTexturePaintLayerPanel(), true);
    assert.equal(editor.texturePaintLayerList.textContent.includes("Background"), true);
    assert.equal(editor.texturePaintLayerList.textContent.includes("Add a layer"), false);
    assert.equal(editor.texturePaintLayerList.children[0].className, "texture-layer-row is-locked");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("layer panel names are editable inputs and rename matching layers", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return tag === "canvas" ? fakeCanvas() : fakeElement(tag);
    }
  };
  try {
    const editor = new TestEditor();
    const material = { userData: {} };
    const mirrorMaterial = { userData: {} };
    const layer = { id: "paint-shared", name: "Paint 1", visible: true, opacity: 1, canvas: fakeCanvas() };
    const mirrorLayer = { id: "paint-shared", name: "Paint 1", visible: true, opacity: 1, canvas: fakeCanvas() };
    const stack = {
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      selectionAnchorLayerId: layer.id,
      baseCanvas: fakeCanvas(),
      layers: [layer]
    };
    const mirrorStack = {
      activeLayerId: mirrorLayer.id,
      selectedLayerIds: [mirrorLayer.id],
      selectionAnchorLayerId: mirrorLayer.id,
      baseCanvas: fakeCanvas(),
      layers: [mirrorLayer]
    };
    material.userData.texturePaintLayerStack = stack;
    mirrorMaterial.userData.texturePaintLayerStack = mirrorStack;
    editor.model = {};
    editor.texturePaintActiveMaterial = material;
    editor.texturePaintLayerList = fakeElement("div");
    editor.texturePaintFirstLayerMaterial = () => material;
    editor.texturePaintLayerEntriesForId = (layerId) => [
      { material, stack, layer },
      { material: mirrorMaterial, stack: mirrorStack, layer: mirrorLayer }
    ].filter((entry) => entry.layer.id === layerId);

    assert.equal(editor.renderTexturePaintLayerPanel(), true);
    const nameInput = editor.texturePaintLayerList.children[0].children[2];
    assert.equal(nameInput.tagName, "input");
    assert.equal(nameInput.dataset.layerRename, layer.id);
    assert.equal(nameInput.value, "Paint 1");

    assert.equal(editor.renameTexturePaintLayer(layer.id, "  Fur   cleanup  "), true);
    assert.equal(layer.name, "Fur cleanup");
    assert.equal(mirrorLayer.name, "Fur cleanup");
    assert.equal(editor.renameTexturePaintLayer(layer.id, "   "), false);
    assert.equal(layer.name, "Fur cleanup");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("layer panel hides an empty auto-created layer after undoing first background paint", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return tag === "canvas" ? fakeCanvas() : fakeElement(tag);
    }
  };
  try {
    const editor = new PaintUndoEditor();
    const baseCanvas = fakeCanvas();
    const compositeCanvas = fakeCanvas();
    const layerCanvas = fakeCanvas();
    const layer = {
      id: "paint-1",
      name: "Paint 1",
      visible: true,
      opacity: 1,
      blendMode: "normal",
      canvas: layerCanvas,
      context: layerCanvas.getContext("2d"),
      isEmpty: false,
      autoCreated: true,
      gpuTarget: { emptyTransparent: false, paintRevision: 1 }
    };
    const stack = {
      baseCanvas,
      baseContext: baseCanvas.getContext("2d"),
      width: baseCanvas.width,
      height: baseCanvas.height,
      activeLayerId: layer.id,
      selectedLayerIds: [layer.id],
      selectionAnchorLayerId: layer.id,
      layers: [layer]
    };
    const material = {
      needsUpdate: false,
      userData: {
        clonePaintCanvas: compositeCanvas,
        clonePaintContext: compositeCanvas.getContext("2d"),
        texturePaintLayerStack: stack
      }
    };
    const texture = { needsUpdate: false };
    editor.model = {};
    editor.texturePaintActiveMaterial = material;
    editor.texturePaintLayerList = fakeElement("div");
    editor.texturePaintLayerDuplicateButton = { disabled: false };
    editor.texturePaintLayerDeleteButton = { disabled: false };
    editor.texturePaintLayerBlendSelect = { disabled: false, value: "normal" };
    editor.texturePaintLayerOpacity = { disabled: false, value: "1" };
    editor.texturePaintLayerOpacityOutput = { textContent: "100%" };
    editor.texturePaintFirstLayerMaterial = () => material;

    const before = layer.context.getImageData(0, 0, layerCanvas.width, layerCanvas.height);
    layerCanvas.data[0] = 255;
    layerCanvas.data[1] = 255;
    layerCanvas.data[2] = 0;
    layerCanvas.data[3] = 255;
    const after = layer.context.getImageData(0, 0, layerCanvas.width, layerCanvas.height);

    assert.equal(editor.renderTexturePaintLayerPanel(), true);
    assert.equal(editor.texturePaintLayerList.textContent.includes("Paint 1"), true);

    assert.equal(editor.restoreTexturePaintSnapshot([{
      type: "canvas",
      canvas: layerCanvas,
      context: layer.context,
      texture,
      material,
      layer,
      before,
      after
    }], "before"), true);

    assert.equal(layer.isEmpty, true);
    assert.equal(layer.gpuTarget, undefined);
    assert.equal(editor.texturePaintLayerList.children.length, 1);
    assert.equal(editor.texturePaintLayerList.textContent.includes("Background"), true);
    assert.equal(editor.texturePaintLayerList.textContent.includes("Paint 1"), false);
    assert.equal(editor.texturePaintLayerDuplicateButton.disabled, true);
    assert.equal(editor.texturePaintLayerDeleteButton.disabled, true);
    assert.equal(editor.texturePaintLayerBlendSelect.disabled, true);
    assert.equal(editor.texturePaintLayerOpacity.disabled, true);

    assert.equal(editor.restoreTexturePaintSnapshot([{
      type: "canvas",
      canvas: layerCanvas,
      context: layer.context,
      texture,
      material,
      layer,
      before,
      after
    }], "after"), true);

    assert.equal(layer.isEmpty, false);
    assert.equal(layer.gpuTarget, undefined);
    assert.equal(editor.texturePaintLayerList.textContent.includes("Paint 1"), true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("layer mutations clear queued layer brush work", () => {
  const editor = new TestEditor();
  let clearedPreview = 0;
  let resolvedWaiters = 0;
  let flushedTargets = 0;
  let projectionFrameResets = 0;
  let cancelledBroadPrewarms = 0;
  let tslSurfaceDynamicResets = 0;
  editor.cancelTextureAirbrushDeferredBroadLayerPrewarm = () => {
    cancelledBroadPrewarms += 1;
    return true;
  };
  editor.clearTextureAirbrushScreenLayer = () => {
    clearedPreview += 1;
  };
  editor.resolveTextureAirbrushScreenStrokeFlushWaiters = () => {
    resolvedWaiters += 1;
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    flushedTargets += 1;
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    projectionFrameResets += 1;
  };
  editor.texturePaintTslSurfaceAirbrushInvalidate = () => {
    tslSurfaceDynamicResets += 1;
    return true;
  };
  editor.textureAirbrushScreenStrokeQueue = [
    { layerMode: true },
    { layerMode: false }
  ];
  editor.textureAirbrushPendingScreenStrokeBatches = [
    { layerMode: true },
    { layerMode: false }
  ];

  assert.equal(editor.prepareTexturePaintLayerMutation(), true);
  assert.equal(editor.texturePaintLayerMutationSerial, 1);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue, [{ layerMode: false }]);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches, [{ layerMode: false }]);
  assert.equal(clearedPreview, 0);
  assert.equal(resolvedWaiters, 0);
  assert.equal(flushedTargets, 1);
  assert.equal(projectionFrameResets, 1);
  assert.equal(cancelledBroadPrewarms, 1);
  assert.equal(tslSurfaceDynamicResets, 1);

  editor.textureAirbrushScreenStrokeQueue = [{ layerMode: true }];
  editor.textureAirbrushPendingScreenStrokeBatches = [{ layerMode: true }];
  assert.equal(editor.prepareTexturePaintLayerMutation({ flushGpuTargets: false }), true);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue, []);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches, []);
  assert.equal(clearedPreview, 1);
  assert.equal(resolvedWaiters, 1);
  assert.equal(flushedTargets, 1);
  assert.equal(projectionFrameResets, 2);
  assert.equal(cancelledBroadPrewarms, 2);
  assert.equal(tslSurfaceDynamicResets, 2);
});

test("changing the active texture paint layer resets dynamic TSL stroke state", () => {
  const editor = new TestEditor();
  const stack = {
    activeLayerId: "paint-1",
    selectedLayerIds: ["paint-1"],
    selectionAnchorLayerId: "paint-1",
    layers: [
      { id: "paint-1" },
      { id: "paint-2" }
    ]
  };
  let resets = 0;
  editor.texturePaintTslSurfaceAirbrushInvalidate = () => {
    resets += 1;
    return true;
  };

  assert.equal(editor.texturePaintSetSingleLayerSelection(stack, "paint-1"), true);
  assert.equal(resets, 0);
  assert.equal(editor.texturePaintSetSingleLayerSelection(stack, "paint-2"), true);
  assert.equal(resets, 1);
  assert.deepEqual(stack.selectedLayerIds, ["paint-2"]);
  assert.equal(stack.selectionAnchorLayerId, "paint-2");
});

test("display-only layer mutations keep pending brush work and the live projection frame warm", () => {
  const editor = new TestEditor();
  editor.texturePaintLayerMutationSerial = 7;
  let flushedTargets = 0;
  let projectionFrameResets = 0;
  let cancelledBroadPrewarms = 0;
  editor.cancelTextureAirbrushDeferredBroadLayerPrewarm = () => {
    cancelledBroadPrewarms += 1;
    return true;
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    flushedTargets += 1;
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    projectionFrameResets += 1;
  };
  editor.textureAirbrushScreenStrokeQueue = [{ layerMode: true }];
  editor.textureAirbrushPendingScreenStrokeBatches = [{ layerMode: true }];

  assert.equal(editor.prepareTexturePaintLayerDisplayMutation(), true);
  assert.equal(editor.texturePaintLayerMutationSerial, 7);
  assert.equal(editor.texturePaintLayerDisplaySerial, 1);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue, [{ layerMode: true }]);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches, [{ layerMode: true }]);
  assert.equal(flushedTargets, 0);
  assert.equal(projectionFrameResets, 0);
  assert.equal(cancelledBroadPrewarms, 1);
});

test("layer visibility hide is live and show composites when the live shader is not compiled", () => {
  const editor = new TestEditor();
  const baseTexture = { name: "base-layer-texture" };
  const materialComposite = fakeCanvas();
  const material = { map: { name: "previous-display" }, userData: {} };
  const baseCanvas = fakeCanvas();
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true,
    texturePaintGpuPainted: true,
    gpuTarget: {
      target: { texture: { uuid: "layer-gpu-texture" } },
      layer: null,
      emptyTransparent: true,
      texturePaintLayerHasPaint: true,
      paintRevision: 2
    }
  };
  layer.gpuTarget.layer = layer;
  material.userData.texturePaintLayerStack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  material.userData.clonePaintCanvas = materialComposite;
  material.userData.clonePaintContext = materialComposite.getContext("2d");
  material.userData.clonePaintTexture = { needsUpdate: false };
  editor.renderer = {};
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerMutationSerial = 3;
  const liveCompositeVisibility = [];
  const prewarmCalls = [];
  let broadPrewarmCalls = 0;
  let baseTextureLookups = 0;
  let mutedLiveComposite = 0;
  let disabledLiveComposite = 0;
  let flushedTargets = 0;
  let exactComposites = 0;
  let renderCalls = 0;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("visibility toggles should not read GPU layer targets back to canvases");
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    throw new Error("visibility toggles should not reset the prewarmed projection frame");
  };
  editor.prewarmTexturePaintActiveLayerGpu = () => {
    throw new Error("visibility toggles should not run immediate broad layer prewarm");
  };
  editor.textureAirbrushCanvasTextureForLayerCanvas = (owner, key, canvas) => {
    assert.equal(owner, material.userData.texturePaintLayerStack);
    assert.equal(key, "base");
    assert.equal(canvas, baseCanvas);
    baseTextureLookups += 1;
    return baseTexture;
  };
  editor.texturePaintDisableLiveLayerShaderComposite = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    disabledLiveComposite += 1;
    return true;
  };
  editor.texturePaintMuteLiveLayerShaderComposite = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    mutedLiveComposite += 1;
    return true;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, layer.gpuTarget);
    liveCompositeVisibility.push(layer.visible);
    return { target: targetEntry.target, shaderComposite: true };
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    exactComposites += 1;
    return true;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };
  editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => {
    broadPrewarmCalls += 1;
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => {
    renderCalls += 1;
    return true;
  };

  assert.equal(editor.toggleTexturePaintLayerVisibility(layer.id), true);
  assert.equal(layer.visible, false);
  assert.equal(material.map, baseTexture);
  assert.equal(flushedTargets, 0);
  assert.equal(editor.toggleTexturePaintLayerVisibility(layer.id), true);
  assert.equal(layer.visible, true);
  assert.deepEqual(liveCompositeVisibility, [true]);
  assert.equal(exactComposites, 0);
  assert.equal(flushedTargets, 0);
  assert.equal(baseTextureLookups, 1);
  assert.equal(mutedLiveComposite, 1);
  assert.equal(disabledLiveComposite, 0);
  assert.equal(editor.texturePaintLayerMutationSerial, 3);
  assert.equal(editor.texturePaintLayerDisplaySerial, 2);
  assert.deepEqual(prewarmCalls, []);
  assert.equal(broadPrewarmCalls, 0);
  assert.equal(renderCalls, 2);
});

test("hiding the top layer uses the next visible GPU layer without full composite", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const baseCanvas = fakeCanvas();
  const lowerCanvas = fakeCanvas();
  const upperCanvas = fakeCanvas();
  const lowerLayer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: lowerCanvas,
    context: lowerCanvas.getContext("2d"),
    isEmpty: false,
    gpuTarget: {
      target: { texture: { uuid: "lower-gpu-texture" } },
      layer: null,
      emptyTransparent: false,
      paintRevision: 2
    }
  };
  const upperLayer = {
    id: "paint-2",
    name: "Paint 2",
    visible: true,
    opacity: 1,
    canvas: upperCanvas,
    context: upperCanvas.getContext("2d"),
    isEmpty: false,
    gpuTarget: {
      target: { texture: { uuid: "upper-gpu-texture" } },
      layer: null,
      emptyTransparent: false,
      paintRevision: 1
    }
  };
  lowerLayer.gpuTarget.layer = lowerLayer;
  upperLayer.gpuTarget.layer = upperLayer;
  material.userData.texturePaintLayerStack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: upperLayer.id,
    selectedLayerIds: [upperLayer.id],
    selectionAnchorLayerId: upperLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  material.userData.clonePaintCanvas = fakeCanvas();
  material.userData.clonePaintContext = material.userData.clonePaintCanvas.getContext("2d");
  material.userData.clonePaintTexture = { needsUpdate: false };
  editor.renderer = {};
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintActiveMaterial = material;
  const liveTargets = [];
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("hiding a top layer should not read GPU layers back to canvases");
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("hiding a top layer should use the next visible live target");
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    liveTargets.push(targetEntry);
    return { target: targetEntry.target, shaderComposite: true };
  };
  editor.scheduleTextureAirbrushPrewarm = () => true;
  editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => true;
  editor.renderTexturePaintLayerPanel = () => true;

  assert.equal(editor.toggleTexturePaintLayerVisibility(upperLayer.id), true);
  assert.equal(upperLayer.visible, false);
  assert.deepEqual(liveTargets, [lowerLayer.gpuTarget]);
});

test("layer opacity changes use display composite and debounce panel rendering", () => {
  const editor = new TestEditor();
  const materialComposite = fakeCanvas();
  const material = { userData: {} };
  const baseCanvas = fakeCanvas();
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    gpuTarget: {
      target: { texture: { uuid: "layer-gpu-texture" } },
      layer: null
    }
  };
  layer.gpuTarget.layer = layer;
  material.userData.texturePaintLayerStack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  material.userData.clonePaintCanvas = materialComposite;
  material.userData.clonePaintContext = materialComposite.getContext("2d");
  material.userData.clonePaintTexture = { needsUpdate: false };
  editor.renderer = {};
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerOpacity = { value: "1" };
  editor.texturePaintLayerOpacityOutput = { textContent: "100%" };
  editor.texturePaintLayerMutationSerial = 5;
  const liveCompositeOpacities = [];
  const scheduledPanelRenders = [];
  const prewarmCalls = [];
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("opacity changes should not read GPU layer targets back to canvases");
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    throw new Error("opacity changes should not reset the prewarmed projection frame");
  };
  editor.prewarmTexturePaintActiveLayerGpu = () => {
    throw new Error("opacity changes should not run immediate broad layer prewarm");
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, layer.gpuTarget);
    liveCompositeOpacities.push(targetEntry.layer.opacity);
    return { target: targetEntry.target, shaderComposite: true };
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("active layer opacity should update through the live shader composite when available");
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };
  editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => true;
  editor.scheduleTexturePaintLayerPanelRender = (delayMs) => {
    scheduledPanelRenders.push(delayMs);
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => {
    throw new Error("opacity input should not rebuild the panel synchronously when scheduling is available");
  };

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0.42), true);
  assert.equal(layer.opacity, 0.42);
  assert.deepEqual(liveCompositeOpacities, [0.42]);
  assert.deepEqual(scheduledPanelRenders, [80]);
  assert.equal(editor.texturePaintLayerOpacity.value, "0.42");
  assert.equal(editor.texturePaintLayerOpacityOutput.textContent, "42%");
  assert.equal(editor.texturePaintLayerMutationSerial, 5);
  assert.equal(editor.texturePaintLayerDisplaySerial, 1);
  assert.deepEqual(prewarmCalls, []);

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0.42001), false);
  assert.deepEqual(liveCompositeOpacities, [0.42]);
  assert.deepEqual(scheduledPanelRenders, [80]);
});

test("raising layer opacity from zero reuses the live GPU layer target", () => {
  const editor = new TestEditor();
  const materialComposite = fakeCanvas();
  const material = { userData: {} };
  const baseCanvas = fakeCanvas();
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 0,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true,
    texturePaintGpuPainted: true,
    gpuTarget: {
      target: { texture: { uuid: "opacity-restore-layer" } },
      layer: null,
      emptyTransparent: true,
      texturePaintLayerHasPaint: true,
      paintRevision: 3
    }
  };
  layer.gpuTarget.layer = layer;
  material.userData.texturePaintLayerStack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  material.userData.clonePaintCanvas = materialComposite;
  material.userData.clonePaintContext = materialComposite.getContext("2d");
  material.userData.clonePaintTexture = { needsUpdate: false };
  editor.renderer = {};
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerOpacity = { value: "0" };
  editor.texturePaintLayerOpacityOutput = { textContent: "0%" };
  const liveCompositeOpacities = [];
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("zero-to-visible opacity restore should not read GPU layer targets back to canvases");
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, layer.gpuTarget);
    liveCompositeOpacities.push(targetEntry.layer.opacity);
    return { target: targetEntry.target, shaderComposite: true };
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("zero-to-visible opacity restore should not run a full GPU layer composite");
  };
  editor.scheduleTextureAirbrushPrewarm = () => true;
  editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => true;
  editor.scheduleTexturePaintLayerPanelRender = () => true;

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0.5), true);
  assert.equal(layer.opacity, 0.5);
  assert.deepEqual(liveCompositeOpacities, [0.5]);
  assert.equal(editor.texturePaintLayerOpacity.value, "0.5");
  assert.equal(editor.texturePaintLayerOpacityOutput.textContent, "50%");
});

test("opacity display treats GPU-painted empty canvases as live painted layers", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const baseCanvas = fakeCanvas();
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true,
    texturePaintGpuPainted: true,
    gpuTarget: {
      target: { texture: { uuid: "painted-gpu-layer" } },
      emptyTransparent: true,
      texturePaintLayerHasPaint: true,
      paintRevision: 4
    }
  };
  const stack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  material.userData.texturePaintLayerStack = stack;
  material.userData.clonePaintCanvas = fakeCanvas();
  material.userData.clonePaintContext = material.userData.clonePaintCanvas.getContext("2d");
  editor.renderer = {};
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintActiveMaterial = material;
  const liveTargets = [];
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("opacity display should not read a painted GPU layer back to the CPU canvas");
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("opacity display should not full-composite a reusable live layer");
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, layer.gpuTarget);
    assert.equal(targetEntry.layerMode, true);
    assert.equal(targetEntry.layer, layer);
    assert.equal(targetEntry.layerStack, stack);
    assert.equal(targetEntry.emptyTransparent, false);
    liveTargets.push(targetEntry);
    return { target: targetEntry.target, shaderComposite: true };
  };
  editor.scheduleTexturePaintLayerPanelRender = () => true;

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0.5), true);
  assert.equal(layer.opacity, 0.5);
  assert.deepEqual(liveTargets, [layer.gpuTarget]);
});

test("turning a GPU-painted layer back on composites when live shader is not compiled", () => {
  const editor = new TestEditor();
  const baseTexture = { name: "base-layer-texture" };
  const material = { map: { name: "previous-display" }, userData: {} };
  const baseCanvas = fakeCanvas();
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: false,
    opacity: 1,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true,
    texturePaintGpuPainted: true,
    gpuTarget: {
      target: { texture: { uuid: "restore-gpu-layer" } },
      emptyTransparent: true,
      texturePaintLayerHasPaint: true,
      paintRevision: 3
    }
  };
  const stack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  material.userData.texturePaintLayerStack = stack;
  material.userData.clonePaintCanvas = fakeCanvas();
  material.userData.clonePaintContext = material.userData.clonePaintCanvas.getContext("2d");
  editor.renderer = {};
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintActiveMaterial = material;
  const liveTargets = [];
  editor.textureAirbrushCanvasTextureForLayerCanvas = () => baseTexture;
  editor.texturePaintMuteLiveLayerShaderComposite = () => true;
  let exactComposites = 0;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("visibility restore should not read a painted GPU layer back to the CPU canvas");
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    exactComposites += 1;
    return true;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry.layerMode, true);
    assert.equal(targetEntry.layer, layer);
    assert.equal(targetEntry.layerStack, stack);
    assert.equal(targetEntry.emptyTransparent, false);
    liveTargets.push(targetEntry);
    return { target: targetEntry.target, shaderComposite: true };
  };
  let displayPrewarms = 0;
  editor.scheduleTexturePaintLayerDisplayPrewarm = () => {
    displayPrewarms += 1;
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => true;

  assert.equal(editor.toggleTexturePaintLayerVisibility(layer.id), true);
  assert.equal(layer.visible, true);
  assert.deepEqual(liveTargets, [layer.gpuTarget]);
  assert.equal(exactComposites, 0);
  assert.equal(displayPrewarms, 0);
});
