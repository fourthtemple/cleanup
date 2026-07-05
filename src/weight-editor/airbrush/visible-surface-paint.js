import { installTextureAirbrushProjectedRegionMethods } from "./projected-region.js";

export function installTextureAirbrushVisibleSurfacePaintMethods(BirdWeightEditor) {
  installTextureAirbrushProjectedRegionMethods(BirdWeightEditor);
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushVisibleSurfaceUnderPointer(event, options = {}) {
      void event;
      void options;
      this.textureAirbrushReportWebGpuFallback?.({
        backend: "none",
        webGpuStatus: "cpu-mesh-fallback-disabled"
      });
      return 0;
    },

    textureAirbrushVisibleSurfacePaintFromEvent(event, options = {}) {
      if (!event || !this.canvas || !this.camera || !this.model) {
        return 0;
      }
      options = this.textureAirbrushOptionsWithPressure?.(event, options) || options;
      if (
        options.fullRegion === true
        || options.meshFallback === true
        || options.cpuStrokeSamples === true
      ) {
        this.textureAirbrushReportWebGpuFallback?.({
          backend: "none",
          webGpuStatus: "cpu-projection-disabled"
        });
        this.setStatus?.("Airbrush CPU texture projection is disabled; WebGPU visible-surface paint is required.");
        return 0;
      }

      // DO NOT PAINT ON NON CAMERA-FACING NORMALS.
      // Live airbrush is allowed to paint only through the WebGPU path that owns
      // the current camera-facing normal observability mask. If that path is not
      // ready or returns no candidates, the correct result is paint nothing.
      const resolvedBackend = options.resolvedBackend && typeof options.resolvedBackend.backend === "string"
        ? options.resolvedBackend
        : null;
      const webGpuVisibleMaskReady = typeof this.textureAirbrushWebGpuPaintFromEvent === "function"
        && Boolean(this.textureAirbrushWebGpuDevice?.());
      const backendOptions = {
        ...options,
        visibleSurfaceMaskRequired: true,
        liveProjectedPaint: true,
        visibleSurfaceMaskReady: webGpuVisibleMaskReady
      };
      const backend = resolvedBackend || this.textureAirbrushResolveBackend?.(backendOptions) || {
        backend: "none",
        webGpuStatus: "not-installed"
      };
      if (backend.backend !== "webgpu") {
        this.textureAirbrushReportWebGpuFallback?.(backend);
        this.setStatus?.("Live airbrush needs a WebGPU visible-surface mask before paint can be applied.");
        return 0;
      }

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
      if (this.textureAirbrushGpuDisabled) {
        this.setStatus?.("Airbrush GPU path failed; reload the model or page before painting again.");
      }
      return 0;
    },

    textureAirbrushMeshUnderPointer(event, options = {}) {
      return this.textureAirbrushVisibleSurfaceUnderPointer(event, options);
    },

    textureAirbrushProjectedMeshFromEvent(event, options = {}) {
      return this.textureAirbrushVisibleSurfacePaintFromEvent(event, options);
    }
  });
}
