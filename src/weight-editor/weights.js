export function installWeightMethods(BirdWeightEditor, deps) {
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
    assignSelectionToBone(boneName, weight, options = {}) {
      const anySelected = this.paintRecords.some((record) => (
        [...record.selected].some((vertexIndex) => !record.deleted?.has(vertexIndex))
      ));
      if (!anySelected) {
        this.setStatus("Paint a selection first");
        return 0;
      }

      let changed = 0;
      let mirroredChanged = 0;
      for (const record of this.paintRecords) {
        const boneIndex = record.object.skeleton.bones.findIndex((bone) => bone.name === boneName);
        if (boneIndex < 0) {
          continue;
        }
        const mirrorBoneName = this.mirrorMode ? this.mirrorBoneName(boneName) : "";
        const mirrorBoneIndex = mirrorBoneName
          ? record.object.skeleton.bones.findIndex((bone) => bone.name === mirrorBoneName)
          : -1;
        const canMirrorWeights = mirrorBoneIndex >= 0;
        const sourceSide = canMirrorWeights ? this.boneSideSignForRecord(record, boneName) : 0;
        const targets = new Map();
        const addTarget = (vertexIndex, targetBoneIndex, mirrored = false) => {
          if (vertexIndex < 0 || targetBoneIndex < 0) {
            return;
          }
          for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
            const key = `${linkedIndex}:${targetBoneIndex}`;
            if (!targets.has(key)) {
              targets.set(key, { vertexIndex: linkedIndex, boneIndex: targetBoneIndex, mirrored });
            }
          }
        };

        for (const vertexIndex of record.selected) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          const vertexSide = this.vertexSideSign(record, vertexIndex);
          const selectedOnMirrorSide = canMirrorWeights && sourceSide && vertexSide && vertexSide !== sourceSide;
          const directBoneIndex = selectedOnMirrorSide ? mirrorBoneIndex : boneIndex;
          const oppositeBoneIndex = selectedOnMirrorSide ? boneIndex : mirrorBoneIndex;
          addTarget(vertexIndex, directBoneIndex, false);

          if (canMirrorWeights) {
            addTarget(this.findMirroredVertex(record, vertexIndex), oppositeBoneIndex, true);
          }
        }

        const fallbackBoneName = options.fallbackBoneName ? this.canonicalMirrorBone(options.fallbackBoneName) : "";
        const fallbackBoneIndex = fallbackBoneName
          ? record.object.skeleton.bones.findIndex((bone) => bone.name === fallbackBoneName)
          : -1;
        const mirrorFallbackBoneName = this.mirrorMode && fallbackBoneName ? this.mirrorBoneName(fallbackBoneName) : "";
        const mirrorFallbackBoneIndex = mirrorFallbackBoneName
          ? record.object.skeleton.bones.findIndex((bone) => bone.name === mirrorFallbackBoneName)
          : -1;
        let reattached = 0;
        let blocked = 0;
        let recordPositionChanged = false;
        this.model?.updateMatrixWorld(true);
        record.object.updateMatrixWorld(true);

        for (const target of targets.values()) {
          const fallbackTargetBoneIndex = target.mirrored && mirrorFallbackBoneIndex >= 0
            ? mirrorFallbackBoneIndex
            : fallbackBoneIndex;
          const worldBeforeWeights = this.vertexWorldPosition(record, target.vertexIndex);
          const result = this.setVertexBoneWeight(record, target.vertexIndex, target.boneIndex, weight, {
            fallbackBoneIndex: fallbackTargetBoneIndex
          });
          if (result.blocked) {
            blocked += 1;
            continue;
          }
          if (result.reattached) {
            reattached += 1;
          }
          if (result.changed) {
            if (this.isVertexEdited(record, target.vertexIndex)) {
              record.modified.add(target.vertexIndex);
            } else {
              record.modified.delete(target.vertexIndex);
            }
            changed += 1;
            if (target.mirrored) {
              mirroredChanged += 1;
            }
            const positionChanged = this.setVertexRawPositionForWorld(record, target.vertexIndex, worldBeforeWeights);
            recordPositionChanged = recordPositionChanged || positionChanged;
            if (positionChanged) {
              record.weightCompensated?.add(target.vertexIndex);
            } else if (!this.getVertexPositionDelta(record, target.vertexIndex)) {
              record.weightCompensated?.delete(target.vertexIndex);
            }
          }
        }
        options.reattachedCount = (options.reattachedCount || 0) + reattached;
        options.blockedCount = (options.blockedCount || 0) + blocked;
        if (recordPositionChanged) {
          record.geometry.attributes.position.needsUpdate = true;
          this.preserveImportedNormals(record);
        }
        record.geometry.attributes.skinIndex.needsUpdate = true;
        record.geometry.attributes.skinWeight.needsUpdate = true;
        if (options.clearSelection) {
          record.selected.clear();
        }
        this.updateRecordColors(record);
      }

      this.syncPatchJson();
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.applyPose(this.progress);
      const actionLabel = options.label || "Set";
      const targetLabel = options.statusBoneLabel || `${this.boneDisplayName(boneName)} influence`;
      const suffix = options.clearSelection ? " and cleared selection" : "";
      const mirrorSuffix = mirroredChanged > 0 ? `, mirrored ${mirroredChanged}` : "";
      const fallbackName = options.fallbackBoneName ? this.canonicalMirrorBone(options.fallbackBoneName) : "";
      const reattachedSuffix = options.reattachedCount > 0 && fallbackName
        ? `, reattached ${options.reattachedCount} to ${this.boneDisplayName(fallbackName)}`
        : "";
      const blockedSuffix = options.blockedCount > 0
        ? `, kept ${options.blockedCount} because no different reattach bone was selected`
        : "";
      this.setStatus(`${actionLabel} ${targetLabel} to ${weight.toFixed(2)} on ${changed} vertices${mirrorSuffix}${reattachedSuffix}${blockedSuffix}${suffix}`);
      return changed;
    },

    removeBoneInfluenceFromSelection(boneName) {
      const canonicalName = this.canonicalMirrorBone(boneName);
      const options = {
        label: "Removed",
        statusBoneLabel: `${this.boneDisplayName(canonicalName)} influence`,
        fallbackBoneName: this.boneSelect?.value || ""
      };
      const changed = this.assignSelectionToBone(canonicalName, 0, options);
      if (changed === 0 && !options.blockedCount) {
        this.setStatus(`${this.boneDisplayName(canonicalName)} is not influencing the selection`);
      }
      return changed;
    },

    adjustSelectionInfluenceFromControl(boneName, weight) {
      const canonicalName = this.canonicalMirrorBone(boneName);
      return this.assignSelectionToBone(canonicalName, weight, {
        label: "Adjusted",
        statusBoneLabel: `${this.boneDisplayName(canonicalName)} influence`,
        fallbackBoneName: this.boneSelect?.value || ""
      });
    },

    chainWeightEntriesForPoint(point, chainPoints, chainIndices) {
      if (chainIndices.length === 1) {
        return [{ index: chainIndices[0], weight: 1 }];
      }

      let bestIndex = 0;
      let bestT = 0;
      let bestDistanceSq = Infinity;
      const segment = new THREE.Vector3();
      const projected = new THREE.Vector3();
      const fromStart = new THREE.Vector3();

      for (let index = 0; index < chainPoints.length - 1; index += 1) {
        const start = chainPoints[index];
        const end = chainPoints[index + 1];
        segment.copy(end).sub(start);
        const lengthSq = segment.lengthSq();
        const t = lengthSq > 0.0000001
          ? THREE.MathUtils.clamp(fromStart.copy(point).sub(start).dot(segment) / lengthSq, 0, 1)
          : 0;
        projected.copy(start).addScaledVector(segment, t);
        const distanceSq = projected.distanceToSquared(point);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestIndex = index;
          bestT = t;
        }
      }

      if (bestT <= 0.0001) {
        return [{ index: chainIndices[bestIndex], weight: 1 }];
      }
      if (bestT >= 0.9999) {
        return [{ index: chainIndices[bestIndex + 1], weight: 1 }];
      }
      return [
        { index: chainIndices[bestIndex], weight: 1 - bestT },
        { index: chainIndices[bestIndex + 1], weight: bestT }
      ];
    },

    chainCumulativeDistances(chainPoints) {
      const distances = [0];
      for (let index = 1; index < chainPoints.length; index += 1) {
        distances.push(distances[index - 1] + chainPoints[index].distanceTo(chainPoints[index - 1]));
      }
      return distances;
    },

    chainWeightEntriesForDistance(distance, chainDistances, chainIndices) {
      if (chainIndices.length === 1) {
        return [{ index: chainIndices[0], weight: 1 }];
      }
      const maxDistance = chainDistances[chainDistances.length - 1] || 0;
      const targetDistance = THREE.MathUtils.clamp(distance, 0, maxDistance);
      for (let index = 0; index < chainDistances.length - 1; index += 1) {
        const start = chainDistances[index];
        const end = chainDistances[index + 1];
        if (targetDistance > end && index < chainDistances.length - 2) {
          continue;
        }
        const span = Math.max(0.000001, end - start);
        const t = THREE.MathUtils.clamp((targetDistance - start) / span, 0, 1);
        if (t <= 0.0001) {
          return [{ index: chainIndices[index], weight: 1 }];
        }
        if (t >= 0.9999) {
          return [{ index: chainIndices[index + 1], weight: 1 }];
        }
        return [
          { index: chainIndices[index], weight: 1 - t },
          { index: chainIndices[index + 1], weight: t }
        ];
      }
      return [{ index: chainIndices[chainIndices.length - 1], weight: 1 }];
    },

    closestDistanceAlongChain(point, chainPoints, chainDistances) {
      if (chainPoints.length <= 1) {
        return 0;
      }
      let bestDistance = 0;
      let bestDistanceSq = Infinity;
      const segment = new THREE.Vector3();
      const projected = new THREE.Vector3();
      const fromStart = new THREE.Vector3();
      for (let index = 0; index < chainPoints.length - 1; index += 1) {
        const start = chainPoints[index];
        const end = chainPoints[index + 1];
        segment.copy(end).sub(start);
        const lengthSq = segment.lengthSq();
        const t = lengthSq > 0.0000001
          ? THREE.MathUtils.clamp(fromStart.copy(point).sub(start).dot(segment) / lengthSq, 0, 1)
          : 0;
        projected.copy(start).addScaledVector(segment, t);
        const distanceSq = projected.distanceToSquared(point);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestDistance = chainDistances[index] + Math.sqrt(lengthSq) * t;
        }
      }
      return bestDistance;
    },

    chainAxisCoordinate(point, chainPoints) {
      if (chainPoints.length <= 1) {
        return 0;
      }
      const start = chainPoints[0];
      const end = chainPoints[chainPoints.length - 1];
      const axis = new THREE.Vector3().copy(end).sub(start);
      const lengthSq = axis.lengthSq();
      if (lengthSq <= 0.0000001) {
        return null;
      }
      return new THREE.Vector3().copy(point).sub(start).dot(axis) / lengthSq;
    },

    nearestChainBoneIndex(point, chainPoints) {
      let bestIndex = 0;
      let bestDistanceSq = Infinity;
      for (let index = 0; index < chainPoints.length; index += 1) {
        const distanceSq = point.distanceToSquared(chainPoints[index]);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestIndex = index;
        }
      }
      return bestIndex;
    },

    rawVertexWorldPosition(record, vertexIndex) {
      const point = new THREE.Vector3().fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
      record.object.localToWorld(point);
      return point;
    },

    setVertexRawPositionForWorld(record, vertexIndex, worldPosition) {
      const position = record.geometry.attributes.position;
      const before = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
      const local = worldPosition.clone();
      record.object.worldToLocal(local);
      const inverseSkinMatrix = this.inverseVertexSkinMatrix(record, vertexIndex);
      local.applyMatrix4(inverseSkinMatrix);
      position.setXYZ(vertexIndex, local.x, local.y, local.z);
      return before.distanceToSquared(local) > 0.0000000001;
    },

    redistributeSelectionAcrossBoneChain(rootName = this.selectedBoneChainRootName) {
      const chainNames = this.selectedBoneChainNames?.(rootName) || [];
      if (!chainNames.length) {
        this.setStatus("Choose a custom bone chain first");
        return 0;
      }
      const anySelected = this.paintRecords.some((record) => (
        [...record.selected].some((vertexIndex) => !record.deleted?.has(vertexIndex))
      ));
      if (!anySelected) {
        this.setStatus("Paint a selection first");
        return 0;
      }

      const chain = this.customBoneChains?.().find((item) => item.root === rootName);
      const chainKey = chain?.root || this.customBoneRootName?.(rootName) || rootName || chainNames[0];
      this.selectedBoneChainRootName = chainKey;
      if (this.boneChainSelect) {
        this.boneChainSelect.value = chainKey;
      }
      this.model?.updateMatrixWorld(true);
      const chainPoints = chainNames.map((name) => {
        const point = new THREE.Vector3();
        this.bones.get(name)?.getWorldPosition(point);
        return point;
      });
      const chainDistances = this.chainCumulativeDistances(chainPoints);
      const totalChainDistance = chainDistances[chainDistances.length - 1] || 0;
      if (chainNames.length > 1 && totalChainDistance <= 0.000001) {
        this.setStatus("Move the chain bones apart before distributing weights");
        return 0;
      }

      let changed = 0;
      for (const record of this.paintRecords) {
        if (!record.selected.size || !record.object?.skeleton) {
          continue;
        }
        record.object.updateMatrixWorld(true);
        const chainIndices = chainNames.map((name) => record.object.skeleton.bones.findIndex((bone) => bone.name === name));
        if (chainIndices.some((index) => index < 0)) {
          continue;
        }

        const targets = new Set();
        for (const vertexIndex of record.selected) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
            if (!record.deleted?.has(linkedIndex)) {
              targets.add(linkedIndex);
            }
          }
        }

        const targetRefs = [...targets].map((vertexIndex) => ({
          vertexIndex,
          world: this.vertexWorldPosition(record, vertexIndex)
        }));

        let recordChanged = false;
        for (const { vertexIndex, world } of targetRefs) {
          const chainPointIndex = this.nearestChainBoneIndex(world, chainPoints);
          const entries = [{ index: chainIndices[chainPointIndex], weight: 1 }];
          const weightChanged = this.setVertexWeightEntries(record, vertexIndex, entries);
          const positionChanged = weightChanged
            ? this.setVertexRawPositionForWorld(record, vertexIndex, world)
            : false;
          if (!weightChanged && !positionChanged) {
            continue;
          }
          if (positionChanged) {
            record.weightCompensated?.add(vertexIndex);
          } else if (!this.getVertexPositionDelta(record, vertexIndex)) {
            record.weightCompensated?.delete(vertexIndex);
          }
          if (this.isVertexEdited(record, vertexIndex)) {
            record.modified.add(vertexIndex);
          } else {
            record.modified.delete(vertexIndex);
          }
          recordChanged = true;
          changed += 1;
        }

        if (recordChanged) {
          record.geometry.attributes.position.needsUpdate = true;
          record.geometry.attributes.skinIndex.needsUpdate = true;
          record.geometry.attributes.skinWeight.needsUpdate = true;
          this.preserveImportedNormals(record);
          this.updateRecordColors(record);
        }
      }

      this.syncPatchJson();
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.applyPose(this.progress);
      this.updateSelectionInfluences();
      this.updateRigBoneList?.();
      const chainLabel = `${this.boneDisplayName(chainNames[0])} chain`;
      this.setStatus(
        changed > 0
          ? `Weighted ${changed} selected ${changed === 1 ? "vertex" : "vertices"} to nearest bone in ${chainLabel} (${chainNames.length} ${chainNames.length === 1 ? "bone" : "bones"})`
          : `${chainLabel} already matches the selection`
      );
      return changed;
    },

    setVertexBoneWeight(record, vertexIndex, boneIndex, targetWeight, options = {}) {
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      const offset = vertexIndex * 4;
      const before = [];
      for (let slot = 0; slot < 4; slot += 1) {
        before.push({
          index: skinIndex.array[offset + slot],
          weight: skinWeight.array[offset + slot]
        });
      }
      const target = THREE.MathUtils.clamp(targetWeight, 0, 1);
      const entries = [];

      for (let slot = 0; slot < 4; slot += 1) {
        const index = skinIndex.array[offset + slot];
        const weight = skinWeight.array[offset + slot];
        if (weight > 0.0001 && index !== boneIndex) {
          entries.push({ index, weight });
        }
      }

      entries.sort((a, b) => b.weight - a.weight);
      const remaining = entries.slice(0, target > 0.0001 ? 3 : 4);
      const remainingTotal = remaining.reduce((sum, entry) => sum + entry.weight, 0);
      const next = [];
      let reattached = false;

      if (target > 0.0001) {
        next.push({ index: boneIndex, weight: target });
      }

      if (remainingTotal > 0) {
        const scale = (1 - target) / remainingTotal;
        for (const entry of remaining) {
          next.push({ index: entry.index, weight: entry.weight * scale });
        }
      } else if (target < 0.9999) {
        const fallbackBoneIndex = Number.isInteger(options.fallbackBoneIndex) ? options.fallbackBoneIndex : -1;
        if (fallbackBoneIndex < 0 || fallbackBoneIndex === boneIndex) {
          return { changed: false, reattached: false, blocked: true };
        }
        next.push({ index: fallbackBoneIndex, weight: 1 - target });
        reattached = true;
      }

      const normalized = this.normalizeWeightEntries(next).slice(0, 4);
      for (let slot = 0; slot < 4; slot += 1) {
        skinIndex.array[offset + slot] = normalized[slot]?.index || 0;
        skinWeight.array[offset + slot] = normalized[slot]?.weight || 0;
      }
      const changed = before.some((entry, slot) => (
        entry.index !== skinIndex.array[offset + slot]
        || Math.abs(entry.weight - skinWeight.array[offset + slot]) > 0.0001
      ));
      if (changed) {
        this.invalidateBoneDisplayCache?.();
      }
      return { changed, reattached, blocked: false };
    },

    getVertexWeightEntries(record, vertexIndex) {
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      const offset = vertexIndex * 4;
      const entries = [];
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.array[offset + slot];
        if (weight > 0.0001) {
          entries.push({
            index: skinIndex.array[offset + slot],
            weight
          });
        }
      }
      return entries;
    },

    setVertexWeightEntries(record, vertexIndex, entries) {
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      const offset = vertexIndex * 4;
      const before = [];
      for (let slot = 0; slot < 4; slot += 1) {
        before.push({
          index: skinIndex.array[offset + slot],
          weight: skinWeight.array[offset + slot]
        });
      }

      const normalized = this.normalizeWeightEntries(entries).slice(0, 4);
      for (let slot = 0; slot < 4; slot += 1) {
        skinIndex.array[offset + slot] = normalized[slot]?.index || 0;
        skinWeight.array[offset + slot] = normalized[slot]?.weight || 0;
      }

      return before.some((entry, slot) => (
        entry.index !== skinIndex.array[offset + slot]
        || Math.abs(entry.weight - skinWeight.array[offset + slot]) > 0.0001
      ));
    },

    setVertexPositionDelta(record, vertexIndex, delta) {
      const position = record.geometry.attributes.position.array;
      const offset = vertexIndex * 3;
      const nextX = record.originalPosition[offset] + delta.x;
      const nextY = record.originalPosition[offset + 1] + delta.y;
      const nextZ = record.originalPosition[offset + 2] + delta.z;
      const changed = Math.abs(position[offset] - nextX)
        + Math.abs(position[offset + 1] - nextY)
        + Math.abs(position[offset + 2] - nextZ) > 0.00001;
      position[offset] = nextX;
      position[offset + 1] = nextY;
      position[offset + 2] = nextZ;
      return changed;
    },

    averageSeamWeightEntries(record, group) {
      const totals = new Map();
      for (const vertexIndex of group) {
        for (const entry of this.getVertexWeightEntries(record, vertexIndex)) {
          totals.set(entry.index, (totals.get(entry.index) || 0) + entry.weight / group.length);
        }
      }
      return [...totals.entries()].map(([index, weight]) => ({ index, weight }));
    },

    averageSeamPositionDelta(record, group) {
      const position = record.geometry.attributes.position.array;
      const delta = new THREE.Vector3();
      for (const vertexIndex of group) {
        const offset = vertexIndex * 3;
        delta.x += position[offset] - record.originalPosition[offset];
        delta.y += position[offset + 1] - record.originalPosition[offset + 1];
        delta.z += position[offset + 2] - record.originalPosition[offset + 2];
      }
      return delta.multiplyScalar(1 / group.length);
    },

    repairSeams() {
      let repairedGroups = 0;
      let repairedVertices = 0;

      for (const record of this.paintRecords) {
        const groups = new Set(record.seamVertexMap?.values() || []);
        for (const group of groups) {
          const activeGroup = group.filter((vertexIndex) => !record.deleted?.has(vertexIndex));
          if (!activeGroup.length) {
            continue;
          }
          const averagedWeights = this.averageSeamWeightEntries(record, activeGroup);
          const averagedDelta = this.averageSeamPositionDelta(record, activeGroup);
          let groupChanged = false;

          for (const vertexIndex of activeGroup) {
            const weightChanged = this.setVertexWeightEntries(record, vertexIndex, averagedWeights);
            const positionChanged = this.setVertexPositionDelta(record, vertexIndex, averagedDelta);
            groupChanged = groupChanged || weightChanged || positionChanged;

            if (this.isVertexEdited(record, vertexIndex)) {
              record.modified.add(vertexIndex);
            } else {
              record.modified.delete(vertexIndex);
              record.sculpted.delete(vertexIndex);
            }
          }

          if (groupChanged) {
            repairedGroups += 1;
            repairedVertices += activeGroup.length;
          }
        }

        record.geometry.attributes.position.needsUpdate = true;
        record.geometry.attributes.skinIndex.needsUpdate = true;
        record.geometry.attributes.skinWeight.needsUpdate = true;
        this.preserveImportedNormals(record);
        this.updateRecordColors(record);
      }

      this.syncPatchJson();
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.applyPose(this.progress);
      this.setStatus(
        repairedGroups > 0
          ? `Repaired ${repairedGroups} seam groups (${repairedVertices} vertices)`
          : "No seam differences found"
      );
      return { groups: repairedGroups, vertices: repairedVertices };
    },

    isVertexEdited(record, vertexIndex) {
      const offset = vertexIndex * 4;
      for (let slot = 0; slot < 4; slot += 1) {
        if (record.geometry.attributes.skinIndex.array[offset + slot] !== record.originalSkinIndex[offset + slot]) {
          return true;
        }
        if (Math.abs(record.geometry.attributes.skinWeight.array[offset + slot] - record.originalSkinWeight[offset + slot]) > 0.0001) {
          return true;
        }
      }
      return Boolean(this.getVertexPositionDelta(record, vertexIndex));
    },

    normalizeWeightEntries(entries) {
      const merged = new Map();
      for (const entry of entries) {
        merged.set(entry.index, (merged.get(entry.index) || 0) + entry.weight);
      }
      const compact = [...merged.entries()]
        .map(([index, weight]) => ({ index, weight }))
        .filter((entry) => entry.weight > 0.0001)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 4);
      const total = compact.reduce((sum, entry) => sum + entry.weight, 0);
      if (total <= 0) {
        return [];
      }
      return compact.map((entry) => ({ ...entry, weight: entry.weight / total }));
    },

    resetWeights() {
      for (const record of this.paintRecords) {
        record.geometry.attributes.position.array.set(record.originalPosition);
        record.geometry.attributes.skinIndex.array.set(record.originalSkinIndex);
        record.geometry.attributes.skinWeight.array.set(record.originalSkinWeight);
        record.geometry.attributes.position.needsUpdate = true;
        record.geometry.attributes.skinIndex.needsUpdate = true;
        record.geometry.attributes.skinWeight.needsUpdate = true;
        record.modified.clear();
        record.sculpted.clear();
        record.weightCompensated?.clear();
        record.deleted?.clear();
        record.selected.clear();
        this.applyDeletedVertices(record);
        this.preserveImportedNormals(record);
        this.updateRecordColors(record);
      }
      this.clearClonePaintState?.({ silent: true });
      this.syncPatchJson();
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.applyPose(this.progress);
      this.setStatus("Weights and selection reset");
    },

    restoreOriginalVertexWeights(record, vertexIndex) {
      const offset = vertexIndex * 4;
      for (let slot = 0; slot < 4; slot += 1) {
        record.geometry.attributes.skinIndex.array[offset + slot] = record.originalSkinIndex[offset + slot];
        record.geometry.attributes.skinWeight.array[offset + slot] = record.originalSkinWeight[offset + slot];
      }
      const positionOffset = vertexIndex * 3;
      record.geometry.attributes.position.array[positionOffset] = record.originalPosition[positionOffset];
      record.geometry.attributes.position.array[positionOffset + 1] = record.originalPosition[positionOffset + 1];
      record.geometry.attributes.position.array[positionOffset + 2] = record.originalPosition[positionOffset + 2];
      record.geometry.attributes.position.needsUpdate = true;
      record.geometry.attributes.skinIndex.needsUpdate = true;
      record.geometry.attributes.skinWeight.needsUpdate = true;
      record.sculpted.delete(vertexIndex);
      record.weightCompensated?.delete(vertexIndex);
    },

    updateRecordColors(record) {
      const color = new THREE.Color();
      const vertexCount = record.geometry.attributes.position.count;
      for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
        if (record.deleted?.has(vertexIndex)) {
          color.copy(BASE_COLOR);
          record.colorAttribute.setXYZ(vertexIndex, color.r, color.g, color.b);
          continue;
        }
        const selected = record.selected.has(vertexIndex);
        const modified = record.modified.has(vertexIndex);
        if (selected && modified) {
          color.copy(SELECTED_MODIFIED_COLOR);
        } else if (selected) {
          color.copy(SELECTED_COLOR);
        } else if (modified) {
          color.copy(MODIFIED_COLOR);
        } else {
          color.copy(BASE_COLOR);
        }
        record.colorAttribute.setXYZ(vertexIndex, color.r, color.g, color.b);
      }
      record.colorAttribute.needsUpdate = true;
    },

    preserveImportedNormals(record) {
      const normal = record?.geometry?.attributes?.normal;
      if (!normal) {
        return false;
      }

      const original = record.originalNormal;
      if (!original || original.length !== normal.array.length) {
        record.geometry.computeVertexNormals();
        return true;
      }

      let changed = false;
      for (let index = 0; index < original.length; index += 1) {
        if (Math.abs(normal.array[index] - original[index]) > 0.000001) {
          changed = true;
          break;
        }
      }

      if (changed) {
        normal.array.set(original);
        normal.needsUpdate = true;
      }
      return changed;
    },

    updateSelectionMarkers() {
      if (!this.model) {
        return;
      }
      this.model.updateMatrixWorld(true);
      const positions = [];
      const colors = [];
      const color = new THREE.Color();

      for (const record of this.paintRecords) {
        for (const vertexIndex of record.selected) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          positions.push(this.tempWorld.x, this.tempWorld.y, this.tempWorld.z);

          const modified = record.modified.has(vertexIndex);
          if (modified) {
            color.copy(SELECTED_MODIFIED_COLOR);
          } else {
            color.copy(SELECTED_COLOR);
          }
          colors.push(color.r, color.g, color.b);
        }
      }

      this.markerGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      this.markerGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      this.markerGeometry.computeBoundingSphere();
      this.markerVertexCount = positions.length / 3;
      this.updateSelectionMarkerStyle?.();
      this.selectionMarkers.visible = !this.cleanPreview
        && this.showSelectionLayer !== false
        && !this.cloneSpotlightActive
        && this.markerVertexCount > 0;
    },

    updateAllVertexMarkers() {
      if (!this.model || !this.vertexMarkers || this.cleanPreview || this.viewMode !== "edit" || this.activeTool === "bone") {
        if (this.vertexMarkers) {
          this.vertexMarkers.visible = false;
        }
        return;
      }
      this.model.updateMatrixWorld(true);
      const positions = [];
      const colors = [];
      const color = new THREE.Color();
      const baseVertexColor = new THREE.Color(0x79cfff);

      for (const record of this.paintRecords) {
        const position = record.geometry.attributes.position;
        for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          positions.push(this.tempWorld.x, this.tempWorld.y, this.tempWorld.z);

          const selected = record.selected.has(vertexIndex);
          const modified = record.modified.has(vertexIndex);
          if (selected && modified) {
            color.copy(SELECTED_MODIFIED_COLOR);
          } else if (selected) {
            color.copy(SELECTED_COLOR);
          } else if (modified) {
            color.copy(MODIFIED_COLOR);
          } else {
            color.copy(baseVertexColor);
          }
          colors.push(color.r, color.g, color.b);
        }
      }

      this.vertexGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      this.vertexGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      this.vertexGeometry.computeBoundingSphere();
      this.vertexMarkerCount = positions.length / 3;
    }
  });
}
