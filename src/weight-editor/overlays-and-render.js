export function installOverlayAndRenderMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    OrbitControls,
    TransformControls,
    cloneClipWithStartOffsetApplied,
    configuredClipStartOffsetSeconds,
    remainingClipStartOffsetSeconds,
    loadBirdFlapProfile,
    ACTOR_TARGETS,
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
    updateSkeletonHelper() {
      if (this.skeletonHelper) {
        this.scene.remove(this.skeletonHelper);
        this.skeletonHelper.dispose?.();
        this.skeletonHelper = null;
      }
      if (
        this.skeletonToggle.checked
        && this.model
        && !this.cleanPreview
        && (this.viewMode !== "rendered" || this.activeTool === "bone")
      ) {
        this.skeletonHelper = new THREE.SkeletonHelper(this.model);
        this.skeletonHelper.material.depthTest = false;
        this.scene.add(this.skeletonHelper);
      }
    },

    shouldShowBonePickerOverlay() {
      return Boolean(this.model && !this.cleanPreview && this.activeTool === "bone");
    },

    updateBonePickerOverlay() {
      if (!this.bonePickerJoints || !this.bonePickerLines) {
        return;
      }
      if (!this.shouldShowBonePickerOverlay()) {
        this.bonePickerJoints.visible = false;
        this.bonePickerLines.visible = false;
        return;
      }

      this.model.updateMatrixWorld(true);
      const positions = [];
      const colors = [];
      const linePositions = [];
      const names = [...this.bones.keys()].sort((a, b) => this.boneDisplayName(a).localeCompare(this.boneDisplayName(b)));
      const virtualNames = new Set(this.virtualBones.map((bone) => bone.name));
      const color = new THREE.Color();

      for (const name of names) {
        const bone = this.bones.get(name);
        if (!bone) {
          continue;
        }
        bone.getWorldPosition(this.tempWorld);
        positions.push(this.tempWorld.x, this.tempWorld.y, this.tempWorld.z);

        if (name === this.activeBoneName) {
          color.set(0xffd36e);
        } else if (virtualNames.has(name)) {
          color.set(0xf06fa8);
        } else {
          color.set(0x78cfff);
        }
        colors.push(color.r, color.g, color.b);

        if (bone.parent?.isBone) {
          bone.parent.getWorldPosition(this.tempLocalA);
          linePositions.push(
            this.tempLocalA.x, this.tempLocalA.y, this.tempLocalA.z,
            this.tempWorld.x, this.tempWorld.y, this.tempWorld.z
          );
        }
      }

      this.bonePickerNames = names;
      this.bonePickerGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      this.bonePickerGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      this.bonePickerGeometry.computeBoundingSphere();
      this.bonePickerLineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
      this.bonePickerLineGeometry.computeBoundingSphere();
      this.bonePickerJoints.visible = positions.length > 0;
      this.bonePickerLines.visible = linePositions.length > 0;
    },

    screenPointForBone(bone, rect) {
      bone.getWorldPosition(this.tempWorld);
      const projected = this.tempWorld.clone().project(this.camera);
      if (projected.z < -1 || projected.z > 1) {
        return null;
      }
      return {
        x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height
      };
    },

    distanceToScreenSegment(point, start, end) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq <= 0.0001) {
        return Math.hypot(point.x - start.x, point.y - start.y);
      }
      const t = THREE.MathUtils.clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq, 0, 1);
      const x = start.x + dx * t;
      const y = start.y + dy * t;
      return Math.hypot(point.x - x, point.y - y);
    },

    bonePlacementSelectedRecords() {
      return this.paintRecords.filter((record) => record.selected?.size > 0);
    },

    bonePlacementHitUsesSelectedVertex(hit) {
      if (!hit?.face) {
        return false;
      }
      const record = this.paintRecords.find((item) => item.object === hit.object);
      if (!record?.selected?.size) {
        return false;
      }
      return record.selected.has(hit.face.a) || record.selected.has(hit.face.b) || record.selected.has(hit.face.c);
    },

    selectedBonePlacementWorldPointFromEvent(event) {
      if (typeof this.nearestScreenVertex !== "function") {
        return null;
      }
      const nearest = this.nearestScreenVertex(event, {
        maxDistance: 34,
        recordFilter: (record) => record.selected?.size > 0,
        vertexFilter: (record, vertexIndex) => record.selected?.has(vertexIndex)
      });
      return nearest?.world ? nearest.world.clone() : null;
    },

    bonePlacementWorldPointFromEvent(event, parent) {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds?.();

      const selectedRecords = this.bonePlacementSelectedRecords();
      const hasSelectedPlacementSurface = selectedRecords.length > 0;
      const intersections = this.raycaster.intersectObjects(this.paintRecords.map((record) => record.object), false);
      if (hasSelectedPlacementSurface) {
        const selectedHit = intersections.find((hit) => this.bonePlacementHitUsesSelectedVertex(hit));
        if (selectedHit) {
          return selectedHit.point.clone();
        }
        return this.selectedBonePlacementWorldPointFromEvent(event);
      }
      if (intersections.length) {
        return intersections[0].point.clone();
      }
      if (!parent) {
        return null;
      }

      parent.getWorldPosition(this.tempLocalA);
      this.camera.getWorldDirection(this.tempLocalB);
      const placementPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.tempLocalB, this.tempLocalA);
      const point = new THREE.Vector3();
      return this.raycaster.ray.intersectPlane(placementPlane, point) ? point : null;
    },

    pickBoneFromEvent(event) {
      if (!this.model || !this.shouldShowBonePickerOverlay()) {
        return false;
      }
      this.model.updateMatrixWorld(true);
      const rect = this.canvas.getBoundingClientRect();
      const pointer = { x: event.clientX, y: event.clientY };
      let best = { name: "", distance: Infinity };

      for (const [name, bone] of this.bones.entries()) {
        const point = this.screenPointForBone(bone, rect);
        if (!point) {
          continue;
        }
        const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
        if (distance < best.distance) {
          best = { name, distance };
        }
      }

      if (best.distance > 22) {
        for (const [name, bone] of this.bones.entries()) {
          if (!bone.parent?.isBone) {
            continue;
          }
          const start = this.screenPointForBone(bone.parent, rect);
          const end = this.screenPointForBone(bone, rect);
          if (!start || !end) {
            continue;
          }
          const distance = this.distanceToScreenSegment(pointer, start, end);
          if (distance < best.distance) {
            best = { name, distance };
          }
        }
      }

      const chainParentName = this.addBoneParentSelect?.value || this.activeBoneName || this.findDefaultBone([...this.bones.keys()]);
      const chainParent = this.bones.get(chainParentName);
      const isExtendingCustomChain = Boolean(this.pendingBonePlacement && chainParent && this.customBoneRecord(chainParent.name));

      if (this.pendingBonePlacement && isExtendingCustomChain) {
        const worldPoint = this.bonePlacementWorldPointFromEvent(event, chainParent);
        if (worldPoint) {
          return this.finishBonePlacement(chainParent.name, { worldPoint });
        }
      }

      if (best.name && best.distance <= 18) {
        if (this.pendingBonePlacement) {
          return this.finishBonePlacement(best.name);
        }
        this.setActiveBone(best.name);
        this.setStatus(`${this.boneDisplayName(best.name)} selected as parent`);
        return true;
      }

      if (this.pendingBonePlacement) {
        const worldPoint = this.bonePlacementWorldPointFromEvent(event, chainParent);
        if (chainParent && worldPoint) {
          return this.finishBonePlacement(chainParent.name, { worldPoint });
        }
        if (this.bonePlacementSelectedRecords().length) {
          this.setStatus("Click a visible joint or the selected mesh surface");
        } else {
          this.setStatus("Click a visible joint or the model surface");
        }
        return false;
      }

      this.setStatus("Click a visible bone joint");
      return false;
    },

    updateSelectedBoneHighlight() {
      if (
        !this.model
        || !this.activeBoneName
        || this.cleanPreview
        || (this.viewMode === "rendered" && this.activeTool !== "bone")
      ) {
        this.selectedBoneLine.visible = false;
        this.selectedBoneJoints.visible = false;
        return;
      }

      const bone = this.bones.get(this.activeBoneName);
      if (!bone) {
        this.selectedBoneLine.visible = false;
        this.selectedBoneJoints.visible = false;
        return;
      }

      this.model.updateMatrixWorld(true);
      const positions = [];
      const joints = [];
      const center = new THREE.Vector3();
      bone.getWorldPosition(center);

      const addJoint = (point) => {
        joints.push(point.x, point.y, point.z);
      };
      const addSegment = (from, to) => {
        positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
        addJoint(from);
        addJoint(to);
      };

      const childBones = bone.children.filter((child) => child.isBone);
      if (bone.parent?.isBone) {
        const parentPosition = new THREE.Vector3();
        bone.parent.getWorldPosition(parentPosition);
        addSegment(parentPosition, center);
      }
      for (const child of childBones) {
        const childPosition = new THREE.Vector3();
        child.getWorldPosition(childPosition);
        addSegment(center, childPosition);
      }
      if (!positions.length) {
        addJoint(center);
      }

      this.selectedBoneLineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      this.selectedBoneLineGeometry.computeBoundingSphere();
      this.selectedBoneJointGeometry.setAttribute("position", new THREE.Float32BufferAttribute(joints, 3));
      this.selectedBoneJointGeometry.computeBoundingSphere();
      this.selectedBoneLine.visible = positions.length > 0;
      this.selectedBoneJoints.visible = joints.length > 0;
    },

    updateBoneLabels() {
      if (!this.boneLabels) {
        return;
      }
      if (
        !this.boneLabelToggle.checked
        || !this.model
        || this.cleanPreview
        || (this.viewMode === "rendered" && this.activeTool !== "bone")
      ) {
        this.boneLabels.replaceChildren();
        return;
      }

      this.model.updateMatrixWorld(true);
      const width = this.canvas.clientWidth || 1;
      const height = this.canvas.clientHeight || 1;
      const names = this.boneLayerNames.length ? this.boneLayerNames : [...this.bones.keys()];
      const labels = [];

      for (const name of names) {
        const bone = this.bones.get(name);
        if (!bone) {
          continue;
        }
        bone.getWorldPosition(this.tempWorld);
        const projected = this.tempWorld.clone().project(this.camera);
        if (projected.z < -1 || projected.z > 1) {
          continue;
        }
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        if (x < -40 || x > width + 40 || y < -20 || y > height + 20) {
          continue;
        }
        const label = document.createElement("span");
        label.className = "bone-label";
        label.textContent = name;
        label.style.left = `${x}px`;
        label.style.top = `${y}px`;
        labels.push(label);
      }

      this.boneLabels.replaceChildren(...labels);
    },

    setCameraPreset(name) {
      let target = new THREE.Vector3(0, 0.92, 0);
      let cameraY = 1.35;
      let distance = 4.2;
      if (this.model) {
        this.model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(this.model);
        if (
          !bounds.isEmpty()
          && Number.isFinite(bounds.min.y)
          && Number.isFinite(bounds.max.y)
          && Number.isFinite(bounds.min.x)
          && Number.isFinite(bounds.max.x)
          && Number.isFinite(bounds.min.z)
          && Number.isFinite(bounds.max.z)
        ) {
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          const height = Math.max(size.y, this.actorTarget?.displayHeight || 1.8, 0.001);
          target = new THREE.Vector3(center.x, bounds.min.y + height * 0.45, center.z);
          cameraY = bounds.min.y + height * 0.82;
          distance = Math.max(5.8, height * 3.2);
          this.positionGroundReference?.(bounds, center);
        }
      }
      const positions = {
        front: [target.x, cameraY, target.z + distance],
        back: [target.x, cameraY, target.z - distance],
        right: [target.x + distance, cameraY, target.z],
        left: [target.x - distance, cameraY, target.z],
        top: [target.x, target.y + distance + 0.6, target.z + 0.02]
      };
      const presetName = positions[name] ? name : "front";
      const [x, y, z] = positions[presetName];
      this.camera.position.set(x, y, z);
      this.controls.target.copy(target);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.controls.target);
      this.controls.maxDistance = Math.max(120, distance * 4);
      this.updateSceneDepthForModelView?.(distance);
      this.controls.update();
      document.querySelectorAll("[data-camera]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.camera === presetName);
      });
      const labels = {
        front: "Front view",
        back: "Back view",
        right: "Right 90-degree view",
        left: "Left 90-degree view",
        top: "Top view"
      };
      this.setStatus(labels[presetName] || "Camera snapped");
    },

    loadGLTFUrl(url) {
      return new Promise((resolve, reject) => {
        this.loader.load(url, resolve, undefined, reject);
      });
    },

    parseGLTFBuffer(buffer, path = "") {
      return new Promise((resolve, reject) => {
        this.loader.parse(buffer, path, resolve, reject);
      });
    },

    setStatus(message) {
      this.status.textContent = message;
    },

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
    },

    hasSelection() {
      return this.paintRecords.some((record) => (
        [...record.selected].some((vertexIndex) => !record.deleted?.has(vertexIndex))
      ));
    },

    sculptVerticesForTest(count = 8, amount = 0.002) {
      const record = this.paintRecords[0];
      if (!record) {
        return 0;
      }
      const position = record.geometry.attributes.position;
      const normal = record.geometry.attributes.normal;
      const total = Math.min(count, position.count);
      this.tempNormalMatrix.getNormalMatrix(record.object.matrixWorld);
      for (let index = 0; index < total; index += 1) {
        this.tempWorldNormal.fromBufferAttribute(normal, index).applyMatrix3(this.tempNormalMatrix).normalize();
        this.tempWorldDelta.copy(this.tempWorldNormal).multiplyScalar(amount);
        this.moveVertexByWorldDelta(record, index, this.tempWorldDelta);
        record.modified.add(index);
        record.sculpted.add(index);
        record.weightCompensated?.delete(index);
      }
      position.needsUpdate = true;
      this.preserveImportedNormals(record);
      this.updateRecordColors(record);
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.syncPatchJson();
      this.updateCounts();
      return total;
    },

    selectVerticesForTest(count = 12) {
      const record = this.paintRecords[0];
      if (!record) {
        return 0;
      }
      record.selected.clear();
      for (let index = 0; index < Math.min(count, record.geometry.attributes.position.count); index += 1) {
        if (record.deleted?.has(index)) {
          continue;
        }
        record.selected.add(index);
      }
      this.updateRecordColors(record);
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      return record.selected.size;
    },

    animate() {
      requestAnimationFrame(() => this.animate());
      const now = performance.now();
      const dt = Math.min((now - this.lastFrameTime) / 1000, 0.08);
      this.lastFrameTime = now;
      if (this.sequencePlaying) {
        const speed = Math.max(0.01, Number(this.speedControl.value) || 1);
        this.sequenceElapsed = Math.min(this.sequenceElapsed + dt * speed, this.sequenceDurationSeconds());
        this.applySequencePose({ now, throttleReadouts: true });
        this.syncSequenceControls({ now, throttle: true });
        if (this.sequenceElapsed >= this.sequenceDurationSeconds() - 0.0001) {
          this.sequencePlaying = false;
          if (this.timelinePlayBothButton) {
            this.timelinePlayBothButton.textContent = "Play Sequence";
          }
          this.syncSequenceControls({ force: true });
        }
      } else if (this.playing && !this.draggingScrub) {
        const speed = Number(this.speedControl.value) * this.actionSpeedMultiplier();
        this.progress += (dt * speed) / this.currentActionDuration();
        if (this.loopToggle.checked) {
          this.progress %= 1;
        } else {
          this.progress = Math.min(this.progress, 1);
        }
        this.applyPose(this.progress);
        this.syncPlaybackReadouts({ now, throttle: true });
      }
      const timelineIsLive = this.playing || this.sequencePlaying || this.draggingScrub || this.curveDragging;
      if (this.markerVertexCount > 0) {
        this.updateSelectionMarkers();
      }
      if (this.viewMode === "edit") {
        this.updateAllVertexMarkers();
      }
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      if (timelineIsLive) {
        this.updateBoneLayerValues({ now, throttle: true, playback: this.playing || this.sequencePlaying });
      }
      if (this.activeTool === "move" && !this.moveDrag) {
        this.updateMoveGizmo();
      }
      if (this.boneLabelToggle.checked) {
        this.updateBoneLabels();
      }
      this.controls.update();
      this.updateCameraRelativeLights?.();
      this.renderer.render(this.scene, this.camera);
    }
  });
}
