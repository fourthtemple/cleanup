import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installAutoKeySolverMethods } from "../src/weight-editor/auto-key-solver.js";
import { installTimelineSolvedKeyMethods } from "../src/weight-editor/timeline-solved-keys.js";

class TestEditor {}
class SolverEditor {}

installTimelineSolvedKeyMethods(TestEditor);
installAutoKeySolverMethods(SolverEditor, {
  THREE,
  CURVE_CHANNEL_KEYS: ["x", "y", "z", "px", "py", "pz"],
  finitePoseValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
});

function radio(checked = false) {
  return {
    checked,
    setAttribute() {}
  };
}

function button() {
  return {
    disabled: false,
    title: ""
  };
}

function editorWithMotion(mode = "additive") {
  const editor = new TestEditor();
  editor.model = {};
  editor.activeClipEntry = { name: "walk", clip: {} };
  editor.actorTarget = { mode: "character" };
  editor.poseKeyframeMode = "additive";
  editor.poseKeyframes = new Map();
  editor.manualPose = new Map();
  editor.poseKeyframesGenerated = false;
  editor.motionConversionModeSelect = { value: mode, title: "" };
  editor.motionConversionApplyButton = button();
  editor.useTimelineKeysToggle = radio(mode === "solved");
  editor.adaptiveEditToggle = radio(mode === "adaptive");
  editor.additiveKinematicsToggle = radio(mode === "additive");
  editor.autoKeyDetailSettings = () => ({ maxKeys: 21, maxCurveKeys: 9, detail: 0.2 });
  editor.updateRangeOutputs = () => {
    editor.rangeOutputsUpdated = true;
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  return editor;
}

test("motion conversion action is disabled until a loaded motion exists", () => {
  const editor = editorWithMotion("solved");
  editor.model = null;

  editor.syncMotionConversionApplyButton();
  assert.equal(editor.motionConversionApplyButton.disabled, true);
  assert.match(editor.motionConversionApplyButton.title, /Load a character animation/);

  editor.model = {};
  editor.syncMotionConversionApplyButton();
  assert.equal(editor.motionConversionApplyButton.disabled, false);
  assert.match(editor.motionConversionApplyButton.title, /solved keys/);
});

test("converting to solved keys solves source timeline keys", async () => {
  const editor = editorWithMotion("solved");
  editor.autoKeyActiveClip = async (options) => {
    editor.autoKeyOptions = options;
    return { label: "walk", frames: [0, 1], boneNames: ["Arm"], curveKeyCount: 2 };
  };

  const converted = await editor.convertCurrentMotionToSelectedMode({ pushUndo: true });

  assert.equal(converted, true);
  assert.equal(editor.autoKeyOptions.generated, false);
  assert.equal(editor.autoKeyOptions.sampleResolvedMotion, true);
  assert.equal(editor.autoKeyOptions.outputAdditive, false);
  assert.equal(editor.autoKeyOptions.pushUndo, true);
  assert.equal(editor.autoKeyOptions.selectPrimaryBone, false);
  assert.equal(editor.motionConversionModeSelect.value, "solved");
  assert.equal(editor.rangeOutputsUpdated, true);
  assert.match(editor.lastStatus, /Resolved walk to solved keys/);
});

test("converting to adaptive keys solves generated guide keys", async () => {
  const editor = editorWithMotion("adaptive");
  editor.autoKeyActiveClip = async (options) => {
    editor.autoKeyOptions = options;
    return { label: "walk", frames: [0, 1], boneNames: ["Arm"], curveKeyCount: 2 };
  };

  const converted = await editor.convertCurrentMotionToSelectedMode();

  assert.equal(converted, true);
  assert.equal(editor.autoKeyOptions.generated, true);
  assert.equal(editor.autoKeyOptions.sampleResolvedMotion, true);
  assert.equal(editor.autoKeyOptions.outputAdditive, false);
  assert.equal(editor.motionConversionModeSelect.value, "adaptive");
  assert.match(editor.lastStatus, /Resolved walk to adaptive keys/);
});

test("converting to additive kinematics does not re-solve unkeyed manual pose", async () => {
  const editor = editorWithMotion("additive");
  editor.manualPose.set("Arm", { x: 0.5 });
  editor.autoKeyActiveClip = async () => {
    throw new Error("additive conversion should not solve keys");
  };
  editor.setTimelineEditMode = (mode) => {
    editor.timelineModeSet = mode;
    return true;
  };
  editor.additiveKinematicsStatusText = () => "Additive kinematics ready";

  const converted = await editor.convertCurrentMotionToSelectedMode();

  assert.equal(converted, true);
  assert.equal(editor.timelineModeSet, "additive");
  assert.match(editor.lastStatus, /Additive kinematics ready/);
});

test("resolved sampling ignores unkeyed manual pose and restores it after sampling", () => {
  const editor = new SolverEditor();
  const manualPose = new Map([["Arm", { x: 99 }]]);
  const additiveNames = new Set(["Arm"]);
  const editedChannels = new Map([["Arm", new Set(["x"])]]);
  editor.model = { updateMatrixWorld() {} };
  editor.manualPose = manualPose;
  editor.manualPoseAdditiveNames = additiveNames;
  editor.manualPoseEditedChannels = editedChannels;
  editor.progress = 0.75;
  editor.lastClipSampleTime = 12;
  editor.applyPose = (progress) => {
    editor.appliedProgress = progress;
    editor.manualPoseSizeDuringApply = editor.manualPose.size;
  };
  editor.getBoneRelativePose = (boneName) => ({
    x: editor.manualPose.has(boneName) ? 99 : 1,
    y: 0,
    z: 0,
    px: 0,
    py: 0,
    pz: 0
  });
  editor.clonePose = (pose) => ({ ...pose });

  const sample = editor.sampleResolvedPoseForAutoKey(0.25, ["Arm"]);

  assert.equal(editor.appliedProgress, 0.25);
  assert.equal(editor.manualPoseSizeDuringApply, 0);
  assert.deepEqual(sample.Arm, { x: 1, y: 0, z: 0, px: 0, py: 0, pz: 0 });
  assert.equal(editor.manualPose, manualPose);
  assert.equal(editor.manualPoseAdditiveNames, additiveNames);
  assert.equal(editor.manualPoseEditedChannels, editedChannels);
  assert.equal(editor.progress, 0.75);
  assert.equal(editor.lastClipSampleTime, 12);
});

test("converting edited motion to additive kinematics resolves the visible layer", async () => {
  const editor = editorWithMotion("additive");
  editor.poseKeyframeMode = "replace";
  editor.poseKeyframes.set(0, { Arm: { x: 0.4 } });
  editor.autoKeyActiveClip = async (options) => {
    editor.autoKeyOptions = options;
    return { label: "walk", frames: [0, 1], boneNames: ["Arm"], curveKeyCount: 2 };
  };

  const converted = await editor.convertCurrentMotionToSelectedMode();

  assert.equal(converted, true);
  assert.equal(editor.autoKeyOptions.sampleResolvedMotion, true);
  assert.equal(editor.autoKeyOptions.outputAdditive, true);
  assert.equal(editor.autoKeyOptions.generated, false);
  assert.match(editor.lastStatus, /Resolved walk to additive kinematics/);
});

test("solved key conversion can sample resolved motion instead of the raw clip", () => {
  const editor = new SolverEditor();
  editor.timelineFrames = 2;
  editor.bones = new Map([["Arm", {}]]);
  editor.boneLayerNames = ["Arm"];
  editor.sampleBasePoseForAutoKey = () => {
    throw new Error("resolved conversion should not sample raw base motion");
  };
  editor.sampleResolvedPoseForAutoKey = (progress, boneNames) => {
    editor.resolvedSampleCalls ||= [];
    editor.resolvedSampleCalls.push({ progress, boneNames });
    return {
      Arm: { x: progress, y: 0, z: 0, px: 0, py: 0, pz: 0 }
    };
  };
  editor.unwrapAutoKeyRotationSamples = () => {};
  editor.autoKeyWalkingContext = () => ({ active: false });
  editor.autoKeyMovingBoneInfo = () => ({ bones: [{ name: "Arm", score: 1 }] });
  editor.autoKeySolveChannelCurves = () => [
    { boneName: "Arm", channel: "x", keys: [{ frame: 0, value: 0 }, { frame: 2, value: 1 }] }
  ];

  const solution = editor.solveAutoKeyframesForActiveClip({
    timelineFrames: 2,
    sampleResolvedMotion: true,
    maxKeys: 4,
    maxCurveKeys: 4
  });

  assert.deepEqual(editor.resolvedSampleCalls.map((call) => call.progress), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(editor.resolvedSampleCalls[0].boneNames, ["Arm"]);
  assert.equal(solution.frames.length, 2);
  assert.equal(solution.boneNames[0], "Arm");
});

test("additive auto-key output stores resolved values as deltas over the base clip", async () => {
  const editor = new SolverEditor();
  editor.model = { updateMatrixWorld() {} };
  editor.actorTarget = { mode: "character" };
  editor.activeClipEntry = { name: "walk", clip: {} };
  editor.activeClipAction = {};
  editor.bones = new Map([["Arm", {}]]);
  editor.poseKeyframes = new Map();
  editor.adaptiveGuideKeyframes = new Map();
  editor.adaptiveGuideDeltaKeyframes = new Map();
  editor.adaptiveGuideCurveHandles = new Map();
  editor.poseCurveHandles = new Map();
  editor.poseKeyframeKinds = new Map();
  editor.manualPose = new Map();
  editor.manualPoseAdditiveNames = new Set();
  editor.progress = 0.25;
  editor.timelineFrames = 2;
  editor.stopSequencePreview = () => {};
  editor.pausePlayback = () => {};
  editor.applyPose = (progress) => {
    editor.lastAppliedProgress = progress;
  };
  editor.syncPoseControlsToCurrentBone = () => {};
  editor.syncTimelineControls = () => {};
  editor.updateTimelineKeyMarkers = () => {};
  editor.syncPatchJson = () => {};
  editor.updateCounts = () => {};
  editor.setCurveHandleFor = (boneName, channel, frame, key) => {
    editor.lastCurveHandle = { boneName, channel, frame, key };
  };
  editor.adaptivePoseFromAbsolutePose = (frame, boneName, pose) => ({
    x: pose.x - 10,
    px: pose.px - 2
  });
  editor.solveAutoKeyframesForActiveClip = () => ({
    frames: [0, 2],
    boneNames: ["Arm"],
    primaryBoneName: "Arm",
    samples: [
      { Arm: { x: 10, y: 0, z: 0, px: 2, py: 0, pz: 0 } },
      { Arm: { x: 10.5, y: 0, z: 0, px: 2.5, py: 0, pz: 0 } },
      { Arm: { x: 11, y: 0, z: 0, px: 3, py: 0, pz: 0 } }
    ],
    curves: [
      { boneName: "Arm", channel: "x", keys: [{ frame: 0, value: 10 }, { frame: 2, value: 11 }] },
      { boneName: "Arm", channel: "px", keys: [{ frame: 2, value: 3 }] }
    ],
    curveKeyCount: 3
  });

  const solution = await editor.autoKeyActiveClip({
    outputAdditive: true,
    pushUndo: false,
    selectPrimaryBone: false,
    silent: true
  });

  assert.ok(solution);
  assert.equal(editor.poseKeyframeMode, "additive");
  assert.equal(editor.poseKeyframesGenerated, false);
  assert.deepEqual(editor.poseKeyframes.get(0).Arm, { x: 0 });
  assert.deepEqual(editor.poseKeyframes.get(2).Arm, { x: 1, px: 1 });
  assert.equal(editor.lastCurveHandle.key.value, 1);
});
