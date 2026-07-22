export const TEXTURE_FIXUP_DEFAULT_PADDING = 32;

export function textureFixupClamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function textureFixupFiniteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

export function textureFixupExportDimensions(bounds = null, options = {}) {
  const width = Math.max(1, textureFixupFiniteInteger(bounds?.width, 1));
  const height = Math.max(1, textureFixupFiniteInteger(bounds?.height, 1));
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const minimumShortSide = Math.max(1, textureFixupFiniteInteger(options.minimumShortSide, 1024));
  const maximumLongSide = Math.max(
    minimumShortSide,
    textureFixupFiniteInteger(options.maximumLongSide, 4096)
  );
  const desiredScale = Math.max(1, minimumShortSide / shortSide);
  const cappedScale = longSide * desiredScale > maximumLongSide
    ? Math.max(1, maximumLongSide / longSide)
    : desiredScale;
  return {
    width: Math.max(1, Math.round(width * cappedScale)),
    height: Math.max(1, Math.round(height * cappedScale)),
    scale: cappedScale
  };
}

export function textureFixupPaddedBounds(bounds = null, padding = 0, width = 1, height = 1) {
  const canvasWidth = Math.max(1, textureFixupFiniteInteger(width, 1));
  const canvasHeight = Math.max(1, textureFixupFiniteInteger(height, 1));
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
    return null;
  }
  const inset = Math.max(0, textureFixupFiniteInteger(padding, 0));
  const left = textureFixupClamp(Math.floor(bounds.x) - inset, 0, canvasWidth - 1);
  const top = textureFixupClamp(Math.floor(bounds.y) - inset, 0, canvasHeight - 1);
  const right = textureFixupClamp(Math.ceil(bounds.x + bounds.width) + inset, left + 1, canvasWidth);
  const bottom = textureFixupClamp(Math.ceil(bounds.y + bounds.height) + inset, top + 1, canvasHeight);
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}
