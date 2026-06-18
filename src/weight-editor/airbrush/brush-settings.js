import {
  byteHex,
  clampByte,
  hexColorBytes
} from "./math.js";

export function installTextureAirbrushBrushSettingsMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushColor() {
      return hexColorBytes(this.texturePaintColor?.value || "#c06f4f");
    },

    textureAirbrushShaderColor(color = null) {
      const hex = color
        ? `#${byteHex(color.r)}${byteHex(color.g)}${byteHex(color.b)}`
        : this.texturePaintColor?.value || "#c06f4f";
      const shaderColor = new THREE.Color(hex);
      return {
        r: shaderColor.r,
        g: shaderColor.g,
        b: shaderColor.b
      };
    },

    textureAirbrushStrength() {
      return Math.max(0.08, this.textureAirbrushOpacity?.() ?? 0.42);
    },

    textureAirbrushSpacingPercent() {
      return Math.max(0.1, Math.min(200, Number(this.textureBrushSpacing?.value || 1)));
    },

    textureAirbrushSpacingPixels(radiusPixels = this.textureBrushRadiusScreenPixels?.() || 24) {
      const radius = Math.max(0.75, Number(radiusPixels) || 24);
      return Math.max(0.1, radius * 2 * (this.textureAirbrushSpacingPercent() / 100));
    },

    textureAirbrushOpacity() {
      return Math.max(0.04, Math.min(1, Number(this.textureBrushOpacity?.value || 0.42)));
    },

    textureAirbrushHardness() {
      return Math.max(0, Math.min(1, Number(this.textureBrushHardness?.value || 0.35)));
    },

    textureAirbrushScatter() {
      return Math.max(0, Math.min(1, Number(this.textureBrushScatter?.value || 0.35)));
    },

    textureAirbrushOptionsFromMacroBrush(settings = null) {
      if (!settings || typeof settings !== "object") {
        return null;
      }
      const colorBytes = settings.colorBytes && typeof settings.colorBytes === "object"
        ? settings.colorBytes
        : null;
      let color = colorBytes
        ? {
            r: clampByte(colorBytes.r),
            g: clampByte(colorBytes.g),
            b: clampByte(colorBytes.b)
          }
        : null;
      if (!color && /^#[0-9a-f]{6}$/i.test(String(settings.color || ""))) {
        const value = Number.parseInt(String(settings.color).slice(1), 16);
        color = {
          r: (value >> 16) & 255,
          g: (value >> 8) & 255,
          b: value & 255
        };
      }
      return {
        ...(color ? { color } : {}),
        ...(Number.isFinite(Number(settings.radiusPixels)) ? { radiusPixels: Math.max(1, Number(settings.radiusPixels)) } : {}),
        ...(Number.isFinite(Number(settings.spacing)) ? { spacing: Math.max(1, Math.min(200, Number(settings.spacing))) } : {}),
        ...(Number.isFinite(Number(settings.opacity)) ? { opacity: Math.max(0.04, Math.min(1, Number(settings.opacity))) } : {}),
        ...(Number.isFinite(Number(settings.hardness)) ? { hardness: Math.max(0, Math.min(1, Number(settings.hardness))) } : {}),
        ...(Number.isFinite(Number(settings.scatter)) ? { scatter: Math.max(0, Math.min(1, Number(settings.scatter))) } : {}),
        ...(Number.isFinite(Number(settings.pressure)) ? { pressure: Math.max(0.02, Math.min(1, Number(settings.pressure))) } : {}),
        ...(typeof settings.pressureRadius === "boolean" ? { pressureRadius: settings.pressureRadius } : {}),
        ...(typeof settings.pressureOpacity === "boolean" ? { pressureOpacity: settings.pressureOpacity } : {}),
        ...(typeof settings.pressureHardness === "boolean" ? { pressureHardness: settings.pressureHardness } : {}),
        ...(typeof settings.pressureScatter === "boolean" ? { pressureScatter: settings.pressureScatter } : {})
      };
    }
  });
}
