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

test("live airbrush flush carries remaining batches forward in stroke order", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: event.clientX,
      radiusPixels: options.radiusPixels,
      segments: options.strokeSegments.length
    });
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [4, 6, 8, 10, 12].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.deepEqual(projected.map((call) => call.radiusPixels), [4, 6]);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 3);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 3);

  assert.deepEqual(projected.map((call) => call.radiusPixels), [4, 6, 8, 10, 12]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush paints old pending batches before fresh pointer batches", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };
  const payload = (radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [4, 6, 8].map((radiusPixels, index) => ({
    styleKey: `pending:${radiusPixels}`,
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    strokeSegments: [{
      start: { clientX: index * 8 - 4, clientY: 0 },
      end: { clientX: index * 8, clientY: 0 }
    }]
  }));
  editor.textureAirbrushScreenStrokeQueue = [payload(20, 20), payload(22, 21)];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 1 }), 1);

  assert.deepEqual(projected, [4]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 4);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches.map((batch) => batch.radiusPixels), [6, 8, 20, 22]);
  assert.equal(scheduled, 1);
});

test("live airbrush flush merges compatible pending and fresh batches without reordering", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => [
      segment.start.clientX,
      segment.start.clientY,
      segment.end.clientX,
      segment.end.clientY
    ]));
    return options.strokeSegments.length;
  };
  const style = {
    styleKey: "same-soft-brush",
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true
  };
  const queuedPayload = (startX, endX) => ({
    clientX: endX,
    clientY: 0,
    strokeStart: { clientX: startX, clientY: 0 },
    styleKey: style.styleKey,
    styleRadiusPixels: style.radiusPixels,
    styleColor: style.color,
    styleOpacity: style.opacity,
    styleHardness: style.hardness,
    styleScatter: style.scatter,
    styleStrength: style.strength,
    spacing: style.spacing
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    ...style,
    strokeSegments: [{
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 10, clientY: 0 }
    }]
  }];
  editor.textureAirbrushScreenStrokeQueue = [
    queuedPayload(10, 20),
    queuedPayload(20, 30)
  ];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 1 }), 3);

  assert.deepEqual(projected, [[[0, 0, 10, 0], [10, 0, 20, 0], [20, 0, 30, 0]]]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush keeps fresh small pen batches behind older large pending batches", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };
  const batch = (radiusPixels, index) => ({
    styleKey: `batch:${radiusPixels}`,
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    strokeSegments: [{
      start: { clientX: index * 8 - 4, clientY: 0 },
      end: { clientX: index * 8, clientY: 0 }
    }]
  });
  const payload = (radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [batch(24, 0), batch(28, 1)];
  editor.textureAirbrushScreenStrokeQueue = [payload(6, 20), payload(8, 21)];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.deepEqual(projected, [24, 28]);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches.map((pending) => pending.radiusPixels), [6, 8]);
  assert.equal(scheduled, 1);
});

test("live airbrush flush uses the batch budget and retains ordered large-brush backlog", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [24, 28, 32].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.deepEqual(projected, [24, 28]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);
  assert.deepEqual(editor.textureAirbrushPendingScreenStrokeBatches.map((batch) => batch.radiusPixels), [32]);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 1);

  assert.deepEqual(projected, [24, 28, 32]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush splits oversized batches into ordered chunks", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  const segments = Array.from({ length: 50 }, (_, index) => ({
    start: { clientX: index, clientY: 0 },
    end: { clientX: index + 1, clientY: 0 }
  }));
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "large-live-stroke",
    radiusPixels: 32,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: segments
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 1,
    maxBatchSegments: 16
  }), 16);

  assert.deepEqual(projected, [
    Array.from({ length: 16 }, (_, index) => index)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 3);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 2,
    maxBatchSegments: 16
  }), 32);

  assert.deepEqual(projected, [
    Array.from({ length: 16 }, (_, index) => index),
    Array.from({ length: 16 }, (_, index) => index + 16),
    Array.from({ length: 16 }, (_, index) => index + 32)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 2);

  assert.deepEqual(projected.flat(), Array.from({ length: 50 }, (_, index) => index));
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush yields by segment budget without dropping chunks", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  const segments = Array.from({ length: 45 }, (_, index) => ({
    start: { clientX: index, clientY: 0 },
    end: { clientX: index + 1, clientY: 0 }
  }));
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "segment-budget-stroke",
    radiusPixels: 32,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: segments
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 10,
    maxBatchSegments: 10,
    maxSegments: 20
  }), 20);

  assert.deepEqual(projected, [
    Array.from({ length: 10 }, (_, index) => index),
    Array.from({ length: 10 }, (_, index) => index + 10)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 3);
  assert.equal(scheduled, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 10,
    maxBatchSegments: 10,
    maxSegments: 20
  }), 20);

  assert.deepEqual(projected, [
    Array.from({ length: 10 }, (_, index) => index),
    Array.from({ length: 10 }, (_, index) => index + 10),
    Array.from({ length: 10 }, (_, index) => index + 20),
    Array.from({ length: 10 }, (_, index) => index + 30)
  ]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);

  assert.equal(editor.flushTextureAirbrushScreenStroke(), 5);

  assert.deepEqual(projected.flat(), Array.from({ length: 45 }, (_, index) => index));
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
});

