import assert from "node:assert/strict";
import test from "node:test";
import { installTexturePaintLayerMethods } from "../src/weight-editor/texture-layers.js";
import {
  installTextureFixupMethods,
  textureFixupCanvasBlob,
  textureFixupColorGradeImageData,
  textureFixupColorHistogram,
  textureFixupCompositeLayerSource,
  textureFixupDominantComponents,
  textureFixupExportDimensions,
  textureFixupForceOpaque,
  textureFixupImageOpaqueBounds,
  textureFixupImportedLayerCanvas,
  textureFixupLayoutOutputBounds,
  textureFixupMaskAlphaInfo,
  textureFixupMaskedCropCanvas,
  textureFixupPackComponents,
  textureFixupPackedCropCanvas,
  textureFixupPaddedBounds
} from "../src/weight-editor/texture-fixup.js";
import { textureFixupCropCanvas } from "../src/weight-editor/texture-fixup/canvas.js";
import {
  textureFixupClipMaskToMaterialUvOccupancy,
  textureFixupMaterialUvOccupancy
} from "../src/weight-editor/texture-fixup/uv-occupancy.js";

class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.operations = [];
    this.states = [];
  }

  clearRect(...args) {
    this.operations.push({ type: "clearRect", args });
    this.canvas.data.fill(0);
  }

  drawImage(...args) {
    this.operations.push({
      type: "drawImage",
      alpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
      args
    });
    const source = args[0];
    if (source?.data?.length === this.canvas.data.length && args.length <= 5) {
      this.canvas.data.set(source.data);
    }
  }

  getImageData(x = 0, y = 0, width = this.canvas.width, height = this.canvas.height) {
    if (x === 0 && y === 0 && width === this.canvas.width && height === this.canvas.height) {
      return {
        width: this.canvas.width,
        height: this.canvas.height,
        data: new Uint8ClampedArray(this.canvas.data)
      };
    }
    const data = new Uint8ClampedArray(width * height * 4);
    for (let targetY = 0; targetY < height; targetY += 1) {
      for (let targetX = 0; targetX < width; targetX += 1) {
        const sourceOffset = ((y + targetY) * this.canvas.width + x + targetX) * 4;
        const targetOffset = (targetY * width + targetX) * 4;
        data.set(this.canvas.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
    return {
      width,
      height,
      data
    };
  }

  createImageData(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  putImageData(image, x = 0, y = 0) {
    if (
      x === 0
      && y === 0
      && image.width === this.canvas.width
      && image.height === this.canvas.height
    ) {
      this.canvas.data.set(image.data);
      return;
    }
    for (let sourceY = 0; sourceY < image.height; sourceY += 1) {
      for (let sourceX = 0; sourceX < image.width; sourceX += 1) {
        const sourceOffset = (sourceY * image.width + sourceX) * 4;
        const targetOffset = ((y + sourceY) * this.canvas.width + x + sourceX) * 4;
        this.canvas.data.set(image.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }

  save() {
    this.states.push({
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation
    });
    this.operations.push({ type: "save" });
  }

  restore() {
    const state = this.states.pop();
    if (state) {
      this.globalAlpha = state.globalAlpha;
      this.globalCompositeOperation = state.globalCompositeOperation;
    }
    this.operations.push({ type: "restore" });
  }

  translate(...args) {
    this.operations.push({ type: "translate", args });
  }

  scale(...args) {
    this.operations.push({ type: "scale", args });
  }

  strokeRect(...args) {
    this.operations.push({ type: "strokeRect", args });
  }

  fillRect(...args) {
    this.operations.push({ type: "fillRect", args, composite: this.globalCompositeOperation });
  }
}

class FakeCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.context = new FakeCanvasContext(this);
  }

  getContext() {
    return this.context;
  }

  toDataURL() {
    return "data:image/png;base64,test";
  }
}

function canvasFactory(width, height) {
  return new FakeCanvas(width, height);
}

function setPixelAlpha(canvas, x, y, alpha) {
  canvas.data[(y * canvas.width + x) * 4 + 3] = alpha;
}

test("fixup mask alpha keeps soft coverage and reports tight bounds", () => {
  const mask = new FakeCanvas(6, 5);
  setPixelAlpha(mask, 4, 1, 64);
  setPixelAlpha(mask, 2, 3, 255);
  setPixelAlpha(mask, 3, 2, 128);

  assert.deepEqual(textureFixupMaskAlphaInfo(mask), {
    count: 3,
    alphaSum: 447,
    bounds: { x: 2, y: 1, width: 3, height: 3 }
  });
  assert.equal(mask.data[(1 * mask.width + 4) * 4 + 3], 64);
});

test("fixup color histogram ignores transparent atlas pixels", () => {
  const image = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      255, 255, 255, 0
    ])
  };
  const histogram = textureFixupColorHistogram(image, { bins: 16 });

  assert.equal(histogram.count, 2);
  assert.equal(histogram.red[15], 1);
  assert.equal(histogram.green[15], 1);
  assert.equal(histogram.blue[15], 0);
});

test("fixup highlight tint warms ornament color without tinting dark fabric", () => {
  const source = {
    width: 3,
    height: 1,
    data: new Uint8ClampedArray([
      160, 160, 160, 255,
      25, 25, 25, 255,
      90, 80, 70, 0
    ])
  };
  const graded = textureFixupColorGradeImageData(source, {
    tint: "#c58b57",
    tintAmount: 100,
    range: "highlights"
  });

  assert.ok(graded.data[0] > graded.data[1]);
  assert.ok(graded.data[1] > graded.data[2]);
  assert.deepEqual(Array.from(graded.data.slice(4, 8)), [25, 25, 25, 255]);
  assert.deepEqual(Array.from(graded.data.slice(8, 12)), [90, 80, 70, 0]);
  assert.deepEqual(textureFixupImageOpaqueBounds(source), { x: 0, y: 0, width: 2, height: 1 });
});

test("fixup mask bounds ignore tiny remote islands", () => {
  const mask = new FakeCanvas(120, 20);
  for (let y = 5; y < 15; y += 1) {
    for (let x = 10; x < 20; x += 1) {
      setPixelAlpha(mask, x, y, 255);
    }
  }
  setPixelAlpha(mask, 110, 10, 255);

  const info = textureFixupMaskAlphaInfo(mask, {
    alphaThreshold: 8,
    trimFraction: 0.01
  });

  assert.deepEqual(info.bounds, { x: 10, y: 5, width: 10, height: 10 });
});

test("small fixup crops are upscaled to an AI-ready export size", () => {
  assert.deepEqual(textureFixupExportDimensions({ width: 351, height: 635 }), {
    width: 1024,
    height: 1853,
    scale: 1024 / 351
  });
  assert.deepEqual(textureFixupExportDimensions({ width: 1458, height: 2048 }), {
    width: 1458,
    height: 2048,
    scale: 1
  });
});

test("fixup source composite excludes mask layers but includes normal paint", () => {
  const base = new FakeCanvas(8, 6);
  const paint = new FakeCanvas(8, 6);
  const hiddenPaint = new FakeCanvas(8, 6);
  const mask = new FakeCanvas(8, 6);
  const editor = {
    createTexturePaintCanvas: canvasFactory,
    texturePaintLayerKind(layer) {
      return layer.kind || "paint";
    },
    texturePaintCanvasCompositeOperation(mode) {
      return mode === "multiply" ? "multiply" : "source-over";
    }
  };
  const result = textureFixupCompositeLayerSource(editor, {
    baseCanvas: base,
    width: 8,
    height: 6,
    layers: [
      { canvas: paint, kind: "paint", visible: true, opacity: 0.4, blendMode: "multiply" },
      { canvas: hiddenPaint, kind: "paint", visible: false, opacity: 1, blendMode: "normal" },
      { canvas: mask, kind: "fixup-mask", visible: true, opacity: 0.75, blendMode: "normal" }
    ]
  });
  const draws = result.context.operations.filter((operation) => operation.type === "drawImage");

  assert.equal(draws.length, 2);
  assert.equal(draws[0].args[0], base);
  assert.equal(draws[1].args[0], paint);
  assert.equal(draws[1].alpha, 0.4);
  assert.equal(draws[1].composite, "multiply");
});

test("fixup crop masks atlas pixels, adds context, and presents the crop upright", () => {
  const source = new FakeCanvas(16, 12);
  const mask = new FakeCanvas(16, 12);
  const editor = { createTexturePaintCanvas: canvasFactory };
  const bounds = textureFixupPaddedBounds({ x: 4, y: 3, width: 4, height: 3 }, 2, 16, 12);
  const crop = textureFixupCropCanvas(editor, source, bounds, mask, { rotate180: true });
  const draws = crop.context.operations.filter((operation) => operation.type === "drawImage");
  const transforms = crop.context.operations.filter((operation) => (
    operation.type === "translate" || operation.type === "scale"
  ));

  assert.deepEqual(bounds, { x: 2, y: 1, width: 8, height: 7 });
  assert.deepEqual(transforms, [
    { type: "translate", args: [8, 7] },
    { type: "scale", args: [-1, -1] }
  ]);
  assert.equal(draws.length, 2);
  assert.equal(draws[0].args[0], source);
  assert.equal(draws[1].args[0], mask);
  assert.equal(draws[1].composite, "destination-in");
});

test("fixup crop can render a larger export while retaining source bounds", () => {
  const source = new FakeCanvas(16, 12);
  const mask = new FakeCanvas(16, 12);
  const editor = { createTexturePaintCanvas: canvasFactory };
  const bounds = { x: 3, y: 2, width: 5, height: 4 };
  const crop = textureFixupCropCanvas(editor, source, bounds, mask, {
    outputWidth: 1024,
    outputHeight: 1024
  });
  const draws = crop.context.operations.filter((operation) => operation.type === "drawImage");

  assert.equal(crop.width, 1024);
  assert.equal(crop.height, 1024);
  assert.deepEqual(draws[0].args.slice(1), [3, 2, 5, 4, 0, 0, 1024, 1024]);
  assert.deepEqual(draws[1].args.slice(1), [3, 2, 5, 4, 0, 0, 1024, 1024]);
});

test("fixup layout packs distant UV regions instead of exporting their empty union", () => {
  const layout = textureFixupPackComponents([
    { bounds: { x: 10, y: 20, width: 50, height: 40 } },
    { bounds: { x: 900, y: 700, width: 40, height: 30 } }
  ], {
    textureWidth: 1024,
    textureHeight: 1024,
    padding: 4,
    gutter: 16
  });

  assert.equal(layout.items.length, 2);
  assert.ok(layout.width < 200);
  assert.ok(layout.height < 200);
  assert.ok(layout.width * layout.height < 1024 * 710 * 0.05);
});

test("fixup layout merges regions whose context padding overlaps", () => {
  const layout = textureFixupPackComponents([
    { bounds: { x: 10, y: 10, width: 8, height: 8 } },
    { bounds: { x: 22, y: 10, width: 8, height: 8 } }
  ], {
    textureWidth: 64,
    textureHeight: 64,
    padding: 4,
    gutter: 16
  });

  assert.equal(layout.items.length, 1);
  assert.deepEqual(layout.items[0].componentIndexes, [0, 1]);
  assert.deepEqual(layout.items[0].sourceBounds, { x: 6, y: 6, width: 28, height: 16 });
});

test("fixup export keeps only the dominant painted texture region", () => {
  const components = [
    { bounds: { x: 5, y: 6, width: 80, height: 100 }, alphaSum: 120000 },
    { bounds: { x: 700, y: 400, width: 10, height: 40 }, alphaSum: 900 },
    { bounds: { x: 900, y: 700, width: 4, height: 3 }, alphaSum: 80 }
  ];

  assert.deepEqual(textureFixupDominantComponents(components), [components[0]]);
});

test("packed fixup crops preserve every UV region under one aggregate mask", () => {
  const source = new FakeCanvas(32, 32);
  const mask = new FakeCanvas(32, 32);
  const editor = { createTexturePaintCanvas: canvasFactory };
  const layout = textureFixupPackComponents([
    { bounds: { x: 2, y: 3, width: 4, height: 5 } },
    { bounds: { x: 22, y: 24, width: 3, height: 4 } }
  ], {
    textureWidth: 32,
    textureHeight: 32,
    padding: 1,
    gutter: 2
  });
  const crop = textureFixupPackedCropCanvas(editor, source, mask, layout, {
    rotate180: true,
    outputWidth: 128,
    outputHeight: 128
  });
  const cropDraws = crop.context.operations.filter((operation) => operation.type === "drawImage");

  assert.equal(crop.width, 128);
  assert.equal(crop.height, 128);
  assert.equal(cropDraws.filter((operation) => operation.args[0] === source).length, 2);
  assert.equal(cropDraws.filter((operation) => operation.composite === "destination-in").length, 1);
});

test("fixup export preserves opaque source context and saves the mask for import", () => {
  const source = new FakeCanvas(32, 32);
  const mask = new FakeCanvas(32, 32);
  const editor = { createTexturePaintCanvas: canvasFactory };
  const layout = textureFixupPackComponents([
    { bounds: { x: 8, y: 9, width: 10, height: 12 } }
  ], {
    textureWidth: 32,
    textureHeight: 32,
    padding: 4
  });
  const crop = textureFixupPackedCropCanvas(editor, source, mask, layout, {
    applyMask: false,
    forceOpaque: true,
    outputWidth: 256,
    outputHeight: 256
  });
  const draws = crop.context.operations.filter((operation) => operation.type === "drawImage");

  assert.equal(draws.filter((operation) => operation.args[0] === source).length, 1);
  assert.equal(draws.some((operation) => operation.composite === "destination-in"), false);
  assert.equal(
    Array.from({ length: crop.width * crop.height }, (_, index) => crop.data[index * 4 + 3])
      .every((alpha) => alpha === 255),
    true
  );
});

test("fixup alpha removal preserves RGB while making every pixel opaque", () => {
  const canvas = new FakeCanvas(2, 1);
  canvas.data.set([12, 34, 56, 0, 78, 90, 123, 96]);

  assert.equal(textureFixupForceOpaque(canvas), true);
  assert.deepEqual(Array.from(canvas.data), [12, 34, 56, 255, 78, 90, 123, 255]);
});

test("masked fixup export preserves the exact silhouette on an opaque achromatic matte", () => {
  const source = new FakeCanvas(3, 2);
  const mask = new FakeCanvas(3, 2);
  source.data.set([
    10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
    100, 110, 120, 255, 130, 140, 150, 255, 160, 170, 180, 255
  ]);
  setPixelAlpha(mask, 1, 0, 255);
  setPixelAlpha(mask, 1, 1, 255);

  const crop = textureFixupMaskedCropCanvas(
    { createTexturePaintCanvas: canvasFactory },
    source,
    mask,
    { x: 0, y: 0, width: 3, height: 2 }
  );

  assert.deepEqual(Array.from(crop.data), [
    128, 128, 128, 255, 40, 50, 60, 255, 128, 128, 128, 255,
    128, 128, 128, 255, 130, 140, 150, 255, 128, 128, 128, 255
  ]);
});

test("fixup export clips seam bleed to material UV occupancy before copying atlas color", () => {
  const source = new FakeCanvas(8, 8);
  const mask = new FakeCanvas(8, 8);
  const material = { uuid: "torso-material" };
  const positionValues = new Array(18).fill(0);
  const uvValues = [
    0.25, 0.25, 0.75, 0.25, 0.75, 0.75,
    0.25, 0.25, 0.75, 0.75, 0.25, 0.75
  ];
  const attribute = (values, itemSize) => ({
    count: values.length / itemSize,
    getX(index) { return values[index * itemSize]; },
    getY(index) { return values[index * itemSize + 1]; }
  });
  const geometry = {
    attributes: {
      position: attribute(positionValues, 3),
      uv: attribute(uvValues, 2)
    },
    groups: []
  };
  const editor = {
    model: {
      traverse(callback) {
        callback({ geometry, material });
      }
    }
  };
  for (let pixelIndex = 0; pixelIndex < 64; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    source.data.set([0, 0, 0, 255], offset);
    mask.data.set([255, 255, 255, 255], offset);
  }
  for (let y = 2; y < 6; y += 1) {
    for (let x = 2; x < 6; x += 1) {
      source.data.set([90, 60, 30, 255], (y * 8 + x) * 4);
    }
  }

  const occupancy = textureFixupMaterialUvOccupancy(editor, material, null, 8, 8);
  assert.equal(occupancy.triangleCount, 2);
  const clipped = textureFixupClipMaskToMaterialUvOccupancy(editor, mask, material, null);
  assert.ok(clipped.removedPixelCount > 0);
  assert.equal(mask.data[3], 0);
  assert.equal(mask.data[(3 * 8 + 3) * 4 + 3], 255);

  const crop = textureFixupMaskedCropCanvas(
    { createTexturePaintCanvas: canvasFactory },
    source,
    mask,
    { x: 0, y: 0, width: 8, height: 8 }
  );
  assert.deepEqual(Array.from(crop.data.slice(0, 4)), [128, 128, 128, 255]);
  assert.deepEqual(
    Array.from(crop.data.slice((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 4)),
    [90, 60, 30, 255]
  );
});

test("masked fixup export and import share the same 180 degree presentation transform", () => {
  const source = new FakeCanvas(2, 2);
  const mask = new FakeCanvas(2, 2);
  source.data.set([
    1, 2, 3, 255, 4, 5, 6, 255,
    7, 8, 9, 255, 10, 11, 12, 255
  ]);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      setPixelAlpha(mask, x, y, 255);
    }
  }

  const crop = textureFixupMaskedCropCanvas(
    { createTexturePaintCanvas: canvasFactory },
    source,
    mask,
    { x: 0, y: 0, width: 2, height: 2 },
    { rotate180: true }
  );

  assert.deepEqual(Array.from(crop.data), [
    10, 11, 12, 255, 7, 8, 9, 255,
    4, 5, 6, 255, 1, 2, 3, 255
  ]);

  const imported = textureFixupImportedLayerCanvas(
    { createTexturePaintCanvas: canvasFactory },
    crop,
    mask,
    {
      width: 2,
      height: 2,
      items: [{
        sourceBounds: { x: 0, y: 0, width: 2, height: 2 },
        destinationBounds: { x: 0, y: 0, width: 2, height: 2 }
      }]
    },
    { rotate180: true }
  );

  assert.deepEqual(Array.from(imported.data), Array.from(source.data));
});

