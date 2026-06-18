export const TEXTURE_AIRBRUSH_WEBGPU_QUERY_PARAM = "webgpu-airbrush";
export const TEXTURE_AIRBRUSH_WEBGPU_RENDERER_QUERY_PARAM = "webgpu-renderer";

const TRUE_QUERY_VALUES = new Set(["1", "true", "yes", "on"]);

function queryFlagValue(search, keys = []) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  for (const key of keys) {
    const value = params.get(key);
    if (TRUE_QUERY_VALUES.has(String(value || "").trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function textureAirbrushWebGpuRequestedFromSearch(search = "") {
  return queryFlagValue(search, [
    TEXTURE_AIRBRUSH_WEBGPU_QUERY_PARAM,
    "airbrush-webgpu"
  ]);
}

export function textureAirbrushWebGpuRendererRequestedFromSearch(search = "") {
  return queryFlagValue(search, [
    TEXTURE_AIRBRUSH_WEBGPU_RENDERER_QUERY_PARAM,
    "renderer-webgpu"
  ]);
}

export function textureAirbrushNativeWebGpuAvailable(scope = globalThis) {
  return Boolean(scope?.navigator?.gpu);
}

export function textureAirbrushRendererWebGpuState(renderer = null) {
  const backend = renderer?.backend || null;
  return {
    isWebGpuRenderer: renderer?.isWebGPURenderer === true,
    isNativeWebGpuBackend: backend?.isWebGPUBackend === true && backend?.isWebGLBackend !== true,
    isWebGlFallbackBackend: backend?.isWebGLBackend === true
  };
}

export function resolveTextureAirbrushRendererMode({
  preferWebGpuRenderer = false,
  webGpuAvailable = false,
  WebGPURenderer = null,
  webGpuRendererDisabled = false
} = {}) {
  if (!preferWebGpuRenderer) {
    return {
      renderer: "webgl",
      webGpuRendererStatus: "not-requested"
    };
  }
  if (webGpuRendererDisabled) {
    return {
      renderer: "webgl",
      webGpuRendererStatus: "disabled"
    };
  }
  if (!webGpuAvailable) {
    return {
      renderer: "webgl",
      webGpuRendererStatus: "unavailable"
    };
  }
  if (typeof WebGPURenderer !== "function") {
    return {
      renderer: "webgl",
      webGpuRendererStatus: "renderer-class-unavailable"
    };
  }
  return {
    renderer: "webgpu",
    webGpuRendererStatus: "ready"
  };
}

export function resolveTextureAirbrushBackend({
  preferWebGpu = false,
  webGpuAvailable = false,
  renderer = null,
  webGpuDisabled = false,
  webGlDisabled = false
} = {}) {
  const rendererState = textureAirbrushRendererWebGpuState(renderer);
  if (preferWebGpu) {
    if (webGpuDisabled) {
      return {
        backend: webGlDisabled ? "cpu" : "webgl",
        webGpuStatus: "disabled"
      };
    }
    if (!webGpuAvailable) {
      return {
        backend: webGlDisabled ? "cpu" : "webgl",
        webGpuStatus: "unavailable"
      };
    }
    if (!rendererState.isWebGpuRenderer) {
      return {
        backend: webGlDisabled ? "cpu" : "webgl",
        webGpuStatus: "needs-webgpu-renderer"
      };
    }
    if (!rendererState.isNativeWebGpuBackend) {
      return {
        backend: webGlDisabled ? "cpu" : "webgl",
        webGpuStatus: rendererState.isWebGlFallbackBackend ? "renderer-webgl-fallback" : "backend-uninitialized"
      };
    }
    return {
      backend: "webgpu",
      webGpuStatus: "ready"
    };
  }
  return {
    backend: webGlDisabled ? "cpu" : "webgl",
    webGpuStatus: "not-requested"
  };
}
