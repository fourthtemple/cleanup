export function installIkSolverMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    finitePoseValue
  } = deps;

  const IK_ITERATIONS = 18;
  const IK_TARGET_EPSILON = 0.003;
  const IK_MAX_AUTO_CHAIN_BONES = 4;
  const IK_SMOOTH_CHAIN_PASSES = 4;

  function cloneManualPoseMap(source) {
    return new Map([...source.entries()].map(([name, pose]) => [name, { ...pose }]));
  }

  function cleanIkPose(pose) {
    const result = {};
    for (const key of ["x", "y", "z", "px", "py", "pz"]) {
      result[key] = Number(finitePoseValue(pose[key]).toFixed(key.startsWith("p") ? 5 : 6));
    }
    return result;
  }

  function quaternionIsFinite(quaternion) {
    return Number.isFinite(quaternion.x)
      && Number.isFinite(quaternion.y)
      && Number.isFinite(quaternion.z)
      && Number.isFinite(quaternion.w);
  }

  function smoothChainFalloff(index, count) {
    if (count <= 1) {
      return 1;
    }
    const t = index / (count - 1);
    return t * t;
  }

  Object.assign(BirdWeightEditor.prototype, {
    activePoseGizmoMode() {
      if (this.activeTool !== "bone") {
        return "";
      }
      if (this.ikTargetGizmoArmed) {
        return "ik";
      }
      if (this.boneMoveGizmoArmed) {
        return "fk";
      }
      return "";
    },

    preparePoseGizmoModeSwitch(nextMode = "") {
      if (nextMode !== "ik" && this.ikDrag) {
        this.finishIkMove();
      }
      if (nextMode !== "fk" && this.boneMoveDrag) {
        this.finishBoneMove();
      }
      if (nextMode !== "ik") {
        this.ikTargetGizmoArmed = false;
      }
      if (nextMode !== "fk") {
        this.boneMoveGizmoArmed = false;
      }
      if (!nextMode) {
        this.updateBoneMoveGizmo?.();
        this.updateIkMoveGizmo?.();
      }
    },

    restorePoseGizmoMode(mode = "") {
      const nextMode = mode === "ik" || mode === "fk" ? mode : "";
      this.boneMoveDrag = null;
      this.ikDrag = null;
      this.boneMoveGizmoArmed = false;
      this.ikTargetGizmoArmed = false;
      if (nextMode) {
        this.activeTool = "bone";
        this.controls.enabled = true;
        this.toolButtons.forEach((button) => {
          button.classList.toggle("is-active", button.dataset.tool === "bone");
        });
      }
      this.boneMoveGizmoArmed = nextMode === "fk";
      this.ikTargetGizmoArmed = nextMode === "ik";
      this.updateBoneMoveGizmo?.();
      this.updateIkMoveGizmo?.();
    },

    createIkTarget() {
      this.ikTarget = new THREE.Object3D();
      this.ikTarget.name = "IK Target";
      this.ikTarget.visible = false;
      this.scene.add(this.ikTarget);

      this.ikTargetMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0x7af7ff,
          transparent: true,
          opacity: 0.92,
          depthTest: false,
          depthWrite: false
        })
      );
      this.ikTargetMarker.renderOrder = 33;
      this.ikTargetMarker.visible = false;
      this.ikTarget.add(this.ikTargetMarker);
    },

    toggleIkMoveGizmo() {
      if (
        this.ikTargetGizmoArmed
        && this.transformControls?.object === this.ikTarget
        && this.transformHelper?.visible
      ) {
        this.ikTargetGizmoArmed = false;
        this.updateIkMoveGizmo();
        this.setStatus("IK gizmo off");
        return false;
      }
      return this.showIkMoveGizmo();
    },

    showIkMoveGizmo() {
      if (!this.model || !this.bones.size) {
        this.setStatus("Load a rigged model first");
        return false;
      }
      const chainNames = this.ikChainNames();
      if (chainNames.length < 2) {
        this.setStatus("Select a bone chain or an end bone for IK");
        return false;
      }

      this.preparePoseGizmoModeSwitch("ik");
      this.boneMoveGizmoArmed = false;
      this.setBonePlacementPending(false);
      this.pausePlayback();
      this.setSidePanelOpen(true);
      this.setRigPanelOpen(true);
      this.setTool("bone");
      this.setViewMode("mesh", { silent: true });
      if (this.skeletonToggle) {
        this.skeletonToggle.checked = true;
        this.updateSkeletonHelper();
      }

      this.ikTargetGizmoArmed = true;
      this.setActiveBone(chainNames[chainNames.length - 1], { stopPlacement: false });
      this.updateIkTargetFromChain(chainNames);
      this.refreshRigOverlays();
      this.updateIkMoveGizmo();
      const settings = this.ikSettingsForChain(chainNames);
      this.setStatus(`IK ${this.ikChainLabel(chainNames)} (${settings.solver.toUpperCase()}): drag the target, then Key to bake`);
      return true;
    },

    ikChainNames() {
      const selectedChain = (this.selectedBoneChainNames?.() || []).filter((name) => this.bones.has(name));
      if (selectedChain.length >= 2) {
        return selectedChain;
      }

      const activeName = this.activeBoneName || this.poseBoneSelect?.value || "";
      let bone = this.bones.get(activeName);
      if (!bone) {
        return [];
      }

      const names = [];
      while (bone?.isBone && names.length < IK_MAX_AUTO_CHAIN_BONES) {
        names.unshift(bone.name);
        bone = bone.parent;
      }
      return names.filter((name, index, all) => name && all.indexOf(name) === index && this.bones.has(name));
    },

    ikChainLabel(chainNames = this.ikChainNames()) {
      if (!chainNames.length) {
        return "chain";
      }
      const first = this.boneDisplayName(chainNames[0]);
      const last = this.boneDisplayName(chainNames[chainNames.length - 1]);
      return first === last ? first : `${first} -> ${last}`;
    },

    defaultIkChainSettings() {
      return { solver: "ccd", counterRotation: 0 };
    },

    normalizeIkChainSettings(settings = {}) {
      return {
        solver: settings.solver === "smooth" ? "smooth" : "ccd",
        counterRotation: THREE.MathUtils.clamp(Number(settings.counterRotation) || 0, -1, 1)
      };
    },

    ikChainSettingsKey(rootName = this.selectedBoneChainRootName, chainNames = null) {
      if (rootName) {
        return rootName;
      }
      const names = chainNames || this.ikChainNames();
      return names.length >= 2 ? this.manualBoneChainId?.(names) || names.join(">") : "";
    },

    ikSettingsForChain(chainNames = this.ikChainNames()) {
      const key = this.ikChainSettingsKey(this.selectedBoneChainRootName, chainNames);
      const manual = key ? this.manualBoneChains.find((chain) => chain.id === key) : null;
      return this.normalizeIkChainSettings(
        this.ikChainSettings?.get(key)
          || manual?.ik
          || this.defaultIkChainSettings()
      );
    },

    setIkChainSettings(rootName = this.selectedBoneChainRootName, settings = {}, options = {}) {
      const key = this.ikChainSettingsKey(rootName);
      if (!key) {
        return false;
      }
      const next = this.normalizeIkChainSettings(settings);
      if (!this.ikChainSettings) {
        this.ikChainSettings = new Map();
      }
      this.ikChainSettings.set(key, next);
      const manual = this.manualBoneChains.find((chain) => chain.id === key);
      if (manual) {
        manual.ik = { ...next };
      }
      this.updateIkSettingsControls?.();
      if (options.sync !== false) {
        this.syncPatchJson?.();
      }
      if (!options.silent) {
        this.setStatus(`IK ${this.boneChainSelect?.selectedOptions?.[0]?.textContent || "chain"} uses ${next.solver.toUpperCase()}`);
      }
      return true;
    },

    updateSelectedIkSettingsFromControls() {
      return this.setIkChainSettings(this.selectedBoneChainRootName, {
        solver: this.ikSolverModeSelect?.value || "ccd",
        counterRotation: Number(this.ikCounterRotation?.value) || 0
      });
    },

    updateIkSettingsControls() {
      const chainNames = this.selectedBoneChainNames?.() || [];
      const enabled = chainNames.length >= 2;
      const settings = enabled ? this.ikSettingsForChain(chainNames) : this.defaultIkChainSettings();
      if (this.ikSolverModeSelect) {
        this.ikSolverModeSelect.disabled = !enabled;
        this.ikSolverModeSelect.value = settings.solver;
      }
      if (this.ikCounterRotation) {
        const showCounterRotation = settings.solver === "ccd";
        this.ikCounterRotation.disabled = !enabled || !showCounterRotation;
        this.ikCounterRotation.value = String(settings.counterRotation);
        const counterField = this.ikCounterRotation.closest?.(".ik-counter-rotation-field");
        counterField?.classList.remove("is-hidden");
        counterField?.classList.toggle("is-disabled", this.ikCounterRotation.disabled);
      }
      if (this.ikCounterRotationOutput) {
        this.ikCounterRotationOutput.textContent = settings.counterRotation.toFixed(2);
      }
    },

    updateIkTargetFromChain(chainNames = this.ikChainNames()) {
      const endBone = this.bones.get(chainNames[chainNames.length - 1]);
      if (!this.ikTarget || !endBone) {
        return false;
      }
      this.applyPose(this.progress);
      this.model?.updateMatrixWorld(true);
      const endWorld = endBone.getWorldPosition(new THREE.Vector3());
      this.ikTarget.position.copy(endWorld);
      this.ikTarget.visible = true;
      this.ikTargetMarker.visible = true;
      this.ikTarget.updateMatrixWorld(true);
      return true;
    },

    updateIkMoveGizmo() {
      if (!this.transformControls || !this.ikTarget) {
        return;
      }
      const chainNames = this.ikChainNames();
      const shouldShow = Boolean(
        !this.cleanPreview
        && this.activeTool === "bone"
        && !this.pendingBonePlacement
        && this.ikTargetGizmoArmed
        && chainNames.length >= 2
      );

      if (!shouldShow) {
        if (this.transformControls.object === this.ikTarget) {
          this.transformControls.detach();
          this.transformControls.enabled = false;
          this.transformHelper.visible = false;
        }
        this.ikTarget.visible = false;
        this.ikTargetMarker.visible = false;
        this.ikGizmoButton?.classList.remove("is-active");
        this.ikGizmoButton?.setAttribute("aria-pressed", "false");
        return;
      }

      if (!this.ikDrag && !this.transformControls.dragging) {
        this.updateIkTargetFromChain(chainNames);
      }
      this.boneMoveGizmoArmed = false;
      this.transformControls.setMode("translate");
      if (this.transformControls.object !== this.ikTarget) {
        this.transformControls.attach(this.ikTarget);
      }
      this.transformControls.enabled = true;
      this.transformHelper.visible = true;
      this.ikTarget.visible = true;
      this.ikTargetMarker.visible = true;
      this.ikGizmoButton?.classList.add("is-active");
      this.ikGizmoButton?.setAttribute("aria-pressed", "true");
      this.boneGizmoButton?.classList.remove("is-active");
      this.boneGizmoButton?.setAttribute("aria-pressed", "false");
    },

    beginIkMove() {
      const chainNames = this.ikChainNames();
      if (!this.ikTarget || chainNames.length < 2) {
        this.ikDrag = null;
        this.updateIkMoveGizmo();
        return false;
      }
      this.setBonePlacementPending(false);
      this.beginPoseControlUndo("IK solve");
      this.ikDrag = {
        chainNames,
        manualPoseBefore: cloneManualPoseMap(this.manualPose),
        targetStart: this.ikTarget.position.clone()
      };
      this.pausePlayback();
      return true;
    },

    applyIkMove() {
      const drag = this.ikDrag;
      if (!drag?.chainNames?.length || !this.ikTarget) {
        return false;
      }
      const chainNames = drag.chainNames.filter((name) => this.bones.has(name));
      if (chainNames.length < 2) {
        return false;
      }

      const targetWorld = this.ikTarget.getWorldPosition(new THREE.Vector3());
      this.manualPose = cloneManualPoseMap(drag.manualPoseBefore);
      this.applyPose(this.progress);
      this.model?.updateMatrixWorld(true);
      const settings = this.ikSettingsForChain(chainNames);
      if (settings.solver === "smooth") {
        this.solveIkSmoothChain(chainNames, targetWorld, settings);
      } else {
        this.solveIkCcd(chainNames, targetWorld, settings);
      }

      const solvedTransforms = this.captureIkSolvedTransforms(chainNames);
      const solvedPose = this.ikPoseMapFromSolvedTransforms(chainNames, solvedTransforms);
      this.manualPose = cloneManualPoseMap(drag.manualPoseBefore);
      for (const [name, pose] of solvedPose.entries()) {
        this.manualPose.set(name, pose);
      }

      this.applyPose(this.progress);
      this.flushPoseUpdates?.();
      this.syncPoseControlsToCurrentBone?.();
      this.syncPatchJson();
      return true;
    },

    finishIkMove() {
      if (!this.ikDrag) {
        this.updateIkMoveGizmo();
        return false;
      }
      const chainNames = this.ikDrag.chainNames;
      this.applyIkMove();
      this.ikDrag = null;
      this.endPoseControlUndo();
      this.applyPose(this.progress);
      this.syncPoseControlsToCurrentBone?.();
      this.refreshRigOverlays();
      this.syncPatchJson();
      this.setStatus(`IK solved ${this.ikChainLabel(chainNames)}. Press Key to bake it`);
      return true;
    },

    shouldUseSmoothChainIk(chainNames) {
      return this.ikSettingsForChain(chainNames).solver === "smooth";
    },

    solveIkSmoothChain(chainNames, targetWorld, settings = this.ikSettingsForChain(chainNames)) {
      const bones = chainNames.map((name) => this.bones.get(name)).filter(Boolean);
      if (bones.length < 2) {
        return false;
      }

      this.model?.updateMatrixWorld(true);
      const basePositions = bones.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
      const baseEnd = basePositions[basePositions.length - 1];
      const targetDelta = targetWorld.clone().sub(baseEnd);
      const counterRotation = 0;
      if (targetDelta.lengthSq() <= 0.0000001) {
        return true;
      }

      const desiredPositions = basePositions.map((point, index) => {
        const t = basePositions.length <= 1 ? 1 : index / (basePositions.length - 1);
        const counterShape = Math.sin(Math.PI * t) * counterRotation * 0.5;
        const follow = THREE.MathUtils.clamp(smoothChainFalloff(index, basePositions.length) - counterShape, -1, 1.5);
        return point.clone().addScaledVector(targetDelta, follow);
      });
      desiredPositions[0].copy(basePositions[0]);
      desiredPositions[desiredPositions.length - 1].copy(targetWorld);

      for (let pass = 0; pass < IK_SMOOTH_CHAIN_PASSES; pass += 1) {
        for (let index = 0; index < bones.length - 1; index += 1) {
          const joint = bones[index];
          const child = bones[index + 1];
          this.model?.updateMatrixWorld(true);

          const jointWorld = joint.getWorldPosition(new THREE.Vector3());
          const childWorld = child.getWorldPosition(new THREE.Vector3());
          const currentSegment = childWorld.sub(jointWorld);
          const desiredSegment = desiredPositions[index + 1].clone().sub(desiredPositions[index]);
          if (currentSegment.lengthSq() < 0.0000001 || desiredSegment.lengthSq() < 0.0000001) {
            continue;
          }

          const deltaWorld = new THREE.Quaternion().setFromUnitVectors(
            currentSegment.normalize(),
            desiredSegment.normalize()
          );
          if (!quaternionIsFinite(deltaWorld)) {
            continue;
          }

          const jointWorldQuaternion = joint.getWorldQuaternion(new THREE.Quaternion());
          const parentWorldQuaternion = joint.parent
            ? joint.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();
          const nextWorldQuaternion = deltaWorld.multiply(jointWorldQuaternion).normalize();
          const nextLocalQuaternion = parentWorldQuaternion.invert().multiply(nextWorldQuaternion).normalize();
          if (quaternionIsFinite(nextLocalQuaternion)) {
            joint.quaternion.copy(nextLocalQuaternion);
          }
        }
      }
      this.model?.updateMatrixWorld(true);
      return true;
    },

    scaledIkDeltaQuaternion(deltaWorld, strength = 1) {
      if (Math.abs(strength - 1) <= 0.0001) {
        return deltaWorld;
      }
      const w = THREE.MathUtils.clamp(deltaWorld.w, -1, 1);
      const angle = 2 * Math.acos(w);
      if (!Number.isFinite(angle) || angle <= 0.000001) {
        return deltaWorld;
      }
      const sinHalfAngle = Math.sqrt(Math.max(0, 1 - w * w));
      if (sinHalfAngle <= 0.000001) {
        return deltaWorld;
      }
      const axis = new THREE.Vector3(
        deltaWorld.x / sinHalfAngle,
        deltaWorld.y / sinHalfAngle,
        deltaWorld.z / sinHalfAngle
      ).normalize();
      return new THREE.Quaternion().setFromAxisAngle(axis, angle * strength).normalize();
    },

    ccdCounterRotationStrength(chainNames, index, counterRotation) {
      const value = THREE.MathUtils.clamp(Number(counterRotation) || 0, -1, 1);
      if (Math.abs(value) <= 0.0001) {
        return 1;
      }
      const maxJointIndex = Math.max(1, chainNames.length - 2);
      const t = THREE.MathUtils.clamp(index / maxJointIndex, 0, 1);
      const rootBias = 1 - t;
      const tipBias = t;
      return THREE.MathUtils.clamp(1 + value * (rootBias * 0.65 - tipBias * 0.35), 0.15, 1.75);
    },

    solveIkCcd(chainNames, targetWorld, settings = this.ikSettingsForChain(chainNames)) {
      const endBone = this.bones.get(chainNames[chainNames.length - 1]);
      if (!endBone) {
        return false;
      }
      const counterRotation = settings?.solver === "ccd" ? settings.counterRotation : 0;

      for (let iteration = 0; iteration < IK_ITERATIONS; iteration += 1) {
        for (let index = chainNames.length - 2; index >= 0; index -= 1) {
          const joint = this.bones.get(chainNames[index]);
          if (!joint) {
            continue;
          }
          this.model?.updateMatrixWorld(true);

          const jointWorld = joint.getWorldPosition(new THREE.Vector3());
          const endWorld = endBone.getWorldPosition(new THREE.Vector3());
          const toEnd = endWorld.sub(jointWorld);
          const toTarget = targetWorld.clone().sub(jointWorld);
          if (toEnd.lengthSq() < 0.0000001 || toTarget.lengthSq() < 0.0000001) {
            continue;
          }

          const deltaWorld = new THREE.Quaternion().setFromUnitVectors(toEnd.normalize(), toTarget.normalize());
          if (!quaternionIsFinite(deltaWorld)) {
            continue;
          }
          const strength = this.ccdCounterRotationStrength(chainNames, index, counterRotation);
          const scaledDeltaWorld = this.scaledIkDeltaQuaternion(deltaWorld, strength);

          const jointWorldQuaternion = joint.getWorldQuaternion(new THREE.Quaternion());
          const parentWorldQuaternion = joint.parent
            ? joint.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();
          const nextWorldQuaternion = scaledDeltaWorld.multiply(jointWorldQuaternion).normalize();
          const nextLocalQuaternion = parentWorldQuaternion.invert().multiply(nextWorldQuaternion).normalize();
          if (quaternionIsFinite(nextLocalQuaternion)) {
            joint.quaternion.copy(nextLocalQuaternion);
          }
        }

        this.model?.updateMatrixWorld(true);
        if (endBone.getWorldPosition(new THREE.Vector3()).distanceTo(targetWorld) <= IK_TARGET_EPSILON) {
          break;
        }
      }
      return true;
    },

    captureIkSolvedTransforms(chainNames) {
      const transforms = new Map();
      for (const name of chainNames) {
        const bone = this.bones.get(name);
        if (!bone) {
          continue;
        }
        transforms.set(name, {
          position: bone.position.clone(),
          quaternion: bone.quaternion.clone()
        });
      }
      return transforms;
    },

    applyIkBasePose() {
      this.resetPose();
      const replaceBaseClip = this.poseKeyframeMode === "replace" && this.poseKeyframes.size > 0 && !this.poseKeyframesGenerated;
      if (!replaceBaseClip && this.actorTarget?.mode !== "bird-flap") {
        this.applyClipBasePose?.(this.progress);
        this.applyClipOrientationForEntry?.(this.activeClipEntry);
        this.applyClipGroundOffsetForEntry?.(this.activeClipEntry);
      }
      this.model?.updateMatrixWorld(true);
    },

    ikPoseMapFromSolvedTransforms(chainNames, solvedTransforms) {
      const previousManualPose = cloneManualPoseMap(this.manualPose);
      this.manualPose = new Map();
      this.applyIkBasePose();

      const poseMap = new Map();
      for (const name of chainNames) {
        const bone = this.bones.get(name);
        const solved = solvedTransforms.get(name);
        if (!bone || !solved) {
          continue;
        }
        const baseQuaternion = bone.quaternion.clone();
        const basePosition = bone.position.clone();
        const relativeQuaternion = baseQuaternion.invert().multiply(solved.quaternion).normalize();
        const euler = new THREE.Euler().setFromQuaternion(relativeQuaternion, "XYZ");
        poseMap.set(name, cleanIkPose({
          x: euler.x,
          y: euler.y,
          z: euler.z,
          px: solved.position.x - basePosition.x,
          py: solved.position.y - basePosition.y,
          pz: solved.position.z - basePosition.z
        }));
      }

      this.manualPose = previousManualPose;
      return poseMap;
    }
  });
}
