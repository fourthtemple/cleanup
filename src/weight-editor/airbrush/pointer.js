const SELECTION_BRUSH_TOOLS = new Set(["paint", "deselect", "erase", "push", "pull"]);
const BRUSH_CURSOR_POSITION_QUANTUM = 0.25;

function quantizedCursorPosition(value = 0) {
  return Math.round(value / BRUSH_CURSOR_POSITION_QUANTUM) * BRUSH_CURSOR_POSITION_QUANTUM;
}

export function installTextureAirbrushPointerMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    texturePaintToolUsesRegion(tool = this.activeTool) {
      return tool === "clone";
    },

    textureAirbrushRecords() {
      const records = [...(this.paintRecords || [])].filter((record) => (
        record?.object
        && record.geometry?.attributes?.position
        && record.geometry?.attributes?.uv
      ));
      const knownObjects = new Set(records.map((record) => record.object));
      this.model?.traverse?.((object) => {
        if (
          knownObjects.has(object)
          || (!object.isMesh && !object.isSkinnedMesh)
          || !object.visible
          || !object.geometry?.attributes?.position
          || !object.geometry?.attributes?.uv
        ) {
          return;
        }
        knownObjects.add(object);
        records.push({
          object,
          geometry: object.geometry,
          selected: new Set(),
          modified: new Set(),
          deleted: new Set(),
          texturePaintOnly: true
        });
      });
      return records;
    },

    texturePaintFrontRegionHitAtCanvasPoint(point, targetEntries = null) {
      if (!point || !this.canvas || !this.camera) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      if (
        point.x < 0
        || point.y < 0
        || point.x > rect.width
        || point.y > rect.height
      ) {
        return null;
      }
      const entries = targetEntries || [...(this.clonePaintTargets?.entries?.() || [])]
        .filter(([record, target]) => record?.object && target?.vertices?.size);
      if (!entries.length) {
        return null;
      }
      const recordByObject = new Map(entries.map(([record]) => [record.object, record]));
      const targetByRecord = new Map(entries);
      this.pointer.x = (point.x / rect.width) * 2 - 1;
      this.pointer.y = -(point.y / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const intersections = this.raycaster.intersectObjects(entries.map(([record]) => record.object), false);
      const hit = intersections[0];
      const record = hit ? recordByObject.get(hit.object) : null;
      const target = record ? targetByRecord.get(record) : null;
      if (!record || !target?.vertices?.size || !hit?.uv) {
        return null;
      }
      if (!this.clonePaintHitInsideRegion?.(hit, target)) {
        return null;
      }
      return { record, target, hit };
    },

    texturePaintHitForEvent(event, tool = this.activeTool) {
      if (!event || !this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds();

      const regionOverlays = this.texturePaintToolUsesRegion(tool)
        ? (this.cloneSpotlightOverlays || []).filter((overlay) => (
          overlay.visible
          && overlay.userData?.cloneSpotlightKind === "target"
        ))
        : [];
      const hasCapturedRegion = Boolean(this.clonePaintTargets?.size && regionOverlays.length);
      if (hasCapturedRegion) {
        const targetEntries = [...(this.clonePaintTargets?.entries?.() || [])]
          .filter(([record, target]) => record?.object && target?.vertices?.size);
        const frontRegionHit = this.texturePaintFrontRegionHitAtCanvasPoint?.({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        }, targetEntries);
        if (frontRegionHit) {
          return {
            record: frontRegionHit.record,
            hit: this.clonePaintProxySpotlightHit?.(
              frontRegionHit.hit,
              frontRegionHit.record,
              frontRegionHit.target
            ) || frontRegionHit.hit
          };
        }
        const screenRegionHit = this.texturePaintScreenSpotlightHit?.(event);
        const screenPoint = screenRegionHit?.hit?.screenPoint;
        const edgeRegionHit = screenPoint
          ? this.texturePaintFrontRegionHitAtCanvasPoint?.(screenPoint, targetEntries)
          : null;
        if (edgeRegionHit) {
          return {
            record: edgeRegionHit.record,
            hit: this.clonePaintProxySpotlightHit?.(
              edgeRegionHit.hit,
              edgeRegionHit.record,
              edgeRegionHit.target
            ) || edgeRegionHit.hit
          };
        }
        return null;
      }

      const textureRecords = tool === "airbrush" || tool === "texture-eraser" || tool === "eyedropper"
        ? this.textureAirbrushRecords?.() || this.paintRecords || []
        : this.paintRecords || [];
      const raycastObjects = hasCapturedRegion
        ? regionOverlays
        : [
          ...regionOverlays,
          ...textureRecords.map((record) => record.object)
        ];
      const intersections = this.raycaster.intersectObjects(raycastObjects, false);
      if (tool === "clone") {
        return this.clonePaintHitFromIntersections?.(intersections) || null;
      }
      return this.texturePaintHitFromIntersections?.(intersections) || null;
    },

    textureBrushRadiusValue() {
      return Math.max(0.004, Number(this.textureBrushRadius?.value || this.brushRadius?.value || 0.035));
    },

    textureBrushRadiusScreenPixels() {
      return Math.max(
        0.75,
        Math.min(40, this.textureBrushRadiusValue() * 220)
      );
    },

    selectionBrushRadiusValue() {
      return Math.max(0.004, Number(this.brushRadius?.value || 0.035));
    },

    usesSelectionBrushCursor(tool = this.activeTool) {
      return SELECTION_BRUSH_TOOLS.has(tool);
    },

    selectionBrushScreenRadiusPixels() {
      const radius = this.selectionBrushRadiusValue();
      return Math.max(18, Math.min(160, radius * 720));
    },

    hideTextureBrushCursor() {
      if (this.textureBrushCursor) {
        this.textureBrushCursor.hidden = true;
        this.textureBrushCursor.classList.remove("is-clone", "is-selection", "is-deselect");
      }
      this.textureBrushCursorPositionState = null;
      this.textureBrushCursorPendingPosition = null;
      this.textureBrushCursorClassMode = "";
    },

    setTextureBrushCursorMode(mode = "airbrush") {
      if (!this.textureBrushCursor) {
        return false;
      }
      const previousMode = this.textureBrushCursorClassMode;
      this.textureBrushCursor.classList.toggle("is-clone", mode === "clone");
      this.textureBrushCursor.classList.toggle("is-selection", mode === "selection" || mode === "deselect");
      this.textureBrushCursor.classList.toggle("is-deselect", mode === "deselect");
      this.textureBrushCursorClassMode = mode;
      return previousMode !== mode;
    },

    showTextureBrushCursorElement() {
      if (!this.textureBrushCursor) {
        return false;
      }
      if (this.textureBrushCursor.hidden) {
        this.textureBrushCursor.hidden = false;
      }
      return true;
    },

    rememberBrushCursorEvent(event) {
      if (!event || !this.canvas) {
        return null;
      }
      const rect = this.brushCursorCanvasRect?.() || this.canvas.getBoundingClientRect();
      if (
        event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom
      ) {
        this.lastBrushCursorEvent = null;
        return null;
      }
      if (this.lastBrushCursorEvent) {
        this.lastBrushCursorEvent.clientX = event.clientX;
        this.lastBrushCursorEvent.clientY = event.clientY;
        return this.lastBrushCursorEvent;
      }
      this.lastBrushCursorEvent = {
        clientX: event.clientX,
        clientY: event.clientY
      };
      return this.lastBrushCursorEvent;
    },

    brushCursorCanvasRect() {
      if (this.painting && this.textureBrushCursorPositionState?.canvasRect) {
        return this.textureBrushCursorPositionState.canvasRect;
      }
      const canvasRect = this.canvas?.getBoundingClientRect?.() || null;
      if (this.painting && canvasRect) {
        this.textureBrushCursorPositionState = {
          ...(this.textureBrushCursorPositionState || {}),
          canvasRect
        };
      }
      return canvasRect;
    },

    brushCursorStageRect() {
      if (this.painting && this.textureBrushCursorPositionState?.stageRect) {
        return this.textureBrushCursorPositionState.stageRect;
      }
      const stageRect = this.canvas?.parentElement?.getBoundingClientRect?.()
        || this.canvas?.getBoundingClientRect?.()
        || { left: 0, top: 0 };
      if (this.painting) {
        this.textureBrushCursorPositionState = {
          ...(this.textureBrushCursorPositionState || {}),
          stageRect
        };
      }
      return stageRect;
    },

    positionBrushCursor(event, radius) {
      const stageRect = this.brushCursorStageRect();
      const diameter = Math.max(1, radius * 2);
      const x = quantizedCursorPosition(event.clientX - stageRect.left - radius);
      const y = quantizedCursorPosition(event.clientY - stageRect.top - radius);
      const state = this.textureBrushCursorPositionState || {};
      const nextStageRect = this.painting ? stageRect : null;
      if (
        state.diameter === diameter
        && state.x === x
        && state.y === y
        && state.stageRect === nextStageRect
      ) {
        return;
      }
      if (state.diameter !== diameter) {
        this.textureBrushCursor.style.width = `${diameter}px`;
        this.textureBrushCursor.style.height = `${diameter}px`;
      }
      if (state.x !== x || state.y !== y) {
        this.textureBrushCursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
      this.textureBrushCursorPositionState = {
        ...state,
        stageRect: nextStageRect,
        diameter,
        x,
        y
      };
    },

    scheduleBrushCursorPosition(event, radius) {
      if (!event || !this.textureBrushCursor) {
        return false;
      }
      this.textureBrushCursorPendingPosition = {
        clientX: event.clientX,
        clientY: event.clientY,
        radius
      };
      if (this.textureBrushCursorPositionFrame) {
        return true;
      }
      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : typeof globalThis.setTimeout === "function"
          ? (callback) => globalThis.setTimeout(callback, 16)
          : null;
      if (!requestFrame) {
        const pending = this.textureBrushCursorPendingPosition;
        this.textureBrushCursorPendingPosition = null;
        this.positionBrushCursor?.(pending, pending.radius);
        return true;
      }
      this.textureBrushCursorPositionFrame = requestFrame(() => {
        this.textureBrushCursorPositionFrame = null;
        const pending = this.textureBrushCursorPendingPosition;
        this.textureBrushCursorPendingPosition = null;
        if (!pending || !this.textureBrushCursor || this.textureBrushCursor.hidden) {
          return;
        }
        this.positionBrushCursor?.(pending, pending.radius);
      });
      return true;
    },

    updateBrushCursorForLastPointer() {
      if (!this.lastBrushCursorEvent) {
        return false;
      }
      if (this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone") {
        return this.updateTextureBrushCursor(this.lastBrushCursorEvent);
      }
      if (this.usesSelectionBrushCursor?.(this.activeTool)) {
        return this.updateSelectionBrushCursor(this.lastBrushCursorEvent);
      }
      return false;
    },

    updateTextureBrushCursor(event) {
      if (!this.textureBrushCursor || !this.canvas || !event) {
        return false;
      }
      const remembered = this.rememberBrushCursorEvent(event);
      const isTextureBrush = this.activeTool === "airbrush" || this.activeTool === "texture-eraser" || this.activeTool === "clone";
      if (!isTextureBrush || this.cleanPreview || !remembered) {
        this.hideTextureBrushCursor();
        return false;
      }
      const hit = this.texturePaintHitForEvent(event, this.activeTool);
      if (this.activeTool === "clone" && (!hit || !this.clonePaintSource?.records?.get(hit.record))) {
        this.hideTextureBrushCursor();
        return false;
      }
      if (this.activeTool === "airbrush") {
        this.scheduleTextureAirbrushPrewarm?.(event, hit, {
          preserveLayerDisplay: true
        });
      }
      const radius = this.textureBrushRadiusScreenPixels();
      this.showTextureBrushCursorElement?.();
      this.setTextureBrushCursorMode(this.activeTool === "clone" ? "clone" : "airbrush");
      this.positionBrushCursor(event, radius);
      return true;
    },

    updateSelectionBrushCursor(event) {
      if (!this.textureBrushCursor || !this.canvas || !event) {
        return false;
      }
      this.rememberBrushCursorEvent(event);
      if (!this.usesSelectionBrushCursor?.(this.activeTool)) {
        this.hideTextureBrushCursor();
        return false;
      }
      const radius = this.selectionBrushScreenRadiusPixels();
      this.showTextureBrushCursorElement?.();
      this.setTextureBrushCursorMode(this.activeTool === "deselect" || this.activeTool === "erase" ? "deselect" : "selection");
      this.positionBrushCursor(event, radius);
      return true;
    }
  });
}
