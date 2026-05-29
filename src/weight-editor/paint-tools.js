export function installPaintToolMethods(BirdWeightEditor, deps) {
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
    onPointerDown(event) {
      if (event.button !== 0 || this.activeTool === "orbit" || this.activeTool === "move") {
        return;
      }
      if (this.activeTool === "bone") {
        if (this.transformControls?.enabled && this.transformControls.object && (this.transformControls.axis || this.transformControls.dragging)) {
          event.preventDefault();
          event.stopPropagation?.();
          return;
        }
        event.preventDefault();
        event.stopPropagation?.();
        this.pickBoneFromEvent(event);
        return;
      }
      event.preventDefault();
      this.pushUndoState?.(this.activeTool === "neighbor" ? "Neighbor pen" : "Paint stroke");
      if (this.activeTool === "neighbor") {
        this.controls.enabled = false;
        this.painting = true;
        this.canvas.setPointerCapture?.(event.pointerId);
        const changed = this.beginNeighborStroke(event);
        if (changed > 0) {
          this.finishPaintChange(changed, "neighbor");
        }
        return;
      }
      this.painting = true;
      this.controls.enabled = false;
      this.canvas.setPointerCapture?.(event.pointerId);
      this.paintFromEvent(event);
    },

    onPointerMove(event) {
      if (!this.painting && this.activeTool === "neighbor") {
        this.updateNeighborHover(event);
        return;
      }
      if (!this.painting || this.activeTool === "orbit" || this.activeTool === "move" || this.activeTool === "bone") {
        return;
      }
      if (this.activeTool === "neighbor") {
        event.preventDefault();
        const changed = this.continueNeighborStroke(event);
        if (changed > 0) {
          this.finishPaintChange(changed, "neighbor");
        }
        return;
      }
      event.preventDefault();
      this.paintFromEvent(event);
    },

    onPointerUp() {
      if (!this.painting) {
        return;
      }
      this.painting = false;
      this.neighborStroke = null;
      this.controls.enabled = this.activeTool === "orbit" || this.activeTool === "bone";
    },

    nearestScreenVertex(event, options = {}) {
      if (!this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const maxDistance = options.maxDistance || Math.max(18, Number(this.brushRadius?.value || 0.035) * 720);
      const maxDistanceSq = maxDistance * maxDistance;
      let nearest = null;
      this.model.updateMatrixWorld(true);
      for (const record of this.paintRecords) {
        if (options.record && record !== options.record) {
          continue;
        }
        if (options.recordFilter && !options.recordFilter(record)) {
          continue;
        }
        const position = record.geometry.attributes.position;
        for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          if (options.vertexFilter && !options.vertexFilter(record, vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          const world = this.tempWorld.clone();
          this.tempWorld.project(this.camera);
          if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
            continue;
          }
          const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
          const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
          const dx = screenX - x;
          const dy = screenY - y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > maxDistanceSq || (nearest && distanceSq >= nearest.distanceSq)) {
            continue;
          }
          nearest = {
            record,
            vertexIndex,
            distanceSq,
            world
          };
        }
      }
      return nearest;
    },

    nearestSurfaceVertex(event, options = {}) {
      if (!this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();

      const records = this.paintRecords.filter((record) => {
        if (options.record && record !== options.record) {
          return false;
        }
        if (options.recordFilter && !options.recordFilter(record)) {
          return false;
        }
        return true;
      });
      const recordByObject = new Map(records.map((record) => [record.object, record]));
      const intersections = this.raycaster.intersectObjects(records.map((record) => record.object), false);
      for (const hit of intersections) {
        const record = recordByObject.get(hit.object);
        const face = hit.face;
        if (!record || !face) {
          continue;
        }
        let nearest = null;
        for (const vertexIndex of [face.a, face.b, face.c]) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          if (options.vertexFilter && !options.vertexFilter(record, vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          const distanceSq = this.tempWorld.distanceToSquared(hit.point);
          if (nearest && distanceSq >= nearest.distanceSq) {
            continue;
          }
          nearest = {
            record,
            vertexIndex,
            distanceSq,
            world: this.tempWorld.clone(),
            hit
          };
        }
        if (nearest) {
          return nearest;
        }
      }
      return null;
    },

    nearestNeighborVertex(event, options = {}) {
      return this.nearestSurfaceVertex(event, options)
        || this.nearestScreenVertex(event, options);
    },

    updateNeighborHover(event = null) {
      if (!this.neighborHoverMarker || !this.neighborHoverGeometry) {
        return;
      }
      if (!event || this.activeTool !== "neighbor" || this.cleanPreview) {
        this.neighborHoverMarker.visible = false;
        return;
      }
      const stroke = this.neighborStroke;
      const nearest = this.nearestNeighborVertex(event, {
        maxDistance: 26,
        record: stroke?.record,
        vertexFilter: stroke?.component
          ? (record, vertexIndex) => record === stroke.record && stroke.component.has(vertexIndex)
          : null
      });
      if (!nearest) {
        this.neighborHoverMarker.visible = false;
        return;
      }
      this.neighborHoverGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
        nearest.world.x,
        nearest.world.y,
        nearest.world.z
      ], 3));
      this.neighborHoverGeometry.computeBoundingSphere();
      this.neighborHoverMarker.visible = true;
    },

    connectedVertexComponent(record, seedVertexIndex) {
      const component = new Set();
      const queue = [seedVertexIndex];
      while (queue.length) {
        const vertexIndex = queue.shift();
        if (component.has(vertexIndex) || record.deleted?.has(vertexIndex)) {
          continue;
        }
        component.add(vertexIndex);
        for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
          if (!component.has(linkedIndex) && !record.deleted?.has(linkedIndex)) {
            queue.push(linkedIndex);
          }
        }
        for (const neighborIndex of record.vertexNeighbors?.[vertexIndex] || []) {
          if (!component.has(neighborIndex) && !record.deleted?.has(neighborIndex)) {
            queue.push(neighborIndex);
          }
        }
      }
      return component;
    },

    connectedVerticesWithinBrush(event, record, seedVertexIndex, options = {}) {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radius = Math.max(18, Number(this.brushRadius?.value || 0.035) * 720);
      const radiusSq = radius * radius;
      const position = record.geometry.attributes.position;
      const visible = new Set();
      const allowedVertices = options.allowedVertices || null;

      record.object.updateMatrixWorld(true);
      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
        if (record.deleted?.has(vertexIndex)) {
          continue;
        }
        if (allowedVertices && !allowedVertices.has(vertexIndex)) {
          continue;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);
        this.tempWorld.project(this.camera);
        if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
          continue;
        }
        const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
        const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
        const dx = screenX - x;
        const dy = screenY - y;
        if (dx * dx + dy * dy <= radiusSq) {
          visible.add(vertexIndex);
        }
      }

      if ((!allowedVertices || allowedVertices.has(seedVertexIndex)) && !visible.has(seedVertexIndex)) {
        visible.add(seedVertexIndex);
      }

      const result = new Set();
      const queue = [seedVertexIndex];
      while (queue.length) {
        const vertexIndex = queue.shift();
        if (result.has(vertexIndex) || !visible.has(vertexIndex) || record.deleted?.has(vertexIndex)) {
          continue;
        }
        result.add(vertexIndex);
        const linked = this.linkedSeamVertices(record, vertexIndex);
        for (const linkedIndex of linked) {
          if (!result.has(linkedIndex) && visible.has(linkedIndex) && !record.deleted?.has(linkedIndex)) {
            queue.push(linkedIndex);
          }
        }
        for (const neighborIndex of record.vertexNeighbors?.[vertexIndex] || []) {
          if (!result.has(neighborIndex) && visible.has(neighborIndex) && !record.deleted?.has(neighborIndex)) {
            queue.push(neighborIndex);
          }
        }
      }
      return result;
    },

    neighborStrokePaintVertices(record, vertices) {
      const expanded = new Set();
      for (const vertexIndex of vertices) {
        for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
          expanded.add(linkedIndex);
        }
        if (!this.mirrorMode) {
          continue;
        }
        const mirrorIndex = this.findMirroredVertex(record, vertexIndex);
        if (mirrorIndex < 0 || mirrorIndex === vertexIndex) {
          continue;
        }
        for (const linkedMirrorIndex of this.linkedSeamVertices(record, mirrorIndex)) {
          expanded.add(linkedMirrorIndex);
        }
      }
      return expanded;
    },

    neighborStrokeTouchesCandidate(record, vertices, stroke) {
      if (!stroke?.vertices?.size || stroke.record !== record) {
        return !stroke?.vertices?.size;
      }
      const touches = (vertexIndex) => stroke.vertices.has(vertexIndex);
      for (const vertexIndex of vertices) {
        if (touches(vertexIndex)) {
          return true;
        }
        for (const linkedIndex of this.linkedSeamVertices(record, vertexIndex)) {
          if (touches(linkedIndex)) {
            return true;
          }
        }
        for (const neighborIndex of record.vertexNeighbors?.[vertexIndex] || []) {
          if (touches(neighborIndex)) {
            return true;
          }
          for (const linkedNeighborIndex of this.linkedSeamVertices(record, neighborIndex)) {
            if (touches(linkedNeighborIndex)) {
              return true;
            }
          }
        }
      }
      return false;
    },

    beginNeighborStroke(event) {
      const nearest = this.nearestNeighborVertex(event);
      if (!nearest) {
        this.neighborStroke = null;
        this.setStatus("Neighbor pen needs a hovered vertex");
        return 0;
      }
      this.neighborStroke = {
        record: nearest.record,
        component: this.connectedVertexComponent(nearest.record, nearest.vertexIndex),
        vertices: new Set(),
        changed: 0
      };
      return this.paintConnectedNeighborPatch(event, "paint", { nearest, stroke: this.neighborStroke });
    },

    continueNeighborStroke(event) {
      if (!this.neighborStroke) {
        return this.beginNeighborStroke(event);
      }
      return this.paintConnectedNeighborPatch(event, "paint", { stroke: this.neighborStroke });
    },

    paintConnectedNeighborPatch(event, action = "paint", options = {}) {
      const stroke = options.stroke || null;
      const nearest = options.nearest || this.nearestNeighborVertex(event, {
        record: stroke?.record,
        vertexFilter: stroke?.component
          ? (record, vertexIndex) => record === stroke.record && stroke.component.has(vertexIndex)
          : null
      });
      if (!nearest) {
        this.setStatus("Neighbor pen needs a hovered vertex");
        return 0;
      }
      if (
        stroke?.vertices?.size
        && !this.neighborStrokeTouchesCandidate(nearest.record, new Set([nearest.vertexIndex]), stroke)
      ) {
        this.setStatus("Neighbor pen stayed on the first connected stroke");
        return 0;
      }
      const vertices = this.connectedVerticesWithinBrush(event, nearest.record, nearest.vertexIndex, {
        allowedVertices: stroke?.component || null
      });
      if (stroke?.vertices?.size && !this.neighborStrokeTouchesCandidate(nearest.record, vertices, stroke)) {
        this.setStatus("Neighbor pen stayed on the first connected stroke");
        return 0;
      }
      const strokeVertices = stroke ? this.neighborStrokePaintVertices(nearest.record, vertices) : null;
      let changed = 0;
      for (const vertexIndex of vertices) {
        changed += this.applyPaintActionWithMirror(nearest.record, vertexIndex, action);
      }
      if (stroke) {
        for (const vertexIndex of strokeVertices) {
          stroke.vertices.add(vertexIndex);
        }
        stroke.changed += changed;
      }
      if (changed === 0) {
        this.setStatus("Neighbor pen found no new connected vertices");
      }
      return changed;
    },

    paintFromEvent(event) {
      if (!this.model) {
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();

      if (this.activeTool === "deselect" || this.activeTool === "erase") {
        const screenSpaceChanged = this.paintScreenSpaceVertices(event, this.activeTool);
        if (screenSpaceChanged > 0) {
          this.finishPaintChange(screenSpaceChanged, this.activeTool);
          return;
        }
      }
      const shouldPaintThrough = this.activeTool === "paint"
        && this.throughSelectionToggle?.checked;
      if (shouldPaintThrough) {
        const throughChanged = this.paintScreenSpaceVertices(event, this.activeTool, { includeAllVertices: true });
        if (throughChanged > 0) {
          this.finishPaintChange(throughChanged, this.activeTool);
          return;
        }
      }

      const intersections = this.raycaster.intersectObjects(this.paintRecords.map((record) => record.object), false);
      if (!intersections.length) {
        return;
      }

      const hit = intersections[0];
      const record = this.paintRecords.find((item) => item.object === hit.object);
      if (!record) {
        return;
      }

      if (this.activeTool === "push" || this.activeTool === "pull") {
        const changed = this.sculptVerticesNear(record, hit, this.activeTool === "pull" ? 1 : -1);
        if (changed > 0) {
          record.geometry.attributes.position.needsUpdate = true;
          this.preserveImportedNormals(record);
          this.syncPatchJson();
          this.updateCounts();
          this.updateRecordColors(record);
          this.updateSelectionMarkers();
          this.updateMoveGizmo();
          this.setStatus(`${this.activeTool === "pull" ? "Pulled" : "Pushed"} ${changed} vertices`);
        }
        return;
      }

      const changed = this.paintVerticesNear(record, hit, this.activeTool);
      if (changed > 0) {
        this.finishPaintChange(changed, this.activeTool);
      }
    },

    refreshSkinnedRaycastBounds() {
      for (const record of this.paintRecords) {
        const object = record.object;
        if (!object?.isSkinnedMesh) {
          continue;
        }
        object.computeBoundingSphere?.();
        if (object.boundingBox) {
          object.computeBoundingBox?.();
        }
      }
    },

    finishPaintChange(changed, action) {
      if (action === "erase" && this.viewMode === "edit") {
        for (const record of this.paintRecords) {
          this.cleanupDeletedVertexSelection?.(record);
          this.applyDeletedVertices?.(record);
        }
      }
      for (const record of this.paintRecords) {
        this.updateRecordColors(record);
      }
      this.syncPatchJson();
      this.updateCounts();
      this.updateSelectionMarkers();
      if (this.viewMode === "edit") {
        this.updateAllVertexMarkers();
      }
      this.updateMoveGizmo();
      const actionLabels = {
        paint: "Selected",
        neighbor: "Neighbor selected",
        deselect: "Deselected",
        erase: this.viewMode === "edit" ? "Cleaned from mesh" : "Erased edits from"
      };
      this.setStatus(`${actionLabels[action] || "Changed"} ${changed} vertices`);
    },

    paintScreenSpaceVertices(event, action, options = {}) {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radius = Math.max(18, Number(this.brushRadius.value) * 720);
      const radiusSq = radius * radius;
      const fallbackRadiusSq = radiusSq * 3.1;
      let changed = 0;
      let nearest = null;

      this.model.updateMatrixWorld(true);
      for (const record of this.paintRecords) {
        const vertexSource = options.includeAllVertices
          ? null
          : action === "erase"
            ? new Set([...record.selected, ...record.modified])
            : record.selected;
        const vertexCount = record.geometry.attributes.position.count;
        const visitVertex = (vertexIndex) => {
          if (record.deleted?.has(vertexIndex)) {
            return;
          }
          this.tempVector.fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          this.tempWorld.project(this.camera);
          if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
            return;
          }

          const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
          const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
          const dx = screenX - x;
          const dy = screenY - y;
          const distanceSq = dx * dx + dy * dy;

          if (distanceSq <= radiusSq) {
            changed += this.applyPaintActionWithMirror(record, vertexIndex, action);
            return;
          }

          if (distanceSq <= fallbackRadiusSq && (!nearest || distanceSq < nearest.distanceSq)) {
            nearest = { record, vertexIndex, distanceSq };
          }
        };

        if (vertexSource === null) {
          for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
            visitVertex(vertexIndex);
          }
          continue;
        }

        for (const vertexIndex of vertexSource) {
          visitVertex(vertexIndex);
        }
      }

      if (changed === 0 && nearest) {
        changed = this.applyPaintActionWithMirror(nearest.record, nearest.vertexIndex, action);
      }

      return changed;
    },

    paintVerticesNear(record, hit, action) {
      const radius = Number(this.brushRadius.value);
      const radiusSq = radius * radius;
      const position = record.geometry.attributes.position;
      let changed = 0;

      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
        if (record.deleted?.has(vertexIndex)) {
          continue;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);
        if (this.tempWorld.distanceToSquared(hit.point) > radiusSq) {
          continue;
        }
        changed += this.applyPaintActionWithMirror(record, vertexIndex, action);
      }

      if (changed === 0 && hit.face) {
        for (const vertexIndex of [hit.face.a, hit.face.b, hit.face.c]) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          changed += this.applyPaintActionWithMirror(record, vertexIndex, action);
        }
      }

      return changed;
    },

    applyPaintAction(record, vertexIndex, action) {
      const hadSelected = record.selected.has(vertexIndex);
      const hadModified = record.modified.has(vertexIndex);

      if (action === "paint") {
        if (record.deleted?.has(vertexIndex)) {
          return false;
        }
        record.selected.add(vertexIndex);
        return !hadSelected;
      }
      if (action === "deselect") {
        record.selected.delete(vertexIndex);
        return hadSelected;
      }
      if (action === "erase") {
        if (this.viewMode === "edit") {
          return this.deleteVertex(record, vertexIndex);
        }
        record.selected.delete(vertexIndex);
        if (hadModified) {
          this.eraseVertex(record, vertexIndex);
        }
        return hadSelected || hadModified;
      }
      return false;
    },

    applyPaintActionWithMirror(record, vertexIndex, action) {
      const vertices = new Set(this.linkedSeamVertices(record, vertexIndex));
      if (this.mirrorMode) {
        const mirrorIndex = this.findMirroredVertex(record, vertexIndex);
        if (mirrorIndex >= 0 && mirrorIndex !== vertexIndex) {
          for (const linkedMirrorIndex of this.linkedSeamVertices(record, mirrorIndex)) {
            vertices.add(linkedMirrorIndex);
          }
        }
      }

      let changed = 0;
      for (const linkedIndex of vertices) {
        if (this.applyPaintAction(record, linkedIndex, action)) {
          changed += 1;
        }
      }
      return changed;
    },

    mirrorCurrentSelection() {
      let changed = 0;
      for (const record of this.paintRecords) {
        for (const vertexIndex of [...record.selected]) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          const mirrorIndex = this.findMirroredVertex(record, vertexIndex);
          if (mirrorIndex < 0) {
            continue;
          }
          for (const linkedMirrorIndex of this.linkedSeamVertices(record, mirrorIndex)) {
            if (!record.selected.has(linkedMirrorIndex)) {
              record.selected.add(linkedMirrorIndex);
              changed += 1;
            }
          }
        }
        this.updateRecordColors(record);
      }
      if (changed > 0) {
        this.updateSelectionMarkers();
        this.updateMoveGizmo();
        this.updateCounts();
      }
      return changed;
    },

    sculptVerticesNear(record, hit, direction) {
      const radius = Number(this.brushRadius.value);
      const strength = Number(this.sculptStrength.value) * direction;
      const radiusSq = radius * radius;
      const position = record.geometry.attributes.position;
      const normal = record.geometry.attributes.normal;
      this.tempNormalMatrix.getNormalMatrix(record.object.matrixWorld);
      let changed = 0;

      for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
        if (record.deleted?.has(vertexIndex)) {
          continue;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);

        const distanceSq = this.tempWorld.distanceToSquared(hit.point);
        if (distanceSq > radiusSq) {
          continue;
        }

        const falloff = 1 - Math.sqrt(distanceSq) / radius;
        this.tempWorldNormal.fromBufferAttribute(normal, vertexIndex).applyMatrix3(this.tempNormalMatrix).normalize();
        this.tempWorldDelta.copy(this.tempWorldNormal).multiplyScalar(strength * falloff);
        this.moveVertexByWorldDelta(record, vertexIndex, this.tempWorldDelta);
        record.modified.add(vertexIndex);
        record.sculpted.add(vertexIndex);
        changed += 1;
      }

      return changed;
    },

    eraseVertex(record, vertexIndex) {
      record.selected.delete(vertexIndex);
      if (record.deleted?.has(vertexIndex)) {
        return;
      }
      if (record.modified.has(vertexIndex)) {
        this.restoreOriginalVertexWeights(record, vertexIndex);
        record.modified.delete(vertexIndex);
        record.sculpted.delete(vertexIndex);
      }
    },

    clearSelection() {
      for (const record of this.paintRecords) {
        record.selected.clear();
        this.updateRecordColors(record);
      }
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.setStatus("Selection cleared");
    },

    invertSelection() {
      for (const record of this.paintRecords) {
        const next = new Set();
        const vertexCount = record.geometry.attributes.position.count;
        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          if (!record.selected.has(vertexIndex)) {
            next.add(vertexIndex);
          }
        }
        record.selected = next;
        this.updateRecordColors(record);
      }
      this.updateSelectionMarkers();
      this.updateMoveGizmo();
      this.updateCounts();
      this.setStatus("Selection inverted");
    },

    linkedSeamVertices(record, vertexIndex) {
      return record.seamVertexMap?.get(vertexIndex) || [vertexIndex];
    },

    vertexSideSign(record, vertexIndex) {
      const x = record.originalPosition[vertexIndex * 3] - record.mirrorCenterX;
      if (Math.abs(x) < 0.0001) {
        return 0;
      }
      return Math.sign(x);
    },

    boneSideSignForRecord(record, boneName) {
      const mirrorName = this.mirrorBoneName(boneName);
      const bone = this.bones.get(boneName);
      const mirrorBone = this.bones.get(mirrorName);
      if (!bone || !mirrorBone) {
        return 0;
      }
      bone.getWorldPosition(this.tempWorld);
      record.object.worldToLocal(this.tempLocalA.copy(this.tempWorld));
      mirrorBone.getWorldPosition(this.tempWorld);
      record.object.worldToLocal(this.tempLocalB.copy(this.tempWorld));
      const x = this.tempLocalA.x - this.tempLocalB.x;
      if (Math.abs(x) < 0.0001) {
        return 0;
      }
      return Math.sign(x);
    },

    findMirroredVertex(record, vertexIndex) {
      if (record.mirrorVertexCache.has(vertexIndex)) {
        return record.mirrorVertexCache.get(vertexIndex);
      }

      const sourceOffset = vertexIndex * 3;
      const targetX = record.mirrorCenterX * 2 - record.originalPosition[sourceOffset];
      const targetY = record.originalPosition[sourceOffset + 1];
      const targetZ = record.originalPosition[sourceOffset + 2];
      const sourceSide = this.vertexSideSign(record, vertexIndex);
      const position = record.originalPosition;
      const vertexCount = record.geometry.attributes.position.count;
      let bestIndex = -1;
      let bestDistanceSq = Infinity;

      for (let index = 0; index < vertexCount; index += 1) {
        if (index === vertexIndex) {
          continue;
        }
        const side = this.vertexSideSign(record, index);
        if (sourceSide && side === sourceSide) {
          continue;
        }
        const offset = index * 3;
        const dx = position[offset] - targetX;
        const dy = position[offset + 1] - targetY;
        const dz = position[offset + 2] - targetZ;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestIndex = index;
        }
      }

      record.mirrorVertexCache.set(vertexIndex, bestIndex);
      return bestIndex;
    }
  });
}
