import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import {
  BIRD_POSE_TIMELINE_FRAMES,
  DEFAULT_BIRD_FLAP_PARAMS,
  birdFlightRotationQuaternion,
  normalizeBirdFlapParams,
  normalizeBirdPoseKeyframes
} from "../src/animation/bird-flap-pose.js";

test("normalizeBirdFlapParams keeps defaults and accepts only finite override values", () => {
  const params = normalizeBirdFlapParams({
    shoulderYBase: "0.5",
    shoulderZStroke: Number.NaN,
    bodyX: -0.2,
    ignored: 99
  });

  assert.equal(params.shoulderYBase, 0.5);
  assert.equal(params.shoulderZStroke, DEFAULT_BIRD_FLAP_PARAMS.shoulderZStroke);
  assert.equal(params.bodyX, -0.2);
  assert.equal(Object.hasOwn(params, "ignored"), false);
});

test("normalizeBirdFlapParams returns a defensive default copy for invalid payloads", () => {
  const params = normalizeBirdFlapParams(null);
  assert.deepEqual(params, DEFAULT_BIRD_FLAP_PARAMS);
  assert.notEqual(params, DEFAULT_BIRD_FLAP_PARAMS);
});

test("normalizeBirdPoseKeyframes clamps frames and normalizes non-finite channels", () => {
  const keyframes = normalizeBirdPoseKeyframes([
    {
      frame: -4,
      bones: {
        LeftArm: { x: "0.25", y: Infinity, z: -0.5, px: 1 }
      }
    },
    {
      frame: BIRD_POSE_TIMELINE_FRAMES + 20,
      bones: {
        LeftArm: { x: 1, py: "2.5", pz: "nope" }
      }
    },
    { frame: 12, bones: { BadBone: null } },
    { frame: "bad", bones: { LeftArm: { x: 1 } } }
  ]);

  assert.equal(keyframes.size, 2);
  assert.deepEqual(keyframes.get(0).LeftArm, {
    x: 0.25,
    y: 0,
    z: -0.5,
    px: 1,
    py: 0,
    pz: 0
  });
  assert.deepEqual(keyframes.get(BIRD_POSE_TIMELINE_FRAMES).LeftArm, {
    x: 1,
    y: 0,
    z: 0,
    px: 0,
    py: 2.5,
    pz: 0
  });
});

test("birdFlightRotationQuaternion wraps degrees before creating a quaternion", () => {
  const wrapped = birdFlightRotationQuaternion(450, -270, 720);
  const expected = birdFlightRotationQuaternion(90, 90, 0);
  assert.ok(wrapped.angleTo(expected) < 1e-10);

  const identity = birdFlightRotationQuaternion("not-a-number", 0, 0);
  assert.ok(identity.angleTo(new THREE.Quaternion()) < 1e-10);
});
