const SURFACE_ANCHOR_KEY = "textureAirbrushSurfaceAnchor";

function finiteVector3(value = null) {
  if (
    !Number.isFinite(value?.x)
    || !Number.isFinite(value?.y)
    || !Number.isFinite(value?.z)
  ) {
    return null;
  }
  return { x: value.x, y: value.y, z: value.z };
}

function normalizedVector3(value = null) {
  const vector = finiteVector3(value);
  if (!vector) {
    return null;
  }
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 0.000001
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : null;
}

function finiteComponent(value = null) {
  const component = Math.floor(Number(value));
  return Number.isInteger(component) && component >= 0 ? component : -1;
}

export function textureAirbrushCloneSurfaceAnchor(anchor = null) {
  const view = finiteVector3(anchor?.view);
  if (!view) {
    return null;
  }
  const normal = normalizedVector3(anchor?.normal);
  const viewRadiusPixels = Number(anchor?.viewRadiusPixels);
  const component = finiteComponent(anchor?.component);
  return {
    view,
    ...(normal ? { normal } : {}),
    ...(Number.isFinite(viewRadiusPixels) && viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
    ...(component >= 0 ? { component } : {})
  };
}

export function textureAirbrushSurfaceAnchorFromPoint(point = null) {
  return textureAirbrushCloneSurfaceAnchor(point?.[SURFACE_ANCHOR_KEY]);
}

export function textureAirbrushPointWithSurfaceAnchor(point = null, anchor = null) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return null;
  }
  const clonedAnchor = textureAirbrushCloneSurfaceAnchor(anchor);
  return {
    clientX: point.clientX,
    clientY: point.clientY,
    ...(clonedAnchor ? { [SURFACE_ANCHOR_KEY]: clonedAnchor } : {})
  };
}

export function textureAirbrushInterpolateSurfaceAnchors(start = null, end = null, ratio = 0) {
  const left = textureAirbrushCloneSurfaceAnchor(start);
  const right = textureAirbrushCloneSurfaceAnchor(end);
  if (!left || !right) {
    return null;
  }
  const t = Math.max(0, Math.min(1, Number(ratio) || 0));
  const lerp = (a, b) => a + (b - a) * t;
  const normal = left.normal && right.normal
    ? normalizedVector3({
        x: lerp(left.normal.x, right.normal.x),
        y: lerp(left.normal.y, right.normal.y),
        z: lerp(left.normal.z, right.normal.z)
      })
    : t < 0.5
      ? left.normal || right.normal || null
      : right.normal || left.normal || null;
  const startRadius = Number(left.viewRadiusPixels);
  const endRadius = Number(right.viewRadiusPixels);
  const viewRadiusPixels = Number.isFinite(startRadius) && Number.isFinite(endRadius)
    ? lerp(startRadius, endRadius)
    : Number.isFinite(startRadius)
      ? startRadius
      : endRadius;
  const component = left.component === right.component ? left.component : -1;
  return {
    view: {
      x: lerp(left.view.x, right.view.x),
      y: lerp(left.view.y, right.view.y),
      z: lerp(left.view.z, right.view.z)
    },
    ...(normal ? { normal } : {}),
    ...(Number.isFinite(viewRadiusPixels) && viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
    ...(component >= 0 ? { component } : {})
  };
}

export function textureAirbrushSurfaceSegmentMetadata(startPoint = null, endPoint = null) {
  const start = textureAirbrushSurfaceAnchorFromPoint(startPoint);
  const end = textureAirbrushSurfaceAnchorFromPoint(endPoint);
  if (!start || !end) {
    return {};
  }
  const viewRadiusPixels = Math.max(
    0,
    Number(start.viewRadiusPixels) || 0,
    Number(end.viewRadiusPixels) || 0
  );
  return {
    viewStart: start.view,
    viewEnd: end.view,
    ...(start.normal ? { viewNormalStart: start.normal } : {}),
    ...(end.normal ? { viewNormalEnd: end.normal } : {}),
    ...(viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
    ...(finiteComponent(start.component) >= 0 ? { componentStart: finiteComponent(start.component) } : {}),
    ...(finiteComponent(end.component) >= 0 ? { componentEnd: finiteComponent(end.component) } : {})
  };
}

export function textureAirbrushCloneSurfaceSegmentMetadata(segment = null) {
  const viewStart = finiteVector3(segment?.viewStart);
  const viewEnd = finiteVector3(segment?.viewEnd);
  if (!viewStart || !viewEnd) {
    return {};
  }
  const viewNormalStart = normalizedVector3(segment?.viewNormalStart);
  const viewNormalEnd = normalizedVector3(segment?.viewNormalEnd);
  const viewRadiusPixels = Number(segment?.viewRadiusPixels);
  const componentStart = finiteComponent(segment?.componentStart);
  const componentEnd = finiteComponent(segment?.componentEnd);
  return {
    viewStart,
    viewEnd,
    ...(viewNormalStart ? { viewNormalStart } : {}),
    ...(viewNormalEnd ? { viewNormalEnd } : {}),
    ...(Number.isFinite(viewRadiusPixels) && viewRadiusPixels > 0 ? { viewRadiusPixels } : {}),
    ...(componentStart >= 0 ? { componentStart } : {}),
    ...(componentEnd >= 0 ? { componentEnd } : {})
  };
}
