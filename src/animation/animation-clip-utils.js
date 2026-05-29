import * as THREE from "../../node_modules/three/build/three.module.js";

const EPSILON = 1e-5;

function finiteOffsetSeconds(value) {
  const offset = Number(value);
  return Number.isFinite(offset) && offset > EPSILON ? offset : 0;
}

function copyValueSlice(track, keyIndex) {
  const valueSize = track.getValueSize();
  const start = keyIndex * valueSize;
  return Array.from(track.values.slice(start, start + valueSize));
}

function sampleTrackValue(track, time) {
  const interpolant = track.createInterpolant(new track.ValueBufferType(track.getValueSize()));
  return Array.from(interpolant.evaluate(time));
}

function startValueForTrack(track, offsetSeconds) {
  const times = track.times;
  if (!times.length) {
    return null;
  }

  if (offsetSeconds <= times[0] + EPSILON) {
    return copyValueSlice(track, 0);
  }

  const lastIndex = times.length - 1;
  if (offsetSeconds >= times[lastIndex] - EPSILON) {
    return copyValueSlice(track, lastIndex);
  }

  return sampleTrackValue(track, offsetSeconds);
}

function trimTrackStart(track, offsetSeconds) {
  const valueSize = track.getValueSize();
  const times = [];
  const values = [];
  const pushKey = (time, keyValues) => {
    times.push(Math.max(0, time));
    values.push(...keyValues);
  };

  const startValue = startValueForTrack(track, offsetSeconds);
  if (!startValue) {
    return null;
  }
  pushKey(0, startValue);

  for (let index = 0; index < track.times.length; index += 1) {
    const sourceTime = track.times[index];
    if (sourceTime <= offsetSeconds + EPSILON) {
      continue;
    }
    pushKey(sourceTime - offsetSeconds, copyValueSlice(track, index));
  }

  const TimeArray = track.times.constructor;
  const ValueArray = track.values.constructor;
  return new track.constructor(
    track.name,
    new TimeArray(times),
    new ValueArray(values),
    track.getInterpolation()
  );
}

export function configuredClipStartOffsetSeconds(entry, owner) {
  return finiteOffsetSeconds(entry?.startOffsetSeconds ?? owner?.clipStartOffsetSeconds);
}

export function appliedClipStartOffsetSeconds(clip) {
  return finiteOffsetSeconds(clip?.userData?.appliedStartOffsetSeconds);
}

export function remainingClipStartOffsetSeconds(clip, configuredOffsetSeconds) {
  return Math.max(0, finiteOffsetSeconds(configuredOffsetSeconds) - appliedClipStartOffsetSeconds(clip));
}

export function cloneClipWithStartOffsetApplied(clip, startOffsetSeconds = 0) {
  const clone = clip.clone();
  const offset = finiteOffsetSeconds(startOffsetSeconds);
  const duration = Number(clone.duration) || 0;
  if (!offset || duration <= offset + EPSILON) {
    clone.userData = {
      ...clone.userData,
      appliedStartOffsetSeconds: 0,
      sourceDurationSeconds: duration
    };
    return clone;
  }

  const tracks = clone.tracks
    .map((track) => trimTrackStart(track, offset))
    .filter(Boolean);
  const trimmed = new THREE.AnimationClip(clone.name, Math.max(EPSILON, duration - offset), tracks);
  trimmed.blendMode = clone.blendMode;
  trimmed.userData = {
    ...clone.userData,
    appliedStartOffsetSeconds: offset,
    sourceDurationSeconds: duration
  };
  return trimmed;
}

export function cloneClipWithStartDeleted(clip, startOffsetSeconds = 0) {
  const deleted = cloneClipWithStartOffsetApplied(clip, startOffsetSeconds);
  const deletedOffset = appliedClipStartOffsetSeconds(deleted);
  deleted.userData = {
    ...deleted.userData,
    appliedStartOffsetSeconds: 0,
    deletedStartOffsetSeconds: deletedOffset,
    originalDurationSeconds: deleted.userData?.sourceDurationSeconds ?? (Number(clip?.duration) || 0)
  };
  return deleted;
}
