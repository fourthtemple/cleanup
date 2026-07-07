import assert from "node:assert/strict";
import test from "node:test";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";
import { installTexturePaintLayerMethods } from "../src/weight-editor/texture-layers.js";

class TestEditor {}

installTexturePaintLayerMethods(TestEditor);

function fakeCanvas(width = 2, height = 1) {
  const canvas = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    getContext() {
      return context;
    },
    setAttribute() {}
  };
  const context = {
    globalAlpha: 1,
    clearRect() {
      canvas.data.fill(0);
    },
    drawImage(source) {
      if (source?.data) {
        canvas.data.set(source.data.subarray(0, canvas.data.length));
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

test("airbrush target creates a paint layer instead of painting the background", () => {
  const editor = new TestEditor();
  const canvas = fakeCanvas();
  const texture = { needsUpdate: false };
  const material = { userData: {} };
  editor.texturePaintLayersEnabled = true;
  editor.activeTool = "airbrush";
  editor.createTexturePaintCanvas = fakeCanvas;

  const editable = {
    canvas,
    context: canvas.getContext("2d"),
    texture
  };
  const stack = editor.texturePaintLayerStackForMaterial(material, editable, { create: true });

  assert.equal(stack.layers.length, 0);
  assert.equal(stack.activeLayerId, "");
  assert.equal(editor.texturePaintHasActivePaintLayer(material), false);

  const target = editor.texturePaintEditableLayerTarget(material, editable);
  assert.notEqual(target, editable);
  assert.equal(target.layerMode, true);
  assert.equal(target.layerStack, stack);
  assert.equal(target.layer.name, "Paint 1");
  assert.equal(target.canvas, target.layer.canvas);
  assert.equal(target.compositeCanvas, canvas);
  assert.equal(target.texture, texture);
  assert.equal(stack.layers.length, 1);
  assert.equal(stack.activeLayerId, target.layer.id);
  assert.equal(editor.texturePaintActiveLayerSelectionTemplate?.id, target.layer.id);
  assert.equal(editor.texturePaintBackgroundSelectionActive, false);
});

test("active paint layer is mirrored onto newly hit material stacks", () => {
  const editor = new TestEditor();
  const activeCanvas = fakeCanvas();
  const hitCanvas = fakeCanvas();
  const activeMaterial = { userData: {} };
  const hitMaterial = { userData: {} };
  editor.texturePaintLayersEnabled = true;
  editor.activeTool = "airbrush";
  editor.createTexturePaintCanvas = fakeCanvas;

  const activeEditable = {
    canvas: activeCanvas,
    context: activeCanvas.getContext("2d"),
    texture: { needsUpdate: false }
  };
  const activeStack = editor.texturePaintLayerStackForMaterial(activeMaterial, activeEditable, { create: true });
  const activeLayer = editor.texturePaintNewLayer(activeStack, { name: "Paint 1" });
  activeStack.layers.push(activeLayer);
  editor.texturePaintSetSingleLayerSelection(activeStack, activeLayer.id);
  editor.texturePaintActiveMaterial = activeMaterial;

  const hitEditable = {
    canvas: hitCanvas,
    context: hitCanvas.getContext("2d"),
    texture: { needsUpdate: false }
  };
  const target = editor.texturePaintEditableLayerTarget(hitMaterial, hitEditable);
  const hitStack = hitMaterial.userData.texturePaintLayerStack;

  assert.equal(target.layerMode, true);
  assert.notEqual(target.canvas, hitCanvas);
  assert.equal(target.layer.name, "Paint 1");
  assert.equal(target.layer.id, activeLayer.id);
  assert.equal(hitStack.layers.length, 1);
  assert.equal(hitStack.activeLayerId, activeLayer.id);
});

test("selected third paint layer overrides stale active layers on hit materials", () => {
  const editor = new TestEditor();
  const activeMaterial = { userData: {} };
  const hitMaterial = { userData: {} };
  editor.texturePaintLayersEnabled = true;
  editor.activeTool = "airbrush";
  editor.createTexturePaintCanvas = fakeCanvas;

  const activeEditable = {
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    texture: { needsUpdate: false }
  };
  const activeStack = editor.texturePaintLayerStackForMaterial(activeMaterial, activeEditable, { create: true });
  const paint1 = editor.texturePaintNewLayer(activeStack, { id: "paint-1", name: "Paint 1" });
  const paint2 = editor.texturePaintNewLayer(activeStack, { id: "paint-2", name: "Paint 2" });
  const paint3 = editor.texturePaintNewLayer(activeStack, { id: "paint-3", name: "Paint 3" });
  activeStack.layers.push(paint1, paint2, paint3);
  editor.texturePaintSetSingleLayerSelection(activeStack, paint3.id);
  editor.rememberTexturePaintLayerSelection(activeStack, paint3);
  editor.texturePaintActiveMaterial = activeMaterial;

  const hitEditable = {
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    texture: { needsUpdate: false }
  };
  const hitStack = editor.texturePaintLayerStackForMaterial(hitMaterial, hitEditable, {
    create: true,
    setActiveMaterial: false
  });
  const hitPaint1 = editor.texturePaintNewLayer(hitStack, { id: "paint-1", name: "Paint 1" });
  const hitPaint2 = editor.texturePaintNewLayer(hitStack, { id: "paint-2", name: "Paint 2" });
  hitStack.layers.push(hitPaint1, hitPaint2);
  editor.texturePaintSetSingleLayerSelection(hitStack, hitPaint2.id);

  const target = editor.texturePaintEditableLayerTarget(hitMaterial, hitEditable);

  assert.equal(target.layerMode, true);
  assert.equal(target.layer.id, "paint-3");
  assert.equal(target.layer.name, "Paint 3");
  assert.equal(hitStack.layers.length, 3);
  assert.equal(hitStack.layers[2].id, "paint-3");
  assert.equal(hitStack.activeLayerId, "paint-3");
});

test("airbrush background selection falls forward to the hit material paint layer", () => {
  const editor = new TestEditor();
  const activeMaterial = { userData: {} };
  const hitMaterial = { userData: {} };
  editor.texturePaintLayersEnabled = true;
  editor.activeTool = "airbrush";
  editor.createTexturePaintCanvas = fakeCanvas;

  const activeEditable = {
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    texture: { needsUpdate: false }
  };
  const activeStack = editor.texturePaintLayerStackForMaterial(activeMaterial, activeEditable, { create: true });
  editor.texturePaintSetBackgroundSelection(activeStack);
  editor.rememberTexturePaintBackgroundSelection();
  editor.texturePaintActiveMaterial = activeMaterial;

  const hitEditable = {
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    texture: { needsUpdate: false }
  };
  const hitStack = editor.texturePaintLayerStackForMaterial(hitMaterial, hitEditable, {
    create: true,
    setActiveMaterial: false
  });
  const hitPaint1 = editor.texturePaintNewLayer(hitStack, { id: "paint-1", name: "Paint 1" });
  hitStack.layers.push(hitPaint1);
  editor.texturePaintSetSingleLayerSelection(hitStack, hitPaint1.id);

  const target = editor.texturePaintEditableLayerTarget(hitMaterial, hitEditable);

  assert.notEqual(target, hitEditable);
  assert.equal(target.layerMode, true);
  assert.equal(target.layer.id, "paint-1");
  assert.equal(target.layerStack, hitStack);
  assert.equal(target.compositeCanvas, hitEditable.canvas);
  assert.equal(hitStack.layers.length, 1);
  assert.equal(hitStack.activeLayerId, "paint-1");
  assert.equal(editor.texturePaintBackgroundSelectionActive, false);
});

test("background commits keep the layer stack base canvas current", () => {
  const editor = new TestEditor();
  const canvas = fakeCanvas(2, 1);
  const texture = { needsUpdate: false };
  const material = { userData: {} };
  editor.createTexturePaintCanvas = fakeCanvas;
  editor.scheduleTexturePaintLayerPanelRender = () => true;

  canvas.data.set([0, 0, 0, 255], 0);
  canvas.data.set([0, 0, 0, 255], 4);
  const editable = {
    canvas,
    context: canvas.getContext("2d"),
    texture
  };
  const stack = editor.texturePaintLayerStackForMaterial(material, editable, { create: true });

  canvas.data.set([255, 230, 12, 255], 4);
  assert.equal(editor.texturePaintCommitEditable(editable, material), true);
  assert.deepEqual([...stack.baseCanvas.data.slice(4, 8)], [255, 230, 12, 255]);
});

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    values,
    contains(name) {
      return values.has(name);
    },
    toggle(name, enabled) {
      if (enabled) {
        values.add(name);
      } else {
        values.delete(name);
      }
    }
  };
}

function fakeLayerRow(layer) {
  const eye = {
    title: "",
    classList: fakeClassList(),
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }
  };
  const opacity = { textContent: "" };
  return {
    dataset: { layerId: layer.id },
    classList: fakeClassList(["texture-layer-row"]),
    querySelector(selector) {
      if (selector === "[data-layer-visibility]") {
        return eye;
      }
      if (selector === ".texture-layer-opacity-label") {
        return opacity;
      }
      return null;
    },
    eye,
    opacity
  };
}

