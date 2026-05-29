import * as THREE from "../../node_modules/three/build/three.module.js";

export const BIRD_FLAP_PARAMS_URL = "";
export const BIRD_WEIGHT_PATCH_URL = "";
export const BIRD_POSE_TIMELINE_FRAMES = 96;

export const DEFAULT_BIRD_FLAP_PARAMS = {
  shoulderYBase: 0.02,
  shoulderYStroke: 0.06,
  shoulderZBase: 0.03,
  shoulderZStroke: 0.475,
  armYBase: 0.18,
  armYStroke: 0.1,
  armZBase: -0.32,
  armZStroke: 0.52,
  forearmYBase: 0.02,
  forearmYStroke: 0.18,
  forearmZBase: 0.355,
  forearmZStroke: 0.385,
  handYBase: -0.285,
  handYStroke: 0,
  handZBase: 0,
  handZStroke: 0.21,
  bodyX: -0.006,
  bodyY: 0.011
};

const BODY_BONES = ["Spine", "Spine01", "Spine02", "neck", "Head", "headfront"];

export function normalizeBirdFlapParams(params) {
  if (!params || typeof params !== "object") {
    return { ...DEFAULT_BIRD_FLAP_PARAMS };
  }

  const next = { ...DEFAULT_BIRD_FLAP_PARAMS };
  Object.keys(DEFAULT_BIRD_FLAP_PARAMS).forEach((key) => {
    const value = Number(params[key]);
    if (Number.isFinite(value)) {
      next[key] = value;
    }
  });
  return next;
}

export async function loadBirdFlapParams(url = BIRD_FLAP_PARAMS_URL) {
  return (await loadBirdFlapProfile(url)).params;
}

export async function loadBirdFlapProfile(url = BIRD_FLAP_PARAMS_URL) {
  if (!url) {
    return {
      params: { ...DEFAULT_BIRD_FLAP_PARAMS },
      poseKeyframes: new Map()
    };
  }
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    return {
      params: normalizeBirdFlapParams(payload?.params || payload),
      poseKeyframes: normalizeBirdPoseKeyframes(payload?.poseKeyframes)
    };
  } catch {
    return {
      params: { ...DEFAULT_BIRD_FLAP_PARAMS },
      poseKeyframes: new Map()
    };
  }
}

export async function loadBirdPoseKeyframes(url = BIRD_FLAP_PARAMS_URL) {
  const profile = await loadBirdFlapProfile(url);
  if (profile.poseKeyframes.size) {
    return profile.poseKeyframes;
  }
  const patch = await loadBirdWeightPatch();
  return normalizeBirdPoseKeyframes(patch?.poseKeyframes);
}

export async function loadBirdWeightPatch(url = BIRD_WEIGHT_PATCH_URL) {
  if (!url) {
    return null;
  }
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const patch = await response.json();
    return patch && Array.isArray(patch.assignments) ? patch : null;
  } catch {
    return null;
  }
}

export function applyBirdWeightPatch(model, patch) {
  if (!model || !patch?.assignments?.length) {
    return 0;
  }

  const records = [];
  model.traverse((object) => {
    if (
      object.isSkinnedMesh &&
      object.geometry?.attributes?.position &&
      object.geometry?.attributes?.skinIndex &&
      object.geometry?.attributes?.skinWeight &&
      object.skeleton?.bones?.length
    ) {
      records.push({ object, geometry: object.geometry });
    }
  });
  if (!records.length) {
    return 0;
  }

  let applied = 0;
  for (const assignment of patch.assignments) {
    const record = records.find((entry) => entry.object.name === assignment.mesh) || records[0];
    if (!record || !Number.isInteger(assignment.vertex)) {
      continue;
    }
    const vertexCount = record.geometry.attributes.position.count;
    if (assignment.vertex < 0 || assignment.vertex >= vertexCount) {
      continue;
    }
    if (assignment.weights) {
      applyWeightsToVertex(record, assignment.vertex, assignment.weights);
    }
    if (Array.isArray(assignment.positionDelta)) {
      applyPositionDeltaToVertex(record, assignment.vertex, assignment.positionDelta);
    }
    applied += 1;
  }

  records.forEach((record) => {
    record.geometry.attributes.position.needsUpdate = true;
    record.geometry.attributes.skinIndex.needsUpdate = true;
    record.geometry.attributes.skinWeight.needsUpdate = true;
    record.geometry.computeVertexNormals();
  });
  return applied;
}

