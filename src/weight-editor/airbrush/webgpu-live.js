import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import { installTextureAirbrushWebGpuCandidateMethods } from "./webgpu-candidates.js?v=layer-undo-fix-20260621a";
import { textureAirbrushWebGpuStrokeEstimate } from "./webgpu-stroke.js?v=layer-undo-fix-20260621a";

function clampByte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(number)));
}

function styleNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function webGpuCandidateStyleKey(candidate = null) {
  const options = candidate?.options || {};
  const color = options.color || {};
  return [
    Math.round(styleNumber(options.radiusPixels, candidate?.radiusPixels || 1) * 100),
    Math.round(styleNumber(options.opacity, 0.42) * 1000),
    Math.round(styleNumber(options.hardness, 0.35) * 1000),
    Math.round(styleNumber(options.scatter, 0.35) * 1000),
    Math.round(styleNumber(options.strength, 1) * 1000),
    clampByte(color.r),
    clampByte(color.g),
    clampByte(color.b)
  ].join(":");
}

function candidateStrokeSegments(candidate = null) {
  return Array.isArray(candidate?.strokeSegments) ? candidate.strokeSegments : [];
}

function webGpuCandidateUndoKey(candidate = null) {
  return candidate?.editable?.texture
    || candidate?.editable?.canvas
    || candidate?.editable
    || [
      candidate?.record?.uuid || candidate?.record?.id || "record",
      candidate?.materialIndex ?? 0,
      candidate?.material?.uuid || candidate?.material?.id || "material"
    ].join(":");
}