test("lower layer opacity changes defer underlay refresh instead of blocking input", async () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const lowerLayer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "lower-texture" } }, emptyTransparent: false }
  };
  const upperLayer = {
    id: "paint-2",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "upper-texture" } }, emptyTransparent: false }
  };
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: lowerLayer.id,
    selectedLayerIds: [lowerLayer.id],
    selectionAnchorLayerId: lowerLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerOpacity = { value: "1" };
  editor.texturePaintLayerOpacityOutput = { textContent: "100%" };
  editor.renderTexturePaintLayerPanel = () => true;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("opacity display changes should not flush GPU layers to CPU canvases");
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("lower layer opacity input should not composite synchronously");
  };
  const liveTargets = [];
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    liveTargets.push(targetEntry);
    return { target: targetEntry.target, shaderComposite: true };
  };

  assert.equal(editor.setTexturePaintLayerOpacity(lowerLayer.id, 0.35), true);
  assert.equal(lowerLayer.opacity, 0.35);
  assert.deepEqual(liveTargets, []);
  assert.equal(editor.pendingTexturePaintLayerDisplayComposites.get(material).forceLiveUnderlay, true);

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(liveTargets, [upperLayer.gpuTarget]);
});

test("visibility toggles update the row without a panel rebuild", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "layer-texture" } }, emptyTransparent: false }
  };
  const stack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  const row = fakeLayerRow(layer);
  material.userData.texturePaintLayerStack = stack;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerList = { children: [row] };
  const scheduledPanelRenders = [];
  let displayChanges = 0;
  editor.texturePaintApplyLayerDisplayChange = (candidateMaterial, options) => {
    assert.equal(candidateMaterial, material);
    assert.equal(options.changedLayer, layer);
    displayChanges += 1;
    return true;
  };
  editor.scheduleTexturePaintLayerPanelRender = (delayMs) => {
    scheduledPanelRenders.push(delayMs);
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => {
    throw new Error("visibility clicks should not rebuild layer thumbnails synchronously");
  };

  assert.equal(editor.toggleTexturePaintLayerVisibility(layer.id), true);
  assert.equal(layer.visible, false);
  assert.equal(row.eye.classList.contains("is-hidden"), true);
  assert.equal(row.eye.title, "Show layer");
  assert.equal(row.opacity.textContent, "100%");
  assert.deepEqual(scheduledPanelRenders, []);
  assert.equal(displayChanges, 1);
});

