import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installTextureAirbrushMethods } from "../src/weight-editor/airbrush/index.js";

class TestEditor {}

installTextureAirbrushMethods(TestEditor, { THREE });

function editorWithBrushControls() {
  const editor = new TestEditor();
  editor.textureBrushRadius = { value: "0.1" };
  editor.textureBrushSpacing = { value: "1" };
  editor.textureBrushOpacity = { value: "0.8" };
  editor.textureBrushHardness = { value: "0.5" };
  editor.textureBrushScatter = { value: "0.6" };
  editor.texturePressureRadius = { checked: true };
  editor.texturePressureOpacity = { checked: true };
  return editor;
}

function closeTo(actual, expected, tolerance = 0.000001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be close to ${expected}`);
}

test("airbrush pressure scales only enabled brush parameters", () => {
  const editor = editorWithBrushControls();
  const options = editor.textureAirbrushOptionsWithPressure({
    pressure: 0.25,
    pointerType: "pen"
  }, {
    hardness: 0.5,
    scatter: 0.6
  });

  assert.equal(options.pressureApplied, true);
  assert.equal(options.pressureRadius, true);
  assert.equal(options.pressureOpacity, true);
  assert.equal(options.pressureHardness, false);
  assert.equal(options.pressureScatter, false);
  closeTo(options.pressure, 0.25);
  closeTo(options.radiusPixels, 5.5);
  closeTo(options.opacity, 0.2);
  closeTo(options.hardness, 0.5);
  closeTo(options.scatter, 0.6);
});

test("airbrush pressure ignores mouse default pressure", () => {
  const editor = editorWithBrushControls();
  const options = editor.textureAirbrushOptionsWithPressure({
    pressure: 0.5,
    pointerType: "mouse"
  }, {
    opacity: 0.8
  });

  closeTo(options.pressure, 1);
  closeTo(options.opacity, 0.8);
});

test("airbrush spacing maps percentage of brush diameter to screen pixels", () => {
  const editor = editorWithBrushControls();

  closeTo(editor.textureAirbrushSpacingPercent(), 1);
  closeTo(editor.textureAirbrushSpacingPixels(20), 0.4);

  editor.textureBrushSpacing.value = "200";
  closeTo(editor.textureAirbrushSpacingPixels(20), 80);
});

test("airbrush macro brush settings carry pressure controls", () => {
  const editor = editorWithBrushControls();
  const options = editor.textureAirbrushOptionsFromMacroBrush({
    radiusPixels: 18,
    spacing: 42,
    opacity: 0.5,
    hardness: 0.4,
    scatter: 0.3,
    pressure: 0.35,
    pressureRadius: true,
    pressureOpacity: false
  });

  assert.equal(options.radiusPixels, 18);
  assert.equal(options.spacing, 42);
  assert.equal(options.opacity, 0.5);
  assert.equal(options.hardness, 0.4);
  assert.equal(options.scatter, 0.3);
  assert.equal(options.pressure, 0.35);
  assert.equal(options.pressureRadius, true);
  assert.equal(options.pressureOpacity, false);
  assert.equal(options.pressureHardness, undefined);
  assert.equal(options.pressureScatter, undefined);
});
