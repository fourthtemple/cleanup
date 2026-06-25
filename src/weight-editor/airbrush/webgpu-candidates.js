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
      const captureDebug = options.captureCandidateDebug === true || this.textureAirbrushCaptureCandidateDebug === true;
      const debug = captureDebug
        ? {
            directHit: false,
            directCandidate: false,
            probeCount: 0,
            intersectionCount: 0,
            frontHitCount: 0,
            candidates: 0,
            rejects: new Map(),
            rejectSamples: []
          }
        : null;
      const debugReject = debug
        ? (reason, detail = null) => {
            debug.rejects.set(reason, (debug.rejects.get(reason) || 0) + 1);
            if (debug.rejectSamples.length < 6) {
              debug.rejectSamples.push({ reason, detail });
            }
          }
        : null;
      const finish = () => {
        if (debug) {
          debug.candidates = candidates.length;
          this.textureAirbrushLastWebGpuCandidateDebug = {
            ...debug,
            rejects: Object.fromEntries(debug.rejects)
          };
        }
        return candidates;
      };
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
      if (debug) {
        debug.directHit = Boolean(directHit?.record && directHit?.hit);
      }
      const directCandidate = this.textureAirbrushWebGpuStrokeCandidateFromHit?.(
        directHit?.record,
        directHit?.hit,
        event,
        debugReject ? { ...options, debugReject } : options
      );
      if (debug) {
        debug.directCandidate = Boolean(directCandidate);
      }
      addCandidate(directCandidate);

      if (!this.canvas || !this.camera || !this.raycaster) {
        if (requiresVisibilityMask) {
          textureAirbrushWebGpuAssignVisibilityMasks(candidates, options);
        }
        return finish();
      }
      if (this.clonePaintTargets?.size && !requiresVisibilityMask) {
        return finish();
      }
      const rect = this.canvas.getBoundingClientRect?.();
      const stroke = textureAirbrushScreenStrokeFromEvent(event, rect, options);
      if (!rect || !stroke) {
        return finish();
      }
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const probes = textureAirbrushProbePointsFromStroke(stroke, brushRadius);
      if (debug) {
        debug.probeCount = probes.length;
      }
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!paintRecords.length) {
        return finish();
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
        if (debug) {
          debug.intersectionCount += intersections.length;
        }
        for (const hit of textureAirbrushFrontIntersections(intersections)) {
          if (debug) {
            debug.frontHitCount += 1;
          }
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
            debugReject
              ? {
                  ...options,
                  debugReject,
                  strokeStart: null,
                  strokeSegments: null
                }
              : {
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
      return finish();
    }
  });
}
