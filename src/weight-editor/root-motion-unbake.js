export function installRootMotionUnbakeMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  const POSITION_RE = /^(.*)\.position$/;

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function cloneTrackWithValues(track, values) {
    return new track.constructor(track.name, track.times.slice(), values);
  }

  function vectorTrackVaries(values, components = [0, 1, 2], epsilon = 1e-5) {
    if (!values?.length) {
      return false;
    }
    for (const component of components) {
      const first = values[component] || 0;
      for (let offset = component; offset < values.length; offset += 3) {
        if (Math.abs((values[offset] || 0) - first) > epsilon) {
          return true;
        }
      }
    }
    return false;
  }

  function trackTargetName(trackName = "") {
    return String(trackName).match(POSITION_RE)?.[1] || "";
  }

  Object.assign(BirdWeightEditor.prototype, {
    rootMotionUnbakeRootName() {
      return this.bones?.has?.("Root") ? "Root" : this.bones?.has?.("root") ? "root" : "Root";
    },

    rootMotionUnbakeHipBone() {
      return this.firstBoneMatching?.([/^Hips$/i, /hips|pelvis/i])
        || [...(this.bones?.values?.() || [])].find((bone) => /hips|pelvis/i.test(bone.name));
    },

    rootMotionUnbakeActionKey(entry = this.activeClipEntry) {
      return this.clipCleanupActionKey?.(entry)
        || entry?.libraryKey
        || entry?.id
        || entry?.name
        || "";
    },

    serializeRootMotionUnbakes() {
      return [...(this.rootMotionUnbakeActions?.entries?.() || [])]
        .map(([action, record]) => ({
          action,
          root: record.root || "Root",
          hips: record.hips || "Hips",
          axes: record.axes || "xz"
        }));
    },

    ensureRootMotionUnbakeBone(hips, options = {}) {
      if (!hips) {
        return null;
      }
      const rootName = options.name || this.rootMotionUnbakeRootName();
      let root = this.bones.get(rootName);
      if (root) {
        return root;
      }

      root = new THREE.Bone();
      root.name = rootName;
      root.position.set(0, 0, 0);
      root.rotation.set(0, 0, 0);
      root.scale.set(1, 1, 1);
      const parent = hips.parent || this.model;
      const siblings = parent?.children || [];
      const hipsIndex = siblings.indexOf(hips);
      parent?.add(root);
      if (hipsIndex >= 0 && siblings.includes(root)) {
        siblings.splice(siblings.indexOf(root), 1);
        siblings.splice(hipsIndex, 0, root);
      }
      root.add(hips);
      root.updateMatrixWorld(true);
      hips.updateMatrixWorld(true);

      this.bones.set(root.name, root);
      if (!this.virtualBones.some((bone) => bone.name === root.name)) {
        this.virtualBones.push({
          name: root.name,
          parent: "",
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          role: "rootMotion"
        });
      }
      this.bindPose.push({
        object: root,
        position: root.position.clone(),
        quaternion: root.quaternion.clone(),
        scale: root.scale.clone()
      });
      this.rebuildSkinnedSkeletons?.();
      return root;
    },

    unbakedRootMotionClip(clip, { hipsName, rootName } = {}) {
      if (!clip?.tracks?.length || !hipsName || !rootName) {
        return null;
      }
      const hipsTrack = clip.tracks.find((track) => trackTargetName(track.name) === hipsName && /\.position$/.test(track.name));
      if (!hipsTrack || !vectorTrackVaries(hipsTrack.values, [0, 2])) {
        return null;
      }

      const rootValues = new Float32Array(hipsTrack.values.length);
      const hipValues = new Float32Array(hipsTrack.values.length);
      const baseX = finite(hipsTrack.values[0]);
      const baseY = finite(hipsTrack.values[1]);
      const baseZ = finite(hipsTrack.values[2]);
      for (let offset = 0; offset < hipsTrack.values.length; offset += 3) {
        const x = finite(hipsTrack.values[offset], baseX);
        const y = finite(hipsTrack.values[offset + 1], baseY);
        const z = finite(hipsTrack.values[offset + 2], baseZ);
        rootValues[offset] = x - baseX;
        rootValues[offset + 1] = 0;
        rootValues[offset + 2] = z - baseZ;
        hipValues[offset] = baseX;
        hipValues[offset + 1] = y;
        hipValues[offset + 2] = baseZ;
      }

      const rootTrack = new THREE.VectorKeyframeTrack(`${rootName}.position`, hipsTrack.times.slice(), rootValues);
      const hipTrack = cloneTrackWithValues(hipsTrack, hipValues);
      const tracks = clip.tracks
        .filter((track) => track !== hipsTrack && track.name !== `${rootName}.position`)
        .concat([rootTrack, hipTrack]);
      const nextClip = new THREE.AnimationClip(clip.name || "Root Motion Unbaked", clip.duration, tracks);
      nextClip.blendMode = clip.blendMode;
      nextClip.userData = {
        ...clip.userData,
        rootMotionUnbaked: true,
        rootMotionRoot: rootName,
        rootMotionHips: hipsName
      };
      return nextClip;
    },

    unbakeActiveClipHipRootMotion() {
      const entry = this.activeClipEntry;
      if (!entry?.clip || !this.model || !this.bones?.size) {
        this.setStatus("Load an animation before unbaking root motion");
        return false;
      }
      if (entry.clip.userData?.rootMotionUnbaked) {
        this.setStatus("Root motion is already unbaked");
        return false;
      }
      const hips = this.rootMotionUnbakeHipBone();
      if (!hips) {
        this.setStatus("Could not find Hips/Pelvis bone");
        return false;
      }
      const root = this.ensureRootMotionUnbakeBone(hips);
      if (!root) {
        this.setStatus("Could not create Root bone");
        return false;
      }
      const nextClip = this.unbakedRootMotionClip(entry.clip, {
        hipsName: hips.name,
        rootName: root.name
      });
      if (!nextClip) {
        this.setStatus("No horizontal Hips root motion found");
        return false;
      }
      entry.clip = nextClip;
      entry.sourceClip = nextClip.clone();
      entry.startOffsetSeconds = 0;
      const actionKey = this.rootMotionUnbakeActionKey(entry);
      if (!this.rootMotionUnbakeActions) {
        this.rootMotionUnbakeActions = new Map();
      }
      if (actionKey) {
        this.rootMotionUnbakeActions.set(actionKey, {
          root: root.name,
          hips: hips.name,
          axes: "xz"
        });
      }
      this.lastClipSampleTime = null;
      this.syncPatchJson?.();
      this.syncExportButtons?.();
      void this.playClipEntry?.(entry).then(() => {
        this.applyPose?.(this.progress);
        this.syncPoseControlsToCurrentBone?.();
        this.refreshRigControls?.(hips.name);
        this.refreshRigOverlays?.();
        this.syncPatchJson?.();
      });
      this.setStatus(`Unbaked Hips X/Z motion to ${root.name}`);
      return true;
    },

    applySerializedRootMotionUnbakes(records = []) {
      this.rootMotionUnbakeActions = new Map();
      if (!Array.isArray(records) || !records.length) {
        return false;
      }
      let changed = false;
      for (const record of records) {
        const action = String(record?.action || "").trim();
        if (!action) {
          continue;
        }
        const rootName = this.sanitizeNewBoneName?.(record.root) || "Root";
        const hipsName = this.sanitizeNewBoneName?.(record.hips) || "";
        this.rootMotionUnbakeActions.set(action, {
          root: rootName,
          hips: hipsName,
          axes: "xz"
        });
      }
      for (const entry of this.clipEntries || []) {
        const action = this.rootMotionUnbakeActionKey(entry);
        const record = this.rootMotionUnbakeActions.get(action);
        if (!record || !entry?.clip || entry.clip.userData?.rootMotionUnbaked) {
          continue;
        }
        const hips = this.bones.get(record.hips) || this.rootMotionUnbakeHipBone();
        const root = this.ensureRootMotionUnbakeBone(hips, { name: record.root });
        if (!hips || !root) {
          continue;
        }
        const nextClip = this.unbakedRootMotionClip(entry.clip, {
          hipsName: hips.name,
          rootName: root.name
        });
        if (!nextClip) {
          continue;
        }
        entry.clip = nextClip;
        entry.sourceClip = nextClip.clone();
        entry.startOffsetSeconds = 0;
        changed = true;
      }
      return changed;
    }
  });
}
