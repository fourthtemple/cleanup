export function installPoseClipboardMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    CURVE_CHANNEL_KEYS,
    finitePoseValue
  } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    poseClipboardSelectedChainMemberNames() {
      const selected = Array.from(this.addBoneChainMembersSelect?.selectedOptions || [])
        .map((option) => option.value)
        .filter((name) => this.bones.has(name));
      const ordered = this.orderedBoneChainSelection?.(selected) || selected;
      return ordered.length > 1 ? ordered : [];
    },

    poseClipboardTargetNames(boneName = this.poseBoneSelect?.value || this.activeBoneName || "") {
      const selectedMembers = this.poseClipboardSelectedChainMemberNames();
      if (selectedMembers.length > 1) {
        return selectedMembers;
      }
      if (!boneName || !this.bones.has(boneName)) {
        return [];
      }
      const selectedChain = this.selectedBoneChainNames?.() || [];
      if (selectedChain.length > 1 && selectedChain.includes(boneName)) {
        return selectedChain.filter((name) => this.bones.has(name));
      }
      for (const chain of this.poseEditChainCandidates?.(boneName) || []) {
        if (chain.length > 1 && chain.includes(boneName)) {
          return chain.filter((name) => this.bones.has(name));
        }
      }
      return [boneName];
    },

    poseClipboardFramePose(frame, boneNames) {
      const targetFrame = Math.max(0, Math.min(this.timelineFrames, Math.round(frame)));
      const previousProgress = this.progress;
      this.progress = targetFrame / Math.max(1, this.timelineFrames);
      if (this.timeScrub) {
        this.timeScrub.value = String(this.progress);
      }
      this.syncTimelineControls?.();
      this.applyPose(this.progress);
      this.model?.updateMatrixWorld(true);
      const poses = {};
      for (const boneName of boneNames) {
        poses[boneName] = this.clonePose?.(this.getBoneRelativePose(boneName)) || {};
      }
      this.progress = previousProgress;
      if (this.timeScrub) {
        this.timeScrub.value = String(this.progress);
      }
      this.syncTimelineControls?.();
      this.applyPose(this.progress);
      this.model?.updateMatrixWorld(true);
      return poses;
    },

    copyCurrentPoseToClipboard() {
      if (!this.model || !this.bones?.size) {
        this.setStatus("Load a rig before copying pose");
        return false;
      }
      const frame = this.currentFrame();
      const boneName = this.poseBoneSelect?.value || this.activeBoneName || "";
      const boneNames = this.poseClipboardTargetNames(boneName);
      if (!boneNames.length) {
        this.setStatus("Select a bone or chain to copy");
        return false;
      }
      const poses = this.poseClipboardFramePose(frame, boneNames);
      this.poseClipboard = {
        frame,
        boneNames,
        poses,
        copiedAt: Date.now()
      };
      this.syncPoseClipboardControls?.();
      const label = boneNames.length === 1
        ? this.boneDisplayName(boneNames[0])
        : `${boneNames.length}-bone chain`;
      this.setStatus(`Copied ${label} pose from frame ${frame}`);
      return true;
    },

    poseClipboardPasteEntries() {
      const clipboard = this.poseClipboard;
      if (!clipboard?.boneNames?.length || !clipboard?.poses) {
        return [];
      }
      const targetNames = this.poseClipboardTargetNames();
      const entries = [];
      if (targetNames.length === clipboard.boneNames.length) {
        for (let index = 0; index < targetNames.length; index += 1) {
          const sourceName = clipboard.boneNames[index];
          const targetName = targetNames[index];
          const pose = clipboard.poses[sourceName];
          if (pose && this.bones.has(targetName)) {
            entries.push({ sourceName, targetName, pose });
          }
        }
      } else {
        for (const sourceName of clipboard.boneNames) {
          const pose = clipboard.poses[sourceName];
          if (pose && this.bones.has(sourceName)) {
            entries.push({ sourceName, targetName: sourceName, pose });
          }
        }
      }
      return entries;
    },

    storedPoseForPastedAbsolutePose(frame, boneName, pose) {
      const cloned = this.clonePose?.(pose) || {};
      if (this.actorTarget?.mode !== "bird-flap" && this.poseKeyframeMode !== "replace") {
        const basePose = this.basePoseForFrame?.(frame, boneName) || {};
        const result = {};
        for (const channel of CURVE_CHANNEL_KEYS) {
          if (cloned[channel] !== undefined) {
            result[channel] = finitePoseValue(cloned[channel] - finitePoseValue(basePose[channel]));
          }
        }
        return result;
      }
      return cloned;
    },

    pastePoseClipboardToCurrentFrame() {
      if (!this.poseClipboard) {
        this.setStatus("Copy a pose first");
        return false;
      }
      const entries = this.poseClipboardPasteEntries();
      if (!entries.length) {
        this.setStatus("Copied pose does not match the selected rig");
        return false;
      }

      this.stopSequencePreview?.({ applyPose: false, resetElapsed: true });
      this.pausePlayback?.();
      const frame = this.currentFrame();
      const useAdaptiveEdit = this.canUseAdaptiveEditForCurrentLayer?.() === true;
      if (useAdaptiveEdit) {
        this.prepareAdaptivePoseLayerForEdit?.();
      }
      this.markPoseKeyframesAuthored?.();

      const framePose = this.poseKeyframes.get(frame) || {};
      for (const { targetName, pose } of entries) {
        const storedPose = this.storedPoseForPastedAbsolutePose(frame, targetName, pose);
        framePose[targetName] = storedPose;
        this.manualPose?.delete(targetName);
        if (this.actorTarget?.mode !== "bird-flap" && this.poseKeyframeMode !== "replace") {
          this.ensureAdditivePoseAnchors?.(targetName, frame, CURVE_CHANNEL_KEYS);
        }
        for (const channel of Object.keys(storedPose)) {
          this.deleteCurveHandlesForPoint?.(targetName, channel, frame);
        }
      }
      this.poseKeyframes.set(frame, framePose);
      this.progress = frame / Math.max(1, this.timelineFrames);
      if (this.timeScrub) {
        this.timeScrub.value = String(this.progress);
      }
      this.syncTimelineControls?.();
      this.applyPose(this.progress);
      this.syncPoseControlsToCurrentBone?.();
      this.syncPatchJson?.();
      this.updateTimelineKeyMarkers?.();
      this.updateCounts?.();
      this.syncPoseClipboardControls?.();
      const label = entries.length === 1
        ? this.boneDisplayName(entries[0].targetName)
        : `${entries.length}-bone chain`;
      this.setStatus(`Pasted ${label} pose to frame ${frame}`);
      return true;
    },

    syncPoseClipboardControls() {
      const hasClipboard = Boolean(this.poseClipboard?.boneNames?.length);
      if (this.copyPoseButton) {
        this.copyPoseButton.disabled = !this.model || !this.bones?.size;
      }
      if (this.pastePoseButton) {
        this.pastePoseButton.disabled = !hasClipboard;
      }
    }
  });
}