test("CPU layer commits display the freshly composited canvas before stale GPU composites", () => {
  const editor = new TestEditor();
  const cloneCanvas = fakeCanvas();
  const layerCanvas = fakeCanvas();
  const cloneTexture = { name: "fresh-cpu-composite", needsUpdate: false };
  const staleGpuTexture = { name: "stale-gpu-composite" };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true
  };
  const material = {
    map: staleGpuTexture,
    needsUpdate: false,
    userData: {
      clonePaintCanvas: cloneCanvas,
      clonePaintContext: cloneCanvas.getContext("2d"),
      clonePaintTexture: cloneTexture,
      texturePaintCompositeGpuTarget: {
        target: { texture: staleGpuTexture }
      },
      texturePaintLayerStack: {
        baseCanvas: fakeCanvas(),
        width: 2,
        height: 1,
        activeLayerId: layer.id,
        selectedLayerIds: [layer.id],
        selectionAnchorLayerId: layer.id,
        layers: [layer]
      }
    }
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("CPU layer commits should not overwrite the fresh display with a stale GPU composite");
  };

  assert.equal(editor.texturePaintCommitEditable({
    layerMode: true,
    layer,
    dirtyBounds: null
  }, material, null), true);

  assert.equal(material.map, cloneTexture);
  assert.equal(cloneTexture.needsUpdate, true);
  assert.equal(material.needsUpdate, true);
  assert.equal(layer.isEmpty, false);
});

test("opacity input updates the row label without a synchronous panel rebuild", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "layer-texture" } }, emptyTransparent: false }
  };
  const stack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  const row = fakeLayerRow(layer);
  material.userData.texturePaintLayerStack = stack;
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerList = { children: [row] };
  editor.texturePaintLayerOpacity = { value: "1" };
  editor.texturePaintLayerOpacityOutput = { textContent: "100%" };
  const scheduledPanelRenders = [];
  editor.texturePaintApplyLayerDisplayChange = () => true;
  editor.scheduleTexturePaintLayerPanelRender = (delayMs) => {
    scheduledPanelRenders.push(delayMs);
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => {
    throw new Error("opacity input should not rebuild layer thumbnails synchronously");
  };

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0.37), true);
  assert.equal(layer.opacity, 0.37);
  assert.equal(row.opacity.textContent, "37%");
  assert.equal(editor.texturePaintLayerOpacityOutput.textContent, "37%");
  assert.deepEqual(scheduledPanelRenders, [80]);
});

