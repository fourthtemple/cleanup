import assert from "node:assert/strict";
import test from "node:test";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";

class TestEditor {}

installPaintToolMethods(TestEditor, {});

test("selection pen strokes throttle heavy refresh work until stroke finalization", () => {
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frameCallbacks = [];
  globalThis.requestAnimationFrame = (callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const editor = new TestEditor();
    const calls = {
      colors: 0,
      counts: 0,
      markers: 0,
      moves: 0,
      patches: 0,
      statuses: []
    };
    editor.viewMode = "weight";
    editor.paintRecords = [{ selected: new Set() }];
    editor.updateRecordColors = () => {
      calls.colors += 1;
    };
    editor.updateCounts = () => {
      calls.counts += 1;
    };
    editor.updateSelectionMarkers = () => {
      calls.markers += 1;
    };
    editor.updateMoveGizmo = () => {
      calls.moves += 1;
    };
    editor.syncPatchJson = () => {
      calls.patches += 1;
    };
    editor.refreshClonePaintTargetFromSelection = () => 0;
    editor.setStatus = (message) => {
      calls.statuses.push(message);
    };

    editor.beginSelectionStrokeUndo("Paint stroke");
    assert.equal(editor.queueSelectionPaintChange(2, "paint"), true);
    assert.equal(editor.queueSelectionPaintChange(3, "paint"), true);
    assert.equal(frameCallbacks.length, 1);
    assert.deepEqual(calls, {
      colors: 0,
      counts: 0,
      markers: 0,
      moves: 0,
      patches: 0,
      statuses: []
    });

    frameCallbacks.shift()();
    assert.equal(calls.colors, 1);
    assert.equal(calls.markers, 1);
    assert.equal(calls.patches, 0);
    assert.equal(calls.counts, 0);
    assert.equal(calls.moves, 0);
    assert.deepEqual(calls.statuses, []);

    assert.equal(editor.flushSelectionStrokeFinalChange(), true);
    assert.equal(calls.patches, 1);
    assert.equal(calls.counts, 1);
    assert.equal(calls.moves, 1);
    assert.deepEqual(calls.statuses, ["Selected 5 vertices"]);
    assert.equal(editor.selectionStrokeUndo.changed, true);
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});
