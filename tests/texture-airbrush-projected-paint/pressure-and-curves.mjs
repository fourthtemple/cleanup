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

test("airbrush coalesces repeated same-style continuous moves before flushing", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  let scheduled = 0;
  let pressureCalls = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushContinuousSampleStepPixels = () => 50;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => {
    pressureCalls += 1;
    return options;
  };
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0 }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({ clientX: 2, clientY: 0 });
  const continuousPayload = editor.textureAirbrushScreenStrokeQueue[1];
  for (let index = 2; index <= 30; index += 1) {
    editor.queueAirbrushTextureStrokeEvent({ clientX: index * 2, clientY: 0 });
  }

  assert.equal(scheduled, 1);
  assert.equal(pressureCalls, 2);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
  assert.equal(editor.textureAirbrushScreenStrokeQueue[1], continuousPayload);
  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue.map((payload) => ({
    startX: payload.strokeStart.clientX,
    endX: payload.clientX
  })), [
    { startX: 0, endX: 0 },
    { startX: 0, endX: 60 }
  ]);
});

test("airbrush queue coalescing preserves bends", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushContinuousSampleStepPixels = () => 50;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  [
    { clientX: 0, clientY: 0, reset: true },
    { clientX: 10, clientY: 0 },
    { clientX: 20, clientY: 0 },
    { clientX: 24, clientY: 18 }
  ].forEach((point) => {
    editor.queueAirbrushTextureStrokeEvent(point, { reset: point.reset === true });
  });

  assert.deepEqual(editor.textureAirbrushScreenStrokeQueue.map((payload) => ({
    start: payload.strokeStart,
    end: { clientX: payload.clientX, clientY: payload.clientY }
  })), [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 0, clientY: 0 }
    },
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 20, clientY: 0 }
    },
    {
      start: { clientX: 20, clientY: 0 },
      end: { clientX: 24, clientY: 18 }
    }
  ]);
});

test("airbrush low spacing applies pen pressure once per queued continuous sample", () => {
  class SpacingEditor {}
  installPaintToolMethods(SpacingEditor, {});
  installTextureAirbrushScreenStrokeMethods(SpacingEditor);
  const editor = new SpacingEditor();
  let pressureCalls = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushContinuousSampleStepPixels = () => 50;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;
  editor.textureAirbrushOptionsWithPressure = (event, options) => {
    pressureCalls += 1;
    return {
      ...options,
      pressure: event.pressure,
      pressureRadius: true,
      radiusPixels: options.radiusPixels * event.pressure,
      pressureApplied: true
    };
  };

  editor.queueAirbrushTextureStrokeEvent({
    clientX: 0,
    clientY: 0,
    pointerType: "pen",
    pressure: 0.5
  }, { reset: true });
  editor.queueAirbrushTextureStrokeEvent({
    clientX: 12,
    clientY: 0,
    pointerType: "pen",
    pressure: 0.6
  });

  assert.equal(pressureCalls, 2);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 2);
});

test("airbrush screen batches preserve queued straight strokes and bends", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const segment = (startX, startY, endX, endY) => ({
    clientX: endX,
    clientY: endY,
    strokeStart: { clientX: startX, clientY: startY },
    radiusPixels: 10,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });

  const [batch] = editor.textureAirbrushScreenStrokeBatches([
    segment(0, 0, 10, 0),
    segment(10, 0, 20, 0),
    segment(20, 0, 30, 0),
    segment(30, 0, 30, 16)
  ]);

  assert.deepEqual(batch.strokeSegments.map((entry) => ({
    start: entry.start,
    end: entry.end
  })), [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 10, clientY: 0 }
    },
    {
      start: { clientX: 10, clientY: 0 },
      end: { clientX: 20, clientY: 0 }
    },
    {
      start: { clientX: 20, clientY: 0 },
      end: { clientX: 30, clientY: 0 }
    },
    {
      start: { clientX: 30, clientY: 0 },
      end: { clientX: 30, clientY: 16 }
    }
  ]);
});