test("layer opacity changes refresh the live TSL layer display when available", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1
  };
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerOpacity = { value: "1" };
  editor.texturePaintLayerOpacityOutput = { textContent: "100%" };
  const refreshes = [];
  editor.texturePaintRefreshTslSurfaceLayerDisplay = (candidateMaterial, options) => {
    refreshes.push({ material: candidateMaterial, options });
    return true;
  };
  let canceled = 0;
  editor.cancelTexturePaintLayerDisplayComposite = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    canceled += 1;
    return true;
  };
  editor.texturePaintApplyLayerDisplayChange = () => {
    throw new Error("live TSL refresh should avoid CPU/display fallback");
  };
  editor.scheduleTexturePaintLayerDisplayPrewarm = () => true;
  editor.scheduleTexturePaintLayerPanelRender = () => true;

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0.42), true);
  assert.equal(layer.opacity, 0.42);
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].material, material);
  assert.equal(refreshes[0].options.changedLayer, layer);
  assert.equal(refreshes[0].options.reason, "opacity");
  assert.equal(canceled, 1);
  assert.equal(editor.texturePaintLayerOpacityOutput.textContent, "42%");
});

test("setting a layer blend mode forces exact display for non-normal modes", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "layer-texture" } }, emptyTransparent: false }
  };
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  const exactComposites = [];
  const pendingMaterial = { userData: {} };
  let displayChanges = 0;
  let displayPrewarms = 0;
  editor.pendingTexturePaintLayerDisplayComposites = new Map([
    [material, { changedLayer: layer }],
    [pendingMaterial, { changedLayer: null }]
  ]);
  editor.texturePaintLayerDisplayCompositeTimer = "timer";
  editor.texturePaintApplyLayerDisplayChange = (candidateMaterial, options) => {
    assert.equal(candidateMaterial, material);
    assert.deepEqual(options, { changedLayer: layer });
    displayChanges += 1;
    return true;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = (candidateMaterial, options) => {
    assert.equal(candidateMaterial, material);
    exactComposites.push(options);
    return true;
  };
  editor.scheduleTexturePaintLayerDisplayPrewarm = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    displayPrewarms += 1;
    return true;
  };
  editor.scheduleTexturePaintLayerPanelRender = () => true;
  editor.renderTexturePaintLayerPanel = () => {
    throw new Error("blend changes should schedule the layer panel render");
  };

  assert.equal(editor.setTexturePaintLayerBlendMode(layer.id, "multiply"), true);
  assert.equal(layer.blendMode, "multiply");
  assert.equal(displayPrewarms, 1);
  assert.equal(displayChanges, 0);
  assert.deepEqual(exactComposites, [{ changedLayer: layer, live: false }]);
  assert.equal(editor.pendingTexturePaintLayerDisplayComposites.has(material), false);
  assert.equal(editor.pendingTexturePaintLayerDisplayComposites.has(pendingMaterial), true);
  assert.equal(editor.texturePaintLayerDisplayCompositeTimer, "timer");
  assert.equal(editor.setTexturePaintLayerBlendMode(layer.id, "multiply"), false);
});

test("layer blend mode changes refresh the live TSL layer display when available", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    blendMode: "normal"
  };
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerBlendSelect = { value: "normal" };
  const refreshes = [];
  editor.texturePaintRefreshTslSurfaceLayerDisplay = (candidateMaterial, options) => {
    refreshes.push({ material: candidateMaterial, options });
    return true;
  };
  let canceled = 0;
  editor.cancelTexturePaintLayerDisplayComposite = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    canceled += 1;
    return true;
  };
  editor.texturePaintCompositeMaterialLayerDisplay = () => {
    throw new Error("live TSL refresh should avoid exact CPU/display composite");
  };
  editor.texturePaintApplyLayerDisplayChange = () => {
    throw new Error("live TSL refresh should avoid display fallback");
  };
  editor.scheduleTexturePaintLayerDisplayPrewarm = () => true;
  editor.scheduleTexturePaintLayerPanelRender = () => true;

  assert.equal(editor.setTexturePaintLayerBlendMode(layer.id, "multiply"), true);
  assert.equal(layer.blendMode, "multiply");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].material, material);
  assert.equal(refreshes[0].options.changedLayer, layer);
  assert.equal(refreshes[0].options.previousMode, "normal");
  assert.equal(refreshes[0].options.reason, "blend-mode");
  assert.equal(canceled, 1);
});

