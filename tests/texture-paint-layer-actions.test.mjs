import assert from "node:assert/strict";
import test from "node:test";
import { installTexturePaintLayerMethods } from "../src/weight-editor/texture-layers.js";

class TestEditor {}

installTexturePaintLayerMethods(TestEditor);

function fakeCanvas(width = 2, height = 1) {
  const canvas = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    className: "",
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

function withFakeDocument(callback) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return fakeCanvas();
    }
  };
  try {
    callback();
  } finally {
    globalThis.document = previousDocument;
  }
}

test("deleting a GPU-composited paint layer removes its visible paint", () => withFakeDocument(() => {
  const editor = new TestEditor();
  editor.model = {};
  editor.texturePaintLayersEnabled = true;
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setStatus = () => {};
  const material = {
    map: null,
    needsUpdate: false,
    userData: {}
  };
  const composite = fakeCanvas();
  composite.data.set([10, 20, 30, 255, 10, 20, 30, 255]);
  const cloneTexture = { needsUpdate: false };
  material.map = cloneTexture;
  material.userData.clonePaintCanvas = composite;
  material.userData.clonePaintContext = composite.getContext("2d");
  material.userData.clonePaintTexture = cloneTexture;
  editor.texturePaintActiveMaterial = material;

  assert.equal(editor.addTexturePaintLayer(), true);
  const stack = material.userData.texturePaintLayerStack;
  const layer = stack.layers[0];
  layer.canvas.data.set([220, 20, 10, 255, 0, 0, 0, 0]);
  let layerTargetDisposed = false;
  let layerTextureDisposed = false;
  let compositeDisposed = false;
  const compositeTexture = {};
  layer.gpuTarget = {
    target: {
      texture: {},
      dispose() {
        layerTargetDisposed = true;
      }
    }
  };
  layer.gpuLayerTexture = {
    dispose() {
      layerTextureDisposed = true;
    }
  };
  material.userData.texturePaintCompositeGpuTarget = {
    target: {
      texture: compositeTexture,
      dispose() {
        compositeDisposed = true;
      }
    }
  };
  material.map = compositeTexture;

  assert.equal(editor.deleteActiveTexturePaintLayer(), true);
  assert.equal(stack.layers.length, 0);
  assert.equal(material.map, cloneTexture);
  assert.equal(layerTargetDisposed, true);
  assert.equal(layerTextureDisposed, true);
  assert.equal(compositeDisposed, true);
  assert.deepEqual([...composite.data], [
    10, 20, 30, 255,
    10, 20, 30, 255
  ]);
}));

test("adding a layer restores clone texture instead of stale airbrush target", () => withFakeDocument(() => {
  const editor = new TestEditor();
  editor.model = {};
  editor.texturePaintLayersEnabled = true;
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setStatus = () => {};
  const material = {
    map: null,
    needsUpdate: false,
    userData: {}
  };
  const composite = fakeCanvas();
  composite.data.set([10, 20, 30, 255, 10, 20, 30, 255]);
  const cloneTexture = { needsUpdate: false };
  const staleTexture = {};
  let staleTargetDisposed = false;
  material.map = staleTexture;
  material.userData.clonePaintCanvas = composite;
  material.userData.clonePaintContext = composite.getContext("2d");
  material.userData.clonePaintTexture = cloneTexture;
  material.userData.textureAirbrushGpuTarget = {
    target: {
      texture: staleTexture,
      dispose() {
        staleTargetDisposed = true;
      }
    }
  };
  const stack = editor.texturePaintLayerStackForMaterial(material, {
    canvas: composite,
    context: composite.getContext("2d"),
    texture: cloneTexture
  }, { create: true });
  editor.texturePaintActiveMaterial = material;

  assert.equal(editor.addTexturePaintLayer(), true);
  assert.equal(material.map, cloneTexture);
  assert.equal(staleTargetDisposed, true);
  assert.equal(material.userData.textureAirbrushGpuTarget, undefined);
  assert.deepEqual([...composite.data], [
    10, 20, 30, 255,
    10, 20, 30, 255
  ]);
  assert.equal(stack.layers.length, 1);
  assert.deepEqual([...stack.layers[0].canvas.data], [
    0, 0, 0, 0,
    0, 0, 0, 0
  ]);
}));

