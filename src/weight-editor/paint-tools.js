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
      this.lastCanvasPointerPaintAt = typeof performance !== "undefined" ? performance.now() : Date.now();
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
      if (this.activeTool === "eyedropper") {
        this.painting = true;
        this.controls.enabled = false;
        this.canvas.setPointerCapture?.(event.pointerId);
        this.pickTextureColorFromEvent(event);
        return;
      }
      if (this.activeTool === "airbrush" || this.activeTool === "clone") {
        this.updateTextureBrushCursor?.(event);
      } else if (this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.updateSelectionBrushCursor?.(event);
      }
      const undoLabel = this.activeTool === "neighbor"
        ? "Neighbor pen"
        : this.activeTool === "clone"
          ? "Clone paint"
          : this.activeTool === "airbrush"
            ? "Texture airbrush"
            : this.activeTool === "lasso"
              ? "Lasso selection"
          : "Paint stroke";
      if (this.usesSelectionStrokeUndo?.(this.activeTool)) {
        this.beginSelectionStrokeUndo?.(undoLabel);
      } else if (this.usesTextureStrokeUndo?.(this.activeTool)) {
        this.beginTexturePaintStrokeUndo?.(undoLabel);
      } else {
        this.pushUndoState?.(undoLabel);
      }
      if (this.activeTool === "lasso") {
        this.controls.enabled = false;
        this.painting = true;
        this.canvas.setPointerCapture?.(event.pointerId);
        this.beginLassoStroke(event);
        return;
      }
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

    onCanvasClick(event) {
      if (this.activeTool !== "airbrush" && this.activeTool !== "clone") {
        return;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (this.texturePaintSuppressClickUntil && now < this.texturePaintSuppressClickUntil) {
        event.preventDefault();
        return;
      }
      if (this.lastCanvasPointerPaintAt && now - this.lastCanvasPointerPaintAt < 180) {
        return;
      }
      event.preventDefault();
      this.lastCanvasPointerPaintAt = now;
      const undoLabel = this.activeTool === "clone" ? "Clone paint" : "Texture airbrush";
      if (this.usesTextureStrokeUndo?.(this.activeTool)) {
        this.beginTexturePaintStrokeUndo?.(undoLabel);
      } else {
        this.pushUndoState?.(undoLabel);
      }
      this.updateTextureBrushCursor?.(event);
      this.paintFromEvent(event);
      this.endTexturePaintStrokeUndo?.();
    },

    onPointerMove(event) {
      if (!this.painting && this.activeTool === "neighbor") {
        this.updateNeighborHover(event);
        return;
      }
      if (!this.painting && (this.activeTool === "airbrush" || this.activeTool === "clone")) {
        this.updateTextureBrushCursor?.(event);
        return;
      }
      if (!this.painting && this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.updateSelectionBrushCursor?.(event);
        return;
      }
      if (this.activeTool === "eyedropper") {
        if (!this.painting) {
          return;
        }
        event.preventDefault();
        this.pickTextureColorFromEvent(event);
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
      if (this.activeTool === "lasso") {
        event.preventDefault();
        this.continueLassoStroke(event);
        return;
      }
      event.preventDefault();
      if (this.activeTool === "airbrush" || this.activeTool === "clone") {
        this.updateTextureBrushCursor?.(event);
      } else if (this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.updateSelectionBrushCursor?.(event);
      }
      this.paintFromEvent(event);
    },

    onPointerUp() {
      if (!this.painting) {
        return;
      }
      if (this.activeTool === "eyedropper") {
        this.painting = false;
        this.controls.enabled = this.activeTool === "orbit" || this.activeTool === "bone";
        return;
      }
      if (this.activeTool === "lasso") {
        const changed = this.finishLassoStroke();
        if (changed > 0) {
          this.finishPaintChange(changed, "lasso");
        } else {
          this.endSelectionStrokeUndo?.();
        }
        this.painting = false;
        this.controls.enabled = this.activeTool === "orbit" || this.activeTool === "bone";
        return;
      }
      this.painting = false;
      this.neighborStroke = null;
      if (this.activeTool === "airbrush" || this.activeTool === "clone") {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.texturePaintSuppressClickUntil = now + 700;
        this.hideTextureBrushCursor?.();
      }
      this.controls.enabled = this.activeTool === "orbit" || this.activeTool === "bone";
      this.endSelectionStrokeUndo?.();
      this.endTexturePaintStrokeUndo?.();
    },

    usesSelectionStrokeUndo(action) {
      return action === "paint" || action === "deselect" || action === "neighbor" || action === "lasso";
    },

    usesTextureStrokeUndo(action) {
      return action === "airbrush" || action === "clone";
    },

    captureSelectionSnapshot() {
      return (this.paintRecords || []).map((record) => [...record.selected]);
    },

    selectionSnapshotsMatch(before = [], after = []) {
      if (before.length !== after.length) {
        return false;
      }
      for (let index = 0; index < before.length; index += 1) {
        const left = before[index] || [];
        const right = after[index] || [];
        if (left.length !== right.length) {
          return false;
        }
        const rightSet = new Set(right);
        for (const value of left) {
          if (!rightSet.has(value)) {
            return false;
          }
        }
      }
      return true;
    },

    pushSelectionUndoState(label, before, after) {
      if (this.selectionSnapshotsMatch(before, after)) {
        return false;
      }
      this.undoStack.push({
        kind: "selection",
        label,
        before,
        after
      });
      if (this.undoStack.length > this.maxUndoSteps) {
        this.disposeFastHistoryState?.(this.undoStack.shift());
      }
      this.redoStack = [];
      this.updateUndoButton?.();
      return true;
    },

    beginSelectionStrokeUndo(label = "Paint stroke") {
      this.selectionStrokeUndo = {
        label,
        before: this.captureSelectionSnapshot(),
        changed: false
      };
      return true;
    },

    markSelectionStrokeChanged(action) {
      if (!this.selectionStrokeUndo || !this.usesSelectionStrokeUndo(action)) {
        return false;
      }
      this.selectionStrokeUndo.changed = true;
      return true;
    },

    endSelectionStrokeUndo() {
      const stroke = this.selectionStrokeUndo;
      this.selectionStrokeUndo = null;
      if (!stroke?.changed) {
        return false;
      }
      return this.pushSelectionUndoState(stroke.label, stroke.before, this.captureSelectionSnapshot());
    },

    restoreSelectionSnapshot(snapshot = []) {
      snapshot.forEach((selected, index) => {
        const record = this.paintRecords?.[index];
        if (!record) {
          return;
        }
        record.selected = new Set((selected || []).filter((vertexIndex) => (
          Number.isInteger(vertexIndex)
          && vertexIndex < record.geometry.attributes.position.count
          && !record.deleted?.has(vertexIndex)
        )));
        this.updateRecordColors(record);
      });
      this.updateSelectionMarkers();
      if (this.viewMode === "edit") {
        this.updateAllVertexMarkers();
      }
      this.updateMoveGizmo();
      this.updateCounts();
      this.syncClonePaintControls?.();
      return true;
    },

    withSelectionUndo(label, callback) {
      const before = this.captureSelectionSnapshot();
      const result = callback?.();
      this.pushSelectionUndoState(label, before, this.captureSelectionSnapshot());
      return result;
    },

    texturePaintUndoEntryKey(type, record, materialIndex, material, targetEntry = null) {
      return [
        type,
        this.paintRecords?.indexOf?.(record) ?? -1,
        materialIndex ?? 0,
        material?.uuid || material?.id || "material",
        targetEntry?.target?.uuid || targetEntry?.target?.texture?.uuid || ""
      ].join(":");
    },

    copyTextureToRenderTarget(sourceTexture, destinationTarget) {
      if (!this.renderer || !sourceTexture || !destinationTarget) {
        return false;
      }
      if (this.textureAirbrushCopyTextureToTarget) {
        return this.textureAirbrushCopyTextureToTarget(sourceTexture, destinationTarget);
      }
      this.textureAirbrushEnsureCopyScene?.();
      if (!this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera || !this.textureAirbrushGpuCopyMesh) {
        return false;
      }
      this.textureAirbrushCopyTextureRenderSettings?.(destinationTarget.texture, sourceTexture);
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      this.textureAirbrushGpuCopyMesh.material = this.textureAirbrushCopyMaterial?.(sourceTexture) || this.textureAirbrushGpuCopyMesh.material;
      this.renderer.setRenderTarget(destinationTarget);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      return true;
    },

    cloneTextureRenderTargetSnapshot(targetEntry) {
      if (!targetEntry?.target?.texture || !this.renderer || !THREE.WebGLRenderTarget) {
        return null;
      }
      const sourceTexture = targetEntry.target.texture;
      const settings = this.textureAirbrushRenderTextureSettings?.(sourceTexture) || {
        minFilter: sourceTexture.minFilter || THREE.LinearFilter,
        magFilter: sourceTexture.magFilter || THREE.LinearFilter,
        wrapS: sourceTexture.wrapS || THREE.ClampToEdgeWrapping,
        wrapT: sourceTexture.wrapT || THREE.ClampToEdgeWrapping,
        generateMipmaps: false
      };
      const snapshot = new THREE.WebGLRenderTarget(targetEntry.width || targetEntry.target.width, targetEntry.height || targetEntry.target.height, {
        minFilter: settings.minFilter,
        magFilter: settings.magFilter,
        wrapS: settings.wrapS,
        wrapT: settings.wrapT,
        depthBuffer: false,
        stencilBuffer: false
      });
      if (!this.textureAirbrushCopyTextureRenderSettings?.(snapshot.texture, sourceTexture)) {
        snapshot.texture.colorSpace = sourceTexture.colorSpace;
        snapshot.texture.flipY = sourceTexture.flipY;
        snapshot.texture.generateMipmaps = settings.generateMipmaps;
      }
      if (!this.copyTextureToRenderTarget(sourceTexture, snapshot)) {
        snapshot.dispose?.();
        return null;
      }
      return snapshot;
    },

    beginTexturePaintStrokeUndo(label = "Texture paint") {
      this.texturePaintStrokeUndo = {
        label,
        before: [],
        touched: new Map(),
        changed: false
      };
      return true;
    },

    markTexturePaintStrokeChanged() {
      if (!this.texturePaintStrokeUndo) {
        return false;
      }
      this.texturePaintStrokeUndo.changed = true;
      return true;
    },

    captureTexturePaintCanvasUndoTarget(record, material, editable, materialIndex = 0) {
      const stroke = this.texturePaintStrokeUndo;
      const canvas = editable?.canvas;
      const context = editable?.context;
      if (!stroke || !canvas || !context) {
        return false;
      }
      const key = this.texturePaintUndoEntryKey("canvas", record, materialIndex, material);
      if (stroke.touched.has(key)) {
        return true;
      }
      const entry = {
        type: "canvas",
        key,
        record,
        material,
        materialIndex,
        canvas,
        context,
        texture: editable.texture,
        before: context.getImageData(0, 0, canvas.width, canvas.height),
        after: null
      };
      stroke.touched.set(key, entry);
      stroke.before.push(entry);
      return true;
    },

    captureTexturePaintGpuUndoTarget(record, material, targetEntry, materialIndex = 0) {
      const stroke = this.texturePaintStrokeUndo;
      if (!stroke || !targetEntry?.target?.texture) {
        return false;
      }
      const key = this.texturePaintUndoEntryKey("gpu", record, materialIndex, material, targetEntry);
      if (stroke.touched.has(key)) {
        return true;
      }
      const snapshot = this.cloneTextureRenderTargetSnapshot(targetEntry);
      if (!snapshot) {
        return false;
      }
      const entry = {
        type: "gpu",
        key,
        record,
        material,
        materialIndex,
        targetEntry,
        before: snapshot,
        after: null
      };
      stroke.touched.set(key, entry);
      stroke.before.push(entry);
      return true;
    },

    finalizeTexturePaintUndoEntry(entry) {
      if (entry.type === "canvas") {
        entry.after = entry.context.getImageData(0, 0, entry.canvas.width, entry.canvas.height);
        return true;
      }
      if (entry.type === "gpu") {
        entry.after = this.cloneTextureRenderTargetSnapshot(entry.targetEntry);
        return Boolean(entry.after);
      }
      return false;
    },

    disposeTexturePaintSnapshotEntry(entry) {
      entry?.before?.dispose?.();
      entry?.after?.dispose?.();
    },

    endTexturePaintStrokeUndo() {
      const stroke = this.texturePaintStrokeUndo;
      this.texturePaintStrokeUndo = null;
      if (!stroke?.changed || !stroke.before.length) {
        for (const entry of stroke?.before || []) {
          this.disposeTexturePaintSnapshotEntry(entry);
        }
        return false;
      }
      const entries = stroke.before.filter((entry) => this.finalizeTexturePaintUndoEntry(entry));
      if (!entries.length) {
        for (const entry of stroke.before) {
          this.disposeTexturePaintSnapshotEntry(entry);
        }
        return false;
      }
      this.undoStack.push({
        kind: "texture-paint",
        label: stroke.label,
        entries
      });
      if (this.undoStack.length > this.maxUndoSteps) {
        this.disposeFastHistoryState?.(this.undoStack.shift());
      }
      for (const state of this.redoStack || []) {
        this.disposeFastHistoryState?.(state);
      }
      this.redoStack = [];
      this.updateUndoButton?.();
      return true;
    },

    restoreTexturePaintSnapshot(entries = [], field = "before") {
      for (const entry of entries) {
        if (entry.type === "canvas") {
          const image = entry[field];
          if (!entry.context || !entry.canvas || !image) {
            continue;
          }
          entry.context.putImageData(image, 0, 0);
          if (entry.texture) {
            entry.texture.needsUpdate = true;
          }
          if (entry.material) {
            entry.material.needsUpdate = true;
          }
          this.refreshCloneSpotlightTextures?.(entry.record);
          continue;
        }
        if (entry.type === "gpu") {
          const snapshot = entry[field];
          if (!snapshot?.texture || !entry.targetEntry?.target) {
            continue;
          }
          this.copyTextureToRenderTarget(snapshot.texture, entry.targetEntry.target);
          if (entry.material) {
            entry.material.needsUpdate = true;
          }
        }
      }
      this.updateClonePaintPreviews?.();
      this.syncPatchJson?.();
      this.updateUndoButton?.();
      return true;
    },

    canvasPointFromEvent(event) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    },

    beginLassoStroke(event) {
      const point = this.canvasPointFromEvent(event);
      this.lassoStroke = {
        points: [point],
        minDistanceSq: 16
      };
      this.updateLassoOverlay();
      this.setStatus("Draw lasso selection");
    },

    continueLassoStroke(event) {
      if (!this.lassoStroke) {
        this.beginLassoStroke(event);
        return;
      }
      const point = this.canvasPointFromEvent(event);
      const previous = this.lassoStroke.points[this.lassoStroke.points.length - 1];
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      if (dx * dx + dy * dy < this.lassoStroke.minDistanceSq) {
        return;
      }
      this.lassoStroke.points.push(point);
      this.updateLassoOverlay();
    },

    updateLassoOverlay() {
      if (!this.lassoOverlay || !this.lassoOverlayPath || !this.lassoStroke?.points?.length) {
        return;
      }
      const points = this.lassoStroke.points;
      this.lassoOverlay.hidden = false;
      this.lassoOverlayPath.setAttribute("d", points
        .map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
        .join(" "));
    },

    hideLassoOverlay() {
      if (this.lassoOverlay) {
        this.lassoOverlay.hidden = true;
      }
      if (this.lassoOverlayPath) {
        this.lassoOverlayPath.setAttribute("d", "");
      }
    },

    pointInPolygon(point, polygon) {
      let inside = false;
      for (let index = 0, last = polygon.length - 1; index < polygon.length; last = index, index += 1) {
        const a = polygon[index];
        const b = polygon[last];
        const crosses = ((a.y > point.y) !== (b.y > point.y))
          && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 0.000001) + a.x;
        if (crosses) {
          inside = !inside;
        }
      }
      return inside;
    },

    finishLassoStroke() {
      const stroke = this.lassoStroke;
      this.lassoStroke = null;
      this.hideLassoOverlay();
      if (!stroke?.points || stroke.points.length < 3 || !this.model) {
        this.setStatus("Lasso needs a larger area");
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      const includeAllDepth = Boolean(this.throughSelectionToggle?.checked);
      const projected = [];
      this.model.updateMatrixWorld(true);

      for (const record of this.paintRecords || []) {
        const position = record.geometry.attributes.position;
        for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
          if (record.deleted?.has(vertexIndex)) {
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
          const point = {
            x: (this.tempWorld.x * 0.5 + 0.5) * rect.width,
            y: (-this.tempWorld.y * 0.5 + 0.5) * rect.height,
            z: this.tempWorld.z
          };
          if (!this.pointInPolygon(point, stroke.points)) {
            continue;
          }
          projected.push({ record, vertexIndex, point });
        }
      }

      if (!projected.length) {
        this.setStatus("Lasso found no vertices");
        return 0;
      }
      const nearestZ = Math.min(...projected.map((item) => item.point.z));
      const depthWindow = includeAllDepth ? Infinity : Math.max(0.08, Number(this.brushRadius?.value || 0.035) * 3.4);
      let changed = 0;
      for (const item of projected) {
        if (!includeAllDepth && item.point.z > nearestZ + depthWindow) {
          continue;
        }
        changed += this.applyPaintActionWithMirror(item.record, item.vertexIndex, "paint");
      }
      return changed;
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
      const screenMaxDistance = options.screenMaxDistance
        || options.maxDistance
        || Math.max(24, Number(this.brushRadius?.value || 0.035) * 720);
      const screenNearest = this.nearestScreenVertex(event, {
        ...options,
        maxDistance: screenMaxDistance
      });
      if (screenNearest && options.preferScreen !== false) {
        return screenNearest;
      }
      const surfaceNearest = this.nearestSurfaceVertex(event, options);
      if (surfaceNearest) {
        const snapDistance = options.screenSnapDistance || 14;
        if (screenNearest && screenNearest.distanceSq <= snapDistance * snapDistance) {
          return screenNearest;
        }
        return surfaceNearest;
      }
      return screenNearest;
    },

    neighborLayerSeeds(event, options = {}) {
      if (!this.model) {
        return [];
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
      if (!intersections.length) {
        return [];
      }

      const brushRadius = Number(this.brushRadius?.value || 0.035);
      const maxDepth = Math.max(0.025, brushRadius * (options.layerDepthMultiplier || 4.5));
      const firstDistance = intersections[0].distance;
      const seeds = [];
      const seen = new Set();

      for (const hit of intersections) {
        if (hit.distance > firstDistance + maxDepth) {
          break;
        }
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
        if (!nearest) {
          continue;
        }
        const key = `${this.paintRecords.indexOf(nearest.record)}:${nearest.vertexIndex}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        seeds.push(nearest);
      }
      return seeds;
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

    topologyExpandedVertices(record, seeds = [], maxDepth = 2) {
      const expanded = new Set();
      const queue = [];
      for (const seed of seeds) {
        if (!Number.isInteger(seed) || record.deleted?.has(seed)) {
          continue;
        }
        expanded.add(seed);
        queue.push({ vertexIndex: seed, depth: 0 });
      }
      while (queue.length) {
        const { vertexIndex, depth } = queue.shift();
        if (depth >= maxDepth) {
          continue;
        }
        const candidates = [
          ...this.linkedSeamVertices(record, vertexIndex),
          ...(record.vertexNeighbors?.[vertexIndex] || [])
        ];
        for (const candidateIndex of candidates) {
          if (expanded.has(candidateIndex) || record.deleted?.has(candidateIndex)) {
            continue;
          }
          expanded.add(candidateIndex);
          queue.push({ vertexIndex: candidateIndex, depth: depth + 1 });
        }
      }
      return expanded;
    },

    selectedNeighborAnchorMap(maxDepth = 3) {
      const anchorsByRecord = new Map();
      for (const record of this.paintRecords || []) {
        if (!record.selected?.size) {
          continue;
        }
        anchorsByRecord.set(record, this.topologyExpandedVertices(record, record.selected, maxDepth));
      }
      return anchorsByRecord;
    },

    neighborStrokeAnchorVertices(stroke) {
      if (!stroke) {
        return new Set();
      }
      return new Set([
        ...(stroke.anchorVertices || []),
        ...(stroke.vertices || [])
      ]);
    },

    nearestAnchoredNeighborVertex(event, stroke) {
      const anchors = this.neighborStrokeAnchorVertices(stroke);
      if (!stroke?.record || !anchors.size) {
        return null;
      }
      const anchorNeighborhood = this.topologyExpandedVertices(stroke.record, anchors, 3);
      return this.nearestNeighborVertex(event, {
        record: stroke.record,
        maxDistance: Math.max(34, Number(this.brushRadius?.value || 0.035) * 900),
        vertexFilter: (record, vertexIndex) => (
          record === stroke.record
          && (!stroke.component || stroke.component.has(vertexIndex))
          && anchorNeighborhood.has(vertexIndex)
        )
      });
    },

    connectedVerticesWithinBrush(event, record, seedVertexIndex, options = {}) {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radius = Math.max(18, Number(this.brushRadius?.value || 0.035) * 720);
      const radiusSq = radius * radius;
      const worldCenter = options.worldCenter || null;
      const worldRadius = Math.max(0.006, Number(this.brushRadius?.value || 0.035) * (options.worldRadiusMultiplier || 2.25));
      const worldRadiusSq = worldRadius * worldRadius;
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
        const insideWorldBrush = Boolean(worldCenter) && this.tempWorld.distanceToSquared(worldCenter) <= worldRadiusSq;
        this.tempWorld.project(this.camera);
        if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
          if (insideWorldBrush) {
            visible.add(vertexIndex);
          }
          continue;
        }
        const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
        const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
        const dx = screenX - x;
        const dy = screenY - y;
        if (dx * dx + dy * dy <= radiusSq || insideWorldBrush) {
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

    expandNeighborHiddenVertices(event, record, vertices, options = {}) {
      if (!vertices?.size) {
        return vertices;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const radius = Math.max(18, Number(this.brushRadius?.value || 0.035) * 720);
      const radiusSq = radius * radius;
      const neighborRadiusSq = radiusSq * 1.18;
      const allowedVertices = options.allowedVertices || null;
      const maxDepth = Math.max(1, Math.floor(Number(options.maxDepth) || 1));
      const expanded = new Set(vertices);
      const queue = [...vertices].map((vertexIndex) => ({ vertexIndex, depth: 0 }));
      const queued = new Set(vertices);
      const position = record.geometry.attributes.position;

      const candidateIsLocal = (vertexIndex) => {
        if (record.deleted?.has(vertexIndex)) {
          return false;
        }
        if (allowedVertices && !allowedVertices.has(vertexIndex)) {
          return false;
        }
        this.tempVector.fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
        this.tempWorld.copy(this.tempVector);
        record.object.localToWorld(this.tempWorld);
        this.tempWorld.project(this.camera);
        if (this.tempWorld.z < -1 || this.tempWorld.z > 1) {
          return false;
        }
        const screenX = (this.tempWorld.x * 0.5 + 0.5) * rect.width;
        const screenY = (-this.tempWorld.y * 0.5 + 0.5) * rect.height;
        const dx = screenX - x;
        const dy = screenY - y;
        return dx * dx + dy * dy <= neighborRadiusSq;
      };

      while (queue.length) {
        const { vertexIndex, depth } = queue.shift();
        if (depth >= maxDepth) {
          continue;
        }
        const candidates = [
          ...this.linkedSeamVertices(record, vertexIndex),
          ...(record.vertexNeighbors?.[vertexIndex] || [])
        ];
        for (const candidateIndex of candidates) {
          if (queued.has(candidateIndex) || !candidateIsLocal(candidateIndex)) {
            continue;
          }
          queued.add(candidateIndex);
          expanded.add(candidateIndex);
          queue.push({ vertexIndex: candidateIndex, depth: depth + 1 });
        }
      }
      return expanded;
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
      const anchors = this.neighborStrokeAnchorVertices(stroke);
      if (!anchors.size || stroke?.record !== record) {
        return !anchors.size;
      }
      const touches = (vertexIndex) => anchors.has(vertexIndex);
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
      const nearest = this.nearestNeighborVertex(event, {
        maxDistance: Math.max(30, Number(this.brushRadius?.value || 0.035) * 820),
        preferScreen: true
      });
      if (!nearest) {
        this.neighborStroke = null;
        this.setStatus("Neighbor pen needs a hovered vertex");
        return 0;
      }
      this.neighborStroke = {
        record: nearest.record,
        component: this.connectedVertexComponent(nearest.record, nearest.vertexIndex),
        anchorVertices: new Set(),
        vertices: new Set(),
        changed: 0
      };
      return this.paintConnectedNeighborPatch(event, "paint", {
        nearest,
        stroke: this.neighborStroke,
        layered: true
      });
    },

    continueNeighborStroke(event) {
      if (!this.neighborStroke) {
        return this.beginNeighborStroke(event);
      }
      return this.paintConnectedNeighborPatch(event, "paint", { stroke: this.neighborStroke });
    },

    paintConnectedNeighborPatch(event, action = "paint", options = {}) {
      const stroke = options.stroke || null;
      const anchorCount = this.neighborStrokeAnchorVertices(stroke).size;
      let nearest = options.nearest || this.nearestNeighborVertex(event, {
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
        anchorCount
        && !this.neighborStrokeTouchesCandidate(nearest.record, new Set([nearest.vertexIndex]), stroke)
      ) {
        nearest = this.nearestAnchoredNeighborVertex(event, stroke);
        if (!nearest) {
          this.setStatus("Neighbor pen stayed on the first connected stroke");
          return 0;
        }
      }
      const layeredSeeds = options.layered && !anchorCount
        ? this.neighborLayerSeeds(event, {
          record: stroke?.record || nearest.record,
          vertexFilter: stroke?.component
            ? (record, vertexIndex) => record === stroke.record && stroke.component.has(vertexIndex)
            : null
        })
        : [];
      const seeds = [nearest];
      const seenSeeds = new Set([`${this.paintRecords.indexOf(nearest.record)}:${nearest.vertexIndex}`]);
      for (const seed of layeredSeeds) {
        const key = `${this.paintRecords.indexOf(seed.record)}:${seed.vertexIndex}`;
        if (seenSeeds.has(key)) {
          continue;
        }
        seenSeeds.add(key);
        seeds.push(seed);
      }
      let changed = 0;
      let touchedStroke = false;

      for (const seed of seeds) {
        const vertices = this.connectedVerticesWithinBrush(event, seed.record, seed.vertexIndex, {
          allowedVertices: stroke?.component || null,
          worldCenter: seed.hit?.point || seed.world || null,
          worldRadiusMultiplier: 2.25
        });
        const expandedVertices = this.expandNeighborHiddenVertices(event, seed.record, vertices, {
          allowedVertices: stroke?.component || null,
          maxDepth: 1
        });
        expandedVertices.add(seed.vertexIndex);
        if (anchorCount && !this.neighborStrokeTouchesCandidate(seed.record, expandedVertices, stroke)) {
          continue;
        }
        touchedStroke = true;
        const strokeVertices = stroke ? this.neighborStrokePaintVertices(seed.record, expandedVertices) : null;
        for (const vertexIndex of expandedVertices) {
          changed += this.applyPaintActionWithMirror(seed.record, vertexIndex, action);
        }
        if (stroke) {
          for (const vertexIndex of strokeVertices) {
            stroke.vertices.add(vertexIndex);
          }
        }
      }
      if (stroke) {
        stroke.changed += changed;
      }
      if (anchorCount && !touchedStroke) {
        this.setStatus("Neighbor pen stayed on the first connected stroke");
        return 0;
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

      const textureHit = this.activeTool === "airbrush" || this.activeTool === "clone"
        ? this.texturePaintHitForEvent?.(event, this.activeTool)
        : null;
      if (this.activeTool === "airbrush") {
        const projectedChanged = this.textureAirbrushProjectedMeshFromEvent?.(event, { gpu: true }) || 0;
        if (!projectedChanged) {
          this.setStatus("Airbrush needs the cursor over textured mesh");
        }
        return;
      }

      const paintObjects = this.paintRecords.map((record) => record.object);
      const intersections = textureHit
        ? []
        : this.raycaster.intersectObjects(paintObjects, false);
      if (!intersections.length && !textureHit) {
        return;
      }

      if (this.activeTool === "clone") {
        const cloneHit = textureHit || this.clonePaintHitFromIntersections?.(intersections);
        if (!cloneHit) {
          this.setStatus("Capture a clone sample, then brush over textured mesh");
          return;
        }
        this.clonePaintVerticesNear?.(cloneHit.record, cloneHit.hit, event);
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

    pickTextureColorFromEvent(event) {
      if (!this.model) {
        return false;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();
      const textureHit = this.texturePaintHitForEvent?.(event, "eyedropper");
      if (!textureHit) {
        this.setStatus("Pick needs the cursor over textured mesh");
        return false;
      }
      return this.pickTextureColorNear?.(textureHit.record, textureHit.hit) || false;
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
      this.markSelectionStrokeChanged?.(action);
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
      const refinedRegionCount = this.refreshClonePaintTargetFromSelection?.({ status: false }) || 0;
      const actionLabels = {
        paint: "Selected",
        neighbor: "Neighbor selected",
        deselect: "Deselected",
        erase: this.viewMode === "edit" ? "Cleaned from mesh" : "Erased edits from"
      };
      const regionSuffix = refinedRegionCount > 0
        ? `; Region now ${refinedRegionCount} ${refinedRegionCount === 1 ? "vertex" : "vertices"}`
        : refinedRegionCount < 0
          ? "; Region cleared"
          : "";
      this.setStatus(`${actionLabels[action] || "Changed"} ${changed} vertices${regionSuffix}`);
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
