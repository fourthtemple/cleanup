import {
  textureAirbrushRunWebGpuPaint,
  textureAirbrushWebGpuDeviceFromRenderer
} from "./webgpu-dispatch.js";
import {
  textureAirbrushCancelDeferredWebGpuCanvasSync,
  textureAirbrushEditableWebGpuPayload,
  textureAirbrushInvalidateWebGpuCache,
  textureAirbrushPrewarmEditableWebGpuPaint,
  textureAirbrushReleaseDeferredWebGpuReadbackStarts,
  textureAirbrushRunEditableWebGpuPaint,
  textureAirbrushSyncDeferredWebGpuCanvasReadbacks,
  textureAirbrushSourcePixelsFromEditable
} from "./webgpu-canvas.js";
import { installTextureAirbrushWebGpuDiagnosticMethods } from "./webgpu-diagnostics.js";
import {
  textureAirbrushWebGpuKernelSource,
  textureAirbrushWebGpuProjectedRenderSource
} from "./webgpu-kernel.js";
import { textureAirbrushWebGpuPaintPlan } from "./webgpu-plan.js";
import { installTextureAirbrushWebGpuLiveMethods } from "./webgpu-live.js";
import { installTextureAirbrushWebGpuPrewarmMethods } from "./webgpu-prewarm.js";
import {
  resolveTextureAirbrushBackend,
  resolveTextureAirbrushRendererMode,
  textureAirbrushNativeWebGpuAvailable
} from "./webgpu-resolver.js";

function textureAirbrushDebugSearchHas(name) {
  return typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has(name);
}

function textureAirbrushDebugSearchNumber(name, fallback) {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = Number(new URLSearchParams(window.location?.search || "").get(name));
  return Number.isFinite(value) ? value : fallback;
}

function textureAirbrushDebugRoot() {
  return typeof window !== "undefined" ? window.document?.documentElement || null : null;
}

function textureAirbrushRecordTslSelfTest(payload) {
  const root = textureAirbrushDebugRoot();
  if (root?.dataset) {
    root.dataset.textureAirbrushDebugTslSelfTest = JSON.stringify(payload);
  }
}

function textureAirbrushRecordRenderTargetSelfTest(payload) {
  const root = textureAirbrushDebugRoot();
  if (root?.dataset) {
    root.dataset.textureAirbrushDebugRenderTargetSelfTest = JSON.stringify(payload);
  }
}

function textureAirbrushRecordRenderedSnapshot(payload) {
  const root = textureAirbrushDebugRoot();
  if (root?.dataset) {
    root.dataset.textureAirbrushDebugRenderedSnapshot = JSON.stringify(payload);
  }
}

function textureAirbrushReadbackStats(bytes, width, height, bytesPerRowOverride = null) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const safeHeight = Math.max(1, Math.floor(Number(height) || 1));
  const bytesPerPixel = 4;
  const explicitBytesPerRow = Math.floor(Number(bytesPerRowOverride));
  const bytesPerRow = Number.isFinite(explicitBytesPerRow) && explicitBytesPerRow >= safeWidth * bytesPerPixel
    ? explicitBytesPerRow
    : Math.ceil((safeWidth * bytesPerPixel) / 256) * 256;
  let nonBlack = 0;
  let greenDominant = 0;
  let maxGreen = 0;
  for (let y = 0; y < safeHeight; y += 1) {
    const row = y * bytesPerRow;
    for (let x = 0; x < safeWidth; x += 1) {
      const index = row + x * bytesPerPixel;
      const r = bytes[index] || 0;
      const g = bytes[index + 1] || 0;
      const b = bytes[index + 2] || 0;
      const a = bytes[index + 3] || 0;
      if (r || g || b || a) {
        nonBlack += 1;
      }
      if (g > r + 16 && g > b + 16) {
        greenDominant += 1;
      }
      maxGreen = Math.max(maxGreen, g);
    }
  }
  return {
    width: safeWidth,
    height: safeHeight,
    bytesPerRow,
    nonBlack,
    greenDominant,
    maxGreen
  };
}

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

