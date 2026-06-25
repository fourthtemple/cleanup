import {
  textureAirbrushFrontIntersections,
  textureAirbrushPaintSamplePointsFromStroke,
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
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // USER-APPROVED FIX, DO NOT SIMPLIFY:
      // live airbrush is allowed to paint only through a shader path that owns
      // the current camera-facing normal gate and current frontmost-depth gate.
      // If that path misses, the correct result is "paint nothing", not "paint
      // through texture space until coverage looks better".
      //
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // Live airbrush painting must use a camera-visible/frontmost-depth mask.
      // CPU/WebGPU texture-space brushing does not currently have that mask,
      // so it must not be used as a live paint fallback.
      const requireVisibleSurfaceShader = options.allowUnsafeCpuAirbrush !== true
        && options.fullRegion !== true
        && options.meshFallback !== true;
      const resolvedBackend = options.resolvedBackend && typeof options.resolvedBackend.backend === "string"
        ? options.resolvedBackend
        : null;
      const webGpuVisibleMaskReady = requireVisibleSurfaceShader
        && typeof this.textureAirbrushWebGpuPaintFromEvent === "function"
        && Boolean(this.textureAirbrushWebGpuDevice?.());
      const backendOptions = {
        ...options,
        visibleSurfaceMaskRequired: requireVisibleSurfaceShader,
        liveProjectedPaint: requireVisibleSurfaceShader,
        visibleSurfaceMaskReady: webGpuVisibleMaskReady
      };
      const backend = resolvedBackend || this.textureAirbrushResolveBackend?.(backendOptions) || {
        backend: !this.textureAirbrushGpuDisabled ? "webgl" : "cpu",
        webGpuStatus: "not-installed"
      };
      if (backend.backend === "webgpu" && requireVisibleSurfaceShader) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // The WebGPU live route is allowed only with an explicit visibility
        // permission mask generated from frontmost raycast samples. That mask
        // can soften visible edges, but it must never authorize hidden texels.
        const webGpuChanged = this.textureAirbrushWebGpuPaintFromEvent?.(event, {
          ...options,
          visibleSurfaceMaskRequired: true,
          liveProjectedPaint: true,
          requireVisibilityMask: true
        }) || 0;
        if (webGpuChanged > 0) {
          return webGpuChanged;
        }
        this.textureAirbrushReportWebGpuFallback?.({
          backend: "none",
          webGpuStatus: "visible-surface-mask-unavailable"
        });
        return 0;
      }
      if (backend.backend === "none") {
        this.textureAirbrushReportWebGpuFallback?.(backend);
        if (requireVisibleSurfaceShader) {
          this.setStatus?.("Live airbrush needs a WebGPU visible-surface mask before the WebGL projection brush can be removed.");
        }
        return 0;
      }
      if (backend.backend !== "webgpu") {
        this.textureAirbrushReportWebGpuFallback?.(backend);
      }
      if (!this.textureAirbrushGpuDisabled) {
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
      if (requireVisibleSurfaceShader) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // This return is intentional. It prevents the CPU raycast/UV fallback
        // from painting texture islands that are not currently camera-facing.
        // Do not replace it with the old fallback unless that fallback gets the
        // same current visible-depth and camera-facing normal mask.
        //
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // If the visible-depth shader misses or is unavailable, do not fall
        // through to CPU texture painting. Returning 0 is safer than painting
        // hidden/back-side texture pixels.
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
      const useCpuStrokeSamples = options.cpuStrokeSamples === true;
      const probes = useCpuStrokeSamples
        ? textureAirbrushPaintSamplePointsFromStroke(stroke, brushRadius, {
            spacing: options.spacing,
            maxSamples: options.maxCpuStrokeSamples
          })
        : textureAirbrushProbePointsFromStroke(stroke, brushRadius);
      const eventAtProbe = (probe) => this.textureAirbrushInputEventAtPoint?.(event, {
        clientX: (rect.left || 0) + probe.x,
        clientY: (rect.top || 0) + probe.y
      }) || this.texturePaintEventAtPoint?.(event, {
        clientX: (rect.left || 0) + probe.x,
        clientY: (rect.top || 0) + probe.y
      }) || {
        ...event,
        clientX: (rect.left || 0) + probe.x,
        clientY: (rect.top || 0) + probe.y
      };

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
        this.captureTexturePaintCanvasUndoTarget?.(record, material, editable, materialIndex);
        const { canvas, context, texture } = editable;
        const sourceImage = this.texturePaintCanvasStrokeSourceImage?.(record, material, editable, materialIndex) || null;
        const opacityState = this.texturePaintCanvasStrokeOpacityState?.(record, material, editable, materialIndex) || null;
        const state = {
          record,
          material,
          editable,
          canvas,
          context,
          texture,
          image: context.getImageData(0, 0, canvas.width, canvas.height),
          sourceImage,
          strokeAlphaByPixel: opacityState?.alphaByPixel || null,
          written: new Set(),
          faceFrames: new Map(),
          changed: 0
        };
        states.set(key, state);
        return state;
      };

      const acceptedFaces = new Set();
      const hits = [];
      const neighborPaintSeed = options.neighborPaintSeed || null;
      const acceptHit = (hit, probe) => {
        const record = recordByObject.get(hit?.object);
        if (!record || !hit?.face || !hit?.uv) {
          return;
        }
        const materialIndex = hit.face?.materialIndex ?? 0;
        const material = this.clonePaintMaterialForHit?.(record, hit) || null;
        if (this.textureAirbrushNeighborHitAllowed?.(
          neighborPaintSeed,
          record,
          hit,
          material,
          materialIndex
        ) === false) {
          return;
        }
        const recordIndex = paintRecords.indexOf(record);
        const probeKey = useCpuStrokeSamples ? `${Math.round(probe?.x || 0)}:${Math.round(probe?.y || 0)}:` : "";
        const faceKey = `${probeKey}${recordIndex}:${hit.face.a}:${hit.face.b}:${hit.face.c}:${hit.face.materialIndex ?? 0}`;
        if (acceptedFaces.has(faceKey)) {
          return;
        }
        acceptedFaces.add(faceKey);
        hits.push({ record, hit, probe });
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
          acceptHit(hit, probe);
        }
      }

      let changed = 0;
      for (const { record, hit, probe } of hits) {
        const state = stateForHit(record, hit);
        if (!state) {
          continue;
        }
        const paintEvent = useCpuStrokeSamples && probe ? eventAtProbe(probe) : event;
        changed += this.textureAirbrushUvBrushOnFace?.(record, hit, paintEvent, {
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
        if (state.editable?.layerMode && state.dirtyBounds) {
          state.editable.dirtyBounds = state.dirtyBounds;
        }
        this.texturePaintCommitEditable?.(state.editable, state.material, state.record, {
          refreshSpotlight: state.editable?.layerMode !== true,
          renderPanel: false
        });
        if (state.editable?.layerMode) {
          delete state.editable.dirtyBounds;
        }
        if (state.editable?.layerMode !== true) {
          this.refreshCloneSpotlightTextures?.(state.record);
        }
      }
      if (changed) {
        this.markTexturePaintStrokeChanged?.();
        if (![...states.values()].some((state) => state.editable?.layerMode === true)) {
          this.updateClonePaintPreviews?.();
        }
        this.setStatus(`${options.erase ? "Erased" : "Airbrushed"} ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      }
      return changed;
    }
  });
}
