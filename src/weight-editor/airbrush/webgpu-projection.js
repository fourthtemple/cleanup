export {
  TEXTURE_AIRBRUSH_PROJECTION_DEPTH_WINDOW as TEXTURE_AIRBRUSH_WEBGPU_PROJECTION_DEPTH_WINDOW,
  textureAirbrushProbePointsFromStroke as textureAirbrushWebGpuProbePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent as textureAirbrushWebGpuScreenStrokeFromEvent
} from "./projection.js";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback = 1) {
  return Math.max(1, Math.floor(finiteNumber(value, fallback)));
}

function finitePoint(point = null) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  return {
    x: Number(point.x),
    y: Number(point.y)
  };
}

function clampPixel(value, max) {
  return Math.max(0, Math.min(max, Math.round(finiteNumber(value, 0))));
}

function maskGroupKey(candidate = null) {
  return [
    candidate?.record?.uuid || candidate?.record?.id || "record",
    candidate?.materialIndex ?? 0,
    candidate?.material?.uuid || candidate?.material?.id || "material",
    candidate?.editable?.texture?.uuid || candidate?.editable?.texture?.id || "",
    candidate?.editable?.canvas?.width || 0,
    candidate?.editable?.canvas?.height || 0
  ].join(":");
}

function setMaskPixel(pixels, width, height, x, y, value = 255) {
  const px = clampPixel(x, width - 1);
  const py = clampPixel(y, height - 1);
  const offset = (py * width + px) * 4;
  const next = Math.max(pixels[offset], value);
  pixels[offset] = next;
  pixels[offset + 1] = next;
  pixels[offset + 2] = next;
  pixels[offset + 3] = next;
}

function stampMaskDisk(pixels, width, height, point, radiusPixels) {
  const center = finitePoint(point);
  if (!center) {
    return 0;
  }
  const radius = Math.max(0.5, finiteNumber(radiusPixels, 0.5));
  const minX = Math.max(0, Math.floor(center.x - radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxX = Math.min(width - 1, Math.ceil(center.x + radius));
  const maxY = Math.min(height - 1, Math.ceil(center.y + radius));
  const radiusSq = radius * radius;
  let changed = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy > radiusSq) {
        continue;
      }
      setMaskPixel(pixels, width, height, x, y, 255);
      changed += 1;
    }
  }
  return changed;
}

function stampMaskSegment(pixels, width, height, segment = null, radiusPixels = 0.5) {
  const start = finitePoint(segment?.start);
  const end = finitePoint(segment?.end);
  if (!start || !end) {
    return 0;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const spacing = Math.max(1, Math.min(8, finiteNumber(radiusPixels, 1) * 0.5));
  const steps = Math.max(1, Math.ceil(length / spacing));
  let changed = 0;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    changed += stampMaskDisk(pixels, width, height, {
      x: start.x + dx * t,
      y: start.y + dy * t
    }, radiusPixels);
  }
  return changed;
}

export function textureAirbrushWebGpuVisibilityMaskPixels(width, height, samples = [], options = {}) {
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  const pixels = new Uint8Array(safeWidth * safeHeight * 4);
  const radiusPixels = Math.max(0.5, finiteNumber(options.stampRadiusPixels, 0.5));
  let markedPixels = 0;
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (sample?.segment) {
      markedPixels += stampMaskSegment(pixels, safeWidth, safeHeight, sample.segment, radiusPixels);
      continue;
    }
    markedPixels += stampMaskDisk(pixels, safeWidth, safeHeight, sample, radiusPixels);
  }
  return {
    width: safeWidth,
    height: safeHeight,
    pixels,
    markedPixels
  };
}

export function textureAirbrushWebGpuAssignVisibilityMasks(candidates = [], options = {}) {
  const groups = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const canvas = candidate?.editable?.canvas || null;
    if (!canvas?.width || !canvas?.height) {
      continue;
    }
    const key = maskGroupKey(candidate);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        width: positiveInteger(canvas.width, 1),
        height: positiveInteger(canvas.height, 1),
        candidates: [],
        samples: []
      };
      groups.set(key, group);
    }
    group.candidates.push(candidate);
    if (candidate.center) {
      group.samples.push(candidate.center);
    }
    for (const segment of Array.isArray(candidate.strokeSegments) ? candidate.strokeSegments : []) {
      group.samples.push({ segment });
    }
  }

  let maskIndex = 0;
  for (const group of groups.values()) {
    const radius = group.candidates.reduce((maxRadius, candidate) => (
      Math.max(maxRadius, finiteNumber(candidate.radiusPixels, 0))
    ), 0);
    const stampRadiusPixels = Math.max(
      0.75,
      finiteNumber(
        options.visibilityMaskStampRadiusPixels,
        Math.min(Math.max(radius * 0.65, 1), Math.max(radius, 1))
      )
    );
    const mask = textureAirbrushWebGpuVisibilityMaskPixels(group.width, group.height, group.samples, {
      stampRadiusPixels
    });
    const visibilityMaskKey = [
      group.key,
      maskIndex,
      Math.round(stampRadiusPixels * 100),
      mask.markedPixels
    ].join(":");
    maskIndex += 1;
    for (const candidate of group.candidates) {
      // The mask is a permission mask for WebGPU live paint. It is generated
      // only from frontmost raycast samples; unsampled/hidden UV texels remain 0.
      candidate.options = {
        ...candidate.options,
        visibilityMaskPixels: mask.pixels,
        visibilityMaskKey,
        visibleSurfaceMaskReady: true,
        useVisibilityMask: true,
        visibilityFeatherRadius: Math.max(
          0,
          finiteNumber(
            candidate.options?.visibilityFeatherRadius,
            finiteNumber(options.visibilityFeatherRadius, Math.max(1, stampRadiusPixels * 0.75))
          )
        ),
        visibilityMaskThreshold: Math.max(
          0,
          Math.min(1, finiteNumber(candidate.options?.visibilityMaskThreshold, 0.5))
        )
      };
    }
  }
  return candidates;
}