test("restored empty layer stacks reuse Paint 1 instead of creating Paint 2", () => withFakeDocument(() => {
  const editor = new TestEditor();
  editor.model = {};
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintLayerList = {
    textContent: "",
    replaceChildren(...nodes) {
      this.children = nodes;
      this.textContent = nodes.map((node) => node.textContent || "").join("");
    }
  };
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setStatus = () => {};
  let targetChanges = 0;
  editor.prepareTexturePaintLayerTargetChange = () => {
    targetChanges += 1;
    return true;
  };
  let mutations = 0;
  editor.prepareTexturePaintLayerMutation = () => {
    mutations += 1;
    return true;
  };
  const material = {
    needsUpdate: false,
    userData: {}
  };
  const composite = fakeCanvas();
  const editable = {
    canvas: composite,
    context: composite.getContext("2d"),
    texture: { needsUpdate: false }
  };
  material.userData.clonePaintCanvas = composite;
  material.userData.clonePaintContext = editable.context;
  material.userData.clonePaintTexture = editable.texture;

  assert.equal(editor.texturePaintApplyLayerStackImages(material, editable, {
    activeLayerId: "",
    layers: []
  }, {}), true);

  const stack = material.userData.texturePaintLayerStack;
  assert.equal(stack.layers.length, 1);
  assert.equal(stack.layers[0].name, "Paint 1");
  assert.equal(stack.layers[0].autoCreated, true);

  editor.texturePaintActiveMaterial = material;
  assert.equal(editor.addTexturePaintLayer(), true);
  assert.equal(stack.layers.length, 1);
  assert.equal(stack.layers[0].name, "Paint 1");
  assert.equal(stack.layers[0].autoCreated, false);
  assert.equal(stack.layers.some((layer) => layer.name === "Paint 2"), false);
  assert.equal(targetChanges, 1);
  assert.equal(mutations, 0);
}));

test("texture paint layers duplicate and move the active layer", () => withFakeDocument(() => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setStatus = () => {};
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
  const firstEditable = editor.texturePaintEditableLayerTarget(material, editable);
  firstEditable.layer.canvas.data.set([1, 2, 3, 128, 0, 0, 0, 0]);

  assert.equal(editor.duplicateActiveTexturePaintLayer(), true);
  const stack = material.userData.texturePaintLayerStack;
  assert.equal(stack.layers.length, 2);
  assert.equal(stack.layers[1].id, stack.activeLayerId);
  assert.deepEqual([...stack.layers[1].canvas.data.slice(0, 4)], [1, 2, 3, 128]);

  assert.equal(editor.moveActiveTexturePaintLayer(-1), true);
  assert.equal(stack.layers[0].id, stack.activeLayerId);
  assert.equal(editor.moveActiveTexturePaintLayer(1), true);
  assert.equal(stack.layers[1].id, stack.activeLayerId);
}));

