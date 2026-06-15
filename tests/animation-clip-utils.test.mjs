import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import {
  appliedClipStartOffsetSeconds,
  cloneClipWithStartDeleted,
  cloneClipWithStartOffsetApplied,
  configuredClipStartOffsetSeconds,
  remainingClipStartOffsetSeconds
} from "../src/animation/animation-clip-utils.js";

function testClip() {
  return new THREE.AnimationClip("walk", 2, [
    new THREE.NumberKeyframeTrack("Hips.rotation[x]", [0, 1, 2], [0, 10, 20]),
    new THREE.VectorKeyframeTrack("Hips.position", [0, 1, 2], [0, 0, 0, 2, 4, 6, 4, 8, 12])
  ]);
}

test("configuredClipStartOffsetSeconds prefers entry values and ignores invalid offsets", () => {
  assert.equal(configuredClipStartOffsetSeconds({ startOffsetSeconds: 0.5 }, { clipStartOffsetSeconds: 1 }), 0.5);
  assert.equal(configuredClipStartOffsetSeconds({ startOffsetSeconds: -1 }, { clipStartOffsetSeconds: 1 }), 0);
  assert.equal(configuredClipStartOffsetSeconds({}, { clipStartOffsetSeconds: 0.25 }), 0.25);
  assert.equal(configuredClipStartOffsetSeconds({}, { clipStartOffsetSeconds: Number.NaN }), 0);
});

test("cloneClipWithStartOffsetApplied trims tracks and stores source metadata", () => {
  const clipped = cloneClipWithStartOffsetApplied(testClip(), 0.5);
  assert.equal(clipped.name, "walk");
  assert.equal(clipped.duration, 1.5);
  assert.equal(appliedClipStartOffsetSeconds(clipped), 0.5);
  assert.equal(clipped.userData.sourceDurationSeconds, 2);

  const numberTrack = clipped.tracks.find((track) => track.name === "Hips.rotation[x]");
  assert.deepEqual(Array.from(numberTrack.times), [0, 0.5, 1.5]);
  assert.deepEqual(Array.from(numberTrack.values), [5, 10, 20]);

  const vectorTrack = clipped.tracks.find((track) => track.name === "Hips.position");
  assert.deepEqual(Array.from(vectorTrack.times), [0, 0.5, 1.5]);
  assert.deepEqual(Array.from(vectorTrack.values), [1, 2, 3, 2, 4, 6, 4, 8, 12]);
});

test("cloneClipWithStartOffsetApplied leaves too-large offsets as untrimmed clones", () => {
  const clipped = cloneClipWithStartOffsetApplied(testClip(), 3);
  assert.equal(clipped.duration, 2);
  assert.equal(appliedClipStartOffsetSeconds(clipped), 0);
  assert.equal(clipped.userData.sourceDurationSeconds, 2);
});

test("remainingClipStartOffsetSeconds subtracts the already applied offset", () => {
  const clipped = cloneClipWithStartOffsetApplied(testClip(), 0.75);
  assert.equal(remainingClipStartOffsetSeconds(clipped, 1), 0.25);
  assert.equal(remainingClipStartOffsetSeconds(clipped, 0.5), 0);
});

test("cloneClipWithStartDeleted records deleted offset while resetting applied offset", () => {
  const clipped = cloneClipWithStartDeleted(testClip(), 0.5);
  assert.equal(appliedClipStartOffsetSeconds(clipped), 0);
  assert.equal(clipped.userData.deletedStartOffsetSeconds, 0.5);
  assert.equal(clipped.userData.originalDurationSeconds, 2);
});
