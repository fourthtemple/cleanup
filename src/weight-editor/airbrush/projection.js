import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";

export const TEXTURE_AIRBRUSH_PROJECTION_DEPTH_WINDOW = 0.025;

function finiteClientPoint(point = null, left = 0, top = 0) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return null;
  }
  return {
    x: point.clientX - left,
    y: point.clientY - top
  };
}

function pointKey(point = null) {
  return `${Math.round(point?.x || 0)}:${Math.round(point?.y || 0)}`;
}

function screenPointDistance(left = null, right = null) {
  if (
    !Number.isFinite(left?.x)
    || !Number.isFinite(left?.y)
    || !Number.isFinite(right?.x)
    || !Number.isFinite(right?.y)
  ) {
    return 0;
  }
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function textureAirbrushScreenStrokeFromEvent(event = null, rect = null, options = {}) {
  if (!event || !rect) {
    return null;
  }
  const center = finiteClientPoint(event, rect.left || 0, rect.top || 0);
  if (!center) {
    return null;
  }
  const start = finiteClientPoint(options.strokeStart, rect.left || 0, rect.top || 0) || center;
  const strokeSegments = (Array.isArray(options.strokeSegments) ? options.strokeSegments : [])
    .map((segment) => {
      const segmentStart = finiteClientPoint(segment?.start, rect.left || 0, rect.top || 0);
      const segmentEnd = finiteClientPoint(segment?.end, rect.left || 0, rect.top || 0);
      return segmentStart && segmentEnd
        ? { start: segmentStart, end: segmentEnd }
        : null;
    })
    .filter(Boolean)
    .slice(0, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
  if (!strokeSegments.length) {
    strokeSegments.push({
      start,
      end: center
    });
  }
  return {
    center,
    start,
    strokeSegments
  };
}

export function textureAirbrushProbePointsFromStroke(stroke = null, radiusPixels = 1) {
  if (!stroke?.center) {
    return [];
  }
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const maxCenters = radius <= 16
    ? 18
    : 10;
  const centers = [];
  const addCenter = (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return;
    }
    if (centers.length >= maxCenters) {
      return;
    }
    const key = pointKey(point);
    if (!centers.some((entry) => entry.key === key)) {
      centers.push({ key, x: point.x, y: point.y });
    }
  };
  addCenter(stroke.center);
  addCenter(stroke.start);
  for (const segment of (stroke.strokeSegments || [])) {
    addCenter(segment.start);
    const distance = screenPointDistance(segment.start, segment.end);
    const step = Math.max(24, Math.min(72, radius * 4));
    const sampleCount = Math.min(6, Math.floor(distance / step));
    for (let index = 1; index <= sampleCount; index += 1) {
      const ratio = index / (sampleCount + 1);
      addCenter({
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio
      });
    }
    addCenter(segment.end);
  }

  const probeRadii = radius <= 16
    ? [0]
    : [0, radius * 0.5, radius];
  const probeAngles = [0, Math.PI * 0.25, Math.PI * 0.5, Math.PI * 0.75, Math.PI, Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75];
  const probes = [];
  const seen = new Set();
  const addProbe = (point) => {
    const key = pointKey(point);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    probes.push(point);
  };
  for (const center of centers) {
    addProbe({ x: center.x, y: center.y });
    for (const radiusOffset of probeRadii.slice(1)) {
      for (const angle of probeAngles) {
        addProbe({
          x: center.x + Math.cos(angle) * radiusOffset,
          y: center.y + Math.sin(angle) * radiusOffset
        });
      }
    }
  }
  return probes;
}

export function textureAirbrushPointInRect(point = null, rect = null) {
  return Boolean(
    point
    && rect
    && point.x >= 0
    && point.y >= 0
    && point.x <= rect.width
    && point.y <= rect.height
  );
}

export function textureAirbrushFrontIntersections(intersections = [], depthWindow = TEXTURE_AIRBRUSH_PROJECTION_DEPTH_WINDOW, limit = 4) {
  const nearest = intersections[0]?.distance ?? null;
  const maxDistance = Number.isFinite(nearest)
    ? nearest + Math.max(0, Number(depthWindow) || 0)
    : Infinity;
  const hits = [];
  for (const hit of intersections.slice(0, Math.max(0, limit))) {
    if (!hit || hit.distance > maxDistance) {
      break;
    }
    hits.push(hit);
  }
  return hits;
}