test("an unchanged scaled export reimports as a transparent delta", () => {
  const source = new FakeCanvas(5, 4);
  const mask = new FakeCanvas(5, 4);
  for (let pixelIndex = 0; pixelIndex < source.width * source.height; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    source.data[offset] = 20 + pixelIndex * 3;
    source.data[offset + 1] = 40 + pixelIndex * 2;
    source.data[offset + 2] = 60 + pixelIndex;
    source.data[offset + 3] = 255;
    mask.data[offset + 3] = 255;
  }
  mask.data[3] = 7;
  const crop = textureFixupMaskedCropCanvas(
    { createTexturePaintCanvas: canvasFactory },
    source,
    mask,
    { x: 0, y: 0, width: 5, height: 4 },
    { outputWidth: 11, outputHeight: 9, rotate180: true }
  );
  const layout = {
    width: 5,
    height: 4,
    items: [{
      sourceBounds: { x: 0, y: 0, width: 5, height: 4 },
      destinationBounds: { x: 0, y: 0, width: 5, height: 4 }
    }]
  };
  const editor = { createTexturePaintCanvas: canvasFactory };
  const unchanged = textureFixupImportedLayerCanvas(editor, crop, mask, layout, {
    rotate180: true,
    referenceCanvas: source
  });

  assert.equal(
    Array.from(unchanged.data).filter((value, index) => index % 4 === 3 && value !== 0).length,
    0
  );
  assert.equal(unchanged.data[3], 0);

  const changedCrop = new FakeCanvas(crop.width, crop.height);
  changedCrop.data.set(crop.data);
  const changedOffset = (5 * changedCrop.width + 5) * 4;
  changedCrop.data[changedOffset] += 12;
  const changed = textureFixupImportedLayerCanvas(editor, changedCrop, mask, layout, {
    rotate180: true,
    referenceCanvas: source
  });
  const changedTextureOffset = (1 * source.width + 2) * 4;
  assert.equal(changed.data[changedTextureOffset], source.data[changedTextureOffset] + 12);
  assert.equal(changed.data[changedTextureOffset + 3], 255);
});

