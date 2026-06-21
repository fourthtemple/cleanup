import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";

class TestEditor {}

installSceneAndControlMethods(TestEditor, {
  THREE,
  EDIT_ONLY_TOOLS: new Set(["move", "pull", "push"]),
  finitePoseValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
});

function fakeRangeInput() {
  const listeners = new Map();
  const events = [];
  const captures = [];
  const releases = [];
  const input = {
    min: "0.004",
    max: "0.18",
    step: "0.002",
    value: "0.035",
    events,
    captures,
    releases,
    getBoundingClientRect() {
      return {
        left: 20,
        width: 100
      };
    },
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    dispatchEvent(event) {
      events.push(event.type);
      for (const callback of listeners.get(event.type) || []) {
        callback(event);
      }
      return true;
    },
    setPointerCapture(pointerId) {
      captures.push(pointerId);
    },
    releasePointerCapture(pointerId) {
      releases.push(pointerId);
    },
    fire(type, event) {
      for (const callback of listeners.get(type) || []) {
        callback(event);
      }
    }
  };
  return input;
}

function pointerEvent(overrides = {}) {
  return {
    pointerId: 7,
    button: 0,
    isPrimary: true,
    clientX: 20,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      this.prevented += 1;
    },
    stopPropagation() {
      this.stopped += 1;
    },
    ...overrides
  };
}

test("airbrush radius slider pointer fallback updates range value and fires existing events", () => {
  const editor = new TestEditor();
  const input = fakeRangeInput();

  assert.equal(editor.installTextureBrushRadiusPointerFallback(input), true);
  assert.equal(editor.installTextureBrushRadiusPointerFallback(input), false);

  const down = pointerEvent({ clientX: 120 });
  input.fire("pointerdown", down);

  assert.equal(input.value, "0.18");
  assert.deepEqual(input.events, ["input"]);
  assert.deepEqual(input.captures, [7]);
  assert.equal(down.prevented, 1);
  assert.equal(down.stopped, 1);

  const move = pointerEvent({ clientX: 20 });
  input.fire("pointermove", move);

  assert.equal(input.value, "0.004");
  assert.deepEqual(input.events, ["input", "input"]);
  assert.equal(move.prevented, 1);
  assert.equal(move.stopped, 1);

  const up = pointerEvent({ clientX: 20 });
  input.fire("pointerup", up);

  assert.equal(input.value, "0.004");
  assert.deepEqual(input.events, ["input", "input", "change"]);
  assert.deepEqual(input.releases, [7]);
  assert.equal(up.prevented, 1);
  assert.equal(up.stopped, 1);
});
