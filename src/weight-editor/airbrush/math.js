export const TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE = 0.72;
export const TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE = 3.6;
export const TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE = 2.55;
export const TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE = 0.25;
export const TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD = 0.004;

export function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function byteHex(value) {
  return clampByte(value).toString(16).padStart(2, "0");
}

export function hexColorBytes(value, fallback = "#c06f4f") {
  const text = String(value || fallback).trim();
  const match = /^#?([0-9a-f]{6})$/i.exec(text) || /^#?([0-9a-f]{6})$/i.exec(fallback);
  const hex = match?.[1] || "c06f4f";
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

export function linearByteToSrgbByte(value) {
  const linear = Math.max(0, Math.min(1, Number(value) / 255));
  const srgb = linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return clampByte(srgb * 255);
}

export function isBrightArtifactPixel(imageData, offset) {
  const red = imageData[offset];
  const green = imageData[offset + 1];
  const blue = imageData[offset + 2];
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
  return luma > 112 && spread < 96;
}

export function artifactTintAlpha(imageData, offset, baseAlpha, softFalloff) {
  if (!isBrightArtifactPixel(imageData, offset)) {
    return baseAlpha;
  }
  return Math.max(baseAlpha, Math.min(0.96, 0.34 + softFalloff * 0.62));
}

export function distanceToSegmentPixels(x, y, startX, startY, endX, endY) {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
  const t = segmentLengthSq > 0.0001
    ? Math.max(0, Math.min(1, ((x - startX) * segmentX + (y - startY) * segmentY) / segmentLengthSq))
    : 1;
  const closestX = startX + segmentX * t;
  const closestY = startY + segmentY * t;
  const dx = x - closestX;
  const dy = y - closestY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function airbrushCoverageForDistance(distancePixels, radiusPixels, scatter, hardness) {
  const radius = Math.max(1, radiusPixels);
  const safeScatter = Math.max(0, Math.min(1, scatter));
  const safeHardness = Math.max(0, Math.min(1, hardness));
  const haloRadius = airbrushHaloRadius(radius, safeScatter);
  if (distancePixels > haloRadius) {
    return 0;
  }
  const hardRadius = radius * safeHardness;
  if (distancePixels <= hardRadius) {
    return 1;
  }
  const fadeRadius = Math.max(1, haloRadius - hardRadius);
  const edge = Math.max(0, 1 - (distancePixels - hardRadius) / fadeRadius);
  const exponent = TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE
    - safeHardness * TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE
    + safeScatter * TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE;
  return Math.min(1, Math.pow(edge, exponent));
}

export function airbrushHaloRadius(radiusPixels, scatter) {
  const radius = Math.max(1, radiusPixels);
  const safeScatter = Math.max(0, Math.min(1, scatter));
  return radius * (1 + safeScatter * TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE);
}

export function airbrushAlphaForDistance(distancePixels, radiusPixels, opacity, scatter, hardness, strength = 1) {
  return Math.min(
    1,
    opacity * strength * airbrushCoverageForDistance(distancePixels, radiusPixels, scatter, hardness)
  );
}
