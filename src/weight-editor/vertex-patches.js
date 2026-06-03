export function installVertexPatchMethods(BirdWeightEditor, deps) {
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
    selectedVertexRefs() {
      const refs = [];
      for (const record of this.paintRecords) {
        for (const vertexIndex of record.selected) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          refs.push({ record, vertexIndex });
        }
      }
      return refs;
    },

    generatedTriangleIndexArray(record) {
      const vertexCount = record.geometry.attributes.position.count;
      return Array.from({ length: vertexCount }, (_, index) => index);
    },

    originalTriangleIndexArray(record) {
      return record.originalIndex
        ? Array.from(record.originalIndex)
        : this.generatedTriangleIndexArray(record);
    },

    originalGeometryGroups(record, indexCount) {
      if (record.originalGroups?.length) {
        return record.originalGroups.map((group) => ({ ...group }));
      }
      return [{ start: 0, count: indexCount, materialIndex: 0 }];
    },

    restoreOriginalGeometryGroups(record) {
      record.geometry.clearGroups();
      for (const group of record.originalGroups || []) {
        record.geometry.addGroup(group.start, group.count, group.materialIndex);
      }
    },

    applyDeletedVertices(record) {
      if (!record) {
        return 0;
      }
      const deleted = record.deleted || new Set();
      if (!deleted.size) {
        if (record.originalIndex) {
          const IndexArray = record.originalIndex.constructor;
          record.geometry.setIndex(new THREE.BufferAttribute(new IndexArray(record.originalIndex), 1));
        } else {
          record.geometry.setIndex(null);
        }
        this.restoreOriginalGeometryGroups(record);
        record.geometry.computeBoundingSphere();
        if (record.geometry.boundingBox) {
          record.geometry.computeBoundingBox();
        }
        return 0;
      }

      const sourceIndex = this.originalTriangleIndexArray(record);
      const sourceGroups = this.originalGeometryGroups(record, sourceIndex.length);
      const nextIndex = [];
      const nextGroups = [];

      for (const group of sourceGroups) {
        const start = Math.max(0, group.start || 0);
        const end = Math.min(sourceIndex.length, start + Math.max(0, group.count || 0));
        const groupStart = nextIndex.length;
        for (let offset = start; offset <= end - 3; offset += 3) {
          const a = sourceIndex[offset];
          const b = sourceIndex[offset + 1];
          const c = sourceIndex[offset + 2];
          if (deleted.has(a) || deleted.has(b) || deleted.has(c)) {
            continue;
          }
          nextIndex.push(a, b, c);
        }
        const groupCount = nextIndex.length - groupStart;
        if (groupCount > 0) {
          nextGroups.push({
            start: groupStart,
            count: groupCount,
            materialIndex: group.materialIndex || 0
          });
        }
      }

      const maxIndex = nextIndex.reduce((max, index) => Math.max(max, index), 0);
      const IndexArray = maxIndex > 65535 ? Uint32Array : Uint16Array;
      record.geometry.setIndex(new THREE.BufferAttribute(new IndexArray(nextIndex), 1));
      record.geometry.clearGroups();
      for (const group of nextGroups) {
        record.geometry.addGroup(group.start, group.count, group.materialIndex);
      }
      record.geometry.index.needsUpdate = true;
      record.geometry.computeBoundingSphere();
      if (record.geometry.boundingBox) {
        record.geometry.computeBoundingBox();
      }
      return deleted.size;
    },

    deleteVertex(record, vertexIndex) {
      if (!record || vertexIndex < 0 || vertexIndex >= record.geometry.attributes.position.count) {
        return false;
      }
      if (record.deleted?.has(vertexIndex)) {
        return false;
      }
      if (!record.deleted) {
        record.deleted = new Set();
      }
      this.restoreOriginalVertexWeights(record, vertexIndex);
      record.selected.delete(vertexIndex);
      record.modified.delete(vertexIndex);
      record.sculpted.delete(vertexIndex);
      record.weightCompensated?.delete(vertexIndex);
      record.deleted.add(vertexIndex);
      return true;
    },

    cleanupDeletedVertexSelection(record) {
      if (!record?.deleted?.size) {
        return;
      }
      for (const vertexIndex of [...record.selected]) {
        if (record.deleted.has(vertexIndex)) {
          record.selected.delete(vertexIndex);
        }
      }
    },

    cleanSelectedVertices() {
      let changed = 0;
      const changedRecords = new Set();
      for (const record of this.paintRecords) {
        const vertices = new Set();
        for (const selectedIndex of record.selected) {
          for (const linkedIndex of this.linkedSeamVertices(record, selectedIndex)) {
            vertices.add(linkedIndex);
          }
          if (this.mirrorMode) {
            const mirrorIndex = this.findMirroredVertex(record, selectedIndex);
            if (mirrorIndex >= 0) {
              for (const linkedMirrorIndex of this.linkedSeamVertices(record, mirrorIndex)) {
                vertices.add(linkedMirrorIndex);
              }
            }
          }
        }
        for (const vertexIndex of vertices) {
          if (this.deleteVertex(record, vertexIndex)) {
            changed += 1;
            changedRecords.add(record);
          }
        }
      }

      for (const record of changedRecords) {
        this.applyDeletedVertices(record);
        this.updateRecordColors(record);
      }
      this.syncPatchJson();
      this.updateSelectionMarkers();
      if (this.viewMode === "edit") {
        this.updateAllVertexMarkers();
      }
      this.updateMoveGizmo();
      this.updateCounts();
      this.setStatus(
        changed > 0
          ? `Cleaned ${changed} ${changed === 1 ? "vertex" : "vertices"} from the mesh`
          : "Select vertices to clean"
      );
      return changed;
    },

    addScaledMatrix(targetElements, sourceElements, scale) {
      for (let index = 0; index < 16; index += 1) {
        targetElements[index] += sourceElements[index] * scale;
      }
    },

    vertexSkinMatrix(object, vertexIndex, target) {
      const skinIndex = object.geometry.attributes.skinIndex;
      const skinWeight = object.geometry.attributes.skinWeight;
      const targetElements = target.elements;
      const offset = vertexIndex * 4;
      targetElements.fill(0);

      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.array[offset + slot];
        if (weight <= 0.0001) {
          continue;
        }
        const boneIndex = skinIndex.array[offset + slot];
        const bone = object.skeleton.bones[boneIndex];
        const inverse = object.skeleton.boneInverses[boneIndex];
        if (!bone || !inverse) {
          continue;
        }
        this.tempBoneMatrix.multiplyMatrices(bone.matrixWorld, inverse);
        this.addScaledMatrix(targetElements, this.tempBoneMatrix.elements, weight);
      }

      target.multiply(object.bindMatrix);
      target.premultiply(object.bindMatrixInverse);
      return target;
    },

    inverseVertexSkinMatrix(record, vertexIndex) {
      const skinMatrix = this.vertexSkinMatrix(record.object, vertexIndex, this.tempSkinMatrix);
      if (Math.abs(skinMatrix.determinant()) < 0.0000001) {
        return new THREE.Matrix4();
      }
      return skinMatrix.clone().invert();
    },

    vertexWorldPosition(record, vertexIndex, basePosition = null) {
      this.tempVector.copy(basePosition || new THREE.Vector3().fromBufferAttribute(record.geometry.attributes.position, vertexIndex));
      this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
      this.tempWorld.copy(this.tempVector);
      record.object.localToWorld(this.tempWorld);
      return this.tempWorld.clone();
    },

    moveVertexByWorldDelta(record, vertexIndex, worldDelta, options = {}) {
      const position = record.geometry.attributes.position;
      const startPosition = options.startPosition || new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
      const inverseSkinMatrix = options.inverseSkinMatrix || this.inverseVertexSkinMatrix(record, vertexIndex);
      const startWorld = options.startWorld || this.vertexWorldPosition(record, vertexIndex, startPosition);
      this.tempDesiredWorld.copy(startWorld).add(worldDelta);
      this.tempDesiredLocal.copy(this.tempDesiredWorld);
      record.object.worldToLocal(this.tempDesiredLocal);
      this.tempDesiredLocal.applyMatrix4(inverseSkinMatrix);
      position.setXYZ(vertexIndex, this.tempDesiredLocal.x, this.tempDesiredLocal.y, this.tempDesiredLocal.z);
    },

    selectionWorldCenter(refs = this.selectedVertexRefs()) {
      if (!refs.length) {
        return null;
      }
      this.model.updateMatrixWorld(true);
      const center = new THREE.Vector3();
      for (const { record, vertexIndex } of refs) {
        this.tempVector.fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);
        center.add(this.tempWorld);
      }
      return center.multiplyScalar(1 / refs.length);
    },

    updateMoveGizmo() {
      if (!this.transformControls) {
        return;
      }
      const refs = this.selectedVertexRefs();
      const shouldShow = !this.cleanPreview && this.activeTool === "move" && this.viewMode === "edit" && refs.length > 0;

      if (!shouldShow) {
        if (this.activeTool !== "bone") {
          this.transformControls.detach();
          this.transformControls.enabled = false;
          this.transformHelper.visible = false;
        }
        this.selectionPivot.visible = false;
        this.selectionPivotMarker.visible = false;
        return;
      }

      if (!this.moveDrag && !this.transformControls.dragging) {
        const center = this.selectionWorldCenter(refs);
        if (center) {
          this.selectionPivot.position.copy(center);
        }
      }

      this.selectionPivot.visible = true;
      this.selectionPivotMarker.visible = true;
      this.selectionPivotMarker.position.copy(this.selectionPivot.position);
      this.selectionPivot.updateMatrixWorld(true);
      this.selectionPivotMarker.updateMatrixWorld(true);
      if (this.transformControls.object !== this.selectionPivot) {
        this.transformControls.attach(this.selectionPivot);
      }
      this.transformControls.enabled = true;
      this.transformHelper.visible = true;
    },

    beginSelectionMove() {
      const refs = this.selectedVertexRefs();
      if (!refs.length) {
        this.moveDrag = null;
        this.updateMoveGizmo();
        return;
      }
      this.moveDrag = {
        startPivot: this.selectionPivot.position.clone(),
        vertices: refs.map(({ record, vertexIndex }) => ({
          record,
          vertexIndex,
          startPosition: new THREE.Vector3().fromBufferAttribute(record.geometry.attributes.position, vertexIndex),
          startWorld: this.vertexWorldPosition(
            record,
            vertexIndex,
            new THREE.Vector3().fromBufferAttribute(record.geometry.attributes.position, vertexIndex)
          ),
          inverseSkinMatrix: this.inverseVertexSkinMatrix(record, vertexIndex)
        }))
      };
    },

    worldDeltaToObjectLocal(object, worldDelta) {
      this.tempMatrix.copy(object.matrixWorld).invert();
      this.tempLocalA.set(0, 0, 0).applyMatrix4(this.tempMatrix);
      this.tempLocalB.copy(worldDelta).applyMatrix4(this.tempMatrix);
      return this.tempLocalB.sub(this.tempLocalA).clone();
    },

    applySelectionMove() {
      if (!this.moveDrag) {
        return;
      }
      this.model.updateMatrixWorld(true);
      this.tempWorldDelta
        .copy(this.selectionPivot.position)
        .sub(this.moveDrag.startPivot)
        .multiplyScalar(Number(this.moveSensitivity.value));
      const visiblePivot = this.moveDrag.startPivot.clone().add(this.tempWorldDelta);
      this.selectionPivot.position.copy(visiblePivot);
      const changedRecords = new Set();

      for (const { record, vertexIndex, startPosition, startWorld, inverseSkinMatrix } of this.moveDrag.vertices) {
        this.moveVertexByWorldDelta(record, vertexIndex, this.tempWorldDelta, {
          startPosition,
          startWorld,
          inverseSkinMatrix
        });
        record.modified.add(vertexIndex);
        record.sculpted.add(vertexIndex);
        record.weightCompensated?.delete(vertexIndex);
        changedRecords.add(record);
      }

      for (const record of changedRecords) {
        record.geometry.attributes.position.needsUpdate = true;
        this.preserveImportedNormals(record);
        this.updateRecordColors(record);
      }
      this.selectionPivotMarker.position.copy(this.selectionPivot.position);
      this.syncPatchJson();
      this.updateSelectionMarkers();
      if (this.viewMode === "edit") {
        this.updateAllVertexMarkers();
      }
    },

    finishSelectionMove() {
      if (!this.moveDrag) {
        this.updateMoveGizmo();
        return;
      }
      const moved = this.moveDrag.vertices.length;
      this.moveDrag = null;
      this.updateMoveGizmo();
      this.setStatus(`Moved ${moved} selected ${moved === 1 ? "vertex" : "vertices"}`);
    },

    applyBoneTransform(object, vertexIndex, target) {
      if (typeof object.applyBoneTransform === "function") {
        object.applyBoneTransform(vertexIndex, target);
      } else if (typeof object.boneTransform === "function") {
        object.boneTransform(vertexIndex, target);
      }
    },

    updateCounts() {
      const selected = this.paintRecords.reduce((sum, record) => (
        sum + [...record.selected].filter((vertexIndex) => !record.deleted?.has(vertexIndex)).length
      ), 0);
      const modified = this.paintRecords.reduce((sum, record) => {
        const edited = new Set([...(record.modified || []), ...(record.deleted || [])]);
        return sum + edited.size;
      }, 0);
      const keyCount = [...this.poseKeyframes.values()].reduce((sum, framePose) => sum + Object.keys(framePose).length, 0);
      this.selectionCount.textContent = `${selected} ${selected === 1 ? "vertex" : "vertices"}`;
      this.patchCount.textContent = `${modified} ${modified === 1 ? "vertex" : "vertices"}`;
      this.keyCount.textContent = `${keyCount} ${keyCount === 1 ? "key" : "keys"}`;
      this.syncTimelineSourceControl?.();
      this.syncClonePaintControls?.();
      this.updateSelectionInfluences();
    },

    texturePaintMaterialsForRecord(record) {
      return Array.isArray(record?.object?.material)
        ? record.object.material
        : [record?.object?.material].filter(Boolean);
    },

    serializeTexturePaints() {
      const textures = [];
      for (const record of this.paintRecords || []) {
        const materials = this.texturePaintMaterialsForRecord(record);
        for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
          const material = materials[materialIndex];
          const canvas = material?.userData?.clonePaintCanvas;
          if (!canvas || typeof canvas.toDataURL !== "function") {
            continue;
          }
          try {
            textures.push({
              mesh: record.object.name || "SkinnedMesh",
              materialIndex,
              materialName: material.name || "",
              width: canvas.width,
              height: canvas.height,
              image: canvas.toDataURL("image/png")
            });
          } catch (error) {
            console.warn("Could not serialize edited texture", error);
          }
        }
      }
      return textures;
    },

    buildPatch() {
      const assignments = [];
      const deletedVertices = [];
      for (const record of this.paintRecords) {
        for (const vertexIndex of [...record.modified].sort((a, b) => a - b)) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          const isWeightCompensationOnly = record.weightCompensated?.has(vertexIndex) && !record.sculpted?.has(vertexIndex);
          const assignment = {
            mesh: record.object.name || "SkinnedMesh",
            vertex: vertexIndex
          };
          const weights = this.getVertexWeights(record, vertexIndex);
          if (Object.keys(weights).length) {
            assignment.weights = weights;
          }
          const positionDelta = this.getVertexPositionDelta(record, vertexIndex);
          if (positionDelta) {
            if (isWeightCompensationOnly) {
              assignment.weightPositionDelta = positionDelta;
            } else {
              assignment.positionDelta = positionDelta;
            }
          }
          assignments.push(assignment);
        }
        if (record.deleted?.size) {
          deletedVertices.push({
            mesh: record.object.name || "SkinnedMesh",
            vertices: [...record.deleted].sort((a, b) => a - b)
          });
        }
      }
      const includePoseKeyframes = !this.poseKeyframesGenerated;
      const poseKeyframes = includePoseKeyframes ? this.serializePoseKeyframes() : [];
      const poseCurveHandles = includePoseKeyframes ? this.serializePoseCurveHandles?.() || [] : [];
      const patch = {
        version: 1,
        actor: this.actorTarget.id,
        model: this.actorTarget.modelUrl.replace(/^\.\//, ""),
        rigBones: this.virtualBones.map((bone) => ({ ...bone })),
        boneChains: this.manualBoneChains.map((chain) => ({
          name: chain.name,
          bones: [...chain.bones],
          ik: this.normalizeIkChainSettings?.(this.ikChainSettings?.get(chain.id) || chain.ik || this.defaultIkChainSettings?.())
        })),
        assignments,
        poseKeyframes
      };
      if (poseCurveHandles.length) {
        patch.poseCurveHandles = poseCurveHandles;
      }
      if (poseKeyframes.length) {
        const poseKeyframeAction = this.clipCleanupActionKey?.(this.activeClipEntry);
        if (poseKeyframeAction) {
          patch.poseKeyframeAction = poseKeyframeAction;
        }
        patch.poseKeyframeSource = this.timelineKeysSourceWasAutoGenerated ? "solved" : "authored";
      }
      if (deletedVertices.length) {
        patch.deletedVertices = deletedVertices;
      }
      if (includePoseKeyframes && this.poseKeyframeMode === "replace") {
        patch.poseKeyframeMode = "replace";
      }
      const clipCleanup = this.serializeClipCleanupEdits?.() || [];
      if (clipCleanup.length) {
        patch.clipCleanup = clipCleanup;
      }
      const texturePaints = this.serializeTexturePaints();
      if (texturePaints.length) {
        patch.texturePaints = texturePaints;
      }
      return patch;
    },

    normalizedPatchPoseLayer(patch, customBoneNames = new Set()) {
      const keyframes = Array.isArray(patch?.poseKeyframes) ? patch.poseKeyframes : [];
      const requestedMode = patch?.poseKeyframeMode === "replace" ? "replace" : "additive";
      const explicitGenerated = patch?.poseKeyframesGenerated === true || patch?.poseKeyframeSource === "generated";
      const explicitTimelineSource = patch?.poseKeyframeSource === "solved" || patch?.poseKeyframeSource === "authored";
      const poseKeyframeAction = String(patch?.poseKeyframeAction || patch?.poseAction || "").trim();
      const activeAction = this.clipCleanupActionKey?.(this.activeClipEntry) || "";
      if (poseKeyframeAction && activeAction && poseKeyframeAction !== activeAction) {
        return {
          keyframes: [],
          mode: "additive",
          generated: false,
          migrated: false,
          skippedAction: true,
          removedSourceEntries: 0
        };
      }
      if (this.actorTarget?.mode === "bird-flap" || requestedMode !== "replace" || !keyframes.length) {
        return {
          keyframes,
          mode: requestedMode,
          generated: explicitGenerated,
          migrated: false,
          skippedAction: false,
          removedSourceEntries: 0
        };
      }

      if (explicitGenerated) {
        return {
          keyframes,
          mode: requestedMode,
          generated: true,
          migrated: false,
          skippedAction: false,
          removedSourceEntries: 0
        };
      }

      if (explicitTimelineSource) {
        return {
          keyframes,
          mode: requestedMode,
          generated: false,
          migrated: false,
          skippedAction: false,
          removedSourceEntries: 0
        };
      }

      let customEntries = 0;
      let sourceEntries = 0;
      const sourceBoneNames = new Set();
      const customKeyframes = [];
      for (const key of keyframes) {
        if (!Number.isInteger(key?.frame) || !key.bones || typeof key.bones !== "object") {
          continue;
        }
        const customBones = {};
        for (const [boneName, pose] of Object.entries(key.bones)) {
          if (customBoneNames.has(boneName)) {
            customBones[boneName] = pose;
            customEntries += 1;
          } else {
            sourceEntries += 1;
            sourceBoneNames.add(boneName);
          }
        }
        if (Object.keys(customBones).length) {
          customKeyframes.push({ frame: key.frame, bones: customBones });
        }
      }

      const looksLikeGeneratedSourceLayer = sourceEntries >= Math.max(24, customEntries * 2)
        && sourceBoneNames.size >= 6
        && keyframes.length >= 4;
      if (!looksLikeGeneratedSourceLayer) {
        return {
          keyframes,
          mode: requestedMode,
          generated: false,
          migrated: false,
          skippedAction: false,
          removedSourceEntries: 0
        };
      }

      if (customEntries > 0) {
        return {
          keyframes: customKeyframes,
          mode: "additive",
          generated: false,
          migrated: true,
          skippedAction: false,
          removedSourceEntries: sourceEntries
        };
      }

      return {
        keyframes,
        mode: requestedMode,
        generated: true,
        migrated: true,
        skippedAction: false,
        removedSourceEntries: sourceEntries
      };
    },

    serializePatchText(patch = this.buildPatch()) {
      return `${JSON.stringify(patch, null, 2)}\n`;
    },

    setPatchJsonFromPatch(patch = this.buildPatch()) {
      this.weightJson.value = this.serializePatchText(patch).trimEnd();
      this.updateCounts();
      return patch;
    },

    syncPatchJson() {
      return this.setPatchJsonFromPatch(this.buildPatch());
    },

    getVertexWeights(record, vertexIndex) {
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      const offset = vertexIndex * 4;
      const weights = {};
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.array[offset + slot];
        if (weight <= 0.0001) {
          continue;
        }
        const bone = record.object.skeleton.bones[skinIndex.array[offset + slot]];
        if (bone) {
          weights[bone.name] = Number(weight.toFixed(5));
        }
      }
      return weights;
    },

    updateSelectionInfluences() {
      if (!this.selectionInfluenceList) {
        return;
      }
      const selectedRefs = this.selectedVertexRefs();
      if (!selectedRefs.length) {
        const empty = document.createElement("span");
        empty.className = "selection-influence-empty";
        empty.textContent = "No selection";
        this.selectionInfluenceList.replaceChildren(empty);
        return;
      }

      const totals = new Map();
      for (const { record, vertexIndex } of selectedRefs) {
        const weights = this.getVertexWeights(record, vertexIndex);
        for (const [boneName, weight] of Object.entries(weights)) {
          const displayBoneName = this.canonicalMirrorBone(boneName);
          const current = totals.get(displayBoneName) || 0;
          totals.set(displayBoneName, current + weight);
        }
      }

      const activeInfluenceBone = this.canonicalMirrorBone(this.boneSelect?.value || this.activeBoneName || "");
      if (activeInfluenceBone && this.bones.has(activeInfluenceBone) && !totals.has(activeInfluenceBone)) {
        totals.set(activeInfluenceBone, 0);
      }

      const rows = [...totals.entries()]
        .map(([boneName, total]) => ({
          boneName,
          value: total / selectedRefs.length,
          active: boneName === activeInfluenceBone
        }))
        .filter((entry) => entry.active || entry.value > 0.0001)
        .sort((a, b) => Number(b.active) - Number(a.active) || b.value - a.value)
        .slice(0, 8)
        .map((entry) => {
          const row = document.createElement("div");
          row.className = `selection-influence-row${entry.active ? " is-active" : ""}`;

          const name = document.createElement("span");
          name.className = "selection-influence-name";
          name.textContent = this.boneDisplayName(entry.boneName);

          const value = document.createElement("span");
          value.className = "selection-influence-value";
          value.textContent = `${Math.round(entry.value * 100)}%`;
          value.dataset.influenceValue = entry.boneName;

          const slider = document.createElement("input");
          slider.type = "range";
          slider.min = "0";
          slider.max = "1";
          slider.step = "0.01";
          slider.value = String(Number(entry.value.toFixed(2)));
          slider.dataset.adjustInfluence = entry.boneName;
          slider.title = `Adjust ${this.boneDisplayName(entry.boneName)} influence`;

          row.append(name, slider, value);
          return row;
        });

      if (!rows.length) {
        const empty = document.createElement("span");
        empty.className = "selection-influence-empty";
        empty.textContent = "No active weights";
        this.selectionInfluenceList.replaceChildren(empty);
        return;
      }
      this.selectionInfluenceList.replaceChildren(...rows);
    },

    getVertexPositionDelta(record, vertexIndex) {
      const offset = vertexIndex * 3;
      const position = record.geometry.attributes.position.array;
      const dx = position[offset] - record.originalPosition[offset];
      const dy = position[offset + 1] - record.originalPosition[offset + 1];
      const dz = position[offset + 2] - record.originalPosition[offset + 2];
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 0.00001) {
        return null;
      }
      return [Number(dx.toFixed(5)), Number(dy.toFixed(5)), Number(dz.toFixed(5))];
    },

    loadTexturePatchImage(src) {
      return new Promise((resolve, reject) => {
        if (!src || typeof Image === "undefined") {
          reject(new Error("Missing texture image"));
          return;
        }
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not load texture image"));
        image.src = src;
      });
    },

    texturePaintMaterialForPatch(entry) {
      const record = this.paintRecords.find((item) => item.object.name === entry.mesh) || this.paintRecords[0];
      if (!record) {
        return null;
      }
      const materials = this.texturePaintMaterialsForRecord(record);
      const materialIndex = Number.isInteger(entry.materialIndex) ? entry.materialIndex : -1;
      return materials[materialIndex]
        || materials.find((material) => entry.materialName && material?.name === entry.materialName)
        || materials[0]
        || null;
    },

    async applySerializedTexturePaints(entries = []) {
      if (!Array.isArray(entries) || !entries.length || typeof document === "undefined") {
        return 0;
      }
      let applied = 0;
      for (const entry of entries) {
        const material = this.texturePaintMaterialForPatch(entry);
        const editable = this.editableClonePaintTexture?.(material);
        if (!editable?.canvas || !editable?.context || !entry?.image) {
          continue;
        }
        try {
          const image = await this.loadTexturePatchImage(entry.image);
          editable.context.clearRect(0, 0, editable.canvas.width, editable.canvas.height);
          editable.context.drawImage(image, 0, 0, editable.canvas.width, editable.canvas.height);
          editable.texture.needsUpdate = true;
          if (material) {
            material.needsUpdate = true;
          }
          applied += 1;
        } catch (error) {
          console.warn("Could not apply edited texture", error);
        }
      }
      if (applied > 0) {
        this.setPatchJsonFromPatch?.(this.buildPatch());
      }
      return applied;
    },

    applyPatchObject(patch, { status = true, errorStatus = "Could not apply weight patch", applyPose = true } = {}) {
      try {
        if (!patch || !Array.isArray(patch.assignments)) {
          throw new Error("Patch JSON must include assignments");
        }
        if (patch.actor && patch.actor !== this.actorTarget.id) {
          this.setStatus(`Patch is for ${patch.actor}; switch character first`);
          return;
        }

        this.resetVirtualBones();
        for (const record of this.paintRecords) {
          record.geometry.attributes.position.array.set(record.originalPosition);
          record.geometry.attributes.skinIndex.array.set(record.originalSkinIndex);
          record.geometry.attributes.skinWeight.array.set(record.originalSkinWeight);
          record.modified.clear();
          record.sculpted.clear();
          record.weightCompensated?.clear();
          record.deleted?.clear();
          this.applyDeletedVertices(record);
          record.selected.clear();
        }

        this.applyRigBones(patch.rigBones || []);
        this.applyBoneChains?.(patch.boneChains || []);
        const customBoneNames = new Set(this.virtualBones.map((bone) => bone.name));
        const clipCleanupChanged = this.applySerializedClipCleanupEdits?.(patch.clipCleanup || []) || false;
        const poseLayer = this.normalizedPatchPoseLayer(patch, customBoneNames);
        this.poseKeyframeMode = poseLayer.mode;
        this.poseKeyframesGenerated = poseLayer.generated;
        this.timelineKeysSourceWasAutoGenerated = patch.poseKeyframeSource === "solved" && !poseLayer.generated;
        for (const deletion of patch.deletedVertices || []) {
          const record = this.paintRecords.find((item) => item.object.name === deletion.mesh) || this.paintRecords[0];
          if (!record || !Array.isArray(deletion.vertices)) {
            continue;
          }
          for (const vertexIndex of deletion.vertices) {
            if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= record.geometry.attributes.position.count) {
              continue;
            }
            record.deleted.add(vertexIndex);
          }
          this.cleanupDeletedVertexSelection(record);
          this.applyDeletedVertices(record);
        }
        let applied = 0;
        for (const assignment of patch.assignments) {
          const record = this.paintRecords.find((item) => item.object.name === assignment.mesh) || this.paintRecords[0];
          if (!record || !Number.isInteger(assignment.vertex)) {
            continue;
          }
          const needsLegacyCustomBindCompensation = Boolean(
            assignment.weights
            && !assignment.positionDelta
            && !assignment.weightPositionDelta
            && Object.keys(assignment.weights).some((name) => customBoneNames.has(name))
          );
          const worldBeforeWeights = needsLegacyCustomBindCompensation
            ? this.vertexWorldPosition(record, assignment.vertex)
            : null;
          if (assignment.weights) {
            this.applyWeightsToVertex(record, assignment.vertex, assignment.weights);
          }
          if (assignment.positionDelta) {
            this.applyPositionDeltaToVertex(record, assignment.vertex, assignment.positionDelta);
            record.sculpted.add(assignment.vertex);
            record.weightCompensated?.delete(assignment.vertex);
          } else if (assignment.weightPositionDelta) {
            this.applyPositionDeltaToVertex(record, assignment.vertex, assignment.weightPositionDelta);
            record.weightCompensated?.add(assignment.vertex);
            record.sculpted.delete(assignment.vertex);
          } else if (worldBeforeWeights) {
            const changed = this.setVertexRawPositionForWorld(record, assignment.vertex, worldBeforeWeights);
            if (changed) {
              record.weightCompensated?.add(assignment.vertex);
            }
          }
          record.modified.add(assignment.vertex);
          applied += 1;
        }
        this.applySerializedPoseKeyframes(poseLayer.keyframes, { generated: poseLayer.generated });
        this.applySerializedPoseCurveHandles?.(patch.poseCurveHandles || []);
        this.poseKeyframeMode = poseLayer.mode;
        const texturePaints = Array.isArray(patch.texturePaints) ? patch.texturePaints : [];

        for (const record of this.paintRecords) {
          record.geometry.attributes.position.needsUpdate = true;
          record.geometry.attributes.skinIndex.needsUpdate = true;
          record.geometry.attributes.skinWeight.needsUpdate = true;
          this.preserveImportedNormals(record);
          this.updateRecordColors(record);
        }
        this.updateSelectionMarkers();
        this.updateMoveGizmo();
        if (clipCleanupChanged && this.activeClipEntry?.clip && this.actorTarget?.mode !== "bird-flap") {
          void this.playClipEntry(this.activeClipEntry);
        }
        if (applyPose) {
          this.lastClipSampleTime = null;
          this.applyPose(this.progress);
        }
        this.refreshRigControls(this.activeBoneName);
        this.syncPoseControls();
        this.setPatchJsonFromPatch(this.buildPatch());
        if (status) {
          this.setStatus(poseLayer.migrated && poseLayer.removedSourceEntries
            ? `Applied ${applied} weight patch vertices; ignored ${poseLayer.removedSourceEntries} generated source pose keys`
            : `Applied ${applied} weight patch vertices`);
        }
        if (texturePaints.length && typeof this.applySerializedTexturePaints === "function") {
          void this.applySerializedTexturePaints(texturePaints).then((textureCount) => {
            if (status && textureCount > 0) {
              this.setStatus(`Applied ${applied} weight patch vertices and ${textureCount} edited ${textureCount === 1 ? "texture" : "textures"}`);
            }
          });
        }
        return true;
      } catch (error) {
        console.error(error);
        this.setStatus(errorStatus);
        return false;
      }
    },

    applyPatchJson({ status = true } = {}) {
      try {
        return this.applyPatchObject(JSON.parse(this.weightJson.value), {
          status,
          errorStatus: "Could not parse weight patch JSON"
        });
      } catch (error) {
        console.error(error);
        this.setStatus("Could not parse weight patch JSON");
        return false;
      }
    },

    applyWeightsToVertex(record, vertexIndex, weightsByName) {
      const entries = Object.entries(weightsByName)
        .map(([name, weight]) => ({
          index: record.object.skeleton.bones.findIndex((bone) => bone.name === name),
          weight: Number(weight)
        }))
        .filter((entry) => entry.index >= 0 && entry.weight > 0.0001);
      const normalized = this.normalizeWeightEntries(entries);
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      const offset = vertexIndex * 4;
      for (let slot = 0; slot < 4; slot += 1) {
        skinIndex.array[offset + slot] = normalized[slot]?.index || 0;
        skinWeight.array[offset + slot] = normalized[slot]?.weight || 0;
      }
      this.invalidateBoneDisplayCache?.();
    },

    applyPositionDeltaToVertex(record, vertexIndex, delta) {
      const offset = vertexIndex * 3;
      record.geometry.attributes.position.array[offset] = record.originalPosition[offset] + Number(delta[0] || 0);
      record.geometry.attributes.position.array[offset + 1] = record.originalPosition[offset + 1] + Number(delta[1] || 0);
      record.geometry.attributes.position.array[offset + 2] = record.originalPosition[offset + 2] + Number(delta[2] || 0);
    }
  });
}