export function installTextureAirbrushWebGpuLiveMethods(BirdWeightEditor) {
  installTextureAirbrushWebGpuCandidateMethods(BirdWeightEditor);
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushTrackWebGpuPaint(promise) {
      if (!promise || typeof promise.finally !== "function") {
        return promise;
      }
      this.textureAirbrushPendingWebGpuPaints ||= new Set();
      this.textureAirbrushPendingWebGpuPaints.add(promise);
      promise.finally(() => {
        this.textureAirbrushPendingWebGpuPaints?.delete?.(promise);
      });
      return promise;
    },

    flushTextureAirbrushPendingWebGpuPaints() {
      const drainQueued = () => Promise.resolve(
        this.flushTextureAirbrushQueuedWebGpuStrokes?.({ force: true }) || 0
      ).then(() => {
        if (this.textureAirbrushWebGpuFlushInFlight || (this.textureAirbrushQueuedWebGpuStrokes || []).length) {
          return drainQueued();
        }
        return null;
      });
      return drainQueued().then(() => {
        const pending = [...(this.textureAirbrushPendingWebGpuPaints || [])];
        if (!pending.length) {
          return [];
        }
        return Promise.allSettled(pending);
      });
    },

    textureAirbrushWebGpuCandidateBatch(candidate = null, segmentCount = candidateStrokeSegments(candidate).length) {
      if (!candidate?.editable || !candidate.material) {
        return null;
      }
      const styleKey = webGpuCandidateStyleKey(candidate);
      const queue = this.textureAirbrushQueuedWebGpuStrokes || [];
      return queue.find((batch) => (
        batch.record === candidate.record
        && batch.material === candidate.material
        && batch.editable === candidate.editable
        && batch.materialIndex === candidate.materialIndex
        && batch.styleKey === styleKey
        && batch.strokeSegments.length + segmentCount <= TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS
      )) || null;
    },

    textureAirbrushQueueWebGpuStrokeCandidate(candidate = null, options = {}) {
      if (!candidate?.editable || !candidate.material) {
        return 0;
      }
      this.textureAirbrushQueuedWebGpuStrokes ||= [];
      this.textureAirbrushQueuedWebGpuUndoKeys ||= new Set();
      const undoKey = webGpuCandidateUndoKey(candidate);
      const queuedSegments = candidateStrokeSegments(candidate);
      const chunks = queuedSegments.length
        ? []
        : [[]];
      for (let index = 0; index < queuedSegments.length; index += TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS) {
        chunks.push(queuedSegments.slice(index, index + TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS));
      }
      let totalEstimate = 0;
      for (const chunk of chunks) {
        const segmentCount = Math.max(1, chunk.length);
        let batch = this.textureAirbrushWebGpuCandidateBatch?.(candidate, segmentCount);
        if (!batch) {
          batch = {
            ...candidate,
            styleKey: webGpuCandidateStyleKey(candidate),
            strokeSegments: [],
            undoCaptured: false,
            options: {
              ...candidate.options,
              strokeSegments: []
            },
            estimate: 0
          };
          this.textureAirbrushQueuedWebGpuStrokes.push(batch);
          if (!this.textureAirbrushQueuedWebGpuUndoKeys.has(undoKey)) {
            this.captureTexturePaintCanvasUndoTarget?.(
              candidate.record,
              candidate.material,
              candidate.editable,
              candidate.materialIndex
            );
            this.textureAirbrushQueuedWebGpuUndoKeys.add(undoKey);
          }
          batch.undoCaptured = true;
        }
        batch.strokeSegments.push(...chunk);
        batch.options.strokeSegments = batch.strokeSegments;
        batch.estimate = textureAirbrushWebGpuStrokeEstimate(batch);
        totalEstimate += textureAirbrushWebGpuStrokeEstimate({
          ...batch,
          strokeSegments: chunk
        });
      }
      this.scheduleTextureAirbrushQueuedWebGpuFlush?.();
      this.setStatus?.(`WebGPU airbrush queued ${totalEstimate || candidate.estimate} texture pixels`);
      return totalEstimate || candidate.estimate;
    },

    scheduleTextureAirbrushQueuedWebGpuFlush() {
      if (this.textureAirbrushWebGpuFlushScheduled) {
        return false;
      }
      this.textureAirbrushWebGpuFlushScheduled = true;
      const schedule = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : typeof globalThis.setTimeout === "function"
          ? (callback) => globalThis.setTimeout(callback, 16)
          : null;
      if (!schedule) {
        this.textureAirbrushWebGpuFlushScheduled = false;
        return false;
      }
      const runFlush = () => {
        this.textureAirbrushWebGpuFlushScheduled = false;
        this.flushTextureAirbrushQueuedWebGpuStrokes?.();
      };
      if (this.textureAirbrushWebGpuFlushInFlight) {
        this.textureAirbrushWebGpuFlushInFlight.finally(() => {
          if ((this.textureAirbrushQueuedWebGpuStrokes || []).length) {
            schedule(runFlush);
          } else {
            this.textureAirbrushWebGpuFlushScheduled = false;
          }
        });
        return true;
      }
      schedule(runFlush);
      return true;
    },

    flushTextureAirbrushQueuedWebGpuStrokes(options = {}) {
      if (this.textureAirbrushWebGpuFlushInFlight) {
        if (options.force === true) {
          return this.textureAirbrushWebGpuFlushInFlight.then(() => (
            this.flushTextureAirbrushQueuedWebGpuStrokes?.({ ...options, force: true }) || 0
          ));
        }
        return this.textureAirbrushWebGpuFlushInFlight;
      }
      this.textureAirbrushWebGpuFlushScheduled = false;
      const queue = this.textureAirbrushQueuedWebGpuStrokes || [];
      if (!queue.length) {
        return Promise.resolve(0);
      }
      this.textureAirbrushQueuedWebGpuStrokes = [];
      this.textureAirbrushQueuedWebGpuUndoKeys = new Set();
      let chain = Promise.resolve();
      let estimate = 0;
      for (const batch of queue) {
        estimate += Math.max(0, batch.estimate || 0);
        chain = chain.then(() => this.textureAirbrushStartWebGpuPaintCandidate?.(batch, options));
      }
      this.setStatus?.(`WebGPU airbrush flushing ${estimate} texture pixels`);
      const flushPromise = chain.then(() => estimate).finally(() => {
        if (this.textureAirbrushWebGpuFlushInFlight === flushPromise) {
          this.textureAirbrushWebGpuFlushInFlight = null;
        }
        if (options.force !== true && (this.textureAirbrushQueuedWebGpuStrokes || []).length) {
          this.scheduleTextureAirbrushQueuedWebGpuFlush?.();
        }
      });
      this.textureAirbrushWebGpuFlushInFlight = flushPromise;
      return flushPromise;
    },

    textureAirbrushStartWebGpuPaintCandidate(candidate = null, options = {}) {
      if (!candidate?.editable || !candidate.material) {
        return Promise.resolve(null);
      }
      if (candidate.undoCaptured !== true) {
        this.captureTexturePaintCanvasUndoTarget?.(
          candidate.record,
          candidate.material,
          candidate.editable,
          candidate.materialIndex
        );
        candidate.undoCaptured = true;
      }
      const strokeSourceImageData = this.texturePaintCanvasStrokeSourceImage?.(
        candidate.record,
        candidate.material,
        candidate.editable,
        candidate.materialIndex
      ) || null;
      const run = this.textureAirbrushRunEditableWebGpuPaint(candidate.editable, {
        ...candidate.options,
        ...options,
        material: candidate.material,
        ...(strokeSourceImageData ? { strokeSourceImageData } : {})
      });
      const tracked = Promise.resolve(run).then((result) => {
        if (result?.applied) {
          this.markTexturePaintStrokeChanged?.();
          this.refreshCloneSpotlightTextures?.(candidate.record);
          this.updateClonePaintPreviews?.();
          this.setStatus?.(`WebGPU airbrushed ${candidate.estimate} texture pixels`);
        }
        return result;
      }).catch((error) => {
        this.textureAirbrushWebGpuDisabled = true;
        console.warn("Texture airbrush WebGPU editable paint failed; using fallback on the next stroke", error);
        return null;
      });
      this.textureAirbrushTrackWebGpuPaint?.(tracked);
      return tracked;
    },

    textureAirbrushWebGpuPaintCandidate(candidate = null, options = {}) {
      if (!candidate?.editable || !candidate.material) {
        return 0;
      }
      this.textureAirbrushStartWebGpuPaintCandidate?.(candidate, options);
      this.setStatus?.(`WebGPU airbrush started ${candidate.estimate} texture pixels`);
      return candidate.estimate;
    },

    textureAirbrushWebGpuPaintFromEvent(event = null, options = {}) {
      if (!event || !this.model || !this.texturePaintHitForEvent) {
        return 0;
      }
      const candidates = this.textureAirbrushWebGpuCandidatesFromEvent?.(event, options) || [];
      if (!candidates.length) {
        return 0;
      }
      return candidates.reduce((total, candidate) => (
        total + (this.textureAirbrushQueueWebGpuStrokeCandidate?.(candidate, options) || 0)
      ), 0);
    }
  });
}
