function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export const SURFACE_STROKE_MASK_MAX_SIZE = 2048;

export function surfaceStrokeMaskMaxSize(defaultSize = SURFACE_STROKE_MASK_MAX_SIZE) {
  const fallback = positiveInteger(defaultSize, SURFACE_STROKE_MASK_MAX_SIZE);
  if (typeof window === "undefined") {
    return fallback;
  }
  const requested = Number(
    new URLSearchParams(window.location?.search || "")
      .get("debugAirbrushStrokeMaskSize")
  );
  return Number.isFinite(requested) && requested > 0
    ? Math.max(512, Math.min(fallback, Math.floor(requested)))
    : fallback;
}

export function surfaceStrokeMaskSize(
  width = 1,
  height = 1,
  defaultMaxSize = SURFACE_STROKE_MASK_MAX_SIZE
) {
  const sourceWidth = positiveInteger(width, 1);
  const sourceHeight = positiveInteger(height, 1);
  const maxSize = surfaceStrokeMaskMaxSize(defaultMaxSize);
  const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    sourceWidth,
    sourceHeight,
    maxSize
  };
}