test("fixup PNG export uses RGB color type without an alpha channel", async () => {
  const canvas = new FakeCanvas(2, 1);
  canvas.data.set([12, 34, 56, 255, 78, 90, 123, 255]);

  const blob = await textureFixupCanvasBlob(canvas);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  assert.deepEqual(Array.from(bytes.slice(1, 4)), [80, 78, 71]);
  assert.equal(bytes[24], 8);
  assert.equal(bytes[25], 2);
});

test("fixup export clicks a named download anchor and revokes its Blob URL", async () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const crop = new FakeCanvas(2, 1);
  crop.data.set([12, 34, 56, 255, 78, 90, 123, 255]);
  const selection = {
    material: { name: "Torso" },
    bounds: { x: 4, y: 5, width: 2, height: 1 },
    layout: {
      width: 2,
      height: 1,
      items: [{
        sourceBounds: { x: 4, y: 5, width: 2, height: 1 },
        destinationBounds: { x: 0, y: 0, width: 2, height: 1 }
      }]
    },
    presentationRotate180: true,
    projection: null,
    cropCanvas: crop
  };
  editor.textureFixupActiveMaskEntry = () => ({ layer: { id: "mask-1" } });
  editor.refreshTextureFixupSelection = async () => selection;
  editor.syncTextureFixupControls = () => {};
  editor.copyTexturePaintCanvas = (canvas) => canvas;
  editor.setTextureFixupPanelStatus = () => {};
  editor.setStatus = (message) => {
    editor.status = message;
  };

  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalCreateObjectUrl = globalThis.URL.createObjectURL;
  const originalRevokeObjectUrl = globalThis.URL.revokeObjectURL;
  const anchor = {
    clicked: 0,
    removed: 0,
    click() {
      this.clicked += 1;
    },
    remove() {
      this.removed += 1;
    }
  };
  let appended = null;
  let revoked = null;
  let timeoutCallback = null;
  globalThis.document = {
    body: {
      append(element) {
        appended = element;
      }
    },
    createElement(tagName) {
      assert.equal(tagName, "a");
      return anchor;
    }
  };
  globalThis.window = {
    setTimeout(callback) {
      timeoutCallback = callback;
    }
  };
  globalThis.URL.createObjectURL = () => "blob:texture-fixup";
  globalThis.URL.revokeObjectURL = (url) => {
    revoked = url;
  };
  try {
    assert.equal(await editor.exportTextureFixupPng(), true);
    assert.equal(appended, anchor);
    assert.equal(anchor.href, "blob:texture-fixup");
    assert.equal(anchor.download, "torso-fixup-4-5-2x1.png");
    assert.equal(anchor.clicked, 1);
    assert.equal(anchor.removed, 1);
    assert.match(editor.status, /Exported torso-fixup-4-5-2x1\.png/);
    timeoutCallback();
    assert.equal(revoked, "blob:texture-fixup");
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.URL.createObjectURL = originalCreateObjectUrl;
    globalThis.URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("packed fixup output bounds map back from resized AI images", () => {
  const layout = {
    width: 100,
    height: 80,
    items: [{
      sourceBounds: { x: 20, y: 30, width: 10, height: 10 },
      destinationBounds: { x: 25, y: 10, width: 30, height: 20 }
    }]
  };

  assert.deepEqual(textureFixupLayoutOutputBounds(layout, layout.items[0], 1000, 400), {
    x: 250,
    y: 50,
    width: 300,
    height: 100
  });
});

test("new fixup mask uses the existing Neighbor airbrush path", () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const stack = { layers: [], activeLayerId: "", selectedLayerIds: [] };
  const material = { userData: { texturePaintLayerStack: stack } };
  editor.model = {};
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerKind = (layer) => layer.kind || "paint";
  editor.texturePaintActivePaintLayerForStack = (targetStack) => {
    const layer = targetStack.layers.find((candidate) => candidate.id === targetStack.activeLayerId) || null;
    return layer ? { stack: targetStack, layer } : null;
  };
  editor.addTexturePaintLayer = (options) => {
    editor.addOptions = options;
    const layer = {
      id: "mask-1",
      name: options.name,
      kind: options.kind,
      canvas: new FakeCanvas(8, 8),
      visible: true
    };
    stack.layers.push(layer);
    stack.activeLayerId = layer.id;
    return true;
  };
  editor.setTexturePaintNeighborMode = (enabled, options) => {
    editor.neighborCall = { enabled, options };
  };
  editor.setTool = (tool) => {
    editor.selectedTool = tool;
  };
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setTextureFixupPanelStatus = () => {};
  editor.setStatus = () => {};

  assert.equal(editor.createTextureFixupMaskLayer(), true);
  assert.deepEqual(editor.addOptions, {
    name: "Fixup Mask 1",
    kind: "fixup-mask",
    opacity: 0.75
  });
  assert.deepEqual(editor.neighborCall, { enabled: true, options: { status: false } });
  assert.equal(editor.selectedTool, "airbrush");
});

test("fixup panel status follows mask and imported layer history", () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const mask = {
    id: "mask-1",
    name: "Fixup Mask 1",
    kind: "fixup-mask",
    canvas: new FakeCanvas(8, 8)
  };
  const fixup = {
    id: "fixup-1",
    name: "AI Fixup 1",
    kind: "paint",
    canvas: new FakeCanvas(8, 8)
  };
  const stack = {
    layers: [mask, fixup],
    activeLayerId: mask.id
  };
  const material = { userData: { texturePaintLayerStack: stack } };
  editor.model = {};
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerKind = (layer) => layer?.kind || "paint";
  editor.texturePaintActivePaintLayerForStack = (targetStack) => {
    const layer = targetStack?.layers?.find((candidate) => candidate.id === targetStack.activeLayerId) || null;
    return layer ? { stack: targetStack, layer } : null;
  };
  editor.textureFixupSelection = {
    maskLayerId: mask.id,
    maskCanvas: new FakeCanvas(8, 8),
    bounds: { x: 1, y: 1, width: 4, height: 4 },
    cropCanvas: new FakeCanvas(1024, 1377),
    pixelCount: 80444,
    exportLayout: {
      width: 100,
      height: 100,
      items: Array.from({ length: 22 }, () => ({
        sourceBounds: { x: 0, y: 0, width: 1, height: 1 },
        destinationBounds: { x: 0, y: 0, width: 1, height: 1 }
      }))
    }
  };
  editor.textureFixupStatus = { textContent: "" };

  assert.equal(editor.syncTextureFixupControls(), true);
  assert.equal(
    editor.textureFixupStatus.textContent,
    "Fixup Mask 1 - 80,444 pixels - 22 regions - export 1024 x 1377px"
  );

  stack.activeLayerId = fixup.id;
  assert.equal(editor.syncTextureFixupControls(), false);
  assert.equal(editor.textureFixupStatus.textContent, "AI Fixup 1 - 22 imported regions");
});

