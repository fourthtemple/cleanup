import { installTextureAirbrushWebGlMaterialMethods } from "./webgl-materials.js";
import { installTextureAirbrushWebGlProjectMethods } from "./webgl-project.js?v=airbrush-smooth-coverage-20260618a";

function materialsForAirbrushRecord(record = null) {
  return Array.isArray(record?.object?.material)
    ? record.object.material
    : [record?.object?.material].filter(Boolean);
}

export function installTextureAirbrushWebGlBackendMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;
  installTextureAirbrushWebGlMaterialMethods(BirdWeightEditor, deps);
  installTextureAirbrushWebGlProjectMethods(BirdWeightEditor, deps);

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushCopyTextureToTarget(sourceTexture, destinationTarget) {
      if (!this.renderer || !sourceTexture || !destinationTarget) {
        return false;
      }
      this.textureAirbrushEnsureCopyScene?.();
      if (!this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera || !this.textureAirbrushGpuCopyMesh) {
        return false;
      }
      this.textureAirbrushCopyTextureRenderSettings?.(destinationTarget.texture, sourceTexture);
      if (sourceTexture.isRenderTargetTexture && typeof this.renderer.copyTextureToTexture === "function") {
        try {
          this.renderer.initRenderTarget?.(destinationTarget);
          this.renderer.copyTextureToTexture(sourceTexture, destinationTarget.texture);
          return true;
        } catch (error) {
          console.warn("Texture airbrush direct render-target copy failed; using shader copy", error);
        }
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      this.textureAirbrushGpuCopyMesh.material = this.textureAirbrushCopyMaterial(sourceTexture);
      this.textureAirbrushWithRawTextureMatrix(sourceTexture, () => {
        this.renderer.setRenderTarget(destinationTarget);
        this.renderer.autoClear = true;
        this.renderer.clear(true, true, true);
        this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
      });
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      return true;
    },

    textureAirbrushRenderTargetSizeForTexture(texture) {
      const image = texture?.image;
      const width = image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width || 0;
      const height = image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height || 0;
      return {
        width: Math.max(1, Math.min(4096, Math.round(width || 1024))),
        height: Math.max(1, Math.min(4096, Math.round(height || 1024)))
      };
    },

    textureAirbrushGpuUvBleedOffsets(targetEntry, radiusPixels = this.textureBrushRadiusScreenPixels?.() || 8) {
      const width = Math.max(1, targetEntry?.width || targetEntry?.target?.width || 1);
      const height = Math.max(1, targetEntry?.height || targetEntry?.target?.height || 1);
      const stepX = 1 / width;
      const stepY = 1 / height;
      const radius = Math.max(1, Number(radiusPixels) || 1);
      const radiusBand = radius > 16 ? "large" : radius > 9 ? "medium" : "small";
      const cacheKey = `${width}:${height}:${radiusBand}`;
      const cache = targetEntry && typeof targetEntry === "object"
        ? (targetEntry.uvBleedOffsetCache ||= new Map())
        : null;
      const cached = cache?.get(cacheKey);
      if (cached) {
        return cached;
      }
      let offsets = [[0, 0]];
      if (radius > 16) {
        offsets = [
          [0, 0],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
          [-2, 0],
          [2, 0],
          [0, -2],
          [0, 2]
        ];
      } else if (radius > 9) {
        offsets = [
          [0, 0],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ];
      }
      const vectors = offsets.map(([x, y]) => new THREE.Vector2(x * stepX, y * stepY));
      cache?.set(cacheKey, vectors);
      return vectors;
    },

    scheduleTextureAirbrushPrewarm(event = null, hit = null, options = {}) {
      const force = options.force === true;
      if (this.textureAirbrushPrewarmPending || (!force && this.activeTool !== "airbrush")) {
        return false;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (!force && this.textureAirbrushLastPrewarmAt && now - this.textureAirbrushLastPrewarmAt < 180) {
        return false;
      }
      this.textureAirbrushPendingPrewarmEvent = event
        ? { clientX: event.clientX, clientY: event.clientY }
        : this.textureAirbrushPendingPrewarmEvent || null;
      this.textureAirbrushPendingPrewarmHit = hit || this.textureAirbrushPendingPrewarmHit || null;
      this.textureAirbrushPrewarmPending = true;
      const run = () => {
        this.textureAirbrushPrewarmPending = false;
        this.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const pendingEvent = this.textureAirbrushPendingPrewarmEvent;
        const pendingHit = this.textureAirbrushPendingPrewarmHit;
        this.textureAirbrushPendingPrewarmEvent = null;
        this.textureAirbrushPendingPrewarmHit = null;
        this.textureAirbrushPrewarm?.(pendingEvent, pendingHit, { force });
      };
      if (force || !event) {
        window.setTimeout(run, options.delay ?? 0);
      } else if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 120 });
      } else {
        window.setTimeout(run, 24);
      }
      return true;
    },

    textureAirbrushPaintableMaterials() {
      const paintables = [];
      const records = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      for (const record of records) {
        const materials = materialsForAirbrushRecord(record);
        for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
          const material = materials[materialIndex];
          if (material && (material.map || material.color)) {
            paintables.push({
              record,
              materialIndex,
              material
            });
          }
        }
      }
      return paintables;
    },

    textureAirbrushFirstPaintableMaterial() {
      return this.textureAirbrushPaintableMaterials?.()[0] || null;
    },

    textureAirbrushPrewarmWebGlMaterial(record = null, materialIndex = 0, material = null) {
      if (!record || !material) {
        return false;
      }
      const targetEntry = this.textureAirbrushGpuTargetForMaterial?.(material);
      if (!targetEntry) {
        return false;
      }
      this.textureAirbrushGpuProxyForRecord?.(record, materialIndex, material);
      return true;
    },

    textureAirbrushPrewarmAllWebGlMaterials(options = {}) {
      const paintables = this.textureAirbrushPaintableMaterials?.() || [];
      const limit = Math.max(1, Number(options.limit) || 12);
      let warmed = 0;
      for (const paintable of paintables.slice(0, limit)) {
        if (this.textureAirbrushPrewarmWebGlMaterial?.(
          paintable.record,
          paintable.materialIndex,
          paintable.material
        )) {
          warmed += 1;
        }
      }
      return warmed;
    },

    textureAirbrushPrewarm(event = null, hit = null, options = {}) {
      if (!this.renderer || !this.model || (!options.force && this.activeTool !== "airbrush")) {
        return false;
      }
      this.textureAirbrushBrushShaderMaterial?.();
      this.textureAirbrushEnsureCopyScene?.();
      this.textureAirbrushRenderDepthTarget?.();
      const paintHit = hit || (event ? this.texturePaintHitForEvent?.(event, "airbrush") : null);
      const record = paintHit?.record;
      const materialIndex = paintHit?.hit?.face?.materialIndex ?? 0;
      const material = record ? this.clonePaintMaterialForHit?.(record, paintHit.hit) : null;
      if (record && material) {
        this.textureAirbrushPrewarmWebGlMaterial?.(record, materialIndex, material);
        this.textureAirbrushPrewarmWebGpuFromHit?.(paintHit);
      } else {
        this.textureAirbrushPrewarmAllWebGlMaterials?.(options);
        this.textureAirbrushPrewarmAllWebGpuPaintables?.(options);
      }
      return true;
    },

    textureAirbrushEnsureCopyScene() {
      if (this.textureAirbrushGpuCopyScene) {
        return;
      }
      this.textureAirbrushGpuCopyScene = new THREE.Scene();
      this.textureAirbrushGpuCopyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.textureAirbrushGpuCopyCamera.position.z = 1;
      this.textureAirbrushGpuCopyMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial()
      );
      this.textureAirbrushGpuCopyMesh.frustumCulled = false;
      this.textureAirbrushGpuCopyScene.add(this.textureAirbrushGpuCopyMesh);
    },

    textureAirbrushEnsureDepthTarget() {
      if (!this.renderer || !this.canvas) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const pixelRatio = this.renderer.getPixelRatio?.() || 1;
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));
      const existing = this.textureAirbrushGpuDepthTarget;
      if (existing?.width === width && existing?.height === height) {
        return existing;
      }
      existing?.dispose?.();
      this.textureAirbrushDepthTargetKey = "";
      const target = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false
      });
      target.texture.name = "texture airbrush screen color";
      target.depthTexture = new THREE.DepthTexture(width, height);
      target.depthTexture.name = "texture airbrush screen depth";
      target.depthTexture.format = THREE.DepthFormat;
      target.depthTexture.type = THREE.UnsignedShortType;
      this.textureAirbrushGpuDepthTarget = target;
      return target;
    },

    textureAirbrushDepthCacheKey(rect = this.canvas?.getBoundingClientRect?.()) {
      if (!rect || !this.camera || !this.renderer) {
        return "";
      }
      const pixelRatio = this.renderer.getPixelRatio?.() || 1;
      const matrixKey = [
        ...this.camera.matrixWorldInverse.elements,
        ...this.camera.projectionMatrix.elements
      ].map((value) => Number(value).toFixed(4)).join(",");
      return [
        Math.round(rect.width * pixelRatio),
        Math.round(rect.height * pixelRatio),
        Number(this.progress || 0).toFixed(5),
        matrixKey
      ].join(":");
    },

    textureAirbrushRenderDepthTarget(options = {}) {
      const depthTarget = this.textureAirbrushEnsureDepthTarget();
      if (!depthTarget || !this.renderer || !this.scene || !this.camera) {
        return null;
      }
      const key = this.textureAirbrushDepthCacheKey();
      if (options.reuse !== false && key && this.textureAirbrushDepthTargetKey === key) {
        return depthTarget;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      this.renderer.setRenderTarget(depthTarget);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.textureAirbrushDepthTargetKey = key;
      return depthTarget;
    },

    textureAirbrushGpuTargetForMaterial(material) {
      if (!material) {
        return null;
      }
      const existing = material.userData?.textureAirbrushGpuTarget;
      if (existing?.target?.texture && material.map === existing.target.texture) {
        return existing;
      }
      const editable = this.editableClonePaintTexture?.(material);
      const sourceTexture = editable?.texture || material.map;
      if (!sourceTexture) {
        return null;
      }
      if (existing?.texture === sourceTexture || existing?.target?.texture === sourceTexture) {
        return existing;
      }
      const baseTexture = existing?.target?.texture === sourceTexture
        ? existing.sourceTexture
        : sourceTexture;
      const size = this.textureAirbrushRenderTargetSizeForTexture(baseTexture);
      const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
      const target = new THREE.WebGLRenderTarget(size.width, size.height, {
        minFilter: settings.minFilter,
        magFilter: settings.magFilter,
        wrapS: settings.wrapS,
        wrapT: settings.wrapT,
        depthBuffer: false,
        stencilBuffer: false
      });
      target.texture.name = `${baseTexture.name || "texture"} airbrush paint`;
      this.textureAirbrushCopyTextureRenderSettings(target.texture, baseTexture);

      if (!this.textureAirbrushCopyTextureToTarget(baseTexture, target)) {
        target.dispose?.();
        return null;
      }

      const entry = {
        sourceTexture: baseTexture,
        target,
        width: size.width,
        height: size.height
      };
      material.map = target.texture;
      material.needsUpdate = true;
      material.userData.textureAirbrushGpuTarget = entry;
      return entry;
    },

    textureAirbrushCanvasFromRenderTarget(targetEntry) {
      const target = targetEntry?.target;
      if (!target || !this.renderer || typeof this.renderer.readRenderTargetPixels !== "function" || typeof document === "undefined") {
        return null;
      }
      const texture = target.texture;
      const width = Math.max(1, targetEntry.width || target.width || texture?.image?.width || 1);
      const height = Math.max(1, targetEntry.height || target.height || texture?.image?.height || 1);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }
      const buffer = new Uint8Array(width * height * 4);
      const previousTarget = typeof this.renderer.getRenderTarget === "function"
        ? this.renderer.getRenderTarget()
        : null;
      try {
        this.renderer.readRenderTargetPixels(target, 0, 0, width, height, buffer);
      } finally {
        if (typeof this.renderer.setRenderTarget === "function") {
          this.renderer.setRenderTarget(previousTarget);
        }
      }
      const image = context.createImageData(width, height);
      const rowBytes = width * 4;
      for (let y = 0; y < height; y += 1) {
        const sourceStart = (height - 1 - y) * rowBytes;
        const targetStart = y * rowBytes;
        image.data.set(buffer.subarray(sourceStart, sourceStart + rowBytes), targetStart);
      }
      context.putImageData(image, 0, 0);
      return { canvas, context, width, height };
    },

    flushTextureAirbrushGpuTargetsToCanvases() {
      const paintables = this.textureAirbrushPaintableMaterials?.() || [];
      const seen = new Set();
      let flushed = 0;
      for (const paintable of paintables) {
        const material = paintable.material;
        const targetEntry = material?.userData?.textureAirbrushGpuTarget;
        if (!material || !targetEntry?.target?.texture || seen.has(material)) {
          continue;
        }
        seen.add(material);
        const editable = this.textureAirbrushCanvasFromRenderTarget?.(targetEntry);
        if (!editable?.canvas || !editable.context) {
          continue;
        }
        const previousTexture = material.userData?.clonePaintTexture;
        const texture = new THREE.CanvasTexture(editable.canvas);
        texture.name = `${targetEntry.target.texture.name || material.map?.name || "texture"} airbrush bake`;
        this.textureAirbrushCopyTextureRenderSettings?.(texture, targetEntry.target.texture);
        texture.needsUpdate = true;
        material.map = texture;
        material.needsUpdate = true;
        material.userData ||= {};
        material.userData.clonePaintCanvas = editable.canvas;
        material.userData.clonePaintContext = editable.context;
        material.userData.clonePaintTexture = texture;
        material.userData.clonePaintTextureScale = targetEntry.sourceTexture?.userData?.clonePaintTextureScale || 1;
        delete material.userData.textureAirbrushGpuTarget;
        if (previousTexture && previousTexture !== texture && previousTexture !== material.userData.clonePaintOriginalMap) {
          previousTexture.dispose?.();
        }
        targetEntry.target.dispose?.();
        flushed += 1;
      }
      if (!flushed) {
        return 0;
      }
      this.textureAirbrushGpuProxies?.clear?.();
      this.updateClonePaintPreviews?.();
      return flushed;
    },

    textureAirbrushGpuProxyForRecord(record, materialIndex, material) {
      const key = `${record.geometry?.uuid || "geometry"}:${materialIndex}`;
      this.textureAirbrushGpuProxies ||= new Map();
      let entry = this.textureAirbrushGpuProxies.get(key);
      const shaderMaterial = this.textureAirbrushBrushShaderMaterial();
      const sourceMaterials = Array.isArray(record.object.material)
        ? record.object.material
        : [record.object.material];
      const paintMaterials = sourceMaterials.map((_, index) => (
        index === materialIndex ? shaderMaterial : this.textureAirbrushNoopMaterial()
      ));
      if (!entry) {
        const proxy = record.object.isSkinnedMesh
          ? new THREE.SkinnedMesh(record.geometry, paintMaterials)
          : new THREE.Mesh(record.geometry, paintMaterials);
        proxy.frustumCulled = false;
        proxy.matrixAutoUpdate = false;
        if (proxy.isSkinnedMesh && record.object.skeleton) {
          proxy.bind(record.object.skeleton, record.object.bindMatrix);
          proxy.bindMatrixInverse.copy(record.object.bindMatrixInverse);
        }
        const scene = new THREE.Scene();
        scene.add(proxy);
        entry = { proxy, scene };
        this.textureAirbrushGpuProxies.set(key, entry);
      } else {
        entry.proxy.material = paintMaterials;
      }
      entry.proxy.matrixWorld.copy(record.object.matrixWorld);
      entry.proxy.matrix.copy(record.object.matrix);
      entry.proxy.visible = true;
      return entry;
    },
  });
}
