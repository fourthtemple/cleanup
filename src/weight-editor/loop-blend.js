export function installLoopBlendMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    CURVE_CHANNELS,
    CURVE_CHANNEL_KEYS,
    finitePoseValue
  } = deps;

  const ZERO_POSE = Object.freeze({ x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0 });
  const LOOP_TAIL_PATTERN = /tail/i;

  Object.assign(BirdWeightEditor.prototype, {
    loopBlendDurationFrames() {
      const timelineFrames = Math.max(1, Math.round(Number(this.timelineFrames) || 1));
      const duration = Math.max(0.001, Number(this.currentActionDuration?.()) || 3);
      const seconds = Number(this.currentBlendSeconds?.()) || Number(this.timelineBlendControl?.value) || 0.35;
      return THREE.MathUtils.clamp(Math.round((seconds / duration) * timelineFrames), 2, timelineFrames);
    },

    loopBlendBoneDepth(name) {
      let depth = 0;
      let bone = this.bones.get(name);
      const seen = new Set();
      while (bone?.parent?.isBone && !seen.has(bone.parent)) {
        seen.add(bone.parent);
        bone = bone.parent;
        depth += 1;
      }
      return depth;
    },

    loopBlendTailBoneNames() {
      return [...this.bones.keys()]
        .filter((name) => LOOP_TAIL_PATTERN.test(this.boneDisplayName?.(name) || name))
        .sort((a, b) => this.loopBlendBoneDepth(a) - this.loopBlendBoneDepth(b) || a.localeCompare(b));
    },

    loopBlendBaseTargetBoneNames() {
      const selected = this.poseBoneSelect?.value || this.activeBoneName || "";
      const selectedChain = this.selectedBoneChainNames?.() || [];
      if (selected && selectedChain.length > 1 && selectedChain.includes(selected)) {
        return selectedChain;
      }
      if (selected && LOOP_TAIL_PATTERN.test(this.boneDisplayName?.(selected) || selected)) {
        const tailNames = this.loopBlendTailBoneNames();
        if (tailNames.length) {
          return tailNames;
        }
      }
      return selected && this.bones.has(selected) ? [selected] : [];
    },

    loopBlendTargetBoneNames() {
      const names = new Set();
      for (const name of this.loopBlendBaseTargetBoneNames()) {
        for (const [targetName] of this.mirroredBoneEntries?.(name, ZERO_POSE) || [[name, ZERO_POSE]]) {
          if (this.bones.has(targetName)) {
            names.add(targetName);
          }
        }
      }
      return [...names].sort((a, b) => this.loopBlendBoneDepth(a) - this.loopBlendBoneDepth(b) || a.localeCompare(b));
    },

    loopBlendPoseAtFrame(frame, boneNames) {
      const targetFrame = Math.max(0, Math.min(this.timelineFrames, Math.round(frame)));
      const interpolated = this.interpolatedPoseForFrame(targetFrame);
      const keyed = this.poseKeyframes.get(targetFrame) || {};
      const poseByBone = new Map();
      for (const boneName of boneNames) {
        const pose = this.clonePose?.({
          ...(interpolated[boneName] || {}),
          ...(keyed[boneName] || {})
        }) || {};
        if (targetFrame === this.currentFrame?.() && this.manualPose?.has(boneName)) {
          Object.assign(pose, this.clonePose(this.manualPose.get(boneName)));
        }
        poseByBone.set(boneName, pose);
      }
      return poseByBone;
    },

    loopBlendChannelsForBone(boneName, startPose = {}, blendStartPose = {}) {
      const channels = new Set();
      const addPoseChannels = (pose, includeZero = false) => {
        for (const channel of CURVE_CHANNEL_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(pose || {}, channel)) {
            continue;
          }
          if (includeZero || Math.abs(finitePoseValue(pose[channel])) > 0.00001) {
            channels.add(channel);
          }
        }
      };
      addPoseChannels(this.poseKeyframes.get(0)?.[boneName], true);
      addPoseChannels(this.manualPose?.get(boneName), true);
      addPoseChannels(startPose);
      addPoseChannels(blendStartPose);
      for (const framePose of this.poseKeyframes.values()) {
        addPoseChannels(framePose?.[boneName], true);
      }
      return [...channels].filter((channel) => CURVE_CHANNELS[channel]);
    },

    loopBlendHasInteriorChannelKey(boneName, channel, beforeFrame) {
      return [...this.poseKeyframes.entries()].some(([frame, framePose]) => (
        frame > 0
        && frame < beforeFrame
        && framePose?.[boneName]?.[channel] !== undefined
      ));
    },

    setLoopBlendChannelValue(frame, boneName, channel, value) {
      const targetFrame = Math.max(0, Math.min(this.timelineFrames, Math.round(frame)));
      const framePose = this.poseKeyframes.get(targetFrame) || {};
      const bonePose = this.clonePose?.(framePose[boneName] || {}) || {};
      bonePose[channel] = finitePoseValue(value);
      framePose[boneName] = bonePose;
      this.poseKeyframes.set(targetFrame, framePose);
    },

    loopBlendLayerValue(frame, boneName, channel, sampledValue, adaptiveAbsoluteEdit) {
      if (adaptiveAbsoluteEdit) {
        return this.adaptiveValueFromAbsoluteValue?.(frame, boneName, channel, sampledValue) ?? finitePoseValue(sampledValue);
      }
      return finitePoseValue(sampledValue);
    },

    blendSelectedPoseBackToStart() {
      if (!this.model || !this.bones?.size) {
        this.setStatus("Load a rig before looping pose keys");
        return false;
      }
      const targetNames = this.loopBlendTargetBoneNames();
      if (!targetNames.length) {
        this.setStatus("Select a bone or chain to loop");
        return false;
      }

      this.stopSequencePreview?.({ applyPose: false, resetElapsed: true });
      this.pausePlayback?.();

      const endFrame = Math.max(1, Math.round(Number(this.timelineFrames) || 1));
      const blendFrames = this.loopBlendDurationFrames();
      const blendStartFrame = Math.max(0, endFrame - blendFrames);
      const startPoses = this.loopBlendPoseAtFrame(0, targetNames);
      const blendStartPoses = this.loopBlendPoseAtFrame(blendStartFrame, targetNames);
      const plan = [];
      for (const boneName of targetNames) {
        const startPose = startPoses.get(boneName) || {};
        const blendStartPose = blendStartPoses.get(boneName) || {};
        for (const channel of this.loopBlendChannelsForBone(boneName, startPose, blendStartPose)) {
          plan.push({
            boneName,
            channel,
            startPose,
            blendStartPose,
            hasInteriorKey: this.loopBlendHasInteriorChannelKey(boneName, channel, blendStartFrame)
          });
        }
      }
      if (!plan.length) {
        this.setStatus("No pose channels to loop on the selected target");
        return false;
      }

      const useAdaptiveEdit = this.canUseAdaptiveEditForCurrentLayer?.() === true;
      const adaptiveAbsoluteEdit = this.shouldConvertSolvedEditToAdaptive?.() === true;
      if (useAdaptiveEdit) {
        this.prepareAdaptivePoseLayerForEdit?.();
      }
      this.markPoseKeyframesAuthored?.();

      let channelCount = 0;
      for (const { boneName, channel, startPose, blendStartPose, hasInteriorKey } of plan) {
        const startValue = this.loopBlendLayerValue(
          0,
          boneName,
          channel,
          finitePoseValue(startPose[channel]),
          adaptiveAbsoluteEdit
        );
        const holdSample = hasInteriorKey
          ? finitePoseValue(blendStartPose[channel])
          : finitePoseValue(startPose[channel]);
        const holdValue = this.loopBlendLayerValue(
          blendStartFrame,
          boneName,
          channel,
          holdSample,
          adaptiveAbsoluteEdit
        );
        const endValue = this.loopBlendLayerValue(
          endFrame,
          boneName,
          channel,
          finitePoseValue(startPose[channel]),
          adaptiveAbsoluteEdit
        );
        this.setLoopBlendChannelValue(0, boneName, channel, startValue);
        this.setLoopBlendChannelValue(blendStartFrame, boneName, channel, holdValue);
        this.setLoopBlendChannelValue(endFrame, boneName, channel, endValue);
        this.setCurveHandleFor?.(boneName, channel, blendStartFrame, { outSlope: 0 });
        this.setCurveHandleFor?.(boneName, channel, endFrame, { inSlope: 0 });
        channelCount += 1;
      }
      for (const boneName of targetNames) {
        this.manualPose?.delete(boneName);
      }

      this.progress = 1;
      if (this.timeScrub) {
        this.timeScrub.value = String(this.progress);
      }
      this.syncTimelineControls?.();
      this.applyPose(this.progress);
      this.syncPoseControlsToCurrentBone?.();
      this.syncPatchJson?.();
      this.updateTimelineKeyMarkers?.();
      this.updateCounts?.();
      const targetLabel = targetNames.length === 1
        ? this.boneDisplayName(targetNames[0])
        : `${targetNames.length}-bone chain`;
      this.setStatus(`Looped ${targetLabel} to frame 0 over ${blendFrames} frames`);
      return true;
    }
  });
}
