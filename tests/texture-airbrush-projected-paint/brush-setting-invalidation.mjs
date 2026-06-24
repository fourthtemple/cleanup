import assert from "node:assert/strict";
import test from "node:test";
import { installPaintToolMethods } from "../../src/weight-editor/paint-tools.js";
import { installTextureAirbrushScreenStrokeMethods } from "../../src/weight-editor/airbrush/screen-strokes.js";

test("airbrush brush-setting changes clear cached radius and sampling state", () => {
  class SettingsEditor {}
  installPaintToolMethods(SettingsEditor, {});
  installTextureAirbrushScreenStrokeMethods(SettingsEditor);
  const editor = new SettingsEditor();
  const event = { clientX: 12, clientY: 18 };
  const hit = { record: { id: "body" } };
  let liveResetOptions = null;
  let prewarmCall = null;

  editor.activeTool = "airbrush";
  editor.painting = false;
  editor.lastBrushCursorEvent = event;
  editor.textureAirbrushInputSamplingCache = { radiusPixels: 10, sampleStep: 6 };
  editor.textureAirbrushStrokeBrushState = { radiusPixels: 10 };
  editor.textureAirbrushStrokeSpacingState = { distanceUntilNext: 4 };
  editor.textureAirbrushStrokePressureState = { pressure: 0.5 };
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHitForEvent = (candidateEvent, tool) => {
    assert.equal(candidateEvent, event);
    assert.equal(tool, "airbrush");
    return hit;
  };
  editor.textureAirbrushResetLiveProjectionFrame = (options) => {
    liveResetOptions = options;
  };
  editor.scheduleTextureAirbrushPrewarm = (candidateEvent, candidateHit, options) => {
    prewarmCall = { event: candidateEvent, hit: candidateHit, options };
    return true;
  };

  assert.equal(editor.textureAirbrushInvalidateBrushSettings(), true);

  assert.equal(editor.textureAirbrushInputSamplingCache, null);
  assert.equal(editor.textureAirbrushStrokeBrushState, null);
  assert.equal(editor.textureAirbrushStrokeSpacingState, null);
  assert.equal(editor.textureAirbrushStrokePressureState, null);
  assert.deepEqual(liveResetOptions, { keepCurrent: true });
  assert.deepEqual(prewarmCall, {
    event,
    hit,
    options: { preserveLayerDisplay: true }
  });
});

test("layer strokes only use variable radius for real pressure pointers", () => {
  class StrokeEditor {}
  installTextureAirbrushScreenStrokeMethods(StrokeEditor);
  const editor = new StrokeEditor();
  editor.activeTool = "airbrush";
  editor.model = {};
  editor.canvas = {};
  editor.texturePaintLayerModeActive = () => true;
  editor.texturePaintHasActivePaintLayer = () => true;
  editor.texturePaintLayerMutationSerialValue = () => 1;
  editor.textureBrushRadiusScreenPixels = () => 20;
  editor.textureAirbrushOpacity = () => 0.5;
  editor.textureAirbrushHardness = () => 0.35;
  editor.textureAirbrushScatter = () => 0.25;
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushColor = () => ({ r: 255, g: 0, b: 0 });
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false, hardness: false, scatter: false });
  editor.textureAirbrushOptionsWithPressure = (event, options) => ({
    ...options,
    pressure: event?.pressure ?? 1,
    pressureRadius: true,
    pressureApplied: true
  });

  const mousePayload = editor.textureAirbrushScreenStrokePayload(
    { clientX: 20, clientY: 0, pointerType: "mouse", pressure: 0.5 },
    { clientX: 0, clientY: 0 }
  );
  const [mouseBatch] = editor.textureAirbrushScreenStrokeBatches([mousePayload]);

  assert.equal(mousePayload.pressurePointer, false);
  assert.equal(mouseBatch.strokeSegments[0].radiusPixels, undefined);

  const pointerPressurePayload = editor.textureAirbrushScreenStrokePayload(
    { type: "pointermove", clientX: 30, clientY: 0, pointerType: "mouse", pressure: 0.35 },
    { clientX: 10, clientY: 0 }
  );
  const [pointerPressureBatch] = editor.textureAirbrushScreenStrokeBatches([pointerPressurePayload]);

  assert.equal(pointerPressurePayload.pressurePointer, true);
  assert.equal(pointerPressureBatch.strokeSegments[0].radiusPixels, 20);

  const penPayload = editor.textureAirbrushScreenStrokePayload(
    { clientX: 40, clientY: 0, pointerType: "pen", pressure: 0.5 },
    { clientX: 20, clientY: 0 }
  );
  const [penBatch] = editor.textureAirbrushScreenStrokeBatches([penPayload]);

  assert.equal(penPayload.pressurePointer, true);
  assert.equal(penBatch.strokeSegments[0].radiusPixels, 20);

  class SafariMouseEvent {}
  SafariMouseEvent.WEBKIT_FORCE_AT_MOUSE_DOWN = 1;
  SafariMouseEvent.WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN = 2;
  const safariPayload = editor.textureAirbrushScreenStrokePayload(
    {
      constructor: SafariMouseEvent,
      clientX: 60,
      clientY: 0,
      pointerType: "mouse",
      pressure: 0.5,
      webkitForce: 0.25
    },
    { clientX: 40, clientY: 0 }
  );
  const [safariBatch] = editor.textureAirbrushScreenStrokeBatches([safariPayload]);

  assert.equal(safariPayload.pressurePointer, true);
  assert.equal(safariBatch.strokeSegments[0].radiusPixels, 20);
});

test("exact first layer display refresh waits until active painting stops", () => {
  class RefreshEditor {}
  installTextureAirbrushScreenStrokeMethods(RefreshEditor);
  const editor = new RefreshEditor();
  let flushed = 0;
  let reset = 0;
  editor.texturePaintNeedsExactFirstPaintDisplayRefresh = true;
  editor.painting = true;
  editor.textureAirbrushScreenStrokeHasPendingWork = () => false;
  editor.resetTexturePaintLayerDisplayCaches = () => {
    reset += 1;
  };
  editor.bumpTexturePaintLayerMutationSerial = () => {};
  editor.forceTexturePaintExactLayerDisplay = () => {};
  editor.textureAirbrushResetLiveProjectionFrame = () => {};
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    flushed += 1;
    return 1;
  };

  assert.equal(editor.flushTexturePaintExactFirstPaintDisplayRefresh(), false);
  assert.equal(editor.texturePaintNeedsExactFirstPaintDisplayRefresh, true);
  assert.equal(flushed, 0);
  assert.equal(reset, 0);

  editor.painting = false;
  assert.equal(editor.flushTexturePaintExactFirstPaintDisplayRefresh(), true);
  assert.equal(editor.texturePaintNeedsExactFirstPaintDisplayRefresh, false);
  assert.equal(flushed, 1);
  assert.equal(reset, 1);
});