test("painted fixup masks render an immediate visible preview", () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const maskCrop = new FakeCanvas(24, 16);
  for (let y = 3; y < 13; y += 1) {
    for (let x = 4; x < 20; x += 1) {
      setPixelAlpha(maskCrop, x, y, 180);
    }
  }
  const layer = {
    name: "Fixup Mask 1",
    canvas: { width: 4096, height: 4096 }
  };
  editor.textureFixupPreview = new FakeCanvas(240, 140);
  editor.textureFixupPadding = { value: "32" };
  editor.createTexturePaintCanvas = canvasFactory;
  editor.setTextureFixupPanelStatus = (message) => {
    editor.panelStatus = message;
  };

  assert.equal(editor.renderTextureFixupMaskLayerPreview({
    canvas: maskCrop,
    bounds: { x: 100, y: 200, width: 24, height: 16 }
  }, layer), true);
  assert.match(editor.panelStatus, /Fixup Mask 1 - 1 region - export \d+ x \d+px/);
  assert.equal(
    editor.textureFixupPreview.context.operations.some((operation) => (
      operation.type === "fillRect" && operation.composite === "source-in"
    )),
    true
  );
});

test("preparing a fixup export leaves the visible mask preview unchanged", () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const source = new FakeCanvas(16, 12);
  const mask = new FakeCanvas(16, 12);
  for (let y = 3; y < 9; y += 1) {
    for (let x = 4; x < 10; x += 1) {
      setPixelAlpha(mask, x, y, 255);
    }
  }
  editor.textureFixupPreview = new FakeCanvas(240, 140);
  editor.textureFixupPreview.data.fill(73);
  const previewBefore = new Uint8ClampedArray(editor.textureFixupPreview.data);
  editor.textureFixupPadding = { value: "2" };
  editor.createTexturePaintCanvas = canvasFactory;
  editor.syncTextureFixupControls = () => {};
  editor.textureFixupSelection = {
    tightBounds: { x: 4, y: 3, width: 6, height: 6 },
    maskComponents: [{ bounds: { x: 4, y: 3, width: 6, height: 6 } }],
    maskCanvas: mask,
    sourceCanvas: source,
    width: source.width,
    height: source.height,
    material: { map: null }
  };

  assert.equal(editor.refreshTextureFixupCrop(), true);
  assert.deepEqual(editor.textureFixupPreview.data, previewBefore);
  assert.ok(editor.textureFixupSelection.cropCanvas);
});

