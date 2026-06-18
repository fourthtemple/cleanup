import { textureAirbrushRunWebGpuPaint } from "./webgpu-dispatch.js";
import { textureAirbrushReadWebGpuPaintResult } from "./webgpu-readback.js";
import {
  resolveTextureAirbrushBackend,
  resolveTextureAirbrushRendererMode,
  textureAirbrushNativeWebGpuAvailable,
  textureAirbrushRendererWebGpuState
} from "./webgpu-resolver.js";

function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function countPaintedPixels(pixels = null) {
  if (!pixels?.byteLength) {
    return 0;
  }
  let count = 0;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    if (
      pixels[offset] > 0
      || pixels[offset + 1] > 0
      || pixels[offset + 2] > 0
      || pixels[offset + 3] > 0
    ) {
      count += 1;
    }
  }
  return count;
}

function maxPaintChannel(pixels = null) {
  if (!pixels?.byteLength) {
    return 0;
  }
  let max = 0;
  for (let index = 0; index < pixels.byteLength; index += 1) {
    max = Math.max(max, pixels[index]);
  }
  return max;
}

export function installTextureAirbrushWebGpuDiagnosticMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushWebGpuRuntimeStatus(options = {}) {
      const scope = options.scope || globalThis;
      const nativeWebGpuAvailable = textureAirbrushNativeWebGpuAvailable(scope);
      const rendererRequested = options.webgpuRenderer === true || this.textureAirbrushWebGpuRendererRequested?.() === true;
      const airbrushRequested = options.webgpu === true || this.textureAirbrushWebGpuRequested?.() === true;
      const resolvedRendererMode = resolveTextureAirbrushRendererMode({
        preferWebGpuRenderer: rendererRequested,
        webGpuAvailable: nativeWebGpuAvailable,
        WebGPURenderer: options.WebGPURenderer,
        webGpuRendererDisabled: this.textureAirbrushWebGpuRendererDisabled === true
      });
      const rendererMode = rendererRequested && this.textureAirbrushLastRendererMode
        ? this.textureAirbrushLastRendererMode
        : resolvedRendererMode;
      const rendererState = textureAirbrushRendererWebGpuState(this.renderer);
      const backend = resolveTextureAirbrushBackend({
        preferWebGpu: airbrushRequested,
        webGpuAvailable: nativeWebGpuAvailable,
        renderer: this.renderer,
        webGpuDisabled: this.textureAirbrushWebGpuDisabled === true,
        webGlDisabled: this.textureAirbrushGpuDisabled === true
      });
      const device = this.textureAirbrushWebGpuDevice?.() || null;
      const lastDispatchResult = this.textureAirbrushLastWebGpuDispatch?.result || null;
      const status = {
        requested: {
          renderer: rendererRequested,
          airbrush: airbrushRequested
        },
        nativeWebGpuAvailable,
        rendererMode,
        rendererState,
        rendererRuntime: this.textureAirbrushRendererMode || (rendererState.isWebGpuRenderer ? "webgpu" : "webgl"),
        rendererReady: this.textureAirbrushWebGpuRendererReady === true || rendererState.isNativeWebGpuBackend,
        backend,
        deviceReady: Boolean(device),
        airbrushReady: backend.backend === "webgpu" && Boolean(device),
        lastPaintStats: this.textureAirbrushLastWebGpuPaintStats || null,
        lastPrewarmStats: this.textureAirbrushLastWebGpuPrewarmStats || null,
        lastSelfTest: this.textureAirbrushLastWebGpuSelfTest || null,
        lastDispatch: lastDispatchResult
          ? {
              dispatch: lastDispatchResult.dispatch || null,
              hasCommandBuffer: Boolean(lastDispatchResult.commandBuffer),
              hasReadback: Boolean(lastDispatchResult.readbackBuffer)
            }
          : null
      };
      this.textureAirbrushLastRuntimeStatus = status;
      return status;
    },

    async textureAirbrushRunWebGpuSelfTest(options = {}) {
      const device = options.device || this.textureAirbrushWebGpuDevice?.();
      if (!device) {
        const result = {
          ok: false,
          status: "device-unavailable"
        };
        this.textureAirbrushLastWebGpuSelfTest = result;
        return result;
      }
      const width = positiveInteger(options.width, 4);
      const height = positiveInteger(options.height, 4);
      const sourcePixels = options.sourcePixels instanceof Uint8Array
        ? options.sourcePixels
        : new Uint8Array(width * height * 4);
      const payload = this.textureAirbrushWebGpuKernelPayload?.({
        width,
        height,
        textureWidth: width,
        textureHeight: height,
        radiusPixels: Math.max(0.75, Number(options.radiusPixels) || 2),
        opacity: Number.isFinite(Number(options.opacity)) ? Number(options.opacity) : 1,
        hardness: Number.isFinite(Number(options.hardness)) ? Number(options.hardness) : 1,
        scatter: Number.isFinite(Number(options.scatter)) ? Number(options.scatter) : 0,
        color: options.color || { r: 255, g: 0, b: 0 },
        strokeSegments: options.strokeSegments || [{
          start: { x: 0, y: 0 },
          end: { x: width - 1, y: height - 1 }
        }]
      });
      const run = textureAirbrushRunWebGpuPaint(device, payload, {
        sourcePixels,
        readback: true,
        label: options.label || "texture-airbrush-self-test"
      });
      if (!run?.result) {
        const result = {
          ok: false,
          status: "dispatch-failed",
          width,
          height
        };
        this.textureAirbrushLastWebGpuSelfTest = result;
        return result;
      }
      const pixels = await textureAirbrushReadWebGpuPaintResult(run.result, options);
      const paintedPixels = countPaintedPixels(pixels);
      const result = {
        ok: paintedPixels > 0,
        status: paintedPixels > 0 ? "ok" : "empty-readback",
        width,
        height,
        dispatch: run.result.dispatch || null,
        readbackBytes: pixels?.byteLength || 0,
        paintedPixels,
        maxChannel: maxPaintChannel(pixels)
      };
      this.textureAirbrushLastWebGpuSelfTest = result;
      return result;
    }
  });
}