test("hiding and showing cached top layer keeps the live underlay fast", () => {
  const editor = new TestEditor();
  const underlayTexture = { uuid: "cached-underlay" };
  const layerTexture = { uuid: "top-layer" };
  const liveState = {
    layerOpacity: 1,
    shader: {
      uniforms: {
        texturePaintLiveLayerMap: { value: layerTexture },
        texturePaintLiveLayerOpacity: { value: 1 }
      }
    }
  };
  const material = {
    map: underlayTexture,
    userData: {
      texturePaintLiveLayerShaderComposite: liveState
    }
  };
  const lowerLayer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "lower-layer" } }, emptyTransparent: false }
  };
  const topTarget = {
    target: { texture: layerTexture },
    emptyTransparent: false,
    liveCompositeBaseTexture: underlayTexture,
    liveCompositeTarget: { target: { texture: layerTexture }, shaderComposite: true },
    liveCompositeLayerCount: 2,
    liveCompositeLayerIndex: 1,
    liveCompositeUnderlayKey: "underlay-key",
    liveCompositeLayerMutationSerial: 0
  };
  const topLayer = {
    id: "paint-2",
    name: "Paint 2",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: topTarget
  };
  topTarget.layer = topLayer;
  topTarget.liveCompositeLayer = topLayer;
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: topLayer.id,
    selectedLayerIds: [topLayer.id],
    selectionAnchorLayerId: topLayer.id,
    layers: [lowerLayer, topLayer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLiveLayerUnderlayKey = (targetEntry) => {
    assert.equal(targetEntry, topTarget);
    return "underlay-key";
  };
  editor.texturePaintMuteLiveLayerShaderComposite = () => {
    throw new Error("cached top-layer hide should keep the live shader instead of muting and swapping maps");
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, targetEntry) => {
    assert.equal(candidateMaterial, material);
    assert.equal(targetEntry, topTarget);
    return topTarget.liveCompositeTarget;
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("visibility toggle should not synchronously composite GPU layers");
  };
  editor.scheduleTexturePaintLayerDisplayComposite = () => {
    throw new Error("visibility toggle should not defer when cached underlay is ready");
  };
  editor.renderTexturePaintLayerPanel = () => true;

  assert.equal(editor.toggleTexturePaintLayerVisibility(topLayer.id), true);
  assert.equal(topLayer.visible, false);
  assert.equal(material.map, underlayTexture);
  assert.equal(liveState.layerOpacity, 0);
  assert.equal(liveState.shader.uniforms.texturePaintLiveLayerOpacity.value, 0);

  assert.equal(editor.toggleTexturePaintLayerVisibility(topLayer.id), true);
  assert.equal(topLayer.visible, true);
  assert.equal(material.map, underlayTexture);
  assert.equal(liveState.layerOpacity, 1);
  assert.equal(liveState.shader.uniforms.texturePaintLiveLayerOpacity.value, 1);
});

test("hiding a TSL surface display layer drops the stale live display cache", () => {
  const editor = new TestEditor();
  const baseTexture = { uuid: "base-texture", needsUpdate: false };
  const layerTexture = { uuid: "painted-layer-texture" };
  const tslDisplayTexture = {
    uuid: "tsl-display-texture",
    userData: {
      texturePaintTslSurfaceAirbrushDisplayTexture: true
    }
  };
  const material = {
    map: tslDisplayTexture,
    needsUpdate: false,
    userData: {
      clonePaintTexture: baseTexture,
      texturePaintLiveLayerShaderComposite: { shader: null }
    }
  };
  const targetEntry = {
    target: { texture: layerTexture },
    displayTarget: { texture: tslDisplayTexture },
    liveCompositeTarget: { texture: tslDisplayTexture },
    liveCompositeBaseTexture: baseTexture,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeLayerBlendMode: "normal",
    liveCompositeUnderlayKey: "",
    liveCompositeLayerMutationSerial: 0,
    emptyTransparent: false,
    paintRevision: 1
  };
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: targetEntry
  };
  targetEntry.layer = layer;
  targetEntry.liveCompositeLayer = layer;
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  let disabledLiveComposite = 0;
  let canceledDisplayComposite = 0;
  editor.texturePaintDisableLiveLayerShaderComposite = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    disabledLiveComposite += 1;
    delete candidateMaterial.userData.texturePaintLiveLayerShaderComposite;
    return true;
  };
  editor.cancelTexturePaintLayerDisplayComposite = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    canceledDisplayComposite += 1;
    return true;
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("TSL display hide should fall back to the CPU/base display instead of reusing stale live display");
  };
  editor.scheduleTexturePaintLayerDisplayComposite = () => {
    throw new Error("TSL display hide should not defer a stale live display");
  };
  editor.renderTexturePaintLayerPanel = () => true;

  assert.equal(editor.toggleTexturePaintLayerVisibility(layer.id), true);
  assert.equal(layer.visible, false);
  assert.equal(material.map, baseTexture);
  assert.equal(material.needsUpdate, true);
  assert.ok(disabledLiveComposite >= 1);
  assert.equal(canceledDisplayComposite, 1);
  assert.equal(targetEntry.liveCompositeTarget, undefined);
  assert.equal(targetEntry.liveCompositeBaseTexture, undefined);
  assert.equal(targetEntry.liveCompositeLayer, undefined);
  assert.equal(targetEntry.liveCompositeLayerIndex, undefined);
  assert.equal(targetEntry.liveCompositeLayerMutationSerial, undefined);
});

