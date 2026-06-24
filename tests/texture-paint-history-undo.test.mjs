import assert from "node:assert/strict";
import test from "node:test";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";

test("texture paint undo finalization exposes a promise while screen work drains", async () => {
  class PaintEditor {}
  installPaintToolMethods(PaintEditor, {});
  const editor = new PaintEditor();
  let resolveScreenFlush = null;
  let finalized = false;
  const screenFlush = new Promise((resolve) => {
    resolveScreenFlush = resolve;
  });
  editor.finishTextureAirbrushScreenStrokeFlush = () => screenFlush;
  editor.finalizeTexturePaintStrokeUndo = (stroke) => {
    finalized = true;
    assert.equal(stroke.label, "Texture airbrush");
    return true;
  };
  editor.texturePaintStrokeUndo = {
    label: "Texture airbrush",
    changed: true,
    touched: new Map(),
    before: [{}]
  };

  const stroke = editor.texturePaintStrokeUndo;
  assert.equal(editor.endTexturePaintStrokeUndo(), false);
  assert.equal(editor.texturePaintStrokeUndo, null);
  assert.equal(editor.texturePaintPendingStrokeUndoFinalizations.has(stroke), true);
  assert.equal(typeof stroke.finalizationPromise?.then, "function");

  let promiseSettled = false;
  stroke.finalizationPromise.then(() => {
    promiseSettled = true;
  });
  const historyWait = editor.texturePaintSettlePendingUndoBeforeHistory();
  assert.equal(typeof historyWait?.then, "function");
  await Promise.resolve();
  assert.equal(finalized, false);
  assert.equal(promiseSettled, false);

  resolveScreenFlush();
  await historyWait;
  await Promise.resolve();
  assert.equal(finalized, true);
  assert.equal(promiseSettled, true);
  assert.equal(editor.texturePaintPendingStrokeUndoFinalizations.has(stroke), false);
});

test("undo waits for pending texture paint before popping history", async () => {
  class HistoryEditor {}
  installPaintToolMethods(HistoryEditor, {});
  installSceneAndControlMethods(HistoryEditor, {});
  const editor = new HistoryEditor();
  const previousLayerState = {
    kind: "texture-layer",
    label: "Add Paint 1"
  };
  const paintState = {
    kind: "texture-paint",
    label: "Texture airbrush",
    entries: ["paint-entry"]
  };
  let resolveFinalization = null;
  const pendingStroke = {
    finalizationPromise: new Promise((resolve) => {
      resolveFinalization = resolve;
    })
  };
  editor.undoStack = [previousLayerState];
  editor.redoStack = [];
  editor.maxUndoSteps = 40;
  editor.texturePaintPendingStrokeUndoFinalizations = new Set([pendingStroke]);
  editor.updateUndoButton = () => {};
  editor.setStatus = () => {};
  let restored = null;
  editor.restoreTexturePaintSnapshot = (entries, field) => {
    restored = { entries, field };
    return true;
  };
  editor.restoreTexturePaintLayerHistorySnapshot = () => {
    throw new Error("undo should not pop the older layer state first");
  };

  assert.equal(editor.undoLastEdit(), false);
  assert.equal(editor.historyRestoreBusy, true);
  assert.deepEqual(editor.undoStack, [previousLayerState]);
  assert.deepEqual(editor.redoStack, []);

  editor.undoStack.push(paintState);
  editor.texturePaintPendingStrokeUndoFinalizations.delete(pendingStroke);
  resolveFinalization(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(restored, {
    entries: ["paint-entry"],
    field: "before"
  });
  assert.equal(editor.historyRestoreBusy, false);
  assert.deepEqual(editor.undoStack, [previousLayerState]);
  assert.deepEqual(editor.redoStack, [paintState]);
});