export function normalizeBirdPoseKeyframes(serialized) {
  const keyframes = new Map();
  if (!Array.isArray(serialized)) {
    return keyframes;
  }
  serialized.forEach((key) => {
    const frame = Math.round(Number(key?.frame));
    if (!Number.isFinite(frame) || !key?.bones || typeof key.bones !== "object") {
      return;
    }
    const bones = {};
    Object.entries(key.bones).forEach(([boneName, pose]) => {
      if (!pose || typeof pose !== "object") {
        return;
      }
      bones[boneName] = {
        x: finitePoseNumber(pose.x),
        y: finitePoseNumber(pose.y),
        z: finitePoseNumber(pose.z),
        px: finitePoseNumber(pose.px),
        py: finitePoseNumber(pose.py),
        pz: finitePoseNumber(pose.pz)
      };
    });
    if (Object.keys(bones).length) {
      keyframes.set(Math.max(0, Math.min(BIRD_POSE_TIMELINE_FRAMES, frame)), bones);
    }
  });
  return keyframes;
}

export function captureBirdBindPose(model) {
  const pose = [];
  model?.traverse((object) => {
    pose.push({
      object,
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone()
    });
  });
  return pose;
}

export function collectBirdBones(model) {
  const bones = new Map();
  model?.traverse((object) => {
    if (object.isBone) {
      bones.set(object.name, object);
    }
  });
  return bones;
}

export function applyBirdFlapPose({ bindPose, bones, params, progress, poseKeyframes, timelineFrames = BIRD_POSE_TIMELINE_FRAMES }) {
  if (!bindPose?.length || !bones?.size) {
    return;
  }

  const safeParams = normalizeBirdFlapParams(params);
  bindPose.forEach(({ object, position, quaternion, scale }) => {
    object.position.copy(position);
    object.quaternion.copy(quaternion);
    object.scale.copy(scale);
  });

  const stroke = 0.5 - 0.5 * Math.cos(progress * Math.PI * 2);
  const phase = Math.sin(progress * Math.PI * 2);
  const settle = Math.cos(progress * Math.PI * 2);

  for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
    setBoneEuler(bindPose, bones, `${side}Shoulder`, 0,
      sign * (safeParams.shoulderYBase + safeParams.shoulderYStroke * stroke),
      -sign * (safeParams.shoulderZBase + safeParams.shoulderZStroke * stroke));
    setBoneEuler(bindPose, bones, `${side}Arm`, 0,
      sign * (safeParams.armYBase + safeParams.armYStroke * stroke),
      -sign * (safeParams.armZBase + safeParams.armZStroke * stroke));
    setBoneEuler(bindPose, bones, `${side}ForeArm`, 0,
      sign * (safeParams.forearmYBase + safeParams.forearmYStroke * stroke),
      -sign * (safeParams.forearmZBase + safeParams.forearmZStroke * stroke));
    setBoneEuler(bindPose, bones, `${side}Hand`, 0,
      sign * (safeParams.handYBase + safeParams.handYStroke * stroke),
      -sign * (safeParams.handZBase + safeParams.handZStroke * stroke));
  }

  BODY_BONES.forEach((boneName) => {
    const bodyAmount = ["Head", "headfront", "neck"].includes(boneName) ? 0.55 : 1;
    setBoneEuler(bindPose, bones, boneName, safeParams.bodyX * settle * bodyAmount, safeParams.bodyY * phase * bodyAmount, 0);
  });

  const keyedPose = interpolatedBirdPoseForFrame(poseKeyframes, progress * timelineFrames, timelineFrames);
  Object.entries(keyedPose).forEach(([boneName, pose]) => {
    setBoneLayerPose(bindPose, bones, boneName, pose);
  });
}

export function applyBirdFlightRotation(root, rotateX = 0, rotateY = 0, rotateZ = 0) {
  if (!root) {
    return;
  }
  root.quaternion.copy(birdFlightRotationQuaternion(rotateX, rotateY, rotateZ));
}

export function applyBirdPathRotation({
  facingRoot,
  motionRoot,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0
} = {}) {
  if (!facingRoot || !motionRoot) {
    return;
  }
  facingRoot.rotation.set(0, 0, 0);
  applyBirdFlightRotation(motionRoot, rotateX, rotateY, rotateZ);
}

export function birdFlightRotationQuaternion(rotateX = 0, rotateY = 0, rotateZ = 0) {
  return new THREE.Quaternion()
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), degreesToRadians(rotateX)))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), degreesToRadians(rotateY)))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), degreesToRadians(rotateZ)));
}

function setBoneEuler(bindPose, bones, name, x, y, z) {
  const bone = bones.get(name);
  if (!bone) {
    return;
  }
  const rest = bindPose.find((entry) => entry.object === bone);
  if (!rest) {
    return;
  }
  bone.quaternion.copy(rest.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ")));
}

function setBoneLayerPose(bindPose, bones, name, pose) {
  const bone = bones.get(name);
  if (!bone) {
    return;
  }
  const rest = bindPose.find((entry) => entry.object === bone);
  if (!rest) {
    return;
  }
  bone.quaternion.copy(rest.quaternion).multiply(
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.x || 0, pose.y || 0, pose.z || 0, "XYZ"))
  );
  bone.position.set(
    rest.position.x + (pose.px || 0),
    rest.position.y + (pose.py || 0),
    rest.position.z + (pose.pz || 0)
  );
}

