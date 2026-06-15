export function installTimelineSolvedKeyMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    hasGeneratedTimelineGuideKeys() {
      return this.poseKeyframeMode === "replace"
        && this.poseKeyframesGenerated
        && this.poseKeyframes.size > 0;
    },

    timelineKeysAreActiveSource() {
      return this.poseKeyframeMode === "replace"
        && this.poseKeyframes.size > 0
        && !this.poseKeyframesGenerated;
    },

    currentTimelineEditMode() {
      const selectMode = this.motionConversionModeSelect?.value || "";
      if (["solved", "adaptive", "additive"].includes(selectMode)) {
        return selectMode;
      }
      if (this.useTimelineKeysToggle?.checked) {
        return "solved";
      }
      if (this.adaptiveEditToggle?.checked) {
        return "adaptive";
      }
      if (this.additiveKinematicsToggle?.checked) {
        return "additive";
      }
      return "additive";
    },

    shouldUseTimelineKeysAsSource() {
      return this.currentTimelineEditMode?.() === "solved";
    },

    timelineEditModeLabel(mode = this.currentTimelineEditMode?.()) {
      if (mode === "solved") {
        return "solved keys";
      }
      if (mode === "adaptive") {
        return "adaptive keys";
      }
      return "additive kinematics";
    },

    canConvertCurrentMotion() {
      return Boolean(this.model && (this.actorTarget?.mode === "bird-flap" || this.activeClipEntry));
    },

    hasResolvedMotionEdits() {
      if (!this.poseKeyframes?.size) {
        return false;
      }
      return !(this.poseKeyframeMode === "replace" && this.poseKeyframesGenerated);
    },

    normalizeTimelineEditMode(preferred = "") {
      const mode = ["solved", "adaptive", "additive"].includes(preferred)
        ? preferred
        : this.currentTimelineEditMode?.() || "additive";
      if (this.motionConversionModeSelect) {
        this.motionConversionModeSelect.value = mode;
      }
      if (!this.useTimelineKeysToggle || !this.adaptiveEditToggle) {
        return;
      }
      const additiveToggle = this.additiveKinematicsToggle;
      this.useTimelineKeysToggle.checked = mode === "solved";
      this.adaptiveEditToggle.checked = mode === "adaptive";
      if (additiveToggle) {
        additiveToggle.checked = mode === "additive";
      }
      if (!this.useTimelineKeysToggle.checked && !this.adaptiveEditToggle.checked && !additiveToggle?.checked) {
        if (additiveToggle) {
          additiveToggle.checked = true;
          if (this.motionConversionModeSelect) {
            this.motionConversionModeSelect.value = "additive";
          }
        } else {
          this.adaptiveEditToggle.checked = true;
          if (this.motionConversionModeSelect) {
            this.motionConversionModeSelect.value = "adaptive";
          }
        }
      }
    },

    syncTimelineSourceControl() {
      if (!this.useTimelineKeysToggle) {
        this.syncMotionConversionApplyButton?.();
        return;
      }
      this.normalizeTimelineEditMode?.();
      const hasKeys = this.poseKeyframeMode === "replace" && this.poseKeyframes.size > 0;
      const hasGeneratedGuides = this.hasGeneratedTimelineGuideKeys();
      const sourceActive = this.timelineKeysAreActiveSource();
      this.useTimelineKeysToggle.disabled = false;
      this.useTimelineKeysToggle.title = hasGeneratedGuides
        ? "Use the auto-solved timeline keys as the editable animation source"
        : hasKeys ? "Timeline keys are the editable animation source" : "Auto-solved guide keys will appear after loading an animation";
      this.useTimelineKeysToggle.setAttribute("aria-pressed", String(sourceActive));
      if (this.adaptiveEditToggle) {
        this.adaptiveEditToggle.title = "Edit inside solved blue curve regions for precise animation changes";
        this.adaptiveEditToggle.setAttribute("aria-pressed", String(this.currentTimelineEditMode() === "adaptive"));
      }
      if (this.additiveKinematicsToggle) {
        this.additiveKinematicsToggle.title = "Use broad FK/IK offsets over the animation without promoting solved regions";
        this.additiveKinematicsToggle.setAttribute("aria-pressed", String(this.currentTimelineEditMode() === "additive"));
      }
      const currentMode = this.currentTimelineEditMode();
      if (this.motionConversionModeSelect) {
        this.motionConversionModeSelect.value = currentMode;
        this.motionConversionModeSelect.title = "Choose how motion edits are converted for keying";
      }
      const keyDetailField = this.solvedKeyDetail?.closest?.(".motion-key-detail-field");
      if (keyDetailField) {
        const showKeyDetail = currentMode === "solved" || currentMode === "adaptive";
        keyDetailField.hidden = !showKeyDetail;
        keyDetailField.setAttribute("aria-hidden", showKeyDetail ? "false" : "true");
      }
      this.syncMotionConversionApplyButton?.();
    },

    syncMotionConversionApplyButton() {
      if (!this.motionConversionApplyButton) {
        return;
      }
      const enabled = this.canConvertCurrentMotion?.() === true;
      const mode = this.currentTimelineEditMode?.() || "additive";
      const label = this.timelineEditModeLabel?.(mode) || "selected motion mode";
      this.motionConversionApplyButton.disabled = !enabled;
      this.motionConversionApplyButton.title = enabled
        ? `Convert the open animation to ${label}`
        : "Load a character animation before converting motion";
    },

    async convertCurrentMotionToSelectedMode(options = {}) {
      const mode = this.currentTimelineEditMode?.() || "additive";
      this.normalizeTimelineEditMode?.(mode);
      if (!this.canConvertCurrentMotion?.()) {
        this.syncMotionConversionApplyButton?.();
        if (!options.silent) {
          this.setStatus(this.model ? "Choose an animation first" : "Load a character first");
        }
        return false;
      }

      const outputAdditive = mode === "additive";
      if (outputAdditive && !this.hasResolvedMotionEdits?.()) {
        const converted = this.setTimelineEditMode?.("additive", options) !== false;
        this.syncMotionConversionApplyButton?.();
        if (converted && !options.silent) {
          this.setStatus(this.additiveKinematicsStatusText?.() || "Additive kinematics ready");
        }
        return converted;
      }

      if (typeof this.autoKeyActiveClip !== "function") {
        this.syncMotionConversionApplyButton?.();
        if (!options.silent) {
          this.setStatus("Motion conversion is not available");
        }
        return false;
      }

      const button = this.motionConversionApplyButton;
      if (button) {
        button.disabled = true;
      }
      try {
        if (!options.silent) {
          this.setStatus(`Converting motion to ${this.timelineEditModeLabel?.(mode) || mode}...`);
        }
        const settings = this.autoKeyDetailSettings?.(options) || {};
        const solution = await this.autoKeyActiveClip({
          ...settings,
          minKeys: options.minKeys || 6,
          pushUndo: options.pushUndo !== false,
          generated: mode === "adaptive",
          outputAdditive,
          sampleResolvedMotion: true,
          selectPrimaryBone: false,
          silent: true
        });
        if (!solution) {
          this.syncTimelineSourceControl?.();
          if (!options.silent) {
            this.setStatus("Could not convert the current motion");
          }
          return false;
        }
        this.normalizeTimelineEditMode?.(mode);
        this.syncTimelineSourceControl?.();
        this.updateRangeOutputs?.();
        if (!options.silent) {
          const label = this.activeClipEntry?.name || this.activeClipEntry?.id || solution.label || "animation";
          this.setStatus(`Resolved ${label} to ${this.timelineEditModeLabel?.(mode) || mode}`);
        }
        return true;
      } finally {
        this.syncMotionConversionApplyButton?.();
      }
    },

    syncTimelineSourceButton() {
      this.syncTimelineSourceControl();
    },

    useTimelineGuideKeysAsSource(options = {}) {
      if (!this.hasGeneratedTimelineGuideKeys()) {
        this.syncTimelineSourceControl();
        if (!options.silent) {
          this.setStatus(this.poseKeyframes.size ? "Timeline keys are already active" : "No timeline guide keys yet");
        }
        return false;
      }
      this.stopSequencePreview?.({ applyPose: false, resetElapsed: true });
      this.pausePlayback?.();
      this.manualPose.clear();
      this.manualPoseAdditiveNames?.clear?.();
      this.manualPoseEditedChannels?.clear?.();
      this.poseKeyframesGenerated = false;
      this.timelineKeysSourceWasAutoGenerated = true;
      this.applyPose(this.progress);
      this.syncPoseControlsToCurrentBone();
      this.syncTimelineControls();
      this.updateTimelineKeyMarkers();
      this.updateBoneLayerValues({ force: true });
      this.syncPatchJson();
      this.updateCounts();
      this.syncTimelineSourceControl();
      if (!options.silent) {
        this.setStatus("Timeline keys are now the animation source");
      }
      return true;
    },

    useRawClipWithTimelineGuides(options = {}) {
      if (!this.timelineKeysAreActiveSource()) {
        this.syncTimelineSourceControl();
        if (!options.silent) {
          this.setStatus(this.poseKeyframes.size ? "Raw FBX clip is already active" : "No timeline keys yet");
        }
        return false;
      }
      if (!this.timelineKeysSourceWasAutoGenerated) {
        if (this.useTimelineKeysToggle) {
          this.useTimelineKeysToggle.checked = true;
        }
        this.syncTimelineSourceControl();
        if (!options.silent) {
          this.setStatus("Edited timeline keys stay active");
        }
        return false;
      }
      this.stopSequencePreview?.({ applyPose: false, resetElapsed: true });
      this.pausePlayback?.();
      this.manualPose.clear();
      this.manualPoseAdditiveNames?.clear?.();
      this.manualPoseEditedChannels?.clear?.();
      this.poseKeyframesGenerated = true;
      this.timelineKeysSourceWasAutoGenerated = false;
      this.applyPose(this.progress);
      this.syncPoseControlsToCurrentBone();
      this.syncTimelineControls();
      this.updateTimelineKeyMarkers();
      this.updateBoneLayerValues({ force: true });
      this.syncPatchJson();
      this.updateCounts();
      this.syncTimelineSourceControl();
      if (!options.silent) {
        this.setStatus("Raw FBX clip is active; timeline keys are guides");
      }
      return true;
    },

    setTimelineKeysSourceEnabled(enabled, options = {}) {
      return this.setTimelineEditMode?.(enabled ? "solved" : "adaptive", options);
    },

    setTimelineEditMode(mode = "additive", options = {}) {
      const targetMode = ["solved", "adaptive", "additive"].includes(mode) ? mode : "additive";
      this.normalizeTimelineEditMode?.(targetMode);
      if (targetMode === "solved") {
        return this.useTimelineGuideKeysAsSource(options);
      }
      if (this.timelineKeysAreActiveSource?.() && this.timelineKeysSourceWasAutoGenerated) {
        this.useRawClipWithTimelineGuides({ ...options, silent: true });
      }
      if (targetMode === "additive") {
        this.syncTimelineSourceControl?.();
        if (!options.silent) {
          this.setStatus(this.additiveKinematicsStatusText?.() || "Additive kinematics enabled");
        }
        return true;
      }
      this.syncTimelineSourceControl?.();
      if (!options.silent) {
        this.setStatus("Adaptive edits enabled");
      }
      return true;
    }
  });
}