test("live airbrush flush adapts small-brush budgets to avoid smooth stroke backlog", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  const segments = Array.from({ length: 96 }, (_, index) => {
    const t = index / 95;
    return {
      start: {
        clientX: index,
        clientY: Math.sin(t * Math.PI * 2) * 18
      },
      end: {
        clientX: index + 1,
        clientY: Math.sin((index + 1) / 95 * Math.PI * 2) * 18
      }
    };
  });
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "small-brush-smooth-stroke",
    radiusPixels: 8,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: segments
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 96);

  assert.deepEqual(projected.flat(), Array.from({ length: 96 }, (_, index) => index));
  assert.deepEqual(projected.map((chunk) => chunk.length), [96]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  assert.equal(scheduled, 0);
});

test("live airbrush flush keeps large-brush adaptive budgets conservative", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.strokeSegments.map((segment) => segment.start.clientX));
    return options.strokeSegments.length;
  };
  editor.textureAirbrushPendingScreenStrokeBatches = [{
    styleKey: "large-brush-stroke",
    radiusPixels: 32,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    pressureApplied: true,
    strokeSegments: Array.from({ length: 96 }, (_, index) => ({
      start: { clientX: index, clientY: 0 },
      end: { clientX: index + 1, clientY: 0 }
    }))
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 48);

  assert.deepEqual(projected.flat(), Array.from({ length: 48 }, (_, index) => index));
  assert.deepEqual(projected.map((chunk) => chunk.length), [24, 24]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 2);
  assert.equal(scheduled, 1);
});

test("live airbrush flush reuses one WebGL projection frame for same-frame batches", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const backend = { backend: "webgl", webGpuStatus: "not-requested" };
  const frame = { marker: "projection-frame" };
  const projectedFrames = [];
  const projectedBackends = [];
  let frameCalls = 0;
  let backendCalls = 0;
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushResolveBackend = (options) => {
    backendCalls += 1;
    assert.deepEqual(options, { gpu: true });
    return backend;
  };
  editor.textureAirbrushGpuProjectionFrame = () => {
    frameCalls += 1;
    return frame;
  };
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projectedFrames.push(options.projectionFrame);
    projectedBackends.push(options.resolvedBackend);
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [4, 6, 8].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 2 }), 2);

  assert.equal(backendCalls, 1);
  assert.equal(frameCalls, 1);
  assert.deepEqual(projectedFrames, [frame, frame]);
  assert.deepEqual(projectedBackends, [backend, backend]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 1);
  assert.equal(scheduled, 1);
});

test("layer GPU live airbrush flush requests a lightweight projection frame", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const backend = { backend: "webgl", webGpuStatus: "not-requested" };
  const frame = { marker: "layer-lightweight-frame" };
  const frameOptions = [];
  const projectedOptions = [];
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushResolveBackend = () => backend;
  editor.textureAirbrushGpuLayerTargetForMaterial = () => ({});
  editor.textureAirbrushLiveProjectionFrame = (options) => {
    frameOptions.push(options);
    return frame;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projectedOptions.push(options);
    return options.strokeSegments.length;
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 8,
    clientY: 0,
    strokeStart: { clientX: 0, clientY: 0 },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    spacing: 1,
    strength: 1,
    erase: false,
    layerMode: true
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  assert.deepEqual(frameOptions, [{ seedLayerProxies: false, seedPaintPasses: false }]);
  assert.equal(projectedOptions.length, 1);
  assert.equal(projectedOptions[0].projectionFrame, frame);
  assert.equal(projectedOptions[0].deferLayerComposite, true);
});

