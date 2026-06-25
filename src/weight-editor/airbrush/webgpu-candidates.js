import {
  textureAirbrushFrontIntersections,
  textureAirbrushPointInRect,
  textureAirbrushProbePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent
} from "./projection.js";
import { textureAirbrushWebGpuAssignVisibilityMasks } from "./webgpu-projection.js";
import { textureAirbrushWebGpuStrokeCandidateFromHit } from "./webgpu-stroke.js";

export function installTextureAirbrushWebGpuCandidateMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushWebGpuStrokeCandidateFromHit(record, hit, event, options = {}) {
      return textureAirbrushWebGpuStrokeCandidateFromHit(this, record, hit, event, options);
    },

    textureAirbrushWebGpuCandidatesFromEvent(event = null, options = {}) {
      if (!event || !this.model) {
        return [];
      }
      const requiresVisibilityMask = options.visibleSurfaceMaskRequired === true
        || options.liveProjectedPaint === true
        || options.requireVisibilityMask === true;
      const candidates = [];
      const seen = new Set();
      const addCandidate = (candidate) => {
        if (!candidate) {
          return;
        }
        const key = [
          this.paintRecords?.indexOf?.(candidate.record) ?? -1,
          candidate.materialIndex ?? 0,
          candidate.material?.uuid || candidate.material?.id || "material",
          Math.round(candidate.center?.x || 0),
          Math.round(candidate.center?.y || 0)
        ].join(":");
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        candidates.push(candidate);
      };

      const directHit = this.texturePaintHitForEvent?.(event, "airbrush");
      addCandidate(this.textureAirbrushWebGpuStrokeCandidateFromHit?.(
        directHit?.record,
        directHit?.hit,
        event,
        options
      ));

      if (!this.canvas || !this.camera || !this.raycaster) {
        if (requiresVisibilityMask) {
          textureAirbrushWebGpuAssignVisibilityMasks(candidates, options);
        }
        return candidates;
      }
      if (this.clonePaintTargets?.size && !requiresVisibilityMask) {
        return candidates;
      }
      const rect = this.canvas.getBoundingClientRect?.();
      const stroke = textureAirbrushScreenStrokeFromEvent(event, rect, options);
      if (!rect || !stroke) {
        return candidates;
      }
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const probes = textureAirbrushProbePointsFromStroke(stroke, brushRadius);
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!paintRecords.length) {
        return candidates;
      }
      this.model.updateMatrixWorld?.(true);
      this.refreshSkinnedRaycastBounds?.();
      const paintObjects = paintRecords.map((record) => record.object);
      const recordByObject = new Map(paintRecords.map((record) => [record.object, record]));
      for (const probe of probes) {
        if (!textureAirbrushPointInRect(probe, rect)) {
          continue;
        }
        this.pointer.x = (probe.x / rect.width) * 2 - 1;
        this.pointer.y = -(probe.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        for (const hit of textureAirbrushFrontIntersections(intersections)) {
          const record = recordByObject.get(hit.object);
          const candidate = this.textureAirbrushWebGpuStrokeCandidateFromHit?.(
            record,
            hit,
            {
              clientX: (rect.left || 0) + probe.x,
              clientY: (rect.top || 0) + probe.y,
              pointerType: event.pointerType || "",
              pressure: event.pressure,
              button: event.button ?? 0,
              buttons: event.buttons ?? 1
            },
            {
              ...options,
              strokeStart: null,
              strokeSegments: null
            }
          );
          addCandidate(candidate);
        }
      }
      if (requiresVisibilityMask) {
        textureAirbrushWebGpuAssignVisibilityMasks(candidates, options);
      }
      return candidates;
    }
  });
}