test("cached live layer display rejects stale blend modes", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const underlayTexture = { uuid: "cached-underlay" };
  const layerTexture = { uuid: "layer-target" };
  const displayTexture = { uuid: "display-texture" };
  const targetEntry = {
    target: { texture: layerTexture },
    liveCompositeTarget: { texture: displayTexture, shaderComposite: true },
    liveCompositeBaseTexture: underlayTexture,
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeLayerOpacity: 1,
    liveCompositeLayerBlendMode: "normal",
    liveCompositeUnderlayKey: "",
    liveCompositeLayerMutationSerial: 0,
    emptyTransparent: false,
    paintRevision: 1
  };
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    blendMode: "multiply",
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: targetEntry
  };
  targetEntry.layer = layer;
  targetEntry.liveCompositeLayer = layer;
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLiveLayerUnderlayKey = () => "";
  editor.texturePaintRestoreLiveLayerShaderDisplayState = () => {
    throw new Error("stale blend-mode cache should not restore the live display");
  };

  assert.equal(editor.texturePaintFastHiddenTopLayerDisplay(material, material.userData.texturePaintLayerStack, layer), false);
  assert.equal(material.map, undefined);
});

test("showing a painted layer queues exact display instead of accepting stale non-live composite", () => {
  const editor = new TestEditor();
  const material = {
    map: { uuid: "base-texture" },
    userData: {}
  };
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: false,
    opacity: 1,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: false,
    gpuTarget: {
      target: { texture: { uuid: "painted-layer-texture" } },
      emptyTransparent: false,
      paintRevision: 1
    }
  };
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.renderer = {};
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("visibility restore should not read GPU layer targets back to CPU");
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = () => ({
    target: { texture: { uuid: "stale-base-only-composite" } }
  });
  let exactComposites = 0;
  editor.texturePaintCompositeMaterialLayerGpuTargets = (candidateMaterial) => {
    exactComposites += 1;
    assert.equal(candidateMaterial, material);
    return true;
  };
  let displayPrewarms = 0;
  editor.scheduleTexturePaintLayerDisplayPrewarm = () => {
    displayPrewarms += 1;
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => true;

  assert.equal(editor.toggleTexturePaintLayerVisibility(layer.id), true);
  assert.equal(layer.visible, true);
  assert.equal(exactComposites, 0);
  assert.equal(editor.pendingTexturePaintLayerDisplayComposites.get(material).changedLayer, layer);
  assert.equal(editor.pendingTexturePaintLayerDisplayComposites.get(material).forceLiveUnderlay, true);
  assert.equal(displayPrewarms, 0);
});

test("restoring a live layer marks the material dirty before shader uniforms exist", () => {
  const editor = new TestEditor();
  const layerTexture = { uuid: "painted-layer-texture" };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1
  };
  const targetEntry = {
    target: { texture: layerTexture },
    layer,
    liveCompositeLayerOpacity: 0
  };
  const material = {
    needsUpdate: false,
    userData: {
      texturePaintLiveLayerShaderComposite: {
        layerTexture: null,
        layerOpacity: 0,
        shader: null
      }
    }
  };

  assert.equal(
    editor.texturePaintRestoreLiveLayerShaderDisplayState(material, targetEntry, { shaderComposite: true }),
    true
  );
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.layerTexture, layerTexture);
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.layerOpacity, 1);
  assert.equal(targetEntry.liveCompositeLayerOpacity, 1);
  assert.equal(material.needsUpdate, true);
});

test("top layer opacity zero and restore reuses the cached live layer path", () => {
  const editor = new TestEditor();
  const baseTexture = { uuid: "base-texture" };
  const layerTexture = { uuid: "layer-texture" };
  const liveState = {
    layerOpacity: 1,
    shader: {
      uniforms: {
        texturePaintLiveLayerOpacity: { value: 1 }
      }
    }
  };
  const material = {
    map: baseTexture,
    userData: {
      texturePaintLiveLayerShaderComposite: liveState
    }
  };
  const targetEntry = {
    target: { texture: layerTexture },
    emptyTransparent: false,
    liveCompositeBaseTexture: baseTexture,
    liveCompositeTarget: { target: { texture: layerTexture }, shaderComposite: true },
    liveCompositeLayerCount: 1,
    liveCompositeLayerIndex: 0,
    liveCompositeUnderlayKey: "",
    liveCompositeLayerMutationSerial: 0
  };
  const layer = {
    id: "paint-1",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: targetEntry
  };
  targetEntry.layer = layer;
  targetEntry.liveCompositeLayer = layer;
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id],
    selectionAnchorLayerId: layer.id,
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerOpacity = { value: "1" };
  editor.texturePaintLayerOpacityOutput = { textContent: "100%" };
  editor.texturePaintLiveLayerUnderlayKey = () => "";
  editor.texturePaintMuteLiveLayerShaderComposite = () => {
    liveState.layerOpacity = 0;
    liveState.shader.uniforms.texturePaintLiveLayerOpacity.value = 0;
    return true;
  };
  editor.texturePaintLiveCompositeTargetForLayerGpuPaint = (candidateMaterial, candidateTarget) => {
    assert.equal(candidateMaterial, material);
    assert.equal(candidateTarget, targetEntry);
    liveState.layerOpacity = layer.opacity;
    liveState.shader.uniforms.texturePaintLiveLayerOpacity.value = layer.opacity;
    return targetEntry.liveCompositeTarget;
  };
  editor.texturePaintCompositeMaterialLayerGpuTargets = () => {
    throw new Error("top layer opacity should not synchronously composite GPU layers");
  };
  editor.scheduleTexturePaintLayerDisplayComposite = () => {
    throw new Error("top layer opacity should not defer when cached live path is ready");
  };
  editor.renderTexturePaintLayerPanel = () => true;

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0), true);
  assert.equal(layer.opacity, 0);
  assert.equal(material.map, baseTexture);
  assert.equal(liveState.shader.uniforms.texturePaintLiveLayerOpacity.value, 0);
  assert.equal(editor.texturePaintLayerOpacityOutput.textContent, "0%");

  assert.equal(editor.setTexturePaintLayerOpacity(layer.id, 0.42), true);
  assert.equal(layer.opacity, 0.42);
  assert.equal(material.map, baseTexture);
  assert.equal(liveState.shader.uniforms.texturePaintLiveLayerOpacity.value, 0.42);
  assert.equal(editor.texturePaintLayerOpacityOutput.textContent, "42%");
});

