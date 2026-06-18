function materialsForRecord(record = null) {
  return Array.isArray(record?.object?.material)
    ? record.object.material
    : [record?.object?.material].filter(Boolean);
}

function paintableMaterialFromRecord(editor = null, record = null) {
  const materials = materialsForRecord(record);
  return materials.find((material) => material && (material.map || material.color)) || null;
}

function webGpuBackendReady(editor = null) {
  const resolved = editor?.textureAirbrushResolveBackend?.({ webgpu: true });
  return resolved?.backend === "webgpu";
}

export function installTextureAirbrushWebGpuPrewarmMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushPrewarmWebGpuEditable(editable = null, material = null, options = {}) {
      if (!editable?.canvas || !webGpuBackendReady(this)) {
        return null;
      }
      const color = options.color || this.textureAirbrushColor?.() || { r: 255, g: 255, b: 255 };
      return this.textureAirbrushPrewarmEditableWebGpuPaint?.(editable, {
        radiusPixels: Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24),
        opacity: options.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42,
        hardness: options.hardness ?? this.textureAirbrushHardness?.() ?? 0.35,
        scatter: options.scatter ?? this.textureAirbrushScatter?.() ?? 0.35,
        color,
        material,
        label: options.label || "texture-airbrush-prewarm"
      });
    },

    textureAirbrushPrewarmWebGpuFromHit(paintHit = null, options = {}) {
      if (!webGpuBackendReady(this)) {
        return false;
      }
      const record = paintHit?.record || null;
      const material = record ? this.clonePaintMaterialForHit?.(record, paintHit.hit) : null;
      const editable = material ? this.editableClonePaintTexture?.(material) : null;
      const result = this.textureAirbrushPrewarmWebGpuEditable?.(editable, material, options);
      return Boolean(result);
    },

    textureAirbrushPrewarmFirstWebGpuPaintable(options = {}) {
      if (!webGpuBackendReady(this)) {
        return false;
      }
      const records = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      for (const record of records) {
        const material = paintableMaterialFromRecord(this, record);
        const editable = material ? this.editableClonePaintTexture?.(material) : null;
        const result = this.textureAirbrushPrewarmWebGpuEditable?.(editable, material, options);
        if (result) {
          return true;
        }
      }
      return false;
    },

    textureAirbrushPrewarmAllWebGpuPaintables(options = {}) {
      if (!webGpuBackendReady(this)) {
        return false;
      }
      const paintables = typeof this.textureAirbrushPaintableMaterials === "function"
        ? this.textureAirbrushPaintableMaterials()
        : [];
      const limit = Math.max(1, Number(options.limit) || 12);
      let warmed = 0;
      for (const paintable of paintables.slice(0, limit)) {
        const editable = paintable.material ? this.editableClonePaintTexture?.(paintable.material) : null;
        if (this.textureAirbrushPrewarmWebGpuEditable?.(editable, paintable.material, options)) {
          warmed += 1;
        }
      }
      if (warmed || paintables.length) {
        return warmed;
      }
      return this.textureAirbrushPrewarmFirstWebGpuPaintable?.(options) ? 1 : 0;
    }
  });
}