test("layer actions schedule selection prewarm and keep mutation prewarm focused", () => withFakeDocument(() => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setStatus = () => {};
  const activePrewarmCalls = [];
  editor.texturePaintLayerModeActive = () => true;
  editor.prewarmTexturePaintActiveLayerMaterialGpu = (candidateMaterial) => {
    activePrewarmCalls.push(["material", candidateMaterial]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerProjectionGpu = (candidateMaterial) => {
    activePrewarmCalls.push(["projection", candidateMaterial]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerCursorProbe = (candidateMaterial) => {
    activePrewarmCalls.push(["cursor", candidateMaterial]);
    return false;
  };
  editor.prewarmTexturePaintActiveLayerGpu = () => {
    throw new Error("layer actions should not synchronously run broad active-layer GPU prewarm");
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    throw new Error("selecting a layer should not schedule heavy prewarm");
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
  const stack = editor.texturePaintLayerStackForMaterial(material, {
    canvas: composite,
    context: composite.getContext("2d"),
    texture
  }, { create: true });
  const firstLayer = editor.texturePaintNewLayer(stack, { name: "Paint 1", isEmpty: false });
  const secondLayer = editor.texturePaintNewLayer(stack, { name: "Paint 2", isEmpty: false });
  stack.layers.push(firstLayer, secondLayer);
  editor.texturePaintSetSingleLayerSelection(stack, firstLayer.id);

  assert.equal(editor.selectTexturePaintLayer(secondLayer.id), true);
  assert.equal(editor.moveActiveTexturePaintLayer(-1), true);
  assert.equal(editor.toggleTexturePaintLayerVisibility(secondLayer.id), true);
  assert.equal(editor.setTexturePaintLayerOpacity(secondLayer.id, 0.5), true);
  assert.equal(editor.deleteActiveTexturePaintLayer(), true);

  assert.deepEqual(activePrewarmCalls, [
    ["material", material],
    ["projection", material],
    ["cursor", material],
    ["material", material],
    ["projection", material],
    ["cursor", material],
    ["material", material],
    ["projection", material],
    ["cursor", material]
  ]);
}));

test("texture paint layers multi-select and merge selected layers", () => withFakeDocument(() => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setStatus = () => {};
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
  const firstEditable = editor.texturePaintEditableLayerTarget(material, editable);
  firstEditable.layer.canvas.data.set([220, 20, 10, 255, 0, 0, 0, 0]);
  firstEditable.layer.isEmpty = false;
  assert.equal(editor.addTexturePaintLayer(), true);
  const stack = material.userData.texturePaintLayerStack;
  const [firstLayer, secondLayer] = stack.layers;
  secondLayer.canvas.data.set([0, 0, 0, 0, 20, 220, 30, 255]);

  assert.equal(editor.selectTexturePaintLayer(firstLayer.id), true);
  assert.equal(editor.selectTexturePaintLayer(secondLayer.id, { range: true }), true);
  assert.deepEqual(stack.selectedLayerIds, [firstLayer.id, secondLayer.id]);

  assert.equal(editor.mergeSelectedTexturePaintLayers(), true);
  assert.equal(stack.layers.length, 1);
  assert.equal(stack.layers[0].id, stack.activeLayerId);
  assert.deepEqual([...stack.selectedLayerIds], [stack.layers[0].id]);
  assert.deepEqual([...stack.layers[0].canvas.data], [
    220, 20, 10, 255,
    20, 220, 30, 255
  ]);
  assert.equal(texture.needsUpdate, true);
  assert.equal(material.needsUpdate, true);
}));

test("layer opacity and effects update matching layers across material stacks", () => withFakeDocument(() => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintLayerOpacity = { value: "1" };
  editor.texturePaintLayerOpacityOutput = { textContent: "100%" };
  editor.texturePaintLayerBlendSelect = { value: "normal" };
  editor.scheduleTexturePaintLayerPanelRender = () => true;
  editor.renderTexturePaintLayerPanel = () => {
    throw new Error("layer property updates should schedule the panel render");
  };

  const createMaterial = () => {
    const material = { userData: {} };
    const canvas = fakeCanvas();
    material.userData.clonePaintCanvas = canvas;
    material.userData.clonePaintContext = canvas.getContext("2d");
    material.userData.clonePaintTexture = { needsUpdate: false };
    const stack = editor.texturePaintLayerStackForMaterial(material, {
      canvas,
      context: canvas.getContext("2d"),
      texture: material.userData.clonePaintTexture
    }, {
      create: true,
      setActiveMaterial: false
    });
    const sharedLayer = editor.texturePaintNewLayer(stack, {
      id: "paint-shared",
      name: "Paint 1",
      isEmpty: false
    });
    stack.layers.push(sharedLayer);
    editor.texturePaintSetSingleLayerSelection(stack, sharedLayer.id);
    return { material, stack, layer: sharedLayer };
  };

  const first = createMaterial();
  const second = createMaterial();
  editor.texturePaintActiveMaterial = first.material;
  editor.textureAirbrushPaintableMaterials = () => [
    { material: first.material },
    { material: second.material }
  ];

  const displayChanges = [];
  const exactComposites = [];
  editor.texturePaintApplyLayerDisplayChange = (material, options) => {
    displayChanges.push({ material, layer: options.changedLayer });
    return true;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = (material, options) => {
    exactComposites.push({ material, layer: options.changedLayer, live: options.live });
    return true;
  };
  editor.scheduleTexturePaintLayerDisplayPrewarm = () => true;

  assert.equal(editor.setTexturePaintLayerOpacity("paint-shared", 0.35), true);
  assert.equal(first.layer.opacity, 0.35);
  assert.equal(second.layer.opacity, 0.35);
  assert.equal(editor.texturePaintLayerOpacityOutput.textContent, "35%");
  assert.deepEqual(displayChanges, [
    { material: first.material, layer: first.layer },
    { material: second.material, layer: second.layer }
  ]);

  assert.equal(editor.setTexturePaintLayerBlendMode("paint-shared", "multiply"), true);
  assert.equal(first.layer.blendMode, "multiply");
  assert.equal(second.layer.blendMode, "multiply");
  assert.deepEqual(exactComposites, [
    { material: first.material, layer: first.layer, live: false },
    { material: second.material, layer: second.layer, live: false }
  ]);
}));