test("single-batch live airbrush flush still uses the shared WebGL projection frame", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const backend = { backend: "webgl", webGpuStatus: "not-requested" };
  const frame = { marker: "projection-frame" };
  let backendCalls = 0;
  let frameCalls = 0;
  let projectedFrame = null;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushResolveBackend = (options) => {
    backendCalls += 1;
    assert.deepEqual(options, { gpu: true });
    return backend;
  };
  editor.textureAirbrushLiveProjectionFrame = () => {
    frameCalls += 1;
    return frame;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projectedFrame = options.projectionFrame;
    return options.strokeSegments.length;
  };
  editor.textureAirbrushScreenStrokeQueue = [{
    clientX: 8,
    clientY: 0,
    strokeStart: { clientX: 0, clientY: 0 },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }];

  assert.equal(editor.flushTextureAirbrushScreenStroke({ live: true }), 1);

  assert.equal(backendCalls, 1);
  assert.equal(frameCalls, 1);
  assert.equal(projectedFrame, frame);
});

test("live airbrush flush yields when the frame time budget is spent", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const projected = [];
  let scheduled = 0;
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      x: event.clientX,
      radiusPixels: options.radiusPixels,
      segments: options.strokeSegments.length
    });
    return options.strokeSegments.length;
  };

  editor.textureAirbrushScreenStrokeQueue = [4, 6, 8].map((radiusPixels, index) => ({
    clientX: index * 8,
    clientY: 0,
    strokeStart: { clientX: index * 8 - 4, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  }));

  assert.equal(editor.flushTextureAirbrushScreenStroke({
    live: true,
    maxBatches: 10,
    maxBatchMs: 0
  }), 1);

  assert.deepEqual(projected.map((call) => call.radiusPixels), [4]);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 2);
  assert.equal(scheduled, 1);
});

test("scheduled live airbrush flush projects pending batches in order", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const originalWindow = globalThis.window;
  let animationFrameCallback = null;
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        animationFrameCallback = callback;
        return 1;
      }
    };
    const projected = [];
    editor.textureAirbrushScreenStrokeQueue = [];
    editor.textureAirbrushPendingScreenStrokeBatches = [{
      strokeSegments: [{
        start: { clientX: 0, clientY: 0 },
        end: { clientX: 8, clientY: 0 }
      }],
      radiusPixels: 4,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1
    }];
    editor.clearTextureAirbrushScreenLayer = () => {};
    editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
      projected.push(options.radiusPixels);
      return options.strokeSegments.length;
    };

    assert.equal(editor.scheduleTextureAirbrushScreenStrokeFlush(), true);
    assert.deepEqual(projected, []);
    assert.equal(typeof animationFrameCallback, "function");

    animationFrameCallback();

    assert.deepEqual(projected, [4]);
    assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("scheduled first layer flush does not put readiness checks before queued paint", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  const originalWindow = globalThis.window;
  const calls = [];
  let animationFrameCallback = null;
  try {
    globalThis.window = {
      requestAnimationFrame(callback) {
        animationFrameCallback = callback;
        return 1;
      }
    };
    editor.textureAirbrushCameraPrewarmScheduled = true;
    editor.texturePaintLayerMutationSerialValue = () => 3;
    editor.textureAirbrushScreenStrokeQueue = [{
      clientX: 12,
      clientY: 8,
      strokeStart: { clientX: 10, clientY: 8 },
      radiusPixels: 8,
      color: { r: 255, g: 0, b: 0 },
      opacity: 0.42,
      hardness: 0.35,
      scatter: 0.35,
      strength: 1,
      spacing: 1,
      erase: false,
      layerMode: true,
      strokeReset: true,
      layerMutationSerial: 3
    }];
    editor.textureAirbrushPrewarmStableCameraFrame = () => {
      throw new Error("layer paint should not run broad camera prewarm before the first flush");
    };
    editor.activeTool = "airbrush";
    editor.texturePaintLayerModeActive = () => true;
    editor.texturePaintActiveMaterial = "active-layer-material";
    editor.textureAirbrushLayerTargetReadyForLiveReset = (material) => {
      throw new Error(`queued layer paint should not run ready checks before the first flush for ${material}`);
    };
    editor.prewarmTexturePaintActiveLayerMaterialGpu = () => {
      throw new Error("ready layer paint should not prewarm before the first flush");
    };
    editor.prewarmTexturePaintActiveLayerGpu = (material, options) => {
      throw new Error("ready layer paint should not run broad prewarm before the first flush");
    };
    editor.flushTextureAirbrushScreenStroke = (options) => {
      calls.push(`flush:${options?.live === true ? "live" : "full"}`);
      editor.textureAirbrushScreenStrokeQueue = [];
      return 1;
    };

    assert.equal(editor.scheduleTextureAirbrushScreenStrokeFlush(), true);
    animationFrameCallback();

    assert.equal(editor.textureAirbrushCameraPrewarmScheduled, false);
    assert.equal(editor.textureAirbrushCameraPrewarmStableFrames, 0);
    assert.deepEqual(calls, ["flush:live"]);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});
