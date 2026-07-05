import {
  artifactTintAlpha,
  clampByte
} from "./math.js";

export function installTextureAirbrushNearBrushMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    paintTextureRegion(options = {}) {
      void options;
      this.textureAirbrushReportWebGpuFallback?.({
        backend: "none",
        webGpuStatus: "cpu-region-paint-disabled"
      });
      this.setStatus?.("Region airbrush requires the WebGPU visible-surface paint path.");
      return 0;
    },

    textureAirbrushNear(record, hit, options = {}) {
      if (options.event) {
        options = this.textureAirbrushOptionsWithPressure?.(options.event, options) || options;
      }
      if (
        options.fullRegion === true
        || options.meshFallback === true
        || !options.event
      ) {
        void record;
        void hit;
        this.textureAirbrushReportWebGpuFallback?.({
          backend: "none",
          webGpuStatus: "cpu-uv-paint-disabled"
        });
        this.setStatus?.("Airbrush CPU UV painting is disabled; WebGPU visible-surface paint is required.");
        return 0;
      }
      if (hit?.cloneRegionHit && options.event) {
        return this.textureAirbrushProjectedRegionFromEvent?.(record, options.event, hit, options) || 0;
      }
      if (options.event && !options.fullRegion && !options.meshFallback) {
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // USER-APPROVED FIX, DO NOT SIMPLIFY:
        // live airbrush must stop here after the projected shader path. The old
        // direct UV fallback can paint whichever UV island is near the hit, even
        // when that island is hidden or facing away from the current camera.
        //
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // Live airbrush must not fall back to direct UV brushing: the UV path
        // paints in texture space and can touch non-camera-facing islands.
        const changed = this.textureAirbrushVisibleSurfacePaintFromEvent?.(options.event, options) || 0;
        return changed;
      }
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      const hitUv = hit?.uv;
      if (!editable || !hitUv) {
        this.setStatus("Airbrush needs an editable texture under the cursor");
        return 0;
      }

      const target = hit?.cloneRegionHit ? this.clonePaintTargets?.get(record) : null;
      const { canvas, context, texture } = editable;
      const targetMaterialIndex = hit?.face?.materialIndex
        ?? target?.originMaterialIndex
        ?? target?.materialIndex
        ?? 0;
      this.captureTexturePaintCanvasUndoTarget?.(record, material, editable, targetMaterialIndex);
      const center = this.clonePaintPixelFromUv(hitUv, canvas, texture, { wrap: !target?.vertices?.size });
      const radiusScale = options.radiusScale ?? (target?.vertices?.size ? 1.55 : 0.72);
      const radiusPixels = Math.max(3, Math.round(this.textureBrushRadiusValue() * Math.max(canvas.width, canvas.height) * radiusScale));
      const color = this.textureAirbrushColor();
      const strength = options.fullRegion
        ? (options.strength ?? 1)
        : options.strength ?? this.textureAirbrushStrength();
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const useLayerPixels = editable.layerMode === true;
      const eraseLayer = useLayerPixels && options.erase === true;
      const visibleRegionTriangles = target?.vertices?.size && hit?.cloneRegionHit
        ? this.texturePaintVisibleRegionTriangles?.(record, targetMaterialIndex, canvas, texture, { referenceUv: hitUv })
        : null;
      const regionTriangles = target?.vertices?.size
        ? visibleRegionTriangles?.length
          ? visibleRegionTriangles
          : this.clonePaintRegionTextureTriangles?.(record, target, targetMaterialIndex, canvas, texture, { referenceUv: hitUv })
        : null;
      if (target?.vertices?.size && !regionTriangles?.length) {
        this.setStatus("Airbrush needs complete Region texture faces");
        return 0;
      }
      let changed = 0;
      const writtenPixels = new Set();

      const paintPixel = (pixelPoint, dx = 0, dy = 0, alphaOverride = null) => {
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (!options.fullRegion && distance > radiusPixels) {
          return;
        }
        if (regionTriangles && !this.clonePaintPointInsideTextureTriangles?.(pixelPoint, regionTriangles, 0.03)) {
          return;
        }
        const actualPixel = regionTriangles
          ? this.clonePaintActualPixelFromTexturePoint?.(pixelPoint, canvas, texture)
          : pixelPoint;
        if (!actualPixel) {
          return;
        }
        const key = `${actualPixel.x}:${actualPixel.y}`;
        if (writtenPixels.has(key)) {
          return;
        }
        writtenPixels.add(key);
        const falloff = options.fullRegion ? 1 : 1 - distance / radiusPixels;
        const softFalloff = Math.pow(Math.max(0, falloff), 1.75);
        const alpha = alphaOverride ?? (
          target?.vertices?.size
            ? Math.min(0.45, strength * (0.08 + softFalloff * 0.74))
            : strength * falloff * falloff
        );
        const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
        const pixelAlpha = target?.vertices?.size && !alphaOverride
          ? artifactTintAlpha(image.data, offset, alpha, softFalloff)
          : alpha;
        if (pixelAlpha <= 0.012) {
          return;
        }
        if (useLayerPixels) {
          if (!this.texturePaintApplyLayerPixel?.(image, offset, color, pixelAlpha, { erase: eraseLayer })) {
            return;
          }
        } else {
          const nextR = clampByte(image.data[offset] * (1 - pixelAlpha) + color.r * pixelAlpha);
          const nextG = clampByte(image.data[offset + 1] * (1 - pixelAlpha) + color.g * pixelAlpha);
          const nextB = clampByte(image.data[offset + 2] * (1 - pixelAlpha) + color.b * pixelAlpha);
          const nextA = Math.max(image.data[offset + 3], 255);
          if (
            image.data[offset] === nextR
            && image.data[offset + 1] === nextG
            && image.data[offset + 2] === nextB
            && image.data[offset + 3] === nextA
          ) {
            return;
          }
          image.data[offset] = nextR;
          image.data[offset + 1] = nextG;
          image.data[offset + 2] = nextB;
          image.data[offset + 3] = nextA;
        }
        changed += 1;
      };

      if (options.fullRegion && regionTriangles) {
        for (const { pixels } of regionTriangles) {
          if (pixels.length !== 3) {
            continue;
          }
          const minX = Math.floor(Math.min(...pixels.map((point) => point.x)));
          const maxX = Math.ceil(Math.max(...pixels.map((point) => point.x)));
          const minY = Math.floor(Math.min(...pixels.map((point) => point.y)));
          const maxY = Math.ceil(Math.max(...pixels.map((point) => point.y)));
          for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
              const pixelPoint = { x, y };
              const barycentric = this.clonePaintBarycentric(pixelPoint, pixels);
              if (this.clonePaintBarycentricInside(barycentric, 0.015)) {
                paintPixel(pixelPoint, 0, 0, strength);
              }
            }
          }
        }
      } else if (regionTriangles) {
        for (let dy = -radiusPixels; dy <= radiusPixels; dy += 1) {
          for (let dx = -radiusPixels; dx <= radiusPixels; dx += 1) {
            paintPixel({ x: center.x + dx, y: center.y + dy }, dx, dy);
          }
        }
      } else {
        for (let y = Math.max(0, center.y - radiusPixels); y <= Math.min(canvas.height - 1, center.y + radiusPixels); y += 1) {
          for (let x = Math.max(0, center.x - radiusPixels); x <= Math.min(canvas.width - 1, center.x + radiusPixels); x += 1) {
            const dx = x - center.x;
            const dy = y - center.y;
            paintPixel({ x, y }, dx, dy);
          }
        }
      }

      if (!changed) {
        this.setStatus("Airbrush found no texture pixels");
        return 0;
      }
      context.putImageData(image, 0, 0);
      texture.needsUpdate = true;
      material.needsUpdate = true;
      this.texturePaintCommitEditable?.(editable, material, record);
      this.markTexturePaintStrokeChanged?.();
      this.refreshCloneSpotlightTextures?.(record);
      this.setStatus(options.fullRegion
        ? `Painted Region ${changed} ${changed === 1 ? "pixel" : "pixels"}`
        : `${eraseLayer ? "Erased" : "Airbrushed"} ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      this.updateClonePaintPreviews?.();
      return changed;
    }
  });
}