test("airbrush batches tolerate tiny pen pressure radius jitter without merging queued segments", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });

  const segment = (startX, endX, radiusPixels) => ({
    clientX: endX,
    clientY: 0,
    strokeStart: { clientX: startX, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 0, b: 0 },
    opacity: 0.421,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1
  });

  const batches = editor.textureAirbrushScreenStrokeBatches([
    segment(0, 8, 7.82),
    segment(8, 16, 8.11),
    segment(16, 24, 8.36)
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].radiusPixels, 8);
  assert.deepEqual(batches[0].strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 8, clientY: 0 }
    },
    {
      start: { clientX: 8, clientY: 0 },
      end: { clientX: 16, clientY: 0 }
    },
    {
      start: { clientX: 16, clientY: 0 },
      end: { clientX: 24, clientY: 0 }
    }
  ]);
});

test("airbrush stabilizes tiny pen pressure radius jitter before batching", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  editor.queueAirbrushTextureStrokeEvent({ clientX: 0, clientY: 0, pointerType: "pen", pressure: 0.44 }, { reset: true });
  for (let index = 1; index <= 8; index += 1) {
    editor.queueAirbrushTextureStrokeEvent({
      clientX: index * 4,
      clientY: 0,
      pointerType: "pen",
      pressure: index % 2 === 0 ? 0.44 : 0.47
    });
  }

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].radiusPixels, 4);
  assert.deepEqual(batches[0].strokeSegments, [
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 0, clientY: 0 }
    },
    {
      start: { clientX: 0, clientY: 0 },
      end: { clientX: 32, clientY: 0 }
    }
  ]);
});

test("airbrush pressure radius stabilization keeps meaningful pressure changes", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  [
    { clientX: 0, pressure: 0.3, reset: true },
    { clientX: 8, pressure: 0.32 },
    { clientX: 16, pressure: 0.56 },
    { clientX: 24, pressure: 0.58 },
    { clientX: 32, pressure: 0.86 }
  ].forEach((sample) => {
    editor.queueAirbrushTextureStrokeEvent({
      clientX: sample.clientX,
      clientY: 0,
      pointerType: "pen",
      pressure: sample.pressure
    }, { reset: sample.reset === true });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  assert.deepEqual(batches.map((batch) => batch.radiusPixels), [3, 6, 9]);
});

test("layer pressure radius at low spacing stays in one variable-radius batch", () => {
  class BatchEditor {}
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.textureBrushRadiusScreenPixels = () => 10;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 255, b: 0 });

  const segment = (startX, endX, radiusPixels) => ({
    clientX: endX,
    clientY: 0,
    strokeStart: { clientX: startX, clientY: 0 },
    radiusPixels,
    color: { r: 255, g: 255, b: 0 },
    opacity: 0.42,
    hardness: 0.35,
    scatter: 0.35,
    strength: 1,
    spacing: 1,
    pressureRadius: true,
    erase: false,
    layerMode: true
  });

  const batches = editor.textureAirbrushScreenStrokeBatches([
    segment(0, 8, 4),
    segment(8, 16, 7),
    segment(16, 24, 11)
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].radiusPixels, 11);
  assert.deepEqual(batches[0].strokeSegments.map((entry) => entry.radiusPixels), [4, 7, 11]);
  assert.deepEqual(batches[0].strokeSegments.map((entry) => ({
    startX: entry.start.clientX,
    endX: entry.end.clientX
  })), [
    { startX: 0, endX: 8 },
    { startX: 8, endX: 16 },
    { startX: 16, endX: 24 }
  ]);
});

