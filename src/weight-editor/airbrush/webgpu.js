import {
  textureAirbrushRunWebGpuPaint,
  textureAirbrushWebGpuDeviceFromRenderer
} from "./webgpu-dispatch.js";
import {
  textureAirbrushEditableWebGpuPayload,
  textureAirbrushInvalidateWebGpuCache,
  textureAirbrushPrewarmEditableWebGpuPaint,
  textureAirbrushRunEditableWebGpuPaint,
  textureAirbrushSourcePixelsFromEditable
} from "./webgpu-canvas.js";
import { installTextureAirbrushWebGpuDiagnosticMethods } from "./webgpu-diagnostics.js";
import { textureAirbrushWebGpuKernelSource } from "./webgpu-kernel.js";
import { textureAirbrushWebGpuPaintPlan } from "./webgpu-plan.js";
import { installTextureAirbrushWebGpuLiveMethods } from "./webgpu-live.js";
import { installTextureAirbrushWebGpuPrewarmMethods } from "./webgpu-prewarm.js";
import {
  resolveTextureAirbrushBackend,
  resolveTextureAirbrushRendererMode,
  textureAirbrushNativeWebGpuAvailable,
  textureAirbrushWebGpuRendererRequestedFromSearch,
  textureAirbrushWebGpuRequestedFromSearch
} from "./webgpu-resolver.js";

export {
  resolveTextureAirbrushBackend,
  resolveTextureAirbrushRendererMode,
  TEXTURE_AIRBRUSH_WEBGPU_QUERY_PARAM,
  TEXTURE_AIRBRUSH_WEBGPU_RENDERER_QUERY_PARAM,
  textureAirbrushNativeWebGpuAvailable,
  textureAirbrushRendererWebGpuState,
  textureAirbrushWebGpuRendererRequestedFromSearch,
  textureAirbrushWebGpuRequestedFromSearch
} from "./webgpu-resolver.js";
export { installTextureAirbrushWebGpuLiveMethods } from "./webgpu-live.js";

export function installTextureAirbrushWebGpuMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushWebGpuRequested() {
      if (this.textureAirbrushForceWebGpu === true) {
        return true;
      }
      if (typeof window === "undefined") {
        return false;
      }
      return textureAirbrushWebGpuRequestedFromSearch(window.location?.search || "");
    },

    textureAirbrushWebGpuRendererRequested() {
      if (this.textureAirbrushForceWebGpuRenderer === true) {
        return true;
      }
      if (typeof window === "undefined") {
        return false;
      }
      return textureAirbrushWebGpuRendererRequestedFromSearch(window.location?.search || "");
    },

    textureAirbrushResolveRendererMode(options = {}) {
      const resolved = resolveTextureAirbrushRendererMode({
        preferWebGpuRenderer: options.webgpuRenderer === true || this.textureAirbrushWebGpuRendererRequested?.() === true,
        webGpuAvailable: textureAirbrushNativeWebGpuAvailable(globalThis),
        WebGPURenderer: options.WebGPURenderer,
        webGpuRendererDisabled: this.textureAirbrushWebGpuRendererDisabled === true
      });
      this.textureAirbrushLastRendererMode = resolved;
      return resolved;
    },

    textureAirbrushResolveBackend(options = {}) {
      const preferWebGpu = options.webgpu === true || this.textureAirbrushWebGpuRequested?.() === true;
      const resolved = resolveTextureAirbrushBackend({
        preferWebGpu,
        webGpuAvailable: textureAirbrushNativeWebGpuAvailable(globalThis),
        renderer: this.renderer,
        webGpuDisabled: this.textureAirbrushWebGpuDisabled === true,
        webGlDisabled: this.textureAirbrushGpuDisabled === true,
        visibleSurfaceMaskRequired: options.visibleSurfaceMaskRequired === true
          || options.liveProjectedPaint === true,
        visibleSurfaceMaskReady: options.visibleSurfaceMaskReady === true
          || Boolean(options.visibilityMaskPixels)
      });
      this.textureAirbrushLastBackend = resolved;
      return resolved;
    },

    textureAirbrushReportWebGpuFallback(resolved = this.textureAirbrushLastBackend) {
      const status = resolved?.webGpuStatus || "";
      if (!status || status === "ready" || status === "not-requested" || this.textureAirbrushWebGpuFallbackStatus === status) {
        return;
      }
      this.textureAirbrushWebGpuFallbackStatus = status;
      const labels = {
        unavailable: "WebGPU is not available in this browser; airbrush is using the WebGL shader brush.",
        disabled: "WebGPU airbrush was disabled after an error; using the WebGL shader brush.",
        "needs-webgpu-renderer": "WebGPU airbrush needs the viewer renderer to run on native WebGPU first; using the WebGL shader brush.",
        "renderer-webgl-fallback": "Three.js fell back from WebGPU to WebGL; airbrush is using the WebGL shader brush.",
        "backend-uninitialized": "WebGPU renderer is not ready yet; airbrush is using the WebGL shader brush.",
        "source-pixels-missing": "WebGPU airbrush needs source texture pixels before dispatch; using the WebGL shader brush.",
        "brush-kernel-unimplemented": "WebGPU airbrush backend is selected, but the brush dispatch path is not fully connected yet; using the WebGL shader brush.",
        "dispatch-failed": "WebGPU airbrush dispatch failed; using the WebGL shader brush.",
        "visible-surface-mask-required": "Live airbrush needs the camera-visible depth/normal mask; using the WebGL projection brush.",
        "visible-surface-mask-unavailable": "Live airbrush needs a native WebGPU visible-surface mask before it can run under the WebGPU renderer."
      };
      const message = labels[status] || `WebGPU airbrush is not ready (${status}); using the WebGL shader brush.`;
      console.info(message);
      this.setStatus?.(message);
    },

    textureAirbrushWebGpuDevice() {
      return textureAirbrushWebGpuDeviceFromRenderer(this.renderer);
    },

    textureAirbrushEditableWebGpuPayload(editable, options = {}) {
      return textureAirbrushEditableWebGpuPayload(this, editable, options);
    },

    textureAirbrushRunEditableWebGpuPaint(editable, options = {}) {
      return textureAirbrushRunEditableWebGpuPaint(this, editable, options);
    },

    textureAirbrushPrewarmEditableWebGpuPaint(editable, options = {}) {
      return textureAirbrushPrewarmEditableWebGpuPaint(this, editable, options);
    },

    textureAirbrushInvalidateWebGpuCache(editableOrTexture) {
      return textureAirbrushInvalidateWebGpuCache(this, editableOrTexture);
    },

    textureAirbrushWebGpuKernelPayload(options = {}) {
      const defaults = {
        radiusPixels: this.textureBrushRadiusScreenPixels?.() || 24,
        opacity: this.textureAirbrushOpacity?.() ?? 0.42,
        hardness: this.textureAirbrushHardness?.() ?? 0.35,
        scatter: this.textureAirbrushScatter?.() ?? 0.35,
        color: this.textureAirbrushColor?.() || { r: 255, g: 255, b: 255 }
      };
      const plan = textureAirbrushWebGpuPaintPlan({
        width: options.textureWidth || options.width || this.canvas?.width || 1,
        height: options.textureHeight || options.height || this.canvas?.height || 1,
        options,
        defaults
      });
      return {
        params: plan.params,
        plan,
        source: textureAirbrushWebGpuKernelSource()
      };
    },

    textureAirbrushDispatchWebGpuKernel(payload, options = {}) {
      const device = options.device || this.textureAirbrushWebGpuDevice?.();
      const editableSource = options.editable
        ? textureAirbrushSourcePixelsFromEditable(options.editable)
        : null;
      const sourcePixels = options.sourcePixels || options.sourcePixelData || editableSource?.sourcePixels || null;
      if (!device || !payload || !sourcePixels) {
        return null;
      }
      return textureAirbrushRunWebGpuPaint(device, payload, {
        sourcePixels,
        visibilityMaskPixels: options.visibilityMaskPixels || null,
        readback: options.readback === true,
        label: "texture-airbrush"
      });
    },

    textureAirbrushWebGpuProjectFromEvent(event = null, options = {}) {
      const editablePayload = options.editable
        ? this.textureAirbrushEditableWebGpuPayload?.(options.editable, options)
        : null;
      this.textureAirbrushLastWebGpuKernel = editablePayload?.payload || this.textureAirbrushWebGpuKernelPayload?.(options);
      const dispatch = this.textureAirbrushDispatchWebGpuKernel?.(this.textureAirbrushLastWebGpuKernel, {
        ...options,
        ...(editablePayload?.sourcePixels ? { sourcePixels: editablePayload.sourcePixels } : {})
      });
      if (dispatch?.result) {
        this.textureAirbrushLastWebGpuDispatch = dispatch;
        const estimate = options.webGpuChangedEstimate
          ?? Math.max(1, this.textureAirbrushLastWebGpuKernel?.plan?.width || 1);
        this.setStatus?.(`WebGPU airbrush dispatched ${this.textureAirbrushLastWebGpuKernel?.plan?.dispatch?.x || 1}x${this.textureAirbrushLastWebGpuKernel?.plan?.dispatch?.y || 1} workgroups`);
        return estimate;
      }
      this.textureAirbrushReportWebGpuFallback?.({
        webGpuStatus: options.sourcePixels || options.sourcePixelData
          ? "dispatch-failed"
          : "source-pixels-missing"
      });
      return 0;
    }
  });
  installTextureAirbrushWebGpuDiagnosticMethods(BirdWeightEditor);
  installTextureAirbrushWebGpuLiveMethods(BirdWeightEditor);
  installTextureAirbrushWebGpuPrewarmMethods(BirdWeightEditor);
}
