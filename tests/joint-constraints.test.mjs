import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installJointConstraintMethods } from "../src/weight-editor/joint-constraints.js";

class TestEditor {}

installJointConstraintMethods(TestEditor, {
  THREE,
  finitePoseValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
});

function editorWithBones() {
  const editor = new TestEditor();
  editor.bones = new Map([
    ["Arm", { name: "Arm" }],
    ["Leg", { name: "Leg" }]
  ]);
  editor.jointConstraints = new Map();
  editor.manualPose = new Map();
  editor.poseKeyframes = new Map();
  editor.progress = 0;
  editor.syncJointConstraintControls = () => {};
  editor.applyPose = () => {};
  editor.flushPoseUpdates = () => {};
  editor.syncPatchJson = () => {};
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  return editor;
}

test("normalizeJointConstraint clamps ranges and swaps inverted min/max channels", () => {
  const editor = editorWithBones();
  const normalized = editor.normalizeJointConstraint({
    enabled: true,
    min: { x: 10, y: 2, z: Number.NaN },
    max: { x: -10, y: -2, z: 0.5 }
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.min.x, -Math.PI * 2);
  assert.equal(normalized.max.x, Math.PI * 2);
  assert.equal(normalized.min.y, -2);
  assert.equal(normalized.max.y, 2);
  assert.equal(normalized.min.z, 0);
  assert.equal(normalized.max.z, 0.5);
});

test("setJointConstraintForBone stores enabled constraints and clamps current pose data", () => {
  const editor = editorWithBones();
  editor.manualPose.set("Arm", { x: 4, y: -4, z: 2, px: 99 });
  editor.poseKeyframes.set(0, {
    Arm: { x: -4, y: 4, z: -2, py: 7 }
  });

  const changed = editor.setJointConstraintForBone("Arm", {
    enabled: true,
    min: { x: -1, y: -2, z: -0.25 },
    max: { x: 1, y: 2, z: 0.25 }
  }, { silent: true });

  assert.equal(changed, true);
  assert.deepEqual(editor.manualPose.get("Arm"), { x: 1, y: -2, z: 0.25, px: 99 });
  assert.deepEqual(editor.poseKeyframes.get(0).Arm, { x: -1, y: 2, z: -0.25, py: 7 });
  assert.deepEqual(editor.serializeJointConstraints(), [{
    bone: "Arm",
    enabled: true,
    min: { x: -1, y: -2, z: -0.25 },
    max: { x: 1, y: 2, z: 0.25 }
  }]);
});

test("applySerializedJointConstraints skips unknown and disabled bones", () => {
  const editor = editorWithBones();
  const applied = editor.applySerializedJointConstraints([
    {
      bone: "Missing",
      enabled: true,
      min: { x: -1, y: -1, z: -1 },
      max: { x: 1, y: 1, z: 1 }
    },
    {
      bone: "Arm",
      enabled: false,
      min: { x: -1, y: -1, z: -1 },
      max: { x: 1, y: 1, z: 1 }
    },
    {
      bone: "Leg",
      enabled: true,
      min: { x: -0.5, y: -0.25, z: 0 },
      max: { x: 0.5, y: 0.25, z: 1 }
    }
  ]);

  assert.equal(applied, 1);
  assert.equal(editor.jointConstraints.has("Missing"), false);
  assert.equal(editor.jointConstraints.has("Arm"), false);
  assert.deepEqual(editor.jointConstraintForBone("Leg"), {
    enabled: true,
    min: { x: -0.5, y: -0.25, z: 0 },
    max: { x: 0.5, y: 0.25, z: 1 }
  });
});

test("jointConstraintCaptureChannels uses explicit edited channels before non-zero pose channels", () => {
  const editor = editorWithBones();
  editor.markJointConstraintPoseChannelEdited("x", "Arm");
  editor.markJointConstraintPoseChannelEdited("z", "Arm");

  assert.deepEqual(editor.jointConstraintCaptureChannels("Arm", { x: 0, y: 1, z: 0 }), ["x", "z"]);
  assert.deepEqual(editor.jointConstraintCaptureChannels("Leg", { x: 0, y: 1, z: 0.25 }), ["y", "z"]);
});
