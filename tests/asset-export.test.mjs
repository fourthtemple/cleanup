import assert from "node:assert/strict";
import test from "node:test";
import { installAssetExportMethods } from "../src/weight-editor/asset-export.js";
import { installTexturePaintLayerMethods } from "../src/weight-editor/texture-layers.js";

class TestEditor {}

class FakeCanvasTexture {
  constructor(image) {
    this.image = image;
    this.name = "";
    this.userData = {};
    this.needsUpdate = false;
  }

  clone() {
    const texture = new FakeCanvasTexture(this.image);
    texture.name = this.name;
    texture.userData = { ...this.userData };
    return texture;
  }
}

installTexturePaintLayerMethods(TestEditor);
installAssetExportMethods(TestEditor, {
  THREE: { CanvasTexture: FakeCanvasTexture },
  GLTFExporter: null,
  SkeletonUtils: null
});

function fakeCanvas(width = 2, height = 1, pixels = null) {
  const canvas = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    getContext() {
      return context;
    },
    toDataURL() {
      return "data:image/png;base64,AQIDBA==";
    }
  };
  if (pixels) {
    canvas.data.set(pixels);
  }
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    clearRect() {
      canvas.data.fill(0);
    },
    drawImage(source) {
      canvas.data.set(source.data);
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

test("FBX export flattens visible texture paint layers into the exported map", () => {
  const editor = new TestEditor();
  let flushedLayerTargets = 0;
  editor.exportMaterials = () => [material];
  editor.flushTexturePaintLayerGpuTargetsToCanvases = ({ material: flushedMaterial } = {}) => {
    assert.equal(flushedMaterial, material);
    flushedLayerTargets += 1;
    return 1;
  };
  editor.textureAirbrushCopyTextureRenderSettings = (target, source) => {
    target.colorSpace = source?.colorSpace || "srgb";
    target.flipY = source?.flipY ?? false;
    return true;
  };
  editor.textureAirbrushInvalidateWebGpuCache = () => {};
  editor.updateClonePaintPreviews = () => {};

  const baseCanvas = fakeCanvas(2, 1, [10, 20, 30, 255, 10, 20, 30, 255]);
  const displayCanvas = fakeCanvas(2, 1);
  const visibleLayerCanvas = fakeCanvas(2, 1, [220, 90, 40, 255, 220, 90, 40, 255]);
  const hiddenLayerCanvas = fakeCanvas(2, 1, [0, 255, 0, 255, 0, 255, 0, 255]);
  const stack = {
    baseCanvas,
    baseContext: baseCanvas.getContext("2d"),
    width: 2,
    height: 1,
    activeLayerId: "visible",
    selectedLayerIds: ["visible"],
    selectionAnchorLayerId: "visible",
    layers: [
      {
        id: "hidden",
        name: "Hidden",
        visible: false,
        opacity: 1,
        blendMode: "normal",
        canvas: hiddenLayerCanvas,
        context: hiddenLayerCanvas.getContext("2d"),
        isEmpty: false
      },
      {
        id: "visible",
        name: "Paint 1",
        visible: true,
        opacity: 1,
        blendMode: "normal",
        canvas: visibleLayerCanvas,
        context: visibleLayerCanvas.getContext("2d"),
        isEmpty: false
      }
    ]
  };
  const originalMap = {
    name: "cat original",
    image: { width: 2, height: 1 },
    userData: {
      content: new Uint8Array([9, 9, 9]),
      fileName: "cat-original.jpg",
      mimeType: "image/jpeg"
    },
    colorSpace: "srgb",
    flipY: false
  };
  const cloneTexture = {
    name: "cat paint",
    image: displayCanvas,
    userData: {
      content: new Uint8Array([8, 8, 8]),
      mimeType: "image/png"
    },
    colorSpace: "srgb",
    flipY: false
  };
  const originalOnBeforeCompile = () => {};
  const originalCacheKey = () => "live-layer";
  const material = {
    name: "Cat",
    map: originalMap,
    needsUpdate: false,
    onBeforeCompile: originalOnBeforeCompile,
    customProgramCacheKey: originalCacheKey,
    userData: {
      clonePaintCanvas: displayCanvas,
      clonePaintContext: displayCanvas.getContext("2d"),
      clonePaintTexture: cloneTexture,
      texturePaintLayerStack: stack,
      texturePaintLiveLayerShaderComposite: { active: true }
    }
  };

  const restoreState = editor.captureExportMaterialState();
  assert.equal(editor.mergeTexturePaintLayersForAssetExport({ format: "fbx" }), 1);
  assert.equal(flushedLayerTargets, 1);
  assert.notEqual(material.map, originalMap);
  assert.equal(material.map.image, displayCanvas);
  assert.equal(material.userData.textureAirbrushBakedTexture, material.map);
  assert.deepEqual([...displayCanvas.data], [...visibleLayerCanvas.data]);

  editor.prepareMaterialsForAssetExport({ format: "fbx" });
  assert.deepEqual([...material.map.userData.content], [1, 2, 3, 4]);
  assert.equal(material.map.userData.fileName, "cat-paint-merged.png");
  assert.equal(material.map.userData.mimeType, "image/png");
  assert.equal(material.userData.texturePaintLayerStack, undefined);
  assert.equal(material.userData.texturePaintMergedExportTexture, undefined);

  editor.restoreExportMaterialState(restoreState);
  assert.equal(material.map, originalMap);
  assert.equal(material.userData.texturePaintLayerStack, stack);
  assert.equal(material.userData.texturePaintLiveLayerShaderComposite.active, true);
  assert.equal(material.onBeforeCompile, originalOnBeforeCompile);
  assert.equal(material.customProgramCacheKey, originalCacheKey);
});

test("asset export resolves live WebGPU display texture to synchronized canvas map", () => {
  const editor = new TestEditor();
  const canvas = fakeCanvas(2, 1, [1, 2, 3, 255, 4, 5, 6, 255]);
  const canvasMap = new FakeCanvasTexture(canvas);
  canvasMap.name = "paint canvas";
  const externalMap = {
    name: "paint live",
    image: { width: 2, height: 1 },
    userData: {
      textureAirbrushExternalWebGpuDisplay: true
    }
  };
  const material = {
    name: "Cat",
    map: externalMap,
    needsUpdate: false,
    userData: {
      textureAirbrushWebGpuExternalMap: externalMap,
      textureAirbrushWebGpuCanvasMap: canvasMap
    }
  };
  editor.exportMaterials = () => [material];

  editor.prepareMaterialsForAssetExport({ format: "fbx" });

  assert.equal(material.map, canvasMap);
  assert.equal(material.needsUpdate, true);
  assert.deepEqual([...material.map.userData.content], [1, 2, 3, 4]);
  assert.equal(material.map.userData.fileName, "paint-canvas.png");
  assert.equal(material.userData.textureAirbrushWebGpuExternalMap, undefined);
  assert.equal(material.userData.textureAirbrushWebGpuCanvasMap, undefined);
});
