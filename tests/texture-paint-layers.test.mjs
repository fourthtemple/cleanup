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
    getImageData() {
      return {
        width: canvas.width,
        height: canvas.height,
        data: new Uint8ClampedArray(canvas.data)
      };
    },
    putImageData(image) {
      canvas.data.set(image.data);
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
      return `${this._textContent}${this.children.map((child) => child.textContent || "").join("")}`;
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

test("adding the first texture paint layer creates only one layer", () => {
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
    assert.equal(fastDisplayCalls, 1);
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
    assert.equal(fastDisplayCalls, 1);
    assert.equal(prewarmCalls.length, 3);
    assert.deepEqual(prewarmCalls.map((call) => call.options), [
      { preserveLayerDisplay: true },
      {},
      {}
    ]);
  } finally {
    globalThis.document = previousDocument;
  }
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
    assert.equal(layer.gpuTarget.emptyTransparent, true);
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
    assert.equal(layer.gpuTarget.emptyTransparent, false);
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
    gpuTarget: {
      target: { texture: { uuid: "layer-gpu-texture" } },
      layer: null,
      emptyTransparent: true,
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
    gpuTarget: {
      target: { texture: { uuid: "opacity-restore-layer" } },
      layer: null,
      emptyTransparent: true,
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
    gpuTarget: {
      target: { texture: { uuid: "painted-gpu-layer" } },
      emptyTransparent: true,
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
    gpuTarget: {
      target: { texture: { uuid: "restore-gpu-layer" } },
      emptyTransparent: true,
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