test("airbrush large brush pressure jitter stays bounded", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 72;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    editor.textureAirbrushScreenFlushScheduled = true;
    return true;
  };

  const sampleCount = 600;
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / (sampleCount - 1);
    editor.queueAirbrushTextureStrokeEvent({
      clientX: 80 + t * 1000,
      clientY: 240 + Math.sin(t * Math.PI * 4) * 80,
      pointerType: "pen",
      pressure: 0.15 + t * 0.85 + (index % 2 === 0 ? -0.03 : 0.03)
    }, { reset: index === 0 });
  }

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.length <= 14, true);
  assert.equal(batches.length <= 14, true);
  assert.equal(segmentCount <= 18, true);
  assert.equal(batches.at(-1).radiusPixels > batches[0].radiusPixels, true);
});

test("airbrush ignores rapid pen pressure reversals while keeping pressure trends", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  Array.from({ length: 1200 }, (_, index) => {
    const t = index / 1199;
    return {
      clientX: 100 + t * 540,
      clientY: 260 + Math.sin(t * Math.PI * 3.5) * 78,
      pointerType: "pen",
      pressure: 0.45 + t * 0.24 + (index % 2 === 0 ? -0.07 : 0.07)
    };
  }).forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.length <= 8, true);
  assert.equal(batches.length <= 8, true);
  assert.equal(segmentCount <= 12, true);
  assert.equal(batches.at(-1).radiusPixels > batches[0].radiusPixels, true);
});

test("airbrush bounds subpixel pen pressure spikes by stroke distance", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 32;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  Array.from({ length: 600 }, (_, index) => {
    const t = index / 599;
    return {
      clientX: 100 + t * 540,
      clientY: 260 + Math.sin(t * Math.PI * 3.5) * 78,
      pointerType: "pen",
      pressure: index % 2 === 0 ? 0.85 : 0.25
    };
  }).forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);

  assert.equal(editor.textureAirbrushScreenStrokeQueue.length <= 64, true);
  assert.equal(batches.length <= 64, true);
  assert.equal(segmentCount <= 64, true);
  assert.equal(batches.some((batch) => batch.radiusPixels <= 10), true);
  assert.equal(batches.some((batch) => batch.radiusPixels >= 24), true);
});

test("airbrush keeps long high-frequency curved pen strokes bounded", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 18;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    if (editor.textureAirbrushScreenFlushScheduled) {
      return false;
    }
    editor.textureAirbrushScreenFlushScheduled = true;
    scheduled += 1;
    return true;
  };

  const samples = Array.from({ length: 97 }, (_, index) => {
    const t = index / 96;
    const jitter = index % 2 === 0 ? 0.012 : -0.012;
    return {
      clientX: 80 + index * 3.2,
      clientY: 160 + Math.sin(t * Math.PI * 1.65) * 46,
      pointerType: "pen",
      pressure: 0.38 + t * 0.32 + jitter
    };
  });

  samples.forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segmentCount = batches.reduce((total, batch) => total + batch.strokeSegments.length, 0);
  const nonZeroSegments = batches.flatMap((batch) => batch.strokeSegments).filter((segment) => (
    Math.abs(segment.end.clientX - segment.start.clientX) > 0.001
    || Math.abs(segment.end.clientY - segment.start.clientY) > 0.001
  ));

  assert.equal(scheduled < samples.length, true);
  assert.equal(batches.length <= 6, true);
  assert.equal(segmentCount <= 24, true);
  assert.equal(nonZeroSegments.length >= 6, true);
  assert.equal(batches.some((batch) => batch.strokeSegments.some((segment) => (
    Math.abs(segment.end.clientY - segment.start.clientY) > 10
  ))), true);

  const projected = [];
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push({
      clientX: event.clientX,
      segmentCount: options.strokeSegments.length,
      radiusPixels: options.radiusPixels
    });
    return options.strokeSegments.length;
  };

  const changed = editor.flushTextureAirbrushScreenStroke();

  assert.equal(projected.length, batches.length);
  assert.equal(changed, segmentCount);
  assert.equal(projected.every((call) => call.segmentCount <= 24), true);
  assert.equal(editor.textureAirbrushScreenStrokeQueue.length, 0);
});