test("fixup import opens from an active mask before an export selection exists", () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const listeners = new Map();
  let pickerCalls = 0;
  editor.textureFixupImportButton = {
    disabled: true,
    addEventListener(type, callback) {
      listeners.set(`button:${type}`, callback);
    }
  };
  editor.textureFixupFileInput = {
    value: "previous.png",
    files: [],
    showPicker() {
      pickerCalls += 1;
    },
    addEventListener(type, callback) {
      listeners.set(`input:${type}`, callback);
    }
  };
  editor.textureFixupActiveMaskEntry = () => ({
    material: {},
    layer: { canvas: new FakeCanvas(4, 4) }
  });
  editor.updateTextureFixupOutputs = () => {};
  editor.syncTextureFixupPanelStatus = () => {};

  editor.bindTextureFixupControls();
  assert.equal(editor.textureFixupImportButton.disabled, false);
  listeners.get("button:click")();
  assert.equal(pickerCalls, 1);
  assert.equal(editor.textureFixupFileInput.value, "");
});

test("fixup import uses the frozen mask, hides it, and creates an undoable paint layer", async () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const material = { name: "Torso", userData: {}, map: { name: "torso-map" } };
  const sourceCanvas = new FakeCanvas(8, 8);
  const frozenMask = new FakeCanvas(8, 8);
  const maskLayer = {
    id: "mask-1",
    name: "Fixup Mask 1",
    kind: "fixup-mask",
    visible: true,
    canvas: new FakeCanvas(8, 8),
    context: null
  };
  maskLayer.context = maskLayer.canvas.context;
  const stack = {
    width: 8,
    height: 8,
    layers: [maskLayer],
    activeLayerId: maskLayer.id,
    selectedLayerIds: [maskLayer.id]
  };
  const createdCanvases = [];
  const snapshots = [];
  const frozenSelection = {
    material,
    maskLayerId: maskLayer.id,
    maskCanvas: frozenMask,
    bounds: { x: 2, y: 1, width: 4, height: 5 },
    exportLayout: {
      width: 6,
      height: 5,
      items: [
        {
          sourceBounds: { x: 1, y: 1, width: 2, height: 2 },
          destinationBounds: { x: 0, y: 0, width: 2, height: 2 }
        },
        {
          sourceBounds: { x: 5, y: 4, width: 2, height: 1 },
          destinationBounds: { x: 4, y: 3, width: 2, height: 1 }
        }
      ]
    },
    exportRotate180: true,
    width: 8,
    height: 8
  };
  let refreshSelectionCalls = 0;
  editor.textureFixupSelection = null;
  editor.textureFixupActiveMaskEntry = () => ({ material, stack, layer: maskLayer });
  editor.refreshTextureFixupSelection = async () => {
    refreshSelectionCalls += 1;
    editor.textureFixupSelection = frozenSelection;
    return frozenSelection;
  };
  editor.textureFixupCompositeSource = async () => ({
    canvas: sourceCanvas,
    context: sourceCanvas.context,
    texture: material.map
  });
  editor.editableClonePaintTexture = () => {
    material.userData.clonePaintCanvas = sourceCanvas;
    material.userData.clonePaintContext = sourceCanvas.context;
    material.userData.clonePaintTexture = material.map;
    return { canvas: sourceCanvas, context: sourceCanvas.context, texture: material.map };
  };
  editor.texturePaintLayerStackForMaterial = () => stack;
  editor.captureTexturePaintLayerHistorySnapshot = () => {
    const snapshot = { serial: snapshots.length + 1 };
    snapshots.push(snapshot);
    return snapshot;
  };
  editor.prepareTexturePaintLayerMutation = () => true;
  editor.texturePaintReusableAutoLayer = () => null;
  editor.createTexturePaintCanvas = (width, height) => {
    const canvas = new FakeCanvas(width, height);
    createdCanvases.push(canvas);
    return canvas;
  };
  editor.texturePaintNewLayer = (targetStack, options) => {
    const canvas = editor.createTexturePaintCanvas(targetStack.width, targetStack.height);
    return {
      id: "fixup-1",
      name: options.name,
      kind: options.kind,
      canvas,
      context: canvas.context,
      visible: true,
      opacity: 1,
      blendMode: "normal"
    };
  };
  editor.texturePaintUpdateLayerEmptyState = (layer) => {
    layer.isEmpty = false;
  };
  editor.texturePaintSetSingleLayerSelection = (targetStack, layerId) => {
    targetStack.activeLayerId = layerId;
    targetStack.selectedLayerIds = [layerId];
  };
  editor.rememberTexturePaintLayerSelection = () => true;
  editor.discardTexturePaintMaterialAirbrushGpuTarget = () => true;
  editor.invalidateTexturePaintMaterialGpuCaches = () => true;
  editor.texturePaintCompositeMaterialLayers = () => true;
  editor.renderTexturePaintLayerPanel = () => true;
  editor.pushTexturePaintLayerUndoState = (label, before, after) => {
    editor.pushedUndo = { label, before, after };
    return true;
  };
  editor.setTextureFixupPanelStatus = () => {};
  editor.setStatus = (message) => {
    editor.status = message;
  };

  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let imageClosed = false;
  const importedBitmap = new FakeCanvas(12, 10);
  importedBitmap.close = () => {
    imageClosed = true;
  };
  setPixelAlpha(frozenMask, 1, 1, 64);
  importedBitmap.data.set([25, 50, 75, 0], (3 * importedBitmap.width + 3) * 4);
  globalThis.createImageBitmap = async () => importedBitmap;
  try {
    assert.equal(await editor.importTextureFixupFile({ type: "image/png", name: "repair.png" }), true);
  } finally {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }

  assert.equal(stack.layers.length, 2);
  assert.equal(refreshSelectionCalls, 1);
  assert.equal(stack.layers[1].name, "AI Fixup 1");
  assert.equal(stack.layers[1].kind, "paint");
  assert.equal(maskLayer.visible, false);
  assert.equal(stack.activeLayerId, "fixup-1");
  assert.equal(editor.pushedUndo.label, "Import AI Fixup 1");
  assert.equal(editor.pushedUndo.before.serial, 1);
  assert.equal(editor.pushedUndo.after.serial, 2);
  assert.match(editor.status, /Imported repair\.png as AI Fixup 1/);
  assert.equal(imageClosed, true);

  const importedPixelOffset = (1 * stack.layers[1].canvas.width + 1) * 4;
  assert.deepEqual(
    Array.from(stack.layers[1].canvas.data.slice(importedPixelOffset, importedPixelOffset + 4)),
    [25, 50, 75, 255]
  );
});