export function installTextureAirbrushWebGpuMethods(BirdWeightEditor, deps = {}) {
  const THREE = deps?.THREE || globalThis.THREE || null;
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushWebGpuRequested() {
      return true;
    },

    textureAirbrushWebGpuRendererRequested() {
      return true;
    },

    textureAirbrushResolveRendererMode(options = {}) {
      const resolved = resolveTextureAirbrushRendererMode({
        webGpuAvailable: textureAirbrushNativeWebGpuAvailable(globalThis),
        WebGPURenderer: options.WebGPURenderer,
        webGpuRendererDisabled: this.textureAirbrushWebGpuRendererDisabled === true
      });
      this.textureAirbrushLastRendererMode = resolved;
      return resolved;
    },

    textureAirbrushResolveBackend(options = {}) {
      const resolved = resolveTextureAirbrushBackend({
        webGpuAvailable: textureAirbrushNativeWebGpuAvailable(globalThis),
        renderer: this.renderer,
        webGpuDisabled: this.textureAirbrushWebGpuDisabled === true,
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
        unavailable: "WebGPU is not available in this browser; airbrush paint was not applied.",
        disabled: "WebGPU airbrush was disabled after an error; airbrush paint was not applied.",
        "needs-webgpu-renderer": "WebGPU airbrush needs the viewer renderer to run on native WebGPU first.",
        "native-webgpu-required": "WebGPU airbrush requires a native WebGPU renderer backend; airbrush paint was not applied.",
        "backend-uninitialized": "WebGPU renderer is not ready yet; airbrush paint was not applied.",
        "source-pixels-missing": "WebGPU airbrush needs source texture pixels before dispatch; airbrush paint was not applied.",
        "brush-kernel-unimplemented": "WebGPU airbrush backend is selected, but the brush dispatch path is not fully connected yet.",
        "dispatch-failed": "WebGPU airbrush dispatch failed; airbrush paint was not applied.",
        "visible-surface-mask-required": "Live airbrush needs the camera-facing normal observability mask; WebGPU paint was not applied.",
        "visible-surface-mask-unavailable": "Live airbrush needs a native WebGPU visible-surface mask before it can run under the WebGPU renderer.",
        "live-display-unavailable": "WebGPU airbrush painted no visible surface because the live display texture was unavailable."
      };
      const message = labels[status] || `WebGPU airbrush is not ready (${status}); airbrush paint was not applied.`;
      console.info(message);
      this.setStatus?.(message);
    },

    textureAirbrushWebGpuDevice() {
      const device = textureAirbrushWebGpuDeviceFromRenderer(this.renderer);
      if (device) {
        this.textureAirbrushMaybeRunTslSelfTest?.();
      }
      return device;
    },

    textureAirbrushMaybeRunTslSelfTest() {
      if (!textureAirbrushDebugSearchHas("debugAirbrushTslSelfTest")) {
        return null;
      }
      if (this.textureAirbrushTslSelfTestPromise) {
        return this.textureAirbrushTslSelfTestPromise;
      }
      textureAirbrushRecordTslSelfTest({ status: "running" });
      this.textureAirbrushTslSelfTestPromise = Promise.all([
        this.textureAirbrushRunTslSelfTest?.(),
        this.textureAirbrushRunRenderTargetSelfTest?.()
      ])
        .catch((error) => {
          const result = {
            status: "error",
            message: error?.message || String(error || "")
          };
          textureAirbrushRecordTslSelfTest(result);
          return result;
        });
      return this.textureAirbrushTslSelfTestPromise;
    },

    async textureAirbrushRunTslSelfTest() {
      const width = 8;
      const height = 8;
      const renderer = this.renderer || null;
      const tsl = THREE?.TSL || null;
      if (!renderer?.isWebGPURenderer || !renderer?.backend?.isWebGPUBackend) {
        throw new Error("WebGPU renderer backend is not ready");
      }
      if (
        typeof THREE?.StorageTexture !== "function"
        || typeof tsl?.Fn !== "function"
        || typeof tsl?.attributeArray !== "function"
        || typeof tsl?.textureStore !== "function"
      ) {
        throw new Error("Three TSL compute helpers are not available");
      }
      const storageTexture = new THREE.StorageTexture(width, height);
      storageTexture.name = "texture-airbrush-tsl-self-test";
      storageTexture.internalFormat = "rgba8unorm";
      storageTexture.mipmapsAutoUpdate = false;

      const { Fn, attributeArray, instanceIndex, textureStore, uint, uvec2, vec4 } = tsl;
      const computeTexture = Fn(({ target }) => {
        const x = instanceIndex.mod(width);
        const y = instanceIndex.div(width);
        textureStore(target, uvec2(x, y), vec4(0.0, 1.0, 0.0, 1.0)).toWriteOnly();
      });
      const computeNode = computeTexture({ target: storageTexture }).compute(width * height);
      await renderer.computeAsync(computeNode);
      const readback = await renderer.backend.copyTextureToBuffer(storageTexture, 0, 0, width, height, 0);
      const bytes = Array.from(new Uint8Array(readback.buffer, readback.byteOffset || 0, readback.byteLength));

      const storageValues = attributeArray(4, "uint");
      storageValues.value.name = "texture-airbrush-tsl-buffer-self-test";
      const computeBuffer = Fn(() => {
        storageValues.element(instanceIndex).assign(instanceIndex.add(uint(1)).mul(uint(17)));
      })().compute(4);
      await renderer.computeAsync(computeBuffer);
      const bufferReadback = await renderer.getArrayBufferAsync(storageValues.value);
      const bufferValues = Array.from(new Uint32Array(bufferReadback));
      const result = {
        status: "complete",
        renderer: renderer.constructor?.name || "",
        backend: renderer.backend?.constructor?.name || "",
        stats: textureAirbrushReadbackStats(bytes, width, height),
        bufferValues,
        head: bytes.slice(0, 64)
      };
      this.textureAirbrushLastTslSelfTest = result;
      textureAirbrushRecordTslSelfTest(result);
      return result;
    },

    async textureAirbrushRunRenderTargetSelfTest() {
      const width = 8;
      const height = 8;
      const renderer = this.renderer || null;
      const RenderTarget = THREE?.RenderTarget || null;
      if (!renderer?.isWebGPURenderer || !renderer?.backend?.isWebGPUBackend) {
        throw new Error("WebGPU renderer backend is not ready");
      }
      if (
        typeof RenderTarget !== "function"
        || typeof THREE?.Scene !== "function"
        || typeof THREE?.OrthographicCamera !== "function"
        || typeof THREE?.PlaneGeometry !== "function"
        || typeof THREE?.MeshBasicMaterial !== "function"
        || typeof THREE?.Mesh !== "function"
      ) {
        throw new Error("Three render target helpers are not available");
      }
      const previousTarget = typeof renderer.getRenderTarget === "function"
        ? renderer.getRenderTarget()
        : null;
      const previousAutoClear = renderer.autoClear;
      const target = new RenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false
      });
      target.texture.name = "texture-airbrush-render-target-self-test";
      target.texture.colorSpace = THREE.NoColorSpace || target.texture.colorSpace;
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({
          color: 0x00ff00,
          transparent: false,
          depthTest: false,
          depthWrite: false
        })
      );
      scene.add(mesh);
      try {
        renderer.setRenderTarget(target);
        renderer.autoClear = true;
        renderer.clear();
        renderer.render(scene, camera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
      }
      const readback = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
      const bytes = Array.from(new Uint8Array(readback.buffer, readback.byteOffset || 0, readback.byteLength));
      const result = {
        status: "complete",
        renderer: renderer.constructor?.name || "",
        backend: renderer.backend?.constructor?.name || "",
        stats: textureAirbrushReadbackStats(bytes, width, height, width * 4),
        head: bytes.slice(0, 64)
      };
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
      target.dispose?.();
      this.textureAirbrushLastRenderTargetSelfTest = result;
      textureAirbrushRecordRenderTargetSelfTest(result);
      return result;
    },

    async textureAirbrushExposeRenderedSnapshot(detail = {}) {
      if (!textureAirbrushDebugSearchHas("debugAirbrushRenderSnapshot")) {
        return null;
      }
      const renderer = this.renderer || null;
      const RenderTarget = THREE?.RenderTarget || null;
      const documentRef = typeof window !== "undefined" ? window.document || null : null;
      if (
        !documentRef
        || !renderer?.isWebGPURenderer
        || !renderer?.backend?.isWebGPUBackend
        || typeof RenderTarget !== "function"
        || !this.scene
        || !this.camera
        || !this.canvas
      ) {
        return null;
      }
      const rect = typeof this.canvas.getBoundingClientRect === "function"
        ? this.canvas.getBoundingClientRect()
        : null;
      const sourceWidth = Math.max(1, Math.floor(Number(rect?.width) || Number(this.canvas.clientWidth) || Number(this.canvas.width) || 1));
      const sourceHeight = Math.max(1, Math.floor(Number(rect?.height) || Number(this.canvas.clientHeight) || Number(this.canvas.height) || 1));
      const maxSize = Math.max(64, Math.min(2048, Math.floor(textureAirbrushDebugSearchNumber("debugAirbrushRenderSnapshotSize", 960))));
      const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const target = new RenderTarget(width, height, {
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false
      });
      target.texture.name = "texture-airbrush-rendered-debug-snapshot";
      target.texture.colorSpace = THREE.SRGBColorSpace || target.texture.colorSpace;
      const previousTarget = typeof renderer.getRenderTarget === "function"
        ? renderer.getRenderTarget()
        : null;
      const previousAutoClear = renderer.autoClear;
      const previousAspect = this.camera.aspect;
      try {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix?.();
        this.controls?.update?.();
        renderer.setRenderTarget(target);
        renderer.autoClear = true;
        renderer.clear?.();
        renderer.render(this.scene, this.camera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
        this.camera.aspect = previousAspect;
        this.camera.updateProjectionMatrix?.();
      }
      let readback = null;
      try {
        readback = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
      } catch (error) {
        target.dispose?.();
        const result = {
          status: "failed",
          reason: String(error?.message || error),
          width,
          height,
          label: detail.label || ""
        };
        textureAirbrushRecordRenderedSnapshot(result);
        return result;
      }
      const sourceBytes = new Uint8ClampedArray(readback.buffer, readback.byteOffset || 0, readback.byteLength);
      const canvas = documentRef.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        target.dispose?.();
        return null;
      }
      const image = context.createImageData(width, height);
      for (let y = 0; y < height; y += 1) {
        const sourceRow = y * width * 4;
        const targetRow = y * width * 4;
        image.data.set(sourceBytes.subarray(sourceRow, sourceRow + width * 4), targetRow);
      }
      context.putImageData(image, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      let snapshotImage = documentRef.getElementById("texture-airbrush-debug-render-snapshot");
      if (!snapshotImage) {
        snapshotImage = documentRef.createElement("img");
        snapshotImage.id = "texture-airbrush-debug-render-snapshot";
        snapshotImage.alt = "Rendered airbrush debug snapshot";
        snapshotImage.style.cssText = "position:fixed;right:8px;top:8px;z-index:2147483647;max-width:320px;max-height:320px;border:1px solid #3ee66b;background:#000;display:none;";
        documentRef.body?.appendChild?.(snapshotImage);
      }
      snapshotImage.src = dataUrl;
      const stats = textureAirbrushReadbackStats(Array.from(sourceBytes), width, height, width * 4);
      const result = {
        status: "complete",
        width,
        height,
        byteLength: dataUrl.length,
        label: detail.label || "",
        stats
      };
      const root = textureAirbrushDebugRoot();
      if (root?.dataset) {
        root.dataset.textureAirbrushDebugRenderedSnapshotCount = String(
          Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugRenderedSnapshotCount) || 0)) + 1
        );
        root.dataset.textureAirbrushDebugRenderedSnapshotSize = JSON.stringify({ width, height });
        root.dataset.textureAirbrushDebugRenderedSnapshotStats = JSON.stringify(stats);
        root.dataset.textureAirbrushDebugRenderedSnapshotLabel = detail.label || "";
      }
      textureAirbrushRecordRenderedSnapshot(result);
      target.dispose?.();
      return result;
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

    textureAirbrushReleaseDeferredWebGpuReadbacks() {
      return textureAirbrushReleaseDeferredWebGpuReadbackStarts(this);
    },

    textureAirbrushCancelDeferredWebGpuCanvasSync() {
      return textureAirbrushCancelDeferredWebGpuCanvasSync(this);
    },

    textureAirbrushSyncDeferredWebGpuCanvases(options = {}) {
      return textureAirbrushSyncDeferredWebGpuCanvasReadbacks(this, options);
    },

    textureAirbrushCreateExternalWebGpuTexture(gpuTexture = null, referenceTexture = null, options = {}) {
      if (!gpuTexture || typeof THREE?.ExternalTexture !== "function") {
        return null;
      }
      const texture = options.reuseTexture instanceof THREE.ExternalTexture
        && options.reuseTexture.sourceTexture === gpuTexture
        ? options.reuseTexture
        : new THREE.ExternalTexture(gpuTexture);
      const mipmapMinFilters = new Set([
        THREE.NearestMipmapNearestFilter,
        THREE.NearestMipmapLinearFilter,
        THREE.LinearMipmapNearestFilter,
        THREE.LinearMipmapLinearFilter
      ].filter((value) => value !== undefined && value !== null));
      const referenceMinFilter = referenceTexture?.minFilter;
      texture.name = options.name || `${referenceTexture?.name || "texture"} WebGPU live paint`;
      texture.image = {
        width: Math.max(1, Math.floor(Number(options.width || referenceTexture?.image?.width) || 1)),
        height: Math.max(1, Math.floor(Number(options.height || referenceTexture?.image?.height) || 1))
      };
      texture.colorSpace = options.colorSpace ?? referenceTexture?.colorSpace ?? texture.colorSpace;
      texture.flipY = options.flipY ?? referenceTexture?.flipY ?? texture.flipY;
      if (referenceTexture && "channel" in referenceTexture) {
        texture.channel = referenceTexture.channel;
      }
      texture.wrapS = referenceTexture?.wrapS || texture.wrapS;
      texture.wrapT = referenceTexture?.wrapT || texture.wrapT;
      const nonMipmapFilter = THREE.NearestFilter || THREE.LinearFilter || texture.minFilter;
      texture.magFilter = options.mipmapped === true
        ? referenceTexture?.magFilter || texture.magFilter
        : referenceTexture?.magFilter || texture.magFilter;
      texture.minFilter = options.mipmapped === true || !mipmapMinFilters.has(referenceMinFilter)
        ? referenceMinFilter || texture.minFilter
        : nonMipmapFilter;
      texture.anisotropy = referenceTexture?.anisotropy || texture.anisotropy;
      texture.generateMipmaps = options.mipmapped === true;
      if (referenceTexture?.offset && texture.offset) {
        texture.offset.copy(referenceTexture.offset);
      }
      if (referenceTexture?.repeat && texture.repeat) {
        texture.repeat.copy(referenceTexture.repeat);
      }
      if (referenceTexture?.center && texture.center) {
        texture.center.copy(referenceTexture.center);
      }
      texture.rotation = referenceTexture?.rotation || 0;
      texture.matrixAutoUpdate = referenceTexture?.matrixAutoUpdate ?? true;
      if (referenceTexture?.matrix && texture.matrix) {
        texture.matrix.copy(referenceTexture.matrix);
      }
      texture.userData = {
        ...(texture.userData || {}),
        textureAirbrushExternalWebGpuDisplay: true,
        textureAirbrushDisplayMipmapped: options.mipmapped === true,
        textureAirbrushReferenceMinFilter: referenceMinFilter,
        textureAirbrushNonMipmapMinFilter: nonMipmapFilter,
        textureAirbrushNonMipmapMagFilter: referenceTexture?.magFilter || texture.magFilter,
        textureAirbrushWebGpuCanvasMap: referenceTexture || null
      };
      texture.needsUpdate = true;
      return texture;
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
      const source = textureAirbrushWebGpuKernelSource();
      const projectedRenderSource = textureAirbrushWebGpuProjectedRenderSource();
      if (
        typeof window !== "undefined"
      ) {
        const params = new URLSearchParams(window.location?.search || "");
        if (!params.has("debugAirbrush")) {
          return {
            params: plan.params,
            plan,
            source,
            projectedRenderSource
          };
        }
        const root = window.document?.documentElement || null;
        if (root?.dataset) {
          root.dataset.textureAirbrushDebugKernelForcePaintBounds = String(params.has("debugAirbrushForcePaintBounds"));
          root.dataset.textureAirbrushDebugKernelForceOrigin = String(params.has("debugAirbrushForceOrigin"));
          root.dataset.textureAirbrushDebugKernelBypassVisibility = String(params.has("debugAirbrushBypassVisibility"));
          root.dataset.textureAirbrushDebugKernelPlanPaintBounds = JSON.stringify(plan.paintBounds || null);
          root.dataset.textureAirbrushDebugKernelPlanPaintRegions = JSON.stringify(plan.paintRegions || []);
          root.dataset.textureAirbrushDebugKernelOptionPaintBounds = JSON.stringify(options.paintBounds || null);
        }
      }
      return {
        params: plan.params,
        plan,
        source,
        projectedRenderSource
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