test("airbrush continuous coalescing preserves natural curved pen stroke shape", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => options;
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => true;

  const samples = Array.from({ length: 360 }, (_, index) => {
    const t = index / 359;
    const angle = t * Math.PI * 1.65;
    const radius = 20 + t * 145;
    return {
      clientX: 330 + Math.cos(angle) * radius,
      clientY: 300 + Math.sin(angle) * radius,
      pointerType: "pen",
      pressure: 0.5
    };
  });
  samples.forEach((sample, index) => {
    editor.queueAirbrushTextureStrokeEvent(sample, { reset: index === 0 });
  });

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const segments = batches.flatMap((batch) => batch.strokeSegments);
  const pointToSegmentDistance = (point, start, end) => {
    const dx = end.clientX - start.clientX;
    const dy = end.clientY - start.clientY;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 0.000001) {
      return Math.hypot(point.clientX - start.clientX, point.clientY - start.clientY);
    }
    const ratio = Math.max(
      0,
      Math.min(
        1,
        ((point.clientX - start.clientX) * dx + (point.clientY - start.clientY) * dy) / lengthSq
      )
    );
    return Math.hypot(
      point.clientX - (start.clientX + dx * ratio),
      point.clientY - (start.clientY + dy * ratio)
    );
  };
  const maxCurveError = Math.max(...samples.map((sample) => Math.min(
    ...segments.map((segment) => pointToSegmentDistance(sample, segment.start, segment.end))
  )));

  assert.equal(batches.length, 1);
  assert.equal(segments.length <= 24, true);
  assert.equal(segments.length >= 12, true);
  assert.equal(maxCurveError < 6, true);
});

test("airbrush radius-pressure pen strokes avoid excessive live projection passes", () => {
  class BatchEditor {}
  installPaintToolMethods(BatchEditor, {});
  installTextureAirbrushScreenStrokeMethods(BatchEditor);
  const editor = new BatchEditor();
  let scheduled = 0;
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.textureBrushRadiusScreenPixels = () => 36;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushOpacity = () => 0.42;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.35;
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event.pressure,
    pressureRadius: true,
    radiusPixels: options.radiusPixels * event.pressure,
    pressureApplied: true
  });
  editor.scheduleTextureAirbrushScreenStrokeFlush = () => {
    scheduled += 1;
    return true;
  };

  const sampleCount = 2400;
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / (sampleCount - 1);
    editor.queueAirbrushTextureStrokeEvent({
      clientX: 120 + t * 980,
      clientY: 260 + Math.sin(t * Math.PI * 6) * 115 + Math.sin(t * Math.PI * 29) * 4,
      pointerType: "pen",
      pressure: 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * Math.PI * 1.4)) + Math.sin(t * Math.PI * 37) * 0.025
    }, { reset: index === 0 });
  }

  const batches = editor.textureAirbrushScreenStrokeBatches(editor.textureAirbrushScreenStrokeQueue);
  const projected = [];
  let liveFrames = 0;
  editor.clearTextureAirbrushScreenLayer = () => {};
  editor.textureAirbrushProjectedMeshFromEvent = (event, options) => {
    projected.push(options.radiusPixels);
    return options.strokeSegments.length;
  };
  while (editor.textureAirbrushScreenStrokeQueue?.length || editor.textureAirbrushPendingScreenStrokeBatches?.length) {
    editor.textureAirbrushScreenFlushScheduled = false;
    editor.flushTextureAirbrushScreenStroke({ live: true, maxBatches: 4, maxBatchMs: 999 });
    liveFrames += 1;
  }

  assert.equal(scheduled < sampleCount, true);
  assert.equal(batches.length <= 6, true);
  assert.equal(projected.length <= 6, true);
  assert.equal(liveFrames <= 2, true);
  assert.equal(editor.textureAirbrushPendingScreenStrokeBatches.length, 0);
  assert.equal(Math.max(...projected) - Math.min(...projected) >= 14, true);
});
