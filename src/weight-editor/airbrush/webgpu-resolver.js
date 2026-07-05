export const TEXTURE_AIRBRUSH_WEBGPU_QUERY_PARAM = "webgpu-airbrush";
export const TEXTURE_AIRBRUSH_WEBGPU_RENDERER_QUERY_PARAM = "webgpu-renderer";

export function textureAirbrushWebGpuRequestedFromSearch(search = "") {
  void search;
  return true;
}

export function textureAirbrushWebGpuRendererRequestedFromSearch(search = "") {
  void search;
  return true;
}

export function textureAirbrushNativeWebGpuAvailable(scope = globalThis) {
  return Boolean(scope?.navigator?.gpu);
}

export function textureAirbrushRendererWebGpuState(renderer = null) {
  const backend = renderer?.backend || null;
  return {
    isWebGpuRenderer: renderer?.isWebGPURenderer === true,
    isNativeWebGpuBackend: backend?.isWebGPUBackend === true
  };
}

export function resolveTextureAirbrushRendererMode({
  preferWebGpuRenderer = true,
  webGpuAvailable = false,
  WebGPURenderer = null,
  webGpuRendererDisabled = false
} = {}) {
  void preferWebGpuRenderer;
  if (webGpuRendererDisabled) {
    return {
      renderer: "none",
      webGpuRendererStatus: "disabled"
    };
  }
  if (!webGpuAvailable) {
    return {
      renderer: "none",
      webGpuRendererStatus: "unavailable"
    };
  }
  if (typeof WebGPURenderer !== "function") {
    return {
      renderer: "none",
      webGpuRendererStatus: "renderer-class-unavailable"
    };
  }
  return {
    renderer: "webgpu",
    webGpuRendererStatus: "ready"
  };
}

export function resolveTextureAirbrushBackend({
  preferWebGpu = true,
  webGpuAvailable = false,
  renderer = null,
  webGpuDisabled = false,
  visibleSurfaceMaskRequired = false,
  visibleSurfaceMaskReady = false
} = {}) {
  void preferWebGpu;
  const rendererState = textureAirbrushRendererWebGpuState(renderer);
  if (visibleSurfaceMaskRequired && !visibleSurfaceMaskReady) {
    return {
      backend: "none",
      webGpuStatus: "visible-surface-mask-unavailable"
    };
  }
  if (webGpuDisabled) {
    return {
      backend: "none",
      webGpuStatus: "disabled"
    };
  }
  if (!webGpuAvailable) {
    return {
      backend: "none",
      webGpuStatus: "unavailable"
    };
  }
  if (!rendererState.isWebGpuRenderer) {
    return {
      backend: "none",
      webGpuStatus: "needs-webgpu-renderer"
    };
  }
  if (!rendererState.isNativeWebGpuBackend) {
    return {
      backend: "none",
      webGpuStatus: "native-webgpu-required"
    };
  }
  return {
    backend: "webgpu",
    webGpuStatus: "ready"
  };
}
