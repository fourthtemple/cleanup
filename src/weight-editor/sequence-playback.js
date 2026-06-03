export function installSequencePlaybackMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    OrbitControls,
    TransformControls,
    cloneClipWithStartOffsetApplied,
    configuredClipStartOffsetSeconds,
    remainingClipStartOffsetSeconds,
    loadBirdFlapProfile,
    BIRD_WEIGHT_PATCH_FILE_NAME,
    ACTOR_TARGETS,
    WING_BONES,
    BODY_BONES,
    PREVIEW_PARAMS,
    BASE_COLOR,
    SELECTED_COLOR,
    MODIFIED_COLOR,
    SELECTED_MODIFIED_COLOR,
    CURVE_CHANNELS,
    CURVE_CHANNEL_KEYS,
    ADDITIVE_POSE_EASE_FRAMES,
    RIG_BONE_GROUPS,
    EDIT_ONLY_TOOLS,
    finitePoseValue,
    writeJsonFile
  } = deps;
  Object.assign(BirdWeightEditor.prototype, {
    applyClipBasePose(progress) {
      if (!this.mixer || !this.activeClipAction) {
        return;
      }
      const clip = this.activeClipAction.getClip();
      const duration = clip?.duration || 1;
      const configuredOffset = configuredClipStartOffsetSeconds(this.activeClipEntry, this.actorTarget);
      const startOffset = Math.min(
        remainingClipStartOffsetSeconds(clip, configuredOffset),
        Math.max(0, duration - 0.001)
      );
      const sampleDuration = Math.max(0.001, duration - startOffset);
      const sampleTime = startOffset + THREE.MathUtils.clamp(progress, 0, 1) * sampleDuration;
      const clipTime = THREE.MathUtils.clamp(sampleTime, 0, Math.max(0, duration - 0.001));
      this.activeClipAction.reset();
      this.activeClipAction.enabled = true;
      this.activeClipAction.paused = false;
      this.activeClipAction.setEffectiveWeight(1);
      this.activeClipAction.play();
      const mixerTime = Number.isFinite(this.mixer.time) ? this.mixer.time : Number.POSITIVE_INFINITY;
      if (
        this.forceNextClipSample
        || Math.abs((this.lastClipSampleTime ?? Number.POSITIVE_INFINITY) - clipTime) < 0.000001
        || Math.abs(mixerTime - clipTime) < 0.000001
      ) {
        const nudgeTime = clipTime > 0.001
          ? clipTime - 0.001
          : Math.min(Math.max(0, duration - 0.001), clipTime + 0.001);
        this.mixer.setTime(nudgeTime);
      }
      this.mixer.setTime(clipTime);
      this.forceNextClipSample = false;
      this.lastClipSampleTime = clipTime;
    },

    clipSampleInfoForEntry(entry) {
      const clip = entry?.clip;
      const duration = clip?.duration || 1;
      const configuredOffset = configuredClipStartOffsetSeconds(entry, this.actorTarget);
      const startOffset = Math.min(
        remainingClipStartOffsetSeconds(clip, configuredOffset),
        Math.max(0, duration - 0.001)
      );
      return {
        duration,
        startOffset,
        sampleDuration: Math.max(0.001, duration - startOffset)
      };
    },

    clipTimeForEntry(entry, progress) {
      const info = this.clipSampleInfoForEntry(entry);
      const sampleTime = info.startOffset + THREE.MathUtils.clamp(progress, 0, 1) * info.sampleDuration;
      return THREE.MathUtils.clamp(sampleTime, 0, Math.max(0, info.duration - 0.001));
    },

    sampleClipEntryAtProgress(entry, action, progress, weight) {
      if (!this.mixer || !this.model || !entry?.clip || weight <= 0.0001) {
        action?.stop();
        return action || null;
      }
      const nextAction = action || this.mixer.clipAction(entry.clip, this.model);
      nextAction.reset();
      nextAction.enabled = true;
      nextAction.paused = true;
      nextAction.clampWhenFinished = true;
      nextAction.setLoop(THREE.LoopOnce, 1);
      nextAction.setEffectiveTimeScale(1);
      nextAction.setEffectiveWeight(THREE.MathUtils.clamp(weight, 0, 1));
      nextAction.play();
      nextAction.time = this.clipTimeForEntry(entry, progress);
      return nextAction;
    },

    sequenceDurationSeconds() {
      if (!this.activeClipEntry?.clip || !this.blendClipEntry?.clip) {
        return 0;
      }
      const activeInfo = this.clipSampleInfoForEntry(this.activeClipEntry);
      const blendInfo = this.clipSampleInfoForEntry(this.blendClipEntry);
      return activeInfo.sampleDuration + this.currentBlendSeconds() + blendInfo.sampleDuration;
    },

    sequencePhaseInfo(elapsed = this.sequenceElapsed) {
      if (!this.activeClipEntry?.clip || !this.blendClipEntry?.clip) {
        return {
          key: "none",
          label: "Ready",
          elapsed: 0,
          duration: 0,
          total: 0,
          sourceDuration: 0,
          mixDuration: 0,
          targetDuration: 0
        };
      }
      const activeInfo = this.clipSampleInfoForEntry(this.activeClipEntry);
      const blendInfo = this.clipSampleInfoForEntry(this.blendClipEntry);
      const blendSeconds = this.currentBlendSeconds();
      const sourceDuration = activeInfo.sampleDuration;
      const mixDuration = blendSeconds;
      const targetDuration = blendInfo.sampleDuration;
      const total = sourceDuration + mixDuration + targetDuration;
      const time = THREE.MathUtils.clamp(elapsed, 0, total);
      const base = { total, sourceDuration, mixDuration, targetDuration };
      if (time <= sourceDuration) {
        return { ...base, key: "source", label: "Initial", elapsed: time, duration: sourceDuration };
      }
      const afterSource = time - sourceDuration;
      if (afterSource <= mixDuration) {
        return { ...base, key: "mix", label: "Mixer", elapsed: afterSource, duration: mixDuration };
      }
      return { ...base, key: "target", label: "Second", elapsed: afterSource - mixDuration, duration: targetDuration };
    },

    syncSequenceControls(options = {}) {
      const now = Number.isFinite(options.now) ? options.now : performance.now();
      if (options.throttle && !options.force) {
        const interval = Number(this.sequenceReadoutIntervalMs) || 180;
        if (now - (this.sequenceReadoutLastUpdate || 0) < interval) {
          return false;
        }
      }
      this.sequenceReadoutLastUpdate = now;
      const phase = this.sequencePhaseInfo();
      const total = phase.total;
      const normalized = total > 0 ? THREE.MathUtils.clamp(this.sequenceElapsed / total, 0, 1) : 0;
      if (this.timelineSequenceScrub) {
        this.timelineSequenceScrub.disabled = !this.blendActionId || total <= 0;
        this.timelineSequenceScrub.value = String(Math.round(normalized * 1000));
      }
      if (this.sequenceReadout) {
        if (!this.blendActionId) {
          this.sequenceReadout.textContent = "Choose target";
        } else if (total <= 0) {
          this.sequenceReadout.textContent = "Loading";
        } else if (this.sequencePlaying) {
          this.sequenceReadout.textContent = phase.label + " " + phase.elapsed.toFixed(2) + "s / " + phase.duration.toFixed(2) + "s";
        } else {
          this.sequenceReadout.textContent = "3 parts, " + total.toFixed(2) + "s";
        }
      }
      const sourceWidth = total > 0 ? (phase.sourceDuration / total) * 100 : 33.333;
      const mixWidth = total > 0 ? (phase.mixDuration / total) * 100 : 33.333;
      const targetWidth = total > 0 ? (phase.targetDuration / total) * 100 : 33.333;
      this.sequencePhaseTrack?.style.setProperty("--sequence-source-width", sourceWidth + "%");
      this.sequencePhaseTrack?.style.setProperty("--sequence-mix-width", mixWidth + "%");
      this.sequencePhaseTrack?.style.setProperty("--sequence-target-width", targetWidth + "%");
      for (const node of this.sequencePhaseTrack?.querySelectorAll("[data-sequence-phase]") || []) {
        node.classList.toggle("is-active", node.dataset.sequencePhase === phase.key);
      }
      if (this.sequenceSourceReadout) {
        this.sequenceSourceReadout.textContent = total > 0 ? phase.sourceDuration.toFixed(2) + "s" : "--";
      }
      if (this.sequenceMixReadout) {
        this.sequenceMixReadout.textContent = total > 0 ? phase.mixDuration.toFixed(2) + "s" : "--";
      }
      if (this.sequenceTargetReadout) {
        this.sequenceTargetReadout.textContent = total > 0 ? phase.targetDuration.toFixed(2) + "s" : "--";
      }
      return true;
    },

    applySequencePose(options = {}) {
      if (!this.mixer || !this.activeClipEntry?.clip || !this.blendClipEntry?.clip) {
        return;
      }
      const activeInfo = this.clipSampleInfoForEntry(this.activeClipEntry);
      const blendInfo = this.clipSampleInfoForEntry(this.blendClipEntry);
      const transitionSeconds = this.currentBlendSeconds();
      const time = THREE.MathUtils.clamp(this.sequenceElapsed, 0, this.sequenceDurationSeconds());
      this.resetPose();
      this.mixer.stopAllAction();

      if (time <= activeInfo.sampleDuration) {
        const activeProgress = activeInfo.sampleDuration > 0 ? time / activeInfo.sampleDuration : 1;
        this.activeClipAction = this.sampleClipEntryAtProgress(this.activeClipEntry, this.activeClipAction, activeProgress, 1);
        this.blendClipAction?.stop();
        this.mixer.update(0);
        this.applyClipOrientationForEntry?.(this.activeClipEntry);
        this.applyClipGroundOffsetForEntry?.(this.activeClipEntry);
        this.progress = THREE.MathUtils.clamp(activeProgress, 0, 1);
        this.applyPoseLayer();
        this.syncPlaybackReadouts({ now: options.now, throttle: options.throttleReadouts });
        return;
      }

      const afterActive = time - activeInfo.sampleDuration;
      if (afterActive <= transitionSeconds) {
        const rawMix = transitionSeconds > 0 ? afterActive / transitionSeconds : 1;
        const easedMix = rawMix * rawMix * (3 - 2 * rawMix);
        const rootAnchor = this.sequenceRootAnchorPosition();
        this.activeClipAction = this.sampleClipEntryAtProgress(this.activeClipEntry, this.activeClipAction, 1, 1 - easedMix);
        this.blendClipAction = this.sampleClipEntryAtProgress(this.blendClipEntry, this.blendClipAction, 0, easedMix);
        this.mixer.update(0);
        this.applySequenceRootAnchor(rootAnchor);
        this.applyClipOrientationBlend?.(this.activeClipEntry, this.blendClipEntry, easedMix);
        this.applyClipGroundOffsetY?.(
          (this.clipGroundOffsetForEntry?.(this.activeClipEntry) || 0) * (1 - easedMix)
            + (this.clipGroundOffsetForEntry?.(this.blendClipEntry) || 0) * easedMix
        );
        this.progress = 1;
        this.applyPoseLayer();
        this.syncPlaybackReadouts({ now: options.now, throttle: options.throttleReadouts });
        return;
      }

      const blendProgress = blendInfo.sampleDuration > 0
        ? (afterActive - transitionSeconds) / blendInfo.sampleDuration
        : 1;
      const rootAnchor = this.sequenceRootAnchorPosition();
      const targetRootStart = this.sequenceTargetRootStartPosition();
      this.activeClipAction?.stop();
      this.blendClipAction = this.sampleClipEntryAtProgress(this.blendClipEntry, this.blendClipAction, blendProgress, 1);
      this.mixer.update(0);
      this.applySequenceRootRebase(rootAnchor, targetRootStart);
      this.applyClipOrientationForEntry?.(this.blendClipEntry);
      this.applyClipGroundOffsetForEntry?.(this.blendClipEntry);
      this.progress = THREE.MathUtils.clamp(blendProgress, 0, 1);
      this.applyPoseLayer();
      this.syncPlaybackReadouts({ now: options.now, throttle: options.throttleReadouts });
    },

    sequenceRootBone() {
      return [...this.bones.values()].find((bone) => this.boneDisplayName(bone.name) === "Hips")
        || [...this.bones.values()].find((bone) => /hips/i.test(bone.name))
        || null;
    },

    sequenceRootAnchorPosition() {
      if (this.sequenceRootAnchor) {
        return this.sequenceRootAnchor;
      }
      const root = this.sequenceRootBone();
      if (!root || !this.mixer || !this.activeClipEntry?.clip) {
        return null;
      }
      this.resetPose();
      this.mixer.stopAllAction();
      const probe = this.sampleClipEntryAtProgress(this.activeClipEntry, null, 1, 1);
      this.mixer.update(0);
      this.sequenceRootAnchor = root.position.clone();
      probe?.stop();
      return this.sequenceRootAnchor;
    },

    sequenceTargetRootStartPosition() {
      if (this.sequenceTargetRootStart) {
        return this.sequenceTargetRootStart;
      }
      const root = this.sequenceRootBone();
      if (!root || !this.mixer || !this.blendClipEntry?.clip) {
        return null;
      }
      this.resetPose();
      this.mixer.stopAllAction();
      const probe = this.sampleClipEntryAtProgress(this.blendClipEntry, null, 0, 1);
      this.mixer.update(0);
      this.sequenceTargetRootStart = root.position.clone();
      probe?.stop();
      return this.sequenceTargetRootStart;
    },

    applySequenceRootAnchor(anchor) {
      const root = this.sequenceRootBone();
      if (root && anchor) {
        root.position.copy(anchor);
      }
    },

    applySequenceRootRebase(anchor, targetRootStart) {
      const root = this.sequenceRootBone();
      if (!root || !anchor || !targetRootStart) {
        return;
      }
      const targetDelta = root.position.clone().sub(targetRootStart);
      root.position.copy(anchor).add(targetDelta);
    },

    currentActionDuration() {
      if (this.actorTarget?.mode === "bird-flap") {
        return 3;
      }
      return this.activeClipAction?.getClip()?.duration || 3;
    },

    actionSpeedMultiplier() {
      return Number(this.activeClipEntry?.speed || 1);
    },

    applyPose(progress) {
      if (!this.model) {
        return;
      }
      const replaceBaseClip = this.poseKeyframeMode === "replace" && this.poseKeyframes.size > 0 && !this.poseKeyframesGenerated;
      this.resetPose();
      if (replaceBaseClip) {
        // Auto-keyed clips are baked into the editable pose layer, so the source clip should not play underneath.
      } else if (this.actorTarget?.mode === "bird-flap") {
        const params = this.birdFlapParams || PREVIEW_PARAMS;
        const stroke = 0.5 - 0.5 * Math.cos(progress * Math.PI * 2);
        const phase = Math.sin(progress * Math.PI * 2);
        const settle = Math.cos(progress * Math.PI * 2);

        for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
          this.setBoneEuler(
            `${side}Shoulder`,
            0,
            sign * (params.shoulderYBase + params.shoulderYStroke * stroke),
            -sign * (params.shoulderZBase + params.shoulderZStroke * stroke)
          );
          this.setBoneEuler(
            `${side}Arm`,
            0,
            sign * (params.armYBase + params.armYStroke * stroke),
            -sign * (params.armZBase + params.armZStroke * stroke)
          );
          this.setBoneEuler(
            `${side}ForeArm`,
            0,
            sign * (params.forearmYBase + params.forearmYStroke * stroke),
            -sign * (params.forearmZBase + params.forearmZStroke * stroke)
          );
          this.setBoneEuler(
            `${side}Hand`,
            0,
            sign * (params.handYBase + params.handYStroke * stroke),
            -sign * (params.handZBase + params.handZStroke * stroke)
          );
        }

        for (const boneName of BODY_BONES) {
          const bodyAmount = ["Head", "headfront", "neck"].includes(boneName) ? 0.55 : 1;
          this.setBoneEuler(boneName, params.bodyX * settle * bodyAmount, params.bodyY * phase * bodyAmount, 0);
        }
      } else {
        this.applyClipBasePose(progress);
        this.applyClipOrientationForEntry?.(this.activeClipEntry);
        this.applyClipGroundOffsetForEntry?.(this.activeClipEntry);
      }
      this.applyPoseLayer();
    }
  });
}