test("fixup color grade previews, cancels exactly, and applies as one undo step", async () => {
  class Editor {}
  installTextureFixupMethods(Editor);
  const editor = new Editor();
  const layerCanvas = new FakeCanvas(2, 1);
  layerCanvas.data.set([
    160, 160, 160, 255,
    25, 25, 25, 255
  ]);
  const original = Array.from(layerCanvas.data);
  const layer = {
    id: "fixup-1",
    name: "AI Fixup 1",
    kind: "paint",
    canvas: layerCanvas,
    context: layerCanvas.context,
    visible: true
  };
  const stack = {
    layers: [layer],
    activeLayerId: layer.id,
    selectedLayerIds: [layer.id]
  };
  const material = { userData: { texturePaintLayerStack: stack } };
  editor.texturePaintActiveMaterial = material;
  editor.texturePaintLayerKind = (candidate) => candidate?.kind || "paint";
  editor.texturePaintActivePaintLayerForStack = (targetStack) => ({
    stack: targetStack,
    layer: targetStack.layers.find((candidate) => candidate.id === targetStack.activeLayerId)
  });
  editor.textureFixupTintColor = { value: "#c58b57", disabled: false };
  editor.textureFixupTintAmount = { value: "100", disabled: false };
  editor.textureFixupToneRange = { value: "highlights", disabled: false };
  editor.textureFixupHue = { value: "0", disabled: false };
  editor.textureFixupSaturation = { value: "0", disabled: false };
  editor.textureFixupBrightness = { value: "0", disabled: false };
  editor.textureFixupHistogram = new FakeCanvas(240, 72);
  editor.flushTexturePaintPendingBrushWorkBeforeLayerMutation = () => true;
  editor.textureAirbrushSyncDeferredWebGpuCanvases = async () => true;
  editor.flushTexturePaintLayerGpuTargetsToCanvases = async () => true;
  editor.prepareTexturePaintLayerTargetChange = () => true;
  editor.disposeTexturePaintLayerGpuState = () => true;
  editor.texturePaintUpdateLayerEmptyState = () => true;
  editor.discardTexturePaintMaterialAirbrushGpuTarget = () => true;
  editor.invalidateTexturePaintMaterialGpuCaches = () => true;
  editor.texturePaintCompositeMaterialLayers = () => {
    editor.composites = (editor.composites || 0) + 1;
    return true;
  };
  let snapshotSerial = 0;
  editor.captureTexturePaintLayerHistorySnapshot = () => ({ serial: ++snapshotSerial });
  editor.pushTexturePaintLayerUndoState = (label, before, after) => {
    editor.pushedUndo = { label, before, after };
    return true;
  };
  editor.renderTexturePaintLayerPanel = () => true;
  editor.setStatus = (message) => {
    editor.status = message;
  };

  assert.equal(await editor.previewTextureFixupColorGrade(), true);
  assert.ok(layerCanvas.data[0] > layerCanvas.data[1]);
  assert.equal(editor.pushedUndo, undefined);
  assert.equal(editor.cancelTextureFixupColorGrade(), true);
  assert.deepEqual(Array.from(layerCanvas.data), original);

  editor.textureFixupTintAmount.value = "100";
  assert.equal(await editor.previewTextureFixupColorGrade(), true);
  assert.equal(await editor.applyTextureFixupColorGrade(), true);
  assert.ok(layerCanvas.data[0] > layerCanvas.data[1]);
  assert.equal(editor.pushedUndo.label, "Color grade AI Fixup 1");
  assert.equal(editor.pushedUndo.before.serial, 2);
  assert.equal(editor.pushedUndo.after.serial, 3);
  assert.match(editor.status, /Applied color grade to AI Fixup 1/);
});