test("empty layer display no longer initializes legacy WebGL render targets", () => {
  class WebGpuOnlyEditor {}
  const THREE = {
    LinearFilter: "linear",
    ClampToEdgeWrapping: "clamp",
    WebGLRenderTarget() {
      throw new Error("WebGPU-only layer display must not allocate WebGL render targets");
    }
  };
  installPaintToolMethods(WebGpuOnlyEditor, { THREE });
  installTexturePaintLayerMethods(WebGpuOnlyEditor);
  const editor = new WebGpuOnlyEditor();

  assert.equal(editor.textureAirbrushGpuLayerTargetForMaterial, undefined);
  assert.equal(editor.textureAirbrushCopyTextureToTarget, undefined);
  assert.equal(editor.textureAirbrushCanvasFromRenderTarget, undefined);
});

test("selecting a layer does not read GPU layer targets back to CPU canvases", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const firstLayer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "first-layer" } }, emptyTransparent: false }
  };
  const secondLayer = {
    id: "paint-2",
    name: "Paint 2",
    visible: true,
    opacity: 1,
    canvas: fakeCanvas(),
    context: fakeCanvas().getContext("2d"),
    isEmpty: false,
    gpuTarget: { target: { texture: { uuid: "second-layer" } }, emptyTransparent: false }
  };
  material.userData.texturePaintLayerStack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: firstLayer.id,
    selectedLayerIds: [firstLayer.id],
    selectionAnchorLayerId: firstLayer.id,
    layers: [firstLayer, secondLayer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.textureAirbrushScreenStrokeQueue = [{ layerMode: true }, { layerMode: false }];
  editor.textureAirbrushPendingScreenStrokeBatches = [{ layerMode: true }, { layerMode: false }];
  let resetFrames = 0;
  let panelRenders = 0;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    throw new Error("layer selection should not flush GPU paint to CPU canvases");
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    resetFrames += 1;
  };
  let prewarmCalls = 0;
  editor.prewarmTexturePaintActiveLayerForAction = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    prewarmCalls += 1;
    return true;
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    throw new Error("layer selection should not schedule heavy airbrush prewarm");
  };
  editor.scheduleTexturePaintLayerDisplayPrewarm = () => {
    throw new Error("layer selection should not schedule display prewarm");
  };
  editor.renderTexturePaintLayerPanel = () => {
    panelRenders += 1;
    return true;
  };

  assert.equal(editor.selectTexturePaintLayer(secondLayer.id), true);
  assert.equal(material.userData.texturePaintLayerStack.activeLayerId, secondLayer.id);
  assert.deepEqual(material.userData.texturePaintLayerStack.selectedLayerIds, [secondLayer.id]);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue, [{ layerMode: false }]);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches, [{ layerMode: false }]);
  assert.equal(editor.texturePaintLayerMutationSerial, 1);
  assert.equal(resetFrames, 1);
  assert.equal(panelRenders, 1);
  assert.equal(prewarmCalls, 1);
});

