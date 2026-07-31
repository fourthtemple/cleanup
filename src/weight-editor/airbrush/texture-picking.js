import {
  byteHex
} from "./math.js";

function pickReadbackBytes(readback = null) {
  if (!readback) {
    return null;
  }
  if (readback instanceof Uint8Array || readback instanceof Uint8ClampedArray) {
    return readback;
  }
  if (readback.buffer) {
    return new Uint8Array(readback.buffer, readback.byteOffset || 0, readback.byteLength);
  }
  return null;
}

function pickTargetSize(targetEntry = null, editable = null) {
  const target = targetEntry?.target || null;
  const texture = target?.texture || null;
  return {
    width: Math.max(1, Math.floor(Number(
      targetEntry?.width
      || target?.width
      || texture?.image?.width
      || editable?.canvas?.width
      || 1
    ))),
    height: Math.max(1, Math.floor(Number(
      targetEntry?.height
      || target?.height
      || texture?.image?.height
      || editable?.canvas?.height
      || 1
    )))
  };
}

function pickColorMagnitude(sample = null) {
  return Math.max(
    Number(sample?.r) || 0,
    Number(sample?.g) || 0,
    Number(sample?.b) || 0
  );
}

function sampleFromReadback(bytes = null, offset = 0) {
  if (!bytes || offset + 3 >= bytes.length) {
    return null;
  }
  return {
    r: bytes[offset],
    g: bytes[offset + 1],
    b: bytes[offset + 2],
    a: bytes[offset + 3]
  };
}

function pickBestReadbackSample(bytes = null, width = 1, height = 1, centerX = 0, centerY = 0) {
  const centerOffset = (centerY * width + centerX) * 4;
  const center = sampleFromReadback(bytes, centerOffset);
  if (!center || center.a <= 8) {
    return center;
  }
  if (pickColorMagnitude(center) > 8) {
    return center;
  }
  let best = center;
  let bestDistance = Infinity;
  let bestMagnitude = pickColorMagnitude(center);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sample = sampleFromReadback(bytes, (y * width + x) * 4);
      if (!sample || sample.a <= 8) {
        continue;
      }
      const magnitude = pickColorMagnitude(sample);
      if (magnitude <= Math.max(8, bestMagnitude)) {
        continue;
      }
      const distance = Math.hypot(x - centerX, y - centerY);
      if (magnitude > bestMagnitude || distance < bestDistance) {
        best = sample;
        bestMagnitude = magnitude;
        bestDistance = distance;
      }
    }
  }
  return best;
}

