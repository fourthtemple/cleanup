import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installRootMotionUnbakeMethods } from "../src/weight-editor/root-motion-unbake.js";

class TestEditor {}

installRootMotionUnbakeMethods(TestEditor, { THREE });

function vectorTrackValues(track) {
  return Array.from(track.values).map((value) => Number(value.toFixed(6)));
}

test("unbakedRootMotionClip moves horizontal hips motion to a root track", () => {
  const editor = new TestEditor();
  const hipsTrack = new THREE.VectorKeyframeTrack("Hips.position", [0, 1, 2], [
    1, 5, 2,
    3, 6, 5,
    5, 7, 8
  ]);
  const rotationTrack = new THREE.QuaternionKeyframeTrack("Hips.quaternion", [0, 2], [
    0, 0, 0, 1,
    0, 0, 0, 1
  ]);
  const clip = new THREE.AnimationClip("walk", 2, [hipsTrack, rotationTrack]);

  const unbaked = editor.unbakedRootMotionClip(clip, {
    hipsName: "Hips",
    rootName: "Root"
  });

  assert.ok(unbaked);
  assert.equal(unbaked.name, "walk");
  assert.equal(unbaked.duration, 2);
  assert.equal(unbaked.userData.rootMotionUnbaked, true);
  assert.equal(unbaked.userData.rootMotionRoot, "Root");
  assert.equal(unbaked.userData.rootMotionHips, "Hips");
  assert.ok(unbaked.tracks.includes(rotationTrack));

  const rootTrack = unbaked.tracks.find((track) => track.name === "Root.position");
  const nextHipsTrack = unbaked.tracks.find((track) => track.name === "Hips.position");
  assert.deepEqual(vectorTrackValues(rootTrack), [
    0, 0, 0,
    2, 0, 3,
    4, 0, 6
  ]);
  assert.deepEqual(vectorTrackValues(nextHipsTrack), [
    1, 5, 2,
    1, 6, 2,
    1, 7, 2
  ]);
});

test("unbakedRootMotionClip returns null when hips have no horizontal motion", () => {
  const editor = new TestEditor();
  const clip = new THREE.AnimationClip("idle", 2, [
    new THREE.VectorKeyframeTrack("Hips.position", [0, 1, 2], [
      1, 5, 2,
      1, 6, 2,
      1, 7, 2
    ])
  ]);

  assert.equal(editor.unbakedRootMotionClip(clip, {
    hipsName: "Hips",
    rootName: "Root"
  }), null);
});

test("serializeRootMotionUnbakes writes stable cleanup records", () => {
  const editor = new TestEditor();
  editor.rootMotionUnbakeActions = new Map([
    ["walk", { root: "Root", hips: "Hips", axes: "xz" }],
    ["jump", { root: "GameRoot", hips: "Pelvis", axes: "x" }]
  ]);

  assert.deepEqual(editor.serializeRootMotionUnbakes(), [
    { action: "walk", root: "Root", hips: "Hips", axes: "xz" },
    { action: "jump", root: "GameRoot", hips: "Pelvis", axes: "x" }
  ]);
});