test("fixup layer kind survives templates, history, and serialization", () => {
  class Editor {}
  installTexturePaintLayerMethods(Editor);
  const editor = new Editor();
  editor.createTexturePaintCanvas = canvasFactory;
  editor.texturePaintMaterialsForRecord = () => [material];
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => true;
  const baseCanvas = new FakeCanvas(4, 4);
  const material = {
    name: "Torso",
    userData: {
      texturePaintLayerStack: {
        width: 4,
        height: 4,
        baseCanvas,
        baseContext: baseCanvas.context,
        layers: [],
        activeLayerId: "",
        selectedLayerIds: [],
        selectionAnchorLayerId: ""
      }
    }
  };
  const stack = material.userData.texturePaintLayerStack;
  const layer = editor.texturePaintNewLayer(stack, {
    id: "mask-1",
    name: "Fixup Mask 1",
    kind: "fixup-mask",
    isEmpty: false
  });
  setPixelAlpha(layer.canvas, 1, 1, 255);
  stack.layers.push(layer);
  stack.activeLayerId = layer.id;
  stack.selectedLayerIds = [layer.id];
  stack.selectionAnchorLayerId = layer.id;
  editor.paintRecords = [{ object: { name: "Torso" } }];

  assert.equal(editor.texturePaintLayerKind(layer), "fixup-mask");
  assert.equal(editor.texturePaintLayerSelectionTemplateFrom(stack, layer).kind, "fixup-mask");
  assert.equal(editor.captureTexturePaintLayerHistorySnapshot(material).layers[0].kind, "fixup-mask");
  assert.equal(editor.serializeTexturePaintLayers()[0].layers[0].kind, "fixup-mask");
});