test("selecting a paint layer bakes pending background paint before returning", () => {
  const editor = new TestEditor();
  const material = { userData: {} };
  const baseCanvas = fakeCanvas();
  baseCanvas.data.set([10, 20, 30, 255], 0);
  const layerCanvas = fakeCanvas();
  const layer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    canvas: layerCanvas,
    context: layerCanvas.getContext("2d"),
    isEmpty: true
  };
  material.userData.texturePaintLayerStack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: "",
    selectedLayerIds: [],
    selectionAnchorLayerId: "",
    layers: [layer]
  };
  editor.texturePaintActiveMaterial = material;
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.renderTexturePaintLayerPanel = () => true;
  const calls = [];
  editor.flushTextureAirbrushScreenStroke = () => {
    calls.push("screen");
    return 1;
  };
  editor.flushTextureAirbrushGpuTargetsToCanvases = (options) => {
    assert.deepEqual(options, { mutatedOnly: true });
    baseCanvas.data.set([255, 230, 12, 255], 0);
    calls.push("background");
    return 1;
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    calls.push("reset-frame");
  };
  editor.prewarmTexturePaintActiveLayerForAction = (candidateMaterial) => {
    assert.equal(candidateMaterial, material);
    calls.push("prewarm");
    return true;
  };
  editor.scheduleTextureAirbrushPrewarm = () => {
    throw new Error("layer selection should not schedule heavy prewarm");
  };
  editor.scheduleTexturePaintLayerDisplayPrewarm = () => {
    throw new Error("layer selection should not schedule display prewarm");
  };

  assert.equal(editor.selectTexturePaintLayer(layer.id), true);
  assert.deepEqual(calls, [
    "screen",
    "background",
    "reset-frame",
    "prewarm"
  ]);
  assert.equal(material.userData.texturePaintLayerStack.activeLayerId, layer.id);
});

test("live layer underlay key tracks lower GPU layer state", () => {
  const editor = new TestEditor();
  editor.texturePaintLayerMutationSerial = 4;
  const lowerCanvas = fakeCanvas();
  const upperCanvas = fakeCanvas();
  const lowerLayer = {
    id: "paint-1",
    name: "Paint 1",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    canvas: lowerCanvas,
    context: lowerCanvas.getContext("2d"),
    isEmpty: false,
    texturePaintGpuPainted: true,
    texturePaintHasPaint: true,
    gpuTarget: {
      target: { texture: { uuid: "lower-a" } },
      paintRevision: 1,
      emptyTransparent: false,
      texturePaintLayerHasPaint: true
    }
  };
  const upperTarget = {
    target: { texture: { uuid: "upper" } },
    paintRevision: 10,
    emptyTransparent: false,
    texturePaintLayerHasPaint: true
  };
  const upperLayer = {
    id: "paint-2",
    name: "Paint 2",
    visible: true,
    opacity: 1,
    blendMode: "normal",
    canvas: upperCanvas,
    context: upperCanvas.getContext("2d"),
    isEmpty: false,
    texturePaintGpuPainted: true,
    texturePaintHasPaint: true,
    gpuTarget: upperTarget
  };
  const stack = {
    baseCanvas: fakeCanvas(),
    width: 2,
    height: 1,
    activeLayerId: upperLayer.id,
    selectedLayerIds: [upperLayer.id],
    selectionAnchorLayerId: upperLayer.id,
    layers: [lowerLayer, upperLayer]
  };
  lowerLayer.gpuTarget.layer = lowerLayer;
  lowerLayer.gpuTarget.layerStack = stack;
  upperTarget.layer = upperLayer;
  upperTarget.layerStack = stack;

  const baseKey = editor.texturePaintLiveLayerUnderlayKey(upperTarget);
  upperTarget.paintRevision += 1;
  assert.equal(editor.texturePaintLiveLayerUnderlayKey(upperTarget), baseKey);

  lowerLayer.gpuTarget.paintRevision += 1;
  const revisionKey = editor.texturePaintLiveLayerUnderlayKey(upperTarget);
  assert.notEqual(revisionKey, baseKey);

  lowerLayer.opacity = 0.5;
  const opacityKey = editor.texturePaintLiveLayerUnderlayKey(upperTarget);
  assert.notEqual(opacityKey, revisionKey);

  lowerLayer.gpuTarget.target.texture = { uuid: "lower-b" };
  assert.notEqual(editor.texturePaintLiveLayerUnderlayKey(upperTarget), opacityKey);
});

test("layer display changes can defer active layer prewarm off the input event", async () => {
  const editor = new TestEditor();
  const material = { userData: { texturePaintLayerStack: { layers: [] } } };
  const prewarmCalls = [];
  editor.texturePaintActiveMaterial = material;
  editor.activeTool = "airbrush";
  editor.texturePaintLayersEnabled = true;
  editor.texturePaintLayerModeActive = () => true;
  editor.prewarmTexturePaintActiveLayerMaterialGpu = (candidateMaterial, options) => {
    prewarmCalls.push(["material", candidateMaterial, options]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerProjectionGpu = (candidateMaterial) => {
    prewarmCalls.push(["projection", candidateMaterial]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerCursorProbe = (candidateMaterial) => {
    prewarmCalls.push(["cursor", candidateMaterial]);
    return true;
  };

  assert.equal(editor.scheduleTexturePaintLayerDisplayPrewarm(material, 1), true);
  assert.deepEqual(prewarmCalls, []);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(prewarmCalls, [
    ["material", material, { preserveLayerDisplay: true }],
    ["projection", material],
    ["cursor", material]
  ]);
});
