export const TEXTURE_AIRBRUSH_WEBGPU_QUERY_PARAM = "webgpu-airbrush";
export const TEXTURE_AIRBRUSH_WEBGPU_RENDERER_QUERY_PARAM = "webgpu-renderer";

const TRUE_QUERY_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_QUERY_VALUES = new Set(["0", "false", "no", "off"]);

function queryFlagValue(search, keys = [], defaultValue = false) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  for (const key of keys) {
    if (!params.has(key)) {
      continue;
    }
    const value = String(params.get(key) || "").trim().toLowerCase();
    if (TRUE_QUERY_VALUES.has(value)) {
      return true;
    }
    if (FALSE_QUERY_VALUES.has(value)) {
      return false;
    }
  }
  return defaultValue;
}

export function textureAirbrushWebGpuRequestedFromSearch(search = "") {
  // Prefer the WebGPU compute path when it is safe for the requested operation.
  // Live projected airbrush still passes visibleSurfaceMaskRequired so the
  // unmasked texture kernel cannot paint hidden/non-visible UV islands.
  return queryFlagValue(search, [
    TEXTURE_AIRBRUSH_WEBGPU_QUERY_PARAM,
    "airbrush-webgpu"
  ], true);
}

export function textureAirbrushWebGpuRendererRequestedFromSearch(search = "") {
  // Keep the renderer opt-in until the scene materials and live airbrush
  // projection shader have a native WebGPU equivalent. Defaulting this on makes
  // the current character render as a black silhouette in runtime validation.
  return queryFlagValue(search, [
    TEXTURE_AIRBRUSH_WEBGPU_RENDERER_QUERY_PARAM,
    "renderer-webgpu"
  ], false);
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
  webGlDisabled = false,
  visibleSurfaceMaskRequired = false,
  visibleSurfaceMaskReady = false
} = {}) {
  const rendererState = textureAirbrushRendererWebGpuState(renderer);
  if (preferWebGpu) {
    if (visibleSurfaceMaskRequired && !visibleSurfaceMaskReady) {
      const webGlProjectionAvailable = webGlDisabled !== true
        && (
          !rendererState.isWebGpuRenderer
          || renderer?.isWebGLRenderer === true
          || rendererState.isWebGlFallbackBackend === true
        );
      return {
        backend: webGlProjectionAvailable ? "webgl" : "none",
        webGpuStatus: webGlProjectionAvailable
          ? "visible-surface-mask-required"
          : "visible-surface-mask-unavailable"
      };
    }
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
