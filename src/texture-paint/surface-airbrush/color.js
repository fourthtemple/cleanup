function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function surfaceBrushSrgbChannelToLinear(value) {
  const channel = clamp01(value);
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

export function surfaceBrushWorkingColor(color = null, fallback = { r: 255, g: 255, b: 255 }) {
  const channel = (name) => {
    const value = Number(color?.[name]);
    const fallbackValue = Number(fallback?.[name]);
    const byte = Number.isFinite(value)
      ? value
      : Number.isFinite(fallbackValue)
        ? fallbackValue
        : 0;
    return surfaceBrushSrgbChannelToLinear(Math.max(0, Math.min(255, byte)) / 255);
  };
  return {
    r: channel("r"),
    g: channel("g"),
    b: channel("b")
  };
}

export function setSurfaceBrushColorUniform(
  uniformValue = null,
  color = null,
  fallback = { r: 255, g: 255, b: 255 }
) {
  if (!uniformValue?.set) {
    return false;
  }
  const working = surfaceBrushWorkingColor(color, fallback);
  uniformValue.set(working.r, working.g, working.b, 1);
  return true;
}
