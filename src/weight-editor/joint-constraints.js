export function installJointConstraintMethods(BirdWeightEditor, deps) {
  const { THREE, finitePoseValue } = deps;
  const TEMPLATE_STORAGE_KEY = "telekinetikitty-cleanup:joint-constraint-templates";
  const ROTATION_CHANNELS = ["x", "y", "z"];

  const clampRadians = (value, min, max) => THREE.MathUtils.clamp(
    finitePoseValue(value),
    finitePoseValue(min),
    finitePoseValue(max)
  );
  const toDegrees = (value) => Number(THREE.MathUtils.radToDeg(finitePoseValue(value)).toFixed(1));
  const toRadians = (value) => finitePoseValue(THREE.MathUtils.degToRad(Number(value) || 0));

  function sortedConstraintEntries(constraints) {
    return [...(constraints?.entries?.() || [])]
      .filter(([boneName, constraint]) => boneName && constraint?.enabled)
      .sort(([a], [b]) => a.localeCompare(b));
  }

  Object.assign(BirdWeightEditor.prototype, {
    defaultJointConstraint() {
      return {
        enabled: false,
        min: { x: -Math.PI, y: -Math.PI, z: -Math.PI },
        max: { x: Math.PI, y: Math.PI, z: Math.PI }
      };
    },

    normalizeJointConstraint(constraint = {}) {
      const fallback = this.defaultJointConstraint();
      const normalized = {
        enabled: Boolean(constraint.enabled),
        min: { ...fallback.min },
        max: { ...fallback.max }
      };
      for (const channel of ROTATION_CHANNELS) {
        let min = finitePoseValue(constraint.min?.[channel] ?? fallback.min[channel]);
        let max = finitePoseValue(constraint.max?.[channel] ?? fallback.max[channel]);
        min = THREE.MathUtils.clamp(min, -Math.PI * 2, Math.PI * 2);
        max = THREE.MathUtils.clamp(max, -Math.PI * 2, Math.PI * 2);
        if (min > max) {
          [min, max] = [max, min];
        }
        normalized.min[channel] = min;
        normalized.max[channel] = max;
      }
      return normalized;
    },

    jointConstraintForBone(boneName = this.poseBoneSelect?.value || this.activeBoneName) {
      const name = this.canonicalMirrorBone?.(boneName) || boneName || "";
      return this.normalizeJointConstraint(this.jointConstraints?.get?.(name) || this.defaultJointConstraint());
    },

    setJointConstraintForBone(boneName, constraint, options = {}) {
      const name = this.canonicalMirrorBone?.(boneName) || boneName || "";
      if (!name || !this.bones?.has?.(name)) {
        return false;
      }
      if (!this.jointConstraints) {
        this.jointConstraints = new Map();
      }
      const next = this.normalizeJointConstraint(constraint);
      if (next.enabled) {
        this.jointConstraints.set(name, next);
      } else {
        this.jointConstraints.delete(name);
      }
      if (options.clampCurrentPose !== false) {
        this.clampStoredPoseForBone(name);
      }
      this.syncJointConstraintControls?.();
      this.applyPose?.(this.progress);
      this.flushPoseUpdates?.();
      if (options.sync !== false) {
        this.syncPatchJson?.();
      }
      if (!options.silent) {
        this.setStatus(next.enabled
          ? `Limited ${this.boneDisplayName?.(name) || name}`
          : `Cleared limits for ${this.boneDisplayName?.(name) || name}`);
      }
      return true;
    },

    clampPoseWithJointConstraint(boneName, pose = {}) {
      const constraint = this.jointConstraintForBone(boneName);
      if (!constraint.enabled) {
        return pose;
      }
      const next = { ...pose };
      for (const channel of ROTATION_CHANNELS) {
        if (next[channel] !== undefined) {
          next[channel] = clampRadians(next[channel], constraint.min[channel], constraint.max[channel]);
        }
      }
      return next;
    },

    clampStoredPoseForBone(boneName) {
      if (this.manualPose?.has?.(boneName)) {
        this.manualPose.set(boneName, this.clampPoseWithJointConstraint(boneName, this.manualPose.get(boneName)));
      }
      for (const framePose of this.poseKeyframes?.values?.() || []) {
        if (framePose?.[boneName]) {
          framePose[boneName] = this.clampPoseWithJointConstraint(boneName, framePose[boneName]);
        }
      }
    },

    serializeJointConstraints() {
      return sortedConstraintEntries(this.jointConstraints)
        .map(([bone, constraint]) => ({
          bone,
          enabled: true,
          min: { ...constraint.min },
          max: { ...constraint.max }
        }));
    },

    applySerializedJointConstraints(entries = []) {
      this.jointConstraints = new Map();
      if (!Array.isArray(entries)) {
        return 0;
      }
      let applied = 0;
      for (const entry of entries) {
        const boneName = this.canonicalMirrorBone?.(entry?.bone) || entry?.bone || "";
        if (!boneName || !this.bones?.has?.(boneName)) {
          continue;
        }
        const constraint = this.normalizeJointConstraint(entry);
        if (!constraint.enabled) {
          continue;
        }
        this.jointConstraints.set(boneName, constraint);
        applied += 1;
      }
      this.syncJointConstraintControls?.();
      return applied;
    },

    loadJointConstraintTemplates() {
      if (this.jointConstraintTemplates) {
        return this.jointConstraintTemplates;
      }
      this.jointConstraintTemplates = new Map();
      try {
        const parsed = JSON.parse(window.localStorage?.getItem(TEMPLATE_STORAGE_KEY) || "[]");
        if (Array.isArray(parsed)) {
          for (const template of parsed) {
            const name = String(template?.name || "").trim();
            if (name && Array.isArray(template.constraints)) {
              this.jointConstraintTemplates.set(name, template.constraints);
            }
          }
        }
      } catch (error) {
        console.warn("Could not load joint constraint templates", error);
      }
      return this.jointConstraintTemplates;
    },

    saveJointConstraintTemplates() {
      const templates = [...this.loadJointConstraintTemplates().entries()]
        .map(([name, constraints]) => ({ name, constraints }));
      try {
        window.localStorage?.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
      } catch (error) {
        console.warn("Could not save joint constraint templates", error);
      }
    },

    refreshJointConstraintTemplateSelect() {
      if (!this.jointConstraintTemplateSelect) {
        return;
      }
      const current = this.jointConstraintTemplateSelect.value;
      const options = [new Option("Template", "")];
      for (const name of [...this.loadJointConstraintTemplates().keys()].sort((a, b) => a.localeCompare(b))) {
        options.push(new Option(name, name));
      }
      this.jointConstraintTemplateSelect.replaceChildren(...options);
      this.jointConstraintTemplateSelect.value = this.jointConstraintTemplates.has(current) ? current : "";
    },

    syncJointConstraintControls() {
      const boneName = this.poseBoneSelect?.value || this.activeBoneName || "";
      const enabled = Boolean(boneName && this.bones?.has?.(boneName));
      const constraint = enabled ? this.jointConstraintForBone(boneName) : this.defaultJointConstraint();
      const disabled = !enabled;
      if (this.jointConstraintEnabled) {
        this.jointConstraintEnabled.disabled = disabled;
        this.jointConstraintEnabled.checked = enabled && constraint.enabled;
      }
      for (const channel of ROTATION_CHANNELS) {
        const minInput = this[`jointConstraint${channel.toUpperCase()}Min`];
        const maxInput = this[`jointConstraint${channel.toUpperCase()}Max`];
        if (minInput) {
          minInput.disabled = disabled || !constraint.enabled;
          minInput.value = String(toDegrees(constraint.min[channel]));
        }
        if (maxInput) {
          maxInput.disabled = disabled || !constraint.enabled;
          maxInput.value = String(toDegrees(constraint.max[channel]));
        }
      }
      for (const button of this.jointConstraintCaptureButtons || []) {
        button.disabled = disabled;
      }
      this.refreshJointConstraintTemplateSelect();
    },

    readJointConstraintControls() {
      const current = this.jointConstraintForBone();
      const next = {
        enabled: Boolean(this.jointConstraintEnabled?.checked),
        min: { ...current.min },
        max: { ...current.max }
      };
      for (const channel of ROTATION_CHANNELS) {
        next.min[channel] = toRadians(this[`jointConstraint${channel.toUpperCase()}Min`]?.value);
        next.max[channel] = toRadians(this[`jointConstraint${channel.toUpperCase()}Max`]?.value);
      }
      return this.normalizeJointConstraint(next);
    },

    updateSelectedJointConstraintFromControls(options = {}) {
      const boneName = this.poseBoneSelect?.value || this.activeBoneName || "";
      return this.setJointConstraintForBone(boneName, this.readJointConstraintControls(), options);
    },

    clearJointConstraintEditedPoseChannels(boneName = this.poseBoneSelect?.value || this.activeBoneName || "") {
      this.jointConstraintEditedPoseBone = boneName || "";
      this.jointConstraintEditedPoseChannels?.clear?.();
    },

    markJointConstraintPoseChannelEdited(channel, boneName = this.poseBoneSelect?.value || this.activeBoneName || "") {
      if (!ROTATION_CHANNELS.includes(channel)) {
        return;
      }
      if (!this.jointConstraintEditedPoseChannels) {
        this.jointConstraintEditedPoseChannels = new Set();
      }
      const name = boneName || "";
      if (this.jointConstraintEditedPoseBone !== name) {
        this.jointConstraintEditedPoseChannels.clear();
        this.jointConstraintEditedPoseBone = name;
      }
      this.jointConstraintEditedPoseChannels.add(channel);
    },

    jointConstraintCaptureChannels(boneName, pose = {}) {
      if (
        boneName
        && this.jointConstraintEditedPoseBone === boneName
        && this.jointConstraintEditedPoseChannels?.size
      ) {
        return ROTATION_CHANNELS.filter((channel) => this.jointConstraintEditedPoseChannels.has(channel));
      }
      return ROTATION_CHANNELS.filter((channel) => Math.abs(finitePoseValue(pose[channel])) >= 0.0001);
    },

    captureCurrentJointConstraintPoseLimit(side = "max") {
      const boneName = this.poseBoneSelect?.value || this.activeBoneName || "";
      if (!boneName || !this.bones?.has?.(boneName)) {
        this.setStatus("Select a bone before capturing joint limits");
        return false;
      }
      const targetSide = side === "min" ? "min" : "max";
      const oppositeSide = targetSide === "min" ? "max" : "min";
      const pose = this.readPoseControls?.() || {};
      const current = this.jointConstraintForBone(boneName);
      const defaults = current.enabled ? current : this.defaultJointConstraint();
      const next = {
        enabled: true,
        min: { ...defaults.min },
        max: { ...defaults.max }
      };
      const captureChannels = this.jointConstraintCaptureChannels(boneName, pose);
      if (!captureChannels.length) {
        this.setStatus("Rotate the selected bone before capturing a joint limit");
        return false;
      }
      for (const channel of captureChannels) {
        const value = finitePoseValue(pose[channel]);
        next[targetSide][channel] = value;
        if (targetSide === "min" && next[oppositeSide][channel] < value) {
          next[oppositeSide][channel] = value;
        }
        if (targetSide === "max" && next[oppositeSide][channel] > value) {
          next[oppositeSide][channel] = value;
        }
      }
      const captured = this.setJointConstraintForBone(boneName, next, {
        clampCurrentPose: false,
        silent: true
      });
      if (!captured) {
        return false;
      }
      this.clearJointConstraintEditedPoseChannels(boneName);
      const channelLabel = captureChannels.map((channel) => channel.toUpperCase()).join("/");
      this.setStatus(`Captured ${this.boneDisplayName?.(boneName) || boneName} ${targetSide} ${channelLabel} pose`);
      return true;
    },

    saveCurrentJointConstraintTemplate() {
      const rawName = String(this.jointConstraintTemplateName?.value || "").trim();
      const fallback = this.activeClipEntry?.name || "Joint Limits";
      const name = rawName || fallback;
      const constraints = this.serializeJointConstraints();
      if (!constraints.length) {
        this.setStatus("Add at least one joint limit before saving a template");
        return false;
      }
      this.loadJointConstraintTemplates().set(name, constraints);
      this.saveJointConstraintTemplates();
      if (this.jointConstraintTemplateName) {
        this.jointConstraintTemplateName.value = name;
      }
      this.refreshJointConstraintTemplateSelect();
      if (this.jointConstraintTemplateSelect) {
        this.jointConstraintTemplateSelect.value = name;
      }
      this.setStatus(`Saved joint constraint template "${name}"`);
      return true;
    },

    applySelectedJointConstraintTemplate() {
      const name = this.jointConstraintTemplateSelect?.value || "";
      const constraints = this.loadJointConstraintTemplates().get(name);
      if (!constraints) {
        this.setStatus("Choose a joint constraint template");
        return false;
      }
      this.applySerializedJointConstraints(constraints);
      this.syncPatchJson?.();
      this.applyPose?.(this.progress);
      this.flushPoseUpdates?.();
      this.setStatus(`Applied joint constraint template "${name}"`);
      return true;
    },

    deleteSelectedJointConstraintTemplate() {
      const name = this.jointConstraintTemplateSelect?.value || "";
      if (!name || !this.loadJointConstraintTemplates().has(name)) {
        this.setStatus("Choose a joint constraint template");
        return false;
      }
      this.jointConstraintTemplates.delete(name);
      this.saveJointConstraintTemplates();
      this.refreshJointConstraintTemplateSelect();
      this.setStatus(`Deleted joint constraint template "${name}"`);
      return true;
    },

    clearSelectedJointConstraint() {
      const boneName = this.poseBoneSelect?.value || this.activeBoneName || "";
      this.clearJointConstraintEditedPoseChannels(boneName);
      return this.setJointConstraintForBone(boneName, { ...this.defaultJointConstraint(), enabled: false });
    }
  });
}