function interpolatedBirdPoseForFrame(poseKeyframes, frame, timelineFrames = BIRD_POSE_TIMELINE_FRAMES) {
  const keyframes = poseKeyframes instanceof Map ? poseKeyframes : normalizeBirdPoseKeyframes(poseKeyframes);
  const frames = [...keyframes.keys()].sort((a, b) => a - b);
  if (!frames.length) {
    return {};
  }
  const boneNames = new Set();
  frames.forEach((keyedFrame) => {
    Object.keys(keyframes.get(keyedFrame) || {}).forEach((boneName) => boneNames.add(boneName));
  });

  const result = {};
  boneNames.forEach((boneName) => {
    result[boneName] = {};
    ["x", "y", "z", "px", "py", "pz"].forEach((channel) => {
      const keyed = frames
        .filter((keyedFrame) => keyframes.get(keyedFrame)?.[boneName]?.[channel] !== undefined)
        .map((keyedFrame) => ({
          frame: keyedFrame,
          value: finitePoseNumber(keyframes.get(keyedFrame)[boneName][channel])
        }));
      result[boneName][channel] = interpolateBirdCurveChannel(keyed, frame, timelineFrames);
    });
  });
  return result;
}

function interpolateBirdCurveChannel(keyed, frame, timelineFrames) {
  if (!keyed.length) {
    return 0;
  }
  if (keyed.length === 1) {
    return keyed[0].value;
  }
  const sorted = [...keyed].sort((a, b) => a.frame - b.frame);
  const exact = sorted.find((item) => item.frame === frame);
  if (exact) {
    return exact.value;
  }

  const nextIndex = sorted.findIndex((item) => item.frame >= frame);
  if (nextIndex <= 0) {
    return sorted[0].value;
  }
  if (nextIndex === -1) {
    return sorted[sorted.length - 1].value;
  }

  const p1Index = nextIndex - 1;
  const p2Index = nextIndex;
  const p1 = sorted[p1Index];
  const p2 = sorted[p2Index];
  const looped = sorted[0].frame === 0
    && sorted[sorted.length - 1].frame === timelineFrames
    && Math.abs(sorted[0].value - sorted[sorted.length - 1].value) < 0.0001;
  const p0 = p1Index > 0
    ? sorted[p1Index - 1]
    : looped
      ? { frame: sorted[sorted.length - 2].frame - timelineFrames, value: sorted[sorted.length - 2].value }
      : p1;
  const p3 = p2Index < sorted.length - 1
    ? sorted[p2Index + 1]
    : looped
      ? { frame: timelineFrames + sorted[1].frame, value: sorted[1].value }
      : p2;
  const span = Math.max(p2.frame - p1.frame, 1);
  const t = THREE.MathUtils.clamp((frame - p1.frame) / span, 0, 1);
  const t2 = t * t;
  const t3 = t2 * t;
  const m1 = birdCurveSlope(p0, p2, span);
  const m2 = birdCurveSlope(p1, p3, span);
  return (2 * t3 - 3 * t2 + 1) * p1.value
    + (t3 - 2 * t2 + t) * m1
    + (-2 * t3 + 3 * t2) * p2.value
    + (t3 - t2) * m2;
}

function birdCurveSlope(previous, next, span) {
  const frameSpan = Math.max(next.frame - previous.frame, 1);
  return ((next.value - previous.value) / frameSpan) * span;
}

function finitePoseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function degreesToRadians(value) {
  const number = Number(value);
  const normalized = ((Number.isFinite(number) ? number : 0) % 360 + 360) % 360;
  return THREE.MathUtils.degToRad(normalized);
}

function applyWeightsToVertex(record, vertexIndex, weightsByName) {
  const entries = Object.entries(weightsByName)
    .map(([name, weight]) => ({
      index: record.object.skeleton.bones.findIndex((bone) => bone.name === name),
      weight: Number(weight)
    }))
    .filter((entry) => entry.index >= 0 && entry.weight > 0.0001)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);

  const total = entries.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const skinIndex = record.geometry.attributes.skinIndex;
  const skinWeight = record.geometry.attributes.skinWeight;
  const offset = vertexIndex * 4;
  for (let slot = 0; slot < 4; slot += 1) {
    skinIndex.array[offset + slot] = entries[slot]?.index || 0;
    skinWeight.array[offset + slot] = entries[slot] ? entries[slot].weight / total : 0;
  }
}

function applyPositionDeltaToVertex(record, vertexIndex, delta) {
  const position = record.geometry.attributes.position;
  const offset = vertexIndex * 3;
  position.array[offset] += Number(delta[0] || 0);
  position.array[offset + 1] += Number(delta[1] || 0);
  position.array[offset + 2] += Number(delta[2] || 0);
}
