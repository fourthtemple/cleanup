export function installRootMotionPreviewMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;
  const UP_AXIS = new THREE.Vector3(0, 1, 0);
  const ROOT_FORWARD_AXES = [
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(-1, 0, 0)
  ];

  function xzVector(vector) {
    return new THREE.Vector3(vector.x || 0, 0, vector.z || 0);
  }

  function rotateYaw(vector, yaw) {
    return vector.clone().applyAxisAngle(UP_AXIS, yaw);
  }

  function signedYawBetween(from, to) {
    const a = xzVector(from);
    const b = xzVector(to);
    if (a.lengthSq() < 0.000001 || b.lengthSq() < 0.000001) {
      return 0;
    }
    a.normalize();
    b.normalize();
    const crossY = a.x * b.z - a.z * b.x;
    const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    return Math.atan2(crossY, dot);
  }

  Object.assign(BirdWeightEditor.prototype, {
    rootMotionPreviewEnabled() {
      return this.actorTarget?.mode !== "bird-flap"
        && this.travelLoopToggle?.checked === true
        && this.loopToggle?.checked === true
        && Boolean(this.activeClipEntry?.clip || this.activeClipAction?.getClip?.());
    },

    rootMotionCameraFollowEnabled() {
      return this.rootMotionPreviewEnabled()
        && this.travelFollowToggle?.checked === true
        && Boolean(this.camera && this.controls);
    },

    syncTravelFollowControls() {
      const visible = this.travelLoopToggle?.checked === true;
      this.travelFollowOption?.classList.toggle("is-hidden", !visible);
      if (this.travelFollowToggle) {
        this.travelFollowToggle.disabled = !visible;
      }
      if (!visible) {
        this.rootMotionCameraFollowPoint = null;
        this.rootMotionCameraFollowHomeTarget = null;
      }
    },

    resetRootMotionPreview({ clearProfile = false, refreshGround = false } = {}) {
      this.rootMotionLoopCycles = 0;
      this.rootMotionCameraFollowPoint = null;
      this.rootMotionCameraFollowHomeTarget = null;
      if (clearProfile) {
        this.rootMotionLoopProfileCache = null;
      }
      if (refreshGround) {
        this.refreshGroundReferenceForCurrentPose?.();
      }
    },

    invalidateRootMotionPreviewProfile() {
      this.rootMotionLoopProfileCache = null;
      this.rootMotionLoopCycles = 0;
      this.rootMotionCameraFollowPoint = null;
      this.rootMotionCameraFollowHomeTarget = null;
    },

    rootMotionPreviewRootBone() {
      return this.sequenceRootBone?.()
        || [...this.bones.values()].find((bone) => /hips|pelvis|root/i.test(this.boneDisplayName?.(bone.name) || bone.name))
        || null;
    },

    rootMotionForwardForQuaternion(quaternion) {
      let best = null;
      for (const axis of ROOT_FORWARD_AXES) {
        const candidate = axis.clone().applyQuaternion(quaternion);
        candidate.y = 0;
        const score = candidate.lengthSq();
        if (!best || score > best.score) {
          best = { vector: candidate, score };
        }
      }
      return best?.score > 0.000001 ? best.vector.normalize() : new THREE.Vector3(0, 0, 1);
    },

    sampleRootMotionLoopEndpoint(progress) {
      const root = this.rootMotionPreviewRootBone();
      if (!root || !this.model) {
        return null;
      }
      const previousProgress = this.progress;
      const previousClipTime = this.lastClipSampleTime;
      this.progress = THREE.MathUtils.clamp(progress, 0, 1);
      this.applyPose(this.progress);
      this.model.updateMatrixWorld(true);
      root.updateWorldMatrix(true, false);
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      root.getWorldPosition(position);
      root.getWorldQuaternion(quaternion);
      this.progress = previousProgress;
      this.lastClipSampleTime = previousClipTime;
      return {
        position: xzVector(position),
        forward: this.rootMotionForwardForQuaternion(quaternion)
      };
    },

    rootMotionLoopProfile() {
      const clip = this.activeClipEntry?.clip || this.activeClipAction?.getClip?.();
      const cacheKey = [
        this.activeClipEntry?.id || this.activeClipEntry?.name || "",
        clip?.uuid || clip?.name || "",
        this.actorScaleMultiplier || 1
      ].join("|");
      if (this.rootMotionLoopProfileCache?.key === cacheKey) {
        return this.rootMotionLoopProfileCache.profile;
      }
      const start = this.sampleRootMotionLoopEndpoint(0);
      const end = this.sampleRootMotionLoopEndpoint(1);
      if (!start || !end) {
        this.rootMotionLoopProfileCache = { key: cacheKey, profile: null };
        return null;
      }
      const yawDelta = signedYawBetween(start.forward, end.forward);
      const loopOffset = end.position.clone().sub(rotateYaw(start.position, yawDelta));
      loopOffset.y = 0;
      const profile = {
        start,
        end,
        yawDelta,
        loopOffset,
        distance: Math.max(loopOffset.length(), end.position.distanceTo(start.position))
      };
      this.rootMotionLoopProfileCache = { key: cacheKey, profile };
      return profile;
    },

    currentModelViewFraming() {
      if (!this.model) {
        return null;
      }
      this.model.visible = true;
      this.model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(this.model);
      if (
        bounds.isEmpty()
        || !Number.isFinite(bounds.min.x)
        || !Number.isFinite(bounds.min.y)
        || !Number.isFinite(bounds.min.z)
        || !Number.isFinite(bounds.max.x)
        || !Number.isFinite(bounds.max.y)
        || !Number.isFinite(bounds.max.z)
      ) {
        return null;
      }
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const height = Math.max(size.y, this.actorTarget?.displayHeight || 1.8, 0.001);
      const distance = Math.max(5.8, height * 3.2);
      const target = center.clone();
      target.y = bounds.min.y + height * 0.45;
      return { bounds, center, distance, height, size, target };
    },

    rootMotionTransformForCycles(cycles, profile = this.rootMotionLoopProfile()) {
      const count = Math.max(0, Math.floor(Number(cycles) || 0));
      const transform = {
        yaw: 0,
        offset: new THREE.Vector3()
      };
      if (!profile || count <= 0) {
        return transform;
      }
      for (let index = 0; index < count; index += 1) {
        transform.offset.copy(rotateYaw(transform.offset, profile.yawDelta)).add(profile.loopOffset);
        transform.yaw += profile.yawDelta;
      }
      return transform;
    },

    advanceRootMotionLoopPreview(nextProgress) {
      if (!this.rootMotionPreviewEnabled()) {
        this.resetRootMotionPreview();
        return nextProgress % 1;
      }
      const profile = this.rootMotionLoopProfile();
      if (!profile) {
        this.rootMotionLoopCycles = 0;
        return nextProgress % 1;
      }
      const loops = Math.max(0, Math.floor(nextProgress));
      if (loops > 0) {
        this.rootMotionLoopCycles += loops;
      }
      return nextProgress - Math.floor(nextProgress);
    },

    applyRootMotionLoopPreview() {
      if (!this.rootMotionPreviewEnabled() || !this.model) {
        this.rootMotionCameraFollowPoint = null;
        return false;
      }
      const profile = this.rootMotionLoopProfile();
      if (!profile) {
        return false;
      }
      const transform = this.rootMotionTransformForCycles(this.rootMotionLoopCycles, profile);
      if (Math.abs(transform.yaw) > 0.000001) {
        const yawQuaternion = new THREE.Quaternion().setFromAxisAngle(UP_AXIS, transform.yaw);
        const rotatedPosition = xzVector(this.model.position).applyQuaternion(yawQuaternion);
        this.model.position.x = rotatedPosition.x;
        this.model.position.z = rotatedPosition.z;
        this.model.quaternion.premultiply(yawQuaternion);
      }
      this.model.position.x += transform.offset.x;
      this.model.position.z += transform.offset.z;
      this.model.updateMatrixWorld(true);
      for (const record of this.paintRecords || []) {
        record.object?.skeleton?.update?.();
      }
      this.updateTravelGroundReference(profile, transform);
      this.updateTravelCameraFollow();
      return true;
    },

    rootMotionCameraFollowPointForCurrentPose() {
      if (!this.model) {
        return null;
      }
      const root = this.rootMotionPreviewRootBone();
      this.model.updateMatrixWorld(true);
      if (root) {
        const position = root.getWorldPosition(new THREE.Vector3());
        return new THREE.Vector3(position.x, 0, position.z);
      }
      const bounds = new THREE.Box3().setFromObject(this.model);
      if (bounds.isEmpty()) {
        return null;
      }
      const center = bounds.getCenter(new THREE.Vector3());
      return new THREE.Vector3(center.x, 0, center.z);
    },

    updateTravelCameraFollow() {
      if (!this.rootMotionCameraFollowEnabled()) {
        this.rootMotionCameraFollowPoint = null;
        return false;
      }
      const nextPoint = this.rootMotionCameraFollowPointForCurrentPose();
      if (!nextPoint) {
        return false;
      }
      if (!this.rootMotionCameraFollowPoint && !this.rootMotionCameraFollowHomeTarget) {
        this.rootMotionCameraFollowHomeTarget = this.controls.target.clone();
      }
      if (this.rootMotionCameraFollowPoint) {
        const delta = nextPoint.clone().sub(this.rootMotionCameraFollowPoint);
        if (delta.lengthSq() > 0.0000001) {
          this.camera.position.add(delta);
          this.controls.target.add(delta);
          this.controls.update();
        }
      }
      this.rootMotionCameraFollowPoint = nextPoint;
      return true;
    },

    animateCameraPanToTarget(target, { duration = 260, onComplete = null } = {}) {
      if (!target || !this.camera || !this.controls) {
        return false;
      }
      const startTarget = this.controls.target.clone();
      const endTarget = target.clone();
      const viewOffset = this.camera.position.clone().sub(startTarget);
      if (startTarget.distanceToSquared(endTarget) < 0.0000001) {
        onComplete?.();
        return true;
      }
      const token = Symbol("camera-pan");
      this.cameraPanToken = token;
      const startTime = performance.now();
      const tick = () => {
        if (this.cameraPanToken !== token) {
          return;
        }
        const elapsed = performance.now() - startTime;
        const alpha = Math.min(1, elapsed / Math.max(1, duration));
        const smooth = alpha * alpha * (3 - 2 * alpha);
        const nextTarget = startTarget.clone().lerp(endTarget, smooth);
        this.controls.target.copy(nextTarget);
        this.camera.position.copy(nextTarget).add(viewOffset);
        this.camera.lookAt(nextTarget);
        this.controls.update();
        this.updateCameraRelativeLights?.();
        if (alpha < 1) {
          window.requestAnimationFrame(tick);
          return;
        }
        this.cameraPanToken = null;
        onComplete?.();
      };
      tick();
      return true;
    },

    refocusCameraOnCurrentPose({ preserveView = true, animate = false, duration = 260 } = {}) {
      if (!this.model || !this.camera || !this.controls) {
        return false;
      }
      const framing = this.currentModelViewFraming();
      if (!framing) {
        return false;
      }
      const { bounds, center, distance: framedDistance, height, target } = framing;
      const previousOffset = this.camera.position.clone().sub(this.controls.target);
      let distance = previousOffset.length();
      const updateFraming = () => {
        this.camera.near = Math.max(0.01, distance / 100);
        this.camera.far = Math.max(220, distance * 100);
        this.camera.updateProjectionMatrix();
        this.controls.maxDistance = Math.max(120, distance * 4);
        this.updateSceneDepthForModelView?.(distance);
      };
      if (animate && preserveView && Number.isFinite(distance) && distance >= 0.001) {
        return this.animateCameraPanToTarget(target, { duration, onComplete: updateFraming });
      }
      if (!preserveView || !Number.isFinite(distance) || distance < 0.001) {
        distance = framedDistance;
        this.camera.position.set(center.x, bounds.min.y + height * 0.82, center.z + distance);
      } else {
        this.camera.position.copy(target).add(previousOffset);
      }
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      updateFraming();
      this.controls.update();
      return true;
    },

    returnCameraFromTravelFollow({ target = null, duration = 260 } = {}) {
      if (!this.camera || !this.controls) {
        this.rootMotionCameraFollowPoint = null;
        this.rootMotionCameraFollowHomeTarget = null;
        return false;
      }
      const returnTarget = target?.clone?.()
        || this.rootMotionCameraFollowHomeTarget?.clone?.()
        || this.currentModelViewFraming()?.target
        || null;
      this.rootMotionCameraFollowPoint = null;
      this.rootMotionCameraFollowHomeTarget = null;
      if (!returnTarget) {
        return false;
      }
      return this.animateCameraPanToTarget(returnTarget, { duration });
    },

    updateTravelGroundReference(profile, transform = this.rootMotionTransformForCycles(this.rootMotionLoopCycles, profile)) {
      if (!this.model || !this.groundGrid || !this.groundFloor) {
        return false;
      }
      const bounds = new THREE.Box3().setFromObject(this.model);
      if (bounds.isEmpty()) {
        return false;
      }
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const travelSpan = Math.max(
        profile?.distance || 0,
        transform?.offset?.length?.() || 0,
        size.x,
        size.z,
        size.y * 0.8
      );
      const groundSize = Math.max(8, travelSpan * 2.8, size.y * 2.4);
      const groundScale = groundSize / 8;
      const groundY = bounds.min.y;
      this.groundGrid.position.set(center.x, groundY, center.z);
      this.groundFloor.position.set(center.x, groundY - 0.012, center.z);
      this.groundGrid.scale.setScalar(groundScale);
      this.groundFloor.scale.setScalar(groundScale);
      return true;
    },

    refreshGroundReferenceForCurrentPose() {
      if (!this.model) {
        return false;
      }
      this.model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(this.model);
      if (bounds.isEmpty()) {
        return false;
      }
      return this.positionGroundReference?.(bounds, bounds.getCenter(new THREE.Vector3())) || false;
    }
  });
}
