import {
  textureAirbrushFrontIntersections,
  textureAirbrushPointInRect,
  textureAirbrushProbePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent
} from "./projection.js";
import { installTextureAirbrushProjectedRegionMethods } from "./projected-region.js";

export function installTextureAirbrushProjectedPaintMethods(BirdWeightEditor) {
  installTextureAirbrushProjectedRegionMethods(BirdWeightEditor);
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushMeshUnderPointer(event, options = {}) {
      if (!event || !this.canvas || !this.camera) {
        return 0;
      }
      if (this.clonePaintTargets?.size) {
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.refreshSkinnedRaycastBounds?.();
      const paintObjects = (this.paintRecords || []).map((record) => record.object);
      const intersections = this.raycaster.intersectObjects(paintObjects, false);
      let changed = 0;
      let paintedHits = 0;
      const paintedFaces = new Set();
      for (const hit of intersections) {
        const record = this.paintRecords.find((item) => item.object === hit.object);
        if (!record) {
          continue;
        }
        const recordIndex = this.paintRecords.indexOf(record);
        const face = hit.face || {};
        const faceKey = `${recordIndex}:${face.a ?? "a"}:${face.b ?? "b"}:${face.c ?? "c"}:${face.materialIndex ?? 0}`;
        if (paintedFaces.has(faceKey)) {
          continue;
        }
        paintedFaces.add(faceKey);
        changed += this.textureAirbrushNear(record, hit, {
          ...options,
          event: null,
          meshFallback: true
        }) || 0;
        paintedHits += 1;
        if (paintedHits >= 12) {
          break;
        }
      }
      return changed;
    },

    textureAirbrushProjectedMeshFromEvent(event, options = {}) {
      if (!event || !this.canvas || !this.camera || !this.model) {
        return 0;
      }
      options = this.textureAirbrushOptionsWithPressure?.(event, options) || options;
      const resolvedBackend = options.resolvedBackend && typeof options.resolvedBackend.backend === "string"
        ? options.resolvedBackend
        : null;
      const backend = resolvedBackend || this.textureAirbrushResolveBackend?.(options) || {
        backend: options.gpu === true && !this.textureAirbrushGpuDisabled ? "webgl" : "cpu",
        webGpuStatus: "not-installed"
      };
      if (backend.backend === "webgpu") {
        try {
          const webGpuChanged = this.textureAirbrushWebGpuPaintFromEvent?.(event, options) || 0;
          if (webGpuChanged > 0) {
            return webGpuChanged;
          }
        } catch (error) {
          this.textureAirbrushWebGpuDisabled = true;
          console.warn("Texture airbrush WebGPU path failed; trying WebGL shader brush", error);
        }
      } else {
        this.textureAirbrushReportWebGpuFallback?.(backend);
      }
      if (backend.backend === "webgl" && !this.textureAirbrushGpuDisabled) {
        try {
          const gpuChanged = this.textureAirbrushGpuProjectFromEvent?.(event, options) || 0;
          if (gpuChanged > 0) {
            return gpuChanged;
          }
        } catch (error) {
          this.textureAirbrushGpuDisabled = true;
          console.warn("Texture airbrush shader path failed; live airbrush paint was not applied", error);
        }
      }
      if (options.gpu === true) {
        if (this.textureAirbrushGpuDisabled) {
          this.setStatus?.("Airbrush GPU path failed; reload the model or page before painting again.");
        }
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      const stroke = textureAirbrushScreenStrokeFromEvent(event, rect, options);
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!stroke || !paintRecords.length) {
        return 0;
      }

      this.model.updateMatrixWorld?.(true);
      for (const record of paintRecords) {
        record.object.updateMatrixWorld(true);
      }
      this.refreshSkinnedRaycastBounds?.();

      const recordByObject = new Map(paintRecords.map((record) => [record.object, record]));
      const paintObjects = paintRecords.map((record) => record.object);
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const probes = textureAirbrushProbePointsFromStroke(stroke, brushRadius);

      const states = new Map();
      const stateForHit = (record, hit) => {
        const material = this.clonePaintMaterialForHit?.(record, hit);
        const editable = this.editableClonePaintTexture?.(material);
        if (!material || !editable) {
          return null;
        }
        const materialIndex = hit?.face?.materialIndex ?? 0;
        const key = [
          paintRecords.indexOf(record),
          materialIndex,
          material.uuid || material.id || "material"
        ].join(":");
        const existing = states.get(key);
        if (existing) {
          return existing;
        }
        const { canvas, context, texture } = editable;
        const state = {
          record,
          material,
          canvas,
          context,
          texture,
          image: context.getImageData(0, 0, canvas.width, canvas.height),
          written: new Set(),
          faceFrames: new Map(),
          changed: 0
        };
        states.set(key, state);
        return state;
      };

      const acceptedFaces = new Set();
      const hits = [];
      const acceptHit = (hit) => {
        const record = recordByObject.get(hit?.object);
        if (!record || !hit?.face || !hit?.uv) {
          return;
        }
        const recordIndex = paintRecords.indexOf(record);
        const faceKey = `${recordIndex}:${hit.face.a}:${hit.face.b}:${hit.face.c}:${hit.face.materialIndex ?? 0}`;
        if (acceptedFaces.has(faceKey)) {
          return;
        }
        acceptedFaces.add(faceKey);
        hits.push({ record, hit });
      };

      for (const probe of probes) {
        if (!textureAirbrushPointInRect(probe, rect)) {
          continue;
        }
        this.pointer.x = (probe.x / rect.width) * 2 - 1;
        this.pointer.y = -(probe.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        for (const hit of textureAirbrushFrontIntersections(intersections)) {
          acceptHit(hit);
        }
      }

      let changed = 0;
      for (const { record, hit } of hits) {
        const state = stateForHit(record, hit);
        if (!state) {
          continue;
        }
        changed += this.textureAirbrushUvBrushOnFace?.(record, hit, event, {
          ...options,
          paintState: state,
          deferCommit: true,
          status: false
        }) || 0;
      }

      for (const state of states.values()) {
        if (!state.changed) {
          continue;
        }
        state.context.putImageData(state.image, 0, 0);
        state.texture.needsUpdate = true;
        state.material.needsUpdate = true;
        this.refreshCloneSpotlightTextures?.(state.record);
      }
      if (changed) {
        this.updateClonePaintPreviews?.();
        this.setStatus(`Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      }
      return changed;
    }
  });
}