export function installTextureAirbrushTexturePickingMethods(BirdWeightEditor, deps = {}) {
  void deps;

  Object.assign(BirdWeightEditor.prototype, {
    dispatchPickedTextureColorEvents(input = this.texturePaintColor) {
      if (!input || typeof input.dispatchEvent !== "function" || typeof Event !== "function") {
        return false;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },

    applyPickedTextureColor(sample, options = {}) {
      if (!sample) {
        return false;
      }
      if (Number.isFinite(sample.a) && sample.a <= 8) {
        return false;
      }
      const hex = `#${byteHex(sample.r)}${byteHex(sample.g)}${byteHex(sample.b)}`;
      const input = options.input || this.texturePaintColor || null;
      if (input) {
        input.value = hex;
        this.dispatchPickedTextureColorEvents?.(input);
      }
      const statusLabel = String(options.statusLabel || "").trim();
      this.setStatus(`Picked${statusLabel ? ` ${statusLabel}` : ""} ${hex}`);
      return true;
    },

    texturePaintPickContext(record, hit) {
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const hitUv = hit?.uv;
      if (!material || !hitUv) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return null;
      }

      const editable = this.editableClonePaintTexture?.(material);
      if (!editable) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return null;
      }
      return { material, editable, hitUv };
    },

    texturePaintGpuPickTargetEntry(material = null, editable = null) {
      const entries = [
        material?.userData?.texturePaintCompositeGpuTarget || null,
        editable?.layer?.gpuTarget || null,
        material?.userData?.texturePaintTslSurfaceAirbrushTarget || null
      ];
      for (const entry of entries) {
        if (entry?.target?.texture) {
          return entry;
        }
      }
      return null;
    },

    texturePaintCanReadWebGpuPickTarget(targetEntry = null) {
      return Boolean(
        targetEntry?.target?.texture
        && this.renderer?.isWebGPURenderer
        && this.renderer?.backend?.isWebGPUBackend
        && typeof this.renderer.readRenderTargetPixelsAsync === "function"
      );
    },

    texturePaintPickEditableColor(context = null, options = {}) {
      const { editable, hitUv } = context || {};
      const { canvas, context: editableContext, texture } = editable || {};
      const pixel = this.clonePaintPixelFromUv(hitUv, canvas, texture);
      if (!Number.isFinite(pixel?.x) || !Number.isFinite(pixel?.y)) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return false;
      }
      const data = editableContext.getImageData(pixel.x, pixel.y, 1, 1).data;
      return this.applyPickedTextureColor?.(
        { r: data[0], g: data[1], b: data[2], a: data[3] },
        options
      ) || false;
    },

    async texturePaintPickWebGpuColor(context = null, targetEntry = null, options = {}) {
      if (!this.texturePaintCanReadWebGpuPickTarget?.(targetEntry)) {
        return false;
      }
      const { editable, hitUv } = context || {};
      const target = targetEntry.target;
      const texture = target.texture || editable?.texture || null;
      const { width, height } = pickTargetSize(targetEntry, editable);
      const pixel = this.clonePaintPixelFromUv(hitUv, { width, height }, texture);
      if (!Number.isFinite(pixel?.x) || !Number.isFinite(pixel?.y)) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return false;
      }
      const centerX = Math.max(0, Math.min(width - 1, Math.floor(pixel.x)));
      const centerY = Math.max(0, Math.min(height - 1, Math.floor(pixel.y)));
      const radius = 16;
      const readX = Math.max(0, centerX - radius);
      const readY = Math.max(0, centerY - radius);
      const readWidth = Math.min(width - readX, radius * 2 + 1);
      const readHeight = Math.min(height - readY, radius * 2 + 1);
      const readback = await this.renderer.readRenderTargetPixelsAsync(
        target,
        readX,
        readY,
        readWidth,
        readHeight
      );
      const bytes = pickReadbackBytes(readback);
      if (!bytes || bytes.length < 4) {
        return false;
      }
      const sample = pickBestReadbackSample(bytes, readWidth, readHeight, centerX - readX, centerY - readY);
      if (options.rejectNearBlack === true && pickColorMagnitude(sample) <= 8) {
        return false;
      }
      return this.applyPickedTextureColor?.(sample, options) || false;
    },

    pickTextureColorNear(record, hit, options = {}) {
      const context = this.texturePaintPickContext?.(record, hit);
      if (!context) {
        return false;
      }
      const targetEntry = this.texturePaintGpuPickTargetEntry?.(context.material, context.editable);
      if (this.texturePaintCanReadWebGpuPickTarget?.(targetEntry)) {
        this.pickTextureColorNearAsync(record, hit, options)
          .then((picked) => {
            if (!picked) {
              this.texturePaintPickEditableColor?.(context, options);
            }
          })
          .catch((error) => {
            this.texturePaintPickEditableColor?.(context, options);
            this.setStatus?.(`Pick failed: ${error?.message || error}`);
          });
        return true;
      }
      return this.texturePaintPickEditableColor?.(context, options) || false;
    },

    async pickTextureColorNearAsync(record, hit, options = {}) {
      const context = this.texturePaintPickContext?.(record, hit);
      if (!context) {
        return false;
      }
      const alternativeHits = Array.isArray(hit?.texturePaintAlternativeHits)
        ? hit.texturePaintAlternativeHits
        : [];
      const contexts = [context];
      for (const alternative of alternativeHits) {
        const alternativeContext = this.texturePaintPickContext?.(alternative.record, alternative.hit);
        if (alternativeContext) {
          contexts.push(alternativeContext);
        }
      }
      const rejectNearBlack = contexts.length > 1;
      if (rejectNearBlack) {
        for (const candidateContext of contexts) {
          const targetEntry = this.texturePaintGpuPickTargetEntry?.(candidateContext.material, candidateContext.editable);
          if (!this.texturePaintCanReadWebGpuPickTarget?.(targetEntry)) {
            continue;
          }
          try {
            if (await this.texturePaintPickWebGpuColor(candidateContext, targetEntry, {
              ...options,
              rejectNearBlack: true
            })) {
              return true;
            }
          } catch (error) {
            this.setStatus?.(`Pick failed: ${error?.message || error}`);
          }
        }
      }
      const targetEntry = this.texturePaintGpuPickTargetEntry?.(context.material, context.editable);
      if (this.texturePaintCanReadWebGpuPickTarget?.(targetEntry)) {
        try {
          if (await this.texturePaintPickWebGpuColor(context, targetEntry, options)) {
            return true;
          }
        } catch (error) {
          this.setStatus?.(`Pick failed: ${error?.message || error}`);
        }
      }
      return this.texturePaintPickEditableColor?.(context, options) || false;
    }
  });
}
