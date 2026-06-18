export function installTextureAirbrushPressureMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushPressureSettings(options = {}) {
      return {
        radius: options.pressureRadius ?? Boolean(this.texturePressureRadius?.checked),
        opacity: options.pressureOpacity ?? Boolean(this.texturePressureOpacity?.checked),
        hardness: options.pressureHardness ?? Boolean(this.texturePressureHardness?.checked),
        scatter: options.pressureScatter ?? Boolean(this.texturePressureScatter?.checked)
      };
    },

    textureAirbrushPressureValue(event = null, options = {}) {
      if (Number.isFinite(Number(options.pressure))) {
        return Math.max(0.02, Math.min(1, Number(options.pressure)));
      }
      const rawPressure = Number(event?.pressure);
      const pointerType = String(event?.pointerType || "").toLowerCase();
      if (!Number.isFinite(rawPressure)) {
        return 1;
      }
      if (pointerType && pointerType !== "pen" && pointerType !== "touch") {
        return 1;
      }
      if (!pointerType && (rawPressure <= 0 || rawPressure === 0.5)) {
        return 1;
      }
      if (rawPressure <= 0) {
        return pointerType === "pen" || pointerType === "touch" ? 0.02 : 1;
      }
      return Math.max(0.02, Math.min(1, rawPressure));
    },

    textureAirbrushOptionsWithPressure(event = null, options = {}) {
      if (options.pressureApplied) {
        return options;
      }
      const settings = this.textureAirbrushPressureSettings?.(options) || {};
      const pressure = this.textureAirbrushPressureValue?.(event, options) ?? 1;
      const pressureScale = Math.max(0.02, Math.min(1, pressure));
      const next = {
        ...options,
        pressure,
        pressureRadius: settings.radius,
        pressureOpacity: settings.opacity,
        pressureHardness: settings.hardness,
        pressureScatter: settings.scatter,
        pressureApplied: true
      };
      if (settings.radius) {
        const baseRadius = Number.isFinite(Number(options.radiusPixels))
          ? Number(options.radiusPixels)
          : this.textureBrushRadiusScreenPixels?.() || 24;
        next.radiusPixels = Math.max(0.75, baseRadius * pressureScale);
      }
      if (settings.opacity) {
        const baseOpacity = Number.isFinite(Number(options.opacity))
          ? Number(options.opacity)
          : this.textureAirbrushOpacity?.() ?? 0.42;
        next.opacity = Math.max(0.001, Math.min(1, baseOpacity * pressureScale));
      }
      if (settings.hardness) {
        const baseHardness = Number.isFinite(Number(options.hardness))
          ? Number(options.hardness)
          : this.textureAirbrushHardness?.() ?? 0.35;
        next.hardness = Math.max(0, Math.min(1, baseHardness * pressureScale));
      }
      if (settings.scatter) {
        const baseScatter = Number.isFinite(Number(options.scatter))
          ? Number(options.scatter)
          : this.textureAirbrushScatter?.() ?? 0.35;
        next.scatter = Math.max(0, Math.min(1, baseScatter * pressureScale));
      }
      return next;
    }
  });
}
